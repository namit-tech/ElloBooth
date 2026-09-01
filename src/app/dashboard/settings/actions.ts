'use server';

import { revalidatePath } from 'next/cache';
import { Types } from 'mongoose';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { Tenant, AuditLog } from '@/models';
import { requireTenant } from '@/lib/rbac';
import { seal, open } from '@/lib/crypto';
import { probeKey, providerOf, PROVIDER_INFO, resolveModel, PROVIDERS, type Provider } from '@/lib/ai';

export type ActionState = { error?: string; ok?: string };

async function audit(
  action: string,
  tenantId: Types.ObjectId,
  email: string,
  meta?: Record<string, unknown>,
) {
  await AuditLog.create({ actorEmail: email, action, tenantId, meta });
}

/* ------------------------------------------------------------------ */
/* API key                                                             */
/* ------------------------------------------------------------------ */

/** Which provider a key form is acting on; falls back to the tenant's own. */
function targetProvider(formData: FormData, fallback: Provider): Provider {
  const raw = String(formData.get('provider') ?? '');
  return (PROVIDERS as readonly string[]).includes(raw) ? (raw as Provider) : fallback;
}

export async function saveApiKey(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { tenantId, tenant, session } = await requireTenant('tenant_admin');
  const provider = targetProvider(formData, providerOf(tenant));
  const info = PROVIDER_INFO[provider];

  const parsed = z
    .string()
    .trim()
    .min(20, 'That does not look like a complete API key')
    .safeParse(formData.get('apiKey'));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid key' };

  // Verify against the model this tenant will actually generate with, so a key
  // that works but lacks access to that model is caught here, not at an event.
  const model = resolveModel(provider, tenant.settings.model).id;
  const probe = await probeKey(provider, parsed.data, model);
  if (!probe.ok) return { error: probe.reason };

  await connectDB();
  const sealed = seal(parsed.data);
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        [`apiKeys.${provider}`]: { ...sealed, verifiedAt: new Date() },
        keyMode: 'byok',
        'settings.provider': provider,
      },
    },
  );

  // Only the masked hint is ever recorded - never the key itself.
  await audit('tenant.apikey.set', tenantId, session.email, { provider, hint: sealed.hint });
  revalidatePath('/dashboard/settings');
  return { ok: `${info.label} key saved and verified (${sealed.hint}).` };
}

export async function testApiKey(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { tenant } = await requireTenant('tenant_admin');
  const provider = targetProvider(formData, providerOf(tenant));
  const sealed = tenant.apiKeys?.[provider];

  if (!sealed?.ciphertext) return { error: `No ${PROVIDER_INFO[provider].label} key is stored.` };

  const model = resolveModel(provider, tenant.settings.model).id;
  const probe = await probeKey(provider, open(sealed), model);
  return probe.ok
    ? { ok: `Key ${sealed.hint} is working with ${model}.` }
    : { error: probe.reason };
}

export async function removeApiKey(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { tenantId, tenant, session } = await requireTenant('tenant_admin');
  const provider = targetProvider(formData, providerOf(tenant));

  await connectDB();
  const remaining = { ...(tenant.apiKeys ?? {}) };
  delete remaining[provider];

  await Tenant.updateOne(
    { _id: tenantId },
    {
      $unset: { [`apiKeys.${provider}`]: 1 },
      // Only fall back to platform credits once no key is left at all.
      ...(Object.keys(remaining).length === 0 ? { $set: { keyMode: 'platform' } } : {}),
    },
  );
  await audit('tenant.apikey.remove', tenantId, session.email, { provider });

  revalidatePath('/dashboard/settings');
  return { ok: `${PROVIDER_INFO[provider].label} key removed.` };
}

/* ------------------------------------------------------------------ */
/* Booth settings                                                      */
/* ------------------------------------------------------------------ */
const Settings = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(3),
  imageSize: z.enum(['1K', '2K', '4K']),
  autoCaptureSeconds: z.coerce.number().min(1).max(10),
  countdownSeconds: z.coerce.number().int().min(1).max(10),
  resultDisplaySeconds: z.coerce.number().int().min(5).max(120),
  retentionDays: z.coerce.number().int().min(0).max(365),
  // An unchecked checkbox is simply absent from FormData, so treat missing as off.
  identityLock: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  realFace: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  consentText: z.string().trim().max(400),
  idleTitle: z.string().trim().max(120),
  idleSubtitle: z.string().trim().max(160),
  accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Accent must be a hex colour like #e0a63c'),
});

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { tenantId, session } = await requireTenant('tenant_admin');

  const parsed = Settings.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form' };
  const s = parsed.data;

  // Guard the pairing here, so a booth never sends a size its model rejects.
  const chosen = resolveModel(s.provider, s.model);
  if (chosen.id !== s.model) return { error: 'That model is not available for the chosen provider.' };
  if (!chosen.sizes.includes(s.imageSize)) {
    return { error: `${chosen.label} only supports ${chosen.sizes.join(', ')}.` };
  }

  await connectDB();
  await Tenant.updateOne(
    { _id: tenantId },
    {
      $set: {
        'settings.provider': s.provider,
        'settings.model': s.model,
        'settings.imageSize': s.imageSize,
        'settings.autoCaptureSeconds': s.autoCaptureSeconds,
        'settings.countdownSeconds': s.countdownSeconds,
        'settings.resultDisplaySeconds': s.resultDisplaySeconds,
        'settings.retentionDays': s.retentionDays,
        'settings.identityLock': s.identityLock,
        'settings.realFace': s.realFace,
        'settings.consentText': s.consentText,
        'branding.idleTitle': s.idleTitle,
        'branding.idleSubtitle': s.idleSubtitle,
        'branding.accent': s.accent,
      },
    },
  );
  await audit('tenant.settings.update', tenantId, session.email, {
    model: s.model,
    identityLock: s.identityLock,
    realFace: s.realFace,
  });

  revalidatePath('/dashboard/settings');
  return { ok: 'Settings saved. Booths pick these up on their next photo.' };
}
