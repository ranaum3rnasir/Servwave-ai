/**
 * Spider's ONE recipient rule (#2619). Every channel - the in-app alert, the email and the text -
 * uses the list this returns, so the popup, the email and the text always agree.
 *
 *   1. The configured roles, users and the lead's owner.
 *   2. The company's Admins, if none are configured OR if the configured ones reach nobody for this
 *      lead after steps 3 and 4 (owner-only on an unowned lead, a chosen role with no active
 *      users, chosen people who cannot open the lead).
 *   3. Only users who can sign in (active, with a login).
 *   4. Only users who can see the lead (the same row check the bell applies), so no channel tells
 *      someone about a lead they could not open.
 *   5. Each person once.
 *
 * A lead never goes unwatched just because the chosen people miss it: the Admins are the backstop
 * (#2619). Only when nobody at all - not even an Admin - can sign in and open the lead does this
 * return an empty list; the sweep then claims nothing, so the lead can still alert once someone it
 * would reach exists.
 *
 * Asked once per company run for all the leads it alerts or summarizes (#2989), never once per lead:
 * one read of the people the rule can name (the chosen roles and users, every lead's owner and the
 * Admins), one batched check of which of them can open which lead (the bell's row check, asked of
 * every lead at once), and then each lead's list is picked from those in memory. The lead's owner
 * stays per lead. The number of reads does not grow with the number of leads. Everything read is
 * this company's alone: the people read is filtered to the company, and so is every lead probe.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import { isSuperUser } from '../../lib/permissions/effectiveRole';
import { scopeWhereForUser } from '../../lib/permissions/enforce';
import { resolveSwitchesForPeople } from '../../lib/permissions/switches/store';
import { readersWithAccessToEach } from '../../lib/tasks/entityAccessCohort';
import type { SpiderRecipients } from './config';
import { inChunks } from './pages';

export interface SpiderRecipient {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  role: string;
  /**
   * How the person was chosen, as the contractor's alert log names it: the lead's `owner`, a chosen
   * `user`, or `admin` - by a chosen role, or as the Admins Spider falls back to.
   */
  chosen_as: SpiderRecipientType;
}

export type SpiderRecipientType = 'owner' | 'user' | 'admin';

