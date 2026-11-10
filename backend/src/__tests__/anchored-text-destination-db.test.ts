/* =============================================================================
   #3016 - A lead or job texts the number it shows (closes #2952's anchored path).

   A lead's or job's effective number is its changed number for the customer's primary, else the customer's primary. For a
   text sent anchored on a lead or a job, the server, not the browser, takes the destination from the record:
     - the record's changed number for the customer's primary;
     - otherwise a number the record or its customer carries, when the browser names one;
     - never a free number from the browser: a number the record and its customer do not carry is refused, nothing is sent,
       and the refusal is the same whether or not that number belongs to someone else.
   Automated texts keep the customer record's own number (4 October Q34).

   #3018 - Text on an extra number stays on the record: the record's own number (also another customer's primary), the
   customer's second phone and a phone on their list are texted as named, the text stays on the record, a number on neither
   the record nor its customer is refused, and a second company carrying the number never wins.

   Driven through the real HTTP doors (the pencil change, the send, the automation) against a real migrated database
   (TEST_DATABASE_URL; the suite skips when it is unset). The phone system is faked at its network edge only: `fetch` answers
   the opt-out check and the send, and records the number each text went to. Every org the suite makes is removed again.
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
// The suite-wide setup replaces the automation dispatcher with a stub; here the real one runs, so a lead change fires its automation.
vi.mock('../services/automations/dispatch', async (importOriginal) => importOriginal());

import { switchFixture } from './permission-switches-fixture';
import { env } from '../config/env';
import { matchByPhone } from '../lib/comms-identity';

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
    return json({ id: `MSG-3016-${randomUUID()}` });
  }
  return json({ error: 'not found' }, 404);
}

suite('a lead or job texts the number it shows (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);

  beforeAll(async () => {
    await import('../app.js');
    // A connected phone system, with keys made up for this run.
    Object.assign(env as Record<string, unknown>, {
      CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER, CTM_WEBHOOK_TOKEN: randomUUID(),
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
        'workflow_step_runs', 'workflow_enrollments', 'workflow_versions', 'workflow_steps', 'workflows', 'record_contact_entries']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM jobs WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company connected to the phone system, texting from its main line, with a customer whose primary is (555) 010-3002. */
  async function connectedOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: `3016${made.tag}`, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: `+1555020${String(++sequence).padStart(4, '0')}`, label: 'Main line', is_org_default: true,
        status: 'active', sms_enabled: true, ctm_number_id: `TPN3016${made.tag}`,
      },
    });
    await db.customer.update({ where: { id: made.customer }, data: { phone: '(555) 010-3002' } });
    return made;
  }

  type Signed = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** A customer in a second company whose phone is (555) 010-5252. */
  async function anotherCompanyCarries5252() {
    const elsewhere = await fx.newOrg();
    await db.customer.update({ where: { id: elsewhere.customer }, data: { phone: '5550105252' } });
  }

  /**
   * Another customer of the company who carries (555) 010-5252: as their phone, or, with `theirRecord`, as their own open
   * lead's or job's changed number. Stored as the app stores a customer phone (bare digits), and checked to be the number's
   * customer before the record under test changes its phone, so the case cannot quietly become "nobody carries it".
   */
  async function neighbourCarries5252(w: { org: string; tag: string }, admin: Signed, theirRecord?: 'lead' | 'job') {
    const neighbour = await db.customer.create({
      data: {
        organization_id: w.org, customer_number: `C-shared-${w.tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Morgan', phone: theirRecord ? '5550106006' : '5550105252',
      },
    });
    if (theirRecord) {
      const theirs = theirRecord === 'lead' ? await fx.addLead(w.org, neighbour.id) : await fx.addJob(w.org, neighbour.id);
      const theirPencil = await admin.post(`/api/${theirRecord}s/${theirs.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-6006', value: '(555) 010-5252',
      });
      expect(theirPencil.status).toBe(201);
    }
    await expectPickNames(w.org, neighbour.id);
    return neighbour.id;
  }

  /** The number's customer pick (#3015's public entry) names `customer` for (555) 010-5252. */
  async function expectPickNames(org: string, customer: string) {
    expect((await matchByPhone(db, org, '+15550105252'))?.customerId).toBe(customer);
  }

  describe('a text sent from a lead whose phone was changed to (555) 010-5252', () => {
    it('texts (555) 010-5252, and the text carries the lead', async () => {
      const w = await connectedOrg();
      const lead = await fx.addLead(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const res = await admin.post('/api/communication/sms', { customerId: w.customer, leadId: lead.id, body: 'About your quote' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550105252']);
      expect(res.body.message.leadId).toBe(lead.id);
    });

    it("texts (555) 010-5252 even when the browser names the customer's own (555) 010-3002", async () => {
      const w = await connectedOrg();
      const lead = await fx.addLead(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-3002', leadId: lead.id, body: 'About your quote' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550105252']);
      expect(res.body.message.leadId).toBe(lead.id);
    });

    // The text stays tied to the record wherever (555) 010-5252 leads: to nobody, to a customer in another company, or to
    // another customer of this company who carries it too. That last customer is the one the number's customer pick names
    // when the lead does not decide it: the lead is Won or Lost (a closed lead does not decide the pick), or another
    // customer's open lead carries (555) 010-5252 as its own too.
    for (const [who, carrier, status] of [
      ['no customer carries (555) 010-5252', 'nobody', 'NEW'],
      ['only a customer in another company carries (555) 010-5252', 'elsewhere', 'NEW'],
      ['another customer of the company carries (555) 010-5252 too', 'neighbour', 'NEW'],
      ['the lead is Won and another customer of the company carries (555) 010-5252 too', 'neighbour', 'WON'],
      ['the lead is Lost and another customer of the company carries (555) 010-5252 too', 'neighbour', 'LOST'],
      ["another customer's open lead carries (555) 010-5252 as its own too", 'neighbour lead', 'NEW'],
    ] as const) {
      it(`stays on the lead when the browser names (555) 010-3002 and ${who}`, async () => {
        const w = await connectedOrg();
        const lead = await fx.addLead(w.org, w.customer);
        const admin = await fx.signedInAs(w.admin);
        if (carrier === 'elsewhere') await anotherCompanyCarries5252();
        const neighbour = carrier === 'neighbour' ? await neighbourCarries5252(w, admin)
          : carrier === 'neighbour lead' ? await neighbourCarries5252(w, admin, 'lead') : null;
        const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
          kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
        });
        expect(pencil.status).toBe(201);
        if (status !== 'NEW') await db.lead.update({ where: { id: lead.id }, data: { status } });
        if (neighbour && (status !== 'NEW' || carrier === 'neighbour lead')) await expectPickNames(w.org, neighbour);

        const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-3002', leadId: lead.id, body: 'About your quote' });

        expect(res.status).toBe(201);
        expect(sentTo).toEqual(['+15550105252']);
        expect(res.body.message.leadId).toBe(lead.id);
        const tab = await admin.get(`/api/leads/${lead.id}/communications`);
        expect(tab.body.items.filter((i: { channel: string }) => i.channel === 'sms').map((i: { preview: string; leadId: string }) => [i.preview, i.leadId]))
          .toEqual([['About your quote', lead.id]]);
      });
    }

    it("a change to the customer's second phone leaves the lead's texts on the primary, (555) 010-3002", async () => {
      const w = await connectedOrg();
      await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '(555) 010-4004' } });
      const lead = await fx.addLead(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-4004', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const fromTab = await admin.post('/api/communication/sms', { customerId: w.customer, leadId: lead.id, body: 'About your quote' });
      const namingPrimary = await admin.post('/api/communication/sms', { toNumber: '(555) 010-3002', leadId: lead.id, body: 'Still on?' });

      expect([fromTab.status, namingPrimary.status]).toEqual([201, 201]);
      expect(sentTo).toEqual(['+15550103002', '+15550103002']);
    });

    // Ran (2026-11-05): a send to ANY customer phone the record changed goes to the record's changed number.
    it("a text naming the customer's second phone, (555) 010-4004, that the lead changed to (555) 010-5252 goes to (555) 010-5252", async () => {
      const w = await connectedOrg();
      await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '(555) 010-4004' } });
      const lead = await fx.addLead(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-4004', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-4004', leadId: lead.id, body: 'Still on?' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550105252']);
    });
  });

  describe('a text sent from a job with its own number, (555) 010-5252', () => {
    it("texts (555) 010-5252 and stays on the job when the browser names the customer's own (555) 010-3002", async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/jobs/${job.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-3002', jobId: job.id, body: 'On our way' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550105252']);
      expect(res.body.message.jobId).toBe(job.id);
    });

    it('texts (555) 010-5252, and the text carries the job', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/jobs/${job.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const res = await admin.post('/api/communication/sms', { customerId: w.customer, jobId: job.id, body: 'On our way' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550105252']);
      expect(res.body.message.jobId).toBe(job.id);
    });

    // As on a lead: the text stays tied to the job wherever (555) 010-5252 leads, including to another customer of this
    // company whom the number's customer pick names instead of the job's own: the job is Done or Cancelled (a closed job does
    // not decide the pick), or another customer's open job carries (555) 010-5252 as its own too.
    for (const [who, carrier, status] of [
      ['no customer carries (555) 010-5252', 'nobody', 'SCHEDULED'],
      ['only a customer in another company carries (555) 010-5252', 'elsewhere', 'SCHEDULED'],
      ['another customer of the company carries (555) 010-5252 too', 'neighbour', 'SCHEDULED'],
      ['the job is Done and another customer of the company carries (555) 010-5252 too', 'neighbour', 'DONE'],
      ['the job is Cancelled and another customer of the company carries (555) 010-5252 too', 'neighbour', 'CANCELLED'],
      ["another customer's open job carries (555) 010-5252 as its own too", 'neighbour job', 'SCHEDULED'],
    ] as const) {
      it(`stays on the job when the browser names (555) 010-3002 and ${who}`, async () => {
        const w = await connectedOrg();
        const job = await fx.addJob(w.org, w.customer);
        const admin = await fx.signedInAs(w.admin);
        if (carrier === 'elsewhere') await anotherCompanyCarries5252();
        const neighbour = carrier === 'neighbour' ? await neighbourCarries5252(w, admin)
          : carrier === 'neighbour job' ? await neighbourCarries5252(w, admin, 'job') : null;
        const pencil = await admin.post(`/api/jobs/${job.id}/contact-entries/change`, {
          kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
        });
        expect(pencil.status).toBe(201);
        if (status !== 'SCHEDULED') await db.job.update({ where: { id: job.id }, data: { status } });
        if (neighbour && (status !== 'SCHEDULED' || carrier === 'neighbour job')) await expectPickNames(w.org, neighbour);

        const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-3002', jobId: job.id, body: 'On our way' });

        expect(res.status).toBe(201);
        expect(sentTo).toEqual(['+15550105252']);
        expect(res.body.message.jobId).toBe(job.id);
        const tab = await admin.get(`/api/jobs/${job.id}/communications`);
        expect(tab.body.items.filter((i: { channel: string }) => i.channel === 'sms').map((i: { preview: string; jobId: string }) => [i.preview, i.jobId]))
          .toEqual([['On our way', job.id]]);
      });
    }
  });

  // A number only the record carries (its own changed number) is texted as named, and the text stays on the record.
  for (const kind of ['lead', 'job'] as const) {
    it(`a text from a ${kind} naming its own (555) 010-5252 goes to (555) 010-5252 and carries the ${kind}`, async () => {
      const w = await connectedOrg();
      const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/${kind}s/${record.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);

      const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-5252', [`${kind}Id`]: record.id, body: 'Running late' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550105252']);
      expect(res.body.message[`${kind}Id`]).toBe(record.id);
    });
  }

  it("journey: the lead's phone is changed, a text is sent from the lead, and it shows on the lead's Communication tab", async () => {
    const w = await connectedOrg();
    const lead = await fx.addLead(w.org, w.customer);
    const admin = await fx.signedInAs(w.admin);

    const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
      kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
    });
    expect(pencil.status).toBe(201);
    const shown = await admin.get(`/api/leads/${lead.id}`);
    expect(shown.body.lead.contact_entries.map((e: { value: string }) => e.value)).toEqual(['5550105252']);

    const sent = await admin.post('/api/communication/sms', { customerId: w.customer, leadId: lead.id, body: 'Can we come Tuesday?' });
    expect(sent.status).toBe(201);
    expect(sent.body.delivery).toBe('sent');
    expect(sentTo).toEqual(['+15550105252']);

    const tab = await admin.get(`/api/leads/${lead.id}/communications`);
    expect(tab.status).toBe(200);
    expect(tab.body.items.filter((i: { channel: string }) => i.channel === 'sms').map((i: { preview: string; leadId: string }) => [i.preview, i.leadId]))
      .toEqual([['Can we come Tuesday?', lead.id]]);
  });

  describe('an automation on a lead whose phone was changed to (555) 010-5252', () => {
    it("still texts the customer's own number, (555) 010-3002", async () => {
      const w = await connectedOrg();
      const lead = await fx.addLead(w.org, w.customer);
      const owner = await fx.addUser(w.org, 'owner', 'SALES');
      const admin = await fx.signedInAs(w.admin);
      const pencil = await admin.post(`/api/leads/${lead.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);
      const made = await admin.post('/api/workflows', {
        name: 'New owner text', trigger_type: 'LEAD_ASSIGNED', send_window: 'ANYTIME',
        steps: [{ step_type: 'SEND_TEXT', config: { recipients: ['customer'], body: 'Your new contact is on it' } }],
      });
      expect(made.status).toBe(201);
      const published = await admin.post(`/api/workflows/${made.body.id}/publish`, { enable: true });
      expect(published.status).toBe(200);

      const assigned = await admin.post(`/api/leads/${lead.id}/assign`, { assigned_to: owner.id });
      expect(assigned.status).toBe(200);

      // The automation runs once the answer is sent; wait for its text to be handed to the phone system.
      for (let tries = 0; tries < 100 && sentTo.length === 0; tries++) await new Promise((r) => setTimeout(r, 100));
      expect(sentTo).toEqual(['+15550103002']);
    });
  });

  describe('a text sent from a lead naming a number the lead and its customer do not carry', () => {
    it('is refused, nothing is sent and no conversation is made, the same whether or not someone else carries the number', async () => {
      const w = await connectedOrg();
      const lead = await fx.addLead(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      // (555) 010-7007 is another customer's phone in this company, with a lead of their own; so it is in a second company.
      // (555) 010-8008 is nobody's.
      const other = await db.customer.create({
        data: {
          organization_id: w.org, customer_number: `C-other-${w.tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
          first_name: 'Jordan', last_name: 'Lee', phone: '5550107007',
        },
      });
      await fx.addLead(w.org, other.id);
      const elsewhere = await fx.newOrg();
      await db.customer.update({ where: { id: elsewhere.customer }, data: { phone: '5550107007' } });
      expect((await matchByPhone(db, w.org, '+15550107007'))?.customerId).toBe(other.id);

      const someoneElses = await admin.post('/api/communication/sms', { toNumber: '(555) 010-7007', leadId: lead.id, body: 'Hello' });
      const nobodys = await admin.post('/api/communication/sms', { toNumber: '(555) 010-8008', leadId: lead.id, body: 'Hello' });

      expect(someoneElses.status).toBe(404);
      expect(someoneElses.body).toEqual({ error: 'You can only text the numbers on this lead' });
      expect({ status: nobodys.status, body: nobodys.body }).toEqual({ status: someoneElses.status, body: someoneElses.body });
      expect(sentTo).toEqual([]);
      const conversations = await admin.get('/api/communication/threads');
      expect(conversations.status).toBe(200);
      expect(conversations.body.threads).toEqual([]);
    });
  });

  describe('a text sent from a job naming a number the job and its customer do not carry', () => {
    it('is refused, nothing is sent and no conversation is made, the same whether or not someone else carries the number', async () => {
      const w = await connectedOrg();
      const job = await fx.addJob(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      // (555) 010-7007 is another customer's phone in this company, with a job of their own; so it is in a second company.
      // (555) 010-8008 is nobody's.
      const other = await db.customer.create({
        data: {
          organization_id: w.org, customer_number: `C-other-${w.tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
          first_name: 'Jordan', last_name: 'Lee', phone: '5550107007',
        },
      });
      await fx.addJob(w.org, other.id);
      const elsewhere = await fx.newOrg();
      await db.customer.update({ where: { id: elsewhere.customer }, data: { phone: '5550107007' } });
      expect((await matchByPhone(db, w.org, '+15550107007'))?.customerId).toBe(other.id);

      const someoneElses = await admin.post('/api/communication/sms', { toNumber: '(555) 010-7007', jobId: job.id, body: 'Hello' });
      const nobodys = await admin.post('/api/communication/sms', { toNumber: '(555) 010-8008', jobId: job.id, body: 'Hello' });

      expect(someoneElses.status).toBe(404);
      expect(someoneElses.body).toEqual({ error: 'You can only text the numbers on this job' });
      expect({ status: nobodys.status, body: nobodys.body }).toEqual({ status: someoneElses.status, body: someoneElses.body });
      expect(sentTo).toEqual([]);
      const conversations = await admin.get('/api/communication/threads');
      expect(conversations.status).toBe(200);
      expect(conversations.body.threads).toEqual([]);
    });
  });

  // ─── #3018: Text on an extra number stays on the record ───────────────────────────────────────────────────────────────
  // The contact card's Text on a number the record carries other than the customer's primary (the record's own number, the
  // customer's second phone, a phone on the customer's list) sends naming that number with the record. The server checks the
  // number is the record's or its customer's, texts it (or the record's changed number for a customer phone the record
  // changed, Ran 2026-11-05), and the text stays on the record whoever else carries the number.

  /** Adds `value` to the record as a number of its own, through the pencil. */
  async function addOwnNumber(admin: Signed, kind: 'lead' | 'job', id: string, value: string) {
    const added = await admin.post(`/api/${kind}s/${id}/contact-entries`, { kind: 'PHONE', value });
    expect(added.status).toBe(201);
  }

  /** The texts the record's Communication tab lists, as [text, record]. */
  async function textsOnTab(admin: Signed, kind: 'lead' | 'job', id: string) {
    const tab = await admin.get(`/api/${kind}s/${id}/communications`);
    expect(tab.status).toBe(200);
    return tab.body.items
      .filter((i: { channel: string }) => i.channel === 'sms')
      .map((i: { preview: string; leadId?: string; jobId?: string }) => [i.preview, kind === 'lead' ? i.leadId : i.jobId]);
  }

  /** Closes the record: a lead Won, a job Done. */
  async function close(kind: 'lead' | 'job', id: string) {
    if (kind === 'lead') await db.lead.update({ where: { id }, data: { status: 'WON' } });
    else await db.job.update({ where: { id }, data: { status: 'DONE' } });
  }

  for (const kind of ['lead', 'job'] as const) {
    describe(`#3018: Text on a ${kind}'s own (555) 010-5252, which is also another customer's primary`, () => {
      // Open, the record is the one open record carrying (555) 010-5252, so the number's customer pick names its own customer.
      // Closed, it does not decide the pick, and the other customer is the one the number names: the case the text could
      // be filed on that customer instead of the record.
      for (const open of [true, false]) {
        it(`sends to (555) 010-5252 and stays on the ${kind}${open ? '' : ` once the ${kind} is closed and the number names the other customer`}`, async () => {
          const w = await connectedOrg();
          const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
          const admin = await fx.signedInAs(w.admin);
          const neighbour = await neighbourCarries5252(w, admin);
          await addOwnNumber(admin, kind, record.id, '(555) 010-5252');
          if (!open) {
            await close(kind, record.id);
            await expectPickNames(w.org, neighbour);
          }

          const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-5252', [`${kind}Id`]: record.id, body: 'Is this your cell?' });

          expect(res.status).toBe(201);
          expect(sentTo).toEqual(['+15550105252']);
          expect(res.body.message[`${kind}Id`]).toBe(record.id);
          expect(await textsOnTab(admin, kind, record.id)).toEqual([['Is this your cell?', record.id]]);
        });
      }
    });

    describe(`#3018: Text on a customer's second phone from a ${kind}`, () => {
      // The customer's Secondary (the second phone column) and a phone on the customer's list, stored as the app stores them.
      for (const [which, named, expected] of [
        ['Secondary', '(555) 010-4004', '+15550104004'],
        ['phone on the customer\'s list', '(555) 010-6116', '+15550106116'],
      ] as const) {
        it(`texts the ${which}, not the primary, and stays on the ${kind}`, async () => {
          const w = await connectedOrg();
          await db.customer.update({
            where: { id: w.customer },
            data: { secondary_phone: '5550104004', phones: { create: { phone: '5550106116', label: 'Office', is_primary: false } } },
          });
          const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
          const admin = await fx.signedInAs(w.admin);

          const res = await admin.post('/api/communication/sms', { toNumber: named, [`${kind}Id`]: record.id, body: 'Which number is best?' });

          expect(res.status).toBe(201);
          expect(sentTo).toEqual([expected]);
          expect(res.body.message[`${kind}Id`]).toBe(record.id);
          expect(await textsOnTab(admin, kind, record.id)).toEqual([['Which number is best?', record.id]]);
        });
      }

      // Ran (2026-11-05): a send to ANY customer phone the record changed goes to the record's changed number.
      it(`texts the ${kind}'s changed number when the ${kind} changed the Secondary`, async () => {
        const w = await connectedOrg();
        await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '5550104004' } });
        const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
        const admin = await fx.signedInAs(w.admin);
        const pencil = await admin.post(`/api/${kind}s/${record.id}/contact-entries/change`, {
          kind: 'PHONE', replaces: '(555) 010-4004', value: '(555) 010-5353',
        });
        expect(pencil.status).toBe(201);

        const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-4004', [`${kind}Id`]: record.id, body: 'Which number is best?' });

        expect(res.status).toBe(201);
        expect(sentTo).toEqual(['+15550105353']);
        expect(res.body.message[`${kind}Id`]).toBe(record.id);
      });
    });

    describe(`#3018: a number on neither the ${kind} nor its customer`, () => {
      // (555) 010-9009 is the customer's OTHER record's own number: on the customer's file through that record, but not on this
      // one. (555) 010-8008 is nobody's. Both get the same answer, which says nothing about the other record.
      it(`is refused with "You can only text the numbers on this ${kind}" and nothing is sent, even when the customer's other ${kind} carries it`, async () => {
        const w = await connectedOrg();
        const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
        const sibling = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
        const admin = await fx.signedInAs(w.admin);
        await addOwnNumber(admin, kind, sibling.id, '(555) 010-9009');

        const siblings = await admin.post('/api/communication/sms', { toNumber: '(555) 010-9009', [`${kind}Id`]: record.id, body: 'Hello' });
        const nobodys = await admin.post('/api/communication/sms', { toNumber: '(555) 010-8008', [`${kind}Id`]: record.id, body: 'Hello' });

        expect(siblings.status).toBe(404);
        expect(siblings.body).toEqual({ error: `You can only text the numbers on this ${kind}` });
        expect({ status: nobodys.status, body: nobodys.body }).toEqual({ status: siblings.status, body: siblings.body });
        expect(sentTo).toEqual([]);
        const conversations = await admin.get('/api/communication/threads');
        expect(conversations.body.threads).toEqual([]);
      });
    });

    describe(`#3018: a second company carrying the ${kind}'s own (555) 010-5252 with a stronger claim`, () => {
      // The record is closed, so in its own company only its customer carries (555) 010-5252 (through the record). In the second
      // company a newer customer has (555) 010-5252 as their primary, and another customer's open record carries it as its own:
      // the first step of the number's pick there. None of that may reach this company's text.
      it(`never wins: the text goes to (555) 010-5252 on the ${kind}, in its own customer's conversation, and nothing is written in the second company`, async () => {
        const w = await connectedOrg();
        const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
        const admin = await fx.signedInAs(w.admin);
        await addOwnNumber(admin, kind, record.id, '(555) 010-5252');
        await close(kind, record.id);

        const elsewhere = await fx.newOrg();
        orgs.push(elsewhere.org);
        await db.customer.update({ where: { id: elsewhere.customer }, data: { phone: '5550106006' } });
        await db.customer.create({
          data: {
            organization_id: elsewhere.org, customer_number: `C-shared-${elsewhere.tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
            first_name: 'Pat', last_name: 'Morgan', phone: '5550105252',
          },
        });
        const theirs = kind === 'lead' ? await fx.addLead(elsewhere.org, elsewhere.customer) : await fx.addJob(elsewhere.org, elsewhere.customer);
        const theirAdmin = await fx.signedInAs(elsewhere.admin);
        const theirPencil = await theirAdmin.post(`/api/${kind}s/${theirs.id}/contact-entries/change`, {
          kind: 'PHONE', replaces: '(555) 010-6006', value: '(555) 010-5252',
        });
        expect(theirPencil.status).toBe(201);
        await expectPickNames(elsewhere.org, elsewhere.customer);

        const res = await admin.post('/api/communication/sms', { toNumber: '(555) 010-5252', [`${kind}Id`]: record.id, body: 'Is this your cell?' });

        expect(res.status).toBe(201);
        expect(sentTo).toEqual(['+15550105252']);
        expect(res.body.message[`${kind}Id`]).toBe(record.id);
        const conversations = await admin.get('/api/communication/threads');
        expect(conversations.body.threads.map((t: { customerId: string }) => t.customerId)).toEqual([w.customer]);
        expect(JSON.stringify(res.body)).not.toContain(elsewhere.customer);
        // Nothing in the second company, as its admin reads it: no conversation, and no text on its record carrying 5252.
        const theirConversations = await theirAdmin.get('/api/communication/threads');
        expect(theirConversations.status).toBe(200);
        expect(theirConversations.body.threads).toEqual([]);
        expect(await textsOnTab(theirAdmin, kind, theirs.id)).toEqual([]);
      });
    });
  }

  // #3018 (customer page): Text on a customer's Secondary on the customer's own page, with no lead or job. The text box opens
  // on the conversation the server names for that number (the line's `conversationId`), else New message to that number,
  // whose send names the number: `{ toNumber }`. It texts the Secondary, in the conversation for (the Secondary, our number)
  // - the same one the inbox and Text on the Secondary from the customer's lead continue (#3019, #3023) - never the primary's.
  describe("#3018: Text on a customer's Secondary from the customer's page", () => {
    /** The line above the text box for the Secondary, as the customer page's Text asks for it. */
    async function lineForSecondary(admin: Signed) {
      const line = await admin.get('/api/communication/sms/numbers?toNumber=%2B15550104004');
      expect(line.status).toBe(200);
      return line.body as { to: string; from: string; conversationId: string | null };
    }

    /** The conversations the person lists, each with [its other party's number, our number]. */
    async function pairsListed(admin: Signed) {
      const listed = await admin.get('/api/communication/threads');
      expect(listed.status).toBe(200);
      return listed.body.threads.map((t: { id: string; pair?: { otherPartyE164: string; ourNumberE164: string } }) => ({
        id: t.id, pair: t.pair ? [t.pair.otherPartyE164, t.pair.ourNumberE164] : null,
      }));
    }

    it("texts the Secondary in the Secondary's own conversation, the one the line names, a reply in it, and Text on it from the customer's lead continue", async () => {
      const w = await connectedOrg();
      await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '5550104004' } });
      const lead = await fx.addLead(w.org, w.customer);
      const admin = await fx.signedInAs(w.admin);
      // The customer already has a conversation: Text on the Primary (by the customer) texts the primary, as before.
      const primary = await admin.post('/api/communication/sms', { customerId: w.customer, body: 'Hello from the office' });
      expect(primary.status).toBe(201);
      expect(sentTo).toEqual(['+15550103002']);
      const before = await lineForSecondary(admin);
      expect(before.to).toBe('+15550104004');
      expect(before.conversationId).toBeNull();

      const res = await admin.post('/api/communication/sms', { toNumber: '+15550104004', body: 'Which number is best?' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550103002', '+15550104004']);
      expect(res.body.to).toBe('+15550104004');
      const secondarys = res.body.threadId as string;
      expect(secondarys).not.toBe(primary.body.threadId);
      expect(await pairsListed(admin)).toEqual(expect.arrayContaining([
        { id: secondarys, pair: ['+15550104004', before.from] },
        { id: primary.body.threadId, pair: ['+15550103002', before.from] },
      ]));
      // The line now names that conversation, so Text on the Secondary opens it.
      expect(await lineForSecondary(admin)).toMatchObject({ to: '+15550104004', conversationId: secondarys });
      // A reply in it texts the Secondary.
      const reply = await admin.post('/api/communication/sms', { threadId: secondarys, body: 'Following up' });
      expect(reply.status).toBe(201);
      expect(reply.body.threadId).toBe(secondarys);
      // Text on the Secondary from the customer's lead continues the same conversation.
      const fromLead = await admin.post('/api/communication/sms', { toNumber: '(555) 010-4004', leadId: lead.id, body: 'About your quote' });
      expect(fromLead.status).toBe(201);
      expect(fromLead.body.threadId).toBe(secondarys);
      expect(sentTo).toEqual(['+15550103002', '+15550104004', '+15550104004', '+15550104004']);
    });

    it("never joins the customer's conversation from before pairs, which texts the primary", async () => {
      const w = await connectedOrg();
      await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '5550104004' } });
      // A conversation from before pairs (the split script has not reached it), filed on the customer, its text naming no number.
      const old = await db.messageThread.create({
        data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: w.customer },
      });
      await db.message.create({
        data: { organization_id: w.org, thread_id: old.id, direction: 'in', body: 'Is Tuesday fine?', ts: new Date(Date.now() - 86_400_000), status: 'received' },
      });
      const admin = await fx.signedInAs(w.admin);
      expect((await lineForSecondary(admin)).conversationId).toBeNull();

      const res = await admin.post('/api/communication/sms', { toNumber: '+15550104004', body: 'Which number is best?' });

      expect(res.status).toBe(201);
      expect(sentTo).toEqual(['+15550104004']);
      expect(res.body.threadId).not.toBe(old.id);
      // Text on the Primary still continues the customer's conversation from before pairs, and texts the primary.
      const primary = await admin.post('/api/communication/sms', { customerId: w.customer, body: 'Hello from the office' });
      expect(primary.status).toBe(201);
      expect(primary.body.threadId).toBe(old.id);
      expect(sentTo).toEqual(['+15550104004', '+15550103002']);
    });
  });
});
