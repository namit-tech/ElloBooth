'use server';

import { revalidatePath } from 'next/cache';
import { Types } from 'mongoose';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { Scene, AuditLog, type IScene } from '@/models';
import { requireTenant } from '@/lib/rbac';
import { mimeFor, type ImageMime } from '@/lib/gemini';
import { resolveApiKey, providerOf } from '@/lib/ai';
import { describeScene, type SceneDraft } from '@/lib/scene-ai';
import { put, remove, makeKey } from '@/lib/storage';
import { randomToken } from '@/lib/crypto';

export type ActionState = { error?: string; ok?: string };
export type DraftState = ActionState & { draft?: SceneDraft; upload?: { key: string; preview: string } };

const ALLOWED: Record<string, ImageMime> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};
const MAX_BYTES = 12 * 1024 * 1024;

async function readUpload(file: unknown): Promise<{ bytes: Buffer; mime: ImageMime } | string> {
  if (!(file instanceof File) || file.size === 0) return 'Choose a reference image first';
  if (file.size > MAX_BYTES) return 'That image is larger than 12 MB';

  const mime = ALLOWED[file.type];
  if (!mime) return 'Use a JPG, PNG or WebP image';

  const bytes = Buffer.from(await file.arrayBuffer());
  // Thumbnails from a search page are too low-resolution to generate from.
  if (bytes.length < 20_000) {
    return 'That image is too small. Open the full-size version and save that instead.';
  }
  return { bytes, mime };
}

/* ------------------------------------------------------------------ */
/* Step 1 - upload the image and let the model draft the wording       */
/* ------------------------------------------------------------------ */
export async function draftScene(_prev: DraftState, formData: FormData): Promise<DraftState> {
  const { tenantId, tenant, session } = await requireTenant('tenant_admin');

  const read = await readUpload(formData.get('image'));
  if (typeof read === 'string') return { error: read };

  let apiKey: string;
  try {
    apiKey = resolveApiKey(tenant);
  } catch {
    return {
      error: 'No AI key available',
      ok: undefined,
    };
  }

  const described = await describeScene({
    provider: providerOf(tenant),
    apiKey,
    image: { mime_type: read.mime, data: read.bytes.toString('base64') },
    hint: String(formData.get('hint') ?? ''),
  });

  // The image is stored either way, so a failed draft does not mean re-uploading.
  const ext = read.mime === 'image/png' ? '.png' : read.mime === 'image/webp' ? '.webp' : '.jpg';
  const key = makeKey(String(tenantId), 'refs', `${randomToken(12)}${ext}`);
  await put(key, read.bytes);

  await connectDB();
  await AuditLog.create({ actorEmail: session.email, action: 'scene.draft', tenantId });

  const upload = { key, preview: `data:${read.mime};base64,${read.bytes.toString('base64')}` };

  return described.ok
    ? { draft: described.draft, upload, ok: 'Draft ready — read it through and edit anything that looks off.' }
    : { upload, error: `${described.reason} The image is saved, so you can write the wording yourself.` };
}

/* ------------------------------------------------------------------ */
/* Step 2 - save it                                                    */
/* ------------------------------------------------------------------ */
const SceneInput = z.object({
  referenceKey: z.string().min(3),
  name: z.string().trim().min(2, 'Give the scene a name').max(80),
  subtitle: z.string().trim().max(140).optional().default(''),
  aspectRatio: z.enum(['3:4', '4:3', '1:1']),
  scene: z.string().trim().min(20, 'The scene description is too short').max(1500),
  pose: z.string().trim().min(20, 'The pose description is too short').max(1500),
  mood: z.string().trim().max(800).optional().default(''),
});

export async function saveScene(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { tenantId, filter, session } = await requireTenant('tenant_admin');

  const parsed = SceneInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form' };
  const input = parsed.data;

  await connectDB();
  const id = String(formData.get('sceneId') ?? '');

  if (id && Types.ObjectId.isValid(id)) {
    // Scoped, so a tenant can never edit the global library or another tenant's.
    const updated = await Scene.updateOne({ _id: id, ...filter }, { $set: input });
    if (!updated.matchedCount) return { error: 'That scene is not yours to edit' };
    await AuditLog.create({ actorEmail: session.email, action: 'scene.update', tenantId, meta: { id } });
    revalidatePath('/dashboard/scenes');
    return { ok: `"${input.name}" updated.` };
  }

  const count = await Scene.countDocuments(filter);
  await Scene.create({ ...input, tenantId, order: count + 10 });
  await AuditLog.create({ actorEmail: session.email, action: 'scene.create', tenantId, meta: { name: input.name } });

  revalidatePath('/dashboard/scenes');
  return { ok: `"${input.name}" added. It will appear on your booths on their next reload.` };
}

/* ------------------------------------------------------------------ */
export async function toggleScene(formData: FormData): Promise<void> {
  const { filter } = await requireTenant('tenant_admin');
  const id = String(formData.get('sceneId'));
  if (!Types.ObjectId.isValid(id)) return;

  await connectDB();
  const scene = await Scene.findOne({ _id: id, ...filter }).lean<IScene>();
  if (!scene) return;

  await Scene.updateOne({ _id: id, ...filter }, { active: !scene.active });
  revalidatePath('/dashboard/scenes');
}

export async function deleteScene(formData: FormData): Promise<void> {
  const { tenantId, filter, session } = await requireTenant('tenant_admin');
  const id = String(formData.get('sceneId'));
  if (!Types.ObjectId.isValid(id)) return;

  await connectDB();
  const scene = await Scene.findOne({ _id: id, ...filter }).lean<IScene>();
  if (!scene) return;

  await Scene.deleteOne({ _id: id, ...filter });
  // Past photos keep their own stored files; only the reference goes.
  await remove(scene.referenceKey).catch(() => {});
  await AuditLog.create({
    actorEmail: session.email,
    action: 'scene.delete',
    tenantId,
    meta: { name: scene.name },
  });

  revalidatePath('/dashboard/scenes');
}

/** Serves a tenant's own reference image to their dashboard. */
export async function referenceMime(key: string): Promise<ImageMime> {
  return mimeFor(key);
}
