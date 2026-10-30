/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.20 - the customer page's controls follow the switches.
   Renders the ROUTED customer page (pages/v2/customers/CustomerDetailPage).

   Edit follows Edit customers, service-location delete follows Delete customers, and archive or restore follows
   Archive customers. Each person below is a custom role described by the rules those switches compile into; the
   signed-in user's role name is set to the OPPOSITE of what the old role-name check wanted, so a page that still
   read the role name would answer wrongly in both directions. A page opened by URL with View customers off asks
   the server and shows the "not authorized" screen when it refuses.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';

import CustomerDetailPage from '../CustomerDetailPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000020';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'c0000000-0000-0000-0000-000000000020' }) };
});

const mockApi = vi.mocked(api);

const CUSTOMER_DETAIL = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C00020',
    first_name: 'Dana',
    last_name: 'Reyes',
    company_name: null,
    email: 'dana@example.test',
    phone: '5551230020',
    phone_ext: null,
    secondary_phone: null,
    ad_source: null,
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    extra_emails: [],
    custom_fields: {},
    created_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    is_active: true,
    tags: [],
    service_locations: [
      { id: 'loc-1', address_line1: '1 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701', is_primary: true },
      { id: 'loc-2', address_line1: '2 Side St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62702', is_primary: false },
    ],
    _count: { leads: 0, jobs: 0 },
    jobs: [],
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
  },
};

/** The signed-in user's role NAME. No built-in role name may decide anything on this page. */
function signedInWithRoleName(role: string) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000020', email: 'custom@test.com', first_name: 'Cu', last_name: 'Stom', role },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })
  ) as typeof useAuthStore);
}

const READ: AbilityRule = { action: 'read', subject: 'Customer' };
const EDIT: AbilityRule = { action: 'update', subject: 'Customer' };
const DELETE: AbilityRule = { action: 'delete', subject: 'Customer' };
const ARCHIVE: AbilityRule = { action: 'archive', subject: 'Customer' };

async function openPage(rules: AbilityRule[], role: string) {
  signedInWithRoleName(role);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Chicago' } };
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL };
    if (url === '/api/leads') return { data: { leads: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } } };
    return { data: {} };
  });
  const user = userEvent.setup();
  renderWithProviders(<CustomerDetailPage />, {
    initialEntries: [`/customers/${CUSTOMER_ID}`],
    ability: buildAbility(rules),
  });
  await screen.findByRole('heading', { level: 1 });
  return user;
}

async function openActionsMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Customer actions' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Edit on the customer page follows Edit customers', () => {
  it('offers Edit client, Add location and the location pencils to a person with Edit customers, whatever their role name', async () => {
    const user = await openPage([READ, EDIT], 'TECHNICIAN');

    // The page behind an open menu is hidden from the accessibility tree, so the page's own controls come first.
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit location' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Set as primary location' })).toBeInTheDocument();
    await openActionsMenu(user);
    expect(await screen.findByRole('menuitem', { name: /Edit client/ })).toBeInTheDocument();
  });

  it('offers none of them to a person without Edit customers, even on a role name the page used to trust', async () => {
    await openPage([READ, DELETE, ARCHIVE], 'ADMIN');

    expect(screen.queryByRole('button', { name: 'Customer actions' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Edit client/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit location' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set as primary location' })).toBeNull();
  });
});

describe('Service-location delete follows Delete customers', () => {
  it('shows the delete control to a person with Delete customers and no Edit customers, whatever their role name', async () => {
    await openPage([READ, DELETE], 'SALES');

    expect(await screen.findAllByRole('button', { name: 'Delete location' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit location' })).toBeNull();
  });

  it('hides the delete control from a person with Edit customers but not Delete customers, even on a role name the page used to trust', async () => {
    await openPage([READ, EDIT], 'DISPATCHER');

    await screen.findAllByRole('button', { name: 'Edit location' });
    expect(screen.queryByRole('button', { name: 'Delete location' })).toBeNull();
  });

  it('deletes through the location route when the control is used', async () => {
    mockApi.delete.mockResolvedValue({ data: {} });
    const user = await openPage([READ, DELETE], 'TECHNICIAN');

    await user.click((await screen.findAllByRole('button', { name: 'Delete location' }))[1]!);

    expect(mockApi.delete).toHaveBeenCalledWith(`/api/customers/${CUSTOMER_ID}/locations/loc-2`);
  });
});

describe('Archive and restore follow Archive customers', () => {
  it('draws no archive or restore control for a person without Archive customers', async () => {
    const user = await openPage([READ, EDIT, DELETE], 'ADMIN');
    await openActionsMenu(user);

    await screen.findByRole('menuitem', { name: /Edit client/ });
    expect(screen.queryByRole('button', { name: /archive|restore/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /archive|restore/i })).toBeNull();
  });
});

describe('Create New does not depend on Edit customers', () => {
  it('still offers the documents a person may create when Edit customers is off', async () => {
    const user = await openPage(
      [READ, { action: 'create', subject: 'Estimate' }, { action: 'create', subject: 'Job' }],
      'DISPATCHER',
    );

    await user.click(await screen.findByRole('button', { name: /Create New/ }));

    expect(await screen.findByRole('menuitem', { name: /Estimate/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Job/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Invoice/ })).toBeNull();
  });

  it('offers no Create New to a person who may create none of them', async () => {
    await openPage([READ, EDIT], 'ADMIN');

    expect(screen.queryByRole('button', { name: /Create New/ })).toBeNull();
  });
});

describe('a customer page opened by URL with View customers off', () => {
  it('shows the "not authorized" screen after the server refuses the read', async () => {
    signedInWithRoleName('TECHNICIAN');
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/customers/${CUSTOMER_ID}`) {
        throw { isAxiosError: true, message: 'Request failed', response: { status: 403, data: { error: 'Forbidden' } } };
      }
      return { data: {} };
    });
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`], ability: buildAbility([]) });

    expect(await screen.findByRole('heading', { name: /You don.t have access to this page/ })).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/${CUSTOMER_ID}`);
    expect(screen.queryByText('Customer not found.')).toBeNull();
  });
});
