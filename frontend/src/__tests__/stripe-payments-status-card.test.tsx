// Payments Phase 2, Task 2.3 — 8-state status card (spec §6.4 truth table + §6.8 copy), now the body of card 1 on
// Settings > ServWave Payments (V7 spec 5.3).
// `deriveStripeState` is a pure function: each of the 8 rows gets its own test using the
// exact input shape named in the task brief's Step 1, plus an aggregate test proving the
// 8 canonical inputs are pairwise mutually exclusive (no shape maps to two states).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import {
  deriveStripeState,
  PaymentsStatusBody,
} from '@/components/payments/PaymentsStatusCard';
import { type StripeStatus } from '@/lib/api/shared/organization';

const BASE_STATUS: StripeStatus = {
  connected: false,
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  collected_awaiting_payout: 0,
};

describe('deriveStripeState (§6.4 truth table)', () => {
  it('state 1 — not set up (no account id)', () => {
    expect(deriveStripeState({ ...BASE_STATUS })).toBe(1);
  });

  it('state 2 — setup started (id set, details_submitted:false)', () => {
    expect(deriveStripeState({ ...BASE_STATUS, connected: true })).toBe(2);
  });

  it('state 3 — submitted, under review (details_submitted:true, charges:false, no disabled_reason)', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
      })
    ).toBe(3);
  });

  it('state 4 — charges live, bank pending (charges:true, payouts:false)', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        collected_awaiting_payout: 1200,
      })
    ).toBe(4);
  });

  it('state 5 — fully active (charges+payouts true, requirements_due:[])', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
      })
    ).toBe(5);
  });

  it('state 6 — action needed (requirements_due non-empty) even though charges+payouts are true', () => {
    // Same shape as the state-5 case above, plus a non-empty requirements_due — proves
    // requirements_due takes priority over "fully active" per §6.4 row 6 ("charges either way").
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
        stripe_requirements_due: ['individual.id_number'],
      })
    ).toBe(6);
  });

  it('state 7 — paused/restricted (disabled_reason set, charges:false, not rejected/deauthorized)', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_disabled_reason: 'requirements.past_due',
      })
    ).toBe(7);
  });

  // Payments go-live slice 34: the processor marks every requirement past due the moment an account is
  // created (disabled_reason = requirements.past_due), before the owner has entered anything. That is a setup
  // that has not been finished, not an account that was paused.
  it('state 2 - a brand-new account reads as setup in progress, not paused, though the processor already sets a disabled_reason', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: false,
        stripe_disabled_reason: 'requirements.past_due',
        stripe_requirements_due: ['individual.first_name'],
      })
    ).toBe(2);
  });

  it('state 8a — rejected.* disabled_reason', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_disabled_reason: 'rejected.fraud',
      })
    ).toBe(8);
  });

  it('state 8b — deauthorized disabled_reason', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_disabled_reason: 'deauthorized',
      })
    ).toBe(8);
  });

  it('all 8 canonical inputs are pairwise mutually exclusive', () => {
    const results = [
      deriveStripeState({ ...BASE_STATUS }),
      deriveStripeState({ ...BASE_STATUS, connected: true }),
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
      }),
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
      }),
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
      }),
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
        stripe_requirements_due: ['individual.id_number'],
      }),
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_details_submitted: true,
        stripe_disabled_reason: 'requirements.past_due',
      }),
      deriveStripeState({
        ...BASE_STATUS,
        connected: true,
        stripe_disabled_reason: 'rejected.fraud',
      }),
    ];
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(results).size).toBe(8);
  });
});

// ─── Component render tests ──────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  status: undefined as unknown as StripeStatus,
  isLoading: false,
  connectMutateAsync: vi.fn(),
  org: undefined as unknown as { accepted_payment_methods: string[] } | undefined,
}));

vi.mock('@/lib/api/shared/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/shared/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: hoisted.org }),
    useStripeStatus: () => ({ data: hoisted.status, isLoading: hoisted.isLoading }),
    useConnectStripe: () => ({ mutateAsync: hoisted.connectMutateAsync, isPending: false }),
  };
});

/** The card body, fed from the same fixtures the page hands it. */
function PaymentsStatusCard({ onOpenSetup }: { onOpenSetup?: () => void }) {
  return (
    <PaymentsStatusBody
      status={hoisted.status}
      acceptedMethods={hoisted.org?.accepted_payment_methods}
      onGoToPayout={onOpenSetup}
    />
  );
}

beforeEach(() => {
  hoisted.status = { ...BASE_STATUS };
  hoisted.isLoading = false;
  hoisted.org = undefined;
  hoisted.connectMutateAsync = vi.fn().mockResolvedValue({ connected: true });
  localStorage.clear();
});

