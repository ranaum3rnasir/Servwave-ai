/**
 * visits-and-task-categories slice 02 - a job visit card carries the VISIT's own crew, everywhere
 * the routed board renders it (PRD stories 6-8).
 *
 * The defect: every card of a job read the JOB-level crew - the server-side union across all its
 * visits - so a job whose three trips are staffed by different people showed every name on every
 * card and put every trip in every one of those people's Member-view lanes. The pure half of the
 * rule is pinned in components/schedule/eventAdapters.test.ts; this file drives the board.
 *
 * The fixture is the multi-visit shape the demo org's reproduction used: three trips of ONE job,
 * each crewed differently, with the job-level `assignees` key holding the union of all of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import { jobToEvents } from '@/components/schedule/eventAdapters';
import SchedulePage from '@/pages/v2/schedule/SchedulePage';
import { EventPeekCard } from '@/pages/v2/schedule/components/eventPeekCard';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const TZ = 'America/New_York';

// Days inside the week the board opens on, so the fixture cannot rot out of the default window.
// 14:00Z is mid-morning in the org zone all year round.
const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}
const dayKey = (offset: number) => format(addDays(WEEK_START, offset), 'yyyy-MM-dd');

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', phone: null };
const BOB = { id: 'm-bob', first_name: 'Bob', last_name: 'Ode', phone: null };
const CARA = { id: 'm-cara', first_name: 'Cara', last_name: 'Diaz', phone: null };
const STAFF = [ALICE, BOB, CARA];
const onVisit = (...people: (typeof ALICE)[]) => people.map((u) => ({ user_id: u.id, user: u }));

const THREE_CREWS_JOB = {
  id: 'job-1',
  job_number: 'J00044',
  status: 'SCHEDULED',
  scope_notes: 'Gate operator swap',
  customer: { first_name: 'Pat', last_name: 'Sample', company_name: 'Sample Co', email: 'pat@example.test' },
  // The server-side union across all three trips - what every card used to read.
  assignees: STAFF.map((user) => ({ user })),
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: onVisit(ALICE) },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: onVisit(BOB) },
    { id: 'v3', visit_seq: 3, status: 'SCHEDULED', scheduled_at: dayAt(5), scheduled_end: dayAt(5, 16), is_all_day: false, assignees: [] },
  ],
};

function mockBoard(jobs: Array<Record<string, unknown>>) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : jobs } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: STAFF.map((u) => ({ ...u, is_active: true, role: 'TECHNICIAN' })) } });
    }
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

async function mountMemberBoard() {
  mockBoard([THREE_CREWS_JOB]);
  const view = renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  await screen.findAllByText(/J00044/);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
  await screen.findByTestId(`week-cell-${ALICE.id}-${dayKey(1)}`);
  return view;
}

/** The board ids rendered inside one member's lane on one day. */
function cardsInLane(memberId: string, offset: number): (string | null)[] {
  const cell = screen.getByTestId(`week-cell-${memberId}-${dayKey(offset)}`);
  return Array.from(cell.querySelectorAll('[data-board-id]')).map((el) => el.getAttribute('data-board-id'));
}

