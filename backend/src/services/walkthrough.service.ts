/**
 * Walkthrough-as-entity redesign (spec md_files/specs/leads/2026-07-28-walkthrough-as-entity.md,
 * plan md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md).
 *
 * Owns the visit lifecycle that used to live inline in lead.controller.ts: performer replace/
 * validate/conflict-detect (moved here verbatim, now keyed by walkthrough_id instead of lead_id),
 * plus the create-or-update/complete/cancel/unschedule transitions on the Walkthrough row itself,
 * plus D15's "current visit" resolution (reused by updateWalkthrough's write target, the four
 * legacy-shaped SELECT/serialize sites, and the automation merge fields). PR-D2 dropped the 9
 * legacy Lead.walkthrough_* columns and deleted the dual-write helper
 * (`stampLegacyWalkthroughColumns`) that used to mirror every lifecycle write onto them - the
 * Walkthrough table is now the sole source of truth, no bridge left to maintain.
 *
 * The lead's own status is never gated on visit state (a visit action is never refused because
 * of it), but it does FOLLOW the visits: after any write to a lead's visit rows the caller runs
 * `syncLeadWalkthroughStatus` (lead-stage.service.ts), the one place the rule lives. That call
 * needs the lead's current status under a row lock, which this module does not load, so it sits
 * in the controller, in the same transaction as the visit write, not here.
 */
