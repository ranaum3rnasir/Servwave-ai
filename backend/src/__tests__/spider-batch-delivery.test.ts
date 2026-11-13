// #3470: Spider's email goes to the provider as ONE batch request per 100 people, and its texts go side by side
// (at most SPIDER_TEXTS_IN_FLIGHT at once). The provider's email API and the phone system are faked at their clients;
// everything between (the brakes, the records, History's plain words) is the real delivery code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { batchSend, suppressedAmong } = vi.hoisted(() => ({ batchSend: vi.fn(), suppressedAmong: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'https://staging.app.test',
  },
}));
vi.mock('resend', () => ({
  Resend: class {
    batch = { send: batchSend };
    emails = { send: vi.fn(() => { throw new Error('Spider never sends one email at a time'); }) };
  },
}));
// setup.ts replaces the email module; the real one (its backoff and its sender line) runs here.
vi.mock('../lib/email-suppression', () => ({
  normalizeSuppressionAddress: (a: string) => a.trim().toLowerCase(),
  transactionalSuppressedAmong: suppressedAmong,
  isTransactionalSendSuppressed: vi.fn(async () => false),
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import {
  EMAIL_OUTCOME,
  SPIDER_EMAIL_BATCH_SIZE,
  SPIDER_EMAIL_REQUEST_LIMIT_MS,
  SPIDER_TEXTS_IN_FLIGHT,
  TEXT_OUTCOME,
  CONCURRENT_IDEMPOTENT_BACKOFF_MS,
  _setConcurrentIdempotentBackoff,
  _setSpiderEmailRequestLimit,
  deliverSpiderEmailsTo,
  deliverSpiderTextsTo,
  runTogether,
  spiderBatchIdempotencyKey,
  type SpiderContact,
} from '../services/spider/delivery';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG = 'org-3470';
const people = (n: number, over: Partial<SpiderContact> = {}): SpiderContact[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, first_name: `P${i}`, last_name: 'Staff', email: `p${i}@staff.test`, phone: `(555) 123-${String(1000 + i)}`, ...over }));
const messageFor = (r: SpiderContact) => ({ subject: `s ${r.id}`, text: `t ${r.id}`, html: `<p>${r.id}</p>` });
const KEY = { alertId: 'alert-1' };

/** A provider that remembers idempotency keys: the second request with a key is answered like the first and sends nothing. */
function idempotentProvider() {
  const answered = new Map<string, unknown>();
  const delivered: string[] = [];
  const requests: { key: string; size: number }[] = [];
  batchSend.mockImplementation(async (payload: { to: string }[], options: { idempotencyKey: string }) => {
    requests.push({ key: options.idempotencyKey, size: payload.length });
    if (!answered.has(options.idempotencyKey)) {
      delivered.push(...payload.map((m) => m.to));
      answered.set(options.idempotencyKey, { data: { data: payload.map((m) => ({ id: `id-${m.to}` })) }, error: null });
    }
    return answered.get(options.idempotencyKey);
  });
  return { delivered, requests };
}

beforeEach(() => {
  vi.clearAllMocks();
  batchSend.mockReset();
  p.organization.findUnique.mockResolvedValue({ email_sending_enabled: true, name: 'Acme', logo_url: null, brand_color: null, timezone: null });
  suppressedAmong.mockResolvedValue(new Set());
});

describe('emails: one batch request per up to 100 people', () => {
  it('sends 25 people in one request, tagged, from the fixed sender, and records each person\'s own provider id', async () => {
    const { delivered, requests } = idempotentProvider();
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(25), messageFor });
    expect(requests).toEqual([{ key: 'spider-alert:alert-1:0', size: 25 }]);
    expect(delivered).toHaveLength(25);
    const payload = batchSend.mock.calls[0]![0] as any[];
    expect(payload.every((m) => m.tags.length === 1 && m.tags[0].name === 'spider_alert_id' && m.tags[0].value === 'alert-1')).toBe(true);
    expect(payload.every((m) => /alerts@spider\.servwave\.com/.test(m.from))).toBe(true);
    expect(out.outcome).toBe(EMAIL_OUTCOME.sent);
    expect(out.recipients!.map((r) => [r.user_id, r.message_id])).toEqual(people(25).map((r) => [r.id, `id-${r.email}`]));
  });

  it('splits 230 people into requests of at most 100, each with its own key', async () => {
    const { requests } = idempotentProvider();
    await deliverSpiderEmailsTo({ orgId: ORG, logKey: { summaryId: 'sum-1' }, recipients: people(230), messageFor });
    expect(requests).toEqual([
      { key: 'spider-summary:sum-1:0', size: SPIDER_EMAIL_BATCH_SIZE },
      { key: 'spider-summary:sum-1:1', size: SPIDER_EMAIL_BATCH_SIZE },
      { key: 'spider-summary:sum-1:2', size: 30 },
    ]);
  });

  it('a "too many requests" refusal is retried with the same key and recorded as sent', async () => {
    batchSend
      .mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'slow down' } })
      .mockResolvedValueOnce({ data: { data: [{ id: 'id-a' }, { id: 'id-b' }] }, error: null });
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
    expect(batchSend).toHaveBeenCalledTimes(2);
    expect(batchSend.mock.calls[0]![1].idempotencyKey).toBe(batchSend.mock.calls[1]![1].idempotencyKey);
    expect(out.results.map((r) => r.result)).toEqual(['sent', 'sent']);
    expect(out.recipients!.map((r) => r.message_id)).toEqual(['id-a', 'id-b']);
  });

  it('the same batch run twice with the same key sends once', async () => {
    const { delivered, requests } = idempotentProvider();
    await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(5), messageFor });
    await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(5), messageFor });
    expect(requests.map((r) => r.key)).toEqual(['spider-alert:alert-1:0', 'spider-alert:alert-1:0']);
    expect(delivered).toHaveLength(5);
  });

  it('a request that keeps being refused for going over the limit ends as "could not be delivered" for everyone in it', async () => {
    batchSend.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'slow down' } });
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(3), messageFor });
    expect(batchSend).toHaveBeenCalledTimes(1 + 4); // the first try and the shared backoff's four retries
    expect(out.results.map((r) => r.result)).toEqual(['failed', 'failed', 'failed']);
    expect(out.outcome).toBe(EMAIL_OUTCOME.failed);
  }, 15_000);

  // #3471 (#3469's r4 L1): the provider refuses a repeat of a request it is still processing with 409 `concurrent_idempotent_requests`.
  // That is not a failure: the first request may still deliver, so the repeat waits and goes again under the SAME key.
  describe('409 concurrent_idempotent_requests', () => {
    const concurrent = { data: null, error: { name: 'concurrent_idempotent_requests', statusCode: 409, message: 'try again' } };
    afterEach(() => _setConcurrentIdempotentBackoff());

    it('backs off and repeats under the same key until the provider answers: recorded as sent, never as "could not be delivered"', async () => {
      _setConcurrentIdempotentBackoff([5, 5, 5]);
      batchSend
        .mockResolvedValueOnce(concurrent)
        .mockResolvedValueOnce(concurrent)
        .mockResolvedValueOnce({ data: { data: [{ id: 'id-a' }, { id: 'id-b' }] }, error: null });
      const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
      expect(batchSend).toHaveBeenCalledTimes(3);
      expect(new Set(batchSend.mock.calls.map((c) => c[1].idempotencyKey))).toEqual(new Set(['spider-alert:alert-1:0']));
      expect(out.results.map((r) => r.result)).toEqual(['sent', 'sent']);
      expect(out.outcome).toBe(EMAIL_OUTCOME.sent);
    });

    it('waits between the repeats (the waits grow, about the request limit in all), and never sends a second copy', async () => {
      expect(CONCURRENT_IDEMPOTENT_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(SPIDER_EMAIL_REQUEST_LIMIT_MS);
      vi.useFakeTimers();
      try {
        const { delivered } = idempotentProvider();
        const provider = batchSend.getMockImplementation()!;
        batchSend.mockResolvedValueOnce(concurrent).mockImplementation(provider);
        const sending = deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(3), messageFor });
        await vi.advanceTimersByTimeAsync(CONCURRENT_IDEMPOTENT_BACKOFF_MS[0]! - 1);
        expect(batchSend).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(batchSend).toHaveBeenCalledTimes(2);
        const out = await sending;
        expect(out.results.map((r) => r.result)).toEqual(['sent', 'sent', 'sent']);
        expect(delivered).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a repeat with the key used for other content (409 invalid_idempotent_request) is a real refusal: not repeated', async () => {
      batchSend.mockResolvedValue({ data: null, error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'different payload' } });
      const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
      expect(batchSend).toHaveBeenCalledTimes(1);
      expect(out.results.map((r) => r.result)).toEqual(['failed', 'failed']);
    });

    it('an unanswered request, then its repeat refused as concurrent, then answered: sent once (the 10 s give-up and the 409 brake work together)', async () => {
      _setSpiderEmailRequestLimit(50);
      _setConcurrentIdempotentBackoff([5, 5]);
      const { delivered } = idempotentProvider();
      const provider = batchSend.getMockImplementation()!;
      batchSend
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce(concurrent)
        .mockImplementation(provider);
      const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
      expect(batchSend).toHaveBeenCalledTimes(3);
      expect(new Set(batchSend.mock.calls.map((c) => c[1].idempotencyKey))).toEqual(new Set(['spider-alert:alert-1:0']));
      expect(out.results.map((r) => r.result)).toEqual(['sent', 'sent']);
      expect(delivered).toHaveLength(2);
      _setSpiderEmailRequestLimit();
    });
  });

  it('a request that fails as a whole (or throws) records each person as failed, in plain words, with no id', async () => {
    batchSend.mockResolvedValueOnce({ data: null, error: { name: 'application_error', statusCode: 500, message: 'boom from the provider' } });
    const a = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
    batchSend.mockRejectedValueOnce(new Error('socket hang up'));
    const b = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
    for (const out of [a, b]) {
      expect(out.results.map((r) => r.result)).toEqual(['failed', 'failed']);
      expect(out.recipients!.every((r) => r.outcome === EMAIL_OUTCOME.failed && r.message_id === undefined)).toBe(true);
      expect(JSON.stringify(out)).not.toMatch(/boom|socket|resend/i);
    }
  });

  it('a partly accepted request: the refused person is failed, the others keep their own ids', async () => {
    batchSend.mockResolvedValueOnce({ data: { data: [{ id: 'id-0' }, { id: 'id-2' }], errors: [{ index: 1, message: 'invalid address' }] }, error: null });
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(3), messageFor });
    expect(out.results.map((r) => r.result)).toEqual(['sent', 'failed', 'sent']);
    expect(out.recipients!.map((r) => r.message_id)).toEqual(['id-0', undefined, 'id-2']);
  });

  it('keeps the same brakes per person: no address, suppressed, and one request for the rest', async () => {
    idempotentProvider();
    suppressedAmong.mockResolvedValue(new Set(['p1@staff.test']));
    const list = [...people(3), { id: 'noaddr', first_name: 'N', last_name: 'A', email: '  ', phone: null }];
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: list, messageFor });
    expect(out.recipients!.map((r) => r.outcome)).toEqual([EMAIL_OUTCOME.sent, EMAIL_OUTCOME.suppressed, EMAIL_OUTCOME.sent, EMAIL_OUTCOME.noAddress]);
    expect(out.results.map((r) => r.result)).toEqual(['sent', 'skipped', 'sent', 'skipped']);
    expect((batchSend.mock.calls[0]![0] as any[]).map((m) => m.to)).toEqual(['p0@staff.test', 'p2@staff.test']);
  });

  it('GATE: with the company email switch off, or everyone suppressed or without an address, no provider call is made', async () => {
    p.organization.findUnique.mockResolvedValue({ email_sending_enabled: false, name: 'Acme', logo_url: null, brand_color: null, timezone: null });
    const off = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(4), messageFor });
    expect(off.outcome).toBe(EMAIL_OUTCOME.companyOff);
    p.organization.findUnique.mockResolvedValue({ email_sending_enabled: true, name: 'Acme', logo_url: null, brand_color: null, timezone: null });
    suppressedAmong.mockResolvedValue(new Set(people(2).map((r) => r.email!)));
    const suppressed = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
    expect(suppressed.outcome).toBe(EMAIL_OUTCOME.suppressed);
    const none = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2, { email: undefined }), messageFor });
    expect(none.outcome).toBe(EMAIL_OUTCOME.noAddress);
    expect(batchSend).not.toHaveBeenCalled();
  });

  it('a company whose switch cannot be read sends nothing and records not delivered', async () => {
    p.organization.findUnique.mockRejectedValue(new Error('db down'));
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
    expect(batchSend).not.toHaveBeenCalled();
    expect(out.outcome).toBe(EMAIL_OUTCOME.failed);
  });

  it('the idempotency key is made from the record and the chunk', () => {
    expect(spiderBatchIdempotencyKey({ alertId: 'a' }, 2)).toBe('spider-alert:a:2');
    expect(spiderBatchIdempotencyKey({ summaryId: 's' }, 0)).toBe('spider-summary:s:0');
  });

  it("tells each person's answer the moment it is known: the brakes at once, then each request's people as it answers", async () => {
    suppressedAmong.mockResolvedValue(new Set(['p1@staff.test']));
    let answerSecond!: () => void;
    batchSend.mockImplementation(async (payload: { to: string }[], options: { idempotencyKey: string }) => {
      if (options.idempotencyKey.endsWith(':1')) await new Promise<void>((resolve) => (answerSecond = resolve));
      return { data: { data: payload.map((m) => ({ id: `id-${m.to}` })) }, error: null };
    });
    const told: { user_id: string; outcome: string; result: string }[] = [];
    const list = [{ id: 'noaddr', first_name: 'N', last_name: 'A', email: '', phone: null }, ...people(SPIDER_EMAIL_BATCH_SIZE + 6)];
    const sending = deliverSpiderEmailsTo({
      orgId: ORG,
      logKey: KEY,
      recipients: list,
      messageFor,
      onPerson: (x) => told.push({ user_id: x.outcome.user_id, outcome: x.outcome.outcome, result: x.result.result }),
    });
    // The second request is out and unanswered: the brakes' people and the first request's 100 are already told.
    await vi.waitFor(() => expect(batchSend).toHaveBeenCalledTimes(2));
    expect(told.filter((x) => x.result === 'skipped').map((x) => x.user_id).sort()).toEqual(['noaddr', 'u1']);
    expect(told.filter((x) => x.result === 'sent')).toHaveLength(SPIDER_EMAIL_BATCH_SIZE);
    answerSecond();
    const out = await sending;
    expect(told).toHaveLength(list.length);
    // What it told is what it records.
    expect(new Map(told.map((x) => [x.user_id, x.outcome]))).toEqual(new Map(out.recipients!.map((r) => [r.user_id, r.outcome])));
  });
});

