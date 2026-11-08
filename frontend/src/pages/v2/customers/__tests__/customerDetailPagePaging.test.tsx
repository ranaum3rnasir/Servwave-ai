import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * Visits slice 06 - the customer page pages through ALL of a customer's jobs and leads.
 *
 * The detail payload used to embed only the 20 newest jobs, and the Leads tab asked for 20 leads,
 * so a long-standing customer's older work was unreachable from their page. Both tabs now show
 * numbered pages with the total under the list, served page by page by the backend.
 *
 * `pages/v2/customers/CustomerDetailPage.tsx` is the routed page (`customers.routes.tsx`).
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000006';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const mockApi = vi.mocked(api);

/** Position 1 is the newest; J00021 is the 21st row, the first one past the old 20-row cap. */
const jobNumber = (pos: number) => `J${String(pos).padStart(5, '0')}`;
function makeJobs(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const pos = i + 1;
    return {
      id: `job-${pos}`,
      job_number: jobNumber(pos),
      status: 'SCHEDULED',
      scope_notes: null,
      completed_at: null,
      created_at: new Date(Date.UTC(2026, 8, 1) - pos * 86_400_000).toISOString(),
      scheduled_start: null as string | null,
      assignees: [],
      service_location: { address_line1: `${pos} Oak Ave`, city: 'Springfield', state: 'IL' },
      invoices: [],
    };
  });
}

const leadRequest = (pos: number) => `Service request #${pos}`;
function makeLeads(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const pos = i + 1;
    return {
      id: `lead-${pos}`,
      lead_number: `L${String(pos).padStart(5, '0')}`,
      status: 'NEW',
      service_request: leadRequest(pos),
      created_at: new Date(Date.UTC(2026, 8, 1) - pos * 86_400_000).toISOString(),
      lead_assignees: [],
      estimates: [],
    };
  });
}

function detail(jobs: ReturnType<typeof makeJobs>, activeJobs: number) {
  return {
    customer: {
      id: CUSTOMER_ID,
      customer_number: 'C00006',
      first_name: 'Nora',
      last_name: 'Quill',
      company_name: null,
      email: 'nora@example.test',
      phone: '5550001111',
      phone_ext: null,
      secondary_phone: null,
      ad_source: null,
      allow_billing: false,
      tax_exempt: false,
      payment_type: null,
      extra_emails: [],
      custom_fields: {},
      created_at: '2020-01-01T00:00:00.000Z',
      archived_at: null,
      is_active: true,
      tags: [],
      service_locations: [],
      _count: { leads: 0, jobs: jobs.length },
      // What the detail payload embeds: the 20 newest only.
      jobs: jobs.slice(0, 20),
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
      jobs: { active: activeJobs },
    },
  };
}

function pageOf<T>(rows: T[], params: unknown) {
  const { page = 1, limit = 25 } = (params ?? {}) as { page?: number; limit?: number };
  return {
    rows: rows.slice((page - 1) * limit, page * limit),
    pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) },
  };
}

interface World {
  jobs: ReturnType<typeof makeJobs>;
  leads: ReturnType<typeof makeLeads>;
  schedule?: unknown;
  activeJobs?: number;
  /** Holds every jobs/leads request for this page until `release` resolves (a slow network). */
  hold?: { page: number; release: Promise<void> };
  /** Requests that fail with a 500 while listed, as `jobs:2` / `leads:1` (list:page). */
  failing?: Set<string>;
}

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const release = new Promise<void>((resolve) => { open = resolve; });
  return { release, open };
}

/** A live backend double: every request reads the CURRENT `world`, so a test can change it mid-run. */
function serve(world: World) {
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Chicago' } };
    if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return { data: world.schedule ?? { jobs: [], leads: [] } };
    const requestedPage = (config?.params as { page?: number } | undefined)?.page;
    if (world.hold && requestedPage === world.hold.page) await world.hold.release;
    const list = url === `/api/customers/${CUSTOMER_ID}/jobs` ? 'jobs' : url === '/api/leads' ? 'leads' : null;
    if (list && world.failing?.has(`${list}:${requestedPage ?? 1}`)) {
      throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
    }
    if (url === `/api/customers/${CUSTOMER_ID}/jobs`) {
      const { rows, pagination } = pageOf(world.jobs, config?.params);
      return { data: { jobs: rows, pagination } };
    }
    if (url === `/api/customers/${CUSTOMER_ID}`) return { data: detail(world.jobs, world.activeJobs ?? world.jobs.length) };
    if (url === '/api/leads') {
      const { rows, pagination } = pageOf(world.leads, config?.params);
      return { data: { leads: rows, pagination } };
    }
    return { data: {} };
  });
}

