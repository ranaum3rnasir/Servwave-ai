/**
 * Repro for #1472: "Add new client" inside the Create-New-Estimate picker sends the user to
 * `/leads/new` instead of `/customers/new`. There are TWO live copies of this dialog:
 *
 *  - `pages/v2/estimates/components/newEstimateDialog.tsx` - rendered by the `/estimates` route
 *    (EstimatesPage.tsx:661).
 *  - `components/estimates/NewEstimateDialog.tsx` - rendered by the dashboard's quick-create menu
 *    (pages/v2/dashboard/components/newMenu.tsx:76).
 *
 * Both `handleAddNewClient` functions navigate to `/leads/new` with `state: { returnTo }`; the
 * expected target is `/customers/new` with the same state shape (CustomerFormPage already reads
 * `location.state.returnTo` on create-success and EstimatesPage already consumes the resulting
 * `?newCustomerId=` - no new plumbing needed, just the destination).
 *
 * The adjacent "Create new lead" affordance (shown once a picked customer has no active leads)
 * is the CONTROL for acceptance criterion #3: it must keep going to `/leads/new` both before and
 * after the fix, proving the fix only retargets "Add new client" and nothing else in the dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { NewEstimateDialog as V2NewEstimateDialog } from '@/pages/v2/estimates/components/newEstimateDialog';
import { NewEstimateDialog as LegacyNewEstimateDialog } from '@/components/estimates/NewEstimateDialog';

const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'Jane',
  last_name: 'Doe',
  company_name: null,
  phone: '5551234567',
  email: 'jane@doe.com',
};

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/**
 * Answers the two requests the dialog fires once a `preSelectedCustomerId` is supplied: the
 * customer itself, and its leads (empty, so the "no active leads" branch - and its "Create new
 * lead" link - renders without needing to drive the search box's 300ms debounce at all).
 *
 * #2041 slice 1 - both dialogs' expand call now hits the org-wide picker endpoint
 * (`/api/customers/picker/:id`), not `/api/customers/:id`.
 */
function setupMocks() {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === `/api/customers/picker/${CUSTOMER_ID}`) return { data: { customer: CUSTOMER } };
    if (url === '/api/leads') return { data: { leads: [] } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

describe.each([
  ['v2 (EstimatesPage) newEstimateDialog', V2NewEstimateDialog],
  ['legacy (dashboard quick-create) NewEstimateDialog', LegacyNewEstimateDialog],
])('#1472 - %s', (_label, Dialog) => {
  function renderDialog() {
    return renderWithProviders(
      <Dialog
        open
        onOpenChange={vi.fn()}
        preSelectedCustomerId={CUSTOMER_ID}
        onPreSelectConsumed={vi.fn()}
      />,
    );
  }

  it('"Add new client" navigates to /customers/new, carrying returnTo back to /estimates', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole('button', { name: /Add new client/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/customers/new', { state: { returnTo: '/estimates' } });
  });

  it('control: "Create new lead" still navigates to /leads/new (must stay true after the fix too)', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole('button', { name: /Create new lead/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/leads/new?customer_id=${CUSTOMER_ID}`);
  });
});
