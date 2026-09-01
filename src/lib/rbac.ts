import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import { getSession, effectiveTenantId, type Session } from '@/lib/auth';
import { connectDB } from '@/lib/db';
import { Device, Tenant, RANK, type ITenant, type Role } from '@/models';
import { hashToken } from '@/lib/crypto';

/**
 * Every authorisation decision in the app goes through this file.
 *
 * The rule that matters: nothing reaches the database without a tenant scope.
 * Route handlers get their scope from `requireTenant` or `requireDevice` and
 * must spread it into every query, rather than building filters by hand.
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

/** Any signed-in human. */
export async function requireUser(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new HttpError(401, 'Not signed in');
  return session;
}

/** A human with at least the given role. */
export async function requireRole(minimum: Role): Promise<Session> {
  const session = await requireUser();
  if (RANK[session.role] < RANK[minimum]) {
    throw new HttpError(403, 'You do not have access to this');
  }
  return session;
}

export async function requireSuperadmin(): Promise<Session> {
  const session = await requireUser();
  if (session.role !== 'superadmin') throw new HttpError(403, 'Superadmin only');
  return session;
}

export type TenantScope = {
  session: Session;
  tenantId: Types.ObjectId;
  tenant: ITenant;
  /** Spread into every query: `Scene.find({ ...scope.filter })`. */
  filter: { tenantId: Types.ObjectId };
};

/** A human acting inside a specific tenant. */
export async function requireTenant(minimum: Role = 'operator'): Promise<TenantScope> {
  const session = await requireRole(minimum);
  const id = effectiveTenantId(session);
  if (!id) throw new HttpError(403, 'This action must be performed inside a tenant');

  await connectDB();
  const tenantId = new Types.ObjectId(id);
  const tenant = await Tenant.findById(tenantId).lean<ITenant>();
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  if (tenant.status === 'suspended') {
    throw new HttpError(403, 'This account is suspended', 'Please contact Elloindia support.');
  }

  return { session, tenantId, tenant, filter: { tenantId } };
}

export type DeviceScope = {
  deviceId: Types.ObjectId;
  tenantId: Types.ObjectId;
  tenant: ITenant;
  filter: { tenantId: Types.ObjectId };
};

/**
 * A paired booth. Booths send `Authorization: Bearer <device token>` instead of
 * a session cookie, so event staff never handle credentials.
 */
export async function requireDevice(req: Request): Promise<DeviceScope> {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'This booth is not paired');

  await connectDB();
  const device = await Device.findOne({ tokenHash: hashToken(token), revoked: false });
  if (!device) throw new HttpError(401, 'Booth pairing is invalid or has been revoked');

  const tenant = await Tenant.findById(device.tenantId).lean<ITenant>();
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  if (tenant.status === 'suspended') {
    throw new HttpError(403, 'This account is suspended', 'Please contact Elloindia support.');
  }

  // Fire-and-forget heartbeat so the dashboard can show booths as online.
  Device.updateOne({ _id: device._id }, { lastSeenAt: new Date() }).catch(() => {});

  return {
    deviceId: device._id,
    tenantId: device.tenantId,
    tenant,
    filter: { tenantId: device.tenantId },
  };
}

/** Wraps a route handler so thrown HttpErrors become clean JSON responses. */
export function handler(fn: (req: Request, ctx: never) => Promise<Response>) {
  return async (req: Request, ctx: never): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message, detail: err.detail }, { status: err.status });
      }
      console.error('[unhandled]', err);
      return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
    }
  };
}