describe('PaymentsStatusCard', () => {
  it('state 5 — renders "ServWave Payments active" with a success-tinted badge', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    };
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByText(/ServWave Payments active/)).toBeInTheDocument();
    // The prior copy only confirmed payouts - it never told a contractor whether
    // customers can actually pay by card, which is what this state is really about.
    expect(screen.getByText(/Customers can now pay your invoices by card/)).toBeInTheDocument();
    const badge = screen.getByText('Active');
    expect(badge.className).toMatch(/text-success/);
  });

  // Payments go-live slice 06, fix round 1. State 3 is also where a fail-closed refresh lands:
  // the account could not be read, charges go false and details_submitted stays as stored. So
  // the copy must not name the processor, and it must not promise "usually takes minutes" to an
  // account that may never turn on. It points the owner at ServWave support instead.
  it('state 3 - says card payments are off until verified, names no vendor, promises no timing, points at ServWave support', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: false,
    };
    const { container } = renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.getByText(/Card payments turn on once your details are verified/)).toBeInTheDocument();
    expect(container).toHaveTextContent(/contact ServWave support/);
    expect(container.textContent).not.toMatch(/stripe/i);
    expect(container.textContent).not.toMatch(/minutes/i);
  });

  it('state 7 - paused message is generic and never leaks the raw Stripe disabled_reason', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: false,
      stripe_disabled_reason: 'requirements.past_due',
    };
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByText(/Card payments are paused\. A bit more information is needed/)).toBeInTheDocument();
    // The raw machine code must not appear anywhere in the rendered card.
    expect(screen.queryByText(/requirements\.past_due/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix now' })).toBeInTheDocument();
  });

  it('state 1 — renders the "Set up payments" CTA', async () => {
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Set up payments' })).toBeInTheDocument();
  });

  // Fee disclosure is decision-time only: shown in the not-yet-connected states (1-2), where
  // it informs the owner's choice to set up payments, and hidden once active. It's already
  // disclosed again at onboarding consent (§6.2), so a permanent settings-page restatement is
  // redundant noise. Payments go-live slice 03 (D9/D12): it states the real model - customers pay
  // the invoice amount, processing rates are billed to the contractor, ServWave takes nothing.
  const DISCLOSURE =
    'Customers pay the invoice amount. Standard card and bank processing rates are billed to your account. ServWave charges no payment fee.';

  it('state 1 — shows the fee disclosure (not yet connected): no ServWave fee, rates billed to the contractor', async () => {
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
  });

  it('state 2 — shows the same fee disclosure while setup is in progress', async () => {
    hoisted.status = { ...BASE_STATUS, connected: true };
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByText(DISCLOSURE)).toBeInTheDocument();
  });

  it('state 5 — hides the fee disclosure once ServWave Payments is active', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    };
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    await screen.findByText(/ServWave Payments active/);
    expect(screen.queryByText(DISCLOSURE)).not.toBeInTheDocument();
  });

  // One canonical input per state (the §6.4 truth table above), state 4 with a collected amount
  // so its bank nudge renders too.
  const EVERY_STATE: Record<string, Partial<StripeStatus>> = {
    '1 not connected': {},
    '2 in progress': { connected: true },
    '3 under review': { connected: true, stripe_details_submitted: true },
    '4 bank pending': {
      connected: true, stripe_details_submitted: true, stripe_charges_enabled: true,
      collected_awaiting_payout: 120,
    },
    '5 active': {
      connected: true, stripe_details_submitted: true, stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    },
    '6 action needed': {
      connected: true, stripe_details_submitted: true, stripe_charges_enabled: true,
      stripe_payouts_enabled: true, stripe_requirements_due: ['external_account'],
    },
    '7 paused': {
      connected: true, stripe_details_submitted: true, stripe_disabled_reason: 'requirements.past_due',
    },
    '8 unavailable': { connected: true, stripe_disabled_reason: 'rejected.fraud' },
  };

  it.each(Object.entries(EVERY_STATE))(
    'state %s — no platform-fee promise and no processor name',
    async (_name, overrides) => {
      hoisted.status = { ...BASE_STATUS, ...overrides };
      const { container } = renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);
      await screen.findAllByText(/./);

      const text = container.textContent!;
      expect(text).not.toMatch(/0\.5%/);
      expect(text).not.toMatch(/2%/);
      expect(text).not.toMatch(/platform fee/i);
      expect(text).not.toMatch(/stripe/i);
      expect(text).not.toMatch(/NaN/);
      // The retired "your customer always pays the invoice amount" + "deducted from your
      // proceeds" pairing is gone.
      expect(text).not.toMatch(/deducted/i);
    },
  );

  // Payments go-live slice 34: opening an account now waits for the terms, which the payout account page
  // collects. So the card only points there; it never starts the account itself.
  it('state 1 CTA hands over to the payout account page and does not open an account itself', async () => {
    const onOpenSetup = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PaymentsStatusCard onOpenSetup={onOpenSetup} />);

    await user.click(await screen.findByRole('button', { name: 'Set up payments' }));

    await waitFor(() => expect(onOpenSetup).toHaveBeenCalled());
    expect(hoisted.connectMutateAsync).not.toHaveBeenCalled();
  });

  it('shows no setup button to someone who may not manage the payout account (no handler given)', async () => {
    hoisted.status = { ...BASE_STATUS, connected: true, stripe_requirements_due: ['x'], stripe_details_submitted: true, stripe_charges_enabled: true };
    renderWithProviders(<PaymentsStatusCard />);

    expect(await screen.findByText('Action needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fix now' })).not.toBeInTheDocument();
  });

  it('state 4 — shows the deferred-bank nudge with the collected amount, dismissible via Snooze', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: false,
      collected_awaiting_payout: 1234.5,
    };
    const user = userEvent.setup();
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);

    expect(await screen.findByText(/\$1,234\.50/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze for 7 days' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Snooze for 7 days' }));
    expect(screen.queryByText(/\$1,234\.50/)).not.toBeInTheDocument();
    // The snooze is kept for 7 days under the existing key, so a remount stays hidden.
    const until = Number(localStorage.getItem('servwave.payments.bank-nudge.snoozed-until'));
    expect(until).toBeGreaterThan(Date.now() + 6.9 * 864e5);
    expect(until).toBeLessThanOrEqual(Date.now() + 7 * 864e5);
  });

  it('never renders a card/bank/SSN input field itself', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      connected: true,
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    };
    const { container } = renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);
    await screen.findByText(/ServWave Payments active/);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });
});

