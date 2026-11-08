/**
 * lead-contact-clock.test.ts — spec #1751 D5: what marks a lead CONTACTED, and what must not.
 *
 * The rule under test: an outbound CALL, an outbound TEXT or a HUMAN-WRITTEN EMAIL stamps
 * `leads.contacted_at` at the moment it happened. Automatic notifications the platform sends on
 * the company's behalf never do. Inbound traffic from the customer never does. First qualifying
 * event wins.
 *
 * WHY THE NEGATIVES COME FIRST IN THIS FILE
 *
 * Provenance is the one property here that cannot be spot-checked by looking at a screen. A
 * broken filter does not fail: it marks every lead in the org contacted the instant its
 * appointment confirmation goes out, and the response-time report then shows a company answering
 * every enquiry in under a second. Nothing anywhere goes red. So the automated and inbound cases
 * are asserted OUTRIGHT — the positive case passing tells you nothing about whether the filter
 * exists at all.
 *
 * SEAM: the house one. The real Express app over supertest against the mocked Prisma client, so
 * every assertion is about what a REQUEST causes to be written, never about which helper produced
 * it. The stamping helper itself is deliberately not tested directly (spec: "no seam is
 * introduced at the level of the individual clock-stamping helper").
 *
 * The transactional-mirror half of the email channel lives in its own file
 * (lead-contact-clock-transactional.test.ts): reaching a real transactional sender needs
 * module-scope `env` / `resend` overrides that would break every door in this one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ingestCall, ingestSms } from '../lib/ctm/ingest';
import * as ctmClient from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader, matchesScopeWhere, CUSTOMER_FIXTURE, LEAD_FIXTURE } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const LEAD_ID = 'e0000000-0000-0000-0000-0000000000c1';
const LEAD_ROW = { id: LEAD_ID, lead_number: 'L00201', customer_id: CUSTOMER_FIXTURE.id };
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000c1';
const MSG_ID = '99990000-0000-0000-0000-0000000000c1';
const CALL_ID = '77770000-0000-0000-0000-0000000000c1';
const EMAIL_ID = 'ee000000-0000-0000-0000-0000000000c1';

/** Every `lead.updateMany` the request made. The clock write is the only one on these doors. */
function clockWrites() {
  return (p.lead.updateMany.mock.calls as any[][]).map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // The outbound-SMS double-fire guard is process-scoped, and several tests below send the same
  // body on the same thread within its 15s window; without this the second one 409s.
  _resetCtmSmsDoubleFireGuard();
  // setup.ts's defaults, restated: the platform is UNCONFIGURED unless a test says otherwise, so
  // an outbound text settles `skipped` and never leaves.
  client.isCtmConfigured.mockReturnValue(false);
  client.isOptedOut.mockResolvedValue(false);
  // `vi.clearAllMocks()` clears CALLS but keeps implementations, so mockDeliveringOrg's org and
  // from-number would otherwise leak forward into the ingest doors further down this file, which
  // read the same two mocks for entirely different rows. Reset returns them to "never configured".
  p.phoneNumber.findFirst.mockReset();
  p.organization.findUnique.mockReset();
  // The stamp is a conditional write; unless a test says otherwise it lands.
  p.lead.updateMany.mockResolvedValue({ count: 1 });
  // matchByPhone's four lookups — no phone match, so nothing is attributed by accident.
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  // The inbound-SMS job auto-router's recency read.
  p.message.findMany.mockResolvedValue([]);
});

// ─── Text ───────────────────────────────────────────────────────────────────────────────────

function mockCustomerThread(overrides: Record<string, unknown> = {}) {
  p.messageThread.findFirst.mockResolvedValue({
    id: THREAD_ID, channel: 'sms', campaign_type: 'customer_care', unread: 0,
    customer_id: CUSTOMER_FIXTURE.id, lead_id: LEAD_ID, vendor_id: null, kind: null,
    organization_id: ALPHA_ORG_ID, ...overrides,
  });
}