import type { Request } from 'express';
import { Prisma, VisitStatus, JobStatus, type LeadStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { isAssignable } from '../lib/permissions/assignableRoles';
import { resolveAssigneePoolForRequest, isAssigneeSetPermitted, assigneeSetChanged } from '../lib/permissions/assigneePool';
import { deriveJobStatus } from '../lib/job-status';
import { replaceVisitCrew } from './visitCrew';
import { projectVisitLocation, formatVisitOwnLocation, visitLocationSelect, type VisitLocationPatch } from './visitLocation';

// Matches every other lib/service in this codebase (tenantWhere, scopeWhereForReq, etc.) - the
// real Express Request, not a hand-rolled structural stand-in.
type Req = Request;

// ─── D15: "current visit" resolution ───────────────────────────────────────
//
// "Current visit" = the next upcoming live visit; if none upcoming, the most recent visit that
// happened (completed or cancelled). One rule, used by updateWalkthrough's write target, the four
// legacy-shaped SELECT/serialize sites (so their JSON responses keep the OLD flat field names
// while sourcing from the relation), and the automation merge fields/staleness guard/date-anchor.
//
// Multi-visit S1 makes this rule load-bearing for the first time. It used to collapse to "the
// lead's one SCHEDULED row", because at most one non-terminal row could exist per lead by
// construction. That invariant is now LIFTED - a lead can hold several live visits at once - so
// "next upcoming" has to actually order by time rather than pick the only candidate.
//
// Note this resolves ONE visit for the legacy flat response shape. It is a compatibility shim,
// not the multi-visit interface: callers that want every visit read the `visits` relation (or
// GET /api/leads/:id/visits) instead.

export type WalkthroughSnapshotRow = {
  id: string;
  /**
   * D13 - creation-order number, the one the customer's email names. Never renumbered.
   *
   * Optional on the TYPE, always present in `walkthroughSnapshotSelect`: a few narrower
   * selects (the automation context's, and older fixtures) build this shape by hand and do
   * not need the number, and making it required there would be churn for no behaviour.
   */
  visit_seq?: number | null;
  status: VisitStatus;
  scheduled_at: Date | null;
  duration_minutes: number | null;
  completed_at: Date | null;
  notes: string | null;
  cancelled_at: Date | null;
  cancelled_reason: string | null;
  cancelled_by: string | null;
  customer_email_sent_at: Date | null;
  created_at: Date;
  canceller?: { id: string; first_name: string; last_name: string } | null;
  /**
   * Where the trip is happening (visit-location spec). Optional on the TYPE and absent from
   * `walkthroughSnapshotSelect`, for the same reason `visit_seq` is optional: the lead selects
   * spread `visitLocationSelect` alongside it and the narrower ones (estimate/job-nested, search)
   * do not. Both `projectVisitLocation` and `locationLabelOf` distinguish "not selected"
   * (undefined) from "no location, i.e. the service address" (null) rather than guessing.
   */
  location_id?: string | null;
  location_address_line1?: string | null;
  location_address_line2?: string | null;
  location_city?: string | null;
  location_state?: string | null;
  location_zip?: string | null;
  /**
   * The location ROW the pointer points at (slice 6). Optional for the same reason the columns
   * are, and selected wherever they are: without it `formatVisitOwnLocation` has only an id, and a
   * showroom booking reads as "no difference" - a card that looks exactly like the common case and
   * is wrong. Never shipped to the wire; it is followed here and collapsed to one resolved line.
   */
  location?: { name: string; address_line1: string | null; city: string | null; state: string | null } | null;
};

/**
 * The Prisma `select` shape for a lead's `walkthroughs` relation wherever a controller needs
 * D15's "current visit" resolution to source a legacy-shaped JSON response (lead.controller.ts's
 * leadListSelect/leadDetailSelect, estimate/job's lead-nested selects, search's LEAD_SELECT).
 * ONE shared shape so every one of those SELECT sites stays in sync with
 * `WalkthroughSnapshotRow`/`resolveCurrentWalkthrough`.
 */
export const walkthroughSnapshotSelect = {
  id: true,
  // D13 - the customer-facing number. It rides in their email subject, so the lead's own
  // history has to be able to name the same trip the customer was told about (MV-LEAD-13).
  visit_seq: true,
  status: true,
  scheduled_at: true,
  duration_minutes: true,
  completed_at: true,
  notes: true,
  cancelled_at: true,
  cancelled_reason: true,
  cancelled_by: true,
  customer_email_sent_at: true,
  created_at: true,
  canceller: { select: { id: true, first_name: true, last_name: true } },
} as const;

/**
 * Repoints a lead (or lead-nested) object's legacy walkthrough_* fields onto its `walkthroughs`
 * relation (selected via `walkthroughSnapshotSelect`), in place of the raw legacy columns -
 * SOURCED from the relation while KEEPING the response field NAMES exactly as they are today,
 * so the frontend needs zero changes. A no-op when `walkthroughs` was not part of the select at
 * all (the `in` check, not a falsy check, so an empty array still projects to "no current
 * visit" rather than being skipped) - callers whose select genuinely never touched the relation
 * are left alone rather than having null keys forced onto them.
 *
 * The performer set is renamed on the same principle. A Prisma relation name IS the JSON key, so
 * S1 renaming `Lead.walkthrough_performers` to `visit_assignees` silently changed the API's
 * public shape and every frontend reader - lead hero, walkthrough tab, the board's crew, the
 * copilot handler - started getting `undefined` (#1637). The model keeps the new name; the
 * response keeps the old one, which is the whole point of this projection.
 */
export function projectLeadWalkthroughFields<
  T extends { visits?: WalkthroughSnapshotRow[]; visit_assignees?: unknown },
>(
  lead: T,
  opts: { full: boolean },
): Omit<T, 'visits' | 'visit_assignees'> {
  // Independent of the `visits` rename below: a select may carry one relation and not the other,
  // and the early return for untouched callers must not swallow the performers.
  const withPerformers = ((): T => {
    if (!('visit_assignees' in (lead as object))) return lead;
    const { visit_assignees, ...rest } = lead;
    return { ...rest, walkthrough_performers: visit_assignees } as unknown as T;
  })();

  type Out = Omit<T, 'visits' | 'visit_assignees'>;
  if (!('visits' in (withPerformers as object))) return withPerformers as unknown as Out;
  const { visits, ...rest } = withPerformers;
  return { ...rest, ...projectLegacyWalkthroughFields(visits, opts) } as unknown as Out;
}

/**
 * The LIST shape of a lead's walkthrough (lead list + CSV export): `projectLeadWalkthroughFields`
 * with `full: false`, resolved over the lead's NON-CANCELLED visits only (visits slice 05).
 *
 * The list carries no `walkthrough_cancelled_at` (that key is detail-only), so every list reader -
 * the leads list's Walkthrough column, the scheduler's walkthrough cards and bucket, the export -
 * reads a non-null `walkthrough_scheduled_at` as "booked". Over ALL visits,
 * `resolveCurrentWalkthrough` falls back to the latest completed OR CANCELLED trip, so a lead
 * marked lost (which cancels its walkthrough) listed its called-off trip's time as its date. Here
 * a lead whose trips were all called off lists no walkthrough, and one whose last trip was called
 * off after an earlier one happened lists the one that happened. The crew is resolved over the
 * same set, so it keeps describing the same trip the date does.
 *
 * The DETAIL keeps the cancelled trip: it ships `walkthrough_cancelled_at` beside the date, which
 * is what lets the lead page show "Cancelled" and seed a re-booking from it.
 */
export function projectLeadListWalkthroughFields<
  T extends { visits?: WalkthroughSnapshotRow[]; visit_assignees?: unknown },
>(lead: T): Omit<T, 'visits' | 'visit_assignees'> {
  const withoutCancelled = 'visits' in (lead as object)
    ? { ...lead, visits: (lead.visits ?? []).filter((v) => v.status !== 'CANCELLED') }
    : lead;
  return projectLeadWalkthroughFields(projectLeadVisitCrew(withoutCancelled), { full: false });
}

/**
 * The lead's walkthrough visits as the scheduler board draws them (visits-and-task-categories
 * slice 03): ONE entry per non-cancelled trip, each with its own time, crew and place, so the board
 * can give every trip its own card - "Visit 1 of 2" on the 28th with one performer, "Visit 2 of 2"
 * on the 30th with another.
 *
 * The flat `walkthrough_*` projection above answers "which ONE trip describes this lead" and keeps
 * doing so for the leads list, the export and the customer page. It cannot feed a per-trip board:
 * resolving to the earliest live visit hid the second trip of a week entirely, and a past trip
 * nobody completed kept hiding every later one.
 *
 * Every non-cancelled trip, not only the ones inside the requested window: the window decides WHICH
 * LEADS the list returns, and "Visit 2 of 3" needs the trips outside it to count to three. The board
 * places each card by its own time, so an out-of-window trip is simply not drawn this week - the job
 * list's `visits` travel the same way. COMPLETED trips stay, because a finished walkthrough stays on
 * the board in its own week. `scheduled_end` falls back to the start plus `duration_minutes` for a
 * row written before #1699 gave lead visits an end of their own.
 */
export type BoardWalkthroughVisitRow = WalkthroughSnapshotRow & {
  scheduled_end?: Date | null;
  is_all_day?: boolean | null;
  assignees?: unknown[] | null;
};

export function projectBoardWalkthroughVisits(visits: BoardWalkthroughVisitRow[] | undefined) {
  return (visits ?? [])
    .filter((v) => v.status !== 'CANCELLED')
    .map((v) => ({
      id: v.id,
      visit_seq: v.visit_seq ?? null,
      status: v.status,
      scheduled_at: v.scheduled_at,
      scheduled_end:
        v.scheduled_end
        ?? (v.scheduled_at ? new Date(v.scheduled_at.getTime() + (v.duration_minutes ?? 60) * 60_000) : null),
      is_all_day: v.is_all_day ?? false,
      ...locationLabelOf(v, 'location_label'),
      assignees: v.assignees ?? [],
    }));
}

// The live-visit rule moved to lib/visit-status.ts in S4 so lib/job-status.ts can read it without
// the service and the D12 derivation importing each other. Re-exported here unchanged: every
// existing importer still reads it off this module, and there is still exactly one list.
export { LIVE_VISIT_STATUSES, isLiveVisit } from '../lib/visit-status';
import { LIVE_VISIT_STATUSES, isLiveVisit } from '../lib/visit-status';

/**
 * D15's rule, applied to an already-fetched list of a parent's visits (any order).
 *
 * Ordering by scheduled_at is what changed in S1: with several live visits the first match in
 * array order is an arbitrary one, so this picks the EARLIEST upcoming trip - the one the hero
 * and the legacy flat fields should describe. A live visit with no time yet sorts last among
 * live ones rather than winning by accident.
 */
export function resolveCurrentWalkthrough<T extends WalkthroughSnapshotRow>(visits: T[]): T | null {
  const live = visits.filter(isLiveVisit);
  if (live.length > 0) {
    return live.reduce((earliest, v) => {
      if (v.scheduled_at === null) return earliest;
      if (earliest.scheduled_at === null) return v;
      return v.scheduled_at.getTime() < earliest.scheduled_at.getTime() ? v : earliest;
    });
  }

  const happened = visits.filter((w) => w.status === 'COMPLETED' || w.status === 'CANCELLED');
  if (happened.length === 0) return null;

  return happened.reduce((latest, w) => {
    const wTime = (w.completed_at ?? w.cancelled_at ?? w.created_at).getTime();
    const latestTime = (latest.completed_at ?? latest.cancelled_at ?? latest.created_at).getTime();
    return wTime > latestTime ? w : latest;
  });
}

/**
 * The walkthrough the customer page's Leads tab shows for a lead (visits-and-task-categories
 * slice 05). ONE server rule, served on the lead list as `next_walkthrough`, so the tab no longer
 * downloads every visit of the customer to work it out:
 *
 *   1. the next upcoming walkthrough: live and not ended yet (measured on its end, falling back to
 *      its start, so a trip under way still counts) - the earliest such trip;
 *   2. else the most recent past one, whichever trip happened last, an overdue uncompleted booking
 *      included, because "all past" means the salesperson wants the latest site visit;
 *   3. else null (no walkthrough, only untimed ones, or every one was called off).
 *
 * A cancelled walkthrough is never the date: marking a lead lost cancels its trip, and a lost lead
 * must not read as booked. Two trips at one instant resolve to the lower visit number.
 *
 * NOT the leads LIST page's rule. The flat `walkthrough_scheduled_at` (projectLeadListWalkthroughFields)
 * keeps D15's earliest live trip, overdue included; the two can differ when an overdue trip and a
 * later one both exist, and which one the list should show is a logged product call.
 */
export function resolveCustomerTabWalkthrough<
  T extends { status: VisitStatus; scheduled_at: Date | null; scheduled_end?: Date | null; visit_seq?: number | null },
>(visits: T[], now: Date = new Date()): T | null {
  // Timed, not called off, in visit-number order so a tie keeps the lower number.
  const timed = visits
    .filter((v) => v.status !== 'CANCELLED' && v.scheduled_at != null)
    .sort((a, b) => (a.visit_seq ?? 0) - (b.visit_seq ?? 0));
  const startMs = (v: T) => v.scheduled_at!.getTime();
  const upcoming = timed.filter((v) => isLiveVisit(v) && (v.scheduled_end ?? v.scheduled_at!).getTime() > now.getTime());
  if (upcoming.length > 0) return upcoming.reduce((best, v) => (startMs(v) < startMs(best) ? v : best));
  if (timed.length === 0) return null;
  return timed.reduce((best, v) => (startMs(v) > startMs(best) ? v : best));
}

/** `resolveCustomerTabWalkthrough` as the lead list serves it: the chosen trip's own window, or null. */
export function projectCustomerTabWalkthrough(visits: BoardWalkthroughVisitRow[] | undefined) {
  const trip = resolveCustomerTabWalkthrough(visits ?? []);
  if (!trip) return null;
  return {
    visit_id: trip.id,
    scheduled_at: trip.scheduled_at,
    scheduled_end: trip.scheduled_end ?? null,
    is_all_day: trip.is_all_day ?? false,
  };
}

/**
 * Projects the resolved current visit onto the legacy FLAT field NAMES (walkthrough_scheduled_at,
 * etc.) for JSON-response byte-compatibility while the frontend still reads the old Lead-column
 * shape (PR-C2/PR-D2 cut it over). `full: false` (list responses) omits the detail-only keys
 * (notes, cancellation detail, customer-email flag) that list selects never carried either.
 *
 * Deliberately does NOT just echo the raw column values dual-write already stamped on Lead -
 * dual-write intentionally preserves the OLD incoherence bug byte-for-byte (rescheduling never
 * cleared walkthrough_completed_at), and multiple visits make the raw columns mix data across
 * visits. Sourcing from the resolved CURRENT visit here is what actually fixes both.
 */
/**
 * Multi-visit S8 (D6): the lead's walkthrough crew, projected onto the `visit_assignees` key
 * that the lead selects have always carried.
 *
 * That key is INTERNAL, not the wire key. projectLeadWalkthroughFields renames it to
 * `walkthrough_performers` immediately after this runs (#1637/#1642), which is what every
 * frontend reader consumes. Calling it a wire key here would be the same stale-comment trap S6
 * hit, so it is named for what it is: the intermediate this function produces.
 *
 * ── ONE VISIT'S CREW, NOT A UNION ACROSS ALL OF THEM (#1952, and the 403 dead end) ──────────
 *
 * S8 flat-mapped `visits[].assignees` with no status filter, so the key answered "everyone who
 * was ever on any trip for this lead". Every reader of it, without exception, is describing ONE
 * visit - the same visit `projectLegacyWalkthroughFields` resolves the flat `walkthrough_*`
 * fields from:
 *
 *   - the lead card's "Scheduled for {walkthrough_scheduled_at} with {crew}" / "Completed
 *     {walkthrough_completed_at} by {crew}" (LeadDetailPage.tsx);
 *   - the walkthrough tab's Starts/Ends/Performer summary and its "Completed on X by Y" banner;
 *   - the scheduler board's walkthrough event, whose start IS `walkthrough_scheduled_at` and
 *     whose crew-swap posts to the LIVE visit (eventAdapters.walkthroughToEvent).
 *
 * A union made all three lie. A lead with two trips crewed by the same person rendered "with
 * Mike Turner, Mike Turner" (#1952) - `visit_assignees` is `@@unique([visit_id, user_id])`, so
 * the only way a name could repeat was by crossing visits - and a lead whose only visits were
 * CANCELLED reported a crew for a visit that no longer exists, which is what dead-ended the
 * walkthrough form: it seeded the Performers field from the cancelled trip's technician, locked
 * it, and the save came back 403 because `findActiveWalkthrough` (live visits only) sees nobody.
 *
 * So the crew is sourced from `resolveCurrentWalkthrough` - the SAME resolution the flat fields
 * use, hence always the same visit they describe. When it resolves to a LIVE visit it is by
 * construction the earliest live one, i.e. the exact row `findActiveWalkthrough` hands
 * `validatePerformers` as `currentPerformerIds`; when it resolves to a finished trip the crew is
 * that trip's, which is what "Completed by" needs and what the form must NOT treat as staffing.
 * The consumer distinguishes those two by the flat fields it already reads.
 *
 * A no-op when `visits` was not part of the select (the `in` check, matching
 * projectLegacyWalkthroughFields' own guard, so "selected but empty" still projects []).
 */
export function projectLeadVisitCrew<T extends Record<string, unknown>>(lead: T): T {
  if (!('visits' in lead)) return lead;
  const visits = lead.visits as Array<WalkthroughSnapshotRow & { assignees?: unknown[] | null }> | null | undefined;
  const current = resolveCurrentWalkthrough(visits ?? []);
  return { ...lead, visit_assignees: current?.assignees ?? [] };
}

/**
 * The `location_label` key for one visit - or NO KEY AT ALL when the caller's select never asked
 * about the location (slice 6).
 *
 * `null` is the statement "this trip is at the parent's service address", which is what makes the
 * card render exactly as it does today. A response is not entitled to make that statement about
 * columns it never read, so the absent-select case omits the key instead of guessing - the same
 * distinction `projectVisitLocation` already draws for `walkthrough_location`.
 *
 * THE DISCRIMINATOR IS THE `location` RELATION, not `location_id`, because the relation is the
 * fact this projection needs and `location_id` is not: a select carrying the six columns without
 * the relation can see that a visit points SOMEWHERE and still cannot say where, so it would
 * resolve a showroom booking to `null` - "at the service address" - which is a wrong answer
 * wearing the common case's clothes. `projectVisitLocation` keys on `location_id` instead, and
 * rightly: it seeds a booking FORM, which posts the columns back and never needs the name. The two
 * keys still appear and disappear together in practice, because `visitLocationSelect` is one
 * indivisible spread - but each now guards on the fact it actually consumes.
 *
 * A RESOLVED STRING, not the six columns. The columns are what a booking FORM needs, because a form
 * posts them back; a card needs the rendered answer, and re-rendering it on the client would put a
 * second copy of "name, then address, in this order, unless it is blank" behind the surfaces the
 * email is supposed to agree with. `formatVisitOwnLocation` is the one `formatVisitLocation` is
 * defined in terms of, so the card's string and the email's string cannot be different strings.
 */
function locationLabelOf(
  visit: WalkthroughSnapshotRow | null | undefined,
  key: 'walkthrough_location_label' | 'location_label',
): Record<string, string | null> {
  if (!visit || !('location' in visit)) return {};
  return { [key]: formatVisitOwnLocation(visit) };
}

export function projectLegacyWalkthroughFields(
  visits: WalkthroughSnapshotRow[] | undefined,
  opts: { full: boolean },
): Record<string, unknown> {
  const list = visits ?? [];
  const current = resolveCurrentWalkthrough(list);
  const base = {
    walkthrough_scheduled_at: current?.scheduled_at ?? null,
    walkthrough_completed_at: current?.status === 'COMPLETED' ? current.completed_at : null,
    walkthrough_duration_minutes: current?.duration_minutes ?? null,
    // Where the current trip is, ALREADY RESOLVED (slice 6) - see `locationLabelOf`. In `base`
    // rather than in the full-only block below, because the scheduler board reads a walkthrough
    // off the lead LIST: a detail-only label would leave the board's own card and its detail
    // dialog unable to say a meeting is at the showroom.
    ...locationLabelOf(current, 'walkthrough_location_label'),
  };
  if (!opts.full) return base;
  return {
    ...base,
    // Where the current visit is happening, in the three-state shape the booking form seeds its
    // "where" control from - `null` means the service address, absent means this caller's select
    // never asked for the columns (so saying "service address" would be a guess, not a fact).
    ...(() => {
      const location = projectVisitLocation(current);
      return location === undefined ? {} : { walkthrough_location: location };
    })(),
    walkthrough_notes: current?.notes ?? null,
    walkthrough_cancelled_at: current?.status === 'CANCELLED' ? current.cancelled_at : null,
    walkthrough_cancelled_reason: current?.status === 'CANCELLED' ? current.cancelled_reason : null,
    walkthrough_cancelled_by: current?.cancelled_by ?? null,
    walkthrough_canceller: current?.canceller ?? null,
    walkthrough_customer_email_sent_at: current?.customer_email_sent_at ?? null,
    // The lead's status (Walkthrough Scheduled / Walkthrough Completed) summarises ALL its visits
    // in one word, so the lead detail page cannot read "how many visits, and what happened on
    // the earlier ones" from lead.status; this list carries that. Full mode only (list selects
    // have never carried per-visit detail, same reasoning as walkthrough_notes above) -
    // newest-first so callers can render it directly.
    walkthrough_count: list.length,
    walkthrough_history: [...list]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((w) => ({
        id: w.id,
        // Without this the lead surface had no number to render at all, and the only
        // endpoint that returns one - GET /api/leads/:id/visits - has no frontend caller.
        // The job surface honours D13/D19 here; the lead surface silently did not.
        visit_seq: w.visit_seq ?? null,
        // The OTHER trips say where they are too (slice 6). Same key, same resolution, same
        // omitted-when-unselected rule as the flat field above - one shape, read three ways.
        ...locationLabelOf(w, 'location_label'),
        status: w.status,
        scheduled_at: w.scheduled_at,
        duration_minutes: w.duration_minutes,
        completed_at: w.completed_at,
        cancelled_at: w.cancelled_at,
        cancelled_reason: w.cancelled_reason,
        created_at: w.created_at,
      })),
  };
}

// ─── D8/D9: send-time instrumentation ──────────────────────────────────────

export type WalkthroughCompletionSnapshot = {
  /** Whether the lead has ever had a COMPLETED visit. Original `hasCompletedWalkthrough` semantics. */
  completed: boolean;
  /** The LATEST completion instant across those visits, or null if none carries one. */
  completedAt: Date | null;
};

/**
 * The lead's walkthrough-completion state AT THIS INSTANT - silent instrumentation recorded on an
 * estimate's SENT timeline event (see estimate.controller.ts's send()/markSent()), replacing the
 * removed require_walkthrough_before_send enforcement gate. Not a gate itself: `null` (a
 * lead-less, customer-anchored estimate) is trivially not completed - there is no lead to visit.
 *
 * `completedAt` is the LATEST completion across the lead's COMPLETED visits, not the first. The
 * business question it feeds is "how long did the salesperson take to send the estimate once the
 * walkthrough was done", and on a multi-visit lead the walkthrough is done when the LAST trip is.
 *
 * Recording it on the timeline event makes it a SNAPSHOT, which is the whole point: a visit booked
 * and completed AFTER this send re-anchors the live value, but can never rewrite what this
 * estimate was measured against. The live projection deliberately does not have this property -
 * projectLegacyWalkthroughFields reports the CURRENT visit, so its walkthrough_completed_at falls
 * back to null the moment a later visit is booked. Correct for a page hero, useless as a clock.
 *
 * Two queries rather than one aggregate, deliberately: `visit.aggregate` is already the visit_seq
 * allocator's call, and the shared test double defaults it to `{ _max: { visit_seq: null } }` - a
 * second caller reading different keys off that same mock gets undefined and throws.
 *
 * `completed` keeps its original meaning exactly (ANY COMPLETED visit), so it stays true for a
 * legacy row completed before `completed_at` was populated, where `completedAt` is null.
 */
export async function walkthroughCompletionSnapshot(
  req: Req,
  leadId: string | null,
): Promise<WalkthroughCompletionSnapshot> {
  if (!leadId) return { completed: false, completedAt: null };
  // Org-scoped like every other visit read in this file. Both of today's callers
  // resolve the lead id from an estimate they already fetched with a tenant
  // predicate, so this is not closing a reachable leak - it moves the guarantee
  // out of the callers and into the signature, where a future caller inherits it
  // instead of having to know about it.
  const where = { ...tenantWhere(req), lead_id: leadId, status: 'COMPLETED' as const };
  const [count, latest] = await Promise.all([
    prisma.visit.count({ where }),
    // `completed_at: { not: null }` is load-bearing: Postgres sorts NULLs FIRST on a DESC order,
    // so without it a COMPLETED row carrying no instant would win and mask the real latest one.
    prisma.visit.findFirst({
      where: { ...where, completed_at: { not: null } },
      orderBy: { completed_at: 'desc' },
      select: { completed_at: true },
    }),
  ]);
  return { completed: count > 0, completedAt: latest?.completed_at ?? null };
}

// ─── Performer helpers (moved from lead.controller.ts, now keyed by walkthrough_id) ──
//
// Mirror the job-crew side (replaceJobCrew / validateCrew / detectCrewConflicts).
// Walkthrough performers are MULTI with REPLACE semantics; lead owner is SINGLE.

// `phone` rides along because this shape becomes an automation event payload's
// RecipientUser (services/automations/executors.ts) - a text step addressed to the
// performer just assigned needs their number, and there is no second lookup later.
export type PerformerMember = { id: string; email: string | null; first_name: string; last_name: string; phone: string | null };

/**
 * Slice 2's refusal, in the user's own words - the PRD writes the same sentence on the form
 * (story 5: "a short line of text under the field telling me I can only put myself on a
 * walkthrough"), so the API and the UI say the same thing.
 *
 * NOT exported, and deliberately not shared with the job-crew twin: `assigneePool.ts` exports
 * no error strings because each validator keeps its own wording ("do not merge the twins").
 */
const PERFORMER_SELF_ONLY = 'You can only put yourself on a walkthrough.';

/**
 * Two questions, in this order: WHOSE NAMES may this requester put on a walkthrough, and is each
 * of those names an ACTIVE in-org user whose role `isAssignable`. Returns the resolved performers
 * on success, or a {status, error} the three lead doors forward verbatim.
 *
 * ── THE POOL CHECK IS FIRST, AND IT IS A 403 ────────────────────────────────────────────────
 *
 * Scoped assignee pool, slice 2 (plan: md_files/plans/permissions/2026-08-31-assignee-pool/).
 * A requester without `assign User` may name only themselves. Naming somebody else is a
 * PERMISSION failure, not a malformed request, so it is 403 - every pre-existing refusal below
 * keeps the 400 it has always had.
 *
 * It runs BEFORE the per-member loop for two reasons. The loop is a database round-trip per id,
 * and a request that was never allowed to name those people should not pay for it. More
 * importantly, resolving the ids first would answer 400 "not found" for an id that names nobody
 * and 403 for one that does - handing a role that deliberately cannot read the staff directory
 * (PRD story 27) a "does this person work here" oracle. First step, one answer.
 *
 * The rule is read off the ability via `resolveAssigneePoolForRequest`, NEVER off `req.user.role`
 * - that is what makes a custom role holding the grant, and a per-user allow/deny override, work
 * with no code here. See assigneePool.ts's decision record.
 *
 * An EMPTY performer list is permitted for everyone. Ran's recorded call, and a deliberate
 * divergence from the task validator, which does reject an empty roster: "they cannot take
 * themselves off" is enforced by the form (slice 4), not by a minimum-length check here.
 *
 * ── `currentPerformerIds`: THE UNCHANGED-SET ESCAPE ─────────────────────────────────────────
 *
 * The set already on the visit being mutated, when there IS one. Supplying it exempts a
 * RESTATEMENT from the pool rule, the same escape task.controller.ts's `sameSet` gives a task
 * update: without it a sales rep who reschedules a visit a dispatcher crewed gets a 403 for
 * touching the time, because the form resends the roster it was shown on every save.
 *
 * OMITTING IT IS THE STRICT PATH, on purpose. A create-shaped door has no current set and must
 * get the full check; a door that simply forgets to pass one is refused rather than opened. Any
 * change - adding a name, removing one, or wiping the list - is a change and is checked, because
 * the rule is about the RESULTING set. The escape covers the pool rule only: the per-member
 * eligibility loop still runs on an unchanged restatement, so "unchanged" is never a way to
 * re-persist somebody who has since been deactivated.
 */
export async function validatePerformers(
  req: Req,
  performerIds: string[],
  currentPerformerIds?: string[],
): Promise<{ ok: true; users: PerformerMember[] } | { ok: false; status: number; error: string }> {
  const isRestatement =
    currentPerformerIds !== undefined && !assigneeSetChanged(currentPerformerIds, performerIds);
  if (!isRestatement) {
    const pool = resolveAssigneePoolForRequest(req, 'walkthroughPerformer');
    if (!isAssigneeSetPermitted(pool, performerIds)) {
      return { ok: false, status: 403, error: PERFORMER_SELF_ONLY };
    }
  }

  const users: PerformerMember[] = [];
  for (const userId of performerIds) {
    const u = await prisma.user.findUnique({
      where: { id: userId, ...tenantWhere(req) },
      select: { id: true, role: true, is_active: true, email: true, first_name: true, last_name: true, phone: true },
    });
    if (!u) return { ok: false, status: 400, error: 'Performer not found or inactive' };
    if (!u.is_active) return { ok: false, status: 400, error: 'Performer not found or inactive' };
    if (!isAssignable(u.role)) return { ok: false, status: 400, error: 'This user is not eligible to perform walkthroughs' };
    users.push({ id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, phone: u.phone });
  }
  return { ok: true, users };
}

export type WalkthroughConflict =
  | { type: 'job'; id: string; number: string; start: Date | null; end: Date | null }
  | { type: 'walkthrough'; id: string; number: string; start: Date | null; end: Date };

/**
 * Per-member conflict detection. For each candidate performer, finds overlapping
 * SCHEDULED/IN_PROGRESS jobs (crew M2M) and other SCHEDULED walkthroughs (performer M2M, any
 * lead) in the same window. Returns conflicts in the EXACT 409 entry shape used by the job side
 * (type/id/number/start/end) - kept byte-stable for the FE retry path. `id`/`number` on a
 * walkthrough conflict are the LEAD's (not the Walkthrough row's) - that is what the FE retry
 * path and the /leads/{id} link expect.
 */
export async function detectPerformerConflicts(
  req: Req,
  opts: { leadId: string; userIds: string[]; schedStart: Date; schedEnd: Date },
): Promise<WalkthroughConflict[]> {
  if (opts.userIds.length === 0) return [];
  const { schedStart, schedEnd } = opts;
  const tw = tenantWhere(req);

  // Repointed off the Job.scheduled_start/scheduled_end MIRROR onto the job's own VISITS relation
  // - the identical repoint job.controller.ts's detectCrewConflicts got in multi-visit S6 (D14):
  // the mirror only ever holds the job's NEXT upcoming visit, so a clash against a job's SECOND or
  // THIRD visit - at a window the mirror does not hold - went unwarned when the conflict was
  // checked from the LEAD side (booking a walkthrough against a technician already busy on that
  // later trip). The crew predicate and the window predicate stay two SEPARATE `visits: { some }`
  // clauses under AND, same reason as the job-side twin: merging them into one `some` would ask
  // "is there a trip that BOTH overlaps AND carries this person", which stops warning about a
  // person on the job's OTHER trip - the deliberate over-warn Q7 ratified on the job side.
  const jobVisitOverlap = {
    status: { not: 'CANCELLED' as const },
    scheduled_at: { lt: schedEnd },
    scheduled_end: { gt: schedStart },
  };

  const [jobConflicts, walkthroughConflicts] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...tw,
        // S8 (D6): crew lives on the trips, so the conflict predicate traverses them.
        AND: [{ visits: { some: { assignees: { some: { user_id: { in: opts.userIds } } } } } }],
        // Spec B1 (Task 5): mirrors job.controller.ts's detectCrewConflicts identical fix --
        // a technician physically on site still occupies the slot. Kept byte-identical to that
        // twin through S4's enum narrowing: widening one without the other reintroduces exactly
        // the drift these two comments exist to stop.
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        visits: { some: jobVisitOverlap },
      },
      // The SAME predicate on the nested read, so each overlapping trip maps to exactly one
      // conflict entry - a job whose other trips sit elsewhere contributes only the clashing one.
      select: {
        id: true,
        job_number: true,
        visits: { where: jobVisitOverlap, select: { id: true, scheduled_at: true, scheduled_end: true } },
      },
    }),
    prisma.visit.findMany({
      where: {
        ...tw,
        // Multi-visit S3: `lead_id: { not: null }` is the guard, and `NOT: { lead_id }` is the
        // exclusion of THIS lead's own visits. They used to be one predicate, `{ not: opts.leadId }`,
        // which does not do the first job: Prisma keeps NULL rows in a `not` on a nullable column,
        // so once S3 gave job visits crew a job-parented row (D5: no lead) matched `assignees.some`
        // and reached the lead dereference below. Splitting them says what is meant without
        // depending on the reader knowing that NULL semantics, and matches the guard the job-side
        // twin and dashboard.controller.ts carry. The two detectors were written as twins and must
        // stay twins.
        lead_id: { not: null },
        NOT: { lead_id: opts.leadId },
        assignees: { some: { user_id: { in: opts.userIds } } },
        status: 'SCHEDULED',
        scheduled_at: { not: null },
      },
      select: { id: true, scheduled_at: true, duration_minutes: true, lead: { select: { id: true, lead_number: true } } },
    }),
  ]);

  // The `wt.lead` narrowing is real rather than a `!` assertion: the `lead_id: { not: null }`
  // predicate above is what guarantees a lead, so dropping that predicate must break the TYPECHECK
  // instead of throwing at runtime on whichever org double-books first.
  const wtConflicts = walkthroughConflicts.filter(
    (wt): wt is typeof wt & { scheduled_at: Date; lead: { id: string; lead_number: string } } => {
      if (!wt.scheduled_at || !wt.lead) return false;
      const wtStart = new Date(wt.scheduled_at);
      const wtEnd = new Date(wtStart.getTime() + (wt.duration_minutes || 60) * 60_000);
      return wtStart < schedEnd && wtEnd > schedStart;
    },
  );

  return [
    // The entry keeps the JOB's id/number and the VISIT's own times - one entry per overlapping
    // trip, so a job whose other trips sit elsewhere contributes only the clashing one. Byte-stable
    // shape: WalkthroughConflict is unchanged, only WHICH window feeds it changed.
    ...jobConflicts.flatMap((j) =>
      j.visits.map((v) => ({ type: 'job' as const, id: j.id, number: j.job_number, start: v.scheduled_at, end: v.scheduled_end as Date })),
    ),
    ...wtConflicts.map((w) => ({
      type: 'walkthrough' as const, id: w.lead.id, number: w.lead.lead_number,
      start: w.scheduled_at,
      end: new Date(new Date(w.scheduled_at).getTime() + (w.duration_minutes || 60) * 60_000),
    })),
  ];
}

