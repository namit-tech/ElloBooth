import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Generation, type IGeneration } from '@/models';
import { get } from '@/lib/storage';
import { mimeFor } from '@/lib/gemini';

/**
 * Serves a finished photo by its share token.
 *
 * Public by design - the visitor scans the QR on their own phone and is not
 * signed in. The token is 18 random bytes, so photos cannot be enumerated, and
 * the row disappears at the tenant's retention deadline.
 */

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[\w-]{20,64}$/.test(token)) return new NextResponse('Not found', { status: 404 });

  await connectDB();
  const generation = await Generation.findOne({ shareToken: token, status: 'ok' }).lean<IGeneration>();
  if (!generation?.imageKey) return new NextResponse('Not found', { status: 404 });

  // A TTL index removes the row, but a sweep may not have run yet.
  if (generation.expiresAt && new Date(generation.expiresAt) < new Date()) {
    return new NextResponse('This photo has expired', { status: 410 });
  }

  // ?raw=1 serves pass 1's output, used by the dashboard gallery to compare
  // identity lock on and off. It is the same visitor's photo either way, so it
  // needs no extra protection beyond the share token itself.
  const wantsRaw = new URL(req.url).searchParams.get('raw') === '1';
  const key = wantsRaw && generation.imageKeyRaw ? generation.imageKeyRaw : generation.imageKey;

  const bytes = await get(key);
  if (!bytes) return new NextResponse('Not found', { status: 404 });

  // Derived from the stored key so older files keep working if the output
  // format ever changes again.
  const contentType = mimeFor(key);
  const ext = key.slice(key.lastIndexOf('.'));

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="photo-${token.slice(0, 8)}${ext}"`,
      // Immutable content, but keep it out of shared caches - it is personal data.
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
