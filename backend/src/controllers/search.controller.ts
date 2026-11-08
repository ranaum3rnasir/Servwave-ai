import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { matchesFragment, proofSelectFor, stripCustomerProofKeys } from '../lib/permissions/customerScope';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../lib/phone-search';
import type { Subject } from '../lib/permissions/catalog';
import { walkthroughSnapshotSelect, resolveCurrentWalkthrough, LIVE_VISIT_STATUSES, type WalkthroughSnapshotRow } from '../services/walkthrough.service';
import { hasFeature } from '../middleware/requireFeature';
import { derivePlanFields, type VisitLike } from '../lib/servicePlans/derive';

/**
 * Compose a multi-word "split" search (every word must match) into a `where` that already
 * carries the spread-in row-scope from `scopeWhereForReq`. Each word becomes a required clause
 * under `AND`. Clobber-safe: a multi-read user's scope is `{ OR: [...] }` (a top-level `OR`, never
 * a top-level `AND`), so appending to / creating `AND` here never drops the scope `OR` — Prisma
 * AND-s a sibling top-level `OR` and `AND` together. Mirrors `addOrFilter`'s anti-leak intent for
 * the conjunctive (per-word) case.
 */
function addAndWords(where: Record<string, unknown>, wordClauses: Record<string, unknown>[]): void {
  const existing = Array.isArray(where.AND)
    ? (where.AND as Record<string, unknown>[])
    : where.AND !== undefined
      ? [where.AND as Record<string, unknown>]
      : [];
  where.AND = [...existing, ...wordClauses];
}

// ─── Helpers ────────────────────────────────────────────

function contains(term: string) {
  return { contains: term, mode: 'insensitive' as const };
}

/** OR across customer name fields for a single word. */
function nameFieldsOr(word: string) {
  return [
    { first_name: contains(word) },
    { last_name: contains(word) },
    { company_name: contains(word) },
  ];
}

/** Merge multiple arrays, deduplicate by id, cap at limit. */
function mergeById<T extends { id: string }>(arrays: T[][], limit: number): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const arr of arrays) {
    for (const item of arr) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
        if (merged.length >= limit) return merged;
      }
    }
  }
  return merged;
}

/**
 * Run a query safely — returns [] on error instead of throwing. Also coerces a resolved
 * `undefined`/`null` to `[]` (Slice 09): an un-mocked `vi.fn()` in a test resolves `undefined`
 * rather than throwing or rejecting, so a bare `prisma.<model>.findMany` call passed straight to
 * this wrapper (no intermediate `.map`/`.filter` to force a throw, unlike e.g. `findSchedulePlans`)
 * would otherwise hand `undefined` to `mergeById`, which throws iterating a non-array — a
 * production-impossible shape (Prisma always resolves an array or rejects) that should never
 * escape this boundary regardless of why it occurred.
 */
async function safeQuery<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return (await fn()) ?? [];
  } catch (err) {
    logger.warn('Search sub-query failed:', err);
    return [];
  }
}

// ─── Shared select shapes ───────────────────────────────

// S8 repoint (D14), FINISHED: `first_visit_start` (S8 §4, #1698 - MIN(scheduled_at) over
// non-cancelled visits, stored and maintained) replaces `scheduled_start` here, in `jobOrderBy`
// below, and in the `date:` projection near the bottom of this file - the three TODOs #1705 left
// pointing at this comment. A REAL, ORDERABLE scalar, unlike the A5 "next upcoming live visit"
// projection used on the job detail/list payloads: this is a sort/filter need (Prisma cannot
// ORDER BY a to-many relation's aggregate), not a "current window" need - same distinction A1 drew
// for JOB_SORT_FIELDS. The FILTER (`inRangeWhere` below) was already repointed to the visit set in
// the same PR that left these TODOs, which is the part that actually loses rows (the
// D16-collapse/7,492-row bug); this is the remaining display/order half.
const JOB_SELECT = {
  id: true,
  job_number: true,
  status: true,
  first_visit_start: true,
  customer: { select: { first_name: true, last_name: true, company_name: true, phone: true } },
  service_location: { select: { address_line1: true, city: true, state: true } },
} as const;

const CUSTOMER_SELECT = {
  id: true,
  customer_number: true,
  first_name: true,
  last_name: true,
  company_name: true,
  phone: true,
  email: true,
  service_locations: { take: 1, select: { address_line1: true, city: true, state: true } },
} as const;