describe('an email request that gets no answer (#3469)', () => {
  afterEach(() => {
    _setSpiderEmailRequestLimit();
    vi.useRealTimers();
  });

  it('is given up on after 10 s and sent once more under the same key, which can then answer: recorded as sent, once', async () => {
    vi.useFakeTimers();
    const { delivered } = idempotentProvider();
    const provider = batchSend.getMockImplementation()!;
    // The first request never answers; the retry is answered by the provider as usual.
    batchSend.mockImplementationOnce(() => new Promise(() => undefined));
    batchSend.mockImplementation(provider);
    const sending = deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(3), messageFor });
    await vi.advanceTimersByTimeAsync(SPIDER_EMAIL_REQUEST_LIMIT_MS - 1);
    expect(batchSend).toHaveBeenCalledTimes(1);
    // At the limit the retry goes out, and the provider answers it at once.
    await vi.advanceTimersByTimeAsync(1);
    expect(batchSend).toHaveBeenCalledTimes(2);
    const out = await sending;
    expect(SPIDER_EMAIL_REQUEST_LIMIT_MS).toBe(10_000);
    expect(batchSend.mock.calls.map((c) => c[1].idempotencyKey)).toEqual(['spider-alert:alert-1:0', 'spider-alert:alert-1:0']);
    expect(out.results.map((r) => r.result)).toEqual(['sent', 'sent', 'sent']);
    expect(delivered).toHaveLength(3);
  });

  it('a second request without an answer: never a third; each person recorded "could not be delivered" in the existing words, 2 x the limit after the start', async () => {
    _setSpiderEmailRequestLimit(200);
    batchSend.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const sending = deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(3), messageFor });
    // Just past the first limit the retry is out, under the same key.
    await new Promise((resolve) => setTimeout(resolve, 200 + 100));
    expect(batchSend).toHaveBeenCalledTimes(2);
    const out = await sending;
    const took = Date.now() - started;
    expect(batchSend).toHaveBeenCalledTimes(2);
    expect(batchSend.mock.calls[0]![1].idempotencyKey).toBe(batchSend.mock.calls[1]![1].idempotencyKey);
    expect(took).toBeGreaterThanOrEqual(2 * 200 - 20);
    expect(took).toBeLessThan(2 * 200 + 500);
    expect(out.outcome).toBe(EMAIL_OUTCOME.failed);
    expect(out.results.map((r) => [r.result, r.reason])).toEqual(Array(3).fill(['failed', 'Email delivery failed']));
    expect(out.recipients!.every((r) => r.outcome === EMAIL_OUTCOME.failed && r.message_id === undefined)).toBe(true);
  });

  it('a request that answers within the limit is never sent twice', async () => {
    _setSpiderEmailRequestLimit(200);
    batchSend.mockImplementation(async (payload: { to: string }[]) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { data: { data: payload.map((m) => ({ id: `id-${m.to}` })) }, error: null };
    });
    const out = await deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(2), messageFor });
    expect(batchSend).toHaveBeenCalledTimes(1);
    expect(out.results.map((r) => r.result)).toEqual(['sent', 'sent']);
  });
});

