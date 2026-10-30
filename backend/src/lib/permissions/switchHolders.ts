import { prisma } from '../prisma';
import { resolveSwitchesForPeople } from './switches/store';

/**
 * The last fallback of an alert's chain (PRD 4's M6, and the never-silent net for calls and texts, PRD 8): the company's active
 * Admins. It was the holders of Manage roles and permissions until that switch retired (AL-18): managing people and roles is
 * the Admin flag's alone, so the people who manage the company's access are its Admins. `ADMINS` is the key a chain asks
 * `activeSwitchHolders` (or a reader that wraps it) for them; it is not a switch.
 */
export const ADMINS = '@admins';

/** The company's active Admins (the `is_admin` flag), read fresh on every call. */
export async function activeAdmins(organizationId: string): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { organization_id: organizationId, is_active: true, is_admin: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return admins.map((a) => a.id);
}

/**
 * The switch-holder lookup (Roles & Permissions, PRD 4, M6): given a switch, the company's active people who hold it.
 *
 * The answer is read from each person's switches (their own stored value, else the role they are based on, else that
 * role's preset; the Admin box holds every switch), never from a role name, so a custom role in is a holder and a
 * person switched off or deactivated is not. Read fresh on every call, nothing cached. A switch that is not a toggle
 * has no "holder": only a value of exactly `true` counts.
 */
export async function activeSwitchHolders(organizationId: string, switchKey: string): Promise<string[]> {
  if (switchKey === ADMINS) return activeAdmins(organizationId);
  const people = await prisma.user.findMany({
    where: { organization_id: organizationId, is_active: true },
    select: { id: true, organization_id: true, role: true, custom_role_id: true, is_admin: true, custom_role: { select: { key: true } } },
  });
  // Everyone at once (a constant number of reads), never one person at a time: a company has hundreds of people.
  const values = await resolveSwitchesForPeople(people, [switchKey]);
  return people.filter((p) => values.get(p.id)?.[switchKey] === true).map((p) => p.id);
}