const LEAD_SELECT = {
  id: true,
  lead_number: true,
  service_request: true,
  status: true,
  created_at: true,
  // Walkthrough-as-entity redesign, PR-B2 (PR-D2 gap #4): walkthrough_scheduled_at is no
  // longer a raw legacy column read here - the schedule-scope transform below sources it
  // from this relation via resolveCurrentWalkthrough (D15's "current visit"), so a lead
  // whose walkthrough already COMPLETED (dual-write never clears walkthrough_scheduled_at
  // on completion) correctly stops showing up as "upcoming" in schedule-scope search.
  visits: { select: walkthroughSnapshotSelect },
  service_address_line1: true,
  service_city: true,
  service_state: true,
  customer: { select: { first_name: true, last_name: true, company_name: true, phone: true } },
} as const;

/**
 * The visit states the schedule board actually renders: every LIVE one - the calendar shows a
 * booked trip, and the sidebar's Walkthroughs bucket shows leads with none. Search used to admit
 * SCHEDULED only, so every card in the sidebar bucket was unfindable by the board's own search -
 * the reported bug.
 *
 * Until multi-visit S4 this named REQUESTED, a VisitStatus the S1 migration retired. It typechecks
 * because leadBaseWhere is a Record<string, unknown>, and safeQuery swallows the Prisma validation
 * error into an empty array - so against a real database schedule-scope lead search returned
 * NOTHING while every mocked test stayed green. Sourced from the shared constant now, so it cannot
 * drift out of the enum again.
 */
const BOARD_WALKTHROUGH_STATUSES = { in: [...LIVE_VISIT_STATUSES] } as const;

/**
 * Narrow a lead `where` to leads with a live visit, WITHOUT touching whatever `visits` predicate
 * the caller's row-scope already put there. See the call sites for why assignment is a leak.
 */
function addBoardVisitFilter(where: Record<string, unknown>): void {
  addAndWords(where, [{ visits: { some: { status: BOARD_WALKTHROUGH_STATUSES } } }]);
}

/**
 * Prisma cannot ORDER BY a to-many relation's scalar field (`walkthroughs` is 1:N on Lead), so
 * the schedule-scope lead queries below cannot ask the DB to sort by "the current visit's
 * scheduled_at" directly. Over-fetch a generous, bounded cap and sort/slice in application code
 * instead - acceptable here because this is a bounded search-typeahead result set (LIMIT=5), not
 * a paginated report.
 */
const SCHEDULE_OVERFETCH = 25;

type ScheduleLeadRow = { id: string; visits?: WalkthroughSnapshotRow[] } & Record<string, unknown>;

/** The current visit's scheduled_at, or null when the lead holds no visit at all. */
function currentVisitAt(l: ScheduleLeadRow): Date | null {
  return resolveCurrentWalkthrough(l.visits ?? [])?.scheduled_at ?? null;
}

/**
 * Scheduled walkthroughs first, soonest to furthest, then the unscheduled ones. A REQUESTED
 * walkthrough has no scheduled_at to sort on (resolveCurrentWalkthrough resolves it to null),
 * so it is appended rather than dropped - dropping it is what hid the whole sidebar bucket.
 */
