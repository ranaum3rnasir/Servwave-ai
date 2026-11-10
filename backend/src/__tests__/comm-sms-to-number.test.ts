// Slice H7 — compose-to-number: POST /api/communication/sms accepts `toNumber`
// (an arbitrary NA phone) as the thread key, sharing the EXACT find-or-create
// keying the CTM webhook ingest uses (lib/ctm/smsThread.ts — extracted from
// ingestSms so a user-composed text and an inbound webhook text land in ONE
// conversation): customer-keyed when the number matches a customer (lead
// matches carry customerId), vendor-keyed on vendor matches, title-keyed
// (title = E.164) when unmatched. Precedence threadId > customerId > toNumber;
// the existing threadId/customerId paths stay byte-identical. Every CTM
// compliance gate (allowlist included) still 409s BEFORE any Message row
// exists on the new path.
//
// The phone system is the REAL client here, faked only at its network edge
// (`fetch`): what a send hands the phone system is read off the requests that
// reach it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

vi.unmock('../lib/ctm/client');

import app from '../app';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { findOrCreateSmsThreadByNumber } from '../lib/ctm/smsThread';
import { matchByPhone } from '../lib/comms-identity';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { numberBelongsTo, noNumberMatches } from './support/phone-match';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG_ID = ALPHA_ORG_ID;
// The webhook's resolver: the whole company's customers, leads and vendors (the helper takes it from its caller, NV-vp3-1).
const companyWide = (n: string) => matchByPhone(prisma, ORG_ID, n);
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSG_ID = '99990000-0000-0000-0000-000000000001';
const RAW_NUMBER = '(201) 555-0123';
const E164 = '+12015550123';
// #3019: our number, the other side of a conversation's pair.
const OUR_NUMBER = '+12015550100';

// The phone system's address in this file. Nothing outside it may be reached.
const PROVIDER = 'https://phone-provider.test/api/v1';

/** Every request that reached the phone system's network edge. */
const reached: Array<{ method: string; path: string; form: URLSearchParams }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, and every text is accepted. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  const method = init?.method ?? 'GET';
  reached.push({ method, path, form: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
  if (method === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (method === 'POST' && /\/sms$/.test(path)) return json({ id: 'MSG123' });
  return json({ error: 'not found' }, 404);
}

/** The texts the phone system was asked to send: the account, our number's id, the destination and the words. */
function textsSent() {
  return reached
    .filter((r) => r.method === 'POST' && /\/sms$/.test(r.path))
    .map((r) => ({ account: r.path.split('/')[2], from: r.form.get('from'), to: r.form.get('to'), msg: r.form.get('msg') }));
}

const ENV_KEYS = ['CTM_ACCESS_KEY', 'CTM_SECRET_KEY', 'CTM_API_BASE', 'CTM_OUTBOUND_ALLOWLIST'] as const;
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, (env as Record<string, unknown>)[k]]));
beforeAll(() => {
  vi.stubGlobal('fetch', fakeProvider);
});
afterAll(() => {
  vi.unstubAllGlobals();
  Object.assign(env as Record<string, unknown>, envBefore);
});

function mockMessageCreate() {
  p.message.create.mockImplementation((a: any) =>
    Promise.resolve({ id: MSG_ID, ts: new Date(), ...a.data }),
  );
}

/** Fully connected + SMS-ready + entitled org with one usable number (mirrors ctm-sms-send). */
function mockConnectedOrg() {
  // The phone system is configured, with keys made up for this run.
  Object.assign(env as Record<string, unknown>, { CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID() });
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '596375',
    ctm_sms_ready: true,
    sms_sending_enabled: true,
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: { phone: true },
  });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  p.message.update.mockResolvedValue({ id: MSG_ID });
  p.auditLog.create.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  // The phone system unconfigured, at this file's address, with no outbound allowlist; nothing reached yet.
  Object.assign(env as Record<string, unknown>, {
    CTM_ACCESS_KEY: '', CTM_SECRET_KEY: '', CTM_API_BASE: PROVIDER, CTM_OUTBOUND_ALLOWLIST: '',
  });
  reached.length = 0;
  // Identity resolver misses by default (unmatched number).
  p.customer.findFirst.mockResolvedValue(null);
  noNumberMatches(p);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  // #3019: the lookup for a conversation from before pairs also lists the customer's ones holding an unsent reply.
  p.messageThread.findMany.mockResolvedValue([]);
  p.timelineEvent.create.mockResolvedValue({});
});

// ─── findOrCreateSmsThreadByNumber — the shared keying helper ───────────────
// One source of truth for SMS thread identity: extracted from ingestSms, used
// by both the webhook ingest and the compose-to-number send path.

