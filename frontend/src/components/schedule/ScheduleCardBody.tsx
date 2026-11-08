/**
 * The one schedule-card body, shared by MemberWeekBoard's BoardCard and TechnicianGridView's
 * JobCard.
 *
 * Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S0b. Both cards
 * carried a byte-identical inner column - time range, number/label + badge row, title, customer,
 * address, tag chips - including the same `isWalk ? customer : title` branch in two places. Under
 * multi-visit that branch has to change in every renderer at once, and #1551 is the standing proof
 * of what happens when a duplicated schedule surface is edited in only one of its copies: the v2
 * tree silently reverted a shipped v1 fix. Collapsing it first turns that class of edit into one
 * edit.
 *
 * The wrapper stays with each card: the two genuinely differ there (the grid view is absolutely
 * positioned at a caller-supplied top/height inside an overflow-hidden lane, the week board is
 * content-sized), and forcing one wrapper would mean threading layout props that only one caller
 * ever uses. What is shared is the CONTENT and the colour/danger resolution - which is exactly what
 * multi-visit needs to change.
 *
 * The spec's evidence section claimed three renderers carried this branch; re-derived on
 * 2026-08-17 there are two - `UnassignedBuckets` renders sidebar rows, not event cards. The spec
 * explicitly says to re-derive these counts rather than trust them.
 *
 * CORRECTED 2026-08-19, by driving the real board rather than re-reading the code: two renderers
 * carry THIS BODY, but three renderers paint schedule cards. `ScheduleEvent` in
 * pages/v2/schedule/SchedulePage paints the Standard week view - the board a dispatcher lands on
 * first - from its own JSX, and it was missed because it imports nothing from here. So "collapsed
 * into one body" is not the same claim as "one place to edit a card": anything a dispatcher must
 * read on EVERY board (the S6 visit label was the first) belongs in scheduleModel as a shared
 * derivation both bodies call, not in this file's JSX. See visitLabel there, and the all-three
 * drift guard at the bottom of ScheduleCardBody.test.tsx.
 */
import React from 'react';
import { format } from 'date-fns';
import { MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TagChips } from '@/components/data/TagChips';
import { NeedsCrewMark } from './NeedsCrewMark';
import {
  eventDangerState, isCompletedEvent, boardCardScheme, visitLabel, IN_FLIGHT_STATUSES, boardEventStatus,
  type BoardEvent, type ScheduledBoardEvent, type EventDangerState, type BoardCardScheme,
} from './scheduleModel';

/**
 * Everything both cards derive from an event before they can paint it. Resolved once here so the
 * two boards cannot disagree about what "in progress" or "needs crew" looks like.
 */
export interface ScheduleCardVisual {
  needsCrew: boolean;
  doubleBooked: boolean;
  isCompleted: boolean;
  isInProgress: boolean;
  isGhost: boolean;
  scheme: BoardCardScheme;
}

export function scheduleCardVisual(event: BoardEvent, dangerState: EventDangerState): ScheduleCardVisual {
  const status = boardEventStatus(event);
  const isCompleted = isCompletedEvent(event);
  const isInProgress = IN_FLIGHT_STATUSES.has(status ?? '');
  return {
    // The two exception states (precedence pre-resolved in eventDangerState; ghosts come back null).
    needsCrew: dangerState === 'needs-crew',
    doubleBooked: dangerState === 'double-booked',
    isCompleted,
    isInProgress,
    isGhost: event.isGhost ?? false,
    // Board-card scheme: a THREE-axis treatment, not a status badge. Precedence is exception
    // state first (double-booked amber outline on the wrapper; needs-crew is a corner notch the
    // body mounts, which leaves the scheme paint alone), then completed / in-progress status,
    // then the event-type accent from EVENT_TYPE_META (the ev-* tokens, org-recolourable). Red is
    // reserved for needs-crew alone.
    //
    // This deliberately does NOT resolve through STATUS_REGISTRY. The registry models a single
    // status axis, and this board inverts it on two of its values: completed reads neutral grey
    // here where the registry says success, and the three in-flight statuses read green here
    // where the registry says warning. Resolving per-status through the registry would repaint
    // every scheduled block and delete the event-type language the board legend advertises.
    scheme: boardCardScheme(event.type, isCompleted, isInProgress),
  };
}

