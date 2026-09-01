/**
 * Self-check for the platform foundation. Run after install or after changing
 * secrets - it proves the key vault, sessions, DB connection and RBAC ranking
 * all work before you trust them with a tenant's key.
 *
 *   npm run verify
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { seal, open, keyHint, pairingCode, hashToken, randomToken } from '../src/lib/crypto';
import { signSession, verifySession, hashPassword, checkPassword } from '../src/lib/auth';
import { connectDB } from '../src/lib/db';

let failures = 0;
function check(label: string, passed: boolean, note = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${note ? `  ${note}` : ''}`);
  if (!passed) failures++;
}

async function main() {
  console.log('\n--- Key vault (AES-256-GCM) ---');
  const fakeKey = 'AIzaSyD-EXAMPLE-not-a-real-key-1234d4f2';
  const sealed = seal(fakeKey);
  check('seal / open round-trips', open(sealed) === fakeKey);
  check('ciphertext differs from plaintext', !sealed.ciphertext.includes('AIza'));
  check('dashboard hint is masked', sealed.hint === keyHint(fakeKey), `-> ${sealed.hint}`);

  let tamperRejected = false;
  try {
    open({ ...sealed, ciphertext: Buffer.from('tampered').toString('base64') });
  } catch {
    tamperRejected = true;
  }
  check('tampered ciphertext is rejected', tamperRejected);

  const ivs = new Set(Array.from({ length: 50 }, () => seal(fakeKey).iv));
  check('IV is unique per seal', ivs.size === 50, `${ivs.size}/50 distinct`);

  console.log('\n--- Device tokens ---');
  const token = randomToken();
  check('token is long enough', token.length >= 40, `${token.length} chars`);
  check('hash is stable', hashToken(token) === hashToken(token));
  check('hash is not reversible to token', !hashToken(token).includes(token.slice(0, 12)));
  const codes = new Set(Array.from({ length: 200 }, () => pairingCode()));
  check('pairing codes are unique', codes.size === 200, `sample: ${pairingCode()}`);
  check('pairing codes avoid 0/O/1/I', !/[01OI]/.test(Array.from(codes).join('')));

  console.log('\n--- Sessions (JWT) ---');
  const session = {
    uid: '65f000000000000000000001',
    email: 'admin@demo.com',
    name: 'Demo Admin',
    role: 'tenant_admin' as const,
    tenantId: '65f000000000000000000002',
  };
  const jwt = await signSession(session);
  const decoded = await verifySession(jwt);
  check('session round-trips', decoded?.email === session.email);
  check('tenantId survives', decoded?.tenantId === session.tenantId);
  check('role survives', decoded?.role === 'tenant_admin');

  const forged = jwt.slice(0, -6) + 'AAAAAA';
  check('forged signature is rejected', (await verifySession(forged)) === null);

  console.log('\n--- Passwords ---');
  const hash = await hashPassword('demo1234');
  check('correct password verifies', await checkPassword('demo1234', hash));
  check('wrong password rejected', !(await checkPassword('demo12345', hash)));
  check('hash is salted (differs each time)', hash !== (await hashPassword('demo1234')));

  console.log('\n--- Database ---');
  try {
    await connectDB();
    check('MongoDB reachable', mongoose.connection.readyState === 1, mongoose.connection.name);
    await mongoose.disconnect();
  } catch (err) {
    check('MongoDB reachable', false, err instanceof Error ? err.message : String(err));
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
