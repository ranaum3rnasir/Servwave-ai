/* =============================================================================
   Spider emails and the provider's delivery events (#2997).

   Every Spider email keeps the provider's id for that one person's email on the record it belongs to
   (a lead's alert or a starting summary), and the provider's later events about it reach that record
   through the REAL delivery webhook route (POST /api/webhooks/resend) with its real signature check.
   A bounce, a failure or a suppression shows in the History tab as the existing failed outcome;
   nothing turns it back into "sent".

   Real app, real migrated database (TEST_DATABASE_URL), the real sweep. The email provider is
   replaced at the HTTP edge only (its API answers with a fresh id per email); the webhook signing
   secret and the provider key are made at run time. Skips when TEST_DATABASE_URL is unset. Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

const { realClient, SECRET_BYTES, PROVIDER_KEY } = vi.hoisted(() => {
  const { randomBytes } = require('crypto') as typeof import('crypto');
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    SECRET_BYTES: randomBytes(24),
    PROVIDER_KEY: `re_${randomBytes(12).toString('hex')}`,
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The shared test env, plus the provider key (so the real email client exists), the webhook secret
// and the test database. Both secrets are made at run time above.
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL,
      EMAIL_FROM: 'no-reply@test.com',
      EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
      RESEND_API_KEY: PROVIDER_KEY,
      RESEND_WEBHOOK_SECRET: `whsec_${SECRET_BYTES.toString('base64')}`,
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});

// setup.ts replaces the email module; the real one runs here, down to its HTTP call.
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { switchFixture, type Person } from './permission-switches-fixture';
import { runSpiderSweep } from '../services/spider/sweep';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const STATUS = '/api/ai-farm/spider/status';
const HISTORY = '/api/ai-farm/spider/history';
const WEBHOOK = '/api/webhooks/resend';
const EVENT_PREFIX = 'se2997-';
const HOUR = 3_600_000;

/** One email the provider's HTTP API was asked to send, and the id it answered with. */
interface ProviderSend {
  id: string;
  to: string;
  tags: { name: string; value: string }[];
}

