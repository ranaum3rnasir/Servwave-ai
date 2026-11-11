// Settings > ServWave Payments, card 2 "Payout account & verification" (was the owner-only payout page, payments go-live slice 34).
// The embedded components are mocked (they do not render in jsdom); everything the page decides is real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { resetAccountScopedStores } from '@/lib/storeReset';
import ServwavePaymentsPage from '@/pages/v2/settings/ServwavePaymentsPage';
import type { StripeStatus } from '@/lib/api/shared/organization';
import { firstPayoutNotice } from '@/lib/payments/first-payout-notice';

const OWNER = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }]);
const NOT_OWNER = buildAbility([{ action: 'update', subject: 'Organization' }]);

const STATUS: StripeStatus = {
  connected: true,
  terms_accepted: true,
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
  stripe_requirements_due: ['business_profile.url'], // something is due now, so the secure form mounts by itself
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
  bannerProps: vi.fn(),
  descriptor: 'HARBOR LOCKS' as string | null,
}));

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/api/shared/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/shared/organization')>();
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
  ConnectNotificationBanner: (props: { onLoadError?: () => void }) => {
    hoisted.bannerProps(props);
    return <div data-testid="embedded-banner"><button onClick={props.onLoadError}>Simulate banner load error</button></div>;
  },
  ConnectAccountOnboarding: (props: { onExit: () => void }) => {
    hoisted.onboardingProps(props);
    return <div data-testid="embedded-onboarding"><button onClick={props.onExit}>Simulate embed exit</button></div>;
  },
  ConnectAccountManagement: () => <div data-testid="embedded-management" />,
}));

const renderPage = (ability = OWNER) => renderWithProviders(<ServwavePaymentsPage />, { ability });

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

describe('who sees the card', () => {
  it('shows status only, asks for no session and offers no buttons, to someone without Manage payout account', () => {
    renderPage(NOT_OWNER);
    expect(screen.getByText('Payout account & verification')).toBeInTheDocument();
    expect(screen.getByText('Setup in progress')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /finish setup|accept terms|manage bank/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('statement-descriptor')).not.toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
    expect(hoisted.apiPost).not.toHaveBeenCalled();
  });

  it('shows the card to the owner', () => {
    renderPage();
    expect(screen.getByText('Payout account & verification')).toBeInTheDocument();
  });

  it('shows the no-access page to someone with neither switch', () => {
    renderPage(buildAbility([]));
    expect(screen.queryByText('Payout account & verification')).not.toBeInTheDocument();
  });
});

