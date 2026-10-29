import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { maEstimateSentWithDeposit } from '../../helpers/workflow-builders';
import { assertInvoiceReconciles } from '../../helpers/reconcile';

/**
 * Harness integration smoke (not a coverage row). Proves the whole machine works
 * against staging before the real suite fans out: provisioned-admin login, the
 * deposit-% AppSetting pin, estimate→send→kind=DEPOSIT invoice spawn, the
 * /api/test/stripe-webhook money door (effect, not just received), and reconcile.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

test('SMOKE: deposit webhook flips the deposit invoice PAID and reconciles', async () => {
  const ctx = await maEstimateSentWithDeposit(api, 10_000, 30, ['CARD']);
  const dep = await api.getDepositInvoice(ctx.estimateId);
  expect(dep, 'deposit invoice should exist on estimate.invoices[0]').toBeTruthy();
  expect(dep!.kind).toBe('DEPOSIT');
  // The deposit % applies to the estimate's TAX-INCLUSIVE total (10000 + 625 MA tax = 10625),
  // so 30% = 3187.5. (This is the real behavior; the deposit invoice itself is non-taxable.)
  expect(Number(dep!.total_amount)).toBe(3_187.5);

  const ev = api.depositPaidEvent(dep!.id, api.checkoutCents(Number(dep!.amount_due)), { eventId: `evt_smoke_${api.suffix}` });
  const fired = await api.fireStripeEvent(ev);
  expect(fired.body.received).toBe(true);

  const paid = await api.getDepositInvoice(ctx.estimateId);
  expect(paid!.status).toBe('PAID');
  expect(Number(paid!.amount_due)).toBe(0);

  await assertInvoiceReconciles(api, dep!.id, 'SMOKE');

  // Idempotency: replaying the SAME event.id must not create a second payment.
  const replay = await api.fireStripeEvent(ev);
  expect(replay.body.duplicate).toBe(true);
});
