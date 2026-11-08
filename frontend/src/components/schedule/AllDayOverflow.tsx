/**
 * All-day strip overflow — the `+N more` chip and its day panel.
 *
 * Spec: md_files/plans/scheduler/2026-08-24-allday-strip-overflow-spec.md
 *
 * The strip is capped at three rows (`allDayMaxRows={ALL_DAY_MAX_ROWS}` on the
 * calendar). Everything past the cap collapses into a `+N more` chip, which is a
 * *disclosure*, not a record: N stands for N things, so it can never resolve to
 * one. It opens a disambiguation list (Layer 1); a row in that list opens the
 * event editor (Layer 2).
 *
 * Interaction — hover previews, click pins:
 *   hover 350ms      → transient panel
 *   mouse out 200ms  → transient panel closes (hovering the panel cancels this,
 *                      WCAG 2.1 SC 1.4.13 "hoverable")
 *   click            → pins; survives mouse-out, and clicking again keeps it
 *   keyboard focus   → opens pinned (a keyboard user has no mouse-out)
 *   Esc / outside    → closes either way ("dismissible")
 * Click pins rather than toggles because with hover already opening the panel, a
 * toggling click would close the panel under the cursor and then reopen it on the
 * next mouse jiggle.
 */
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { format } from 'date-fns';
import { customerDisplayName } from '@/lib/customer-name';
import { cn } from '@/lib/utils';
import { visitLabel, type BoardEvent } from './scheduleModel';

/**
 * react-big-calendar reads this as `maxRows = allDayMaxRows + 1`, where the `+1`
 * is the row that carries the `+N more` chip (TimeGridHeader.js). So **2 here
 * means a three-row strip**: two full rows plus a final row that shows an event
 * when only one lands in it and the chip when several do. Do not "fix" this to 3.
 */
export const ALL_DAY_MAX_ROWS = 2;

const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 200;
const PANEL_WIDTH = 288;

export interface AllDayOverflowState {
  date: Date;
  /** The whole day column, not just the hidden items — see the spec, §5. */
  events: BoardEvent[];
  x: number;
  y: number;
  pinned: boolean;
}

interface OverflowApi {
  hoverIn: (events: BoardEvent[], date: Date, rect: DOMRect) => void;
  hoverOut: () => void;
  keepOpen: () => void;
  pinAt: (events: BoardEvent[], date: Date, rect: DOMRect) => void;
  close: () => void;
}

const noop: OverflowApi = {
  hoverIn: () => {}, hoverOut: () => {}, keepOpen: () => {}, pinAt: () => {}, close: () => {},
};

const AllDayOverflowCtx = createContext<OverflowApi>(noop);

export const AllDayOverflowProvider = AllDayOverflowCtx.Provider;

/**
 * The overflow state machine. Lives on the page so the panel and the chip share
 * one set of timers — the panel must be able to cancel a close the chip started.
 */
export function useAllDayOverflow(isDragging: () => boolean) {
  const [state, setState] = useState<AllDayOverflowState | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // scheduleClose() runs from a timer callback, so it cannot read `state`.
  const pinnedRef = useRef(false);

  const clearOpen = () => {
    if (openTimer.current !== null) { clearTimeout(openTimer.current); openTimer.current = null; }
  };
  const clearClose = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  const close = useCallback(() => {
    clearOpen(); clearClose();
    pinnedRef.current = false;
    setState(null);
  }, []);

  const openAt = useCallback((events: BoardEvent[], date: Date, rect: DOMRect, pinned: boolean) => {
    clearOpen(); clearClose();
    pinnedRef.current = pinned;
    setState({
      events, date, pinned,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
      y: rect.bottom + 4,
    });
  }, []);

  const api = useMemo<OverflowApi>(() => ({
    hoverIn: (events, date, rect) => {
      if (isDragging()) return;          // a drag in flight suppresses hover entirely
      clearClose(); clearOpen();
      openTimer.current = window.setTimeout(() => openAt(events, date, rect, false), HOVER_OPEN_MS);
    },
    hoverOut: () => {
      clearOpen();
      if (pinnedRef.current) return;     // a pinned panel ignores mouse-out
      clearClose();
      closeTimer.current = window.setTimeout(() => { setState(null); }, HOVER_CLOSE_MS);
    },
    keepOpen: () => clearClose(),
    pinAt: (events, date, rect) => openAt(events, date, rect, true),
    close,
  }), [isDragging, openAt, close]);

  // Dismissible (SC 1.4.13) — Esc closes a pinned panel too.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  // A drag started after the panel opened closes it — hoverIn's guard only covers
  // the case where the drag was already in flight.
  useEffect(() => {
    if (!state) return;
    const onDragStart = () => close();
    document.addEventListener('dragstart', onDragStart, true);
    return () => document.removeEventListener('dragstart', onDragStart, true);
  }, [state, close]);

  useEffect(() => () => { clearOpen(); clearClose(); }, []);

  return { state, api, close };
}

