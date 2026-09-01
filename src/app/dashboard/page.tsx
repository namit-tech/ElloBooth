import Link from 'next/link';
import { connectDB } from '@/lib/db';
import { Generation, Device, Scene } from '@/models';
import { requireTenant } from '@/lib/rbac';
import { providerOf, PROVIDER_INFO } from '@/lib/ai';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const { tenant, filter } = await requireTenant('operator');
  await connectDB();

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [total, last30, failures, devices, sceneCount, recent] = await Promise.all([
    Generation.countDocuments({ ...filter, status: 'ok' }),
    Generation.countDocuments({ ...filter, status: 'ok', createdAt: { $gte: since } }),
    Generation.countDocuments({ ...filter, status: { $ne: 'ok' }, createdAt: { $gte: since } }),
    Device.find({ ...filter, revoked: false }).sort({ lastSeenAt: -1 }).lean(),
    Scene.countDocuments({ $or: [{ tenantId: null }, filter], active: true }),
    Generation.find(filter).sort({ createdAt: -1 }).limit(8).lean(),
  ]);

  const online = devices.filter(
    (d) => d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000,
  ).length;

  const lowCredits = tenant.keyMode === 'platform' && tenant.credits < 25;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tenant.name}</h1>
          <p>Last 30 days across all your booths.</p>
        </div>
      </div>

      {lowCredits ? (
        <div className="notice err" style={{ marginBottom: 18 }}>
          Only <strong>{tenant.credits} credits</strong> left. Booths stop generating at zero — top up before your
          next event.
        </div>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Photos (30 days)</div>
          <div className="value">{last30.toLocaleString('en-IN')}</div>
          <div className="sub">{total.toLocaleString('en-IN')} all time</div>
        </div>
        <div className="stat">
          <div className="label">{tenant.keyMode === 'platform' ? 'Credits left' : 'Key mode'}</div>
          <div className="value">
            {tenant.keyMode === 'platform'
              ? tenant.credits.toLocaleString('en-IN')
              : PROVIDER_INFO[providerOf(tenant)].label.split(' ')[0]}
          </div>
          <div className="sub">
            {tenant.keyMode === 'platform'
              ? `${tenant.creditsUsed.toLocaleString('en-IN')} used`
              : (tenant.apiKeys?.[providerOf(tenant)]?.hint ?? 'no key set')}
          </div>
        </div>
        <div className="stat">
          <div className="label">Booths</div>
          <div className="value">{devices.length}</div>
          <div className="sub">{online} online now</div>
        </div>
        <div className="stat">
          <div className="label">Failures (30 days)</div>
          <div className="value">{failures}</div>
          <div className="sub">{scenes(sceneCount)} available</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Recent activity</h2>
          <p>
            Photos are kept for{' '}
            {tenant.settings.retentionDays === 0 ? 'as long as you want' : `${tenant.settings.retentionDays} days`},
            then deleted automatically.
          </p>
        </div>

        {recent.length === 0 ? (
          <div className="empty">
            Nothing yet. <Link href="/dashboard/devices" style={{ color: 'var(--gold)' }}>Pair a booth</Link> to get
            started.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Took</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((g) => (
                  <tr key={String(g._id)}>
                    <td style={{ color: 'var(--muted)' }}>{new Date(g.createdAt).toLocaleString('en-IN')}</td>
                    <td>
                      <span className={`badge ${g.status === 'ok' ? 'active' : 'suspended'}`}>{g.status}</span>
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{g.model.replace('gemini-', '')}</td>
                    <td style={{ color: 'var(--muted)' }}>{(g.ms / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const scenes = (n: number) => `${n} scene${n === 1 ? '' : 's'}`;
