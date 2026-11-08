import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  ALL_DAY_MAX_ROWS,
  AllDayOverflowPanel,
  AllDayOverflowProvider,
  AllDayShowMore,
  allDayEventLabel,
  useAllDayOverflow,
} from '@/components/schedule/AllDayOverflow';
import type { BoardEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

// The all-day strip caps at three rows and folds the rest into a "+N more" chip.
// Spec: md_files/plans/scheduler/2026-08-24-allday-strip-overflow-spec.md
//
// The chip is a *disclosure*, not a toggle: hover previews, click pins. The pin
// is the part that breaks quietly — a panel that pins and then can never close
// is worse than no panel — so the transitions are what these tests hold down.

const DAY = new Date(2026, 7, 24); // 2026-08-24, a Monday

const ev = (id: string, jobNumber: string, first: string): BoardEvent => ({
  // Multi-visit S6 replaced `id` with boardId (per-card) + parentId (the row a
  // mutation addresses). These fixtures hold no visit row, so the two match.
  boardId: id,
  parentId: id,
  type: 'job',
  number: jobNumber,
  title: `Job ${jobNumber}`,
  customer: first,
  crew: [],
  ownerId: null,
  start: asWallClock(DAY),
  end: asWallClock(DAY),
  raw: { job_number: jobNumber, customer: { first_name: first, last_name: 'Doe' }, is_all_day: true },
});

const EVENTS = [ev('a', 'J00001', 'Ada'), ev('b', 'J00002', 'Bo'), ev('c', 'J00003', 'Cy')];

/** Minimal host: the real hook, the real chip, the real panel. */
function Harness({
  onSelect = () => {},
  dragging = false,
  events = EVENTS,
  count = 2,
  dangerFor,
}: {
  onSelect?: (e: BoardEvent) => void;
  dragging?: boolean;
  events?: BoardEvent[];
  count?: number;
  dangerFor?: (e: BoardEvent) => 'needs-crew' | 'double-booked' | null;
}) {
  const isDragging = React.useCallback(() => dragging, [dragging]);
  const { state, api } = useAllDayOverflow(isDragging);
  return (
    <AllDayOverflowProvider value={api}>
      <AllDayShowMore count={count} events={events} slotDate={DAY} />
      <AllDayOverflowPanel
        state={state}
        api={api}
        onSelect={onSelect}
        styleFor={() => ({ style: {} })}
        dangerFor={dangerFor}
      />
      <div data-testid="outside">outside</div>
    </AllDayOverflowProvider>
  );
}

const chip = () => screen.getByRole('button', { name: /more all-day items/i });
const panel = () => screen.queryByRole('dialog');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('all-day overflow chip', () => {
  it('counts the hidden items, not the whole day', () => {
    render(<Harness />);
    // 3 events in the day, 2 hidden → the chip says 2.
    expect(chip()).toHaveTextContent('+2 more');
  });

  it('the row cap constant is rbc-relative: 2 means three rows', () => {
    // react-big-calendar reads maxRows = allDayMaxRows + 1, the +1 being the row
    // that carries the chip. If someone "fixes" this to 3 the strip grows to four
    // rows and starts crushing the header again.
    expect(ALL_DAY_MAX_ROWS).toBe(2);
  });

  it('labels a row the way the pill does', () => {
    expect(allDayEventLabel(EVENTS[0]!)).toBe('J00001 \u2014 Ada Doe');
  });

  // Slice 03 (calendar-entries spec \u00a72) - a calendar entry crossing midnight lands in this
  // strip today (occupiesAllDayStrip mirrors rbc's !isSameDay routing, no is_all_day flag
  // required), and the fall-through in allDayEventLabel silently meant "walkthrough" - which
  // printed "Walkthrough \u2014 " (dangling em dash, empty customer) for an entry with
  // neither a lead_number nor a raw.customer. Title alone, exactly what ScheduleEvent's own
  // calendar-entry branch renders for the pill.
  it('a calendar entry gets its title alone \u2014 no "Walkthrough" fallback, no dangling em dash', () => {
    const entry: BoardEvent = {
      boardId: 'ce-1',
      parentId: 'entry-1',
      type: 'calendar-entry',
      number: '',
      title: 'Dave is off Mon-Fri',
      customer: '',
      crew: [],
      ownerId: null,
      start: asWallClock(DAY),
      end: asWallClock(DAY),
      raw: { id: 'entry-1', title: 'Dave is off Mon-Fri' },
    };
    const label = allDayEventLabel(entry);
    expect(label).toBe('Dave is off Mon-Fri');
    expect(label).not.toContain('Walkthrough');
    expect(label).not.toContain('\u2014'); // no em dash \u2014 no record-number/customer segment at all
  });
});

describe('hover previews', () => {
  it('opens only after the 350ms dwell', () => {
    render(<Harness />);
    fireEvent.mouseEnter(chip());
    advance(340);
    expect(panel()).not.toBeInTheDocument();
    advance(20);
    expect(panel()).toBeInTheDocument();
  });

  it('a pass-through does not open it', () => {
    render(<Harness />);
    fireEvent.mouseEnter(chip());
    advance(200);
    fireEvent.mouseLeave(chip());
    advance(400);
    expect(panel()).not.toBeInTheDocument();
  });

  it('closes on mouse-out after the grace period', () => {
    render(<Harness />);
    fireEvent.mouseEnter(chip());
    advance(350);
    fireEvent.mouseLeave(chip());
    advance(190);
    expect(panel()).toBeInTheDocument(); // still inside the grace window
    advance(20);
    expect(panel()).not.toBeInTheDocument();
  });

  it('stays open while the pointer is on the panel (WCAG 1.4.13 hoverable)', () => {
    render(<Harness />);
    fireEvent.mouseEnter(chip());
    advance(350);
    fireEvent.mouseLeave(chip());
    advance(100);            // heading for the panel, inside the grace window
    fireEvent.mouseEnter(panel()!);
    advance(1000);
    expect(panel()).toBeInTheDocument();
  });

  it('is suppressed while a drag is in flight', () => {
    render(<Harness dragging />);
    fireEvent.mouseEnter(chip());
    advance(1000);
    expect(panel()).not.toBeInTheDocument();
  });
});

describe('click pins', () => {
  it('survives mouse-out', () => {
    render(<Harness />);
    fireEvent.click(chip());
    expect(panel()).toBeInTheDocument();
    fireEvent.mouseLeave(chip());
    advance(1000);
    expect(panel()).toBeInTheDocument();
  });

  it('a second click keeps it open rather than toggling it shut', () => {
    render(<Harness />);
    fireEvent.click(chip());
    fireEvent.click(chip());
    expect(panel()).toBeInTheDocument();
  });

  it('keyboard focus opens it pinned', () => {
    render(<Harness />);
    fireEvent.focus(chip());
    expect(panel()).toBeInTheDocument();
    fireEvent.mouseLeave(chip());
    advance(1000);
    expect(panel()).toBeInTheDocument();
  });

  it('Escape dismisses a pinned panel', () => {
    render(<Harness />);
    fireEvent.click(chip());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).not.toBeInTheDocument();
  });

  it('a drag starting after it opened closes it', () => {
    render(<Harness />);
    fireEvent.click(chip());
    fireEvent.dragStart(screen.getByTestId('outside'));
    expect(panel()).not.toBeInTheDocument();
  });
});

