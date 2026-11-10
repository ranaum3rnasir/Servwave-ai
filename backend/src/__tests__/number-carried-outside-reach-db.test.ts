/* =============================================================================
   Guard the number (whole-diff security ruling, Ran 2026-11-07): a person cannot make a customer carry a number that a
   customer they cannot open already carries, unless they hold Communication "All". Every person door that makes a customer
   carry a number refuses it with one sentence that names nobody: the lead's and the job's own contact entries (add, change,
   correct), the customer's own create and edit (Create anyway included), the new lead and new job forms (a new customer, or
   a phone typed for an existing one), and the office review's apply.

   Carries a number (CONTEXT.md): one of the customer's phone fields (phone, second phone, phones list) or a live phone entry
   of one of their leads or jobs. Since #3021 a customer carrying a conversation's number opens it, so without this guard a
   rep who adds another rep's customer's number to his own lead reads that customer's texts (sec-probe-1).

   Real HTTP through the app on a real migrated database (TEST_DATABASE_URL); the phone provider is faked at its network
   edge (fetch). Placeholder people and 555-01xx numbers only. The suite skips when TEST_DATABASE_URL is unset.
   ========================================================================== */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// ONE connection, as the hosted database's pool has: a guard that asked on another connection from inside the office review's
// finish transaction would wait for the one the transaction holds and time out, which a local pool of several hides.
const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const pooled = new URL(dbUrl);
  pooled.searchParams.set('connection_limit', '1');
  pooled.searchParams.set('pool_timeout', '5');
  return { realClient: new PrismaClient({ datasources: { db: { url: pooled.toString() } } }) };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The provider's client is mocked for every suite (setup.ts); here only its network edge is faked, so a send is real.
vi.unmock('../lib/ctm/client');

import { switchFixture } from './permission-switches-fixture';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

/** The refusal (conductor's copy for Ran's ruling), word for word. */
const REFUSAL = "This number is already on a customer you can't open. Ask someone who can open that customer to add it.";

const PROVIDER = 'https://phone-provider.test/api/v1';
const unexpected: string[] = [];
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  // The app's live-update broadcast (a test host, see setup.ts) is not the phone provider.
  if (u.includes('/realtime/v1/api/broadcast')) return json({});
  if (!u.startsWith(PROVIDER)) { unexpected.push(u); throw new Error(`unexpected network call: ${u}`); }
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) return json({ id: `MSG-GUARD-${randomUUID()}` });
  return json({ error: 'not found' }, 404);
}

const MAIN = '+15550100100';
const R_LINE = '+15550100111';
const S_LINE = '+15550100122';
/** Customer Y's phone: the number under guard. */
const N = '(555) 010-0155';
const N_E164 = '+15550100155';
/** A number no customer carries. */
const FREE = '(555) 010-0177';