// ─── Visit lifecycle ──────────────────────────────────────────────────────

/**
 * Every visit on a lead, newest-scheduled last. The multi-visit read: callers that need the whole
 * set (the lead page, the visits collection endpoint, the seq allocator) use this rather than
 * resolving down to one row.
 */
export async function listLeadVisits(req: Req, leadId: string) {
  return prisma.visit.findMany({
    where: { ...tenantWhere(req), lead_id: leadId },
    include: { assignees: { select: { user_id: true } } },
    orderBy: [{ scheduled_at: 'asc' }, { created_at: 'asc' }],
  });
}

/**
 * D13: the next per-parent visit number.
 *
 * Taken from MAX(visit_seq), not from a row count: a number that has been in a customer's inbox
 * must never be handed to a different trip, and a count would reuse one as soon as a row was
 * removed. Cancelled visits therefore still consume their number.
 *
 * An aggregate rather than "load every visit and reduce" so booking a visit does not read the
 * whole history to learn one integer.
 *
 * TAKES THE TRANSACTION CLIENT, exactly as nextVisitSeqForJob does, and the symmetry is
 * load-bearing rather than tidiness. This previously read the module-level `prisma` from inside
 * the caller's `$transaction` callback. Under DB_TENANT_GUARD=on that global is the tenant-guard
 * Proxy, and each of its model ops opens a transaction of its own - so the aggregate asked the
 * pool for a SECOND connection while the outer interactive transaction still held the first. A
 * roomy pool hides it; the deployed staging service does not, and every lead-walkthrough booking
 * returned 500 with Prisma P2024 after the pool timeout. Reading through `tx` needs no second
 * connection, and as a side effect the MAX now happens INSIDE the transaction, closing the race
 * the job twin's docstring predicted.
 */
