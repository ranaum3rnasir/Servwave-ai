/**
 * V7-09a (BE-10) - one unapplied payment or refund opened in its own drawer: why it is here, who paid, which invoice it
 * was meant for, which invoices could take it, and what this caller may do. Also the invoice search behind the Attach
 * dialog.
 *
 * Built from ServWave's own rows plus ONE on-demand read of how the money was paid (card or bank), which is never stored.
 * No processor id, error text or payer name leaves this module. Every query is scoped to the caller's company and, for
 * invoices, to the invoices the caller can open.
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { tenantWhere } from '../../lib/tenant';
import { scopeWhereForReq } from '../../lib/permissions/enforce';
import { logger } from '../../lib/logger';
import { retrieveCapturePayerDetail } from '../../lib/stripe';
import { PAYABLE_STATUSES, PROCESSING_PAYMENT_WHERE, payableNowCents } from '../../lib/payment-ledger';
import { describePaymentDetail } from '../../lib/payment-display';
import { unappliedReasonTexts } from '../../lib/unapplied-reason-text';
import { customerNameOf } from '../payments-page';
import { customerBlockFor } from '../payments-page/customerBlock';
import { findAttention, invoiceTextMatch, present } from './index';
import type { RawRow } from './queries';
import type { AttentionType } from './rules';

export const UNAPPLIED_TYPES: readonly AttentionType[] = ['unmatched_payment', 'unmatched_refund'];

/** Most suggested invoices on the drawer, and most rows the Attach dialog's search returns. */
const SUGGESTION_CAP = 10;
const SEARCH_CAP = 25;

const cents = (n: number): number => Math.round(n * 100);
const num = (d: { toString(): string } | null | undefined): number => (d == null ? 0 : Number(d.toString()));
const idOf = (row: RawRow): string => row.key.slice(row.key.indexOf(':') + 1);

/** The unapplied item for this id as the caller sees it (open or resolved), or null for another company's, an unknown id or one outside their reach. */
export async function findUnapplied(req: Request, id: string): Promise<RawRow | null> {
  const capture = await prisma.unappliedCapture.findFirst({ where: { id, ...tenantWhere(req) }, select: { reason: true } });
  if (!capture) return null;
  return findAttention(req, capture.reason === 'REFUND_UNMATCHED' ? 'unmatched_refund' : 'unmatched_payment', id);
}

const INVOICE_SELECT = {
  id: true, invoice_number: true, status: true, total_amount: true, amount_due: true, due_date: true,
  customer: { select: { first_name: true, last_name: true, company_name: true } },
  job: { select: { job_type: true } },
  line_items: { select: { description: true }, orderBy: { sequence: 'asc' }, take: 1 },
  // A bank debit still clearing takes room: what the invoice can take now is its balance less these.
  payments: { where: PROCESSING_PAYMENT_WHERE, select: { amount: true } },
} satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

/** What the suggestion and the search rows share. `job_type` falls back to the first line's description. */
function rowOf(inv: InvoiceRow, extra: { meant: boolean; canAttach: boolean; refund?: boolean }) {
  // `balance` is the invoice's real amount due (what its status will be worked out from). `payable_now` is what the booking
  // would accept (the same payableNowCents rule, less a bank debit still clearing); can_attach and the disabled reason follow it.
  return {
    id: inv.id,
    number: inv.invoice_number,
    customer: customerNameOf(inv.customer),
    due_date: inv.due_date ? inv.due_date.toISOString() : null,
    job_type: inv.job?.job_type?.trim() || inv.line_items[0]?.description?.trim() || null,
    amount: num(inv.total_amount),
    balance: num(inv.amount_due),
    payable_now: extra.refund ? num(inv.amount_due) : payableNowCents(inv) / 100,
    meant: extra.meant,
    can_attach: extra.canAttach,
  };
}

/** The invoices a payment could be attached to: open (hand-payable statuses), not a deposit, in this company and the caller's reach. */
async function attachableWhere(req: Request): Promise<Prisma.InvoiceWhereInput> {
  const scope = (await scopeWhereForReq(req, 'Invoice')) as Prisma.InvoiceWhereInput;
  return { AND: [tenantWhere(req), scope, { status: { in: [...PAYABLE_STATUSES] }, kind: { not: 'DEPOSIT' } }] };
}

const BY_DUE: Prisma.InvoiceOrderByWithRelationInput[] = [{ due_date: 'asc' }, { invoice_number: 'asc' }];

