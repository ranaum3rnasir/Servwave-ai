// s1d (live QA 2026-07-21): sendMessage commits the MessageThread row BEFORE
// the CTM allowlist precheck, with no rollback — a 409 leaves the message
// unwritten but the brand-new, empty thread persists and surfaces on the
// next poll as a phantom conversation. A thread the send merely APPENDED to
// (already existed) must never be touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { ingestSms } from '../lib/ctm/ingest';
import { findOrCreateSmsThreadByNumber } from '../lib/ctm/smsThread';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

// The inbound-keying block below drives the real webhook door; the bell is not
// what is under test and emitting it would reach the notification service.
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = ALPHA_ORG_ID;
const NEW_THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000aa';
const EXISTING_THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000bb';

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
  p.message.update.mockResolvedValue({ id: 'msg-1' });
  p.auditLog.create.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  client.isCtmConfigured.mockReturnValue(false);
  client.isOptedOut.mockResolvedValue(false);
  client.isOutboundAllowed.mockReturnValue(true);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  p.timelineEvent.create.mockResolvedValue({});
  // No staff owns any number by default - the org roster is empty.
  p.user.findMany.mockResolvedValue([]);
});

describe('POST /api/communication/sms — 409 must not leave a phantom thread (s1d)', () => {
  it('customerId path: a brand-new thread is deleted when the allowlist gate 409s', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '+16095551234' });
    p.messageThread.findFirst.mockResolvedValue(null); // no existing thread
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    expect(p.messageThread.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: NEW_THREAD_ID,
          organization_id: ORG_ID,
          messages: { none: {} },
        }),
      }),
    );
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('guards the delete against a message that arrived concurrently before the 409 fired', async () => {
    // Message.thread is onDelete: Cascade, and findOrCreateSmsThreadByNumber
    // (the same keying this path uses) is ALSO the function the CTM webhook
    // ingest calls for inbound SMS — so a real inbound message can land in
    // this exact thread during the several DB round-trips (and, for some
    // gate reasons, a real CTM HTTP call) precheckCtmSms makes before this
    // 409 fires. The delete must be guarded so that message is never
    // cascaded away. `count: 0` below is what the real DB would return: the
    // `messages: { none: {} }` clause excludes a thread that is no longer
    // empty.
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '+16095551234' });
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });
    p.messageThread.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(p.messageThread.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: NEW_THREAD_ID,
          organization_id: ORG_ID,
          messages: { none: {} },
        }),
      }),
    );
  });

  it('customerId path: a PRE-EXISTING thread is never deleted on the same 409', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '+16095551234' });
    p.messageThread.findFirst.mockResolvedValue({
      id: EXISTING_THREAD_ID, customer_id: CUSTOMER_FIXTURE.id, vendor_id: null, kind: null, title: null,
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.messageThread.deleteMany).not.toHaveBeenCalled();
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('toNumber path: a brand-new title-keyed thread is deleted when the allowlist gate 409s', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: null, vendor_id: null, kind: null, title: '+12015550123',
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: '(201) 555-0123', body: 'blocked text' });

    expect(res.status).toBe(409);
    expect(p.messageThread.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: NEW_THREAD_ID,
          organization_id: ORG_ID,
          messages: { none: {} },
        }),
      }),
    );
    expect(p.message.create).not.toHaveBeenCalled();
  });
});


// ─── Spec C slice 7 - inbound identity keying for STAFF ─────────────────────
//
// The other half of the phantom-thread problem, and a NEW one this feature
// creates. `findOrCreateSmsThreadByNumber` resolved customer -> lead -> vendor
// -> unmatched, and the unmatched branch creates a thread with
// campaign_type 'customer_care' and NO kind, which the inbox reads as
// `customer`. So the moment automations start texting technicians, the first
// technician who replies surfaces in the CUSTOMER conversations lane as a
// conversation with an unknown contact.
//
// The fix is identity only: on an inbound text that matched no customer, lead
// or vendor, look the number up against ACTIVE staff and reuse (or create) that
// person's team thread, using the same key the automation recorder uses
// (user_id + channel + organization, see services/automations/smsRecord.ts).
// Ownership, routing and unread semantics stay deliberately undesigned.

const STAFF_USER_ID = '00000000-0000-0000-0000-0000000000c1';
const STAFF_NUMBER = '+12015550199';
const STAFF_THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000cc';

