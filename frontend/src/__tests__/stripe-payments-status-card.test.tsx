// Payments Phase 2, Task 2.3 — 8-state status card (spec §6.4 truth table + §6.8 copy).
// `deriveStripeState` is a pure function: each of the 8 rows gets its own test using the
// exact input shape named in the task brief's Step 1, plus an aggregate test proving the
// 8 canonical inputs are pairwise mutually exclusive (no shape maps to two states).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import {
  deriveStripeState,
  StripePaymentsStatusCard,
} from '@/components/payments/StripePaymentsStatusCard';
import { type StripeStatus } from '@/lib/api/organization';

const BASE_STATUS: StripeStatus = {
  stripe_account_id: null,
  stripe_charges_enabled: false,
  stripe_payouts_enabled: false,
  stripe_details_submitted: false,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  platform_fee_bps: 50,
  collected_awaiting_payout: 0,
};

describe('deriveStripeState (§6.4 truth table)', () => {
  it('state 1 — not set up (no account id)', () => {
    expect(deriveStripeState({ ...BASE_STATUS })).toBe(1);
  });

  it('state 2 — setup started (id set, details_submitted:false)', () => {
    expect(deriveStripeState({ ...BASE_STATUS, stripe_account_id: 'acct_1' })).toBe(2);
  });

  it('state 3 — submitted, under review (details_submitted:true, charges:false, no disabled_reason)', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
      })
    ).toBe(3);
  });

  it('state 4 — charges live, bank pending (charges:true, payouts:false)', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
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
        stripe_account_id: 'acct_1',
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
        stripe_account_id: 'acct_1',
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
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
        stripe_disabled_reason: 'requirements.past_due',
      })
    ).toBe(7);
  });

  it('state 8a — rejected.* disabled_reason', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_disabled_reason: 'rejected.fraud',
      })
    ).toBe(8);
  });

  it('state 8b — deauthorized disabled_reason', () => {
    expect(
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_disabled_reason: 'deauthorized',
      })
    ).toBe(8);
  });

  it('all 8 canonical inputs are pairwise mutually exclusive', () => {
    const results = [
      deriveStripeState({ ...BASE_STATUS }),
      deriveStripeState({ ...BASE_STATUS, stripe_account_id: 'acct_1' }),
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
      }),
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
      }),
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
      }),
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
        stripe_requirements_due: ['individual.id_number'],
      }),
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
        stripe_details_submitted: true,
        stripe_disabled_reason: 'requirements.past_due',
      }),
      deriveStripeState({
        ...BASE_STATUS,
        stripe_account_id: 'acct_1',
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
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useStripeStatus: () => ({ data: hoisted.status, isLoading: hoisted.isLoading }),
    useConnectStripe: () => ({ mutateAsync: hoisted.connectMutateAsync, isPending: false }),
  };
});

beforeEach(() => {
  hoisted.status = { ...BASE_STATUS };
  hoisted.isLoading = false;
  hoisted.connectMutateAsync = vi.fn().mockResolvedValue({ stripe_account_id: 'acct_new' });
  localStorage.clear();
});

describe('StripePaymentsStatusCard', () => {
  it('state 5 — renders "ServWave Payments active" with a success-tinted badge', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      stripe_account_id: 'acct_1',
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    };
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    expect(await screen.findByText(/ServWave Payments active/)).toBeInTheDocument();
    // The prior copy only confirmed payouts - it never told a contractor whether
    // customers can actually pay by card, which is what this state is really about.
    expect(screen.getByText(/Customers can now pay your invoices by card/)).toBeInTheDocument();
    const badge = screen.getByText('Active');
    expect(badge.className).toMatch(/text-success/);
  });

  it('state 7 - paused message is generic and never leaks the raw Stripe disabled_reason', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      stripe_account_id: 'acct_1',
      stripe_details_submitted: true,
      stripe_charges_enabled: false,
      stripe_disabled_reason: 'requirements.past_due',
    };
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    expect(await screen.findByText(/Card payments are paused\. Stripe needs a bit more information/)).toBeInTheDocument();
    // The raw machine code must not appear anywhere in the rendered card.
    expect(screen.queryByText(/requirements\.past_due/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix now' })).toBeInTheDocument();
  });

  it('state 1 — renders the "Set up payments" CTA', async () => {
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Set up payments' })).toBeInTheDocument();
  });

  // Fee disclosure is decision-time only: shown in the not-yet-connected states (1-2), where
  // it informs the owner's choice to set up payments, and hidden once active. It's already
  // disclosed again at onboarding consent (§6.2) and on every collected payment (§7.3), so a
  // permanent settings-page restatement is redundant noise.
  it('state 1 — shows the platform-fee disclosure (not yet connected)', async () => {
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    expect(await screen.findByText(/ServWave platform fee:/i)).toBeInTheDocument();
  });

  it('state 5 — hides the platform-fee disclosure once ServWave Payments is active', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      stripe_account_id: 'acct_1',
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    };
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    await screen.findByText(/ServWave Payments active/);
    expect(screen.queryByText(/ServWave platform fee:/i)).not.toBeInTheDocument();
  });

  it('state 1 CTA connects first, then calls onOpenDrawer (no drawer import — callback only)', async () => {
    const onOpenDrawer = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={onOpenDrawer} />);

    await user.click(await screen.findByRole('button', { name: 'Set up payments' }));

    await waitFor(() => expect(hoisted.connectMutateAsync).toHaveBeenCalled());
    await waitFor(() => expect(onOpenDrawer).toHaveBeenCalled());
  });

  it('state 4 — shows the deferred-bank nudge with the collected amount, dismissible via Snooze', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      stripe_account_id: 'acct_1',
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: false,
      collected_awaiting_payout: 1234.5,
    };
    const user = userEvent.setup();
    renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    expect(await screen.findByText(/\$1,234\.50/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(screen.queryByText(/\$1,234\.50/)).not.toBeInTheDocument();
  });

  it('renders a loading skeleton (not the title) while the status query is pending', () => {
    hoisted.isLoading = true;
    hoisted.status = undefined as unknown as StripeStatus;
    const { container } = renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);

    expect(screen.queryByText(/ServWave Payments/)).not.toBeInTheDocument();
    // Positively assert the Skeleton placeholder itself renders — without this, a
    // regression that dropped <Skeleton> entirely (rendering an empty Card) would
    // still pass on the negative assertion above alone.
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('never renders a card/bank/SSN input field itself', async () => {
    hoisted.status = {
      ...BASE_STATUS,
      stripe_account_id: 'acct_1',
      stripe_details_submitted: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
    };
    const { container } = renderWithProviders(<StripePaymentsStatusCard onOpenDrawer={vi.fn()} />);
    await screen.findByText(/ServWave Payments active/);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });
});