suite('a number carried by a customer the person cannot open (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const TOKEN = randomUUID();

  beforeAll(async () => {
    await fx.listener();
    Object.assign(env as Record<string, unknown>, {
      CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER, CTM_WEBHOOK_TOKEN: TOKEN,
    });
    vi.stubGlobal('fetch', fakeProvider);
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await fx.cleanup();
  });

  /**
   * A company with two sales reps on the preset Sales role (Leads Attached, Jobs through own leads, Communication Attached,
   * View customers): R owns and is on customer Y's lead (so R opens Y), S owns and is on customer Z's lead L (so S opens Z,
   * never Y). Y carries N. X is a second customer of R's, so R has a lead of his own to put N on.
   */
  async function company() {
    const made = await fx.newOrg();
    const account = `NG${made.tag}`;
    await db.organization.update({ where: { id: made.org }, data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true } });
    const line = (e164: string, tpn: string, isDefault = false) => db.phoneNumber.create({
      data: { organization_id: made.org, e164, is_org_default: isDefault, status: 'active', sms_enabled: true, ctm_number_id: `${tpn}-${made.tag}` },
    });
    await line(MAIN, 'TPN-MAIN', true);
    const rLine = await line(R_LINE, 'TPN-R');
    const sLine = await line(S_LINE, 'TPN-S');
    const r = await fx.addUser(made.org, 'Rhea', 'SALES');
    const s = await fx.addUser(made.org, 'Sol', 'SALES');
    await db.userPhoneNumber.create({ data: { user_id: r.id, phone_number_id: rLine.id, is_default: true } });
    await db.userPhoneNumber.create({ data: { user_id: s.id, phone_number_id: sLine.id, is_default: true } });
    const y = made.customer;
    await db.customer.update({ where: { id: y }, data: { first_name: 'Yancy', last_name: 'Placeholder', phone: '5550100155' } });
    const newCustomer = async (first: string, phone: string) => {
      const id = randomUUID();
      await db.customer.create({ data: { id, organization_id: made.org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: first, last_name: 'Placeholder', phone } });
      return id;
    };
    const z = await newCustomer('Zed', '5550100166');
    const x = await newCustomer('Xan', '5550100188');
    const ly = await fx.addLead(made.org, y, { owner: r.id, assignees: [r.id] });
    const l = await fx.addLead(made.org, z, { owner: s.id, assignees: [s.id] });
    const lx = await fx.addLead(made.org, x, { owner: r.id, assignees: [r.id] });
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
    await db.lead.updateMany({ where: { id: { in: [l.id, ly.id, lx.id] } }, data: { created_at: twoDaysAgo } });
    return { ...made, account, r, s, y, z, x, ly: ly.id, l: l.id, lx: lx.id };
  }
  type Co = Awaited<ReturnType<typeof company>>;

  async function inboundText(w: Co, body: string, ours = R_LINE) {
    const res = await request(await fx.listener()).post(`/api/webhooks/ctm/inbound_text?token=${TOKEN}`).send({
      message_id: `MSG-GUARD-${randomUUID()}`, account_id: w.account, caller_number: N_E164, tracking_number: ours,
      direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000),
    });
    expect(res.status).toBe(200);
  }
  async function inboundCall(w: Co) {
    const res = await request(await fx.listener()).post(`/api/webhooks/ctm/end?token=${TOKEN}`).set('Content-Type', 'application/json').send(JSON.stringify({
      sid: `CA-GUARD-${randomUUID().slice(0, 12)}`, account_id: w.account, caller_number: N_E164, tracking_number: MAIN, direction: 'inbound',
      call_status: 'completed', dial_status: 'completed', talk_time: 42, duration: 45, unix_time: Math.floor(Date.now() / 1000),
    }));
    expect(res.status).toBe(200);
  }

  /** Y's conversation with R: Y texts R's line, R answers from the inbox (both tied to nothing). Its id. */
  async function yConversation(w: Co): Promise<string> {
    await inboundText(w, 'Y-UNTIED-1 gate code 4321');
    const admin = await fx.signedInAs(w.admin);
    const threads = (await admin.get('/api/communication/threads')).body.threads as { id: string; messages: { body: string }[] }[];
    const yt = threads.find((t) => t.messages.some((m) => m.body.startsWith('Y-UNTIED-1')));
    expect(yt).toBeDefined();
    const r = await fx.signedInAs(w.r);
    expect((await r.post('/api/communication/sms', { threadId: yt!.id, body: 'R-UNTIED-REPLY' })).status).toBe(201);
    return yt!.id;
  }

  const texts = (items: unknown): string[] =>
    (Array.isArray(items) ? items : []).map((i: Record<string, unknown>) => `${String(i.channel)}:${String(i.preview ?? i.body ?? '')}`);

  /**
   * sec-probe-1's reads (1)-(5) for S, as they were before the build: Z's page and L's tab show none of Y's texts, Y's
   * conversation does not open and cannot be continued, a text to N from S starts S's own conversation, and what Y sends or
   * calls next is filed on nothing of S's.
   */
  async function expectSStillOutsideY(w: Co, yt: string) {
    const s = await fx.signedInAs(w.s);
    const onZ = await s.get(`/api/customers/${w.z}/communications`);
    expect(onZ.status).toBe(200);
    expect(texts(onZ.body.items).filter((t) => /Y-UNTIED|R-UNTIED/.test(t))).toEqual([]);
    expect((await s.get(`/api/communication/threads/${yt}`)).status).toBe(404);
    const onL = await s.get(`/api/leads/${w.l}/communications`);
    expect(onL.status).toBe(200);
    expect(texts(onL.body.items).filter((t) => /Y-UNTIED|R-UNTIED/.test(t))).toEqual([]);
    expect((await s.get(`/api/communication/sms/numbers?${new URLSearchParams({ threadId: yt })}`)).status).toBe(404);
    expect((await s.post('/api/communication/sms', { threadId: yt, body: 'S-VIA-THREAD' })).status).toBe(404);
    const byNumber = await s.post('/api/communication/sms', { toNumber: N, body: 'S-VIA-NUMBER' });
    expect(byNumber.status).toBe(201);
    expect(byNumber.body.threadId).not.toBe(yt);
    const fromLead = await s.post('/api/communication/sms', { leadId: w.l, toNumber: N, body: 'S-VIA-LEAD' });
    expect([fromLead.status, fromLead.body.error]).toEqual([404, 'You can only text the numbers on this lead']);

    // (5) What Y does next lands on Y, not on S's lead or customer.
    await new Promise((res) => setTimeout(res, 1100));
    await inboundText(w, 'Y-AFTER');
    await inboundText(w, 'Y-TO-MAIN', MAIN);
    await inboundCall(w);
    const onLAfter = texts((await s.get(`/api/leads/${w.l}/communications`)).body.items);
    const onZAfter = texts((await s.get(`/api/customers/${w.z}/communications`)).body.items);
    for (const seen of [onLAfter, onZAfter]) {
      expect(seen.filter((t) => /Y-|R-UNTIED/.test(t) || t.startsWith('call:'))).toEqual([]);
    }
    const r = await fx.signedInAs(w.r);
    const onY = texts((await r.get(`/api/customers/${w.y}/communications`)).body.items);
    expect(onY.filter((t) => /Y-AFTER|Y-TO-MAIN/.test(t))).toHaveLength(2);
    expect(onY.filter((t) => t.startsWith('call:'))).toHaveLength(1);
    expect(unexpected).toEqual([]);
  }

  describe("a lead's own contact entries", () => {
    it("refuses S a number carried by a customer he can't open, and S still reads nothing of that customer's", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const s = await fx.signedInAs(w.s);

      const added = await s.post(`/api/leads/${w.l}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });

      expect([added.status, added.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it('lets R, who can open every customer carrying the number, put it on his own lead', async () => {
      const w = await company();
      const r = await fx.signedInAs(w.r);

      const added = await r.post(`/api/leads/${w.lx}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });

      expect(added.status).toBe(201);
    }, 60_000);

    it('lets a person on Communication "All" put a number carried by any customer on a lead', async () => {
      const w = await company();
      const admin = await fx.signedInAs(w.admin);

      const added = await admin.post(`/api/leads/${w.l}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });

      expect(added.status).toBe(201);
    }, 60_000);

    it("refuses S changing his customer's phone, for his lead only, to a number carried by a customer he can't open", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const s = await fx.signedInAs(w.s);

      const changed = await s.post(`/api/leads/${w.l}/contact-entries/change`, { kind: 'PHONE', replaces: '(555) 010-0166', value: N, label: 'Mobile' });

      expect([changed.status, changed.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it("refuses S correcting his lead's entry to a number carried by a customer he can't open", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const s = await fx.signedInAs(w.s);
      const added = await s.post(`/api/leads/${w.l}/contact-entries`, { kind: 'PHONE', value: FREE, label: 'Mobile' });
      expect(added.status).toBe(201);
      const entryId = (added.body.entries as { id: string; value: string }[]).find((e) => e.value === '5550100177')!.id;

      const corrected = await s.patch(`/api/leads/${w.l}/contact-entries/${entryId}`, { value: N });

      expect([corrected.status, corrected.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it("lets S correct only the label of an entry, and correct an entry to a number nobody carries", async () => {
      const w = await company();
      const s = await fx.signedInAs(w.s);
      const added = await s.post(`/api/leads/${w.l}/contact-entries`, { kind: 'PHONE', value: FREE, label: 'Mobile' });
      const entryId = (added.body.entries as { id: string; value: string }[]).find((e) => e.value === '5550100177')!.id;

      expect((await s.patch(`/api/leads/${w.l}/contact-entries/${entryId}`, { label: 'Work' })).status).toBe(200);
      expect((await s.patch(`/api/leads/${w.l}/contact-entries/${entryId}`, { value: '(555) 010-0178' })).status).toBe(200);
    }, 60_000);

    it('lets a sales rep on Communication "All", who still cannot open the customer carrying it, put the number on his lead', async () => {
      const w = await company();
      const key = `numguard-sales-all-${randomUUID().slice(0, 8)}`;
      const role = await fx.addCustomRole(w.org, key, 'SALES');
      await fx.setRoleSwitches(w.org, key, { communication_scope: 'all' });
      const t = await fx.addUser(w.org, 'Tam', 'SALES', { customRoleId: role.id });
      const lt = await fx.addLead(w.org, w.z, { owner: t.id, assignees: [t.id] });
      const api = await fx.signedInAs(t);
      expect((await api.get(`/api/customers/${w.y}`)).status).toBe(404);

      const added = await api.post(`/api/leads/${lt.id}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });

      expect(added.status).toBe(201);
    }, 60_000);

    it('lets S put a number nobody in his company carries on his own lead, though a customer of another company carries it', async () => {
      const w = await company();
      const other = await fx.newOrg();
      await db.customer.update({ where: { id: other.customer }, data: { phone: '5550100177' } });
      const s = await fx.signedInAs(w.s);

      const added = await s.post(`/api/leads/${w.l}/contact-entries`, { kind: 'PHONE', value: FREE, label: 'Mobile' });

      expect(added.status).toBe(201);
    }, 60_000);
  });

  describe("the customer's own create and edit", () => {
    it("refuses S creating a customer with a number carried by a customer he can't open, Create anyway included", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const s = await fx.signedInAs(w.s);
      const body = { first_name: 'Wes', last_name: 'Placeholder', phone: N };

      const anyway = await s.post('/api/customers?override=true', body);
      const asSecond = await s.post('/api/customers?override=true', { first_name: 'Wes', phone: FREE, secondary_phone: N });
      const inList = await s.post('/api/customers?override=true', { first_name: 'Wes', phone: FREE, phones: [{ phone: N }] });

      for (const res of [anyway, asSecond, inList]) expect([res.status, res.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it("refuses S changing his own customer's phones to a number carried by a customer he can't open, Create anyway included", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const s = await fx.signedInAs(w.s);

      const phone = await s.patch(`/api/customers/${w.z}?override=true`, { phone: N });
      const second = await s.patch(`/api/customers/${w.z}`, { secondary_phone: N });
      const list = await s.patch(`/api/customers/${w.z}`, { phones: [{ phone: N }] });

      for (const res of [phone, second, list]) expect([res.status, res.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it('lets S save his customer again with the phones it already has, and give it a number nobody carries', async () => {
      const w = await company();
      // Someone on Communication "All" already put N on Z as its second phone: Z and Y both carry it.
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/customers/${w.z}?override=true`, { secondary_phone: N })).status).toBe(200);
      const s = await fx.signedInAs(w.s);

      const again = await s.patch(`/api/customers/${w.z}`, { phone: '(555) 010-0166', secondary_phone: N, first_name: 'Zed' });
      const free = await s.patch(`/api/customers/${w.z}`, { secondary_phone: FREE });
      const created = await s.post('/api/customers', { first_name: 'Wes', phone: '(555) 010-0179' });

      expect([again.status, free.status, created.status]).toEqual([200, 200, 201]);
    }, 60_000);

    it('lets R, who can open the carrier, and a person on Communication "All" create and edit customers with the number', async () => {
      const w = await company();
      const r = await fx.signedInAs(w.r);
      const admin = await fx.signedInAs(w.admin);

      const byR = await r.patch(`/api/customers/${w.x}?override=true`, { secondary_phone: N });
      const byAdmin = await admin.patch(`/api/customers/${w.z}?override=true`, { phone: N });
      const createdByAdmin = await admin.post('/api/customers?override=true', { first_name: 'Wes', phone: N });

      expect([byR.status, byAdmin.status, createdByAdmin.status]).toEqual([200, 200, 201]);
    }, 60_000);
  });

  describe('the new lead and new job forms', () => {
    const LOCATION = { address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' };

    it("refuses S a new lead whose new customer, or whose typed phone for his own customer, is carried by a customer he can't open", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const s = await fx.signedInAs(w.s);

      const newCustomer = await s.post('/api/leads?override=true', { new_customer: { first_name: 'Wes', phone: N }, service_request: 'Fix the door' });
      const asSecond = await s.post('/api/leads?override=true', { new_customer: { first_name: 'Wes', phone: FREE, secondary_phone: N }, service_request: 'Fix the door' });
      const typed = await s.post('/api/leads?override=true', { customer_id: w.z, phone: N, service_request: 'Fix the door' });

      for (const res of [newCustomer, asSecond, typed]) expect([res.status, res.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it("lets S book a lead for his customer with the phone it already has, though a customer he can't open carries it too", async () => {
      const w = await company();
      // Z already carries N too (put there by a person on "All"); the form fills in the customer's own phones.
      expect((await (await fx.signedInAs(w.admin)).patch(`/api/customers/${w.z}?override=true`, { secondary_phone: N })).status).toBe(200);
      const s = await fx.signedInAs(w.s);

      const own = await s.post('/api/leads?override=true', { customer_id: w.z, phone: N, service_request: 'Fix the door' });

      expect(own.status).toBe(201);
    }, 60_000);

    it('lets a person on Communication "All" book a lead for a new customer with a number any customer carries', async () => {
      const w = await company();

      const byAdmin = await (await fx.signedInAs(w.admin)).post('/api/leads?override=true', { new_customer: { first_name: 'Wes', phone: N }, service_request: 'Fix the door' });

      expect(byAdmin.status).toBe(201);
    }, 60_000);

    it("refuses a dispatcher who can't open a customer carrying the number a new job with it, for a new customer or typed for theirs", async () => {
      const w = await company();
      await fx.addJob(w.org, w.z);
      const key = `numguard-dispatch-${randomUUID().slice(0, 8)}`;
      const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');
      await fx.setRoleSwitches(w.org, key, { leads_scope: 'attached' });
      const d = await fx.signedInAs(await fx.addUser(w.org, 'Dee', 'DISPATCHER', { customRoleId: role.id }));

      const newCustomer = await d.post('/api/jobs?override=true', { new_customer: { first_name: 'Wes', phone: N, location: LOCATION } });
      const typed = await d.post('/api/jobs?override=true', { customer_id: w.z, phone: N, new_location: LOCATION });
      const free = await d.post('/api/jobs', { new_customer: { first_name: 'Wes', phone: FREE, location: LOCATION } });

      for (const res of [newCustomer, typed]) expect([res.status, res.body.error]).toEqual([409, REFUSAL]);
      expect(free.status).toBe(201);
    }, 60_000);

    it('lets a dispatcher who can open every customer carrying the number make a new job with it', async () => {
      const w = await company();
      const d = await fx.signedInAs(await fx.addUser(w.org, 'Dot', 'DISPATCHER'));

      const made = await d.post('/api/jobs?override=true', { new_customer: { first_name: 'Wes', phone: N, location: LOCATION } });

      expect(made.status).toBe(201);
    }, 60_000);
  });

  describe("the office review's apply", () => {
    type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
    interface Item { key: string; kind: string; checked: boolean; latest_entry_id: string; contact?: { kind: string } }
    interface Review { version: string; summary: { checked: boolean; latest_entry_id: string | null }; groups: { key: string; items: Item[] }[] }
    const itemsOf = (r: Review) => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);
    const read = async (api: Api, jobId: string): Promise<Review> => (await api.get(`/api/jobs/${jobId}/review`)).body.review;

    /** Z's job, with N put on it as the job's own phone by a person on Communication "All", then handed to the review. */
    async function reviewWithN(w: Co) {
      const job = await fx.addJob(w.org, w.z, { fromLead: w.l });
      const admin = await fx.signedInAs(w.admin);
      expect((await admin.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' })).status).toBe(201);
      await db.job.update({ where: { id: job.id }, data: { status: 'OFFICE_REVIEW', completed_at: new Date() } });
      await db.jobReview.create({ data: { organization_id: w.org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000) } });
      await db.timelineEvent.create({
        data: { organization_id: w.org, entity_type: 'JOB', entity_id: job.id, event_type: 'OFFICE_REVIEW_STARTED', description: 'Office review started', created_at: new Date(Date.now() + 5) },
      });
      return job.id;
    }

    /** Check every item the way the reviewer does, picking "Add to the customer" for the phone, then finish. */
    async function finishAddingTheNumber(api: Api, jobId: string) {
      let review = await read(api, jobId);
      const plain = [
        ...(review.summary.checked || !review.summary.latest_entry_id ? [] : [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }]),
        ...itemsOf(review).filter((i) => i.kind !== 'contact' && !i.checked).map((i) => ({ item_key: i.key, entry_id: i.latest_entry_id })),
      ];
      if (plain.length > 0) expect((await api.post(`/api/jobs/${jobId}/review/checks/all`, { items: plain })).status).toBe(200);
      review = await read(api, jobId);
      const phone = itemsOf(review).find((i) => i.kind === 'contact' && i.contact?.kind === 'PHONE');
      expect(phone).toBeDefined();
      expect((await api.post(`/api/jobs/${jobId}/review/decisions`, { item_key: phone!.key, entry_id: phone!.latest_entry_id, choice: 'ADD' })).status).toBe(200);
      return api.post(`/api/jobs/${jobId}/review/finish`, { version: (await read(api, jobId)).version });
    }

    /** A reviewer on the Dispatcher preset (Office review, Jobs All), with Leads Attached unless they reach every lead. */
    async function reviewer(w: Co, reachesEveryLead: boolean) {
      const key = `numguard-reviewer-${randomUUID().slice(0, 8)}`;
      const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');
      if (!reachesEveryLead) await fx.setRoleSwitches(w.org, key, { leads_scope: 'attached' });
      return fx.addUser(w.org, `rev${key.slice(-4)}`, 'DISPATCHER', { customRoleId: role.id });
    }

    it("refuses a reviewer who can't open a customer carrying the number adding it to the job's customer", async () => {
      const w = await company();
      const jobId = await reviewWithN(w);
      const api = await fx.signedInAs(await reviewer(w, false));

      const finished = await finishAddingTheNumber(api, jobId);

      expect([finished.status, finished.body.error]).toEqual([409, REFUSAL]);
      // Nothing of the finish was applied: the customer has no such phone, and the job is still in Office review.
      const admin = await fx.signedInAs(w.admin);
      const zNow = (await admin.get(`/api/customers/${w.z}`)).body.customer as { phone: string | null; secondary_phone: string | null; phones: { phone: string }[] };
      expect([zNow.phone, zNow.secondary_phone, ...zNow.phones.map((p) => p.phone)]).not.toContain('5550100155');
      expect((await admin.get(`/api/jobs/${jobId}`)).body.job.status).toBe('OFFICE_REVIEW');
    }, 120_000);

    it('lets a reviewer who can open every customer carrying it, and one on Communication "All", add it', async () => {
      const w = await company();
      const first = await reviewWithN(w);
      const second = await reviewWithN(w);

      const byReach = await finishAddingTheNumber(await fx.signedInAs(await reviewer(w, true)), first);
      const byAdmin = await finishAddingTheNumber(await fx.signedInAs(w.admin), second);

      expect([byReach.status, byAdmin.status]).toEqual([200, 200]);
    }, 120_000);
  });

  describe("a job's own contact entries", () => {
    it("refuses S adding, or changing his customer's phone to, a number carried by a customer he can't open", async () => {
      const w = await company();
      const yt = await yConversation(w);
      const job = await fx.addJob(w.org, w.z, { fromLead: w.l });
      const s = await fx.signedInAs(w.s);

      const added = await s.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });
      const changed = await s.post(`/api/jobs/${job.id}/contact-entries/change`, { kind: 'PHONE', replaces: '(555) 010-0166', value: N, label: 'Mobile' });

      expect([added.status, added.body.error]).toEqual([409, REFUSAL]);
      expect([changed.status, changed.body.error]).toEqual([409, REFUSAL]);
      await expectSStillOutsideY(w, yt);
    }, 120_000);

    it("lets a technician, who opens no customer, add to his job a number only the job's own customer carries", async () => {
      const w = await company();
      const tech = await fx.addUser(w.org, 'Tex', 'TECHNICIAN');
      const job = await fx.addJob(w.org, w.z, { crew: [tech.id] });
      // Z carries (555) 010-0177 through its lead's own entry, not its phone fields.
      expect((await (await fx.signedInAs(w.s)).post(`/api/leads/${w.l}/contact-entries`, { kind: 'PHONE', value: FREE, label: 'Mobile' })).status).toBe(201);
      const api = await fx.signedInAs(tech);

      const added = await api.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: FREE, label: 'Mobile' });
      const elsewhere = await api.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: N, label: 'Home' });

      expect(added.status).toBe(201);
      expect([elsewhere.status, elsewhere.body.error]).toEqual([409, REFUSAL]);
    }, 60_000);

    it("lets R (who can open the carrier), a person on Communication \"All\", and S with a number nobody carries add to a job", async () => {
      const w = await company();
      const jobX = await fx.addJob(w.org, w.x, { fromLead: w.lx });
      const jobZ = await fx.addJob(w.org, w.z, { fromLead: w.l });

      const byR = await (await fx.signedInAs(w.r)).post(`/api/jobs/${jobX.id}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });
      const byAdmin = await (await fx.signedInAs(w.admin)).post(`/api/jobs/${jobZ.id}/contact-entries`, { kind: 'PHONE', value: N, label: 'Mobile' });
      const byS = await (await fx.signedInAs(w.s)).post(`/api/jobs/${jobZ.id}/contact-entries`, { kind: 'PHONE', value: FREE, label: 'Mobile' });

      expect([byR.status, byAdmin.status, byS.status]).toEqual([201, 201, 201]);
    }, 60_000);
  });
});
