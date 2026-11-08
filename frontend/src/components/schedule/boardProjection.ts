import type { SchedulableEvent } from './scheduleModel';
import { visitCrewPeopleOf, type VisitCrewRow } from './eventPeople';
import { toWallClock, addMsToWallClock, type WallClock } from '@/lib/schedule-tz';
import { visitDenominator } from '@/lib/visits';

/**
 * The board-event projection (visits-and-task-categories slice 02): a parent plus its visits in,
 * board cards out. ONE card per non-cancelled visit, each with a stable per-visit identity, the
 * visit's own crew, its "Visit n of m" and its own time.
 *
 * Pure and parent-agnostic on purpose. Job cards are built through it (eventAdapters.jobToEvents),
 * and lead walkthrough cards are meant to be (slice 03), so the two can never disagree about what
 * a visit card is. Everything that is the PARENT's - title, customer, owner, tags, `raw` - arrives
 * already built in `parent`; everything that is the TRIP's is read here, and nowhere else.
 *
 * This is the read boundary (schedule-tz.ts): every timestamp a visit carries is an Instant, and
 * crosses into the org zone's WallClock exactly here, through toWallClock.
 */

/**
 * One VISIT row as the board sees it. `scheduled_at` is deliberately spelled the way the API
 * spells it - the rename to `scheduled_start` is S8's, and widening this to accept both
 * spellings is what lib/visits.ts's header forbids.
 */
export interface BoardVisitRow {
  id: string;
  visit_seq?: number | null;
  status?: string | null;
  scheduled_at?: string | null;
  scheduled_end?: string | null;
  is_all_day?: boolean | null;
  /** Slice 6: this trip's own location, resolved by the API (jobListSelect + projectJobVisitLocations). */
  location_label?: string | null;
  /** This trip's own crew. Absent or empty = the trip is unassigned. */
  assignees?: VisitCrewRow[] | null;
}

/** What the parent contributes to every one of its cards - the card minus the trip's own facts. */
export type VisitCardParent = Omit<
  SchedulableEvent,
  'boardId' | 'start' | 'end' | 'isAllDay' | 'crew' | 'visitId' | 'visitSeq' | 'visitStatus' | 'visitCount' | 'locationLabel'
>;

export interface VisitCardOptions {
  tz: string;
  /** Prefixed onto the visit id to form the card's board id (`jv-` for a job's trips). */
  boardIdPrefix: string;
  /** The parent type's default length, used only when a visit carries no end of its own. */
  defaultDurationMin: number;
}

/**
 * The parent's cards, one per non-cancelled visit. Returns `[]` when no visit survives, and the
 * caller decides what a parent with no trip looks like (a job keeps its bare identity card).
 */
export function projectVisitCards(
  parent: VisitCardParent,
  visits: readonly BoardVisitRow[],
  opts: VisitCardOptions,
): SchedulableEvent[] {
  const live = visits.filter((v) => v.status !== 'CANCELLED');
  // "Visit 2 of 3": the total is the one rule the customer Schedule tab shares (lib/visits.ts).
  const visitCount = visitDenominator(live);

  return live.map((v) => {
    const start: WallClock | null = v.scheduled_at ? toWallClock(new Date(v.scheduled_at), opts.tz) : null;
    // F7: the end comes off the VISIT's own scheduled_end, so the drop modal seeds this trip's
    // duration rather than the parent default. The default is the fallback, not the rule.
    const end: WallClock | null = v.scheduled_end
      ? toWallClock(new Date(v.scheduled_end), opts.tz)
      : start
        ? addMsToWallClock(start, opts.defaultDurationMin * 60_000)
        : null;
    return {
      ...parent,
      boardId: `${opts.boardIdPrefix}${v.id}`,
      visitId: v.id,
      visitSeq: v.visit_seq ?? undefined,
      // This trip's own state, so the card is coloured by the trip rather than by the parent's
      // roll-up across all of them (MV-BOARD-10).
      visitStatus: v.status ?? undefined,
      visitCount,
      // The trip's own crew - which decides its card's names AND the Member-view lanes it sits in
      // (isOnBoardFor). An uncrewed trip is unassigned, whoever is on its siblings.
      crew: visitCrewPeopleOf(v).flatMap((p) => (p.id ? [p.id] : [])),
      // Slice 6: this trip's own location, not the parent's - the trips can be in different places.
      locationLabel: v.location_label ?? null,
      isAllDay: v.is_all_day ?? false,
      start,
      end,
    };
  });
}
