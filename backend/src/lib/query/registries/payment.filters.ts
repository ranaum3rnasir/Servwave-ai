import { Prisma } from '@prisma/client';
import { openFailedRefundExists } from '../../../services/payment-attention/queries';

/**
 * Payments page facet registry (payments go-live P3). The wire param names are the contract the frontend registry
 * copies (P6): `status`, `method`, `payout_status`, `amount_min`, `amount_max`, `chip`. There is no date facet: time is
 * the period picker (`from`/`to`) only.
 *
 * Lists that grow must scale, so the Payments list is paged IN SQL: every facet here is a SQL condition on the
 * `payments p` row (joined to `invoices i` and `payouts po`), and the controller counts and pages with LIMIT/OFFSET.
 * Nothing is resolved to a JS list of ids first. The conditions are scoped by the caller's organization_id (on i).
 *
 * Every multi facet validates against its own list first, so a garbage value is dropped instead of reaching the
 * database as a 500 (the invoice list's rule).
 *
 * `status` is the DISPLAY status, so each value is the predicate that produces it (paymentDisplayStatus in
 * services/payments-page.ts): a payment with an open dispute reads Disputed, a refund wins over a void, and so on.
 * The amount range is on the CHARGED amount (invoice amount + tip + service fee).
 */

export const PAYMENT_STATUS_SLUGS = [
  'succeeded', 'pending', 'failed', 'disputed', 'refund_failed', 'charged_back', 'voided', 'refunded', 'partially_refunded',
] as const;
export type PaymentStatusSlug = (typeof PAYMENT_STATUS_SLUGS)[number];

export const PAYMENT_METHODS = ['CARD', 'ACH'] as const;
export const PAYOUT_STATUS_KEYS = ['awaiting', 'in_transit', 'paid', 'failed'] as const;
export type PayoutStatusFacet = (typeof PAYOUT_STATUS_KEYS)[number];

/** A quick-filter chip: one or more statuses. `attention` is served by another endpoint, so it is not here. */
export const PAYMENT_CHIPS: Record<string, PaymentStatusSlug[]> = {
  succeeded: ['succeeded'],
  pending: ['pending'],
  failed: ['failed'],
  refunded: ['refunded', 'partially_refunded'],
  disputed: ['disputed'],
};

/** What hit the card: invoice amount + tip + service fee. */
export const CHARGED_SQL = Prisma.sql`(p.amount + COALESCE(p.tip_amount, 0) + COALESCE(p.service_fee_amount, 0))`;
/** Processing fee + platform fee, or NULL while neither has been captured. */
export const FEE_SQL = Prisma.sql`(CASE WHEN p.stripe_fee_amount IS NULL AND p.platform_fee_amount IS NULL THEN NULL ELSE COALESCE(p.stripe_fee_amount, 0) + COALESCE(p.platform_fee_amount, 0) END)`;

const OPEN_DISPUTE = Prisma.sql`EXISTS (SELECT 1 FROM disputes d WHERE d.payment_id = p.id AND d.status IN ('NEEDS_RESPONSE', 'UNDER_REVIEW'))`;
const HAS_REFUND = Prisma.sql`EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.state = 'SUCCEEDED')`;
// A refund of the payment failed and nobody has dealt with it: the attention list's own definition, on this query's company.
const REFUND_FAILED_OPEN = openFailedRefundExists(Prisma.sql`i.organization_id`);
const REFUNDED_SUM = Prisma.sql`(SELECT COALESCE(SUM(r.amount), 0) FROM refunds r WHERE r.payment_id = p.id AND r.state = 'SUCCEEDED')`;

