/**
 * Payments go-live P3 - the Payments page's read API.
 *
 * Every number and row comes from ServWave's own records (the payments ledger, refunds, disputes and
 * payouts), never from a live read of the processor. No processor id, account id or processor error text
 * leaves this controller. Every query is scoped to the caller's company, and the queries run one after
 * another (the hosted pool allows one connection).
 */
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { COUNTED_PAYMENT_WHERE } from '../lib/payment-ledger';
import { DEPOSIT_CREDIT_REFERENCE } from '../lib/deposit-credit';
import { isBareOrgDay, orgDayRange, daysBetweenOrgDays } from '../lib/orgDayRange';
import { getRequestOrgTimezone } from '../lib/timezone';
import { logAudit } from '../lib/audit';
import { parseArrayParam } from '../lib/query/parseArrayParam';
import { buildPaginationMeta, parsePagination, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { PAYMENT_PAGE_SORT_FIELDS, type SortFieldMap } from '../lib/sortFields';
import { invoiceRefundCap, REFUNDABLE_INVOICE_STATUSES, REFUNDABLE_PAYMENT_WHERE } from '../lib/refund-cap';
import { invoiceOpenerFor } from '../lib/permissions/invoiceAccess';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { describeDisputeReason, describeFailure } from '../lib/payment-failure-reasons';
import { CHARGED_SQL, FEE_SQL, facetConditions, validStatuses } from '../lib/query/registries/payment.filters';
import {
  buildTimeline, customerNameOf, nextPayoutDate, payoutReference, payoutScheduleText, readPayoutSummary,
  succeededRefundTotal, toPageRow, type PaymentRowInput,
} from '../services/payments-page';

const cents = (n: unknown): number => Math.round(Number(n ?? 0) * 100);
const dollars = (c: number): number => c / 100;

/** The Payments tab lists ONLINE payments only: card and bank payments that went through the processor, never the synthetic deposit-credit rows. */
function onlinePaymentsWhere(req: Request): Prisma.PaymentWhereInput {
  return {
    method: { in: ['CARD', 'ACH'] },
    stripe_payment_intent_id: { not: null },
    AND: [{ OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }] }],
    invoice: { is: { ...tenantWhere(req) } },
  };
}

type Period = { from: string; to: string; range: { gte?: Date; lt?: Date } };

