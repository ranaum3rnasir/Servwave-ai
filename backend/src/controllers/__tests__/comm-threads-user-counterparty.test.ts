/**
 * Spec C slice 5 - the threads API can address a user.
 *
 * `mapThread` projects the three existing counterparties with a conditional spread
 * (`...(t.lead_id != null && { leadId: t.lead_id })`), so a key is absent rather than
 * null when the counterparty does not apply. The user follows the same rule, which is
 * what makes the customer / lead / vendor payloads BYTE-IDENTICAL to what they are
 * today: a thread with no user_id gains no key at all.
 *
 * That regression half matters more than the new half. Nothing writes a user-keyed
 * thread until the send path lands, so the only way this slice can do damage right now
 * is by changing what an existing customer thread serializes - which is why the
 * customer / lead / vendor cases below assert on the WHOLE payload object rather than
 * on the presence of a userId key.
 */
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import app from '../../app';
import { prisma } from '../../lib/prisma';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const THREAD_ID = 'aa000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000004';
const CUSTOMER_ID = 'cc000000-0000-0000-0000-000000000001';
const LEAD_ID = 'dd000000-0000-0000-0000-000000000001';
const VENDOR_ID = 'ee000000-0000-0000-0000-000000000001';

/** A thread row as Prisma returns it, with every counterparty null by default. */
function threadRow(over: Record<string, any> = {}) {
  return {
    id: THREAD_ID,
    customer_id: null,
    lead_id: null,
    vendor_id: null,
    user_id: null,
    channel: 'sms',
    campaign_type: 'customer_care',
    unread: 0,
    kind: null,
    archived: false,
    title: null,
    subtitle: null,
    messages: [],
    customer: null,
    lead: null,
    vendor: null,
    user: null,
    organization_id: ALPHA_ORG_ID,
    ...over,
  };
}

/** What every counterparty-less thread serializes to - the shared baseline. */
const BASE_PAYLOAD = {
  id: THREAD_ID,
  customerId: '',
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [],
  archived: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

async function listWith(row: Record<string, any>) {
  p.messageThread.findMany.mockResolvedValue([row]);
  mockAuthAs('admin');
  const res = await request(app).get('/api/communication/threads').set(authHeader('admin'));
  expect(res.status).toBe(200);
  return res.body.threads[0];
}

describe('GET /api/communication/threads - the user counterparty', () => {
  it('returns a real user id on a user-keyed thread', async () => {
    const thread = await listWith(
      threadRow({
        user_id: USER_ID,
        kind: 'team',
        campaign_type: 'tech_ops',
        user: { id: USER_ID, first_name: 'Test', last_name: 'Tech' },
      }),
    );

    // A REAL id, not the empty-string customerId sentinel the frontend used to have
    // to interpret. This is the whole point of the slice.
    expect(thread.userId).toBe(USER_ID);
  });

  it('carries the staff display name so no second call is needed', async () => {
    const thread = await listWith(
      threadRow({
        user_id: USER_ID,
        user: { id: USER_ID, first_name: 'Test', last_name: 'Tech' },
      }),
    );
    expect(thread.linkedUser).toEqual({ id: USER_ID, name: 'Test Tech' });
  });

  it('asks the database for the user alongside the other three counterparties', async () => {
    await listWith(threadRow({ user_id: USER_ID, user: { id: USER_ID, first_name: 'Test', last_name: 'Tech' } }));
    const include = p.messageThread.findMany.mock.calls[0][0].include;
    // id + name fields only. Selecting the whole user row would put a password hash
    // and an email on a payload that only needs a label.
    expect(include.user).toEqual({ select: { id: true, first_name: true, last_name: true } });
  });

  it('omits the user keys entirely when the thread has no user', async () => {
    const thread = await listWith(threadRow({ customer_id: CUSTOMER_ID }));
    expect(thread).not.toHaveProperty('userId');
    expect(thread).not.toHaveProperty('linkedUser');
  });
});

describe('GET /api/communication/threads - existing counterparties are untouched', () => {
  it('serializes a customer thread exactly as before', async () => {
    const thread = await listWith(
      threadRow({
        customer_id: CUSTOMER_ID,
        customer: { id: CUSTOMER_ID, first_name: 'Ada', last_name: 'Lovelace', company_name: null },
      }),
    );
    expect(thread).toEqual({
      ...BASE_PAYLOAD,
      customerId: CUSTOMER_ID,
      linkedCustomer: { id: CUSTOMER_ID, name: 'Ada Lovelace' },
    });
  });

  it('serializes a lead thread exactly as before, sentinel customerId included', async () => {
    const thread = await listWith(
      threadRow({ lead_id: LEAD_ID, lead: { id: LEAD_ID, lead_number: 'L00042' } }),
    );
    expect(thread).toEqual({
      ...BASE_PAYLOAD,
      leadId: LEAD_ID,
      linkedLead: { id: LEAD_ID, leadNumber: 'L00042' },
    });
  });

  it('serializes a vendor thread exactly as before', async () => {
    const thread = await listWith(
      threadRow({ vendor_id: VENDOR_ID, vendor: { id: VENDOR_ID, name: 'Acme Doors' } }),
    );
    expect(thread).toEqual({
      ...BASE_PAYLOAD,
      vendorId: VENDOR_ID,
      linkedVendor: { id: VENDOR_ID, name: 'Acme Doors' },
    });
  });
});

describe('GET /api/communication/threads/:id - the single-thread read', () => {
  it('returns the user id and display name on a user-keyed thread', async () => {
    p.messageThread.findFirst.mockResolvedValue(
      threadRow({ user_id: USER_ID, user: { id: USER_ID, first_name: 'Test', last_name: 'Tech' } }),
    );
    mockAuthAs('admin');
    const res = await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.thread.userId).toBe(USER_ID);
    expect(res.body.thread.linkedUser).toEqual({ id: USER_ID, name: 'Test Tech' });
    // The include has to be on BOTH queries or opening a staff thread loses the name
    // the list already had.
    const include = p.messageThread.findFirst.mock.calls[0][0].include;
    expect(include.user).toEqual({ select: { id: true, first_name: true, last_name: true } });
  });

  it('leaves a customer thread byte-identical', async () => {
    p.messageThread.findFirst.mockResolvedValue(
      threadRow({
        customer_id: CUSTOMER_ID,
        customer: { id: CUSTOMER_ID, first_name: null, last_name: null, company_name: 'Acme Ltd' },
      }),
    );
    mockAuthAs('admin');
    const res = await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.thread).toEqual({
      ...BASE_PAYLOAD,
      customerId: CUSTOMER_ID,
      linkedCustomer: { id: CUSTOMER_ID, name: 'Acme Ltd' },
    });
  });
});
