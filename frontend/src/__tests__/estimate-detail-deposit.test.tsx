/**
 * Tests for #185 — the estimate workspace's deposit surface, derived from
 * invoices[kind=DEPOSIT] + send_config (legacy est.deposit was removed in the
 * entity-model redesign) — and #238 — its Waive-deposit button gates on CASL
 * ability, not the auth-store role.
 *
 * Re-pointed 2026-07-20 (D5, prototype→ServWave port plan §14.6): this suite
 * originally exercised `EstimateDetailPage.tsx`, which was dead and unrouted
 * (App.tsx never routed to it — only `/estimates/:id` → `EstimateWorkspacePage`).
 * That page has been deleted; this suite now exercises the real live surface.
 *
 * Re-pointed AGAIN 2026-08-27, for the same reason a second time: `/estimates/:id`
 * moved to the v2 page (`pages/v2/estimates/`) on 2026-08-13 and this suite kept
 * importing the v1 copy at `pages/`, so "the real live surface" above quietly
 * stopped being true. The v1 copy is now deleted and this suite imports the v2
 * page. If a third fork ever appears, the import here is the thing to check first.
 *
 * STRUCTURAL GAPS vs the original #185/#238 intent (documented, not fixed here):
 *   - There is no more "Deposit" tab to click. Deposit-due info now lives inline
 *     in the right-rail <EstimateReceiptCard> ("Deposit due now" box); Waive/
 *     Refund live in their own "Deposit Actions" card beside it. Both render
 *     directly once the page loads — no tab-click step below.
 *   - The deposit-due box no longer hides when `send_config.deposit_required`
 *     is false. `EstimateReceiptCard` keys visibility off `Boolean(estimate.
 *     send_config)` alone (i.e. "was this estimate ever sent") — verified in
 *     `EstimateReceiptCard.tsx` — not the `deposit_required` flag. So a
 *     sent-without-deposit estimate now shows a "Deposit due now — 0% / $0.00"
 *     box instead of nothing. Real behavior difference, asserted as-is below.
 *   - The old "Receipt Info" panel (payment date / reference number / Stripe
 *     payment id) for a PAID deposit has no live equivalent on this page — there
 *     is nowhere on EstimateWorkspacePage that surfaces a recorded deposit
 *     payment's reference number. That assertion is dropped, not faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

// Action buttons (Waive Deposit, …) are gated on CASL ability rather than the
// auth-store role (see #238). The deposit-surface tests exercise the Waive
// button, so render with a full-access (admin superuser) ability.
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-185-test-id' }),
  };
});

// Heavy sub-surfaces with no bearing on the deposit box / Waive button — stubbed
// out. <EstimateReceiptCard> is deliberately left REAL: it's the thing #185
// guards. <PdfPreviewDialog>/other dialogs are stubbed: this suite only checks
// trigger-button gating (#238's whole point), not dialog internals.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({
  EstimateTabs: () => null,
}));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({
  SignatureCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({
  NotesCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({
  HistoryPanel: () => null,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: () => null,
}));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const mockApi = vi.mocked(api);

// Minimal shared estimate fields
const BASE_ESTIMATE = {
  id: 'est-185-test-id',
  lead_id: 'lead-1',
  estimate_number: 'E00185',
  name: null,
  status: 'SENT',
  sent_at: '2026-06-01T00:00:00.000Z',
  approved_at: null,
  declined_at: null,
  cancelled_at: null,
  scope_notes: null,
  tax_rate: '0.0625',
  subtotal: '10000.00',
  tax_amount: '625.00',
  total_amount: '10625.00',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_at: null,
  public_token: 'tok-185',
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  lead: {
    id: 'lead-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-1',
      first_name: 'Alice',
      last_name: 'Test',
      company_name: null,
      email: 'alice@test.com',
      phone: '5550001234',
      billing_address_line1: null,
      billing_city: null,
      billing_state: null,
      billing_zip: null,
    },
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
};

// Fixture A: SENT estimate, deposit required, kind=DEPOSIT invoice SENT
const FIXTURE_A = {
  ...BASE_ESTIMATE,
  send_config: {
    id: 'sc-1',
    deposit_required: true,
    deposit_percentage: '30.00',
    deposit_amount: '3187.50',
    payment_methods: [],
    message_body: null,
  },
  invoices: [
    {
      id: 'di-1',
      kind: 'DEPOSIT',
      status: 'SENT',
      total_amount: '3187.50',
      amount_due: '3187.50',
      total_refunded: '0.00',
      refunded_at: null,
      payments: [],
    },
  ],
};

// Fixture B: sent, but deposit NOT required (send_config still exists — see the
// GAP note above: the deposit box renders anyway, at 0%/$0.00).
const FIXTURE_B = {
  ...BASE_ESTIMATE,
  send_config: {
    id: 'sc-2',
    deposit_required: false,
    deposit_percentage: null,
    deposit_amount: null,
    payment_methods: [],
    message_body: null,
  },
  invoices: [],
};

// Fixture C: deposit invoice PAID with a check payment
const FIXTURE_C = {
  ...BASE_ESTIMATE,
  send_config: {
    id: 'sc-3',
    deposit_required: true,
    deposit_percentage: '30.00',
    deposit_amount: '3187.50',
    payment_methods: [],
    message_body: null,
  },
  invoices: [
    {
      id: 'di-2',
      kind: 'DEPOSIT',
      status: 'PAID',
      total_amount: '3187.50',
      amount_due: '0.00',
      total_refunded: '0.00',
      refunded_at: null,
      payments: [
        {
          id: 'pay-1',
          amount: '3187.50',
          method: 'CHECK',
          paid_at: '2026-06-01T10:00:00.000Z',
          stripe_payment_intent_id: null,
          reference_number: 'CHK-9',
        },
      ],
    },
  ],
};

function setupMocks(fixture: typeof FIXTURE_A | typeof FIXTURE_B | typeof FIXTURE_C) {
  mockApi.get.mockImplementation(async (url: string) => {
    // EstimateReceiptCard (kept real — it's the surface under test) fetches
    // jurisdiction options for its tax-rate select.
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate: fixture } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage — deposit surface (#185)', () => {
  it('shows the deposit-due percent and amount on the receipt card when a deposit is configured', async () => {
    setupMocks(FIXTURE_A);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('30%')).toBeInTheDocument();
    });
    expect(screen.getByText('$3,187.50')).toBeInTheDocument();
  });

  it('shows the Waive button for ADMIN when the deposit invoice is SENT', async () => {
    setupMocks(FIXTURE_A);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /waive deposit/i })).toBeInTheDocument();
    });
  });

  it('renders without error when no deposit was ever configured (GAP: the deposit-due box still shows at 0%/$0.00 rather than hiding — see file header)', async () => {
    setupMocks(FIXTURE_B);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => {
      // "Estimate Info" card's Number row renders the bare estimate_number — R7's copy-id
      // affordance next to the header title renders the same bare number a second time, so this
      // now legitimately matches twice; getAllByText tolerates that instead of the strict
      // single-match getByText.
      expect(screen.getAllByText('E00185').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('0%')).toBeInTheDocument();

    // No deposit invoice on this fixture, so neither action button appears.
    expect(screen.queryByRole('button', { name: /waive deposit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /refund deposit/i })).toBeNull();
  });

  it('hides the Waive button once the deposit invoice is PAID', async () => {
    setupMocks(FIXTURE_C);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('30%')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /waive deposit/i })).toBeNull();
  });
});

// #238 — action buttons are gated on CASL ability, NOT the auth-store role.
// The auth store is mocked to ADMIN globally (setup.ts); these tests prove the
// button follows the *ability* passed in, independent of that role.
describe('EstimateWorkspacePage — Waive Deposit gates on ability, not role (#238)', () => {
  it('shows Waive Deposit when ability grants waive_deposit Estimate', async () => {
    setupMocks(FIXTURE_A);
    const ability = buildAbility([
      { action: 'read', subject: 'Estimate' },
      { action: 'waive_deposit', subject: 'Estimate' },
    ]);
    renderWithProviders(<EstimateWorkspacePage />, { ability });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /waive deposit/i })).toBeInTheDocument();
    });
  });

  it('hides Waive Deposit when ability lacks waive_deposit Estimate (even though the auth-store role is ADMIN)', async () => {
    setupMocks(FIXTURE_A);
    // read-only ability: can view the estimate, but no waive grant.
    const ability = buildAbility([{ action: 'read', subject: 'Estimate' }]);
    renderWithProviders(<EstimateWorkspacePage />, { ability });

    // Anchor on the deposit percent (FIXTURE_A = 30%) to confirm the receipt
    // card rendered before asserting the button's absence.
    await waitFor(() => {
      expect(screen.getByText('30%')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /waive deposit/i })).toBeNull();
  });
});

// Editable record IDs (2026-08-19 plan) - RecordNumberEditor wired into the "Estimate Info"
// card's Number row, gated on ability.can('renumber', 'Estimate').
describe('EstimateWorkspacePage - record number editor gating', () => {
  it('shows the edit affordance for a user with the renumber grant', async () => {
    setupMocks(FIXTURE_A);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
  });

  it('hides the edit affordance for a user without the renumber grant', async () => {
    setupMocks(FIXTURE_A);
    const ability = buildAbility([{ action: 'read', subject: 'Estimate' }]);
    renderWithProviders(<EstimateWorkspacePage />, { ability });

    await screen.findAllByText('E00185');
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
  });
});
