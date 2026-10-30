import type { Request } from 'express';
import type { Action } from './catalog';
import { prisma } from '../prisma';
import { canActOnRow } from './enforce';
import { creatorCanOpen, creatorRuleOpens, type CreatorSubject } from './creatorRule';

/**
 * M3 - the access resolver's per-record answer for an invoice or an estimate (Roles & Permissions, PRD 4): which of the
 * page's action buttons this person may use on THIS record. The invoice page and the estimate page draw a button only for
 * an action on the list, so none shows that the record's routes would refuse. They replace the invoice page's role-name
 * check; the answer asks the same switches the routes ask, never a role.
 *
 * An action is listed when either of two things holds, the same two the route guard (`canDoOrCreator`) accepts:
 *   - the person holds the switch behind it and the record is within its scope (a holder of Edit invoices edits other
 *     people's invoices in scope), or
 *   - the creator rule opens it (send, edit and delete on a record the person made and can still see, whatever their
 *     View and Edit switches say). The rule never opens a money action, so record payment and copy payment link stand
 *     on Record payments and Send payment links alone.
 *
 * Whether the record is in a state the action fits (a draft to send, a sent invoice to resend) is the page's own
 * reading of the record's status; this answer is only about who may.
 *
 *   edit               Edit invoices / Edit estimates   details, lines, billing, notes, tags (and an estimate's status)
 *   send               Edit invoices / Edit estimates   send, resend and mark sent
 *   delete             Delete invoices / Delete estimates
 *   cancel             Edit estimates                   estimates only
 *   copy_payment_link  Send payment links               invoices only
 *   record_payment     Record payments                  the invoice's payment, or an estimate's deposit
 */

export type InvoiceAction = 'edit' | 'send' | 'delete' | 'copy_payment_link' | 'record_payment';
export type EstimateAction = 'edit' | 'send' | 'delete' | 'cancel' | 'record_payment';

/** The action's verb on the record, in the order the answer lists them. */
const INVOICE_VERBS: ReadonlyArray<readonly [InvoiceAction, Action]> = [
  ['edit', 'update'],
  ['send', 'send'],
  ['delete', 'delete'],
  ['copy_payment_link', 'send_payment_link'],
  ['record_payment', 'record_payment'],
];

const ESTIMATE_VERBS: ReadonlyArray<readonly [EstimateAction, Action]> = [
  ['edit', 'update'],
  ['send', 'send'],
  ['delete', 'delete'],
  ['cancel', 'cancel'],
  ['record_payment', 'record_payment'],
];

async function actionsFor<A extends string>(
  req: Request,
  subject: CreatorSubject,
  id: string,
  verbs: ReadonlyArray<readonly [A, Action]>,
  only?: readonly A[],
): Promise<A[]> {
  verbs = only ? verbs.filter(([action]) => only.includes(action)) : verbs;
  const delegate = subject === 'Invoice' ? prisma.invoice : prisma.estimate;
  // Asked at most once, and only when a verb the person does not hold could still be the creator's.
  let creatorOwns: Promise<boolean> | undefined;
  const madeByPerson = () => (creatorOwns ??= creatorCanOpen(req.user!, subject, id));

  const answers = await Promise.all(verbs.map(async ([, verb]) => {
    if (req.ability!.can(verb, subject) && (await canActOnRow(req, subject, delegate, id, verb))) return true;
    return creatorRuleOpens(subject, verb) && (await madeByPerson());
  }));
  return verbs.filter((_, i) => answers[i]).map(([action]) => action);
}

/**
 * The actions this person may take on the invoice, in the order of INVOICE_VERBS. `only` asks about just those actions,
 * so a caller that needs one answer (the job page's Payment Received step) pays for that one and not for all five.
 */
export function invoiceActionsFor(req: Request, invoiceId: string, only?: readonly InvoiceAction[]): Promise<InvoiceAction[]> {
  return actionsFor(req, 'Invoice', invoiceId, INVOICE_VERBS, only);
}

/** The actions this person may take on the estimate, in the order of ESTIMATE_VERBS. */
export function estimateActionsFor(req: Request, estimateId: string): Promise<EstimateAction[]> {
  return actionsFor(req, 'Estimate', estimateId, ESTIMATE_VERBS);
}
