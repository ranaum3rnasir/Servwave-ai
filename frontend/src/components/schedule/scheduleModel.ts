// frontend/src/components/schedule/scheduleModel.ts
// The pure, framework-free heart of the scheduler board — a tested module derived from the
// locked scheduler-assignment redesign (PRD: md_files/plans/scheduler/).
// Crew (0..N performers) and schedule (a time or null) are INDEPENDENT axes (§3.8 four-state).
// Time is modeled as real Dates (an earlier {dayIndex,minutes} sketch was a design-time abstraction).
//
// start/end are WallClock, not a raw Instant: every event that reaches this module has already
// crossed the org-timezone boundary in eventAdapters.ts. See frontend/src/lib/schedule-tz.ts for
// what that means and why — react-big-calendar (the consumer downstream of this module) has no
// timezone concept, so the whole board operates in wall-clock space between the two boundaries.

import { isSameDay } from 'date-fns';
import type { WallClock } from '@/lib/schedule-tz';
import { isLiveVisit } from '@/lib/visits';

// Slice 03 (calendar-entries spec §3): 'calendar-entry' is the internal EventType member for
// the user-facing "Event" (ADR 0002 - sits on the board, joins nothing). Widening this union is
// the forcing function: every Record<EventType, ...> table below becomes a compile error until
// it answers the new member, which is deliberate - see the note on EVENT_TYPE_META.
export type EventType = 'job' | 'walkthrough' | 'service-plan' | 'calendar-entry';

export interface SchedulableEvent {
  /**
   * The card's identity ON THE BOARD - unique per card. `jv-${visit.id}` for a job visit,
   * `wv-${visit.id}` for a walkthrough visit (visits slice 03), and the parent's identity for a card
   * that is not a trip: the bare job id for a job that holds no visit row yet, `wt-${lead.id}` for
   * a lead in the Unscheduled bucket (the unassigned buckets and the first-booking paths).
   *
   * Multi-visit S6 DELETED the old `id` field rather than repointing it, and that is the whole
   * mitigation: `id` was simultaneously the React key, the GRID_EVENT_ID drag payload, the
   * conflict-set key AND the path segment in `/api/jobs/${ev.id}/assign|unassign|complete`. All
   * of those are `string`, so silently changing what it held would have typechecked perfectly and
   * broken every write at runtime. Removing the name turns each of those ~25 sites into a compile
   * error that has to be answered with either `boardId` or `parentId`.
   */
  boardId: string;
  /** The row every mutation addresses: the job id for a job, the LEAD id for a walkthrough. */
  parentId: string;
  /** The visit this card is. Absent for a job that has no visit row behind it yet. */
  visitId?: string;
  /** D13 - creation-order label, not the position in the time-sorted board. */
  visitSeq?: number;
  /**
   * THIS trip's own status, when the card is a trip. The job's status is a derived
   * roll-up across every visit, so colouring a card by it paints all of a job's cards
   * the same: a COMPLETED trip on a live job rendered in the in-flight treatment,
   * byte-identical to its own SCHEDULED sibling, and a future SCHEDULED trip on a
   * completed job rendered faded grey and read as finished (MV-BOARD-10).
   */
  visitStatus?: string;
  /** How many live trips the parent holds. 1 (or undefined) means "do not label this card". */
  visitCount?: number;
  /** The visit's own all-day flag, carried so the drop modal can seed from the trip it dragged. */
  isAllDay?: boolean;
  /**
   * Visit-location slice 6: WHERE this trip is, already resolved by the API, or null/absent when it
   * is at the parent's service address.
   *
   * Typed here rather than read off `raw` for the reason `tags` is: the board card, the member-week
   * card and the visit detail all consume it, and `raw` is `Record<string, unknown>`. A dispatcher
   * routing a crew works off this board, so a card silently painting the CUSTOMER's address on a
   * trip booked at the yard is the exact "wrong side of town" the slice exists to stop.
   *
   * OPTIONAL, so every existing job/walkthrough fixture across the schedule test files stays valid
   * with it absent - and absent reads the same as null, because there is nothing better to show.
   */
  locationLabel?: string | null;
  type: EventType;
  number: string;                   // J00041 / L00012 / SP0003
  title: string;
  customer: string;
  crew: string[];                   // performer user ids (0..N) — equal, no lead/primary
  ownerId: string | null;           // commission owner — OFF-BOARD (a field, never a column)
  start: WallClock | null;          // null = unscheduled
  end: WallClock | null;            // null = unscheduled
  raw: Record<string, unknown>;     // the source job/lead row (for popups, downstream reads)
  // SRVW-58 - tag chips on the board. OPTIONAL deliberately: a required member would
  // break every SchedulableEvent fixture in the five schedule test files. Typed here
  // rather than read off `raw` (which already carries it) because three card renderers
  // consume it and `raw` is Record<string, unknown> - declaring the shape once beats
  // casting it three times.
  tags?: { id: string; name: string; color: string }[];
  /**
   * Slice 06 (calendar-entries spec §3, ADR 0002) - the USER participants on a calendar entry,
   * used ONLY by `isOnBoardFor` to place an entry in a member's column. OPTIONAL for the same
   * reason `tags` is: every existing job/walkthrough fixture across the schedule test files
   * stays valid with the field absent.
   *
   * Deliberately NEVER folded into `crew` - `crew` means "people doing the work", and a
   * participant is not working the entry. `deriveState`, `eventDangerState`'s state-4 read and
   * `conflictedEventIds` all key off `crew`; populating it from participants would make every
   * entry with a participant read as crewed work, painting the board red and rejecting a real
   * job's write with a 409 over an entry as harmless as a birthday - precisely the alternative
   * ADR 0002 rejects.
   */
  participantUserIds?: string[];
  /**
   * Post-QA fix (drag/resize "notify participants" toast; PO-reported 2026-08-25) — whether the
   * entry has any participant at all, i.e. whether the "Notify" toast action has a real
   * recipient. The bug it closes: the action offered itself on an entry with nobody on it and
   * then claimed participants had been notified.
   *
   * BOTH kinds (product-owner change, 2026-08-25). Briefly customer-only, on the reasoning that
   * a teammate had already been told — which was true of the in-app notice the drag's own PATCH
   * emits, and false of email, which that PATCH never sends. `notifyMoved` now emails both kinds
   * with the in-app channel suppressed, so a user-only entry has someone to reach. OPTIONAL for
   * the same reason `tags`/`participantUserIds` are: every job/walkthrough fixture across the
   * schedule test files stays valid with it absent, and SchedulePage.tsx treats an absent value
   * as "nobody to notify".
   */
  hasParticipants?: boolean;
}

