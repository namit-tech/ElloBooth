"""
Cuts the visitor out of the booth's capture and stands them in a fixed scene.

Why this exists alongside swap.py
---------------------------------
The generative path draws the visitor from scratch and then has their real face
transplanted back in. Two things are wrong with that for a darshan booth:

  - The deity is redrawn every time. Devotees know the murti; it should look
    identical in every photograph, which a generative model cannot promise.
  - The visitor is redrawn too. A transplanted face fixes the face and nothing
    else, and it has its own failure modes - spectacles doubling, a small
    capture stretched to fit, a head at the wrong angle.

Compositing sidesteps both. The deity comes from one fixed backplate, and the
visitor is their own photograph - face, hair, spectacles, clothes, all of it
untouched. Nothing is redrawn, so nothing can be redrawn wrongly.

What it costs instead: one backplate has to be prepared per scene, everyone
gets the same background, and the booth's lighting has to be in the same
neighbourhood as the plate's. The first two are features for a darbar. The
third is what booth lighting is for.

MediaPipe's multiclass selfie segmenter runs on CPU and separates hair from
body, which matters because hair is where a cut-out gives itself away.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

MODEL_PATH = Path(__file__).parent / "models" / "selfie_multiclass.tflite"

# The classes the multiclass segmenter returns. Everything except background is
# "the visitor", but hair is kept separately so its edge can be handled softly.
BACKGROUND = 0
HAIR = 1

# Longest edge the mask is refined at. The segmenter itself only ever produces
# 256x256, so there is no detail above this to recover - only time to spend.
REFINE_EDGE = 1280

# Confidence below this is background, above it is solidly the visitor, and the
# gap between is the only place the cut-out is allowed to be semi-transparent.
SOLID_BELOW = 0.35
SOLID_ABOVE = 0.70

# Longest edge the drop shadow is built at before being scaled up.
SHADOW_EDGE = 512

# Longest edge the colour statistics are gathered from. Means and deviations do
# not need megapixels.
STATS_EDGE = 640

# Rows blended at a time. Keeps peak memory to a few megabytes regardless of how
# large the plate is.
BAND_ROWS = 512

_lock = threading.Lock()
_segmenter = None


def _seg() -> "mp_vision.ImageSegmenter":
    global _segmenter
    if _segmenter is None:
        if not MODEL_PATH.exists():
            raise RuntimeError(f"Segmentation model missing at {MODEL_PATH}")
        _segmenter = mp_vision.ImageSegmenter.create_from_options(
            mp_vision.ImageSegmenterOptions(
                base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
                running_mode=mp_vision.RunningMode.IMAGE,
                output_category_mask=True,
                output_confidence_masks=True,
            )
        )
    return _segmenter


def warm() -> None:
    _seg()


@dataclass
class Placement:
    """Where the visitor stands in the plate, in fractions of its size."""

    # Horizontal centre of the visitor. 0.5 is the middle, higher is further right.
    anchor_x: float = 0.72
    # Where the bottom of the visitor sits. 1.0 is the bottom edge of the plate.
    anchor_bottom: float = 1.0
    # How much of the plate's height the visitor fills.
    height: float = 0.88


@dataclass
class Outcome:
    ok: bool
    image: np.ndarray | None = None
    reason: str = ""
    detail: dict = field(default_factory=dict)


def _person_mask(image: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """
    Soft 0..1 alpha for the visitor, plus a hair-only mask.

    The segmenter works at 256x256, so its mask is far coarser than the photo.
    Upscaling it alone gives a stair-stepped silhouette that reads as a cut-out
    immediately. A joint bilateral filter pulls the edge back onto the actual
    image edge, which is what makes hair survive.
    """
    height, width = image.shape[:2]

    # Everything about the mask happens at a working size. The segmenter resizes
    # whatever it is handed down to 256x256 before it looks at it, so passing a
    # 17-megapixel booth capture only buys a 17-megapixel colour conversion and
    # a 17-megapixel resize inside MediaPipe, for a mask that is 256x256 either
    # way. The edge refinement has the same nothing to gain from full size.
    scale = min(1.0, REFINE_EDGE / max(width, height))
    work_w, work_h = max(64, int(width * scale)), max(64, int(height * scale))
    small = cv2.resize(image, (work_w, work_h), interpolation=cv2.INTER_AREA)

    frame = mp.Image(
        image_format=mp.ImageFormat.SRGB,
        data=cv2.cvtColor(small, cv2.COLOR_BGR2RGB),
    )
    with _lock:
        result = _seg().segment(frame)

    confidences = result.confidence_masks
    if not confidences:
        return None

    background = confidences[BACKGROUND].numpy_view()
    person = cv2.resize(1.0 - background, (work_w, work_h), interpolation=cv2.INTER_LINEAR)

    guide = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    radius = max(3, int(min(work_w, work_h) * 0.012)) | 1
    person = (
        cv2.ximgproc.guidedFilter(guide, person.astype(np.float32), radius, 1e-3)
        if _has_ximgproc()
        else cv2.bilateralFilter(person.astype(np.float32), d=9, sigmaColor=0.1, sigmaSpace=radius)
    )

    # Stretch the middle of the range out to the ends. The raw confidence stays
    # around 0.5 across parts of the body, which composites as a translucent
    # person with the background showing through their jaw. Only the narrow band
    # either side of the silhouette should ever be partly transparent.
    person = np.clip((person - SOLID_BELOW) / (SOLID_ABOVE - SOLID_BELOW), 0.0, 1.0)

    person = cv2.resize(person, (width, height), interpolation=cv2.INTER_LINEAR)

    hair = confidences[HAIR].numpy_view() if len(confidences) > HAIR else None
    hair = (
        cv2.resize(hair, (width, height), interpolation=cv2.INTER_LINEAR)
        if hair is not None
        else np.zeros_like(person)
    )

    return np.clip(person, 0.0, 1.0), np.clip(hair, 0.0, 1.0)


def _has_ximgproc() -> bool:
    return hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "guidedFilter")


def _largest_component(alpha: np.ndarray) -> np.ndarray:
    """
    Keeps only the biggest connected blob.

    A booth sees furniture, doorways and people walking past behind the visitor.
    The segmenter will happily mark a bystander, and pasting two half-people into
    a temple looks worse than any lighting mismatch.
    """
    binary = (alpha > 0.5).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        return alpha

    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return alpha * (labels == biggest)


def _plate_luts(person: np.ndarray, alpha: np.ndarray, plate: np.ndarray) -> list[np.ndarray]:
    """
    Per-channel lookup tables that bring the cut-out into the plate's light.

    Matching is done in Lab and only partially: the plate's cast is adopted, but
    the visitor keeps most of their own complexion. Matching fully would make
    everyone come out the colour of the temple, which is the opposite of the
    point. Luminance is nudged harder than colour, because a person lit from the
    wrong side reads as fake faster than one whose skin is slightly off.

    The correction is a plain per-pixel function of the input value, so it is
    returned as three 256-entry tables rather than applied to the image here.
    Statistics are gathered from downscaled copies for the same reason: on a
    17-megapixel photograph a single `.astype(np.float32)` is 200 MB, and doing
    that several times over made the service slower on every successive request
    until it was timing out at the caller.
    """
    scale = min(1.0, STATS_EDGE / max(person.shape[:2]))
    size = (max(16, int(person.shape[1] * scale)), max(16, int(person.shape[0] * scale)))

    src = cv2.cvtColor(
        cv2.resize(person, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2LAB
    ).astype(np.float32)
    dst = cv2.cvtColor(
        cv2.resize(plate, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2LAB
    ).astype(np.float32)
    a = cv2.resize(alpha, size, interpolation=cv2.INTER_AREA)

    covered = float(a.sum())
    ramp = np.arange(256, dtype=np.float32)
    luts: list[np.ndarray] = []

    for channel, pull in ((0, 0.55), (1, 0.35), (2, 0.35)):
        if covered < 100:
            luts.append(ramp.astype(np.uint8))
            continue

        s = src[:, :, channel]
        d = dst[:, :, channel]

        s_mean = float((s * a).sum() / covered)
        d_mean = float(d.mean())
        s_std = float(np.sqrt(((s - s_mean) ** 2 * a).sum() / covered)) or 1.0
        d_std = float(d.std()) or 1.0

        gain = 1.0 + (min(1.6, max(0.6, d_std / s_std)) - 1.0) * pull
        shift = (d_mean - s_mean) * pull
        luts.append(np.clip((ramp - s_mean) * gain + s_mean + shift, 0, 255).astype(np.uint8))

    return luts


def _drop_shadow(canvas: np.ndarray, alpha: np.ndarray, strength: float = 0.38) -> np.ndarray:
    """
    A soft shadow under the visitor so they sit on the floor instead of hovering.

    Deliberately crude - offset down, blurred wide, multiplied in. A correct
    shadow needs the plate's light direction, which we do not know; a soft pool
    beneath the feet is the part the eye actually checks for.
    """
    height, width = alpha.shape[:2]

    # A blurred shadow has no fine detail in it by definition, so it is built
    # small and scaled up. Gaussian-blurring a 17-megapixel buffer to get
    # something this soft is seconds spent on nothing.
    scale = min(1.0, SHADOW_EDGE / max(width, height))
    sw, sh = max(32, int(width * scale)), max(32, int(height * scale))
    small = cv2.resize(alpha, (sw, sh), interpolation=cv2.INTER_AREA)

    offset = max(1, int(sh * 0.012))
    shadow = np.roll(small, offset, axis=0)
    shadow[:offset] = 0
    blur = max(9, int(min(sw, sh) * 0.02)) | 1
    shadow = cv2.GaussianBlur(shadow, (blur, blur), 0)

    # Only under the lower part of the body - a halo around the head is wrong.
    ramp = np.linspace(0.0, 1.0, sh, dtype=np.float32) ** 2.2
    shadow = shadow * ramp[:, None]

    shadow = cv2.resize(shadow, (width, height), interpolation=cv2.INTER_LINEAR)
    return (canvas.astype(np.float32) * (1.0 - shadow[..., None] * strength)).astype(np.uint8)


def compose(
    person_image: np.ndarray,
    plate: np.ndarray,
    placement: Placement | None = None,
    shadow: bool = True,
) -> Outcome:
    """
    @param person_image the booth's capture of the visitor
    @param plate        the finished scene they are being placed into
    """
    placement = placement or Placement()
    detail: dict = {"plate": f"{plate.shape[1]}x{plate.shape[0]}"}

    masks = _person_mask(person_image)
    if masks is None:
        return Outcome(False, reason="Could not separate the visitor from the background", detail=detail)
    alpha, _hair = masks
    alpha = _largest_component(alpha)

    ys, xs = np.nonzero(alpha > 0.5)
    if len(xs) < 500:
        return Outcome(False, reason="No one was found standing in the capture", detail=detail)

    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    detail["cutout"] = f"{x1 - x0}x{y1 - y0}"
    detail["capture"] = f"{person_image.shape[1]}x{person_image.shape[0]}"

    crop = person_image[y0:y1, x0:x1]
    crop_alpha = alpha[y0:y1, x0:x1]

    plate_h, plate_w = plate.shape[:2]
    target_h = max(16, int(plate_h * placement.height))
    scale = target_h / crop.shape[0]
    target_w = max(16, int(crop.shape[1] * scale))
    detail["placed"] = f"{target_w}x{target_h}"
    detail["scale"] = round(scale, 2)

    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    crop = cv2.resize(crop, (target_w, target_h), interpolation=interp)
    crop_alpha = cv2.resize(crop_alpha, (target_w, target_h), interpolation=cv2.INTER_LINEAR)

    # Where it lands on the plate, clipped to the plate's own edges.
    left = int(plate_w * placement.anchor_x) - target_w // 2
    top = int(plate_h * placement.anchor_bottom) - target_h

    canvas_alpha = np.zeros((plate_h, plate_w), dtype=np.float32)
    canvas_person = np.zeros_like(plate)

    sx0, sy0 = max(0, -left), max(0, -top)
    dx0, dy0 = max(0, left), max(0, top)
    w = min(target_w - sx0, plate_w - dx0)
    h = min(target_h - sy0, plate_h - dy0)
    if w <= 0 or h <= 0:
        return Outcome(False, reason="The visitor was placed outside the backplate", detail=detail)

    canvas_person[dy0 : dy0 + h, dx0 : dx0 + w] = crop[sy0 : sy0 + h, sx0 : sx0 + w]
    canvas_alpha[dy0 : dy0 + h, dx0 : dx0 + w] = crop_alpha[sy0 : sy0 + h, sx0 : sx0 + w]

    luts = _plate_luts(canvas_person, canvas_alpha, plate)

    out = plate.copy()
    if shadow:
        out = _drop_shadow(out, canvas_alpha)

    # Correct and blend a few hundred rows at a time. Done whole-image, the
    # float32 buffers this needs come to well over a gigabyte on a 4K plate,
    # which pushed the machine into swap and made each request slower than the
    # one before it until the caller gave up waiting.
    height = plate.shape[0]
    for top in range(0, height, BAND_ROWS):
        bottom = min(height, top + BAND_ROWS)
        weight = canvas_alpha[top:bottom, :, None]
        if not weight.any():
            continue

        band = cv2.cvtColor(canvas_person[top:bottom], cv2.COLOR_BGR2LAB)
        for channel in range(3):
            band[:, :, channel] = cv2.LUT(band[:, :, channel], luts[channel])
        band = cv2.cvtColor(band, cv2.COLOR_LAB2BGR)

        out[top:bottom] = (
            band.astype(np.float32) * weight
            + out[top:bottom].astype(np.float32) * (1.0 - weight)
        ).astype(np.uint8)

    return Outcome(True, image=out, detail=detail)
