/**
 * A cross-midnight job must be VISIBLE on the routed board.
 *
 * react-big-calendar's TimeGrid routes an event into the all-day strip when
 * `allDay(event) || startAndEndAreDateOnly || (!showMultiDayTimes && !isSameDate(start, end))`.
 * We never pass showMultiDayTimes, so ANY event crossing a calendar day lands in the strip
 * whatever its is_all_day flag says. The strip is collapsed to `max-height: 0` until the page
 * puts `has-allday-events` on the calendar container - and the v2 page gated that class on
 * `isAllDayEvent` rather than `occupiesAllDayStrip`, so a timed multi-day job was rendered
 * into a zero-height container and simply vanished from the week.
 *
 * Reported against prod job 698776 (Alpha Doors): Aug 17 9:00 AM -> Aug 21 9:00 AM,
 * is_all_day false, status SCHEDULED. It was in the DOM the whole time, zero pixels tall.
 *
 * The class is asserted rather than a pixel height because jsdom applies no stylesheet -
 * `has-allday-events` IS the switch schedule-dark.css keys the strip's height off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
// App.tsx wraps the whole tree in this one provider; the board's kit tooltips throw without it.
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';

import SchedulePage from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const job = (over: Record<string, unknown>) => ({
  id: 'job-1',
  job_number: '698776',
  status: 'SCHEDULED',
  scope_notes: 'Door repair',
  customer: { first_name: 'Raul', last_name: 'Herrera', company_name: null },
  assignees: [],
  tags: [],
  is_all_day: false,
  ...over,
});

function mockJobs(jobs: Array<Record<string, unknown>>) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

/** The container schedule-dark.css keys the strip's collapse off. */
const calendarShell = (container: HTMLElement) =>
  container.querySelector('.schedule-cal') as HTMLElement | null;

describe('v2 schedule board - the all-day strip opens for anything rbc puts in it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the strip for a TIMED job that crosses midnight', async () => {
    // The reported job, in org-zone terms: Aug 17 9:00 AM -> Aug 21 9:00 AM, is_all_day FALSE.
    mockJobs([job({
      scheduled_start: '2026-08-17T13:00:00.000Z',
      scheduled_end: '2026-08-21T13:00:00.000Z',
    })]);

    const { container } = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );

    // The board renders the job in more than one place (grid + sidebar); any of them proves
    // the query resolved and the memo has run.
    await screen.findAllByText(/698776/);
    expect(calendarShell(container)).toHaveClass('has-allday-events');
  });

  it('opens the strip for a flagged all-day job', async () => {
    mockJobs([job({
      is_all_day: true,
      scheduled_start: '2026-08-17T04:00:00.000Z',
      scheduled_end: '2026-08-18T04:00:00.000Z',
    })]);

    const { container } = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );

    // The board renders the job in more than one place (grid + sidebar); any of them proves
    // the query resolved and the memo has run.
    await screen.findAllByText(/698776/);
    expect(calendarShell(container)).toHaveClass('has-allday-events');
  });

  it('leaves the strip collapsed when every job fits inside one day', async () => {
    // The strip costs vertical space the grid needs, so it must stay shut by default -
    // "always open" is not an acceptable fix for the bug above.
    mockJobs([job({
      scheduled_start: '2026-08-17T13:00:00.000Z',
      scheduled_end: '2026-08-17T15:00:00.000Z',
    })]);

    const { container } = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: ADMIN },
    );

    // The board renders the job in more than one place (grid + sidebar); any of them proves
    // the query resolved and the memo has run.
    await screen.findAllByText(/698776/);
    expect(calendarShell(container)).not.toHaveClass('has-allday-events');
  });
});
