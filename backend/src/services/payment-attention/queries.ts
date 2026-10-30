/**
 * Payments go-live P4 - the SQL behind the Needs attention list.
 *
 * Every kind of item is derived from ServWave's own rows (payments, refunds, disputes, payouts, unapplied captures), so
 * nothing is stored twice and nothing asks the processor. Each kind has ONE select that returns the same columns (see
 * COLUMNS), so the kinds can be merged in the database: every branch is cut to its newest `take` rows (offset + limit)
 * before the merge, so no request ever loads more than that per kind. All text columns are tenant-scoped on the
 * organization id, and the whole request is one query (two for the counts), whatever the page.
 *
 * Ordering: newest first by `date` (the day the problem arose, to the millisecond), the item key as the tiebreak, both
 * descending, compared byte-wise (COLLATE "C") so the database and JavaScript agree.
 *
 * The open predicate of each kind is written once, here, as `is_open`; rules.ts puts words on the resolved ones.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type { AttentionType } from './rules';
import { ATTENTION_TYPES } from './rules';

export type View = 'open' | 'resolved';

export interface Filters {
  orgId: string;
  /** The caller's invoice scope does not reach every invoice: an item on the organization itself is not for them. */
  narrowed: boolean;
  /** Invoice ids a text search may match (those the caller can open), or null for no search. */
  searchInvoiceIds: string[] | null;
  /** Only these kinds, or null for all. */
  types: AttentionType[] | null;
  /** Only the row with this id (a single-item lookup pushes the id down, so it never scans the company's rows). */
  rowId?: string;
  /** Only the items that belong to this payment (a payout and unmatched money belong to none, so they drop out). */
  paymentId?: string;
}

/** One row of any kind, as the database returns it. */
export interface RawRow {
  key: string;
  type: AttentionType;
  date: Date;
  amount: Prisma.Decimal | null;
  code: string | null;
  payment_id: string | null;
  payout_id: string | null;
  dispute_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  customer_email: string | null;
  is_open: boolean;
  res_kind: string | null;
  res_note: string | null;
  res_by: string | null;
  res_at: Date | null;
  later_method: string | null;
  later_at: Date | null;
  later_by: string | null;
  src_status: string | null;
  is_bank_return: boolean | null;
  due_by: Date | null;
  resolved_ts: Date | null;
  refundable: boolean | null;
  pay_method: string | null;
  pay_paid_at: Date | null;
  rf_reason: string | null;
  rf_category: string | null;
}

const S = Prisma.sql;
/** The payment filter: `col` is the payment id the branch's items hang on; a branch with none passes null. */
const forPayment = (f: Filters, col: Prisma.Sql | null): Prisma.Sql =>
  !f.paymentId ? S`TRUE` : col ? S`${col} = ${f.paymentId}::uuid` : S`FALSE`;
const onlyRow = (f: Filters, col: Prisma.Sql): Prisma.Sql => (f.rowId ? S`${col} = ${f.rowId}::uuid` : S`TRUE`);
const MS = (expr: Prisma.Sql) => S`date_trunc('milliseconds', ${expr})`;
// A processor timestamp is timestamptz; every other column is a UTC timestamp. One type across the union.
const UTC = (expr: Prisma.Sql) => S`(${expr} AT TIME ZONE 'UTC')`;