function laneDrop(boardId: string, fromMember: string, toMember: string, offset: number) {
  const cell = screen.getByTestId(`week-cell-${toMember}-${dayKey(offset)}`);
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? fromMember : k === GRID_EVENT_TYPE ? 'job' : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('the Member view places each visit only in its own crew\'s lanes', () => {
  it('shows visit 1 only in Alice\'s lane and visit 2 only in Bob\'s', async () => {
    await mountMemberBoard();

    expect(cardsInLane(ALICE.id, 1)).toEqual(['jv-v1']);
    expect(cardsInLane(BOB.id, 1)).toEqual([]);
    expect(cardsInLane(CARA.id, 1)).toEqual([]);

    expect(cardsInLane(BOB.id, 3)).toEqual(['jv-v2']);
    expect(cardsInLane(ALICE.id, 3)).toEqual([]);
  });

  it('puts the uncrewed visit in nobody\'s lane', async () => {
    await mountMemberBoard();

    for (const member of STAFF) expect(cardsInLane(member.id, 5)).toEqual([]);
  });
});

describe('the card\'s hover and editor list only that visit\'s crew', () => {
  it('the peek card of visit 2 names Bob and nobody from the other trips', () => {
    const visit2 = jobToEvents(THREE_CREWS_JOB, TZ).find((e) => e.boardId === 'jv-v2')!;
    renderWithProviders(
      <EventPeekCard event={visit2} x={0} y={0} pinned={false} onOpen={vi.fn()} onClose={vi.fn()} />,
    );

    const card = screen.getByRole('tooltip');
    expect(within(card).getByText('Bob Ode')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/Alice|Cara/);
  });

  it('the peek card of an uncrewed visit says it needs crew, whoever is on its siblings', () => {
    const visit3 = jobToEvents(THREE_CREWS_JOB, TZ).find((e) => e.boardId === 'jv-v3')!;
    renderWithProviders(
      <EventPeekCard event={visit3} x={0} y={0} pinned={false} onOpen={vi.fn()} onClose={vi.fn()} />,
    );

    expect(within(screen.getByRole('tooltip')).getByText('Needs crew')).toBeInTheDocument();
  });

  it('the editor opened from visit 2 lists Bob as its crew and nobody else', async () => {
    await mountMemberBoard();
    const cell = screen.getByTestId(`week-cell-${BOB.id}-${dayKey(3)}`);
    fireEvent.click(within(cell).getAllByText(/J00044/)[0]!);

    const editor = await screen.findByRole('dialog');
    expect(within(editor).getAllByText(/Bob Ode/).length).toBeGreaterThan(0);
    expect(editor.textContent).not.toMatch(/Alice Ng|Cara Diaz/);
  });

  it('the reschedule confirmation for visit 2 lists only visit 2\'s crew', async () => {
    await mountMemberBoard();
    // Same lane, another day: a reschedule, crew unchanged.
    laneDrop('jv-v2', BOB.id, BOB.id, 4);

    const confirm = await screen.findByRole('button', { name: /Confirm reschedule/i });
    const dialog = confirm.closest('[role="dialog"], [role="alertdialog"]') as HTMLElement;
    expect(within(dialog).getByText(/Bob Ode/)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/Alice Ng|Cara Diaz/);
  });
});

describe('a cross-lane drag re-crews the DRAGGED visit, not the job\'s current one', () => {
  it('swapping Bob for Cara on visit 2 writes visit 2\'s crew through its own door', async () => {
    await mountMemberBoard();
    laneDrop('jv-v2', BOB.id, CARA.id, 3);

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/visits/v2/assignees', { assignee_ids: [CARA.id] }),
    );
    // The job-level door lands its statement on the job's CURRENT trip - visit 1 here.
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/jobs/job-1/assignees', expect.anything());
  });

  it('saving crew from visit 2\'s editor writes visit 2, not the job\'s current visit', async () => {
    await mountMemberBoard();
    const cell = screen.getByTestId(`week-cell-${BOB.id}-${dayKey(3)}`);
    fireEvent.click(within(cell).getAllByText(/J00044/)[0]!);
    const editor = await screen.findByRole('dialog');

    fireEvent.click(within(editor).getByRole('button', { name: 'Remove Bob Ode' }));
    fireEvent.click(await within(editor).findByRole('button', { name: /Save crew/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/visits/v2/assignees', { assignee_ids: [] }),
    );
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/jobs/job-1/assignees', expect.anything());
  });

  it('moves only visit 2 into Cara\'s lane straight away, and leaves visit 1 where it was', async () => {
    let settle: (v: unknown) => void = () => {};
    mockApi.post.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await mountMemberBoard();
    laneDrop('jv-v2', BOB.id, CARA.id, 3);

    // Optimistic, before the server answers: the dragged trip moved lanes...
    await waitFor(() => expect(cardsInLane(CARA.id, 3)).toEqual(['jv-v2']));
    expect(cardsInLane(BOB.id, 3)).toEqual([]);
    // ...and its sibling trips kept their own crews.
    expect(cardsInLane(ALICE.id, 1)).toEqual(['jv-v1']);
    expect(cardsInLane(CARA.id, 1)).toEqual([]);
    settle({ data: {} });
  });
});
