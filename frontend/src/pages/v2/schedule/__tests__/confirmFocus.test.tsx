import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { buildAbility } from '@/lib/ability';
import { renderSchedule, serveSchedule } from '@/__tests__/harness/schedulePage';
import { addDays, format, startOfWeek } from 'date-fns';
import api from '@/lib/axios';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/stores/auth.store';

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

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
  serveSchedule({ jobs: [JOB], bucketJobs: [], users: [{ ...ALICE, is_active: true, role: 'TECHNICIAN' }] });
}

async function mountBoard() {
  mockBoard();
  renderSchedule({ ability: ADMIN });
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
