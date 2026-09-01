import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

/**
 * Puts the visitor's real face into the generated photo.
 *
 * The generative model draws a face rather than copying one, so its likeness
 * has a hard ceiling no amount of prompting clears. This step sidesteps that
 * entirely: it finds the same landmarks on the real capture and on the
 * generated photo, aligns the real face onto the generated one, and blends it
 * in. The pixels a visitor recognises as themselves are their own.
 *
 * A similarity transform (uniform scale, rotation, translation) is enough
 * because the scene prompt forces a near-frontal head. A full piecewise warp
 * would be needed for large angle differences and is deliberately not built
 * until something demands it.
 *
 * Everything runs in the booth's browser: MediaPipe's WASM and model are served
 * from /mp, so this also works while the venue's connection is down.
 */

/** Outline of the face, used to build the blend mask. */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/**
 * Anchors for alignment. Eyes and mouth are the most reliably placed points and
 * together pin down scale, rotation and position.
 */
const ANCHORS = [33, 133, 362, 263, 61, 291, 1, 152];

export type BlendOutcome =
  | { ok: true; blob: Blob; ms: number }
  | { ok: false; reason: string; ms: number };

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** Loaded once and reused; first load reads ~4 MB and takes a moment. */
function getLandmarker(): Promise<FaceLandmarker> {
  landmarkerPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks('/mp/wasm');
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/mp/face_landmarker.task' },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
  })();
  return landmarkerPromise;
}

/** Warm the model up during the idle screen so the first photo is not slower. */
export function preloadFaceModel(): void {
  getLandmarker().catch(() => {
    /* falls back to the unblended photo if it never loads */
  });
}

type Pt = { x: number; y: number };

function toPixels(result: FaceLandmarkerResult, w: number, h: number, indices: number[]): Pt[] | null {
  const face = result.faceLandmarks?.[0];
  if (!face) return null;
  return indices.map((i) => ({ x: face[i].x * w, y: face[i].y * h }));
}

/**
 * Least-squares similarity transform mapping `from` onto `to`.
 * Returns the canvas matrix [a, b, -b, a, tx, ty].
 */
function similarity(from: Pt[], to: Pt[]): [number, number, number, number, number, number] | null {
  const n = from.length;
  if (n < 2 || to.length !== n) return null;

  const mean = (pts: Pt[]) => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  });
  const fc = mean(from);
  const tc = mean(to);

  let sxx = 0; // dot product term  -> scale * cos
  let sxy = 0; // cross product term -> scale * sin
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const fx = from[i].x - fc.x;
    const fy = from[i].y - fc.y;
    const tx = to[i].x - tc.x;
    const ty = to[i].y - tc.y;
    sxx += fx * tx + fy * ty;
    sxy += fx * ty - fy * tx;
    norm += fx * fx + fy * fy;
  }
  if (norm < 1e-6) return null;

  const a = sxx / norm;
  const b = sxy / norm;

  // A wildly different scale means the two detections are not comparable.
  const scale = Math.hypot(a, b);
  if (!Number.isFinite(scale) || scale < 0.2 || scale > 5) return null;

  return [a, b, -b, a, tc.x - (a * fc.x - b * fc.y), tc.y - (b * fc.x + a * fc.y)];
}

/**
 * Pulls an outline in toward its centre. Blending right at the silhouette is
 * where seams show, so both faces are trimmed slightly before compositing.
 */
