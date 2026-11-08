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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { findOrCreateSmsThreadByNumber } from '../lib/ctm/smsThread';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = ALPHA_ORG_ID;
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSG_ID = '99990000-0000-0000-0000-000000000001';
const RAW_NUMBER = '(201) 555-0123';
const E164 = '+12015550123';

function mockMessageCreate() {
  p.message.create.mockImplementation((a: any) =>
    Promise.resolve({ id: MSG_ID, ts: new Date(), ...a.data }),
  );
}

/** Fully connected + SMS-ready + entitled org with one usable number (mirrors ctm-sms-send). */
function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '500001',
    ctm_sms_ready: true,
    sms_sending_enabled: true,
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: { phone: true },
  });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.isOptedOut.mockResolvedValue(false);
  client.sendSms.mockResolvedValue({ id: 'MSG123' });
  p.message.update.mockResolvedValue({ id: MSG_ID });
  p.auditLog.create.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts defaults: platform unconfigured, not opted out, allowlist inert.
  client.isCtmConfigured.mockReturnValue(false);
  client.isOptedOut.mockResolvedValue(false);
  client.isOutboundAllowed.mockReturnValue(true);
  // Identity resolver misses by default (unmatched number).
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  p.timelineEvent.create.mockResolvedValue({});
});

// ─── findOrCreateSmsThreadByNumber — the shared keying helper ───────────────
// One source of truth for SMS thread identity: extracted from ingestSms, used
// by both the webhook ingest and the compose-to-number send path.

describe('findOrCreateSmsThreadByNumber — keying parity with ingest', () => {
  it('customer match keys the find AND the create by customer_id (title null)', async () => {
    p.customer.findFirst.mockResolvedValue({
      id: 'cust-1', first_name: 'Pat', last_name: 'Lee', company_name: null,
    });
    p.messageThread.create.mockResolvedValue({ id: 'th-1', customer_id: 'cust-1' });

    const { thread, match } = await findOrCreateSmsThreadByNumber(prisma, ORG_ID, RAW_NUMBER);

    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG_ID, channel: 'sms', customer_id: 'cust-1' },
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
      organization_id: ORG_ID,
    });
    expect(thread.id).toBe('th-1');
    expect(match?.kind).toBe('customer');
  });

  it('vendor match keys by vendor_id (customer_id null, title null)', async () => {
    p.vendor.findFirst.mockResolvedValue({ id: 'vendor-1', name: 'Acme Supply' });
    p.messageThread.create.mockResolvedValue({ id: 'th-v', vendor_id: 'vendor-1' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, RAW_NUMBER);

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

  it('unmatched number keys by title = the E.164 normalization (bare spelling included)', async () => {
    p.messageThread.create.mockResolvedValue({ id: 'th-t', title: E164 });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, '2015550123');

    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organization_id: ORG_ID,
          channel: 'sms',
          customer_id: null,
          vendor_id: null,
          title: E164,
        },
      }),
    );
    const created = p.messageThread.create.mock.calls[0][0];
    expect(created.data.title).toBe(E164);
    expect(created.data.channel).toBe('sms');
    expect(created.data.campaign_type).toBe('customer_care');
  });

  it('reuses an existing thread — no create when the find hits', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-existing', title: E164 });

    const { thread } = await findOrCreateSmsThreadByNumber(prisma, ORG_ID, RAW_NUMBER);

    expect(thread.id).toBe('th-existing');
    expect(p.messageThread.create).not.toHaveBeenCalled();
  });
});

// ─── POST /api/communication/sms — toNumber path ────────────────────────────

describe('POST /api/communication/sms — compose to an arbitrary number', () => {
  it('a number matching an existing customer reuses the CUSTOMER-keyed thread (ingest parity, no duplicate)', async () => {
    mockAuthAs('dispatcher');
    mockMessageCreate();
    p.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, first_name: 'Pat', last_name: 'Lee', company_name: null,
    });
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: RAW_NUMBER, body: 'hello there' });

    expect(res.status).toBe(201);
    expect(res.body.threadId).toBe(THREAD_ID);
    // The find is keyed by customer_id — same key ingestSms uses.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG_ID, channel: 'sms', customer_id: CUSTOMER_FIXTURE.id },
      }),
    );
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ thread_id: THREAD_ID, direction: 'out', body: 'hello there' }),
      }),
    );
  });

  it('an unmatched number creates ONE title-keyed thread; a second send reuses it', async () => {
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

    // Second send: the title-keyed find now hits → NO second thread.
    p.messageThread.findFirst.mockResolvedValue({
      id: 'th-new', customer_id: null, vendor_id: null, kind: null, title: E164,
    });
    const second = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: '2015550123', body: 'second text' });

    expect(second.status).toBe(201);
    expect(second.body.threadId).toBe('th-new');
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    expect(p.messageThread.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: E164 }),
      }),
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
    client.isOutboundAllowed.mockReturnValue(false);
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
    // The guard was consulted with the E.164 destination resolved off the
    // title-keyed thread, and NO message/timeline row exists.
    expect(client.isOutboundAllowed).toHaveBeenCalledWith(E164);
    expect(client.sendSms).not.toHaveBeenCalled();
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
    expect(client.sendSms).toHaveBeenCalledWith('500001', {
      from: 'TPN-A',
      to: E164,
      msg: 'clean send',
    });
  });
});

// ─── Regression: threadId / customerId paths byte-identical ─────────────────

describe('POST /api/communication/sms — existing paths untouched when toNumber is absent', () => {
  it('threadId path: no identity-resolver lookups, no thread create, no threadId in the response', async () => {
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
    expect('threadId' in res.body).toBe(false);
    // Unconfigured CTM: the thread lookup is the ONLY read — the phone
    // identity resolver (customer OR-phone match) must never run.
    expect(p.customer.findFirst).not.toHaveBeenCalled();
    expect(p.vendor.findFirst).not.toHaveBeenCalled();
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.message.create).toHaveBeenCalledTimes(1);
  });

  it('customerId path: one by-id customer lookup only, response shape unchanged', async () => {
    mockAuthAs('dispatcher');
    mockMessageCreate();
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'hello' });

    expect(res.status).toBe(201);
    expect('threadId' in res.body).toBe(false);
    expect(p.customer.findFirst).toHaveBeenCalledTimes(1);
    expect(p.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CUSTOMER_FIXTURE.id, organization_id: ORG_ID },
      }),
    );
    // The customer-thread find keeps its original key shape (customer_id +
    // channel + tenant) — not the helper's.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customer_id: CUSTOMER_FIXTURE.id, channel: 'sms', organization_id: ORG_ID },
      }),
    );
  });

  it('threadId wins over toNumber when both are sent (precedence)', async () => {
    mockAuthAs('dispatcher');
    mockMessageCreate();
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
      organization_id: ORG_ID,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, toNumber: RAW_NUMBER, body: 'reply' });

    expect(res.status).toBe(201);
    // The identity resolver never ran — the explicit thread won.
    expect(p.customer.findFirst).not.toHaveBeenCalled();
    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ thread_id: THREAD_ID }) }),
    );
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