/** An active staff member who owns STAFF_NUMBER, stored however `users.phone`
 *  happens to spell it (the column is free text on live rows). */
function staffRoster(phone: string = STAFF_NUMBER) {
  p.user.findMany.mockResolvedValue([
    { id: STAFF_USER_ID, first_name: 'Mike', last_name: 'Reyes', phone },
  ]);
}

/** The inbound SMS webhook activity CTM posts for a text FROM `from`. */
function inboundSms(from: string, over: Record<string, any> = {}) {
  return {
    message_id: `MSG-${from}`,
    account_id: 500001,
    caller_number: from,
    tracking_number: '+12019037784',
    direction: 'msg_inbound',
    message_body: 'on my way',
    unix_time: 1_752_000_100,
    ...over,
  };
}

describe('inbound SMS from a member of staff keys onto their team thread', () => {
  beforeEach(() => {
    p.message.findFirst.mockResolvedValue(null);
    p.message.findMany.mockResolvedValue([]);
    p.message.create.mockResolvedValue({ id: 'msg-1', thread_id: STAFF_THREAD_ID });
    p.messageThread.update.mockResolvedValue({ id: STAFF_THREAD_ID });
  });

  it('reuses the EXISTING team thread the automation recorder created', async () => {
    staffRoster();
    p.messageThread.findFirst.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.user_id === STAFF_USER_ID
          ? { id: STAFF_THREAD_ID, customer_id: null, vendor_id: null, lead_id: null, title: 'Mike Reyes', kind: 'team' }
          : null,
      ),
    );

    const res = await ingestSms(prisma, ORG_ID, inboundSms(STAFF_NUMBER));

    expect(res?.threadId).toBe(STAFF_THREAD_ID);
    // Keyed the SAME way smsRecord.ts keys it - user + channel + org.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG_ID, channel: 'sms', user_id: STAFF_USER_ID },
      }),
    );
    // ...and no customer-lane thread was invented for the same person.
    expect(p.messageThread.create).not.toHaveBeenCalled();
  });

  it('creates the team thread when the person has never been texted, with the recorder shape', async () => {
    staffRoster();
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({
      id: STAFF_THREAD_ID, customer_id: null, vendor_id: null, lead_id: null, title: 'Mike Reyes', kind: 'team',
    });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.messageThread.create.mock.calls[0][0].data).toEqual({
      channel: 'sms',
      kind: 'team',
      campaign_type: 'tech_ops',
      title: 'Mike Reyes',
      user_id: STAFF_USER_ID,
      organization_id: ORG_ID,
    });
  });

  // A team thread's `title` is the ONLY display name it has - there is no
  // customer row to fall back to - and the inbox tests it for TRUTHINESS
  // (SmsInboxView threadTitle). So an empty title is not a blank label: it
  // falls through to the customer lookup, misses on a user_id thread, and
  // renders "Unknown" in the lane whose whole purpose is naming the person.
  it('titles the thread with the email when the person has no name on file', async () => {
    p.user.findMany.mockResolvedValue([
      {
        id: STAFF_USER_ID, first_name: '', last_name: '',
        email: 'mike@northwind.example.com', phone: STAFF_NUMBER,
      },
    ]);
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: STAFF_THREAD_ID, kind: 'team' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.messageThread.create.mock.calls[0][0].data.title).toBe('mike@northwind.example.com');
  });

  // Whitespace is the same defect wearing a disguise: ' ' survives
  // filter(Boolean) and is truthy in JS, so the inbox would print a row with a
  // blank name rather than fall back at all.
  it('treats a whitespace-only name as no name', async () => {
    p.user.findMany.mockResolvedValue([
      {
        id: STAFF_USER_ID, first_name: '  ', last_name: null,
        email: 'mike@northwind.example.com', phone: STAFF_NUMBER,
      },
    ]);
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: STAFF_THREAD_ID, kind: 'team' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.messageThread.create.mock.calls[0][0].data.title).toBe('mike@northwind.example.com');
  });

  it('still prefers a HALF name over the email', async () => {
    p.user.findMany.mockResolvedValue([
      {
        id: STAFF_USER_ID, first_name: null, last_name: 'Reyes',
        email: 'mike@northwind.example.com', phone: STAFF_NUMBER,
      },
    ]);
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: STAFF_THREAD_ID, kind: 'team' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.messageThread.create.mock.calls[0][0].data.title).toBe('Reyes');
  });

  // The roster fixture hands back an email whatever the `select` asks for, so a
  // mocked Prisma can NEVER catch a select that forgot it - against the real
  // client the fallback would be `undefined`. Pin the select itself.
  it('reads the email in the same roster query, so the fallback has one to use', async () => {
    staffRoster();
    p.messageThread.findFirst.mockResolvedValue({ id: STAFF_THREAD_ID, kind: 'team' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ email: true }) }),
    );
  });

  it('matches a stored number however it is spelled - both sides are normalized', async () => {
    staffRoster('(201) 555-0199');
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: STAFF_THREAD_ID, title: 'Mike Reyes', kind: 'team' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.messageThread.create.mock.calls[0][0].data.user_id).toBe(STAFF_USER_ID);
  });

  it('asks only for ACTIVE staff who have a number at all', async () => {
    staffRoster();
    p.messageThread.findFirst.mockResolvedValue({ id: STAFF_THREAD_ID, kind: 'team' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG_ID, is_active: true, phone: { not: null } },
      }),
    );
  });

  it('leaves a number owned by NOBODY on the title-keyed thread it makes today', async () => {
    p.user.findMany.mockResolvedValue([]);
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: 'th-unknown', title: '+12015550123' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, '+12015550123', { matchStaff: true });

    expect(p.messageThread.create.mock.calls[0][0].data).toEqual({
      channel: 'sms',
      campaign_type: 'customer_care',
      customer_id: null,
      lead_id: null,
      vendor_id: null,
      title: '+12015550123',
      organization_id: ORG_ID,
    });
  });
});