/** The shared half of each card's wrapper className - the danger/scheme paint, not the layout. */
export function scheduleCardPaintClass(v: ScheduleCardVisual): string {
  // Double-booked: an AMBER frame (D7, re-hued 2026-09-14). It was red until the needs-crew
  // signal became the corner notch; two red edge treatments for two different problems was a
  // legend nobody would retain, so red now means exactly one thing on this board.
  // The frame goes ON TOP of the card's own paint (2026-09-30): the card keeps its type surface,
  // text and left bar, and a 2px amber outline is inset over all four edges - the same frame the
  // Standard board paints (boardEventPaint). It used to swap the card for a white one, which threw
  // away the one colour telling a dispatcher what the card was. The amber clears 3:1 against every
  // derived surface and against the board. An outline changes no geometry.
  if (v.doubleBooked) {
    // `[outline-style:solid]` rather than `outline`: cn's tailwind-merge drops `outline` beside
    // `outline-2` (one conflict group), which would leave no frame. See boardEventPaint.
    return cn(v.scheme.bg, 'border-l-4', v.scheme.accent, '[outline-style:solid] outline-2 outline-warning -outline-offset-2');
  }
  // Needs-crew no longer paints here at all. It used to be a solid red FILL, which erased the
  // type accent - and the type accent is now the org's own colour choice (EVENT_TYPE_META), so a
  // red job and a red walkthrough were the same card. The state is carried by NeedsCrewMark, an
  // absolutely positioned notch the body mounts below; the card keeps its scheme paint.
  return cn(v.scheme.bg, v.scheme.accent, v.isGhost ? 'border-l-4 border-dashed' : 'border-l-4');
}

/**
 * The wrapper style both cards merge their layout onto. EMPTY since 2026-09-30, and kept as the
 * seam rather than deleted: completed (0.5) and ghost (0.55) used to fade the whole card, which
 * pulled every text row under WCAG AA however well its colours were chosen. Completed now reads
 * as done through its grey scheme (boardCardScheme) and a ghost through its dashed bar and "draft"
 * badge. Anything added here must not lower text contrast.
 */
export function scheduleCardOpacityStyle(_v: ScheduleCardVisual): React.CSSProperties {
  return {};
}

/**
 * A walkthrough's address comes off the denormalized lead fields; a job's off its
 * service_location relation. Spelled once so multi-visit only has to repoint it once.
 *
 * Visit-location slice 6: the TRIP'S OWN location wins over the parent's, because since slice 1 a
 * visit can be booked somewhere the parent is not - and a card painting the customer's street on a
 * trip booked at the yard is not a missing fact but a wrong one, which is what routes a crew to the
 * wrong side of town. The string is the API's, already resolved by the same function the customer's
 * confirmation email renders from; nothing here re-derives it.
 */
export function cardAddressText(event: BoardEvent): string {
  if (event.locationLabel) return event.locationLabel;
  if (event.type === 'walkthrough') {
    return [event.raw.service_address_line1, event.raw.service_city, event.raw.service_state]
      .filter(Boolean).join(', ');
  }
  const location = event.raw.service_location as { address?: string; city?: string; state?: string } | null;
  if (!location) return '';
  return location.address
    ? `${location.address}, ${location.city ?? ''}`
    : [location.city, location.state].filter(Boolean).join(', ');
}

export interface ScheduleCardBodyProps {
  /** Narrowed to the placed variant: the body formats start/end, which are non-null only here. */
  event: ScheduledBoardEvent;
  visual: ScheduleCardVisual;
  /**
   * The grid view hides chips on sub-hour cards (it is absolutely positioned inside an
   * overflow-hidden wrapper, so unconditional content clips); the week board is content-sized and
   * always shows them. Caller's call, because only the caller knows its own height budget.
   */
  showTags?: boolean;
  /** Extra content below the shared body - the grid view's rich-media device slot. */
  children?: React.ReactNode;
}

