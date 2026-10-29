import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  createTech,
  fullStandardFlowCompleted,
} from '../../helpers/workflow-builders';

// Entity-redesign §9 — Statements. GET /api/statements/job/:jobId and
// /api/statements/customer/:customerId project every invoice/payment/credit/refund into a
// chronological list with a running balance, plus totals {billed,paid,refunded,credited,
// balance}. The customer/org roll-up keys off bill_to_customer_id (the billing group), NOT
// parent_id. running_balance = Σbilled − Σpaid − Σcredited + Σrefunded (a refund raises the
// outstanding/settlement gap).

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe('19 Statements (§9)', () => {
  test('ST-01: job statement → lines + totals with a correct running balance after full payment', async () => {
    // Lead → estimate → job → COMPLETED, then invoice + full payment.
    const ctx = await fullStandardFlowCompleted(api);
    const { body: invBody } = await api.createInvoice(ctx.jobId);
    const invoiceId = invBody.invoice.id;
    const { body: sentBody } = await api.sendInvoice(invoiceId);
    const amountDue = Number(sentBody.invoice.amount_due);

    await api.recordPayment(invoiceId, {
      amount: amountDue,
      method: 'CASH',
      notes: 'Full payment for statement test',
    });

    const { res, body } = await api.getJobStatement(ctx.jobId);
    expect(res.status()).toBe(200);
    expect(body.scope).toBe('job');
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBeGreaterThan(0);

    // Totals: billed and paid both equal the invoice total; balance nets to 0 after full pay.
    expect(Number(body.totals.billed)).toBeCloseTo(amountDue, 2);
    expect(Number(body.totals.paid)).toBeCloseTo(amountDue, 2);
    expect(Number(body.totals.balance)).toBeCloseTo(0, 2);

    // Running balance: billed − paid − credited + refunded = 0 = the last line's running_balance.
    const last = body.lines[body.lines.length - 1];
    expect(Number(last.running_balance)).toBeCloseTo(0, 2);
    const expectedBalance =
      Number(body.totals.billed) -
      Number(body.totals.paid) -
      Number(body.totals.credited) +
      Number(body.totals.refunded);
    expect(Number(body.totals.balance)).toBeCloseTo(expectedBalance, 2);
  });

  test('ST-02: job statement after a partial refund → balance reflects money back out', async () => {
    const ctx = await fullStandardFlowCompleted(api);
    const { body: invBody } = await api.createInvoice(ctx.jobId);
    const invoiceId = invBody.invoice.id;
    const { body: sentBody } = await api.sendInvoice(invoiceId);
    const amountDue = Number(sentBody.invoice.amount_due);

    await api.recordPayment(invoiceId, { amount: amountDue, method: 'CASH' });

    // Partial refund of half the paid amount.
    const refundAmount = Math.round(amountDue * 0.5 * 100) / 100;
    const { res: refundRes } = await api.refundInvoice(invoiceId, {
      amount: refundAmount,
      reason: 'Statement test partial refund',
      reason_category: 'CUSTOMER_REQUEST',
    });
    expect(refundRes.status()).toBe(200);

    const { res, body } = await api.getJobStatement(ctx.jobId);
    expect(res.status()).toBe(200);

    // billed = total; paid = total; refunded = the refund → balance = billed − paid + refunded.
    expect(Number(body.totals.refunded)).toBeCloseTo(refundAmount, 2);
    const expectedBalance =
      Number(body.totals.billed) -
      Number(body.totals.paid) -
      Number(body.totals.credited) +
      Number(body.totals.refunded);
    expect(Number(body.totals.balance)).toBeCloseTo(expectedBalance, 2);
    // A refund leaves a positive settlement gap (money owed back to the customer).
    expect(Number(body.totals.balance)).toBeCloseTo(refundAmount, 2);
  });

  test('ST-03: customer statement → rolls up the customer billing group', async () => {
    const ctx = await fullStandardFlowCompleted(api);
    const { body: invBody } = await api.createInvoice(ctx.jobId);
    const invoiceId = invBody.invoice.id;
    const { body: sentBody } = await api.sendInvoice(invoiceId);
    await api.recordPayment(invoiceId, {
      amount: Number(sentBody.invoice.amount_due),
      method: 'CASH',
    });

    const { res, body } = await api.getCustomerStatement(ctx.customerId);
    expect(res.status()).toBe(200);
    expect(body.scope).toBe('customer');
    expect(body.customer?.id).toBe(ctx.customerId);
    expect(Array.isArray(body.lines)).toBe(true);

    // Roll-up keys off bill_to_customer_id (the billing group), not parent_id — totals are
    // internally consistent and balance nets the invoice/payment for this customer.
    const expectedBalance =
      Number(body.totals.billed) -
      Number(body.totals.paid) -
      Number(body.totals.credited) +
      Number(body.totals.refunded);
    expect(Number(body.totals.balance)).toBeCloseTo(expectedBalance, 2);
    expect(Number(body.totals.balance)).toBeCloseTo(0, 2);
  });
});