/** The period from `from`/`to` (org days, `to` inclusive), or the 400 message naming the bad field. */
async function readPeriod(req: Request, required: boolean): Promise<{ period: Period | null } | { error: string }> {
  const { from, to } = req.query;
  if (!from && !to && !required) return { period: null };
  if (!from) return { error: 'from is required (YYYY-MM-DD)' };
  if (!to) return { error: 'to is required (YYYY-MM-DD)' };
  if (!isBareOrgDay(from)) return { error: 'from must be a date like 2026-10-01' };
  if (!isBareOrgDay(to)) return { error: 'to must be a date like 2026-10-31' };
  if (Number.isNaN(Date.parse(`${from}T00:00:00Z`))) return { error: 'from must be a real date' };
  if (Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return { error: 'to must be a real date' };
  if (to < from) return { error: 'to cannot be before from' };
  if (daysBetweenOrgDays(from, to) + 1 > 366) return { error: 'to is more than a year after from; choose a shorter period' };
  const range = orgDayRange(from, to, await getRequestOrgTimezone(req));
  return { period: { from, to, range: range ?? {} } };
}

/** Today's date in the org's zone, as YYYY-MM-DD. */
function orgToday(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// GET /api/payments-page/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function getSummary(req: Request, res: Response) {
  try {
    const parsed = await readPeriod(req, true);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { period } = parsed;
    const collectedWhere: Prisma.PaymentWhereInput = {
      ...onlinePaymentsWhere(req),
      ...COUNTED_PAYMENT_WHERE,
      paid_at: period!.range,
    };
    const sums = await prisma.payment.aggregate({
      where: collectedWhere,
      _sum: { amount: true, tip_amount: true, service_fee_amount: true, stripe_fee_amount: true, platform_fee_amount: true, net_amount: true },
      _count: { _all: true },
    });
    const feesPending = await prisma.payment.count({ where: { ...collectedWhere, net_amount: null } });
    // The Disputed chip's count: the period's collected payments whose dispute is still open.
    const disputedCount = await prisma.payment.count({
      where: { ...collectedWhere, disputes: { some: { status: { in: ['NEEDS_RESPONSE', 'UNDER_REVIEW'] } } } },
    });
    const refundSum = await prisma.refund.aggregate({
      where: { state: 'SUCCEEDED', payment: { is: collectedWhere } },
      _sum: { amount: true },
    });

    // Net counts only payments whose fees are captured (net_amount known), so a refund is taken off net only for
    // those too: a payment with no net yet adds nothing to net, and its refund must not take anything off.
    const netRefundSum = await prisma.refund.aggregate({
      where: { state: 'SUCCEEDED', payment: { is: { ...collectedWhere, net_amount: { not: null } } } },
      _sum: { amount: true },
    });

    const collected = cents(sums._sum.amount) + cents(sums._sum.tip_amount) + cents(sums._sum.service_fee_amount);
    const fees = cents(sums._sum.stripe_fee_amount) + cents(sums._sum.platform_fee_amount);
    const refunds = cents(refundSum._sum.amount);
    const net = cents(sums._sum.net_amount) - cents(netRefundSum._sum.amount);

    // Next payout: collected money not yet in any payout (all time, not the period), what is in transit, and the date.
    const awaitingWhere: Prisma.PaymentWhereInput = { ...onlinePaymentsWhere(req), ...COUNTED_PAYMENT_WHERE, payout_id: null };
    const awaiting = await prisma.payment.aggregate({ where: awaitingWhere, _sum: { net_amount: true } });
    // A refund on a payment that has not joined a payout yet leaves the processor with less to send. Same rule as net:
    // only payments whose net is known are in the sum, so only their refunds come off.
    const awaitingRefunds = await prisma.refund.aggregate({
      where: { state: 'SUCCEEDED', payment: { is: { ...awaitingWhere, net_amount: { not: null } } } },
      _sum: { amount: true },
    });
    const inTransit = await prisma.payout.aggregate({
      where: { ...tenantWhere(req), status: { in: ['PENDING', 'IN_TRANSIT'] } },
      _sum: { amount: true },
    });
    const upcoming = await prisma.payout.findFirst({
      where: { ...tenantWhere(req), status: { in: ['PENDING', 'IN_TRANSIT'] }, arrival_date: { not: null } },
      orderBy: { arrival_date: 'asc' },
      select: { arrival_date: true },
    });
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id }, select: { payout_summary: true } });
    const schedule = readPayoutSummary(org?.payout_summary);
    const tz = await getRequestOrgTimezone(req);

    res.json({
      collected: dollars(collected),
      fees: dollars(fees),
      net: dollars(net),
      refunds: dollars(refunds),
      count: sums._count._all,
      fees_pending: feesPending,
      disputed_count: disputedCount,
      next_payout: {
        amount: dollars(cents(awaiting._sum.net_amount) - cents(awaitingRefunds._sum.amount)),
        in_transit: dollars(cents(inTransit._sum.amount)),
        date: upcoming?.arrival_date ? upcoming.arrival_date.toISOString().slice(0, 10) : nextPayoutDate(schedule, orgToday(tz)),
        schedule_text: payoutScheduleText(schedule),
        bank_label: schedule?.bank_label ?? null,
      },
    });
  } catch (error) {
    logger.error('payments-page summary failed', { error });
    res.status(500).json({ error: 'Could not load the payments summary' });
  }
}

// ---- The payments list --------------------------------------------------------------------------------------------

const EXPORT_CAP = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROW_SELECT = {
  id: true, amount: true, tip_amount: true, service_fee_amount: true, stripe_fee_amount: true, platform_fee_amount: true, net_amount: true,
  method: true, state: true, paid_at: true, voided_at: true, void_category: true,
  wallet: true, card_brand: true, card_last4: true, bank_name: true, bank_last4: true,
  invoice: {
    select: {
      id: true, invoice_number: true,
      customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
    },
  },
  payout: { select: { id: true, status: true, arrival_date: true } },
  refunds: { select: { amount: true, state: true } },
  disputes: { select: { status: true } },
} satisfies Prisma.PaymentSelect;

type RowRecord = Prisma.PaymentGetPayload<{ select: typeof ROW_SELECT }>;

const num = (v: unknown): number | null => (v == null ? null : Number(v));

