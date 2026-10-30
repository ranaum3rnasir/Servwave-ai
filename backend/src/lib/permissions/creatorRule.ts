import { prisma } from '../prisma';
import type { Action } from './catalog';
import { createdAndAttachedReach, creatorReach } from './recordPeople';
import type { ScopedSubject } from './switches/catalog';
import { substituteConditions } from './substituteConditions';

/**
 * The creator rule's server half (Roles & Permissions, PRD 1, M3). What it reaches is `creatorReach`
 * in the resolver; this file asks it of a record and says which actions it opens.
 */

/** The two kinds of record the creator rule covers. */
export type CreatorSubject = 'Estimate' | 'Invoice';

/**
 * What the creator of an estimate or invoice may do with it whatever their switches say: open it, edit it
 * (details, lines, notes, tags), send and resend it, and delete it while it is a draft (the delete itself
 * refuses a document that is no longer a draft). Estimates also carry the lifecycle verbs Edit estimates
 * names. Void, refund, credit, void payment, Apply discounts, Record payments, Send payment links, adding or
 * removing an invoice's lines and every other switch are not here: they stay on their own switches.
 */
const CREATOR_ACTIONS: Record<CreatorSubject, ReadonlySet<Action>> = {
  Estimate: new Set<Action>(['read', 'update', 'send', 'delete', 'cancel', 'revise']),
  Invoice: new Set<Action>(['read', 'update', 'send', 'delete']),
};

export function creatorRuleOpens(subject: CreatorSubject, action: Action): boolean {
  return CREATOR_ACTIONS[subject].has(action);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Person = { id: string; organization_id: string };

/** Is this record one the person made and can see: attached while on a job or lead, for good if for a customer alone? */
export async function creatorCanOpen(person: Person, subject: CreatorSubject, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const reach = substituteConditions(creatorReach(subject), { userId: person.id })!;
  const where = { id, organization_id: person.organization_id, ...reach };
  const found = subject === 'Estimate'
    ? await prisma.estimate.findFirst({ where, select: { id: true } })
    : await prisma.invoice.findFirst({ where, select: { id: true } });
  return !!found;
}

/**
 * "Is creator and still attached": the person made this record and is on it now. PRD 4 reads it for a
 * lead the creator may still edit with Edit leads off. Read from the people on the record as they stand, so
 * a person taken off it answers false on the very next call.
 */
export async function isCreatorStillAttached(person: Person, subject: ScopedSubject, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const reach = substituteConditions(createdAndAttachedReach(subject), { userId: person.id })!;
  const where = { id, organization_id: person.organization_id, ...reach };
  switch (subject) {
    case 'Lead': return !!(await prisma.lead.findFirst({ where, select: { id: true } }));
    case 'Job': return !!(await prisma.job.findFirst({ where, select: { id: true } }));
    case 'Estimate': return !!(await prisma.estimate.findFirst({ where, select: { id: true } }));
    case 'Invoice': return !!(await prisma.invoice.findFirst({ where, select: { id: true } }));
  }
}