/** The SQL predicate that produces one display status. */
export function statusPredicate(slug: PaymentStatusSlug): Prisma.Sql {
  const collected = Prisma.sql`p.state = 'SUCCEEDED'`;
  const noOpenDispute = Prisma.sql`NOT ${OPEN_DISPUTE}`;
  // Refund failed sits before Refunded, Charged back and Voided in the display order, so those leave its rows out.
  const noFailedRefund = Prisma.sql`NOT ${REFUND_FAILED_OPEN}`;
  switch (slug) {
    case 'pending': return Prisma.sql`p.state = 'PROCESSING'`;
    case 'failed': return Prisma.sql`p.state = 'FAILED'`;
    case 'disputed': return Prisma.sql`(${collected} AND ${OPEN_DISPUTE})`;
    case 'refund_failed': return Prisma.sql`(${collected} AND ${noOpenDispute} AND ${REFUND_FAILED_OPEN})`;
    case 'charged_back':
      return Prisma.sql`(${collected} AND ${noOpenDispute} AND ${noFailedRefund} AND p.voided_at IS NOT NULL AND p.void_category = 'CHARGEBACK' AND NOT ${HAS_REFUND})`;
    case 'voided':
      return Prisma.sql`(${collected} AND ${noOpenDispute} AND ${noFailedRefund} AND p.voided_at IS NOT NULL AND p.void_category IS DISTINCT FROM 'CHARGEBACK' AND NOT ${HAS_REFUND})`;
    // A refund wins over a void, as in the report's statusLabel.
    case 'refunded': return Prisma.sql`(${collected} AND ${noOpenDispute} AND ${noFailedRefund} AND ${HAS_REFUND} AND ${REFUNDED_SUM} >= p.amount)`;
    case 'partially_refunded': return Prisma.sql`(${collected} AND ${noOpenDispute} AND ${noFailedRefund} AND ${HAS_REFUND} AND ${REFUNDED_SUM} < p.amount)`;
    case 'succeeded': return Prisma.sql`(${collected} AND ${noOpenDispute} AND ${noFailedRefund} AND p.voided_at IS NULL AND NOT ${HAS_REFUND})`;
  }
}

/** The SQL predicate that produces one payout-status key (po is the LEFT-joined payout). */
function payoutStatusPredicate(key: PayoutStatusFacet): Prisma.Sql {
  switch (key) {
    case 'awaiting': return Prisma.sql`(p.payout_id IS NULL AND p.state = 'SUCCEEDED' AND p.voided_at IS NULL)`;
    case 'in_transit': return Prisma.sql`po.status IN ('PENDING', 'IN_TRANSIT')`;
    case 'paid': return Prisma.sql`po.status = 'PAID'`;
    case 'failed': return Prisma.sql`po.status IN ('FAILED', 'CANCELED')`;
  }
}

/** The status slugs among these values (garbage dropped). */
export function validStatuses(values: string[]): PaymentStatusSlug[] {
  return values.filter((v): v is PaymentStatusSlug => (PAYMENT_STATUS_SLUGS as readonly string[]).includes(v));
}

export interface PaymentListFacets {
  statuses: PaymentStatusSlug[];
  chip: string;
  methods: string[];
  payoutStatuses: string[];
  amountMin: number | null;
  amountMax: number | null;
}

/** The facet conditions to AND into the list's WHERE. Each is already parenthesised. */
export function facetConditions(f: PaymentListFacets): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  const any = (parts: Prisma.Sql[]) => Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
  if (f.statuses.length > 0) out.push(any(f.statuses.map(statusPredicate)));
  const chipSlugs = Object.prototype.hasOwnProperty.call(PAYMENT_CHIPS, f.chip) ? PAYMENT_CHIPS[f.chip] : [];
  if (chipSlugs.length > 0) out.push(any(chipSlugs.map(statusPredicate)));
  const methods = f.methods.filter((v) => (PAYMENT_METHODS as readonly string[]).includes(v));
  if (methods.length > 0) out.push(Prisma.sql`p.method::text IN (${Prisma.join(methods)})`);
  const keys = f.payoutStatuses.filter((v): v is PayoutStatusFacet => (PAYOUT_STATUS_KEYS as readonly string[]).includes(v));
  if (keys.length > 0) out.push(any(keys.map(payoutStatusPredicate)));
  if (f.amountMin != null) out.push(Prisma.sql`${CHARGED_SQL} >= ${String(f.amountMin)}::numeric`);
  if (f.amountMax != null) out.push(Prisma.sql`${CHARGED_SQL} <= ${String(f.amountMax)}::numeric`);
  return out;
}