export function ScheduleCardBody({ event, visual, showTags = true, children }: ScheduleCardBodyProps) {
  const { needsCrew, doubleBooked, isInProgress, isCompleted, isGhost, scheme } = visual;
  // A completed card is a SOLID mid-grey (boardCardScheme): the near-black title and the red
  // needs-crew words that sit on every pale card would fail AA on it, so there they take the
  // scheme's own on-solid text like every other row.
  const titleText = isCompleted ? scheme.text : 'text-text-primary';
  const needsCrewText = isCompleted ? scheme.text : 'text-danger-text';
  const isWalk = event.type === 'walkthrough';
  const addressText = cardAddressText(event);
  // The org's own job-type label (Organization.job_type_options), straight off the job row. Only a
  // job has one: a walkthrough is a lead and a calendar entry is not a job.
  const jobType = !isWalk && typeof event.raw.job_type === 'string' ? event.raw.job_type : '';

  return (
    <>
      {/* The needs-crew signal. Absolutely positioned against the (relative) wrapper, so it
          takes no room from any row below - see NeedsCrewMark for why that is the whole point. */}
      {needsCrew && <NeedsCrewMark />}
      {/* Ghost draft label */}
      {isGhost && (
        <span className="absolute top-1 right-1.5 text-[8px] font-bold uppercase tracking-wider
                         text-info-text bg-info-surface px-1 py-0.5 rounded leading-none">
          draft
        </span>
      )}

      {/* Time range. Every secondary row below paints in the scheme's text colour: it clears
          4.5:1 on the card's surface by construction, where the neutral greys these rows used
          (text-soft 2.5:1, text-secondary 3.9-4.2:1 on the derived surfaces) did not. */}
      <p className={cn(
        'text-[10px] leading-none whitespace-nowrap font-medium', scheme.text,
      )}>
        {format(event.start, 'h:mm a')} – {format(event.end, 'h:mm a')}
      </p>

      {/* Job number / label + badges */}
      <div className="flex items-center gap-1 flex-wrap min-w-0">
        <span className={cn('text-[11px] font-bold truncate leading-none', scheme.text)}>
          {/* Never `|| event.boardId`: since multi-visit S6 the board id is `jv-<uuid>`, so the
              old fallback would print a UUID on the card. A number-less event shows nothing. */}
          {isWalk ? 'Walkthrough' : event.number}
        </span>
        {/* D13 - which trip this is. Both the condition and the wording come from visitLabel
            in scheduleModel, because the Standard week board renders through a THIRD card
            component that shares no JSX with this one and must say the same words. Only the
            styling below is this renderer's own. */}
        {visitLabel(event) && (
          <span className={cn(
            'text-[9px] font-medium shrink-0 leading-none', scheme.text,
          )}>
            {visitLabel(event)}
          </span>
        )}
        {isWalk && event.number && (
          <span className={cn('text-[9px] font-medium shrink-0 leading-none', scheme.text)}>{event.number}</span>
        )}
        {/* danger-TEXT, not the notch's --understaffed: the notch is a shape (3:1 is its bar),
            these are 9px words, and --danger measures 3.8-4.1:1 on the derived surfaces where
            the text step of the same red clears 4.5. */}
        {needsCrew && (
          <span className={cn('text-[9px] font-bold uppercase tracking-wider shrink-0 leading-none', needsCrewText)}>
            needs crew
          </span>
        )}
        {/* No visible mark - same call as the Standard board's cards (see DoubleBookedLabel
            there). The 2px outline on the wrapper is the whole signal; this keeps the state's
            NAME for a screen reader and for the board tests, and the conflict modal still
            spells the overlap out. */}
        {doubleBooked && <span className="sr-only">Double-booked</span>}
        {isInProgress && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full
                           bg-success-surface text-success-text shrink-0 leading-none">
            In Progress
          </span>
        )}
      </div>

      {/* Title (scope-first for jobs; customer for walkthroughs - their title repeats the header) */}
      <p className={cn(
        'text-xs font-semibold truncate leading-tight', titleText,
      )}>
        {isWalk ? event.customer : (event.title || event.customer)}
      </p>
      {!isWalk && event.customer && event.customer !== event.title && (
        <p className={cn('text-[11px] truncate leading-tight', scheme.text)}>
          {event.customer}
        </p>
      )}

      {/* Job type, above the address (owner, 2026-09-14) */}
      {jobType && (
        <p className={cn('text-[10px] truncate leading-none', scheme.text)}>{jobType}</p>
      )}

      {/* Address */}
      {addressText && (
        <p className={cn('text-[10px] flex items-center gap-0.5 min-w-0 leading-none', scheme.text)}>
          <MapPin className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{addressText}</span>
        </p>
      )}

      {/* SRVW-58 tag chips */}
      {showTags && <TagChips tags={event.tags} max={2} />}

      {children}
    </>
  );
}

/** Re-exported so callers need one import for the whole card-painting vocabulary. */
export { eventDangerState };
