/**
 * Payments go-live P4 - the Needs attention list for one caller.
 *
 * `listAttention` is the page's card and chip; `countOpenAttention` is the cheap number (one count per source, no rows
 * loaded) the dashboard reuses. Both apply the caller's privacy rule: an item on an invoice they cannot open is listed
 * with its names left out, and an item on the organization itself is for callers whose invoice scope reaches every row,
 * so a number never exceeds what the list shows them.
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { tenantWhere } from '../../lib/tenant';
import { scopeWhereForReq } from '../../lib/permissions/enforce';
import { invoiceOpenerFor } from '../../lib/permissions/invoiceAccess';
import { buildPaginationMeta } from '../../lib/pagination';
import { countRows, findRow, pageRows, type Counts, type Filters, type RawRow, type View } from './queries';
import { toItem, type AttentionItem, type Caps } from './items';
import { payAgainUrl } from '../payment-reconciler/checkout-effects';
import { checkoutOpenStatus } from '../../lib/public-pay-state';
import { ATTENTION_TYPES, type AttentionType } from './rules';

/** Deepest offset a page may start at: beyond it the caller narrows with a search or a type filter. */
export const MAX_OFFSET = 1_000;
export const MAX_LIMIT = 50;
export const TOO_DEEP = 'Narrow with search or a type filter';

/** Most invoices a free-text search may match (a search that wide is narrowed by a filter). */
const SEARCH_INVOICE_CAP = 20_000;

export async function capsOf(req: Request): Promise<Caps> {
  const canCreate = !!req.ability?.can('create', 'Invoice') && !!req.ability?.can('create_standalone', 'Invoice');
  return {
    refund: !!req.ability?.can('refund', 'Invoice'),
    sendLink: !!req.ability?.can('send_payment_link', 'Invoice'),
    payoutAccount: !!req.ability?.can('manage_payout_account', 'Organization'),
    createInvoice: canCreate,
  };
}

/** The company, whether the caller's invoice scope is narrower than every invoice, and nothing else yet. */
export async function baseFilters(req: Request): Promise<Filters> {
  const scope = await scopeWhereForReq(req, 'Invoice');
  return { orgId: req.user!.organization_id, narrowed: Object.keys(scope).length > 0, searchInvoiceIds: null, types: null };
}

/**
 * The invoices a free-text search may match: customer name or invoice number, only through invoices the caller can open
 * (the invoice scope is a Prisma predicate, so the ids are resolved first, capped), so a search never reveals a hidden name.
 */
export async function searchInvoiceIds(req: Request, text: string): Promise<string[]> {
  const scope = await scopeWhereForReq(req, 'Invoice');
  const rows = await prisma.invoice.findMany({
    where: { AND: [scope as Prisma.InvoiceWhereInput, tenantWhere(req), invoiceTextMatch(text)] } as Prisma.InvoiceWhereInput,
    select: { id: true },
    take: SEARCH_INVOICE_CAP,
  });
  return rows.map((r) => r.id);
}

/** Invoices whose number contains the text, or whose customer's first, last or company name contains every word of it. */
export function invoiceTextMatch(text: string): Prisma.InvoiceWhereInput {
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
  return { OR: [{ invoice_number: { contains: text, mode: 'insensitive' } }, { customer: { is: nameMatch } }] } as Prisma.InvoiceWhereInput;
}

const sum = (c: Counts, view: View, types: readonly AttentionType[]): number => types.reduce((n, t) => n + c[t][view], 0);

/** { open, by_type } for the caller: one count per source, no rows. */
export async function countOpenAttention(req: Request): Promise<{ open: number; by_type: Record<AttentionType, number> }> {
  const counts = await countRows(await baseFilters(req));
  const by_type = Object.fromEntries(ATTENTION_TYPES.map((t) => [t, counts[t].open])) as Record<AttentionType, number>;
  return { open: sum(counts, 'open', ATTENTION_TYPES), by_type };
}

export interface ListQuery {
  view: View;
  types: AttentionType[] | null;
  q: string;
  /** Only the items that belong to this payment. */
  paymentId?: string;
  page: number;
  limit: number;
}

export async function listAttention(req: Request, query: ListQuery) {
  const base = await baseFilters(req);
  const offset = (query.page - 1) * query.limit;
  const filters: Filters = {
    ...base,
    types: query.types,
    ...(query.paymentId ? { paymentId: query.paymentId } : {}),
    searchInvoiceIds: query.q ? await searchInvoiceIds(req, query.q) : null,
  };
  const counts = await countRows(base);
  const filtered = query.types || query.q || query.paymentId ? await countRows(filters) : counts;
  const total = sum(filtered, query.view, query.types ?? ATTENTION_TYPES);
  const rows = offset >= total ? [] : await pageRows(filters, query.view, offset, query.limit);
  const items = await present(req, rows);
  return {
    items,
    pagination: buildPaginationMeta(total, { page: query.page, limit: query.limit, skip: offset }),
    counts: { open: sum(counts, 'open', ATTENTION_TYPES), resolved: sum(counts, 'resolved', ATTENTION_TYPES) },
  };
}

/** Rows as the caller sees them (one question about the page's invoices). */
export async function present(req: Request, rows: RawRow[]): Promise<AttentionItem[]> {
  const ids = [...new Set(rows.map((r) => r.invoice_id).filter((id): id is string => !!id))];
  const openable = await (await invoiceOpenerFor(req))(ids);
  const caps = await capsOf(req);
  const now = new Date();
  const payUrls = caps.sendLink ? await payUrlsFor(req, rows, openable) : undefined;
  return rows.map((r) => toItem(r, { openable, caps, now, payUrls }));
}

/**
 * The page a customer pays a failed bank payment's invoice from, as a finished URL, for the failed-payment rows the
 * caller can open (one batched, company-scoped read). Null when the invoice cannot be paid online right now (paid,
 * disputed, voided, refunded: the same rule as the automatic email) or has no link. Only for a holder of Send
 * payment links; the token is never returned on its own.
 */
async function payUrlsFor(req: Request, rows: RawRow[], openable: ReadonlySet<string>): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.filter((r) => r.type === 'failed_payment' && r.invoice_id && openable.has(r.invoice_id)).map((r) => r.invoice_id as string))];
  if (ids.length === 0) return new Map();
  const invoices = await prisma.invoice.findMany({
    where: { AND: [{ id: { in: ids } }, tenantWhere(req)] } as Prisma.InvoiceWhereInput,
    select: { id: true, kind: true, status: true, public_token: true, estimate: { select: { id: true, public_token: true } } },
  });
  return new Map(invoices.map((inv) => [inv.id, checkoutOpenStatus(inv.status, inv.kind === 'DEPOSIT') ? payAgainUrl(inv) : null]));
}

/** One item by type and id for the caller's company (open or resolved), or null. */
export async function findAttention(req: Request, type: AttentionType, id: string): Promise<RawRow | null> {
  return findRow(await baseFilters(req), type, id);
}
