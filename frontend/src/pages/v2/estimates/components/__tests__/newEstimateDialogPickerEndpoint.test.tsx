import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { NewEstimateDialog } from '../newEstimateDialog';

/**
 * #2041 slice 1 — the v2 "Create New Estimate" client picker repoints at the org-wide picker
 * endpoint (Ran's carve-out): a rep must still be able to start an estimate on a customer they
 * have never worked with once #2041 slice 2 scopes the Customers list/detail. No-op narrowing
 * here (R13). Mounted by `pages/v2/estimates/EstimatesPage.tsx` and
 * `pages/v2/SidebarCreateMenu.tsx` — see `md_files/plans/agents/runs/issue-2041/slice-1.md`.
 */

const mockApi = vi.mocked(api);

// A REDACTED picker row (decision 7): only id/name/company/phone_last4/city, restricted:true —
// never phone, email or service_locations.
const RESTRICTED_ROW = {
  id: 'c0000000-0000-0000-0000-0000000000f3',
  first_name: 'Res',
  last_name: 'Tricted',
  company_name: null,
  phone_last4: '7777',
  city: 'Austin',
  restricted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/customers/picker') return { data: { customers: [RESTRICTED_ROW] } };
    return { data: {} };
  });
});

describe('newEstimateDialog (v2) — org-wide picker (#2041 slice 1)', () => {
  it('searches /api/customers/picker, never the scoped /api/customers list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewEstimateDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByPlaceholderText(/name, email, phone/i), 'Re');

    await waitFor(
      () => expect(mockApi.get.mock.calls.some(([url]) => url === '/api/customers/picker')).toBe(true),
      { timeout: 2000 },
    );
    expect(mockApi.get.mock.calls.some(([url]) => url === '/api/customers')).toBe(false);
  });

  it('renders a restricted search result without throwing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewEstimateDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByPlaceholderText(/name, email, phone/i), 'Re');

    expect(await screen.findByText(/Res Tricted/, {}, { timeout: 2000 })).toBeInTheDocument();
  });
});