describe('terms first', () => {
  beforeEach(() => {
    hoisted.status = { ...STATUS, connected: false, terms_accepted: false };
  });

  it('shows the terms and the heads-up, and requests no session while the terms are unticked', () => {
    renderPage();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    for (const name of [/^ServWave Payments terms/, /^fee schedule/]) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.getAllByText(/ServWave charges no payment fee/).length).toBeGreaterThan(0);
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

  it('keeps Accept terms and set up payout account disabled until the box is ticked, then accepts the terms and opens the account, in that order', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    hoisted.acceptTerms.mockImplementation(async () => { order.push('terms'); return { accepted: true }; });
    hoisted.connect.mockImplementation(async () => { order.push('connect'); return { connected: true }; });
    renderPage();

    const button = screen.getByRole('button', { name: 'Accept terms and set up payout account' });
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
    await user.click(screen.getByRole('button', { name: 'Accept terms and set up payout account' }));
    await waitFor(() => expect(hoisted.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(hoisted.connect).not.toHaveBeenCalled();
  });

  it('skips opening an account the org already has', async () => {
    const user = userEvent.setup();
    hoisted.status = { ...STATUS, connected: true, terms_accepted: false };
    renderPage();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Accept terms and set up payout account' }));
    await waitFor(() => expect(hoisted.acceptTerms).toHaveBeenCalled());
    expect(hoisted.connect).not.toHaveBeenCalled();
  });
});

describe('the embedded components', () => {
  it('mounts the notification banner and onboarding for an account that has not finished setup', async () => {
    renderPage();
    expect(await screen.findByTestId('embedded-onboarding')).toBeInTheDocument();
    expect(hoisted.onboardingProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectionOptions: { fields: 'currently_due', futureRequirements: 'omit' } }),
    );
    expect(screen.queryByTestId('due-later')).not.toBeInTheDocument();
    expect(screen.getByTestId('embedded-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-management')).not.toBeInTheDocument();
  });

  it('offers Manage bank and identity once payouts are on and nothing is due, and mounts account management on click', async () => {
    const user = userEvent.setup();
    hoisted.status = {
      ...STATUS, stripe_requirements_due: [], stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
      first_payout: { state: 'waiting' },
    };
    renderPage();
    expect(await screen.findByText('Bank and identity details are managed in a secure form. They never pass through ServWave.')).toBeInTheDocument();
    // No payout has reached the bank yet: the card says how long the first one can take.
    expect(screen.getByTestId('first-payout-notice')).toHaveTextContent('Your first payout can take up to 7 business days');
    expect(screen.getByTestId('embedded-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-management')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Manage bank and identity' }));
    expect(await screen.findByTestId('embedded-management')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
  });

  // A co-owner's details are only asked for once volume passes a threshold: setup never asked for them. The page says so,
  // the banner lists them, and Add details now opens the form that collects them; onboarding of what is due now asks for less.
  it('active with details due later: the row reads Due later, the banner shows later items, Add details now collects them', async () => {
    const user = userEvent.setup();
    hoisted.status = {
      ...STATUS, stripe_requirements_due: [], stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
      verification: { business_details: 'verified', owner_identity: 'due_later', bank_account: 'verified', tax_id: 'verified' },
    };
    renderPage();
    expect(await screen.findByText('Due later')).toBeInTheDocument();
    expect(screen.getByTestId('due-later')).toHaveTextContent('payouts pause until they are added');
    expect(screen.getByRole('button', { name: 'Manage bank and identity' })).toBeInTheDocument();
    expect(hoisted.bannerProps).toHaveBeenCalledWith(
      expect.objectContaining({ collectionOptions: { fields: 'eventually_due', futureRequirements: 'include' } }),
    );
    await user.click(screen.getByRole('button', { name: 'Add details now' }));
    expect(await screen.findByTestId('embedded-onboarding')).toBeInTheDocument();
    expect(hoisted.onboardingProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectionOptions: { fields: 'eventually_due', futureRequirements: 'include' } }),
    );
    // The secure-setup fallback for this form collects the later items too.
    await user.click(screen.getByRole('button', { name: 'Simulate banner load error' }));
    const tab = { opener: null as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    hoisted.accountLink.mockResolvedValue({ url: 'https://secure.example.test/setup' });
    await user.click(screen.getByRole('button', { name: /^Continue in secure setup/ }));
    await waitFor(() => expect(hoisted.accountLink).toHaveBeenCalledWith({ collect: 'all' }));
    open.mockRestore();
  });

  it('does not mount the onboarding by itself when nothing is due; Finish setup mounts it', async () => {
    const user = userEvent.setup();
    hoisted.status = { ...STATUS, stripe_requirements_due: [] };
    renderPage();
    expect(await screen.findByText('The secure form for the details still due appears here.')).toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByTestId('embedded-onboarding')).toBeInTheDocument();
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
    ['Active', { stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_requirements_due: [] }, 'Active'],
    ['Action needed', { stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_requirements_due: ['individual.id_number'] }, 'Action needed'],
    ['Restricted', { stripe_details_submitted: true, stripe_charges_enabled: false, stripe_disabled_reason: 'requirements.past_due' }, 'Restricted'],
    ['Setup in progress (a brand-new account is not paused)', { stripe_details_submitted: false, stripe_disabled_reason: 'requirements.past_due' }, 'Setup in progress'],
  ];
  it.each(cases)('%s', (_name, overrides, label) => {
    hoisted.status = { ...STATUS, ...overrides };
    renderPage();
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('splits "set up" (charges on, bank pending) from "active" (payouts on)', () => {
    hoisted.status = { ...STATUS, stripe_requirements_due: [], stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: false };
    const first = renderPage();
    expect(screen.getByText('Your payout account is set up.')).toBeInTheDocument();
    first.unmount();
    hoisted.status = { ...STATUS, stripe_requirements_due: [], stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true };
    renderPage();
    expect(screen.getByText('Your payout account is active.')).toBeInTheDocument();
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
  it('shows what customers see on their statement in a read-only field, with an example line', () => {
    renderPage();
    const field = screen.getByLabelText('Statement descriptor');
    expect(field).toHaveValue('HARBOR LOCKS');
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveAttribute('aria-readonly', 'true');
    const example = screen.getByLabelText('Example statement line');
    expect(example).toHaveTextContent('HARBOR LOCKS');
    expect(example).toHaveTextContent('$642.50');
  });

  it('keeps the explaining line behind a "?" and has no Save control', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByText(/How a charge from you reads on your customers/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More about statement descriptor' }));
    expect(await screen.findByText(/to change it, contact ServWave support/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save descriptor/i })).not.toBeInTheDocument();
  });

  it('is hidden from someone without Manage payout account (the endpoint needs that switch)', () => {
    renderPage(NOT_OWNER);
    expect(screen.queryByLabelText('Statement descriptor')).not.toBeInTheDocument();
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
          <Route path="/settings/servwave-payments" element={<div />} />
        </Route>
      </Routes>,
      { ability, initialEntries: ['/settings/servwave-payments'] },
    );

  it('is listed (as ServWave Payments) for whoever holds Manage payout account', () => {
    renderNav(OWNER);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(nav).toHaveTextContent('ServWave Payments');
    expect(nav).not.toHaveTextContent('Payout account & verification');
  });

  it('is not listed for someone who can edit company settings but not the payout account', () => {
    renderNav(NOT_OWNER);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(nav).not.toHaveTextContent('Payout account & verification');
    expect(nav).toHaveTextContent('ServWave Payments');
    expect(nav).toHaveTextContent('Lists');
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
    // Both ways out show as soon as the first load has failed.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Continue in secure setup/ })).toBeInTheDocument();

    const options = hoisted.load.mock.calls[hoisted.load.mock.calls.length - 1][0] as { fetchClientSecret: () => Promise<string> };
    await options.fetchClientSecret();
    await waitFor(() => expect(screen.queryByText(/Couldn.t load secure setup/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});


describe('fix round 1: terms sentence, 44px controls, secure-setup tab', () => {
  it('the terms sentence flows inline: both links sit inside the one sentence, not as blocks', () => {
    hoisted.status = { ...STATUS, connected: false, terms_accepted: false };
    renderPage();
    const label = screen.getByRole('checkbox').closest('label') as HTMLElement;
    expect(label.textContent).toMatch(
      /^I agree to the ServWave Payments terms \(opens in a new tab\) and fee schedule \(opens in a new tab\)\. Customers pay the invoice amount\./,
    );
    for (const name of [/^ServWave Payments terms/, /^fee schedule/]) {
      const link = screen.getByRole('link', { name });
      const tokens = link.className.split(/\s+/);
      expect(tokens).toContain('inline');
      expect(tokens).not.toContain('inline-flex');
      expect(tokens).not.toContain('flex');
      expect(tokens).not.toContain('block');
    }
  });

  it('every button of cards 1 and 2 is 44px high on a phone', async () => {
    const user = userEvent.setup();
    hoisted.status = { ...STATUS, connected: false, terms_accepted: false };
    const first = renderPage();
    expect(screen.getByRole('button', { name: 'Accept terms and set up payout account' }).className).toContain('max-sm:h-11');
    expect(screen.getByRole('button', { name: 'Set up payments' }).className).toContain('max-sm:h-11');
    first.unmount();

    hoisted.status = { ...STATUS, stripe_requirements_due: [] };
    const second = renderPage();
    expect(screen.getByRole('button', { name: 'Resume setup' }).className).toContain('max-sm:h-11');
    const finish = await screen.findByRole('button', { name: 'Finish setup' });
    expect(finish.className).toContain('max-sm:h-11');
    expect(screen.getByLabelText('Statement descriptor').className).toContain('max-sm:h-11');
    second.unmount();

    hoisted.status = { ...STATUS, stripe_requirements_due: ['x'], stripe_details_submitted: true, stripe_charges_enabled: true };
    renderPage();
    expect(screen.getByRole('button', { name: 'Fix now' }).className).toContain('max-sm:h-11');
    await user.click(await screen.findByRole('button', { name: 'Simulate banner load error' }));
    expect(screen.getByRole('button', { name: 'Retry' }).className).toContain('max-sm:h-11');
    expect(screen.getByRole('button', { name: /^Continue in secure setup/ }).className).toContain('max-sm:h-11');
  });

  it('manage bank and identity and the bank nudge buttons are 44px on a phone', () => {
    hoisted.status = { ...STATUS, stripe_requirements_due: [], stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true };
    renderPage();
    expect(screen.getByRole('button', { name: 'Manage bank and identity' }).className).toContain('max-sm:h-11');
  });

  it('the status row does not turn its width basis into a height on a phone', () => {
    hoisted.status = { ...STATUS, connected: false, terms_accepted: false };
    renderPage();
    const text = screen.getByText('Accept card payments - set up ServWave Payments.').parentElement as HTMLElement;
    expect(text.className).toContain('max-sm:basis-auto');
  });

  describe('Continue in secure setup', () => {
    const failLoad = async (user: ReturnType<typeof userEvent.setup>) => {
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Simulate banner load error' }));
      return screen.getByRole('button', { name: /^Continue in secure setup/ });
    };

    it('opens a tab at once and sets its address once the link is minted', async () => {
      const user = userEvent.setup();
      const tab = { opener: 'x' as unknown, location: { href: '' }, close: vi.fn() };
      const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      hoisted.accountLink.mockResolvedValue({ url: 'https://secure.example.test/setup' });
      await user.click(await failLoad(user));
      await waitFor(() => expect(tab.location.href).toBe('https://secure.example.test/setup'));
      expect(open).toHaveBeenCalledWith('about:blank', '_blank');
      expect(tab.opener).toBeNull();
      expect(tab.close).not.toHaveBeenCalled();
      open.mockRestore();
    });

    it('closes the tab and toasts when the link cannot be minted', async () => {
      const user = userEvent.setup();
      const tab = { opener: 'x' as unknown, location: { href: '' }, close: vi.fn() };
      const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      hoisted.accountLink.mockRejectedValue(new Error('down'));
      await user.click(await failLoad(user));
      await waitFor(() => expect(tab.close).toHaveBeenCalled());
      expect(tab.location.href).toBe('');
      expect(hoisted.toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive', title: 'Couldn’t open secure setup', description: 'Try again.' }),
      );
      open.mockRestore();
    });
  });
});

// The wait for the first payout, explained until it arrives, then a confirmation (the rule itself; one page mount above).
describe('first payout notice', () => {
  const active: StripeStatus = {
    ...STATUS, stripe_requirements_due: [], stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
  };
  it('explains the wait, then the payout on its way with its date, then confirms; never names a vendor', () => {
    const waiting = firstPayoutNotice({ ...active, first_payout: { state: 'waiting' } })!;
    expect(waiting).toMatchObject({ tone: 'neutral', title: 'Your first payout can take up to 7 business days' });
    expect(waiting.body).toMatch(/Bank \(ACH\) payments take about 4 more business days/);
    expect(waiting.body).toMatch(/one deposit, after processing fees, from ServWave/);
    expect(firstPayoutNotice({ ...active, first_payout: { state: 'on_the_way', arrival_date: '2026-11-13' } })!.title)
      .toBe('Your first payout is on its way, expected Fri, Nov 13');
    const arrived = firstPayoutNotice({ ...active, first_payout: { state: 'arrived', arrival_date: '2026-11-06' } })!;
    expect(arrived).toMatchObject({ tone: 'success', title: 'Payouts are arriving regularly' });
    expect(arrived.body).toMatch(/^Your first payout reached your bank on Fri, Nov 6\./);
    for (const n of [waiting, arrived]) expect(`${n.title} ${n.body}`).not.toMatch(/stripe/i);
  });
  it('says nothing while the account cannot take payments, or without a payout state', () => {
    expect(firstPayoutNotice({ ...active, stripe_charges_enabled: false, first_payout: { state: 'waiting' } })).toBeNull();
    expect(firstPayoutNotice({ ...active, stripe_details_submitted: false, first_payout: { state: 'waiting' } })).toBeNull();
    expect(firstPayoutNotice(active)).toBeNull();
  });
});
