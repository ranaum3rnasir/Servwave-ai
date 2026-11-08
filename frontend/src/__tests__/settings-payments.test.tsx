import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
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

// Task 2.4 — the embedded Stripe SDKs don't render in jsdom; stand in for them so the
// one wiring test below (card CTA -> real onOpenDrawer -> <StripeOnboardingDrawer>) can
// reach the drawer's "ready" phase without a real iframe.
vi.mock('@stripe/connect-js', () => ({
  loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })),
}));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div data-testid="connect-account-onboarding" />,
}));

const ORG = {
  id: 'o1',
  stripe_account_id: null,
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

  // Card acceptance is NOT a manual toggle in this list - dispatchers can't check/uncheck
  // it. It's governed entirely by ServWave Payments (Stripe) connection status. But once
  // charges are live, the list DOES surface a read-only "ServWave Payments" confirmation
  // row (2026-07-24) so a contractor can see, in the one place they check every other
  // accepted method, that card payments are actually on - the status card above only
  // says "payouts enabled," which doesn't answer that question.
  //
  // Both tests below gate on `findByDisplayValue('40')` (the deposit-percentage input
  // reset() populates from the loaded org) so the assertion runs against the org fixture,
  // not the transient pre-load render (this page has no `isLoading` guard).
  it('does not render a ServWave Payments row mid-onboarding (account id set, charges not yet enabled)', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({
          data: { ...ORG, stripe_account_id: 'acct_1', stripe_charges_enabled: false },
        });
      }
      return Promise.resolve({ data: {} });
    });
    renderWithProviders(<PaymentsListsPage />);
    await screen.findByDisplayValue('40'); // org has loaded, form has reset()

    // Scope to the Accepted Payment Methods card - the ServWave Payments STATUS card
    // (a different component, rendered above) has its own unrelated "ServWave Payments" h3.
    const methodsCard = screen.getByText('Accepted Payment Methods').closest('[data-slot="card"]') as HTMLElement;
    expect(within(methodsCard).queryByText('ServWave Payments')).not.toBeInTheDocument();
    expect(screen.queryByText(/locked — Stripe is integrated/i)).not.toBeInTheDocument();
  });

  it('renders a read-only, checked "ServWave Payments" row when charges are enabled, alongside the toggleable manual methods', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({
          data: {
            ...ORG,
            stripe_account_id: 'acct_1',
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
    // The row is not an editable checkbox - it's not part of the CASL/RHF form state.
    expect(within(methodsCard).queryByRole('checkbox', { name: /ServWave Payments/i })).not.toBeInTheDocument();
    const row = within(methodsCard).getByText('ServWave Payments');
    expect(row.closest('div')).toHaveTextContent(/Accepted automatically/i);
    // The manual/offline methods it DOES manage are still rendered and toggleable.
    expect(screen.getByRole('checkbox', { name: 'Cash' })).toBeInTheDocument();
  });

  // Task 2.4 — closes the card<->drawer loop: this page now owns `payDrawerOpen` and
  // passes the real opener to StripePaymentsStatusCard, replacing Task 2.3's
  // `onOpenDrawer={() => {}}` placeholder. Uses the "Resume setup" CTA (state 2 — account
  // id already set) so the click reaches onOpenDrawer directly, without also exercising
  // the separate connect() network call already covered by Task 2.3's own tests.
  it('Task 2.4 wiring: the status card CTA opens the real StripeOnboardingDrawer, not a no-op', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: ORG });
      if (url === '/api/organization/stripe/status') {
        return Promise.resolve({
          data: {
            stripe_account_id: 'acct_1',
            stripe_charges_enabled: false,
            stripe_payouts_enabled: false,
            stripe_details_submitted: false,
            stripe_requirements_due: [],
            stripe_disabled_reason: null,
            platform_fee_bps: 50,
            collected_awaiting_payout: 0,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    mockApi.post.mockImplementation((url: string) => {
      if (url === '/api/organization/stripe/account-session') {
        return Promise.resolve({ data: { client_secret: 'sec_123' } });
      }
      return Promise.resolve({ data: {} });
    });
    const user = userEvent.setup();
    renderWithProviders(<PaymentsListsPage />);

    // Drawer starts closed — its Sheet content isn't in the document.
    expect(screen.queryByText(/Secured by Stripe/)).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Resume setup' }));

    expect(await screen.findByText(/Secured by Stripe/)).toBeInTheDocument();
    expect(await screen.findByTestId('connect-account-onboarding')).toBeInTheDocument();
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
});
