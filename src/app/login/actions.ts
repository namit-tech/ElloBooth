'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { User, Tenant, AuditLog, homeFor, type IUser } from '@/models';
import { checkPassword, setSessionCookie, clearSessionCookie } from '@/lib/auth';

const LoginInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  password: z.string().min(1, 'Enter your password'),
  // FormData.get returns null for a field that was never rendered, and null is
  // not the same as undefined to Zod - so this must be nullish, not optional.
  next: z.string().nullish(),
});

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginInput.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check your details' };
  }
  const { email, password, next } = parsed.data;

  await connectDB();

  // Email is unique per tenant, so the same address can exist in several
  // tenants. Try each match rather than assuming a single account.
  const candidates = await User.find({ email, active: true }).lean<IUser[]>();

  let user: IUser | null = null;
  for (const candidate of candidates) {
    if (await checkPassword(password, candidate.passwordHash)) {
      user = candidate;
      break;
    }
  }

  // Deliberately identical message for unknown email and wrong password, so
  // the form cannot be used to discover which accounts exist.
  if (!user) return { error: 'Email or password is incorrect' };

  if (user.tenantId) {
    const tenant = await Tenant.findById(user.tenantId).lean();
    if (!tenant) return { error: 'Email or password is incorrect' };
    if (tenant.status === 'suspended') {
      return { error: 'This account is suspended. Please contact Elloindia support.' };
    }
  }

  await setSessionCookie({
    uid: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId ? String(user.tenantId) : null,
  });

  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
  await AuditLog.create({
    actorId: user._id,
    actorEmail: user.email,
    action: 'auth.login',
    tenantId: user.tenantId ?? null,
  });

  // Only accept an in-app relative path, never an absolute URL from the query.
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(user.role);
  redirect(target);
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect('/login');
}