async function findScheduleLeads(where: Record<string, unknown>, take: number): Promise<ScheduleLeadRow[]> {
  const rows = (await prisma.lead.findMany({
    where, take: SCHEDULE_OVERFETCH, orderBy: { created_at: 'desc' }, select: LEAD_SELECT,
  })) as ScheduleLeadRow[];
  const scheduled = rows
    .map((row) => ({ row, at: currentVisitAt(row) }))
    .filter((x): x is { row: ScheduleLeadRow; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((x) => x.row);
  const unscheduled = rows.filter((row) => currentVisitAt(row) === null);
  return [...scheduled, ...unscheduled].slice(0, take);
}

/**
 * Everything derivePlanFields needs (the recurrence rule fields + the visits it counts
 * against) plus what the row renders. The rule fields are not display data - they are why
 * search can answer "is this plan still in the sidebar bucket" without a second round trip.
 */
const SERVICE_PLAN_SELECT = {
  id: true,
  service_plan_number: true,
  name: true,
  status: true,
  visit_cadence: true,
  interval_unit: true,
  interval_count: true,
  byweekday: true,
  occurrence_count: true,
  start_date: true,
  end_date: true,
  visits: { select: { status: true, scheduled_date: true } },
  customer: { select: { first_name: true, last_name: true, company_name: true, phone: true } },
  service_location: { select: { address_line1: true, city: true, state: true } },
} as const;

type SchedulePlanRow = { id: string; visits: VisitLike[]; next_due: Date } & Record<string, unknown>;

/**
 * The sidebar's Service Plans bucket is not a plain query: `visits_remaining` and `next_due`
 * are DERIVED from the recurrence rule against the visits actually actioned, so neither can
 * be a `where` or an `orderBy`. Over-fetch, derive, then drop the exhausted plans in
 * application code - the same shape findScheduleLeads uses, and the same filter
 * schedulerBucket applies, so a search hit is always a plan the bucket really carries
 * rather than a dead end.
 */
async function findSchedulePlans(where: Record<string, unknown>, take: number): Promise<SchedulePlanRow[]> {
  const rows = await prisma.servicePlan.findMany({
    where, take: SCHEDULE_OVERFETCH, orderBy: { start_date: 'asc' }, select: SERVICE_PLAN_SELECT,
  });
  const now = new Date();
  return rows
    .map((row) => ({ row, d: derivePlanFields(row as never, row.visits as VisitLike[], now) }))
    // Open-ended plans (null remaining) always belong in the bucket; finite plans need >0 left.
    .filter((x) => x.d.visits_remaining === null || x.d.visits_remaining > 0)
    .sort((a, b) => a.d.next_due.getTime() - b.d.next_due.getTime())
    .slice(0, take)
    .map((x) => ({ ...x.row, next_due: x.d.next_due })) as unknown as SchedulePlanRow[];
}

const ESTIMATE_SELECT = {
  id: true,
  estimate_number: true,
  status: true,
  total_amount: true,
  created_at: true,
  // R6 (2026-07-22) — Estimate.customer_id is a direct column again; no lead hop needed.
  customer: { select: { first_name: true, last_name: true, company_name: true, phone: true } },
} as const;

/**
 * The scheduler's fourth schedulable type (scheduleModel.ts EventType 'calendar-entry',
 * user-facing "Event"). Spec §3: entries carry no record number, so `title` is the row's only
 * search handle — no number, description or address field is ever matched.
 */
const CALENDAR_ENTRY_SEARCH_SELECT = {
  id: true,
  title: true,
  start: true,
} as const;

const INVOICE_SELECT = {
  id: true,
  invoice_number: true,
  status: true,
  amount_due: true,
  total_amount: true,
  created_at: true,
  job: {
    select: {
      customer: { select: { first_name: true, last_name: true, company_name: true } },
    },
  },
} as const;

// ─── Search Handler ─────────────────────────────────────

export async function search(req: Request, res: Response) {
  try {
    const q = (req.query.q as string || '').trim();
    const empty = { results: { jobs: [], customers: [], leads: [], estimates: [], invoices: [], servicePlans: [], calendarEntries: [] } };

    if (q.length < 2) {
      res.json(empty);
      return;
    }

    const orgWhere = tenantWhere(req);
    const scope = (req.query.scope as string || '').trim();
    const isScheduleScope = scope === 'schedule';

    // Row-scoping is driven by the SAME grant engine every entity controller uses — never ad-hoc
    // role literals (the leak this fix closes). `scopeWhereForReq` is override-aware (a per-user
    // ALLOW grant yields own-scope) and FAIL-CLOSED: a user with no `read <Subject>` grant gets
    // MATCH_NOTHING, so that entity returns nothing for them. ADMIN / unconditional-read → {}.
    // Each scope is spread as the OUTERMOST base of its entity's `where`; the search-term `OR`
    // is then composed on top with `addOrFilter` (clobber-safe for a multi-read user's scope OR).
    const [jobScope, leadScope, estScope, invScope, custScope] = await Promise.all([
      scopeWhereForReq(req, 'Job'),
      scopeWhereForReq(req, 'Lead'),
      scopeWhereForReq(req, 'Estimate'),
      scopeWhereForReq(req, 'Invoice'),
      scopeWhereForReq(req, 'Customer'),
    ]);
    const rangeStart = req.query.rangeStart as string | undefined;
    const rangeEnd   = req.query.rangeEnd   as string | undefined;
    const hasDateRange = isScheduleScope && !!rangeStart && !!rangeEnd;
    const rangeStartDate = hasDateRange ? new Date(rangeStart!) : null;
    const rangeEndDate   = hasDateRange ? new Date(rangeEnd!)   : null;
    const words = q.split(/\s+/).filter(Boolean);
    const isMultiWord = words.length > 1;
    const LIMIT = 5;
    const addressOr = [{ address_line1: contains(q) }, { city: contains(q) }];

    // ─── Jobs ───────────────────────────────────────────
    const jobBaseWhere: Record<string, unknown> = { ...orgWhere, ...jobScope };
    addOrFilter(jobBaseWhere, [
      { job_number: contains(q) },
      { customer: { OR: nameFieldsOr(q) } },
      { service_location: { OR: addressOr } },
    ]);
    // Spec B1 (Task 5): this used to admit only UNSCHEDULED/SCHEDULED/IN_PROGRESS, so a job
    // visibly on the schedule board (EN_ROUTE/ON_SITE/COMPLETED/CANCELLED all render there) was
    // unfindable by the board's own search. All seven statuses is every value JobStatus has --
    // a filter that admits everything is noise, so the status filter is removed rather than
    // widened. isScheduleScope still matters for jobOrderBy below.

    // S8 repoint (D14), FINISHED — see the JOB_SELECT comment above.
    const jobOrderBy = isScheduleScope ? { first_visit_start: 'asc' as const } : { created_at: 'desc' as const };
    const jobQueries: ReturnType<typeof safeQuery>[] = [];

    // Tier 1 — in-range jobs (priority slots)
    if (hasDateRange) {
      const inRangeWhere: Record<string, unknown> = { ...jobBaseWhere };
      // S8 repoint (D14): backward-looking — the visit SET, not the (to-be-dropped)
      // `scheduled_start` mirror (the 7,492-row bug this whole slice exists to fix: a COMPLETED
      // job's mirror NULLs once its last live visit leaves the live set (D16), so this range
      // filter has been silently dropping completed work from schedule-scope search results).
      // Composed under AND via `addAndWords` (never assigned onto `where.visits`): jobBaseWhere
      // already carries jobScope's row-scope OR (TECHNICIAN's OWN_JOB is
      // `visits.some.assignees.some.user_id: <self>`) plus the search-term OR from `addOrFilter`
      // above, and a bare `inRangeWhere.visits = ...` here would silently overwrite either — an
      // RBAC bypass for the scope case. Both OR arms of the reference pattern are reachable here
      // (unlike the dashboard's status-narrowed tiles): this file admits every JobStatus (the
      // status filter was deliberately removed, see the comment above), so a CANCELLED job with a
      // cancelled trip in range must still surface (D19 keeps the rows).
      addAndWords(inRangeWhere, [
        {
          OR: [
            { visits: { some: { scheduled_at: { gte: rangeStartDate!, lte: rangeEndDate! }, status: { not: 'CANCELLED' } } } },
            { status: 'CANCELLED' as const, visits: { some: { scheduled_at: { gte: rangeStartDate!, lte: rangeEndDate! } } } },
          ],
        },
      ]);
      jobQueries.push(
        // S8 repoint (D14), FINISHED — see the JOB_SELECT comment above.
        safeQuery(() => prisma.job.findMany({ where: inRangeWhere, take: LIMIT, orderBy: { first_visit_start: 'asc' }, select: JOB_SELECT })),
      );
    }

    // Tier 2 — fallback (any date, fills remaining slots after dedup)
    jobQueries.push(
      safeQuery(() => prisma.job.findMany({ where: jobBaseWhere, take: LIMIT, orderBy: jobOrderBy, select: JOB_SELECT })),
    );
    if (isMultiWord) {
      const splitWhere: Record<string, unknown> = { ...orgWhere, ...jobScope };
      addAndWords(splitWhere, words.map((w) => ({ customer: { OR: nameFieldsOr(w) } })));
      jobQueries.push(
        safeQuery(() => prisma.job.findMany({ where: splitWhere, take: LIMIT, orderBy: jobOrderBy, select: JOB_SELECT })),
      );
    }

    // ─── Customers ──────────────────────────────────────
    // #2041 — Customer IS now a `scopeWhereForReq` resource for a row-scoped SALES read; the
    // ability gate stays first (fail-closed for a strict technician holding no `read Customer`
    // grant at all — an empty custScope union still needs SOMETHING to skip on). Schedule scope
    // never wants customers either.
    const skipCustomers = !req.ability!.can('read', 'Customer' as Subject) || isScheduleScope;
    // custScope is spread FIRST (its own top-level key may be `OR`), then the search terms are
    // composed with `addOrFilter` — the same clobber-safe idiom every other entity in this file
    // already uses for exactly this reason (a bare `OR:` literal here would silently overwrite a
    // multi-read union scope).
    const customerBaseWhere: Record<string, unknown> = { ...orgWhere, ...custScope };
    addOrFilter(customerBaseWhere, [
      ...nameFieldsOr(q),
      { customer_number: contains(q) },
      // #350 — digit-normalized phone match (digits-only query finds a formatted
      // store and vice-versa), mirroring the /api/customers picker search.
      // #460 — also search the phones[] relation (CustomerPhone), where numbers are
      // now stored, so global search doesn't miss phones[]-stored customers.
      ...phoneSearchClauses(q),
      ...phoneRelationSearchClauses(q),
      { email: contains(q) },
      { service_locations: { some: { OR: addressOr } } },
    ]);
    // R1 (blocking) — same in-memory proof re-check `customer.controller.ts::list` applies: the
    // SQL `where` above is the real enforcement, but a mocked-findMany test (and, in theory, a
    // stray future query bypassing this `where`) would still leak a row through. Never trusted
    // silently — see the filter/warn-log pass below.
    const customerSelectWithProof = { ...CUSTOMER_SELECT, ...proofSelectFor(custScope, req.user!.id) };
    const customerQueries = skipCustomers
      ? []
      : [
          safeQuery(() => prisma.customer.findMany({ where: customerBaseWhere, take: LIMIT, orderBy: { created_at: 'desc' }, select: customerSelectWithProof })),
        ];
    if (isMultiWord && !skipCustomers) {
      const custSplitWhere: Record<string, unknown> = { ...orgWhere, ...custScope };
      addAndWords(custSplitWhere, words.map((w) => ({ OR: nameFieldsOr(w) })));
      customerQueries.push(
        safeQuery(() => prisma.customer.findMany({
          where: custSplitWhere,
          take: LIMIT,
          orderBy: { created_at: 'desc' },
          select: customerSelectWithProof,
        })),
      );
    }

    // ─── Leads ──────────────────────────────────────────
    // CONVENTION (first in-controller entitlement read in this codebase; org_features is
    // otherwise only read by auth.controller / auth-user / authenticate / requireFeature).
    // A per-ENTITY entitlement filter belongs here, not on the router:
    //   (a) every lead route is behind requireFeature('leads') (lead.routes.ts:14, minPlan
    //       PRO), so a lead handed to an unentitled org is a guaranteed dead end - the
    //       schedule board it links into can never render the row either;
    //   (b) this is deliberately NOT requireFeature('leads') on search.routes.ts, which
    //       would 402 GLOBAL SEARCH for every Starter org. Only the lead GROUP drops;
    //   (c) it fails CLOSED on a missing org_features, matching requireFeature.ts:28.
    // Copy this shape (skip the query pushes, touch no `where`) for the next entity that
    // needs a per-entity plan filter.
    const skipLeads = !hasFeature(req, 'leads');
    const leadBaseWhere: Record<string, unknown> = { ...orgWhere, ...leadScope };
    addOrFilter(leadBaseWhere, [
      // Leads are identified by their L-number on every surface that prints them (board
      // card, list, detail header), so it has to be a search term - jobs have matched
      // job_number all along, and its absence here is why typing an L-number found nothing.
      { lead_number: contains(q) },
      { service_request: contains(q) },
      { customer: { OR: nameFieldsOr(q) } },
      { service_address_line1: contains(q) },
      { service_city: contains(q) },
    ]);
    // Walkthrough-as-entity redesign, PR-B2 (PR-D2 gap #4): repointed from the raw
    // walkthrough_scheduled_at column onto the Walkthrough relation's own status - "is on
    // the board" is a walkthroughs-relation state, not "the legacy column happens to be
    // non-null" (which dual-write never clears on completion).
    //
    // AND-COMPOSED, never assigned. TECHNICIAN's `read Lead` scope is OWN_WALKTHROUGH, whose only
    // top-level key is `visits` - the same key this filter wants - so `where.visits = ...` deletes
    // the row-scope instead of narrowing it and the handler answers with every crew's leads in the
    // org. Every other entity in this handler composes clobber-safely for exactly this reason.
    if (isScheduleScope) addBoardVisitFilter(leadBaseWhere);

    const leadOrderBy = { created_at: 'desc' as const };
    const leadQueries: ReturnType<typeof safeQuery>[] = [];

    if (!skipLeads) {
      // Tier 1 — in-range walkthroughs (priority slots)
      if (hasDateRange) {
        const inRangeWhere: Record<string, unknown> = { ...leadBaseWhere };
        // Composed for the same reason, and it matters twice over here: this clause narrows the
        // board filter AND sits on top of the caller's scope.
        addAndWords(inRangeWhere, [
          { visits: { some: { status: 'SCHEDULED', scheduled_at: { gte: rangeStartDate!, lte: rangeEndDate! } } } },
        ]);
        leadQueries.push(safeQuery(() => findScheduleLeads(inRangeWhere, LIMIT)));
      }

      // Tier 2 — fallback (any date with walkthrough, fills remaining slots)
      leadQueries.push(
        isScheduleScope
          ? safeQuery(() => findScheduleLeads(leadBaseWhere, LIMIT))
          : safeQuery(() => prisma.lead.findMany({ where: leadBaseWhere, take: LIMIT, orderBy: leadOrderBy, select: LEAD_SELECT })),
      );

      if (isMultiWord) {
        const splitWhere: Record<string, unknown> = { ...orgWhere, ...leadScope };
        addAndWords(splitWhere, words.map((w) => ({ customer: { OR: nameFieldsOr(w) } })));
        if (isScheduleScope) addBoardVisitFilter(splitWhere);
        leadQueries.push(
          isScheduleScope
            ? safeQuery(() => findScheduleLeads(splitWhere, LIMIT))
            : safeQuery(() => prisma.lead.findMany({ where: splitWhere, take: LIMIT, orderBy: leadOrderBy, select: LEAD_SELECT })),
        );
      }
    }

    // ─── Estimates ──────────────────────────────────────
    // Estimate row-scope is grant-driven via `estScope`, exactly like Lead/Job/Invoice. Post-F-004
    // the default SALES `read Estimate` grant is OWN_LEAD-conditioned, so `estScope` already carries
    // the own-lead fragment for SALES (strict technician → MATCH_NOTHING → no estimates; granted
    // tech → own-scope; ADMIN/DISPATCHER → {}). No role literal; the search terms below are composed
    // clobber-safe (addOrFilter / addAndWords) so they can never overwrite the scope.
    const estBaseWhere: Record<string, unknown> = { ...orgWhere, ...estScope };
    addOrFilter(estBaseWhere, [
      { estimate_number: contains(q) },
      { customer: { OR: nameFieldsOr(q) } },
    ]);

    const skipEstimates = isScheduleScope;
    const estQueries = skipEstimates
      ? []
      : [
          safeQuery(() => prisma.estimate.findMany({ where: estBaseWhere, take: LIMIT, orderBy: { created_at: 'desc' }, select: ESTIMATE_SELECT })),
        ];
    if (isMultiWord && !skipEstimates) {
      const splitWhere: Record<string, unknown> = { ...orgWhere, ...estScope };
      addAndWords(splitWhere, words.map((w) => ({ customer: { OR: nameFieldsOr(w) } })));
      estQueries.push(
        safeQuery(() => prisma.estimate.findMany({ where: splitWhere, take: LIMIT, orderBy: { created_at: 'desc' }, select: ESTIMATE_SELECT })),
      );
    }

    // ─── Invoices ────────────────────────────────────────
    // Pure grant-driven scope (matches the invoice LIST controller, which dropped its old
    // SALES/TECHNICIAN literals). `invScope` fail-closes a strict technician (and previously the
    // search invoice branch had NO scoping at all → org-wide totals to everyone — the core leak).
    const invBaseWhere: Record<string, unknown> = { ...orgWhere, ...invScope };
    addOrFilter(invBaseWhere, [
      { invoice_number: contains(q) },
      { job: { customer: { OR: nameFieldsOr(q) } } },
    ]);

    const skipInvoices = isScheduleScope;
    const invQueries = skipInvoices
      ? []
      : [
          safeQuery(() => prisma.invoice.findMany({ where: invBaseWhere, take: LIMIT, orderBy: { created_at: 'desc' }, select: INVOICE_SELECT })),
        ];
    if (isMultiWord && !skipInvoices) {
      const splitWhere: Record<string, unknown> = { ...orgWhere, ...invScope };
      addAndWords(splitWhere, words.map((w) => ({ job: { customer: { OR: nameFieldsOr(w) } } })));
      invQueries.push(
        safeQuery(() => prisma.invoice.findMany({ where: splitWhere, take: LIMIT, orderBy: { created_at: 'desc' }, select: INVOICE_SELECT })),
      );
    }

    // ─── Service plans ───────────────────────────────────
    // The third schedulable type (scheduleModel.ts EventType). Schedule-scope ONLY, the
    // mirror image of the customers/estimates/invoices skips above: this group exists to
    // serve the board's sidebar bucket, and every other surface reaches plans through the
    // Service Plans page. Two gates, both fail-closed and neither on the router (a
    // requireFeature there would 402 global search for every Starter org):
    //   - `read ServicePlan`, matching service-plan.routes.ts's canDo;
    //   - the `service_plans` entitlement (minPlan PRO), matching that router's
    //     requireFeature - the same shape the `leads` skip above established.
    const skipServicePlans =
      !isScheduleScope
      || !req.ability!.can('read', 'ServicePlan' as Subject)
      || !hasFeature(req, 'service_plans');
    const planBaseWhere: Record<string, unknown> = {
      ...orgWhere,
      // Only ACTIVE plans reach the sidebar bucket (service-plan.controller.ts
      // schedulerBucket), so only ACTIVE plans are actionable from a board search hit.
      status: 'ACTIVE',
    };
    addOrFilter(planBaseWhere, [
      { service_plan_number: contains(q) },
      { name: contains(q) },
      { customer: { OR: nameFieldsOr(q) } },
      { service_location: { OR: addressOr } },
    ]);
    const planQueries = skipServicePlans ? [] : [safeQuery(() => findSchedulePlans(planBaseWhere, LIMIT))];

    // ─── Calendar Entries (Slice 09) ─────────────────────
    // Schedule-scope ONLY — Events are a scheduler concept (slice-09's "out of scope" list
    // explicitly excludes the global header search). Gated the same way ServicePlan is above,
    // via `req.ability!.can('read', 'CalendarEntry')`, rather than `scopeWhereForReq`: CalendarEntry
    // visibility is ORG-WIDE by construction (spec §4 — "no private flag"; the default grant,
    // ADMIN + DISPATCHER, carries no condition), so there is no row-scope to express, and adding
    // 'CalendarEntry' to the `ScopeResource` union would force an update to every EXHAUSTIVE
    // Record<ScopeResource, …> keyed on it elsewhere (e.g. notifications/filterByAccess.ts's
    // delegateMap) for a resource with nothing conditional to add. Still fail-closed: no `read
    // CalendarEntry` grant → ability.can() is false → the bucket is skipped → `[]`, and the table
    // is never queried for that caller — never a leak.
    const skipCalendarEntries = !isScheduleScope || !req.ability!.can('read', 'CalendarEntry' as Subject);
    const entryBaseWhere: Record<string, unknown> = { ...orgWhere, title: contains(q) };
    if (hasDateRange) {
      // Same overlap test calendar-entry.controller.ts's `list` uses: an entry is in-window
      // when `start <= rangeEnd AND end >= rangeStart`, so a multi-day entry surfaces in every
      // window it spans, not only the one containing its own start.
      addAndWords(entryBaseWhere, [
        { start: { lte: rangeEndDate! } },
        { end: { gte: rangeStartDate! } },
      ]);
    }
    const entryQueries = skipCalendarEntries
      ? []
      : [safeQuery(() => prisma.calendarEntry.findMany({ where: entryBaseWhere, take: LIMIT, orderBy: { start: 'asc' }, select: CALENDAR_ENTRY_SEARCH_SELECT }))];

    // ─── Run all queries in parallel ────────────────────
    const allQueries = [...jobQueries, ...customerQueries, ...leadQueries, ...estQueries, ...invQueries, ...planQueries, ...entryQueries];
    const allResults = await Promise.all(allQueries);

    // Split results back into entity groups
    let idx = 0;
    const jobResults = allResults.slice(idx, idx += jobQueries.length);
    const customerResults = allResults.slice(idx, idx += customerQueries.length);
    const leadResults = allResults.slice(idx, idx += leadQueries.length);
    const estResults = allResults.slice(idx, idx += estQueries.length);
    const invResults = allResults.slice(idx, idx += invQueries.length);
    const planResults = allResults.slice(idx, idx += planQueries.length);
    const entryResults = allResults.slice(idx, idx += entryQueries.length);

    // Merge and deduplicate
    const jobs = mergeById(jobResults as { id: string }[][], LIMIT);
    // #2041 R1 — drop (and warn-log) any row the SQL scope let through but the in-memory proof
    // check disagrees with; never happens in production, so a drop here is an invariant
    // violation, not a silently shortened result set. Proof keys are stripped either way — they
    // were never part of the wire shape.
    const rawCustomers = mergeById(customerResults as { id: string }[][], LIMIT);
    const customers = rawCustomers
      .filter((c) => {
        const ok = matchesFragment(custScope, c as unknown as Record<string, unknown>);
        if (!ok) {
          logger.warn(`#2041: GET /api/search SQL scope returned customer ${c.id} which failed the in-memory proof re-check — dropped from the response.`);
        }
        return ok;
      })
      .map((c) => stripCustomerProofKeys(c as unknown as Record<string, unknown>));
    const leads = mergeById(leadResults as { id: string }[][], LIMIT);
    const estimates = mergeById(estResults as { id: string }[][], LIMIT);
    const invoices = mergeById(invResults as { id: string }[][], LIMIT);
    const servicePlans = mergeById(planResults as { id: string }[][], LIMIT);
    const calendarEntries = mergeById(entryResults as { id: string }[][], LIMIT);

    // ─── Transform (null-safe) ─────────────────────────
    const results = {
      jobs: (jobs as typeof allResults[0]).map((j: any) => {
        const cust = j.customer;
        const name = cust ? (cust.company_name || `${cust.first_name} ${cust.last_name}`) : '';
        const loc = j.service_location;
        return {
          id: j.id,
          entity_type: 'job' as const,
          title: j.job_number,
          subtitle: name,
          // S8 repoint (D14), FINISHED — see the JOB_SELECT comment above.
          date: j.first_visit_start?.toISOString() ?? null,
          address: loc ? `${loc.address_line1}, ${loc.city}, ${loc.state}` : null,
          phone: cust?.phone ?? null,
          status: j.status,
        };
      }),
      customers: (customers as typeof allResults[0]).map((c: any) => {
        const name = c.company_name || `${c.first_name} ${c.last_name}`;
        const loc = c.service_locations?.[0];
        return {
          id: c.id,
          entity_type: 'customer' as const,
          title: name,
          subtitle: c.email,
          phone: c.phone,
          address: loc ? `${loc.address_line1}, ${loc.city}, ${loc.state}` : null,
        };
      }),
      leads: (leads as typeof allResults[0]).map((l: any) => {
        const cust = l.customer;
        const name = cust ? (cust.company_name || `${cust.first_name} ${cust.last_name}`) : '';
        // Walkthrough-as-entity redesign, PR-B2 (PR-D2 gap #4): sourced from the CURRENT
        // (D15) visit via the relation, not the raw walkthrough_scheduled_at column.
        // On the schedule this is the DATE THE BOARD JUMPS TO, so an unscheduled (REQUESTED)
        // walkthrough must report null rather than falling back to created_at - that fallback
        // would send the calendar to the day the lead was created and highlight nothing.
        const visitAt = currentVisitAt(l);
        return {
          id: l.id,
          entity_type: 'lead' as const,
          // Schedule rows mirror the board card, which is titled by the L-number, exactly
          // as job rows are titled by the J-number.
          title: isScheduleScope ? l.lead_number : (l.service_request || 'No service request'),
          subtitle: name,
          date: isScheduleScope ? visitAt?.toISOString() ?? null : l.created_at?.toISOString() ?? null,
          address: l.service_address_line1
            ? `${l.service_address_line1}, ${l.service_city || ''}, ${l.service_state || ''}`.replace(/, ,/g, ',').replace(/,\s*$/, '')
            : null,
          phone: cust?.phone ?? null,
          status: l.status,
        };
      }),
      estimates: (estimates as typeof allResults[0]).map((e: any) => {
        const cust = e.customer;
        const name = cust ? (cust.company_name || `${cust.first_name} ${cust.last_name}`) : '';
        return {
          id: e.id,
          entity_type: 'estimate' as const,
          title: e.estimate_number,
          subtitle: name,
          date: e.created_at?.toISOString() ?? null,
          status: e.status,
          total: e.total_amount ? Number(e.total_amount) : null,
          phone: cust?.phone ?? null,
        };
      }),
      invoices: (invoices as typeof allResults[0]).map((inv: any) => {
        const cust = inv.job?.customer;
        const name = cust ? (cust.company_name || `${cust.first_name} ${cust.last_name}`) : '';
        return {
          id: inv.id,
          entity_type: 'invoice' as const,
          title: inv.invoice_number,
          subtitle: name,
          date: inv.created_at?.toISOString() ?? null,
          status: inv.status,
          total: inv.total_amount ? Number(inv.total_amount) : null,
          amount_due: inv.amount_due ? Number(inv.amount_due) : null,
        };
      }),
      servicePlans: (servicePlans as typeof allResults[0]).map((p: any) => {
        const cust = p.customer;
        const name = cust ? (cust.company_name || `${cust.first_name} ${cust.last_name}`) : '';
        const loc = p.service_location;
        return {
          id: p.id,
          entity_type: 'service-plan' as const,
          // Titled by its SP-number, like every other schedule row is titled by its number.
          title: p.service_plan_number,
          subtitle: name,
          // The DERIVED next due date, not start_date - it is the day the board should jump
          // to, and the day the sidebar card is telling the dispatcher about.
          date: p.next_due?.toISOString() ?? null,
          address: loc ? `${loc.address_line1}, ${loc.city}, ${loc.state}` : null,
          phone: cust?.phone ?? null,
          status: p.status,
        };
      }),
      calendarEntries: (calendarEntries as typeof allResults[0]).map((e: any) => ({
        id: e.id,
        entity_type: 'calendar-entry' as const,
        // Spec §3 — entries carry no record number, so the row is titled by its own title,
        // unlike every other bucket above (which titles off a J-/L-/SP-number).
        title: e.title,
        // A true instant (search-shared.tsx's formatInstant reads it in the ORG's zone, not
        // the viewer's, exactly like every other bucket's `date`) — never a status, total or
        // address; an Event has none of those (spec §3).
        date: e.start?.toISOString() ?? null,
      })),
    };

    res.json({ results });
  } catch (err) {
    logger.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
}
