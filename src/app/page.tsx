import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { homeFor } from '@/models/roles';

export default async function Home() {
  const session = await getSession();
  redirect(session ? homeFor(session.role) : '/login');
}
