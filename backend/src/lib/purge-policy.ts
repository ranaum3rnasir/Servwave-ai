/**
 * Payments go-live F1: what a force-purge may and may not delete.
 *
 * A purge hard-deletes a customer and everything under it. Financial records are kept for a
 * retention window and card payments can still be disputed for a while, so a purge is refused
 * whenever the customer's subtree holds one of those.
 *
 * THE NUMBERS BELOW ARE RESEARCH, NOT LEGAL ADVICE. They come from
 * md_files/plans/payments/2026-10-05-payments-go-live/09-force-purge-compliance.md (section 5,
 * step 1). A lawyer sets the final values; change them here and nowhere else. Both are passed
 * into `assessPurge` as parameters so a test (or a lawyer's decision) can use other windows.
 *
 * PURGE_BLOCKED_PAYMENT_IN_FLIGHT (the 409 code of the purge route) exists for two cases: a payment
 * link that was paid but is not recorded yet, and a new invoice that appeared for the customer
 * between the link sweep and the delete (found by comparing the locked invoice ids with the ones the
 * sweep covered). A purge refused at that re-check leaves the links it already expired expired,
 * which is safe: an expired link can take no money, and the customer simply gets a fresh one if the
 * invoice is ever paid.
 */
import type { Prisma } from '@prisma/client';

/** Years financial records (non-draft invoices, payments, refunds, credits) are kept. */
export const PURGE_RETENTION_YEARS = 7;
/** Days after which a card or bank payment can no longer be disputed by the cardholder. */
export const PURGE_DISPUTE_WINDOW_DAYS = 400;

export type PurgeBlocker =
  | 'INVOICES_IN_RETENTION_WINDOW'
  | 'PAYMENTS_IN_RETENTION_WINDOW'
  | 'OPEN_DISPUTES'
  | 'CARD_PAYMENTS_IN_DISPUTE_WINDOW';

export interface PurgeAssessment {
  allowed: boolean;
  blockers: PurgeBlocker[];
  /** Invoices that are neither draft nor voided (all ages). */
  invoice_count: number;
  /** Payments that were not voided and have SUCCEEDED (all ages), and what they add up to (2 decimals). */
  payment_count: number;
  payment_total: number;
  open_disputes: number;
  /** ISO date of the newest invoice, payment, refund or credit; null when there is none. */
  newest_financial_date: string | null;
  has_card_payments: boolean;
  draft_invoice_count: number;
  /** Every invoice in the subtree (ids and numbers), for the audit row and the link sweep. */
  invoices: { id: string; invoice_number: string; status: string }[];
}

export interface PurgeAssessOptions {
  now?: Date;
  retentionYears?: number;
  disputeWindowDays?: number;
  /** Inside a purge transaction: lock the customer and its invoice rows (FOR UPDATE) before reading. */
  lockRows?: boolean;
}

// Dispute mapping (DisputeStatus in schema.prisma has five values, none of them a warning or inquiry state):
// NEEDS_RESPONSE and UNDER_REVIEW are open, so they block a purge at ANY age. WON, LOST and CLOSED do not
// block on their own: a recent closed dispute is still covered by the money and card windows above.
const OPEN_DISPUTE_STATUSES = ['NEEDS_RESPONSE', 'UNDER_REVIEW'] as const;
const ONLINE_METHODS = ['CARD', 'ACH'] as const;

function subtreeInvoiceWhere(customerId: string, orgId: string): Prisma.InvoiceWhereInput {
  return {
    organization_id: orgId,
    OR: [
      { customer_id: customerId },
      { job: { customer_id: customerId } },
      { estimate: { customer_id: customerId } },
      { estimate: { lead: { customer_id: customerId } } },
    ],
  };
}

