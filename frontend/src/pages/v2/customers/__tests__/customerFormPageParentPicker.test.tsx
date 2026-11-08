import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * #2041 slice 1, R9 — `CustomerFormPage.tsx`'s parent/billing-group picker (`is_parent=true`)
 * is DELIBERATELY NOT repointed at the org-wide picker: it stays on the scoped list/detail
 * endpoints, so it takes the narrowing #2041 slice 2 introduces on purpose. This pins the
 * PRE-EXISTING behaviour on a 404 expand (a parent the requester cannot read) — no crash, no
 * blank page, and no owner- or vendor-revealing copy (never the real parent's name/company). See
 * `md_files/plans/agents/runs/issue-2041/slice-1.md`.
 */

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000010';
const PARENT_ID = 'c0000000-0000-0000-0000-000000000099';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
}));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'Own',
  last_name: 'Customer',
  company_name: null,
  email: 'own@example.com',
  phone: '5125550100',
  phone_ext: null,
  extra_emails: [],
  phones: [],
  ad_source: null,
  source: null,
  allow_billing: false,
  tax_exempt: false,
  // parent_id set -> the form derives account_type: 'under' and fetches the parent by id.
  parent_id: PARENT_ID,
  is_parent: false,
  billing_terms: null,
  service_locations: [],
  notes: null,
  created_at: '2026-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: CUSTOMER } };
    // The parent expand 404s — out of the requester's scope (#2041 slice 2).
    if (url === `/api/customers/${PARENT_ID}`) {
      const err = new Error('Not Found') as Error & { response?: { status: number } };
      err.response = { status: 404 };
      throw err;
    }
    if (url === '/api/customers') return { data: { customers: [] } };
    return { data: {} };
  });
});

describe('CustomerFormPage — parent picker stays on the scoped endpoint (#2041 slice 1, R9)', () => {
  it('renders without crashing when the parent expand 404s, with a neutral (non-owner-revealing) label', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomerFormPage />, {
      ability: adminAbility,
      initialEntries: [`/customers/${CUSTOMER_ID}/edit`],
    });

    // The form itself renders through to completion — no crash, no blank page.
    await waitFor(() => expect(screen.getByDisplayValue('Own')).toBeInTheDocument());

    // The franchise/account-type config lives in the collapsed "More Details" section.
    await user.click(screen.getByRole('button', { name: /more details/i }));

    // Franchise picker still renders its "picked" chip — never a raw error state — but with
    // the generic fallback label, never the real (unreadable) parent's name or company.
    expect(await screen.findByText('Selected franchise')).toBeInTheDocument();
    expect(screen.queryByText('Parent Co')).not.toBeInTheDocument();
  });

  it('still calls /api/customers/:id for the parent expand, not the picker endpoint (deliberately not repointed)', async () => {
    renderWithProviders(<CustomerFormPage />, {
      ability: adminAbility,
      initialEntries: [`/customers/${CUSTOMER_ID}/edit`],
    });

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/${PARENT_ID}`));
    expect(mockApi.get.mock.calls.some(([url]) => url === `/api/customers/picker/${PARENT_ID}`)).toBe(false);
  });
});
