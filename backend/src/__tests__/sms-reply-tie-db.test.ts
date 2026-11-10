/* =============================================================================
   #3020 - A reply lands on the lead that texted (parent #3013).

   An incoming text takes the lead or job of the latest text we sent in its conversation, from a person or an automation,
   within 30 days, while that lead or job is open. Else it takes the one open lead or job carrying the number as its own,
   when exactly one does. Else it stays untied. Texts the phone system sends by itself (an opt-in confirmation) never count
   as the latest text we sent.

   Driven through the incoming-text webhook over HTTP against a real migrated database (TEST_DATABASE_URL; the suite skips
   when it is unset), with the texts we send going through the real send route. What a person gets is read back through
   the app: the inbox (each text with its lead or job), the lead itself, and the alerts of the person who texted. The phone
   system is faked at its network edge only (`fetch`). Every company the suite makes is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
// The suite-wide setup replaces the automation dispatcher with a stub; here the real one runs, so a new lead fires its automation.
vi.mock('../services/automations/dispatch', async (importOriginal) => importOriginal());

import { switchFixture, type Person } from './permission-switches-fixture';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

// The phone system's address in this suite. Nothing outside it may be reached.
const PROVIDER = 'https://phone-provider.test/api/v1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Texts the phone system refuses to send, by their words. */
const REJECTED = new Set<string>();

/**
 * The phone system at its network edge: no one has opted out, and every send is accepted with a fresh message id, except a
 * text whose words are in REJECTED.
 */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) {
    const words = new URLSearchParams(String(init.body)).get('msg') ?? '';
    if (REJECTED.has(words)) return json({ error: 'rejected' }, 422);
    return json({ id: `MSG-3020-${randomUUID()}` });
  }
  return json({ error: 'not found' }, 404);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The number two customers share, stored bare the way the customer forms store a phone. */
const SHARED_PHONE = '5550104410';
const SHARED_E164 = '+15550104410';

