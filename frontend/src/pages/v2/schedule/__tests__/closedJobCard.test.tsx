/**
 * Roles & Permissions, PRD 6, S06.17 and PRD 9, S09.13 - what the Schedule offers on the card of a Done or Cancelled job.
 *
 * The server refuses a move of a closed job's visit with "Reopen this job first", and that refusal is the guard. The board
 * does not invite the drag either: the card of a Done or Cancelled job is not a drag source, and a drop that still reaches
 * the board (a touch carry, a stale tab) says why in a toast and sends nothing.
 *
 * The card's "Needs crew" mark asks the same question the "No crew" filter and the Missing crew tile ask: a finished visit
 * on a Done job with nobody on it has no crew to miss, so it carries no mark, while a booked visit on an open job does.
 *
 * These drive the ROUTED board with its real data hooks; only the network is replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: vi.fn(),
}));

/** The props the page hands the drag-and-drop calendar, captured as it renders (the real calendar still renders). */
const calendarProps = vi.hoisted(() => ({
  current: undefined as
    | { draggableAccessor: (e: object) => boolean; resizableAccessor: (e: object) => boolean; events: Array<{ boardId: string }> }
    | undefined,
}));
vi.mock('react-big-calendar/lib/addons/dragAndDrop', async (importOriginal) => {
  const { createElement } = await import('react');
  const original = await importOriginal<{ default: (calendar: unknown) => React.ComponentType<Record<string, unknown>> }>();
  return {
    default: (calendar: unknown) => {
      const Real = original.default(calendar);
      return function CapturingCalendar(props: Record<string, unknown>) {
        calendarProps.current = props as unknown as NonNullable<typeof calendarProps.current>;
        return createElement(Real, props);
      };
    },
  };
});

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}
const dayKey = (offset: number) => format(addDays(WEEK_START, offset), 'yyyy-MM-dd');

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' };
const CUSTOMER = { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' };

type VisitRow = { id: string; status: string; assignees: Array<{ user_id: string; user: typeof ALICE }> };
function job(over: { id: string; number: string; status: string; offset: number; visit: VisitRow }) {
  const { visit, offset } = over;
  return {
    id: over.id,
    job_number: over.number,
    status: over.status,
    scope_notes: 'Rooftop Unit Swap',
    customer: CUSTOMER,
    assignees: visit.assignees.map((a) => ({ user: a.user })),
    tags: [],
    scheduled_start: dayAt(offset),
    scheduled_end: dayAt(offset, 16),
    visits: [{ visit_seq: 1, scheduled_at: dayAt(offset), scheduled_end: dayAt(offset, 16), is_all_day: false, ...visit }],
  };
}
const onVisit = [{ user_id: ALICE.id, user: ALICE }];

const DONE_CREWLESS = job({ id: 'job-done-0', number: 'J00071', status: 'DONE', offset: 1, visit: { id: 'v-done-0', status: 'COMPLETED', assignees: [] } });
const OPEN_CREWLESS = job({ id: 'job-open-0', number: 'J00072', status: 'SCHEDULED', offset: 2, visit: { id: 'v-open-0', status: 'SCHEDULED', assignees: [] } });
const DONE_CREWED = job({ id: 'job-done-1', number: 'J00073', status: 'DONE', offset: 3, visit: { id: 'v-done-1', status: 'COMPLETED', assignees: onVisit } });
const CANCELLED_CREWED = job({ id: 'job-cx-1', number: 'J00074', status: 'CANCELLED', offset: 4, visit: { id: 'v-cx-1', status: 'SCHEDULED', assignees: onVisit } });
const OPEN_CREWED = job({ id: 'job-open-1', number: 'J00075', status: 'SCHEDULED', offset: 5, visit: { id: 'v-open-1', status: 'SCHEDULED', assignees: onVisit } });

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
      return Promise.resolve({ data: { users: [{ ...ALICE, is_active: true, role: 'TECHNICIAN' }] } });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

function mount(jobs: Array<Record<string, unknown>>) {
  mockBoard(jobs);
  return renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
}

/** The card element a board id paints (the Standard board's wrapper or a Member board's card). */
const cardOf = (container: HTMLElement, boardId: string) => container.querySelector<HTMLElement>(`[data-board-id="${boardId}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('the "Needs crew" mark on the Standard board', () => {
  it('is on a booked visit of an open job with nobody on it, and not on a finished visit of a Done job', async () => {
    const { container } = mount([DONE_CREWLESS, OPEN_CREWLESS]);
    await screen.findAllByText(/J00072/);
    await screen.findAllByText(/J00071/);

    expect(cardOf(container, 'jv-v-open-0')!.querySelector('[aria-label="Needs crew"]')).not.toBeNull();
    expect(cardOf(container, 'jv-v-done-0')).not.toBeNull();
    expect(cardOf(container, 'jv-v-done-0')!.querySelector('[aria-label="Needs crew"]')).toBeNull();
    expect(cardOf(container, 'jv-v-done-0')!.textContent?.toLowerCase()).not.toContain('needs crew');
  });
});

describe('the drag on the Standard board', () => {
  it('is offered on the card of an open job and not on the card of a Done or a Cancelled job', async () => {
    mount([DONE_CREWED, CANCELLED_CREWED, OPEN_CREWED]);
    await screen.findAllByText(/J00075/);

    // The board's own drag gate, asked about each card the board paints (the gate react-big-calendar consults before it
    // begins a drag; a jsdom press-and-move cannot start one, so the gate is read where the page hands it over).
    const { draggableAccessor, resizableAccessor, events } = calendarProps.current!;
    const gate = (accessor: (e: object) => boolean, boardId: string) => accessor(events.find((e) => e.boardId === boardId)!);

    for (const accessor of [draggableAccessor, resizableAccessor]) {
      expect(gate(accessor, 'jv-v-open-1')).toBe(true);
      expect(gate(accessor, 'jv-v-done-1')).toBe(false);
      expect(gate(accessor, 'jv-v-cx-1')).toBe(false);
    }
  });
});

describe('the drag on the Member board', () => {
  async function mountMember() {
    const view = mount([DONE_CREWED, CANCELLED_CREWED, OPEN_CREWED]);
    await screen.findAllByText(/J00075/);
    fireEvent.click(screen.getByRole('button', { name: 'Member' }));
    await screen.findByTestId(`week-cell-${ALICE.id}-${dayKey(5)}`);
    return view;
  }

  it('is offered on the card of an open job and not on the card of a Done or a Cancelled job', async () => {
    const { container } = await mountMember();

    expect(cardOf(container, 'jv-v-open-1')!.getAttribute('draggable')).toBe('true');
    expect(cardOf(container, 'jv-v-done-1')!.getAttribute('draggable')).toBe('false');
    expect(cardOf(container, 'jv-v-cx-1')!.getAttribute('draggable')).toBe('false');
  });

  it('says "Reopen this job first" and sends nothing when a closed job\'s card is dropped on another day', async () => {
    await mountMember();
    const cell = screen.getByTestId(`week-cell-${ALICE.id}-${dayKey(0)}`);

    fireEvent.drop(cell, {
      dataTransfer: {
        getData: (k: string) =>
          k === GRID_EVENT_ID ? 'jv-v-done-1' : k === FROM_MEMBER ? ALICE.id : k === GRID_EVENT_TYPE ? 'job' : '',
        types: [GRID_EVENT_ID, FROM_MEMBER],
      },
    });

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Can't reschedule", { description: expect.stringContaining('Reopen this job first') }));
    expect(screen.queryByRole('button', { name: /Confirm reschedule/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.patch).not.toHaveBeenCalled();
      expect(mockApi.post).not.toHaveBeenCalled();
    });
  });
});
