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
// Anything that loads or caches a role's switch values (permission_role_switches.role_key) MUST use grantRoleKey. Anything
// asking "what kind of user is this" keeps reading `.role`.

// The four Role enum values. Custom keys share the permission_role_switches.role_key column with
// these, so they are reserved: a collision would silently merge a custom role's grants
// into a system role's.
export const SYSTEM_ROLE_NAMES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

const RESERVED = new Set<string>(SYSTEM_ROLE_NAMES.map((r) => r.toLowerCase()));

/**
 * Each built-in role's Admin flag: whether being given that role makes a person an Admin (P15). Only the Administrator role
 * has it set. A custom role never does: a role copied from Administrator holds switches, not the flag. The flag on the role
 * is what the role picker's Administrator entry means ("make this person an Admin"); what is stored, and what every later
 * check reads, is the flag on the person (`isSuperUser`). The Roles list shows it as the role's full access.
 */
export const ROLE_ADMIN_FLAG: Readonly<Record<(typeof SYSTEM_ROLE_NAMES)[number], boolean>> = {
  ADMIN: true, SALES: false, DISPATCHER: false, TECHNICIAN: false,
};

/** Whether holding this role (a built-in role, or a custom role on that base) makes its holder an Admin: the role's flag. */
export function roleMakesAdmin(role: string, customRoleId: string | null | undefined): boolean {
  return !customRoleId && (ROLE_ADMIN_FLAG as Record<string, boolean>)[role] === true;
}

/** The subset of a user this module needs. Widened from AppUser / req.user. */
export interface RoleBearer {
  role: string;
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
}

/**
 * A person as the Admin question needs them: the flag has to be loaded. Required, not optional, so a select that
 * forgets `is_admin` is a type error at the call, never a person quietly treated as a non-admin.
 */
export interface AdminBearer extends RoleBearer {
  is_admin: boolean;
}

/**
 * The value to look up in `permission_role_switches.role_key` (and to key the switch cache on).
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
 * True for an Admin - the `manage all` superuser short-circuit (P15). Admin is a flag on the person, never a role name:
 * a person whose role is named ADMIN but whose flag is off is not an Admin, and a person with the flag on has full
 * access whatever role or custom role they carry. Anything but `true` is not an Admin (fail closed).
 *
 * Every site that asks "is this person an admin" asks here (defineAbility, scopeWhereFor, enforce, attachAbility,
 * auth.controller's loadAbilityRules, the switch store). A test fails on any other way of deciding it.
 */
export function isSuperUser(user: AdminBearer): boolean {
  return user.is_admin === true;
}

/** A custom role may not take a system role's name (case-insensitive - keys are slugs). */
export function isReservedRoleKey(key: string): boolean {
  return RESERVED.has(key.trim().toLowerCase());
}

/**
 * Derive a custom role's stable `key` from its label.
 *
 * The key is generated once at creation and never changes: it is the value written
 * into every one of the role's permission_role_switches rows, so renaming it would orphan
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