/**
 * The board event: the pure SchedulableEvent plus plan-mode draft flags. The flags are
 * optional, so a bare SchedulableEvent (straight from the adapters, or a test fixture)
 * is a valid board event. Status / urgency / all-day live on `raw` — read them there.
 */
export type BoardEvent = SchedulableEvent & { isGhost?: boolean; ghostId?: string };

/** A BoardEvent actually placed on the board — start/end narrowed to real WallClocks. */
export type ScheduledBoardEvent = BoardEvent & { start: WallClock; end: WallClock };

export type AssignmentState = 1 | 2 | 3 | 4;

export interface StateMeta { label: string; where: string; hint: string }
export const STATE_META: Record<AssignmentState, StateMeta> = {
  1: { label: 'Fresh', where: 'Unassigned bucket', hint: 'no crew · no time' },
  2: { label: 'Scheduled', where: 'Board', hint: 'crew ≥1 · timed' },
  3: { label: 'Crewed, unscheduled', where: 'Unassigned bucket', hint: 'keeps crew · no time' },
  4: { label: 'Needs assignment', where: 'Standard view only', hint: 'timed · 0 crew (red flag)' },
};

export function deriveState(e: Pick<SchedulableEvent, 'crew' | 'start'>): AssignmentState {
  const crewed = e.crew.length > 0;
  const scheduled = e.start !== null;
  if (crewed && scheduled) return 2;
  if (crewed && !scheduled) return 3;
  if (!crewed && scheduled) return 4;
  return 1;
}

export const DEFAULT_DURATION_MIN: Record<EventType, number> = { job: 120, walkthrough: 60, 'service-plan': 90, 'calendar-entry': 60 };
export const HOURLESS_DEFAULT_START_MIN = 8 * 60; // 08:00 fallback for day-granularity drops

