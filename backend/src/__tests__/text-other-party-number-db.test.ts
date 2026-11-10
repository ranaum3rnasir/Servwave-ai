/* =============================================================================
   #3014 - Every text remembers the customer's number.

   Every text stores the other party's number, normalized E.164, beside the company number it already stores. Each writer is
   driven through its real HTTP door against a real migrated database (TEST_DATABASE_URL; the suite skips when it is unset):
     - a text sent from the inbox (a conversation, and a number typed into the composer);
     - a text sent from a lead;
     - a text an automation sends (a published automation, fired by creating a lead);
     - an incoming text, and a text the phone system reports sending (the phone system's webhook), which still joins the
       conversation it always joined (keying a conversation by its pair of numbers is #3019's).
   No writer ever stores one of the organization's own numbers as the other party.
   The phone system is faked at its network edge only: `fetch` answers the opt-out check and the send, and records the number
   each text went to. Every org the suite makes is removed again.

   The entry-point guard (every place in the backend that writes a text row) is text-other-party-number-writers-guard.test.ts.
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
// The suite-wide setup replaces the automation dispatcher with a stub; here the real one runs, so a new lead fires its automation.
vi.mock('../services/automations/dispatch', async (importOriginal) => importOriginal());

import { switchFixture } from './permission-switches-fixture';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

// The phone system's address in this suite. Nothing outside it may be reached.
const PROVIDER = 'https://phone-provider.test/api/v1';

/** What the faked phone system was asked to send: the destination of every text. */
const sentTo: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, and every send is accepted with a fresh message id. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) {
    sentTo.push(new URLSearchParams(String(init.body)).get('to') ?? '');
    return json({ id: `MSG-3014-${randomUUID()}` });
  }
  return json({ error: 'not found' }, 404);
}

