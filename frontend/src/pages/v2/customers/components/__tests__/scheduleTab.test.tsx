import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  ScheduleTab, buildScheduleRows, EventDetailDialog,
  type CalendarEntrySummary,
} from '../scheduleTab';
import {
  projectCustomerSchedule,
  type CustomerScheduleJob, type CustomerScheduleLead, type CustomerScheduleVisit,
} from '@/lib/customers/customerSchedule';

// floating-ui, under the kit Dialog, does `new ResizeObserver(...)`.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function visit(over: Partial<CustomerScheduleVisit> & Pick<CustomerScheduleVisit, 'id' | 'visit_seq'>): CustomerScheduleVisit {
  return {
    status: 'SCHEDULED',
    scheduled_at: '2026-09-10T14:00:00.000Z',
    scheduled_end: '2026-09-10T16:00:00.000Z',
    is_all_day: false,
    created_at: '2026-09-01T00:00:00.000Z',
    crew: [],
    ...over,
  };
}

const ANA = { id: 'u1', first_name: 'Ana', last_name: 'Lee' };
const BEN = { id: 'u2', first_name: 'Ben', last_name: 'Ortiz' };

/** Three visits, a different crew on each - the demo org's J00044 shape. */
const JOB: CustomerScheduleJob = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Replace condenser',
  visits: [
    visit({ id: 'v1', visit_seq: 1, scheduled_at: '2026-09-10T14:00:00.000Z', crew: [ANA] }),
    visit({ id: 'v2', visit_seq: 2, scheduled_at: '2026-09-14T14:00:00.000Z', crew: [BEN] }),
    visit({ id: 'v3', visit_seq: 3, scheduled_at: '2026-09-16T14:00:00.000Z', crew: [ANA, BEN] }),
  ],
};

const WALKTHROUGH_LEAD: CustomerScheduleLead = {
  id: 'lead-1',
  lead_number: 'L00012',
  status: 'NEW',
  service_request: 'AC not cooling',
  visits: [visit({ id: 'w1', visit_seq: 1, scheduled_at: '2026-09-05T09:00:00.000Z', crew: [BEN] })],
};

const EVENT: CalendarEntrySummary = {
  id: 'entry-1',
  title: "Dave's follow-up call",
  description: 'Discuss financing options.',
  start: '2026-09-12T16:00:00.000Z',
  end: '2026-09-12T16:30:00.000Z',
  is_all_day: false,
  participants: [
    { id: 'p1', kind: 'USER', first_name: 'Dana', last_name: 'Brooks', name: null, email: null },
    { id: 'p2', kind: 'CUSTOMER', first_name: null, last_name: null, name: 'Doe HVAC', email: 'john@doe.com' },
  ],
};

const UNSCHEDULED_JOB: CustomerScheduleJob = { id: 'job-2', job_number: 'J00099', status: 'UNSCHEDULED', scope_notes: null, visits: [] };

const rowsOf = (jobs: CustomerScheduleJob[], leads: CustomerScheduleLead[]) =>
  projectCustomerSchedule({ jobs, leads });

function renderTab(props: Partial<Parameters<typeof ScheduleTab>[0]> = {}) {
  return render(
    <ScheduleTab
      visitRows={rowsOf([JOB], [WALKTHROUGH_LEAD])}
      calendarEntries={[EVENT]}
      onNavigateJob={vi.fn()}
      onNavigateWalkthrough={vi.fn()}
      onOpenEvent={vi.fn()}
      status="ready"
      onRetry={vi.fn()}
      timeZone="America/New_York"
      {...props}
    />,
  );
}

describe('buildScheduleRows', () => {
  it('merges every job visit, every walkthrough visit and the Events into one chronological list', () => {
    const rows = buildScheduleRows(rowsOf([JOB], [WALKTHROUGH_LEAD]), [EVENT]);

    // w1 Sep 5 -> v1 Sep 10 -> Event Sep 12 -> v2 Sep 14 -> v3 Sep 16
    expect(rows.map((r) => r.kind)).toEqual(['walkthrough', 'job', 'event', 'job', 'job']);
    expect(rows.map((r) => r.id)).toEqual(['lead-1', 'job-1', 'entry-1', 'job-1', 'job-1']);
  });

  it('sorts unscheduled (null-start) rows last, keeping timed rows in chronological order', () => {
    const rows = buildScheduleRows(rowsOf([JOB, UNSCHEDULED_JOB], [WALKTHROUGH_LEAD]), [EVENT]);
    expect(rows.at(-1)?.id).toBe('job-2');
    expect(rows.slice(0, -1).every((r) => r.start !== null)).toBe(true);
  });
});