// Type-keyed presentation — Tailwind tokens ONLY (job=info, walkthrough=warning, service-plan=ai).
// `accent`/`soft`/`text` are class fragments components compose; a 3rd type slots in additively.
export interface EventTypeMeta { label: string; accent: string; soft: string; text: string }
// 'calendar-entry' -> 'Event' (spec §3): a MUTED scheme that reads "on the calendar", not
// "assigned work" - a `--event` token (tokens.css/tokens.ts/tailwind.config.js), an olive hue
// chosen specifically because it sits outside every hue already claimed on this board (info=blue
// job, warning=amber walkthrough, ai=indigo service-plan, danger=terracotta, success=green,
// neutral=cool blue-grey completed) - so it cannot be mistaken for a status tint at a glance.
//
// CORRECTED post-slice-03 (§9 risk 4): the original bronze/taupe value (~4.7:1 estimated on
// WHITE) actually painted 3.70:1 on the card's real background - a low-alpha tint of --event
// over the board canvas, not white - failing AA, and its hue sat close enough to warning/amber
// that an Event and a Walkthrough card read as near-siblings. Olive clears AA on that real
// composite (5.48:1) and separates further from every sibling accent; see the tokens.css comment
// on `--olive-700` for the full measurement and why green/teal alternatives were rejected (both
// collided with the success/in-progress treatment instead). Still a DEFAULT-only token, matching
// info/warning/ai above, not the -surface/-border/-text/-strong badge quartet.
//
// The honest limit, unresolved by any hex: this card's BACKGROUND fill still reads as near-
// identical to the completed treatment's neutral-surface grey (both are compositing something
// at low alpha over the same near-white canvas - no candidate hue closed that gap past ~30 on a
// 0-441 scale). A colour swap fixes the WCAG contrast failure on the text; it does not give a dispatcher
// a background they can tell apart from "this job is done" at a glance. A non-colour signal (a
// distinct border style, or a visible "Event" label on the card - today's number/type badge slot
// is blank for a calendar entry, since it carries no record number) would close that gap more
// robustly, but touches the Standard-view renderer in SchedulePage.tsx, which another team's PR
// (#1737) is actively editing - deliberately left as a follow-up rather than risking that file.
// See boardCardScheme's own note just below for why this does NOT resolve through STATUS_REGISTRY
// either.
// The ev-* utilities are NOT four new colours. Each resolves through an --ev-* custom property
// that aliases the status token this type has always used (tokens.css), so an org that has
// customised nothing renders exactly as before. An org that HAS customised gets the alias
// re-pointed at its chosen palette token on documentElement (lib/schedule/eventColors.ts), and
// every card, pill, bucket, legend swatch and editor chip repaints from this one table.
// Status still outranks type - see boardCardScheme immediately below, which checks completed and
// in-progress BEFORE consulting this table. A customised board keeps its grey "done" and green
// "in progress" cards; only the scheduled/upcoming ones take the org's colour.
//
// The three class fragments are the card colours DERIVED from each accent (2026-09-30), not the
// accent itself: `soft` an opaque surface, `text` an in-hue tone that clears 4.5:1 on it,
// `accent` a left bar that clears 3:1 on the surface and on white (design-system/
// eventCardColors.ts). The accent as text on a 5-10% tint of itself - what these used to be -
// failed AA for most colours an org can pick. Because `text` clears AA on the surface, it clears
// it on white too (the surface is the darker of the two), so a chip or a bucket number painted
// with `text` alone on a white card stays readable.
export const EVENT_TYPE_META: Record<EventType, EventTypeMeta> = {
  job:             { label: 'Job',          accent: 'border-l-ev-job-border',            soft: 'bg-ev-job-surface',            text: 'text-ev-job-text' },
  walkthrough:     { label: 'Walkthrough',  accent: 'border-l-ev-walkthrough-border',    soft: 'bg-ev-walkthrough-surface',    text: 'text-ev-walkthrough-text' },
  'service-plan':  { label: 'Service Plan', accent: 'border-l-ev-service-plan-border',   soft: 'bg-ev-service-plan-surface',   text: 'text-ev-service-plan-text' },
  'calendar-entry':{ label: 'Event',        accent: 'border-l-ev-calendar-entry-border', soft: 'bg-ev-calendar-entry-surface', text: 'text-ev-calendar-entry-text' },
};

/**
 * The board card treatment, spelled ONCE for both member boards (MemberWeekBoard's
 * BoardCard and TechnicianGridView's JobCard previously carried byte-identical copies).
 *
 * This is a THREE-AXIS board treatment - exception state, then status, then event type -
 * NOT a status badge, and it deliberately does NOT resolve through STATUS_REGISTRY. The
 * first axis (the two reds: needs-crew fill, double-booked outline) is resolved by the
 * callers via eventDangerState and never reaches this helper; what is left is the status
 * axis and the type axis, in that order.
 *
 * Why the registry is the wrong source here, concretely:
 *   - EVENT_TYPE_META (see just above) paints job=info, walkthrough=warning and
 *     service-plan=ai. That is the type-accent language the on-screen board legend
 *     advertises to the user. Resolving per status through the registry would repaint
 *     every SCHEDULED and UNSCHEDULED block amber and delete those type accents outright.
 *   - COMPLETED_STATUSES (below) deliberately buckets COMPLETED and CANCELLED together as
 *     one "this is over" treatment for jobs (isCompletedEvent adds the walkthrough case
 *     separately, off the trip's own status rather than the lead's status - see there). The
 *     registry splits the job bucket into a success tone and a neutral tone.
 *   - The in-flight treatment here is green; the registry maps the in-flight statuses to amber,
 *     where they would collide with SCHEDULED.
 * So a registry migration of this helper is a repaint of the busiest screen in the app,
 * not a consolidation. Any change to it is a deliberate design decision, not a cleanup.
 */
export interface BoardCardScheme { accent: string; bg: string; text: string }

export function boardCardScheme(type: EventType, isCompleted: boolean, isInProg: boolean): BoardCardScheme {
  // Completed: the solid grey card the Standard board paints too (tokens.css --ev-completed-*),
  // white text at AA and no fade on top. Solid and type-independent, so it can never be mistaken
  // for a scheduled card, all of which are pale tints. The bar is the fill's own colour.
  if (isCompleted) return { accent: 'border-l-ev-completed-solid', bg: 'bg-ev-completed-solid', text: 'text-ev-completed-on-solid' };
  if (isInProg)    return { accent: 'border-l-success',        bg: 'bg-success-surface', text: 'text-success-text' };
  const m = EVENT_TYPE_META[type];
  return { accent: m.accent, bg: m.soft, text: m.text };
}

