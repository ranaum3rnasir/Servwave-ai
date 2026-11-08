import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * #2041 slice 1 — the v2 lead-create form's inline contact typeahead (pickCustomer.tsx) and its
 * `?customer_id=` preselect expand both repoint at the org-wide picker endpoint (Ran's
 * carve-out): a rep must still be able to start a lead on a customer they have never worked with
 * once #2041 slice 2 scopes the Customers list/detail. This is a no-op narrowing here (R13) — the
 * assertions pin the URL and the "never throws on a restricted row" contract, not a behaviour
 * change. See `md_files/plans/agents/runs/issue-2041/slice-1.md`.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// A REDACTED picker row (decision 7): only id/name/company/phone_last4/city, restricted:true —
// never phone, email or service_locations.
const RESTRICTED_ROW = {
  id: 'c0000000-0000-0000-0000-0000000000f1',
  first_name: 'Res',
  last_name: 'Tricted',
  company_name: null,
  phone_last4: '9999',
  city: 'Austin',
  restricted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/customers/picker') return { data: { customers: [RESTRICTED_ROW] } };
    if (url === `/api/customers/picker/${RESTRICTED_ROW.id}`) return { data: { customer: RESTRICTED_ROW } };
    return { data: {} };
  });
});

describe('LeadFormPage (create) — org-wide picker (#2041 slice 1)', () => {
  it('searches /api/customers/picker, never the scoped /api/customers list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/create'] });

    await user.type(screen.getByLabelText(/first name/i), 'Re');

    await waitFor(() =>
      expect(mockApi.get.mock.calls.some(([url]) => url === '/api/customers/picker')).toBe(true),
    );
    expect(mockApi.get.mock.calls.some(([url]) => url === '/api/customers')).toBe(false);
  });

  it('a restricted search result selects cleanly — no throw, email left blank, address left open', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/create'] });

    await user.type(screen.getByLabelText(/first name/i), 'Re');
    const resultButton = await screen.findByText(/Res Tricted/);
    await user.click(resultButton);

    expect(await screen.findByDisplayValue('Res')).toBeInTheDocument();
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).value).toBe('');
  });

  it('?customer_id= preselect expands through /api/customers/picker/:id, not /api/customers/:id', async () => {
    renderWithProviders(<LeadFormPage />, {
      ability: adminAbility,
      initialEntries: [`/leads/create?customer_id=${RESTRICTED_ROW.id}`],
    });

    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/picker/${RESTRICTED_ROW.id}`),
    );
    expect(await screen.findByDisplayValue('Res')).toBeInTheDocument();
    expect(mockApi.get.mock.calls.some(([url]) => url === `/api/customers/${RESTRICTED_ROW.id}`)).toBe(false);
  });
});
