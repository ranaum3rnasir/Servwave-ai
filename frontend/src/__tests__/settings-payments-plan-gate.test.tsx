// Payments go-live slice 16 - an org whose plan lacks online payments is told so on Settings ->
// Payments, before onboarding can start (user story 14: "so that I don't half-finish onboarding").
// The backend refuses to open a new payout account for such an org with 403; this page must not
// offer that step in the first place. An account that already exists stays visible and fixable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useLocation } from 'react-router-dom';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import PaymentsListsPage from '@/pages/v2/settings/PaymentsListsPage';

const mockApi = vi.mocked(api);
const OWNER = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }]);
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

vi.mock('@stripe/connect-js/pure', () => ({
  loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })),
}));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div data-testid="connect-account-onboarding" />,
}));

const ORG = {
  id: 'o1',
  stripe_connected: false,
  stripe_charges_enabled: false,
  accepted_payment_methods: ['CASH'],
  source_options: [],
  job_type_options: [],
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

const NOT_CONNECTED = {
  connected: false,
  terms_accepted: false,
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  collected_awaiting_payout: 0,
};

function signedInAdminWith(orgFeatures: string[]) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', organization_id: 'o1', org_plan: 'PRO', org_features: orgFeatures,
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: ORG });
    if (url === '/api/organization/stripe/status') return Promise.resolve({ data: NOT_CONNECTED });
    return Promise.resolve({ data: {} });
  });
});

describe('Settings -> Payments for an org whose plan lacks online payments', () => {
  it('shows the plan message with the upgrade path, and no way to start onboarding', async () => {
    signedInAdminWith(['payments', 'invoices']);
    const { container } = renderWithProviders(<PaymentsListsPage />);
    await screen.findByDisplayValue('40'); // the org has loaded

    expect(screen.getByText("Online payments aren't included in your plan.")).toBeInTheDocument();
    const upgrade = screen.getByRole('link', { name: 'Contact us to upgrade' });
    expect(upgrade).toHaveAttribute('href', expect.stringMatching(/^mailto:support@servwave\.com/));
    expect(screen.queryByRole('button', { name: /set up payments|resume setup|fix now/i })).not.toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/stripe/i);
  });

  it('the online Card and Bank defaults read unavailable because of the plan', async () => {
    signedInAdminWith(['payments', 'invoices']);
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByDisplayValue('40');

    expect(screen.getByRole('switch', { name: 'Credit card' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Bank (ACH)' })).toBeDisabled();
    expect(screen.getAllByText('Not included in your plan.')).toHaveLength(2);
    expect(screen.queryByText('Finish payout account verification first.')).not.toBeInTheDocument();
  });
});

// Fix round 1: losing the plan must not hide an account that already exists. Its owner still sees
// where it stands and can still fix it, so money it already collected can be paid out; the plan
// message sits beside the card, not in its place.
describe('Settings -> Payments for an org that lost online payments but already has an account', () => {
  function statusIs(status: Record<string, unknown>) {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: { ...ORG, stripe_connected: true } });
      if (url === '/api/organization/stripe/status') return Promise.resolve({ data: status });
      return Promise.resolve({ data: {} });
    });
  }

  it('still shows "Action needed" with Fix now, which opens setup on the existing account, beside the plan message', async () => {
    signedInAdminWith(['payments', 'invoices']);
    statusIs({
      ...NOT_CONNECTED,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
      stripe_requirements_due: ['individual.verification.document'],
    });
    const { container } = renderWithProviders(<><PaymentsListsPage /><Where /></>, { ability: OWNER });

    expect(await screen.findByText('Action needed')).toBeInTheDocument();
    expect(screen.getByText("Online payments aren't included in your plan.")).toBeInTheDocument();

    // Payments go-live slice 34: fixing the account is the owner's page, on the existing account.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fix now' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/settings/payout-account'));
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/organization/stripe/connect');
    expect(container.textContent).not.toMatch(/stripe|acct_/i);
  });

  it('still shows the collected-awaiting-payout nudge', async () => {
    signedInAdminWith(['payments', 'invoices']);
    statusIs({
      ...NOT_CONNECTED,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: false,
      collected_awaiting_payout: 250,
    });
    renderWithProviders(<PaymentsListsPage />, { ability: OWNER });

    expect(await screen.findByText(/You've collected \$250\.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect bank' })).toBeInTheDocument();
    expect(screen.getByText("Online payments aren't included in your plan.")).toBeInTheDocument();
  });
});

describe('Settings -> Payments for an org whose plan includes online payments', () => {
  it('offers onboarding and shows no plan message', async () => {
    signedInAdminWith(['payments', 'invoices', 'online_payments']);
    renderWithProviders(<PaymentsListsPage />, { ability: OWNER });

    expect(await screen.findByRole('button', { name: 'Set up payments' })).toBeInTheDocument();
    expect(screen.queryByText("Online payments aren't included in your plan.")).not.toBeInTheDocument();
  });
});