/**
 * The label a panel row shows: number, em dash, customer. The em dash is `EM` from
 * pages/v2/schedule/glyphs.ts, U+2014; the page's e2e selectors match on rendered text
 * rather than testids.
 *
 * Deliberately FULLER than the pill it stands in for, and no longer a mirror of it. The pill
 * was measured at 96.3px against this 254px string, so it now carries the bare number; this
 * panel is 288px and is where the customer name is actually legible. Reading the two as "one
 * must match the other" is what made the pill unreadable in the first place.
 *
 * Which TRIP it is deliberately is NOT in this string: the row renders `visitLabel(e)` as a
 * separate shrink-0 sibling, so the one thing that tells two visits of one job apart survives
 * the truncation that eats the customer name. The panel keeps the full sentence
 * (`Visit 2 of 5`); only the pill abbreviates it, via visitLabelCompact.
 *
 * Slice 03 (calendar-entries spec \u00a72, ADR 0002) - a calendar entry crossing midnight lands
 * in this strip TODAY, with no `is_all_day` flag required: `occupiesAllDayStrip` mirrors
 * react-big-calendar's own `!isSameDay(start, end)` routing, independent of the flag, and
 * that predicate is already live. An entry carries no record number and no customer (\u00a72 -
 * the card renders the title alone), so it gets its own branch rather than falling through
 * the `job ? ... : ...` ternary below - the fall-through silently means "walkthrough", which
 * is exactly wrong for a fourth type: it printed "Walkthrough \u2014 " (dangling em dash, empty
 * customer) for an entry with neither a `lead_number` nor a `raw.customer`. Checked first so
 * this NEVER reaches that fallback. `ScheduleEvent`'s own calendar-entry branch in
 * SchedulePage.tsx returns before its occupiesAllDayStrip check for the identical reason, so
 * the two agree here: title alone, in both places, for every calendar entry.
 */
export function allDayEventLabel(e: BoardEvent): string {
  if (e.type === 'calendar-entry') return e.title;
  const customer = e.raw?.customer as { first_name: string; last_name: string } | null;
  const customerName = customer ? customerDisplayName(customer, '') : '';
  // NOT-job still reads as "walkthrough" below - a pre-existing gap (service-plan already hit
  // it, silently, before calendar entries existed) this slice does not widen further. Making
  // the branch a type-safe drive-by fix here is out of scope; a calendar entry is excluded
  // above precisely so it cannot fall into the same trap a fourth type would otherwise repeat.
  return e.type === 'job'
    ? `${e.raw?.job_number as string} \u2014 ${customerName}`
    : `${(e.raw?.lead_number as string) ?? 'Walkthrough'} \u2014 ${customerName}`;
}

/**
 * `components.showMore` override. react-big-calendar hands us the whole day
 * column in `events` and the hidden subset in `remainingEvents`; the count comes
 * from the hidden subset, the panel lists the whole day.
 *
 * Supplying this bypasses rbc's own `onShowMore` wiring, which is what we want —
 * rbc does not forward the anchor element, and this chip owns its own ref.
 */