function renderPage() {
  return renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });
}

/** The job numbers on the Jobs tab's current page, in order. */
function visibleJobNumbers(): string[] {
  return screen.queryAllByText(/^J\d{5}$/).map((el) => el.textContent ?? '');
}

async function openJobsTab() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
  await screen.findByText(jobNumber(1));
}

async function nextPage() {
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
}

/** The numbered pager under the list: which page numbers it draws, and which one is current. */
function expectPager(current: number, pages: number[]) {
  const nav = screen.getByRole('navigation', { name: 'Pagination' });
  expect(within(nav).getAllByRole('button', { name: /^Page \d+$/ }).map((b) => Number(b.textContent))).toEqual(pages);
  expect(within(nav).getByRole('button', { name: `Page ${current}` })).toHaveAttribute('aria-current', 'page');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerDetailPage - numbered pages on the Jobs tab (visits slice 06)', () => {
  it('job 21 is reachable: page 2 lists the 21st to 40th newest jobs, and the total is shown', async () => {
    serve({ jobs: makeJobs(45), leads: [] });
    renderPage();
    await openJobsTab();

    expect(visibleJobNumbers()).toHaveLength(20);
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 1-20 of 45');
    expectPager(1, [1, 2, 3]);

    await nextPage();
    await screen.findByText(jobNumber(21));
    expect(visibleJobNumbers()).toEqual(Array.from({ length: 20 }, (_, i) => jobNumber(21 + i)));
    expectPager(2, [1, 2, 3]);
  });

  it('numbered pages: clicking 3 loads jobs 41-60, and 3 becomes the current page', async () => {
    serve({ jobs: makeJobs(150), leads: [] });
    renderPage();
    await openJobsTab();

    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));

    await screen.findByText(jobNumber(41));
    expect(visibleJobNumbers()).toEqual(Array.from({ length: 20 }, (_, i) => jobNumber(41 + i)));
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 41-60 of 150');
    expectPager(3, [1, 2, 3, 4, 5, 8]);
  });

  it('every job appears exactly once across the pages - same page size, no duplicates, no gaps', async () => {
    serve({ jobs: makeJobs(45), leads: [] });
    renderPage();
    await openJobsTab();

    const seen: string[] = [...visibleJobNumbers()];
    await nextPage();
    await screen.findByText(jobNumber(21));
    seen.push(...visibleJobNumbers());
    await nextPage();
    await screen.findByText(jobNumber(41));
    const last = visibleJobNumbers();
    expect(last).toHaveLength(5);
    seen.push(...last);

    expect(seen).toEqual(Array.from({ length: 45 }, (_, i) => jobNumber(i + 1)));
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('a customer with 150 jobs: eight pages, and the last page holds the oldest ten', async () => {
    serve({ jobs: makeJobs(150), leads: [] });
    renderPage();
    await openJobsTab();

    expectPager(1, [1, 2, 3, 4, 5, 8]);
    fireEvent.click(screen.getByRole('button', { name: 'Page 8' }));
    await screen.findByText(jobNumber(150));
    expect(visibleJobNumbers()).toEqual(Array.from({ length: 10 }, (_, i) => jobNumber(141 + i)));
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 141-150 of 150');
  });

  it('exactly one page of jobs (20): one page, nothing to page to', async () => {
    serve({ jobs: makeJobs(20), leads: [] });
    renderPage();
    await openJobsTab();

    expect(visibleJobNumbers()).toHaveLength(20);
    expectPager(1, [1]);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('one job: shown with its total', async () => {
    serve({ jobs: makeJobs(1), leads: [] });
    renderPage();
    await openJobsTab();

    expect(visibleJobNumbers()).toEqual([jobNumber(1)]);
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 1-1 of 1');
  });

  it('no jobs: the empty state, and no pager', async () => {
    serve({ jobs: [], leads: [] });
    renderPage();

    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('the last page emptied by a delete steps back to the new last page', async () => {
    const world: World = { jobs: makeJobs(41), leads: [] };
    serve(world);
    const { queryClient } = renderPage();
    await openJobsTab();
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await screen.findByText(jobNumber(41));

    // Job 41 is deleted elsewhere; deleting a job runs the shared visit-write refresh.
    world.jobs = makeJobs(40);
    refreshAfterVisitWrite(queryClient, { jobId: 'job-41' });

    await screen.findByText(jobNumber(21));
    expect(visibleJobNumbers()).toEqual(Array.from({ length: 20 }, (_, i) => jobNumber(21 + i)));
    expectPager(2, [1, 2]);
  });

  it('while the stepped-back page loads, the tab shows it is loading - never "No jobs yet." for a customer who has jobs', async () => {
    const slowPage2 = gate();
    const world: World = { jobs: makeJobs(41), leads: [] };
    serve(world);
    const { queryClient } = renderPage();
    await openJobsTab();
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await screen.findByText(jobNumber(41));

    world.jobs = makeJobs(40);
    world.hold = { page: 2, release: slowPage2.release };
    refreshAfterVisitWrite(queryClient, { jobId: 'job-41' });

    // Page 3 comes back empty and the page steps back to 2, whose answer is still in flight.
    await waitFor(() => expect(screen.queryByText(jobNumber(41))).toBeNull());
    expect(await screen.findByTestId('list-loading')).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet.')).toBeNull();

    slowPage2.open();
    await screen.findByText(jobNumber(21));
    expect(screen.queryByText('No jobs yet.')).toBeNull();
    expectPager(2, [1, 2]);
  });

  it('Active Jobs counts every active job the reader can open, not only the first page', async () => {
    serve({ jobs: makeJobs(45), leads: [], activeJobs: 45 });
    renderPage();

    const kpi = (await screen.findByText('Active Jobs')).parentElement!;
    await waitFor(() => expect(kpi).toHaveTextContent('45'));
  });
});

describe('CustomerDetailPage - numbered pages on the Leads tab (visits slice 06)', () => {
  it('lead 21 is reachable: page 2 lists the 21st to 25th newest leads, and the total is shown', async () => {
    serve({ jobs: [], leads: makeLeads(25) });
    renderPage();

    await screen.findByText(leadRequest(1));
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 1-20 of 25');
    expect(screen.queryByText(leadRequest(21))).toBeNull();

    await nextPage();
    await screen.findByText(leadRequest(21));
    for (let pos = 21; pos <= 25; pos += 1) expect(screen.getByText(leadRequest(pos))).toBeInTheDocument();
    expect(screen.queryByText(leadRequest(20))).toBeNull();
    expectPager(2, [1, 2]);
  });
});

describe('CustomerDetailPage - Leads tab step-back (visits slice 06)', () => {
  it('a lead page emptied by a delete shows loading while the previous page loads, not "No leads yet."', async () => {
    const slowPage1 = gate();
    const world: World = { jobs: [], leads: makeLeads(21) };
    serve(world);
    const { queryClient } = renderPage();
    await screen.findByText(leadRequest(1));
    await nextPage();
    await screen.findByText(leadRequest(21));

    // Lead 21 is deleted; page 1 is already cached, so hold its REFETCH to catch the empty state.
    world.leads = makeLeads(20);
    world.hold = { page: 1, release: slowPage1.release };
    queryClient.removeQueries({ queryKey: ['customer-leads', CUSTOMER_ID, { page: 1, limit: 20 }] });
    refreshAfterVisitWrite(queryClient, { leadId: 'lead-21' });

    await waitFor(() => expect(screen.queryByText(leadRequest(21))).toBeNull());
    expect(await screen.findByTestId('list-loading')).toBeInTheDocument();
    expect(screen.queryByText('No leads yet.')).toBeNull();

    slowPage1.open();
    await screen.findByText(leadRequest(1));
    expectPager(1, [1]);
  });
});

describe('CustomerDetailPage - a failed page request is an error, not "empty" (visits slice 06)', () => {
  it('Jobs: the first page fails - an error with Retry, never "No jobs yet."; Retry loads it', async () => {
    const world: World = { jobs: makeJobs(45), leads: [], failing: new Set(['jobs:1']) };
    serve(world);
    renderPage();

    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
    expect(await screen.findByText("Couldn't load this customer's jobs.")).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet.')).toBeNull();

    world.failing = new Set();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(jobNumber(1));
    expect(screen.queryByText("Couldn't load this customer's jobs.")).toBeNull();
    expectPager(1, [1, 2, 3]);
  });

  it('Leads: the first page fails - an error with Retry, never "No leads yet."; Retry loads it', async () => {
    const world: World = { jobs: [], leads: makeLeads(25), failing: new Set(['leads:1']) };
    serve(world);
    renderPage();

    expect(await screen.findByText("Couldn't load this customer's leads.")).toBeInTheDocument();
    expect(screen.queryByText('No leads yet.')).toBeNull();

    world.failing = new Set();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(leadRequest(1));
    expectPager(1, [1, 2]);
  });

  it('Jobs: the next page fails - the page on screen stays with its pager, the failure is named, Retry loads it', async () => {
    const world: World = { jobs: makeJobs(45), leads: [], failing: new Set(['jobs:2']) };
    serve(world);
    renderPage();
    await openJobsTab();

    await nextPage();
    expect(await screen.findByText("Couldn't load page 2.")).toBeInTheDocument();
    expect(visibleJobNumbers()).toEqual(Array.from({ length: 20 }, (_, i) => jobNumber(1 + i)));
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 1-20 of 45');
    expectPager(1, [1, 2, 3]);

    world.failing = new Set();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(jobNumber(21));
    expect(screen.queryByText("Couldn't load page 2.")).toBeNull();
    expectPager(2, [1, 2, 3]);
  });

  it('Leads: the next page fails - the page on screen stays with its pager, Retry loads it', async () => {
    const world: World = { jobs: [], leads: makeLeads(25), failing: new Set(['leads:2']) };
    serve(world);
    renderPage();
    await screen.findByText(leadRequest(1));

    await nextPage();
    expect(await screen.findByText("Couldn't load page 2.")).toBeInTheDocument();
    expect(screen.getByText(leadRequest(1))).toBeInTheDocument();
    expectPager(1, [1, 2]);

    world.failing = new Set();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(leadRequest(21));
    expectPager(2, [1, 2]);
  });
});

describe('CustomerDetailPage - page state is per tab (visits slice 06)', () => {
  it('changing tabs keeps each tab on its own page', async () => {
    serve({ jobs: makeJobs(45), leads: makeLeads(25) });
    renderPage();

    await screen.findByText(leadRequest(1));
    await nextPage();
    await screen.findByText(leadRequest(21));

    await openJobsTab();
    expectPager(1, [1, 2, 3]);
    await nextPage();
    await screen.findByText(jobNumber(21));

    fireEvent.click(screen.getByRole('tab', { name: 'Leads' }));
    expect(await screen.findByText(leadRequest(21))).toBeInTheDocument();
    expectPager(2, [1, 2]);

    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }));
    expect(await screen.findByText(jobNumber(21))).toBeInTheDocument();
    expectPager(2, [1, 2, 3]);
  });
});

describe('CustomerDetailPage - the Schedule tab is not paged (visits slice 06)', () => {
  it('lists the upcoming visit of a job that sits on Jobs page 2', async () => {
    const jobs = makeJobs(45);
    // The Jobs tab's date rides on its page, as the endpoint computes it.
    jobs[29] = { ...jobs[29]!, scheduled_start: '2099-04-02T15:00:00.000Z' };
    const job30 = jobs[29]!;
    serve({
      jobs,
      leads: [],
      schedule: {
        jobs: [{
          id: job30.id, job_number: job30.job_number, status: 'SCHEDULED', scope_notes: 'Rehang side gate',
          visits: [{
            id: 'v-30', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2099-04-02T15:00:00.000Z',
            scheduled_end: null, is_all_day: false, created_at: '2026-01-01T00:00:00.000Z', crew: [],
          }],
        }],
        leads: [],
      },
    });
    renderPage();

    // Job 30 is not on the Jobs tab's first page...
    await openJobsTab();
    expect(screen.queryByText(jobNumber(30))).toBeNull();
    await nextPage();
    const onPage2 = (await screen.findByText(jobNumber(30))).closest('tr')!;
    // ...and its Scheduled date comes with page 2 (the per-visit feed is not fetched for it).
    await waitFor(() => expect(within(onPage2).getByText('Apr 2, 2099')).toBeInTheDocument());

    // The Schedule tab lists its visit whatever page the Jobs tab is on.
    fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
    expect(await screen.findByText('Rehang side gate')).toBeInTheDocument();
  });
});
