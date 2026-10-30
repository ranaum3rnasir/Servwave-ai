import type { SuiteContext } from '../context';
import {
  TEST_BANK_FAIL, TEST_BANK_OK, assert, chargingOrgId, deleteSeeded, deliverAsAccount, label, openCheckout, payByBank, paymentsOf,
  realEvents, removeFixtures, seedInvoice, sinceNow, waitFor, withOrgSettings, type SeededInvoice,
} from '../harness';
import { prisma } from '../../../src/lib/prisma';

// The hosted BANK checkout on the connected account, with the processor's test bank accounts and
// nothing typed into any page. The checkout is opened through the app's public door, paid with a
// test bank account, the micro-deposits verified, and the processor's own events (the completed
// session, then the cleared or failed outcome) played to the backend as the account's events:
//   - an invoice, success account: PROCESSING while the debit clears (invoice not PAID), then
//     SUCCEEDED and PAID; the outcome event again is a duplicate;
//   - a deposit invoice, success account: the estimate is approved when the debit STARTS (PRD
//     call 3), and the deposit is PAID when it clears;
//   - an invoice, failure account: FAILED, and the full balance is open again.
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const orgId = await chargingOrgId(ctx);
  const account = ctx.chargingAccount!;
  const cents = 12500;

  const pay = async (inv: SeededInvoice, accountNumber: string, outcome: 'async_payment_succeeded' | 'async_payment_failed') => {
    const since = sinceNow();
    const opened = await openCheckout(ctx, inv, { method: 'bank' });
    assert(opened.status === 200 && opened.sessionId, `the bank checkout opened (got ${opened.status} ${JSON.stringify(opened.json)})`);
    const { intentId } = await payByBank(ctx, opened.sessionId, cents, accountNumber);
    const isSession = (o: Record<string, unknown>) => o.id === opened.sessionId;
    const completed = await realEvents(ctx, { type: 'checkout.session.completed', since, match: isSession });
    await deliverAsAccount(completed, account);
    const processing = await waitFor('the PROCESSING payment', async () => (await paymentsOf(inv.id)).find((p) => p.state === 'PROCESSING'));
    const settled = await realEvents(ctx, { type: `checkout.session.${outcome}`, since, match: isSession, timeoutMs: 180_000 });
    await deliverAsAccount(settled, account);
    return { sessionId: opened.sessionId, intentId, processing, settled };
  };

  return withOrgSettings(orgId, { stripe_charges_enabled: true, accepted_payment_methods: ['CARD', 'ACH'] }, async () => {
    const invoiceCase = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: cents, methods: ['ACH'] });
    const depositCase = await seedInvoice(orgId, { kind: 'DEPOSIT', totalCents: cents, methods: ['ACH'] });
    const failCase = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: cents, methods: ['ACH'] });
    try {
      // Invoice, success.
      const a = await pay(invoiceCase, TEST_BANK_OK, 'async_payment_succeeded');
      assert(a.processing.method === 'ACH' && a.processing.stripe_account_id === account, `a bank payment on the connected account (got ${a.processing.method})`);
      count++;
      const [cleared] = await paymentsOf(invoiceCase.id);
      assert(cleared.state === 'SUCCEEDED', `the debit cleared (got ${cleared.state})`);
      const invoiceA = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceCase.id } });
      assert(invoiceA.status === 'PAID' && Number(invoiceA.amount_due) === 0, `the invoice is PAID (got ${invoiceA.status} ${invoiceA.amount_due})`);
      count++;
      await deliverAsAccount(a.settled, account);
      assert((await paymentsOf(invoiceCase.id)).length === 1, 'the outcome event again books nothing more');
      count++;
      ctx.booked.push({ flow: 'flow-N', orgId, paymentId: cleared.id, chargeId: cleared.stripe_charge_id, intentId: cleared.stripe_payment_intent_id });

      // Deposit, success: approved when the debit starts.
      const since = sinceNow();
      const opened = await openCheckout(ctx, depositCase, { method: 'bank' });
      assert(opened.status === 200 && opened.sessionId, `the deposit's bank checkout opened (got ${opened.status} ${JSON.stringify(opened.json)})`);
      await payByBank(ctx, opened.sessionId, cents, TEST_BANK_OK);
      const isDeposit = (o: Record<string, unknown>) => o.id === opened.sessionId;
      await deliverAsAccount(await realEvents(ctx, { type: 'checkout.session.completed', since, match: isDeposit }), account);
      await waitFor('the PROCESSING deposit payment', async () => (await paymentsOf(depositCase.id)).find((p) => p.state === 'PROCESSING'));
      const approved = await prisma.estimate.findUniqueOrThrow({ where: { id: depositCase.estimateId! } });
      assert(approved.status === 'WON', `the estimate is approved when the bank deposit starts processing (got ${approved.status})`);
      assert((await prisma.invoice.findUniqueOrThrow({ where: { id: depositCase.id } })).status !== 'PAID', 'the deposit is not PAID while the debit is clearing');
      count++;
      await deliverAsAccount(await realEvents(ctx, { type: 'checkout.session.async_payment_succeeded', since, match: isDeposit, timeoutMs: 180_000 }), account);
      const depositPaid = await prisma.invoice.findUniqueOrThrow({ where: { id: depositCase.id } });
      assert(depositPaid.status === 'PAID', `the deposit is PAID once the debit clears (got ${depositPaid.status})`);
      count++;

      // Invoice, failure account.
      const f = await pay(failCase, TEST_BANK_FAIL, 'async_payment_failed');
      const [failed] = await paymentsOf(failCase.id);
      assert(failed.state === 'FAILED', `the failed debit is FAILED (got ${failed.state})`);
      const invoiceF = await prisma.invoice.findUniqueOrThrow({ where: { id: failCase.id } });
      assert(invoiceF.status === 'SENT' && Number(invoiceF.amount_due) === 125, `the full balance is open again (got ${invoiceF.status} ${invoiceF.amount_due})`);
      count++;
      if (opts.verbose) console.log(`  cleared ${a.intentId}; deposit approved then PAID; failure ${f.intentId} reopened the balance`);
      return count;
    } finally {
      for (const inv of [invoiceCase, depositCase, failCase]) {
        await removeFixtures(label(inv, orgId), () => deleteSeeded(orgId, inv));
      }
    }
  });
}
