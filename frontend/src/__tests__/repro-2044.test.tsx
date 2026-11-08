/**
 * #2044 — Ran's decision: zero accepted org payment methods + "Require deposit" ON must be a
 * WARNING, never a block, in BOTH dialogs.
 *
 * Today both SendEstimateDialog and MarkSentDialog gate their primary button on
 * `enabledMethods.size > 0` when a deposit is required (SendEstimateDialog.tsx:205,475;
 * MarkSentDialog.tsx:133,281), so with `accepted_payment_methods: []` the "No payment methods
 * accepted..." warning renders AND the primary button is DISABLED — the opposite of the ruling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

vi.mock('@/components/payments/StripePaymentsBanner', () => ({
  StripePaymentsBanner: () => null,
}));

const TOTAL = 106.63;

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({
    data: {
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      accepted_payment_methods: [], // zero accepted methods
    },
  });
});

describe('#2044 — zero payment methods warns instead of blocking', () => {
  it('(a) MarkSentDialog: warning shown AND "Mark as Sent" stays enabled', () => {
    renderWithProviders(
      <MarkSentDialog
        open
        onOpenChange={() => {}}
        estimateId="est-1"
        estimateNumber="J00229-2"
        totalAmount={TOTAL}
        onSuccess={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');

    expect(
      within(dialog).getByText(
        /No payment methods accepted by your organization\. Update them in Organization Settings\./,
      ),
    ).toBeInTheDocument();

    // Fails today: the button is disabled (canSubmit = (!depositRequired || enabledMethods.size >
    // 0) && depositValid — MarkSentDialog.tsx:133 — evaluates false with an empty accepted list).
    expect(within(dialog).getByRole('button', { name: /mark as sent/i })).toBeEnabled();
  });

  it('(b) SendEstimateDialog: warning shown AND "Send" stays enabled with a valid recipient', () => {
    renderWithProviders(
      <SendEstimateDialog
        open
        onOpenChange={() => {}}
        estimateId="est-1"
        estimateNumber="J00229-2"
        totalAmount={TOTAL}
        customerEmail="customer@example.com"
        alreadySent={false}
        onSuccess={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');

    expect(
      within(dialog).getByText(
        /No payment methods accepted by your organization\. Update them in Organization Settings\./,
      ),
    ).toBeInTheDocument();

    // Fails today: the button is disabled (canSend = (!depositRequired || enabledMethods.size >
    // 0) && recipientValid && depositValid — SendEstimateDialog.tsx:205 — evaluates false with an
    // empty accepted list, even though recipientValid is true).
    expect(within(dialog).getByRole('button', { name: /send j00229-2/i })).toBeEnabled();
  });
});
