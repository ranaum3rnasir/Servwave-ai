import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Fires checkout.session.completed with a tampered amount_total.
// The handler should detect the mismatch, log an error, and NOT update the deposit.
export async function run(f: Fixtures, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const depositBefore = await prisma.deposit.findUnique({ where: { id: f.depositId } });
  const fakePiId = `pi_mismatch_${Date.now()}`;

  const event = {
    id: `evt_amount_mismatch_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_mismatch_1',
        payment_intent: fakePiId,
        amount_total: 99999, // wrong — correct value is depositAmount * 100
        metadata: { depositId: f.depositId },
      },
    },
  };

  const res = await postWebhook(event);
  assert(res.status === 200, `amount-mismatch should return 200 (got ${res.status})`);
  count++;

  const depositAfter = await prisma.deposit.findUnique({ where: { id: f.depositId } });
  assert(
    depositAfter?.stripe_payment_intent_id !== fakePiId,
    'deposit stripe_payment_intent_id was NOT updated with mismatched-amount event',
  );
  count++;
  assert(
    depositAfter?.status === depositBefore?.status,
    `deposit status unchanged after amount mismatch (got ${depositAfter?.status})`,
  );
  count++;

  return count;
}
