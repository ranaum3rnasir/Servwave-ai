/* =============================================================================
   #3025 (parent #3013): calls tell the truth.

   What the call ingest stores for each way a call can end, and what it raises:
   - "no answer" (with a space) and "failed" are stored as missed, never as completed;
   - an outbound end with zero talk time and no answered leg is stored as missed (the call history reads "Not connected"),
     and an outbound missed call raises no missed-call alert;
   - an incoming missed call ("no answer") raises its missed-call alert;
   - a text's start and end events (carrying a message id, or a message direction) create no call.

   Every case is posted to the phone service webhook route on a real migrated database (TEST_DATABASE_URL), the way the phone
   service posts it, both as an end alone (the row is created by the end) and as a start followed by its end (the end updates
   the row the start made). The suite skips when TEST_DATABASE_URL is unset. The phone service is never reached: its network
   edge is recorded and nothing is expected there. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomBytes, randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup replaces the phone service's client; here the real one runs, so a request it made would reach the
// network edge faked below.
vi.unmock('../lib/ctm/client');

import { switchFixture } from './permission-switches-fixture';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const SID_PREFIX = 'CA-3025-';

suite('calls tell the truth: what the call ingest stores and raises for each ending (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  const token = randomBytes(24).toString('hex');
  const providerCalls: string[] = [];
  // The phone service's address in this suite. Nothing outside it may be reached.
  const PROVIDER = 'https://phone-provider.test/api/v1';
  const settings = env as Record<string, unknown>;
  const before = {
    CTM_WEBHOOK_TOKEN: settings.CTM_WEBHOOK_TOKEN, CTM_ACCESS_KEY: settings.CTM_ACCESS_KEY,
    CTM_SECRET_KEY: settings.CTM_SECRET_KEY, CTM_API_BASE: settings.CTM_API_BASE,
  };

  beforeAll(async () => {
    await fx.listener();
    // A connected phone service, so its client would really send a request. The route is closed while no token is set; this
    // run's token and keys are made up here, never stored.
    Object.assign(settings, {
      CTM_WEBHOOK_TOKEN: token, CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER,
    });
    // The phone service's network edge: any request to it is recorded, and none is expected. Any other address throws.
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${url}`);
      providerCalls.push(url);
      return new Response('{}', { status: 200 });
    });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    Object.assign(settings, before);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notification_recipients WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM ctm_events WHERE ctm_event_id LIKE '${SID_PREFIX}%'`));
    await fx.cleanup();
  });

  type Company = { org: string; account: string; ours: string };

  /**
   * A number of its own each time, ten digits. Placeholders in the 555-01xx range only, (555) 010-0100 up to (555) 010-0199, each
   * handed out once per run; every case has its own company, so a number never meets the same number from an earlier run.
   */
  let numbersUsed = 0;
  const placeholderNumber = () => {
    if (numbersUsed > 99) throw new Error('this suite has used every placeholder number in (555) 010-0100..0199');
    return `5550100${100 + numbersUsed++}`;
  };

  /** A company on the phone service, with its main line stored, so the webhook finds it and its number. */
  async function companyOnPhoneService(): Promise<Company> {
    const { org, tag } = await fx.newOrg();
    orgs.push(org);
    const account = `3025${tag}`;
    await db.organization.update({ where: { id: org }, data: { ctm_account_id: account } });
    const ours = `+1${placeholderNumber()}`;
    await db.phoneNumber.create({ data: { organization_id: org, e164: ours, label: 'Main line', is_org_default: true, status: 'active' } });
    return { org, account, ours };
  }

  const newSid = () => `${SID_PREFIX}${randomUUID().slice(0, 12)}`;
  const customerNumber = () => `+1${placeholderNumber()}`;

  /** One event, posted to the webhook route the way the phone service posts it. */
  async function post(company: Company, position: 'starts' | 'end', event: Record<string, unknown>) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/${position}?token=${token}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ account_id: company.account, unix_time: Math.floor(Date.now() / 1000), ...event }));
    expect(res.status).toBe(200);
  }

  const inbound = (company: Company, sid: string, number: string) =>
    ({ sid, caller_number: number, tracking_number: company.ours, direction: 'inbound' });
  const outbound = (company: Company, sid: string, number: string) =>
    ({ sid, caller_number: company.ours, tracking_number: company.ours, called_number: number, direction: 'outbound' });

  /** The ServWave user's own phone leg, answered: the phone service names the agent who picked up. */
  const ANSWERED_LEG = { agent: { id: 9001, name: 'Placing Agent', email: 'nobody-3025@example.test' } };

  async function storedStatus(company: Company, sid: string) {
    const row = await db.callSession.findFirst({ where: { organization_id: company.org, ctm_call_id: sid }, select: { status: true } });
    return row?.status ?? null;
  }

  async function missedAlertFor(company: Company, sid: string) {
    const call = await db.callSession.findFirst({ where: { organization_id: company.org, ctm_call_id: sid }, select: { id: true } });
    if (!call) return null;
    return db.notification.findFirst({
      where: { organization_id: company.org, verb: 'communication.call_missed', object_id: call.id },
      select: { id: true },
    });
  }

  /** The alert is raised after the phone service has its answer, so it is waited for. */
  async function waitForMissedAlert(company: Company, sid: string) {
    return vi.waitFor(async () => {
      const found = await missedAlertFor(company, sid);
      if (!found) throw new Error('no missed-call alert yet');
      return found;
    }, { timeout: 10_000, interval: 100 });
  }

  /**
   * Each ending the issue names, as the phone service reports it at the call's end, with what must be stored. `alert` says
   * whether the missed-call alert goes out.
   */
  const ENDINGS: Array<{
    name: string;
    direction: 'in' | 'out';
    end: Record<string, unknown>;
    stored: 'missed' | 'completed';
    alert: boolean;
  }> = [
    {
      name: 'an incoming "no answer" call',
      direction: 'in',
      end: { call_status: 'no answer', dial_status: 'no answer', talk_time: 0, duration: 25 },
      stored: 'missed',
      alert: true,
    },
    {
      name: 'an incoming "failed" call',
      direction: 'in',
      end: { call_status: 'failed', dial_status: 'failed', talk_time: 0, duration: 0 },
      stored: 'missed',
      alert: true,
    },
    {
      name: 'an outbound "no answer" call',
      direction: 'out',
      end: { call_status: 'no answer', dial_status: 'no answer', talk_time: 0, duration: 30 },
      stored: 'missed',
      alert: false,
    },
    {
      name: 'an outbound "failed" call',
      direction: 'out',
      end: { call_status: 'failed', dial_status: 'failed', talk_time: 0, duration: 0 },
      stored: 'missed',
      alert: false,
    },
    {
      name: 'an outbound call you never answered (zero talk time, no answered leg)',
      direction: 'out',
      end: { call_status: 'completed', dial_status: 'completed', talk_time: 0, duration: 31 },
      stored: 'missed',
      alert: false,
    },
    {
      name: 'an outbound call whose leg was answered, with zero talk time',
      direction: 'out',
      end: { call_status: 'completed', dial_status: 'completed', talk_time: 0, duration: 12, ...ANSWERED_LEG },
      stored: 'completed',
      alert: false,
    },
    {
      name: 'an outbound call with talk time and no agent named',
      direction: 'out',
      end: { call_status: 'completed', dial_status: 'completed', talk_time: 33, duration: 40 },
      stored: 'completed',
      alert: false,
    },
  ];

  for (const shape of ['an end alone', 'a start, then its end'] as const) {
    it(`stores each ending as the issue says, and raises the missed-call alert only for an incoming missed call (${shape})`, async () => {
      const company = await companyOnPhoneService();
      const results: Array<{ name: string; stored: string | null; alert: boolean }> = [];
      const sids: string[] = [];

      for (const ending of ENDINGS) {
        const sid = newSid();
        sids.push(sid);
        const number = customerNumber();
        const base = ending.direction === 'in' ? inbound(company, sid, number) : outbound(company, sid, number);
        if (shape === 'a start, then its end') {
          await post(company, 'starts', { ...base, call_status: 'in-progress' });
          // The start made the row; the end below updates it.
          expect(await storedStatus(company, sid)).toBe('ringing');
        }
        await post(company, 'end', { ...base, ...ending.end });
        results.push({ name: ending.name, stored: await storedStatus(company, sid), alert: false });
      }

      // Every alert the endings raise is out once the last one expected has landed (they are raised in order). The wait
      // is bounded and never fails by itself: the table below says which alert is missing.
      const lastAlerted = ENDINGS.map((e, i) => ({ e, sid: sids[i]! })).filter(({ e }) => e.alert).pop();
      if (lastAlerted) await waitForMissedAlert(company, lastAlerted.sid).catch(() => undefined);
      for (const [i, sid] of sids.entries()) results[i]!.alert = (await missedAlertFor(company, sid)) !== null;

      expect(results).toEqual(ENDINGS.map((e) => ({ name: e.name, stored: e.stored, alert: e.alert })));
      expect(providerCalls).toEqual([]);
    });
  }

  /** A text activity as the phone service reports it on a call hook: it carries a sid too. */
  const TEXTS: Array<{ name: string; event: (company: Company, sid: string, number: string) => Record<string, unknown> }> = [
    {
      name: 'an outgoing text with its message id and message direction',
      event: (company, sid, number) => ({
        sid, message_id: `MSG3025${randomUUID().replace(/-/g, '')}`, direction: 'msg_outbound',
        caller_number: number, contact_number: number, called_number: company.ours, tracking_number: company.ours,
        call_status: 'sent', dial_status: 'sent', status: 'sent', message_body: 'Your technician is on the way',
      }),
    },
    {
      name: 'an incoming text with its message id and message direction',
      event: (company, sid, number) => ({
        sid, message_id: `MSG3025${randomUUID().replace(/-/g, '')}`, direction: 'msg_inbound',
        caller_number: number, tracking_number: company.ours, message_body: 'Thanks, see you then',
      }),
    },
    {
      name: 'a text carrying a message id only (its direction reads like a call\'s)',
      event: (company, sid, number) => ({
        sid, message_id: `MSG3025${randomUUID().replace(/-/g, '')}`, direction: 'inbound',
        caller_number: number, tracking_number: company.ours, message_body: 'Is Tuesday still on?',
      }),
    },
    {
      name: 'a text carrying a message direction only',
      event: (company, sid, number) => ({
        sid, direction: 'msg_inbound', caller_number: number, tracking_number: company.ours, message_body: 'Running late',
      }),
    },
  ];

  it('a text\'s start and end events create no call', async () => {
    const company = await companyOnPhoneService();
    const made: Array<{ name: string; calls: number }> = [];

    for (const text of TEXTS) {
      const sid = newSid();
      const event = text.event(company, sid, customerNumber());
      await post(company, 'starts', event);
      await post(company, 'end', event);
      made.push({ name: text.name, calls: await db.callSession.count({ where: { organization_id: company.org, ctm_call_id: sid } }) });
    }

    expect(made).toEqual(TEXTS.map((t) => ({ name: t.name, calls: 0 })));
    // The company has no call at all: nothing a text sent made one.
    expect(await db.callSession.count({ where: { organization_id: company.org } })).toBe(0);
    expect(providerCalls).toEqual([]);
  });
});
