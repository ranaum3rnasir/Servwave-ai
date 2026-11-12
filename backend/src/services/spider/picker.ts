/**
 * Spider's lead picker, answered by the server (#3435, mockup M2): "Select Contacts for Alert" asks for one page of 50
 * at a time instead of downloading every customer and lead. Every read here is one company's, Admin-only (the routes'
 * gate), and runs a fixed number of queries whatever the company's size:
 *
 *   - the overview: open leads watched and open leads excluded;
 *   - customers WITH open leads, searched on name, company, lead number and phone, each with its open-lead count and
 *     how many of those are excluded, and with a search, how many customers match it in all;
 *   - one customer's open leads, each with whether it is excluded, its status, its Spider stage and when it entered it
 *     (the screen shows the time in stage) and its owner's name;
 *   - the excluded open leads, searched the same way, with the customer's id and name (the id moves that customer's
 *     chips at once when a lead is included again).
 *
 * "Open" and "watched" come from #3434 alone: open is `openLeadsWhere` (the sweep's own condition), watched is open and
 * not in spider_settings.excluded_lead_ids. An excluded lead that is closed is in no list and no count (the picker only
 * shows open leads); it stays on the exclusion list, so it is still excluded when it reopens.
 *
 * Pages are keyset pages, newest first (created_at, then id, both descending, so the order is total), continued from
 * an opaque cursor. A row carries only what the picker shows (mockup M2, version 3): a customer's name, company and
 * primary email; a lead's number, status, time in stage, owner's name and, in a customer's list, its own service
 * address on one line. Never a phone number.
 */
import type { LeadStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { phoneRelationSearchClauses, phoneSearchClauses } from '../../lib/phone-search';
import { containsIgnoringCase, escapeLike } from '../../lib/name-match';
import { customerName, spiderStageOf, SPIDER_LEAD_TIMES_SELECT, type SpiderStatus } from './config';
import { openLeadsWhere } from './sweep';

/** The most rows one picker page holds. */
export const PICKER_PAGE_SIZE = 50;

/** The longest search the picker accepts. */
const MAX_SEARCH_LENGTH = 100;

// ─── Cursor ──────────────────────────────────────────────────────────────────

/** Where a page ended: the last row's created_at and id. Sent to the screen as an opaque string. */
interface PageKey {
  created_at: Date;
  id: string;
}

function encodeCursor(key: PageKey): string {
  return Buffer.from(JSON.stringify([key.created_at.toISOString(), key.id])).toString('base64url');
}

const cursorShape = z.tuple([z.string().datetime(), z.string().uuid()]);

/** The key a cursor names, or null when the text is not a cursor this server wrote. */
function decodeCursor(text: string): PageKey | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
    return parsed.success ? { created_at: new Date(parsed.data[0]), id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/** Rows after the key in the newest-first order. */
function afterKey(key: PageKey | null): Prisma.LeadWhereInput & Prisma.CustomerWhereInput {
  if (!key) return {};
  return { OR: [{ created_at: { lt: key.created_at } }, { created_at: key.created_at, id: { lt: key.id } }] };
}

const NEWEST_FIRST = [{ created_at: 'desc' as const }, { id: 'desc' as const }];

/** One page of rows read with one extra, and the cursor to the next page (null on the last). */
function pageOf<T extends PageKey>(rows: T[]): { rows: T[]; next_cursor: string | null } {
  if (rows.length <= PICKER_PAGE_SIZE) return { rows, next_cursor: null };
  const page = rows.slice(0, PICKER_PAGE_SIZE);
  return { rows: page, next_cursor: encodeCursor(page[page.length - 1]!) };
}

// ─── Query string ────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  q: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
  cursor: z.string().max(200).optional(),
});

export interface PickerListQuery {
  q: string;
  after: PageKey | null;
}

/** The search and cursor of a list request, or the reason it is refused. */
export function parsePickerListQuery(query: unknown): { ok: true; value: PickerListQuery } | { ok: false; error: z.ZodError } {
  const parsed = listQuerySchema.safeParse(query ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error };
  const after = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after) {
    return {
      ok: false,
      error: new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'This page link is no longer valid. Reload the list.' }]),
    };
  }
  return { ok: true, value: { q: parsed.data.q ?? '', after } };
}

// ─── Search ──────────────────────────────────────────────────────────────────

/** A literal, case-insensitive "contains": `%` and `_` in a search match only themselves (lib/name-match.ts). */
const contains = containsIgnoringCase;

/**
 * A customer matching the search on its name, company or phone. Each word of a several-word search must match the
 * name or company ("Dana Cole" finds first name Dana, last name Cole); the whole search also matches a phone, however
 * either side is punctuated (lib/phone-search.ts).
 */