describe('findOrCreateSmsThreadByNumber — keying parity with ingest', () => {
  it('customer match: the pair\'s conversation, else the customer\'s from before pairs, else a new one for the pair (#3019)', async () => {
    numberBelongsTo(p, { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', company_name: null });
    // The number is the customer's own phone, the number a conversation from before pairs texts.
    p.customer.findFirst.mockResolvedValue({ phone: '2015550123' });
    p.messageThread.create.mockResolvedValue({ id: 'th-1', customer_id: 'cust-1' });

    const { thread, match } = await findOrCreateSmsThreadByNumber(prisma, ORG_ID, RAW_NUMBER, OUR_NUMBER, companyWide);

    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG_ID, other_party_e164: E164, our_number_e164: OUR_NUMBER }),
      }),
    );
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG_ID, channel: 'sms', other_party_e164: null, customer_id: 'cust-1' }),
      }),
    );
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data).toEqual({
      channel: 'sms',
      campaign_type: 'customer_care',
      customer_id: 'cust-1',
      lead_id: null,
      vendor_id: null,
      title: null,
      other_party_e164: E164,
      our_number_e164: OUR_NUMBER,
      organization_id: ORG_ID,
    });
    expect(thread.id).toBe('th-1');
    expect(match?.kind).toBe('customer');
  });

  it('vendor match keys by vendor_id (customer_id null, title null)', async () => {
    p.vendor.findFirst.mockResolvedValue({ id: 'vendor-1', name: 'Acme Supply' });
    p.messageThread.create.mockResolvedValue({ id: 'th-v', vendor_id: 'vendor-1' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, RAW_NUMBER, OUR_NUMBER, companyWide);

    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG_ID, channel: 'sms', vendor_id: 'vendor-1' },
      }),
    );
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.vendor_id).toBe('vendor-1');
    expect(created.data.customer_id).toBeNull();
    expect(created.data.title).toBeNull();
  });

  it('unmatched number: a conversation from before pairs is found by title = the E.164 normalization (bare spelling included)', async () => {
    p.messageThread.create.mockResolvedValue({ id: 'th-t', title: E164 });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, '2015550123', OUR_NUMBER, companyWide);

    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ORG_ID,
          channel: 'sms',
          other_party_e164: null,
          customer_id: null,
          vendor_id: null,
          title: E164,
        }),
      }),
    );
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.title).toBe(E164);
    expect(created.data.channel).toBe('sms');
    expect(created.data.campaign_type).toBe('customer_care');
  });

  it('reuses an existing thread — no create when the find hits', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-existing', title: E164 });

    const { thread } = await findOrCreateSmsThreadByNumber(prisma, ORG_ID, RAW_NUMBER, OUR_NUMBER, companyWide);

    expect(thread.id).toBe('th-existing');
    expect(p.messageThread.create).not.toHaveBeenCalled();
  });
});

// ─── POST /api/communication/sms — toNumber path ────────────────────────────

