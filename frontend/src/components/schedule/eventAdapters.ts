import type { SchedulableEvent } from './scheduleModel';
import { DEFAULT_DURATION_MIN } from './scheduleModel';
import { crewPeopleOf, ownerOf, visitCrewPeopleOf, type VisitCrewRow } from './eventPeople';
import { toWallClock, addMsToWallClock, type WallClock } from '@/lib/schedule-tz';
import { projectVisitCards, type BoardVisitRow, type VisitCardParent } from './boardProjection';

type CustomerLike = { first_name?: string; last_name?: string; company_name?: string | null } | null | undefined;

// Board display policy: company name first (company-dominant for field crew clarity).
// This is intentionally different from src/lib/customer-name.ts customerDisplayName, which is
// person-first (used in office/sales views). Do not unify — the contexts differ.
export function customerName(c: CustomerLike): string {
  if (!c) return 'Customer';
  if (c.company_name?.trim()) return c.company_name.trim();
  const n = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return n || 'Customer';
}

const ids = (people: { id?: string }[]): string[] =>
  people.map((p) => p.id).filter((id): id is string => Boolean(id));

type NarrowedJob = {
  id: string;
  job_number: string;
  scope_notes?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  is_all_day?: boolean | null;
  customer?: CustomerLike;
  tags?: SchedulableEvent['tags'];
  visits?: BoardVisitRow[] | null;
};

/**
 * The job as ONE card, keyed on the bare job id and carrying the job's own mirror window.
 *
 * This is the identity a card has when it is NOT a trip: a job that holds no visit row yet, and
 * every card in the unscheduled bucket (see jobToBucketEvent). With no trip to read a crew off,
 * it carries the job-level crew - the bucket's "crew kept" state and the optimistic window after
 * /assign (which writes `job.assignees` before the refetch brings the visit) both read it. Slice 02
 * moved every TRIP card off that union; this card is not a trip.
 */
function jobIdentityEvent(j: NarrowedJob, job: Record<string, unknown>, tz: string): SchedulableEvent {
  const start: WallClock | null = j.scheduled_start ? toWallClock(new Date(j.scheduled_start), tz) : null;
  const end: WallClock | null = j.scheduled_end
    ? toWallClock(new Date(j.scheduled_end), tz)
    : start
      ? addMsToWallClock(start, DEFAULT_DURATION_MIN.job * 60_000)
      : null;
  return {
    ...sharedJobFields(j, job),
    crew: ids(crewPeopleOf('job', job)),
    boardId: j.id,
    isAllDay: j.is_all_day ?? false,
    start,
    end,
  };
}

/**
 * Multi-visit S6 (F4, D16): a card in the UNSCHEDULED bucket addresses the JOB, never a trip.
 *
 * "Unscheduled" means the job holds no LIVE visit, so there is no trip for the card to be - and
 * the gesture the card offers is "book this work", which is `/assign`'s first-booking path.
 * Fanning the bucket out per visit the way the board does looks like a no-op (an unscheduled job
 * usually has no surviving visit at all) right up until `/unassign` leaves one behind: it cancels
 * only the LIVE statuses, so a job whose trip had already COMPLETED keeps that row. Keyed on the
 * visit, that card dragged out would PATCH the finished trip - rewriting when the work was
 * actually done and booking nothing - and its plan-mode ghost would carry `jv-<uuid>` as a JOB id
 * (parseBoardDragId has no `jv-` case) straight into a 404.
 */
export function jobToBucketEvent(job: Record<string, unknown>, tz: string): SchedulableEvent {
  const j = job as NarrowedJob;
  return jobIdentityEvent(j, job, tz);
}

/** The card content every one of a job's cards shares - see the note inside for why. */
function sharedJobFields(j: NarrowedJob, job: Record<string, unknown>): VisitCardParent {
  // The card's content is the JOB's - D4: a visit is an occurrence only, with no address and no
  // customer of its own. The time, the identity, the visit label AND the crew differ per card, and
  // are the projection's (boardProjection.ts).
  return {
    type: 'job' as const,
    parentId: j.id,
    number: j.job_number,
    title: j.scope_notes?.trim() || customerName(j.customer),
    customer: customerName(j.customer),
    ownerId: ownerOf('job', job)?.id ?? null,
    tags: j.tags ?? [],
    raw: job,
  };
}

