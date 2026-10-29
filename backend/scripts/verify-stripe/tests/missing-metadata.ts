import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Fires checkout.session.completed with no depositId or invoiceId in metadata.
// The handler should break early without updating any DB state, but return 200.
export async function run(_f: Fixtures, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const event = {
    id: `evt_no_meta_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_no_meta_1',
        payment_intent: `pi_no_meta_${Date.now()}`,
        amount_total: 50000,
        metadata: {}, // no depositId, no invoiceId
      },
    },
  };

  const res = await postWebhook(event);
  assert(res.status === 200, `missing-metadata should return 200 (got ${res.status})`);
  count++;
  // The event is still recorded (handler falls through to the !eventRecorded path)
  assert(!res.body.error, `no error in response (got ${res.body.error})`);
  count++;

  return count;
}
