import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { emailFeatureOn } from './emailFeature';
import {
  NO_EMAIL, communicationScopeForReq, emailSectionForReq, emailThreadReachWhereForReq, heldRecordReachWhereForReq, resolveMailboxSelection,
  type CommunicationScopeValue, type EmailSection, type MailboxSelection,
} from './communicationScope';

/**
 * Who sees what in a mailbox's Needs review list (Roles & Permissions PRD 10, S10.18): ONE rule, written here, that the list, the
 * counts on the Email page's rail and the link action all go through.
 *
 * A held message (`emails.review_reason` set: failed sender authentication, automatic mail, a reply from an address we did not
 * send to, a reply on an address that no longer resolves) is filed under one mailbox (`review_mailbox_id`). A person sees the held
 * messages of the mailboxes they can see:
 *   - under Communication scope Attached, the mailboxes they hold (their own and any handed to them) and the company's main
 *     mailbox when they read it;
 *   - under All, every mailbox of the company.
 * With one limit under Attached: a held reply on a record conversation's reply address (an invoice's, an estimate's, a
 * job's) shows only to people who can reach that conversation (`heldRecordReachWhereForReq`), so a forwarded reply to an invoice
 * never reaches a person with Invoices View off through a mailbox's list.
 *
 * One held kind is wider: a reply from an address we did not send to (`sender_mismatch`) rings the people of the conversation its
 * reply address belongs to (S10.19), and the bell opens that one item for anyone who can reach that conversation, whichever mailbox
 * it is filed under (`needsReviewItemWhereForReq`). The lists and the counts keep the mailbox rule above.
 *
 * While the company's Email plan feature is off the answer is `NO_EMAIL`: the held messages are kept and hidden like all mail.
 */

type Where = Record<string, unknown>;

export interface NeedsReviewVisibility {
  scope: CommunicationScopeValue;
  /** The `where` on emails for every held message the person sees, in every mailbox they can see. */
  where: Where;
  /** The mailbox issued to the person, when they have one. */
  own: string | null;
  /** The main mailbox, when the person reads it (under Attached). */
  main: string | null;
  /** The mailboxes whose lists the person may open under Attached; null under All (every mailbox of the company). */
  readable: string[] | null;
}

/** Every held message the person may see (see the header), read afresh on every request. */
export async function needsReviewVisibilityForReq(req: Request, known?: EmailSection): Promise<NeedsReviewVisibility> {
  if (!emailFeatureOn(req)) return { scope: 'attached', where: NO_EMAIL, own: null, main: null, readable: [] };
  const scope = await communicationScopeForReq(req);
  const held = { review_reason: { not: null }, ...tenantWhere(req) };
  const section = known ?? await emailSectionForReq(req);
  const { own, main } = section.mailboxes;
  if (scope === 'all') return { scope, where: held, own, main, readable: null };

  const readable = main ? [...section.mailboxes.held, main] : section.mailboxes.held;
  if (readable.length === 0) return { scope, where: NO_EMAIL, own, main, readable };
  return {
    scope,
    where: { ...held, AND: [{ review_mailbox_id: { in: readable } }, await heldRecordReachWhereForReq(req, scope, readable, section.mailboxes)] },
    own, main, readable,
  };
}

/**
 * The `where` for ONE held message the person opens or links by id (the Needs review item a bell points at, and the link action).
 *
 * It is the person's usual visibility, plus, for a reply from an address we did not send to, anyone who can reach the conversation
 * its reply address belongs to (the same reach a link's target needs): the people the bell rang are not necessarily the ones who see
 * the mailbox it is filed under. Nothing else widens, and nothing widens while the company's Email plan feature is off.
 */
export async function needsReviewItemWhereForReq(req: Request, id: string): Promise<Where> {
  const usual = { AND: [{ id }, (await needsReviewVisibilityForReq(req)).where] };
  if (!emailFeatureOn(req)) return usual;
  const held = await prisma.email.findFirst({
    where: { id, review_reason: 'sender_mismatch', review_thread_id: { not: null }, ...tenantWhere(req) },
    select: { review_thread_id: true },
  });
  if (!held?.review_thread_id) return usual;
  const reachable = await prisma.emailThread.findFirst({
    where: { AND: [{ id: held.review_thread_id }, tenantWhere(req), await emailThreadReachWhereForReq(req, [held.review_thread_id])] },
    select: { id: true },
  });
  return reachable ? { id, review_reason: { not: null }, ...tenantWhere(req) } : usual;
}

/**
 * The mailbox whose list the page asks for (`?mailbox=`): "mine", one mailbox, or, on All, every one; a mailbox the person cannot
 * open reads "mine". Asked for nothing, it is everything the person sees, as the Email list reads without a mailbox.
 */
export async function needsReviewSelectionForReq(req: Request, visibility: NeedsReviewVisibility, requested: unknown): Promise<MailboxSelection> {
  if (requested === undefined) return { kind: 'all' };
  return resolveMailboxSelection(req, requested, visibility.scope, visibility.readable ?? []);
}

/** The `where` that narrows the visible held messages to one selection. */
export function needsReviewSelectionWhere(selection: MailboxSelection, visibility: Pick<NeedsReviewVisibility, 'own'>): Where {
  switch (selection.kind) {
    case 'all':
      return {};
    case 'mailbox':
      return { review_mailbox_id: selection.id };
    case 'mine':
      // A person with no mailbox of their own has no list of their own.
      return visibility.own ? { review_mailbox_id: visibility.own } : NO_EMAIL;
  }
}

/** The held messages the person sees in the selection: the `where` to read them (and count them) by. */
export async function needsReviewListWhereForReq(req: Request, requested: unknown) {
  const visibility = await needsReviewVisibilityForReq(req);
  const selection = await needsReviewSelectionForReq(req, visibility, requested);
  return { where: { AND: [visibility.where, needsReviewSelectionWhere(selection, visibility)] } as Where, selection, visibility };
}

/**
 * How many held messages the person sees in each mailbox, for the Email page's rail (one grouped count, however many mailboxes
 * and messages there are), and the count for the selection the page shows.
 */
export async function needsReviewCountsForReq(
  req: Request, selection: MailboxSelection, visibility?: NeedsReviewVisibility,
): Promise<{ selected: number; byMailbox: Map<string, number>; total: number }> {
  const seen = visibility ?? await needsReviewVisibilityForReq(req);
  // Nothing is visible (no mailbox to read, or the Email plan feature is off): there is nothing to count, so nothing is asked.
  if (seen.where === NO_EMAIL) return { selected: 0, byMailbox: new Map(), total: 0 };
  const groups = await prisma.email.groupBy({ by: ['review_mailbox_id'], where: seen.where, _count: { _all: true } });
  const byMailbox = new Map(groups.flatMap((g) => (g.review_mailbox_id ? [[g.review_mailbox_id, g._count._all] as const] : [])));
  // A held message whose mailbox is gone is visible only on All, where it counts toward the total and no mailbox.
  const total = groups.reduce((sum, g) => sum + g._count._all, 0);
  const selected = selection.kind === 'all'
    ? total
    : selection.kind === 'mine'
      ? (seen.own ? byMailbox.get(seen.own) ?? 0 : 0)
      : byMailbox.get(selection.id) ?? 0;
  return { selected, byMailbox, total };
}
