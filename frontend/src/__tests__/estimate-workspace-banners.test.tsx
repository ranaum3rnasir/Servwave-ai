import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: __route.id }),
  };
});
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

const __route = vi.hoisted(() => ({ id: '' }));

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('estimate-detail-deposit', () => {
  // The router mock reads the id this block's file used to fix.
  beforeEach(() => { __route.id = 'est-185-test-id'; });
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

  // Action buttons (Waive Deposit, …) are gated on CASL ability rather than the
  // auth-store role (see #238). The deposit-surface tests exercise the Waive
  // button, so render with a full-access (admin superuser) ability.

  // Heavy sub-surfaces with no bearing on the deposit box / Waive button — stubbed
  // out. <EstimateReceiptCard> is deliberately left REAL: it's the thing #185
  // guards. <PdfPreviewDialog>/other dialogs are stubbed: this suite only checks
  // trigger-button gating (#238's whole point), not dialog internals.

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
            paid_through_processor: false,
            reference_number: 'CHK-9',
          },
        ],
      },
    ],
  };

  function setupMocks(fixture: typeof FIXTURE_A | typeof FIXTURE_B | typeof FIXTURE_C) {
    serveEstimateWorkspace({ estimate: fixture });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('EstimateWorkspacePage — deposit surface (#185)', () => {
    it('shows the deposit-due percent and amount on the receipt card when a deposit is configured', async () => {
      setupMocks(FIXTURE_A);
      renderEstimateWorkspace();

      await waitFor(() => {
        expect(screen.getByText('30%')).toBeInTheDocument();
      });
      expect(screen.getByText('$3,187.50')).toBeInTheDocument();
    });

    it('shows the Waive button for ADMIN when the deposit invoice is SENT', async () => {
      setupMocks(FIXTURE_A);
      renderEstimateWorkspace();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /waive deposit/i })).toBeInTheDocument();
      });
    });

    it('renders without error when no deposit was ever configured (GAP: the deposit-due box still shows at 0%/$0.00 rather than hiding — see file header)', async () => {
      setupMocks(FIXTURE_B);
      renderEstimateWorkspace();

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
      renderEstimateWorkspace();

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
      renderEstimateWorkspace({ ability });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /waive deposit/i })).toBeInTheDocument();
      });
    });

    it('hides Waive Deposit when ability lacks waive_deposit Estimate (even though the auth-store role is ADMIN)', async () => {
      setupMocks(FIXTURE_A);
      // Can view the estimate and its prices (the deposit box is a price, P11), but holds no waive grant.
      const ability = buildAbility([
        { action: 'read', subject: 'Estimate' },
        { action: 'read', subject: 'Prices' },
      ]);
      renderEstimateWorkspace({ ability });

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
      renderEstimateWorkspace();

      expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
    });

    it('hides the edit affordance for a user without the renumber grant', async () => {
      setupMocks(FIXTURE_A);
      const ability = buildAbility([{ action: 'read', subject: 'Estimate' }]);
      renderEstimateWorkspace({ ability });

      await screen.findAllByText('E00185');
      expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
    });
  });
});