describe('texts: side by side, at most 5 in flight', () => {
  beforeEach(() => {
    _resetCtmSmsDoubleFireGuard();
    client.isCtmConfigured.mockReturnValue(true);
    client.isOutboundAllowed.mockReturnValue(true);
    client.isOptedOut.mockResolvedValue(false);
    p.organization.findUnique.mockResolvedValue({
      ctm_account_id: '111111', ctm_sms_ready: true, sms_sending_enabled: true, plan: 'PRO', trial_ends_at: null, feature_overrides: { phone: true },
    });
    p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  });

  it('6 people: never more than 5 texts in flight, every one counted once the moment it goes out', async () => {
    let inFlight = 0;
    let peak = 0;
    client.sendSms.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { id: 'M' };
    });
    const counted: string[] = [];
    const out = await deliverSpiderTextsTo({
      orgId: ORG, sendKey: 'alert-1', logKey: {}, recipients: people(6), bodyFor: () => 'body',
      onSent: async (r) => void counted.push(r.id),
    });
    expect(SPIDER_TEXTS_IN_FLIGHT).toBe(5);
    expect(peak).toBe(5);
    expect(client.sendSms).toHaveBeenCalledTimes(6);
    expect(out.sent).toBe(6);
    expect(counted.sort()).toEqual(people(6).map((r) => r.id).sort());
    expect(out.recipients!.map((r) => r.user_id)).toEqual(people(6).map((r) => r.id)); // History keeps the list's order
  });

  it('a person listed twice is texted and counted once', async () => {
    client.sendSms.mockResolvedValue({ id: 'M' });
    const onSent = vi.fn().mockResolvedValue(undefined);
    const [a] = people(1);
    const out = await deliverSpiderTextsTo({ orgId: ORG, sendKey: 'alert-1', logKey: {}, recipients: [a!, a!], bodyFor: () => 'b', onSent });
    expect(client.sendSms).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(1);
  });

  it('GATE: a number outside the test list, no phone, and a company with texting off get no provider call, with the same words as before', async () => {
    client.isOutboundAllowed.mockReturnValue(false);
    const gated = await deliverSpiderTextsTo({ orgId: ORG, sendKey: 'k1', logKey: {}, recipients: people(2), bodyFor: () => 'b', onSent: async () => undefined });
    expect(gated.outcome).toBe(TEXT_OUTCOME.testOnly);
    client.isOutboundAllowed.mockReturnValue(true);
    const noPhone = await deliverSpiderTextsTo({ orgId: ORG, sendKey: 'k2', logKey: {}, recipients: people(2, { phone: null }), bodyFor: () => 'b', onSent: async () => undefined });
    expect(noPhone.outcome).toBe(TEXT_OUTCOME.noPhone);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111', ctm_sms_ready: true, sms_sending_enabled: false, plan: 'PRO', trial_ends_at: null, feature_overrides: { phone: true } });
    const off = await deliverSpiderTextsTo({ orgId: ORG, sendKey: 'k3', logKey: {}, recipients: people(2), bodyFor: () => 'b', onSent: async () => undefined });
    expect(off.outcome).toBe(TEXT_OUTCOME.companyOff);
    expect(client.sendSms).not.toHaveBeenCalled();
  });

  it('a text that fails does not stop the others, and is not counted', async () => {
    client.sendSms.mockRejectedValueOnce(new client.CtmApiError(500, 'boom')).mockResolvedValue({ id: 'M' });
    const onSent = vi.fn().mockResolvedValue(undefined);
    const out = await deliverSpiderTextsTo({ orgId: ORG, sendKey: 'k4', logKey: {}, recipients: people(3), bodyFor: () => 'b', onSent });
    expect(out.results.map((r) => r.result).sort()).toEqual(['failed', 'sent', 'sent']);
    expect(onSent).toHaveBeenCalledTimes(2);
  });
});