function shrink(points: Pt[], factor: number): Pt[] {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Filled, feathered outline of the target face - the region we replace. */
function buildMask(oval: Pt[], w: number, h: number, feather: number): HTMLCanvasElement {
  const mask = makeCanvas(w, h);
  const ctx = mask.getContext('2d')!;

  ctx.filter = `blur(${feather}px)`;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(oval[0].x, oval[0].y);
  for (let i = 1; i < oval.length; i++) ctx.lineTo(oval[i].x, oval[i].y);
  ctx.closePath();
  ctx.fill();

  return mask;
}

/**
 * Shifts the transplanted face to sit in the generated photo's light.
 *
 * Without this the face is recognisable but obviously pasted - lit from the
 * wrong side and the wrong colour temperature. Means are matched fully;
 * contrast is only nudged, since matching it exactly amplifies noise.
 */
function matchColour(faceCtx: CanvasRenderingContext2D, sceneCtx: CanvasRenderingContext2D, box: DOMRect): void {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.max(1, Math.floor(box.width));
  const h = Math.max(1, Math.floor(box.height));

  const face = faceCtx.getImageData(x, y, w, h);
  const scene = sceneCtx.getImageData(x, y, w, h);

  for (let ch = 0; ch < 3; ch++) {
    let fs = 0;
    let ss = 0;
    let fq = 0;
    let sq = 0;
    let n = 0;

    for (let i = 0; i < face.data.length; i += 4) {
      if (face.data[i + 3] < 200) continue; // outside the transplanted face
      const f = face.data[i + ch];
      const s = scene.data[i + ch];
      fs += f;
      ss += s;
      fq += f * f;
      sq += s * s;
      n++;
    }
    if (n < 50) return; // too little overlap to judge

    const fMean = fs / n;
    const sMean = ss / n;
    const fStd = Math.sqrt(Math.max(1, fq / n - fMean * fMean));
    const sStd = Math.sqrt(Math.max(1, sq / n - sMean * sMean));
    const gain = Math.min(1.25, Math.max(0.8, sStd / fStd));

    for (let i = 0; i < face.data.length; i += 4) {
      if (face.data[i + 3] === 0) continue;
      const v = (face.data[i + ch] - fMean) * gain + sMean;
      face.data[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  faceCtx.putImageData(face, x, y);
}

async function toBitmap(src: Blob | HTMLImageElement): Promise<ImageBitmap> {
  return src instanceof Blob ? createImageBitmap(src) : createImageBitmap(src);
}

/**
 * @param generated the photo returned by the model
 * @param capture   the booth's original photograph of the visitor
 */
export async function blendRealFace(generated: Blob, capture: Blob): Promise<BlendOutcome> {
  const startedAt = Date.now();
  const fail = (reason: string): BlendOutcome => ({ ok: false, reason, ms: Date.now() - startedAt });
  const pass = (blob: Blob): BlendOutcome => ({ ok: true, blob, ms: Date.now() - startedAt });

  let landmarker: FaceLandmarker;
  try {
    landmarker = await getLandmarker();
  } catch (err) {
    return fail(`Face model unavailable: ${err instanceof Error ? err.message : err}`);
  }

  const [sceneBmp, faceBmp] = await Promise.all([toBitmap(generated), toBitmap(capture)]);
  const W = sceneBmp.width;
  const H = sceneBmp.height;

  const sceneCanvas = makeCanvas(W, H);
  const sceneCtx = sceneCanvas.getContext('2d', { willReadFrequently: true })!;
  sceneCtx.drawImage(sceneBmp, 0, 0);

  const capCanvas = makeCanvas(faceBmp.width, faceBmp.height);
  capCanvas.getContext('2d')!.drawImage(faceBmp, 0, 0);

  const sceneMarks = landmarker.detect(sceneCanvas);
  const capMarks = landmarker.detect(capCanvas);

  const sceneAnchors = toPixels(sceneMarks, W, H, ANCHORS);
  const capAnchors = toPixels(capMarks, faceBmp.width, faceBmp.height, ANCHORS);
  const sceneOval = toPixels(sceneMarks, W, H, FACE_OVAL);
  const capOval = toPixels(capMarks, faceBmp.width, faceBmp.height, FACE_OVAL);

  if (!sceneAnchors || !sceneOval) return fail('No face found in the generated photo');
  if (!capAnchors || !capOval) return fail('No face found in the original capture');

  const matrix = similarity(capAnchors, sceneAnchors);
  if (!matrix) return fail('Could not align the two faces');

  // Draw the real face into the generated photo's coordinate space.
  const faceLayer = makeCanvas(W, H);
  const faceCtx = faceLayer.getContext('2d', { willReadFrequently: true })!;
  faceCtx.setTransform(...matrix);
  faceCtx.drawImage(capCanvas, 0, 0);
  faceCtx.setTransform(1, 0, 0, 1, 0, 0);

  // Keep only the part that is face in BOTH images, with soft edges.
  const xs = sceneOval.map((p) => p.x);
  const ys = sceneOval.map((p) => p.y);
  const box = new DOMRect(
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  const feather = Math.max(6, Math.min(box.width, box.height) * 0.09);

  /* The mask is the intersection of both faces.
     Using only the generated face's outline pulls in whatever sat behind the
     visitor in the capture - a couch, a wall - wherever that outline reaches
     past their real face, which showed up as a hard dark patch along the jaw.
     Clipping to the capture's own face outline first makes that impossible. */
  faceCtx.globalCompositeOperation = 'destination-in';

  // Still in the transformed space, so the capture's outline lands correctly.
  faceCtx.setTransform(...matrix);
  faceCtx.drawImage(
    buildMask(shrink(capOval, 0.94), faceBmp.width, faceBmp.height, feather * 0.8),
    0,
    0,
  );
  faceCtx.setTransform(1, 0, 0, 1, 0, 0);

  faceCtx.drawImage(buildMask(shrink(sceneOval, 0.97), W, H, feather), 0, 0);
  faceCtx.globalCompositeOperation = 'source-over';

  matchColour(faceCtx, sceneCtx, box);

  sceneCtx.drawImage(faceLayer, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    sceneCanvas.toBlob(resolve, 'image/jpeg', 0.94),
  );
  if (!blob) return fail('Could not encode the blended photo');

  return pass(blob);
}