suite('a reply lands on the lead or job that texted (real database)', () => {
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
      for (const table of ['workflow_step_runs', 'workflow_enrollments', 'workflow_versions', 'workflow_steps', 'workflows',
        'notification_recipients', 'notifications', 'timeline_events', 'message_thread_read_states',
        'messages', 'message_threads', 'lead_status_history', 'record_contact_entries']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visit_assignees WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visits WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM lead_assignees WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM jobs WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM customers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;
  // Placeholders in the 555-01xx range only: (555) 010-70nn for main lines, (555) 010-80nn for Sam's.
  const nextNumber = (prefix: string) => `${prefix}${String(++sequence).padStart(2, '0')}`;

  /**
   * A company connected to the phone system, with its main line and Sam Rivera, a salesperson with a number of his own.
   * Two customers share (555) 010-4410: Pat Payer, a record made years ago, and Jordan Lee, made today. Each has an open
   * lead. `numbers` lets a second company carry the very same numbers.
   */
  async function connectedOrg(numbers?: { mainLine: string; samLine: string }) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3020${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = numbers?.mainLine ?? nextNumber('+155501070');
    const samLine = numbers?.samLine ?? nextNumber('+155501080');
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN-MAIN-${made.tag}`,
      },
    });
    const samNumber = await db.phoneNumber.create({
      data: { organization_id: made.org, e164: samLine, status: 'active', sms_enabled: true, ctm_number_id: `TPN-SAM-${made.tag}` },
    });
    const sam = await fx.addUser(made.org, 'Sam', 'SALES');
    await db.user.update({ where: { id: sam.id }, data: { last_name: 'Rivera' } });
    await db.userPhoneNumber.create({ data: { user_id: sam.id, phone_number_id: samNumber.id, is_default: true } });
    // A salesperson who has nothing to do with this exchange.
    const kim = await fx.addUser(made.org, 'Kim', 'SALES');

    const older = made.customer;
    await db.customer.update({
      where: { id: older },
      data: { phone: SHARED_PHONE, created_at: new Date('2022-03-01T12:00:00Z') },
    });
    const newer = randomUUID();
    await db.customer.create({
      data: {
        id: newer, organization_id: made.org, customer_number: `C-${newer.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Jordan', last_name: 'Lee', phone: SHARED_PHONE,
      },
    });
    const olderLead = await fx.addLead(made.org, older);
    const newerLead = await fx.addLead(made.org, newer, { assignees: [sam.id] });
    return { ...made, account, sam, kim, mainLine, samLine, older, newer, olderLead: olderLead.id, newerLead: newerLead.id };
  }

  type Company = Awaited<ReturnType<typeof connectedOrg>>;

  /** The customer texts one of our numbers, as the phone system reports it. */
  async function customerTexts(w: Company, ourNumber: string, body: string, from = SHARED_E164) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-3020-${randomUUID()}`, account_id: w.account, caller_number: from, tracking_number: ourNumber,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000),
      });
    expect(res.status).toBe(200);
  }

  /**
   * A person texts the customer from a lead's or a job's text box (or the customer's page), as the screen sends it; with
   * `toNumber`, Text on one of the record's own numbers.
   */
  async function textFrom(person: Person, body: string, on: { customerId?: string; toNumber?: string; leadId?: string; jobId?: string }) {
    const res = await (await fx.signedInAs(person)).post('/api/communication/sms', { ...on, body });
    expect(res.status).toBe(201);
  }

  type Listed = { body: string; direction: string; leadId?: string; jobId?: string };

  /** The company's conversations as the inbox lists them to its admin. */
  async function inbox(w: Company) {
    const res = await (await fx.signedInAs(w.admin)).get('/api/communication/threads');
    expect(res.status).toBe(200);
    return res.body.threads as {
      id: string; messages: Listed[]; pair?: { otherPartyE164: string; ourNumberE164: string | null };
    }[];
  }

  /** The lead or job a text shows in the inbox (its grey "lead or job" line), found by its words. */
  async function tieOf(w: Company, body: string) {
    const text = (await inbox(w)).flatMap((t) => t.messages).find((m) => m.body === body);
    expect(text, `"${body}" is in the inbox`).toBeDefined();
    return { leadId: text!.leadId ?? null, jobId: text!.jobId ?? null };
  }

  /** The texts alerts a person has in their bell, by the words they quote. */
  async function textAlertsOf(person: Person) {
    const res = await (await fx.signedInAs(person)).get('/api/notifications');
    expect(res.status).toBe(200);
    return (res.body.items as { verb: string; body: string | null }[])
      .filter((n) => n.verb === 'communication.sms_inbound')
      .map((n) => n.body);
  }

  /** Moves a text we sent back in time, the way it reads when it went out `ms` ago. */
  async function sentAgo(w: Company, body: string, ms: number) {
    const moved = await db.message.updateMany({
      where: { organization_id: w.org, body, direction: 'out' },
      data: { ts: new Date(Date.now() - ms) },
    });
    expect(moved.count).toBe(1);
  }

  /**
   * The phone system sends a text by itself (an opt-in confirmation) from one of our numbers, and reports it the way it
   * reports every text sent outside the app: a `status_change` carrying the whole text, the customer as its contact.
   */
  async function phoneSystemSends(w: Company, ourNumber: string, body: string, secondsAgo: number, to = SHARED_E164) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/status_change?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-3020-${randomUUID()}`, account_id: w.account, caller_number: to, contact_number: to,
        called_number: ourNumber, tracking_number: ourNumber, direction: 'msg_outbound', status: 'sent', call_status: 'sent',
        message_body: body, unix_time: Math.floor(Date.now() / 1000) - secondsAgo,
      });
    expect(res.status).toBe(200);
  }

  /** The record's pencil (its contact card), as a person uses it: add a number only this record carries. */
  async function addOwnNumber(w: Company, kind: 'lead' | 'job', id: string, value: string) {
    const res = await (await fx.signedInAs(w.admin)).post(`/api/${kind}s/${id}/contact-entries`, { kind: 'PHONE', value });
    expect(res.status).toBe(201);
  }

  /** What a new-lead automation texts the customer. */
  const WELCOME = 'Thanks for your request, when suits you?';

  /** The admin publishes "text the customer" on a new lead, as the automation builder makes it. */
  async function newLeadTextsTheCustomer(w: Company) {
    const admin = await fx.signedInAs(w.admin);
    const made = await admin.post('/api/workflows', {
      name: 'Welcome text', trigger_type: 'LEAD_CREATED', send_window: 'ANYTIME',
      steps: [{ step_type: 'SEND_TEXT', config: { recipients: ['customer'], body: WELCOME } }],
    });
    expect(made.status).toBe(201);
    const published = await admin.post(`/api/workflows/${made.body.id}/publish`, { enable: true });
    expect(published.status).toBe(200);
  }

  /**
   * The admin makes a lead for a customer with Sam as its owner; the automation then texts the customer from the main line.
   * Sam has a number of his own and is not on the main line, so a reply on the main line tells him only through his lead.
   */
  async function newLeadFor(w: Company, customerId: string) {
    const res = await (await fx.signedInAs(w.admin)).post('/api/leads', {
      customer_id: customerId, service_request: 'New garage door', assigned_to: w.sam.id,
    });
    expect(res.status).toBe(201);
    return res.body.lead.id as string;
  }

  /** Waits until the inbox shows the text `body` past "queued" (it went out, or did not), and returns that status. */
  async function settled(w: Company, body: string) {
    let status: string | undefined;
    for (let tries = 0; tries < 100; tries++) {
      const text = (await inbox(w)).flatMap((t) => t.messages as (Listed & { status?: string })[]).find((m) => m.body === body);
      status = text?.status;
      if (status && status !== 'queued') return status;
      await new Promise((r) => setTimeout(r, 100));
    }
    return status;
  }

  describe('the highest seam', () => {
    it('two customers share a number; a reply to a text sent from the newer one\'s lead lands in that conversation, carries that lead, and alerts the sender', async () => {
      const w = await connectedOrg();

      // Sam texts Jordan from Jordan's lead. With no conversation yet it leaves from his own number.
      await textFrom(w.sam, 'Can we come Tuesday?', { customerId: w.newer, leadId: w.newerLead });
      await customerTexts(w, w.samLine, 'Yes, Tuesday works');

      const conversations = await inbox(w);
      expect(conversations.map((t) => ({ pair: t.pair && [t.pair.otherPartyE164, t.pair.ourNumberE164], texts: t.messages.map((m) => m.body).sort() })))
        .toEqual([{ pair: [SHARED_E164, w.samLine], texts: ['Can we come Tuesday?', 'Yes, Tuesday works'] }]);
      expect(await tieOf(w, 'Yes, Tuesday works')).toEqual({ leadId: w.newerLead, jobId: null });
      // The alert is handed over once the reply is stored; it quotes what the customer wrote.
      await vi.waitFor(async () => expect(await textAlertsOf(w.sam)).toEqual([expect.stringContaining('Yes, Tuesday works')]));
      expect(await textAlertsOf(w.kim)).toEqual([]);
    });
  });

  describe('a reply stays untied when the text it answers is too old or its record is closed', () => {
    for (const { days, tied } of [{ days: 29, tied: true }, { days: 31, tied: false }]) {
      it(`a reply ${days} days after the last text ${tied ? 'takes its lead' : 'stays untied'}`, async () => {
        const w = await connectedOrg();
        await textFrom(w.sam, 'Still interested?', { customerId: w.newer, leadId: w.newerLead });
        await sentAgo(w, 'Still interested?', days * DAY_MS);

        await customerTexts(w, w.samLine, 'Sorry for the late answer');

        expect(await tieOf(w, 'Sorry for the late answer')).toEqual({ leadId: tied ? w.newerLead : null, jobId: null });
      });
    }

    it('a reply after the lead is lost stays untied', async () => {
      const w = await connectedOrg();
      await textFrom(w.sam, 'Any news on the quote?', { customerId: w.newer, leadId: w.newerLead });
      await db.lead.update({ where: { id: w.newerLead }, data: { status: 'LOST' } });

      await customerTexts(w, w.samLine, 'We went with someone else');

      expect(await tieOf(w, 'We went with someone else')).toEqual({ leadId: null, jobId: null });
    });

    // Ran, 2026-11-05: a job is closed only when Done or Cancelled; Completed, Office review and Ready to close are open work.
    for (const { status, tied } of [
      { status: 'COMPLETED', tied: true },
      { status: 'OFFICE_REVIEW', tied: true },
      { status: 'READY_TO_CLOSE', tied: true },
      { status: 'DONE', tied: false },
      { status: 'CANCELLED', tied: false },
    ] as const) {
      it(`a reply to a text sent from a job that is now ${status} ${tied ? 'takes the job' : 'stays untied'}`, async () => {
        const w = await connectedOrg();
        const job = await fx.addJob(w.org, w.newer);
        await textFrom(w.admin, 'Your technician is finished', { customerId: w.newer, jobId: job.id });
        await db.job.update({ where: { id: job.id }, data: { status } });

        await customerTexts(w, w.mainLine, 'Thanks, all good');

        expect(await tieOf(w, 'Thanks, all good')).toEqual({ leadId: null, jobId: tied ? job.id : null });
      });
    }
  });

  describe('texts the phone system sends by itself never count as the latest text we sent', () => {
    it('an opt-in confirmation between the text and the reply does not change which lead the reply takes', async () => {
      const w = await connectedOrg();
      await textFrom(w.sam, 'Can we come Tuesday?', { customerId: w.newer, leadId: w.newerLead });
      await sentAgo(w, 'Can we come Tuesday?', 5 * 60_000);
      await phoneSystemSends(w, w.samLine, 'You are now subscribed to texts. Reply STOP to opt out.', 120);

      await customerTexts(w, w.samLine, 'Tuesday is fine');

      // The confirmation is in the conversation, between the two.
      const [conversation] = await inbox(w);
      expect(conversation!.messages.map((m) => m.body).sort()).toEqual(
        ['Can we come Tuesday?', 'Tuesday is fine', 'You are now subscribed to texts. Reply STOP to opt out.'],
      );
      expect(await tieOf(w, 'Tuesday is fine')).toEqual({ leadId: w.newerLead, jobId: null });
      // The confirmation is ours, not a reply: it is tied to nothing.
      expect(await tieOf(w, 'You are now subscribed to texts. Reply STOP to opt out.')).toEqual({ leadId: null, jobId: null });
    });
  });

  describe('a reply with no recent text takes the one lead or job carrying the number as its own', () => {
    const OWN = '(555) 010-5252';
    const OWN_E164 = '+15550105252';

    it('the one lead carrying the number as its own takes the reply', async () => {
      const w = await connectedOrg();
      await addOwnNumber(w, 'lead', w.newerLead, OWN);

      await customerTexts(w, w.mainLine, 'This is my new cell', OWN_E164);

      expect(await tieOf(w, 'This is my new cell')).toEqual({ leadId: w.newerLead, jobId: null });
    });

    it('the one job carrying the number as its own takes the reply', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.older);
      await addOwnNumber(w, 'job', job.id, OWN);

      await customerTexts(w, w.mainLine, 'Is the crew on its way?', OWN_E164);

      expect(await tieOf(w, 'Is the crew on its way?')).toEqual({ leadId: null, jobId: job.id });
    });

    it('two open records carrying the number: the reply stays untied', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.older);
      await addOwnNumber(w, 'lead', w.newerLead, OWN);
      await addOwnNumber(w, 'job', job.id, OWN);

      await customerTexts(w, w.mainLine, 'Who is this for?', OWN_E164);

      expect(await tieOf(w, 'Who is this for?')).toEqual({ leadId: null, jobId: null });
    });

    it('a closed record carrying the number is not counted: the one open record takes the reply', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.older, { status: 'DONE' });
      await addOwnNumber(w, 'lead', w.newerLead, OWN);
      await addOwnNumber(w, 'job', job.id, OWN);

      await customerTexts(w, w.mainLine, 'About the new quote', OWN_E164);

      expect(await tieOf(w, 'About the new quote')).toEqual({ leadId: w.newerLead, jobId: null });
    });

    it('a recent text from another record comes before the one lead carrying the number as its own', async () => {
      const w = await connectedOrg();
      // (555) 010-5252 is Pat's second phone, and Jordan's lead carries it as its own.
      await db.customer.update({ where: { id: w.older }, data: { secondary_phone: '5550105252' } });
      const job = await fx.addJob(w.org, w.older);
      await addOwnNumber(w, 'lead', w.newerLead, OWN);
      // The office texts Pat's second phone from Pat's job.
      await textFrom(w.admin, 'The parts arrived', { toNumber: OWN, jobId: job.id });

      await customerTexts(w, w.mainLine, 'Great, when can you come?', OWN_E164);

      expect(await tieOf(w, 'Great, when can you come?')).toEqual({ leadId: null, jobId: job.id });
    });

    it('a recent text decides first, even when two records carry the number', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.older);
      await addOwnNumber(w, 'lead', w.newerLead, OWN);
      await addOwnNumber(w, 'job', job.id, OWN);
      // Text on the job's own number, from the job.
      await textFrom(w.admin, 'Your crew is booked', { toNumber: OWN, jobId: job.id });

      await customerTexts(w, w.mainLine, 'Great, see you then', OWN_E164);

      expect(await tieOf(w, 'Great, see you then')).toEqual({ leadId: null, jobId: job.id });
    });
  });

  describe('a text an automation sent counts as the latest text we sent', () => {
    it('a reply after an automated text about a job takes that job, not the lead texted before it', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.newer);
      // The office texts from the lead (the main line: nobody's own number), then an automation texts about the job.
      await textFrom(w.admin, 'Your quote is attached', { customerId: w.newer, leadId: w.newerLead });
      await sentAgo(w, 'Your quote is attached', 2 * 60_000);
      const { recordOutboundSms } = await import('../services/automations/smsRecord.js');
      await recordOutboundSms({
        organizationId: w.org, to: { type: 'customer', customerId: w.newer, job: { id: job.id, label: 'J-1' } },
        body: 'Reminder: your visit is tomorrow',
      });

      await customerTexts(w, w.mainLine, 'Can we move it to Friday?');

      const [conversation] = await inbox(w);
      expect(conversation!.messages.map((m) => m.body).sort()).toEqual(
        ['Can we move it to Friday?', 'Reminder: your visit is tomorrow', 'Your quote is attached'],
      );
      expect(await tieOf(w, 'Can we move it to Friday?')).toEqual({ leadId: null, jobId: job.id });
    });
  });

  describe('a text an automation sent on a new lead counts as the latest text we sent', () => {
    it('a reply to the text a new-lead automation sent takes that lead, and its owner is alerted', async () => {
      const w = await connectedOrg();
      await newLeadTextsTheCustomer(w);
      const lead = await newLeadFor(w, w.newer);
      expect(await settled(w, WELCOME)).toBe('sent');

      await customerTexts(w, w.mainLine, 'Thursday morning, please');

      expect(await tieOf(w, 'Thursday morning, please')).toEqual({ leadId: lead, jobId: null });
      await vi.waitFor(async () => expect(await textAlertsOf(w.sam)).toEqual([expect.stringContaining('Thursday morning, please')]));
    });

    it('the office texted the other customer\'s lead earlier, the automation texted the new lead later: the reply takes the new lead', async () => {
      const w = await connectedOrg();
      await newLeadTextsTheCustomer(w);
      // The office texts Pat from Pat's lead on the main line, the number the automation texts from too.
      await textFrom(w.admin, 'Your quote is ready', { customerId: w.older, leadId: w.olderLead });
      await sentAgo(w, 'Your quote is ready', 3 * DAY_MS);
      const lead = await newLeadFor(w, w.newer);
      expect(await settled(w, WELCOME)).toBe('sent');

      await customerTexts(w, w.mainLine, 'Is Thursday possible?');

      const [conversation] = await inbox(w);
      expect(conversation!.messages.map((m) => m.body).sort()).toEqual(['Is Thursday possible?', WELCOME, 'Your quote is ready']);
      expect(await tieOf(w, 'Is Thursday possible?')).toEqual({ leadId: lead, jobId: null });
      // Sam owns the new lead and nothing of Pat's: he is told because the reply is on his lead.
      await vi.waitFor(async () => expect(await textAlertsOf(w.sam)).toEqual([expect.stringContaining('Is Thursday possible?')]));
    });
  });

  describe('a text that did not go out is not the latest text we sent', () => {
    it('a text from the lead went out, then a text on a new lead was skipped (texting turned off): the reply takes the first lead', async () => {
      const w = await connectedOrg();
      await newLeadTextsTheCustomer(w);
      await textFrom(w.admin, 'Can we come Tuesday?', { customerId: w.newer, leadId: w.newerLead });
      await sentAgo(w, 'Can we come Tuesday?', 5 * 60_000);
      // Texting is turned off for the company, so the automation's text on the new lead never goes out.
      await db.organization.update({ where: { id: w.org }, data: { sms_sending_enabled: false } });
      await newLeadFor(w, w.newer);
      expect(await settled(w, WELCOME)).toBe('skipped');

      await customerTexts(w, w.mainLine, 'Tuesday is fine');

      expect(await tieOf(w, 'Tuesday is fine')).toEqual({ leadId: w.newerLead, jobId: null });
    });

    it('a text from the lead went out, then the phone system refused a text from another lead: the reply takes the first lead', async () => {
      const w = await connectedOrg();
      await textFrom(w.admin, 'Can we come Tuesday?', { customerId: w.newer, leadId: w.newerLead });
      await sentAgo(w, 'Can we come Tuesday?', 5 * 60_000);
      REJECTED.add('About your other request');
      await textFrom(w.admin, 'About your other request', { customerId: w.older, leadId: w.olderLead });
      expect(await settled(w, 'About your other request')).toBe('failed');

      await customerTexts(w, w.mainLine, 'Tuesday is fine');

      expect(await tieOf(w, 'Tuesday is fine')).toEqual({ leadId: w.newerLead, jobId: null });
    });
  });

  describe('another company with the same numbers never ties a reply', () => {
    it('its more recent text from its own lead does not take our reply', async () => {
      const other = await connectedOrg();
      const w = await connectedOrg({ mainLine: other.mainLine, samLine: other.samLine });
      // The other company's conversation is the older one, and its text the more recent.
      await textFrom(other.admin, 'Hello from the other company', { customerId: other.newer, leadId: other.newerLead });
      await textFrom(w.admin, 'Hello from us', { customerId: w.newer, leadId: w.newerLead });
      await sentAgo(w, 'Hello from us', 10 * 60_000);

      await customerTexts(w, w.mainLine, 'Answering you');

      expect(await tieOf(w, 'Answering you')).toEqual({ leadId: w.newerLead, jobId: null });
      expect((await inbox(other)).flatMap((t) => t.messages.map((m) => m.body))).toEqual(['Hello from the other company']);
    });

    it('its lead carrying the number as its own does not take our reply', async () => {
      const other = await connectedOrg();
      const w = await connectedOrg({ mainLine: other.mainLine, samLine: other.samLine });
      await addOwnNumber(other, 'lead', other.newerLead, '(555) 010-5252');

      await customerTexts(w, w.mainLine, 'New number, who dis?', '+15550105252');

      expect(await tieOf(w, 'New number, who dis?')).toEqual({ leadId: null, jobId: null });
      expect(await inbox(other)).toEqual([]);
    });
  });

  describe('a reply moves no lead status', () => {
    /** The lead's status as its page shows it, and whether it shows a first contact. */
    async function statusOf(w: Company, leadId: string) {
      const res = await (await fx.signedInAs(w.admin)).get(`/api/leads/${leadId}`);
      expect(res.status).toBe(200);
      return `${res.body.lead.status as string}${res.body.lead.contacted_at ? ', contacted' : ''}`;
    }

    it('a reply tied to a New lead leaves it New (an incoming text is the customer\'s contact, not ours), and every other lead too', async () => {
      const w = await connectedOrg();
      await addOwnNumber(w, 'lead', w.newerLead, '(555) 010-5252');

      await customerTexts(w, w.mainLine, 'Please call me back', '+15550105252');

      expect(await tieOf(w, 'Please call me back')).toEqual({ leadId: w.newerLead, jobId: null });
      expect([await statusOf(w, w.newerLead), await statusOf(w, w.olderLead)]).toEqual(['NEW', 'NEW']);
    });

    it('the text we sent from the lead moved it to Contacted; the reply it takes leaves it there, and the other customer\'s lead New', async () => {
      const w = await connectedOrg();
      await textFrom(w.sam, 'Can we come Tuesday?', { customerId: w.newer, leadId: w.newerLead });

      await customerTexts(w, w.samLine, 'Yes, Tuesday works');

      expect(await tieOf(w, 'Yes, Tuesday works')).toEqual({ leadId: w.newerLead, jobId: null });
      expect([await statusOf(w, w.newerLead), await statusOf(w, w.olderLead)]).toEqual(['CONTACTED, contacted', 'NEW']);
    });
  });
});
