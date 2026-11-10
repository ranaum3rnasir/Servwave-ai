/* =============================================================================
   #3024 - Attach to a lead or job, across every customer with the number (parent #3013, Q41 and decision 1; Ran's rulings of
   2026-11-06).

   A text's or a call's "Attach to a lead or job" may tie it to a lead or job of any customer carrying its number (CONTEXT.md
   "Carries a number") that the person reaches; this replaces "same customer only". When no customer carries the number, any lead
   or job the person can open, as before. A conversation from before pairs keeps its same-customer rule. The existing Attach
   switch gates it.

   Driven through the real HTTP routes (the menu's read, the text and call re-tie routes, the inbox and call reads) against a real
   migrated database (TEST_DATABASE_URL; the suite skips when it is unset). Texts arrive through the incoming-text webhook and
   calls through the call log's own door. The phone system is faked at its network edge only (`fetch`). Every org the suite makes
   is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why). The client reports every statement
// it runs, so a test can count what one request costs.
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
/** The number Jordan Lee, Pat Morgan and Alex Kim carry. */
const SHARED = '+15550103002';
/** A number no customer carries. */
const UNKNOWN = '+15550103099';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: nothing may be reached but its opt-out list and its send. */
async function fakeProvider(url: unknown, init?: { method?: string }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) return json({ id: `MSG-3024-${randomUUID()}` });
  return json({ error: 'not found' }, 404);
}

type Group = { customer: { id: string; name: string }; jobs: { id: string; number: string }[]; leads: { id: string; number: string }[] };
type Targets = { rule: 'carriers' | 'any'; groups: Group[] };

