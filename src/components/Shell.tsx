import NavLink from './NavLink';
import { logout } from '@/app/login/actions';
import { stopImpersonating } from '@/app/superadmin/actions';
import { ROLE_LABEL, type Role } from '@/models/roles';
import type { Session } from '@/lib/session';

export type NavItem = { href: string; label: string; exact?: boolean };

export default function Shell({
  session,
  kicker,
  nav,
  children,
}: {
  session: Session;
  kicker: string;
  nav: NavItem[];
  children: React.ReactNode;
}) {
  return (
    <>
      {session.impersonating ? (
        <div className="impersonation-bar">
          <span>
            Viewing <strong>{session.impersonating.tenantName}</strong> as support. Actions are logged.
          </span>
          <form action={stopImpersonating}>
            <button type="submit">Exit</button>
          </form>
        </div>
      ) : null}

      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <strong>Elloindia</strong>
            <span>{kicker}</span>
          </div>

          {nav.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}

          <div className="sidebar-foot">
            <div style={{ color: 'var(--ink)', fontWeight: 500 }}>{session.name}</div>
            <div style={{ fontSize: 12.5 }}>{session.email}</div>
            <div style={{ marginTop: 6 }}>
              <span className="badge neutral">{ROLE_LABEL[session.role as Role]}</span>
            </div>
            <form action={logout} style={{ marginTop: 12 }}>
              <button type="submit" className="btn ghost sm">
                Sign out
              </button>
            </form>
          </div>
        </aside>

        <main className="main">{children}</main>
      </div>
    </>
  );
}
