import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { homeFor } from '@/models/roles';

/**
 * First line of defence: keeps signed-out visitors off dashboard routes and
 * stops a tenant user from loading superadmin pages at all.
 *
 * This runs on the edge and cannot reach MongoDB, so it is a gate, not the
 * authority. Every page and action still calls the `require*` guards, which
 * re-check against live tenant status.
 */

/**
 * `/photo` and `/api/photo` are both public on purpose: a visitor scans the QR
 * on their own phone and is not signed in. Access is gated by the unguessable
 * share token instead. Missing `/api/photo` here would redirect the image
 * request to the login page and break every QR code.
 */
/**
 * `/mp` holds MediaPipe's WASM and face-landmark model. The booth is not a
 * signed-in session, so leaving it out sends those asset requests to /login and
 * the face blend silently never runs.
 */
const PUBLIC = ['/login', '/booth', '/photo', '/api/photo', '/api/booth', '/mp'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith('/superadmin') && session.role !== 'superadmin') {
    return NextResponse.redirect(new URL(homeFor(session.role), req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$).*)'],
};