function rowInputOf(p: RowRecord): PaymentRowInput {
  return {
    id: p.id,
    amount: Number(p.amount),
    tip: num(p.tip_amount),
    serviceFee: num(p.service_fee_amount),
    stripeFee: num(p.stripe_fee_amount),
    platformFee: num(p.platform_fee_amount),
    net: num(p.net_amount),
    method: p.method,
    state: p.state,
    paidAt: p.paid_at,
    voidedAt: p.voided_at,
    voidCategory: p.void_category,
    wallet: p.wallet,
    cardBrand: p.card_brand,
    cardLast4: p.card_last4,
    bankName: p.bank_name,
    bankLast4: p.bank_last4,
    refunds: p.refunds.map((r) => ({ amount: Number(r.amount), state: r.state })),
    openDispute: p.disputes.some((d) => d.status === 'NEEDS_RESPONSE' || d.status === 'UNDER_REVIEW'),
    payout: p.payout ? { id: p.payout.id, status: p.payout.status, arrivalDate: p.payout.arrival_date } : null,
    invoice: { id: p.invoice.id, number: p.invoice.invoice_number },
    customer: { id: p.invoice.customer.id, name: customerNameOf(p.invoice.customer) },
  };
}

/** The rows mapped for this caller: one reach lookup for the whole page, then one question about its invoices. */
async function mapRows(req: Request, records: RowRecord[]) {
  const openable = await (await invoiceOpenerFor(req, { checkOrg: true }))([...new Set(records.map((r) => r.invoice.id))]);
  return records.map((r) => toPageRow(rowInputOf(r), !openable.has(r.invoice.id)));
}

function amountBound(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Most invoices a free-text search may match (a search that wide is narrowed by the period or a filter). */
const SEARCH_INVOICE_CAP = 20_000;

/**
 * Free text over customer name, invoice number and payment id prefix, as one SQL condition. Name and number only ever
 * match through invoices the caller can open (the invoice scope is a Prisma predicate, so the matching invoice ids are
 * resolved first, capped), so a search never reveals a hidden name; the id prefix reveals nothing.
 */
async function searchCondition(req: Request, q: unknown): Promise<Prisma.Sql | null> {
  const text = typeof q === 'string' ? q.trim() : '';
  if (!text) return null;
  const scope = await scopeWhereForReq(req, 'Invoice');
  const tokens = text.split(/\s+/).filter(Boolean);
  const nameMatch = {
    AND: tokens.map((t) => ({
      OR: [
        { first_name: { contains: t, mode: 'insensitive' } },
        { last_name: { contains: t, mode: 'insensitive' } },
        { company_name: { contains: t, mode: 'insensitive' } },
      ],
    })),
  };
  const invoices = await prisma.invoice.findMany({
    where: {
      AND: [
        scope as Prisma.InvoiceWhereInput,
        tenantWhere(req),
        { payments: { some: { method: { in: ['CARD', 'ACH'] }, stripe_payment_intent_id: { not: null } } } },
        { OR: [{ invoice_number: { contains: text, mode: 'insensitive' } }, { customer: { is: nameMatch } }] },
      ],
    } as Prisma.InvoiceWhereInput,
    select: { id: true },
    take: SEARCH_INVOICE_CAP,
  });
  const parts: Prisma.Sql[] = [];
  if (invoices.length > 0) parts.push(Prisma.sql`i.id = ANY(${invoices.map((r) => r.id)}::text[]::uuid[])`);
  if (/^[0-9a-f-]{4,36}$/i.test(text)) parts.push(Prisma.sql`p.id::text LIKE ${text.toLowerCase() + '%'}`);
  return Prisma.sql`(${parts.length > 0 ? Prisma.join(parts, ' OR ') : Prisma.sql`FALSE`})`;
}

/** The SQL for the list and the export (`payments p` + `invoices i` + `payouts po`, scoped to the caller's company), or the 400 message. */
async function buildListQuery(req: Request): Promise<{ from: Prisma.Sql; filters: Record<string, string> } | { error: string }> {
  const parsed = await readPeriod(req, false);
  if ('error' in parsed) return parsed;
  const conds: Prisma.Sql[] = [
    Prisma.sql`i.organization_id = ${req.user!.organization_id}::uuid`,
    Prisma.sql`p.method IN ('CARD', 'ACH')`,
    Prisma.sql`p.stripe_payment_intent_id IS NOT NULL`,
    Prisma.sql`(p.reference_number IS NULL OR p.reference_number <> ${DEPOSIT_CREDIT_REFERENCE})`,
  ];
  const range = parsed.period?.range;
  if (range?.gte) conds.push(Prisma.sql`p.paid_at >= ${range.gte}`);
  if (range?.lt) conds.push(Prisma.sql`p.paid_at < ${range.lt}`);

  conds.push(...facetConditions({
    statuses: validStatuses(parseArrayParam(req.query.status)),
    chip: typeof req.query.chip === 'string' ? req.query.chip : '',
    methods: parseArrayParam(req.query.method),
    payoutStatuses: parseArrayParam(req.query.payout_status),
    amountMin: amountBound(req.query.amount_min),
    amountMax: amountBound(req.query.amount_max),
  }));
  const search = await searchCondition(req, req.query.q);
  if (search) conds.push(search);

  const filters: Record<string, string> = {};
  for (const key of ['from', 'to', 'q', 'chip', 'status', 'method', 'payout_status', 'amount_min', 'amount_max']) {
    const v = req.query[key];
    if (v != null && v !== '') filters[key] = Array.isArray(v) ? v.map(String).join(',') : String(v);
  }
  const from = Prisma.sql`FROM payments p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN payouts po ON po.id = p.payout_id WHERE ${Prisma.join(conds, ' AND ')}`;
  return { from, filters };
}

async function countListed(from: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT COUNT(*) AS n ${from}`);
  return Number(rows[0]?.n ?? 0);
}

const ORDER_BY: Record<string, (dir: Prisma.Sql) => Prisma.Sql> = {
  date: (dir) => Prisma.sql`p.paid_at ${dir}`,
  amount: (dir) => Prisma.sql`${CHARGED_SQL} ${dir}`,
  // A payment whose fee or net is not known yet sorts last in either direction.
  fee: (dir) => Prisma.sql`${FEE_SQL} ${dir} NULLS LAST`,
  net: (dir) => Prisma.sql`p.net_amount ${dir} NULLS LAST`,
};

/** One page of payment ids in sort order (the id is the tiebreak, in the same direction), paged in SQL. */
async function pageIds(from: Prisma.Sql, sortBy: string, dir: 'asc' | 'desc', skip: number, take: number): Promise<string[]> {
  const d = dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT p.id ${from} ORDER BY ${ORDER_BY[sortBy](d)}, p.id ${d} LIMIT ${take} OFFSET ${skip}`);
  return rows.map((r) => r.id);
}

