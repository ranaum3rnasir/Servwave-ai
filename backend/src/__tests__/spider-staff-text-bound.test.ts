// #2995: the worst-case (adapted from the verifier's r1 test; the bound comes from the ticket, ~10 s) time one Spider staff alert text
// can hold the sweep, with the REAL client against a fake slow provider. fetch is stubbed globally,
// so nothing can reach the real phone provider. Fake timers drive both the abort signals and Date.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.unmock('../lib/ctm/client');
vi.mock('../config/env', async () => ({
  env: {
    ...(await import('./test-env.js')).testEnv,
    CTM_ACCESS_KEY: 'fake-access',
    CTM_SECRET_KEY: 'fake-secret',
    CTM_API_BASE: 'https://fake-provider.invalid/api/v1',
    CTM_OUTBOUND_ALLOWLIST: undefined,
  },
}));

import { prisma } from '../lib/prisma';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { deliverSpiderTextsTo, TEXT_OUTCOME, TEXT_REASON } from '../services/spider/delivery';
import type { SpiderRecipient } from '../services/spider/recipients';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

type Step = { kind: 'hang' } | { kind: 'ok'; afterMs: number; body: unknown } | { kind: 'status'; status: number };
const calls: Array<{ path: 'opt_out' | 'sms'; at: number; timeoutMs: number }> = [];
let plan: { opt_out: Step[]; sms: Step[] };
const signalTimeouts = new WeakMap<AbortSignal, number>();

const fetchMock = vi.fn(async (url: string, init: { signal: AbortSignal }) => {
  const key: 'opt_out' | 'sms' = url.includes('/opt_out_texts') ? 'opt_out' : url.endsWith('/sms') ? 'sms' : (() => { throw new Error(`unexpected url ${url}`); })();
  calls.push({ path: key, at: Date.now(), timeoutMs: signalTimeouts.get(init.signal) ?? -1 });
  const step = plan[key].shift() ?? { kind: 'hang' };
  return new Promise<Response>((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
    if (step.kind === 'ok') setTimeout(() => resolve(new Response(JSON.stringify(step.body), { status: 200 })), step.afterMs);
    if (step.kind === 'status') resolve(new Response('{"reason":"busy"}', { status: step.status }));
  });
});
vi.stubGlobal('fetch', fetchMock);

const recipient: SpiderRecipient = { id: 'u1', first_name: 'Sam', last_name: 'Staff', email: null, phone: '(555) 123-4567' } as any;

// Each test starts its fake clock far past the last one, so the client's module-level request
// pacing (lastRequestAt) never carries a wait across tests.
let base = Date.now() + 1e9;
beforeEach(() => {
  calls.length = 0;
  _resetCtmSmsDoubleFireGuard();
  base += 1e9;
  vi.useFakeTimers({ now: base });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' })), ms);
    signalTimeouts.set(c.signal, ms);
    return c.signal;
  });
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '111111', ctm_sms_ready: true, sms_sending_enabled: true, plan: 'PRO', trial_ends_at: null, feature_overrides: { phone: true },
  });
  p.phoneNumber.findFirst.mockResolvedValue({ id: 'pn1', ctm_number_id: 'TPN-A' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function oneAlert() {
  const t0 = Date.now();
  const run = deliverSpiderTextsTo({
    orgId: 'org-2995-bound', sendKey: `alert-${Math.random()}`, logKey: {}, recipients: [recipient], bodyFor: () => 'body', onSent: async () => undefined,
  });
  // The hold is when the delivery RESOLVES, not when every leftover timer has drained.
  let doneAt = -1;
  void run.then(() => { doneAt = Date.now(); });
  await vi.runAllTimersAsync();
  const out = await run;
  return { out, elapsed: doneAt - t0 };
}

const NOT_OPTED_OUT = { opt_out_texts: [] };
const scenarios: Array<[string, { opt_out: Step[]; sms: Step[] }]> = [
  ['A: provider hangs on everything', { opt_out: [], sms: [] }],
  ['B: opt-out check answers at once, send hangs', { opt_out: [{ kind: 'ok', afterMs: 0, body: NOT_OPTED_OUT }], sms: [] }],
  ['C: opt-out check times out twice, answers at 29.9 s, send hangs (worst case that still attempts the send)', {
    opt_out: [{ kind: 'hang' }, { kind: 'hang' }, { kind: 'ok', afterMs: 29_900, body: NOT_OPTED_OUT }], sms: [] }],
  ['D: opt-out check answers at 29.9 s, send hangs', { opt_out: [{ kind: 'ok', afterMs: 29_900, body: NOT_OPTED_OUT }], sms: [] }],
  ['E: opt-out check 503 three times', { opt_out: [{ kind: 'status', status: 503 }, { kind: 'status', status: 503 }, { kind: 'status', status: 503 }], sms: [] }],
  ['F: opt-out fine, send 503', { opt_out: [{ kind: 'ok', afterMs: 0, body: NOT_OPTED_OUT }], sms: [{ kind: 'status', status: 503 }] }],
];

describe('#2995: worst-case hold of ONE staff alert text (fake slow provider, fake timers)', () => {
  it.each(scenarios)('%s', async (name, s) => {
    plan = { opt_out: [...s.opt_out], sms: [...s.sms] };
    const { out, elapsed } = await oneAlert();
    // Every scenario here ends as a failed text in plain words, never sent.
    expect(out.sent).toBe(0);
    expect(out.results).toEqual([{ user_id: 'u1', result: 'failed', reason: TEXT_REASON.failed }]);
    expect(out.outcome).toBe(TEXT_OUTCOME.failed);
    expect(JSON.stringify(out)).not.toMatch(/ctm|calltracking|busy|timeout|abort|503/i);
    // The ticket's bound: about 10 s in total for one staff alert text (allow pacing + 1 s slack).
    expect(elapsed, `${name}: total hold`).toBeLessThanOrEqual(11_000);
  });
});

describe('#2995: the fast path still sends', () => {
  it('opt-out check and send both answer at once: sent, and quickly', async () => {
    plan = { opt_out: [{ kind: 'ok', afterMs: 0, body: NOT_OPTED_OUT }], sms: [{ kind: 'ok', afterMs: 0, body: { id: 'M1' } }] };
    const { out, elapsed } = await oneAlert();
    expect(out.sent).toBe(1);
    expect(out.results).toEqual([{ user_id: 'u1', result: 'sent', reason: null }]);
    expect(elapsed).toBeLessThanOrEqual(1_000);
  });
});