/** The column list of every branch, in order. A branch fills what applies to it; the rest are typed NULLs. */
function columns(c: Partial<Record<keyof RawRow, Prisma.Sql>> & { key: Prisma.Sql; type: Prisma.Sql; date: Prisma.Sql; is_open: Prisma.Sql }): Prisma.Sql {
  const t = (k: keyof RawRow, cast: string): Prisma.Sql => c[k] ?? S`NULL::${Prisma.raw(cast)}`;
  return S`${c.key} AS key, ${c.type} AS type, ${MS(c.date)} AS date,
    ${t('amount', 'numeric')} AS amount, ${t('code', 'text')} AS code,
    ${t('payment_id', 'uuid')} AS payment_id, ${t('payout_id', 'uuid')} AS payout_id, ${t('dispute_id', 'uuid')} AS dispute_id,
    ${t('invoice_id', 'uuid')} AS invoice_id, ${t('invoice_number', 'text')} AS invoice_number, ${t('invoice_status', 'text')} AS invoice_status,
    ${t('customer_id', 'uuid')} AS customer_id, ${t('first_name', 'text')} AS first_name, ${t('last_name', 'text')} AS last_name,
    ${t('company_name', 'text')} AS company_name, ${t('customer_email', 'text')} AS customer_email,
    ${c.is_open} AS is_open,
    ${t('res_kind', 'text')} AS res_kind, ${t('res_note', 'text')} AS res_note, ${t('res_by', 'text')} AS res_by, ${t('res_at', 'timestamp')} AS res_at,
    ${t('later_method', 'text')} AS later_method, ${t('later_at', 'timestamp')} AS later_at, ${t('later_by', 'text')} AS later_by,
    ${t('src_status', 'text')} AS src_status, ${t('is_bank_return', 'boolean')} AS is_bank_return, ${t('due_by', 'timestamp')} AS due_by,
    ${t('resolved_ts', 'timestamp')} AS resolved_ts, ${t('refundable', 'boolean')} AS refundable,
    ${t('pay_method', 'text')} AS pay_method, ${t('pay_paid_at', 'timestamp')} AS pay_paid_at,
    ${t('rf_reason', 'text')} AS rf_reason, ${t('rf_category', 'text')} AS rf_category`;
}

const CUSTOMER_COLUMNS = {
  customer_id: S`c.id`, first_name: S`c.first_name`, last_name: S`c.last_name`, company_name: S`c.company_name`, customer_email: S`c.email`,
};
const RESOLUTION_COLUMNS = { res_kind: S`r.resolution`, res_note: S`r.note`, res_by: S`r.resolved_by_name`, res_at: S`r.resolved_at` };

/** The search and the narrowing, as conditions on invoice alias `i` (and, for unapplied money, the capture `ua`). */
function invoiceFilter(f: Filters, invoiceIdCol: Prisma.Sql): Prisma.Sql {
  if (f.searchInvoiceIds === null) return S`TRUE`;
  return f.searchInvoiceIds.length === 0 ? S`FALSE` : S`${invoiceIdCol} = ANY(${f.searchInvoiceIds}::text[]::uuid[])`;
}

interface Branch {
  types: AttentionType[];
  /** SELECT ... FROM ... WHERE ... (no ORDER/LIMIT), given the filters and the view's open/resolved condition. */
  select: (f: Filters, view: View | 'any') => Prisma.Sql;
  /** The open predicate alone (an aggregate counts with it), over the same FROM. */
  count: (f: Filters, type: AttentionType) => Prisma.Sql;
}

const viewCond = (view: View | 'any', open: Prisma.Sql): Prisma.Sql => (view === 'any' ? S`TRUE` : view === 'open' ? open : S`NOT (${open})`);

// ---- failed_payment ----------------------------------------------------------------------------------------------

