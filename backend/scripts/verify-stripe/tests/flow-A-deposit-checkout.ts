import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export async function run(f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const event = {
    id: `evt_verify_dep_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_verify_dep_1',
        payment_intent: f.depositPiId,
        amount_total: Math.round(f.depositAmount * 100),
        metadata: { depositId: f.depositId },
      },
    },
  };

  const res = await postWebhook(event);
  assert(res.status === 200, `checkout.session.completed returns 200 (got ${res.status})`);
  count++;
  assert(!res.body.duplicate, 'first delivery is not a duplicate');
  count++;

  const deposit = await prisma.deposit.findUnique({ where: { id: f.depositId } });
  assert(deposit?.status === 'PAID', `deposit status should be PAID (got ${deposit?.status})`);
  count++;
  assert(deposit?.payment_method === 'CARD', `deposit payment_method should be CARD (got ${deposit?.payment_method})`);
  count++;
  assert(deposit?.stripe_payment_intent_id === f.depositPiId, 'deposit stripe_payment_intent_id is set');
  count++;
  assert(deposit?.paid_at !== null, 'deposit paid_at is set');
  count++;

  const estimate = await prisma.estimate.findUnique({ where: { id: f.estimateId } });
  assert(estimate?.status === 'APPROVED', `estimate status should be APPROVED (got ${estimate?.status})`);
  count++;

  const lead = await prisma.lead.findUnique({ where: { id: f.leadId } });
  assert(lead?.status === 'WON', `lead status should be WON (got ${lead?.status})`);
  count++;

  const timeline = await prisma.timelineEvent.findFirst({
    where: { entity_type: 'ESTIMATE', entity_id: f.estimateId, event_type: 'DEPOSIT_PAID' },
  });
  assert(timeline !== null, 'DEPOSIT_PAID timeline event created');
  count++;

  // Replay — idempotent
  const replay = await postWebhook(event);
  assert(replay.status === 200, `replay returns 200 (got ${replay.status})`);
  count++;
  assert(replay.body.duplicate === true, 'replay returns duplicate:true');
  count++;

  if (opts.verbose) console.log(`  deposit ${f.depositId} → PAID, PI=${f.depositPiId}`);
  return count;
}
