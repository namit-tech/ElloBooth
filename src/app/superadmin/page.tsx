import Link from 'next/link';
import { connectDB } from '@/lib/db';
import { Tenant, User, Generation, type ITenant } from '@/models';
import { requireSuperadmin } from '@/lib/rbac';
import NewTenantForm from './NewTenantForm';

export const dynamic = 'force-dynamic';

export default async function TenantsPage() {
  await requireSuperadmin();
  await connectDB();

  const tenants = await Tenant.find().sort({ createdAt: -1 }).lean<ITenant[]>();
  const ids = tenants.map((t) => t._id);

  // One grouped query each rather than a lookup per tenant.
  const [userCounts, photoCounts] = await Promise.all([
    User.aggregate<{ _id: unknown; n: number }>([
      { $match: { tenantId: { $in: ids } } },
      { $group: { _id: '$tenantId', n: { $sum: 1 } } },
    ]),
    Generation.aggregate<{ _id: unknown; n: number }>([
      { $match: { tenantId: { $in: ids }, status: 'ok' } },
      { $group: { _id: '$tenantId', n: { $sum: 1 } } },
    ]),
  ]);

  const users = new Map(userCounts.map((r) => [String(r._id), r.n]));
  const photos = new Map(photoCounts.map((r) => [String(r._id), r.n]));

  const totalPhotos = tenants.reduce((sum, t) => sum + (photos.get(String(t._id)) ?? 0), 0);
  const active = tenants.filter((t) => t.status === 'active').length;
  const onPlatformKey = tenants.filter((t) => t.keyMode === 'platform').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tenants</h1>
          <p>Client accounts on the platform.</p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <div className="stat">
          <div className="label">Tenants</div>
          <div className="value">{tenants.length}</div>
          <div className="sub">{active} active</div>
        </div>
        <div className="stat">
          <div className="label">Photos generated</div>
          <div className="value">{totalPhotos.toLocaleString('en-IN')}</div>
          <div className="sub">all time</div>
        </div>
        <div className="stat">
          <div className="label">On platform key</div>
          <div className="value">{onPlatformKey}</div>
          <div className="sub">{tenants.length - onPlatformKey} on their own key</div>
        </div>
        <div className="stat">
          <div className="label">Credits outstanding</div>
          <div className="value">
            {tenants.reduce((sum, t) => sum + (t.keyMode === 'platform' ? t.credits : 0), 0).toLocaleString('en-IN')}
          </div>
          <div className="sub">unspent, platform-key only</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {tenants.length === 0 ? (
          <div className="empty">No tenants yet. Create the first one below.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Status</th>
                  <th>Key mode</th>
                  <th>Credits</th>
                  <th>Users</th>
                  <th>Photos</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => {
                  const id = String(t._id);
                  return (
                    <tr key={id}>
                      <td>
                        <Link href={`/superadmin/tenants/${id}`} style={{ fontWeight: 600 }}>
                          {t.name}
                        </Link>
                        <div className="mono" style={{ color: 'var(--faint)', fontSize: 12 }}>
                          /{t.slug}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${t.status}`}>{t.status}</span>
                      </td>
                      <td>
                        <span className={`badge ${t.keyMode === 'byok' ? 'neutral' : 'gold'}`}>
                          {t.keyMode === 'byok' ? 'Own key' : 'Platform'}
                        </span>
                      </td>
                      <td>{t.keyMode === 'platform' ? t.credits.toLocaleString('en-IN') : '—'}</td>
                      <td>{users.get(id) ?? 0}</td>
                      <td>{(photos.get(id) ?? 0).toLocaleString('en-IN')}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Link href={`/superadmin/tenants/${id}`} className="btn ghost sm">
                          Manage
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewTenantForm />
    </>
  );
}
