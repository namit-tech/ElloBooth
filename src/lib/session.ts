import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@/models/roles';

/**
 * Edge-safe half of auth: JWT only, no bcrypt and no `cookies()`.
 * `middleware.ts` runs on the edge runtime and can import this; anything that
 * needs hashing or the cookie jar lives in `auth.ts` instead.
 */

export const SESSION_COOKIE = 'ello_session';
export const SESSION_DAYS = 7;

export type Session = {
  uid: string;
  email: string;
  name: string;
  role: Role;
  /** null for superadmins - they belong to the platform, not a tenant. */
  tenantId: string | null;
  /** Set when a superadmin is impersonating a tenant for support. */
  impersonating?: { tenantId: string; tenantName: string };
};

function secret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('AUTH_SECRET must be set and at least 32 characters.');
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

/**
 * The tenant a request is acting inside. A superadmin who is impersonating
 * acts within that tenant; otherwise they have no tenant of their own.
 */
export function effectiveTenantId(session: Session): string | null {
  return session.impersonating?.tenantId ?? session.tenantId;
}
