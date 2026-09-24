import { connectDB } from '@/lib/db';
import { Scene, type IScene } from '@/models';
import { requireTenant } from '@/lib/rbac';
import { providerOf } from '@/lib/ai';
import { exists } from '@/lib/storage';
import { RANK } from '@/models/roles';
import { toggleScene, deleteScene } from './actions';
import NewScene from './NewScene';
import EditScene from './EditScene';

export const dynamic = 'force-dynamic';

export default async function ScenesPage() {
  const { session, tenantId, tenant, filter } = await requireTenant('operator');
  await connectDB();

  const [mine, global] = await Promise.all([
    Scene.find(filter).sort({ order: 1, createdAt: 1 }).lean<IScene[]>(),
    Scene.find({ tenantId: null }).sort({ order: 1 }).lean<IScene[]>(),
  ]);

  const ready = new Map<string, boolean>();
  for (const s of [...mine, ...global]) ready.set(String(s._id), await exists(s.referenceKey));

  const isAdmin = RANK[session.role] >= RANK.tenant_admin;
  const hasKey = tenant.keyMode === 'byok' ? !!tenant.apiKeys?.[providerOf(tenant)]?.ciphertext : true;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scenes</h1>
          <p>Upload who your visitors should appear with. The wording is drafted for you from the image.</p>
        </div>
      </div>

      {isAdmin && !hasKey ? (
        <div className="notice err" style={{ marginBottom: 18 }}>
          Add an AI key in Settings first — drafting a scene reads the image with it.
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>Your scenes</h2>
          <p>Only your booths can use these.</p>
        </div>

        {mine.length === 0 ? (
          <div className="empty">Nothing yet. Add one below.</div>
        ) : (
          <div className="scene-list">
            {mine.map((s) => {
              const id = String(s._id);
              return (
                <div className={`scene-row${s.active ? '' : ' off'}`} key={id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/scenes/${id}/reference`} alt="" />
                  <div className="scene-body">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{s.name}</strong>
                      <span className="badge neutral">{s.aspectRatio}</span>
                      {/* Readable without opening the editor, so a saved mode
                          is visibly saved rather than something to go and
                          check. A composite scene with no backplate cannot
                          produce anything, so it says so here. */}
                      {s.mode === 'composite' ? (
                        <span className={`badge ${s.backplateKey ? 'gold' : 'suspended'}`}>
                          {s.backplateKey ? 'composite' : 'composite — no backplate'}
                        </span>
                      ) : null}
                      {!ready.get(id) ? <span className="badge suspended">no image</span> : null}
                      {!s.active ? <span className="badge neutral">hidden</span> : null}
                    </div>
                    {s.subtitle ? <p className="scene-sub">{s.subtitle}</p> : null}
                    <p className="scene-prompt">{s.scene}</p>
                  </div>

                  {isAdmin ? (
                    <div className="scene-actions">
                      <EditScene
                        scene={{
                          id,
                          name: s.name,
                          subtitle: s.subtitle ?? '',
                          aspectRatio: s.aspectRatio,
                          scene: s.scene,
                          pose: s.pose,
                          mood: s.mood ?? '',
                          referenceKey: s.referenceKey,
                          mode: s.mode ?? 'generate',
                          hasBackplate: !!s.backplateKey,
                          anchorX: s.placement?.anchorX ?? 0.72,
                          anchorBottom: s.placement?.anchorBottom ?? 1,
                          personHeight: s.placement?.height ?? 0.88,
                        }}
                      />
                      <form action={toggleScene}>
                        <input type="hidden" name="sceneId" value={id} />
                        <button className="btn ghost sm">{s.active ? 'Hide' : 'Show'}</button>
                      </form>
                      <form action={deleteScene}>
                        <input type="hidden" name="sceneId" value={id} />
                        <button className="btn danger sm">Delete</button>
                      </form>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isAdmin ? <NewScene tenantId={String(tenantId)} /> : null}

      <div className="card">
        <div className="card-head">
          <h2>Elloindia library</h2>
          <p>Shared with every account. Your booths can use these, but only Elloindia can change them.</p>
        </div>
        <div className="scene-list">
          {global.map((s) => {
            const id = String(s._id);
            return (
              <div className="scene-row" key={id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/scenes/${id}/reference`} alt="" />
                <div className="scene-body">
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{s.name}</strong>
                    <span className="badge neutral">{s.aspectRatio}</span>
                    {!ready.get(id) ? <span className="badge suspended">no image</span> : null}
                  </div>
                  {s.subtitle ? <p className="scene-sub">{s.subtitle}</p> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
