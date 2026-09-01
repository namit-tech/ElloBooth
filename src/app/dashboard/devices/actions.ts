'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { Device, AuditLog } from '@/models';
import { requireTenant } from '@/lib/rbac';
import { pairingCode } from '@/lib/crypto';

export type ActionState = { error?: string; ok?: string; code?: string };

/** A pairing code is single-use and short-lived; a booth redeems it for a token. */
const PAIRING_WINDOW_MINUTES = 30;

export async function createDevice(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { tenantId, session } = await requireTenant('tenant_admin');

  const parsed = z.string().trim().min(2, 'Give the booth a name').max(60).safeParse(formData.get('name'));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid name' };

  await connectDB();

  // Collisions are vanishingly unlikely, but a duplicate live code would let a
  // booth pair into the wrong tenant, so retry rather than assume.
  let code = pairingCode();
  for (let i = 0; i < 5; i++) {
    const clash = await Device.findOne({ pairingCode: code, pairingExpiresAt: { $gt: new Date() } });
    if (!clash) break;
    code = pairingCode();
  }

  await Device.create({
    tenantId,
    name: parsed.data,
    pairingCode: code,
    pairingExpiresAt: new Date(Date.now() + PAIRING_WINDOW_MINUTES * 60 * 1000),
  });

  await AuditLog.create({
    actorEmail: session.email,
    action: 'device.create',
    tenantId,
    meta: { name: parsed.data },
  });

  revalidatePath('/dashboard/devices');
  return { ok: `Enter this code on the booth within ${PAIRING_WINDOW_MINUTES} minutes.`, code };
}

export async function revokeDevice(formData: FormData): Promise<void> {
  const { tenantId, filter, session } = await requireTenant('tenant_admin');
  const deviceId = String(formData.get('deviceId'));

  await connectDB();
  // Scoped by tenant so one tenant can never revoke another's booth.
  await Device.updateOne(
    { _id: deviceId, ...filter },
    { revoked: true, $unset: { tokenHash: 1, pairingCode: 1 } },
  );

  await AuditLog.create({
    actorEmail: session.email,
    action: 'device.revoke',
    tenantId,
    meta: { deviceId },
  });

  revalidatePath('/dashboard/devices');
}

export async function regenerateCode(formData: FormData): Promise<void> {
  const { filter } = await requireTenant('tenant_admin');
  const deviceId = String(formData.get('deviceId'));

  await connectDB();
  await Device.updateOne(
    { _id: deviceId, ...filter },
    {
      pairingCode: pairingCode(),
      pairingExpiresAt: new Date(Date.now() + PAIRING_WINDOW_MINUTES * 60 * 1000),
      $unset: { tokenHash: 1 },
      pairedAt: null,
    },
  );

  revalidatePath('/dashboard/devices');
}
