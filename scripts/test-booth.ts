/**
 * End-to-end checks for the booth API against a running server.
 *
 *   npm run build && npm start     (one terminal)
 *   npm run test:booth             (another)
 *
 * Nothing here calls the image provider, so it costs nothing: the quota check
 * is reached by exhausting credits, which returns before any provider call.
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { connectDB } from '../src/lib/db';
import { Tenant, Device, Scene, Generation } from '../src/models';
import { pairingCode } from '../src/lib/crypto';
import { put, makeKey } from '../src/lib/storage';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

let failures = 0;
function check(label: string, passed: boolean, note = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${note ? `  (${note})` : ''}`);
  if (!passed) failures++;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Big enough to pass the route's "capture looks empty" guard. */
const FAKE_CAPTURE = 'A'.repeat(4000);

async function newTenantWithBooth(name: string, slug: string, credits: number) {
  const tenant = await Tenant.create({ name, slug, status: 'active', keyMode: 'platform', credits });

  const code = pairingCode();
  await Device.create({
    tenantId: tenant._id,
    name: `${name} booth`,
    pairingCode: code,
    pairingExpiresAt: new Date(Date.now() + 30 * 60_000),
  });

  const scene = await Scene.create({
    tenantId: tenant._id,
    name: `${name} private scene`,
    referenceKey: makeKey(String(tenant._id), 'refs', 'test.png'),
    aspectRatio: '3:4',
    scene: 'test scene',
    pose: 'test pose',
    mood: 'test mood',
  });
  // The route reads the reference before checking credits, so it must exist.
  await put(scene.referenceKey, Buffer.alloc(40_000, 7));

  return { tenant, code, scene };
}

async function main() {
  await connectDB();

  const stamp = Date.now();
  const A = await newTenantWithBooth('Test Alpha', `test-alpha-${stamp}`, 2);
  const B = await newTenantWithBooth('Test Beta', `test-beta-${stamp}`, 5);

  console.log(`\nTesting against ${BASE}\n`);

  /* ---------------- pairing ---------------- */
  console.log('--- Pairing ---');
  let res = await api('/api/booth/pair', { method: 'POST', body: JSON.stringify({ code: 'ZZZZZZ' }) });
  check('unknown code rejected', res.status === 400, String(res.status));

  res = await api('/api/booth/pair', { method: 'POST', body: JSON.stringify({ code: 'abc' }) });
  check('malformed code rejected', res.status === 400, String(res.status));

  res = await api('/api/booth/pair', { method: 'POST', body: JSON.stringify({ code: A.code }) });
  const paired = await res.json();
  check('valid code pairs', res.status === 200 && !!paired.token, String(res.status));
  const tokenA = paired.token as string;

  res = await api('/api/booth/pair', { method: 'POST', body: JSON.stringify({ code: A.code }) });
  check('code cannot be reused', res.status === 400, String(res.status));

  const tokenB = await api('/api/booth/pair', { method: 'POST', body: JSON.stringify({ code: B.code }) })
    .then((r) => r.json())
    .then((d) => d.token as string);

  /* ---------------- config ---------------- */
  console.log('\n--- Config ---');
  res = await api('/api/booth/config');
  check('no token rejected', res.status === 401, String(res.status));

  res = await api('/api/booth/config', { headers: auth('made-up-token') });
  check('bogus token rejected', res.status === 401, String(res.status));

  res = await api('/api/booth/config', { headers: auth(tokenA) });
  const configA = await res.json();
  check('paired booth gets config', res.status === 200, String(res.status));
  check('config names the tenant', configA.tenant?.name === 'Test Alpha', configA.tenant?.name);
  check('credits reported', configA.credits === 2, String(configA.credits));

  const sceneIds: string[] = (configA.scenes ?? []).map((s: { id: string }) => s.id);
  check('own private scene visible', sceneIds.includes(String(A.scene._id)));
  check("another tenant's scene NOT visible", !sceneIds.includes(String(B.scene._id)));
  check('global library included', (configA.scenes ?? []).some((s: { own: boolean }) => !s.own));

  /* ---------------- generate: isolation and guards ---------------- */
  console.log('\n--- Generate guards ---');
  const gen = (token: string, sceneId: string) =>
    api('/api/booth/generate', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ sceneId, imageBase64: FAKE_CAPTURE, mimeType: 'image/jpeg' }),
    });

  res = await gen(tokenA, String(B.scene._id));
  check("cannot use another tenant's scene", res.status === 404, String(res.status));

  res = await gen(tokenA, String(new Types.ObjectId()));
  check('unknown scene rejected', res.status === 404, String(res.status));

  res = await gen(tokenA, 'not-an-object-id');
  check('malformed sceneId rejected', res.status === 400, String(res.status));

  res = await api('/api/booth/generate', {
    method: 'POST',
    headers: auth(tokenA),
    body: JSON.stringify({ sceneId: String(A.scene._id), imageBase64: 'tiny' }),
  });
  check('empty capture rejected', res.status === 400, String(res.status));

  /* ---------------- quota ---------------- */
  console.log('\n--- Credit enforcement ---');
  await Tenant.updateOne({ _id: A.tenant._id }, { credits: 0 });
  res = await gen(tokenA, String(A.scene._id));
  const quota = await res.json();
  check('zero credits blocks generation', res.status === 402, String(res.status));
  check('message is actionable', /credit/i.test(quota.error ?? ''), quota.error);

  const afterBlock = await Tenant.findById(A.tenant._id).lean();
  check('blocked attempt did not go negative', (afterBlock?.credits ?? -1) === 0, String(afterBlock?.credits));

  /* ---------------- suspension ---------------- */
  console.log('\n--- Suspension ---');
  await Tenant.updateOne({ _id: B.tenant._id }, { status: 'suspended' });
  res = await api('/api/booth/config', { headers: auth(tokenB) });
  check('suspended tenant booth is cut off', res.status === 403, String(res.status));
  await Tenant.updateOne({ _id: B.tenant._id }, { status: 'active' });

  /* ---------------- revocation ---------------- */
  console.log('\n--- Revocation ---');
  await Device.updateOne({ tenantId: A.tenant._id }, { revoked: true });
  res = await api('/api/booth/config', { headers: auth(tokenA) });
  check('revoked booth loses access immediately', res.status === 401, String(res.status));

  /* ---------------- photo sharing ---------------- */
  console.log('\n--- Photo links ---');
  // redirect:manual matters here - following a redirect would land on /login
  // and report a misleading 200.
  res = await fetch(`${BASE}/api/photo/${'x'.repeat(24)}`, { redirect: 'manual' });
  check('unknown share token 404s', res.status === 404, String(res.status));

  res = await fetch(`${BASE}/api/photo/not-a-valid-token`, { redirect: 'manual' });
  check('malformed share token 404s', res.status === 404, String(res.status));

  res = await fetch(`${BASE}/photo/${'x'.repeat(24)}`, { redirect: 'manual' });
  check('photo page is public (not redirected to login)', res.status !== 307, String(res.status));

  /* ---------------- cleanup ---------------- */
  await Promise.all([
    Tenant.deleteMany({ _id: { $in: [A.tenant._id, B.tenant._id] } }),
    Device.deleteMany({ tenantId: { $in: [A.tenant._id, B.tenant._id] } }),
    Scene.deleteMany({ tenantId: { $in: [A.tenant._id, B.tenant._id] } }),
    Generation.deleteMany({ tenantId: { $in: [A.tenant._id, B.tenant._id] } }),
  ]);

  console.log(failures === 0 ? '\nAll booth checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