/**
 * D13 - the ONE sentence any board is allowed to use to say which trip a card is.
 *
 * Returns null for the case that must stay silent, so a renderer's whole obligation is
 * `{visitLabel(e) && <span ...>{visitLabel(e)}</span>}` - it never restates the condition and
 * never words the label itself.
 *
 * Labelled by CREATION order (visit_seq), never by the card's position in the time-sorted
 * board, because the customer holds an email naming "Visit 2". Silent for the single-trip case,
 * which is 99% of jobs: a badge reading "Visit 1 of 1" on every card is noise, not information.
 *
 * It lives here, next to boardCardScheme, rather than in any one card component because THREE
 * independent renderers paint schedule cards - ScheduleCardBody (MemberWeekBoard +
 * TechnicianGridView) and ScheduleEvent (the Standard week board, which shares no JSX with the
 * other two). S6 first shipped this label into ScheduleCardBody alone and the Standard board -
 * the one a dispatcher lands on - painted three identical unlabelled cards for a three-trip job.
 * That is the #1551 class exactly: a duplicated schedule surface edited in only some of its
 * copies. Only the STYLING is per-renderer; the wording and the condition are not.
 */
export function visitLabel(e: Pick<SchedulableEvent, 'visitSeq' | 'visitCount'>): string | null {
  if ((e.visitCount ?? 1) <= 1 || e.visitSeq == null) return null;
  return `Visit ${e.visitSeq} of ${e.visitCount}`;
}

/**
 * Does taking THIS walkthrough card off the schedule leave the lead with another booked visit?
 * (visits-and-task-categories slice 03)
 *
 * When it does, the lead does NOT go back to the Unscheduled bucket - it still has a trip on the
 * board - and its status stays where it is (the backend reverts a lead to "contacted" only when no
 * live walkthrough remains). The unschedule confirm and its toast say which of the two happens.
 * Always false for a job card and for the bucket's lead card, which is not a trip.
 */
export function leadKeepsAnotherBookedVisit(e: Pick<SchedulableEvent, 'type' | 'visitId' | 'raw'>): boolean {
  if (e.type !== 'walkthrough' || !e.visitId) return false;
  const trips = (e.raw?.walkthrough_visits as { id: string; status: string }[] | undefined) ?? [];
  return trips.some((v) => v.id !== e.visitId && isLiveVisit(v));
}

/**
 * The SAME statement as visitLabel, for the ONE surface that measurably cannot hold the
 * sentence: the week-view all-day strip pill.
 *
 * This is a deliberate, measured exception to the rule above, not a second wording anyone may
 * reach for. Measured on deployed staging at a 1280px viewport, in a 96.3px pill row (the
 * default layout, Jobs panel open), for job J00314:
 *
 *   "J00314 - QA-AllDayChip Overflow"          254px   natural
 *   "J00314"                                    54.6px
 *   "Visit 1 of 5"                              49.7px  -> number + sentence = 132.7px, DOES NOT FIT
 *   "1/5"                                       ~20px   -> number + this     =  78.5px, fits
 *
 * With the sentence, flexbox squeezed the job number down to FOUR characters - `J003` - which is
 * what J00315 also renders. Two different jobs, same four characters: the trip number told you
 * which trip, of a job the pill declined to name. The abbreviation is what buys the number back.
 *
 * Every roomier surface - the full card, the overflow panel, the hover preview - keeps
 * visitLabel's sentence. Do not "unify" these two by abbreviating those.
 */
export function visitLabelCompact(e: Pick<SchedulableEvent, 'visitSeq' | 'visitCount'>): string | null {
  // Deliberately delegates the CONDITION rather than restating it - the silent-when-single rule
  // has to be one decision, or the two labels drift apart on exactly the edge case D13 is about.
  return visitLabel(e) === null ? null : `${e.visitSeq}/${e.visitCount}`;
}

/**
 * M3 — the one column-membership predicate both member views share: an event sits on a
 * member's board lane iff the member is on its crew, OR (slice 06, calendar-entries spec §3) the
 * member is one of its user participants. (Owner is OFF-BOARD — never a column.)
 * Any same-day narrowing is a view concern and stays local to the views.
 *
 * `participantUserIds` is read here and ONLY here — this is the one place ADR 0002 allows
 * participation to affect placement. It must never leak into `crew` itself (see the field's own
 * doc comment on SchedulableEvent for why).
 */
export function isOnBoardFor(
  e: Pick<SchedulableEvent, 'crew' | 'participantUserIds'>,
  memberId: string,
): boolean {
  return e.crew.includes(memberId) || (e.participantUserIds ?? []).includes(memberId);
}

// ─── D9 — role-gated board capabilities (TG13) ───────────────────────────────
// DATA scoping is server-side (PR A scopeWhereFor); this only gates UI CONTROLS.
// ADMIN/DISPATCHER: member view + full edit. SALES: no member view, normal edits
// on their (server-scoped) data. TECHNICIAN — and any unknown/missing role, which
// fails SAFE — gets no member view and a READ-ONLY board.

export interface BoardCapabilities { memberView: boolean; readOnly: boolean }

export function boardCapabilitiesFor(role: string | undefined): BoardCapabilities {
  if (role === 'ADMIN' || role === 'DISPATCHER') return { memberView: true, readOnly: false };
  if (role === 'SALES') return { memberView: false, readOnly: false };
  return { memberView: false, readOnly: true };
}

