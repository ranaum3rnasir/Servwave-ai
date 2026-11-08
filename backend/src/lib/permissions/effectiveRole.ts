// SRVW-138 phase one - the custom-role bridge.
//
// A custom role is stored as a row in `custom_roles` and referenced by
// `users.custom_role_id`. `users.role` is UNCHANGED and now means the BASE role: the
// role whose code-level behaviour the custom role inherits. That split is what keeps
// the ~24 controller sites that compare `req.user.role === 'DISPATCHER'` correct
// without auditing them one by one.
//
// Two rules, and they are the whole bridge:
//   grant / cache lookup key  =  custom_role.key ?? role     <- grantRoleKey, below
//   every existing role branch =  role (the base)            <- unchanged, read directly
//
// Anything that loads or caches role_permissions rows MUST use grantRoleKey. Anything
// asking "what kind of user is this" keeps reading `.role`.

// The four Role enum values. Custom keys share the role_permissions.role column with
// these, so they are reserved: a collision would silently merge a custom role's grants
// into a system role's.
export const SYSTEM_ROLE_NAMES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

const RESERVED = new Set<string>(SYSTEM_ROLE_NAMES.map((r) => r.toLowerCase()));

/** The subset of a user this module needs. Widened from AppUser / req.user. */
export interface RoleBearer {
  role: string;
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
}

/**
 * The value to look up in `role_permissions.role` (and to key the grant cache on).
 *
 * Fails LOUD, not soft, when `custom_role_id` is set but the relation was not
 * selected: falling back to the base role would hand the user the BASE role's grant
 * set, a silent over-grant whenever the custom role is narrower. The throw surfaces
 * as attachAbility's 500, which denies access and is easy to spot - unlike a user
 * quietly holding more permission than their role says.
 */
export function grantRoleKey(user: RoleBearer): string {
  if (user.custom_role_id) {
    if (!user.custom_role?.key) {
      throw new Error(
        `grantRoleKey: user has custom_role_id ${user.custom_role_id} but the custom_role relation was not loaded`,
      );
    }
    return user.custom_role.key;
  }
  return user.role;
}

/**
 * True for an unrestricted ADMIN - the `manage all` superuser short-circuit.
 *
 * An ADMIN-derived custom role ("full access minus payroll") must NOT short-circuit,
 * or the grants it subtracts would be ignored and the role would silently be a full
 * admin. Such a role carries base_role ADMIN plus a seeded explicit grant set, so it
 * resolves through the normal grant path instead.
 *
 * This replaces bare `user.role === 'ADMIN'` at the five fail-safe superuser sites:
 * defineAbility, scopeWhereFor, enforce (scopeWhereForReq), attachAbility, and
 * auth.controller's loadAbilityRules.
 */
export function isSuperUser(user: RoleBearer): boolean {
  return user.role === 'ADMIN' && !user.custom_role_id;
}

/** A custom role may not take a system role's name (case-insensitive - keys are slugs). */
export function isReservedRoleKey(key: string): boolean {
  return RESERVED.has(key.trim().toLowerCase());
}

/**
 * Derive a custom role's stable `key` from its label.
 *
 * The key is generated once at creation and never changes: it is the value written
 * into every one of the role's role_permissions rows, so renaming it would orphan
 * them all. Renames therefore touch `label` only.
 */
export function slugifyRoleKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('slugifyRoleKey: label must contain at least one alphanumeric character');
  return slug;
}