/** The composer resolves an explicit leadId under the caller's own Lead scope. */
function mockLeadResolve() {
  p.lead.findFirst.mockResolvedValue(LEAD_ROW);
}

/** Prisma returns the row it wrote, so the mock echoes `data` back — `ts` included. */
function mockMessageCreate() {
  p.message.create.mockImplementation((a: any) => Promise.resolve({ id: MSG_ID, ...a.data }));
}

/** The instant the door actually stamped on the message row. */
function sentMessageTs() {
  return p.message.create.mock.calls[0][0].data.ts;
}

function sendText(body: Record<string, unknown>) {
  return request(app)
    .post('/api/communication/sms')
    .set(authHeader('dispatcher'))
    .send({ threadId: THREAD_ID, body: 'Hi there', leadId: LEAD_ID, ...body });
}

/**
 * A connected, SMS-ready, entitled org with a usable from-number and a reachable destination —
 * everything an outbound text needs to actually LEAVE, so its row settles `sent`.
 *
 * Load-bearing rather than incidental setup, because the stamp follows the delivery OUTCOME and
 * not the intent (see the door). On an org where delivery is not configured — the suite's default,
 * and a real state for a customer who has not connected telephony — the row settles `skipped` and
 * nothing ever left the building; stamping from there would mark the lead contacted permanently,
 * because first-touch-wins means the real outreach that follows can never correct it. Every
 * positive assertion below therefore has to run over a path that genuinely delivers, or it would
 * be asserting the bug.
 */
function mockDeliveringOrg() {
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
  // resolveSmsDestination reads the thread customer's phone. Overrides the beforeEach default,
  // which exists for matchByPhone on the ingest doors and is never consulted on this one.
  p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });
  p.message.update.mockResolvedValue({ id: MSG_ID });
  p.timelineEvent.create.mockResolvedValue({});
  p.auditLog.create.mockResolvedValue({});
}

