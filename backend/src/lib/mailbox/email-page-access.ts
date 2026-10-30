/**
 * Whether the Email page is closed to a person (PRD 10, "A warning stays for anyone whose own switches close the
 * Email page"): their own switches turn Access Communication or Show Email off. Their mailbox is still issued and
 * still receives, but they cannot read it, so the Users page marks the address "Can't read: Email page is off for
 * this person". Only a custom role or a per-user change can do it: every built-in preset has both on.
 *
 * The rule is on resolved switch values, so a person's Permissions page, a role's editor and the users list all
 * ask the same question of the same values.
 */
import { resolveSwitchesForPeople, type SwitchSubject } from '../permissions/switches/store';
import type { ResolvedSwitches } from '../permissions/switches/cache';

/** The two switches whose absence closes the Email page. */
export const EMAIL_PAGE_SWITCHES = ['access_communication', 'show_email'] as const;

export function emailPageClosed(values: ResolvedSwitches): boolean {
  return EMAIL_PAGE_SWITCHES.some((key) => values[key] !== true);
}

/**
 * Which of these people have the Email page closed, in a constant number of reads however many people there are
 * (the shared many-people switch read, narrowed to the two switches). Read fresh, never from the per-person cache.
 */
export async function emailPageClosedFor(people: SwitchSubject[]): Promise<Set<string>> {
  const closed = new Set<string>();
  if (people.length === 0) return closed;
  const values = await resolveSwitchesForPeople(people, EMAIL_PAGE_SWITCHES);
  for (const person of people) {
    const own = values.get(person.id);
    if (own && emailPageClosed(own)) closed.add(person.id);
  }
  return closed;
}
