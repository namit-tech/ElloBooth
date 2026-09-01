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
  let finalImage = result.image;
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
      finalImage = refined.image;
    } else {
      refineError = refined.reason.slice(0, 500);
      console.warn(`[identity-lock] ${scene.name}: ${refineError}`);
      await refundCredit(tenantId, tenant.keyMode, 1);
    }
  }

  const shareToken = randomToken(18);
  const imageKey = makeKey(String(tenantId), 'photos', `${shareToken}${OUTPUT_EXT}`);
  await put(imageKey, Buffer.from(finalImage, 'base64'));

  // Keep pass 1's output alongside it so the tenant can judge whether identity
  // lock is actually earning its extra credit.
  let imageKeyRaw: string | undefined;
  if (identityLock && !refineError) {
    imageKeyRaw = makeKey(String(tenantId), 'photos', `${shareToken}-raw${OUTPUT_EXT}`);
    await put(imageKeyRaw, Buffer.from(result.image, 'base64'));
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
    ms: result.ms + refineMs,
    costUsd,
    imageKey,
    imageKeyRaw,
    identityLock,
    refineError,
    shareToken,
    expiresAt: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : undefined,
  });

  const shareUrl = `${baseUrl(req)}/photo/${shareToken}`;

  return NextResponse.json({
    shareToken,
    imageUrl: `/api/photo/${shareToken}`,
    shareUrl,
    qr: await QRCode.toDataURL(shareUrl, { margin: 1, width: 320 }),
    ms: result.ms + refineMs,
  });
}
