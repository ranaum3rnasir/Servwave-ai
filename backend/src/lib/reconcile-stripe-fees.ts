import { prisma } from './prisma';
import { getStripeForOrg } from './stripe';
import { logger } from './logger';

// Matches the round-to-cents guard used throughout the codebase for money math (e.g.
// invoice-totals.ts, estimate.controller.ts, job.controller.ts) — guards against floating-point
// drift when subtracting values that were each independently divided down from Stripe's
// integer-cents amounts (e.g. (1234567 - 34521 - 6173) / 100 done piecewise can land on
// 11938.730000000001 instead of 11938.73; the Decimal(12,2) column would round it on write,
// but a dirty JS number is still wrong to persist/compare against).
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Capture fee/net for a direct-charge Payment. checkout.session.completed carries no fee data,
 *  so retrieve the PI + balance_transaction AFTER the money write commits. Failure-isolated.
 *
 *  BASIS (explicit, 2026-08-04): `net_amount` is derived from `charge.amount` - the FULL amount
 *  charged to the card, i.e. the invoice face value PLUS the card service fee PLUS the customer's
 *  tip. That is intentional and load-bearing. Stripe's fee and our application fee are both taken
 *  out of that full amount, so it is the only basis on which `net_amount` equals the cash that
 *  actually landed in the org's Stripe balance.
 *
 *  It therefore does NOT line up with `Payment.amount`, which is the face value alone (the fee and
 *  the tip never enter Payment.amount or invoice totals - D1/D10 of the card-service-fee plan, and
 *  that principle is untouched). On a fee- or tip-bearing payment `net_amount` will legitimately
 *  EXCEED `Payment.amount`: the customer funded the processing stack and the tip rides on top.
 *  Do not "fix" that by subtracting the fee and tip here - it would report less cash than the org
 *  received, and it would hide the entire point of the service fee. Consumers that need the two
 *  bases reconciled report the charged basis alongside the face basis instead
 *  (services/payment-fees-report.ts's `charged`, components/crm/PaymentFeeBreakdown.tsx's
 *  additive rows). Pinned by reconcile-stripe-fees.test.ts's charged-basis test. */
export async function captureStripeFees(paymentId: string, paymentIntentId: string, stripeAccountId: string): Promise<void> {
  try {
    const { stripe } = getStripeForOrg({ stripe_account_id: stripeAccountId });
    const pi = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge.balance_transaction'] },
      { stripeAccount: stripeAccountId },
    );
    const charge: any = pi.latest_charge;
    const bt: any = charge?.balance_transaction;
    if (!bt) {
      logger.warn(`[reconcile] no balance_transaction for payment ${paymentId} (payment_intent ${paymentIntentId}) - nightly sweep will retry`);
      return;
    }
    const stripeFee = round2((bt.fee ?? 0) / 100);
    const platformFee = round2((charge?.application_fee_amount ?? 0) / 100);
    const net = round2((charge?.amount ?? 0) / 100 - stripeFee - platformFee);
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        stripe_fee_amount: stripeFee,
        platform_fee_amount: platformFee,
        net_amount: net,
        stripe_balance_transaction_id: bt.id ?? null,
      },
    });
  } catch (err) {
    logger.warn(`[reconcile] fee capture failed for payment ${paymentId} (nightly sweep will retry): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Nightly: backfill Payments that have a PI + account but no captured balance_transaction. */
export async function sweepUncapturedFees(): Promise<{ swept: number }> {
  const rows = await prisma.payment.findMany({
    where: { stripe_payment_intent_id: { not: null }, stripe_account_id: { not: null }, stripe_balance_transaction_id: null },
    select: { id: true, stripe_payment_intent_id: true, stripe_account_id: true },
    orderBy: { paid_at: 'asc' },
    take: 500,
  });
  for (const p of rows) await captureStripeFees(p.id, p.stripe_payment_intent_id!, p.stripe_account_id!);
  return { swept: rows.length };
}
