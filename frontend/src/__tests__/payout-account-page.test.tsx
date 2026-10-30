// Payments go-live slice 34 - the owner-only "Payout account & verification" page.
// The embedded components are mocked (they do not render in jsdom); everything the page decides is real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { resetAccountScopedStores } from '@/lib/storeReset';
import PayoutAccountPage from '@/pages/v2/settings/PayoutAccountPage';
import type { StripeStatus } from '@/lib/api/organization';

const OWNER = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }]);
const NOT_OWNER = buildAbility([{ action: 'update', subject: 'Organization' }]);

const STATUS: StripeStatus = {
  connected: true,
  terms_accepted: true,
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  collected_awaiting_payout: 0,
};

const hoisted = vi.hoisted(() => ({
  status: undefined as unknown as StripeStatus,
  acceptTerms: vi.fn(),
  connect: vi.fn(),
  refresh: vi.fn(),
  accountLink: vi.fn(),
  toast: vi.fn(),
  load: vi.fn(),
  logout: vi.fn(),
  apiPost: vi.fn(),
  onboardingProps: vi.fn(),
  descriptor: 'HARBOR LOCKS' as string | null,
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useStripeStatus: () => ({ data: hoisted.status, isLoading: false }),
    useAcceptPaymentsTerms: () => ({ mutateAsync: hoisted.acceptTerms, isPending: false }),
    useConnectStripe: () => ({ mutateAsync: hoisted.connect, isPending: false }),
    useRefreshStripeStatus: () => ({ mutateAsync: hoisted.refresh }),
    useStripeAccountLink: () => ({ mutateAsync: hoisted.accountLink, isPending: false }),
    useStatementDescriptor: () => ({ data: hoisted.descriptor === null ? undefined : { statement_descriptor: hoisted.descriptor }, isLoading: false }),
  };
});
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});
vi.mock('@/lib/axios', () => ({ default: { post: hoisted.apiPost } }));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: hoisted.load }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="connect-provider">{children}</div>,
  ConnectNotificationBanner: (props: { onLoadError?: () => void }) => (
    <div data-testid="embedded-banner"><button onClick={props.onLoadError}>Simulate banner load error</button></div>
  ),
  ConnectAccountOnboarding: (props: { onExit: () => void }) => {
    hoisted.onboardingProps(props);
    return <div data-testid="embedded-onboarding"><button onClick={props.onExit}>Simulate embed exit</button></div>;
  },
  ConnectAccountManagement: () => <div data-testid="embedded-management" />,
}));

const renderPage = (ability = OWNER) => renderWithProviders(<PayoutAccountPage />, { ability });

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  resetAccountScopedStores(); // the shared embedded session is module state: start every test without one
  hoisted.logout.mockClear();
  hoisted.status = { ...STATUS };
  hoisted.descriptor = 'HARBOR LOCKS';
  hoisted.load.mockReturnValue({ logout: hoisted.logout });
  hoisted.acceptTerms.mockResolvedValue({ accepted: true });
  hoisted.connect.mockResolvedValue({ connected: true });
  hoisted.refresh.mockResolvedValue({ ...STATUS });
  hoisted.apiPost.mockResolvedValue({ data: { client_secret: 'cs_secret' } });
});

describe('who sees the page', () => {
  it('hides the page, and asks for no session, from someone without Manage payout account', () => {
    renderPage(NOT_OWNER);
    expect(screen.queryByText('Payout account & verification')).not.toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
    expect(hoisted.apiPost).not.toHaveBeenCalled();
  });

  it('shows the page to the owner', () => {
    renderPage();
    expect(screen.getByText('Payout account & verification')).toBeInTheDocument();
  });
});

describe('terms first', () => {
  beforeEach(() => {
    hoisted.status = { ...STATUS, connected: false, terms_accepted: false };
  });

  it('shows the terms and the heads-up, and requests no session while the terms are unticked', () => {
    renderPage();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ServWave Payments terms' })).toBeInTheDocument();
    expect(screen.getByText(/ServWave charges no payment fee/)).toBeInTheDocument();
    expect(screen.getByText(/To protect your account, you may be asked for a verification code sent by text\./)).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
    expect(hoisted.apiPost).not.toHaveBeenCalled();
  });

  it('drops the sentence about being authorized to bind the company', () => {
    const { container } = renderPage();
    expect(container.textContent).not.toMatch(/authorized to bind/i);
    expect(container.textContent).not.toMatch(/to these terms/i);
  });

  it('keeps Continue disabled until the box is ticked, then accepts the terms and opens the account, in that order', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    hoisted.acceptTerms.mockImplementation(async () => { order.push('terms'); return { accepted: true }; });
    hoisted.connect.mockImplementation(async () => { order.push('connect'); return { connected: true }; });
    renderPage();

    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => expect(order).toEqual(['terms', 'connect']));
    expect(hoisted.apiPost).not.toHaveBeenCalled(); // the session is the embedded component's own ask, after the status refresh
  });

  it('does not open an account when saving the acceptance fails', async () => {
    const user = userEvent.setup();
    hoisted.acceptTerms.mockRejectedValue(new Error('down'));
    renderPage();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(hoisted.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(hoisted.connect).not.toHaveBeenCalled();
  });

  it('skips opening an account the org already has', async () => {
    const user = userEvent.setup();
    hoisted.status = { ...STATUS, connected: true, terms_accepted: false };
    renderPage();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(hoisted.acceptTerms).toHaveBeenCalled());
    expect(hoisted.connect).not.toHaveBeenCalled();
  });
});