describe('emails and texts start together', () => {
  it('runTogether starts both before either finishes, waits for both, and raises the first throw after both stopped', async () => {
    const order: string[] = [];
    const slow = async (name: string, ms: number) => {
      order.push(`${name} start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name} end`);
      return name;
    };
    expect(await runTogether(() => slow('email', 30), () => slow('text', 10))).toEqual(['email', 'text']);
    expect(order.slice(0, 2)).toEqual(['email start', 'text start']);
    order.length = 0;
    await expect(runTogether(async () => { throw new Error('first'); }, () => slow('text', 10))).rejects.toThrow('first');
    expect(order).toEqual(['text start', 'text end']);
  });

  it('an email batch and the texts are both in progress at the same time', async () => {
    let emailOpen = false;
    let textsOpen = 0;
    let overlap = false;
    batchSend.mockImplementation(async (payload: { to: string }[]) => {
      emailOpen = true;
      if (textsOpen > 0) overlap = true;
      await new Promise((r) => setTimeout(r, 30));
      emailOpen = false;
      return { data: { data: payload.map((m) => ({ id: `id-${m.to}` })) }, error: null };
    });
    _resetCtmSmsDoubleFireGuard();
    client.isCtmConfigured.mockReturnValue(true);
    client.isOutboundAllowed.mockReturnValue(true);
    client.isOptedOut.mockResolvedValue(false);
    p.organization.findUnique.mockResolvedValue({
      email_sending_enabled: true, name: 'Acme', logo_url: null, brand_color: null, timezone: null,
      ctm_account_id: '111111', ctm_sms_ready: true, sms_sending_enabled: true, plan: 'PRO', trial_ends_at: null, feature_overrides: { phone: true },
    });
    p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
    client.sendSms.mockImplementation(async () => {
      if (emailOpen) overlap = true;
      textsOpen += 1;
      await new Promise((r) => setTimeout(r, 30));
      textsOpen -= 1;
      return { id: 'M' };
    });
    await runTogether(
      () => deliverSpiderEmailsTo({ orgId: ORG, logKey: KEY, recipients: people(3), messageFor }),
      () => deliverSpiderTextsTo({ orgId: ORG, sendKey: 'k5', logKey: {}, recipients: people(3), bodyFor: () => 'b', onSent: async () => undefined }),
    );
    expect(overlap).toBe(true);
  });
});
