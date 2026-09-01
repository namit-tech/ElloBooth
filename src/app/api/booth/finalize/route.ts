import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { Generation, type IGeneration } from '@/models';
import { requireDevice, HttpError } from '@/lib/rbac';
import { put, remove, makeKey } from '@/lib/storage';
import { OUTPUT_EXT } from '@/lib/gemini';

/**
 * Stores the booth's face-blended version as the photo the visitor keeps.
 *
 * The blend runs in the booth's browser (MediaPipe + canvas), so the finished
 * image has to come back here to stay the canonical copy behind the QR link.
 * Only a paired device can call this, and only for its own tenant's photo.
 *
 * Whatever the model produced is retained as `imageKeyRaw`, which is what the
 * dashboard's before/after toggle compares against.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  shareToken: z.string().regex(/^[\w-]{20,64}$/),
  imageBase64: z.string().min(1000, 'The blended photo looks empty'),
  ms: z.coerce.number().min(0).max(600_000).optional(),
});

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
  const { tenantId } = scope;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Bad request' }, { status: 400 });
  }
  const { shareToken, imageBase64, ms } = parsed.data;

  await connectDB();

  // Scoped by tenant so one booth can never overwrite another tenant's photo.
  const generation = await Generation.findOne({ shareToken, tenantId, status: 'ok' }).lean<IGeneration>();
  if (!generation?.imageKey) {
    return NextResponse.json({ error: 'That photo was not found' }, { status: 404 });
  }

  // Already finalised - the booth retried. Nothing to do.
  if (generation.imageKeyRaw && generation.imageKeyRaw !== generation.imageKey) {
    const alreadyBlended = generation.imageKey.includes('-final');
    if (alreadyBlended) return NextResponse.json({ ok: true, alreadyFinal: true });
  }

  const finalKey = makeKey(String(tenantId), 'photos', `${shareToken}-final${OUTPUT_EXT}`);
  await put(finalKey, Buffer.from(imageBase64, 'base64'));

  // The model's own output becomes the "before" side of the comparison. Any
  // earlier raw is superseded, so remove its file rather than orphan it.
  const supersededRaw = generation.imageKeyRaw;

  await Generation.updateOne(
    { _id: generation._id, tenantId },
    {
      $set: {
        imageKey: finalKey,
        imageKeyRaw: generation.imageKey,
        realFaceMs: ms ?? 0,
        realFace: true,
      },
    },
  );

  if (supersededRaw && supersededRaw !== generation.imageKey) {
    await remove(supersededRaw).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
