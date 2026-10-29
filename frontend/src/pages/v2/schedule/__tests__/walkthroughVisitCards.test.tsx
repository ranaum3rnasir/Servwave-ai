/**
 * visits-and-task-categories slice 03 - one scheduler card per lead walkthrough visit, on the
 * routed board (PRD stories 1-5, 9, 10).
 *
 * The defect, reproduced on the demo org as L00075: a lead with walkthroughs on two days of one
 * week, each with a different performer, drew ONE card - the lead's current trip - so the second
 * walkthrough was invisible, and every gesture on the card addressed the lead's current trip
 * whichever trip the dispatcher meant. The pure half is pinned in
 * components/schedule/useScheduleEvents.test.tsx; this file drives the board.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// usePlanMode reads its storage key off a per-tab id at MODULE LOAD (see planModeVisitDraft.test).
vi.hoisted(() => sessionStorage.setItem('plan-mode-tab-id', 'vtc-s03-plan-test'));

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { asWallClock } from '@/lib/schedule-tz';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import { walkthroughToEvents } from '@/components/schedule/eventAdapters';
import SchedulePage, { boardCardDraft } from '@/pages/v2/schedule/SchedulePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const TZ = 'America/New_York';
const STORAGE_KEY = 'plan-mode-vtc-s03-plan-test';

// Days inside the week the board opens on, so the fixture cannot rot out of the default window.
const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}
const dayKey = (offset: number) => format(addDays(WEEK_START, offset), 'yyyy-MM-dd');

const BEN = { id: 'm-ben', first_name: 'Ben', last_name: 'Ortiz', phone: null };
const DANA = { id: 'm-dana', first_name: 'Dana', last_name: 'Whitfield', phone: null };
const CARA = { id: 'm-cara', first_name: 'Cara', last_name: 'Diaz', phone: null };
const STAFF = [BEN, DANA, CARA];
const onVisit = (...people: (typeof BEN)[]) => people.map((u) => ({ user_id: u.id, user: u }));

const VISIT_1 = { id: 'wv-a', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 15), is_all_day: false, assignees: onVisit(BEN) };
const VISIT_2 = { id: 'wv-b', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 15), is_all_day: false, assignees: onVisit(DANA) };

/** The lead as GET /api/leads ships it: the flat current-trip fields AND every live trip. */
function leadWith(visits: Array<typeof VISIT_1>) {
  return {
    id: 'lead-75',
    lead_number: 'L00075',
    status: 'CONTACTED',
    customer: { first_name: 'Elena', last_name: 'Sample', company_name: null, email: 'elena@example.test' },
    commission_owner: null,
    tags: [],
    walkthrough_scheduled_at: visits[0]!.scheduled_at,
    walkthrough_duration_minutes: 60,
    walkthrough_completed_at: null,
    walkthrough_performers: visits[0]!.assignees,
    walkthrough_visits: visits,
  };
}

let boardLeads: Array<Record<string, unknown>> = [];

function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    if (url === '/api/leads') {
      const params = config?.params as { walkthrough_status?: string } | undefined;
      return Promise.resolve({ data: { leads: params?.walkthrough_status ? [] : boardLeads } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: STAFF.map((u) => ({ ...u, is_active: true, role: 'TECHNICIAN' })) } });
    }
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

function mountBoard() {
  return renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
}

const boardIds = () =>
  Array.from(document.querySelectorAll('[data-board-id^="wv-"], [data-board-id^="wt-"]'))
    .map((el) => el.getAttribute('data-board-id'));

async function mountMemberBoard() {
  const view = mountBoard();
  await screen.findAllByText(/L00075/);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
  await screen.findByTestId(`week-cell-${DANA.id}-${dayKey(3)}`);
  return view;
}

function cardsInLane(memberId: string, offset: number): (string | null)[] {
  const cell = screen.getByTestId(`week-cell-${memberId}-${dayKey(offset)}`);
  return Array.from(cell.querySelectorAll('[data-board-id]')).map((el) => el.getAttribute('data-board-id'));
}