export async function nextVisitSeqForLead(
  tx: Prisma.TransactionClient,
  orgId: string,
  leadId: string,
): Promise<number> {
  const agg = await tx.visit.aggregate({
    where: { organization_id: orgId, lead_id: leadId },
    _max: { visit_seq: true },
  });
  return (agg._max.visit_seq ?? 0) + 1;
}

/**
 * The visit the legacy single-visit endpoints act on: the EARLIEST still-coming trip.
 *
 * Was "the ONE non-terminal row" - the invariant S1 lifts. It stays a findFirst rather than
 * taking the head of a list so it does not share a query surface with detectPerformerConflicts'
 * unrelated cross-lead findMany; ordering, not uniqueness, is what picks the row now.
 */
export async function findActiveWalkthrough(req: Req, leadId: string) {
  return prisma.visit.findFirst({
    where: {
      ...tenantWhere(req),
      lead_id: leadId,
      status: { in: [...LIVE_VISIT_STATUSES] },
    },
    include: { assignees: { select: { user_id: true } } },
    orderBy: [{ scheduled_at: 'asc' }, { created_at: 'asc' }],
  });
}

/**
 * ONE named walkthrough visit of ONE lead, in the caller's organization - the target of the
 * per-visit lead doors (visits-and-task-categories slice 03). Scoped to all three at once, so a
 * visit id from another lead or another organization is simply not found. Same `include` as
 * findActiveWalkthrough, because the doors read the two interchangeably.
 */
export async function findLeadVisit(req: Req, leadId: string, visitId: string) {
  return prisma.visit.findFirst({
    where: { ...tenantWhere(req), id: visitId, lead_id: leadId },
    include: { assignees: { select: { user_id: true } } },
  });
}

/** Back-compat alias - complete/cancel act on the same earliest live visit. */
export async function findScheduledWalkthrough(req: Req, leadId: string) {
  return findActiveWalkthrough(req, leadId);
}

/**
 * Whether the lead has any still-coming visit. D22a: this is what replaces the retired REQUESTED
 * bucket - "needs scheduling" is the ABSENCE of a live visit, not the presence of a placeholder
 * row. Expressed as a Prisma `where` fragment so the three read sites can compose it.
 */
export const NO_LIVE_VISIT_WHERE = {
  visits: { none: { status: { in: [...LIVE_VISIT_STATUSES] } } },
};

/**
 * D15's current-visit resolution, fetched fresh for a single lead - used by updateWalkthrough
 * (the notes/duration-only save endpoint) to find the row it should actually write to.
 */
export async function findCurrentWalkthroughForLead(req: Req, leadId: string) {
  const visits = await prisma.visit.findMany({
    where: { ...tenantWhere(req), lead_id: leadId },
  });
  return resolveCurrentWalkthrough(visits);
}

/**
 * Book a NEW visit on a lead - the multi-visit create. Distinct from rescheduling: this never
 * touches an existing row, which is exactly what lets a lead hold several live visits at once
 * (user stories 6 and 7).
 */
export async function createLeadVisit(
  tx: Prisma.TransactionClient,
  opts: {
    leadId: string;
    orgId: string;
    visitSeq: number;
    scheduledAt: Date;
    scheduledEnd: Date;
    durationMinutes: number;
    notes?: string | null;
    stampCustomerEmailSentAt: boolean;
    /**
     * Where this trip is happening, already tenant-checked and reduced to columns by
     * `resolveVisitLocationWrite` (visit-location spec, slice 3). The same option, the same type
     * and the same "omit it, or pass `{}`, and no location column is written at all" contract as
     * `scheduleActiveWalkthrough`'s below - which on a CREATE leaves all six at their NULL
     * default: the parent's service address, which is what every visit booked before this feature
     * means.
     *
     * A lead holding a SECOND visit somewhere else is the case the whole feature exists for - the
     * first meeting at the showroom, the measure at the customer's house, a design review back at
     * the showroom. This writer never touches an existing row, so one trip's answer cannot
     * disturb another's; that is a property of the create, not something the caller arranges.
     */
    locationData?: VisitLocationPatch;
  },
) {
  return tx.visit.create({
    data: {
      organization_id: opts.orgId,
      lead_id: opts.leadId,
      purpose: 'WALKTHROUGH',
      visit_seq: opts.visitSeq,
      status: 'SCHEDULED',
      scheduled_at: opts.scheduledAt,
      // #1699: both ends of the span, from the one the caller already computed. The job-shaped
      // writers set the pair together; these two lead-shaped ones were the only writes that did
      // not, so a lead visit was born with a null end no reader could trust.
      scheduled_end: opts.scheduledEnd,
      duration_minutes: opts.durationMinutes,
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
      ...(opts.locationData ?? {}),
    },
  });
}

/**
 * (Re)schedule the lead's active visit into SCHEDULED. Reuses the live row when there is one - a
 * genuine reschedule of the SAME visit - and otherwise books a fresh one.
 *
 * This is the LEGACY single-visit path, kept so the existing scheduling dialog keeps working
 * unchanged while S1 lands. Booking an ADDITIONAL visit alongside a live one goes through
 * createLeadVisit / POST /api/leads/:id/visits instead: this function still collapses onto one
 * row by design, because that is what "reschedule the appointment" means.
 */
export async function scheduleActiveWalkthrough(
  tx: Prisma.TransactionClient,
  opts: {
    leadId: string;
    orgId: string;
    activeWalkthroughId: string | null;
    wasAlreadyScheduled: boolean;
    visitSeq: number;
    scheduledAt: Date;
    scheduledEnd: Date;
    durationMinutes: number;
    stampCustomerEmailSentAt: boolean;
    /**
     * The visit-location columns to write, already tenant-checked and reduced by
     * `resolveVisitLocationWrite`. Omit it, or pass `{}`, to leave the stored location exactly as
     * it is - which is what a caller who said nothing about where means, and is why this is a
     * patch object rather than six named parameters that would each have to carry their own
     * "unchanged" sentinel.
     */
    locationData?: VisitLocationPatch;
  },
) {
  const data = {
    status: 'SCHEDULED' as VisitStatus,
    scheduled_at: opts.scheduledAt,
    // #1699: the end MUST move with the start. Writing only `scheduled_at` left the row holding
    // the end of its previous slot, so a walkthrough moved later finished before it began.
    scheduled_end: opts.scheduledEnd,
    duration_minutes: opts.durationMinutes,
    ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
    ...(opts.locationData ?? {}),
  };
  const walkthrough = opts.activeWalkthroughId
    ? await tx.visit.update({ where: { id: opts.activeWalkthroughId }, data })
    : await tx.visit.create({
        data: {
          organization_id: opts.orgId,
          lead_id: opts.leadId,
          purpose: 'WALKTHROUGH',
          visit_seq: opts.visitSeq,
          ...data,
        },
      });
  return { walkthrough, isReschedule: opts.wasAlreadyScheduled };
}

/**
 * Unschedule a visit.
 *
 * D16/D19/D22a: with REQUESTED retired there is no "booked but timeless" state to fall back to -
 * an unscheduled trip IS a cancelled row, and "this lead needs a visit" is now expressed by the
 * lead having no live visit at all. The row is kept (never deleted) because the customer may hold
 * an email naming it, and because deleting it would make the first-time-fix / callback data
 * (SRVW-41) unrecoverable.
 *
 * Guarded, and for the same reason `completeWalkthroughRow` below is - read that writer for the
 * full argument. The unschedule door resolves its target with a read that runs BEFORE the
 * transaction opens, so two requests arriving together both reach this writer holding the same
 * snapshot. Unconditional, an unschedule that lost the row to a concurrent COMPLETION overwrote
 * it back to CANCELLED and the completion was simply gone - the same clobber the completion race
 * turned out to be, one door along. Returns whether THIS call was the one that landed it.
 */
