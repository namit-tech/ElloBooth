import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import { z } from 'zod';
import QRCode from 'qrcode';
import { connectDB } from '@/lib/db';
import { Scene, Generation, type IScene } from '@/models';
import { requireDevice, HttpError } from '@/lib/rbac';
import { reserveCredit, refundCredit, costOf, creditsNeeded } from '@/lib/credits';
import { buildPrompt, mimeFor, OUTPUT_MIME, OUTPUT_EXT } from '@/lib/gemini';
import { resolveApiKey, generateImage, refineFace, providerOf, modelFor } from '@/lib/ai';
import { swapFace, composeScene, faceSwapConfigured, type SwapDetail } from '@/lib/faceswap';
import { get, put, makeKey } from '@/lib/storage';
import { randomToken } from '@/lib/crypto';

export const runtime = 'nodejs';
// Two passes on the Pro model can each take over 90s, so the ceiling has to
// clear roughly 4 minutes or the request is cut off mid-generation.
export const maxDuration = 300;

const Body = z.object({
  sceneId: z.string().refine(Types.ObjectId.isValid, 'Unknown scene'),
  imageBase64: z.string().min(1000, 'The capture looks empty'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
});

function baseUrl(req: Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  // Fall back to whatever host the booth reached us on, so the QR works on a LAN.
  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireDevice(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: err.status });
    }
    throw err;
  }

  const { tenant, tenantId, deviceId } = scope;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Bad request' }, { status: 400 });
  }
  const { sceneId, imageBase64, mimeType } = parsed.data;

  await connectDB();

  // Scoped so a booth can only use global scenes or its own tenant's.
  const scene = await Scene.findOne({
    _id: sceneId,
    active: true,
    $or: [{ tenantId: null }, { tenantId }],
  }).lean<IScene>();
  if (!scene) {
    return NextResponse.json({ error: 'That scene is not available on this account' }, { status: 404 });
  }

  /* ================= Composite scenes =================
     A composite scene never reaches the image model. The visitor is cut out of
     the capture and stood in a prepared backplate, so the deity is identical in
     every photograph and the visitor is their own photograph rather than a
     drawing of one.

     Deliberately written as a self-contained branch rather than threaded
     through the generative path below: everything after this point - credits,
     API keys, two model passes, the face transplant - has no part in it, and
     keeping them apart means this block can be deleted to go back to exactly
     the previous behaviour.

     No credit is reserved or spent. There is no provider call to pay for. */
  if (scene.mode === 'composite') {
    if (!scene.backplateKey) {
      return NextResponse.json(
        {
          error: `No backplate for "${scene.name}"`,
          detail: 'This scene is set to composite. Upload its backplate image in Scenes.',
        },
        { status: 400 },
      );
    }

    const plateBytes = await get(scene.backplateKey);
    if (!plateBytes) {
      return NextResponse.json(
        {
          error: `The backplate for "${scene.name}" is missing`,
          detail: 'Re-upload it in Scenes.',
        },
        { status: 400 },
      );
    }

    const composed = await composeScene({
      person: imageBase64,
      plate: plateBytes.toString('base64'),
      placement: scene.placement,
    });

    if (!composed.ok) {
      await Generation.create({
        tenantId,
        deviceId,
        sceneId: scene._id,
        model: 'composite',
        keyMode: tenant.keyMode,
        status: 'error',
        ms: composed.ms,
        costUsd: 0,
        error: composed.reason.slice(0, 500),
      });

      return NextResponse.json(
        { error: 'The photo could not be created', detail: composed.reason.slice(0, 400) },
        { status: 422 },
      );
    }

    const shareToken = randomToken(18);
    const imageKey = makeKey(String(tenantId), 'photos', `${shareToken}${OUTPUT_EXT}`);
    await put(imageKey, Buffer.from(composed.image, 'base64'));

    const retentionDays = tenant.settings.retentionDays;
    await Generation.create({
      tenantId,
      deviceId,
      sceneId: scene._id,
      model: 'composite',
      keyMode: tenant.keyMode,
      status: 'ok',
      ms: composed.ms,
      costUsd: 0,
      imageKey,
      // The visitor's own pixels, by construction - there was never a drawn
      // face to replace.
      realFace: true,
      realFaceMs: composed.ms,
      faceDetail: composed.detail,
      shareToken,
      expiresAt: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : undefined,
    });

    const shareUrl = `${baseUrl(req)}/photo/${shareToken}`;
    return NextResponse.json({
      shareToken,
      imageUrl: `/api/photo/${shareToken}`,
      shareUrl,
      qr: await QRCode.toDataURL(shareUrl, { margin: 1, width: 320 }),
      ms: composed.ms,
    });
  }
  /* =============== end composite scenes =============== */

  const referenceBytes = await get(scene.referenceKey);
  if (!referenceBytes) {
    return NextResponse.json(
      {
        error: `No reference image for "${scene.name}"`,
        detail: 'Upload the reference image for this scene before using it at an event.',
      },
      { status: 400 },
    );
  }

  const provider = providerOf(tenant);
  const model = modelFor(tenant).id;
  const identityLock = tenant.settings.identityLock;
  const passes = creditsNeeded(tenant);

  // Reserve before calling the provider so concurrent booths cannot overspend.
  try {
    await reserveCredit(tenant, passes);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: err.status });
    }
    throw err;
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey(tenant);
  } catch (err) {
    await refundCredit(tenantId, tenant.keyMode, passes);
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: err.status });
    }
    throw err;
  }

  const result = await generateImage({
    provider,
    apiKey,
    model,
    imageSize: tenant.settings.imageSize,
    aspectRatio: scene.aspectRatio,
    capture: { mime_type: mimeType, data: imageBase64 },
    reference: { mime_type: mimeFor(scene.referenceKey), data: referenceBytes.toString('base64') },
    prompt: buildPrompt(scene),
  });

  if (!result.ok) {
    // The visitor got nothing, so every reserved credit goes back.
    await refundCredit(tenantId, tenant.keyMode, passes);
    await Generation.create({
      tenantId,
      deviceId,
      sceneId: scene._id,
      model,
      keyMode: tenant.keyMode,
      status: 'refused',
      ms: result.ms,
      costUsd: 0,
      identityLock,
      error: result.reason.slice(0, 500),
    });

    return NextResponse.json(
      { error: 'The photo could not be created', detail: result.reason.slice(0, 400) },
      { status: 422 },
    );
  }

  /* -------- Pass 2: correct the face, if identity lock is on --------
     Pass 1 already produced a usable photo. If this second pass fails for any
     reason the visitor still gets that photo - a worse face beats no photo at
     a live event - and the unused credit is returned. */
  let composed = result.image;
  let refineError: string | undefined;
  let refineMs = 0;

  if (identityLock) {
    const refined = await refineFace({
      provider,
      apiKey,
      model,
      imageSize: tenant.settings.imageSize,
      aspectRatio: scene.aspectRatio,
      composed: { mime_type: OUTPUT_MIME, data: result.image },
      capture: { mime_type: mimeType, data: imageBase64 },
    });
    refineMs = refined.ms;

    if (refined.ok) {
      composed = refined.image;
    } else {
      refineError = refined.reason.slice(0, 500);
      console.warn(`[identity-lock] ${scene.name}: ${refineError}`);
      await refundCredit(tenantId, tenant.keyMode, 1);
    }
  }

  /* -------- Put the visitor's actual face in --------
     The model draws a face rather than copying one, so no prompt gets the
     likeness past roughly 85-90%. The face service replaces that region with
     the real pixels from the capture.

     It runs here rather than in the booth for two reasons: photos generated
     from the offline queue get it too, which the browser-side version never
     did, and the image stored behind the QR link is the same one shown on
     screen instead of a second upload racing it.

     The scene's reference goes along so the service can tell which face in the
     photo is the visitor and which belongs to the deity or celebrity that must
     keep its own. Any failure leaves the model's photo untouched. */
  let finalImage = composed;
  let realFaceOk = false;
  let realFaceError: string | undefined;
  let realFaceMs = 0;
  let faceDetail: SwapDetail | undefined;

  if (tenant.settings.realFace && faceSwapConfigured()) {
    const swapped = await swapFace({
      target: composed,
      source: imageBase64,
      avoid: referenceBytes.toString('base64'),
    });
    realFaceMs = swapped.ms;
    faceDetail = swapped.detail;

    if (swapped.ok) {
      finalImage = swapped.image;
      realFaceOk = true;
    } else {
      realFaceError = swapped.reason.slice(0, 500);
      console.warn(`[real-face] ${scene.name}: ${realFaceError}`);
    }
  }

  const shareToken = randomToken(18);
  const imageKey = makeKey(String(tenantId), 'photos', `${shareToken}${OUTPUT_EXT}`);
  await put(imageKey, Buffer.from(finalImage, 'base64'));

  /* The "before" side of the dashboard comparison: the photo one improvement
     step earlier. Once the real face is in, that is the model's own rendering
     of the visitor, which is the comparison actually worth looking at.
     Otherwise it is pass 1, kept so identity lock's extra credit can be judged. */
  const before = realFaceOk ? composed : identityLock && !refineError ? result.image : null;
  let imageKeyRaw: string | undefined;
  if (before) {
    imageKeyRaw = makeKey(String(tenantId), 'photos', `${shareToken}-raw${OUTPUT_EXT}`);
    await put(imageKeyRaw, Buffer.from(before, 'base64'));
  }

  const costUsd = costOf(model) * (identityLock && !refineError ? 2 : 1);
  const retentionDays = tenant.settings.retentionDays;

  await Generation.create({
    tenantId,
    deviceId,
    sceneId: scene._id,
    model,
    keyMode: tenant.keyMode,
    status: 'ok',
    ms: result.ms + refineMs + realFaceMs,
    costUsd,
    imageKey,
    imageKeyRaw,
    identityLock,
    refineError,
    realFace: realFaceOk,
    realFaceMs,
    realFaceError,
    faceDetail,
    shareToken,
    expiresAt: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : undefined,
  });

  const shareUrl = `${baseUrl(req)}/photo/${shareToken}`;

  return NextResponse.json({
    shareToken,
    imageUrl: `/api/photo/${shareToken}`,
    shareUrl,
    qr: await QRCode.toDataURL(shareUrl, { margin: 1, width: 320 }),
    ms: result.ms + refineMs + realFaceMs,
  });
}