function laneDrop(boardId: string, fromMember: string, toMember: string, offset: number) {
  const cell = screen.getByTestId(`week-cell-${toMember}-${dayKey(offset)}`);
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? fromMember : k === GRID_EVENT_TYPE ? 'walkthrough' : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

async function openVisit2Editor() {
  await mountMemberBoard();
  const cell = screen.getByTestId(`week-cell-${DANA.id}-${dayKey(3)}`);
  fireEvent.click(within(cell).getAllByText(/L00075/)[0]!);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  boardLeads = [leadWith([VISIT_1, VISIT_2])];
  mockBoard();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('a lead with two walkthroughs in one week shows two cards', () => {
  it('draws "Visit 1 of 2" and "Visit 2 of 2", each keyed on its own visit', async () => {
    mountBoard();
    await waitFor(() => expect(boardIds()).toEqual(['wv-wv-a', 'wv-wv-b']));
    expect(screen.getAllByText('Visit 1 of 2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Visit 2 of 2').length).toBeGreaterThan(0);
  });

  it('the Member view puts each walkthrough only in its own performer\'s lane', async () => {
    await mountMemberBoard();
    expect(cardsInLane(BEN.id, 1)).toEqual(['wv-wv-a']);
    expect(cardsInLane(DANA.id, 1)).toEqual([]);
    expect(cardsInLane(DANA.id, 3)).toEqual(['wv-wv-b']);
    expect(cardsInLane(BEN.id, 3)).toEqual([]);
  });

  it('a walkthrough booked from the lead page appears on the board without a reload', async () => {
    boardLeads = [leadWith([VISIT_1])];
    const { queryClient } = mountBoard();
    await waitFor(() => expect(boardIds()).toEqual(['wv-wv-a']));

    // The lead page books a second trip and runs the one visit-write refresh (slice 01).
    boardLeads = [leadWith([VISIT_1, VISIT_2])];
    act(() => refreshAfterVisitWrite(queryClient, { leadId: 'lead-75' }));

    await waitFor(() => expect(boardIds()).toEqual(['wv-wv-a', 'wv-wv-b']));
  });
});

describe('every gesture on a walkthrough card addresses THAT visit', () => {
  it('opening visit 2 opens visit 2: its own performer, nobody from visit 1', async () => {
    const editor = await openVisit2Editor();
    expect(within(editor).getAllByText(/Dana Whitfield/).length).toBeGreaterThan(0);
    expect(editor.textContent).not.toMatch(/Ben Ortiz/);
  });

  it('dragging visit 2 to another day reschedules only visit 2', async () => {
    await mountMemberBoard();
    laneDrop('wv-wv-b', DANA.id, DANA.id, 4);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        '/api/leads/lead-75/visits/wv-b',
        expect.objectContaining({ performer_ids: [DANA.id], walkthrough_duration_minutes: 60 }),
      ),
    );
    const body = mockApi.patch.mock.calls[0]![1] as { walkthrough_scheduled_at: string };
    expect(body.walkthrough_scheduled_at).toBe(dayAt(4));
    // The lead-level door moves the lead's CURRENT trip - visit 1 here.
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/leads/lead-75/walkthrough/schedule', expect.anything());
  });

  it('swapping Dana for Cara on visit 2 re-crews visit 2 through its own door, and moves it lanes at once', async () => {
    let settle: (v: unknown) => void = () => {};
    mockApi.post.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await mountMemberBoard();
    laneDrop('wv-wv-b', DANA.id, CARA.id, 3);

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-75/visits/wv-b/performers', { performer_ids: [CARA.id] }),
    );
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/leads/lead-75/walkthrough/performers', expect.anything());
    // Optimistic: the dragged trip moved lanes, its sibling kept its own performer.
    await waitFor(() => expect(cardsInLane(CARA.id, 3)).toEqual(['wv-wv-b']));
    expect(cardsInLane(BEN.id, 1)).toEqual(['wv-wv-a']);
    settle({ data: {} });
  });

  it('saving crew from visit 2\'s editor writes visit 2', async () => {
    const editor = await openVisit2Editor();
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove Dana Whitfield' }));
    fireEvent.click(await within(editor).findByRole('button', { name: /Save crew/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-75/visits/wv-b/performers', { performer_ids: [] }),
    );
  });

  it('"Move to Unscheduled" on visit 2 unschedules visit 2 only', async () => {
    const editor = await openVisit2Editor();
    fireEvent.click(within(editor).getByRole('button', { name: /Move to Unscheduled/i }));
    const confirm = await screen.findByRole('button', { name: /^Unschedule$/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-75/visits/wv-b/unschedule'));
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/leads/lead-75/walkthrough/unschedule');
  });

  it('the confirm says visit 2 leaves the schedule and the lead keeps its other booked visit', async () => {
    const editor = await openVisit2Editor();
    fireEvent.click(within(editor).getByRole('button', { name: /Move to Unscheduled/i }));
    const confirm = (await screen.findByRole('button', { name: /^Unschedule$/i })).closest('div.shadow-modal') as HTMLElement;

    expect(confirm.textContent).toMatch(/removed from the schedule/i);
    expect(confirm.textContent).toMatch(/keeps its other booked visit/i);
    // It does NOT go back to the bucket - the lead still has visit 1 booked.
    expect(confirm.textContent).not.toMatch(/bucket|cancellation of the job/i);
  });

  it('with no other booked visit, the confirm keeps the back-to-its-bucket wording', async () => {
    boardLeads = [leadWith([VISIT_2])];
    await mountMemberBoard();
    const cell = screen.getByTestId(`week-cell-${DANA.id}-${dayKey(3)}`);
    fireEvent.click(within(cell).getAllByText(/L00075/)[0]!);
    const editor = await screen.findByRole('dialog');
    fireEvent.click(within(editor).getByRole('button', { name: /Move to Unscheduled/i }));
    const confirm = (await screen.findByRole('button', { name: /^Unschedule$/i })).closest('div.shadow-modal') as HTMLElement;

    expect(confirm.textContent).toMatch(/goes back to its bucket/i);
    expect(confirm.textContent).not.toMatch(/keeps its other booked visit/i);
  });
});

describe('a Plan Mode draft of a walkthrough card moves exactly that visit', () => {
  const visit2Card = () => walkthroughToEvents(leadWith([VISIT_1, VISIT_2]), TZ).find((e) => e.boardId === 'wv-wv-b')!;
  const FRIDAY = asWallClock(new Date(addDays(WEEK_START, 5).setHours(9, 0, 0, 0)));
  const FRIDAY_END = asWallClock(new Date(addDays(WEEK_START, 5).setHours(10, 30, 0, 0)));

  it('the draft names the visit', () => {
    expect(boardCardDraft(visit2Card(), FRIDAY, FRIDAY_END, TZ)).toMatchObject({
      sourceType: 'walkthrough', sourceId: 'lead-75', visitId: 'wv-b',
    });
  });

  it('confirming it reschedules visit 2 through its own door, with its own crew', async () => {
    const draft = boardCardDraft(visit2Card(), FRIDAY, FRIDAY_END, TZ);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ isActive: true, ghosts: [{ ...draft, id: 'g-wv' }], updatedAt: Date.now() }));

    mountBoard();
    await screen.findAllByText(/L00075/);
    fireEvent.click(await screen.findByRole('button', { name: /^Confirm All$/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm 1 Change' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/leads/lead-75/visits/wv-b', {
        walkthrough_scheduled_at: draft.start,
        performer_ids: [DANA.id],
        walkthrough_duration_minutes: 90,
      }),
    );
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/leads/lead-75/walkthrough/schedule', expect.anything());
  });
});