/** The rows for these ids, in the order given. */
export async function recordsInOrder(req: Request, ids: string[]): Promise<RowRecord[]> {
  if (ids.length === 0) return [];
  // The ids come from queries already scoped to the company; the company is asked again here, so an id from anywhere else is never read.
  const found = await prisma.payment.findMany({ where: { id: { in: ids }, invoice: { organization_id: req.user!.organization_id } }, select: ROW_SELECT });
  const byId = new Map(found.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

// A prototype-less copy, so a sortBy of `constructor` or `toString` is unknown instead of finding an inherited property.
const OWN_PAYMENT_SORT_FIELDS: SortFieldMap = Object.assign(Object.create(null), PAYMENT_PAGE_SORT_FIELDS);

// GET /api/payments-page/payments
export async function listPayments(req: Request, res: Response) {
  try {
    const built = await buildListQuery(req);
    if ('error' in built) {
      res.status(400).json({ error: built.error });
      return;
    }
    const sort = parseSortParams(req.query as { sortBy?: string; sortDir?: string }, OWN_PAYMENT_SORT_FIELDS, 'paid_at', 'desc');
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const dir: 'asc' | 'desc' = req.query.sortDir === 'asc' ? 'asc' : 'desc';
    const pagination = parsePagination(req.query as { page?: string; limit?: string });
    const sortBy = typeof req.query.sortBy === 'string' && req.query.sortBy ? req.query.sortBy : 'date';
    const total = await countListed(built.from);
    const ids = await pageIds(built.from, sortBy, dir, pagination.skip, pagination.limit);
    res.json({ payments: await mapRows(req, await recordsInOrder(req, ids)), pagination: buildPaginationMeta(total, pagination) });
  } catch (error) {
    logger.error('payments-page list failed', error);
    res.status(500).json({ error: 'Could not load payments' });
  }
}

// GET /api/payments-page/payments/export
export async function exportPayments(req: Request, res: Response) {
  try {
    const built = await buildListQuery(req);
    if ('error' in built) {
      res.status(400).json({ error: built.error });
      return;
    }
    const total = await countListed(built.from);
    if (total > EXPORT_CAP) {
      res.status(413).json({ error: 'Narrow the period or the filters' });
      return;
    }
    const ids = await pageIds(built.from, 'date', 'desc', 0, EXPORT_CAP);
    const records: RowRecord[] = [];
    for (let i = 0; i < ids.length; i += 500) records.push(...(await recordsInOrder(req, ids.slice(i, i + 500))));
    const rows = (await mapRows(req, records)).map((r) => ({
      ...r,
      customer_name: r.restricted ? 'Restricted' : r.customer!.name,
      invoice_number: r.restricted ? 'Restricted' : r.invoice!.number,
    }));
    // Filters only: no row data goes into the audit trail.
    await logAudit({ req, action: 'payments.exported', resourceType: 'payments', metadata: { filters: built.filters, row_count: rows.length } });
    res.json({ payments: rows });
  } catch (error) {
    logger.error('payments-page export failed', error);
    res.status(500).json({ error: 'Could not export payments' });
  }
}

// GET /api/payments-page/payments/:id
export async function getPayment(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    const p = await prisma.payment.findFirst({
      where: { id, ...onlinePaymentsWhere(req) },
      select: {
        ...ROW_SELECT,
        failure_code: true,
        refunds: {
          select: { amount: true, state: true, created_at: true, reason_category: true, refunded_by_user: { select: { first_name: true, last_name: true } } },
          orderBy: { created_at: 'asc' },
        },
        disputes: { select: { id: true, status: true, reason: true, amount: true, evidence_due_by: true, closed_at: true, created_at: true }, orderBy: { created_at: 'desc' } },
      },
    });
    // A payment on an invoice the caller cannot open has no detail, and neither has another company's.
    const openable = p ? await (await invoiceOpenerFor(req, { checkOrg: true }))([p.invoice.id]) : new Set<string>();
    if (!p || !openable.has(p.invoice.id)) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    const row = toPageRow(rowInputOf(p as unknown as RowRecord), false);
    const openDispute = p.disputes.some((d) => d.status === 'NEEDS_RESPONSE' || d.status === 'UNDER_REVIEW');
    const canRefundRight = Boolean(req.ability?.can('refund', 'Invoice'));
    const dispute = p.disputes.find((d) => d.status === 'NEEDS_RESPONSE' || d.status === 'UNDER_REVIEW') ?? p.disputes[0] ?? null;
    const committed = p.refunds.filter((r) => r.state !== 'FAILED').reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);
    const paymentRoom = p.voided_at ? 0 : Math.max(0, (Math.round(Number(p.amount) * 100) - committed) / 100);
    // The refund route also caps at the invoice (net paid, or the undrawn credit of a deposit) and refuses an invoice that
    // is not paid; the same shared cap is used here so the drawer never offers a refund the route will refuse.
    const refundInvoiceRow = await prisma.invoice.findFirst({
      where: { id: p.invoice.id, ...tenantWhere(req) },
      select: {
        id: true, kind: true, status: true,
        payments: { where: REFUNDABLE_PAYMENT_WHERE, select: { amount: true } },
        refunds: { select: { amount: true, state: true, payment: { select: { voided_at: true } } } },
      },
    });
    const invoiceRoom = refundInvoiceRow && REFUNDABLE_INVOICE_STATUSES.includes(refundInvoiceRow.status)
      ? Math.max(0, await invoiceRefundCap(prisma, refundInvoiceRow))
      : 0;
    const refundable = Math.min(paymentRoom, invoiceRoom);
    const failureText = p.state === 'FAILED' ? describeFailure(p.failure_code) : null;
    res.json({
      ...row,
      invoice_amount: Number(p.amount),
      tip: num(p.tip_amount) ?? 0,
      service_fee: num(p.service_fee_amount) ?? 0,
      failure_text: failureText,
      refunds: p.refunds.map((r) => ({
        amount: Number(r.amount),
        state: r.state,
        created_at: r.created_at.toISOString(),
        reason_category: r.reason_category,
        by: [r.refunded_by_user?.first_name, r.refunded_by_user?.last_name].filter(Boolean).join(' ') || null,
      })),
      dispute: dispute
        ? {
            id: dispute.id,
            status: dispute.status,
            reason_text: describeDisputeReason(dispute.reason),
            amount: Number(dispute.amount),
            respond_by: dispute.evidence_due_by ? dispute.evidence_due_by.toISOString() : null,
            closed_at: dispute.closed_at ? dispute.closed_at.toISOString() : null,
          }
        : null,
      timeline: buildTimeline({
        method: p.method,
        state: p.state,
        paidAt: p.paid_at,
        failureText,
        refunds: p.refunds.map((r) => ({ amount: Number(r.amount), state: r.state, createdAt: r.created_at })),
        dispute: dispute ? { status: dispute.status, createdAt: dispute.created_at, closedAt: dispute.closed_at } : null,
        payout: p.payout ? { reference: payoutReference(p.payout.id), arrivalDate: p.payout.arrival_date, status: p.payout.status } : null,
      }),
      refundable_amount: refundable,
      // Refunding a payment with an open dispute can lose the money twice, so it waits for the dispute to close.
      can_refund: canRefundRight && p.state === 'SUCCEEDED' && refundable > 0 && !openDispute,
      // Only Refund payments holders respond to a dispute; View payments holders see it without the action.
      can_respond_dispute: canRefundRight && dispute?.status === 'NEEDS_RESPONSE',
      can_open_invoice: true,
    });
  } catch (error) {
    logger.error('payments-page detail failed', error);
    res.status(500).json({ error: 'Could not load this payment' });
  }
}

