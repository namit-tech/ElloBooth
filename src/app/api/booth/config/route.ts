import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Scene, type IScene } from '@/models';
import { requireDevice, HttpError } from '@/lib/rbac';
import { exists } from '@/lib/storage';

/** Everything a paired booth needs to render its idle screen and scene picker. */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { tenant, tenantId } = await requireDevice(req);
    await connectDB();

    // Global library plus this tenant's own scenes - never another tenant's.
    const scenes = await Scene.find({
      active: true,
      $or: [{ tenantId: null }, { tenantId }],
    })
      .sort({ order: 1, createdAt: 1 })
      .lean<IScene[]>();

    const withStatus = await Promise.all(
      scenes.map(async (s) => ({
        id: String(s._id),
        name: s.name,
        subtitle: s.subtitle ?? '',
        aspectRatio: s.aspectRatio,
        own: s.tenantId != null,
        // Lets the booth grey out scenes whose reference image was never uploaded.
        ready: await exists(s.referenceKey),
      })),
    );

    return NextResponse.json({
      tenant: { name: tenant.name },
      branding: {
        accent: tenant.branding.accent,
        idleTitle: tenant.branding.idleTitle || 'आइए, कैमरे के सामने खड़े हों',
        idleSubtitle: tenant.branding.idleSubtitle || 'Step in front of the camera',
      },
      settings: {
        autoCaptureSeconds: tenant.settings.autoCaptureSeconds,
        countdownSeconds: tenant.settings.countdownSeconds,
        resultDisplaySeconds: tenant.settings.resultDisplaySeconds,
        consentText: tenant.settings.consentText,
        realFace: tenant.settings.realFace,
      },
      // Shown so staff can top up before the queue stalls; booths on their own
      // key have no platform balance to report.
      credits: tenant.keyMode === 'platform' ? tenant.credits : null,
      scenes: withStatus,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: err.status });
    }
    console.error('[booth/config]', err);
    return NextResponse.json({ error: 'Could not load booth settings' }, { status: 500 });
  }
}
