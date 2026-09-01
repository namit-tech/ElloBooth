import crypto from 'node:crypto';

/**
 * Tenant API-key vault.
 *
 * Keys are sealed with AES-256-GCM under a master key that lives only in the
 * server environment. A sealed key can be opened on the server to make a
 * generation call, but there is deliberately no code path that returns a
 * plaintext key to any client - the dashboard only ever sees `hint`.
 */

const ALGO = 'aes-256-gcm';

function masterKey(): Buffer {
  const raw = process.env.MASTER_KEY;
  if (!raw) {
    throw new Error('MASTER_KEY is not set. Generate one with: openssl rand -hex 32');
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error('MASTER_KEY must be 32 bytes of hex (64 characters).');
  }
  return key;
}

export type SealedKey = {
  ciphertext: string;
  iv: string;
  authTag: string;
  hint: string;
};

/** Masked form that is safe to show in the dashboard, e.g. "AIza…d4f2". */
export function keyHint(plaintext: string): string {
  const s = plaintext.trim();
  if (s.length <= 10) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function seal(plaintext: string): SealedKey {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext.trim(), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    hint: keyHint(plaintext),
  };
}

export function open(sealed: Pick<SealedKey, 'ciphertext' | 'iv' | 'authTag'>): string {
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/** Device tokens are stored hashed, so a database leak cannot pair a booth. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Short, human-readable code an operator types into a booth once. */
export function pairingCode(): string {
  // No 0/O/1/I - they get misread off a screen at an event.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from(crypto.randomBytes(6))
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}
