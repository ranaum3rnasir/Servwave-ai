import { prisma } from '../prisma';
import { SYSTEM_ROLE_NAMES, isReservedRoleKey, slugifyRoleKey } from './effectiveRole';

/**
 * The names a custom role may and may not take. Creating a role, renaming one and Save as role all ask this one
 * question, so they refuse the same names in the same words.
 */

/** How a built-in role is named on screen. */
export const BUILT_IN_ROLE_LABELS: Record<(typeof SYSTEM_ROLE_NAMES)[number], string> = {
  ADMIN: 'Administrator (Owner)',
  SALES: 'Sales',
  DISPATCHER: 'Dispatcher',
  TECHNICIAN: 'Technician',
};

/** The keys a built-in role goes by on screen: its code ("TECHNICIAN") and its label ("Administrator (Owner)"). */
const BUILT_IN_NAME_KEYS = new Set(
  Object.entries(BUILT_IN_ROLE_LABELS).flatMap(([code, label]) => [slugifyRoleKey(code), slugifyRoleKey(label)]),
);

/**
 * The words a built-in role is also known by on screen, beyond its label and code: the Administrator (Owner) role is
 * called "Administrator", "Owner" and "Admin" in conversation, so a custom role with one of those names would read as
 * the same thing in a picker.
 */
const BUILT_IN_ROLE_ALIASES = ['Administrator', 'Owner', 'Admin'];
const BUILT_IN_ALIAS_KEYS = new Set(BUILT_IN_ROLE_ALIASES.map((a) => slugifyRoleKey(a)));

/** The sentence for a name another live role already has. */
export const nameTakenMessage = (label: string) => `A role named "${label}" already exists. Choose another name.`;

/**
 * Why a name cannot be given to a custom role, or null when it can: it may not be a built-in role's name, and it may
 * not be another live role's name. The words the Administrator (Owner) role is known by are refused too, except to a
 * role that already carries one. A name is compared as the key it would make, so case and spacing are ignored
 * ("Ops  Lead" and "ops-lead" are one name). A role being renamed may keep its own name, so its id is left out of the
 * comparison. A role is compared by its key and by its label, because a renamed role keeps the key it was made with.
 */
export async function roleNameRefusal(args: {
  organizationId: string;
  label: string;
  renaming?: string;
}): Promise<{ status: 400 | 409; error: string } | null> {
  let key: string;
  try {
    key = slugifyRoleKey(args.label);
  } catch {
    return { status: 400, error: 'Label must contain at least one letter or number' };
  }
  const builtInRefusal = { status: 400 as const, error: `"${args.label}" is the name of a built-in role. Choose another name.` };
  if (isReservedRoleKey(key) || BUILT_IN_NAME_KEYS.has(key)) return builtInRefusal;
  const live = await prisma.customRole.findMany({
    where: { organization_id: args.organizationId, archived_at: null },
    select: { id: true, key: true, label: true },
  });
  if (BUILT_IN_ALIAS_KEYS.has(key)) {
    // A role made before this word was refused keeps its name, and may be saved again under it.
    const own = live.find((r) => r.id === args.renaming);
    if (!own || slugifyRoleKey(own.label) !== key) return builtInRefusal;
  }
  const taken = live.some((r) => r.id !== args.renaming && (r.key === key || slugifyRoleKey(r.label) === key));
  return taken ? { status: 409, error: nameTakenMessage(args.label) } : null;
}
