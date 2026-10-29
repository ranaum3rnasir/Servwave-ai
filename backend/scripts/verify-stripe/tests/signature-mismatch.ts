import { Fixtures } from '../fixtures';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export async function run(_f: Fixtures, _opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const payload = JSON.stringify({
    id: `evt_sig_mismatch_${Date.now()}`,
    type: 'checkout.session.completed',
    data: { object: { metadata: {} } },
  });

  const res = await fetch('http://localhost:3000/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=9999999999,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
    body: payload,
  });
  const body = await res.json();

  assert(res.status === 400, `bad signature should return 400 (got ${res.status})`);
  count++;
  assert(
    typeof body.error === 'string' && body.error.toLowerCase().includes('signature'),
    `error message should mention signature (got "${body.error}")`,
  );
  count++;

  return count;
}
