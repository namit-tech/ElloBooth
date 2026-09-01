import { connectDB } from '@/lib/db';
import { Generation, Scene, type IGeneration, type IScene } from '@/models';
import { requireTenant } from '@/lib/rbac';
import Compare from './Compare';

export const dynamic = 'force-dynamic';

export default async function GalleryPage() {
  const { tenant, filter } = await requireTenant('operator');
  await connectDB();

  const photos = await Generation.find({ ...filter, status: 'ok', shareToken: { $exists: true } })
    .sort({ createdAt: -1 })
    .limit(60)
    .lean<IGeneration[]>();

  const scenes = await Scene.find({ $or: [{ tenantId: null }, filter] }, { name: 1 }).lean<IScene[]>();
  const sceneNames = new Map(scenes.map((s) => [String(s._id), s.name]));

  const withBoth = photos.filter((p) => p.imageKeyRaw).length;
  const refineFailed = photos.filter((p) => p.identityLock && p.refineError).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gallery</h1>
          <p>
            Last {photos.length} photo{photos.length === 1 ? '' : 's'}.{' '}
            {tenant.settings.retentionDays === 0
              ? 'Auto-delete is off.'
              : `Deleted automatically after ${tenant.settings.retentionDays} days.`}
          </p>
        </div>
      </div>

      {withBoth > 0 ? (
        <div className="notice info" style={{ marginBottom: 18 }}>
          {withBoth} photo{withBoth === 1 ? ' has' : 's have'} both versions saved. Hover or tap the toggle on a
          photo to see it with and without identity lock — that is the comparison worth judging the extra credit
          on.
          {refineFailed > 0 ? (
            <>
              {' '}
              <strong>{refineFailed}</strong> photo{refineFailed === 1 ? '' : 's'} fell back to the first pass
              because the correction failed; no extra credit was charged for those.
            </>
          ) : null}
        </div>
      ) : null}

      {photos.length === 0 ? (
        <div className="card">
          <div className="empty">No photos yet. Run one from a paired booth.</div>
        </div>
      ) : (
        <div className="gallery">
          {photos.map((p) => (
            <Compare
              key={String(p._id)}
              token={p.shareToken!}
              hasRaw={!!p.imageKeyRaw}
              sceneName={sceneNames.get(String(p.sceneId)) ?? 'Unknown scene'}
              takenAt={new Date(p.createdAt).toLocaleString('en-IN')}
              seconds={(p.ms / 1000).toFixed(1)}
              failed={!!p.refineError}
            />
          ))}
        </div>
      )}
    </>
  );
}
