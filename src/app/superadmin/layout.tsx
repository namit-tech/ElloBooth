import { redirect } from 'next/navigation';
import Shell, { type NavItem } from '@/components/Shell';
import { getSession } from '@/lib/auth';

const NAV: NavItem[] = [
  { href: '/superadmin', label: 'Tenants', exact: true },
  { href: '/superadmin/audit', label: 'Audit log' },
];

export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.role !== 'superadmin') redirect('/dashboard');

  return (
    <Shell session={session} kicker="Platform" nav={NAV}>
      {children}
    </Shell>
  );
}
