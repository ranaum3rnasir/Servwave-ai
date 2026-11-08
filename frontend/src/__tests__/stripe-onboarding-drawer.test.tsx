// Payments Phase 2, Task 2.4 — onboarding drawer state machine (spec §3.1/§3.2/§3.6/§6.2).
// Phase = needsTerms | initializing | ready | error. One test per transition, plus the
// three hard invariants called out in the task brief's self-review: (1) the embedded
// component never mounts before terms are accepted — server-verified, not just UI
// ordering; (2) the hosted-Account-Link fallback appears after exactly the 2nd failure
// (not the 1st, and it doesn't disappear again on a 3rd); (3) no card/bank/SSN input is
// ever rendered by this component itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { StripeOnboardingDrawer } from '@/components/payments/StripeOnboardingDrawer';
import type { Organization, StripeStatus } from '@/lib/api/organization';

// NOTE: no platform_fee_bps — the real /api/organization payload does NOT include it (only
// /stripe/status does). Omitting it here mirrors production, so the drawer's fee text must be
// sourced from useStripeStatus(); reading it off `org` renders "NaN%" (the bug this guards).
const ORG = {
  id: 'o1',
  name: 'Acme Plumbing',
} as Organization;

// The payments status DOES carry platform_fee_bps (50 bps = 0.5%) — this is the drawer's fee source.
const STATUS = {
  stripe_account_id: 'acct_1',
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  platform_fee_bps: 50,
  collected_awaiting_payout: 0,
} as StripeStatus;

const hoisted = vi.hoisted(() => ({
  org: undefined as unknown as Organization,
  stripeStatus: undefined as unknown as StripeStatus,
  sessionMutateAsync: vi.fn(),
  acceptTermsMutateAsync: vi.fn(),
  acceptTermsPending: false,
  accountLinkMutateAsync: vi.fn(),
  accountLinkPending: false,
  toast: vi.fn(),
  loadConnectAndInitialize: vi.fn(),
  onboardingProps: vi.fn(),
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.org }),
    useStripeStatus: () => ({ data: hoisted.stripeStatus }),
    useStripeAccountSession: () => ({ mutateAsync: hoisted.sessionMutateAsync }),
    useAcceptPaymentsTerms: () => ({
      mutateAsync: hoisted.acceptTermsMutateAsync,
      isPending: hoisted.acceptTermsPending,
    }),
    useStripeAccountLink: () => ({
      mutateAsync: hoisted.accountLinkMutateAsync,
      isPending: hoisted.accountLinkPending,
    }),
  };
});

vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

vi.mock('@stripe/connect-js', () => ({
  loadConnectAndInitialize: hoisted.loadConnectAndInitialize,
}));

// Stand-ins for Stripe's real embedded iframe components — real ones don't render in
// jsdom. ConnectAccountOnboarding reports every prop it was called with (so tests can
// assert on the exact collectionOptions shape) and exposes a button that fires onExit,
// simulating the admin finishing/leaving the embedded flow.
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="connect-provider">{children}</div>
  ),
  ConnectAccountOnboarding: (props: { onExit: () => void; collectionOptions?: unknown }) => {
    hoisted.onboardingProps(props);
    return (
      <div data-testid="connect-account-onboarding">
        <button onClick={props.onExit}>Simulate embed exit</button>
      </div>
    );
  },
}));

function renderDrawer(open = true) {
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <StripeOnboardingDrawer open={open} onOpenChange={onOpenChange} />
  );
  return { onOpenChange, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.org = { ...ORG };
  hoisted.stripeStatus = { ...STATUS };
  hoisted.acceptTermsPending = false;
  hoisted.accountLinkPending = false;
  hoisted.loadConnectAndInitialize.mockReturnValue({ logout: vi.fn() });
  Object.defineProperty(window, 'location', {
    value: { ...window.location, href: '' },
    writable: true,
  });
});

