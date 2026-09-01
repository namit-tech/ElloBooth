import { connectDB } from '@/lib/db';
import { Device, type IDevice } from '@/models';
import { requireTenant } from '@/lib/rbac';
import { RANK } from '@/models/roles';
import { revokeDevice, regenerateCode } from './actions';
import NewDeviceForm from './NewDeviceForm';

export const dynamic = 'force-dynamic';

function status(d: IDevice): { label: string; cls: string } {
  if (d.revoked) return { label: 'revoked', cls: 'suspended' };
  if (!d.tokenHash) {
    const live = d.pairingExpiresAt && new Date(d.pairingExpiresAt) > new Date();
    return live ? { label: 'waiting to pair', cls: 'trial' } : { label: 'code expired', cls: 'neutral' };
  }
  const online = d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000;
  return online ? { label: 'online', cls: 'active' } : { label: 'paired', cls: 'neutral' };
}

export default async function DevicesPage() {
  const { session, filter } = await requireTenant('operator');
  await connectDB();

  const devices = await Device.find(filter).sort({ createdAt: -1 }).lean<IDevice[]>();
  const isAdmin = RANK[session.role] >= RANK.tenant_admin;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Booths</h1>
          <p>Each booth pairs once with a code, then runs without anyone signing in.</p>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {devices.length === 0 ? (
          <div className="empty">No booths yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Booth</th>
                  <th>Status</th>
                  <th>Pairing code</th>
                  <th>Last seen</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const s = status(d);
                  const codeLive = !d.tokenHash && d.pairingExpiresAt && new Date(d.pairingExpiresAt) > new Date();
                  return (
                    <tr key={String(d._id)}>
                      <td style={{ fontWeight: 600 }}>{d.name}</td>
                      <td>
                        <span className={`badge ${s.cls}`}>{s.label}</span>
                      </td>
                      <td>
                        {codeLive ? (
                          <span className="mono" style={{ fontSize: 17, letterSpacing: 2, color: 'var(--gold)' }}>
                            {d.pairingCode}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--faint)' }}>—</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('en-IN') : 'never'}
                      </td>
                      {isAdmin ? (
                        <td style={{ textAlign: 'right' }}>
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            {!d.revoked ? (
                              <>
                                <form action={regenerateCode}>
                                  <input type="hidden" name="deviceId" value={String(d._id)} />
                                  <button type="submit" className="btn ghost sm">
                                    New code
                                  </button>
                                </form>
                                <form action={revokeDevice}>
                                  <input type="hidden" name="deviceId" value={String(d._id)} />
                                  <button type="submit" className="btn danger sm">
                                    Revoke
                                  </button>
                                </form>
                              </>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isAdmin ? <NewDeviceForm /> : null}
    </>
  );
}