// Slice 34b - the card names the methods that are on.
const ACTIVE: StripeStatus = {
  ...BASE_STATUS,
  connected: true,
  stripe_details_submitted: true,
  stripe_charges_enabled: true,
  stripe_payouts_enabled: true,
};

describe('PaymentsStatusBody - methods (slice 34b)', () => {
  it.each([
    [['CARD'], 'Customers can now pay your invoices by card.'],
    [['ACH'], 'Customers can now pay your invoices by bank transfer.'],
    [['CARD', 'ACH'], 'Customers can now pay your invoices by card or bank transfer.'],
  ])('names every method that is on: %j', async (methods, sentence) => {
    hoisted.status = ACTIVE;
    hoisted.org = { accepted_payment_methods: ['CASH', ...methods] };
    const { container } = renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);
    expect(container.textContent).toContain(sentence);
  });
});

describe('PaymentsStatusBody - the call to action per state (V7 spec 5.3)', () => {
  it.each([
    ['1 not connected', {}, 'Set up payments'],
    ['2 in progress', { connected: true }, 'Resume setup'],
    ['6 action needed', { connected: true, stripe_details_submitted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_requirements_due: ['x'] }, 'Fix now'],
    ['7 paused', { connected: true, stripe_details_submitted: true, stripe_disabled_reason: 'requirements.past_due' }, 'Fix now'],
  ])('state %s has the button %s', async (_n, overrides, label) => {
    hoisted.status = { ...BASE_STATUS, ...overrides };
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);
    expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
  });

  it.each([
    ['3 under review', { connected: true, stripe_details_submitted: true }],
    ['4 bank pending', { connected: true, stripe_details_submitted: true, stripe_charges_enabled: true }],
    ['5 active', ACTIVE],
    ['8 unavailable', { connected: true, stripe_disabled_reason: 'rejected.fraud' }],
  ])('state %s has no main button', async (_n, overrides) => {
    hoisted.status = { ...BASE_STATUS, ...overrides };
    renderWithProviders(<PaymentsStatusCard onOpenSetup={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /set up payments|resume setup|fix now/i })).not.toBeInTheDocument();
  });

  it('uses the curly apostrophe in the state 4 message', async () => {
    hoisted.status = { ...BASE_STATUS, connected: true, stripe_details_submitted: true, stripe_charges_enabled: true };
    renderWithProviders(<PaymentsStatusCard />);
    expect(await screen.findByText('You’re set - send this invoice with a Pay button now.')).toBeInTheDocument();
  });
});
