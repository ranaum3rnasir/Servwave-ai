/* =============================================================================
   #3021 - A shared-number conversation shows on every customer with the number (parent #3013, decisions 4 and 5, Q41).

   A text conversation is a pair of numbers (CONTEXT.md). Which customers it shows on is worked out every time it is read,
   from the customers' phone fields and the leads' and jobs' own numbers, never stored. Driven through the real HTTP reads
   (the inbox list, opening a conversation, marking it read, a customer page's Communication tab) against a real migrated
   database (TEST_DATABASE_URL; the suite skips when it is unset), as people who reach both sharing customers, one of them,
   or neither. The conversation itself is made through the real doors (a send from a lead's page, the incoming-text webhook).
   The phone system is faked at its network edge only (`fetch`). Every org the suite makes is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why). The client reports every statement
// it runs, so a test can count what one read costs.
const { realClient, statements } = vi.hoisted(() => {
  const statements: string[] = [];
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined, statements };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] });
  client.$on('query' as never, (e: { query: string }) => statements.push(e.query));
  return { realClient: client, statements };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup replaces the phone-system client; here the real one runs, and only its network edge is faked.
vi.unmock('../lib/ctm/client');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const PROVIDER = 'https://phone-provider.test/api/v1';
/** The number Jordan Lee and Pat Morgan share, and the way the inbox and the pages carry it. */
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
  if (init?.method === 'POST' && /\/sms$/.test(path)) return json({ id: `MSG-3021-${randomUUID()}` });
  return json({ error: 'not found' }, 404);
}

