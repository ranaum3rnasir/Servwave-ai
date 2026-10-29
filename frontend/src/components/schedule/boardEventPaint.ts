/**
 * What the Standard board paints one react-big-calendar event as - the body of the page's
 * `eventStyleGetter`, pulled out so the paint can be tested without mounting the whole page.
 * It lives here, beside scheduleModel, rather than in pages/v2/schedule/ because the Schedule
 * Colors settings preview paints its sample cards with it too, and one v2 page module may not
 * import from another (pages/v2/__tests__/moduleIsolation.test.ts).
 *
 * Every card colour here is one of the DERIVED card colours (tokens.css `--ev-*-surface / -text /
 * -border / -solid / -on-solid`, recomputed for the org's picks by useScheduleEventColorVars), not
 * the raw accent: the accent as text on a 10% tint of itself failed WCAG AA for most of the colours
 * an org can pick. Every text row on every card state below clears 4.5:1 against its fill, and
 * nothing fades a card with opacity - opacity is what took completed text to 1.7:1.
 *
 * The class names are spelled out in full, per type, because Tailwind's JIT only generates the
 * classes it can read in the source.
 */
import type React from 'react';
import type { EventType, EventDangerState } from './scheduleModel';

/** One type's card paint, as `!`-important classes (they must outrank .rbc-event's own colours). */
interface TypePaint {
  /** Surface + text + the 4px left bar in the type's colour. Double-booked adds the frame on top. */
  card: string;
  /** Custom-property names for the style-object paths (the plan-mode ghost). */
  vars: { surface: string; text: string; border: string };
}

const TYPE_PAINT: Record<EventType, TypePaint> = {
  job: {
    card: '!bg-ev-job-surface !text-ev-job-text !border-0 !border-l-4 !border-l-ev-job-border !border-solid',
    vars: { surface: '--ev-job-surface', text: '--ev-job-text', border: '--ev-job-border' },
  },
  walkthrough: {
    card: '!bg-ev-walkthrough-surface !text-ev-walkthrough-text !border-0 !border-l-4 !border-l-ev-walkthrough-border !border-solid',
    vars: { surface: '--ev-walkthrough-surface', text: '--ev-walkthrough-text', border: '--ev-walkthrough-border' },
  },
  'service-plan': {
    card: '!bg-ev-service-plan-surface !text-ev-service-plan-text !border-0 !border-l-4 !border-l-ev-service-plan-border !border-solid',
    vars: { surface: '--ev-service-plan-surface', text: '--ev-service-plan-text', border: '--ev-service-plan-border' },
  },
  'calendar-entry': {
    card: '!bg-ev-calendar-entry-surface !text-ev-calendar-entry-text !border-0 !border-l-4 !border-l-ev-calendar-entry-border !border-solid',
    vars: { surface: '--ev-calendar-entry-surface', text: '--ev-calendar-entry-text', border: '--ev-calendar-entry-border' },
  },
};

/**
 * Double-booked: a 2px amber (--warning) OUTLINE inset over all four edges of the card's own paint
 * (the owner-approved mock). An outline rather than a border so it changes no geometry, and inset
 * (-2px) so it paints over the card's edge - including the outer half of the 4px type bar, which
 * stays visible inside it. The `!` is load-bearing: schedule-dark.css gives every week/day card a
 * 1px surface-coloured outline (the hairline between stacked cards), and without it that hairline
 * wins and the frame reads as 1px. It used to be a border on three sides, which on an amber-typed
 * card (the default walkthrough) barely differed from a normal one.
 */
// `[outline-style:solid]`, not Tailwind's `outline`: tailwind-merge (cn) files `outline` and
// `outline-2` in one conflict group and silently drops `outline`, which leaves a width with no
// style - no frame at all - wherever this string passes through cn (member boards, all-day panel).
const DOUBLE_BOOKED_FRAME = '![outline-style:solid] !outline-2 !outline-warning !-outline-offset-2';

/**
 * In progress: a SOLID fill - the one card on the board that shouts. Derived from --info with the
 * solid rule (white text, the fill darkened just enough for white to clear 4.5; white on raw
 * --info was 3.68).
 */
const IN_PROGRESS = '!bg-ev-in-progress-solid !text-ev-in-progress-on-solid !border-0';
/**
 * Completed: the solid grey card it has always been, made readable. It used to be --text-soft at
 * 60% opacity with white text (2.90:1 before the fade); now the grey is darkened just enough for
 * white to clear 4.5:1 and nothing fades it. SOLID on purpose, and the same whatever the type:
 * every scheduled card is a pale tint, so no colour an org picks can make a done card look like
 * an upcoming one (a pale grey tint did exactly that next to a Slate job).
 */
const COMPLETED = '!bg-ev-completed-solid !text-ev-completed-on-solid !border-0';

export interface BoardEventPaintInput {
  type: EventType;
  isGhost: boolean;
  completed: boolean;
  inFlight: boolean;
  dangerState: EventDangerState;
  /** The search-highlight style, merged onto every state: a card is found whatever it is painted as. */
  highlight: React.CSSProperties;
  /** Calendar entries only: whether this viewer may drag it (drives the cursor, nothing else). */
  canDragCalendarEntry: boolean;
}

export interface BoardEventPaint {
  className?: string;
  style: React.CSSProperties;
}

const CARD_STYLE: React.CSSProperties = {
  borderRadius: '6px',
  padding: '4px 8px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
};

export function boardEventPaint(input: BoardEventPaintInput): BoardEventPaint {
  const { type, isGhost, completed, inFlight, dangerState, highlight, canDragCalendarEntry } = input;
  const paint = TYPE_PAINT[type] ?? TYPE_PAINT.job;

  // Plan-mode ghost: the confirmed card of its type, dashed. Previewing the thing it will become
  // rather than introducing a colour meaning at drop time. It used to fade to 0.7 opacity as well,
  // which took its text under AA; the dashed frame and the "draft" badge already say "not real yet".
  if (isGhost) {
    return {
      style: {
        background: `rgb(var(${paint.vars.surface}))`,
        border: `2px dashed rgb(var(${paint.vars.border}))`,
        color: `rgb(var(${paint.vars.text}))`,
        borderRadius: '6px',
        padding: '4px 8px',
        cursor: 'grab',
      },
    };
  }

  // Double-booked: the card KEEPS its type surface, text and left bar, and gains the amber frame.
  // It used to become a plain white card with dark text - the one card on the board that lost the
  // colour telling a dispatcher what it was. The amber (--warning) measures >= 4.37:1 against every
  // derived surface and 5.02:1 against the white board, so the frame is visible on both sides.
  if (dangerState === 'double-booked') {
    return {
      className: `${paint.card} ${DOUBLE_BOOKED_FRAME}`,
      style: { ...CARD_STYLE, cursor: 'grab', ...highlight },
    };
  }

  // Calendar entry: its own muted type colour; never double-booked or needs-crew (eventDangerState
  // returns null for it), never completed or in progress.
  if (type === 'calendar-entry') {
    return {
      className: paint.card,
      style: { ...CARD_STYLE, cursor: canDragCalendarEntry ? 'grab' : 'default', ...highlight },
    };
  }

  // Status outranks type: a customised board keeps grey "done" and the solid in-progress fill;
  // only scheduled/upcoming cards take the org's colour. A walkthrough has no in-flight status.
  let className: string;
  if (completed) className = COMPLETED;
  else if (type !== 'walkthrough' && inFlight) className = IN_PROGRESS;
  else className = paint.card;

  return {
    className,
    style: { ...CARD_STYLE, cursor: completed ? 'default' : 'grab', ...highlight },
  };
}