function customerSearch(q: string): Prisma.CustomerWhereInput[] {
  const words = q.split(/\s+/).filter(Boolean);
  const nameOrCompany = (w: string): Prisma.CustomerWhereInput[] => [
    { first_name: contains(w) },
    { last_name: contains(w) },
    { company_name: contains(w) },
  ];
  return [
    ...(words.length > 1 ? [{ AND: words.map((w) => ({ OR: nameOrCompany(w) })) }] : nameOrCompany(q)),
    // The phone candidates keep the term as typed (e.g. "L_77"), so they are escaped too.
    ...phoneSearchClauses(q).map((c) => ({ phone: { contains: escapeLike(c.phone.contains) } })),
    ...phoneRelationSearchClauses(q).map((c) => ({ phones: { some: { phone: { contains: escapeLike(c.phones.some.phone.contains) } } } })),
  ];
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The company's exclusion list (#3434); empty when Spider was never set up. */
export async function excludedLeadIdsOf(orgId: string): Promise<string[]> {
  const row = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId }, select: { excluded_lead_ids: true } });
  return row?.excluded_lead_ids ?? [];
}

export interface SpiderPickerOverview {
  /** Open leads Spider watches: every open lead that is not excluded. */
  watched: number;
  /** Open leads on the exclusion list. */
  excluded: number;
}

/** "Watching N open leads · M excluded". */
export async function pickerOverview(orgId: string, excludedLeadIds?: readonly string[]): Promise<SpiderPickerOverview> {
  const excludedIds = excludedLeadIds ?? (await excludedLeadIdsOf(orgId));
  const open = openLeadsWhere(orgId);
  const [openCount, excluded] = await Promise.all([
    prisma.lead.count({ where: open }),
    prisma.lead.count({ where: { ...open, id: { in: [...excludedIds] } } }),
  ]);
  return { watched: openCount - excluded, excluded };
}

export interface SpiderPickerCustomer {
  id: string;
  name: string;
  company_name: string | null;
  /** The customer's primary email (the row's second line), or null. */
  email: string | null;
  /** Its open leads. */
  open_leads: number;
  /** How many of them are excluded. */
  excluded_leads: number;
}

/**
 * One page of the company's customers with open leads, newest first, matching the search. A search also answers how
 * many customers match it in all (`total`: mockup M2's "38 customers with open leads match "bro""), counted with the
 * same condition in one more query; a list without a search has no total (the header counts leads, not customers).
 */
export async function pickerCustomers(orgId: string, { q, after }: PickerListQuery) {
  const search: Prisma.CustomerWhereInput = q
    ? { OR: [...customerSearch(q), { leads: { some: { ...openLeadsWhere(orgId), lead_number: contains(q) } } }] }
    : {};
  const matching: Prisma.CustomerWhereInput[] = [{ organization_id: orgId, leads: { some: openLeadsWhere(orgId) } }, search];
  const [excludedIds, rows, total] = await Promise.all([
    excludedLeadIdsOf(orgId),
    prisma.customer.findMany({
      where: { AND: [...matching, afterKey(after)] },
      select: { id: true, created_at: true, first_name: true, last_name: true, company_name: true, email: true },
      orderBy: NEWEST_FIRST,
      take: PICKER_PAGE_SIZE + 1,
    }),
    q ? prisma.customer.count({ where: { AND: matching } }) : Promise.resolve(null),
  ]);
  const page = pageOf(rows);
  const ids = page.rows.map((c) => c.id);
  const countBy = (where: Prisma.LeadWhereInput) =>
    ids.length
      ? prisma.lead.groupBy({ by: ['customer_id'], where: { ...where, customer_id: { in: ids } }, _count: { _all: true } })
      : Promise.resolve([]);
  const [open, excluded] = await Promise.all([
    countBy(openLeadsWhere(orgId)),
    countBy({ ...openLeadsWhere(orgId), id: { in: excludedIds } }),
  ]);
  const openOf = new Map(open.map((g) => [g.customer_id, g._count._all]));
  const excludedOf = new Map(excluded.map((g) => [g.customer_id, g._count._all]));
  const customers: SpiderPickerCustomer[] = page.rows.map((c) => ({
    id: c.id,
    name: customerName(c),
    company_name: c.company_name,
    email: c.email,
    open_leads: openOf.get(c.id) ?? 0,
    excluded_leads: excludedOf.get(c.id) ?? 0,
  }));
  return { customers, next_cursor: page.next_cursor, ...(total === null ? {} : { total }) };
}

const LEAD_ROW_SELECT = {
  id: true,
  lead_number: true,
  ...SPIDER_LEAD_TIMES_SELECT,
  commission_owner: { select: { first_name: true, last_name: true } },
} as const satisfies Prisma.LeadSelect;

type LeadRow = Prisma.LeadGetPayload<{ select: typeof LEAD_ROW_SELECT }>;

export interface SpiderPickerLead {
  id: string;
  lead_number: string;
  status: LeadStatus;
  /** The Spider stage the lead is in, or null when it is in none (e.g. Walkthrough Scheduled). */
  stage: SpiderStatus | null;
  /** When it entered that stage: the screen's "time in stage". Null when it is in no stage. */
  stage_entered_at: string | null;
  owner_name: string | null;
}