// ─── Shared status reads (M2) ────────────────────────────────────────────────
// Status / urgency / all-day live on the raw row (the adapters keep events pure).
// One source for all render sites — `raw` can be absent at runtime on the transient
// outside-drag preview stub (cast in), so every read defaults off.

// Job statuses only - a walkthrough's "is this over" reading is not a status value at all
// (see isCompletedEvent below).
export const COMPLETED_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

/**
 * Statuses that render as "work is happening right now".
 *
 * Multi-visit S4 (D17) collapsed this to one value: EN_ROUTE and ON_SITE retired from JobStatus
 * and became VisitStatus values, so neither can appear on a job any more. The visible consequence
 * is deliberate and spec-mandated - a job whose crew is on the way or on site reads SCHEDULED
 * until somebody STARTS a visit (D12), so the board's in-flight colouring now begins at "work
 * started" rather than at "tech left the depot". The finer state is on the visit chip.
 */
export const IN_FLIGHT_STATUSES = new Set(['IN_PROGRESS']);

// A walkthrough event's "completed" reading comes off the visit it represents, never off the
// lead's status. The lead's status (Walkthrough Scheduled / Walkthrough Completed) follows ALL of
// its visits together, so it cannot say whether THIS card's trip is done, and an Estimate Sent
// lead is never moved by a visit at all. Without a trip status the fallback is
// walkthrough_completed_at, the lead's current-visit field. Jobs are unaffected - COMPLETED/
// CANCELLED are real JobStatus values.
//
// Slice 03: a walkthrough card that IS a trip (one card per walkthrough visit) reads that trip's own
// status - the lead's walkthrough_completed_at describes only its current trip, so a finished first
// visit would otherwise paint as upcoming and its upcoming sibling could paint as done.
export const isCompletedEvent = (e: BoardEvent): boolean => {
  if (e.type === 'walkthrough') {
    return e.visitStatus ? e.visitStatus === 'COMPLETED' : Boolean(e.raw?.walkthrough_completed_at);
  }
  return COMPLETED_STATUSES.has(boardEventStatus(e) ?? '');
};

/**
 * The status a CARD should be coloured by.
 *
 * A job fans out into one card per visit but every card shares `raw: job`, so reading
 * `raw.status` gives each trip the roll-up rather than its own state. Where the card is
 * a trip, the trip's status wins; everything else - walkthroughs, service plans, and a
 * job with no visit row behind it - still reads the parent's, which is the only status
 * those cards have. Read `?.` throughout for the same reason rescheduleGate does:
 * react-big-calendar calls the accessors on its untyped outside-drag preview stub too.
 */
export const boardEventStatus = (e: Pick<BoardEvent, 'type' | 'raw' | 'visitStatus'>): string | undefined =>
  (e.type === 'job' ? e.visitStatus : undefined) ?? (e.raw?.status as string | undefined);

/**
 * The drag/resize gate for the calendar and member boards (Spec B1, B-2). Dragging or
 * resizing a scheduled event goes through `/assign`, which un-completes and un-cancels
 * a job via milestoneClears — money, not status, is what should freeze it. Walkthroughs
 * are a Lead, out of scope — they keep the completed-walkthrough block.
 *
 * `e.raw` reads `?.` throughout: react-big-calendar's outside-drag preview stub
 * (`dragFromOutsideItem`) is an untyped `{id,title,start,end}` with no `raw`/`type`, and
 * `draggableAccessor`/`resizableAccessor` call this on every rendered event, preview
 * included. A crash here trips the top-level ErrorBoundary mid-drag.
 */
export type RescheduleGateResult = { ok: true } | { ok: false; reason: string };

export function rescheduleGate(e: Pick<SchedulableEvent, 'type' | 'raw'>): RescheduleGateResult {
  // A calendar entry carries no invoices and joins nothing (ADR 0002), so money can never freeze
  // it. Own early branch rather than falling through to the invoice read below - `raw` on a
  // CalendarEntry has no `invoices` key, so falling through happens to also read as ok:true today,
  // but that is an accident of an absent field, not a decision, and slice 08 (drag comes back on)
  // needs this to be the explicit answer.
  if (e.type === 'calendar-entry') return { ok: true };
  if (e.type === 'walkthrough') {
    return isCompletedEvent(e as BoardEvent)
      ? { ok: false, reason: 'This walkthrough already happened.' }
      : { ok: true };
  }
  const invoices = (e.raw?.invoices as Array<{ sent_at: string | null }> | undefined) ?? [];
  return invoices.some((i) => i.sent_at)
    ? { ok: false, reason: 'This job has already been invoiced.' }
    : { ok: true };
}

