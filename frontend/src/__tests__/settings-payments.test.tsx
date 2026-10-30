import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { renderWithProviders } from './helpers';
/**
 * Settings > ServWave Payments: the cases that used to run on the combined Payments & Lists page (card availability,
 * the fee disclosure, the status card's hand-off, the return from secure setup), now on the new page.
 */
import ServwavePaymentsPage from '@/pages/v2/settings/ServwavePaymentsPage';
import { buildAbility } from '@/lib/ability';

const mockApi = vi.mocked(api);

// The embedded processor SDKs do not render in jsdom; stand in for them.
vi.mock('@stripe/connect-js/pure', () => ({
  loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })),
}));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div data-testid="connect-account-onboarding" />,
  ConnectAccountManagement: () => <div data-testid="connect-account-management" />,
  ConnectNotificationBanner: () => <div data-testid="connect-notification-banner" />,
}));

const FULL = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);

const ORG = {
  id: 'o1',
  stripe_connected: false,
  accepted_payment_methods: ['CASH'],
  source_options: ['Google'],
  job_type_options: [],
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: ORG });
    return Promise.resolve({ data: {} });
  });
});

describe('ServwavePaymentsPage - cards moved from Payments & Lists', () => {

  // Card acceptance is NOT a member of the manual list - dispatchers can't check/uncheck CARD
  // there, because CARD in accepted_payment_methods is a server-owned capability fact. Payments
  // go-live slice 20 replaced the read-only "ServWave Payments - Accepted automatically" row with
  // the owner's default-offer switch for Card (card_offered_by_default), which reads as
  // unavailable until the account can take cards.
  //
  // Both tests below gate on `findByDisplayValue('40')` (the deposit-percentage input
  // reset() populates from the loaded org) so the assertion runs against the org fixture,
  // not the transient pre-load render (this page has no `isLoading` guard).
  it('mid-onboarding (account id set, charges not yet enabled) the Card switch is unavailable', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({
          data: { ...ORG, stripe_connected: true, stripe_charges_enabled: false },
        });
      }
      return Promise.resolve({ data: {} });
    });
    renderWithProviders(<ServwavePaymentsPage />, { ability: FULL });
    await screen.findByDisplayValue('40'); // org has loaded, form has reset()

    expect(screen.getByRole('switch', { name: 'Credit card' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(/locked — Stripe is integrated/i)).not.toBeInTheDocument();
  });

  it('when charges are enabled the Card switch is available, and CARD is not a manual checkbox beside the toggleable manual methods', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({
          data: {
            ...ORG,
            stripe_connected: true,
            stripe_charges_enabled: true,
            accepted_payment_methods: ['CASH', 'CARD'],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    renderWithProviders(<ServwavePaymentsPage />, { ability: FULL });
    await screen.findByDisplayValue('40'); // org has loaded, form has reset()

    const methodsCard = screen.getByText('Accepted payment methods').closest('[data-slot="card"]') as HTMLElement;
    expect(within(methodsCard).getByRole('switch', { name: 'Credit card' })).not.toHaveAttribute('aria-disabled', 'true');
    // CARD is not part of the manual (accepted_payment_methods) checkbox list.
    expect(within(methodsCard).queryByRole('checkbox', { name: /credit card$/i })).not.toBeInTheDocument();
    // The manual/offline methods it DOES manage are still rendered and toggleable.
    expect(screen.getByRole('checkbox', { name: 'Cash' })).toBeInTheDocument();
  });

  // Payments go-live slice 03 (D9/D12): before setup, Settings -> Payments tells the owner the real
  // fee model, and the retired org platform fee is neither shown nor editable.
  it('a not-yet-connected org sees the no-ServWave-fee disclosure and no platform-fee field', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: { ...ORG, platform_fee_bps: 50 } });
      if (url === '/api/organization/stripe/status') {
        return Promise.resolve({
          data: {
            connected: false,
            terms_accepted: false,
            stripe_charges_enabled: false,
            stripe_payouts_enabled: false,
            stripe_details_submitted: false,
            stripe_requirements_due: [],
            stripe_disabled_reason: null,
            collected_awaiting_payout: 0,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    const { container } = renderWithProviders(<ServwavePaymentsPage />, { ability: FULL });

    expect(
      await screen.findByText(
        'Customers pay the invoice amount. Standard card and bank processing rates are billed to your account. ServWave charges no payment fee.',
      ),
    ).toBeInTheDocument();
    const text = container.textContent!;
    expect(text).not.toMatch(/platform fee/i);
    expect(text).not.toMatch(/0\.5%/);
    expect(text).not.toMatch(/stripe/i);
    expect(screen.queryByRole('spinbutton', { name: /fee/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /fee/i })).not.toBeInTheDocument();
  });

  // Payments go-live slice 34: setting up the payout account moved to its own owner-only page. The
  // status card's button hands over to it; anyone without Manage payout account sees the status only.
  const connectedNotSubmitted = {
    connected: true,
    terms_accepted: true,
    stripe_charges_enabled: false,
    stripe_payouts_enabled: false,
    stripe_details_submitted: false,
    stripe_requirements_due: [],
    stripe_disabled_reason: null,
    collected_awaiting_payout: 0,
  };
  const serveStatus = (status: Record<string, unknown>) =>
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: ORG });
      if (url === '/api/organization/stripe/status') return Promise.resolve({ data: status });
      return Promise.resolve({ data: {} });
    });

  it('the status card button scrolls to the payout account card and focuses its heading, without leaving the page', async () => {
    serveStatus(connectedNotSubmitted);
    const user = userEvent.setup();
    const Where = () => {
      const { pathname, hash } = useLocation();
      return <div data-testid="where">{pathname}{hash}</div>;
    };
    renderWithProviders(<><ServwavePaymentsPage /><Where /></>, {
      ability: buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }]),
      initialEntries: ['/settings/servwave-payments'],
    });

    await user.click(await screen.findByRole('button', { name: 'Resume setup' }));

    const heading = screen.getByRole('heading', { name: 'Payout account & verification' });
    expect(heading).toHaveFocus();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/servwave-payments$/);
  });

  it('shows the status but no setup button to someone without Manage payout account', async () => {
    serveStatus(connectedNotSubmitted);
    renderWithProviders(<ServwavePaymentsPage />, {
      ability: buildAbility([{ action: 'update', subject: 'Organization' }]),
    });

    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume setup|set up payments|fix now/i })).not.toBeInTheDocument();
  });

  // Payments go-live slice 06 (#1987): the hosted onboarding sends the owner back with
  // ?onboarding=return. The page re-reads the account status (the backend fails closed) instead
  // of showing whatever was stored, so an account that cannot take cards never reads "Active".
  it('on the return from hosted onboarding, refreshes the account status once and shows the non-active state', async () => {
    const server = {
      connected: true,
      terms_accepted: true,
      stripe_charges_enabled: true, // stale: what the old fail-open backfill stored
      stripe_payouts_enabled: true,
      stripe_details_submitted: true,
      stripe_requirements_due: [] as string[],
      stripe_disabled_reason: null,
      platform_fee_bps: 0,
      collected_awaiting_payout: 0,
    };
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: ORG });
      if (url === '/api/organization/stripe/status') return Promise.resolve({ data: { ...server } });
      return Promise.resolve({ data: {} });
    });
    mockApi.post.mockImplementation((url: string) => {
      if (url === '/api/organization/stripe/refresh-status') {
        server.stripe_charges_enabled = false;
        server.stripe_payouts_enabled = false;
        return Promise.resolve({ data: { ...server } });
      }
      return Promise.resolve({ data: {} });
    });

    renderWithProviders(<ServwavePaymentsPage />, { ability: FULL, initialEntries: ['/settings/payments?onboarding=return'] });

    expect((await screen.findAllByText('Under review')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    const refreshCalls = mockApi.post.mock.calls.filter(([url]) => url === '/api/organization/stripe/refresh-status');
    expect(refreshCalls).toHaveLength(1);
  });

  // Fix round 1: what the page says about taking cards reads the ORGANIZATION query, not the
  // status query. A refresh that only updated the status left the page saying the org could take
  // cards under an "Under review" card. Since slice 20 that is the Card switch's availability.
  it('on the return from hosted onboarding, the Card switch turns unavailable once the refresh fails closed', async () => {
    const server = {
      connected: true,
      terms_accepted: true,
      stripe_charges_enabled: true, // stale: what the old fail-open backfill stored
      stripe_payouts_enabled: true,
      stripe_details_submitted: true,
      stripe_requirements_due: [] as string[],
      stripe_disabled_reason: null,
      platform_fee_bps: 0,
      collected_awaiting_payout: 0,
    };
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({
          data: {
            ...ORG,
            stripe_connected: server.connected,
            stripe_charges_enabled: server.stripe_charges_enabled,
            accepted_payment_methods: ['CASH', 'CARD'],
          },
        });
      }
      if (url === '/api/organization/stripe/status') return Promise.resolve({ data: { ...server } });
      return Promise.resolve({ data: {} });
    });
    // Hold the refresh until the stale row has rendered, so the test proves the row is
    // taken DOWN by the refresh rather than never having been read as charges=true.
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    mockApi.post.mockImplementation(async (url: string) => {
      if (url === '/api/organization/stripe/refresh-status') {
        await refreshGate;
        server.stripe_charges_enabled = false;
        server.stripe_payouts_enabled = false;
        return { data: { ...server } };
      }
      return { data: {} };
    });

    renderWithProviders(<ServwavePaymentsPage />, { ability: FULL, initialEntries: ['/settings/payments?onboarding=return'] });

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Credit card' })).not.toHaveAttribute('aria-disabled', 'true'));
    releaseRefresh();

    expect((await screen.findAllByText('Under review')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Credit card' })).toHaveAttribute('aria-disabled', 'true'));
  });

  // Fix round 1: the plain-visit guard on its own passed on the code before this slice (there
  // was no refresh at all), so it proved nothing. It now runs in the same test as the return:
  // the plain visit must NOT refresh, the return must refresh exactly once and drop the marker.
  it('refreshes only on the return from onboarding: not on a plain visit, once on the return, and the marker is dropped', async () => {
    const user = userEvent.setup();
    function Harness() {
      const navigate = useNavigate();
      const location = useLocation();
      return (
        <>
          <ServwavePaymentsPage />
          <button type="button" onClick={() => navigate('/settings/payments?onboarding=return')}>
            back from onboarding
          </button>
          <output data-testid="url-search">{location.search}</output>
        </>
      );
    }
    const refreshCalls = () =>
      mockApi.post.mock.calls.filter(([url]) => url === '/api/organization/stripe/refresh-status');

    renderWithProviders(<Harness />, { ability: FULL, initialEntries: ['/settings/payments'] });
    await screen.findByDisplayValue('40'); // org has loaded: the page has settled on the plain visit
    expect(refreshCalls()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'back from onboarding' }));

    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('url-search')).toHaveTextContent(/^$/));
    expect(refreshCalls()).toHaveLength(1);
  });
});
