/**
 * Client for the local face service.
 *
 * The image model draws a face rather than copying one, so its likeness has a
 * ceiling no prompt clears. The service replaces that face with the visitor's
 * own pixels; this module is the only thing in the app that knows it exists.
 *
 * Every failure path here is deliberately soft. A visitor is standing in front
 * of a camera waiting for a photograph, and the photograph the model produced
 * is a perfectly good one - so a service that is down, slow, or unsure which
 * face to touch results in that photo being kept, with the reason recorded.
 * Nothing about this step is allowed to cost someone their picture.
 */

/** What the service reports about a swap, stored so failures are diagnosable. */
export type SwapDetail = {
  faces_in_photo?: number;
  reference_face_found?: boolean;
  chosen_face?: number;
  score?: number;
  all_scores?: number[];
  score_vs_reference?: number;
  capture_face_px?: number;
  photo_face_px?: number;
  scale_ratio?: number;
};

export type SwapResult =
  | { ok: true; image: string; ms: number; detail: SwapDetail }
  | { ok: false; reason: string; ms: number; detail: SwapDetail };

/**
 * Generation already takes 10-40s and the swap adds 1-2s, so this ceiling is
 * far above anything healthy. It exists to stop a wedged service from holding
 * the booth's request open until the route's own 300s limit.
 */
const TIMEOUT_MS = 45_000;

function serviceUrl(): string | null {
  const raw = process.env.FACE_SERVICE_URL?.trim();
  return raw ? raw.replace(/\/$/, '') : null;
}

/** False when no service is configured, in which case the swap is skipped. */
export function faceSwapConfigured(): boolean {
  return serviceUrl() !== null;
}

export type ComposeDetail = {
  plate?: string;
  capture?: string;
  cutout?: string;
  placed?: string;
  scale?: number;
};

export type ComposeResult =
  | { ok: true; image: string; ms: number; detail: ComposeDetail }
  | { ok: false; reason: string; ms: number; detail: ComposeDetail };

/**
 * The other way of making the photograph: cut the visitor out of the capture
 * and stand them in the scene's prepared backplate.
 *
 * Unlike the swap, this is not an improvement layered onto a photo that already
 * exists - it *is* the photo. A failure here leaves nothing to fall back on, so
 * the caller has to treat it as the generation failing.
 */
export async function composeScene(opts: {
  /** The booth's capture of the visitor, base64. */
  person: string;
  /** The scene's backplate, base64. */
  plate: string;
  placement?: { anchorX: number; anchorBottom: number; height: number };
}): Promise<ComposeResult> {
  const base = serviceUrl();
  const startedAt = Date.now();
  const fail = (reason: string): ComposeResult => ({
    ok: false,
    reason,
    ms: Date.now() - startedAt,
    detail: {},
  });

  if (!base) return fail('No face service configured');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/composite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        person: opts.person,
        plate: opts.plate,
        anchor_x: opts.placement?.anchorX ?? 0.72,
        anchor_bottom: opts.placement?.anchorBottom ?? 1,
        height: opts.placement?.height ?? 0.88,
      }),
      signal: abort.signal,
    });

    if (!res.ok) return fail(`Face service returned ${res.status}`);

    const data = (await res.json()) as {
      ok?: boolean;
      image?: string;
      reason?: string;
      ms?: number;
      detail?: ComposeDetail;
    };

    const ms = data.ms ?? Date.now() - startedAt;
    const detail = data.detail ?? {};

    return data.ok && data.image
      ? { ok: true, image: data.image, ms, detail }
      : { ok: false, reason: data.reason ?? 'The face service gave no reason', ms, detail };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail(`Face service did not answer within ${TIMEOUT_MS / 1000}s`);
    }
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function swapFace(opts: {
  /** The photograph the model produced, base64. */
  target: string;
  /** The booth's capture of the visitor, base64. */
  source: string;
  /** The scene's reference artwork, base64. Its face is the one to leave alone. */
  avoid?: string;
}): Promise<SwapResult> {
  const base = serviceUrl();
  const startedAt = Date.now();
  const fail = (reason: string): SwapResult => ({
    ok: false,
    reason,
    ms: Date.now() - startedAt,
    detail: {},
  });

  if (!base) return fail('No face service configured');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: opts.target,
        source: opts.source,
        avoid: opts.avoid ?? null,
      }),
      signal: abort.signal,
    });

    if (!res.ok) return fail(`Face service returned ${res.status}`);

    const data = (await res.json()) as {
      ok?: boolean;
      image?: string;
      reason?: string;
      ms?: number;
      detail?: SwapDetail;
    };

    const ms = data.ms ?? Date.now() - startedAt;
    const detail = data.detail ?? {};

    return data.ok && data.image
      ? { ok: true, image: data.image, ms, detail }
      : { ok: false, reason: data.reason ?? 'The face service gave no reason', ms, detail };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail(`Face service did not answer within ${TIMEOUT_MS / 1000}s`);
    }
    // Almost always the service simply not being up.
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
