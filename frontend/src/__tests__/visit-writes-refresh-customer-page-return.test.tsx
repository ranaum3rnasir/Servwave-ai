/**
 * The reported defect end to end (visits-and-task-categories slice 01): a job booked from the job
 * page still read "Unscheduled" on the customer page after navigating back in the app, until a
 * reload.
 *
 * Runs with the APP's cache settings (five-minute staleTime, no refetch on focus), because that
 * is what made the page serve its old copy: open the customer page, leave it, book a visit, come
 * back - and the Jobs tab must show the booked date.
 */
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import CustomerDetailPage from '@/pages/v2/customers/CustomerDetailPage';
import { formatDate } from '@/pages/v2/customers/components/detailTabs';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useParams: () => ({ id: 'c0000000-0000-0000-0000-000000000001' }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
const BOOKED_START = '2026-10-02T13:00:00.000Z';

const customerPayload = () => ({
    customer: {
      id: CUSTOMER_ID,
      customer_number: 'C00001',
      first_name: 'Pat',
      last_name: 'Sample',
      company_name: null,
      email: 'pat@example.test',
      phone: '5551234567',
      extra_emails: [],
      custom_fields: {},
      created_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      is_active: true,
      tags: [],
      service_locations: [],
      _count: { leads: 0, jobs: 1 },
      activity_notes: [],
      orphan_invoices: [],
      invoices: [],
    },
    summary: {
      financials: {
        lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0,
        paid_invoice_count: 0, unpaid_invoice_count: 0,
      },
      estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
      deposits: { collected: 0, pending: 0 },
      leads: { open: 0, active: 0 },
      tasks: { open: 0 },
      jobs: { active: 1 },
    },
});

/** The Jobs tab's page (slice 06): one job, whatever its schedule. */
const jobsPage = (scheduledStart: string | null) => ({
  jobs: [{
    id: 'job-52',
    job_number: 'J00052',
    status: scheduledStart ? 'SCHEDULED' : 'UNSCHEDULED',
    scope_notes: 'Gate repair',
    completed_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    // The endpoint serves the job-window date on each row.
    scheduled_start: scheduledStart,
    assignees: [],
    service_location: null,
    invoices: [],
  }],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
});

/** The per-visit feed behind the Schedule tab (slice 04): the booked visit, once booked. */
const schedule = (scheduledStart: string | null) => ({
  jobs: [{
    id: 'job-52',
    job_number: 'J00052',
    status: scheduledStart ? 'SCHEDULED' : 'UNSCHEDULED',
    scope_notes: 'Gate repair',
    visits: scheduledStart
      ? [{
          id: 'visit-1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: scheduledStart, scheduled_end: null,
          is_all_day: false, created_at: '2026-09-28T00:00:00.000Z', crew: [],
        }]
      : [],
  }],
  leads: [],
});

/** What the server says the job's schedule is right now. */
let serverScheduledStart: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  serverScheduledStart = null;
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/customers/${CUSTOMER_ID}`) return { data: customerPayload() };
    if (url === `/api/customers/${CUSTOMER_ID}/jobs`) return { data: jobsPage(serverScheduledStart) };
    if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return { data: schedule(serverScheduledStart) };
    return { data: {} };
  });
  mockApi.post.mockImplementation(async () => {
    serverScheduledStart = BOOKED_START;
    return { data: {} };
  });
});

function appQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
}

function renderIn(qc: QueryClient, ui: ReactElement) {
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={320}>
        <MemoryRouter>
          <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>{ui}</AbilityProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function jobRowOnCustomerPage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Jobs' }));
  return (await screen.findByText('J00052')).closest('tr')!;
}

describe('returning to the customer page after booking a visit', () => {
  it('shows the booked date without a reload', async () => {
    const user = userEvent.setup();
    const qc = appQueryClient();

    // 1. The office opens the customer page: the job is not booked yet.
    const customerPage = renderIn(qc, <CustomerDetailPage />);
    expect(within(await jobRowOnCustomerPage(user)).queryByText(formatDate(BOOKED_START))).not.toBeInTheDocument();
    customerPage.unmount();

    // 2. They go to the job and book its visit.
    const jobPage = renderIn(qc, <VisitScheduleDialog open onOpenChange={() => {}} jobId="job-52" canAssignCrew={false} />);
    await user.type(screen.getByLabelText('Start date'), '10/02/2026');
    await user.tab();
    await user.type(screen.getByLabelText('Start time'), '9:00 AM');
    await user.tab();
    await user.type(screen.getByLabelText('End date'), '10/02/2026');
    await user.tab();
    await user.type(screen.getByLabelText('End time'), '11:00 AM');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Book visit' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-52/visits', expect.anything()));
    jobPage.unmount();

    // 3. Back on the customer page, well inside the five-minute staleTime.
    renderIn(qc, <CustomerDetailPage />);
    const row = await jobRowOnCustomerPage(user);
    expect(await within(row).findByText(formatDate(BOOKED_START))).toBeInTheDocument();
  });
});