/**
 * Multi-visit S6: all-day is a fact about the TRIP, so the CARD's own flag is the answer.
 *
 * `raw` is the shared job row - every card a job fans out into points at the same object - and
 * `Job.is_all_day` is a write-through mirror of the NEXT upcoming visit (D14). Reading it here
 * therefore let one trip's flag decide the placement of all of the job's cards: mark the Monday
 * trip all-day from the job page and Friday's timed 14:00-16:00 visit was routed into the
 * all-day strip and painted as a pill with its time thrown away - and the mirror flips to the
 * next trip the moment Monday completes, so the finished card starts rendering all-day too.
 *
 * The `raw` fallback is NOT dead: a plan-mode ghost is built from a source job row rather than
 * from a visit (SchedulePage's ghostCalendarEvents), so the mirror is the only flag it has.
 */
export const isAllDayEvent = (e: BoardEvent): boolean => {
  if (e.type === 'job') return Boolean(e.isAllDay ?? e.raw?.is_all_day);
  // Slice 05 (calendar-entries spec §3) — same shape as the job branch above, but with none of
  // its mirror hazard: `is_all_day` is a real column on the entry itself, not a write-through
  // mirror of a child row, so there is no "which trip's flag wins" question to answer. `isAllDay`
  // is what calendarEntryToEvent carries onto the card; `raw.is_all_day` is the fallback for
  // anything built straight from the source row instead (there is no calendar-entry ghost today,
  // but the job branch keeps this fallback for exactly that shape, so this mirrors it).
  if (e.type === 'calendar-entry') return Boolean(e.isAllDay ?? e.raw?.is_all_day);
  if (!e.raw) return false;
  if (e.type === 'walkthrough') {
    // Slice 03: a trip card's own flag; the lead's duration describes only its current trip.
    if (e.visitId) return Boolean(e.isAllDay);
    return ((e.raw.walkthrough_duration_minutes as number | null) ?? 60) >= 1440;
  }
  return false;
};

/**
 * Does this event get rendered into react-big-calendar's all-day strip?
 *
 * NOT the same question as isAllDayEvent, and the gap between the two is a bug we
 * shipped: rbc's TimeGrid routes an event to the all-day strip when
 *   accessors.allDay(event) || startAndEndAreDateOnly || (!showMultiDayTimes && !isSameDate(start,end))
 * We never pass showMultiDayTimes, so ANY event crossing a calendar-day boundary lands
 * in the strip regardless of its is_all_day flag. The page then gates the strip's
 * visibility (`has-allday-events` → max-height 0 in schedule-dark.css) on isAllDayEvent,
 * so a timed cross-midnight job rendered into a collapsed container and simply vanished
 * from the week - it was in the DOM, zero pixels tall.
 *
 * Mirror rbc's own predicate rather than a tidier one: an event ending at exactly
 * midnight is "a different day" to rbc, so it must be one here too.
 */
export const occupiesAllDayStrip = (e: BoardEvent): boolean => {
  if (isAllDayEvent(e)) return true;
  if (!e.start || !e.end) return false;
  return !isSameDay(e.start, e.end);
};

// ─── The two reds (D7 + §3.8 state 4) ────────────────────────────────────────

export type EventDangerState = 'needs-crew' | 'double-booked' | null;

/**
 * The single precedence decision for the two reds, shared by all three render
 * sites (member grid card, member week chip, standard-calendar styles):
 *   - 'needs-crew'   → red FILL (state 4: timed + 0 crew). Standard views only in
 *     practice — `isOnBoardFor` structurally keeps state-4 out of member columns.
 *   - 'double-booked' → red OUTLINE (id ∈ conflictIds, D7).
 * needs-crew WINS: a crew-less event can't share a member with anything, so the
 * overlap is impossible — but the precedence is encoded here, once.
 * Ghost/draft cards are plan-mode previews — never painted red.
 */
export function eventDangerState(e: BoardEvent, conflictIds: Set<string>): EventDangerState {
  if (e.isGhost) return null;
  // ADR 0002 - a calendar entry has no crew by design (participants are not crew), so it would
  // otherwise paint red as state 4 "needs assignment" on EVERY entry. Checked before deriveState
  // for exactly that reason - it is not a job/walkthrough missing a crew, it never had one to miss.
  if (e.type === 'calendar-entry') return null;
  if (deriveState(e) === 4) return 'needs-crew';
  if (conflictIds.has(e.boardId)) return 'double-booked';
  return null;
}

/** Do two scheduled events overlap in real time? Unscheduled → never. */
export function timeOverlap(a: SchedulableEvent, b: SchedulableEvent): boolean {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  return a.start < b.end && b.start < a.end;
}

/**
 * D7 — double-booking. The ids of events that share a crew member with another scheduled
 * event whose time overlaps. Per-crew-member, spans jobs + walkthroughs in one flat pass.
 * (Visual only — the backend independently enforces conflicts on write with a 409.)
 */
export function conflictedEventIds(events: SchedulableEvent[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (!a || !b) continue;
      // ADR 0002 - a calendar entry neither reports a double-booking nor causes one, on EITHER
      // side of the pair: excluded as `a` and as `b`. A crew-less entry would never match the
      // `crew.some(...)` test anyway (its crew is always []), but a job/walkthrough sharing a
      // PARTICIPANT with an entry must also stay silent, and participants are not read here at
      // all - this guard is what keeps that true regardless of how participants are modelled later.
      if (a.type === 'calendar-entry' || b.type === 'calendar-entry') continue;
      if (a.crew.some((c) => b.crew.includes(c)) && timeOverlap(a, b)) {
        out.add(a.boardId);
        out.add(b.boardId);
      }
    }
  }
  return out;
}

