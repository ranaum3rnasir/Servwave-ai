/* =============================================================================
   #3023 - A reply leaves from the conversation's number, and the box says so (parent #3013, decisions 2 and 3, Q40).

   Driven through the send route over HTTP against a real migrated database (TEST_DATABASE_URL; the suite skips when it is
   unset), for each sending case, together with the line the text box shows above it (GET /api/communication/sms/numbers,
   the same doors and the same numbers the send uses):
     - from a conversation, a text leaves from that conversation's number, whoever sends it;
     - from a customer, a lead or a job (by the customer, or by the number tapped on the record), a text continues the latest
       conversation with the number (decision 2); with none, it leaves from the sender's own number, else the main line;
     - once that number is released or inactive, a text leaves from the main line and is filed in the main-line conversation,
       which the send names so the screen can open it (decision 3);
     - another company with the same numbers changes nothing; a person who cannot read a conversation cannot send from its
       number by naming it.
   The numbers are the issue's: the customer (555) 010-5252, Dana's number (555) 010-1111, the main line (555) 010-0000.
   The phone system is faked at its network edge only: `fetch` answers the opt-out check, the send and a number's release,
   and records where each text went and the company number it left from. Every org the suite makes is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup replaces the phone-system client; here the real one runs, and only its network edge is faked.
vi.unmock('../lib/ctm/client');

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

// The phone system's address in this suite. Nothing outside it may be reached.
const PROVIDER = 'https://phone-provider.test/api/v1';

/** What the faked phone system was asked to send: where each text went, and the company number it left from. */
const sent: { to: string; from: string }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, every send is accepted, and a number can be released. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) {
    const form = new URLSearchParams(String(init.body));
    sent.push({ to: form.get('to') ?? '', from: form.get('from') ?? '' });
    return json({ id: `MSG-3023-${randomUUID()}` });
  }
  if (init?.method === 'DELETE' && /\/numbers\/[^/]+$/.test(path)) return json({});
  return json({ error: 'not found' }, 404);
}

// The issue's numbers.
const CUSTOMER_PHONE = '+15550105252';
const DANA_LINE = '+15550101111';
const MAIN_LINE = '+15550100000';
const TECH_LINE = '+15550102222';
const OUTSIDER_LINE = '+15550104444';