describe('contact clock — text channel (POST /api/communication/sms)', () => {
  // PROVENANCE, the negative. An automated text is the platform speaking for the company, and
  // counting it would make the response-time metric measure the software instead of the people
  // (user story 12). Asserted before the positive on purpose.
  it('does NOT stamp the clock for an AUTOMATED text to a lead', async () => {
    mockAuthAs('dispatcher');
    // Over a DELIVERING org on purpose. On the suite's unconfigured default the row settles
    // `skipped` and the outcome gate would withhold the clock on its own, so this test would pass
    // with the provenance filter deleted — which is precisely the failure it exists to catch.
    mockDeliveringOrg();
    mockCustomerThread();
    mockLeadResolve();
    mockMessageCreate();

    const res = await sendText({ automated: true });

    expect(res.status).toBe(201);
    // The row still records the lead — attribution is unaffected; only the CLOCK is withheld.
    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, automated: true });
    expect(clockWrites()).toEqual([]);
  });

  // The customer texting US is their effort, not ours (user story 15).
  it('does NOT stamp the clock for an INBOUND text on a lead thread', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockLeadResolve();
    mockMessageCreate();

    const res = await sendText({ direction: 'in', status: 'received' });

    expect(res.status).toBe(201);
    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'in' });
    expect(clockWrites()).toEqual([]);
  });

  // The same negative over a row that settles `sent`, so the DIRECTION filter is the only thing
  // withholding the clock. A simulated inbound write that names no status defaults to `sent`, so
  // the outcome gate lets it through and nothing but the filter stands between it and the stamp.
  it('does NOT stamp the clock for an INBOUND text whose row reads as sent', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockLeadResolve();
    mockMessageCreate();

    const res = await sendText({ direction: 'in' });

    expect(res.status).toBe(201);
    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'in', status: 'sent' });
    expect(clockWrites()).toEqual([]);
  });

  // THE OUTCOME, NOT THE INTENT. An org that has not connected telephony still gets the record —
  // the record is the product — but the text never left, so nobody was contacted. Stamping here
  // would be permanent: first touch wins, so the real outreach that follows could never correct
  // it, and the org's response-time report would credit a message nobody received.
  it('does NOT stamp the clock when the text never went out', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockLeadResolve();
    mockMessageCreate();
    p.message.update.mockResolvedValue({ id: MSG_ID });

    const res = await sendText({});

    expect(res.status).toBe(201);
    // The row itself says so, which is what the door reads.
    expect(res.body.delivery).toBe('skipped');
    expect(res.body.message.status).toBe('skipped');
    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'out' });
    expect(clockWrites()).toEqual([]);
  });

  it('stamps the clock for a human outbound text to a lead', async () => {
    mockAuthAs('dispatcher');
    mockDeliveringOrg();
    mockCustomerThread();
    mockLeadResolve();
    mockMessageCreate();

    const res = await sendText({});

    expect(res.status).toBe(201);
    expect(clockWrites()).toEqual([
      {
        // `contacted_at: null` in the WHERE is the first-touch-wins mechanism itself: the write is
        // refused by the database, atomically, when the clock already carries a value.
        where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null },
        // The MESSAGE's own instant, not a second `new Date()` read further downstream — "at the
        // moment it happened" is the whole contract.
        data: { contacted_at: sentMessageTs() },
      },
    ]);
  });

  // `contacted_set_by` is the marker for a HAND correction. An automatic stamp that filled it in
  // would make the two indistinguishable, and a report could no longer tell a measured response
  // time from an asserted one.
  it('leaves contacted_set_by untouched on an automatic stamp', async () => {
    mockAuthAs('dispatcher');
    mockDeliveringOrg();
    mockCustomerThread();
    mockLeadResolve();
    mockMessageCreate();

    await sendText({});

    expect(clockWrites()[0].data).not.toHaveProperty('contacted_set_by');
  });

  // Most texts are not lead outreach at all. Nothing is written and nothing throws.
  it('stamps nothing, and does not fail the send, for a text carrying no lead', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ lead_id: null });
    mockMessageCreate();

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'Running late' });

    expect(res.status).toBe(201);
    expect(clockWrites()).toEqual([]);
  });

  // FIRST TOUCH WINS, stated as the invariant rather than as a call-shape assertion. The mock
  // below enforces the same conditional-write semantics Postgres does, so a second outreach can
  // only move the stamp if the code stopped guarding on null.
  it('does not move the stamp when the salesperson follows up a second time', async () => {
    mockAuthAs('dispatcher');
    mockDeliveringOrg();
    mockCustomerThread();
    mockLeadResolve();

    const stored: { contacted_at: Date | null } = { contacted_at: null };
    p.lead.updateMany.mockImplementation(({ where, data }: any) => {
      if ('contacted_at' in where && where.contacted_at === null && stored.contacted_at !== null) {
        return Promise.resolve({ count: 0 });
      }
      if (data.contacted_at !== undefined) stored.contacted_at = data.contacted_at;
      return Promise.resolve({ count: 1 });
    });

    // The door stamps its own `new Date()` on each message, so the two sends carry genuinely
    // different instants; overriding `ts` in the mock would be testing the mock instead.
    mockMessageCreate();
    expect((await sendText({})).status).toBe(201);
    const first = p.message.create.mock.calls[0][0].data.ts;

    expect((await sendText({ body: 'Following up' })).status).toBe(201);
    const second = p.message.create.mock.calls[1][0].data.ts;

    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    expect(p.lead.updateMany).toHaveBeenCalledTimes(2);
    expect(stored.contacted_at).toEqual(first);
  });
});

// ─── Call ───────────────────────────────────────────────────────────────────────────────────

const CALL_BODY = {
  direction: 'out',
  from_number: '(555) 010-0001',
  to_number: '(555) 010-0002',
  status: 'ringing',
  lead_id: LEAD_ID,
};

