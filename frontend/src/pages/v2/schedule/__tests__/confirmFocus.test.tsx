/**
 * Mobile slice 16 (A11Y-04), on the routed board: the schedule's confirmations hold focus while
 * they are up, including when they replace another dialog on the same tick.
 *
 * "Move to Unscheduled?" is opened from INSIDE the event editor (the editor's `open` is gated off
 * while the confirm is up), and the 409 conflict confirm replaces the reschedule confirm. Both
 * swaps used to land focus on nothing (the confirm was a plain div with no focus handling), so
 * Tab walked the board behind it. The isolated focus contract of each confirm is in
 * src/__tests__/overlay-focus-trap.test.tsx; this file proves the page's swaps keep it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

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

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' };
const JOB = {
  id: 'job-2',
  job_number: 'J00042',
  status: 'SCHEDULED',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  assignees: [{ user: ALICE }],
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v9', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [{ user_id: ALICE.id, user: ALICE }] },
  ],
};

function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : [JOB] } });
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

async function mountBoard() {
  mockBoard();
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  await screen.findAllByText(/J00042/);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
}

async function expectTrappedIn(panel: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  for (let i = 0; i < 5; i++) {
    await user.tab();
    expect(panel.contains(document.activeElement), `Tab #${i + 1} left the confirm`).toBe(true);
  }
}

describe('schedule confirmations hold focus across the page swaps (mobile slice 16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('"Move to Unscheduled?" opened from the editor takes focus, keeps it, and Cancel hands it back to the reopened editor', async () => {
    const user = userEvent.setup();
    await mountBoard();
    const [card] = await screen.findAllByText(/J00042/);
    fireEvent.click(card!);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));

    const confirm = await screen.findByRole('alertdialog', { name: /Move to Unscheduled/i });
    await expectTrappedIn(confirm, user);

    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    // The editor comes back (it was only hidden), and focus goes into it, not to the page.
    const editor = await screen.findByRole('dialog');
    await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));
  });

  it('the 409 conflict confirm that replaces the reschedule confirm takes focus and keeps it', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Schedule conflict detected', conflicts: [] } },
    });
    await mountBoard();
    const cell = await screen.findByTestId(`week-cell-m-alice-${format(addDays(WEEK_START, 5), 'yyyy-MM-dd')}`);
    fireEvent.drop(cell, {
      dataTransfer: {
        getData: (k: string) => (k === GRID_EVENT_ID ? 'jv-v9' : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? 'job' : ''),
        types: [GRID_EVENT_ID, FROM_MEMBER],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    const conflict = await screen.findByRole('alertdialog', { name: /Scheduling conflict/i });
    await expectTrappedIn(conflict, user);
  });
});
