/**
 * Payments go-live slice 05: which payment-history rows count as money. Mirrors the backend's
 * lib/payment-ledger.ts.
 *
 * A payment counts toward what was paid only once it has SUCCEEDED: a bank payment is
 * PROCESSING until it clears and may still FAIL. A refund counts toward what was refunded only
 * once it has SUCCEEDED: a bank refund is PENDING until it lands, and a FAILED one gave nothing
 * back. Rows in any other state stay in the history; they just never enter a total.
 *
 * A row with no state comes from a payload that predates the column; every such row was
 * backfilled to SUCCEEDED, so it counts.
 */
import type { PaymentState, RefundState } from '@/types/entities';

export function paymentCounts(p: { state?: PaymentState | string | null }): boolean {
  return (p.state ?? 'SUCCEEDED') === 'SUCCEEDED';
}

export function refundCounts(r: { state?: RefundState | string | null }): boolean {
  return (r.state ?? 'SUCCEEDED') === 'SUCCEEDED';
}

/**
 * Whether a refund holds its share of what can still be refunded: a SUCCEEDED refund gave the
 * money back and a PENDING one is on its way; only a FAILED one frees its share again. Mirrors the
 * backend's COMMITTED_REFUND_WHERE, which caps every new refund.
 */
export function refundHoldsCap(r: { state?: RefundState | string | null }): boolean {
  return (r.state ?? 'SUCCEEDED') !== 'FAILED';
}