describe('POST /api/communication/sms — compose to an arbitrary number', () => {
  it('a number matching an existing customer reuses the pair\'s conversation (ingest parity, no duplicate)', async () => {
    mockAuthAs('dispatcher');
    mockMessageCreate();
    numberBelongsTo(p, { id: CUSTOMER_FIXTURE.id, first_name: 'Pat', last_name: 'Lee', company_name: null });
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null, other_party_e164: E164, our_number_e164: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: RAW_NUMBER, body: 'hello there' });

    expect(res.status).toBe(201);
    expect(res.body.threadId).toBe(THREAD_ID);
    // #3019: the find is keyed by the pair of numbers - the same key ingestSms uses.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG_ID, channel: 'sms', other_party_e164: E164 }),
      }),
    );
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ thread_id: THREAD_ID, direction: 'out', body: 'hello there' }),
      }),
    );
  });

  it('an unmatched number creates ONE conversation for its pair, filed on nobody; a second send reuses it', async () => {
    mockAuthAs('dispatcher');
    mockMessageCreate();
    p.messageThread.create.mockResolvedValue({
      id: 'th-new', customer_id: null, vendor_id: null, kind: null, title: E164,
    });

    const first = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: RAW_NUMBER, body: 'first text' });

    expect(first.status).toBe(201);
    expect(first.body.threadId).toBe('th-new');
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.title).toBe(E164);
    expect(created.data.customer_id).toBeNull();
    expect(created.data.other_party_e164).toBe(E164);

    // Second send: the pair find now hits → NO second thread.
    p.messageThread.findFirst.mockResolvedValue({
      id: 'th-new', customer_id: null, vendor_id: null, kind: null, title: E164, other_party_e164: E164, our_number_e164: null,
    });
    const second = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: '2015550123', body: 'second text' });

    expect(second.status).toBe(201);
    expect(second.body.threadId).toBe('th-new');
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    // #3023 (Ran, 2026-11-06, after spec r3): the pair's conversation is joined whoever can read it - never a second
    // conversation for a pair - so the pair find is not narrowed by reach, nor by "filed on nobody" as a stand-in for it.
    // Reach only decides whether the sender may continue the conversation they join, for the Access Communication gate (the
    // dispatcher here is on Attached, so that check carries their continue rule).
    const lastFind = p.messageThread.findFirst.mock.lastCall![0];
    expect(lastFind.where).toEqual(expect.objectContaining({ other_party_e164: E164 }));
    expect(lastFind.where).not.toHaveProperty('AND');
    expect(lastFind.where).not.toHaveProperty('customer_id');
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'th-new', AND: [expect.objectContaining({ OR: expect.any(Array) })] } }),
    );
  });

  it('an invalid number 400s with a human message — nothing created', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: '(20) 155-012', body: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enter a valid North American phone number');
    expect(p.messageThread.findFirst).not.toHaveBeenCalled();
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('rejects a request with none of threadId / customerId / toNumber at validation', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ body: 'hello' });

    expect(res.status).toBe(400);
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('allowlist gate 409s NOT_IN_TEST_ALLOWLIST on the toNumber path BEFORE any Message row', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockMessageCreate();
    // The test allowlist holds another number only.
    Object.assign(env as Record<string, unknown>, { CTM_OUTBOUND_ALLOWLIST: '+12015550188' });
    p.messageThread.create.mockResolvedValue({
      id: 'th-new', customer_id: null, vendor_id: null, kind: null, title: E164,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: RAW_NUMBER, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expect(res.body.error).toBeTruthy();
    // Nothing reached the phone system, and NO message/timeline row exists.
    expect(reached).toEqual([]);
    expect(p.message.create).not.toHaveBeenCalled();
    expect(p.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('delivers through CTM on a clean toNumber send (gates pass, sid stamped)', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockMessageCreate();
    p.messageThread.create.mockResolvedValue({
      id: 'th-new', customer_id: null, vendor_id: null, kind: null, title: E164,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: RAW_NUMBER, body: 'clean send' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('sent');
    expect(res.body.threadId).toBe('th-new');
    expect(textsSent()).toEqual([{ account: '596375', from: 'TPN-A', to: E164, msg: 'clean send' }]);
  });
});

// ─── Regression: threadId / customerId paths byte-identical ─────────────────
// The phone identity resolver (a customer, open lead or vendor matched by number) never runs on these paths: a
// customer is read by id only, and after a customer miss the resolver would go on to read leads and vendors, which
// nothing on these paths does.

/** The conversation's own customer, as a read by id finds it: the phone the text goes to. */
const CONVERSATION_CUSTOMER = { id: CUSTOMER_FIXTURE.id, first_name: 'Pat', last_name: 'Lee', company_name: null, phone: '2015550199' };
const CONVERSATION_PHONE = '+12015550199';

function expectNoNumberLookup() {
  for (const [args] of p.customer.findFirst.mock.calls) {
    expect(args.where, 'a customer is only ever read by id').toEqual({ id: CUSTOMER_FIXTURE.id, organization_id: ORG_ID });
  }
  expect(p.lead.findFirst).not.toHaveBeenCalled();
  expect(p.vendor.findFirst).not.toHaveBeenCalled();
  expect(p.vendorContact.findFirst).not.toHaveBeenCalled();
}

describe('POST /api/communication/sms — existing paths untouched when toNumber is absent', () => {
  it('threadId path: the text joins that conversation; no number lookup, no new conversation; the answer names that conversation', async () => {
    mockAuthAs('dispatcher');
    mockMessageCreate();
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
      organization_id: ORG_ID,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'reply' });

    expect(res.status).toBe(201);
    // #3023: every send names the conversation the text was filed in (a reply from a number no longer in use is filed
    // in the main-line conversation, which the screen then opens).
    expect(res.body.threadId).toBe(THREAD_ID);
    expect(p.message.create).toHaveBeenCalledTimes(1);
    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ thread_id: THREAD_ID, body: 'reply' }) }),
    );
    expect(p.messageThread.create).not.toHaveBeenCalled();
    // The phone system is not configured: nothing reaches it.
    expect(reached).toEqual([]);
    expectNoNumberLookup();
  });

  it("customerId path: texts the customer's own phone, read by id; the answer names the conversation it was filed in", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockMessageCreate();
    p.customer.findFirst.mockResolvedValue(CONVERSATION_CUSTOMER);
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
      other_party_e164: CONVERSATION_PHONE, our_number_e164: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.threadId).toBe(THREAD_ID);
    expect(res.body.delivery).toBe('sent');
    expect(textsSent()).toEqual([{ account: '596375', from: 'TPN-A', to: CONVERSATION_PHONE, msg: 'hello' }]);
    // #3019: the customer's conversation is the pair of their number and ours.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG_ID, channel: 'sms', other_party_e164: CONVERSATION_PHONE }),
      }),
    );
    expectNoNumberLookup();
  });

  it("threadId wins over toNumber when both are sent (precedence): the conversation's number is texted, never the browser's", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockMessageCreate();
    p.customer.findFirst.mockResolvedValue(CONVERSATION_CUSTOMER);
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
      organization_id: ORG_ID,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, toNumber: RAW_NUMBER, body: 'reply' });

    expect(res.status).toBe(201);
    expect(textsSent()).toEqual([{ account: '596375', from: 'TPN-A', to: CONVERSATION_PHONE, msg: 'reply' }]);
    // The text is written into the conversation, holding the number it was sent to (#3014).
    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ thread_id: THREAD_ID, other_party_e164: CONVERSATION_PHONE }) }),
    );
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expectNoNumberLookup();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