// ---- Payouts --------------------------------------------------------------------------------------------------------

const PAYOUT_STATUSES = ['PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED'];

function payoutRow(p: { id: string; status: string; amount: Prisma.Decimal; arrival_date: Date | null; destination_label: string | null }, paymentCount: number) {
  return {
    id: p.id,
    reference: payoutReference(p.id),
    arrival_date: p.arrival_date ? p.arrival_date.toISOString().slice(0, 10) : null,
    status: p.status,
    destination_label: p.destination_label,
    amount: Number(p.amount),
    payment_count: paymentCount,
  };
}

// GET /api/payments-page/payouts
export async function listPayouts(req: Request, res: Response) {
  try {
    const statuses = parseArrayParam(req.query.status).map((v) => v.toUpperCase()).filter((v) => PAYOUT_STATUSES.includes(v));
    const where: Prisma.PayoutWhereInput = { ...tenantWhere(req), ...(statuses.length ? { status: { in: statuses } } : {}) };
    const pagination = parsePagination(req.query as { page?: string; limit?: string });
    const total = await prisma.payout.count({ where });
    const rows = await prisma.payout.findMany({
      where,
      orderBy: [{ arrival_date: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }, { id: 'desc' }],
      skip: pagination.skip,
      take: pagination.limit,
      select: { id: true, status: true, amount: true, arrival_date: true, destination_label: true, _count: { select: { payments: { where: { voided_at: null } } } } },
    });
    res.json({ payouts: rows.map((r) => payoutRow(r, r._count.payments)), pagination: buildPaginationMeta(total, pagination) });
  } catch (error) {
    logger.error('payments-page payouts failed', error);
    res.status(500).json({ error: 'Could not load payouts' });
  }
}