/** A lead the rule is asked about: its id and its owner now. */
export interface SpiderRecipientLead {
  id: string;
  ownerId: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

const RECIPIENT_SELECT = { id: true, first_name: true, last_name: true, email: true, phone: true, role: true } as const;
/** What the row check needs about a person (the bell's access filter reads the same fields). */
const ACCESS_SELECT = {
  organization_id: true, department_id: true, location_id: true, custom_role_id: true, is_admin: true,
  custom_role: { select: { key: true } },
} as const;
const CAN_SIGN_IN = { is_active: true, has_login: true } as const;

/**
 * Spider's recipients for each of these leads of one company, by the rule above. Every lead asked
 * about has an entry (an empty list when nobody can be reached).
 */
export async function resolveSpiderRecipientsForLeads(
  db: Db,
  args: { orgId: string; leads: readonly SpiderRecipientLead[]; recipients: SpiderRecipients },
): Promise<Map<string, SpiderRecipient[]>> {
  const { orgId, leads, recipients } = args;
  const byLead = new Map<string, SpiderRecipient[]>();
  if (leads.length === 0) return byLead;

  const ownerIds = recipients.lead_owner ? [...new Set(leads.flatMap((l) => (l.ownerId ? [l.ownerId] : [])))] : [];
  // Everyone the rule can name for any of these leads, in one read: the Admins (the backstop) and the
  // configured roles, users and owners. Who is configured for WHICH lead is decided below.
  const anyOf: Prisma.UserWhereInput[] = [{ is_admin: true }];
  if (recipients.roles.length > 0) anyOf.push({ role: { in: recipients.roles } });
  if (recipients.user_ids.length > 0) anyOf.push({ id: { in: recipients.user_ids } });
  if (ownerIds.length > 0) anyOf.push({ id: { in: ownerIds } });
  const people = await db.user.findMany({
    where: { organization_id: orgId, ...CAN_SIGN_IN, OR: anyOf },
    select: { ...RECIPIENT_SELECT, ...ACCESS_SELECT },
    orderBy: { id: 'asc' },
  });
  if (people.length === 0) {
    for (const lead of leads) byLead.set(lead.id, []);
    return byLead;
  }

  const canOpen = await whoCanOpenEachLead(people, orgId, leads.map((l) => l.id));
  const asRecipient = (u: (typeof people)[number], chosen_as: SpiderRecipientType): SpiderRecipient => ({
    id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, phone: u.phone, role: u.role, chosen_as,
  });

  for (const lead of leads) {
    const isOwner = (id: string) => recipients.lead_owner && lead.ownerId !== null && lead.ownerId === id;
    const configured = people.filter(
      (u) => recipients.roles.includes(u.role) || recipients.user_ids.includes(u.id) || isOwner(u.id),
    );
    const chosenAs = (id: string): SpiderRecipientType =>
      isOwner(id) ? 'owner' : recipients.user_ids.includes(id) ? 'user' : 'admin';
    const reached = configured.filter((u) => canOpen(u.id, lead.id)).map((u) => asRecipient(u, chosenAs(u.id)));
    // Nobody configured, or the configured people reach nobody for this lead: the Admins.
    byLead.set(
      lead.id,
      reached.length > 0
        ? reached
        : people.filter((u) => u.is_admin && canOpen(u.id, lead.id)).map((u) => asRecipient(u, 'admin')),
    );
  }
  return byLead;
}

type AccessPerson = Parameters<typeof scopeWhereForUser>[0];

/**
 * Which of these people can open which of these leads: the bell's row check
 * (notifications/filterByAccess.ts, filterRecipientsByAccess for a LEAD), asked of every lead at once.
 * A person whose lead scope restricts nothing opens every lead; everyone else is answered by
 * readersWithAccessToEach, the same cohorts and probes the bell uses, over all the leads in one go.
 * Fails closed: a person whose check throws, or everyone needing a row probe when the probe throws,
 * opens nothing (and is logged by id).
 */
async function whoCanOpenEachLead(
  people: AccessPerson[],
  orgId: string,
  leadIds: string[],
): Promise<(userId: string, leadId: string) => boolean> {
  // Everyone's switches in a constant number of reads, so deriving each person's scope below reads nothing more.
  // A failure here is not an answer: each person is then judged on their own below and fails closed on their own.
  await resolveSwitchesForPeople(people.filter((u) => !isSuperUser(u))).catch(() => undefined);

  const open = new Set<string>();
  const needsRow: AccessPerson[] = [];
  for (const person of people) {
    try {
      const scope = await scopeWhereForUser(person, 'Lead');
      if (Object.keys(scope).length === 0) open.add(person.id);
      else needsRow.push(person);
    } catch (err) {
      logger.warn('[spider] lead access check threw - leaving the person out', { orgId, userId: person.id, error: errorName(err) });
    }
  }

  let readersOf = new Map<string, Set<string>>();
  if (needsRow.length > 0) {
    try {
      // In chunks of SWEEP_PAGE_SIZE leads (#2992, pages.ts): no probe asks about every lead of a run at once. Each
      // lead's answer is its own (readersWithAccessToEach), so the chunks' answers together are the one answer.
      for (const chunk of inChunks(leadIds)) {
        const { readersOf: part } = await readersWithAccessToEach(needsRow, 'LEAD', chunk);
        for (const [leadId, readers] of part) readersOf.set(leadId, readers);
      }
    } catch (err) {
      // Fails closed for every lead of the run, as one probe failing did before the chunks.
      readersOf = new Map();
      logger.warn('[spider] lead access probe threw - leaving out everyone it was for', { orgId, people: needsRow.length, error: errorName(err) });
    }
  }
  return (userId, leadId) => open.has(userId) || (readersOf.get(leadId)?.has(userId) ?? false);
}

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}
