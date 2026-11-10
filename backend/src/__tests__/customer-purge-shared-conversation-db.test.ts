/* =============================================================================
   #3019 - deleting a customer keeps a conversation another customer, lead or job still carries the number of (Ran,
   2026-11-05): "a shared conversation (another customer/lead/job still carries the number) is KEPT with its texts and
   detached from the deleted customer; deleted only when nobody else carries the number."

   A conversation is a pair of numbers (CONTEXT.md), so one filed on a customer can hold texts sent from another customer's
   page when the two share a phone. Driven through the real doors against a real migrated database (TEST_DATABASE_URL; the
   suite skips when it is unset): texts come in through the phone system's webhook and go out from a customer's page, the
   customer is deleted through POST /api/customers/:id/purge, and what is left is read through the inbox.
   The phone system is faked at its network edge only (`fetch`). Every org the suite makes is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

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

import { switchFixture } from './permission-switches-fixture';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const PROVIDER = 'https://phone-provider.test/api/v1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, and every send is accepted. Nothing else may be reached. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) return json({ id: `MSG-3019P-${randomUUID()}` });
  return json({ error: 'not found' }, 404);
}

suite('deleting a customer keeps a conversation someone else carries the number of (real database)', () => {
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
        'messages', 'message_threads', 'record_contact_entries']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;
  const nextNumber = () => `+1555022${String(++sequence).padStart(4, '0')}`;

  /**
   * A company connected to the phone system with its main line, Dana Ruiz (who reads texts), and the customer about to be
   * deleted, whose phone is (555) 010-3002.
   */
  async function connectedOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3019P${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = nextNumber();
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN-MAIN-${made.tag}`,
      },
    });
    const dana = await fx.addUser(made.org, 'Dana', 'ADMIN');
    // Stored bare, the way the customer forms store a phone (the number match compares stored spellings).
    await db.customer.update({ where: { id: made.customer }, data: { phone: '5550103002' } });
    const row = await db.customer.findUniqueOrThrow({ where: { id: made.customer } });
    return { ...made, account, mainLine, dana, customerNumber: row.customer_number };
  }

  type Company = Awaited<ReturnType<typeof connectedOrg>>;

  async function addCustomer(w: Company, first: string, phone: string | null) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: w.org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: first, last_name: 'Lee', phone,
      },
    });
    return id;
  }

  /** The customer texts our main line, as the phone system reports it. `secondsAgo` < 0 is a text a few seconds ahead. */
  async function customerTexts(w: Company, body: string, secondsAgo: number) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-3019P-${randomUUID()}`, account_id: w.account, caller_number: '+15550103002', tracking_number: w.mainLine,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000) - secondsAgo,
      });
    expect(res.status).toBe(200);
  }

  type Listed = { id: string; customerId: string; title?: string; unread: number; messages: { body: string }[] };

  /** The company's conversations as the inbox lists them to one person. */
  async function inbox(person: Company['admin']) {
    const res = await (await fx.signedInAs(person)).get('/api/communication/threads');
    expect(res.status).toBe(200);
    return res.body.threads as Listed[];
  }

  /** What a person reads in the inbox: each conversation, whom it is filed on, its title, its texts and their unread count. */
  async function read(person: Company['admin']) {
    return (await inbox(person)).map((t) => ({
      id: t.id, customerId: t.customerId, title: t.title ?? null, unread: t.unread, texts: t.messages.map((m) => m.body).sort(),
    }));
  }

  async function purge(w: Company) {
    const res = await (await fx.signedInAs(w.admin)).post(`/api/customers/${w.customer}/purge`, { confirm: w.customerNumber });
    expect(res.status).toBe(200);
  }

  /**
   * The deleted customer's conversation with (555) 010-3002 on the main line: a text from the customer's page, the
   * customer's answer, which Dana reads, and a second answer she has not read yet.
   */
  async function conversationOnTheDeletedCustomer(w: Company) {
    const admin = await fx.signedInAs(w.admin);
    const sent = await admin.post('/api/communication/sms', { customerId: w.customer, body: 'Your door is ordered' });
    expect(sent.status).toBe(201);
    await customerTexts(w, 'Thanks, when will it come?', 60);
    const [conversation] = await inbox(w.admin);
    expect((await (await fx.signedInAs(w.dana)).patch(`/api/communication/threads/${conversation!.id}/read`)).status).toBe(200);
    await customerTexts(w, 'Mornings are best', -5);
    return conversation!.id;
  }

  describe('another customer still carries the number', () => {
    it('keeps the conversation with every text and each person\'s unread count, filed on nobody', async () => {
      const w = await connectedOrg();
      const other = await addCustomer(w, 'Jordan', '5550103002');
      const id = await conversationOnTheDeletedCustomer(w);
      // A text from the other customer's page continues the same conversation (#3013 decision 2).
      const fromOther = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { customerId: other, body: 'Jordan here, booked' });
      expect(fromOther.status).toBe(201);

      await purge(w);

      const texts = ['Jordan here, booked', 'Mornings are best', 'Thanks, when will it come?', 'Your door is ordered'];
      expect(await read(w.admin)).toEqual([{ id, customerId: '', title: '+15550103002', unread: 2, texts }]);
      expect(await read(w.dana)).toEqual([{ id, customerId: '', title: '+15550103002', unread: 1, texts }]);
    });
  });

  describe('only a lead or job of another customer carries the number, as its own', () => {
    const texts = ['Mornings are best', 'Thanks, when will it come?', 'Your door is ordered'];

    it.each([
      ['an open lead', async (w: Company, other: string) => {
        const lead = await fx.addLead(w.org, other);
        await db.recordContactEntry.create({ data: { organization_id: w.org, lead_id: lead.id, kind: 'PHONE', intent: 'ADDED', value: '5550103002' } });
      }],
      ['a closed (lost) lead', async (w: Company, other: string) => {
        const lead = await fx.addLead(w.org, other);
        await db.lead.update({ where: { id: lead.id }, data: { status: 'LOST' } });
        await db.recordContactEntry.create({ data: { organization_id: w.org, lead_id: lead.id, kind: 'PHONE', intent: 'ADDED', value: '+15550103002' } });
      }],
      ['a closed (done) job', async (w: Company, other: string) => {
        const job = await fx.addJob(w.org, other, { status: 'DONE' });
        await db.recordContactEntry.create({ data: { organization_id: w.org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: '5550103002' } });
      }],
    ])('%s: the conversation is kept, filed on nobody', async (_name, carry) => {
      const w = await connectedOrg();
      const other = await addCustomer(w, 'Jordan', '5550109009');
      const id = await conversationOnTheDeletedCustomer(w);
      await carry(w, other);

      await purge(w);

      expect(await read(w.admin)).toEqual([{ id, customerId: '', title: '+15550103002', unread: 2, texts }]);
      expect(await read(w.dana)).toEqual([{ id, customerId: '', title: '+15550103002', unread: 1, texts }]);
    });
  });

  describe('a conversation from before pairs (the split has not reached it)', () => {
    it('filed on the deleted customer\'s lead, with texts to a number another customer carries: kept, filed on nobody', async () => {
      const w = await connectedOrg();
      await addCustomer(w, 'Jordan', '5550103002');
      const lead = await fx.addLead(w.org, w.customer);
      // As it was before #3019: filed on the customer and the lead, with no pair; its text knows the number (#3014).
      const legacy = await db.messageThread.create({
        data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: w.customer, lead_id: lead.id },
      });
      await db.message.create({
        data: {
          organization_id: w.org, thread_id: legacy.id, direction: 'in', body: 'Sent last year', ts: new Date('2025-06-01T12:00:00Z'),
          status: 'received', other_party_e164: '+15550103002',
        },
      });

      await purge(w);

      const listed = await inbox(w.admin);
      expect(listed.map((t) => ({ id: t.id, customerId: t.customerId, leadId: (t as { leadId?: string }).leadId ?? null, title: t.title, texts: t.messages.map((m) => m.body) })))
        .toEqual([{ id: legacy.id, customerId: '', leadId: null, title: '+15550103002', texts: ['Sent last year'] }]);
    });
  });

  describe('nobody else carries the number', () => {
    it('the conversation is deleted with the customer, even when the customer\'s own lead carried the number', async () => {
      const w = await connectedOrg();
      await addCustomer(w, 'Jordan', '5550109009');
      const own = await fx.addLead(w.org, w.customer);
      await db.recordContactEntry.create({ data: { organization_id: w.org, lead_id: own.id, kind: 'PHONE', intent: 'ADDED', value: '5550103002' } });
      await conversationOnTheDeletedCustomer(w);

      await purge(w);

      expect(await read(w.admin)).toEqual([]);
    });

    it('a customer of another company with the same number does not count', async () => {
      const other = await connectedOrg();
      const w = await connectedOrg();
      await conversationOnTheDeletedCustomer(w);
      expect((await db.customer.findUniqueOrThrow({ where: { id: other.customer } })).phone).toBe('5550103002');

      await purge(w);

      expect(await read(w.admin)).toEqual([]);
    });
  });
});