/**
 * Charged amount, fees and net over the payments in a payout, summed in SQL (never over one page). A voided payment
 * (a chargeback, say) is not money in the payout, so it is left out; succeeded refunds come off net, for payments
 * whose net is known (the same rule as the period net).
 */
async function payoutTotals(payoutId: string) {
  const live = { payout_id: payoutId, voided_at: null } satisfies Prisma.PaymentWhereInput;
  const sums = await prisma.payment.aggregate({
    where: live,
    _sum: { amount: true, tip_amount: true, service_fee_amount: true, stripe_fee_amount: true, platform_fee_amount: true, net_amount: true },
  });
  const count = await prisma.payment.count({ where: live });
  const voidedCount = await prisma.payment.count({ where: { payout_id: payoutId, voided_at: { not: null } } });
  const refunds = await prisma.refund.aggregate({
    where: { state: 'SUCCEEDED', payment: { is: { ...live, net_amount: { not: null } } } },
    _sum: { amount: true },
  });
  return {
    count,
    voidedCount,
    totals: {
      amount: dollars(cents(sums._sum.amount) + cents(sums._sum.tip_amount) + cents(sums._sum.service_fee_amount)),
      fee: dollars(cents(sums._sum.stripe_fee_amount) + cents(sums._sum.platform_fee_amount)),
      net: dollars(cents(sums._sum.net_amount) - cents(refunds._sum.amount)),
    },
  };
}