describe('the panel', () => {
  it('lists the whole day, not just the hidden items', () => {
    render(<Harness />);
    fireEvent.click(chip());
    // Chip says "+2 more" but all three of the day's items are listed — a "+1 more"
    // panel showing one row would be a disambiguation list with nothing to
    // disambiguate.
    expect(screen.getByText('J00001 — Ada Doe')).toBeInTheDocument();
    expect(screen.getByText('J00002 — Bo Doe')).toBeInTheDocument();
    expect(screen.getByText('J00003 — Cy Doe')).toBeInTheDocument();
  });

  // D13. The fixture that found this on staging: one job booked five times on the one
  // day, so `allDayEventLabel` returned the SAME string five times and the panel listed
  // five rows nobody could tell apart - a disambiguation list with nothing to
  // disambiguate, which is the whole reason the panel exists.
  it('numbers the trips when the rows are visits of one job', () => {
    const visits = [1, 2, 3, 4, 5].map((n) => ({
      ...ev(`v${n}`, 'J00314', 'Ada'),
      visitId: `v${n}`,
      visitSeq: n,
      visitCount: 5,
    }));
    render(<Harness events={visits} count={3} />);
    fireEvent.click(chip());

    expect(screen.getAllByText('J00314 — Ada Doe')).toHaveLength(5);
    [1, 2, 3, 4, 5].forEach((n) => {
      expect(screen.getByText(`Visit ${n} of 5`)).toBeInTheDocument();
    });
  });

  it('says nothing about trips when each row is its own job', () => {
    render(<Harness />);
    fireEvent.click(chip());
    expect(screen.queryByText(/Visit \d/)).not.toBeInTheDocument();
  });

  // The crew warning's only home now: the strip pill cannot hold 62.5px of words in a ~90px
  // row without eating the job number, so it carries the red fill and the panel carries the
  // sentence. Before this the words were nowhere - a red pill with no stated reason.
  it('spells out a crew warning the pill can only colour', () => {
    render(<Harness dangerFor={(e) => (e.boardId === 'b' ? 'needs-crew' : null)} />);
    fireEvent.click(chip());

    const rows = screen.getAllByRole('button').filter((b) => /J0000/.test(b.textContent ?? ''));
    expect(rows.find((r) => /J00002/.test(r.textContent!))).toHaveTextContent(/needs crew/i);
    expect(rows.find((r) => /J00001/.test(r.textContent!))).not.toHaveTextContent(/needs crew/i);
  });

  it('says nothing about crew when the host offers no derivation', () => {
    // dangerFor omitted - a panel with no opinion must not invent one.
    render(<Harness />);
    fireEvent.click(chip());
    expect(screen.queryByText(/needs crew/i)).not.toBeInTheDocument();
  });

  it('does not mistake a double-booking for a missing crew', () => {
    render(<Harness dangerFor={() => 'double-booked'} />);
    fireEvent.click(chip());
    expect(screen.queryByText(/needs crew/i)).not.toBeInTheDocument();
  });

  it('names the day it belongs to', () => {
    render(<Harness />);
    fireEvent.click(chip());
    expect(panel()).toHaveAccessibleName(/Monday, August 24/i);
  });

  it('a row opens the editor and closes the panel (Layer 2 replaces Layer 1)', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByText('J00002 — Bo Doe'));
    expect(onSelect).toHaveBeenCalledWith(EVENTS[1]!);
    expect(panel()).not.toBeInTheDocument();
  });
});