/** The meant-for invoice (when it is still open) first, then up to nine more open invoices that owe exactly the payment. */
async function suggestedInvoices(req: Request, row: RawRow, amount: number) {
  const where = await attachableWhere(req);
  const meantId = row.invoice_id;
  const meant = meantId ? await prisma.invoice.findFirst({ where: { AND: [where, { id: meantId }] }, select: INVOICE_SELECT }) : null;
  const same = await prisma.invoice.findMany({
    where: { AND: [where, { amount_due: amount }, ...(meant ? [{ id: { not: meant.id } }] : [])] },
    select: INVOICE_SELECT,
    orderBy: BY_DUE,
    take: SUGGESTION_CAP - (meant ? 1 : 0),
  });
  return [
    ...(meant ? [rowOf(meant, { meant: true, canAttach: payableNowCents(meant) >= cents(amount) })] : []),
    ...same.map((inv) => rowOf(inv, { meant: false, canAttach: payableNowCents(inv) >= cents(amount) })),
  ];
}

const payerBasics = (row: RawRow, id: string) => ({
  received_at: row.date.toISOString(),
  reference: row.key.startsWith('unmatched_refund:') ? shortRef('REF-', id) : shortRef('RCV-', id),
});

/** How the money was paid, in words: only what the processor read gave, nothing else. */
async function payerOf(row: RawRow, id: string, capture: { stripe_payment_intent_id: string | null; stripe_account_id: string | null }) {
  const base = { received_at: row.date.toISOString(), reference: row.key.startsWith('unmatched_refund:') ? shortRef('REF-', id) : shortRef('RCV-', id) };
  if (!capture.stripe_account_id || !capture.stripe_payment_intent_id) return base;
  let read: Awaited<ReturnType<typeof retrieveCapturePayerDetail>> = null;
  try {
    // Outside any transaction (the pool allows one connection). A failed read only means the rows are left out.
    read = await retrieveCapturePayerDetail(capture.stripe_account_id, capture.stripe_payment_intent_id);
  } catch (error) {
    logger.warn('unapplied payer read failed', { capture_id: id, error: error instanceof Error ? error.name : 'unknown' });
  }
  if (!read) return base;
  const detail = describePaymentDetail(
    read.method === 'card'
      ? { method: 'CARD', cardBrand: read.brand, cardLast4: read.last4 }
      : { method: 'ACH', bankName: read.bank_name, bankLast4: read.last4 },
  );
  return {
    ...base,
    method_label: read.method === 'card' ? 'Card' : 'Bank',
    ...(detail ? { detail } : {}),
    ...(read.description ? { description: read.description } : {}),
  };
}

