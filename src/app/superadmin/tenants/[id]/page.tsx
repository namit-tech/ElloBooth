import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Types } from 'mongoose';
import { connectDB } from '@/lib/db';
import { Tenant, User, Generation, Device, ROLE_LABEL, type ITenant, type IUser } from '@/models';
import { requireSuperadmin } from '@/lib/rbac';
import { setTenantStatus, impersonate } from '../../actions';
import CreditsForm from './CreditsForm';

export const dynamic = 'force-dynamic';

export default async function TenantDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperadmin();
  const { id } = await params;
  if (!Types.ObjectId.isValid(id)) notFound();

  await connectDB();
  const tenant = await Tenant.findById(id).lean<ITenant>();
  if (!tenant) notFound();

  const scope = { tenantId: new Types.ObjectId(id) };
  const [users, deviceCount, okCount, failCount, spend] = await Promise.all([
    User.find(scope).sort({ createdAt: 1 }).lean<IUser[]>(),
    Device.countDocuments({ ...scope, revoked: false }),
    Generation.countDocuments({ ...scope, status: 'ok' }),
    Generation.countDocuments({ ...scope, status: { $ne: 'ok' } }),
    Generation.aggregate<{ total: number }>([
      { $match: { ...scope, status: 'ok' } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
  ]);

  const costUsd = spend[0]?.total ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/superadmin" style={{ color: 'var(--muted)', fontSize: 13.5 }}>
            ← All tenants
          </Link>
          <h1 style={{ marginTop: 6 }}>{tenant.name}</h1>
          <p>
            <span className="mono">/{tenant.slug}</span> · created{' '}
            {new Date(tenant.createdAt).toLocaleDateString('en-IN')}
          </p>
        </div>
        <form action={impersonate}>
          <input type="hidden" name="tenantId" value={id} />
          <button type="submit" className="btn ghost">
            View as this tenant
          </button>
        </form>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Photos</div>
          <div className="value">{okCount.toLocaleString('en-IN')}</div>
          <div className="sub">{failCount} failed or refused</div>
        </div>
        <div className="stat">
          <div className="label">Credits left</div>
          <div className="value">{tenant.keyMode === 'platform' ? tenant.credits.toLocaleString('en-IN') : '—'}</div>
          <div className="sub">{tenant.creditsUsed.toLocaleString('en-IN')} used</div>
        </div>
        <div className="stat">
          <div className="label">Booths paired</div>
          <div className="value">{deviceCount}</div>
          <div className="sub">{users.length} users</div>
        </div>
        <div className="stat">
          <div className="label">API spend</div>
          <div className="value">${costUsd.toFixed(2)}</div>
          <div className="sub">{tenant.keyMode === 'byok' ? "on tenant's own key" : 'on platform key'}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Account status</h2>
            <p>Suspending blocks sign-in, the dashboard and every paired booth immediately.</p>
          </div>
          <div className="row">
            <span className={`badge ${tenant.status}`}>{tenant.status}</span>
            {(['active', 'trial', 'suspended'] as const)
              .filter((s) => s !== tenant.status)
              .map((s) => (
                <form key={s} action={setTenantStatus}>
                  <input type="hidden" name="tenantId" value={id} />
                  <input type="hidden" name="status" value={s} />
                  <button type="submit" className={`btn sm ${s === 'suspended' ? 'danger' : 'ghost'}`}>
                    {s === 'suspended' ? 'Suspend' : `Set ${s}`}
                  </button>
                </form>
              ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Credits</h2>
            <p>
              {tenant.keyMode === 'platform'
                ? 'One credit is one generated photo on the platform key.'
                : 'This tenant uses their own API key, so credits do not apply.'}
            </p>
          </div>
          {tenant.keyMode === 'platform' ? (
            <CreditsForm tenantId={id} balance={tenant.credits} />
          ) : (
            <div className="notice info">
              Key mode is <strong>Own key</strong>. They are billed by Google directly. The tenant can switch to
              platform credits from their own settings page.
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Users</h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={String(u._id)}>
                  <td>{u.name}</td>
                  <td className="mono">{u.email}</td>
                  <td>
                    <span className="badge neutral">{ROLE_LABEL[u.role]}</span>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-IN') : 'never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
