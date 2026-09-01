/**
 * Roles live in their own module so the edge runtime can import the type
 * without pulling in mongoose.
 */

export const ROLES = ['superadmin', 'tenant_admin', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const KEY_MODES = ['byok', 'platform'] as const;
export type KeyMode = (typeof KEY_MODES)[number];

/** Higher rank implies every permission of the ranks below it. */
export const RANK: Record<Role, number> = {
  superadmin: 3,
  tenant_admin: 2,
  operator: 1,
};

export const ROLE_LABEL: Record<Role, string> = {
  superadmin: 'Superadmin',
  tenant_admin: 'Admin',
  operator: 'Operator',
};

/** Where each role lands after signing in. */
export function homeFor(role: Role): string {
  return role === 'superadmin' ? '/superadmin' : '/dashboard';
}
