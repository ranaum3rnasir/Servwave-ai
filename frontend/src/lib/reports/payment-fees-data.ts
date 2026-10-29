import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';

/**
 * Payment processing fees (Task 4.1, Phase 4 follow-on to §7.3) —
 * GET /api/reports/payment-fees.
 *
 * Live for demo and real orgs alike — this is a genuinely new real feature
 * (Phase 3's Stripe fee reconciliation), not a not-yet-backed mock-first
 * surface, so there is no fabricated equivalent to show a demo org (mirrors
 * inventory-usage-data.ts's reasoning: `useIsDemoOrg`'s mock-first behavior
 * is for surfaces that AREN'T backend-wired yet — this one is).
 */
export interface PaymentFeesPayload {
  from: string;
  to: string;
  /** Σ Payment.amount - invoice FACE value collected in the window (cost-reconciled rows
   *  only). The revenue basis: the service fee and the tip are outside it (D1/D10). */
  gross: number;
  /** Σ (face + service fee + tip) over the same rows - what those cards were actually
   *  charged, and the basis `net` is measured against. `charged - stripeFees -
   *  platformFees === net`. Equals `gross` when no payment carries a fee or tip.
   *  Do NOT substitute `serviceFees + tips` for `charged - gross`: those come from a
   *  wider population and are refund-prorated. */
  charged: number;
  /** Σ Payment.stripe_fee_amount - taken by Stripe out of `charged`, not out of `gross`. */
  stripeFees: number;
  /** Σ Payment.platform_fee_amount. */
  platformFees: number;
  /** Σ Payment.net_amount - cash landed, on the `charged` basis. May legitimately
   *  exceed `gross`: the customer funds the fee stack and the tip rides on top. */
  net: number;
  /** Number of succeeded, fee-reconciled CARD payments summed into gross/stripeFees/platformFees/net. */
  reconciledCount: number;
  /** Σ Payment.service_fee_amount, prorated by refunded share - collected from the
   *  customer, on top of Gross (D1). Independent of cost-side reconciliation. */
  serviceFees: number;
  /** Number of payments contributing to serviceFees. */
  serviceFeeCount: number;
  /** Σ Payment.tip_amount, prorated by refunded share - collected from the customer,
   *  kept in full by the org (D10). Independent of cost-side reconciliation. */
  tips: number;
  /** Number of payments contributing to tips. */
  tipCount: number;
}

export function usePaymentFeesReport(range: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ['payment-fees-report', range],
    queryFn: async () =>
      (await api.get('/api/reports/payment-fees', { params: range })).data as PaymentFeesPayload,
    staleTime: 60_000,
  });
}