suite('a shared-number conversation shows on every customer with the number (real database)', () => {
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
   * A person on a role of their own: they open customer pages and use the text inbox, on Communication scope `scope`, and
   * reach the leads and jobs attached to them (so the customers of those) or, with `customers: 'all'`, every lead, job and
   * customer. No company number is theirs and the main-line fallback is off, so only a customer they reach opens a text.
   */
  async function personWho(org: string, name: string, opts: { scope?: 'attached' | 'all'; customers?: 'attached' | 'all' } = {}) {
    const key = `shared-number-${++sequence}`;
    await fx.addCustomRole(org, key, 'DISPATCHER');
    const reach = opts.customers ?? 'attached';
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, actorId: null, reason: 'manual',
      values: {
        view_customers: true, view_jobs: true, jobs_scope: reach, view_leads: true, leads_scope: reach,
        access_communication: true, view_communication: true, communication_scope: opts.scope ?? 'attached',
        see_main_line_when_no_number: false,
      },
    });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id });
  }

  async function addCustomer(org: string, first: string, last: string, phone: string | null) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: first, last_name: last, phone,
      },
    });
    return id;
  }

  /**
   * A company connected to the phone system, with its main line and two customers who share (555) 010-3002: Jordan Lee
   * (stored bare, the way the customer forms store a phone) and Pat Morgan (stored as E.164). Each has an open lead; Pia owns
   * Pat's lead, so she reaches Pat Morgan and no one else; Nico reaches neither customer.
   */
  async function sharedNumberCompany() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3021${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = `+1555030${String(++sequence).padStart(4, '0')}`;
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN-MAIN-${made.tag}`,
      },
    });
    const jordan = made.customer;
    await db.customer.update({ where: { id: jordan }, data: { first_name: 'Jordan', last_name: 'Lee', phone: '5550103002' } });
    const pat = await addCustomer(made.org, 'Pat', 'Morgan', SHARED);
    const pia = await personWho(made.org, 'Pia');
    const nico = await personWho(made.org, 'Nico');
    // Pat's lead is the older one, so the fixed order (#3015) names Jordan Lee first: the customer with the newest open lead.
    const patLead = await fx.addLead(made.org, pat, { owner: pia.id });
    const jordanLead = await fx.addLead(made.org, jordan);
    await db.lead.update({ where: { id: jordanLead.id }, data: { created_at: new Date(Date.now() + 1000) } });
    return { ...made, account, mainLine, jordan, pat, pia, nico, patLead: patLead.id, jordanLead: jordanLead.id };
  }

  type Company = Awaited<ReturnType<typeof sharedNumberCompany>>;

  /** The customer texts our main line, as the phone system reports it. */
  async function customerTexts(w: Company, body: string, from = SHARED) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-3021-${randomUUID()}`, account_id: w.account, caller_number: from, tracking_number: w.mainLine,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000),
      });
    expect(res.status).toBe(200);
  }

  /** A text from a customer's page, about one of their leads. */
  async function textFrom(w: Company, customerId: string, leadId: string, body: string) {
    const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { customerId, leadId, body });
    expect(res.status).toBe(201);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Arrange only: the text we sent with these words went out `ms` ago (as sms-reply-tie-db.test.ts does). */
  async function sentAgo(w: Company, body: string, ms: number) {
    const moved = await db.message.updateMany({
      where: { organization_id: w.org, body, direction: 'out' },
      data: { ts: new Date(Date.now() - ms) },
    });
    expect(moved.count).toBe(1);
  }

  /** The lead and job a text of the conversation is tied to, as the admin reads it when opening the conversation. */
  async function tieOf(w: Company, id: string, body: string) {
    const res = await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${id}`);
    const text = (res.body.thread.messages as { body: string; leadId?: string; jobId?: string }[]).find((m) => m.body === body);
    expect(text, `"${body}" is in the conversation`).toBeDefined();
    return { leadId: text!.leadId ?? null, jobId: text!.jobId ?? null };
  }
  const UNTIED = { leadId: null, jobId: null };

  /**
   * The conversation on (555) 010-3002: the office texts from Jordan's lead (so it is filed on Jordan Lee), the customer
   * answers more than 30 days later (so it answers no recent text of ours and is tied to no lead or job, #3020), and the
   * office texts again from Pat's lead (the same conversation, #3013 decision 2). With `answerTo: 'recent'` the customer
   * answers the office's text at once instead, so the answer is tied to Jordan's lead (#3020).
   */
  async function sharedConversation(w: Company, opts: { answerTo?: 'old' | 'recent' } = {}) {
    const answersOldText = (opts.answerTo ?? 'old') === 'old';
    await textFrom(w, w.jordan, w.jordanLead, 'Your estimate is ready');
    if (answersOldText) await sentAgo(w, 'Your estimate is ready', 31 * DAY_MS);
    await customerTexts(w, 'Is Tuesday free?');
    await textFrom(w, w.pat, w.patLead, 'Booked for Tuesday');
    const listed = (await (await fx.signedInAs(w.admin)).get('/api/communication/threads')).body.threads as { id: string }[];
    expect(listed).toHaveLength(1);
    const id = listed[0]!.id;
    // The premise the tests read by: the customer's answer is tied to no lead or job (or, when asked, to Jordan's lead).
    expect(await tieOf(w, id, 'Is Tuesday free?')).toEqual(answersOldText ? UNTIED : { leadId: w.jordanLead, jobId: null });
    return id;
  }

  type Item = { channel: string; who: string; preview: string; threadId?: string };

  /** The texts a customer's Communication tab lists to a person: who each is with, its words and its conversation. */
  async function textsOnPage(person: Person, customerId: string) {
    const res = await (await fx.signedInAs(person)).get(`/api/customers/${customerId}/communications`);
    expect(res.status).toBe(200);
    return (res.body.items as Item[])
      .filter((i) => i.channel === 'sms')
      .map((i) => ({ who: i.who, text: i.preview, conversation: i.threadId }))
      .sort((a, b) => a.text.localeCompare(b.text));
  }

  /** What a person gets for a customer page they cannot open. */
  async function textsOnPageRefused(person: Person, customerId: string) {
    const res = await (await fx.signedInAs(person)).get(`/api/customers/${customerId}/communications`);
    return { status: res.status, body: res.body };
  }

  describe("a conversation on a number Jordan Lee and Pat Morgan carry shows on both customers' pages", () => {
    it('lists every text of it on each page, named for that page\'s customer', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);

      const on = (who: string) => [
        { who, text: 'Booked for Tuesday', conversation: id },
        { who, text: 'Is Tuesday free?', conversation: id },
        { who, text: 'Your estimate is ready', conversation: id },
      ];
      expect(await textsOnPage(w.admin, w.jordan)).toEqual(on('Jordan Lee'));
      expect(await textsOnPage(w.admin, w.pat)).toEqual(on('Pat Morgan'));
    });
  });

  /** The texts a person reads when they open the conversation, or the refusal they get. */
  async function opens(person: Person, id: string) {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/threads/${id}`);
    return res.status === 200
      ? { status: 200, texts: (res.body.thread.messages as { body: string }[]).map((m) => m.body).sort() }
      : { status: res.status, body: res.body };
  }

  type Listed = { id: string; pair?: { otherPartyE164: string; customers: { id: string; name: string }[] } };

  /** The customers the inbox names on each conversation, as the list gives them and as the open conversation does. */
  async function namedInInbox(person: Person) {
    const api = await fx.signedInAs(person);
    const listed = (await api.get('/api/communication/threads')).body.threads as Listed[];
    return Promise.all(listed.map(async (t) => {
      const open = (await api.get(`/api/communication/threads/${t.id}`)).body.thread as Listed;
      return { listed: t.pair?.customers ?? null, open: open.pair?.customers ?? null };
    }));
  }

  /**
   * Eight more customers carrying (555) 010-3002, each in another place a number is kept: the phone, the second phone,
   * the phones list, and a lead's own number (a lead that is lost, so it decides nothing in the fixed order).
   */
  async function eightMoreCarriers(w: Company) {
    const made: { id: string; name: string }[] = [];
    for (let i = 1; i <= 8; i++) {
      const id = await addCustomer(w.org, 'Customer', String(i), null);
      await db.customer.update({ where: { id }, data: { created_at: new Date(Date.UTC(2024, 0, i)) } });
      if (i % 4 === 1) await db.customer.update({ where: { id }, data: { phone: '5550103002' } });
      if (i % 4 === 2) await db.customer.update({ where: { id }, data: { secondary_phone: '5550103002' } });
      if (i % 4 === 3) await db.customerPhone.create({ data: { customer_id: id, phone: SHARED } });
      if (i % 4 === 0) {
        const lead = await fx.addLead(w.org, id);
        await db.lead.update({ where: { id: lead.id }, data: { status: 'LOST' } });
        await db.recordContactEntry.create({ data: { organization_id: w.org, lead_id: lead.id, kind: 'PHONE', intent: 'ADDED', value: '5550103002' } });
      }
      made.push({ id, name: `Customer ${i}` });
    }
    // The newest first, after the two with an open lead.
    return made.reverse();
  }

  describe('the inbox names every customer carrying the number', () => {
    it('in the fixed order, on the row and in the open conversation, and never a customer of another company', async () => {
      const w = await sharedNumberCompany();
      const more = await eightMoreCarriers(w);
      // Another company's customer carries the very same number, and has an open lead there.
      const elsewhere = await fx.newOrg();
      orgs.push(elsewhere.org);
      await db.customer.update({ where: { id: elsewhere.customer }, data: { first_name: 'Elsewhere', last_name: 'Only', phone: '5550103002' } });
      await fx.addLead(elsewhere.org, elsewhere.customer);
      await sharedConversation(w);

      const carriers = [{ id: w.jordan, name: 'Jordan Lee' }, { id: w.pat, name: 'Pat Morgan' }, ...more];
      expect(await namedInInbox(w.admin)).toEqual([{ listed: carriers, open: carriers }]);
    });
  });

  describe('the customers named on the conversation are the ones the person can open', () => {
    it('a person who reaches Pat Morgan only is told of Pat; one who holds our number but reaches neither is told of no one', async () => {
      const w = await sharedNumberCompany();
      const lina = await personWho(w.org, 'Lina');
      const main = await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: w.mainLine } });
      await db.userPhoneNumber.create({ data: { user_id: lina.id, phone_number_id: main.id } });
      const id = await sharedConversation(w);

      const opened = (person: Person) => fx.signedInAs(person).then((api) => api.get(`/api/communication/threads/${id}`));
      expect((await opened(w.pia)).body.thread.pair.customers).toEqual([{ id: w.pat, name: 'Pat Morgan' }]);
      expect((await opened(lina)).body.thread.pair.customers).toEqual([]);
      const listed = (await (await fx.signedInAs(lina)).get('/api/communication/threads')).body.threads as Listed[];
      expect(listed.map((t) => ({ id: t.id, customers: t.pair!.customers }))).toEqual([{ id, customers: [] }]);
    });
  });

  /**
   * Everything a person is sent about the conversation, as JSON: the inbox list, the open conversation, a customer page's
   * Communication tab (when one is given) and the unread badge.
   */
  async function everythingSent(person: Person, id: string, page?: string) {
    const api = await fx.signedInAs(person);
    const reads = {
      list: await api.get('/api/communication/threads'),
      open: await api.get(`/api/communication/threads/${id}`),
      ...(page && { page: await api.get(`/api/customers/${page}/communications`) }),
      badge: await api.get('/api/communication/unread-counts'),
    };
    for (const [read, res] of Object.entries(reads)) expect({ read, status: res.status }).toEqual({ read, status: 200 });
    return { list: reads.list.body, open: reads.open.body, page: reads.page?.body, all: JSON.stringify(Object.values(reads).map((r) => r.body)) };
  }

  /** Whether a payload names a customer: by their id, or by their name. */
  function namesOf(text: string, customer: { id: string; name: string }) {
    return { id: text.includes(customer.id), name: text.includes(customer.name) };
  }
  const NAMES_NOTHING = { id: false, name: false };

  describe('names and ids of customers the person cannot open are never sent (ruling: only customers the viewer can open)', () => {
    it("a person who reaches Pat Morgan only is never sent Jordan Lee, though the conversation is filed on Jordan; Pat's view keeps it", async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);
      const jordan = { id: w.jordan, name: 'Jordan' };
      // Pam reaches Pat Morgan through a lead of Pat's she owns, and holds the main line, so the inbox lists the conversation.
      const pam = await personWho(w.org, 'Pam');
      await fx.addLead(w.org, w.pat, { owner: pam.id });
      const main = await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: w.mainLine } });
      await db.userPhoneNumber.create({ data: { user_id: pam.id, phone_number_id: main.id } });

      const pia = await everythingSent(w.pia, id, w.pat);
      const pams = await everythingSent(pam, id, w.pat);

      expect(namesOf(pia.all, jordan)).toEqual(NAMES_NOTHING);
      expect(namesOf(pams.all, jordan)).toEqual(NAMES_NOTHING);
      // Nor the lead of Jordan's the conversation is filed on, which Pia cannot open either.
      expect({ jordansLead: pia.all.includes(w.jordanLead) }).toEqual({ jordansLead: false });
      // What Pia does get: the conversation on Pat Morgan, with its untied text and the one tied to Pat's lead.
      expect(pia.open.thread.pair.customers).toEqual([{ id: w.pat, name: 'Pat Morgan' }]);
      expect((pia.open.thread.messages as { body: string }[]).map((m) => m.body).sort()).toEqual(['Booked for Tuesday', 'Is Tuesday free?']);
      expect((pia.page.items as { preview: string }[]).map((i) => i.preview).sort()).toEqual(['Booked for Tuesday', 'Is Tuesday free?']);
      expect((pams.list.threads as Listed[]).map((t) => ({ id: t.id, customers: t.pair!.customers })))
        .toEqual([{ id, customers: [{ id: w.pat, name: 'Pat Morgan' }] }]);
    });

    it('a person who holds our number but reaches neither customer is sent neither of them', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);
      const lina = await personWho(w.org, 'Lina');
      const main = await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: w.mainLine } });
      await db.userPhoneNumber.create({ data: { user_id: lina.id, phone_number_id: main.id } });

      const sent = await everythingSent(lina, id);

      expect(namesOf(sent.all, { id: w.jordan, name: 'Jordan' })).toEqual(NAMES_NOTHING);
      expect(namesOf(sent.all, { id: w.pat, name: 'Pat' })).toEqual(NAMES_NOTHING);
      expect((sent.list.threads as Listed[]).map((t) => ({ id: t.id, customers: t.pair!.customers }))).toEqual([{ id, customers: [] }]);
    });

    it('an admin is still told the customer the conversation is filed on', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);

      const sent = await everythingSent(w.admin, id);

      const filedOn = (t: { customerId: string; linkedCustomer?: unknown }) => ({ customerId: t.customerId, linkedCustomer: t.linkedCustomer });
      const jordan = { customerId: w.jordan, linkedCustomer: { id: w.jordan, name: 'Jordan Lee' } };
      expect(filedOn(sent.open.thread)).toEqual(jordan);
      expect((sent.list.threads as { customerId: string }[]).map(filedOn)).toEqual([jordan]);
    });
  });

  describe('a number on 47 customers', () => {
    it('loads the inbox in as many statements as a number on two: one read names every customer, not one per customer', async () => {
      const w = await sharedNumberCompany();
      await sharedConversation(w);
      const admin = await fx.signedInAs(w.admin);
      /** One inbox load: how many statements it ran, and how many customers it named. */
      const load = async () => {
        statements.length = 0;
        const res = await admin.get('/api/communication/threads');
        expect(res.status).toBe(200);
        return { statements: statements.length, named: (res.body.threads as Listed[])[0]!.pair!.customers.length };
      };
      await load(); // Warms what the app keeps between requests (the person's switches), so the two loads compare alike.
      const onTwo = await load();
      for (let i = 1; i <= 45; i++) await addCustomer(w.org, 'Carrier', String(i), '5550103002');

      const onFortySeven = await load();

      expect(onTwo.named).toBe(2);
      expect(onFortySeven).toEqual({ statements: onTwo.statements, named: 47 });
    });
  });

  describe('a person who reaches Pat Morgan only (decision 4)', () => {
    it('reads the texts tied to no lead or job, and the one tied to Pat\'s lead, on Pat\'s page', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);

      expect(await textsOnPage(w.pia, w.pat)).toEqual([
        { who: 'Pat Morgan', text: 'Booked for Tuesday', conversation: id },
        { who: 'Pat Morgan', text: 'Is Tuesday free?', conversation: id },
      ]);
    });

    it('opens the conversation with the same texts, never the one tied to Jordan\'s lead', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);

      expect(await opens(w.pia, id)).toEqual({ status: 200, texts: ['Booked for Tuesday', 'Is Tuesday free?'] });
    });
  });

  describe("a reply to the office's text on Jordan's lead, in the conversation Jordan Lee and Pat Morgan share (#3020 with decision 4)", () => {
    it("is tied to Jordan's lead, so a person who reaches Pat Morgan only does not read it, and one who reaches Jordan Lee only does", async () => {
      const w = await sharedNumberCompany();
      const jordansReader = await personWho(w.org, 'Jo');
      await db.lead.update({ where: { id: w.jordanLead }, data: { commission_owner_id: jordansReader.id } });

      const id = await sharedConversation(w, { answerTo: 'recent' });

      expect(await tieOf(w, id, 'Is Tuesday free?')).toEqual({ leadId: w.jordanLead, jobId: null });
      expect(await opens(w.pia, id)).toEqual({ status: 200, texts: ['Booked for Tuesday'] });
      expect(await textsOnPage(w.pia, w.pat)).toEqual([{ who: 'Pat Morgan', text: 'Booked for Tuesday', conversation: id }]);
      expect(await opens(jordansReader, id)).toEqual({ status: 200, texts: ['Is Tuesday free?', 'Your estimate is ready'] });
      // The alert about the answer agrees: it goes to Jordan's reader, never to Pia.
      const answer = ((await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${id}`)).body.thread.messages as { id: string; body: string }[])
        .find((m) => m.body === 'Is Tuesday free?')!;
      const { filterRecipientsByAccess } = await import('../services/notifications/filterByAccess.js');
      const alerted = await filterRecipientsByAccess('MESSAGE_THREAD', id, [w.pia.id, jordansReader.id], w.org, { messageId: answer.id });
      expect(alerted).toEqual([jordansReader.id]);
    });
  });

  describe('removing (555) 010-3002 from Pat Morgan (Q41, decision 5)', () => {
    it("takes the conversation off Pat's page at once, even though it is filed on Pat, and leaves it on Jordan's", async () => {
      const w = await sharedNumberCompany();
      // Started from Pat's lead, so the conversation is filed on Pat Morgan.
      await textFrom(w, w.pat, w.patLead, 'Booked for Tuesday');
      // The customer answers more than 30 days later, so the answer is tied to no lead or job (#3020).
      await sentAgo(w, 'Booked for Tuesday', 31 * DAY_MS);
      await customerTexts(w, 'Is Tuesday free?');
      const id = ((await (await fx.signedInAs(w.admin)).get('/api/communication/threads')).body.threads as { id: string; customerId: string }[])
        .map((t) => ({ id: t.id, filedOn: t.customerId }))[0]!;
      expect(id.filedOn).toBe(w.pat);
      expect(await tieOf(w, id.id, 'Is Tuesday free?')).toEqual(UNTIED);
      expect(await textsOnPage(w.admin, w.pat)).toHaveLength(2);

      // The office removes the number from Pat's record (an email stays, so Pat keeps a way to be reached).
      const edit = await (await fx.signedInAs(w.admin)).patch(`/api/customers/${w.pat}`, { phone: null, email: 'pat@example.test' });
      expect(edit.status).toBe(200);

      expect(await textsOnPage(w.admin, w.pat)).toEqual([]);
      expect(await textsOnPage(w.admin, w.jordan)).toEqual([
        { who: 'Jordan Lee', text: 'Booked for Tuesday', conversation: id.id },
        { who: 'Jordan Lee', text: 'Is Tuesday free?', conversation: id.id },
      ]);
      // Pia reaches Pat Morgan, who no longer carries the number: she keeps only the text tied to Pat's lead.
      expect(await opens(w.pia, id.id)).toEqual({ status: 200, texts: ['Booked for Tuesday'] });
    });
  });

  describe('who opens the conversation (decision 4)', () => {
    it.each([
      ['a person on Communication "All" who reaches no customer', { scope: 'all' as const }, ['Booked for Tuesday', 'Is Tuesday free?', 'Your estimate is ready']],
      ['a person who reaches Jordan Lee only', { ownsJordansLead: true }, ['Is Tuesday free?', 'Your estimate is ready']],
    ])('%s', async (_who, opts, texts) => {
      const w = await sharedNumberCompany();
      const person = await personWho(w.org, 'Reader', 'scope' in opts ? { scope: opts.scope } : {});
      if ('ownsJordansLead' in opts) await db.lead.update({ where: { id: w.jordanLead }, data: { commission_owner_id: person.id } });
      const id = await sharedConversation(w);

      expect(await opens(person, id)).toEqual({ status: 200, texts });
    });

    it('a customer of another company carrying the number opens nothing here, even for a person who reaches every customer', async () => {
      const w = await sharedNumberCompany();
      const everyCustomer = await personWho(w.org, 'Cara', { customers: 'all' });
      // Another company's customer carries (555) 010-4004; no customer of this company does.
      const elsewhere = await fx.newOrg();
      orgs.push(elsewhere.org);
      await db.customer.update({ where: { id: elsewhere.customer }, data: { phone: '5550104004' } });
      await customerTexts(w, 'Who is this?', '+15550104004');
      const [unknown] = (await (await fx.signedInAs(w.admin)).get('/api/communication/threads')).body.threads as Listed[];
      expect(unknown!.pair!.customers).toEqual([]);

      expect(await opens(everyCustomer, unknown!.id)).toEqual(await opens(everyCustomer, randomUUID()));
    });
  });

  describe('an alert about the customer\'s text', () => {
    it('goes only to people who read that text when they open the conversation: the access filter and the route agree', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);
      const quoted = ((await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${id}`)).body.thread.messages as { id: string; body: string }[])
        .find((m) => m.body === 'Is Tuesday free?')!;
      const { filterRecipientsByAccess } = await import('../services/notifications/filterByAccess.js');
      const people = [w.admin, w.pia, w.nico];

      const kept = new Set(await filterRecipientsByAccess('MESSAGE_THREAD', id, people.map((p) => p.id), w.org, { messageId: quoted.id }));
      const verdicts: { filter: boolean; route: boolean }[] = [];
      for (const p of people) {
        const opened = await opens(p, id);
        verdicts.push({ filter: kept.has(p.id), route: 'texts' in opened && opened.texts!.includes('Is Tuesday free?') });
      }

      expect(verdicts).toEqual([{ filter: true, route: true }, { filter: true, route: true }, { filter: false, route: false }]);
    });
  });

  describe('a person who reaches neither customer', () => {
    it('does not see the conversation, and every refusal reads as it does for a conversation that does not exist', async () => {
      const w = await sharedNumberCompany();
      const id = await sharedConversation(w);
      const texts = (await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${id}`)).body.thread.messages as { id: string }[];
      const nico = await fx.signedInAs(w.nico);
      const missing = randomUUID();

      expect((await nico.get('/api/communication/threads')).body.threads).toEqual([]);
      // Each door, asked about the conversation (or one of its texts) and about an id that is nobody's: the same answer.
      const doors: [string, (target: string) => Promise<request.Response>][] = [
        ['open it', (t) => nico.get(`/api/communication/threads/${t}`)],
        ['mark it read', (t) => nico.patch(`/api/communication/threads/${t}/read`)],
        ['mark it unread', (t) => nico.patch(`/api/communication/threads/${t}/unread`)],
        ['reply in it', (t) => nico.post('/api/communication/sms', { threadId: t, body: 'Hello?' })],
      ];
      for (const [door, ask] of doors) {
        const [real, none] = [await ask(id), await ask(missing)];
        expect({ door, status: real.status, body: real.body }).toEqual({ door, status: none.status, body: none.body });
        expect({ door, status: real.status }).toEqual({ door, status: 404 });
      }
      const [real, none] = [
        await nico.patch(`/api/communication/sms/${texts[0]!.id}/lead`, { lead_id: null }),
        await nico.patch(`/api/communication/sms/${missing}/lead`, { lead_id: null }),
      ];
      expect({ status: real.status, body: real.body }).toEqual({ status: none.status, body: none.body });
      expect(await textsOnPageRefused(w.nico, w.pat)).toEqual(await textsOnPageRefused(w.nico, missing));
    });
  });
});
