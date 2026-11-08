/**
 * Multi-visit spec slice S1: the one place the frontend decides which of a parent's visits is
 * "current" and which are "the others".
 *
 * Extracted deliberately, not inlined. Two lead pages each carried a byte-identical copy of the
 * filter this replaces, and PR #1551 is the standing proof of what that cost: a shipped fix in
 * one lead tree was silently reverted by its untouched copy in the other. Only one of those
 * pages survives - the unrouted v1 lead page was deleted - so the rule now reads forward rather
 * than backward: the routed lead page's walkthrough tab takes the rule from here, and any new
 * renderer of "current visit vs the others" must do the same rather than re-derive it.
 *
 * Mirrors the backend's resolveCurrentWalkthrough (services/walkthrough.service.ts) so the page
 * and the legacy flat `walkthrough_*` response fields never disagree about which trip is current.
 */

/** A visit that has not happened yet and has not been called off. */
export const LIVE_VISIT_STATUSES = ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] as const;

export interface VisitRow {
  id: string;
  status: string;
  scheduled_at: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_at: string;
  /**
   * Visit-location slice 6: WHERE this trip is, already resolved, or `null` when it is at the
   * parent's service address - which is the great majority of them, and which renders nothing.
   *
   * Declared on the BASE row rather than on `JobVisitRow`, because every surface that reads a visit
   * gets the same key from the same server-side resolution: the job's Visits card, the lead's visit
   * cards (whose history rows are structurally these) and the scheduler board. #1551 is what a
   * per-surface copy of a visit field costs.
   *
   * A STRING, deliberately, and not the six columns `visit_location` carries. Those are the seed a
   * booking FORM posts back; a card needs the rendered answer, and rendering it here would put a
   * second copy of "name, then address, in this order, unless it is blank" in the client - free to
   * drift from the one the customer's email renders. Optional because a cached payload from before
   * this shipped carries no such key, and a card must render that row rather than crash on it.
   */
  location_label?: string | null;
}

export function isLiveVisit(v: Pick<VisitRow, 'status'>): boolean {
  return (LIVE_VISIT_STATUSES as readonly string[]).includes(v.status);
}

/**
 * The "m" of "Visit n of m": the highest `visit_seq` among the parent's NON-cancelled visits, with
 * the live row count as the floor for a missing seq. Shared by the scheduler board
 * (components/schedule/eventAdapters.ts) and the customer page's Schedule tab
 * (lib/customers/customerSchedule.ts), so the two never print different totals for one parent.
 *
 * `visit_seq` is the stable creation-order number (D13 - it is in the customer's email, so it is
 * never renumbered), so the total must sit on the SAME axis as the numerator. Counting rows would
 * print a card that cannot be true: cancel visit 1 of three and the survivors, still numbered 2 and
 * 3, would read "Visit 2 of 2" and "Visit 3 of 2". The highest live seq reads "2 of 3" and "3 of 3",
 * while a cancelled LAST trip drops out ("1 of 2", "2 of 2"). Cancelled rows are kept (D19) and are
 * ignored here whether or not the caller already filtered them.
 */
export function visitDenominator(
  visits: ReadonlyArray<{ status?: string | null; visit_seq?: number | null }>,
): number {
  const live = visits.filter((v) => v.status !== 'CANCELLED');
  return live.reduce((highest, v) => Math.max(highest, v.visit_seq ?? 0), live.length);
}

function timeOf(v: VisitRow): number {
  return new Date(v.completed_at ?? v.cancelled_at ?? v.created_at).getTime();
}

/**
 * The visit the page's hero describes: the EARLIEST still-coming trip, or - when nothing is
 * still coming - the most recent one that happened.
 *
 * Ordering by scheduled_at is what S1 changed. Under the old one-live-visit invariant "the first
 * SCHEDULED row" was unambiguous because there was only ever one; with several live visits it
 * would pick an arbitrary one.
 */
export function resolveCurrentVisit<T extends VisitRow>(visits: T[]): T | null {
  const live = visits.filter(isLiveVisit);
  if (live.length > 0) {
    return live.reduce((earliest, v) => {
      if (v.scheduled_at === null) return earliest;
      if (earliest.scheduled_at === null) return v;
      return new Date(v.scheduled_at).getTime() < new Date(earliest.scheduled_at).getTime() ? v : earliest;
    });
  }

  const happened = visits.filter((v) => v.status === 'COMPLETED' || v.status === 'CANCELLED');
  if (happened.length === 0) return null;
  return happened.reduce((latest, v) => (timeOf(v) > timeOf(latest) ? v : latest));
}

/**
 * Every visit EXCEPT the one already described above, in time order.
 *
 * Excluding by row IDENTITY is the fix S1 needed. The previous filter excluded by STATUS CLASS -
 * "if the current visit is scheduled, drop every SCHEDULED row" - which was harmless only while a
 * lead could hold at most one live visit. The moment a lead holds two, that rule hides a real,
 * booked trip from the office entirely.
 */
