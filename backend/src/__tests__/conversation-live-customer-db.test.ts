/* =============================================================================
   The one customer a shared-number conversation is named by is worked out when it is read (whole-diff ruling, Ran
   2026-11-07: "use the order live"; #3013 decision 5; #3015's fixed order).

   A conversation (a pair of numbers, CONTEXT.md) is stored on whichever customer the door that made it named. That stored
   customer stops deciding the conversation's one customer: the inbox side panel and the "SMS sent to customer" line of a
   text sent in the conversation follow the first customer carrying its number in the fixed order (#3015) that the person
   can open - the customer the inbox header names first.

   Driven through the real HTTP doors (a text from a customer's page, the incoming-text webhook, an inbox reply, a text to
   the number, the customer form, the conversation read and the Recent Activity feed) against a real migrated database
   (TEST_DATABASE_URL; the suite skips when it is unset). The phone system is faked at its network edge only (`fetch`).
   Every org the suite makes is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup replaces the phone-system client; here the real one runs, and only its network edge is faked (trap 23).
vi.unmock('../lib/ctm/client');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const PROVIDER = 'https://phone-provider.test/api/v1';
/** The number Jordan Lee and Pat Morgan share. */
const SHARED = '+15550103002';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, and every send is accepted. Nothing else may be reached. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) return json({ id: `MSG-LIVE-${randomUUID()}` });
  return json({ error: 'not found' }, 404);
}

