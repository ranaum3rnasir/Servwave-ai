/**
 * Web-form lead intake receiver - POST /api/webhooks/web-form/:provider/:urlToken
 *
 * Gates (controllers/web-form-webhook.controller.ts): known provider, enabled row
 * for the token, JSON body, the save-time test probe, at least one contact handle.
 * The 200 goes out before processing. Nothing here ever answers 4xx/5xx to a real
 * submission: this vendor never retries, so a rejected delivery is a destroyed
 * lead rather than a deferred one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { WEB_FORM_MAX_IN_FLIGHT } from '../controllers/web-form-webhook.controller';
import { submissionKey } from '../lib/web-form/process';

const app = express();
app.use('/api/webhooks', webhookRoutes);
// app.ts's terminal error handler, verbatim (app.ts:475-478). It ignores
// err.status and always answers 500, which is what makes a body-parser failure
// on this router a 500 rather than the 413 body-parser raised - the behaviour
// the sibling receivers keep and this one must not.
app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const TOKEN = 'a'.repeat(64);
const ORG_ID = 'b0000000-0000-0000-0000-0000000000bb';
const INTEGRATION = { id: 'wfi-1', organization_id: ORG_ID, field_map: null, default_lead_source: null };

/** A submission as the plugin sends it: flat JSON, slugs with UNDERSCORES. */
const SUBMISSION = {
  name_1: 'Dana',
  name_2: 'Okafor',
  email_1: 'dana.okafor@example.test',
  phone_1: '(609) 555-0123',
  textarea_1: 'Looking for a quote on a new front door.',
  select_1: 'Replacement',
  current_url: 'https://example.test/contact?utm_campaign=spring',
  referer_url: 'https://www.google.com/',
  form_title: 'Request a Quote',
  entry_time: '2026-09-18 09:41:07',
};

function post(opts: { provider?: string; token?: string; body: string; headers?: Record<string, string> }) {
  const provider = opts.provider ?? 'forminator';
  const token = opts.token ?? TOKEN;
  let r = request(app)
    .post(`/api/webhooks/web-form/${provider}/${token}`)
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(opts.headers ?? {})) r = r.set(k, v);
  return r.send(opts.body);
}

/** Let the post-ack setImmediate continuation settle. */
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

beforeEach(() => {
  vi.clearAllMocks();
  p.webFormIntegration.findFirst.mockResolvedValue(INTEGRATION);
  p.webFormIntegration.update.mockResolvedValue({});
  p.webFormSubmission.create.mockResolvedValue({ id: 'wfs-1' });
});