/**
 * The call door resolves an explicit `lead_id` through `lead.findFirst`, and so does matchByPhone
 * one statement later. They are told apart by matchByPhone's own `status: { notIn: [...] }` guard,
 * so the phone matcher still resolves nothing and only the EXPLICIT lead is attributed.
 */
function mockExplicitLeadOnly() {
  p.lead.findFirst.mockImplementation((a: any) =>
    Promise.resolve(a?.where?.status ? null : LEAD_ROW));
}

function mockCallCreate(overrides: Record<string, unknown> = {}) {
  p.callSession.create.mockImplementation((a: any) =>
    Promise.resolve({ id: CALL_ID, ...a.data, ...overrides }));
}

/** The instant the door actually stamped on the call row. */
function placedCallStartedAt() {
  return p.callSession.create.mock.calls[0][0].data.started_at;
}

describe('contact clock — call channel (POST /api/communication/calls)', () => {
  // The customer ringing us is not us reaching out. This door records BOTH directions, so the
  // filter is the only thing keeping an inbound call off the clock.
  it('does NOT stamp the clock for an INBOUND call linked to a lead', async () => {
    mockAuthAs('dispatcher');
    mockExplicitLeadOnly();
    mockCallCreate();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...CALL_BODY, direction: 'in' });

    expect(res.status).toBe(201);
    expect(p.callSession.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'in' });
    expect(clockWrites()).toEqual([]);
  });

  it('stamps the clock, at the call\'s own start instant, for an outbound call to a lead', async () => {
    mockAuthAs('dispatcher');
    mockExplicitLeadOnly();
    mockCallCreate();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(CALL_BODY);

    expect(res.status).toBe(201);
    expect(clockWrites()).toEqual([
      {
        where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null },
        // The CALL's own start instant, so the clock says when the phone rang.
        data: { contacted_at: placedCallStartedAt() },
      },
    ]);
  });

  it('stamps nothing for an outbound call that matched no lead', async () => {
    mockAuthAs('dispatcher');
    mockCallCreate();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ direction: 'out', from_number: '(555) 010-0001', to_number: '(555) 010-0002', status: 'ringing' });

    expect(res.status).toBe(201);
    expect(clockWrites()).toEqual([]);
  });
});

// ─── Email (compose) ────────────────────────────────────────────────────────────────────────

function mockEmailCreate(overrides: Record<string, unknown> = {}) {
  p.email.create.mockImplementation((a: any) =>
    Promise.resolve({
      id: EMAIL_ID,
      account: 'user',
      from: { name: null, email: 'no-reply@mail.test.com' },
      snippet: '', labels: null, attachments: null, important: false, snoozed_until: null,
      vendor_id: null, job_id: null, job_label: null, customer: null, lead: null, vendor: null,
      customer_id: null, lead_id: null, thread_id: null,
      ...a.data,
      ts: BigInt(1789000005000),
      ...overrides,
    }));
  p.emailThread.create.mockResolvedValue({ id: 'ee000000-0000-0000-0000-0000000000e1' });
  p.emailReadState.create.mockResolvedValue({});
}

function composeEmail(fields: Record<string, string> = {}) {
  const req = request(app)
    .post('/api/communication/emails')
    .set(authHeader('admin'))
    .field('to', 'angel@example.com')
    .field('subject', 'About your enquiry')
    .field('body', JSON.stringify(['Following up on your request.']));
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req;
}