suite('attach a text or a call to a lead or job of any customer carrying its number (real database)', () => {
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
        'messages', 'message_threads', 'call_sessions', 'record_contact_entries', 'customer_phones']) {
        const where = table === 'customer_phones'
          ? `customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`
          : `organization_id = '${org}'`;
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${where}`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM jobs WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /**
   * A person on a role of their own who uses the text inbox and the call log on Communication scope "attached". `reach` is
   * their reach on customers, leads and jobs; `attach` their Attach conversations to jobs and leads switch.
   */
  async function personWho(org: string, name: string, opts: { reach?: 'attached' | 'all'; attach?: boolean; viewCustomers?: boolean } = {}) {
    const key = `attach-menu-${++sequence}`;
    await fx.addCustomRole(org, key, 'DISPATCHER');
    const reach = opts.reach ?? 'attached';
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, actorId: null, reason: 'manual',
      values: {
        view_customers: opts.viewCustomers ?? true, ...(opts.viewCustomers === false && { create_customers: false, edit_customers: false }), view_jobs: true, jobs_scope: reach, view_leads: true, leads_scope: reach,
        access_communication: true, view_communication: true, communication_scope: 'attached',
        see_main_line_when_no_number: false, attach_conversations: opts.attach ?? true,
      },
    });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id });
  }

  async function addCustomer(org: string, first: string, last: string, phones: { phone?: string; secondary_phone?: string }) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: first, last_name: last, ...phones,
      },
    });
    return id;
  }

  async function jobNumbered(org: string, customer: string, number: string, opts: Parameters<typeof fx.addJob>[2] = {}) {
    const job = await fx.addJob(org, customer, opts);
    await db.job.update({ where: { id: job.id }, data: { job_number: number } });
    return job.id;
  }

  async function leadNumbered(org: string, customer: string, number: string, opts: Parameters<typeof fx.addLead>[2] = {}) {
    const lead = await fx.addLead(org, customer, opts);
    await db.lead.update({ where: { id: lead.id }, data: { lead_number: number } });
    return lead.id;
  }

  /**
   * A company connected to the phone system, with its main line and three customers who carry (555) 010-3002: Jordan Lee (as
   * the phone, stored bare), Pat Morgan (as the phone, stored as E.164) and Alex Kim (as the second phone). Sam Rivera does not
   * carry it. Each has open work (and Jordan a cancelled job, Alex a lost lead). Pia owns Pat's lead and dispatches J00218, so
   * she reaches Pat Morgan and no one else.
   */
  async function sharedNumberCompany() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3024${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    // The main line: +1 555 0105 NNN, never a number a customer in this file carries.
    const mainLine = `+1555010${5000 + ++sequence}`;
    await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN-MAIN-${made.tag}`,
      },
    });
    const jordan = made.customer;
    await db.customer.update({ where: { id: jordan }, data: { first_name: 'Jordan', last_name: 'Lee', phone: '5550103002' } });
    const pat = await addCustomer(made.org, 'Pat', 'Morgan', { phone: SHARED });
    const alex = await addCustomer(made.org, 'Alex', 'Kim', { phone: '5550107777', secondary_phone: '5550103002' });
    const sam = await addCustomer(made.org, 'Sam', 'Rivera', { phone: '5550108888' });
    const pia = await personWho(made.org, 'Pia');
    const records = {
      jordanJob: await jobNumbered(made.org, jordan, 'J00101'),
      jordanLead: await leadNumbered(made.org, jordan, 'L00055'),
      patJob: await jobNumbered(made.org, pat, 'J00218', { dispatcher: pia.id }),
      patLead: await leadNumbered(made.org, pat, 'L00060', { owner: pia.id }),
      alexLead: await leadNumbered(made.org, alex, 'L00077'),
      samJob: await jobNumbered(made.org, sam, 'J00300'),
      samLead: await leadNumbered(made.org, sam, 'L00300'),
    };
    // A cancelled job and a lost lead are never offered, as the menu always did.
    await jobNumbered(made.org, jordan, 'J00199', { status: 'CANCELLED' });
    await db.lead.update({ where: { id: await leadNumbered(made.org, alex, 'L00078') }, data: { status: 'LOST' } });
    return { ...made, account, mainLine, jordan, pat, alex, sam, pia, ...records };
  }

  type Company = Awaited<ReturnType<typeof sharedNumberCompany>>;

  /** A customer texts our main line, as the phone system reports it; answers the text's id, read through the inbox. */
  async function textFrom(w: Company, from: string, body: string) {
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: `MSG-3024-${randomUUID()}`, account_id: w.account, caller_number: from, tracking_number: w.mainLine,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000),
      });
    expect(res.status).toBe(200);
    const threads = (await (await fx.signedInAs(w.admin)).get('/api/communication/threads')).body.threads as {
      id: string; messages: { id: string; body: string }[];
    }[];
    const thread = threads.find((t) => t.messages.some((m) => m.body === body))!;
    return { threadId: thread.id, messageId: thread.messages.find((m) => m.body === body)!.id };
  }

  /** A call in the call log from `from` to our main line; answers its id. */
  async function callFrom(w: Company, from: string) {
    const res = await (await fx.signedInAs(w.admin)).post('/api/communication/calls', {
      direction: 'in', from_number: from, to_number: w.mainLine, status: 'completed',
    });
    expect(res.status).toBe(201);
    return res.body.call.id as string;
  }

  /** The menu as the person gets it: per customer (in the order given), the numbers of their jobs and leads. */
  async function menuOf(person: Person, path: string) {
    const res = await (await fx.signedInAs(person)).get(path);
    expect(res.status).toBe(200);
    const body = res.body as Targets;
    return {
      rule: body.rule,
      groups: body.groups.map((g) => ({
        customer: g.customer.name, jobs: g.jobs.map((j) => j.number).sort(), leads: g.leads.map((l) => l.number).sort(),
      })),
    };
  }

  /** The text as the inbox shows it: its job and lead. */
  async function tieOfText(person: Person, threadId: string, messageId: string) {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/threads/${threadId}`);
    expect(res.status).toBe(200);
    const m = (res.body.thread.messages as { id: string; jobLabel?: string; leadId?: string; leadLabel?: string }[])
      .find((x) => x.id === messageId)!;
    return { job: m.jobLabel ?? null, lead: m.leadLabel ?? null };
  }

  /** The call as the call log shows it: its job and lead. */
  async function tieOfCall(person: Person, callId: string) {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/calls/${callId}`);
    expect(res.status).toBe(200);
    return { job: res.body.call.jobLabel ?? null, lead: res.body.call.linkedLead?.leadNumber ?? null };
  }

  const THREE_CARRIERS = (rule = 'carriers') => ({
    rule,
    groups: expect.arrayContaining([
      { customer: 'Jordan Lee', jobs: ['J00101'], leads: ['L00055'] },
      { customer: 'Pat Morgan', jobs: ['J00218'], leads: ['L00060'] },
      { customer: 'Alex Kim', jobs: [], leads: ['L00077'] },
    ]),
  });

  describe('on a reply from (555) 010-3002', () => {
    it("the menu lists Jordan Lee's, Pat Morgan's and Alex Kim's leads and jobs, grouped by customer, and no one else's", async () => {
      const w = await sharedNumberCompany();
      const { messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');

      const menu = await menuOf(w.admin, `/api/communication/sms/${messageId}/attach-targets`);
      expect(menu).toEqual(THREE_CARRIERS());
      expect(menu.groups).toHaveLength(3);
    });

    it("attaching it to Pat Morgan's J00218 succeeds, and so does Alex Kim's lead, which takes it off the job in the one change", async () => {
      const w = await sharedNumberCompany();
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      const api = await fx.signedInAs(w.admin);

      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.patJob })).status).toBe(200);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00218', lead: null });
      expect((await api.patch(`/api/communication/sms/${messageId}/lead`, { lead_id: w.alexLead })).status).toBe(200);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: null, lead: 'L00077' });
    });

    // Ran, 2026-11-06 (after spec r1 F1 / verifier r1 M1): attaching a text to a job sets its lead to the job's own lead, or
    // none, as a call's job does; it leaves the other customer's lead.
    it("a text on Jordan Lee's L00055 attached to Pat Morgan's J00218 ends on J00218 alone: off Jordan Lee's lead, which goes back to New", async () => {
      const w = await sharedNumberCompany();
      const api = await fx.signedInAs(w.admin);
      // Sent from Jordan Lee's lead, which it moves from New to Contacted.
      const sent = await api.post('/api/communication/sms', { customerId: w.jordan, leadId: w.jordanLead, body: 'About your quote' });
      expect(sent.status).toBe(201);
      const messageId = sent.body.message.id as string;
      const threads = (await api.get('/api/communication/threads')).body.threads as { id: string; messages: { id: string }[] }[];
      const threadId = threads.find((t) => t.messages.some((m) => m.id === messageId))!.id;
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: null, lead: 'L00055' });
      expect((await api.get(`/api/leads/${w.jordanLead}`)).body.lead.status).toBe('CONTACTED');

      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.patJob })).status).toBe(200);

      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00218', lead: null });
      // Jordan Lee's lead tab no longer has it on the lead (Jordan Lee still carries the number, so the tab's window, #3022,
      // still lists the text itself).
      const jordansTab = await api.get(`/api/leads/${w.jordanLead}/communications`);
      expect(jordansTab.status).toBe(200);
      const onJordansTab = (jordansTab.body.items as { id: string; leadId?: string }[]).find((i) => i.id === messageId);
      expect({ leadId: onJordansTab?.leadId ?? null }).toEqual({ leadId: null });
      expect((await api.get(`/api/leads/${w.jordanLead}`)).body.lead.status).toBe('NEW');
      // Pia reaches Pat Morgan only: she reads the text through J00218, and nothing of Jordan Lee's lead comes with it.
      expect(await tieOfText(w.pia, threadId, messageId)).toEqual({ job: 'J00218', lead: null });
    });

    it("attached to a job converted from a lead, the text takes that job's own lead", async () => {
      const w = await sharedNumberCompany();
      const convertedJob = await jobNumbered(w.org, w.pat, 'J00219', { fromLead: w.patLead });
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      const api = await fx.signedInAs(w.admin);
      expect((await api.patch(`/api/communication/sms/${messageId}/lead`, { lead_id: w.jordanLead })).status).toBe(200);

      const attached = await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: convertedJob });
      expect(attached.status).toBe(200);
      // The answer says so too, so the inbox shows what the server did.
      expect(attached.body.message).toMatchObject({ jobLabel: 'J00219', leadId: w.patLead, leadLabel: 'L00060' });
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00219', lead: 'L00060' });
    });

    it('attaching it to a customer without the number is refused by the server, exactly as a record that does not exist', async () => {
      const w = await sharedNumberCompany();
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      const api = await fx.signedInAs(w.admin);

      const job = await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.samJob });
      const noJob = await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: randomUUID() });
      expect({ status: job.status, body: job.body }).toEqual({ status: noJob.status, body: noJob.body });
      expect(job.status).toBe(404);
      const lead = await api.patch(`/api/communication/sms/${messageId}/lead`, { lead_id: w.samLead });
      const noLead = await api.patch(`/api/communication/sms/${messageId}/lead`, { lead_id: randomUUID() });
      expect({ status: lead.status, body: lead.body }).toEqual({ status: noLead.status, body: noLead.body });
      expect(lead.status).toBe(404);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: null, lead: null });
    });

    it('"No lead or job" unties it in the one change, through either route', async () => {
      const w = await sharedNumberCompany();
      const convertedJob = await jobNumbered(w.org, w.pat, 'J00219', { fromLead: w.patLead });
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      const api = await fx.signedInAs(w.admin);
      for (const untie of [{ route: 'job', body: { job_id: null } }, { route: 'lead', body: { lead_id: null } }]) {
        await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: convertedJob });
        expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00219', lead: 'L00060' });

        expect((await api.patch(`/api/communication/sms/${messageId}/${untie.route}`, untie.body)).status).toBe(200);
        expect({ untie: untie.route, tie: await tieOfText(w.admin, threadId, messageId) }).toEqual({ untie: untie.route, tie: { job: null, lead: null } });
      }
    });

    it("a person who reaches Pat Morgan only is offered Pat Morgan's work alone, and is refused Jordan Lee's", async () => {
      const w = await sharedNumberCompany();
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');

      expect(await menuOf(w.pia, `/api/communication/sms/${messageId}/attach-targets`)).toEqual({
        rule: 'carriers', groups: [{ customer: 'Pat Morgan', jobs: ['J00218'], leads: ['L00060'] }],
      });
      const api = await fx.signedInAs(w.pia);
      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.jordanJob })).status).toBe(404);
      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.patJob })).status).toBe(200);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00218', lead: null });
    });

    it('a person who opens leads and jobs but not the Customers module is offered the work they reach, under its customer, and may attach to it', async () => {
      const w = await sharedNumberCompany();
      const tess = await personWho(w.org, 'Tess', { reach: 'all', viewCustomers: false });
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      // Tess reads the text through the job it is on.
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/communication/sms/${messageId}/job`, { job_id: w.patJob })).status).toBe(200);

      const menu = await menuOf(tess, `/api/communication/sms/${messageId}/attach-targets`);
      expect(menu).toEqual(THREE_CARRIERS());
      expect(menu.groups).toHaveLength(3);
      const api = await fx.signedInAs(tess);
      expect((await api.patch(`/api/communication/sms/${messageId}/lead`, { lead_id: w.alexLead })).status).toBe(200);
      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.samJob })).status).toBe(404);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: null, lead: 'L00077' });
    });

    it('a person without Attach is refused the menu and the change', async () => {
      const w = await sharedNumberCompany();
      const nora = await personWho(w.org, 'Nora', { reach: 'all', attach: false });
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      const api = await fx.signedInAs(nora);

      expect((await api.get(`/api/communication/sms/${messageId}/attach-targets`)).status).toBe(403);
      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.patJob })).status).toBe(403);
      expect((await api.patch(`/api/communication/sms/${messageId}/lead`, { lead_id: w.patLead })).status).toBe(403);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: null, lead: null });
    });
  });

  describe('a text from a number no customer carries (ruling 2: any lead or job, as before)', () => {
    it('the menu searches every lead and job, and attaching to any customer\'s job succeeds', async () => {
      const w = await sharedNumberCompany();
      const { threadId, messageId } = await textFrom(w, UNKNOWN, 'Who is this?');

      expect(await menuOf(w.admin, `/api/communication/sms/${messageId}/attach-targets`)).toEqual({ rule: 'any', groups: [] });
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/communication/sms/${messageId}/job`, { job_id: w.samJob })).status).toBe(200);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00300', lead: null });
    });
  });

  describe('a conversation from before pairs keeps its same-customer rule', () => {
    it("offers and accepts only the customer it is filed on, though Pat Morgan carries the number too", async () => {
      const w = await sharedNumberCompany();
      const { threadId, messageId } = await textFrom(w, SHARED, 'Is Tuesday free?');
      // Setup only: the conversation as it was before pairs (#3019): no stored pair, filed on Jordan Lee.
      await db.messageThread.update({
        where: { id: threadId }, data: { other_party_e164: null, our_number_e164: null, customer_id: w.jordan },
      });
      const api = await fx.signedInAs(w.admin);

      expect(await menuOf(w.admin, `/api/communication/sms/${messageId}/attach-targets`)).toEqual({
        rule: 'carriers', groups: [{ customer: 'Jordan Lee', jobs: ['J00101'], leads: ['L00055'] }],
      });
      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.patJob })).status).toBe(404);
      expect((await api.patch(`/api/communication/sms/${messageId}/job`, { job_id: w.jordanJob })).status).toBe(200);
      expect(await tieOfText(w.admin, threadId, messageId)).toEqual({ job: 'J00101', lead: null });
    });
  });

  describe('a call (ruling 1)', () => {
    it('from (555) 010-3002: the menu lists the three carriers, Pat Morgan\'s J00218 is accepted and a customer without the number refused', async () => {
      const w = await sharedNumberCompany();
      const callId = await callFrom(w, '(555) 010-3002');
      const api = await fx.signedInAs(w.admin);

      const menu = await menuOf(w.admin, `/api/communication/calls/${callId}/attach-targets`);
      expect(menu).toEqual(THREE_CARRIERS());
      expect(menu.groups).toHaveLength(3);

      const job = await api.patch(`/api/communication/calls/${callId}/job`, { job_id: w.samJob });
      const noJob = await api.patch(`/api/communication/calls/${callId}/job`, { job_id: randomUUID() });
      expect({ status: job.status, body: job.body }).toEqual({ status: 404, body: noJob.body });
      const lead = await api.patch(`/api/communication/calls/${callId}/lead`, { lead_id: w.samLead });
      const noLead = await api.patch(`/api/communication/calls/${callId}/lead`, { lead_id: randomUUID() });
      expect({ status: lead.status, body: lead.body }).toEqual({ status: 404, body: noLead.body });
      expect(await tieOfCall(w.admin, callId)).toEqual({ job: null, lead: null });

      expect((await api.patch(`/api/communication/calls/${callId}/job`, { job_id: w.patJob })).status).toBe(200);
      expect(await tieOfCall(w.admin, callId)).toEqual({ job: 'J00218', lead: null });
      expect((await api.patch(`/api/communication/calls/${callId}/lead`, { lead_id: w.alexLead })).status).toBe(200);
      expect(await tieOfCall(w.admin, callId)).toEqual({ job: null, lead: 'L00077' });
      expect((await api.patch(`/api/communication/calls/${callId}/job`, { job_id: null })).status).toBe(200);
      expect(await tieOfCall(w.admin, callId)).toEqual({ job: null, lead: null });
    });

    it('from a number no customer carries: any lead or job, as before', async () => {
      const w = await sharedNumberCompany();
      const callId = await callFrom(w, '(555) 010-3099');

      expect(await menuOf(w.admin, `/api/communication/calls/${callId}/attach-targets`)).toEqual({ rule: 'any', groups: [] });
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/communication/calls/${callId}/job`, { job_id: w.samJob })).status).toBe(200);
      expect(await tieOfCall(w.admin, callId)).toEqual({ job: 'J00300', lead: null });
    });

    it('a person without Attach is refused the menu and the change', async () => {
      const w = await sharedNumberCompany();
      const nora = await personWho(w.org, 'Nora', { reach: 'all', attach: false });
      const callId = await callFrom(w, '(555) 010-3002');
      const api = await fx.signedInAs(nora);

      expect((await api.get(`/api/communication/calls/${callId}/attach-targets`)).status).toBe(403);
      expect((await api.patch(`/api/communication/calls/${callId}/job`, { job_id: w.patJob })).status).toBe(403);
      expect(await tieOfCall(w.admin, callId)).toEqual({ job: null, lead: null });
    });
  });

  describe('another company carrying the same number (organization check)', () => {
    it('is never offered, never accepted, and never turns our unknown number into a carried one', async () => {
      const w = await sharedNumberCompany();
      // Another company's customer carries both numbers, and has open work there.
      const elsewhere = await fx.newOrg();
      orgs.push(elsewhere.org);
      await db.customer.update({
        where: { id: elsewhere.customer },
        data: { first_name: 'Elsewhere', last_name: 'Only', phone: '5550103002', secondary_phone: '5550103099' },
      });
      const theirJob = await jobNumbered(elsewhere.org, elsewhere.customer, 'J09999');
      await leadNumbered(elsewhere.org, elsewhere.customer, 'L09999');

      const shared = await textFrom(w, SHARED, 'Is Tuesday free?');
      const menu = await menuOf(w.admin, `/api/communication/sms/${shared.messageId}/attach-targets`);
      expect(menu).toEqual(THREE_CARRIERS());
      expect(menu.groups).toHaveLength(3);
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/communication/sms/${shared.messageId}/job`, { job_id: theirJob })).status).toBe(404);

      // Our unknown number stays unknown here: any of our leads and jobs, text and call alike.
      const unknown = await textFrom(w, UNKNOWN, 'Who is this?');
      expect(await menuOf(w.admin, `/api/communication/sms/${unknown.messageId}/attach-targets`)).toEqual({ rule: 'any', groups: [] });
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/communication/sms/${unknown.messageId}/job`, { job_id: w.samJob })).status).toBe(200);
      const callId = await callFrom(w, '(555) 010-3099');
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/communication/calls/${callId}/job`, { job_id: w.samJob })).status).toBe(200);
    });
  });

  describe('the menu and the change cost the same however many customers carry the number', () => {
    /** The statements one request runs. */
    async function statementsOf(run: () => Promise<{ status: number }>) {
      const before = statements.length;
      const res = await run();
      expect(res.status).toBe(200);
      return statements.length - before;
    }

    it('3 carriers or 33, one query per read', async () => {
      const few = await sharedNumberCompany();
      const many = await sharedNumberCompany();
      for (let i = 1; i <= 30; i++) {
        const id = await addCustomer(many.org, 'Customer', String(i), { phone: '5550103002' });
        await jobNumbered(many.org, id, `J1${String(i).padStart(4, '0')}`);
        await leadNumbered(many.org, id, `L1${String(i).padStart(4, '0')}`);
      }
      const a = await textFrom(few, SHARED, 'Is Tuesday free?');
      const b = await textFrom(many, SHARED, 'Is Tuesday free?');
      const callA = await callFrom(few, '5550103002');
      const callB = await callFrom(many, '5550103002');
      const adminA = await fx.signedInAs(few.admin);
      const costA = {
        textMenu: await statementsOf(() => adminA.get(`/api/communication/sms/${a.messageId}/attach-targets`)),
        textTie: await statementsOf(() => adminA.patch(`/api/communication/sms/${a.messageId}/job`, { job_id: few.patJob })),
        callMenu: await statementsOf(() => adminA.get(`/api/communication/calls/${callA}/attach-targets`)),
        callTie: await statementsOf(() => adminA.patch(`/api/communication/calls/${callA}/job`, { job_id: few.patJob })),
      };
      const adminB = await fx.signedInAs(many.admin);
      const menuB = (await adminB.get(`/api/communication/sms/${b.messageId}/attach-targets`)).body as Targets;
      expect(menuB.groups).toHaveLength(33);
      const costB = {
        textMenu: await statementsOf(() => adminB.get(`/api/communication/sms/${b.messageId}/attach-targets`)),
        textTie: await statementsOf(() => adminB.patch(`/api/communication/sms/${b.messageId}/job`, { job_id: many.patJob })),
        callMenu: await statementsOf(() => adminB.get(`/api/communication/calls/${callB}/attach-targets`)),
        callTie: await statementsOf(() => adminB.patch(`/api/communication/calls/${callB}/job`, { job_id: many.patJob })),
      };
      expect(costB).toEqual(costA);
    });
  });
});