function withoutOwner({ owner_name: _owner, ...row }: SpiderPickerLead): Omit<SpiderPickerLead, 'owner_name'> {
  return row;
}

function leadRow(l: LeadRow): SpiderPickerLead {
  const visit = spiderStageOf(l);
  const owner = l.commission_owner ? `${l.commission_owner.first_name ?? ''} ${l.commission_owner.last_name ?? ''}`.trim() : '';
  return {
    id: l.id,
    lead_number: l.lead_number,
    status: l.status,
    stage: visit?.stage ?? null,
    stage_entered_at: visit?.enteredAt.toISOString() ?? null,
    owner_name: owner || null,
  };
}

/**
 * The lead's own service address on one line, as the picker draws it ("48 Elm Street, Springfield"): street lines and
 * city. Null when the lead has no service location of its own (the picker then shows no address).
 */
function addressLine(loc: { address_line1: string | null; address_line2: string | null; city: string | null } | null): string | null {
  if (!loc) return null;
  const line = [loc.address_line1, loc.address_line2, loc.city].map((p) => p?.trim()).filter(Boolean).join(', ');
  return line || null;
}

/**
 * One page of one customer's open leads, newest first, each with whether it is excluded. Null when the customer is not
 * this company's (or does not exist): the two answer alike.
 */
export async function pickerCustomerLeads(orgId: string, customerId: string, { after }: Pick<PickerListQuery, 'after'>) {
  const [customer, excludedIds, rows] = await Promise.all([
    prisma.customer.findFirst({ where: { id: customerId, organization_id: orgId }, select: { id: true } }),
    excludedLeadIdsOf(orgId),
    prisma.lead.findMany({
      where: { AND: [{ ...openLeadsWhere(orgId), customer_id: customerId }, afterKey(after)] },
      select: { ...LEAD_ROW_SELECT, service_location: { select: { address_line1: true, address_line2: true, city: true } } },
      orderBy: NEWEST_FIRST,
      take: PICKER_PAGE_SIZE + 1,
    }),
  ]);
  if (!customer) return null;
  const excluded = new Set(excludedIds);
  const page = pageOf(rows);
  return {
    leads: page.rows.map((l) => ({ ...leadRow(l), address: addressLine(l.service_location), excluded: excluded.has(l.id) })),
    next_cursor: page.next_cursor,
  };
}

/** One page of the company's excluded open leads, newest first, matching the search, with the customer's name. */
export async function pickerExcludedLeads(orgId: string, { q, after }: PickerListQuery) {
  const excludedIds = await excludedLeadIdsOf(orgId);
  if (excludedIds.length === 0) return { leads: [], next_cursor: null };
  const search: Prisma.LeadWhereInput = q ? { OR: [{ lead_number: contains(q) }, { customer: { OR: customerSearch(q) } }] } : {};
  const rows = await prisma.lead.findMany({
    where: { AND: [{ ...openLeadsWhere(orgId), id: { in: excludedIds } }, search, afterKey(after)] },
    select: { ...LEAD_ROW_SELECT, customer_id: true, customer: { select: { first_name: true, last_name: true, company_name: true } } },
    orderBy: NEWEST_FIRST,
    take: PICKER_PAGE_SIZE + 1,
  });
  const page = pageOf(rows);
  return {
    // The Excluded tab shows no owner (mockup M2 v3).
    leads: page.rows.map((l) => ({
      ...withoutOwner(leadRow(l)),
      customer_id: l.customer_id,
      customer_name: customerName(l.customer),
      customer_company_name: l.customer.company_name,
    })),
    next_cursor: page.next_cursor,
  };
}

// ─── The save ────────────────────────────────────────────────────────────────

export const updateSpiderExclusionsSchema = z
  .object({
    exclude: z.array(z.string().uuid()).max(5000),
    include: z.array(z.string().uuid()).max(5000),
  })
  .strict()
  .refine((b) => { const inc = new Set(b.include); return !b.exclude.some((id) => inc.has(id)); }, {
    message: 'A lead cannot be excluded and included in the same save.',
    path: ['include'],
  });
export type UpdateSpiderExclusionsBody = z.infer<typeof updateSpiderExclusionsSchema>;

/** The ids among these that are this company's open leads: anything else in a save is dropped. */
export async function openLeadIdsAmong(orgId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.lead.findMany({ where: { ...openLeadsWhere(orgId), id: { in: [...new Set(ids)] } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** The exclusion list after one Save: the list before, plus the leads excluded, minus the leads included. Sorted. */
export function applyExclusionChanges(before: readonly string[], change: { exclude: readonly string[]; include: readonly string[] }): string[] {
  const included = new Set(change.include);
  return [...new Set([...before, ...change.exclude])].filter((id) => !included.has(id)).sort();
}