describe('contact clock — email channel (POST /api/communication/emails)', () => {
  // PROVENANCE, stated by the writer. The compose door is the one email writer that is a person
  // typing, so it must declare itself as such; the transactional mirror declares the opposite
  // (see lead-contact-clock-transactional.test.ts).
  it('records a composed email as NOT automated', async () => {
    mockAuthAs('admin');
    p.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockEmailCreate();

    const res = await composeEmail({ lead_id: LEAD_ID });

    expect(res.status).toBe(201);
    expect(p.email.create.mock.calls[0][0].data).toMatchObject({
      automated: false,
      direction: 'out',
      lead_id: LEAD_ID,
    });
  });

  it('stamps the clock for a human-written email to a lead', async () => {
    mockAuthAs('admin');
    p.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockEmailCreate();

    const res = await composeEmail({ lead_id: LEAD_ID });

    expect(res.status).toBe(201);
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: expect.any(Date) } },
    ]);
    expect(clockWrites()[0].data).not.toHaveProperty('contacted_set_by');
  });

  it('stamps nothing, and does not fail the send, for an email carrying no lead', async () => {
    mockAuthAs('admin');
    mockEmailCreate();

    const res = await composeEmail();

    expect(res.status).toBe(201);
    expect(p.email.create.mock.calls[0][0].data).toMatchObject({ automated: false });
    expect(clockWrites()).toEqual([]);
  });

  // AUTHORIZATION, and the reason it belongs in THIS file rather than an RBAC one: the attach is
  // what stamps the clock. Contact is first-touch-wins and therefore permanent, so a salesperson
  // able to name a colleague's lead here would credit that lead with outreach that never happened
  // — and no later, real outreach could ever correct it. The message would also surface on a lead
  // the sender cannot open.
  //
  // The mock stands in for Postgres rather than answering a fixed row: it evaluates the WHERE the
  // door actually sent, against a lead assigned to somebody else. Drop the row-scope predicate and
  // the very same lead comes back, the email is created carrying it, and the clock is stamped —
  // which is the state this test exists to fail on.
  it('404s on a lead the SALES caller cannot see, without sending or stamping', async () => {
    mockAuthAs('sales');
    p.lead.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        matchesScopeWhere(where, {
          ...LEAD_ROW,
          organization_id: ALPHA_ORG_ID,
          // Assigned to a colleague. SALES reads Lead conditioned on OWN_LEAD, so the caller's own
          // scope fragment is `lead_assignees: { some: { user_id: <sales id> } }`.
          lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
        })
          ? LEAD_ROW
          : null,
      ),
    );
    mockEmailCreate();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('sales'))
      .field('to', 'angel@example.com')
      .field('subject', 'About your enquiry')
      .field('body', JSON.stringify(['Following up on your request.']))
      .field('lead_id', LEAD_ID);

    // 404, never 403: a lead out of scope is indistinguishable from one that does not exist, the
    // same no-existence-oracle rule the job and customer resolves on this door already keep.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Lead not found' });
    expect(p.email.create).not.toHaveBeenCalled();
    expect(clockWrites()).toEqual([]);
  });

  // The other half of the same rule: the scope is a filter, not a block. A salesperson emailing
  // their OWN lead attaches and stamps exactly as before.
  it('attaches and stamps for a SALES caller on a lead that is theirs', async () => {
    mockAuthAs('sales');
    p.lead.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(
        matchesScopeWhere(where, {
          ...LEAD_ROW,
          organization_id: ALPHA_ORG_ID,
          lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        })
          ? LEAD_ROW
          : null,
      ),
    );
    mockEmailCreate();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('sales'))
      .field('to', 'angel@example.com')
      .field('subject', 'About your enquiry')
      .field('body', JSON.stringify(['Following up on your request.']))
      .field('lead_id', LEAD_ID);

    expect(res.status).toBe(201);
    expect(p.email.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID });
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: expect.any(Date) } },
    ]);
  });

  // Attach-by-origin is tenant-scoped like its job and customer siblings: a lead the caller's org
  // does not own must 404 having dispatched nothing at all.
  it('404s on a cross-org lead_id without sending or stamping', async () => {
    mockAuthAs('admin');
    p.lead.findUnique.mockResolvedValue(null);
    mockEmailCreate();

    const res = await composeEmail({ lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Lead not found' });
    expect(p.email.create).not.toHaveBeenCalled();
    expect(clockWrites()).toEqual([]);
  });

  // The message has already reached the customer by the time the clock is written. A bookkeeping
  // failure must not report a send that plainly happened as a failure.
  it('still answers 201 when the clock write itself fails', async () => {
    mockAuthAs('admin');
    p.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockEmailCreate();
    p.lead.updateMany.mockRejectedValue(new Error('db down'));

    const res = await composeEmail({ lead_id: LEAD_ID });

    expect(res.status).toBe(201);
  });
});

