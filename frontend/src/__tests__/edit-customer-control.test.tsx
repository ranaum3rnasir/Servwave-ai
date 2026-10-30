/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.20 - "Edit customer" on the job and lead pages.
   Renders the ROUTED job page (pages/v2/jobs/JobDetailPage) and lead page (pages/v2/leads/LeadDetailPage).

   "Edit customer" (the customer record) shows only with View customers AND Edit customers, and opens the customer's
   edit form. It is not affected by a finished job or a Lost lead: the customer's own details never lock. On the job
   page it sits beside the pencil (this job only). Every person is a custom switch set read by the catalog's own keys,
   never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, LEAD_FIXTURE, ALL_JOB_ACTIONS } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const routeId = vi.hoisted(() => ({ value: 'j0000000-0000-0000-0000-000000000001' }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: routeId.value }) };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'John',
  last_name: 'Doe',
  company_name: null,
  email: 'john@doe.com',
  phone: '5551234567',
  phones: [{ phone: '5551234567', label: 'Mobile', extension: null, is_primary: true }],
  emails: [{ email: 'john@doe.com', label: null, is_primary: true }],
};

const JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: CUSTOMER,
  assignees: [],
  service_location: { id: 'l1', address_line1: '12 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};

type Held = { view: boolean; edit: boolean; editContact?: boolean };

/** The "Me" answer for a person holding exactly these switches. */
function meAnswer({ view, edit, editContact = true }: Held) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('View customers').key]: view,
      [catalogToggle('Edit customers').key]: edit,
      [catalogToggle('Edit job and lead contact details').key]: editContact,
    },
  };
}

function renderJobPage(held: Held, job: Record<string, unknown> = JOB) {
  routeId.value = JOB.id;
  localStorage.clear();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: meAnswer(held) };
    if (url.includes('/api/jobs/')) return { data: { job } };
    return { data: {} };
  });
  return renderWithProviders(<JobDetailPage />, { ability: adminAbility });
}

function renderLeadPage(held: Held, status = 'CONTACTED') {
  routeId.value = 'e0000000-0000-0000-0000-000000000001';
  localStorage.clear();
  const lead = { ...LEAD_FIXTURE, status, customer: { ...LEAD_FIXTURE.customer, id: CUSTOMER_ID } };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: meAnswer(held) };
    if (url.includes('/api/leads/')) return { data: { lead } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
  return renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
}

/** The page has drawn the customer, and the person's switches have arrived and been applied. */
async function loaded(findCustomer: () => Promise<unknown>) {
  await findCustomer();
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const jobLoaded = () => loaded(() => screen.findAllByText('(555) 123-4567'));
const leadLoaded = () => loaded(() => screen.findByText('(555) 123-4567'));
const editCustomer = () => screen.queryByRole('link', { name: 'Edit customer' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('"Edit customer" on the job page', () => {
  it('shows beside the pencil with View customers and Edit customers on, and opens the customer edit form', async () => {
    renderJobPage({ view: true, edit: true });
    await jobLoaded();

    const link = await screen.findByRole('link', { name: 'Edit customer' });
    expect(link).toHaveAttribute('href', `/customers/${CUSTOMER_ID}/edit`);
    expect(screen.getByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
  });

  it('is absent with Edit customers off, while the pencil stays', async () => {
    renderJobPage({ view: true, edit: false });
    await jobLoaded();

    expect(editCustomer()).toBeNull();
    expect(screen.getByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
  });

  it('is absent with View customers off', async () => {
    renderJobPage({ view: false, edit: true });
    await jobLoaded();

    expect(editCustomer()).toBeNull();
  });

  it('still shows on a finished job: the customer record never locks', async () => {
    renderJobPage({ view: true, edit: true }, { ...JOB, status: 'COMPLETED', completed_at: '2026-02-02T00:00:00.000Z' });
    await jobLoaded();

    expect(await screen.findByRole('link', { name: 'Edit customer' })).toBeInTheDocument();
  });
});

describe('"Edit customer" on the lead page', () => {
  it('shows with View customers and Edit customers on, and opens the customer edit form', async () => {
    renderLeadPage({ view: true, edit: true });
    await leadLoaded();

    const link = await screen.findByRole('link', { name: 'Edit customer' });
    expect(link).toHaveAttribute('href', `/customers/${CUSTOMER_ID}/edit`);
  });

  it.each([
    ['Edit customers off', { view: true, edit: false }],
    ['View customers off', { view: false, edit: true }],
  ])('is absent with %s', async (_label, held) => {
    renderLeadPage(held);
    await leadLoaded();

    expect(editCustomer()).toBeNull();
  });

  it('still shows on a Lost lead: the customer record never locks', async () => {
    renderLeadPage({ view: true, edit: true }, 'LOST');
    await leadLoaded();

    expect(await screen.findByRole('link', { name: 'Edit customer' })).toBeInTheDocument();
  });
});
