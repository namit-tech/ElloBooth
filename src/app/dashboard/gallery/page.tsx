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

  /* The face transplant used to fail into a console warning nobody reads, so a
     booth could serve AI faces all evening and look fine. Surfaced here as a
     plain count, with the service's own reason attached. */
  const realFaceOn = tenant.settings.realFace;
  const swapped = photos.filter((p) => p.realFace).length;
  const swapFailed = photos.filter((p) => p.realFaceError).length;
  const commonReason = photos.find((p) => p.realFaceError)?.realFaceError;

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

      {realFaceOn && photos.length > 0 ? (
        <div className={`notice ${swapFailed > swapped ? 'warn' : 'info'}`} style={{ marginBottom: 18 }}>
          <strong>{swapped}</strong> of {photos.length} photo{photos.length === 1 ? '' : 's'} carry the
          visitor&apos;s real face.
          {swapFailed > 0 ? (
            <>
              {' '}
              <strong>{swapFailed}</strong> kept the face the AI drew
              {commonReason ? <> — most recently: &ldquo;{commonReason}&rdquo;</> : null}. Check that the face
              service is running.
            </>
          ) : null}
        </div>
      ) : null}

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
              rawLabel={
                p.realFace
                  ? 'showing the face the AI drew, before the visitor’s own went in'
                  : 'showing pass 1, before face correction'
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