suite('every text remembers the other party\'s number (real database)', () => {
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
    sentTo.length = 0;
  });

  const orgs: string[] = [];
  afterAll(async () => {
    vi.unstubAllGlobals();
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'timeline_events', 'messages', 'message_threads',
        'workflow_step_runs', 'workflow_enrollments', 'workflow_versions', 'workflow_steps', 'workflows']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company connected to the phone system, texting from its main line, with a customer whose phone is stored formatted. */
  async function connectedOrg(customerPhone = '(555) 010-3002') {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3014${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = `+1555020${String(++sequence).padStart(4, '0')}`;
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN3014${made.tag}`,
      },
    });
    await db.customer.update({ where: { id: made.customer }, data: { phone: customerPhone } });
    return { ...made, account, mainLine };
  }

  /** The number a stored text holds for its other party. */
  async function otherPartyOf(messageId: string): Promise<string | null> {
    const row = await db.message.findUniqueOrThrow({ where: { id: messageId }, select: { other_party_e164: true } });
    return row.other_party_e164;
  }

  describe('a text sent from the inbox stores the number it went to', () => {
    it('a reply in a customer\'s conversation', async () => {
      const w = await connectedOrg('(555) 010-3002');
      const thread = await db.messageThread.create({
        data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: w.customer },
      });

      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: thread.id, body: 'On our way' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550103002']);
      expect(await otherPartyOf(res.body.message.id)).toBe('+15550103002');
    });

    it('a number typed into the composer that is nobody on file', async () => {
      const w = await connectedOrg();

      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { toNumber: '(555) 010-4004', body: 'Hello there' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550104004']);
      expect(await otherPartyOf(res.body.message.id)).toBe('+15550104004');
    });

    it('never one of our own numbers: a text typed to our own main line stores none', async () => {
      const w = await connectedOrg();

      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { toNumber: w.mainLine, body: 'Testing the line' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual([w.mainLine]);
      expect(await otherPartyOf(res.body.message.id)).toBeNull();
    });
  });

  describe('a text sent from a lead stores the number it went to', () => {
    it("the lead's customer", async () => {
      const w = await connectedOrg('5550103002');
      const lead = await fx.addLead(w.org, w.customer);

      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', {
        customerId: w.customer, leadId: lead.id, body: 'About your quote',
      });

      expect(res.status).toBe(201);
      expect(res.body.message.leadId).toBe(lead.id);
      expect(sentTo).toEqual(['+15550103002']);
      expect(await otherPartyOf(res.body.message.id)).toBe('+15550103002');
    });
  });

  describe('a text an automation sends stores the number it went to', () => {
    /** Publish "text the customer" on a new lead, make a lead, and wait for the automation's text to reach the phone system. */
    async function automationTextsTheCustomer(w: Awaited<ReturnType<typeof connectedOrg>>) {
      const admin = await fx.signedInAs(w.admin);
      const made = await admin.post('/api/workflows', {
        name: 'Welcome text', trigger_type: 'LEAD_CREATED', send_window: 'ANYTIME',
        steps: [{ step_type: 'SEND_TEXT', config: { recipients: ['customer'], body: 'Thanks for reaching out' } }],
      });
      expect(made.status).toBe(201);
      const published = await admin.post(`/api/workflows/${made.body.id}/publish`, { enable: true });
      expect(published.status).toBe(200);

      const lead = await admin.post('/api/leads', { customer_id: w.customer, service_request: 'New garage door' });
      expect(lead.status).toBe(201);

      // The automation runs once the answer is sent; wait for its text to be handed to the phone system.
      let text: { id: string } | null = null;
      for (let tries = 0; tries < 100 && !text; tries++) {
        text = await db.message.findFirst({
          where: { organization_id: w.org, automated: true, status: { not: 'queued' } }, select: { id: true },
        });
        if (!text) await new Promise((r) => setTimeout(r, 100));
      }
      expect(text, 'the automation sent its text').not.toBeNull();
      return text!.id;
    }

    it('"text the customer" on a new lead', async () => {
      const w = await connectedOrg('555.010.3002');

      const text = await automationTextsTheCustomer(w);

      expect(sentTo).toEqual(['+15550103002']);
      expect(await otherPartyOf(text)).toBe('+15550103002');
    });

    it('never one of our own numbers: a customer whose phone is our main line stores none', async () => {
      const w = await connectedOrg();
      await db.customer.update({ where: { id: w.customer }, data: { phone: w.mainLine } });

      const text = await automationTextsTheCustomer(w);

      expect(sentTo).toEqual([w.mainLine]);
      expect(await otherPartyOf(text)).toBeNull();
    });
  });

  describe('an incoming text stores the number it came from', () => {
    it('the sender, as the phone system names it', async () => {
      const w = await connectedOrg();
      const sid = `MSG-3014-${randomUUID()}`;

      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
        .send({
          message_id: sid, account_id: w.account, caller_number: '5550103002', tracking_number: w.mainLine,
          direction: 'msg_inbound', message_body: 'Is Tuesday still on?', unix_time: Math.floor(Date.now() / 1000),
        });

      expect(res.status).toBe(200);
      const text = await db.message.findFirstOrThrow({ where: { organization_id: w.org, ctm_sms_id: sid }, select: { id: true } });
      expect(await otherPartyOf(text.id)).toBe('+15550103002');
    });
  });

  describe('a text the phone system reports sending stores the customer it went to', () => {
    it('the contact the phone system names, as on the live outbound report (caller and contact are the customer)', async () => {
      const w = await connectedOrg();
      const sid = `MSG-3014-${randomUUID()}`;

      // The shape of the outbound report measured live (ctm-webhook.test.ts, "status_change is the REAL outbound-text
      // carrier"): the caller and the contact are the customer texted; the called number is another party.
      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/status_change?token=${WEBHOOK_TOKEN}`)
        .send({
          sid: String(Math.floor(Math.random() * 1e9)), message_id: sid, account_id: w.account,
          caller_number: '+15550103002', contact_number: '+15550103002', called_number: '+15550108008', tracking_number: w.mainLine,
          direction: 'msg_outbound', status: 'sent', message_body: 'Sent from the phone system', unix_time: Math.floor(Date.now() / 1000),
        });

      expect(res.status).toBe(200);
      const text = await db.message.findFirstOrThrow({ where: { organization_id: w.org, ctm_sms_id: sid }, select: { id: true } });
      expect(await otherPartyOf(text.id)).toBe('+15550103002');
    });

    it('joins the conversation of its pair (the contact and the line it left from), never the called number\'s, and stores the contact', async () => {
      // #3019 keys a conversation by its pair of numbers: the other party the text stores (the contact the phone system
      // names) and our number. The called number, another customer's here, no longer picks the conversation.
      const w = await connectedOrg('(555) 010-3002');
      const calledCustomer = randomUUID();
      await db.customer.create({
        data: {
          id: calledCustomer, organization_id: w.org, customer_number: `C-${calledCustomer.slice(0, 8)}`, kind: 'PERSON',
          segment: 'RESIDENTIAL', first_name: 'Dana', last_name: 'Ruiz', phone: '5550108008',
        },
      });
      const calledConversation = await db.messageThread.create({
        data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: calledCustomer },
      });
      const sid = `MSG-3014-${randomUUID()}`;

      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/status_change?token=${WEBHOOK_TOKEN}`)
        .send({
          sid: String(Math.floor(Math.random() * 1e9)), message_id: sid, account_id: w.account,
          caller_number: '+15550103002', contact_number: '+15550103002', called_number: '+15550108008', tracking_number: w.mainLine,
          direction: 'msg_outbound', status: 'sent', message_body: 'Sent from the phone system', unix_time: Math.floor(Date.now() / 1000),
        });

      expect(res.status).toBe(200);
      const text = await db.message.findFirstOrThrow({
        where: { organization_id: w.org, ctm_sms_id: sid },
        select: { thread_id: true, other_party_e164: true, thread: { select: { other_party_e164: true, our_number_e164: true } } },
      });
      expect(text.thread_id).not.toBe(calledConversation.id);
      expect(text).toMatchObject({
        other_party_e164: '+15550103002', thread: { other_party_e164: '+15550103002', our_number_e164: w.mainLine },
      });
    });

    it('never one of our own numbers: a report naming only our numbers stores none', async () => {
      const w = await connectedOrg();
      const sid = `MSG-3014-${randomUUID()}`;

      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/status_change?token=${WEBHOOK_TOKEN}`)
        .send({
          sid: String(Math.floor(Math.random() * 1e9)), message_id: sid, account_id: w.account,
          caller_number: w.mainLine, called_number: w.mainLine, tracking_number: w.mainLine,
          direction: 'msg_outbound', status: 'sent', message_body: 'Sent from the phone system', unix_time: Math.floor(Date.now() / 1000),
        });

      expect(res.status).toBe(200);
      const text = await db.message.findFirstOrThrow({ where: { organization_id: w.org, ctm_sms_id: sid }, select: { id: true } });
      expect(await otherPartyOf(text.id)).toBeNull();
    });
  });

  it('journey: a text from a lead and the customer\'s reply both hold the customer\'s number beside our number', async () => {
    const w = await connectedOrg('(555) 010-3002');
    const lead = await fx.addLead(w.org, w.customer);
    const sent = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', {
      customerId: w.customer, leadId: lead.id, body: 'Can we come Tuesday?',
    });
    expect(sent.status).toBe(201);

    const sid = `MSG-3014-${randomUUID()}`;
    const reply = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: sid, account_id: w.account, caller_number: '+15550103002', tracking_number: w.mainLine,
        direction: 'msg_inbound', message_body: 'Tuesday works', unix_time: Math.floor(Date.now() / 1000),
      });
    expect(reply.status).toBe(200);

    const both = await db.message.findMany({
      where: { organization_id: w.org },
      // The reply's time is the phone system's whole second, which can sort before the send: order by direction instead.
      orderBy: { direction: 'desc' },
      select: { direction: true, other_party_e164: true, phone_number: { select: { e164: true } } },
    });
    expect(both).toEqual([
      { direction: 'out', other_party_e164: '+15550103002', phone_number: { e164: w.mainLine } },
      { direction: 'in', other_party_e164: '+15550103002', phone_number: { e164: w.mainLine } },
    ]);
  });
});