const FAILED_PAYMENT_OPEN = S`(r.id IS NULL AND i.status NOT IN ('PAID', 'VOIDED') AND lp.paid_at IS NULL)`;
const FAILED_PAYMENT_FROM = (f: Filters) => S`FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN payment_attention_resolutions r ON r.organization_id = i.organization_id AND r.item_key = 'failed_payment:' || p.id::text
  LEFT JOIN LATERAL (
    -- Paid again once the payments that did not FAIL (SUCCEEDED, or a bank debit still PROCESSING) after this failure
    -- add up to at least the failed amount. A part payment settles nothing. If the in-flight debit later fails it shows
    -- as its own failed item, so nothing is hidden.
    SELECT t.method, t.paid_at FROM (
      SELECT q.method, q.paid_at, SUM(q.amount) OVER (ORDER BY q.paid_at, q.id) AS covered FROM payments q
      WHERE q.invoice_id = p.invoice_id AND q.state IN ('SUCCEEDED', 'PROCESSING') AND q.voided_at IS NULL AND q.paid_at > p.paid_at
    ) t
    WHERE t.covered >= p.amount
    ORDER BY t.paid_at ASC LIMIT 1
  ) lp ON TRUE
  WHERE i.organization_id = ${f.orgId}::uuid AND p.state = 'FAILED' AND p.method = 'ACH' AND p.voided_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.payment_id = p.id)
    AND ${invoiceFilter(f, S`i.id`)} AND ${onlyRow(f, S`p.id`)} AND ${forPayment(f, S`p.id`)}`;

const failedPayment: Branch = {
  types: ['failed_payment'],
  select: (f, view) => S`SELECT ${columns({
    key: S`'failed_payment:' || p.id::text`, type: S`'failed_payment'::text`, date: S`p.paid_at`, is_open: FAILED_PAYMENT_OPEN,
    amount: S`p.amount`, code: S`p.failure_code`, payment_id: S`p.id`, invoice_id: S`i.id`, invoice_number: S`i.invoice_number`, invoice_status: S`i.status::text`,
    ...CUSTOMER_COLUMNS, ...RESOLUTION_COLUMNS, later_method: S`lp.method::text`, later_at: S`lp.paid_at`,
  })} ${FAILED_PAYMENT_FROM(f)} AND ${viewCond(view, FAILED_PAYMENT_OPEN)}`,
  count: (f) => S`SELECT 'failed_payment'::text AS type, COUNT(*) FILTER (WHERE ${FAILED_PAYMENT_OPEN}) AS open, COUNT(*) FILTER (WHERE NOT ${FAILED_PAYMENT_OPEN}) AS resolved ${FAILED_PAYMENT_FROM(f)}`,
};

// ---- failed_refund -----------------------------------------------------------------------------------------------

const FAILED_REFUND_OPEN = S`(r.id IS NULL AND lr.created_at IS NULL)`;
const FAILED_REFUND_FROM = (f: Filters) => S`FROM refunds rf
  JOIN invoices i ON i.id = rf.invoice_id AND i.organization_id = rf.organization_id
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN payments pay ON pay.id = rf.payment_id
  LEFT JOIN payment_attention_resolutions r ON r.organization_id = rf.organization_id AND r.item_key = 'failed_refund:' || rf.id::text
  LEFT JOIN LATERAL (
    -- Settled once the refunds that did not FAIL (PENDING or SUCCEEDED) after this failure add up to at least the
    -- failed refunds on the payment from this one onward, so one refund settles one failure and a partial one settles
    -- none. A real bank refund stays PENDING for days; counting it stops a second refund. If it later fails it shows
    -- as its own failed item.
    SELECT t.created_at, u.first_name, u.last_name FROM (
      SELECT q.created_at, q.refunded_by, SUM(q.amount) OVER () AS total FROM refunds q
      WHERE q.organization_id = rf.organization_id AND q.payment_id = rf.payment_id AND q.state IN ('PENDING', 'SUCCEEDED') AND q.from_unapplied_capture = FALSE
        AND q.created_at > rf.created_at
    ) t LEFT JOIN users u ON u.id = t.refunded_by
    WHERE t.total >= (
      SELECT SUM(x.amount) FROM refunds x
      WHERE x.organization_id = rf.organization_id AND x.payment_id = rf.payment_id AND x.state = 'FAILED' AND x.from_unapplied_capture = FALSE
        AND x.created_at >= rf.created_at
    )
    ORDER BY t.created_at DESC LIMIT 1
  ) lr ON TRUE
  WHERE rf.organization_id = ${f.orgId}::uuid AND rf.state = 'FAILED' AND rf.from_unapplied_capture = FALSE
    AND ${invoiceFilter(f, S`i.id`)} AND ${onlyRow(f, S`rf.id`)} AND ${forPayment(f, S`rf.payment_id`)}`;

