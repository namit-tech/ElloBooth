import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { Device, Tenant, AuditLog } from '@/models';
import { randomToken, hashToken } from '@/lib/crypto';

/**
 * Redeems a one-time pairing code for a long-lived device token.
 *
 * This is the only unauthenticated write in the app, so it is deliberately
 * narrow: the code must exist, be unused and be unexpired, and it is consumed
 * atomically so the same code cannot pair two booths.
 */

export const runtime = 'nodejs';

const Body = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[2-9A-HJ-NP-Z]{6}$/, 'Pairing codes are 6 characters'),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter the 6-character code from your dashboard' }, { status: 400 });
  }

  await connectDB();

  const token = randomToken();

  // findOneAndUpdate is atomic: whichever booth gets here first consumes the
  // code, and the second attempt finds nothing to match.
  const device = await Device.findOneAndUpdate(
    {
      pairingCode: parsed.data.code,
      pairingExpiresAt: { $gt: new Date() },
      tokenHash: { $exists: false },
      revoked: false,
    },
    {
      tokenHash: hashToken(token),
      pairedAt: new Date(),
      lastSeenAt: new Date(),
      $unset: { pairingCode: 1, pairingExpiresAt: 1 },
    },
    { new: true },
  );

  if (!device) {
    return NextResponse.json(
      { error: 'That code is not valid, has expired, or has already been used' },
      { status: 400 },
    );
  }

  const tenant = await Tenant.findById(device.tenantId).lean();
  if (!tenant || tenant.status === 'suspended') {
    return NextResponse.json({ error: 'This account is not active' }, { status: 403 });
  }

  await AuditLog.create({
    actorEmail: `device:${device.name}`,
    action: 'device.paired',
    tenantId: device.tenantId,
    meta: { deviceId: String(device._id) },
  });

  // The plaintext token is returned exactly once - only its hash is stored.
  return NextResponse.json({
    token,
    device: { id: String(device._id), name: device.name },
    tenant: { name: tenant.name },
  });
}