describe('ScheduleTab', () => {
  it('lists each of a job\'s three visits as its own row - Visit 1 of 3 to Visit 3 of 3 - with its own date, time and crew', () => {
    renderTab({ visitRows: rowsOf([JOB], []), calendarEntries: [] });

    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Visit 1 of 3');
    expect(rows[0]).toHaveTextContent('Sep 10, 2026');
    expect(rows[0]).toHaveTextContent('Ana Lee');
    expect(rows[1]).toHaveTextContent('Visit 2 of 3');
    expect(rows[1]).toHaveTextContent('Sep 14, 2026');
    expect(rows[1]).toHaveTextContent('Ben Ortiz');
    expect(rows[1]).not.toHaveTextContent('Ana Lee');
    expect(rows[2]).toHaveTextContent('Visit 3 of 3');
    expect(rows[2]).toHaveTextContent('Ana Lee, Ben Ortiz');
    // A time, not just a day.
    expect(rows[0]?.textContent).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  });

  it('marks a cancelled visit as Cancelled; live visits carry no such mark', () => {
    const lead = {
      ...WALKTHROUGH_LEAD,
      visits: [
        visit({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: '2026-09-05T09:00:00.000Z' }),
        visit({ id: 'w2', visit_seq: 2, scheduled_at: '2026-09-08T09:00:00.000Z' }),
      ],
    };
    renderTab({ visitRows: rowsOf([], [lead]), calendarEntries: [] });

    const rows = screen.getAllByRole('row').slice(1);
    // A cancelled trip reads "Visit n · Cancelled" - no "of m"; the live total counts live trips only.
    expect(rows[0]).toHaveTextContent('Visit 1 · Cancelled');
    expect(rows[0]).not.toHaveTextContent('of');
    expect(rows[1]).toHaveTextContent('Visit 2 of 2');
    expect(rows[1]).not.toHaveTextContent('Cancelled');
  });

  it('a lost lead\'s cancelled walkthrough is marked Cancelled and its date struck through', () => {
    const lost: CustomerScheduleLead = {
      ...WALKTHROUGH_LEAD,
      status: 'LOST',
      visits: [visit({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: '2026-09-05T09:00:00.000Z', crew: [BEN] })],
    };
    renderTab({ visitRows: rowsOf([], [lost]), calendarEntries: [] });

    const row = screen.getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('AC not cooling');
    expect(row).toHaveTextContent('Visit 1 · Cancelled');
    expect(screen.getByText(/Sep 5, 2026/)).toHaveClass('line-through');
  });

  it('reads Unassigned for a visit with no crew', () => {
    const lead = { ...WALKTHROUGH_LEAD, visits: [visit({ id: 'w1', visit_seq: 1, crew: [] })] };
    renderTab({ visitRows: rowsOf([], [lead]), calendarEntries: [] });
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Unassigned');
  });

  it('renders a single time-ordered list across all three kinds, with a Job/Walkthrough/Event type chip', () => {
    renderTab();

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Walkthrough');
    expect(rows[0]).toHaveTextContent('Visit 1 of 1');
    expect(rows[1]).toHaveTextContent('Job');
    expect(rows[1]).toHaveTextContent('J00041');
    expect(rows[2]).toHaveTextContent('Event');
    expect(rows[2]).toHaveTextContent("Dave's follow-up call");
  });

  it('shows no Events rows when calendarEntries is empty (the caller\'s ungranted-viewer shape), but still shows jobs and walkthroughs', () => {
    renderTab({ calendarEntries: [] });

    expect(screen.queryByText('Event')).toBeNull();
    expect(screen.getByText('AC not cooling')).toBeInTheDocument();
    expect(screen.getAllByText('J00041')).toHaveLength(3);
  });

  it('renders the empty state when nothing is scheduled', () => {
    renderTab({ visitRows: [], calendarEntries: [] });
    expect(screen.getByText('Nothing scheduled yet.')).toBeInTheDocument();
  });

  it('clicking a job visit row calls onNavigateJob with the job id', () => {
    const onNavigateJob = vi.fn();
    renderTab({ visitRows: rowsOf([JOB], []), calendarEntries: [], onNavigateJob });
    fireEvent.click(screen.getByText('Visit 2 of 3').closest('tr')!);
    expect(onNavigateJob).toHaveBeenCalledWith('job-1');
  });

  it('clicking a walkthrough row calls onNavigateWalkthrough with the LEAD id', () => {
    const onNavigateWalkthrough = vi.fn();
    renderTab({ visitRows: rowsOf([], [WALKTHROUGH_LEAD]), calendarEntries: [], onNavigateWalkthrough });
    fireEvent.click(screen.getByText('AC not cooling').closest('tr')!);
    expect(onNavigateWalkthrough).toHaveBeenCalledWith('lead-1');
  });

  it('clicking an Event row calls onOpenEvent with the full entry, not just its id', () => {
    const onOpenEvent = vi.fn();
    renderTab({ visitRows: [], onOpenEvent });
    fireEvent.click(screen.getByText("Dave's follow-up call").closest('tr')!);
    expect(onOpenEvent).toHaveBeenCalledWith(EVENT);
  });
});