const failedRefund: Branch = {
  types: ['failed_refund'],
  select: (f, view) => S`SELECT ${columns({
    key: S`'failed_refund:' || rf.id::text`, type: S`'failed_refund'::text`, date: S`rf.created_at`, is_open: FAILED_REFUND_OPEN,
    amount: S`rf.amount`, code: S`rf.failure_code`, payment_id: S`rf.payment_id`, invoice_id: S`i.id`, invoice_number: S`i.invoice_number`, invoice_status: S`i.status::text`,
    ...CUSTOMER_COLUMNS, ...RESOLUTION_COLUMNS,
    later_at: S`lr.created_at`, later_by: S`NULLIF(btrim(COALESCE(lr.first_name, '') || ' ' || COALESCE(lr.last_name, '')), '')`,
    // Whether the payment still holds at least the failed amount that has not gone back (the invoice refund door can take it again).
    refundable: S`(pay.id IS NOT NULL AND pay.state = 'SUCCEEDED' AND pay.voided_at IS NULL AND pay.amount - COALESCE((SELECT SUM(x.amount) FROM refunds x WHERE x.payment_id = pay.id AND x.state <> 'FAILED'), 0) >= rf.amount)`,
    pay_method: S`pay.method::text`, pay_paid_at: S`pay.paid_at`, rf_reason: S`rf.reason`, rf_category: S`rf.reason_category::text`,
  })} ${FAILED_REFUND_FROM(f)} AND ${viewCond(view, FAILED_REFUND_OPEN)}`,
  count: (f) => S`SELECT 'failed_refund'::text AS type, COUNT(*) FILTER (WHERE ${FAILED_REFUND_OPEN}) AS open, COUNT(*) FILTER (WHERE NOT ${FAILED_REFUND_OPEN}) AS resolved ${FAILED_REFUND_FROM(f)}`,
};

// ---- dispute -----------------------------------------------------------------------------------------------------

const DISPUTE_OPEN = S`(d.status = 'NEEDS_RESPONSE')`;
const DISPUTE_FROM = (f: Filters) => S`FROM disputes d
  JOIN invoices i ON i.id = d.invoice_id AND i.organization_id = d.organization_id
  JOIN customers c ON c.id = i.customer_id
  WHERE d.organization_id = ${f.orgId}::uuid AND ${invoiceFilter(f, S`i.id`)} AND ${onlyRow(f, S`d.id`)} AND ${forPayment(f, S`d.payment_id`)}`;

const dispute: Branch = {
  types: ['dispute'],
  select: (f, view) => S`SELECT ${columns({
    key: S`'dispute:' || d.id::text`, type: S`'dispute'::text`, date: S`d.created_at`, is_open: DISPUTE_OPEN,
    amount: S`d.amount`, code: S`d.reason`, payment_id: S`d.payment_id`, dispute_id: S`d.id`,
    invoice_id: S`i.id`, invoice_number: S`i.invoice_number`, invoice_status: S`i.status::text`, ...CUSTOMER_COLUMNS,
    src_status: S`d.status::text`, is_bank_return: S`d.is_bank_return`, due_by: S`d.evidence_due_by`, resolved_ts: S`COALESCE(d.closed_at, d.updated_at)`,
  })} ${DISPUTE_FROM(f)} AND ${viewCond(view, DISPUTE_OPEN)}`,
  count: (f) => S`SELECT 'dispute'::text AS type, COUNT(*) FILTER (WHERE ${DISPUTE_OPEN}) AS open, COUNT(*) FILTER (WHERE NOT ${DISPUTE_OPEN}) AS resolved ${DISPUTE_FROM(f)}`,
};

