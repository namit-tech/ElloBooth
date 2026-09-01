import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  signSession,
  verifySession,
  effectiveTenantId,
  type Session,
} from '@/lib/session';

/** Node-runtime half of auth: cookie jar plus password hashing. */

export { SESSION_COOKIE, signSession, verifySession, effectiveTenantId };
export type { Session };

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? verifySession(token) : null;
}

export async function setSessionCookie(session: Session): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await signSession(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const checkPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);