describe('inbound SMS keying for everyone else is byte-identical', () => {
  it('a CUSTOMER number never reaches the staff lookup at all', async () => {
    staffRoster();
    p.customer.findFirst.mockResolvedValue({
      id: CUSTOMER_FIXTURE.id, first_name: 'Pat', last_name: 'Lee', company_name: null,
    });
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: 'th-c', customer_id: CUSTOMER_FIXTURE.id });

    const { thread, match } = await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, {
      matchStaff: true,
    });

    expect(match?.kind).toBe('customer');
    expect(thread.id).toBe('th-c');
    // A customer wins outright - the roster is never even read.
    expect(p.user.findMany).not.toHaveBeenCalled();
    expect(p.messageThread.create.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('a VENDOR number never reaches the staff lookup either', async () => {
    staffRoster();
    p.vendor.findFirst.mockResolvedValue({ id: 'vendor-1', name: 'Acme Supply' });
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: 'th-v', vendor_id: 'vendor-1' });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER, { matchStaff: true });

    expect(p.user.findMany).not.toHaveBeenCalled();
    expect(p.messageThread.create.mock.calls[0][0].data.vendor_id).toBe('vendor-1');
  });

  it('the staff branch is OFF unless the caller asks for it', async () => {
    staffRoster();
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: 'th-t', title: STAFF_NUMBER });

    await findOrCreateSmsThreadByNumber(prisma, ORG_ID, STAFF_NUMBER);

    expect(p.user.findMany).not.toHaveBeenCalled();
    expect(p.messageThread.create.mock.calls[0][0].data.title).toBe(STAFF_NUMBER);
  });
});

describe('composing TO a staff number is not the same act as receiving from one', () => {
  it('keeps the title-keyed, deliverable thread so an admin can still text a technician', async () => {
    // A staff thread has no destination the send path can resolve
    // (resolveSmsDestination has no user branch, on purpose), so keying the
    // composer onto one would turn a working send into a dead end.
    mockAuthAs('dispatcher');
    staffRoster();
    mockConnectedOrg();
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({
      id: NEW_THREAD_ID, customer_id: null, vendor_id: null, kind: null, title: STAFF_NUMBER,
    });
    p.message.create.mockImplementation((a: any) =>
      Promise.resolve({ id: 'msg-out', ts: new Date(), ...a.data }),
    );

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ toNumber: STAFF_NUMBER, body: 'can you swing by?' });

    expect(res.status).toBe(201);
    expect(p.user.findMany).not.toHaveBeenCalled();
    expect(p.messageThread.create.mock.calls[0][0].data.title).toBe(STAFF_NUMBER);
    expect(p.messageThread.create.mock.calls[0][0].data.user_id).toBeUndefined();
  });
});