suite('Spider emails and their delivery events (real app, real database, real webhook route)', () => {
  const db = realClient as PrismaClient;
  let app: Parameters<typeof request>[0];
  const fx = switchFixture(db, async () => app);
  const sends: ProviderSend[] = [];
  const unknownIdWarnings = () =>
    vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('unknown provider_message_id'));

  beforeAll(async () => {
    app = (await import('../app.js')).default as never;
    // The provider's HTTP edge: each send gets its own id; any other request goes out untouched.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith('https://api.resend.com/emails')) return realFetch(input, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const id = randomUUID();
      sends.push({ id, to: Array.isArray(body.to) ? body.to[0] : body.to, tags: body.tags ?? [] });
      return new Response(JSON.stringify({ id }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }, 120_000);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  afterAll(async () => {
    await db.resendEvent.deleteMany({ where: { resend_event_id: { startsWith: EVENT_PREFIX } } }).catch(() => undefined);
    await fx.cleanup();
  });

  // ─── Fixtures ──────────────────────────────────────────────────────────────

  /** A Spider company (Scale, demo) that may email, with `admins` Admins in all. */
  async function spiderCompany(admins = 1) {
    const o = await fx.newOrg();
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true, email_sending_enabled: true } });
    const people: Person[] = [o.admin];
    for (let i = 1; i < admins; i += 1) people.push(await fx.addUser(o.org, `admin${i}`, 'ADMIN'));
    const api = await fx.signedInAs(o.admin);
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    const saved = await api.put(SETTINGS, {
      status_limits: {
        NEW: { enabled: true, value: 2, unit: 'HOUR' },
        CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
        WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
      },
      channels: { in_app: false, red_frame: false, email: true, text: false },
      recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
      watch_all_leads: true,
      selected_lead_ids: [],
    });
    expect(saved.status).toBe(200);
    return { ...o, people };
  }
  type Company = Awaited<ReturnType<typeof spiderCompany>>;

  /** A lead that crosses its 2-hour limit after Spider was switched on: the sweep alerts it on its own. */
  async function perLeadAlert(c: Company) {
    const lead = await fx.addLead(c.org, c.customer);
    const now = Date.now();
    // The switch-on's starting summary first: nothing is overdue yet, so it reports nothing.
    await runSpiderSweep(new Date(now + 15 * 60_000));
    const before = sends.length;
    expect((await runSpiderSweep(new Date(now + 3 * HOUR))).ran).toBe(true);
    const alert = await db.spiderAlert.findFirstOrThrow({ where: { organization_id: c.org, lead_id: lead.id } });
    expect(alert.kind).toBe('ALERTED');
    return { alert, sent: sends.slice(before).filter((s) => c.people.some((p) => p.email === s.to)) };
  }

  /** A lead already past its limit when Spider was switched on: it goes into the starting summary. */
  async function summarizedLead(c: Company) {
    const lead = await fx.addLead(c.org, c.customer);
    await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - 5 * HOUR) } });
    const before = sends.length;
    expect((await runSpiderSweep(new Date(Date.now() + 15 * 60_000))).ran).toBe(true);
    const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org, status: 'READY' } });
    const alert = await db.spiderAlert.findFirstOrThrow({ where: { organization_id: c.org, lead_id: lead.id } });
    expect(alert.kind).toBe('SUMMARIZED');
    return { summary, alert, sent: sends.slice(before).filter((s) => c.people.some((p) => p.email === s.to)) };
  }

  const emailRecipients = (delivery: unknown) =>
    (delivery as { email: { recipients: { user_id: string; outcome: string; message_id?: string }[] } }).email.recipients;

  /** The standard signature a delivery webhook carries: HMAC-SHA256 of `id.timestamp.body` under the shared secret. */
  function signed(svixId: string, body: string, secret: Buffer = SECRET_BYTES) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  }

  type EventType =
    | 'email.sent' | 'email.delivered' | 'email.delivery_delayed' | 'email.bounced' | 'email.failed'
    | 'email.suppressed' | 'email.complained' | 'email.opened' | 'email.clicked';

  /** One provider event about one email, as the provider sends it: the email's id, its recipients and the send's tags. */
  function providerEvent(type: EventType, email: { id: string; to: string; tags?: unknown }) {
    const data: Record<string, unknown> = {
      created_at: new Date().toISOString(),
      email_id: email.id,
      from: 'ServWave Spider Alerts <alerts@spider.servwave.com>',
      to: [email.to],
      subject: 'Spider Alert',
      ...(email.tags === undefined ? {} : { tags: email.tags }),
    };
    if (type === 'email.bounced') data.bounce = { message: 'Mailbox does not exist', subType: 'General', type: 'Permanent' };
    if (type === 'email.failed') data.failed = { reason: 'provider says no' };
    if (type === 'email.suppressed') data.suppressed = { message: 'on the suppression list', type: 'OnAccountSuppressionList' };
    return { type, created_at: new Date().toISOString(), data };
  }

  /** The tags as a delivery event carries them back: { name: value }. */
  const eventTags = (s: ProviderSend) => Object.fromEntries(s.tags.map((t) => [t.name, t.value]));

  async function post(event: object, opts: { secret?: Buffer; unsigned?: boolean } = {}) {
    const body = JSON.stringify(event);
    const svixId = `${EVENT_PREFIX}${randomUUID()}`;
    let req = request(app).post(WEBHOOK).set('Content-Type', 'application/json');
    if (!opts.unsigned) {
      for (const [k, v] of Object.entries(signed(svixId, body, opts.secret))) req = req.set(k, v);
    }
    return req.send(body);
  }

  async function historyRow(c: Company, alertId: string) {
    const res = await (await fx.signedInAs(c.admin)).get(HISTORY);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === alertId);
    expect(row).toBeDefined();
    return { row, raw: JSON.stringify(res.body) };
  }

  // ─── The journey ───────────────────────────────────────────────────────────

  it('journey: Spider emails an alert, the provider reports it sent and then bounced, and the History tab shows it failed, in plain words', async () => {
    const c = await spiderCompany();
    const { alert, sent } = await perLeadAlert(c);
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email.to).toBe(c.admin.email);
    expect(email.tags).toEqual([{ name: 'spider_alert_id', value: alert.id }]);
    expect(emailRecipients(alert.delivery)).toEqual([{ user_id: c.admin.id, outcome: 'Email sent', message_id: email.id }]);

    const before = await historyRow(c, alert.id);
    expect(before.row).toMatchObject({ outcome: 'SENT', outcomes: { email: { status: 'SENT', sent: 1, failed: 0 } } });

    expect((await post(providerEvent('email.sent', { ...email, tags: eventTags(email) }))).status).toBe(200);
    expect((await post(providerEvent('email.bounced', { ...email, tags: eventTags(email) }))).status).toBe(200);
    // The provider's events were Spider's: no "unknown id" line for either.
    expect(unknownIdWarnings()).toEqual([]);

    const after = await historyRow(c, alert.id);
    expect(after.row).toMatchObject({
      outcome: 'FAILED',
      outcomes: { email: { enabled: true, status: 'FAILED', sent: 0, failed: 1, error: 'Email delivery failed' } },
      recipients: [{ id: c.admin.id, email_outcome: 'Email could not be delivered' }],
      channels: { email: 'Email could not be delivered' },
    });
    // Our own fixed words: never the provider's bounce text, its name, or the email's id.
    expect(after.raw).not.toMatch(/resend|mailbox does not exist/i);
    expect(after.raw).not.toContain(email.id);

    // A late "delivered" never turns the bounce back into success.
    expect((await post(providerEvent('email.delivered', { ...email, tags: eventTags(email) }))).status).toBe(200);
    expect((await historyRow(c, alert.id)).row).toMatchObject({
      outcome: 'FAILED',
      outcomes: { email: { status: 'FAILED', sent: 0, failed: 1 } },
      recipients: [{ id: c.admin.id, email_outcome: 'Email could not be delivered' }],
      channels: { email: 'Email could not be delivered' },
    });
    expect(unknownIdWarnings()).toEqual([]);
  });

  // ─── Both lanes: one id per person ─────────────────────────────────────────

  it.each([
    ['a per-lead alert', 'alert'],
    ['a starting summary', 'summary'],
  ] as const)('%s sent to 3 people keeps 3 ids, one per email, each on its own person and tagged with its record', async (_name, lane) => {
    const c = await spiderCompany(3);
    const made = lane === 'alert' ? await perLeadAlert(c) : await summarizedLead(c);
    const record =
      lane === 'alert'
        ? { delivery: made.alert.delivery, tag: { name: 'spider_alert_id', value: made.alert.id } }
        : { delivery: (made as Awaited<ReturnType<typeof summarizedLead>>).summary.delivery,
            tag: { name: 'spider_summary_id', value: (made as Awaited<ReturnType<typeof summarizedLead>>).summary.id } };
    expect(made.sent).toHaveLength(3);
    for (const s of made.sent) expect(s.tags).toEqual([record.tag]);
    const stored = emailRecipients(record.delivery);
    expect(stored).toHaveLength(3);
    const idOf = new Map(c.people.map((p) => [p.id, made.sent.find((s) => s.to === p.email)!.id]));
    expect(new Set(idOf.values()).size).toBe(3);
    for (const entry of stored) expect(entry).toEqual({ user_id: entry.user_id, outcome: 'Email sent', message_id: idOf.get(entry.user_id) });
  });

  it("a bounce of one person's starting summary marks their summary email failed and shows on every summarized lead it told them about", async () => {
    const c = await spiderCompany(3);
    const { summary, alert, sent } = await summarizedLead(c);
    const bounced = sent.find((s) => s.to === c.people[1].email)!;
    expect((await post(providerEvent('email.bounced', { ...bounced, tags: eventTags(bounced) }))).status).toBe(200);
    expect(unknownIdWarnings()).toEqual([]);

    const after = await db.spiderSummary.findUniqueOrThrow({ where: { id: summary.id } });
    expect((after.delivery as { email: { outcome: string } }).email.outcome).toBe('Email sent (2 of 3)');
    expect(emailRecipients(after.delivery).find((r) => r.user_id === c.people[1].id)?.outcome).toBe('Email could not be delivered');
    expect(emailRecipients(after.delivery).filter((r) => r.outcome === 'Email sent')).toHaveLength(2);

    const { row, raw } = await historyRow(c, alert.id);
    expect(row).toMatchObject({
      in_starting_summary: true,
      outcome: 'PARTIAL',
      outcomes: { email: { status: 'SENT', sent: 2, failed: 1, error: 'Email delivery failed' } },
    });
    expect(raw).not.toMatch(/resend|mailbox does not exist/i);
  });

  // ─── Each event, and each order ────────────────────────────────────────────

  it.each([
    [['email.sent', 'email.delivered'], 'SENT'],
    [['email.delivery_delayed', 'email.delivered'], 'SENT'],
    [['email.complained'], 'SENT'],
    [['email.opened', 'email.clicked'], 'SENT'],
    [['email.bounced'], 'FAILED'],
    [['email.failed'], 'FAILED'],
    [['email.suppressed'], 'FAILED'],
    [['email.bounced', 'email.delivered'], 'FAILED'],
    [['email.delivered', 'email.bounced'], 'FAILED'],
    [['email.bounced', 'email.failed', 'email.bounced'], 'FAILED'],
  ] as const)('events %j leave the email %s', async (events, expected) => {
    const c = await spiderCompany();
    const { alert, sent } = await perLeadAlert(c);
    const [email] = sent;
    for (const type of events) expect((await post(providerEvent(type, { ...email, tags: eventTags(email) }))).status).toBe(200);
    expect(unknownIdWarnings()).toEqual([]);
    const { row } = await historyRow(c, alert.id);
    // A failure is counted once, however many failure events arrive.
    expect(row.outcomes.email).toMatchObject(
      expected === 'FAILED' ? { status: 'FAILED', sent: 0, failed: 1 } : { status: 'SENT', sent: 1, failed: 0 },
    );
  });

  it('reads the tags in either shape the provider may send them ({name: value} or [{name, value}])', async () => {
    const c = await spiderCompany();
    const { alert, sent } = await perLeadAlert(c);
    const [email] = sent;
    expect((await post(providerEvent('email.bounced', { ...email, tags: email.tags }))).status).toBe(200);
    expect((await historyRow(c, alert.id)).row.outcomes.email).toMatchObject({ status: 'FAILED' });
  });

  // ─── Scope: only the record that holds the id ──────────────────────────────

  it("an event changes only the record that holds its email's id: never another company's, whatever its tags say", async () => {
    const a = await spiderCompany();
    const b = await spiderCompany();
    const fromA = await perLeadAlert(a);
    const fromB = await perLeadAlert(b);
    const [emailA] = fromA.sent;
    const [emailB] = fromB.sent;
    const snapshot = async () =>
      db.spiderAlert.findMany({ where: { id: { in: [fromA.alert.id, fromB.alert.id] } }, select: { id: true, delivery: true, channels: true }, orderBy: { id: 'asc' } });
    const before = await snapshot();

    // A's email id with B's record named in the tags, A's id with no tags, and A's tags with an id no record holds.
    for (const event of [
      providerEvent('email.bounced', { ...emailA, tags: eventTags(emailB) }),
      providerEvent('email.bounced', { id: emailA.id, to: emailA.to }),
      providerEvent('email.bounced', { id: randomUUID(), to: emailA.to, tags: eventTags(emailA) }),
    ]) {
      expect((await post(event)).status).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
    // None of them is Spider's, so each keeps today's handling of an unknown id.
    expect(unknownIdWarnings()).toHaveLength(3);
  });

  it('an event for an id that is neither a business email nor Spider\'s keeps today\'s handling: acknowledged, recorded, and logged as unknown', async () => {
    const id = randomUUID();
    const res = await post(providerEvent('email.bounced', { id, to: 'someone@example.test' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(unknownIdWarnings()).toEqual([`[resend-webhook] email.bounced for unknown provider_message_id ${id} — recorded, ignored`]);
  });

  it('keeps the signature check exactly as it is: an unsigned or wrongly signed event changes nothing', async () => {
    const c = await spiderCompany();
    const { alert, sent } = await perLeadAlert(c);
    const [email] = sent;
    const event = providerEvent('email.bounced', { ...email, tags: eventTags(email) });
    expect((await post(event, { unsigned: true })).status).toBe(401);
    expect((await post(event, { secret: Buffer.from(randomUUID()) })).status).toBe(401);
    expect((await historyRow(c, alert.id)).row.outcomes.email).toMatchObject({ status: 'SENT', sent: 1, failed: 0 });
  });

  // ─── A bounce that arrives before the sweep wrote its delivery ─────────────

  it('a failure that arrives before the record wrote its email delivery is refused for a retry, and applies once the delivery is written', async () => {
    const c = await spiderCompany();
    const { alert, sent } = await perLeadAlert(c);
    const [email] = sent;
    const written = { delivery: alert.delivery as object, channels: alert.channels as object };
    // As the record stands while the sweep is still sending: claimed, nothing recorded yet.
    await db.spiderAlert.update({ where: { id: alert.id }, data: { delivery: {}, channels: {} } });

    const bounce = providerEvent('email.bounced', { ...email, tags: eventTags(email) });
    const body = JSON.stringify(bounce);
    const svixId = `${EVENT_PREFIX}${randomUUID()}`;
    const send = () => {
      let req = request(app).post(WEBHOOK).set('Content-Type', 'application/json');
      for (const [k, v] of Object.entries(signed(svixId, body))) req = req.set(k, v);
      return req.send(body);
    };
    // "sent" is acknowledged with no change; the bounce is refused so the provider sends it again.
    expect((await post(providerEvent('email.sent', { ...email, tags: eventTags(email) }))).status).toBe(200);
    expect((await send()).status).toBe(500);
    expect(await db.resendEvent.count({ where: { resend_event_id: svixId } })).toBe(0);

    // The sweep writes the delivery; the provider's retry (the same event id) now applies.
    await db.spiderAlert.update({ where: { id: alert.id }, data: written });
    expect((await send()).status).toBe(200);
    expect((await historyRow(c, alert.id)).row.outcomes.email).toMatchObject({ status: 'FAILED', failed: 1 });
    expect(unknownIdWarnings()).toEqual([]);
  });
});