// ---- failed_payout -----------------------------------------------------------------------------------------------

const PAYOUT_DATE = (a: string) => S`COALESCE(${UTC(S`${Prisma.raw(a)}.processor_created_at`)}, ${Prisma.raw(a)}.created_at)`;
const FAILED_PAYOUT_OPEN = S`(r.id IS NULL AND lp.date IS NULL)`;
// A payout belongs to no invoice, so a text search (customer, invoice number) never matches one.
const FAILED_PAYOUT_FROM = (f: Filters) => S`FROM payouts po
  LEFT JOIN payment_attention_resolutions r ON r.organization_id = po.organization_id AND r.item_key = 'failed_payout:' || po.id::text
  LEFT JOIN LATERAL (
    SELECT ${PAYOUT_DATE('q')} AS date FROM payouts q
    WHERE q.organization_id = po.organization_id AND q.status = 'PAID' AND ${PAYOUT_DATE('q')} > ${PAYOUT_DATE('po')}
    ORDER BY ${PAYOUT_DATE('q')} ASC LIMIT 1
  ) lp ON TRUE
  WHERE po.organization_id = ${f.orgId}::uuid AND po.status = 'FAILED' AND ${f.searchInvoiceIds === null ? S`TRUE` : S`FALSE`} AND ${onlyRow(f, S`po.id`)} AND ${forPayment(f, null)}`;

const failedPayout: Branch = {
  types: ['failed_payout'],
  select: (f, view) => S`SELECT ${columns({
    key: S`'failed_payout:' || po.id::text`, type: S`'failed_payout'::text`, date: PAYOUT_DATE('po'), is_open: FAILED_PAYOUT_OPEN,
    amount: S`po.amount`, code: S`po.failure_code`, payout_id: S`po.id`, ...RESOLUTION_COLUMNS, later_at: S`lp.date`,
  })} ${FAILED_PAYOUT_FROM(f)} AND ${viewCond(view, FAILED_PAYOUT_OPEN)}`,
  count: (f) => S`SELECT 'failed_payout'::text AS type, COUNT(*) FILTER (WHERE ${FAILED_PAYOUT_OPEN}) AS open, COUNT(*) FILTER (WHERE NOT ${FAILED_PAYOUT_OPEN}) AS resolved ${FAILED_PAYOUT_FROM(f)}`,
};

// ---- unmatched_payment / unmatched_refund ------------------------------------------------------------------------

const UNAPPLIED_OPEN = S`(ua.status = 'OPEN')`;
const UNAPPLIED_TYPE = S`(CASE WHEN ua.reason = 'REFUND_UNMATCHED' THEN 'unmatched_refund' ELSE 'unmatched_payment' END)::text`;
const UNAPPLIED_FROM = (f: Filters, types: AttentionType[] | null) => S`FROM unapplied_captures ua
  LEFT JOIN invoices i ON i.id = ua.invoice_id AND i.organization_id = ua.organization_id
  LEFT JOIN customers c ON c.id = i.customer_id
  WHERE ua.organization_id = ${f.orgId}::uuid
    AND ${onlyRow(f, S`ua.id`)}
    AND ${forPayment(f, null)}
    AND ${f.narrowed ? S`ua.invoice_id IS NOT NULL` : S`TRUE`}
    AND ${f.searchInvoiceIds === null ? S`TRUE` : invoiceFilter(f, S`ua.invoice_id`)}
    AND ${types === null || types.length === 2 ? S`TRUE` : types[0] === 'unmatched_refund' ? S`ua.reason = 'REFUND_UNMATCHED'` : S`ua.reason <> 'REFUND_UNMATCHED'`}`;