// ─── The phone system's own ingest ──────────────────────────────────────────────────────────
//
// This is where a call PLACED through the product actually lands. Click-to-call and the softphone
// answer 202 with no local row at all — the CallSession is created off the CTM webhook — so a
// clock wired only to the manual call-log door would miss every call the product itself placed.
// Driven as a direct module call under the same harness, the shape ctm-call-attribution.test.ts
// already established for this module.

const SID = 'CA-contact-clock-1';
const MSG_SID = 'MSG-contact-clock-1';

/** matchByPhone resolves the counterpart number to this lead, and to nothing else. */
function mockPhoneMatchesLead() {
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(LEAD_ROW);
}

function mockIngestBaseline() {
  p.user.findFirst.mockResolvedValue(null);
  p.callSession.findFirst.mockResolvedValue(null);
  // Prisma returns the row it wrote; echoing `create` back is what lets the clock read the
  // lead and the direction off it.
  p.callSession.upsert.mockImplementation((a: any) => Promise.resolve({ id: 'cs-1', ...a.create }));
  p.pendingCallAttribution.findFirst.mockResolvedValue(null);
  p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 0 });
}

const CALL_ACTIVITY = {
  sid: SID,
  tracking_number: '+15550100001',
  called_number: '+15550100002',
  caller_number: '+15550100002',
  unix_time: 1_787_000_000,
  dial_status: 'answered',
  talk_time: 30,
};

describe('contact clock — calls ingested from the phone system', () => {
  beforeEach(() => {
    mockIngestBaseline();
  });

  it('stamps the clock for an OUTBOUND ingested call matched to a lead', async () => {
    mockPhoneMatchesLead();

    await ingestCall(prisma, ALPHA_ORG_ID, { ...CALL_ACTIVITY, direction: 'outbound' }, 'end');

    const created = p.callSession.upsert.mock.calls[0][0].create;
    expect(created.lead_id).toBe(LEAD_ID);
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: created.started_at } },
    ]);
  });

  // The lead ringing US is their effort. The same ingest handles both directions, so the filter is
  // the only thing keeping an inbound call off the clock — and inbound is the COMMON case here.
  it('does NOT stamp the clock for an INBOUND ingested call matched to a lead', async () => {
    mockPhoneMatchesLead();

    await ingestCall(prisma, ALPHA_ORG_ID, { ...CALL_ACTIVITY, direction: 'inbound' }, 'end');

    expect(p.callSession.upsert.mock.calls[0][0].create.lead_id).toBe(LEAD_ID);
    expect(clockWrites()).toEqual([]);
  });

  // The webhook fires twice for one call. First-touch-wins makes the second a no-op, and the
  // instant both carry is the call's own start rather than whenever the `end` payload arrived.
  it('does not move the stamp when the same call reports twice', async () => {
    mockPhoneMatchesLead();

    await ingestCall(prisma, ALPHA_ORG_ID, { ...CALL_ACTIVITY, direction: 'outbound' }, 'starts');
    p.lead.updateMany.mockResolvedValue({ count: 0 }); // the clock is set now
    await ingestCall(prisma, ALPHA_ORG_ID, { ...CALL_ACTIVITY, direction: 'outbound' }, 'end');

    const writes = clockWrites();
    expect(writes).toHaveLength(2);
    // Both guarded on null, so the second cannot overwrite; and both carry the SAME instant, so
    // even a lost guard could not report a contact time minutes after the phone rang.
    expect(writes[1].where).toEqual({ id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null });
    expect(writes[1].data.contacted_at).toEqual(writes[0].data.contacted_at);
  });
});

