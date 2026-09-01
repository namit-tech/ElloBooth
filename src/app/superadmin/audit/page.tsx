import { connectDB } from '@/lib/db';
import { AuditLog, Tenant, type IAuditLog, type ITenant } from '@/models';
import { requireSuperadmin } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  await requireSuperadmin();
  await connectDB();

  const entries = await AuditLog.find().sort({ createdAt: -1 }).limit(200).lean<IAuditLog[]>();
  const tenants = await Tenant.find({}, { name: 1 }).lean<ITenant[]>();
  const names = new Map(tenants.map((t) => [String(t._id), t.name]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>Last 200 privileged actions, newest first.</p>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {entries.length === 0 ? (
          <div className="empty">Nothing logged yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Tenant</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={String(e._id)}>
                    <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {new Date(e.createdAt).toLocaleString('en-IN')}
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{e.action}</td>
                    <td style={{ color: 'var(--muted)' }}>{e.actorEmail}</td>
                    <td>{e.tenantId ? (names.get(String(e.tenantId)) ?? '—') : '—'}</td>
                    <td className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>
                      {e.meta ? JSON.stringify(e.meta) : ''}
                    </td>
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
