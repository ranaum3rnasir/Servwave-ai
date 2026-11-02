/**
 * Roles & Permissions, PRD 3, slice S03.21 - the render sweep. Every people screen in PRD 3's scope is rendered
 * through its ROUTED file with the people slots empty, and its visible words (text, placeholders, labels and
 * titles) are read for the two words PRD 3 retired: "Unassigned" (each empty slot is named for that slot instead:
 * "No owner", "No dispatcher") and "Assigned To" (the lead's Owner is called Owner).
 *
 * The screens: the lead page, the Leads list (the "No owner" card, the filters, the column and the export), the
 * job page's Team card, the new-lead form and the new-job form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AxiosRequestConfig } from 'axios';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import LeadsPage from '@/pages/v2/leads/LeadsPage';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';

type AuthState = ReturnType<typeof useAuthStore.getState>;

const hoisted = vi.hoisted(() => ({
  toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
  downloadCSV: vi.fn(),
}));
vi.mock('@/lib/inventory/csv', () => ({ toCSV: hoisted.toCSV, downloadCSV: hoisted.downloadCSV }));

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const route = vi.hoisted(() => ({ id: '' }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: route.id }), useNavigate: () => vi.fn() };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const mockApi = vi.mocked(api);
const everything = buildAbility([{ action: 'manage', subject: 'all' }]);

/** The words a person can read on the page: its text, and what sits in placeholders, labels and titles. */
function wordsOnPage(): string {
  const attributes = ['placeholder', 'aria-label', 'title', 'alt', 'data-placeholder'];
  const found: string[] = [document.body.textContent ?? ''];
  document.body.querySelectorAll('*').forEach((el) => {
    for (const name of attributes) {
      const value = el.getAttribute(name);
      if (value) found.push(value);
    }
  });
  return found.join('\n');
}

const RETIRED_WORDS = /unassigned|assigned to/i;
const expectNoRetiredWords = () => expect(wordsOnPage()).not.toMatch(RETIRED_WORDS);

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001', first_name: 'John', last_name: 'Doe', company_name: null,
  phone: '5551234567', customer_number: 'C-1', ad_source: null,
};
const LEAD_WITH_NOBODY = {
  ...LEAD_FIXTURE,
  commission_owner: null,
  lead_assignees: [],
  dispatcher: null,
  walkthrough_performers: [],
};
const JOB_WITH_NOBODY = {
  id: 'j0000000-0000-0000-0000-000000000001', job_number: 'J00001', status: 'SCHEDULED', job_type: 'Install', description: 'Replace the unit',
  scope_notes: null, estimated_duration: null, completion_notes: null, scheduled_start: null, scheduled_end: null, started_at: null,
  completed_at: null, cancelled_at: null, cancelled_reason: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  dispatcher: null, salesperson: null, assignees: [], visits: [], customer: { ...CUSTOMER, email: 'john@doe.com' },
  service_location: { id: 'l-1', address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
  estimate: null, invoices: [], linked_estimates: [], tags: [], source_plan_id: null, source_plan: null, actions: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The forms are the create pages: no record id in the route unless a case sets one.
  route.id = '';
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.mocked(useAuthStore).mockImplementation((selector: (s: AuthState) => unknown) =>
    selector({ user: { ...CREATOR, email: 'casey@example.com', role: 'TECHNICIAN', organization_id: 'org-1' } } as AuthState),
  );
});

describe('the lead page', () => {
  it('names the empty Owner and Dispatcher for what they are, with nothing unassigned and no Assigned To', async () => {
    route.id = LEAD_WITH_NOBODY.id;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/api/leads/')) return { data: { lead: LEAD_WITH_NOBODY } };
      if (url.includes('/api/users')) return { data: { users: [] } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
    renderWithProviders(<LeadDetailPage />, { ability: everything });

    await screen.findByText('Owner');
    expect(await screen.findByText('No owner')).toBeInTheDocument();
    expect(screen.getByText('No dispatcher')).toBeInTheDocument();
    expectNoRetiredWords();
  });
});

describe('the Leads list', () => {
  const LEAD_ROW = {
    id: 'e0000000-0000-0000-0000-000000000001', lead_number: 'L00001', status: 'NEW', service_request: 'AC not cooling',
    job_type: null, service_city: 'Austin', service_state: 'TX', walkthrough_scheduled_at: null,
    walkthrough_completed_at: null, contacted_at: null, service_location_id: null,
    created_at: '2026-08-24T22:00:00.000Z', customer: CUSTOMER, commission_owner: null, lead_assignees: [], estimates: [],
  };

  beforeEach(() => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/leads') {
        return {
          data: {
            leads: [LEAD_ROW],
            pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
            stats: { total: 1, new_this_week: 0, no_owner: 1, won: 0, lost: 0 },
          },
        };
      }
      if (url === '/api/users/assignable') return { data: [{ id: 'u-1', first_name: 'Olive', last_name: 'Owner', role: 'SALES', department: null }] };
      return { data: {} };
    });
  });

  it('says No owner on the card and a dash in the column, with nothing unassigned and no Assigned To', async () => {
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    expect(screen.getByText('No owner')).toBeInTheDocument();
    expectNoRetiredWords();
  });

  it('offers no Unassigned or Assigned To in the filters', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^filter$/i }));
    await user.click(await screen.findByRole('tab', { name: 'Owner' }));
    await screen.findByRole('checkbox', { name: 'No owner' });
    expectNoRetiredWords();

    await user.click(screen.getByRole('tab', { name: 'Dispatcher' }));
    await screen.findByRole('checkbox', { name: 'No dispatcher' });
    expectNoRetiredWords();
  });

  it('exports an Owner column and no Assigned To column', async () => {
    const user = userEvent.setup();
    // Export leads needs View leads.
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'export', subject: 'Lead' }]),
    });
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^export$/i }));
    await user.click(await screen.findByRole('menuitem', { name: /current page/i }));

    const [rows] = hoisted.toCSV.mock.calls.at(-1)!;
    const columns = Object.keys((rows as Record<string, unknown>[])[0]!);
    expect(columns).toContain('Owner');
    expect(columns.join('\n')).not.toMatch(RETIRED_WORDS);
    expect(JSON.stringify(rows)).not.toMatch(RETIRED_WORDS);
  });
});