function yearsBefore(now: Date, years: number): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/** Read-only: works on the app client or a transaction client. */
export async function assessPurge(
  db: Prisma.TransactionClient,
  customerId: string,
  orgId: string,
  options: PurgeAssessOptions = {},
): Promise<PurgeAssessment> {
  const now = options.now ?? new Date();
  const moneyCutoff = yearsBefore(now, options.retentionYears ?? PURGE_RETENTION_YEARS);
  const cardCutoff = new Date(now.getTime() - (options.disputeWindowDays ?? PURGE_DISPUTE_WINDOW_DAYS) * 86_400_000);

  if (options.lockRows) {
    // Customer first (an invoice insert takes a share lock on it), then the invoices (a payment, refund,
    // credit or dispute insert takes a share lock on its invoice): writers wait, or are already committed.
    await db.$queryRaw`SELECT id FROM customers WHERE id = ${customerId}::uuid FOR UPDATE`;
  }
  const invoices = await db.invoice.findMany({
    where: subtreeInvoiceWhere(customerId, orgId),
    select: { id: true, invoice_number: true, status: true, created_at: true, sent_at: true, paid_at: true },
  });
  const invoiceIds = invoices.map((i) => i.id);
  if (options.lockRows && invoiceIds.length > 0) {
    await db.$queryRaw`SELECT id FROM invoices WHERE id = ANY(${invoiceIds}::uuid[]) FOR UPDATE`;
  }
  const inSubtree = { invoice_id: { in: invoiceIds } };

  const [payments, refunds, credits, openDisputes] = await Promise.all([
    db.payment.findMany({
      where: inSubtree,
      select: { amount: true, method: true, paid_at: true, voided_at: true, state: true, stripe_payment_intent_id: true },
    }),
    db.refund.findMany({ where: { ...inSubtree, organization_id: orgId }, select: { created_at: true } }),
    db.credit.findMany({ where: { ...inSubtree, organization_id: orgId }, select: { created_at: true } }),
    db.dispute.count({ where: { ...inSubtree, organization_id: orgId, status: { in: [...OPEN_DISPUTE_STATUSES] } } }),
  ]);

  const kept = invoices.filter((i) => i.status !== 'DRAFT' && i.status !== 'VOIDED');
  const invoiceDate = (i: (typeof invoices)[number]) =>
    new Date(Math.max(...[i.created_at, i.sent_at, i.paid_at].filter((d): d is Date => !!d).map((d) => d.getTime())));
  // Money that settled: FAILED and PROCESSING payments are not in the count or the total (they still block,
  // through the date windows above and the in-flight check on the links). Summed in whole cents.
  const counted = payments.filter((p) => !p.voided_at && p.state === 'SUCCEEDED');
  const totalCents = counted.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0);
  const isOnline = (p: (typeof payments)[number]) =>
    (ONLINE_METHODS as readonly string[]).includes(p.method) || !!p.stripe_payment_intent_id;

  const blockers: PurgeBlocker[] = [];
  if (kept.some((i) => invoiceDate(i) >= moneyCutoff)) blockers.push('INVOICES_IN_RETENTION_WINDOW');
  if (
    payments.some((p) => p.paid_at >= moneyCutoff)
    || refunds.some((r) => r.created_at >= moneyCutoff)
    || credits.some((c) => c.created_at >= moneyCutoff)
  ) blockers.push('PAYMENTS_IN_RETENTION_WINDOW');
  if (openDisputes > 0) blockers.push('OPEN_DISPUTES');
  if (payments.some((p) => isOnline(p) && p.paid_at >= cardCutoff)) blockers.push('CARD_PAYMENTS_IN_DISPUTE_WINDOW');

  const dates = [
    ...kept.map(invoiceDate),
    ...payments.map((p) => p.paid_at),
    ...refunds.map((r) => r.created_at),
    ...credits.map((c) => c.created_at),
  ];
  const newest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;

  return {
    allowed: blockers.length === 0,
    blockers,
    invoice_count: kept.length,
    payment_count: counted.length,
    payment_total: Number((totalCents / 100).toFixed(2)),
    open_disputes: openDisputes,
    newest_financial_date: newest ? newest.toISOString() : null,
    has_card_payments: payments.some(isOnline),
    draft_invoice_count: invoices.filter((i) => i.status === 'DRAFT').length,
    invoices: invoices.map((i) => ({ id: i.id, invoice_number: i.invoice_number, status: i.status })),
  };
}