/**
 * job API payload -> board events, ONE PER VISIT.
 *
 * This is the read boundary (schedule-tz.ts): every timestamp the payload carries is an Instant,
 * and everything downstream of this function (RBC, grid layout math) needs a WallClock in the
 * org's `tz` instead - see there for why. Every instant crosses exactly here, exactly once,
 * through toWallClock; a `new Date(v).toISOString()` anywhere else converts in the BROWSER zone,
 * which is #1551's second defect.
 *
 * Multi-visit S6 (D33): `Job.scheduled_start` is a write-through mirror of the job's NEXT
 * upcoming visit (D14), so reading it produced exactly one card however many trips the job held.
 * A job whose `visits` array is EMPTY still yields one event off the mirror, keyed on the bare
 * job id: that is the unassigned bucket, the first-booking path, and the optimistic window after
 * /assign returns but before the refetch lands. Removing that fallback would make a freshly
 * booked job vanish from the board until the next fetch.
 */
export function jobToEvents(job: Record<string, unknown>, tz: string): SchedulableEvent[] {
  // The parameter stays `Record<string, unknown>` - the shape `raw`, crewPeopleOf and
  // ownerOf all speak - and the fields this function actually reads are narrowed once
  // here rather than cast one by one at each use.
  const j = job as NarrowedJob;
  // One card per non-cancelled trip, each with its own time, crew and "Visit n of m" - the
  // projection slice 03's walkthrough cards share (boardProjection.ts).
  const cards = projectVisitCards(sharedJobFields(j, job), j.visits ?? [], {
    tz,
    boardIdPrefix: 'jv-',
    defaultDurationMin: DEFAULT_DURATION_MIN.job,
  });
  return cards.length > 0 ? cards : [jobIdentityEvent(j, job, tz)];
}

/**
 * Slice 03 (calendar-entries spec §2/§3) — the CalendarEntry read boundary, same shape as
 * jobToEvents/walkthroughToEvent: every timestamp crosses into the org-tz WallClock exactly
 * here, via toWallClock, and nowhere downstream.
 *
 * `number: ''` — spec §2: an entry carries no record number, so the card renders the title
 * alone. `customer: ''` and `crew: []` — ADR 0002: an entry joins no lead/job/estimate and has
 * no crew; its participants are a SEPARATE field (`participantUserIds`, slice 06), never folded
 * into crew here. `ownerId: null` — there is no commission owner for scheduler content that is
 * not work.
 */
type NarrowedParticipant = { kind: 'USER' | 'CUSTOMER'; user_id: string | null };

type NarrowedCalendarEntry = {
  id: string;
  title: string;
  start: string;
  end: string;
  is_all_day?: boolean | null;
  participants?: NarrowedParticipant[];
};

/**
 * Slice 06 (calendar-entries spec §3, ADR 0002) — the USER participants, as ids, for
 * `isOnBoardFor`. Deliberately its own small function rather than inlined below: it is the ONE
 * place a `calendar-entry` payload's participants are read for board placement, mirroring how
 * `crewPeopleOf`/`ownerOf` in eventPeople.ts are the one place crew/owner are read — so a future
 * reader looking for "where do participants become board membership" finds one function, not a
 * filter buried in a return object.
 */
function participantUserIdsOf(entry: NarrowedCalendarEntry): string[] {
  return (entry.participants ?? [])
    .filter((p) => p.kind === 'USER')
    .map((p) => p.user_id)
    .filter((id): id is string => Boolean(id));
}

/**
 * Post-QA fix (drag/resize "notify participants" toast, PO-reported 2026-08-25) — whether the
 * entry has anyone the "Notify" toast action could actually reach. The original bug was the
 * action offering itself on an entry with NO participants and then reporting that participants
 * had been notified.
 *
 * Counts BOTH kinds since the product-owner change of 2026-08-25 ("I actually wanted all
 * participants to be notified"). It was briefly customer-only, on the reasoning that a teammate
 * had already been told — true of the in-app notice, which fires on the PATCH the drag itself
 * sends, but not of email, which that PATCH never sends. `notifyMoved` now emails both kinds
 * and passes `suppressInAppNotice`, so the in-app notice still fires exactly once and a
 * user-only entry has a real recipient for this action.
 */
function calendarEntryHasParticipantOf(entry: NarrowedCalendarEntry): boolean {
  return (entry.participants ?? []).length > 0;
}

export function calendarEntryToEvent(entry: Record<string, unknown>, tz: string): SchedulableEvent {
  const e = entry as NarrowedCalendarEntry;
  return {
    boardId: `ce-${e.id}`,
    parentId: e.id,
    type: 'calendar-entry',
    number: '',
    title: e.title,
    customer: '',
    crew: [],
    participantUserIds: participantUserIdsOf(e),
    hasParticipants: calendarEntryHasParticipantOf(e),
    ownerId: null,
    isAllDay: e.is_all_day ?? false,
    start: toWallClock(new Date(e.start), tz),
    end: toWallClock(new Date(e.end), tz),
    tags: [],
    raw: entry,
  };
}

