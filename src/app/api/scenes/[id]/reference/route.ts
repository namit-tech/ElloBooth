import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import { connectDB } from '@/lib/db';
import { Scene, type IScene } from '@/models';
import { requireTenant, HttpError } from '@/lib/rbac';
import { get } from '@/lib/storage';
import { mimeFor } from '@/lib/gemini';

/**
 * Serves a scene's reference image to the dashboard.
 *
 * Addressed by scene id rather than by storage key, so the tenant scope on the
 * lookup is what grants access - there is no way to name a path and have it
 * fetched. A tenant sees the shared global library and their own scenes only.
 */

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { tenantId } = await requireTenant('operator');
    const { id } = await ctx.params;
    if (!Types.ObjectId.isValid(id)) return new NextResponse('Not found', { status: 404 });

    await connectDB();
    const scene = await Scene.findOne({
      _id: id,
      $or: [{ tenantId: null }, { tenantId }],
    }).lean<IScene>();
    if (!scene) return new NextResponse('Not found', { status: 404 });

    // ?plate=1 serves the composite backplate instead. Same scene, same tenant
    // scope, so it needs no separate route or permission of its own.
    const wantsPlate = new URL(req.url).searchParams.get('plate') === '1';
    const key = wantsPlate ? scene.backplateKey : scene.referenceKey;
    if (!key) return new NextResponse('No backplate uploaded', { status: 404 });

    const bytes = await get(key);
    if (!bytes) {
      return new NextResponse(wantsPlate ? 'No backplate uploaded' : 'No reference image uploaded', {
        status: 404,
      });
    }

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mimeFor(key),
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return new NextResponse(err.message, { status: err.status });
    console.error('[scene reference]', err);
    return new NextResponse('Something went wrong', { status: 500 });
  }
}
