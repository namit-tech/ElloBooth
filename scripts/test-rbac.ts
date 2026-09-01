/**
 * Runtime check that access control actually holds, against a running server.
 *
 *   npm run build && npm start        (in one terminal)
 *   npm run test:rbac                 (in another)
 *
 * Covers both halves: the login form is driven for real, and the guards behind
 * it are exercised with sessions minted directly from AUTH_SECRET.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/lib/db';
import { Tenant, User, type ITenant, type IUser } from '../src/models';
import { signSession, SESSION_COOKIE } from '../src/lib/session';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

let failures = 0;
function check(label: string, passed: boolean, note = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${note ? `  (${note})` : ''}`);
  if (!passed) failures++;
}

/** Follow no redirects - the redirect itself is what we are asserting on. */
async function visit(path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
  return { status: res.status, location: res.headers.get('location') || '' };
}

/**
 * Drives the real login server action the way the browser does, so the form
 * itself is covered - not just the guards behind it.
 */
async function submitLogin(email: string, password: string): Promise<boolean> {
  const page = await fetch(`${BASE}/login`);
  const html = await page.text();
  const actionId = html.match(/"([0-9a-f]{40,})"/)?.[1];
  if (!actionId) throw new Error('Could not find the login action id in the page');

  const form = new FormData();
  form.set('email', email);
  form.set('password', password);

  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Next-Action': actionId },
    body: form,
  });

  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.includes(`${SESSION_COOKIE}=`) && !setCookie.includes(`${SESSION_COOKIE}=;`);
}

async function main() {
  await connectDB();

  const superadmin = await User.findOne({ role: 'superadmin' }).lean<IUser>();
  const demo = await Tenant.findOne({ slug: 'demo' }).lean<ITenant>();
  const tenantAdmin = await User.findOne({ tenantId: demo?._id, role: 'tenant_admin' }).lean<IUser>();
  const operator = await User.findOne({ tenantId: demo?._id, role: 'operator' }).lean<IUser>();

  if (!superadmin || !demo || !tenantAdmin || !operator) {
    console.error('Seed data missing. Run: npm run seed');
    process.exit(1);
  }

  const asSuper = await signSession({
    uid: String(superadmin._id),
    email: superadmin.email,
    name: superadmin.name,
    role: 'superadmin',
    tenantId: null,
  });
  const asAdmin = await signSession({
    uid: String(tenantAdmin._id),
    email: tenantAdmin.email,
    name: tenantAdmin.name,
    role: 'tenant_admin',
    tenantId: String(demo._id),
  });
  const asOperator = await signSession({
    uid: String(operator._id),
    email: operator.email,
    name: operator.name,
    role: 'operator',
    tenantId: String(demo._id),
  });

  console.log(`\nTesting against ${BASE}\n`);

  console.log('--- Login form (real submissions) ---');
  for (const [label, body, expect] of [
    ['correct credentials sign in', { email: 'admin@demo.com', password: 'demo1234' }, true],
    ['wrong password rejected', { email: 'admin@demo.com', password: 'wrong-one' }, false],
    ['unknown email rejected', { email: 'nobody@nowhere.com', password: 'demo1234' }, false],
    ['operator can sign in', { email: 'operator@demo.com', password: 'demo1234' }, true],
    ['superadmin can sign in', { email: superadmin.email, password: process.env.SUPERADMIN_PASSWORD || '' }, true],
  ] as [string, { email: string; password: string }, boolean][]) {
    const signedIn = await submitLogin(body.email, body.password);
    check(label, signedIn === expect, signedIn ? 'got a session' : 'no session');
  }

  console.log('\n--- Signed out ---');
  for (const path of ['/dashboard', '/superadmin', '/dashboard/settings']) {
    const r = await visit(path);
    check(`${path} redirects to login`, r.status === 307 && r.location.includes('/login'), `${r.status} ${r.location}`);
  }
  const login = await visit('/login');
  check('/login is reachable', login.status === 200, String(login.status));

  console.log('\n--- Tenant admin ---');
  let r = await visit('/dashboard', asAdmin);
  check('can open own dashboard', r.status === 200, String(r.status));
  r = await visit('/dashboard/settings', asAdmin);
  check('can open settings', r.status === 200, String(r.status));
  r = await visit('/superadmin', asAdmin);
  check(
    'BLOCKED from superadmin',
    r.status === 307 && r.location.includes('/dashboard'),
    `${r.status} ${r.location}`,
  );
  r = await visit(`/superadmin/tenants/${demo._id}`, asAdmin);
  check('BLOCKED from tenant admin pages', r.status === 307, `${r.status} ${r.location}`);

  console.log('\n--- Operator ---');
  r = await visit('/dashboard', asOperator);
  check('can open dashboard', r.status === 200, String(r.status));
  r = await visit('/superadmin', asOperator);
  check('BLOCKED from superadmin', r.status === 307, `${r.status} ${r.location}`);

  console.log('\n--- Superadmin ---');
  r = await visit('/superadmin', asSuper);
  check('can open platform console', r.status === 200, String(r.status));
  r = await visit(`/superadmin/tenants/${demo._id}`, asSuper);
  check('can open tenant detail', r.status === 200, String(r.status));
  r = await visit('/dashboard', asSuper);
  check(
    'without impersonating, sent back to console',
    r.status === 307 && r.location.includes('/superadmin'),
    `${r.status} ${r.location}`,
  );

  console.log('\n--- Forged / tampered sessions ---');
  r = await visit('/superadmin', asAdmin.slice(0, -6) + 'AAAAAA');
  check('tampered signature rejected', r.status === 307 && r.location.includes('/login'), String(r.status));
  r = await visit('/dashboard', 'not-a-jwt-at-all');
  check('garbage cookie rejected', r.status === 307 && r.location.includes('/login'), String(r.status));

  // The payload claims superadmin but is signed with the wrong key.
  const { SignJWT } = await import('jose');
  const wrongKey = await new SignJWT({ uid: 'x', email: 'attacker@evil.com', name: 'X', role: 'superadmin', tenantId: null })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode('x'.repeat(32)));
  r = await visit('/superadmin', wrongKey);
  check('self-signed superadmin token rejected', r.status === 307 && r.location.includes('/login'), String(r.status));

  console.log(failures === 0 ? '\nAll RBAC checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
