import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { homeFor } from '@/models/roles';
import LoginForm from './LoginForm';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session) redirect(homeFor(session.role));

  const { next } = await searchParams;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Elloindia Photo Booth</h1>
        <p className="sub">Sign in to your account</p>
        <LoginForm next={next} />
      </div>
    </div>
  );
}
