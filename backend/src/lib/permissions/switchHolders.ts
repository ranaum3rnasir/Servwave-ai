import { prisma } from '../prisma';
import { resolveSwitchesForPeople } from './switches/store';

/** The switch the last fallback of an alert's chain asks (PRD 4's M6, and the never-silent net for calls and texts, PRD 8). */
export const MANAGE_ROLES_SWITCH = 'manage_roles_and_permissions';

/**
 * The switch-holder lookup (Roles & Permissions, PRD 4, M6): given a switch, the company's active people who hold it.
 *
 * The answer is read from each person's switches (their own stored value, else the role they are based on, else that
 * role's preset; the Admin box holds every switch), never from a role name, so a custom role in is a holder and a
 * person switched off or deactivated is not. Read fresh on every call, nothing cached. A switch that is not a toggle
 * has no "holder": only a value of exactly `true` counts.
 */
export async function activeSwitchHolders(organizationId: string, switchKey: string): Promise<string[]> {
  const people = await prisma.user.findMany({
    where: { organization_id: organizationId, is_active: true },
    select: { id: true, organization_id: true, role: true, custom_role_id: true, custom_role: { select: { key: true } } },
  });
  // Everyone at once (a constant number of reads), never one person at a time: a company has hundreds of people.
  const values = await resolveSwitchesForPeople(people, [switchKey]);
  return people.filter((p) => values.get(p.id)?.[switchKey] === true).map((p) => p.id);
}