export async function unscheduleWalkthroughRow(
  tx: Prisma.TransactionClient,
  walkthroughId: string,
): Promise<boolean> {
  const { count } = await tx.visit.updateMany({
    where: { id: walkthroughId, status: { in: [...LIVE_VISIT_STATUSES] } },
    data: { status: 'CANCELLED', cancelled_at: new Date(), cancelled_reason: 'Unscheduled' },
  });
  return count > 0;
}

/**
 * Live → COMPLETED, and only from live. Returns whether THIS call was the one that completed it.
 *
 * The status test lives in the WHERE rather than in a preceding read, for exactly the reason
 * `stampLeadClock` puts its null test there. The completion door resolves its target with a read
 * that runs BEFORE the transaction opens, so two requests arriving together both see the same live
 * visit and both reach this writer. Unconditional, the second one overwrote the first one's
 * `completed_at` — which is how a lead ended up carrying a first-completion stamp that matched
 * neither of its own visits, the lead clock having survived (it is written through a guarded
 * statement) while the visit row did not.
 *
 * Postgres settles it: under READ COMMITTED the second writer blocks on the row lock, then
 * re-evaluates this WHERE against the row the winner committed, whose status is no longer live —
 * so it matches nothing and truthfully reports `count: 0` instead of clobbering. `updateMany`
 * rather than `update` because `update` turns a no-match into a P2025 throw rather than a fact the
 * caller can act on — the same trade `stampLeadClock` documents.
 *
 * The accept-set is LIVE_VISIT_STATUSES, matching `findActiveWalkthrough`'s own filter, so this
 * rejects exactly the rows that read would never have handed over and no others. Guarding on
 * SCHEDULED alone would silently narrow the endpoint, which today completes any live visit.
 */
export async function completeWalkthroughRow(
  tx: Prisma.TransactionClient,
  walkthroughId: string,
  completedAt: Date,
): Promise<boolean> {
  const { count } = await tx.visit.updateMany({
    where: { id: walkthroughId, status: { in: [...LIVE_VISIT_STATUSES] } },
    data: { status: 'COMPLETED', completed_at: completedAt },
  });
  return count > 0;
}

/**
 * Live → CANCELLED (scheduled_at kept as history - D15 needs it to resolve "the most recent visit
 * that happened").
 *
 * D22a: this no longer mints a replacement placeholder row. It used to create a fresh REQUESTED
 * visit so the lead reappeared in the scheduler bucket; with REQUESTED retired, the lead
 * reappears there simply by having no live visit, and minting a row would be actively wrong under
 * multi-visit - cancelling ONE of three trips must not put the lead in "needs scheduling" while
 * two are still booked (D24/user story 24).
 *
 * `rebooked` stays in the return shape as null so callers keep compiling; it is removed when the
 * legacy endpoints are retired.
 *
 * Guarded like its two siblings - see `completeWalkthroughRow` for the argument. `cancelled` comes
 * back null when this call was NOT the one that landed the transition, which is the caller's cue
 * that somebody else took the visit out of the accept-set in between.
 *
 * `acceptStatuses` is a REQUIRED opt rather than a constant because the two doors that call this
 * do not screen the same set, and a guard that does not match its own door's pre-check either
 * narrows the endpoint or fails to close the race:
 *   - the lead door reads through `findScheduledWalkthrough`, which returns live visits only, so
 *     it passes LIVE_VISIT_STATUSES;
 *   - the job door reads the visit with no status filter and refuses only an already-CANCELLED
 *     one, so it passes live + COMPLETED, which is that refusal written as an accept-set.
 * Making it explicit at the call site is what stops a third caller inheriting the wrong screen.
 */
export async function cancelWalkthroughRow(
  tx: Prisma.TransactionClient,
  // S4: `leadId` is optional because the job side calls this same writer, and a job visit has no
  // lead. It was already unused by the body - a job-side twin would only be a second copy of the
  // cancel shape for the two parents to drift apart on (D3).
  opts: {
    walkthroughId: string;
    leadId?: string;
    orgId: string;
    cancelledAt: Date;
    reason: string;
    cancelledBy: string;
    acceptStatuses: readonly VisitStatus[];
  },
) {
  const { count } = await tx.visit.updateMany({
    where: { id: opts.walkthroughId, status: { in: [...opts.acceptStatuses] } },
    data: {
      status: 'CANCELLED',
      cancelled_at: opts.cancelledAt,
      cancelled_reason: opts.reason,
      cancelled_by: opts.cancelledBy,
    },
  });
  if (count === 0) return { cancelled: null, rebooked: null };
  // `data: {}` - the guarded write above already made every change and holds this row's lock for
  // the rest of the transaction, so this second statement is a re-read for the response shape and
  // nothing more. Same idiom the lead doors use on `tx.lead`. It exists because the job door
  // answers with the cancelled row itself, and `updateMany` returns a count rather than a row.
  const cancelled = await tx.visit.update({ where: { id: opts.walkthroughId }, data: {} });
  const rebooked = null;
  return { cancelled, rebooked };
}

/**
 * What a cancelled trip records as its reason when the LEAD itself left the pipeline. One wording
 * per exit, shared by the two doors that reach it: the dedicated mark-lost and cancel endpoints
 * (the lead status menu closes a lead through those same endpoints).
 */
export const LEAD_EXIT_WALKTHROUGH_REASON = {
  LOST: 'Lead marked as lost',
  CANCELLED: 'Lead cancelled',
} as const satisfies Partial<Record<LeadStatus, string>>;

/**
 * Cancel EVERY live walkthrough visit of a lead as a side effect of the lead itself leaving the
 * pipeline (LOST / CANCELLED) - whether through mark-lost or cancel. Returns how many trips it cancelled.
 *
 * Every live trip, not the earliest one: since slice 03 a lead can hold several booked trips, and
 * a trip left booked for a lost lead stays on the board and on the crew's day. Finished and
 * already-cancelled trips are history and are not touched. No replacement row is booked: the lead
 * is terminal, so it must not reappear in the "needs scheduling" bucket.
 *
 * Guarded by the live set in the WHERE, like its siblings, so a trip another request completed or
 * cancelled first keeps that outcome. It runs in the caller's transaction, which also moves the
 * lead's status, and is scoped to the organization as well as the lead.
 */
export async function cancelLiveWalkthroughsOnLeadExit(
  tx: Prisma.TransactionClient,
  opts: { leadId: string; orgId: string; cancelledAt: Date; reason: string; cancelledBy: string },
): Promise<number> {
  const { count } = await tx.visit.updateMany({
    where: { organization_id: opts.orgId, lead_id: opts.leadId, status: { in: [...LIVE_VISIT_STATUSES] } },
    data: {
      status: 'CANCELLED',
      cancelled_at: opts.cancelledAt,
      cancelled_reason: opts.reason,
      cancelled_by: opts.cancelledBy,
    },
  });
  return count;
}

// ─── Job visits (multi-visit S2) ───────────────────────────────────────────
//
// D3: a visit is a visit - only the parent and the purpose differ. These live in the SAME module
// as the lead helpers above rather than in a job-side fork, so the LIVE_VISIT_STATUSES rule and
// the [{scheduled_at:'asc'},{created_at:'asc'}] ordering cannot drift between the two parents.
// That drift is exactly what #1551 spent a PR undoing.

/**
 * Book a NEW visit on a job. Sets `job_id` and leaves `lead_id` unset: D5's
 * `visits_exactly_one_parent` CHECK is a raw DB constraint Prisma cannot see, so a copy of the
 * lead helper that also stamped lead_id would typecheck, pass every mocked test, and fail only
 * against a real Postgres.
 *
 * Writes `duration_minutes` derived from the span alongside `scheduled_end`: every lead-shaped
 * reader (projectLegacyWalkthroughFields, detectPerformerConflicts) still reasons in minutes.
 * That is two representations of one fact in one row - every S2 write path sets them together.
 */
export async function createJobVisit(
  tx: Prisma.TransactionClient,
  opts: {
    jobId: string;
    orgId: string;
    visitSeq: number;
    scheduledAt: Date;
    scheduledEnd: Date;
    isAllDay: boolean;
    notes?: string | null;
    /**
     * S7: byte-parallel to createLeadVisit's option of the same name. ONE write, so the row that
     * gets emailed about and the row that records having been emailed about cannot be two writes
     * that disagree - that split is #1522's shape.
     */
    stampCustomerEmailSentAt?: boolean;
    /**
     * Where this trip is happening, already tenant-checked and reduced to columns by
     * `resolveVisitLocationWrite` (visit-location spec, slice 4). The same option, the same type
     * and the same "omit it, or pass `{}`, and no location column is written at all" contract as
     * `createLeadVisit`'s above - a visit is a visit (D3), so the job writer takes the patch on
     * exactly the terms the lead writer does rather than growing a job-shaped variant.
     *
     * OMITTED IS THE CASE THAT CARRIES `/assign`. `syncJobWindowOntoVisits` first-books through
     * this writer and passes nothing, so all six columns stay at their NULL default and the trip
     * is at the job's service address - which is what every job visit created before this feature
     * means, and is the behaviour that path deliberately keeps.
     */
    locationData?: VisitLocationPatch;
  },
) {
  return tx.visit.create({
    data: {
      organization_id: opts.orgId,
      job_id: opts.jobId,
      purpose: 'WORK',
      visit_seq: opts.visitSeq,
      status: 'SCHEDULED',
      scheduled_at: opts.scheduledAt,
      scheduled_end: opts.scheduledEnd,
      is_all_day: opts.isAllDay,
      duration_minutes: Math.max(
        1,
        Math.round((opts.scheduledEnd.getTime() - opts.scheduledAt.getTime()) / 60_000),
      ),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
      ...(opts.locationData ?? {}),
    },
  });
}

/**
 * D13: the next visit number on a job, taken from MAX(visit_seq) rather than from a row count -
 * a number that has been in a customer's inbox must never be handed to a different trip, so a
 * cancelled visit still consumes its number.
 *
 * Takes the TRANSACTION client, so the MAX read happens inside the transaction. That narrows the
 * race but does not close it - the read takes no lock, so two concurrent transactions can still
 * see the same MAX. Since 20260821120000 there IS a unique index on (job_id, visit_seq) and on
 * (lead_id, visit_seq) to catch it when they do, and `withVisitSeqRetry` re-runs the whole
 * transaction so the loser re-reads rather than 500ing (section 4.4 of the multi-visit QA run).
 * The lead-side twin was the outstanding follow-up this docstring used to name; it now takes `tx`
 * on the same terms, after the global-client read turned out to deadlock on the pool under
 * DB_TENANT_GUARD as well as race.
 *
 * Tenant-scoped by orgId (the caller has already tenant-probed the job).
 */
/**
 * The two unique indexes that mean "another writer took the number we just allocated".
 *
 * Prisma reports P2002 with `meta.target` as either the index NAME or the column list,
 * depending on the connector and the error path, so both spellings are matched.
 */
export const VISIT_SEQ_UNIQUE_TARGETS = [
  'visits_job_id_visit_seq_key',
  'visits_lead_id_visit_seq_key',
  'job_id_visit_seq',
  'lead_id_visit_seq',
] as const;

function isVisitSeqCollision(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  const asText = Array.isArray(target) ? target.join('_') : String(target ?? '');
  return VISIT_SEQ_UNIQUE_TARGETS.some((t) => asText.includes(t) || t.includes(asText));
}

