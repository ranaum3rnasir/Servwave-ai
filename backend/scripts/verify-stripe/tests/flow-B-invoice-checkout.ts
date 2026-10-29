import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export async function run(f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const event = {
    id: `evt_verify_inv_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_verify_inv_1',
        payment_intent: f.invoicePiId,
        amount_total: Math.round(543.75 * 100),
        metadata: { invoiceId: f.invoiceId },
      },
    },
  };

  const res = await postWebhook(event);
  assert(res.status === 200, `checkout.session.completed returns 200 (got ${res.status})`);
  count++;
  assert(!res.body.duplicate, 'first delivery is not a duplicate');
  count++;

  const invoice = await prisma.invoice.findUnique({ where: { id: f.invoiceId } });
  assert(invoice?.status === 'PAID', `invoice status should be PAID (got ${invoice?.status})`);
  count++;
  assert(invoice?.paid_at !== null, 'invoice paid_at is set');
  count++;
  assert(Number(invoice?.amount_due) === 0, 'invoice amount_due is 0');
  count++;

  const payment = await prisma.payment.findFirst({ where: { invoice_id: f.invoiceId } });
  assert(payment !== null, 'Payment record created');
  count++;
  assert(payment?.method === 'CARD', `payment method should be CARD (got ${payment?.method})`);
  count++;
  assert(payment?.stripe_payment_intent_id === f.invoicePiId, 'payment stripe_payment_intent_id is set');
  count++;

  const timeline = await prisma.timelineEvent.findFirst({
    where: { entity_type: 'INVOICE', entity_id: f.invoiceId, event_type: 'INVOICE_PAID' },
  });
  assert(timeline !== null, 'INVOICE_PAID timeline event created');
  count++;

  // Non-payable status — invoice is now PAID, replay should not double-process
  const replay = await postWebhook(event);
  assert(replay.status === 200, `replay returns 200 (got ${replay.status})`);
  count++;
  assert(replay.body.duplicate === true, 'replay returns duplicate:true');
  count++;

  if (opts.verbose) console.log(`  invoice ${f.invoiceId} → PAID, PI=${f.invoicePiId}`);
  return count;
}
