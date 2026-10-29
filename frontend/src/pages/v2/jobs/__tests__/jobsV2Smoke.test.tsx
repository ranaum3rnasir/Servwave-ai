import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../JobsPage';
import JobDetailPage from '../JobDetailPage';
import JobFormPage from '../JobFormPage';

/**
 * Mount smoke for the three v2 jobs pages.
 *
 * The legacy suites in `src/__tests__` are the behavioural contract and stay
 * pointed at the legacy pages, which this branch does not touch. This file
 * exists for the one thing those cannot cover: that the rebuilt pages mount at
 * all, with the tab set, KPI labels and permission gates the legacy pages have.
 */

// floating-ui, under Radix's dropdown and popover, does `new ResizeObserver(...)`.
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
  };
});

const mockApi = vi.mocked(api);

const JOB_LIST_FIXTURE = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: null,
        customer_number: 'C00001',
      },
      assignees: [],
      service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    unassigned: 2,
    scheduled: 5,
    in_progress: 1,
    completed: 3,
    cancelled: 1,
    need_invoices: 4,
  },
  // The list fires several GETs (jobs + assignable users + departments + tags);
  // one resolver shape that satisfies all of them is enough here.
  users: [],
  departments: [],
  tags: [],
};

const BASE_JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  job_type: 'HVAC Installation',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: '2026-05-10T09:00:00.000Z',
  scheduled_end: null,
  started_at: '2026-05-10T09:00:00.000Z',
  on_site_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  signature_at: null,
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [],
  service_location: null,
  estimate: null,
  invoices: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
};

const FINANCIALS = { final_invoice: null, invoices: [], payments: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 JobsPage', () => {
  it('renders the header, the six KPI tiles and a row', async () => {
    mockApi.get.mockResolvedValue({ data: JOB_LIST_FIXTURE });

    renderWithProviders(<JobsPage />, { initialEntries: ['/jobs'] });

    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    expect(await screen.findByText('J00001')).toBeInTheDocument();
    // `findAllByText`: several of these strings appear twice on a loaded list -
    // once as the tile label and once as a column header or a status chip.
    for (const label of ['Unscheduled', 'Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Need Invoices']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByPlaceholderText('Search jobs...')).toBeInTheDocument();
  });

  it('hides the New Job button without `create Job`', async () => {
    mockApi.get.mockResolvedValue({ data: JOB_LIST_FIXTURE });

    renderWithProviders(<JobsPage />, { initialEntries: ['/jobs'] });

    await screen.findByRole('heading', { name: 'Jobs' });
    expect(screen.queryByRole('button', { name: /new job/i })).not.toBeInTheDocument();
  });
});

describe('v2 JobDetailPage', () => {
  it('renders the ten command-center tabs in order', async () => {
    const ability = buildAbility([
      { action: 'read', subject: 'Communication' },
      { action: 'read', subject: 'Inventory' },
      { action: 'read', subject: 'Estimate' },
      { action: 'read', subject: 'Invoice' },
    ]);
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/financials')) return { data: FINANCIALS };
      if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability, initialEntries: ['/jobs/j0000000-0000-0000-0000-000000000001'] });

    expect(await screen.findByRole('heading', { name: /J00001/ })).toBeInTheDocument();

    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent?.trim());
    expect(tabs).toEqual([
      'Overview',
      // Multi-visit S2: a job holds its own visits now.
      'Visits',
      'Items',
      'Logistics',
      'Estimates',
      'Attachments',
      'Communication',
      'Tasks',
      'Notes',
      'Payments',
    ]);
  });

  it('renders the not-found branch when the job does not resolve', async () => {
    mockApi.get.mockResolvedValue({ data: {} });

    renderWithProviders(<JobDetailPage />, { initialEntries: ['/jobs/j0000000-0000-0000-0000-000000000001'] });

    expect(await screen.findByText('Job not found')).toBeInTheDocument();
  });
});

describe('v2 JobFormPage', () => {
  it('renders the create form when `create Job` is granted', async () => {
    const ability = buildAbility([{ action: 'create', subject: 'Job' }]);
    mockApi.get.mockResolvedValue({ data: {} });

    renderWithProviders(<JobFormPage />, { ability, initialEntries: ['/jobs/new'] });

    expect(await screen.findByRole('heading', { name: 'New Job' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create job/i })).toBeInTheDocument();
  });

  it('redirects away without `create Job`', async () => {
    mockApi.get.mockResolvedValue({ data: {} });

    renderWithProviders(<JobFormPage />, { initialEntries: ['/jobs/new'] });

    expect(screen.queryByRole('heading', { name: 'New Job' })).not.toBeInTheDocument();
  });
});