export function otherVisits<T extends VisitRow>(visits: T[]): T[] {
  const current = resolveCurrentVisit(visits);
  return visits
    .filter((v) => v.id !== current?.id)
    .sort((a, b) => {
      // Upcoming first (soonest at the top), then everything that already happened, newest first.
      const aLive = isLiveVisit(a);
      const bLive = isLiveVisit(b);
      if (aLive !== bLive) return aLive ? -1 : 1;
      if (aLive && bLive) {
        if (a.scheduled_at === null) return 1;
        if (b.scheduled_at === null) return -1;
        return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
      }
      return timeOf(b) - timeOf(a);
    });
}

/**
 * Multi-visit S2: a JOB's visit. Adds the three things a job's schedule needs and a lead
 * walkthrough never had - the stable number, the end of the window, and the all-day flag.
 *
 * `scheduled_at` deliberately keeps the row's own name rather than being aliased to
 * `scheduled_start`, and VisitRow is deliberately NOT widened to accept both spellings: the lead
 * page and the job page would then disagree about which field is authoritative.
 */
export interface VisitCrewMember {
  user_id: string;
  user: { id: string; first_name: string | null; last_name: string | null };
}

export interface JobVisitRow extends VisitRow {
  visit_seq: number;
  scheduled_end: string | null;
  is_all_day: boolean;
  cancelled_reason?: string | null;
  /**
   * S3 (D6): the crew on THIS trip, as GET /api/jobs/:id/visits serves it. Optional because a
   * cached payload from before S3 carries no such key, and the Visits card must render that
   * row rather than crash on it.
   *
   * Widened here once, in the file the job page and the lead surfaces already share, so a crew
   * line added to one of them cannot be silently reverted by an untouched copy elsewhere (#1551).
   */
  assignees?: VisitCrewMember[];
  /**
   * S4 (D7): the milestone stamps, which live on the VISIT now. `completed_at` and `cancelled_at`
   * come from VisitRow above.
   *
   * Widened HERE and only here, for the same reason `assignees` is: listJobVisits uses findMany
   * with `include` and no `select`, so every new Visit column ships to the client automatically -
   * a row type declared locally in a visits component would silently diverge from what the API
   * actually sends.
   */
  en_route_at?: string | null;
  on_site_at?: string | null;
  started_at?: string | null;
  /**
   * Scheduling-notifications slice 08: was the matching stamp above SKIPPED - written with the
   * same instant as a later tap, rather than tapped itself? Optional for the same reason the
   * stamps are: a cached payload from before slice 08 carries no such key, and absent reads as
   * "tapped", which is what every stamp was before skips existed.
   */
  en_route_skipped?: boolean;
  on_site_skipped?: boolean;
  started_skipped?: boolean;
  /**
   * When the direct-send path last announced THIS trip. A dispatch marker, NOT a receipt: it says
   * an announcement occurrence happened, never that the customer received anything, and the
   * scheduling-notifications PRD forbids rendering it as one (the automation ledger is the
   * receipt). Declared because the API ships it; nothing on the job page reads it.
   *
   * Widened HERE and only here, the same rule as the two blocks above: there must not be a
   * second per-visit email-sent field for the two trees to disagree about.
   */
  customer_email_sent_at?: string | null;
  /**
   * Visit-location slice 4: where this trip is happening, in the three-state shape the booking
   * dialog seeds its "where" control from. The job twin of the lead response's
   * `walkthrough_location`, named for the surface it belongs to (D5).
   *
   * `null` is a FACT - this trip is at the job's service address. `undefined` means a cached
   * payload from before this shipped, and the dialog reads it the same way, because a form with
   * no seed has nothing better to offer than its default. The two are not the same claim, which
   * is why the key is optional rather than defaulted.
   *
   * Structurally the shared control's `StoredVisitLocation` (pages/v2/_shared/visitLocationField),
   * stated here rather than imported: `lib/` does not reach into `pages/`, and the two are checked
   * against each other every time `seedVisitLocation` is handed one of these.
   */
  visit_location?: {
    location_id: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
}

/**
 * The one instant a visit row should show beside its status: the latest thing that actually
 * happened to it. Null for a trip nobody has left for yet, whose only interesting time is the
 * booking itself.
 */
export function latestVisitStamp(v: JobVisitRow): string | null {
  return v.cancelled_at ?? v.completed_at ?? v.started_at ?? v.on_site_at ?? v.en_route_at ?? null;
}

/** "Dana Ruiz", or the empty string when the row carries no usable name. */
export function crewMemberName(member: VisitCrewMember): string {
  return [member.user.first_name, member.user.last_name].filter(Boolean).join(' ').trim();
}

/**
 * S5: the lifecycle verb vocabulary, moved HERE from the Visits cards, where it existed as two
 * byte-identical copies (one of them on the since-deleted v1 job page). The lifecycle bar renders
 * the same rule, and #1551 is the standing proof of what another copy would cost.
 *
 * `VisitAction` and `VisitMilestoneAction` live here rather than in useVisitLifecycle so this
 * module can own `VISIT_ACTIONS` without the cycle
 * lib/visits -> useVisitLifecycle -> useJobVisits -> lib/visits. useVisitLifecycle re-exports
 * both, so no existing caller changes.
 */
export type VisitAction = 'en-route' | 'arrive' | 'start' | 'complete' | 'cancel';

/** The four milestone verbs - every lifecycle verb except the one that carries a body. */
export type VisitMilestoneAction = Exclude<VisitAction, 'cancel'>;

/** The Job abilities the four per-visit routes are gated on. */
export type VisitVerb = 'en_route' | 'arrive' | 'start';

export const VISIT_ACTIONS: { action: VisitMilestoneAction; label: string; from: string[]; needs: VisitVerb }[] = [
  // `needs` names the ability THAT ROUTE is gated on (backend/src/routes/job.routes.ts), which is
  // not the same one for all four: complete rides `start Job`, and en-route has its own verb that
  // the default TECHNICIAN role does not hold. Gating the whole row on one flag rendered an "En
  // route" button for every crewed technician whose POST then 403'd - and useVisitLifecycle has no
  // onError, so the button simply appeared to do nothing.
  //
  // Labels are IMPERATIVE (scheduling-notifications slice 09, story 20): a button reading "On
  // site" beside a status chip reading "On Site" was taken for the visit's state, not a command.
  { action: 'en-route', label: 'Mark on the way', from: ['SCHEDULED'], needs: 'en_route' },
  { action: 'arrive', label: 'Mark on site', from: ['SCHEDULED', 'EN_ROUTE'], needs: 'arrive' },
  { action: 'start', label: 'Start work', from: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE'], needs: 'start' },
  { action: 'complete', label: 'Complete', from: ['EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'], needs: 'start' },
];

/**
 * What this principal may drive on a visit in `status`, in lifecycle order. A finished or
 * cancelled trip offers nothing - it is history (D19).
 *
 * The gate's honest limit, recorded rather than worked around: the ability answers from
 * `job.assignees`, which since S3 is the UNION across every visit, so a technician crewed only on
 * visit 3 is offered visit 1's controls and the API's per-visit check (D7a) will 403 them.
 * Building a second, visit-aware authorization engine in the client is the wrong fix; the right
 * one is repointing the stored OWN_JOB condition at the visits path, which the S3 migration
 * header already assigns to S8.
 */
export function availableActions(status: string, abilities: Partial<Record<VisitVerb, boolean>>) {
  return VISIT_ACTIONS.filter((a) => a.from.includes(status) && abilities[a.needs]);
}

export type VisitStep = (typeof VISIT_ACTIONS)[number];

/**
 * Slice 09: the row's ONE next step, and the later milestones it may jump to.
 *
 * `primary` is the first permitted verb in lifecycle order; `skipTo` is every permitted verb
 * after it. The split is derived from `availableActions` rather than from a second list so the
 * two renderers (the Visits card and the lifecycle rail) cannot disagree about which verb comes
 * first for a viewer who lacks an earlier one: a technician without `en_route` gets "Mark on
 * site" as primary and "Start work" behind Skip to, not an empty primary slot.
 */
export function nextVisitStep(status: string, abilities: Partial<Record<VisitVerb, boolean>>): {
  primary: VisitStep | null;
  skipTo: VisitStep[];
} {
  const [primary = null, ...skipTo] = availableActions(status, abilities);
  return { primary, skipTo };
}

export interface VisitMilestoneStamp {
  milestone: 'en_route' | 'on_site' | 'started' | 'completed';
  label: string;
  at: string;
  /** Slice 08: stamped with a later tap's instant, never tapped itself (story 23). */
  skipped: boolean;
}

/**
 * Slice 09: every milestone this trip has reached, in lifecycle order, each saying whether it
 * was tapped or skipped. The row's stamps line renders this list; `latestVisitStamp` above
 * answers the narrower "when did something last happen" and stays for its other readers.
 *
 * Labels are the milestone NAMES ("On the way", "On site"), not the imperative button labels
 * and not the registry's status words: a stamp is a thing that happened, a button is a thing to
 * do, and a status is where the trip is now.
 */
export function visitMilestoneStamps(v: JobVisitRow): VisitMilestoneStamp[] {
  const out: VisitMilestoneStamp[] = [];
  if (v.en_route_at) out.push({ milestone: 'en_route', label: 'On the way', at: v.en_route_at, skipped: v.en_route_skipped === true });
  if (v.on_site_at) out.push({ milestone: 'on_site', label: 'On site', at: v.on_site_at, skipped: v.on_site_skipped === true });
  if (v.started_at) out.push({ milestone: 'started', label: 'Started', at: v.started_at, skipped: v.started_skipped === true });
  if (v.completed_at) out.push({ milestone: 'completed', label: 'Completed', at: v.completed_at, skipped: false });
  return out;
}
