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
import { ATTENTION_TYPES, type AttentionType } from './rules';

/** Deepest offset a page may start at: beyond it the caller narrows with a search or a type filter. */
export const MAX_OFFSET = 1_000;
export const MAX_LIMIT = 50;
export const TOO_DEEP = 'Narrow with search or a type filter';

/** Most invoices a free-text search may match (a search that wide is narrowed by a filter). */
const SEARCH_INVOICE_CAP = 20_000;

export function capsOf(req: Request): Caps {
  return {
    refund: !!req.ability?.can('refund', 'Invoice'),
    sendLink: !!req.ability?.can('send_payment_link', 'Invoice'),
    payoutAccount: !!req.ability?.can('manage_payout_account', 'Organization'),
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
  const rows = await prisma.invoice.findMany({
    where: {
      AND: [
        scope as Prisma.InvoiceWhereInput,
        tenantWhere(req),
        { OR: [{ invoice_number: { contains: text, mode: 'insensitive' } }, { customer: { is: nameMatch } }] },
      ],
    } as Prisma.InvoiceWhereInput,
    select: { id: true },
    take: SEARCH_INVOICE_CAP,
  });
  return rows.map((r) => r.id);
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
  const caps = capsOf(req);
  const now = new Date();
  return rows.map((r) => toItem(r, { openable, caps, now }));
}

/** One item by type and id for the caller's company (open or resolved), or null. */
export async function findAttention(req: Request, type: AttentionType, id: string): Promise<RawRow | null> {
  return findRow(await baseFilters(req), type, id);
}