suite("a shared-number conversation's one customer is the fixed order's, worked out at every read (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const WEBHOOK_TOKEN = randomUUID();

  beforeAll(async () => {
    await fx.listener();
    // A connected phone system, with keys made up for this run.
    Object.assign(env as Record<string, unknown>, {
      CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER, CTM_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    });
    vi.stubGlobal('fetch', fakeProvider);
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    vi.unstubAllGlobals();
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'timeline_events', 'message_thread_read_states',
        'messages', 'message_threads', 'record_contact_entries', 'customer_phones']) {
        const where = table === 'customer_phones'
          ? `customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`
          : `organization_id = '${org}'`;
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${where}`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /**
   * A person on a role of their own who opens customer pages and uses the text inbox, on Communication scope "attached", and
   * reaches only the leads and jobs attached to them (so the customers of those). No company number is theirs.
   */
  async function personWho(org: string, name: string) {
    const key = `live-customer-${++sequence}`;
    await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, actorId: null, reason: 'manual',
      values: {
        view_customers: true, view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
        access_communication: true, view_communication: true, communication_scope: 'attached',
        see_main_line_when_no_number: false,
      },
    });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id });
  }

  /**
   * A company connected to the phone system, with its main line, and two customers carrying (555) 010-3002: Jordan Lee, the
   * newer one, with an open lead, and Pat Morgan, the older one, with no open work (her one lead was lost). The fixed order
   * (#3015) names Jordan Lee first. Pia owns Pat's lost lead, so she opens Pat Morgan and no other customer.
   */
  async function sharedNumberCompany() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `LIVE${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = '+15550100000';
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN-MAIN-${made.tag}`,
      },
    });
    const jordan = made.customer;
    await db.customer.update({ where: { id: jordan }, data: { first_name: 'Jordan', last_name: 'Lee', phone: '5550103002' } });
    const pat = randomUUID();
    await db.customer.create({
      data: {
        id: pat, organization_id: made.org, customer_number: `C-${pat.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Morgan', phone: SHARED, created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      },
    });
    const pia = await personWho(made.org, 'Pia');
    const patLead = await fx.addLead(made.org, pat, { owner: pia.id });
    await db.lead.update({ where: { id: patLead.id }, data: { status: 'LOST' } });
    const jordanLead = await fx.addLead(made.org, jordan);
    return { ...made, account, mainLine, jordan, pat, pia, jordanLead: jordanLead.id };
  }

  type Company = Awaited<ReturnType<typeof sharedNumberCompany>>;

  /** Dana (the office) texts from Pat Morgan's page, before anyone else texts the number. */
  async function danaTextsFromPatsPage(w: Company, body: string) {
    const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { customerId: w.pat, body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.threadId as string;
  }

  /** The customer texts our main line, as the phone system reports it. */
  async function customerTexts(w: Company, body: string) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-LIVE-${randomUUID()}`, account_id: w.account, caller_number: SHARED, tracking_number: w.mainLine,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000),
      });
    expect(res.status).toBe(200);
  }

  /** A reply typed into the open conversation in the inbox. */
  async function repliesInInbox(person: Person, threadId: string, body: string) {
    const res = await (await fx.signedInAs(person)).post('/api/communication/sms', { threadId, body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.threadId).toBe(threadId);
  }

  /** A text typed to the number itself (the inbox's "New message" to a number). */
  async function textsTheNumber(person: Person, body: string) {
    const res = await (await fx.signedInAs(person)).post('/api/communication/sms', { toNumber: '(555) 010-3002', body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.threadId as string;
  }

  /** The conversation as the person opens it: the customers it is named by, in order, and the whole answer as text. */
  async function opens(person: Person, threadId: string) {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/threads/${threadId}`);
    expect(res.status).toBe(200);
    return { customers: res.body.thread.pair.customers as { id: string; name: string }[], sent: JSON.stringify(res.body) };
  }

  /**
   * Whose customer history each "SMS sent to customer" line is on, as the office reads its Recent Activity feed: how many
   * lines each customer got.
   */
  async function sentLines(w: Company) {
    const res = await (await fx.signedInAs(w.admin)).get('/api/dashboard?tiles=recent_activity');
    expect(res.status).toBe(200);
    const names = new Map<string, string>([[w.jordan, 'Jordan Lee'], [w.pat, 'Pat Morgan']]);
    const lines: Record<string, number> = {};
    for (const e of res.body.data.recent_activity as { description: string; entity_type: string; entity_id: string }[]) {
      if (e.description !== 'SMS sent to customer') continue;
      const who = e.entity_type === 'CUSTOMER' ? names.get(e.entity_id) ?? 'someone else' : e.entity_type;
      lines[who] = (lines[who] ?? 0) + 1;
    }
    return lines;
  }

  const JORDAN = (w: Company) => ({ id: w.jordan, name: 'Jordan Lee' });
  const PAT = (w: Company) => ({ id: w.pat, name: 'Pat Morgan' });

  describe("Dana texts from Pat Morgan's page first, so the conversation is stored on Pat; the fixed order names Jordan Lee", () => {
    it("an inbox reply's line lands on Jordan Lee, the customer the open conversation names first", async () => {
      const w = await sharedNumberCompany();
      // Another company's customer carries the very same number, with a newer open lead there.
      const elsewhere = await fx.newOrg();
      orgs.push(elsewhere.org);
      await db.customer.update({ where: { id: elsewhere.customer }, data: { first_name: 'Elsewhere', last_name: 'Only', phone: '5550103002' } });
      const theirLead = await fx.addLead(elsewhere.org, elsewhere.customer);
      await db.lead.update({ where: { id: theirLead.id }, data: { created_at: new Date(Date.now() + 60_000) } });
      const id = await danaTextsFromPatsPage(w, 'Your door is ready');
      await customerTexts(w, 'Can you come Tuesday?');
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1 });

      await repliesInInbox(w.admin, id, 'Tuesday at 9');

      expect((await opens(w.admin, id)).customers).toEqual([JORDAN(w), PAT(w)]);
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1, 'Jordan Lee': 1 });
    });

    it('after (555) 010-3002 is removed from Pat Morgan, the conversation still names Jordan Lee and a reply lands on Jordan', async () => {
      const w = await sharedNumberCompany();
      const id = await danaTextsFromPatsPage(w, 'Your door is ready');
      await customerTexts(w, 'Can you come Tuesday?');
      const edit = await (await fx.signedInAs(w.admin)).patch(`/api/customers/${w.pat}`, { phone: null, email: 'pat@example.test' });
      expect(edit.status).toBe(200);

      await repliesInInbox(w.admin, id, 'Tuesday at 9');

      expect((await opens(w.admin, id)).customers).toEqual([JORDAN(w)]);
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1, 'Jordan Lee': 1 });
    });

    it("when the conversation's number is no longer in use, the reply leaves from the main line and still lands on Jordan Lee", async () => {
      const w = await sharedNumberCompany();
      // Dana's own line is (555) 010-1111, so her text from Pat's page starts the conversation (3002, 1111), stored on Pat.
      const own = await db.phoneNumber.create({
        data: { organization_id: w.org, e164: '+15550101111', status: 'active', sms_enabled: true, ctm_number_id: `TPN-DANA-${w.tag}` },
      });
      await db.userPhoneNumber.create({ data: { user_id: w.admin.id, phone_number_id: own.id, is_default: true } });
      const id = await danaTextsFromPatsPage(w, 'Your door is ready');
      // The phone system no longer reports her line as active.
      await db.phoneNumber.update({ where: { id: own.id }, data: { status: 'inactive' } });

      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: id, body: 'Tuesday at 9' });

      expect(res.status).toBe(201);
      expect(res.body.threadId).not.toBe(id);
      expect((await opens(w.admin, res.body.threadId)).customers).toEqual([JORDAN(w), PAT(w)]);
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1, 'Jordan Lee': 1 });
    });

    it('once no customer carries the number any more, a reply is put on no customer', async () => {
      const w = await sharedNumberCompany();
      const id = await danaTextsFromPatsPage(w, 'Your door is ready');
      await customerTexts(w, 'Can you come Tuesday?');
      const admin = await fx.signedInAs(w.admin);
      for (const customer of [w.pat, w.jordan]) {
        expect((await admin.patch(`/api/customers/${customer}`, { phone: null, email: `${customer}@example.test` })).status).toBe(200);
      }

      await repliesInInbox(w.admin, id, 'Tuesday at 9');

      expect((await opens(w.admin, id)).customers).toEqual([]);
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1 });
    });
  });

  describe('a text to the number from the inbox', () => {
    it("lands on the first customer carrying the number, never on a customer whose phone is stored as typed, \"(555) 010-3002\"", async () => {
      const w = await sharedNumberCompany();
      const id = await danaTextsFromPatsPage(w, 'Your door is ready');
      // An old customer whose phone was saved exactly as typed, with the newest open lead of all: no customer carrying
      // (555) 010-3002 as the inbox names them (E.164 or the bare ten digits), so never the conversation's one customer.
      const typed = randomUUID();
      await db.customer.create({
        data: {
          id: typed, organization_id: w.org, customer_number: `C-${typed.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
          first_name: 'Typed', last_name: 'Phone', phone: '(555) 010-3002', created_at: new Date(Date.now() - 730 * 24 * 60 * 60 * 1000),
        },
      });
      const typedLead = await fx.addLead(w.org, typed);
      await db.lead.update({ where: { id: typedLead.id }, data: { created_at: new Date(Date.now() + 60_000) } });

      expect(await textsTheNumber(w.admin, 'Tuesday at 9')).toBe(id);

      expect((await opens(w.admin, id)).customers).toEqual([JORDAN(w), PAT(w)]);
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1, 'Jordan Lee': 1 });
    });
  });

  describe('Pia opens Pat Morgan but not Jordan Lee', () => {
    it("is named Pat Morgan alone, sent nothing of Jordan's, and her inbox reply lands on Pat", async () => {
      const w = await sharedNumberCompany();
      const id = await danaTextsFromPatsPage(w, 'Your door is ready');
      await customerTexts(w, 'Can you come Tuesday?');

      await repliesInInbox(w.pia, id, 'Tuesday at 9');

      const seen = await opens(w.pia, id);
      expect(seen.customers).toEqual([PAT(w)]);
      expect({ id: seen.sent.includes(w.jordan), name: seen.sent.includes('Jordan') }).toEqual({ id: false, name: false });
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 2 });
    });

    it("in a conversation stored on Jordan Lee, her inbox reply lands on Pat Morgan, never on Jordan's history", async () => {
      const w = await sharedNumberCompany();
      // The customer texts first: the incoming text stores the conversation on the fixed order's customer, Jordan Lee.
      await customerTexts(w, 'Can you come Tuesday?');
      const [stored] = (await (await fx.signedInAs(w.admin)).get('/api/communication/threads')).body.threads as { id: string; customerId: string }[];
      expect(stored!.customerId).toBe(w.jordan);

      await repliesInInbox(w.pia, stored!.id, 'Tuesday at 9');

      expect((await opens(w.pia, stored!.id)).customers).toEqual([PAT(w)]);
      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1 });
    });

    it("her text to the number, in the conversation stored on Jordan Lee, lands on Pat Morgan, never on Jordan's history", async () => {
      const w = await sharedNumberCompany();
      await customerTexts(w, 'Can you come Tuesday?');
      const [stored] = (await (await fx.signedInAs(w.admin)).get('/api/communication/threads')).body.threads as { id: string; customerId: string }[];
      expect(stored!.customerId).toBe(w.jordan);

      expect(await textsTheNumber(w.pia, 'Tuesday at 9')).toBe(stored!.id);

      expect(await sentLines(w)).toEqual({ 'Pat Morgan': 1 });
    });
  });
});
