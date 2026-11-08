// TG6 — D1 multi-column rendering: an event renders in EVERY assigned crew member's
// column. This is the contract that replaces the pre-redesign single-assignee model.
// TG10 — board cards write the swap channels (from-member) and hour-slot drops deliver them.
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { TechnicianGridView } from '@/components/schedule/TechnicianGridView';
import { JOB_ID, GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

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

const soloJob: SchedulableEvent = {
  boardId: 'job-2',
  parentId: 'job-2',
  type: 'job',
  number: 'J00044',
  title: 'Filter Replacement',
  customer: 'Globex',
  crew: ['m-bob'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 13, 0)),
  end: asWallClock(new Date(2026, 5, 10, 14, 0)),
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

const members = [
  { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' },
  { id: 'm-bob', first_name: 'Bob', last_name: 'Ortiz', is_active: true, role: 'TECHNICIAN' },
];

function renderGrid(
  events: SchedulableEvent[],
  conflictIds: Set<string> = new Set(),
  onDropJob = vi.fn(),
) {
  renderWithProviders(
    <TechnicianGridView
      date={asWallClock(new Date(2026, 5, 10))}
      events={events}
      members={members}
      conflictIds={conflictIds}
      isLoading={false}
      draggingJobIdRef={{ current: null }}
      onDropJob={onDropJob}
      onSelectJob={vi.fn()}
      onEventClick={vi.fn()}
    />,
  );
  return onDropJob;
}

describe('TechnicianGridView — D1 multi-column rendering', () => {
  it("renders a 2-crew job in BOTH members' columns", () => {
    renderGrid([twoCrewJob]);
    expect(screen.getAllByText('Rooftop Unit Swap')).toHaveLength(2);
  });

  it('renders a single-crew job in exactly one column', () => {
    renderGrid([twoCrewJob, soloJob]);
    expect(screen.getAllByText('Rooftop Unit Swap')).toHaveLength(2);
    expect(screen.getAllByText('Filter Replacement')).toHaveLength(1);
  });

  it('does not render a crew-less (state 4) event in any member column', () => {
    renderGrid([{ ...twoCrewJob, crew: [] }]);
    expect(screen.queryByText('Rooftop Unit Swap')).not.toBeInTheDocument();
  });

  it('does not render an event scheduled on a DIFFERENT date (pins the isSameDay leg)', () => {
    renderGrid([
      {
        ...twoCrewJob,
        start: asWallClock(new Date(2026, 5, 11, 9, 0)),
        end: asWallClock(new Date(2026, 5, 11, 11, 0)),
      },
    ]);
    expect(screen.queryByText('Rooftop Unit Swap')).not.toBeInTheDocument();
  });
});

describe('TechnicianGridView — slice 06 participant column placement (ADR 0002)', () => {
  it("an entry naming Alice as a participant renders in exactly one column (Alice's), on the correct day", () => {
    renderGrid([entryNamingAlice]);
    // D1's own convention in this file: column membership is proven by occurrence COUNT (see
    // "renders a single-crew job in exactly one column" above) — two members, one match means
    // it rendered in Alice's column and not Bob's.
    expect(screen.getAllByText('Team Lunch')).toHaveLength(1);
  });

  it('an entry naming nobody (no participants, empty crew) renders in no member column', () => {
    renderGrid([{ ...entryNamingAlice, participantUserIds: [] }]);
    expect(screen.queryByText('Team Lunch')).not.toBeInTheDocument();
  });

  it('the participant card shows no red fill and no red outline (ADR 0002 — no crew, no conflict)', () => {
    renderGrid([entryNamingAlice], new Set([entryNamingAlice.boardId]));
    const card = screen.getByText('Team Lunch').closest('[data-board-id="ce-1"]');
    expect(card).not.toBeNull();
    expect(card!.className).not.toMatch(/bg-danger/);
    expect(card!.className).not.toMatch(/border-danger/);
    expect(screen.queryByText('needs crew')).not.toBeInTheDocument();
    expect(screen.queryByText(/double-booked/i)).not.toBeInTheDocument();
  });
});

describe('TechnicianGridView — the two reds (D7 red outline; state 4 is structural)', () => {
  it("a conflicted 2-crew event shows the double-booked treatment in BOTH members' columns", () => {
    renderGrid([twoCrewJob], new Set([twoCrewJob.boardId]));
    expect(screen.getAllByText(/double-booked/i)).toHaveLength(2);
  });

  it('a non-conflicted event shows no double-booked treatment', () => {
    renderGrid([twoCrewJob]);
    expect(screen.queryByText(/double-booked/i)).not.toBeInTheDocument();
  });
});

describe('TechnicianGridView — TG10 swap wiring (board cards carry their lane)', () => {
  it("dragging Bob's card writes grid-event-id/type + from-member=bob (codec channels)", () => {
    renderGrid([soloJob]); // crew: ['m-bob'] → exactly one card, in Bob's column
    const setData = vi.fn();
    const card = screen.getByText('Filter Replacement').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    fireEvent.dragStart(card!, { dataTransfer: { setData, effectAllowed: 'none' } });
    expect(setData).toHaveBeenCalledWith(GRID_EVENT_ID, 'job-2');
    expect(setData).toHaveBeenCalledWith(GRID_EVENT_TYPE, 'job');
    expect(setData).toHaveBeenCalledWith(FROM_MEMBER, 'm-bob');
  });

  it("a board card from Bob's lane dropped on Alice's hour slot delivers from-member to onDropJob", () => {
    const onDropJob = renderGrid([soloJob]);
    const slot = screen.getByTestId('grid-slot-m-alice-13'); // 1 PM slot in Alice's column
    fireEvent.drop(slot, {
      dataTransfer: {
        getData: (k: string) => (k === GRID_EVENT_ID ? 'job-2' : k === FROM_MEMBER ? 'm-bob' : ''),
        types: [GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER],
      },
    });
    expect(onDropJob).toHaveBeenCalledTimes(1);
    // The page classifies from≠to as a SWAP (the slot time is ignored there).
    expect(onDropJob).toHaveBeenCalledWith(
      'job-2',
      'm-alice',
      new Date(2026, 5, 10, 13, 0),
      new Date(2026, 5, 10, 15, 0),
      'm-bob',
    );
  });

  it('a bucket-card drop (job-id channel, no from-member) delivers null', () => {
    const onDropJob = renderGrid([]);
    const slot = screen.getByTestId('grid-slot-m-bob-9');
    fireEvent.drop(slot, {
      dataTransfer: {
        getData: (k: string) => (k === JOB_ID ? 'job-7' : ''),
        types: [JOB_ID],
      },
    });
    expect(onDropJob).toHaveBeenCalledWith(
      'job-7',
      'm-bob',
      new Date(2026, 5, 10, 9, 0),
      new Date(2026, 5, 10, 11, 0),
      null,
    );
  });
});

describe('TechnicianGridView — type accents (META)', () => {
  it('a crewed job (no conflict) renders the job accent — no red fill', () => {
    renderGrid([soloJob]);
    const card = screen.getByText('Filter Replacement').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    // Red fill is reserved for needs-crew (state 4) — a crewed job keeps the job accent.
    expect(card).not.toHaveClass('bg-danger');
    // Pinned as literals rather than read back out of EVENT_TYPE_META: reading the table the
    // component already renders from would assert nothing. These are the card colours DERIVED
    // from the job accent (--ev-job, org-recolourable): an opaque surface and a left bar that
    // clear AA, where the old `bg-ev-job/5` tint under `text-ev-job` did not.
    expect(card).toHaveClass('bg-ev-job-surface');
    expect(card).toHaveClass('border-l-ev-job-border');
  });

  it('a walkthrough card carries the META warning accent (legend parity), not the legacy cyan', () => {
    const walkthrough: SchedulableEvent = {
      boardId: 'wt-1',
      parentId: 'lead-1',
      type: 'walkthrough',
      number: 'L00012',
      title: 'Walkthrough',
      customer: 'Initech',
      crew: ['m-alice'],
      ownerId: null,
      start: asWallClock(new Date(2026, 5, 10, 15, 0)),
      end: asWallClock(new Date(2026, 5, 10, 16, 0)),
      raw: {},
    };
    renderGrid([walkthrough]);
    const card = screen.getByText('Initech').closest('[draggable="true"]');
    expect(card).not.toBeNull();
    expect(card).toHaveClass('bg-ev-walkthrough-surface');
    expect(card).toHaveClass('border-l-ev-walkthrough-border');
    expect(card).not.toHaveClass('bg-cyan-50');
  });
});