export function AllDayShowMore({
  count, events, slotDate,
}: { count: number; events: object[]; slotDate: Date }) {
  const api = useContext(AllDayOverflowCtx);
  const ref = useRef<HTMLButtonElement>(null);
  const rect = () => ref.current?.getBoundingClientRect() ?? null;
  const board = events as BoardEvent[];

  return (
    <button
      ref={ref}
      type="button"
      className="rbc-button-link rbc-show-more schedule-allday-more"
      aria-haspopup="dialog"
      aria-label={`${count} more all-day items on ${format(slotDate, 'EEEE, MMMM d')}`}
      onMouseEnter={() => { const r = rect(); if (r) api.hoverIn(board, slotDate, r); }}
      onMouseLeave={() => api.hoverOut()}
      onFocus={() => { const r = rect(); if (r) api.pinAt(board, slotDate, r); }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = rect();
        if (r) api.pinAt(board, slotDate, r);   // pins; never toggles
      }}
    >
      +{count} more
    </button>
  );
}

/** Layer 1 — the day's all-day items. A row opens the editor (Layer 2). */
export function AllDayOverflowPanel({
  state, api, onSelect, styleFor, dangerFor,
}: {
  state: AllDayOverflowState | null;
  api: OverflowApi;
  onSelect: (event: BoardEvent) => void;
  /** The board's own card paint (the page's eventStyleGetter), so a row reads as the card it opens. */
  styleFor: (event: BoardEvent) => { className?: string; style?: React.CSSProperties };
  /**
   * The board's own danger derivation, handed down rather than repeated here: resolving the
   * two reds needs `conflictIds`, which lives on the page. Optional so a bare panel (tests,
   * a future host) still renders - it just says nothing about crew, which is honest.
   */
  dangerFor?: (event: BoardEvent) => 'needs-crew' | 'double-booked' | null;
}) {
  if (!state) return null;
  return (
    <div
      role="dialog"
      // The page dismisses its hand-positioned surfaces from one capturing
      // document `mousedown`; this attribute is how a surface says "the press
      // landed on me". See overlayDismiss.ts.
      data-schedule-overlay
      aria-label={`All-day items on ${format(state.date, 'EEEE, MMMM d')}`}
      className="fixed z-[70] rounded-lg border border-border bg-surface-light shadow-lg
                 overflow-hidden schedule-popup-enter"
      style={{ left: state.x, top: state.y, width: PANEL_WIDTH }}
      onMouseEnter={() => api.keepOpen()}
      onMouseLeave={() => api.hoverOut()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-border text-[11px] font-semibold uppercase
                      tracking-wide text-text-secondary">
        {format(state.date, 'EEEE, MMM d')} · all day
      </div>
      <div className="max-h-64 overflow-y-auto p-1.5 space-y-1">
        {state.events.map((e) => (
          // The row takes the card's className as well as its style: the style alone carried
          // only the shape, so every row was a plain white line whatever the card looked like.
          // The hover darkens the fill slightly instead of fading the row - opacity took the
          // text down with it.
          <button
            key={e.boardId}
            type="button"
            className={cn(
              'w-full text-left rounded px-2 py-1.5 text-[11px] font-semibold flex items-center gap-1',
              'hover:brightness-[0.97] transition-[filter]',
              styleFor(e).className,
            )}
            style={styleFor(e).style}
            onClick={(ev) => { ev.stopPropagation(); api.close(); onSelect(e); }}
          >
            <span className="truncate">{allDayEventLabel(e)}</span>
            {/* D13 - five visits of one job put five rows in here, and the label above is
                the same string for every one of them. A disambiguation list whose rows
                cannot be told apart has nothing to disambiguate. Same derivation, wording
                and silent-when-single condition as the pill and the timed card. */}
            {visitLabel(e) && (
              <span className="text-[10px] font-medium shrink-0">{visitLabel(e)}</span>
            )}
            {/* The crew warning's home. The strip pill cannot hold these words - 62.5px of a
                ~90px row, which is what cut one pill's job number down to `J0` - so the pill
                carries the red fill alone and the words live here, on the 288px surface. The
                cost is paid by the customer name: label 181px + trip 50px + this 62.5px
                exceeds the row's 272px of content box, so a long name now truncates. That is
                the right thing to spend: the row still opens with the job number, and "this
                job has nobody on it" is not information a dispatcher should have to hover to
                find. Wording and casing match the full card exactly - one sentence per fact,
                per D13's rule. */}
            {dangerFor?.(e) === 'needs-crew' && (
              <span className="text-[9px] font-bold uppercase tracking-wider shrink-0">
                needs crew
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
