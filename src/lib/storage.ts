import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * File storage behind a tiny interface.
 *
 * Local disk for development. Swapping in S3 / Cloudflare R2 for production
 * means replacing the three functions below - nothing else in the app touches
 * the filesystem, and every key is already tenant-prefixed.
 */

const ROOT = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');

/** Keys are always `<tenantId>/<kind>/<file>` so tenants can never collide. */
export function makeKey(tenantId: string, kind: 'photos' | 'refs' | 'branding', filename: string): string {
  return `${tenantId}/${kind}/${filename}`;
}

function resolve(key: string): string {
  const full = path.resolve(ROOT, key);
  // Refuse anything that escapes the storage root via ".." in a key.
  if (!full.startsWith(path.resolve(ROOT) + path.sep)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return full;
}

export async function put(key: string, data: Buffer): Promise<void> {
  const full = resolve(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function get(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(resolve(key));
  } catch {
    return null;
  }
}

export async function remove(key: string): Promise<void> {
  await fs.rm(resolve(key), { force: true });
}

export async function exists(key: string): Promise<boolean> {
  try {
    await fs.access(resolve(key));
    return true;
  } catch {
    return false;
  }
}
