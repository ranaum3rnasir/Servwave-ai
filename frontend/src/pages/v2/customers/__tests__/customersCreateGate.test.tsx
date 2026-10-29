import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';

import CustomersPage from '../CustomersPage';

/**
 * #2041 slice 1, decision 11 — the "Add Customer" control on `/customers` is gated on the
 * ABILITY (`ability.can('create', 'Customer')`), not the role literal
 * (`user?.role === 'ADMIN' || user?.role === 'DISPATCHER'`), same pattern as `canExport`
 * (`customersExportGate.test.tsx`). A per-user permission override or a future re-grant then
 * flows through with no further edits.
 */

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  customer_number: 'C00001',
  first_name: 'John',
  last_name: 'Doe',
  company_name: null,
  email: 'john@doe.test',
  phone: '5125550100',
  ad_source: null,
  created_at: '2026-01-15T00:00:00.000Z',
  service_locations: [],
  _count: { leads: 1, jobs: 2 },
  tags: [],
};

const CUSTOMERS_FIXTURE = {
  customers: [CUSTOMER],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
};
const CUSTOMER_STATS = { total: 10, newThisMonth: 2, activeLeads: 3, activeJobs: 4 };

/** A SALES-shaped ability: create Customer, but no export. */
const createAbility = () =>
  buildAbility([
    { action: 'create', subject: 'Customer' },
    { action: 'read', subject: 'Customer' },
  ]);
/** A role with real read access but no create grant — e.g. a locked-down custom role. */
const noCreateAbility = () => buildAbility([{ action: 'read', subject: 'Customer' }]);

const mockApi = vi.mocked(api);

/**
 * setup.ts's global `useAuthStore` mock defaults `user.role` to `'ADMIN'`, which alone
 * satisfies the OLD role-literal check this gate replaced. Round-2 fix: override the role to a
 * non-ADMIN/DISPATCHER role so the first test actually proves the ABILITY drives the button,
 * not the role default (see `board-scoped-to-own-tasks.test.tsx`'s `signedInAs` for the same
 * re-implement-the-selector pattern).
 */
function signedInAsSales() {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000003',
        email: 'sales@test.com',
        first_name: 'Test',
        last_name: 'Sales',
        role: 'SALES',
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })
  ) as typeof useAuthStore);
}

async function renderPage(ability: ReturnType<typeof buildAbility>) {
  const result = renderWithProviders(<CustomersPage />, { ability, initialEntries: ['/customers'] });
  expect(await screen.findByText('C00001')).toBeInTheDocument();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/me/table-views/')) return { data: {} };
    if (url === '/api/customers/stats') return { data: CUSTOMER_STATS };
    if (url === '/api/customers') return { data: CUSTOMERS_FIXTURE };
    return { data: {} };
  });
  mockApi.put.mockResolvedValue({ data: {} });
});

describe('Customers "Add Customer" control — ability gate (#2041 slice 1, decision 11)', () => {
  it('renders for an ability that permits customer create, even without ADMIN/DISPATCHER role context', async () => {
    signedInAsSales();
    await renderPage(createAbility());

    expect(screen.getByRole('button', { name: /add customer/i })).toBeInTheDocument();
  });

  it('hides the control for an ability that does not permit customer create', async () => {
    await renderPage(noCreateAbility());

    expect(screen.queryByRole('button', { name: /add customer/i })).not.toBeInTheDocument();
  });
});