describe('the embedded components', () => {
  it('mounts the notification banner and onboarding for an account that has not finished setup', async () => {
    renderPage();
    expect(await screen.findByTestId('embedded-onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('embedded-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-management')).not.toBeInTheDocument();
  });

  it('mounts account management (bank and identity) once the details were submitted', async () => {
    hoisted.status = { ...STATUS, stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true };
    renderPage();
    expect(await screen.findByTestId('embedded-management')).toBeInTheDocument();
    expect(screen.getByTestId('embedded-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
  });

  it('asks for the owner surface when the embedded session needs a secret', async () => {
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    const options = hoisted.load.mock.calls[0][0] as { fetchClientSecret: () => Promise<string> };
    await expect(options.fetchClientSecret()).resolves.toBe('cs_secret');
    expect(hoisted.apiPost).toHaveBeenCalledWith('/api/organization/stripe/account-session', { surface: 'owner' });
  });

  it('hands the components resolved colour values, never a CSS variable reference', async () => {
    document.documentElement.style.setProperty('--primary', '12 45 58');
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    const { appearance } = hoisted.load.mock.calls[0][0] as { appearance: { variables: Record<string, string> } };
    expect(appearance.variables.colorPrimary).toBe(`#${['0c', '2d', '3a'].join('')}`); // 12 45 58 as hex
    for (const value of Object.values(appearance.variables)) expect(value).not.toMatch(/var\(|rgb\(var/);
    document.documentElement.style.removeProperty('--primary');
  });

  it('refreshes the status when the owner leaves onboarding', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Simulate embed exit' }));
    await waitFor(() => expect(hoisted.refresh).toHaveBeenCalled());
  });
});

describe('the status in plain words', () => {
  const cases: Array<[string, Partial<StripeStatus>, string]> = [
    ['Active', { stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true }, 'Active'],
    ['Action needed', { stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_requirements_due: ['individual.id_number'] }, 'Action needed'],
    ['Restricted', { stripe_details_submitted: true, stripe_charges_enabled: false, stripe_disabled_reason: 'requirements.past_due' }, 'Restricted'],
    ['Setup in progress (a brand-new account is not paused)', { stripe_details_submitted: false, stripe_disabled_reason: 'requirements.past_due' }, 'Setup in progress'],
  ];
  it.each(cases)('%s', (_name, overrides, label) => {
    hoisted.status = { ...STATUS, ...overrides };
    renderPage();
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('never prints an account id or a machine reason code', () => {
    hoisted.status = { ...STATUS, stripe_details_submitted: true, stripe_disabled_reason: 'requirements.past_due' };
    const { container } = renderPage();
    expect(container.textContent).not.toMatch(/acct_|requirements\.past_due/);
  });

  it('names no vendor in what it renders', () => {
    const { container } = renderPage();
    expect(container.textContent).not.toMatch(/stripe/i);
  });
});

describe('the embedded session ends on ServWave sign-out only', () => {
  it('does not call logout() when the page closes', async () => {
    const { unmount } = renderPage();
    await screen.findByTestId('embedded-onboarding');
    unmount();
    expect(hoisted.logout).not.toHaveBeenCalled();
  });

  it('reuses the session when the owner comes back', async () => {
    const first = renderPage();
    await screen.findByTestId('embedded-onboarding');
    first.unmount();
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    expect(hoisted.load).toHaveBeenCalledTimes(1);
  });

  it('calls logout() once when the account stores are reset for a sign-out', async () => {
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    resetAccountScopedStores();
    expect(hoisted.logout).toHaveBeenCalledTimes(1);
  });
});

describe('the sign-out leaves nothing of the embedded session in the page', () => {
  const frame = (src: string, hidden = false) => {
    const el = document.createElement('iframe');
    el.src = src;
    if (hidden) el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  };
  afterEach(() => document.querySelectorAll('iframe').forEach((f) => f.remove()));

  it("removes the processor's frames (the hidden controller included) after ending the session, and no other frame", async () => {
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    const mine = [
      frame('https://connect-js.stripe.com/v1.0/controller.html', true),
      frame('https://connect-js.stripe.com/v1.0/notification-banner.html'),
      frame('https://js.stripe.com/v3/m-outer.html'),
    ];
    const other = frame('https://example.com/widget');
    let finishLogout!: () => void;
    hoisted.logout.mockReturnValue(new Promise<void>((r) => { finishLogout = r; }));

    resetAccountScopedStores();
    expect(hoisted.logout).toHaveBeenCalledTimes(1);
    mine.forEach((f) => expect(document.body.contains(f)).toBe(true)); // the session ends first
    finishLogout();

    await waitFor(() => mine.forEach((f) => expect(document.body.contains(f)).toBe(false)));
    expect(document.body.contains(other)).toBe(true);
  });

  it('still clears them when ending the session fails', async () => {
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    const leftover = frame('https://connect-js.stripe.com/v1.0/controller.html', true);
    hoisted.logout.mockRejectedValue(new Error('offline'));
    resetAccountScopedStores();
    await waitFor(() => expect(document.body.contains(leftover)).toBe(false));
  });

  it('clears frames left by an earlier session even when no session is open now', async () => {
    const leftover = frame('https://connect-js.stripe.com/v1.0/controller.html', true);
    resetAccountScopedStores();
    await waitFor(() => expect(document.body.contains(leftover)).toBe(false));
  });

  it('also removes a frame the processor library mounts AFTER the sign-out finished (seconds later in a real browser)', async () => {
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    resetAccountScopedStores();
    await new Promise((r) => setTimeout(r, 20)); // sign-out fully settled
    const late = frame('https://js.stripe.com/v3/controller-with-preconnect-abc.html', true);
    await waitFor(() => expect(document.body.contains(late)).toBe(false));
  });

  it('stops watching once a new session starts, so the next owner keeps their own frames', async () => {
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    resetAccountScopedStores();
    await new Promise((r) => setTimeout(r, 20));
    cleanup();
    renderPage(); // a new session: getPayoutConnect() runs again
    await screen.findByTestId('embedded-onboarding');
    const mine = frame('https://js.stripe.com/v3/controller-with-preconnect-abc.html', true);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.contains(mine)).toBe(true);
  });
});

describe('the statement descriptor', () => {
  it('shows what customers see on their statement, as plain text with the explaining line', () => {
    renderPage();
    expect(screen.getByText('HARBOR LOCKS')).toBeInTheDocument();
    expect(screen.getByText("This is how charges appear on your customers' card statements.")).toBeInTheDocument();
  });

  it('has no input and no Save control: the platform cannot write it on this account', () => {
    renderPage();
    expect(screen.queryByLabelText('Statement descriptor')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /descriptor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save descriptor/i })).not.toBeInTheDocument();
  });

  it('gives no instruction to change it (the documentation does not say plainly that the account section can)', () => {
    renderPage();
    expect(screen.queryByText(/To change it/i)).not.toBeInTheDocument();
  });

  it('is not shown before the account exists (terms step)', () => {
    hoisted.status = { ...STATUS, connected: false, terms_accepted: false };
    renderPage();
    expect(screen.queryByText('HARBOR LOCKS')).not.toBeInTheDocument();
    expect(screen.queryByText(/card statements/i)).not.toBeInTheDocument();
  });
});

// The Settings side nav lists the page for the owner only.
import { Routes, Route } from 'react-router-dom';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';

describe('the Settings side nav entry', () => {
  const renderNav = (ability: ReturnType<typeof buildAbility>) =>
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="/settings/payments" element={<div />} />
        </Route>
      </Routes>,
      { ability, initialEntries: ['/settings/payments'] },
    );

  it('is listed for whoever holds Manage payout account', () => {
    renderNav(OWNER);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(nav).toHaveTextContent('Payout account & verification');
  });

  it('is not listed for someone who can edit company settings but not the payout account', () => {
    renderNav(NOT_OWNER);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(nav).not.toHaveTextContent('Payout account & verification');
    expect(nav).toHaveTextContent('Payments & Lists');
  });
});

// 33b fix round (D1): the error card shows only while the section is failed. Once the library's request for a
// session secret succeeds, a card left over from an earlier failure goes.
describe('the load-error card', () => {
  it('goes away once the session request succeeds', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('embedded-onboarding');
    await user.click(screen.getByRole('button', { name: 'Simulate banner load error' }));
    expect(await screen.findByText(/Couldn.t load secure setup/)).toBeInTheDocument();

    const options = hoisted.load.mock.calls[hoisted.load.mock.calls.length - 1][0] as { fetchClientSecret: () => Promise<string> };
    await options.fetchClientSecret();
    await waitFor(() => expect(screen.queryByText(/Couldn.t load secure setup/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
