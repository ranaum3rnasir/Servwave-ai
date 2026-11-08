/**
 * reconcile-stripe-fees.test.ts
 *
 * TDD for Task 3.3: post-commit Stripe fee reconciliation + nightly sweep.
 *
 * `checkout.session.completed` carries no fee data — captureStripeFees retrieves the
 * PaymentIntent (expanded to latest_charge.balance_transaction) on the connected account
 * and writes stripe_fee_amount / platform_fee_amount / net_amount / stripe_balance_transaction_id
 * onto the Payment row, converting Stripe's integer cents into the dollar-denominated Decimal
 * columns the rest of the codebase uses (matches Payment.amount / invoice.total_amount).
 * Failure-isolated: never throws, so a Stripe/DB hiccup here can never affect the money write
 * that already committed. sweepUncapturedFees is the nightly backstop for anything missed
 * (e.g. a webhook that raced the balance_transaction settling).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The global setup.ts mocks this wholesale (so webhook.test.ts can assert the wiring in
// isolation); this file tests the REAL implementation.
vi.unmock('../lib/reconcile-stripe-fees');

import { captureStripeFees, sweepUncapturedFees } from '../lib/reconcile-stripe-fees';
import { prisma } from '../lib/prisma';
import { getStripeForOrg } from '../lib/stripe';
import { logger } from '../lib/logger';

const mockPrisma = prisma as unknown as {
  payment: {
    update: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
};

// getStripeForOrg is globally mocked (setup.ts) to always return the SAME stripe object
// reference regardless of input — same idiom Task 3.2's stripe.applicationFees tests use.
const { stripe } = getStripeForOrg({ stripe_account_id: null });
const mockRetrieve = stripe.paymentIntents.retrieve as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('captureStripeFees', () => {
  it('retrieves the PaymentIntent with the balance_transaction expand, on the connected account', async () => {
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: {
        amount: 10000,
        application_fee_amount: 50,
        balance_transaction: { id: 'txn_1', fee: 320 },
      },
    });
    mockPrisma.payment.update.mockResolvedValueOnce({});

    await captureStripeFees('pay_1', 'pi_1', 'acct_test_1');

    expect(mockRetrieve).toHaveBeenCalledWith(
      'pi_1',
      { expand: ['latest_charge.balance_transaction'] },
      { stripeAccount: 'acct_test_1' },
    );
  });

  it('converts Stripe cents to dollars and writes all four reconciliation columns', async () => {
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: {
        amount: 10000, // $100.00
        application_fee_amount: 50, // $0.50
        balance_transaction: { id: 'txn_1', fee: 320 }, // $3.20
      },
    });
    mockPrisma.payment.update.mockResolvedValueOnce({});

    await captureStripeFees('pay_1', 'pi_1', 'acct_test_1');

    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay_1' },
      data: {
        stripe_fee_amount: 3.2,
        platform_fee_amount: 0.5,
        net_amount: 96.3, // 100.00 - 3.20 - 0.50
        stripe_balance_transaction_id: 'txn_1',
      },
    });
  });

  // Decision guard (2026-08-04). net_amount is deliberately measured against the FULL
  // charge - face + card service fee + tip - because that is the amount Stripe's fee was
  // actually taken from, and the result is the cash that lands in the org's balance. It is
  // NOT the face amount minus fees. The alternative (re-basing net onto the face value so it
  // lines up with the report's face-basis `gross`) was considered and rejected: it would
  // report ~$509.79 landing on the live staging row below when $608.45 actually did, and it
  // would erase the whole point of the service fee, which is that the customer funds the fee
  // stack so the org keeps face value. The report reconciles the two bases with its own
  // `charged` figure instead (services/payment-fees-report.ts).
  it('measures net_amount against the full charge (face + service fee + tip), not the invoice face amount', async () => {
    // Live staging row, payment 8b17c520-…, org 00000000-…-0001: face $533.13 + service fee
    // $18.66 + tip $80.00 = $631.79 charged to the card.
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: {
        amount: 63179,
        application_fee_amount: 236,
        balance_transaction: { id: 'txn_charged_basis', fee: 2098 },
      },
    });
    mockPrisma.payment.update.mockResolvedValueOnce({});

    await captureStripeFees('pay_charged_basis', 'pi_charged_basis', 'acct_test_1');

    const { data } = mockPrisma.payment.update.mock.calls[0][0];
    expect(data.net_amount).toBe(608.45); // 631.79 - 20.98 - 2.36
    // Explicitly NOT the face basis: 533.13 - 20.98 - 2.36. Guards against a future
    // "net should not exceed gross" change quietly rewriting what the column means.
    expect(data.net_amount).not.toBe(509.79);
    expect(data.net_amount).toBeGreaterThan(533.13);
  });

  it('guards against floating-point drift when combining fee components (rounds to the cent)', async () => {
    // Verified in isolation: (1234567/100) - (34521/100) - (6173/100) evaluates in raw JS to
    // 11938.730000000001, not 11938.73 — this pins the round-to-cent guard, not just the math.
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: {
        amount: 1234567,
        application_fee_amount: 6173,
        balance_transaction: { id: 'txn_drift', fee: 34521 },
      },
    });
    mockPrisma.payment.update.mockResolvedValueOnce({});

    await captureStripeFees('pay_drift', 'pi_drift', 'acct_test_1');

    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay_drift' },
      data: {
        stripe_fee_amount: 345.21,
        platform_fee_amount: 61.73,
        net_amount: 11938.73,
        stripe_balance_transaction_id: 'txn_drift',
      },
    });
  });

  it('defaults platform_fee_amount to 0 when application_fee_amount is null (no platform fee on this charge)', async () => {
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: {
        amount: 5000,
        application_fee_amount: null,
        balance_transaction: { id: 'txn_2', fee: 175 },
      },
    });
    mockPrisma.payment.update.mockResolvedValueOnce({});

    await captureStripeFees('pay_2', 'pi_2', 'acct_test_1');

    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'pay_2' },
      data: {
        stripe_fee_amount: 1.75,
        platform_fee_amount: 0,
        net_amount: 48.25,
        stripe_balance_transaction_id: 'txn_2',
      },
    });
  });

  it('no-ops (does not write) when the charge has no balance_transaction yet (not settled), and warns naming the payment and payment intent', async () => {
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: { amount: 10000, application_fee_amount: 50, balance_transaction: null },
    });

    await captureStripeFees('pay_1', 'pi_1', 'acct_test_1');

    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    // Distinguishable from the catch block's "fee capture failed" warn below - this is the
    // "no balance_transaction" case, not a thrown error - so a future reader can grep the two apart.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no balance_transaction'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pay_1'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pi_1'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nightly sweep will retry'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('fee capture failed'));
  });

  it('no-ops when there is no latest_charge at all', async () => {
    mockRetrieve.mockResolvedValueOnce({ latest_charge: null });

    await captureStripeFees('pay_1', 'pi_1', 'acct_test_1');

    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  it('swallows a Stripe API error — never throws — so a capture failure can never affect the payment write that already committed', async () => {
    mockRetrieve.mockRejectedValueOnce(new Error('Stripe API is down'));

    await expect(captureStripeFees('pay_1', 'pi_1', 'acct_test_1')).resolves.toBeUndefined();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  it('swallows a DB write error too — never throws', async () => {
    mockRetrieve.mockResolvedValueOnce({
      latest_charge: { amount: 10000, application_fee_amount: 0, balance_transaction: { id: 'txn_1', fee: 100 } },
    });
    mockPrisma.payment.update.mockRejectedValueOnce(new Error('DB is down'));

    await expect(captureStripeFees('pay_1', 'pi_1', 'acct_test_1')).resolves.toBeUndefined();
  });
});

describe('sweepUncapturedFees', () => {
  it('queries Payments with a PI + account but no captured balance_transaction, oldest-first, capped at 500', async () => {
    mockPrisma.payment.findMany.mockResolvedValueOnce([]);

    const result = await sweepUncapturedFees();

    expect(mockPrisma.payment.findMany).toHaveBeenCalledWith({
      where: {
        stripe_payment_intent_id: { not: null },
        stripe_account_id: { not: null },
        stripe_balance_transaction_id: null,
      },
      select: { id: true, stripe_payment_intent_id: true, stripe_account_id: true },
      orderBy: { paid_at: 'asc' },
      take: 500,
    });
    expect(result).toEqual({ swept: 0 });
  });

  it('captures each uncaptured row (using ITS OWN stripe_account_id) and returns the attempted count', async () => {
    mockPrisma.payment.findMany.mockResolvedValueOnce([
      { id: 'pay_a', stripe_payment_intent_id: 'pi_a', stripe_account_id: 'acct_a' },
      { id: 'pay_b', stripe_payment_intent_id: 'pi_b', stripe_account_id: 'acct_b' },
    ]);
    mockRetrieve.mockResolvedValue({ latest_charge: null }); // both rows no-op past retrieve

    const result = await sweepUncapturedFees();

    expect(mockRetrieve).toHaveBeenCalledTimes(2);
    expect(mockRetrieve).toHaveBeenCalledWith(
      'pi_a',
      { expand: ['latest_charge.balance_transaction'] },
      { stripeAccount: 'acct_a' },
    );
    expect(mockRetrieve).toHaveBeenCalledWith(
      'pi_b',
      { expand: ['latest_charge.balance_transaction'] },
      { stripeAccount: 'acct_b' },
    );
    expect(result).toEqual({ swept: 2 });
  });
});