const SMS_ACTIVITY = {
  message_id: MSG_SID,
  caller_number: '+15550100002',
  called_number: '+15550100002',
  unix_time: 1_787_000_000,
  message_body: 'Following up on your enquiry',
};

describe('contact clock — texts ingested from the phone system', () => {
  beforeEach(() => {
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, channel: 'sms', customer_id: null, lead_id: LEAD_ID,
      vendor_id: null, kind: null, organization_id: ALPHA_ORG_ID,
    });
    p.message.findFirst.mockResolvedValue(null);
    p.message.create.mockImplementation((a: any) => Promise.resolve({ id: MSG_ID, ...a.data }));
    p.messageThread.update.mockResolvedValue({});
  });

  it('stamps the clock for an OUTBOUND text sent from outside the app', async () => {
    mockPhoneMatchesLead();

    await ingestSms(prisma, ALPHA_ORG_ID, { ...SMS_ACTIVITY, direction: 'outbound' });

    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, automated: false });
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: expect.any(Date) } },
    ]);
  });

  it('does NOT stamp the clock for an INBOUND text from the lead', async () => {
    mockPhoneMatchesLead();
    p.blockedNumber.findFirst.mockResolvedValue(null);

    await ingestSms(prisma, ALPHA_ORG_ID, { ...SMS_ACTIVITY, direction: 'inbound' });

    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'in' });
    expect(clockWrites()).toEqual([]);
  });
});

// ─── The correction door ────────────────────────────────────────────────────────────────────

const CORRECTION_AT = '2026-08-20T15:30:00.000Z';

function mockCorrectionTx() {
  p.$transaction.mockImplementation(async (fn: any) => fn(p));
  p.lead.update.mockImplementation((a: any) =>
    Promise.resolve({ ...LEAD_FIXTURE, id: LEAD_ID, ...a.data }));
  p.timelineEvent.create.mockResolvedValue({});
  p.auditLog.create.mockResolvedValue({});
  p.tagAssignment.findMany.mockResolvedValue([]);
}

