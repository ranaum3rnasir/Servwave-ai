import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { downloadCSV } from '@/lib/inventory/csv';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomersPage from '../CustomersPage';

/**
 * Slice 018-b — the Customers Export control is gated on the ability.
 *
 * `frontend/src/pages/v2/customers/CustomersPage.tsx` is the LIVE page:
 * `pages/v2/routes/customers.routes.tsx` mounts `../customers/CustomersPage` at
 * `/customers`, and `App.tsx` routes nothing itself. `src/pages/CustomersPage.tsx`
 * is the unrouted v1 copy (still gated in lockstep, and covered by
 * `src/__tests__/customers-page.test.tsx`).
 *
 * WHY ONE GATE ON THE PARENT DROPDOWN. "All customers" round-trips to
 * `/api/customers/export`, so revoking the server grant stops it. "Current page"
 * builds its CSV client-side from rows already sitting in the React Query cache:
 * it issues NO request, so no server guard, audit trail or rate limiter sees it,
 * and revoking the grant does not touch it. The parent is the only single place
 * a check closes both, which is why the absence test below asserts on the
 * menu ITEMS as well as the trigger.
 */

// Only downloadCSV is replaced; toCSV stays real so the page's own mapping still
// has to produce something before the assertion can fire.
vi.mock('@/lib/inventory/csv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inventory/csv')>('@/lib/inventory/csv');
  return { ...actual, downloadCSV: vi.fn() };
});

const mockApi = vi.mocked(api);
const mockDownloadCSV = vi.mocked(downloadCSV);

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

/** The ability a user who MAY export customers carries (backend catalog pair). */
const exportAbility = () => buildAbility([{ action: 'export', subject: 'Customer' }]);
/**
 * A user with real access to the list — read + update Customer — but no export
 * grant. Deliberately NOT an empty ability: an empty one would also hide the
 * control if the gate were wired to some unrelated permission, so this fixture
 * is what makes the absence test discriminating.
 */
const noExportAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Customer' },
    { action: 'update', subject: 'Customer' },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/me/table-views/')) return { data: {} };
    if (url === '/api/customers/stats') return { data: CUSTOMER_STATS };
    if (url === '/api/customers') return { data: CUSTOMERS_FIXTURE };
    if (url === '/api/customers/export') return { data: { customers: [CUSTOMER] } };
    // tags, assignable users, departments, the org record...
    return { data: {} };
  });
  mockApi.put.mockResolvedValue({ data: {} });
});

async function renderPage(ability: ReturnType<typeof buildAbility>) {
  const result = renderWithProviders(<CustomersPage />, {
    ability,
    initialEntries: ['/customers'],
  });
  // Wait for the list itself, so an absent Export button cannot be an artefact
  // of asserting before the page finished rendering its toolbar.
  expect(await screen.findByText('C00001')).toBeInTheDocument();
  return result;
}

const exportTrigger = () => screen.queryByRole('button', { name: /^export$/i });

describe('Customers Export control — ability gate', () => {
  it('renders the Export control, and both menu items work, for an ability that permits customer export', async () => {
    const user = userEvent.setup();
    await renderPage(exportAbility());

    const trigger = exportTrigger();
    expect(trigger).toBeInTheDocument();

    // Path 1 — "Current page": client-side only, no request.
    await user.click(trigger!);
    await user.click(await screen.findByRole('menuitem', { name: /current page/i }));
    await waitFor(() => expect(mockDownloadCSV).toHaveBeenCalledTimes(1));
    expect(mockDownloadCSV.mock.calls.at(0)?.[1]).toMatch(/^customers-page1-/);
    expect(
      mockApi.get.mock.calls.some(([url]) => url === '/api/customers/export')
    ).toBe(false);

    // Path 2 — "All customers": round-trips to the export endpoint.
    await user.click(exportTrigger()!);
    await user.click(await screen.findByRole('menuitem', { name: /all customers/i }));
    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/customers/export', expect.anything());
    });
    await waitFor(() => expect(mockDownloadCSV).toHaveBeenCalledTimes(2));
    expect(mockDownloadCSV.mock.calls.at(1)?.[1]).toMatch(/^customers-all-/);
  });

  it('hides the Export control entirely — trigger and BOTH menu items — for an ability that does not permit customer export', async () => {
    await renderPage(noExportAbility());

    expect(exportTrigger()).not.toBeInTheDocument();
    // The client-side path has no server guard behind it, so "no trigger" is not
    // enough on its own: neither item may exist anywhere in the tree.
    expect(screen.queryByText(/current page \(/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all customers \(/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Export as CSV')).not.toBeInTheDocument();
  });

  it('leaves the rest of the toolbar untouched when Export is hidden', async () => {
    await renderPage(noExportAbility());

    expect(screen.getByPlaceholderText('Search customers...')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /show archived/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^filter$/i })).toBeInTheDocument();
    // The row is still there and still clickable-through to the detail page.
    expect(screen.getByText('C00001')).toBeInTheDocument();
  });
});