/**
 * D2 swap reducer — the drop-target member replaces the from-lane member (1:1, preserves size).
 * No-op if the target is already on the crew (the card already renders in their column — per-person
 * removal is an EDITOR action, never a drag) or if from-member isn't on the crew (defensive).
 */
export type SwapOutcome =
  | { kind: 'swapped'; crew: string[] }
  | { kind: 'noop-already-on' }
  | { kind: 'noop-not-on' };

export function swapCrew(crew: string[], fromMember: string, toMember: string): SwapOutcome {
  if (!crew.includes(fromMember)) return { kind: 'noop-not-on' };
  if (crew.includes(toMember)) return { kind: 'noop-already-on' };
  return { kind: 'swapped', crew: crew.map((c) => (c === fromMember ? toMember : c)) };
}

/**
 * TG10 — the governing rule for dropping an already-scheduled BOARD card on a member
 * lane, encoded once: drag changes WHERE/WHEN an event is + whole-lane swaps; the
 * EDITOR changes who is on it. So:
 *   - cross-lane (from ≠ to)            → 'swap'       (crew change; the drop slot's time/date is IGNORED)
 *   - same lane + hour slot             → 'reschedule' (move within the lane; crew unchanged)
 *   - same lane + day cell, other day   → 'reschedule' (keep time-of-day + duration; crew unchanged)
 *   - same lane + day cell, same day    → 'noop'       (nothing to change)
 *   - from-member absent                → 'noop'       (defensive — board drags only originate in member lanes)
 */
export type BoardDropDecision = 'swap' | 'reschedule' | 'noop';

export function classifyBoardDrop(args: {
  fromMember: string | null;
  toMember: string;
  sameDay: boolean;
  hasTime: boolean;
}): BoardDropDecision {
  if (!args.fromMember) return 'noop';
  if (args.fromMember !== args.toMember) return 'swap';
  if (args.hasTime) return 'reschedule';
  return args.sameDay ? 'noop' : 'reschedule';
}

/** A board drop location. Member targets carry a member id; time targets carry an exact start. */
export type DropTarget =
  | { kind: 'member-day'; memberId: string; start: WallClock }   // member + exact time
  | { kind: 'member-week'; memberId: string; date: WallClock }   // member + day, no time
  | { kind: 'standard-time'; start: WallClock }                  // time, no member
  | { kind: 'standard-day'; date: WallClock };                   // day, no member, no time

export interface ScheduleDraft {
  eventId: string;
  start: WallClock;
  durationMin: number;
  crew: string[];
  autoDate: boolean;   // highlight: date came from the drop
  autoTime: boolean;   // highlight: time came from the drop
  autoMember: boolean; // highlight: member came from the drop
  /** All-day: the job owns whole days, so its times are not asked for or sent. */
  allDay: boolean;
}

/** A copy of `day` with the time-of-day set to `minutes` since midnight (wall-clock space). */
export function atMinutes(day: WallClock, minutes: number): WallClock {
  const d = new Date(day);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d as WallClock;
}

/** 'HH:MM' → minutes since midnight; falls back to 08:00 on malformed input. */
export function hhmmToMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return HOURLESS_DEFAULT_START_MIN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * D5 — the drop modal's ADVISORY conflict note (decision D5 in the scheduler redesign PRD).
 * Scans the scheduled events for the first one that shares ≥1 crew member with the draft
 * AND overlaps its hypothetical [start, start+duration) window — excluding the dragged
 * event itself. Returns "overlaps <number> for <firstName>" (name resolved via
 * `firstNameById`, omitted when unknown) or null. Advisory only — never a blocker; the
 * backend independently enforces conflicts on write with a 409.
 */
export function conflictNoteFor(
  draft: Pick<ScheduleDraft, 'eventId' | 'start' | 'durationMin' | 'crew'>,
  events: SchedulableEvent[],
  firstNameById: ReadonlyMap<string, string>,
): string | null {
  if (draft.crew.length === 0) return null;
  const end = new Date(draft.start.getTime() + draft.durationMin * 60_000);
  for (const other of events) {
    if (other.boardId === draft.eventId) continue;
    if (!other.start || !other.end) continue;
    const shared = draft.crew.find((c) => other.crew.includes(c));
    if (shared === undefined) continue;
    if (draft.start < other.end && other.start < end) {
      const first = firstNameById.get(shared);
      return `overlaps ${other.number}${first ? ` for ${first}` : ''}`;
    }
  }
  return null;
}

