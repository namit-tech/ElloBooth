'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Types } from 'mongoose';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { Tenant, User, AuditLog } from '@/models';
import { requireSuperadmin, requireUser } from '@/lib/rbac';
import { getSession, setSessionCookie, hashPassword } from '@/lib/auth';

/** Superadmin-only mutations. Every one of them writes an audit entry. */

type TenantRef = Types.ObjectId | string | null | undefined;

async function audit(action: string, tenantId: TenantRef, meta?: Record<string, unknown>) {
  const session = await getSession();
  await AuditLog.create({
    actorId: session?.uid,
    actorEmail: session?.email ?? 'unknown',
    action,
    tenantId,
    meta,
  });
}

export type ActionState = { error?: string; ok?: string };

/* ------------------------------------------------------------------ */
const NewTenant = z.object({
  name: z.string().trim().min(2, 'Company name is too short'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, 'Slug can use lowercase letters, numbers and hyphens only'),
  adminName: z.string().trim().min(2, 'Admin name is too short'),
  adminEmail: z.string().trim().toLowerCase().pipe(z.email('Enter a valid admin email')),
  adminPassword: z.string().min(8, 'Password must be at least 8 characters'),
  keyMode: z.enum(['byok', 'platform']),
  credits: z.coerce.number().int().min(0).max(1_000_000),
});

export async function createTenant(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSuperadmin();

  const parsed = NewTenant.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form' };
  const input = parsed.data;

  await connectDB();

  if (await Tenant.findOne({ slug: input.slug })) {
    return { error: `The slug "${input.slug}" is already taken` };
  }

  const tenant = await Tenant.create({
    name: input.name,
    slug: input.slug,
    status: 'active',
    keyMode: input.keyMode,
    credits: input.keyMode === 'platform' ? input.credits : 0,
  });

  await User.create({
    tenantId: tenant._id,
    email: input.adminEmail,
    name: input.adminName,
    passwordHash: await hashPassword(input.adminPassword),
    role: 'tenant_admin',
  });

  await audit('tenant.create', tenant._id, { slug: input.slug, keyMode: input.keyMode });
  revalidatePath('/superadmin');
  return { ok: `${input.name} created. Admin can sign in as ${input.adminEmail}.` };
}

/* ------------------------------------------------------------------ */
export async function setTenantStatus(formData: FormData): Promise<void> {
  await requireSuperadmin();
  const tenantId = String(formData.get('tenantId'));
  const status = z.enum(['active', 'suspended', 'trial']).parse(formData.get('status'));

  await connectDB();
  await Tenant.updateOne({ _id: tenantId }, { status });
  await audit('tenant.status', tenantId, { status });

  revalidatePath('/superadmin');
  revalidatePath(`/superadmin/tenants/${tenantId}`);
}

/* ------------------------------------------------------------------ */
export async function addCredits(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSuperadmin();

  const tenantId = String(formData.get('tenantId'));
  const parsed = z.coerce.number().int().safeParse(formData.get('amount'));
  if (!parsed.success || parsed.data === 0) return { error: 'Enter a non-zero whole number' };
  const amount = parsed.data;

  await connectDB();
  // $gte guard stops a negative adjustment from pushing the balance below zero.
  const updated = await Tenant.findOneAndUpdate(
    amount < 0 ? { _id: tenantId, credits: { $gte: -amount } } : { _id: tenantId },
    { $inc: { credits: amount } },
    { new: true, projection: { credits: 1, name: 1 } },
  );
  if (!updated) return { error: 'Not enough credits to deduct that amount' };

  await audit('tenant.credits', tenantId, { amount, balance: updated.credits });
  revalidatePath(`/superadmin/tenants/${tenantId}`);
  revalidatePath('/superadmin');

  return {
    ok: `${amount > 0 ? 'Added' : 'Deducted'} ${Math.abs(amount)} credits. Balance: ${updated.credits}.`,
  };
}

/* ------------------------------------------------------------------ */
/**
 * Support impersonation. The session keeps the superadmin's own identity and
 * only adds the tenant being viewed, so audit entries stay attributable.
 */
export async function impersonate(formData: FormData): Promise<void> {
  const session = await requireSuperadmin();
  const tenantId = String(formData.get('tenantId'));

  await connectDB();
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) throw new Error('Tenant not found');

  await setSessionCookie({
    ...session,
    impersonating: { tenantId: String(tenant._id), tenantName: tenant.name },
  });
  await audit('tenant.impersonate.start', tenant._id, { tenantName: tenant.name });

  redirect('/dashboard');
}

export async function stopImpersonating(): Promise<void> {
  const session = await requireUser();
  if (session.impersonating) {
    await connectDB();
    await audit('tenant.impersonate.stop', session.impersonating.tenantId, {
      tenantName: session.impersonating.tenantName,
    });
  }

  const { impersonating: _dropped, ...rest } = session;
  await setSessionCookie(rest);
  redirect('/superadmin');
}
