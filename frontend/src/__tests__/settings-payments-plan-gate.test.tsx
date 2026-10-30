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
import ServwavePaymentsPage from '@/pages/v2/settings/ServwavePaymentsPage';

const mockApi = vi.mocked(api);
const PAGE_ABILITY = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);
function Where() {
  const { pathname, hash } = useLocation();
  return <div data-testid="where">{pathname}{hash}</div>;
}

vi.mock('@stripe/connect-js/pure', () => ({
  loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })),
}));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div data-testid="connect-account-onboarding" />,
  ConnectAccountManagement: () => <div />,
  ConnectNotificationBanner: () => <div />,
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
    const { container } = renderWithProviders(<ServwavePaymentsPage />, { ability: PAGE_ABILITY });
    await screen.findByDisplayValue('40'); // the org has loaded

    expect(screen.getByText("Online payments aren’t included in your plan.")).toBeInTheDocument();
    const upgrade = screen.getByRole('link', { name: /^Contact us to upgrade/ });
    expect(upgrade).toHaveAttribute('href', expect.stringMatching(/^mailto:support@servwave\.com/));
    expect(screen.queryByRole('button', { name: /set up payments|resume setup|fix now/i })).not.toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/stripe/i);
  });

  it('the online Card and Bank defaults read unavailable because of the plan', async () => {
    signedInAdminWith(['payments', 'invoices']);
    renderWithProviders(<ServwavePaymentsPage />, { ability: PAGE_ABILITY });
    await screen.findByDisplayValue('40');

    expect(screen.getByRole('switch', { name: 'Credit card' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('switch', { name: 'Bank (ACH)' })).toHaveAttribute('aria-disabled', 'true');
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

  // The plan card replaces card 1's status (V7 call C-40); the payout card still follows the real account, so the
  // owner can finish what is due and get already-collected money paid out.
  it('shows the plan card in place of the status, and the payout card still shows "Action needed" with the secure form', async () => {
    signedInAdminWith(['payments', 'invoices']);
    statusIs({
      ...NOT_CONNECTED,
      connected: true,
      terms_accepted: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
      stripe_requirements_due: ['individual.verification.document'],
    });
    const { container } = renderWithProviders(<><ServwavePaymentsPage /><Where /></>, {
      ability: PAGE_ABILITY,
      initialEntries: ['/settings/servwave-payments'],
    });

    expect(await screen.findByRole('heading', { name: 'Your plan' })).toBeInTheDocument();
    expect(screen.getByText('Online payments aren’t included in your plan.')).toBeInTheDocument();
    expect(screen.getByText('Customers can’t pay online right now. You can still keep your payout account up to date.')).toBeInTheDocument();
    // No status badge or Fix now in card 1; the payout card carries the state.
    expect(screen.queryByRole('button', { name: 'Fix now' })).not.toBeInTheDocument();
    expect(await screen.findByText('Action needed')).toBeInTheDocument();
    // Something is due now, so the secure form mounts by itself on the existing account.
    expect(screen.getByTestId('connect-account-onboarding')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/organization/stripe/connect');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/servwave-payments$/);
    expect(container.textContent).not.toMatch(/stripe|acct_/i);
  });

  it('with charges on and payouts pending, the secure area offers Finish setup (the bank nudge belongs to the status card)', async () => {
    signedInAdminWith(['payments', 'invoices']);
    statusIs({
      ...NOT_CONNECTED,
      connected: true,
      terms_accepted: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: false,
      collected_awaiting_payout: 250,
    });
    renderWithProviders(<ServwavePaymentsPage />, { ability: PAGE_ABILITY });

    expect(await screen.findByRole('button', { name: 'Finish setup' })).toBeInTheDocument();
    expect(screen.getByText('Online payments aren’t included in your plan.')).toBeInTheDocument();
    expect(screen.queryByText(/You’ve collected/)).not.toBeInTheDocument();
  });

  it('with no plan and no account there is no payout card to start from', async () => {
    signedInAdminWith(['payments', 'invoices']);
    renderWithProviders(<ServwavePaymentsPage />, { ability: PAGE_ABILITY });
    await screen.findByDisplayValue('40');
    expect(screen.queryByRole('heading', { name: 'Payout account & verification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept terms/i })).not.toBeInTheDocument();
  });
});

describe('Settings -> Payments for an org whose plan includes online payments', () => {
  it('offers onboarding and shows no plan message', async () => {
    signedInAdminWith(['payments', 'invoices', 'online_payments']);
    renderWithProviders(<ServwavePaymentsPage />, { ability: PAGE_ABILITY });

    expect(await screen.findByRole('button', { name: 'Set up payments' })).toBeInTheDocument();
    expect(screen.queryByText("Online payments aren’t included in your plan.")).not.toBeInTheDocument();
  });
});