const shortRef = (prefix: 'RCV-' | 'REF-', id: string): string => `${prefix}${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** The drawer body for one unapplied item (spec BE-10 "Detail"). */
export async function unappliedDetail(req: Request, row: RawRow) {
  const id = idOf(row);
  const [item] = await present(req, [row]);
  const restricted = item.restricted;
  const kind = row.type === 'unmatched_refund' ? 'REFUND' : 'PAYMENT';
  const amount = row.amount == null ? null : Number(row.amount);
  // A caller who cannot open the invoice gets the reason in words but not its number or total.
  const texts = unappliedReasonTexts({
    reason: row.code ?? '', invoiceStatus: row.invoice_status, invoiceNumber: restricted ? null : row.invoice_number,
    invoiceTotal: restricted || row.invoice_total == null ? null : Number(row.invoice_total), amount, sameAmountPaid: row.same_amount_paid,
  });
  // The payer is read only for an open item: a resolved or attached one already has its method stored.
  const capture = restricted || !row.is_open
    ? null
    : await prisma.unappliedCapture.findFirst({ where: { id, ...tenantWhere(req) }, select: { stripe_payment_intent_id: true, stripe_account_id: true } });
  const customerBlock = row.invoice_id ? await customerBlockFor({ invoiceId: row.invoice_id }, req) : null;
  const canSuggest = kind === 'PAYMENT' && row.is_open && !restricted && !row.on_payment_row && amount != null && amount > 0;
  return {
    id,
    key: row.key,
    kind,
    title: item.title,
    status: item.status,
    amount,
    reference: restricted ? null : (item.reference as string | null),
    created_at: row.date.toISOString(),
    reason_short: texts.short,
    reason_long: texts.long,
    restricted,
    meant_for: {
      invoice: row.invoice_id && !restricted && row.invoice_number
        ? { id: row.invoice_id, number: row.invoice_number, status: row.invoice_status, total: row.invoice_total == null ? null : Number(row.invoice_total) }
        : null,
    },
    customer_block: customerBlock,
    payer: capture ? await payerOf(row, id, capture) : restricted ? null : payerBasics(row, id),
    suggested_invoices: canSuggest ? await suggestedInvoices(req, row, amount!) : [],
    resolved_at: item.resolved_at,
    resolved_by_name: item.resolved_by_name,
    resolution: item.resolution,
    actions: item.actions,
  };
}

/**
 * The Attach dialog's search. A payment: open invoices, the meant-for one first, then the ones that owe exactly the
 * payment, then the rest that can take it, then the ones that owe less (listed so the dialog can show them disabled).
 * A refund: any non-voided invoice holding a succeeded payment with at least the refund still refundable. At most 25.
 * The caller's invoice reach and the company always apply.
 */
export async function searchInvoicesForCapture(req: Request, row: RawRow, text: string) {
  if (!row.is_open || row.amount == null) return [];
  const amount = Number(row.amount);
  const meantId = row.invoice_id;
  const match: Prisma.InvoiceWhereInput = text ? invoiceTextMatch(text) : {};
  const scope = (await scopeWhereForReq(req, 'Invoice')) as Prisma.InvoiceWhereInput;

  if (row.type === 'unmatched_refund') {
    const eligible = await prisma.$queryRaw<Array<{ invoice_id: string }>>`
      SELECT DISTINCT p.invoice_id::text AS invoice_id
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
      WHERE i.organization_id = ${req.user!.organization_id}::uuid AND i.status <> 'VOIDED'
        AND p.state = 'SUCCEEDED' AND p.voided_at IS NULL
        AND p.amount - COALESCE((SELECT SUM(x.amount) FROM refunds x WHERE x.payment_id = p.id AND x.state <> 'FAILED'), 0) >= ${amount}
      LIMIT 5000`;
    const ids = eligible.map((e) => e.invoice_id);
    if (ids.length === 0) return [];
    const eligibleWhere: Prisma.InvoiceWhereInput = { AND: [tenantWhere(req), scope, { id: { in: ids }, status: { not: 'VOIDED' } }, match] };
    // The meant-for invoice is fetched on its own so it is always first, however many other invoices match.
    const meantInv = meantId ? await prisma.invoice.findFirst({ where: { AND: [eligibleWhere, { id: meantId }] }, select: INVOICE_SELECT }) : null;
    const found = await prisma.invoice.findMany({
      where: { AND: [eligibleWhere, ...(meantInv ? [{ id: { not: meantInv.id } }] : [])] },
      select: INVOICE_SELECT,
      orderBy: [{ created_at: 'desc' }],
      take: SEARCH_CAP - (meantInv ? 1 : 0),
    });
    return [...(meantInv ? [meantInv] : []), ...found]
      .map((inv) => ({ ...rowOf(inv, { meant: inv.id === meantId, canAttach: true, refund: true }), status: inv.status, same_amount: false }));
  }

  const where: Prisma.InvoiceWhereInput = { AND: [await attachableWhere(req), match] };
  const take = SEARCH_CAP;
  const meant = meantId ? await prisma.invoice.findFirst({ where: { AND: [where, { id: meantId }] }, select: INVOICE_SELECT }) : null;
  const notMeant: Prisma.InvoiceWhereInput = meant ? { id: { not: meant.id } } : {};
  const bucket = (due: Prisma.InvoiceWhereInput) => prisma.invoice.findMany({
    where: { AND: [where, notMeant, due] }, select: INVOICE_SELECT, orderBy: BY_DUE, take,
  });
  const [same, more, less] = await Promise.all([
    bucket({ amount_due: amount }),
    bucket({ amount_due: { gt: amount } }),
    bucket({ amount_due: { lt: amount, gt: 0 } }),
  ]);
  const out = [
    ...(meant ? [{ inv: meant, meant: true }] : []),
    ...same.map((inv) => ({ inv, meant: false })),
    ...more.map((inv) => ({ inv, meant: false })),
    ...less.map((inv) => ({ inv, meant: false })),
  ].slice(0, take);
  return out.map(({ inv, meant: isMeant }) => ({
    ...rowOf(inv, { meant: isMeant, canAttach: payableNowCents(inv) >= cents(amount) }),
    status: inv.status,
    // Spec 7.16: "same amount" is the invoice whose amount due is exactly the payment.
    same_amount: cents(num(inv.amount_due)) === cents(amount),
  }));
}
