// TG7 — Member·Week is interactive: per member×day cell drops (day granularity, no time),
// D1 crew-parity with the grid view, and idle members keep a full droppable lane (D3).
// TG10 — board cards write the swap channels (from-member) and drops deliver them.
// First DnD test in the repo — drag payloads are plain objects mimicking dataTransfer
// (jsdom has no DataTransfer); keys come from the dragChannels codec.
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { MemberWeekBoard } from '@/components/schedule/MemberWeekBoard';
import { JOB_ID, GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

// Wed Jun 10 2026 → week renders Sun Jun 7 … Sat Jun 13.
const weekStart = asWallClock(new Date(2026, 5, 10));
const TZ = 'America/New_York';

const twoCrewJob: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme',
  crew: ['m-alice', 'm-bob'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {},
};

// Slice 06 (calendar-entries spec §3, ADR 0002) — an entry naming Alice as a USER participant,
// with an empty crew: it must place in Alice's column via `participantUserIds`, not `crew`.
const entryNamingAlice: SchedulableEvent = {
  boardId: 'ce-1',
  parentId: 'entry-1',
  type: 'calendar-entry',
  number: '',
  title: 'Team Lunch',
  customer: '',
  crew: [],
  participantUserIds: ['m-alice'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {},
};

const staff = [
  { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' },
  { id: 'm-bob', first_name: 'Bob', last_name: 'Ortiz', is_active: true, role: 'TECHNICIAN' },
  { id: 'm-carol', first_name: 'Carol', last_name: 'Diaz', is_active: true, role: 'SALES' },
];

function renderBoard(events: SchedulableEvent[], onDropJob = vi.fn(), conflictIds: Set<string> = new Set()) {
  renderWithProviders(
    <MemberWeekBoard
      weekStart={weekStart}
      staff={staff}
      events={events}
      conflictIds={conflictIds}
      isLoading={false}
      tz={TZ}
      onSelectEvent={vi.fn()}
      onDropJob={onDropJob}
    />,
  );
  return onDropJob;
}

describe('MemberWeekBoard — TG7 interactive member×day cells', () => {
  it('a bucket-card drop on a member×day cell calls onDropJob(id, memberId, date, null)', () => {
    const onDropJob = renderBoard([]);
    const cell = screen.getByTestId('week-cell-m-alice-2026-06-10');
    fireEvent.drop(cell, {
      dataTransfer: {
        getData: (k: string) => (k === JOB_ID ? 'job-9' : ''),
        types: [JOB_ID],
      },
    });
    expect(onDropJob).toHaveBeenCalledTimes(1);
    // Bucket cards carry no from-member lane marker → null (modal path, never a swap).
    expect(onDropJob).toHaveBeenCalledWith('job-9', 'm-alice', new Date(2026, 5, 10), null);
  });

  it("renders a 2-crew event in BOTH members' week lanes (D1 parity)", () => {
    renderBoard([twoCrewJob]);
    expect(screen.getAllByText('Rooftop Unit Swap')).toHaveLength(2);
  });

  it('an idle member still renders a full lane of droppable day cells (no hide-empty)', () => {
    renderBoard([twoCrewJob]); // Carol has zero events
    expect(screen.getByText('Carol Diaz')).toBeInTheDocument();
    // Her member×day cells exist and accept drops — one per day of the week.
    const cell = screen.getByTestId('week-cell-m-carol-2026-06-10');
    expect(cell).toBeInTheDocument();
    expect(screen.getByTestId('week-cell-m-carol-2026-06-07')).toBeInTheDocument();
    expect(screen.getByTestId('week-cell-m-carol-2026-06-13')).toBeInTheDocument();
  });

  it("a conflicted 2-crew event shows the double-booked treatment in BOTH members' lanes (red-outline parity)", () => {
    renderBoard([twoCrewJob], vi.fn(), new Set([twoCrewJob.boardId]));
    expect(screen.getAllByText(/double-booked/i)).toHaveLength(2);
  });
});

describe('MemberWeekBoard — slice 06 participant column placement (ADR 0002)', () => {
  it("an entry naming Alice as a participant renders in Alice's lane, not Bob's, on the correct day", () => {
    renderBoard([entryNamingAlice]);
    const aliceCell = screen.getByTestId('week-cell-m-alice-2026-06-10');
    expect(within(aliceCell).getByText('Team Lunch')).toBeInTheDocument();
    const bobCell = screen.getByTestId('week-cell-m-bob-2026-06-10');
    expect(within(bobCell).queryByText('Team Lunch')).not.toBeInTheDocument();
  });

  it('the participant card shows no red fill and no red outline (ADR 0002 — no crew, no conflict)', () => {
    renderBoard([entryNamingAlice], vi.fn(), new Set([entryNamingAlice.boardId]));
    const card = screen.getByText('Team Lunch').closest('[data-board-id="ce-1"]');
    expect(card).not.toBeNull();
    expect(card!.className).not.toMatch(/bg-danger/);
    expect(card!.className).not.toMatch(/border-danger/);
    expect(screen.queryByText('needs crew')).not.toBeInTheDocument();
    expect(screen.queryByText(/double-booked/i)).not.toBeInTheDocument();
  });
});

describe('MemberWeekBoard — TG10 swap wiring (board cards carry their lane)', () => {
  it("dragging Alice's card writes grid-event-id/type + from-member=alice (codec channels)", () => {
    renderBoard([twoCrewJob]);
    const setData = vi.fn();
    const aliceCell = screen.getByTestId('week-cell-m-alice-2026-06-10');
    const card = within(aliceCell).getByText('Rooftop Unit Swap').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    fireEvent.dragStart(card!, { dataTransfer: { setData, effectAllowed: 'none' } });
    expect(setData).toHaveBeenCalledWith(GRID_EVENT_ID, 'job-1');
    expect(setData).toHaveBeenCalledWith(GRID_EVENT_TYPE, 'job');
    expect(setData).toHaveBeenCalledWith(FROM_MEMBER, 'm-alice');
  });

  it("a board card from Alice's lane dropped on Bob's cell delivers from-member to onDropJob", () => {
    const onDropJob = renderBoard([twoCrewJob]);
    const bobCell = screen.getByTestId('week-cell-m-bob-2026-06-11');
    fireEvent.drop(bobCell, {
      dataTransfer: {
        getData: (k: string) =>
          k === GRID_EVENT_ID ? 'job-1' : k === FROM_MEMBER ? 'm-alice' : '',
        types: [GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER],
      },
    });
    expect(onDropJob).toHaveBeenCalledTimes(1);
    // The page classifies from≠to as a SWAP (the cell date is ignored there).
    expect(onDropJob).toHaveBeenCalledWith('job-1', 'm-bob', new Date(2026, 5, 11), 'm-alice');
  });
});