type NarrowedLead = {
  id: string;
  lead_number: string;
  walkthrough_scheduled_at?: string | null;
  walkthrough_duration_minutes?: number | null;
  /** Slice 6: the current visit's own location, resolved by the API onto the lead LIST payload. */
  walkthrough_location_label?: string | null;
  /** The crew of the lead's CURRENT trip - the one the flat walkthrough_* fields describe. */
  walkthrough_performers?: VisitCrewRow[] | null;
  /** Slice 03: every non-cancelled trip, each with its own time, crew and place (lead LIST payload). */
  walkthrough_visits?: BoardVisitRow[] | null;
  customer?: CustomerLike;
  tags?: SchedulableEvent['tags'];
};

/** The card content every one of a lead's walkthrough cards shares - the lead's, never a trip's. */
function sharedWalkthroughFields(l: NarrowedLead, lead: Record<string, unknown>): VisitCardParent {
  return {
    type: 'walkthrough' as const,
    parentId: l.id,
    number: l.lead_number,
    title: `Walkthrough · ${customerName(l.customer)}`,
    customer: customerName(l.customer),
    ownerId: ownerOf('walkthrough', lead)?.id ?? null,
    tags: l.tags ?? [],
    raw: lead,
  };
}

/**
 * The lead as ONE walkthrough card, keyed `wt-<leadId>` and carrying the lead's CURRENT trip off
 * the flat walkthrough_* fields - the lead's identity rather than any one trip's.
 *
 * That is exactly what the Unscheduled bucket needs, and it is the bucket's card (the twin of
 * jobToBucketEvent): "needs scheduling" means the lead holds no live trip, so the gesture the card
 * offers is "book this lead a walkthrough", which /walkthrough/schedule's first-booking path does.
 * Its crew is the current trip's crew, read off `walkthrough_performers` directly - the bucket's
 * "crew kept" state - and never the union crewPeopleOf answers for naming people.
 */
export function walkthroughToEvent(lead: Record<string, unknown>, tz: string): SchedulableEvent {
  // Same narrowing as jobToEvent - see the note there.
  const l = lead as NarrowedLead;
  const start: WallClock | null = l.walkthrough_scheduled_at
    ? toWallClock(new Date(l.walkthrough_scheduled_at), tz)
    : null;
  const durMin = l.walkthrough_duration_minutes ?? DEFAULT_DURATION_MIN.walkthrough;
  const end: WallClock | null = start ? addMsToWallClock(start, durMin * 60_000) : null;
  return {
    ...sharedWalkthroughFields(l, lead),
    boardId: `wt-${l.id}`,
    crew: ids(visitCrewPeopleOf({ assignees: l.walkthrough_performers })),
    // Slice 6: the walkthrough half. Resolved against the lead's CURRENT visit, the same one this
    // card's start time comes from, so the card cannot name one trip's time beside another's place.
    locationLabel: l.walkthrough_location_label ?? null,
    start,
    end,
  };
}

/**
 * lead API payload -> board events, ONE PER WALKTHROUGH VISIT (visits-and-task-categories slice 03).
 *
 * The board's lead lane used to read the flat walkthrough_* fields, which resolve to the lead's ONE
 * current trip: a lead booked twice in a week showed one card, and a past trip nobody completed hid
 * every later one. Now every non-cancelled trip in `walkthrough_visits` becomes its own card through
 * the same projection job visits use (boardProjection.ts), so both lanes agree on what a visit card
 * is - its own time, its own crew (hence its own Member-view lanes), its own "Visit n of m" - and
 * each card is keyed `wv-<visitId>` so a drag, a re-crew or an unschedule addresses THAT trip.
 *
 * A payload without `walkthrough_visits` (an optimistic cache entry, or an older API) falls back to
 * the lead-identity card, exactly as a job with no visit rows keeps its bare-job card.
 */
export function walkthroughToEvents(lead: Record<string, unknown>, tz: string): SchedulableEvent[] {
  const l = lead as NarrowedLead;
  const cards = projectVisitCards(sharedWalkthroughFields(l, lead), l.walkthrough_visits ?? [], {
    tz,
    boardIdPrefix: 'wv-',
    defaultDurationMin: DEFAULT_DURATION_MIN.walkthrough,
  });
  return cards.length > 0 ? cards : [walkthroughToEvent(lead, tz)];
}
