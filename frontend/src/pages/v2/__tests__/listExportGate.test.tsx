import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AppSubject } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore, type User } from '@/stores/auth.store';

import CustomersPage from '../customers/CustomersPage';
import EstimatesPage from '../estimates/EstimatesPage';
import InvoicesPage from '../invoices/InvoicesPage';
import JobsPage from '../jobs/JobsPage';
import LeadsPage from '../leads/LeadsPage';

/**
 * Roles & Permissions S02.30 - the Export control on the five record lists follows that module's Export switch,
 * which reaches the browser as the `export` ability on the module's subject. Each list is the ROUTED page (the one
 * `pages/v2/routes/` mounts), rendered for a person who holds the module's read access but not Export, and for one
 * who holds Export. The Jobs list used to hide Export from the Sales role by name and the Leads, Estimates and
 * Invoices lists showed it to everyone; neither the base role nor an empty rule set may decide it any more.
 */

const mockApi = vi.mocked(api);
const PAGINATION = { page: 1, limit: 25, total: 1, totalPages: 1 };
const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001', customer_number: 'C00001', first_name: 'John', last_name: 'Doe',
  company_name: null, email: 'john@doe.test', phone: '5125550100', ad_source: null,
  created_at: '2026-01-15T00:00:00.000Z', service_locations: [], _count: { leads: 1, jobs: 2 }, tags: [],
};
const CUSTOMER_REF = {
  id: CUSTOMER.id, first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001',
};

const LISTS: Array<{
  name: string; Page: React.ComponentType; path: string; endpoint: string; data: unknown;
  subject: AppSubject; rowText: string;
}> = [
  {
    name: 'customers', Page: CustomersPage, path: '/customers', endpoint: '/api/customers',
    data: { customers: [CUSTOMER], pagination: PAGINATION }, subject: 'Customer', rowText: 'C00001',
  },
  {
    name: 'leads', Page: LeadsPage, path: '/leads', endpoint: '/api/leads', subject: 'Lead', rowText: 'L00001',
    data: {
      leads: [{
        id: 'l0000000-0000-0000-0000-000000000001', lead_number: 'L00001', status: 'NEW',
        service_request: 'AC not cooling', job_type: null, created_at: '2026-01-15T00:00:00.000Z',
        customer: { ...CUSTOMER_REF, phone: '5125550100', ad_source: null }, commission_owner: null, estimates: [],
      }],
      pagination: PAGINATION, stats: { total: 1, new_this_week: 1, no_owner: 1, won: 0, lost: 0 },
    },
  },
  {
    name: 'jobs', Page: JobsPage, path: '/jobs', endpoint: '/api/jobs', subject: 'Job', rowText: 'J00001',
    data: {
      jobs: [{
        id: 'j0000000-0000-0000-0000-000000000001', job_number: 'J00001', status: 'SCHEDULED', scheduled_start: null,
        created_at: '2026-01-15T00:00:00.000Z', customer: CUSTOMER_REF, assignees: [], service_location: null, tags: [],
      }],
      pagination: PAGINATION,
      stats: { unassigned: 0, scheduled: 1, in_progress: 0, completed: 0, cancelled: 0, need_invoices: 0 },
    },
  },
  {
    name: 'estimates', Page: EstimatesPage, path: '/estimates', endpoint: '/api/estimates', subject: 'Estimate',
    rowText: 'E00001',
    data: {
      estimates: [{
        id: 'e0000000-0000-0000-0000-000000000001', estimate_number: 'E00001', status: 'DRAFT', subtotal: 100,
        tax_amount: 0, total_amount: 100, created_at: '2026-01-15T00:00:00.000Z', lead: null, customer: CUSTOMER_REF,
        creator: { id: 'u1', first_name: 'Test', last_name: 'Admin' }, deposit: null, tags: [],
      }],
      pagination: PAGINATION,
      stats: {
        draft: { count: 1, value: 100 }, sent: { count: 0, value: 0 }, pending: { count: 0, value: 0 },
        won: { count: 0, value: 0 }, declined: { count: 0, value: 0 }, archived: { count: 0, value: 0 },
      },
    },
  },
  {
    name: 'invoices', Page: InvoicesPage, path: '/invoices', endpoint: '/api/invoices', subject: 'Invoice',
    rowText: 'I00001',
    data: {
      invoices: [{
        id: 'i0000000-0000-0000-0000-000000000001', invoice_number: 'I00001', status: 'SENT', kind: 'STANDARD',
        subtotal: 100, discount_amount: 0, tax_amount: 8, deposit_credit: 0, total_amount: 108, amount_due: 108,
        due_date: null, sent_at: null, paid_at: null, created_at: '2026-01-15T00:00:00.000Z',
        customer: CUSTOMER_REF, job: null, tags: [],
      }],
      pagination: PAGINATION,
      stats: {
        due: { total: 108, count: 1 }, overdue: { total: 0, count: 0 }, collected_this_month: { total: 0, count: 0 },
        unsent: 0, need_invoices: 0,
      },
    },
  },
];

function signInAs(role: User['role']) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-test', email: 't@qa.test', first_name: 'T', last_name: 'T', role, organization_id: 'o1' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as unknown as typeof useAuthStore);
}

async function renderList(list: (typeof LISTS)[number], rules: Parameters<typeof buildAbility>[0]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/me/table-views/')) return { data: {} };
    if (url === '/api/customers/stats') return { data: { total: 1, newThisMonth: 0, activeLeads: 0, activeJobs: 0 } };
    if (url === list.endpoint) return { data: list.data };
    return { data: {} };
  });
  mockApi.put.mockResolvedValue({ data: {} });
  renderWithProviders(<list.Page />, { ability: buildAbility(rules), initialEntries: [list.path] });
  // The list itself must be on screen, so an absent Export cannot be a page that never finished drawing.
  expect(await screen.findByText(list.rowText)).toBeInTheDocument();
}

const exportTrigger = () => screen.queryByRole('button', { name: /^export$/i });

beforeEach(() => {
  vi.clearAllMocks();
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

describe('list Export follows the module Export switch', () => {
  it.each(LISTS)('$name list shows Export with the module Export ability', async (list) => {
    signInAs('ADMIN');
    await renderList(list, [{ action: 'read', subject: list.subject }, { action: 'export', subject: list.subject }]);
    const trigger = exportTrigger();
    expect(trigger).toBeInTheDocument();
    await userEvent.click(trigger!);
    expect(await screen.findByText('Export as CSV')).toBeInTheDocument();
  });

  it.each(LISTS)('$name list hides Export without it, even for an Admin', async (list) => {
    signInAs('ADMIN');
    await renderList(list, [{ action: 'read', subject: list.subject }, { action: 'update', subject: list.subject }]);
    expect(exportTrigger()).not.toBeInTheDocument();
  });

  it.each(LISTS)('$name list ignores the other four modules Export abilities', async (list) => {
    signInAs('ADMIN');
    const others = LISTS.filter((l) => l.subject !== list.subject).map((l) => ({ action: 'export' as const, subject: l.subject }));
    await renderList(list, [{ action: 'read', subject: list.subject }, ...others]);
    expect(exportTrigger()).not.toBeInTheDocument();
  });

  it('Jobs list shows Export to a Sales-role person who holds Export jobs (no role-name check)', async () => {
    signInAs('SALES');
    const jobs = LISTS.find((l) => l.name === 'jobs')!;
    await renderList(jobs, [{ action: 'read', subject: 'Job' }, { action: 'export', subject: 'Job' }]);
    expect(exportTrigger()).toBeInTheDocument();
  });

});