/**
 * Re-run a visit-creating unit of work when two writers allocate the same visit_seq.
 *
 * The number comes from MAX(visit_seq) + 1 with no lock, so concurrent creates can read the
 * same MAX. The unique index added in 20260821120000 turns that from a silent duplicate -
 * two trips sharing one number, in two customer emails that cannot be told apart - into a
 * failed write; this turns the failed write back into a correct number.
 *
 * `fn` must be the WHOLE transaction, not just the insert: a unique violation aborts the
 * transaction it happens in, so the MAX has to be re-read inside a fresh one. Bounded at
 * three attempts, because a collision that survives that many re-reads is not contention
 * any more and should surface rather than spin.
 *
 * Only the visit_seq indexes are retried. Any other P2002 is a real error, and retrying it
 * would repeat the same failure while hiding its cause.
 */
export async function withVisitSeqRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isVisitSeqCollision(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function nextVisitSeqForJob(
  tx: Prisma.TransactionClient,
  orgId: string,
  jobId: string,
): Promise<number> {
  const agg = await tx.visit.aggregate({
    where: { organization_id: orgId, job_id: jobId },
    _max: { visit_seq: true },
  });
  return (agg._max.visit_seq ?? 0) + 1;
}

/**
 * The next UPCOMING trip: the row Job.scheduled_start mirrors (D14 (ii)).
 *
 * "Upcoming" is measured on the visit's END, not its start, so a visit under way right now still
 * wins - handing the mirror to next week's trip while the crew is on site would drop today's job
 * off today's board. Among upcoming visits the earliest wins; a live visit with no time yet sorts
 * last and never wins; creation order breaks a tie - the same
 * [{scheduled_at:'asc'},{created_at:'asc'}] ordering listLeadVisits and findActiveWalkthrough
 * apply, so the lead side and the job side cannot disagree about what "next" means.
 *
 * When every live visit has already elapsed the EARLIEST is returned rather than nothing. S2's
 * reason for that ("a job visit has no way to leave SCHEDULED, so an untouched job accumulates
 * elapsed live rows") is VOID from S4 - cancel and complete exist now, and an elapsed visit can be
 * taken off the live set deliberately. The behaviour survives on a different, re-derived reason: a
 * past visit that is STILL LIVE is one nobody has actioned - the crew did not complete it and the
 * office did not cancel it - and that trip should keep holding the board slot until somebody says
 * what happened to it. Returning null there would blank Job.scheduled_start (still the column the
 * board, search and reports read until S6) and quietly drop the job off the board instead.
 *
 * The genuinely empty case is different and is D16's collapse, handled by syncJobFromVisits: no
 * LIVE visit at all means the schedule columns go to null and the job derives UNSCHEDULED.
 */
export function resolveNextJobVisit<
  T extends { scheduled_at: Date | null; scheduled_end?: Date | null; created_at: Date },
>(visits: T[], now: Date = new Date()): T | null {
  // `!= null` (not `!== null`): a real Prisma select never OMITS a selected column, so
  // `scheduled_at` is always an explicit `Date` or an explicit `null` in production - but the
  // mocked-Prisma seam this codebase's whole backend test suite runs on can and does build a
  // fixture that leaves the key `undefined`, which `!== null` lets through only to crash two
  // lines down on `.getTime()`. Found via job-schedule-projection.test.ts (S8, A5) exercising this
  // function through a new caller (resolveJobScheduleWindow) that a sloppier fixture could reach.
  const timed = visits.filter((v) => v.scheduled_at != null);
  if (timed.length === 0) return null;
  const earliestOf = (rows: T[]) =>
    rows.reduce((earliest, v) => {
      const a = v.scheduled_at!.getTime();
      const b = earliest.scheduled_at!.getTime();
      if (a !== b) return a < b ? v : earliest;
      return v.created_at.getTime() < earliest.created_at.getTime() ? v : earliest;
    });
  const upcoming = timed.filter(
    (v) => (v.scheduled_end ?? v.scheduled_at!).getTime() > now.getTime(),
  );
  return earliestOf(upcoming.length > 0 ? upcoming : timed);
}

/**
 * The trip the crew is ON RIGHT NOW, for the job-level verbs - a different question from the one
 * resolveNextJobVisit answers.
 *
 * The board mirror wants the next UPCOMING trip. A technician pressing Start on the job page wants
 * the trip in front of them, and those two part company the moment a job runs late: with visit 1
 * booked 09:00-11:30 today and visit 2 next week, a press at 11:45 finds visit 1 no longer
 * "upcoming" and resolveNextJobVisit hands back NEXT WEEK's trip. Stamping that one leaves today's
 * visit SCHEDULED for ever, shows next week as already under way, and dates the per-visit history
 * behind the customer's "Visit 2" email a week early.
 *
 * So a visit that has BEGUN wins over one that has not: begun by the clock (its start time has
 * passed) or begun by hand (its status has left SCHEDULED, which is the crew who arrived early).
 * The LATEST such row wins, because a job holding two elapsed unactioned trips is one whose crew
 * is at the more recent of them. With nothing begun this defers to resolveNextJobVisit, so the
 * ordinary case - every trip still ahead - is the earliest upcoming, exactly as the mirror sees it.
 *
 * Untimed rows are ignored here for the same reason resolveNextJobVisit ignores them: a visit with
 * no time cannot be the one anybody is standing at.
 */
export function resolveCurrentJobVisit<
  T extends {
    status: VisitStatus;
    scheduled_at: Date | null;
    scheduled_end?: Date | null;
    created_at: Date;
  },
>(visits: T[], now: Date = new Date()): T | null {
  const begun = visits.filter(
    (v) => v.scheduled_at !== null && (v.status !== 'SCHEDULED' || v.scheduled_at.getTime() <= now.getTime()),
  );
  if (begun.length === 0) return resolveNextJobVisit(visits, now);
  return begun.reduce((latest, v) => {
    const a = v.scheduled_at!.getTime();
    const b = latest.scheduled_at!.getTime();
    if (a !== b) return a > b ? v : latest;
    return v.created_at.getTime() > latest.created_at.getTime() ? v : latest;
  });
}

/**
 * Multi-visit S4 (D7): move ONE visit along its lifecycle and stamp the matching column.
 *
 * One writer for every door - the per-visit routes and the job-level start/arrive/en-route verbs
 * that now act on the job's current visit both come through here, so a job-level copy and a
 * visit-level copy cannot drift. That drift is what #1551 spent a PR undoing.
 *
 * Writes the status, the stamp and the LATER stamps this move rewinds - no visit_seq (D13 - the
 * number never moves), no schedule columns (a lifecycle write is not a reschedule), no parent.
 *
 * The rewind is job-milestones.ts's rule applied to the row that now owns these columns, and it is
 * load-bearing rather than tidy: D12 reads IN_PROGRESS off `started_at`, so a backward move that
 * left the later stamp in place would be a no-op the moment anything re-derived - the job would
 * keep answering IN_PROGRESS, and the next syncJobFromVisits would mirror the surviving stamp back
 * onto Job.started_at, silently undoing the dispatcher's correction. There is no route that can
 * un-stamp a visit, so nothing else could ever put it right. An earlier draft of this writer left
 * the later stamps alone on the grounds that "on a visit a later stamp is history": history is
 * exactly what a backward move on the lifecycle bar is asked to rewrite, and the job row's own
 * twin (milestoneClears) has always rewritten it.
 */
export const VISIT_MILESTONE_COLUMNS = {
  en_route: { status: 'EN_ROUTE', column: 'en_route_at', clears: ['on_site_at', 'started_at', 'completed_at'] },
  on_site: { status: 'ON_SITE', column: 'on_site_at', clears: ['started_at', 'completed_at'] },
  started: { status: 'IN_PROGRESS', column: 'started_at', clears: ['completed_at'] },
  completed: { status: 'COMPLETED', column: 'completed_at', clears: [] },
} as const;

export type VisitMilestone = keyof typeof VISIT_MILESTONE_COLUMNS;

/** Lifecycle order. A tap stamps everything unstamped BEFORE it and rewinds everything AFTER it. */
const VISIT_MILESTONE_ORDER: readonly VisitMilestone[] = ['en_route', 'on_site', 'started', 'completed'];

/**
 * The skipped marker for a milestone, or null for the one milestone that cannot be skipped:
 * completed is last in lifecycle order, so nothing can be tapped past it.
 */
function skippedMarkerOf(milestone: VisitMilestone): 'en_route_skipped' | 'on_site_skipped' | 'started_skipped' | null {
  switch (milestone) {
    case 'en_route': return 'en_route_skipped';
    case 'on_site': return 'on_site_skipped';
    case 'started': return 'started_skipped';
    case 'completed': return null;
  }
}

/** The current milestone state of the visit being moved - the stamp columns the writer reads. */
export type VisitMilestoneState = {
  id: string;
  organization_id: string;
  en_route_at?: Date | null;
  on_site_at?: Date | null;
  started_at?: Date | null;
  completed_at?: Date | null;
};

/**
 * Scheduling-notifications slice 08 ("Skip stamps and the milestone log"): milestones stay stamps
 * that can be skipped, and every stamp leaves a trace.
 *
 * Tapping a milestone while EARLIER ones are unstamped stamps those earlier ones with the SAME
 * instant and marks them skipped, so a forgotten "On the way" tap never blocks "Start work" and a
 * report can exclude the skipped stamp instead of reading zero minutes. The tapped milestone's
 * own marker is cleared: it is a real tap now, whatever it was before. The rewind (everything
 * LATER) clears the columns AND their markers, so a rewound milestone reads "never happened"
 * rather than "skipped".
 *
 * The log is appended in the SAME client as the visit write: one `tapped` row for the tap, one
 * `skipped` row per milestone stamped as skipped, one `reverted` row per LATER milestone that
 * actually held a stamp (a later column already null was not cleared by this tap, so it gets no
 * row). Nothing is ever deleted from it - the stamp columns are the current state, the log is
 * the history behind them, and a rewind rewrites the former by appending to the latter.
 */
export async function stampVisitMilestone(
  tx: Prisma.TransactionClient,
  opts: { visit: VisitMilestoneState; milestone: VisitMilestone; at: Date; actorId: string },
) {
  const { visit, milestone, at, actorId } = opts;
  const { status, column, clears } = VISIT_MILESTONE_COLUMNS[milestone];
  const data: Record<string, unknown> = { status: status as VisitStatus, [column]: at };
  const tappedMarker = skippedMarkerOf(milestone);
  if (tappedMarker) data[tappedMarker] = false;
  const events: { milestone: VisitMilestone; kind: 'tapped' | 'skipped' | 'reverted' }[] = [
    { milestone, kind: 'tapped' },
  ];

  const position = VISIT_MILESTONE_ORDER.indexOf(milestone);
  for (const earlier of VISIT_MILESTONE_ORDER.slice(0, position)) {
    const earlierColumn = VISIT_MILESTONE_COLUMNS[earlier].column;
    if (visit[earlierColumn] != null) continue;
    data[earlierColumn] = at;
    data[skippedMarkerOf(earlier)!] = true;
    events.push({ milestone: earlier, kind: 'skipped' });
  }

  for (const later of clears) {
    data[later] = null;
  }
  for (const later of VISIT_MILESTONE_ORDER.slice(position + 1)) {
    const laterMarker = skippedMarkerOf(later);
    if (laterMarker) data[laterMarker] = false;
    if (visit[VISIT_MILESTONE_COLUMNS[later].column] != null) events.push({ milestone: later, kind: 'reverted' });
  }

  await tx.visitMilestoneLog.createMany({
    data: events.map((e) => ({
      organization_id: visit.organization_id,
      visit_id: visit.id,
      milestone: e.milestone,
      kind: e.kind,
      occurred_at: at,
      actor_id: actorId,
    })),
  });

  return tx.visit.update({ where: { id: visit.id }, data });
}

/**
 * Multi-visit S4 (B9): apply a milestone to the job's CURRENT visit, for the job-level verbs.
 *
 * POST /:id/en-route, /:id/arrive and /:id/start are the door the shipped JobLifecycleBar, the
 * copilot's update_job_status and POST /:id/status all press, and they must keep working
 * unchanged while the truth moves to the visit underneath them. So they resolve the job's current
 * trip - resolveCurrentJobVisit, which is the mirror's rule with one difference: a trip that has
 * already begun beats one that has not yet, so a crew running past their slot stamps the visit
 * they are standing at rather than next week's - and stamp it through the SAME writer the
 * per-visit routes use. A job-level copy and a visit-level copy of this write is the drift #1551
 * spent a PR undoing.
 *
 * Returns null when the job holds no live visit, which is not an error: a job can be started
 * before anyone has booked a trip for it, and the caller falls back to stamping the job row alone.
 *
 * Takes a client rather than requiring a transaction: the three job-level verbs write their
 * timeline event and their job row on the global client today, and wrapping them would silently
 * break every suite that exercises them without wiring $transaction (setup.ts leaves it a bare
 * vi.fn(), so an unwired callback never runs at all).
 */
export async function stampCurrentJobVisitMilestone(
  client: Prisma.TransactionClient,
  opts: { jobId: string; orgId: string; milestone: VisitMilestone; at: Date; actorId: string },
): Promise<string | null> {
  const live = await client.visit.findMany({
    where: {
      organization_id: opts.orgId,
      job_id: opts.jobId,
      status: { in: [...LIVE_VISIT_STATUSES] },
    },
  });
  const current = resolveCurrentJobVisit(live);
  if (!current) return null;
  await stampVisitMilestone(client, { visit: current, milestone: opts.milestone, at: opts.at, actorId: opts.actorId });
  return current.id;
}

/**
 * D14 (ii) + D12 + D16: keep the job row true to its visit set, in the SAME transaction as the
 * visit write that changed it.
 *
 * THREE jobs in one function now, not four - S8 (RATIFIED, A5) dropped the forward-looking
 * schedule mirror (`scheduled_start`/`scheduled_end`/`is_all_day`) from `jobs` entirely. Those
 * three wire keys are served on READ, computed fresh off `job.visits[]` by
 * `lib/job-schedule-projection.ts` (the same "next upcoming live visit" rule this function used to
 * write here) - nothing is written for them any more, by this function or any other:
 *  - the milestone mirror (started_at only, now) is the EARLIEST non-null across the WHOLE set.
 *    S5 repointed the lifecycle bar onto the visit set, so en_route_at/on_site_at had no reader at
 *    all before S8 dropped their JOB-level columns outright; started_at is NOT symmetric and still
 *    feeds deriveJobStatus's urgent-workflow branch, so its write stays;
 *  - the BACKWARD-LOOKING duration span (S8 §4, A2+) - first_visit_start / last_visit_end /
 *    last_visit_completed_at - is MIN/MAX over the NON-CANCELLED set, unconditionally (see
 *    spanStamp below: unlike the milestone mirror, these three have no direct job-level writer to
 *    protect, so "no qualifying visit" is always NULL, not "write nothing");
 *  - Job.status is DERIVED (D12) from the same post-write set.
 *
 * It ALWAYS writes now. S2's version returned early when no live visit remained, with a comment
 * saying D16's collapse "arrives with S4's cancel/complete" - this is that collapse: with no live
 * visit the projection reads NULL (computed on read, nothing to write here for it) and the
 * derivation answers UNSCHEDULED, so a job whose last trip was called off stops sitting inside the
 * board's date-range query.
 *
 * It reads the job's CURRENT status on the TRANSACTION client rather than taking the caller's
 * pre-transaction `existing.status`. A status another writer changed between the two reads would
 * otherwise decide this derivation, and the derivation's whole job is to not fight a human-set
 * COMPLETED or CANCELLED.
 *
 * What it must NEVER do: route through assign() or reuse its data fragment. assign() spreads
 * `...(scheduled_start ? milestoneClears('scheduled') : {})`, so adding visit 3 to an in-flight job
 * would wipe visit 1's arrival and completion timestamps and revive a cancelled job. It also never
 * writes Job.completed_at in either direction - D7 says completing the last visit does not complete
 * the job, and the job-level fact stays explicitly set by complete()/reopen().
 */
export async function syncJobFromVisits(
  tx: Prisma.TransactionClient,
  opts: {
    jobId: string;
    orgId: string;
    /**
     * Set false by a handler that is itself deciding the status - job-level cancel and
     * reopen. Those two write the job row by hand and mean the status they set, so
     * re-deriving here would fight them; but they still need the BACKWARD-LOOKING SPAN
     * (first_visit_start / last_visit_end / last_visit_completed_at, S8 §4) re-derived - those
     * three have no other writer, so a stale pre-write value would survive the very request that
     * cancelled or restored the visit it describes (section 4.2 of the multi-visit QA run named
     * this exact hazard against the now-dropped forward mirror; the span carries the identical
     * risk under a different name).
     */
    deriveStatus?: boolean;
  },
) {
  // The WHOLE set, not just the live subset: D12's derivation needs the completed rows (a job
  // whose only visit just finished is IN_PROGRESS, not UNSCHEDULED), and the milestone mirror
  // reads stamps off rows that have already left the live set.
  const all = await tx.visit.findMany({
    where: { organization_id: opts.orgId, job_id: opts.jobId },
  });

  const job = await tx.job.findUnique({
    where: { id: opts.jobId },
    // started_at joins the select so the mirror below can tell a stamp that came FROM a visit
    // from one the urgent workflow set on the job itself. en_route_at/on_site_at are GONE from
    // `jobs` (S8, RATIFIED) - nothing here reads or writes them at the job level any more; the
    // VISIT's own en_route_at/on_site_at (read a few lines down, off `all`) are untouched.
    select: { status: true, started_at: true },
  });

  // CANCELLED rows are excluded on the same grounds deriveJobStatusFromVisits excludes them:
  // the row is kept as history (D19) and keeps its stamps, so a trip that was started and
  // then called off is not evidence of work in flight.
  const notCalledOff = all.filter((v) => v.status !== 'CANCELLED');

  /**
   * Has ANY trip on this job ever been worked - including one since cancelled, whose stamps
   * are kept as history (D19)?
   *
   * This is what separates the two reasons a live set can carry no start stamp. If a trip
   * WAS worked, the visit set is the authority and the job's columns mirror it, nulls
   * included: that is the dispatcher's backward correction, or a started trip since called
   * off. If NOTHING on this job has ever been worked, the job's own stamp is the only
   * evidence there is - the urgent workflow, where a job is created UNSCHEDULED and started
   * on the spot with no visit at all (story 45) - and booking the return trip must not read
   * "this visit has not started" as "the job has not started".
   */
  const anyVisitWorked = all.some(
    (v) => v.en_route_at != null || v.on_site_at != null || v.started_at != null
      || v.completed_at != null || v.status === 'COMPLETED',
  );

  /**
   * Earliest stamp across the live set, and NULL when the live set has none but some trip
   * was worked.
   *
   * The old version returned {} - "write nothing" - whenever the live set had no stamp,
   * which made these columns write-once: a backward move nulled the VISIT's stamp and the
   * job's copy survived, so D12 kept reading IN_PROGRESS off a job whose trips had all been
   * rewound or called off, and no route existed that could ever put it right (section 4.1).
   */
  // S8 (RATIFIED): only ever called with 'started_at' now - en_route_at/on_site_at are gone from
  // `jobs`. The parameter stays generic-shaped (rather than hard-coding the one column) because
  // `v[column]` still reads off the VISIT row `notCalledOff` holds, which keeps its own
  // en_route_at/on_site_at columns untouched by this drop.
  const mirrorMilestone = (column: 'started_at') => {
    const stamps = notCalledOff
      .map((v) => v[column])
      .filter((d): d is Date => d instanceof Date);
    if (stamps.length > 0) {
      return { [column]: stamps.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b)) };
    }
    if (!anyVisitWorked) return {};
    return { [column]: null };
  };
  const milestones = mirrorMilestone('started_at') as Partial<Record<'started_at', Date | null>>;

  /**
   * A2+ (multi-visit S8 §4, D14(i)): the BACKWARD-LOOKING duration span, over the SAME
   * `notCalledOff` set the milestone mirror above uses - a cancelled trip is not evidence of
   * planned or actual work (D19) here either.
   *
   * Unlike mirrorMilestone, there is no "write nothing" branch: these three columns have no
   * job-level, visit-independent writer to protect the way started_at protects the urgent
   * workflow's direct job-level stamp. first_visit_start / last_visit_end /
   * last_visit_completed_at are ONLY ever a fact about the visit set, so "no qualifying visit"
   * always means an unconditional NULL, on every call - including the one that just cancelled a
   * job's only visit. That is the #1550-class bug mirrorMilestone's own comment describes,
   * avoided here by never having a write-once branch to fall into in the first place.
   */
  const spanStamp = (
    field: 'scheduled_at' | 'scheduled_end' | 'completed_at',
    pick: (a: Date, b: Date) => Date,
  ): Date | null => {
    const stamps = notCalledOff
      .map((v) => v[field])
      .filter((d): d is Date => d instanceof Date);
    return stamps.length > 0 ? stamps.reduce(pick) : null;
  };
  // first_visit_start - MIN(scheduled_at). PLANNED start.
  const firstVisitStart = spanStamp('scheduled_at', (a, b) => (a.getTime() <= b.getTime() ? a : b));
  // last_visit_end - MAX(scheduled_end). PLANNED end - a booked window, not a completion.
  const lastVisitEnd = spanStamp('scheduled_end', (a, b) => (a.getTime() >= b.getTime() ? a : b));
  // last_visit_completed_at - MAX(completed_at). The only ACTUAL stamp of the three; pairs with
  // jobs.started_at (mirrorMilestone('started_at') above), not with first_visit_start.
  const lastVisitCompletedAt = spanStamp('completed_at', (a, b) => (a.getTime() >= b.getTime() ? a : b));

  // Derive off the started_at this write is ABOUT to set, not the one the row still holds.
  // Reading the stale value leaves the status behind its own mirror: the rewind cleared the
  // column and D12 went on answering IN_PROGRESS off the value being cleared in the very
  // same statement.
  const nextStartedAt = 'started_at' in milestones
    ? milestones.started_at ?? null
    : job?.started_at ?? null;
  const derived = job ? deriveJobStatus(job.status, all, nextStartedAt) : undefined;

  await tx.job.update({
    where: { id: opts.jobId },
    data: {
      // S8 (RATIFIED, A5): scheduled_start/scheduled_end/is_all_day are DROPPED from `jobs` -
      // nothing writes them here (or anywhere) any more. The wire keys are served on READ,
      // computed off `job.visits[]` by lib/job-schedule-projection.ts using the identical "next
      // upcoming live visit" rule this function used to apply on WRITE.
      first_visit_start: firstVisitStart,
      last_visit_end: lastVisitEnd,
      last_visit_completed_at: lastVisitCompletedAt,
      ...milestones,
      // Spread only when the derivation actually has an answer. `undefined` means "this job's
      // status is a human-set COMPLETED or CANCELLED, write nothing" - see lib/job-status.ts for
      // why that is not the same as writing the current value back.
      ...(opts.deriveStatus !== false && derived !== undefined ? { status: derived } : {}),
    },
  });
}