describe('ScheduleTab — dates on the organization clock', () => {
  it('renders a timed visit in the org time zone, not the browser zone', () => {
    // 02:00Z is 7:00 PM the evening before in Los Angeles, and 10:00 AM the same day in Manila.
    const at = [visit({ id: 'v1', visit_seq: 1, scheduled_at: '2026-09-10T02:00:00.000Z' })];
    const job: CustomerScheduleJob = { ...JOB, visits: at };

    const { unmount } = renderTab({ visitRows: rowsOf([job], []), calendarEntries: [], timeZone: 'America/Los_Angeles' });
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Sep 9, 2026, 7:00 PM');
    unmount();

    renderTab({ visitRows: rowsOf([job], []), calendarEntries: [], timeZone: 'Asia/Manila' });
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Sep 10, 2026, 10:00 AM');
  });

  it('renders an all-day visit on its org-clock day', () => {
    // Midnight Sep 10 in Manila = 16:00Z on Sep 9 - still Sep 9 anywhere in the Americas.
    const allDay = [visit({ id: 'v1', visit_seq: 1, scheduled_at: '2026-09-09T16:00:00.000Z', is_all_day: true })];
    const job: CustomerScheduleJob = { ...JOB, visits: allDay };

    renderTab({ visitRows: rowsOf([job], []), calendarEntries: [], timeZone: 'Asia/Manila' });
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Sep 10, 2026 · All day');
  });
});

describe('ScheduleTab — loading and error', () => {
  it('while the schedule loads: a skeleton, never the empty state', () => {
    renderTab({ status: 'loading', visitRows: [], calendarEntries: [] });
    expect(screen.queryByText('Nothing scheduled yet.')).toBeNull();
    expect(screen.getByTestId('schedule-loading')).toBeInTheDocument();
  });

  it('when the schedule fails to load: says so and offers Retry, never the empty state', () => {
    const onRetry = vi.fn();
    renderTab({ status: 'error', visitRows: [], calendarEntries: [], onRetry });

    expect(screen.queryByText('Nothing scheduled yet.')).toBeNull();
    expect(screen.getByText("Couldn't load this customer's schedule.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('once loaded with nothing booked: the empty state', () => {
    renderTab({ status: 'ready', visitRows: [], calendarEntries: [] });
    expect(screen.getByText('Nothing scheduled yet.')).toBeInTheDocument();
  });
});

describe('EventDetailDialog', () => {
  it('renders the title, time range, description and participants, with no edit/delete control', () => {
    render(<EventDetailDialog entry={EVENT} open onOpenChange={vi.fn()} timeZone="America/New_York" />);

    expect(screen.getByText("Dave's follow-up call")).toBeInTheDocument();
    expect(screen.getByText('Discuss financing options.')).toBeInTheDocument();
    expect(screen.getByText('Dana Brooks')).toBeInTheDocument();
    expect(screen.getByText('Doe HVAC')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    // Two "Close" buttons exist (the footer button and Radix's own dialog-close X) - both
    // read-only affordances, neither an edit/delete one, which is the thing under test.
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('renders nothing when closed', () => {
    render(<EventDetailDialog entry={EVENT} open={false} onOpenChange={vi.fn()} timeZone="America/New_York" />);
    expect(screen.queryByText("Dave's follow-up call")).toBeNull();
  });
});