suite('a reply leaves from the conversation\'s number, and the box says so (real database)', () => {
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

  beforeEach(() => {
    sent.length = 0;
  });

  const orgs: string[] = [];
  afterAll(async () => {
    vi.unstubAllGlobals();
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'timeline_events', 'message_thread_read_states',
        'messages', 'message_threads', 'visit_assignees', 'visits']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  /**
   * A company connected to the phone system: its main line (555) 010-0000, Dana Ruiz with her own number (555) 010-1111,
   * a technician with a number of their own, and a customer whose phone is (555) 010-5252.
   */
  async function connectedOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3023${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const line = (e164: string, tpn: string, isDefault = false) => db.phoneNumber.create({
      data: {
        organization_id: made.org, e164, is_org_default: isDefault, status: 'active', sms_enabled: true,
        ctm_number_id: `${tpn}-${made.tag}`,
      },
    });
    await line(MAIN_LINE, 'TPN-MAIN', true);
    const danaNumber = await line(DANA_LINE, 'TPN-DANA');
    const techNumber = await line(TECH_LINE, 'TPN-TECH');
    const dana = await fx.addUser(made.org, 'Dana', 'ADMIN');
    await db.user.update({ where: { id: dana.id }, data: { last_name: 'Ruiz' } });
    await db.userPhoneNumber.create({ data: { user_id: dana.id, phone_number_id: danaNumber.id, is_default: true } });
    const tech = await fx.addUser(made.org, 'Tech', 'TECHNICIAN');
    await db.userPhoneNumber.create({ data: { user_id: tech.id, phone_number_id: techNumber.id, is_default: true } });
    // Stored bare, the way the customer forms store a phone.
    await db.customer.update({ where: { id: made.customer }, data: { phone: '5550105252' } });
    return {
      ...made, account, dana, tech, danaNumberId: danaNumber.id,
      mainTpn: `TPN-MAIN-${made.tag}`, danaTpn: `TPN-DANA-${made.tag}`, techTpn: `TPN-TECH-${made.tag}`,
    };
  }

  type Company = Awaited<ReturnType<typeof connectedOrg>>;

  /** The customer texts one of our numbers, as the phone system reports it. */
  async function customerTexts(w: Company, ourNumber: string, body: string, secondsAgo = 0) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-3023-${randomUUID()}`, account_id: w.account, caller_number: CUSTOMER_PHONE, tracking_number: ourNumber,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000) - secondsAgo,
      });
    expect(res.status).toBe(200);
  }

  /** The company's conversations as the inbox lists them to its admin: id, number pair, and texts. */
  async function conversations(w: Company) {
    const res = await (await fx.signedInAs(w.admin)).get('/api/communication/threads');
    expect(res.status).toBe(200);
    return (res.body.threads as { id: string; messages: { body: string }[]; pair?: { otherPartyE164: string; ourNumberE164: string | null } }[])
      .map((t) => ({ id: t.id, pair: t.pair ? [t.pair.otherPartyE164, t.pair.ourNumberE164] : null, texts: t.messages.map((m) => m.body).sort() }))
      .sort((a, b) => String(a.pair).localeCompare(String(b.pair)));
  }

  /**
   * What the line above the text box names for this send (the same fields the send takes): its numbers (`body`), and apart,
   * the conversation the text box continues (`conversationId`), which the inbox opens for Text on a customer.
   */
  async function lineFor(person: Person, target: Record<string, string>) {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/sms/numbers?${new URLSearchParams(target)}`);
    const { conversationId, ...numbers } = res.body as Record<string, unknown>;
    return { status: res.status, body: numbers, conversationId };
  }

  /** Dana's conversation with the customer: Dana texted them from the job, so the job's crew can read it. */
  async function danasConversation(w: Company) {
    const job = await fx.addJob(w.org, w.customer, { crew: [w.tech.id] });
    const first = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', {
      customerId: w.customer, jobId: job.id, body: 'Your door is on order',
    });
    expect(first.status).toBe(201);
    const conversation = (await conversations(w)).find((c) => c.texts.includes('Your door is on order'))!;
    expect(conversation.pair).toEqual([CUSTOMER_PHONE, DANA_LINE]);
    sent.length = 0;
    return { id: conversation.id, job };
  }

  describe('from a conversation, a text leaves from that conversation\'s number, whoever sends it', () => {
    it('a technician replying in Dana\'s conversation sends from (555) 010-1111, and the line says so', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);

      const line = await lineFor(w.tech, { threadId: dana.id });
      const reply = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { threadId: dana.id, body: 'On my way' });

      expect(line.status).toBe(200);
      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
      expect(line.conversationId).toBe(dana.id);
      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
      expect((await conversations(w)).find((c) => c.id === dana.id)!.texts).toEqual(['On my way', 'Your door is on order']);
    });

    it('Dana replying in her own conversation: the line says it leaves from her number', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);

      const line = await lineFor(w.dana, { threadId: dana.id });

      expect(line.status).toBe(200);
      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: true, noLongerInUse: null, cannotSendTexts: null });
    });
  });

  /** A person who may open every customer, lead and job, with a number of their own, (555) 010-3333. */
  async function officeWithOwnNumber(w: Company) {
    const own = await db.phoneNumber.create({
      data: { organization_id: w.org, e164: '+15550103333', status: 'active', sms_enabled: true, ctm_number_id: `TPN-OFFICE-${w.tag}` },
    });
    await db.userPhoneNumber.create({ data: { user_id: w.admin.id, phone_number_id: own.id, is_default: true } });
    return `TPN-OFFICE-${w.tag}`;
  }

  /** Every door a text is sent through from a customer, a lead or a job: the fields the text box sends. */
  const RECORD_DOORS = [
    ['the customer', 'customer'],
    ['the lead\'s text box', 'lead'],
    ['the job\'s text box', 'job'],
    ['Text on the lead\'s card (the number tapped, with the lead)', 'lead-number'],
    ['Text on the job\'s card or header (the number tapped, with the job)', 'job-number'],
    ['a number typed into the composer', 'number'],
  ] as const;
  type RecordDoor = (typeof RECORD_DOORS)[number][1];

  async function fieldsFor(w: Company, door: RecordDoor): Promise<Record<string, string>> {
    if (door === 'customer') return { customerId: w.customer };
    if (door === 'number') return { toNumber: '(555) 010-5252' };
    const record = door.startsWith('lead') ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
    const anchor: Record<string, string> = door.startsWith('lead') ? { leadId: record.id } : { jobId: record.id };
    return door.endsWith('number') ? { toNumber: '(555) 010-5252', ...anchor } : { customerId: w.customer, ...anchor };
  }

  describe('from a customer, a lead or a job, a text continues the latest conversation with the number (decision 2)', () => {
    it.each(RECORD_DOORS)('a text from %s to a customer Dana texted last week continues Dana\'s conversation', async (_name, door) => {
      const w = await connectedOrg();
      await officeWithOwnNumber(w);
      // Dana texted the customer last week from her number; the customer had texted the main line two weeks ago.
      const dana = await danasConversation(w);
      await customerTexts(w, MAIN_LINE, 'Do you sell storm doors?', 14 * 86_400);
      await db.message.updateMany({ where: { thread_id: dana.id }, data: { ts: new Date(Date.now() - 7 * 86_400_000) } });
      const fields = await fieldsFor(w, door);

      const line = await lineFor(w.admin, fields);
      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { ...fields, body: 'Following up on your door' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
      // Text on the customer opens this conversation (not the main-line one, which the customer updated more recently).
      expect(line.conversationId).toBe(dana.id);
      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
      expect(res.body.threadId).toBe(dana.id);
      expect((await conversations(w)).find((c) => c.id === dana.id)!.texts).toEqual(['Following up on your door', 'Your door is on order']);
    });
  });

  it('before the split reaches a customer\'s conversation, Text on the customer opens it, and the text continues it', async () => {
    const w = await connectedOrg();
    // A conversation from before pairs (the split script has not keyed it yet): the customer texted the main line.
    const mainLine = await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: MAIN_LINE } });
    const before = await db.messageThread.create({
      data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: w.customer },
    });
    await db.message.create({
      data: {
        organization_id: w.org, thread_id: before.id, direction: 'in', body: 'Texting before pairs', ts: new Date(Date.now() - 86_400_000),
        status: 'sent', phone_number_id: mainLine.id, other_party_e164: CUSTOMER_PHONE,
      },
    });

    const line = await lineFor(w.admin, { customerId: w.customer });
    const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { customerId: w.customer, body: 'Thanks for texting' });

    expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
    expect(line.conversationId).toBe(before.id);
    expect(res.status).toBe(201);
    expect(res.body.threadId).toBe(before.id);
    expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
  });

  /** The admin releases Dana's number on the Numbers screen (the phone system hands it back). */
  async function releaseDanasNumber(w: Company) {
    const res = await (await fx.signedInAs(w.admin)).delete(`/api/communication/numbers/${w.danaNumberId}`);
    expect(res.status).toBe(200);
  }

  describe('after (555) 010-1111 is released, a text leaves from the main line and lands in the main-line conversation', () => {
    it('a reply in Dana\'s conversation: the line says the number is no longer in use; the reply is filed in a new main-line conversation the answer names', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      await releaseDanasNumber(w);

      const line = await lineFor(w.tech, { threadId: dana.id });
      const reply = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { threadId: dana.id, body: 'Are you still home?' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(reply.body.threadId).not.toBe(dana.id);
      expect(await conversations(w)).toEqual([
        { id: reply.body.threadId, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Are you still home?'] },
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
      ]);
    });

    // Verifier r3 V3-TECH (acceptance line 4 with the issue's technician; spec r3 M2): the customer had texted the main line
    // before, so the pair (customer, main line) already has its conversation, which the technician cannot read. The reply
    // joins it - never a second main-line conversation - the customer's answer lands in it, and the screen can open it.
    it('the issue\'s technician: the reply joins the main-line conversation the customer already has, which they cannot read, and the customer\'s answer lands there', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      await customerTexts(w, MAIN_LINE, 'Earlier main line question');
      const mainLine = (await conversations(w)).find((c) => c.texts.includes('Earlier main line question'))!;
      await releaseDanasNumber(w);

      const reply = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { threadId: dana.id, body: 'Tech after release' });
      await customerTexts(w, MAIN_LINE, 'Customer answers the tech');

      expect(reply.status).toBe(201);
      expect(reply.body.threadId).toBe(mainLine.id);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(await conversations(w)).toEqual([
        { id: mainLine.id, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Customer answers the tech', 'Earlier main line question', 'Tech after release'] },
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
      ]);
      // The screen opens the conversation the answer names.
      expect((await (await fx.signedInAs(w.tech)).get(`/api/communication/threads/${mainLine.id}`)).status).toBe(200);
    });

    // Verifier r3 V3-TECH2 (spec r3 M2 at the job tab box): a technician with no number of their own texts from the job; the
    // text joins the main-line conversation the customer already has, and the customer's answer lands there, tied to the
    // job (#3020), so the technician reads it.
    it('a technician with no number of their own, from the job\'s text box: the text joins the main-line conversation the customer already has, and the answer is tied to the job', async () => {
      const w = await connectedOrg();
      await db.userPhoneNumber.deleteMany({ where: { user_id: w.tech.id } });
      const job = await fx.addJob(w.org, w.customer, { crew: [w.tech.id] });
      await customerTexts(w, MAIN_LINE, 'Earlier main line question');
      const mainLine = (await conversations(w)).find((c) => c.texts.includes('Earlier main line question'))!;
      const fields = { customerId: w.customer, jobId: job.id };

      const line = await lineFor(w.tech, fields);
      const res = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { ...fields, body: 'Tech from the job tab' });
      await customerTexts(w, MAIN_LINE, 'Customer answers the tech');

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
      expect(res.status).toBe(201);
      expect(res.body.threadId).toBe(mainLine.id);
      expect(await conversations(w)).toEqual([
        { id: mainLine.id, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Customer answers the tech', 'Earlier main line question', 'Tech from the job tab'] },
      ]);
      const theirs = await (await fx.signedInAs(w.tech)).get(`/api/communication/threads/${mainLine.id}`);
      expect((theirs.body.thread.messages as { body: string; jobId?: string }[]).filter((m) => m.body !== 'Earlier main line question').map((m) => [m.body, m.jobId]).sort())
        .toEqual([['Customer answers the tech', job.id], ['Tech from the job tab', job.id]]);
    });

    it('a number no longer active: the reply joins the main-line conversation the customer already has', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      await customerTexts(w, MAIN_LINE, 'Is the office open Saturday?');
      const mainLine = (await conversations(w)).find((c) => c.texts.includes('Is the office open Saturday?'))!;
      // The phone system no longer reports the number as active.
      await db.phoneNumber.update({ where: { id: w.danaNumberId }, data: { status: 'inactive' } });

      const line = await lineFor(w.dana, { threadId: dana.id });
      const reply = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { threadId: dana.id, body: 'Yes, 9 to noon' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(reply.body.threadId).toBe(mainLine.id);
      expect(await conversations(w)).toEqual([
        { id: mainLine.id, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Is the office open Saturday?', 'Yes, 9 to noon'] },
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
      ]);
    });

    it.each(RECORD_DOORS)('a text from %s whose latest conversation is on the released number', async (_name, door) => {
      const w = await connectedOrg();
      await officeWithOwnNumber(w);
      const dana = await danasConversation(w);
      await releaseDanasNumber(w);
      const fields = await fieldsFor(w, door);

      const line = await lineFor(w.admin, fields);
      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { ...fields, body: 'Checking in' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(await conversations(w)).toEqual([
        { id: res.body.threadId, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Checking in'] },
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
      ]);
    });

    it('when no number of the company can send texts either, the reply is refused as today and leaves no main-line conversation behind', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      await releaseDanasNumber(w);
      for (const number of [MAIN_LINE, TECH_LINE]) await cannotText(w, number, { sms_enabled: false });
      const before = await conversations(w);

      const line = await lineFor(w.tech, { threadId: dana.id });
      const reply = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { threadId: dana.id, body: 'Are you still home?' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
      expect([reply.status, reply.body]).toEqual([409, { error: 'No SMS-capable phone number is available for this conversation', code: 'NO_SMS_NUMBER' }]);
      expect(sent).toEqual([]);
      expect(await conversations(w)).toEqual(before);
      expect(before.map((c) => c.id)).toEqual([dana.id]);
    });
  });

  /** One of the company's numbers, still in use, made unable to send texts in one of the ways the phone system allows. */
  async function cannotText(w: Company, e164: string, how: { sms_enabled: false } | { ctm_number_id: null }) {
    await db.phoneNumber.updateMany({ where: { organization_id: w.org, e164 }, data: how });
  }
  const CANNOT_TEXT_WAYS = [
    ['texting is off', { sms_enabled: false }],
    ['the phone system has no id for it', { ctm_number_id: null }],
  ] as const;

  describe('a conversation\'s number still in use that cannot send texts: the line says so, and the text leaves from the main line', () => {
    it.each(CANNOT_TEXT_WAYS)('Dana\'s number when %s: the line reads "cannot send texts"; the reply leaves from the main line, filed in the main-line conversation the answer names', async (_how, how) => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      await cannotText(w, DANA_LINE, how);

      const line = await lineFor(w.tech, { threadId: dana.id });
      const reply = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { threadId: dana.id, body: 'Are you still home?' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: DANA_LINE });
      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(reply.body.threadId).not.toBe(dana.id);
      expect(await conversations(w)).toEqual([
        { id: reply.body.threadId, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Are you still home?'] },
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
      ]);
    });

    it.each(RECORD_DOORS)('a text from %s whose latest conversation is on Dana\'s number, which cannot send texts', async (_name, door) => {
      const w = await connectedOrg();
      await officeWithOwnNumber(w);
      const dana = await danasConversation(w);
      await cannotText(w, DANA_LINE, { sms_enabled: false });
      const fields = await fieldsFor(w, door);

      const line = await lineFor(w.admin, fields);
      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { ...fields, body: 'Checking in' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: DANA_LINE });
      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(await conversations(w)).toEqual([
        { id: res.body.threadId, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Checking in'] },
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
      ]);
    });

    it('a main line for calls only: a reply in the customer\'s main-line conversation says the main line cannot send texts, and leaves from the company\'s oldest number that can, filed in its conversation', async () => {
      const w = await connectedOrg();
      await officeWithOwnNumber(w);
      await cannotText(w, MAIN_LINE, { sms_enabled: false });
      await customerTexts(w, MAIN_LINE, 'Texting your main line');
      const mainLine = (await conversations(w)).find((c) => c.texts.includes('Texting your main line'))!;
      expect(mainLine.pair).toEqual([CUSTOMER_PHONE, MAIN_LINE]);

      const line = await lineFor(w.admin, { threadId: mainLine.id });
      const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: mainLine.id, body: 'Thanks for texting' });

      // The main line cannot text, so the company's number the main line's texts fall back to: its oldest that can, Dana's.
      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: MAIN_LINE });
      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
      expect(await conversations(w)).toEqual([
        { id: mainLine.id, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Texting your main line'] },
        { id: reply.body.threadId, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Thanks for texting'] },
      ]);
    });

    it('no number of the company can send texts: the line says so, and the reply is refused as today, with nothing sent or written', async () => {
      const w = await connectedOrg();
      await customerTexts(w, MAIN_LINE, 'Texting your main line');
      for (const number of [MAIN_LINE, DANA_LINE, TECH_LINE]) await cannotText(w, number, { sms_enabled: false });
      const before = await conversations(w);
      const mainLine = before.find((c) => c.texts.includes('Texting your main line'))!;

      const line = await lineFor(w.admin, { threadId: mainLine.id });
      const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: mainLine.id, body: 'Thanks for texting' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: MAIN_LINE });
      expect([reply.status, reply.body]).toEqual([409, { error: 'No SMS-capable phone number is available for this conversation', code: 'NO_SMS_NUMBER' }]);
      expect(sent).toEqual([]);
      expect(await conversations(w)).toEqual(before);
    });

    // Conductor's ruling (2026-11-06, from spec r2 F5): with no conversation and no number that can text, the line reads
    // "(555) 010-0000 cannot send texts." so the line and the send's refusal agree.
    it.each(RECORD_DOORS)('no number of the company can send texts and nobody texted the customer: from %s the line says the main line cannot send texts, and the send is refused with nothing written', async (_name, door) => {
      const w = await connectedOrg();
      for (const number of [MAIN_LINE, DANA_LINE, TECH_LINE]) await cannotText(w, number, { sms_enabled: false });
      const fields = await fieldsFor(w, door);

      const line = await lineFor(w.admin, fields);
      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { ...fields, body: 'Hello from ServWave' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: MAIN_LINE });
      expect([res.status, res.body]).toEqual([409, { error: 'No SMS-capable phone number is available for this conversation', code: 'NO_SMS_NUMBER' }]);
      expect(sent).toEqual([]);
      expect(await conversations(w)).toEqual([]);
    });
  });

  // Conductor's ruling (2026-11-06, from spec r2 L6): the main line takes the number-only wording, even for a person it is
  // assigned to.
  it('the main line is never "your number", even for the person it is assigned to', async () => {
    const w = await connectedOrg();
    const mainLine = await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: MAIN_LINE } });
    await db.userPhoneNumber.create({ data: { user_id: w.admin.id, phone_number_id: mainLine.id, is_default: true } });

    const fromCustomer = await lineFor(w.admin, { customerId: w.customer });
    const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { customerId: w.customer, body: 'Hello from ServWave' });
    const inConversation = await lineFor(w.admin, { threadId: res.body.threadId });

    expect(res.status).toBe(201);
    expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
    expect(fromCustomer.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
    expect(inConversation.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
  });

  describe('the company\'s own numbers and conversations only', () => {
    it('another company with the same numbers, a newer conversation with the customer, and (555) 010-1111 still in use changes nothing', async () => {
      const other = await connectedOrg();
      const w = await connectedOrg();
      await officeWithOwnNumber(w);
      const dana = await danasConversation(w);
      const lead = await fx.addLead(w.org, w.customer);
      // The other company's customer with the same number texts its technician's line, after Dana's text.
      const otherRes = await request(await fx.listener())
        .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
        .send({
          message_id: `MSG-3023-${randomUUID()}`, account_id: other.account, caller_number: CUSTOMER_PHONE, tracking_number: TECH_LINE,
          direction: 'msg_inbound', message_body: 'Texting the other company', unix_time: Math.floor(Date.now() / 1000) + 60,
        });
      expect(otherRes.status).toBe(200);
      const otherBefore = await conversations(other);

      const fromLead = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', {
        customerId: w.customer, leadId: lead.id, body: 'From the lead',
      });
      await releaseDanasNumber(w);
      const line = await lineFor(w.tech, { threadId: dana.id });
      const reply = await (await fx.signedInAs(w.tech)).post('/api/communication/sms', { threadId: dana.id, body: 'After the release' });

      expect([fromLead.status, reply.status]).toEqual([201, 201]);
      expect(fromLead.body.threadId).toBe(dana.id);
      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }, { to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(await conversations(other)).toEqual(otherBefore);
      expect(otherBefore.map((c) => c.texts)).toEqual([['Texting the other company']]);
    });
  });

  describe('reach: a person who cannot read a conversation cannot send from its number by naming it, or its customer\'s number', () => {
    it('a technician who is not on the job gets "Thread not found" for the line and the reply, and nothing is sent', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      const outsider = await fx.addUser(w.org, 'Outsider', 'TECHNICIAN');

      const line = await lineFor(outsider, { threadId: dana.id });
      const reply = await (await fx.signedInAs(outsider)).post('/api/communication/sms', { threadId: dana.id, body: 'Sneaking in' });

      expect([line.status, line.body]).toEqual([404, { error: 'Thread not found' }]);
      expect([reply.status, reply.body]).toEqual([404, { error: 'Thread not found' }]);
      expect(sent).toEqual([]);
      expect((await conversations(w)).find((c) => c.id === dana.id)!.texts).toEqual(['Your door is on order']);
    });

    /** A technician on no job of the customer's (so they cannot open the customer), with a number of their own, (555) 010-4444. */
    async function outsiderWithOwnNumber(w: Company) {
      const outsider = await fx.addUser(w.org, 'Outsider', 'TECHNICIAN');
      const own = await db.phoneNumber.create({
        data: { organization_id: w.org, e164: OUTSIDER_LINE, status: 'active', sms_enabled: true, ctm_number_id: `TPN-OUTSIDER-${w.tag}` },
      });
      await db.userPhoneNumber.create({ data: { user_id: outsider.id, phone_number_id: own.id, is_default: true } });
      return { outsider, numberId: own.id, tpn: `TPN-OUTSIDER-${w.tag}` };
    }

    it('a technician who cannot open the customer, typing the customer\'s number, is told and sends from their own number, in a conversation of their own', async () => {
      const w = await connectedOrg();
      const dana = await danasConversation(w);
      const { outsider, tpn } = await outsiderWithOwnNumber(w);

      const line = await lineFor(outsider, { toNumber: '(555) 010-5252' });
      const res = await (await fx.signedInAs(outsider)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Hello from the field' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: OUTSIDER_LINE, fromIsYours: true, noLongerInUse: null, cannotSendTexts: null });
      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: tpn }]);
      expect(res.body.threadId).not.toBe(dana.id);
      expect(await conversations(w)).toEqual([
        { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Your door is on order'] },
        { id: res.body.threadId, pair: [CUSTOMER_PHONE, OUTSIDER_LINE], texts: ['Hello from the field'] },
      ]);
    });

    // Was "... of nobody's, never the customer's" at r3/r2 (a second main-line conversation for the pair). Ran (2026-11-06,
    // after spec r3): joining the pair's conversation is never filtered by reach - never a second conversation for a pair
    // (spec r3 M2). The technician still reads only their own text in it.
    it.each([['is released', 'released'], ['can no longer send texts (verifier r2 R2-C, under the ruling)', 'cannot-text']] as const)('once that technician\'s number %s, their reply joins the pair\'s one main-line conversation, where the customer\'s answer lands too, and they read only their own text', async (_name, how) => {
      const w = await connectedOrg();
      await customerTexts(w, MAIN_LINE, 'Is the office open Saturday?');
      const customersMainLine = (await conversations(w)).find((c) => c.texts.includes('Is the office open Saturday?'))!;
      const { outsider, numberId } = await outsiderWithOwnNumber(w);
      const first = await (await fx.signedInAs(outsider)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Hello from the field' });
      expect(first.status).toBe(201);
      if (how === 'released') expect((await (await fx.signedInAs(w.admin)).delete(`/api/communication/numbers/${numberId}`)).status).toBe(200);
      else await db.phoneNumber.update({ where: { id: numberId }, data: { sms_enabled: false } });
      sent.length = 0;

      const line = await lineFor(outsider, { threadId: first.body.threadId });
      const reply = await (await fx.signedInAs(outsider)).post('/api/communication/sms', { threadId: first.body.threadId, body: 'Still there?' });
      const theirs = await (await fx.signedInAs(outsider)).get(`/api/communication/threads/${customersMainLine.id}`);
      await customerTexts(w, MAIN_LINE, 'Yes, still here');

      expect(line.body).toEqual({
        to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false,
        noLongerInUse: how === 'released' ? OUTSIDER_LINE : null, cannotSendTexts: how === 'released' ? null : OUTSIDER_LINE,
      });
      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(reply.body.threadId).toBe(customersMainLine.id);
      expect(await conversations(w)).toEqual([
        { id: customersMainLine.id, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Is the office open Saturday?', 'Still there?', 'Yes, still here'] },
        { id: first.body.threadId, pair: [CUSTOMER_PHONE, OUTSIDER_LINE], texts: ['Hello from the field'] },
      ]);
      // Read before the customer answers (an answer to their own text may be theirs to read: reply attribution).
      expect((theirs.body.thread.messages as { body: string }[]).map((m) => m.body)).toEqual(['Still there?']);
    });

    it('a person who reaches no customer carrying the number and has no number of their own joins the pair\'s one main-line conversation, never a second one, and the customer\'s answer lands in it', async () => {
      const w = await connectedOrg();
      // A dispatcher with no number of their own texted the customer from job J1: the main-line conversation holds only texts
      // about a job the technician below cannot open.
      const job = await fx.addJob(w.org, w.customer);
      const first = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { customerId: w.customer, jobId: job.id, body: 'Your install is booked' });
      expect(first.status).toBe(201);
      await customerTexts(w, MAIN_LINE, 'Thanks!');
      const technician = await fx.addUser(w.org, 'Outsider', 'TECHNICIAN');
      sent.length = 0;

      const line = await lineFor(technician, { toNumber: '(555) 010-5252' });
      const res = await (await fx.signedInAs(technician)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Bringing the parts' });
      const theirs = await (await fx.signedInAs(technician)).get(`/api/communication/threads/${first.body.threadId}`);
      await customerTexts(w, MAIN_LINE, 'See you then');

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
      expect(line.conversationId).toBeNull();
      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
      expect(res.body.threadId).toBe(first.body.threadId);
      expect(await conversations(w)).toEqual([{
        id: first.body.threadId, pair: [CUSTOMER_PHONE, MAIN_LINE],
        texts: ['Bringing the parts', 'See you then', 'Thanks!', 'Your install is booked'],
      }]);
      // Read before the customer answers (an answer to their own text may be theirs to read: reply attribution).
      expect((theirs.body.thread.messages as { body: string }[]).map((m) => m.body)).toEqual(['Bringing the parts']);
    });

    /**
     * Conductor's ruling (2026-11-06, #3021 decision 4): a person may continue a conversation exactly when they can read it - a
     * customer they can open carries its number, or it holds a text of theirs or of a lead or job they can open - never because
     * it is filed on nobody, and whichever door they text from.
     */
    describe('who may continue a conversation is who can read it, at every door (#3021 decision 4)', () => {
      let sequence = 0;
      /** These switches off, and every switch that needs one of them off too, so the set is one the product stores. */
      const withDependantsOff = (off: string[]): Record<string, SwitchValue> => {
        const out: Record<string, SwitchValue> = Object.fromEntries(off.map((k) => [k, false]));
        for (let grew = true; grew;) {
          grew = false;
          for (const sw of SWITCH_CATALOG) {
            if (!(sw.key in out) && sw.requires.some((r) => out[r] === false)) { out[sw.key] = false; grew = true; }
          }
        }
        return out;
      };

      /**
       * A person on a role of their own: they open customer pages and text on Communication scope Attached, reaching the leads
       * and jobs attached to them (so the customers of those). No number of the company is theirs and the main-line fallback
       * is off. `off`: switches turned off for this person (and every switch that needs one of them).
       */
      async function personWho(w: Company, name: string, off: string[] = []) {
        const key = `reply-number-${++sequence}`;
        await fx.addCustomRole(w.org, key, 'DISPATCHER');
        await fx.setRoleSwitches(w.org, key, {
          view_customers: true, contact_customers: true, view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
          access_communication: true, view_communication: true, communication_scope: 'attached', see_main_line_when_no_number: false,
          ...withDependantsOff(off),
        });
        const role = await db.customRole.findFirstOrThrow({ where: { organization_id: w.org, key } });
        return fx.addUser(w.org, name, 'DISPATCHER', { customRoleId: role.id });
      }

      /**
       * Pat Morgan carries the customer's number (555) 010-5252 too. The customer (Jordan) has the newer open lead, so the fixed
       * order (#3015) names Jordan for the number; Pia owns Pat's lead, so she reaches Pat Morgan and no one else.
       */
      async function patCarriesTheNumber(w: Company) {
        const pat = randomUUID();
        await db.customer.create({
          data: {
            id: pat, organization_id: w.org, customer_number: `C-${pat.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
            first_name: 'Pat', last_name: 'Morgan', phone: CUSTOMER_PHONE,
          },
        });
        const pia = await personWho(w, 'Pia');
        const patLead = await fx.addLead(w.org, pat, { owner: pia.id });
        const jordanLead = await fx.addLead(w.org, w.customer);
        await db.lead.update({ where: { id: jordanLead.id }, data: { created_at: new Date(Date.now() + 1000) } });
        return { pat, pia, patLead: patLead.id, patJob: (await fx.addJob(w.org, pat, { crew: [pia.id] })).id };
      }

      /** The customer texts Dana's line while no customer carries (555) 010-5252: the conversation is filed on nobody. */
      async function conversationFiledOnNobody(w: Company) {
        await db.customer.update({ where: { id: w.customer }, data: { phone: null } });
        await customerTexts(w, DANA_LINE, 'Who is this?');
        // Later the office adds the number to the customer.
        await db.customer.update({ where: { id: w.customer }, data: { phone: '5550105252' } });
        const conversation = (await conversations(w)).find((c) => c.texts.includes('Who is this?'))!;
        expect(conversation.pair).toEqual([CUSTOMER_PHONE, DANA_LINE]);
        return conversation.id;
      }

      const PIA_DOORS = [
        ['Text on Pat\'s lead card (the number tapped, with the lead)', 'lead-number'],
        ['the number typed into the composer', 'number'],
        ['Pat\'s lead\'s text box', 'lead'],
        // Verifier r3 L4: the job doors and the customer page / dialer too.
        ['Text on Pat\'s job card or header (the number tapped, with the job)', 'job-number'],
        ['Pat\'s job\'s text box', 'job'],
        ['Text on Pat Morgan (customer page, dialer)', 'customer'],
      ] as const;

      it.each(PIA_DOORS)('a person who reaches only the second customer carrying the number continues the latest conversation from %s', async (_name, door) => {
        const w = await connectedOrg();
        const { pat, pia, patLead, patJob } = await patCarriesTheNumber(w);
        // The customer texts Dana's line: the conversation is filed on Jordan (the fixed order), and shown on Pat too.
        await customerTexts(w, DANA_LINE, 'Is my door in?');
        const dana = (await conversations(w)).find((c) => c.texts.includes('Is my door in?'))!;
        const fields: Record<string, string> = door === 'number' ? { toNumber: '(555) 010-5252' }
          : door === 'lead-number' ? { toNumber: '(555) 010-5252', leadId: patLead }
            : door === 'job-number' ? { toNumber: '(555) 010-5252', jobId: patJob }
              : door === 'job' ? { customerId: pat, jobId: patJob }
                : door === 'customer' ? { customerId: pat } : { customerId: pat, leadId: patLead };

        const line = await lineFor(pia, fields);
        const res = await (await fx.signedInAs(pia)).post('/api/communication/sms', { ...fields, body: 'It arrived today' });

        expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
        expect(line.conversationId).toBe(dana.id);
        expect(res.status).toBe(201);
        expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
        expect(res.body.threadId).toBe(dana.id);
        expect(await conversations(w)).toEqual([{ id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Is my door in?', 'It arrived today'] }]);
      });

      /**
       * Ran (2026-11-06, after spec r3): reach to continue is decided per conversation. Dana texted Jordan Lee from his job J1
       * and Jordan's answer was tied to J1 (#3020), so every text of Dana's conversation is about a job Sam cannot open. Sam,
       * with a number of his own (555) 010-4444, owns L19835 on Jordan: he opens Jordan, a customer carrying the number, so he
       * continues Dana's conversation from her number at every door, and still reads none of her texts.
       */
      const SAM_DOORS = [
        ['L19835\'s text box', 'lead'],
        ['Text on L19835\'s card (the number tapped, with the lead)', 'lead-number'],
        ['the number typed into the composer', 'number'],
        ['Text on Jordan Lee (the inbox\'s New message to the customer)', 'customer'],
        ['a reply in the conversation itself (by its id)', 'thread'],
      ] as const;

      it.each(SAM_DOORS)('a person who opens the customer continues a conversation whose every text is about a job they cannot open, from %s', async (_name, door) => {
        const w = await connectedOrg();
        const dana = await danasConversation(w);
        await customerTexts(w, DANA_LINE, 'Great, when is install?');
        const sam = await personWho(w, 'Sam');
        const own = await db.phoneNumber.create({
          data: { organization_id: w.org, e164: OUTSIDER_LINE, status: 'active', sms_enabled: true, ctm_number_id: `TPN-SAM-${w.tag}` },
        });
        await db.userPhoneNumber.create({ data: { user_id: sam.id, phone_number_id: own.id, is_default: true } });
        const lead = await fx.addLead(w.org, w.customer, { owner: sam.id });
        const fields: Record<string, string> = door === 'lead' ? { customerId: w.customer, leadId: lead.id }
          : door === 'lead-number' ? { toNumber: '(555) 010-5252', leadId: lead.id }
            : door === 'number' ? { toNumber: '(555) 010-5252' } : door === 'thread' ? { threadId: dana.id } : { customerId: w.customer };

        const line = await lineFor(sam, fields);
        const res = await (await fx.signedInAs(sam)).post('/api/communication/sms', { ...fields, body: 'Following up on your estimate' });

        expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
        // He reads no text of it yet, so Text on the customer opens New message to the customer (which continues it), never
        // a conversation he would be refused.
        expect(line.conversationId).toBeNull();
        expect(res.status).toBe(201);
        expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
        expect(res.body.threadId).toBe(dana.id);
        expect(await conversations(w)).toEqual([{
          id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE],
          texts: ['Following up on your estimate', 'Great, when is install?', 'Your door is on order'],
        }]);
        // He still never sees a text he cannot open: only his own.
        const his = await (await fx.signedInAs(sam)).get(`/api/communication/threads/${dana.id}`);
        expect(his.status).toBe(200);
        expect((his.body.thread.messages as { body: string }[]).map((m) => m.body)).toEqual(['Following up on your estimate']);
        // A text from the lead keeps the lead.
        const asAdmin = await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${dana.id}`);
        const mine = (asAdmin.body.thread.messages as { body: string; leadId?: string }[]).find((m) => m.body === 'Following up on your estimate')!;
        expect(mine.leadId).toBe(door.startsWith('lead') ? lead.id : undefined);
      });

      // Spec r3 L1: before the split, Text on the customer must not name a conversation the person cannot read (the inbox
      // would refuse it): New message to the customer instead, whose send joins it as before.
      it('before the split, a conversation filed on the customer whose texts are all about a job the person cannot open: they may reply in it, Text on the customer opens New message, and the text joins it', async () => {
        const w = await connectedOrg();
        const job = await fx.addJob(w.org, w.customer);
        const mainLine = await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: MAIN_LINE } });
        const before = await db.messageThread.create({
          data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: w.customer },
        });
        await db.message.create({
          data: {
            organization_id: w.org, thread_id: before.id, direction: 'in', body: 'About the install', ts: new Date(Date.now() - 86_400_000),
            status: 'sent', phone_number_id: mainLine.id, other_party_e164: CUSTOMER_PHONE, job_id: job.id,
          },
        });
        const sam = await personWho(w, 'Sam');
        const lead = await fx.addLead(w.org, w.customer, { owner: sam.id });

        const reply = await lineFor(sam, { threadId: before.id });
        const line = await lineFor(sam, { customerId: w.customer, leadId: lead.id });
        const res = await (await fx.signedInAs(sam)).post('/api/communication/sms', { customerId: w.customer, leadId: lead.id, body: 'Following up' });

        expect([reply.status, reply.body]).toEqual([200, { to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null }]);
        expect(line.conversationId).toBeNull();
        expect(res.status).toBe(201);
        expect(res.body.threadId).toBe(before.id);
        const his = await (await fx.signedInAs(sam)).get(`/api/communication/threads/${before.id}`);
        expect((his.body.thread.messages as { body: string }[]).map((m) => m.body)).toEqual(['Following up']);
      });

      /**
       * Ran (2026-11-06, after spec r3): a text from a lead or a job keeps that lead or job, so #3020 ties the answer to it. Text
       * on Pat's lead (or job) opens Dana's conversation, filed on Jordan Lee (the fixed order), and the reply is sent in it
       * with the record (spec r3 M3). A record whose customer does not carry the conversation's number is still not stamped.
       */
      it.each([['lead'], ['job']] as const)('a reply in a shared conversation filed on another customer, sent from Pat\'s %s, is tied to it, and so is Pat\'s answer', async (kind) => {
        const w = await connectedOrg();
        const { pat } = await patCarriesTheNumber(w);
        await customerTexts(w, DANA_LINE, 'Is my door in?');
        const dana = (await conversations(w)).find((c) => c.texts.includes('Is my door in?'))!;
        const record = kind === 'lead' ? await fx.addLead(w.org, pat) : await fx.addJob(w.org, pat);
        const field = kind === 'lead' ? 'leadId' : 'jobId';

        const line = await lineFor(w.admin, { threadId: dana.id, [field]: record.id });
        const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: dana.id, [field]: record.id, body: 'It arrived today' });
        await customerTexts(w, DANA_LINE, 'Great, Thursday?');

        expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
        expect(reply.status).toBe(201);
        expect(reply.body.threadId).toBe(dana.id);
        expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
        const thread = await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${dana.id}`);
        const tie = (body: string) => (thread.body.thread.messages as { body: string; leadId?: string; jobId?: string }[]).find((m) => m.body === body)![field];
        expect([tie('It arrived today'), tie('Great, Thursday?')]).toEqual([record.id, record.id]);
      });

      it('a reply in that conversation sent from the lead of a customer who does not carry its number is not tied to the lead', async () => {
        const w = await connectedOrg();
        await patCarriesTheNumber(w);
        await customerTexts(w, DANA_LINE, 'Is my door in?');
        const dana = (await conversations(w)).find((c) => c.texts.includes('Is my door in?'))!;
        const elsewhere = await db.customer.create({
          data: {
            id: randomUUID(), organization_id: w.org, customer_number: `C-${randomUUID().slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
            first_name: 'Robin', last_name: 'Vale', phone: '5550109898',
          },
        });
        const lead = await fx.addLead(w.org, elsewhere.id);

        const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: dana.id, leadId: lead.id, body: 'It arrived today' });

        expect(reply.status).toBe(201);
        const thread = await (await fx.signedInAs(w.admin)).get(`/api/communication/threads/${dana.id}`);
        expect((thread.body.thread.messages as { body: string; leadId?: string }[]).find((m) => m.body === 'It arrived today')!.leadId).toBeUndefined();
      });

      // Was "... is not theirs to continue" at r3 (per-text rule). Ran (2026-11-06, after spec r3) ruled it per conversation:
      // Pia opens Pat Morgan, a customer carrying the number, so she continues it (spec r3 M1, scenario B), from Pat's lead.
      it('from the second customer\'s own page too, a person continues a conversation whose every text is about a lead they cannot open', async () => {
        const w = await connectedOrg();
        const { pat, pia, patLead } = await patCarriesTheNumber(w);
        // Dana texts Jordan from his lead: the only text of the conversation is tied to a lead Pia cannot open.
        const jordansLead = await fx.addLead(w.org, w.customer);
        const first = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { customerId: w.customer, leadId: jordansLead.id, body: 'Your estimate is ready' });
        expect(first.status).toBe(201);
        sent.length = 0;

        const line = await lineFor(pia, { customerId: pat, leadId: patLead });
        const res = await (await fx.signedInAs(pia)).post('/api/communication/sms', { customerId: pat, leadId: patLead, body: 'About your lead' });

        expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
        expect(line.conversationId).toBeNull();
        expect(res.status).toBe(201);
        expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }]);
        expect(res.body.threadId).toBe(first.body.threadId);
        expect(await conversations(w)).toEqual([
          { id: first.body.threadId, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['About your lead', 'Your estimate is ready'] },
        ]);
        // She reads only her own text in it, and it is tied to Pat's lead.
        const hers = await (await fx.signedInAs(pia)).get(`/api/communication/threads/${first.body.threadId}`);
        expect((hers.body.thread.messages as { body: string; leadId?: string }[]).map((m) => [m.body, m.leadId])).toEqual([['About your lead', patLead]]);
      });

      it('a person who cannot read a conversation filed on nobody never continues it, or hears of its number: they text from their own number', async () => {
        const w = await connectedOrg();
        const filedOnNobody = await conversationFiledOnNobody(w);
        const { outsider, tpn } = await outsiderWithOwnNumber(w);

        const line = await lineFor(outsider, { toNumber: '(555) 010-5252' });
        const res = await (await fx.signedInAs(outsider)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Hello from the field' });

        expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: OUTSIDER_LINE, fromIsYours: true, noLongerInUse: null, cannotSendTexts: null });
        expect(res.status).toBe(201);
        expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: tpn }]);
        expect(await conversations(w)).toEqual([
          { id: filedOnNobody, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Who is this?'] },
          { id: res.body.threadId, pair: [CUSTOMER_PHONE, OUTSIDER_LINE], texts: ['Hello from the field'] },
        ]);
      });

      it('a person without Access Communication who cannot read that conversation is starting a new one: refused, nothing sent', async () => {
        const w = await connectedOrg();
        const filedOnNobody = await conversationFiledOnNobody(w);
        const person = await personWho(w, 'Noa', ['access_communication']);
        const before = await conversations(w);

        const res = await (await fx.signedInAs(person)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Hello there' });

        expect([res.status, res.body]).toEqual([403, { error: 'Starting a new conversation from the inbox requires access to the Communication section.' }]);
        expect(sent).toEqual([]);
        expect(await conversations(w)).toEqual(before);
        expect(before.map((c) => c.id)).toEqual([filedOnNobody]);
      });

      it('a person without Access Communication who reaches no customer carrying the number: the pair\'s conversation they cannot continue still counts as starting a new one: refused, nothing sent', async () => {
        const w = await connectedOrg();
        await customerTexts(w, MAIN_LINE, 'Is the office open Saturday?');
        const person = await personWho(w, 'Noa', ['access_communication']);
        const before = await conversations(w);

        const res = await (await fx.signedInAs(person)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Hello there' });

        expect([res.status, res.body]).toEqual([403, { error: 'Starting a new conversation from the inbox requires access to the Communication section.' }]);
        expect(sent).toEqual([]);
        expect(await conversations(w)).toEqual(before);
        expect(before.map((c) => c.pair)).toEqual([[CUSTOMER_PHONE, MAIN_LINE]]);
      });

      it('a reply moved off a conversation filed on nobody joins the main-line conversation the customer already has, never a second one', async () => {
        const w = await connectedOrg();
        const filedOnNobody = await conversationFiledOnNobody(w);
        await customerTexts(w, MAIN_LINE, 'Is the office open Saturday?');
        const mainLine = (await conversations(w)).find((c) => c.texts.includes('Is the office open Saturday?'))!;
        await releaseDanasNumber(w);

        const line = await lineFor(w.admin, { threadId: filedOnNobody });
        const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: filedOnNobody, body: 'Yes, 9 to noon' });

        expect(line.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
        expect(reply.status).toBe(201);
        expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.mainTpn }]);
        expect(reply.body.threadId).toBe(mainLine.id);
        expect(await conversations(w)).toEqual([
          { id: mainLine.id, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['Is the office open Saturday?', 'Yes, 9 to noon'] },
          { id: filedOnNobody, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Who is this?'] },
        ]);
      });
    });
  });

  describe('a text to a customer nobody texted leaves from the sender\'s own number, else the main line', () => {
    const SENDERS = [
      ['Dana, from her own number', 'dana', DANA_LINE, true],
      ['a person with no number, from the main line', 'admin', MAIN_LINE, false],
    ] as const;
    const CASES = RECORD_DOORS.flatMap(([doorName, door]) => SENDERS.map(([who, sender, from, yours]) => [doorName, who, door, sender, from, yours] as const));

    it.each(CASES)('from %s: %s', async (_doorName, _who, door, sender, from, yours) => {
      const w = await connectedOrg();
      const fields = await fieldsFor(w, door);
      const person = sender === 'dana' ? w.dana : w.admin;

      const line = await lineFor(person, fields);
      const res = await (await fx.signedInAs(person)).post('/api/communication/sms', { ...fields, body: 'Hello from ServWave' });

      expect(line.body).toEqual({ to: CUSTOMER_PHONE, from, fromIsYours: yours, noLongerInUse: null, cannotSendTexts: null });
      expect(line.conversationId).toBeNull();
      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: sender === 'dana' ? w.danaTpn : w.mainTpn }]);
      expect(await conversations(w)).toEqual([{ id: res.body.threadId, pair: [CUSTOMER_PHONE, from], texts: ['Hello from ServWave'] }]);
    });
  });

  it('journey: Dana texts from the job, the technician answers from her number, her number is released, the next reply leaves from the main line', async () => {
    const w = await connectedOrg();
    const dana = await danasConversation(w);
    await customerTexts(w, DANA_LINE, 'Great, when is install?');
    const tech = await fx.signedInAs(w.tech);

    const before = await lineFor(w.tech, { threadId: dana.id });
    const first = await tech.post('/api/communication/sms', { threadId: dana.id, body: 'Thursday morning' });
    await releaseDanasNumber(w);
    const after = await lineFor(w.tech, { threadId: dana.id });
    const second = await tech.post('/api/communication/sms', { threadId: dana.id, body: 'Running 10 minutes late' });
    await customerTexts(w, MAIN_LINE, 'No problem');

    expect(before.body).toEqual({ to: CUSTOMER_PHONE, from: DANA_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
    expect(after.body).toEqual({ to: CUSTOMER_PHONE, from: MAIN_LINE, fromIsYours: false, noLongerInUse: DANA_LINE, cannotSendTexts: null });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.threadId).toBe(dana.id);
    expect(sent).toEqual([{ to: CUSTOMER_PHONE, from: w.danaTpn }, { to: CUSTOMER_PHONE, from: w.mainTpn }]);
    expect(await conversations(w)).toEqual([
      { id: second.body.threadId, pair: [CUSTOMER_PHONE, MAIN_LINE], texts: ['No problem', 'Running 10 minutes late'] },
      { id: dana.id, pair: [CUSTOMER_PHONE, DANA_LINE], texts: ['Great, when is install?', 'Thursday morning', 'Your door is on order'] },
    ]);
  });
});