/**
 * The other direction of D14's mirror: keep the visit set in step with the ONE window a legacy
 * single-window writer just booked.
 *
 * /assign is that writer - the job page's Assign Technician dialog, the hero tile and the board
 * drag all POST it - and it writes Job.scheduled_start / scheduled_end / is_all_day directly.
 * Those three columns are a CACHE of the visit set from S2 onwards, so a booking that skips the
 * visits leaves the two disagreeing, and the next visit write recomputes the mirror from visits
 * alone and silently deletes the booking. The two entry points sit one click apart on the same
 * page.
 *
 * A job that already holds a live visit is being MOVED, so the next upcoming row is moved with it
 * (D19: same row, same visit_seq - the customer holds an email naming "Visit 1"). A job with no
 * live visit is being booked for the first time and gets one. Repointing /assign at the visit
 * layer wholesale is S6's job; this is the smallest thing that keeps the two representations
 * from contradicting each other in the meantime.
 *
 * Deliberately NOT followed by mirrorNextVisitOntoJob: assign() writes the job row itself, in the
 * same transaction, and re-deriving it here would fight that write.
 */
/**
 * S3: returns the ONE visit this call touched - the row it moved, or the row it created - so
 * /assign can land the crew it was given on exactly that visit and no other. `created` is part of
 * the answer because the two cases are different facts about crew: a trip this request invented has
 * no crew statement of its own and takes the one it was given, while a trip that already existed
 * carries a crew somebody chose per visit, which a job-level statement must not overwrite wholesale.
 * Callers that only wanted the window synced can keep ignoring the value.
 */
