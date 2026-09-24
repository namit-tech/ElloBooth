"""
Puts the visitor's real face into the photograph the image model produced.

Why this exists
---------------
An image model *draws* a face, it does not copy one, so likeness tops out
somewhere around 85-90% - close enough that people notice it is not them.
Nothing in the prompt clears that ceiling. This replaces the face region with
the visitor's own pixels instead.

Three things separate this from a naive paste, and each one is a defect that
showed up in the browser-side version it replaces:

1. Piecewise affine warp, not a single similarity transform.
   One scale/rotate/translate for the whole face has four degrees of freedom.
   It cannot turn a frontal capture into a head that is tilted, turned or
   bowed - it can only squash it and hope. Splitting the face into ~900
   triangles off the landmark mesh and warping each one on its own gives the
   hundreds of degrees of freedom a real head pose needs.

2. Poisson blending, not alpha feathering.
   Feathering has to choose between a visible seam and averaging the two faces
   together, and the averaged ring is exactly where identity lives - jaw, chin,
   hairline. cv2.seamlessClone solves the transplant in the gradient domain
   instead: lighting and colour come from the scene, while texture and
   complexion stay the visitor's. It also removes any need to shrink the mask,
   so the whole face goes in, silhouette included.

3. Choosing which face to replace.
   A generated temple photo has at least two faces in it - the visitor and the
   deity. A generated meet-and-greet has the visitor and the celebrity. Taking
   whichever face the detector happened to rank first risks pasting a visitor
   onto a murti. Candidates are scored against the booth's capture, with the
   scene's own reference artwork acting as a veto.

CPU only. No GPU, no network, no paid service, and nothing with a licence to
worry about: MediaPipe, OpenCV, SciPy and NumPy are all permissively licensed.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from scipy.spatial import Delaunay

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

MODEL_PATH = Path(__file__).parent / "models" / "face_landmarker.task"

# Breathing room in pixels: how far outside the face the working crop reaches,
# and how much slack the capture gets so landmarks that fall a little outside
# the frame still index into real pixels. Also the floor for the crop margin.
PAD = 96

# Below this a "face" is a texture artefact, not something to transplant onto.
MIN_FACE_PX = 48

# Longest edge the first detection pass runs at. Large enough to keep a small
# face findable, small enough that the detector's own downscaling does not throw
# the face away before it ever looks at it.
DETECT_EDGE = 1536

# Resemblance is `structure - tone/30`, so it sits roughly in -3 .. +1. This
# floor only catches the case where nothing in the photo looks like the visitor
# at all; it is deliberately loose, because refusing a good swap costs more at a
# live event than allowing a mediocre one.
MIN_RESEMBLANCE = -1.6

_lock = threading.Lock()
_landmarker = None


def _detector():
    """Loaded once and reused. Not thread-safe, hence the lock around detect()."""
    global _landmarker
    if _landmarker is None:
        if not MODEL_PATH.exists():
            raise RuntimeError(f"Face model missing at {MODEL_PATH}")
        _landmarker = mp_vision.FaceLandmarker.create_from_options(
            mp_vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
                running_mode=mp_vision.RunningMode.IMAGE,
                # More than one, because the interesting images have a deity or
                # a celebrity in them as well as the visitor.
                num_faces=5,
            )
        )
    return _landmarker


def warm() -> None:
    """Load the model at startup so the first visitor does not pay for it."""
    _detector()


@dataclass
class Face:
    """One detected face: 478 landmarks in pixel coordinates."""

    points: np.ndarray

    @property
    def rect(self):
        return cv2.boundingRect(self.points)

    @property
    def span(self) -> float:
        return float(self.rect[2])


def _detect_in(image: np.ndarray) -> list[Face]:
    """Faces in this exact image, in its own pixel coordinates."""
    height, width = image.shape[:2]
    frame = mp.Image(
        image_format=mp.ImageFormat.SRGB,
        data=cv2.cvtColor(image, cv2.COLOR_BGR2RGB),
    )
    with _lock:
        found = _detector().detect(frame)

    faces = []
    for marks in found.face_landmarks or []:
        points = np.array([[m.x * width, m.y * height] for m in marks], dtype=np.float32)
        face = Face(points)
        if face.span >= MIN_FACE_PX:
            faces.append(face)
    return faces


def detect(image: np.ndarray) -> list[Face]:
    """
    Every face in the image, largest first, found in two stages.

    The detector resizes whatever it is handed down to its own small input
    before looking for anything. Give it a 4K souvenir print and a face that
    fills a comfortable part of the frame shrinks to a few dozen pixels by the
    time it is looked at, and comes back as no face at all - which is not an
    error anyone sees, just a photograph that quietly keeps the drawn face.

    So: find the face on a copy small enough for the detector to cope with, then
    re-run on a full-resolution crop around it. The first pass decides whether
    there is a face; the second gets the landmarks accurate enough to warp with,
    which a scaled-up coarse mesh would not be.
    """
    height, width = image.shape[:2]
    scale = min(1.0, DETECT_EDGE / max(height, width))

    if scale >= 1.0:
        faces = _detect_in(image)
        faces.sort(key=lambda f: f.span, reverse=True)
        return faces

    small = cv2.resize(
        image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA
    )

    faces: list[Face] = []
    for coarse in _detect_in(small):
        x, y, w, h = (int(v / scale) for v in coarse.rect)
        margin = int(max(w, h) * 0.4)
        x0, y0 = max(0, x - margin), max(0, y - margin)
        x1, y1 = min(width, x + w + margin), min(height, y + h + margin)

        # Arithmetic against a Python list promotes to float64, which
        # cv2.boundingRect refuses outright - keep everything float32.
        precise = _detect_in(np.ascontiguousarray(image[y0:y1, x0:x1]))
        points = (
            precise[0].points + np.array([x0, y0], dtype=np.float32)
            if precise
            else coarse.points / np.float32(scale)
        )
        faces.append(Face(points.astype(np.float32)))

    faces.sort(key=lambda f: f.span, reverse=True)
    return faces


# --------------------------------------------------------------------------- #
# Telling one face from another                                               #
# --------------------------------------------------------------------------- #


def signature(image: np.ndarray, face: Face):
    """
    A small descriptor of what a face looks like, robust to the scene's lighting.

    Two halves, because either alone is fooled:
      - median Lab chroma, which separates a painted blue-and-gold idol from a
        photographed person no matter how the temple is lit;
      - a 32x32 greyscale patch with mean and contrast normalised away, which
        survives the model's relighting and still says whether the underlying
        arrangement of features is the same.
    """
    x, y, w, h = face.rect
    x, y = max(x, 0), max(y, 0)
    crop = image[y : y + h, x : x + w]
    if crop.size == 0 or min(crop.shape[:2]) < 8:
        return None

    crop = cv2.resize(crop, (32, 32), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    tone = np.median(lab[:, :, 1:].reshape(-1, 2).astype(np.float32), axis=0)

    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
    grey = (grey - grey.mean()) / (grey.std() + 1e-6)

    return tone, grey


def resemblance(a, b) -> float:
    """Higher means more likely to be the same face. Roughly -3 .. +1."""
    if a is None or b is None:
        return -9.0
    structure = float((a[1] * b[1]).mean())
    tone = float(np.linalg.norm(a[0] - b[0]))
    return structure - tone / 30.0


# --------------------------------------------------------------------------- #
# Warping                                                                     #
# --------------------------------------------------------------------------- #


def _triangle_area(t) -> float:
    """Twice-the-area cross product, halved. Zero means the points are collinear."""
    return (
        abs(
            (t[1][0] - t[0][0]) * (t[2][1] - t[0][1])
            - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])
        )
        * 0.5
    )


def _warp(source, src_pts, dst_pts, shape):
    """
    Carry the source face into the target's coordinate space, triangle by triangle.

    The triangulation is computed on the *source* points. Those come from the
    booth's capture, which is near-frontal by design, so the mesh is well
    conditioned; running it on a target face that is turned away would produce
    slivers. The same vertex indices address both point sets, so one mesh warps
    onto the other.
    """
    out = np.zeros(shape, dtype=np.uint8)
    height, width = shape[:2]

    for tri in Delaunay(src_pts).simplices:
        t_src = src_pts[tri]
        t_dst = dst_pts[tri]

        # A Delaunay mesh over landmark points always throws off a few slivers
        # along the hull, and MediaPipe's iris points sit close enough together
        # to produce collinear ones outright. Their affine transform is singular,
        # which sends warpAffine's source coordinates off to absurd values, and
        # the border handler then walks back one reflection at a time - a single
        # triangle can hang the whole request for minutes. They also cover no
        # area, so nothing is lost by dropping them.
        if _triangle_area(t_src) < 1.0 or _triangle_area(t_dst) < 1.0:
            continue

        sx, sy, sw, sh = cv2.boundingRect(t_src)
        dx, dy, dw, dh = cv2.boundingRect(t_dst)
        if min(sw, sh, dw, dh) < 1:
            continue
        if dx < 0 or dy < 0 or dx + dw > width or dy + dh > height:
            continue

        patch = source[sy : sy + sh, sx : sx + sw]
        if patch.size == 0:
            continue

        matrix = cv2.getAffineTransform(
            np.float32(t_src - [sx, sy]), np.float32(t_dst - [dx, dy])
        )
        # INTER_CUBIC because the capture's face is usually smaller than the
        # generated one, so most triangles are being enlarged.
        #
        # BORDER_REPLICATE clamps in constant time. REFLECT_101 loops, so it
        # turns any remaining numerical excursion into a hang rather than a
        # slightly wrong edge pixel - and those pixels fall outside the stencil
        # below in any case.
        warped = cv2.warpAffine(
            patch,
            matrix,
            (dw, dh),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )

        stencil = np.zeros((dh, dw), dtype=np.uint8)
        cv2.fillConvexPoly(stencil, np.int32(t_dst - [dx, dy]), 255, cv2.LINE_8)
        roi = out[dy : dy + dh, dx : dx + dw]
        np.copyto(roi, warped, where=stencil[:, :, None] > 0)

    return out


def _sharpen(image, amount: float):
    """
    Undo the softness that enlarging a small face introduces.

    This is not invention - the detail was lost to interpolation, and an unsharp
    mask restores the local contrast the interpolation flattened. The amount is
    tied to how much the face actually had to be enlarged.
    """
    if amount <= 0.02:
        return image
    blur = cv2.GaussianBlur(image, (0, 0), 1.1)
    return cv2.addWeighted(image, 1.0 + amount, blur, -amount, 0)


# --------------------------------------------------------------------------- #
# The swap                                                                    #
# --------------------------------------------------------------------------- #


@dataclass
class Outcome:
    ok: bool
    image: np.ndarray | None = None
    reason: str = ""
    detail: dict = field(default_factory=dict)


def swap(target, source, avoid=None, sharpen: bool = True) -> Outcome:
    """
    @param target  the photograph the image model produced
    @param source  the booth's capture of the visitor
    @param avoid   the scene's reference artwork - the deity or celebrity that
                   is *supposed* to keep its own face. Used as a veto, not a
                   hint, so a scene whose reference has no detectable face falls
                   back to scoring against the capture alone.
    """
    detail: dict = {}

    source_faces = detect(source)
    if not source_faces:
        return Outcome(False, reason="No face found in the booth's capture", detail=detail)
    # The visitor stands alone at the booth; anyone else in frame is behind them
    # and therefore smaller.
    visitor = source_faces[0]

    candidates = detect(target)
    detail["faces_in_photo"] = len(candidates)
    if not candidates:
        return Outcome(False, reason="No face found in the generated photo", detail=detail)

    visitor_sig = signature(source, visitor)
    avoid_sig = None
    if avoid is not None:
        avoid_faces = detect(avoid)
        if avoid_faces:
            avoid_sig = signature(avoid, avoid_faces[0])
    detail["reference_face_found"] = avoid_sig is not None

    candidate_sigs = [signature(target, c) for c in candidates]
    scores = [resemblance(s, visitor_sig) for s in candidate_sigs]
    best = int(np.argmax(scores))
    detail["chosen_face"] = best
    detail["score"] = round(scores[best], 3)
    detail["all_scores"] = [round(s, 3) for s in scores]

    if scores[best] < MIN_RESEMBLANCE:
        return Outcome(
            False,
            reason="None of the faces in the photo resemble the visitor",
            detail=detail,
        )

    # Veto: if the face we picked looks more like the scene's own artwork than
    # like the visitor, then the model drew only the deity and we are one step
    # away from transplanting a visitor onto a murti.
    if avoid_sig is not None:
        against_reference = resemblance(candidate_sigs[best], avoid_sig)
        detail["score_vs_reference"] = round(against_reference, 3)
        if against_reference >= scores[best]:
            return Outcome(
                False,
                reason="The only face found belongs to the scene's own subject",
                detail=detail,
            )

    drawn = candidates[best]
    ratio = drawn.span / max(visitor.span, 1.0)
    detail["capture_face_px"] = round(visitor.span)
    detail["photo_face_px"] = round(drawn.span)
    detail["scale_ratio"] = round(ratio, 2)

    # --- work inside a crop around the face, never the whole photograph ---
    # seamlessClone solves a Poisson system over the entire image it is handed
    # and allocates several full-size float buffers to do it. On a 4K souvenir
    # print that is minutes of work and gigabytes of memory spent almost
    # entirely on pixels nowhere near the face. The solve only needs the mask
    # plus enough margin for its boundary condition to settle, so the warp and
    # the clone both run in that crop and the result is written back. Cost then
    # depends on the size of the face, not the size of the output.
    height, width = target.shape[:2]
    face_rect = cv2.boundingRect(cv2.convexHull(np.int32(drawn.points)))
    margin = max(PAD, int(0.35 * max(face_rect[2], face_rect[3])))

    # Padding first, so a visitor standing at the very edge of frame still has
    # margin on every side and the crop arithmetic needs no special cases.
    target_p = cv2.copyMakeBorder(target, margin, margin, margin, margin, cv2.BORDER_REPLICATE)
    source_p = cv2.copyMakeBorder(source, PAD, PAD, PAD, PAD, cv2.BORDER_REPLICATE)

    ph, pw = target_p.shape[:2]
    x0 = max(0, face_rect[0])
    y0 = max(0, face_rect[1])
    x1 = min(pw, face_rect[0] + face_rect[2] + 2 * margin)
    y1 = min(ph, face_rect[1] + face_rect[3] + 2 * margin)

    roi = np.ascontiguousarray(target_p[y0:y1, x0:x1])
    detail["blend_crop"] = f"{x1 - x0}x{y1 - y0}"
    detail["photo"] = f"{width}x{height}"

    src_pts = visitor.points + PAD
    dst_pts = drawn.points + margin - np.array([x0, y0], dtype=np.float32)

    warped = _warp(source_p, src_pts, dst_pts, roi.shape)
    if sharpen:
        warped = _sharpen(warped, min(0.7, max(0.0, (ratio - 1.0) * 0.5)))

    mask = np.zeros(roi.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(np.int32(dst_pts)), 255)

    # Poisson takes its boundary condition from the mask edge, so pull that edge
    # a hair inside the silhouette - otherwise it reads hair and background as
    # if they were skin. Kept small: the whole point of this method is that the
    # jaw and hairline can be included, unlike with feathering.
    erode = max(3, int(drawn.span * 0.015)) | 1
    mask = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (erode, erode)))
    # A mask that reaches the edge of the image it is given is rejected outright,
    # and a clamped crop can still put it there. Two clear pixels is enough.
    mask[:2, :] = 0
    mask[-2:, :] = 0
    mask[:, :2] = 0
    mask[:, -2:] = 0

    if cv2.countNonZero(mask) < 100:
        return Outcome(False, reason="The face region was too small to blend", detail=detail)

    mx, my, mw, mh = cv2.boundingRect(mask)
    centre = (mx + mw // 2, my + mh // 2)

    try:
        blended = cv2.seamlessClone(warped, roi, mask, centre, cv2.NORMAL_CLONE)
    except cv2.error as err:  # pragma: no cover - the guards above cover this
        return Outcome(False, reason=f"Blending failed: {err}", detail=detail)

    target_p[y0:y1, x0:x1] = blended
    return Outcome(
        True,
        image=target_p[margin : margin + height, margin : margin + width],
        detail=detail,
    )
