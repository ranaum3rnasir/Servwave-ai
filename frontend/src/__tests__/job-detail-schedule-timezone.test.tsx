/**
 * The job detail surface must read AND write schedule times in the ORG timezone,
 * the same way the scheduler board does (lib/schedule-tz.ts).
 *
 * schedule-tz.picker.test.ts and schedule-tz.render.test.ts prove the HELPERS convert
 * correctly. These tests prove the PAGE actually routes through them - a distinction
 * that matters, because the lifecycle bar was still reading browser-local getters after
 * the surrounding surface had been converted.
 *
 * The org zone here is Asia/Manila deliberately: it differs from every plausible CI
 * runner zone (UTC, America/New_York), so these assertions fail on browser-local
 * behaviour rather than passing by coincidence. Every expectation below is the
 * MANILA wall clock of the fixture instant, and is correct in any runner zone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

const ORG_TZ = 'Asia/Manila'; // UTC+8, no DST
// 2026-08-20T13:00:00Z === 9:00 PM Aug 20 in Manila (and 9:00 AM in New York).
const START_ISO = '2026-08-20T13:00:00.000Z';
const END_ISO = '2026-08-20T15:00:00.000Z'; // 11:00 PM Manila

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
    useNavigate: () => vi.fn(),
  };
});

// useScheduleTimezone reads org.timezone through this module.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false }),
  };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'SCHEDULED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: START_ISO,
  scheduled_end: END_ISO,
  is_all_day: false,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  // Late enough in the UTC day that Manila has already rolled over to Aug 2 while
  // both UTC and New York are still on Aug 1 - so the lifecycle-bar assertion below
  // can only pass through the org zone, never through the runner's.
  created_at: '2026-08-01T20:00:00.000Z',
  updated_at: '2026-08-01T20:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  assignees: [
    { user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Tina', last_name: 'Tech' } },
  ],
  service_location: null,
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/jobs/')) return { data: { job: JOB } };
    return { data: {} };
  });
  mockApi.post.mockResolvedValue({ data: { job: JOB } });
});

/** JobDetailPage is a very large tree, and these two tests drive the Actions menu, a dialog
 *  and several typed fields through it. On a loaded machine that runs past the 30s default,
 *  so they carry their own timeout - they fail on wall clock long before any assertion. */
const SLOW_UI_TIMEOUT = 90_000;

async function openRescheduleDialog() {
  renderWithProviders(<JobDetailPage />, { ability: adminAbility });
  await userEvent.click(await screen.findByRole('button', { name: /actions/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /Reschedule/ }));
  return screen.findAllByPlaceholderText('MM/DD/YYYY');
}

describe('JobDetailPage schedule rendering honours the org timezone', () => {
  it('shows the Schedule tile in the org zone, not the browser zone', async () => {
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });
    // 9:00 PM is the Manila wall clock; a browser-local read would print the
    // runner's own zone (1:00 PM in UTC, 9:00 AM in New York).
    expect(await screen.findByText('Aug 20, 9:00 PM')).toBeInTheDocument();
  });

  // JobLifecycleBar defaults `tz` when the prop is absent, so this asserts the page
  // actually threads the org zone in - a default would otherwise hide a missing wire-up.
  it('dates lifecycle milestones on the org calendar day', async () => {
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });
    // created_at is Aug 2 in Manila; Aug 1 in UTC and in New York.
    expect(await screen.findByText('Aug 2')).toBeInTheDocument();
    expect(screen.queryByText('Aug 1')).not.toBeInTheDocument();
  });

  it('prefills the Reschedule pickers with the org-zone wall clock', async () => {
    const dateFields = await openRescheduleDialog();
    // Start date / start time / end date / end time, all four on the org's clock.
    expect(dateFields.map((f) => (f as HTMLInputElement).value)).toEqual([
      '08/20/2026',
      '08/20/2026',
    ]);
    const timeFields = screen.getAllByPlaceholderText('Time');
    expect(timeFields.map((f) => (f as HTMLInputElement).value)).toEqual([
      '9:00 PM',
      '11:00 PM',
    ]);
  }, SLOW_UI_TIMEOUT);

  it('writes back the instant the org-zone wall clock denotes, not the browser one', async () => {
    const dateFields = await openRescheduleDialog();

    // Retype both halves. The time must move too: the fixture's own 9:00 PM Manila
    // happens to be 9:00 AM New York, so keeping it would let an Eastern runner
    // reach the right instant through the wrong zone and pass vacuously.
    await userEvent.clear(dateFields[0]!);
    await userEvent.type(dateFields[0]!, '08/21/2026');
    await userEvent.tab();

    const startTime = screen.getAllByPlaceholderText('Time')[0]!;
    await userEvent.clear(startTime);
    await userEvent.type(startTime, '10:00 AM');
    await userEvent.tab();

    await userEvent.click(screen.getByRole('button', { name: /^Reschedule$/ }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [, body] = mockApi.post.mock.calls.find(([url]) => String(url).includes('/assign'))!;
    // 10:00 AM Aug 21 in Manila (UTC+8) === 02:00Z that day. A browser-local read
    // would send 14:00Z from New York or 10:00Z from UTC.
    expect((body as { scheduled_start: string }).scheduled_start).toBe('2026-08-21T02:00:00.000Z');
    // The end TRAVELS with the start now, keeping the 2-hour slot a 2-hour slot: 12:00 PM
    // Aug 21 in Manila === 04:00Z. It used to stay pinned to its original instant, which
    // left a start moved past it denoting a negative range - and is converted through the
    // org zone here too, which is what this test exists to prove.
    expect((body as { scheduled_end: string }).scheduled_end).toBe('2026-08-21T04:00:00.000Z');
  }, SLOW_UI_TIMEOUT);
});