/** D5 — derive the modal's initial draft from where the card was dropped. Pure. */
export function draftFromDrop(
  event: SchedulableEvent,
  target: DropTarget,
  opts: { defaultStartMin: number; defaultDurationMin: number },
): ScheduleDraft {
  const durationMin =
    event.start && event.end
      ? Math.round((event.end.getTime() - event.start.getTime()) / 60_000)
      : opts.defaultDurationMin;
  const base = { eventId: event.boardId, durationMin, crew: [...event.crew], allDay: event.isAllDay ?? false };
  switch (target.kind) {
    case 'member-day':
      return { ...base, start: target.start, crew: [target.memberId], autoDate: true, autoTime: true, autoMember: true };
    case 'member-week':
      return { ...base, start: atMinutes(target.date, opts.defaultStartMin), crew: [target.memberId], autoDate: true, autoTime: false, autoMember: true };
    case 'standard-time':
      return { ...base, start: target.start, autoDate: true, autoTime: true, autoMember: false };
    case 'standard-day':
      return { ...base, start: atMinutes(target.date, opts.defaultStartMin), autoDate: true, autoTime: false, autoMember: false };
  }
}

/**
 * Whose names the drop modal OPENS with, for the person who did the dropping.
 *
 * The twin of `seedPerformers` in the lead's Walkthrough tab, and deliberately answering the same
 * rule - the two booking surfaces must not drift.
 *
 * ── A NON-HOLDER IS SEEDED WITH THEMSELVES, WHATEVER THE DROP PRODUCED ──────────────────────
 *
 * An earlier version of this function passed a dropped card's existing crew straight through, on
 * the reasoning that "an unchanged restatement is not a crew statement - `validateCrew` /
 * `validatePerformers` exempt it via their `currentCrewIds` parameter". THAT EXEMPTION DOES NOT
 * EXIST ON THIS SURFACE, and the comment claiming it did was worse than no comment: it walked a
 * self-only viewer into a 403 they could not leave.
 *
 * `POST /api/jobs/:id/assign` passes `hasLiveVisit ? jobCrewIds(existing) : undefined`, and
 * omitting that third argument IS the strict path (see the long note at that call site: with no
 * live trip there is no roster to restate, and `syncJobWindowOntoVisits` would take a stated crew
 * WHOLESALE onto a brand-new visit). `POST /leads/:id/walkthrough/schedule` does the same through
 * `findActiveWalkthrough`. So the exemption needs a live visit, and this function never sees one:
 *
 *   EVERY card that reaches here came out of the UNSCHEDULED BUCKET. `openDropModal` has exactly
 *   two callers (`handleDropFromOutside` and `handleMemberBoardDrop`) and both resolve their card
 *   through `bucketEvents.find(...)`. A bucket card is a job from `GET /api/jobs?status=UNSCHEDULED`
 *   - and `deriveJobStatus` only answers UNSCHEDULED when no visit is live and none is started or
 *   COMPLETED - or a lead from `GET /api/leads?walkthrough_status=needs_scheduling`, whose facet
 *   is literally `visits: { none: { status: { in: LIVE_VISIT_STATUSES } } }`. "Has a live visit"
 *   is therefore not a fact to be threaded in from the draft: it is FALSE by construction, and
 *   the two query parameters above are where that is enforced.
 *
 * Concretely, the case that used to dead-end: job J sits in the bucket crewed `[TECH]` off a
 * cancelled trip. A rep drags it onto a standard time lane, `draftFromDrop` copies `crew:
 * ['TECH']` through, the Crew field arrives LOCKED holding TECH, Schedule posts
 * `assignee_ids: ['TECH']` with `hasLiveVisit` false, and the door answers 403 "You can only
 * assign yourself as job crew." - after which
 * `restoreDraftOnNon409` puts them back in front of the same unfixable form.
 *
 * The member-lane seed needs no clause of its own any more. `member-day` / `member-week` put the
 * LANE's id in `draft.crew`, and the lanes are built from `roster`, the same grant-scoped
 * `/api/users/assignable` list - so a self-only viewer has exactly one lane, it is their own, and
 * `[memberId]` and `[actorId]` are the same array. Stating it as "yourself" rather than "whatever
 * the lane said" is also the safer of the two if that scoping ever widens.
 *
 * A GRANT HOLDER IS UNTOUCHED: `droppedCrew` back verbatim, which for an empty drop is `[]` (a
 * dispatcher booking somebody else's job must not find their own name pre-filled).
 *
 * `actorId` is '' until the session hydrates, and `['']` is a member the API answers 404 for. The
 * guard therefore returns `droppedCrew` UNCHANGED rather than `[]`: pre-hydration `canAssignOthers`
 * reads false for a dispatcher too (`useAppAbility` defaults to `emptyAbility`), so wiping the
 * card's crew on the strength of that verdict would be acting on an answer we do not have yet.
 * Unlike the tab there is no re-seed sentinel and none is needed: a draft is built when a card is
 * DROPPED, not when the page mounts, and the board cannot render a lane to drop onto before the
 * session it fetched its roster with has landed.
 *
 * Pure, and kept here rather than folded into `draftFromDrop`: that function answers WHERE the
 * card landed, takes no actor, and is a fixture builder in three suites. Its four branches must
 * not each restate a permission rule.
 */
export function seedCrewForActor(
  droppedCrew: string[],
  canAssignOthers: boolean,
  actorId: string,
): string[] {
  if (canAssignOthers) return droppedCrew;
  if (!actorId) return droppedCrew;
  return [actorId];
}