describe('StripeOnboardingDrawer — state machine', () => {
  it('initializing: shows a skeleton while the account-session probe is in flight, no checkbox/embed yet', async () => {
    let resolveProbe: (v: { client_secret: string }) => void;
    hoisted.sessionMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      })
    );
    renderDrawer();

    // SheetContent renders through a Radix Portal into document.body, not into RTL's
    // `container` — query the document so this actually inspects the portaled content
    // (a `container`-scoped query here would trivially pass no matter what renders).
    expect(document.body.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connect-account-onboarding')).not.toBeInTheDocument();

    // Drain the pending probe so the test doesn't leak a dangling mutation into the next one.
    resolveProbe!({ client_secret: 'sec_x' });
    await waitFor(() => expect(hoisted.loadConnectAndInitialize).toHaveBeenCalled());
  });

  it('initializing -> ready: a successful probe mints the account session and mounts the embed with currently_due collectionOptions', async () => {
    hoisted.sessionMutateAsync.mockResolvedValue({ client_secret: 'sec_123' });
    renderDrawer();

    expect(await screen.findByTestId('connect-account-onboarding')).toBeInTheDocument();
    expect(hoisted.loadConnectAndInitialize).toHaveBeenCalledTimes(1);
    expect(hoisted.onboardingProps).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionOptions: { fields: 'currently_due', futureRequirements: 'omit' },
      })
    );
  });

  // Real bug caught live in the §13.1 sandbox validation: the "Add information" button in
  // the real embedded iframe never advanced past its landing card no matter how it was
  // clicked. Root cause — collectionOptions/onExit were inline literals recreated on every
  // render, and Stripe's Connect.js remounts the embedded element whenever those props
  // change identity. ANY unrelated re-render of this drawer (a background react-query
  // refetch of org/status while the drawer is already open) recreated them and reset the
  // embed back to its first step before a real user could ever get past it.
  it('ready: an unrelated re-render (e.g. a background status refetch) does not recreate collectionOptions/onExit — Connect.js only remounts on a real prop change', async () => {
    hoisted.sessionMutateAsync.mockResolvedValue({ client_secret: 'sec_stable' });
    const onOpenChange = vi.fn();
    const { rerender } = renderWithProviders(
      <StripeOnboardingDrawer open={true} onOpenChange={onOpenChange} />
    );

    await screen.findByTestId('connect-account-onboarding');
    const firstProps = hoisted.onboardingProps.mock.calls[0][0] as {
      collectionOptions: unknown;
      onExit: () => void;
    };

    hoisted.stripeStatus = { ...STATUS, platform_fee_bps: 60 };
    rerender(<StripeOnboardingDrawer open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => expect(hoisted.onboardingProps.mock.calls.length).toBeGreaterThan(1));
    const lastCall = hoisted.onboardingProps.mock.calls.length - 1;
    const secondProps = hoisted.onboardingProps.mock.calls[lastCall][0] as {
      collectionOptions: unknown;
      onExit: () => void;
    };

    expect(secondProps.collectionOptions).toBe(firstProps.collectionOptions);
    expect(secondProps.onExit).toBe(firstProps.onExit);
  });

  it('initializing -> needsTerms: a 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED shows the clickwrap, unchecked, Continue disabled', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue({
      response: { data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' } },
    });
    renderDrawer();

    const checkbox = await screen.findByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    // Fee % is sourced from /stripe/status (platform_fee_bps 50 → 0.5%), NOT from useOrganization()
    // whose payload omits platform_fee_bps — reading it off `org` rendered "NaN%" in the disclosure.
    expect(screen.getByText(/0\.5%/)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.getByText(/Acme Plumbing/)).toBeInTheDocument();
  });

  it('needsTerms: the embedded component never mounts before terms are accepted (gate is real, not UI ordering)', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue({
      response: { data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' } },
    });
    renderDrawer();

    await screen.findByRole('checkbox');
    expect(hoisted.loadConnectAndInitialize).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connect-account-onboarding')).not.toBeInTheDocument();
  });

  it('needsTerms: clicking Continue while unchecked is a no-op — disabled means the browser never fires onClick', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue({
      response: { data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' } },
    });
    const user = userEvent.setup();
    renderDrawer();

    const continueBtn = await screen.findByRole('button', { name: 'Continue' });
    await user.click(continueBtn);

    expect(hoisted.acceptTermsMutateAsync).not.toHaveBeenCalled();
    expect(hoisted.loadConnectAndInitialize).not.toHaveBeenCalled();
  });

  it('needsTerms -> ready: checking the box + Continue accepts terms THEN mints the session and mounts the embed', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue({
      response: { data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' } },
    });
    hoisted.acceptTermsMutateAsync.mockResolvedValue({ accepted: true });
    const user = userEvent.setup();
    renderDrawer();

    await user.click(await screen.findByRole('checkbox'));
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeEnabled();
    await user.click(continueBtn);

    await waitFor(() => expect(hoisted.acceptTermsMutateAsync).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('connect-account-onboarding')).toBeInTheDocument();
    expect(hoisted.loadConnectAndInitialize).toHaveBeenCalledTimes(1);
  });

  it('needsTerms: an accept-terms failure shows feedback and does NOT mint the session or mount the embed', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue({
      response: { data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' } },
    });
    hoisted.acceptTermsMutateAsync.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderDrawer();

    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalled());
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' })
    );
    expect(hoisted.loadConnectAndInitialize).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connect-account-onboarding')).not.toBeInTheDocument();
    // Still gated — the checkbox/Continue gate is still on screen, not a dead end.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('initializing -> error (1st failure): shows Retry but NOT the hosted-link fallback', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue(new Error('boom'));
    renderDrawer();

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue on Stripe/ })).not.toBeInTheDocument();
  });

  it('error -> ready: clicking Retry re-probes the session; success transitions to ready', async () => {
    hoisted.sessionMutateAsync
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ client_secret: 'sec_retry' });
    const user = userEvent.setup();
    renderDrawer();

    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('connect-account-onboarding')).toBeInTheDocument();
  });

  it('error -> error (2nd failure): Retry failing again reveals the "Continue on Stripe" hosted-link fallback', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('button', { name: /Continue on Stripe/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' })); // 2nd failure

    expect(await screen.findByRole('button', { name: /Continue on Stripe/ })).toBeInTheDocument();
  });

  it('error (3rd+ failure): the hosted-link fallback stays visible, it does not require exactly 2', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByRole('button', { name: 'Retry' });
    await user.click(screen.getByRole('button', { name: 'Retry' })); // 2nd failure
    await screen.findByRole('button', { name: /Continue on Stripe/ });
    await user.click(screen.getByRole('button', { name: 'Retry' })); // 3rd failure

    expect(await screen.findByRole('button', { name: /Continue on Stripe/ })).toBeInTheDocument();
  });

  it('error fallback: clicking "Continue on Stripe" requests a hosted Account Link and redirects the browser', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue(new Error('boom'));
    hoisted.accountLinkMutateAsync.mockResolvedValue({ url: 'https://connect.stripe.com/setup/e/acct_1/xyz' });
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByRole('button', { name: 'Retry' });
    await user.click(screen.getByRole('button', { name: 'Retry' })); // 2nd failure
    await user.click(await screen.findByRole('button', { name: /Continue on Stripe/ }));

    await waitFor(() => expect(hoisted.accountLinkMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(window.location.href).toBe('https://connect.stripe.com/setup/e/acct_1/xyz')
    );
  });

  it('error fallback: an Account Link failure shows feedback instead of silently doing nothing', async () => {
    // This is the last-resort escape hatch after 2+ failures — if it fails silently, the
    // user is stuck with zero signal and no way forward. useStripeAccountLink (Task 2.2)
    // has no onError of its own, so the drawer must surface this itself, the same way
    // onAcceptTerms already does for useAcceptPaymentsTerms.
    hoisted.sessionMutateAsync.mockRejectedValue(new Error('boom'));
    hoisted.accountLinkMutateAsync.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderDrawer();

    await screen.findByRole('button', { name: 'Retry' });
    await user.click(screen.getByRole('button', { name: 'Retry' })); // 2nd failure
    await user.click(await screen.findByRole('button', { name: /Continue on Stripe/ }));

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalled());
    expect(hoisted.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    // No navigation happened, and the fallback is still there to retry — not a dead end.
    expect(window.location.href).toBe('');
    expect(screen.getByRole('button', { name: /Continue on Stripe/ })).toBeInTheDocument();
  });

  it('ready: fetchClientSecret (the config wired into loadConnectAndInitialize) resolves to the bare client_secret string, not the wrapper object', async () => {
    // This is the one seam that talks to the real Stripe SDK config — every other test
    // mocks loadConnectAndInitialize as a static return, so nothing else in this file
    // actually invokes the fetchClientSecret callback it was given. Do that here directly:
    // a wrong destructure key or returning the whole { client_secret } object instead of
    // the bare string would break the real embedded flow in production without failing
    // any other test.
    hoisted.sessionMutateAsync.mockResolvedValue({ client_secret: 'sec_abc123' });
    renderDrawer();

    await screen.findByTestId('connect-account-onboarding');
    expect(hoisted.loadConnectAndInitialize).toHaveBeenCalledTimes(1);

    const config = hoisted.loadConnectAndInitialize.mock.calls[0][0] as {
      fetchClientSecret: () => Promise<string>;
    };
    await expect(config.fetchClientSecret()).resolves.toBe('sec_abc123');
    // fetchClientSecret always re-POSTs (Connect.js calls it again on session expiry) —
    // confirm invoking it actually hit the session mutation again, not a cached value.
    expect(hoisted.sessionMutateAsync).toHaveBeenCalledTimes(2);
  });

  it('ready: onExit from the embedded component closes the drawer and shows the completion toast', async () => {
    hoisted.sessionMutateAsync.mockResolvedValue({ client_secret: 'sec_123' });
    const user = userEvent.setup();
    const { onOpenChange } = renderDrawer();

    await user.click(await screen.findByRole('button', { name: 'Simulate embed exit' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "You're set — send this invoice with a Pay button now." })
    );
  });

  it('never renders a card, bank, or SSN input itself — the only <input> across any phase is the terms checkbox', async () => {
    hoisted.sessionMutateAsync.mockRejectedValue({
      response: { data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' } },
    });
    renderDrawer();
    await screen.findByRole('checkbox');

    // SheetContent is portaled to document.body — query there, not RTL's `container`,
    // or this would trivially pass no matter what the drawer actually renders.
    const nonCheckboxInputs = Array.from(document.body.querySelectorAll('input')).filter(
      (el) => el.getAttribute('type') !== 'checkbox'
    );
    expect(nonCheckboxInputs).toHaveLength(0);
  });

  it('never renders a card, bank, or SSN input itself — ready phase (embed mocked) has zero inputs', async () => {
    hoisted.sessionMutateAsync.mockResolvedValue({ client_secret: 'sec_123' });
    renderDrawer();
    await screen.findByTestId('connect-account-onboarding');

    expect(document.body.querySelectorAll('input')).toHaveLength(0);
  });

  it('closed: renders nothing (Sheet content unmounted) and makes no account-session probe', () => {
    renderDrawer(false);

    expect(screen.queryByText('ServWave Payments')).not.toBeInTheDocument();
    expect(hoisted.sessionMutateAsync).not.toHaveBeenCalled();
  });
});