function correct(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/leads/${LEAD_ID}/contact`)
    .set(authHeader('dispatcher'))
    .send({ contacted_at: CORRECTION_AT, ...body });
}

describe('contact clock — the hand-correction door (POST /api/leads/:id/contact)', () => {
  it('sets the clock and attributes it to the person who used the door', async () => {
    mockAuthAs('dispatcher');
    p.lead.findUnique.mockResolvedValue({ id: LEAD_ID, lead_number: 'L00201', contacted_at: null });
    mockCorrectionTx();

    const res = await correct({ contacted_note: 'Called from my own phone' });

    expect(res.status).toBe(200);
    expect(p.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LEAD_ID },
        data: expect.objectContaining({
          contacted_at: new Date(CORRECTION_AT),
          // Never null. An anonymous correction is not auditable, and it is what makes a hand-set
          // time distinguishable from a measured one forever after.
          contacted_set_by: TEST_USERS.dispatcher.id,
          contacted_note: 'Called from my own phone',
        }),
      }),
    );
  });

  // THE ONE DELIBERATE EXCEPTION to first-touch-wins in the whole spec. The write must be
  // unconditional — routing it through the atomic stamper would make a correction silently do
  // nothing on precisely the leads somebody is trying to correct.
  it('OVERWRITES an existing automatic stamp', async () => {
    mockAuthAs('dispatcher');
    const automatic = new Date('2026-08-19T08:00:00Z');
    p.lead.findUnique.mockResolvedValue({ id: LEAD_ID, lead_number: 'L00201', contacted_at: automatic });
    mockCorrectionTx();

    const res = await correct();

    expect(res.status).toBe(200);
    const data = p.lead.update.mock.calls[0][0].data;
    expect(data.contacted_at).toEqual(new Date(CORRECTION_AT));
    // Not through stampLeadClock: that helper's WHERE is `contacted_at: null`, which would have
    // matched nothing here.
    expect(clockWrites()).toEqual([]);
  });

  it('writes a timeline entry naming the actor, with the instants in metadata rather than in the prose', async () => {
    mockAuthAs('dispatcher');
    const automatic = new Date('2026-08-19T08:00:00Z');
    p.lead.findUnique.mockResolvedValue({ id: LEAD_ID, lead_number: 'L00201', contacted_at: automatic });
    mockCorrectionTx();

    await correct();

    expect(p.timelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organization_id: ALPHA_ORG_ID,
        entity_type: 'LEAD',
        entity_id: LEAD_ID,
        event_type: 'CONTACT_SET',
        description: 'Contact time corrected by hand',
        metadata: {
          contacted_at: CORRECTION_AT,
          previous_contacted_at: automatic.toISOString(),
          source: 'manual_correction',
        },
        created_by: TEST_USERS.dispatcher.id,
      }),
    });
    // Prose is printed verbatim in the Activity panel, so a server-rendered instant would be in
    // the wrong zone for every reader (MV-TZ-07).
    const { description } = p.timelineEvent.create.mock.calls[0][0].data;
    expect(description).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
  });

  // D1/D6: status moves through the one transition writer and nowhere else. The pre-redesign
  // version of this door moved the lead to CONTACTED, which is exactly what would make the
  // "first contact to walkthrough booked" interval unmeasurable.
  it('does not touch the lead status', async () => {
    mockAuthAs('dispatcher');
    p.lead.findUnique.mockResolvedValue({ id: LEAD_ID, lead_number: 'L00201', contacted_at: null });
    mockCorrectionTx();

    await correct();

    expect(p.lead.update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  it('404s on a lead in another org', async () => {
    mockAuthAs('dispatcher');
    p.lead.findUnique.mockResolvedValue(null);

    const res = await correct();

    expect(res.status).toBe(404);
    expect(p.lead.update).not.toHaveBeenCalled();
  });

  // The `contact` grant is not held by TECHNICIAN — the route guard, not the handler, refuses it.
  it('403s for a role without the contact grant', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/contact`)
      .set(authHeader('technician'))
      .send({ contacted_at: CORRECTION_AT });

    expect(res.status).toBe(403);
    expect(p.lead.update).not.toHaveBeenCalled();
  });

  // Own-scope: SALES holds `contact` conditioned on owning the lead, so a lead it does not own is
  // refused by the per-row check even though the route guard let it through.
  it('403s for an own-scoped role on a lead it does not own', async () => {
    mockAuthAs('sales');
    p.lead.findUnique.mockResolvedValue({ id: LEAD_ID, lead_number: 'L00201', contacted_at: null });
    p.lead.findFirst.mockResolvedValue(null); // canAccessRow's scoped probe finds nothing

    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/contact`)
      .set(authHeader('sales'))
      .send({ contacted_at: CORRECTION_AT });

    expect(res.status).toBe(403);
    expect(p.lead.update).not.toHaveBeenCalled();
  });

  // Nothing in this spec un-sets a clock. A door that could would let an already-recorded breach
  // be erased, which the product owner ratified against.
  it('rejects a body that tries to clear the clock', async () => {
    mockAuthAs('dispatcher');
    p.lead.findUnique.mockResolvedValue({ id: LEAD_ID, lead_number: 'L00201', contacted_at: new Date() });

    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/contact`)
      .set(authHeader('dispatcher'))
      .send({ contacted_at: null });

    expect(res.status).toBe(400);
    expect(p.lead.update).not.toHaveBeenCalled();
  });
});