export async function syncJobWindowOntoVisits(
  tx: Prisma.TransactionClient,
  opts: { jobId: string; orgId: string; scheduledAt: Date; scheduledEnd: Date; isAllDay: boolean },
) {
  const live = await tx.visit.findMany({
    where: {
      organization_id: opts.orgId,
      job_id: opts.jobId,
      status: { in: [...LIVE_VISIT_STATUSES] },
    },
  });
  const next = resolveNextJobVisit(live);
  if (next) {
    await rescheduleVisitRow(tx, next.id, {
      scheduledAt: opts.scheduledAt,
      scheduledEnd: opts.scheduledEnd,
      isAllDay: opts.isAllDay,
    });
    return { id: next.id, created: false };
  }
  const created = await createJobVisit(tx, {
    jobId: opts.jobId,
    orgId: opts.orgId,
    visitSeq: await nextVisitSeqForJob(tx, opts.orgId, opts.jobId),
    scheduledAt: opts.scheduledAt,
    scheduledEnd: opts.scheduledEnd,
    isAllDay: opts.isAllDay,
  });
  return { id: created.id, created: true };
}

/**
 * Multi-visit S3 (D6, user story 10): land a JOB-level crew statement on ONE visit without letting
 * it fan out.
 *
 * /assign speaks job-level crew, and the Assign dialog seeds that array from `job.assignees` -
 * which from S3 is the UNION across every visit. Restating that array verbatim on the visit the
 * window sync touched writes the finish crew onto the pour trip: "the two techs who pour concrete
 * are not automatically the ones who come back to finish" is the story this exists to keep true,
 * and `JOIN LATERAL ... LIMIT 1` is how the S3 migration keeps the same thing true for the rows it
 * folded. The damage would compound rather than settle - the next Assign press re-seeds from the
 * grown union - and from S4/S7 the per-visit crew decides who may start the visit and who is
 * emailed about it.
 *
 * So the visit takes the CHANGE, not the statement: people the request newly names join the trip it
 * is booking, people it drops leave that trip, and everyone else's membership is left to the
 * per-visit surfaces that actually know. `previousJobCrew` is the union as it stood before this
 * request - the very set the dialog rendered - so the delta is what the dispatcher really did.
 *
 * A visit this request CREATED is the exception, and takes the crew wholesale: it has no crew
 * statement of its own to preserve, so the job-level one is the only information there is. This is
 * the going-forward twin of the migration folding job-level crew onto a job's first visit.
 *
 * Not tenant-filtered on the read, and safe for the same reason replaceVisitCrew is:
 * every caller has already tenant-checked the job before reaching here.
 */
export async function applyJobCrewStatementToVisit(
  tx: Prisma.TransactionClient,
  opts: {
    visitId: string;
    orgId: string;
    isNewVisit: boolean;
    previousJobCrew: string[];
    statedCrew: string[];
  },
): Promise<{ added: string[]; removed: string[] }> {
  if (opts.isNewVisit) {
    return replaceVisitCrew(tx, { visitId: opts.visitId, orgId: opts.orgId, userIds: opts.statedCrew });
  }
  const before = new Set(opts.previousJobCrew);
  const stated = new Set(opts.statedCrew);
  const newlyNamed = [...stated].filter((id) => !before.has(id));
  const dropped = [...before].filter((id) => !stated.has(id));
  if (newlyNamed.length === 0 && dropped.length === 0) return { added: [], removed: [] };

  const current = await tx.visitAssignee.findMany({
    where: { visit_id: opts.visitId },
    select: { user_id: true },
  });
  const next = new Set(current.map((c) => c.user_id));
  for (const id of dropped) next.delete(id);
  for (const id of newlyNamed) next.add(id);
  return replaceVisitCrew(tx, { visitId: opts.visitId, orgId: opts.orgId, userIds: [...next] });
}

/**
 * D19: reschedule is the SAME row with a new time, never a new visit. The customer holds an email
 * referencing "Visit 2", so the row's identity - and its visit_seq - must survive the move.
 * Sits beside the unscheduleWalkthroughRow / completeWalkthroughRow / cancelWalkthroughRow family.
 */
export async function rescheduleVisitRow(
  tx: Prisma.TransactionClient,
  visitId: string,
  opts: {
    scheduledAt: Date;
    scheduledEnd: Date;
    isAllDay?: boolean;
    notes?: string | null;
    /** S7: the FIRST announce of a trip booked silently. Same single-write rule as createJobVisit's. */
    stampCustomerEmailSentAt?: boolean;
    /**
     * The visit-location columns to write, already tenant-checked and reduced by
     * `resolveVisitLocationWrite` (visit-location spec, slice 4).
     *
     * THIS IS THE WRITER WHERE "OMITTED" AND "SIX NULLS" STOP BEING THE SAME THING. Every other
     * caller of `resolveVisitLocationWrite` so far has been a create or an upsert onto a fresh
     * row, where writing nothing and writing six explicit nulls leave the same row behind. This
     * one UPDATES a row that already holds an answer: `{}` leaves a yard booking exactly where it
     * is, and the CLEARED patch really does move it back to the customer's address. A caller that
     * merged a default in here - or that spread `opts.locationData ?? CLEARED` - would send the
     * crew to the wrong place on every plain drag-to-reschedule, which is the single most
     * expensive thing this feature can get wrong.
     *
     * Not merged with `stampCustomerEmailSentAt`'s conditional spread by accident: both are
     * "only when the caller actually said so", which is the rule this whole writer is built on
     * (see `isAllDay` directly below).
     */
    locationData?: VisitLocationPatch;
  },
) {
  return tx.visit.update({
    where: { id: visitId },
    data: {
      scheduled_at: opts.scheduledAt,
      scheduled_end: opts.scheduledEnd,
      // Only when the caller actually said so: an undefined flag is "not part of this edit", and
      // writing false there silently converts an all-day visit - and, through the mirror, its
      // job - into a timed window nobody asked for.
      ...(opts.isAllDay !== undefined ? { is_all_day: opts.isAllDay } : {}),
      duration_minutes: Math.max(
        1,
        Math.round((opts.scheduledEnd.getTime() - opts.scheduledAt.getTime()) / 60_000),
      ),
      ...(opts.notes !== undefined && opts.notes !== null ? { notes: opts.notes } : {}),
      ...(opts.stampCustomerEmailSentAt ? { customer_email_sent_at: new Date() } : {}),
      ...(opts.locationData ?? {}),
    },
  });
}

/**
 * Every visit on a job, earliest first. The job twin of listLeadVisits.
 *
 * D13: sorted by TIME, labelled by CREATION order - the ordering is applied here in code rather
 * than delegated to an `orderBy` so it is reachable from the API test seam (Prisma is mocked
 * across the backend suite, and a delegated orderBy is invisible there: a list that silently lost
 * its ordering would still look green).
 *
 * S3 (D6): each visit carries its own crew, so the collection serves it.
 *
 * The nested `user` select is a DELIBERATE divergence from listLeadVisits, which selects
 * `user_id` alone. The lead page gets crew NAMES from the separate flat projection
 * `lead.walkthrough_performers[].user`; the job side has no such projection, so copying the lead
 * shape verbatim would leave the job Visits card rendering raw UUIDs. The fields are byte-matched
 * to jobListSelect's assignee shape so the frontend types line up across both job reads.
 *
 * Tenancy: the outer where already spreads tenantWhere(req) and `assignees` is traversed from an
 * already-scoped row, so this does NOT inherit replaceVisitCrew's documented
 * not-tenant-filtered exception.
 */
export async function listJobVisits(req: Req, jobId: string) {
  const visits = await prisma.visit.findMany({
    where: { ...tenantWhere(req), job_id: jobId },
    include: {
      // Slice 6: the POINTER, FOLLOWED. The six columns ride along for free on an `include`, but a
      // company location is only an id until this relation is loaded - without it
      // `formatVisitOwnLocation` answers null and a yard booking renders on the card exactly like a
      // trip at the customer's house. No `where` on it: archiving a location takes it out of the
      // booking pickers (D9), never off the trips already booked there.
      location: visitLocationSelect.location,
      assignees: {
        select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true } } },
      },
    },
  });
  return [...visits]
    .sort((a, b) => {
      // A visit with no time yet sorts last, matching resolveNextJobVisit's rule.
      if (a.scheduled_at === null) return b.scheduled_at === null ? 0 : 1;
      if (b.scheduled_at === null) return -1;
      const delta = a.scheduled_at.getTime() - b.scheduled_at.getTime();
      return delta !== 0 ? delta : a.created_at.getTime() - b.created_at.getTime();
    })
    // Visit-location slice 4: the seed the job's booking dialog is DESTRUCTIVE without.
    //
    // `VisitScheduleDialog`'s location control defaults to the service address and the form
    // states a location on every save, so a Reschedule opened on a yard booking with nothing to
    // seed from would post `location: null` and send the crew to the customer's house - through
    // the very door whose omitted-means-unchanged rule exists to stop that. The API's rule cannot
    // save a form that always states one.
    //
    // Named for what the surface calls it, the job twin of the lead response's
    // `walkthrough_location` (D5), and projected through the SAME `projectVisitLocation` rather
    // than by handing the six raw columns to the client: the three states are a rule, and a
    // client re-deriving it from column prefixes is a second copy of that rule free to drift.
    // `?? null` cannot fire here - this read uses `include`, so every scalar is present - and is
    // what keeps the key's type honest for a caller that narrows the select later.
    // `location` is destructured OUT rather than spread: it is followed above to resolve the line
    // and must not reach the wire. Shipping it would be a COPY of the Settings row (D2) - a client
    // rendering from that copy keeps showing yesterday's address after an admin corrects the typo,
    // which is the one failure a pointer exists to prevent.
    .map(({ location, ...v }) => ({
      ...v,
      visit_location: projectVisitLocation(v) ?? null,
      // Slice 6: where this trip is, already resolved, for the job's Visits card and for the
      // schedule. `null` means the job's own service address, which is what the card has always
      // silently shown - so a null renders no new line at all.
      location_label: formatVisitOwnLocation({ ...v, location }),
    }));
}