const unapplied: Branch = {
  types: ['unmatched_payment', 'unmatched_refund'],
  select: (f, view) => S`SELECT ${columns({
    key: S`${UNAPPLIED_TYPE} || ':' || ua.id::text`, type: UNAPPLIED_TYPE, date: S`ua.created_at`, is_open: UNAPPLIED_OPEN,
    amount: S`ua.amount`, code: S`ua.reason`, invoice_id: S`i.id`, invoice_number: S`i.invoice_number`, invoice_status: S`i.status::text`, ...CUSTOMER_COLUMNS,
    src_status: S`ua.status::text`, resolved_ts: S`COALESCE(ua.refunded_at, ua.updated_at)`,
    // Money that can go back from here: a payment (not a stray refund) whose connected account is on record.
    refundable: S`(ua.reason <> 'REFUND_UNMATCHED' AND ua.stripe_payment_intent_id IS NOT NULL AND ua.stripe_account_id IS NOT NULL)`,
  })} ${UNAPPLIED_FROM(f, f.types?.filter((t) => unapplied.types.includes(t)) ?? null)} AND ${viewCond(view, UNAPPLIED_OPEN)}`,
  count: (f, type) => S`SELECT ${Prisma.raw(`'${type}'`)}::text AS type, COUNT(*) FILTER (WHERE ${UNAPPLIED_OPEN}) AS open, COUNT(*) FILTER (WHERE NOT ${UNAPPLIED_OPEN}) AS resolved ${UNAPPLIED_FROM(f, [type])}`,
};

const BRANCHES: Branch[] = [failedPayment, failedRefund, dispute, failedPayout, unapplied];
const wanted = (b: Branch, f: Filters): boolean => f.types === null || b.types.some((t) => f.types!.includes(t));

// Always applied to a single-source SELECT (a wrapped branch, or the merge), so `key` is an input column here.
const ORDER = S`ORDER BY date DESC, key COLLATE "C" DESC`;

/**
 * One page of the list: each kind cut to its newest `take` rows, merged in the database, newest first. `take` is
 * offset + limit, so a page never loads more than that per kind; the rows to return are the `limit` after `offset`.
 */
export async function pageRows(f: Filters, view: View, offset: number, limit: number): Promise<RawRow[]> {
  const branches = BRANCHES.filter((b) => wanted(b, f));
  if (branches.length === 0) return [];
  const take = offset + limit;
  const parts = branches.map((b) => S`(SELECT * FROM (${b.select(f, view)}) branch ${ORDER} LIMIT ${take})`);
  return prisma.$queryRaw<RawRow[]>(S`SELECT * FROM (${Prisma.join(parts, ' UNION ALL ')}) merged ${ORDER} LIMIT ${limit} OFFSET ${offset}`);
}

/** One item by key, open or resolved (null when it is not this company's). The id is pushed into the query. */
export async function findRow(f: Filters, type: AttentionType, id: string): Promise<RawRow | null> {
  const branch = BRANCHES.find((b) => b.types.includes(type))!;
  const scoped: Filters = { ...f, types: [type], searchInvoiceIds: null, rowId: id };
  const rows = await prisma.$queryRaw<RawRow[]>(S`SELECT * FROM (${branch.select(scoped, 'any')}) one WHERE one.key = ${`${type}:${id}`}`);
  return rows[0] ?? null;
}

export type Counts = Record<AttentionType, { open: number; resolved: number }>;

/** Open and resolved counts per kind: one query, one small count per source. */
export async function countRows(f: Filters): Promise<Counts> {
  const out = Object.fromEntries(ATTENTION_TYPES.map((t) => [t, { open: 0, resolved: 0 }])) as Counts;
  const parts: Prisma.Sql[] = [];
  for (const b of BRANCHES) {
    if (!wanted(b, f)) continue;
    for (const t of b.types) if (f.types === null || f.types.includes(t)) parts.push(S`(${b.count(f, t)})`);
  }
  if (parts.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ type: AttentionType; open: bigint; resolved: bigint }>>(Prisma.join(parts, ' UNION ALL '));
  for (const r of rows) out[r.type] = { open: Number(r.open), resolved: Number(r.resolved) };
  return out;
}