describe('estimate-workspace-decline-reason', () => {
  // The router mock reads the id this block's file used to fix.
  beforeEach(() => { __route.id = 'est-decline-reason'; });
  /**
   * SRVW-285 — the decline reason is READABLE, not just recorded.
   *
   * The slice originally shipped `lost_reason_note` write-only: the column was written by the
   * public decline, and nothing on any staff surface selected or rendered it. That defeats the
   * request it came from — a general manager asked for this so the business could LEARN why
   * customers decline, and an answer nobody can read without opening a database has not been
   * learned. So the rail row is part of the same slice as the write, and these are its tests.
   *
   * Four cases, and the last two are the ones worth having: the reason is deliberately OPTIONAL
   * for the customer (requiring it risks them abandoning the decline and going silent, which
   * loses the reason AND the status), so "reason without note", "note without reason" and
   * "neither" are all ordinary states the rail has to render honestly. A missing row must read as
   * "they did not tell us", never as an empty field.
   */

  // The same stub set the other workspace specs use — none of these sub-surfaces is under test.

  function declinedEstimate(over: Record<string, unknown> = {}) {
    return {
      id: 'est-decline-reason',
      lead_id: 'lead-decline-1',
      estimate_number: 'E00921',
      name: null,
      status: 'DECLINED',
      sent_at: '2026-09-01T00:00:00.000Z',
      approved_at: null,
      declined_at: '2026-09-05T00:00:00.000Z',
      lost_reason: null,
      lost_reason_note: null,
      cancelled_at: null,
      scope_notes: null,
      tax_rate: '0.0625',
      subtotal: '1000.00',
      tax_amount: '62.50',
      total_amount: '1062.50',
      discount_type: null,
      discount_value: null,
      discount_name: null,
      discount_amount: '0.00',
      signature_data: null,
      signature_at: null,
      public_token: 'tok-921',
      version: 1,
      modified_after_send: false,
      superseded_by_id: null,
      created_by: 'user-1',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-05T00:00:00.000Z',
      send_config: null,
      invoices: [],
      lead: {
        id: 'lead-decline-1',
        status: 'LOST',
        service_request: 'Kitchen cabinets',
        service_address_line1: '14 Test St',
        service_city: 'Boston',
        service_state: 'MA',
        service_zip: '02101',
        customer: {
          id: 'cust-921',
          first_name: 'Dana',
          last_name: 'Decline',
          company_name: null,
          email: 'dana@qa.servwave.test',
          phone: '5555550188',
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
      ...over,
    };
  }

  /**
   * The organisation's curated list (slice C). Note TIMING is switched OFF and the last row is one
   * the admin added - between them they are the two cases the rail has to label that the five
   * built-in labels cannot.
   */
  const ORG_REASONS = [
    { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true },
    { code: 'TIMING', label: 'Ready sooner than we can build', is_active: false, sort_order: 1, is_builtin: true },
    { code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', is_active: true, sort_order: 2, is_builtin: false },
  ];

  function setup(over: Record<string, unknown> = {}, reasons: unknown[] = []) {
    serveEstimateWorkspace({ estimate: declinedEstimate(over), routes: [
        { match: (url) => url.includes('/communications'), data: { items: [] } },
        { match: (url) => url.includes('/api/lost-reason-options'), data: { lost_reason_options: reasons } },
      ] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderAndSettle() {
    renderEstimateWorkspace();
    await waitFor(() => expect(screen.getAllByText('E00921').length).toBeGreaterThan(0));
  }

  describe('EstimateWorkspacePage — the customer’s decline reason is readable (SRVW-285)', () => {
    it('renders the reason and the comment when the customer gave both', async () => {
      setup({ lost_reason: 'COMPETITOR', lost_reason_note: 'Another shop came in three thousand under.' });
      await renderAndSettle();

      expect(screen.getByText('Reason')).toBeInTheDocument();
      // The LABEL, never the raw enum value — staff, the customer's own screen and the conversion
      // report have to read one wording for one loss.
      expect(screen.getByText('Went with a competitor')).toBeInTheDocument();
      expect(screen.queryByText('COMPETITOR')).toBeNull();

      expect(screen.getByText('Their comment')).toBeInTheDocument();
      expect(screen.getByText('Another shop came in three thousand under.')).toBeInTheDocument();
    });

    it('renders the reason alone when the customer skipped the comment', async () => {
      setup({ lost_reason: 'PRICE', lost_reason_note: null });
      await renderAndSettle();

      expect(screen.getByText('Price')).toBeInTheDocument();
      // No empty "Their comment" row — an absent answer is absent, not blank.
      expect(screen.queryByText('Their comment')).toBeNull();
    });

    it('renders the comment alone when the customer typed one but picked no reason', async () => {
      setup({ lost_reason: null, lost_reason_note: 'The designer was not the right fit for us.' });
      await renderAndSettle();

      expect(screen.getByText('Their comment')).toBeInTheDocument();
      expect(screen.getByText('The designer was not the right fit for us.')).toBeInTheDocument();
      expect(screen.queryByText('Reason')).toBeNull();
    });

    it('renders neither row when the customer declined without answering', async () => {
      setup();
      await renderAndSettle();

      // The decline itself still reads — losing the reason must never cost us the status.
      // `getAllByText`: "Declined" is both the status chip and the rail's date label.
      expect(screen.getAllByText('Declined').length).toBeGreaterThan(0);
      expect(screen.queryByText('Reason')).toBeNull();
      expect(screen.queryByText('Their comment')).toBeNull();
    });
  });

  /**
   * Slice C - the rail labels the ORGANISATION's reasons, not only the five built-in ones.
   *
   * Before this slice a code outside the five could not exist, so `LOST_REASON_LABELS[code] ?? code`
   * always hit the map. Now an admin can add one, and the fallback would render the stored code -
   * WENT_WITH_A_DESIGNER where the admin wrote "Went with a designer". These two cases are the
   * whole of what changed here, and the second is the one that is easy to get wrong.
   */
  describe('EstimateWorkspacePage - the rail reads the organisation\'s own words (slice C)', () => {
    it('labels a reason the admin added, rather than showing its stored code', async () => {
      setup({ lost_reason: 'WENT_WITH_A_DESIGNER' }, ORG_REASONS);
      await renderAndSettle();

      await waitFor(() => expect(screen.getByText('Went with a designer')).toBeInTheDocument());
      // The code is the storage detail; it must not be what a staff member reads.
      expect(screen.queryByText('WENT_WITH_A_DESIGNER')).toBeNull();
    });

    it('still labels a reason the admin has since switched OFF', async () => {
      // D4 is that a reason is deactivated and never deleted precisely so estimates declined under
      // it stay readable. A rail that filtered to the ACTIVE list would blank exactly the history
      // that rule exists to protect - and it would do so silently, months after the admin's click.
      // The renamed label is what proves the row was read rather than guessed: "Timing" is the
      // built-in wording, and this org's is not.
      setup({ lost_reason: 'TIMING' }, ORG_REASONS);
      await renderAndSettle();

      await waitFor(() => expect(screen.getByText('Ready sooner than we can build')).toBeInTheDocument());
      expect(screen.queryByText('TIMING')).toBeNull();
    });
  });
});