describe('web-form webhook gates', () => {
  it('404s an unknown provider before touching the database', async () => {
    const res = await post({ provider: 'typeform', body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(p.webFormIntegration.findFirst).not.toHaveBeenCalled();
  });

  it('404s a token that resolves no enabled row (query is provider + token + enabled)', async () => {
    p.webFormIntegration.findFirst.mockResolvedValue(null);
    const res = await post({ token: 'b'.repeat(64), body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(404);
    expect(p.webFormIntegration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url_token: 'b'.repeat(64), provider: 'forminator', enabled: true } }),
    );
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
  });

  it('answers an unknown provider, an unknown token and a disabled row identically, so the token space cannot be probed', async () => {
    const unknownProvider = await post({ provider: 'typeform', body: JSON.stringify(SUBMISSION) });
    // A disabled row and a token nobody owns both resolve nothing: the WHERE
    // carries `enabled: true`, so the controller cannot tell them apart either.
    p.webFormIntegration.findFirst.mockResolvedValue(null);
    const unknownToken = await post({ token: 'c'.repeat(64), body: JSON.stringify(SUBMISSION) });

    expect(unknownProvider.status).toBe(unknownToken.status);
    expect(unknownProvider.text).toBe(unknownToken.text);
  });

  it('404s an oversized token without querying for it', async () => {
    const res = await post({ token: 'd'.repeat(129), body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(404);
    expect(p.webFormIntegration.findFirst).not.toHaveBeenCalled();
  });

  it('202s a malformed body with a warning, never a 4xx, and stores nothing', async () => {
    const res = await post({ body: '{not json' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'malformed' });
    expect(logger.warn).toHaveBeenCalled();
    await flush();
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
    expect(p.webFormIntegration.update).not.toHaveBeenCalled();
  });

  it('202s valid JSON that is not a submission object, and says so separately from the handle gate', async () => {
    const res = await post({ body: JSON.stringify([{ phone_1: '609-555-0123' }]) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'malformed' });
    await flush();
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
  });

  it('202s a submission with neither phone nor email and stores nothing', async () => {
    const res = await post({
      body: JSON.stringify({ form_title: 'Request a Quote', name_1: 'Dana', textarea_1: 'call me' }),
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'no_contact' });
    expect(logger.warn).toHaveBeenCalled();
    await flush();
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
  });

  it('keeps a submission that carries only an email, and one that carries only a phone', async () => {
    const emailOnly = await post({ body: JSON.stringify({ form_title: 'F', email_1: 'dana@example.test' }) });
    expect(emailOnly.status).toBe(200);
    const phoneOnly = await post({ body: JSON.stringify({ form_title: 'F', phone_1: '609-555-0123' }) });
    expect(phoneOnly.status).toBe(200);
    await flush();
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(2);
  });

  it('202s a phone that does not normalise when nothing else can be contacted', async () => {
    // A handle we cannot dial is not a lead. The gate is "normalisable phone OR
    // plausible email", not "the phone key was present".
    const res = await post({ body: JSON.stringify({ form_title: 'F', phone_1: '12', email_1: 'not-an-email' }) });
    expect(res.status).toBe(202);
    expect(res.body.ignored).toBe('no_contact');
  });
});

describe('nothing before the ack may leave the plugin unanswered', () => {
  it('202s a transient failure of the integration lookup itself, and logs it', async () => {
    // Every gate above answers deliberately. This is the general case: ANY throw
    // ahead of the ack used to escape as a rejected promise Express 4 does not
    // adopt, so the plugin sat on its 5s timeout and got nothing - a destroyed
    // lead nobody is told about, for a DB blip that lasted one request.
    p.webFormIntegration.findFirst.mockRejectedValue(new Error('connection reset by peer'));

    const res = await post({ body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'error' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[web-form]'));
  });

  it('keeps the submitted values out of that failure line, the one place a throw could leak them', async () => {
    // The receiver's standing promise is that it never logs a phone number, an
    // email address or a submitted name.
    p.webFormIntegration.findFirst.mockRejectedValue(new Error('connection reset by peer'));
    await post({ body: JSON.stringify(SUBMISSION) });

    const line = (logger.error as any).mock.calls[0][0] as string;
    expect(line).not.toContain('6095550123');
    expect(line).not.toContain('555-0123');
    expect(line).not.toContain('dana.okafor@example.test');
    expect(line).not.toContain('Okafor');
  });

  it('answers a body crafted to blow the stack inside the parse', async () => {
    // ~10KB, far under any body-size limit, and the reason the adapter caps its
    // own recursion. Pinned HERE as well as in the adapter's own suite because
    // what the finding was actually about is the RESPONSE: a 2xx and a log line,
    // never silence.
    let nested = '"6095550123"';
    for (let i = 0; i < 5000; i++) nested = `[${nested}]`;

    const res = await post({ body: `{"form_title":"F","phone_1":${nested}}` });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('a delivery the body parser cannot read', () => {
  /** A valid submission padded to `bytes`, so only the SIZE is ever the reason. */
  const padded = (bytes: number) =>
    JSON.stringify({ form_title: 'F', phone_1: '(609) 555-0123', textarea_1: 'x'.repeat(bytes) });

  it('reads a body far past body-parser\'s 100KB default, which nothing said this route was under', async () => {
    // /api/webhooks mounts twelve lines BEFORE the app-level
    // express.json({ limit: '1mb' }), so this route never saw that ceiling and
    // silently ran on the 100KB default instead - tighter than the rest of the
    // app, undocumented, and fatal rather than deferring.
    const res = await post({ body: padded(200_000) });
    expect(res.status).toBe(200);
    await flush();
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
  });

  it('202s a body past even the explicit limit instead of 500ing the lead away', async () => {
    const res = await post({ body: padded(1_500_000) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'unreadable' });
    expect(logger.warn).toHaveBeenCalled();
    await flush();
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
  });

  it('202s a delivery whose Content-Encoding lies', async () => {
    const res = await post({
      headers: { 'Content-Encoding': 'gzip' },
      body: JSON.stringify(SUBMISSION),
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'unreadable' });
  });

  it('leaves the three other receivers on this router answering exactly as before', async () => {
    // Different vendors, different retry semantics: Stripe, the phone system and
    // the email service all retry, so a 500 there is the CORRECT answer and
    // makes the delivery come back. Only the web-form route may swallow one.
    for (const path of ['/api/webhooks/stripe', '/api/webhooks/resend', '/api/webhooks/ctm/1']) {
      const res = await request(app)
        .post(path)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ padding: 'x'.repeat(200_000) }));
      expect({ path, status: res.status, body: res.body }).toEqual({
        path,
        status: 500,
        body: { error: 'Internal server error' },
      });
    }
  });
});

describe('web-form webhook processing (after the ack)', () => {
  it('acks a real submission 200 and then records it in the ledger with the normalised fields', async () => {
    const res = await post({ body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await flush();
    expect(p.webFormIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wfi-1' }, data: { last_event_at: expect.any(Date) } }),
    );
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
    const data = p.webFormSubmission.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organization_id: ORG_ID,
      provider: 'forminator',
      form_title: 'Request a Quote',
      payload: SUBMISSION,
    });
    expect(typeof data.submission_key).toBe('string');
    expect(data.submission_key.length).toBeGreaterThan(0);
  });

  it('answers 200 without waiting for the work, so the visitor never sits on the plugin\'s 5s timeout', async () => {
    // A ledger write that never settles. If the response waited on the
    // continuation at all, this request could not come back.
    let release!: () => void;
    p.webFormSubmission.create.mockReturnValue(new Promise((r) => { release = () => r({ id: 'wfs-1' }); }));

    const res = await post({ body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    release();
    await flush();
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
  });

  it('strips the NUL byte Postgres accepts in neither text nor jsonb, from keys as well as values', async () => {
    // Verified against PostgreSQL 16: a real NUL in a text column and a real NUL
    // in a jsonb string are both `null character not permitted`, and the
    // six-character JSON escape the driver actually sends for one is
    // `unsupported Unicode escape sequence`.
    //
    // Unstripped, the 200 goes out and the INSERT then throws:
    // no ledger row, no Customer, no Lead, one generic failure line. Total
    // silent loss on a vendor that never resends.
    //
    // A raw NUL cannot survive JSON.parse, so the escape is the whole attack.
    const res = await post({
      body: '{"form_title":"F\\u0000orm","name_1":"Da\\u0000na","phone_1":"6095550123","ex\\u0000tra":"v\\u0000al"}',
    });
    expect(res.status).toBe(200);
    await flush();

    const data = p.webFormSubmission.create.mock.calls[0][0].data;
    expect(JSON.stringify(data)).not.toContain('\\u0000');
    expect(data.form_title).toBe('Form');
    expect(Object.keys(data.payload)).toContain('extra');
  });

  it("carries the org's own field_map through to the adapter, the whole answer to slug drift", async () => {
    // `field_map` is the only thing an operator can change WITHOUT a deploy, and
    // the only answer to the plugin's positional slugs: `select_1` and `text_1`
    // carry the plugin's DEFAULT labels, so the agency reordering a form changes
    // what they mean without changing their name. Nothing pinned that the column
    // was actually wired through - dropping the argument from the
    // parseWebFormSubmission call left every other test in this branch green.
    p.webFormIntegration.findFirst.mockResolvedValue({ ...INTEGRATION, field_map: { text_2: 'phone' } });

    // A slug the DEFAULT map has never heard of, carrying the ONLY contact
    // handle in the payload. Unmapped this is a no_contact 202 storing nothing;
    // mapped it is a lead. Nothing else can make the difference.
    const res = await post({ body: JSON.stringify({ form_title: 'Request a Quote', text_2: '(609) 555-0123' }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await flush();
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
  });

  it('records the submission even when the cosmetic last_event_at stamp fails', async () => {
    // `last_event_at` is a dashboard nicety; the ledger row is the payload
    // archive and the only thing a human could recover a lost lead from. Awaited
    // first inside the same try, one transient connection reset took the claim
    // insert, the Customer and the Lead with it - after a 200 had already gone
    // out to a vendor that never resends.
    p.webFormIntegration.update.mockRejectedValue(new Error('connection reset by peer'));

    const res = await post({ body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(200);

    await flush();
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
  });

  it('a duplicate submission key leaves one ledger row and never throws', async () => {
    p.webFormSubmission.create
      .mockResolvedValueOnce({ id: 'wfs-1' })
      .mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: 'P2002' }));

    const first = await post({ body: JSON.stringify(SUBMISSION) });
    const second = await post({ body: JSON.stringify(SUBMISSION) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    await flush();
    // Two claims attempted, one row: the unique index is the lock, and the
    // loser is swallowed rather than logged as a failure.
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('derives the same key for the same submission inside one minute, and a different one per contact', async () => {
    await post({ body: JSON.stringify(SUBMISSION) });
    await post({ body: JSON.stringify(SUBMISSION) });
    await post({ body: JSON.stringify({ ...SUBMISSION, phone_1: '(609) 555-0199', email_1: 'other@example.test' }) });
    await flush();

    const keys = p.webFormSubmission.create.mock.calls.map((c: any) => c[0].data.submission_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('uses the vendor entry id as the key when the payload carries one', async () => {
    await post({ body: JSON.stringify({ ...SUBMISSION, entry_id: '4471023' }) });
    await flush();
    expect(p.webFormSubmission.create.mock.calls[0][0].data.submission_key).toBe('4471023');
  });

  it('a processing failure is logged and never changes the response already sent', async () => {
    p.webFormSubmission.create.mockRejectedValue(new Error('db down'));
    const res = await post({ body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(200);
    await flush();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('processing failed'));
    // No phone number, email address or name in the log line.
    const line = (logger.error as any).mock.calls[0][0] as string;
    expect(line).not.toContain('6095550123');
    expect(line).not.toContain('555-0123');
    expect(line).not.toContain('dana.okafor@example.test');
    expect(line).not.toContain('Okafor');
  });
});

describe('the idempotency window', () => {
  it('is ONE MINUTE, the double-click it exists for and nothing wider', () => {
    // Not driven through the router: `receivedAt` is the server's own clock and
    // not an input, so the window can only be pinned by varying it directly.
    //
    // The derivation is DELIBERATELY IMPERFECT and process.ts says so - the
    // vendor never retries, so there is no re-delivery to collapse, and under
    // §3d.4 a second submission is a legitimate second lead. The only thing this
    // key may catch is one submission arriving twice inside a minute, which is a
    // double-click. The comment there says widening it "would start silently
    // swallowing real leads"; widening 60_000 to an hour left every test green.
    const event = {
      provider: 'forminator' as const,
      vendorSubmissionId: null,
      formTitle: 'Request a Quote',
      firstName: 'Dana',
      lastName: 'Okafor',
      phone: '+16095550123',
      email: 'dana.okafor@example.test',
      message: null,
      selection: null,
      landingPageUrl: null,
      referringUrl: null,
      trackingParams: {},
      submittedAt: new Date(),
      extras: {},
    };

    const onTheMinute = new Date('2026-09-18T09:41:00.000Z');
    const at = (ms: number) => submissionKey(event, new Date(onTheMinute.getTime() + ms));

    // The whole minute is one key: a double-click 59.999s later is collapsed.
    expect(at(59_999)).toBe(at(0));
    // The very next millisecond is a new one: a real second lead survives.
    expect(at(60_000)).not.toBe(at(0));
  });
});

describe('the post-ack work is bounded', () => {
  it('acks everything, but past a fixed high-water mark drops the overflow LOUDLY', async () => {
    // NOTHING rate-limits this endpoint: /api/webhooks mounts at app.ts:103,
    // before the global limiter at :129. Each accepted POST scheduled a
    // setImmediate with no queue and no cap, and each of those opens a
    // transaction that takes an exclusive lock on the org's `organizations` row
    // TWICE via allocateNumber, while holding a connection from the
    // process-wide Prisma pool EVERY TENANT SHARES. Enough concurrent posts to
    // one leaked URL and other organizations' queries fail on pool timeout, so
    // the blast radius was cross-tenant rather than confined to the token's org.
    //
    // The answer is not the existing limiter - a 429 destroys a real lead. Ack
    // always; bound what happens afterwards. Under a flood the flooded org
    // loses its own overflow, and every other tenant keeps the API.
    expect(WEB_FORM_MAX_IN_FLIGHT).toBe(50);

    let release!: () => void;
    const held = new Promise((r) => {
      release = () => r({ id: 'wfs-1' });
    });
    p.webFormSubmission.create.mockReturnValue(held);

    const statuses: number[] = [];
    for (let i = 0; i < WEB_FORM_MAX_IN_FLIGHT + 5; i++) {
      const res = await post({
        body: JSON.stringify({ ...SUBMISSION, phone_1: `(609) 555-${String(1000 + i)}` }),
      });
      statuses.push(res.status);
    }

    const accepted = p.webFormSubmission.create.mock.calls.length;
    const errors = (logger.error as any).mock.calls.map((c: any[]) => c[0]);

    // Released BEFORE the assertions: the counter is module state, so a failing
    // assertion here would otherwise leave 50 slots held and silently break
    // every later test in this file.
    release();
    await flush();
    await flush();

    // Every single delivery was still acked. That rule has no exceptions.
    expect(statuses).toEqual(Array(WEB_FORM_MAX_IN_FLIGHT + 5).fill(200));
    expect(accepted).toBe(WEB_FORM_MAX_IN_FLIGHT);
    // An ERROR, not an info: a dropped submission is a lost lead and the log
    // line is the only alarm anyone gets.
    expect(errors.some((line: string) => line.includes('[web-form]'))).toBe(true);

    // And the counter drains, so a burst cannot wedge the receiver for good.
    p.webFormSubmission.create.mockResolvedValue({ id: 'wfs-2' });
    await post({ body: JSON.stringify(SUBMISSION) });
    await flush();
    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(WEB_FORM_MAX_IN_FLIGHT + 1);
  });
});

describe('web-form webhook save-time test request', () => {
  it('200s X-Hook-Test, stamps last_event_at and creates no ledger row', async () => {
    // The agency pressing Save in the plugin. The probe's values are field
    // LABELS, so storing it would open a lead called "First Name"; a non-2xx
    // would stop them saving the integration at all.
    const res = await post({
      headers: { 'X-Hook-Test': 'true' },
      body: JSON.stringify({ name_1: 'First Name', email_1: 'Email Address', phone_1: 'Phone Number' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });

    await flush();
    expect(p.webFormIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wfi-1' }, data: { last_event_at: expect.any(Date) } }),
    );
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
  });

  it('keeps the 200 when the probe\'s stamp fails, so the agency can still press Save', async () => {
    // Same reasoning as the real-submission path: the stamp is cosmetic. Here a
    // non-2xx would block the agency saving the integration at all.
    p.webFormIntegration.update.mockRejectedValue(new Error('connection reset by peer'));

    const res = await post({ headers: { 'X-Hook-Test': 'true' }, body: JSON.stringify(SUBMISSION) });
    expect(res.status).toBe(200);

    await flush();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('last_event_at'));
  });

  it('treats any non-empty header value other than false/0 as a test', async () => {
    for (const value of ['true', '1', 'yes', 'TRUE']) {
      vi.clearAllMocks();
      p.webFormIntegration.findFirst.mockResolvedValue(INTEGRATION);
      const res = await post({ headers: { 'X-Hook-Test': value }, body: JSON.stringify(SUBMISSION) });
      await flush();
      expect(res.status).toBe(200);
      expect(p.webFormSubmission.create).not.toHaveBeenCalled();
    }
  });

  it('treats X-Hook-Test: false as a real submission, so a live lead is never silently dropped', async () => {
    for (const value of ['false', '0', '']) {
      vi.clearAllMocks();
      p.webFormIntegration.findFirst.mockResolvedValue(INTEGRATION);
      p.webFormSubmission.create.mockResolvedValue({ id: 'wfs-1' });
      const res = await post({ headers: { 'X-Hook-Test': value }, body: JSON.stringify(SUBMISSION) });
      await flush();
      expect(res.status).toBe(200);
      expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
    }
  });
});