describe('the new-lead form', () => {
  it('says Owner and Dispatcher, and an empty one reads No owner or No dispatcher', async () => {
    mockApi.get.mockImplementation(async (url: string, _config?: AxiosRequestConfig) => {
      if (url === '/api/leads/creator-prefill') return { data: { prefill: { owner_id: null, dispatcher_id: null } } };
      if (url === '/api/users/assignable') return { data: [] };
      return { data: {} };
    });
    // Create leads needs View leads and Edit leads.
    renderWithProviders(<LeadFormPage />, {
      ability: buildAbility([
        { action: 'read', subject: 'Lead' },
        { action: 'update', subject: 'Lead' },
        { action: 'create', subject: 'Lead' },
      ]),
      initialEntries: ['/leads/create'],
    });

    expect(await screen.findByText('No owner')).toBeInTheDocument();
    expect(screen.getByText('No dispatcher')).toBeInTheDocument();
    expectNoRetiredWords();
  });

  it('says the same for a person who can choose the people, with the pickers empty', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/leads/creator-prefill') return { data: { prefill: { owner_id: null, dispatcher_id: null } } };
      if (url === '/api/users/assignable') return { data: [] };
      return { data: {} };
    });
    renderWithProviders(<LeadFormPage />, {
      // Create leads needs View leads and Edit leads; Assign people to leads needs View leads.
      ability: buildAbility([
        { action: 'read', subject: 'Lead' },
        { action: 'update', subject: 'Lead' },
        { action: 'create', subject: 'Lead' },
        { action: 'assign', subject: 'Lead' },
        { action: 'read', subject: 'User' },
      ]),
      initialEntries: ['/leads/create'],
    });

    await screen.findByRole('combobox', { name: 'Owner' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Dispatcher' })).toBeInTheDocument());
    expectNoRetiredWords();
  });
});

describe('the new-job form', () => {
  it('says Sold By and Dispatcher, and an empty one reads No dispatcher', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/jobs/creator-prefill') return { data: { prefill: { sold_by_id: null, dispatcher_id: null } } };
      if (url === '/api/users/assignable') return { data: [] };
      return { data: {} };
    });
    renderWithProviders(<JobFormPage />, {
      // Create jobs needs View jobs and Edit jobs.
      ability: buildAbility([{ action: 'create', subject: 'Job' }, { action: 'read', subject: 'Job' }, { action: 'update', subject: 'Job' }]),
      initialEntries: ['/jobs/new'],
    });

    expect(await screen.findByText('No dispatcher')).toBeInTheDocument();
    expectNoRetiredWords();
  });
});

describe('the job page Team card', () => {
  it('names an empty Dispatcher, an empty Sold By and an empty crew for what they are', async () => {
    route.id = JOB_WITH_NOBODY.id;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes('/line-items')) return { data: { lines: [], billing: { subtotal: 0, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 0 } } };
      if (url.includes('/notes')) return { data: { notes: [] } };
      if (url.includes('/api/attachments/')) return { data: { attachments: [] } };
      if (url.includes('/communications')) return { data: { items: [] } };
      if (url.includes(`/api/jobs/${JOB_WITH_NOBODY.id}`)) return { data: { job: JOB_WITH_NOBODY } };
      return { data: {} };
    });
    renderWithProviders(<JobDetailPage />, { ability: everything, initialEntries: [`/jobs/${JOB_WITH_NOBODY.id}`] });

    expect(await screen.findByText('Dispatcher')).toBeInTheDocument();
    expect(await screen.findByText('No dispatcher')).toBeInTheDocument();
    expect(screen.getByText('Sold By')).toBeInTheDocument();
    expectNoRetiredWords();
  });
});
