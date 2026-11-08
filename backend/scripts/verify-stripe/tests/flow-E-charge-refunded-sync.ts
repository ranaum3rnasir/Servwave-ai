import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Tests the charge.refunded webhook handler for both invoice and deposit paths,
// and verifies that in_app metadata causes the handler to skip state updates.
// Depends on flow-A and flow-B having run first (deposit/invoice need PI IDs set).
export async function run(f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  // ── Invoice path (charge.refunded for invoice PI set by flow-B) ────────────
  const invoiceRefundEvent = {
    id: `evt_refunded_inv_${Date.now()}`,
    type: 'charge.refunded',
    data: {
      object: {
        payment_intent: f.invoicePiId,
        amount_refunded: Math.round(543.75 * 100),
        refunds: {
          data: [{ id: 're_verify_inv_1', metadata: {} }], // no in_app source
        },
      },
    },
  };

  const invRes = await postWebhook(invoiceRefundEvent);
  assert(invRes.status === 200, `charge.refunded (invoice path) returns 200 (got ${invRes.status})`);
  count++;

  const invoice = await prisma.invoice.findUnique({ where: { id: f.invoiceId } });
  assert(invoice?.status === 'REFUNDED', `invoice status should be REFUNDED (got ${invoice?.status})`);
  count++;
  assert(Number(invoice?.total_refunded) > 0, 'invoice total_refunded is set');
  count++;

  const payment = await prisma.payment.findFirst({ where: { invoice_id: f.invoiceId } });
  assert(payment?.refunded_at !== null, 'payment refunded_at is set');
  count++;

  const invTimeline = await prisma.timelineEvent.findFirst({
    where: { entity_type: 'INVOICE', entity_id: f.invoiceId, event_type: 'INVOICE_REFUNDED' },
  });
  assert(invTimeline !== null, 'INVOICE_REFUNDED timeline event created');
  count++;

  // ── Deposit path (charge.refunded for deposit PI set by flow-A) ────────────
  const depRefundEvent = {
    id: `evt_refunded_dep_${Date.now()}`,
    type: 'charge.refunded',
    data: {
      object: {
        payment_intent: f.depositPiId,
        amount_refunded: Math.round(f.depositAmount * 100),
        refunds: {
          data: [{ id: 're_verify_dep_1', metadata: {} }], // no in_app source
        },
      },
    },
  };

  const depRes = await postWebhook(depRefundEvent);
  assert(depRes.status === 200, `charge.refunded (deposit path) returns 200 (got ${depRes.status})`);
  count++;

  const deposit = await prisma.deposit.findUnique({ where: { id: f.depositId } });
  assert(deposit?.status === 'REFUNDED', `deposit status should be REFUNDED (got ${deposit?.status})`);
  count++;

  const depTimeline = await prisma.timelineEvent.findFirst({
    where: { entity_type: 'ESTIMATE', entity_id: f.estimateId, event_type: 'DEPOSIT_REFUNDED' },
  });
  assert(depTimeline !== null, 'DEPOSIT_REFUNDED timeline event created');
  count++;

  // ── in_app metadata skip path ──────────────────────────────────────────────
  const invoiceBeforeSkip = await prisma.invoice.findUnique({ where: { id: f.invoiceId } });
  const inAppEvent = {
    id: `evt_inapp_skip_${Date.now()}`,
    type: 'charge.refunded',
    data: {
      object: {
        payment_intent: f.invoicePiId,
        amount_refunded: Math.round(543.75 * 100),
        refunds: {
          data: [{ id: 're_inapp_1', metadata: { source: 'in_app' } }],
        },
      },
    },
  };

  const skipRes = await postWebhook(inAppEvent);
  assert(skipRes.status === 200, `in_app skip returns 200 (got ${skipRes.status})`);
  count++;

  // State should not change (handler recorded event only, no DB state update)
  const invoiceAfterSkip = await prisma.invoice.findUnique({ where: { id: f.invoiceId } });
  assert(
    invoiceAfterSkip?.refunded_at?.getTime() === invoiceBeforeSkip?.refunded_at?.getTime(),
    'invoice refunded_at unchanged after in_app skip',
  );
  count++;

  if (opts.verbose) console.log(`  invoice→REFUNDED, deposit→REFUNDED, in_app skip verified`);
  return count;
}
