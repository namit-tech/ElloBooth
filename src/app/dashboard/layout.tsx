import { redirect } from 'next/navigation';
import Shell, { type NavItem } from '@/components/Shell';
import { getSession, effectiveTenantId } from '@/lib/auth';
import { RANK } from '@/models/roles';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  // A superadmin who is not impersonating has no tenant to show.
  if (!effectiveTenantId(session)) redirect('/superadmin');

  const isAdmin = RANK[session.role] >= RANK.tenant_admin;

  const nav: NavItem[] = [
    { href: '/dashboard', label: 'Overview', exact: true },
    { href: '/dashboard/scenes', label: 'Scenes' },
    { href: '/dashboard/gallery', label: 'Gallery' },
    { href: '/dashboard/devices', label: 'Booths' },
    ...(isAdmin ? [{ href: '/dashboard/settings', label: 'Settings' }] : []),
  ];

  return (
    <Shell session={session} kicker="Booth" nav={nav}>
      {children}
    </Shell>
  );
}