/**
 * ServWave's net for the payout as it stood when the payout was created: only voids and succeeded refunds dated on or
 * before the payout's creation count. A refund or chargeback that happens later is debited from a LATER payout, so it
 * never belongs in the check against this payout's own amount.
 */
async function payoutNetAtCreation(payoutId: string, cutoff: Date) {
  const inPayout = {
    payout_id: payoutId,
    OR: [{ voided_at: null }, { voided_at: { gt: cutoff } }],
  } satisfies Prisma.PaymentWhereInput;
  const sums = await prisma.payment.aggregate({ where: inPayout, _sum: { net_amount: true } });
  const refunds = await prisma.refund.aggregate({
    where: { state: 'SUCCEEDED', created_at: { lte: cutoff }, payment: { is: { ...inPayout, net_amount: { not: null } } } },
    _sum: { amount: true },
  });
  return cents(sums._sum.net_amount) - cents(refunds._sum.amount);
}

async function findPayout(req: Request) {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) return null;
  return prisma.payout.findFirst({
    where: { id, ...tenantWhere(req) },
    select: { id: true, status: true, amount: true, arrival_date: true, destination_label: true, failure_code: true, created_at: true, processor_created_at: true },
  });
}

// GET /api/payments-page/payouts/:id
export async function getPayout(req: Request, res: Response) {
  try {
    const payout = await findPayout(req);
    if (!payout) {
      res.status(404).json({ error: 'Payout not found' });
      return;
    }
    const { count, totals } = await payoutTotals(payout.id);
    // Does what ServWave adds up for this payout agree with the amount the payout was sent for? The difference is
    // ServWave's net minus the payout amount, in dollars (never a processor id).
    const netAtCreation = await payoutNetAtCreation(payout.id, payout.processor_created_at ?? payout.created_at);
    const difference = dollars(netAtCreation - cents(payout.amount));
    res.json({
      ...payoutRow(payout, count),
      net_matches_payout: difference === 0,
      net_difference: difference,
      failure_text: payout.status === 'FAILED' ? describeFailure(payout.failure_code) : null,
      // What this caller may do about it: a failed payout is fixed by updating the bank account, by whoever manages the payout account.
      actions: { update_bank_account: payout.status === 'FAILED' && Boolean(req.ability?.can('manage_payout_account', 'Organization')) },
      totals,
    });
  } catch (error) {
    logger.error('payments-page payout failed', error);
    res.status(500).json({ error: 'Could not load this payout' });
  }
}

// GET /api/payments-page/payouts/:id/payments
export async function listPayoutPayments(req: Request, res: Response) {
  try {
    const payout = await findPayout(req);
    if (!payout) {
      res.status(404).json({ error: 'Payout not found' });
      return;
    }
    const pagination = parsePagination(req.query as { page?: string; limit?: string });
    const { count, voidedCount, totals } = await payoutTotals(payout.id);
    const records = await prisma.payment.findMany({
      where: { payout_id: payout.id, invoice: { organization_id: req.user!.organization_id } },
      select: ROW_SELECT,
      orderBy: [{ paid_at: 'desc' }, { id: 'desc' }],
      skip: pagination.skip,
      take: pagination.limit,
    });
    const voidedIds = new Set(records.filter((r) => r.voided_at != null).map((r) => r.id));
    // Each row carries the figures the footer counts: a voided (chargeback) row counts nothing, and a succeeded refund
    // comes off net once the net is known (the same rule payoutTotals uses). The charged amount stays on the row.
    const rows = (await mapRows(req, records)).map((r) => {
      const voided = voidedIds.has(r.id);
      return {
        id: r.id, customer: r.customer, invoice: r.invoice, restricted: r.restricted,
        voided,
        charged_amount: r.amount,
        amount: voided ? 0 : r.amount,
        fee: voided ? 0 : r.fee,
        refunded: r.refunded,
        net: voided ? 0 : r.net == null ? null : dollars(cents(r.net) - cents(r.refunded)),
      };
    });
    // Rows page over everything in the payout (voided ones included); the count says how many are counted.
    res.json({
      payments: rows,
      payment_count: count,
      voided_count: voidedCount,
      pagination: buildPaginationMeta(count + voidedCount, pagination),
      totals,
    });
  } catch (error) {
    logger.error('payments-page payout payments failed', error);
    res.status(500).json({ error: 'Could not load the payments in this payout' });
  }
}
