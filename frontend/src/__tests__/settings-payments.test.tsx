import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { renderWithProviders } from './helpers';
/**
 * This file deliberately imports `@/pages/v2/settings/PaymentsListsPage`, NOT
 * `@/pages/settings/PaymentsListsPage`.
 *
 * `/settings/payments` is mounted from `pages/v2/routes/settings.routes.tsx` via
 * `import('../settings/PaymentsListsPage')` - and because that import sits in
 * `pages/v2/routes/`, it resolves to the v2 fork. The v1 file is dead code whose only
 * importer was this test, which is exactly how #1730's Tags card shipped to a page no
 * user can reach while these gate assertions stayed green.
 */
import PaymentsListsPage from '@/pages/v2/settings/PaymentsListsPage';
import { buildAbility } from '@/lib/ability';

const mockApi = vi.mocked(api);

// The embedded processor SDKs do not render in jsdom; stand in for them.
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

describe('PaymentsListsPage — Payments & Lists (in-shell)', () => {
  it('renders payments + lists sections, but NOT the moved estimate document copy', async () => {
    renderWithProviders(<PaymentsListsPage />);
    expect(await screen.findByText('Accepted Payment Methods')).toBeInTheDocument();
    expect(screen.getByText('Default Deposit')).toBeInTheDocument();
    expect(screen.getByText('Lead/Customer Sources')).toBeInTheDocument();
    expect(screen.getByText('Job Types')).toBeInTheDocument();
    // estimate copy was moved to Branding & Templates
    expect(screen.queryByText('Estimate Document Copy')).not.toBeInTheDocument();
  });

  it('loads the saved deposit percentage from the org object', async () => {
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByText('Default Deposit');
    expect(await screen.findByDisplayValue('40')).toBeInTheDocument();
  });

  it('adds a source chip to the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByText('Lead/Customer Sources');

    const input = screen.getByPlaceholderText(/New source/);
    await user.type(input, 'Referral{Enter}');
    expect(await screen.findByText('Referral')).toBeInTheDocument();
  });

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
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByDisplayValue('40'); // org has loaded, form has reset()

    expect(screen.getByRole('switch', { name: 'Credit card' })).toBeDisabled();
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
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByDisplayValue('40'); // org has loaded, form has reset()

    const methodsCard = screen.getByText('Accepted Payment Methods').closest('[data-slot="card"]') as HTMLElement;
    expect(within(methodsCard).getByRole('switch', { name: 'Credit card' })).toBeEnabled();
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
    const { container } = renderWithProviders(<PaymentsListsPage />);

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

  it('the status card button takes the owner to the payout account page', async () => {
    serveStatus(connectedNotSubmitted);
    const user = userEvent.setup();
    const Where = () => <div data-testid="where">{useLocation().pathname}</div>;
    renderWithProviders(<><PaymentsListsPage /><Where /></>, {
      ability: buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }]),
    });

    await user.click(await screen.findByRole('button', { name: 'Resume setup' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/settings/payout-account');
  });

  it('shows the status but no setup button to someone without Manage payout account', async () => {
    serveStatus(connectedNotSubmitted);
    renderWithProviders(<PaymentsListsPage />, {
      ability: buildAbility([{ action: 'update', subject: 'Organization' }]),
    });

    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume setup|set up payments|fix now/i })).not.toBeInTheDocument();
  });
});

describe('PaymentsListsPage — tag management gate', () => {
  // `update`/`delete Tag` carry no defaultGrants row, so only ADMIN (`manage all`)
  // holds both. A dispatcher or salesperson can still read and create tags from a
  // record, but must not see the org-wide rename/delete surface.
  const ADMIN = buildAbility([
    { action: 'update', subject: 'Tag' },
    { action: 'delete', subject: 'Tag' },
  ]);
  const NON_ADMIN = buildAbility([
    { action: 'read', subject: 'Tag' },
    { action: 'create', subject: 'Tag' },
  ]);

  beforeEach(() => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: ORG });
      if (url === '/api/tags') {
        return Promise.resolve({ data: { tags: [{ id: 't1', name: 'Urgent', color: '#EF4444' }] } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it('shows the Tags card to an admin', async () => {
    renderWithProviders(<PaymentsListsPage />, { ability: ADMIN });
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete tag Urgent')).toBeInTheDocument();
  });

  it('hides the Tags card from a non-admin who can still create tags', async () => {
    renderWithProviders(<PaymentsListsPage />, { ability: NON_ADMIN });
    // The rest of the page still renders — only the tag card is withheld.
    expect(await screen.findByText('Lead/Customer Sources')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tags' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete tag Urgent')).not.toBeInTheDocument();
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

    renderWithProviders(<PaymentsListsPage />, { initialEntries: ['/settings/payments?onboarding=return'] });

    expect(await screen.findByText('Under review')).toBeInTheDocument();
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

    renderWithProviders(<PaymentsListsPage />, { initialEntries: ['/settings/payments?onboarding=return'] });

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Credit card' })).toBeEnabled());
    releaseRefresh();

    expect(await screen.findByText('Under review')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Credit card' })).toBeDisabled());
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
          <PaymentsListsPage />
          <button type="button" onClick={() => navigate('/settings/payments?onboarding=return')}>
            back from onboarding
          </button>
          <output data-testid="url-search">{location.search}</output>
        </>
      );
    }
    const refreshCalls = () =>
      mockApi.post.mock.calls.filter(([url]) => url === '/api/organization/stripe/refresh-status');

    renderWithProviders(<Harness />, { initialEntries: ['/settings/payments'] });
    await screen.findByDisplayValue('40'); // org has loaded: the page has settled on the plain visit
    expect(refreshCalls()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'back from onboarding' }));

    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('url-search')).toHaveTextContent(/^$/));
    expect(refreshCalls()).toHaveLength(1);
  });
});
