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
import { logger } from '../lib/logger';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ingestCall, ingestSms } from '../lib/ctm/ingest';
import * as ctmClient from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, mockRoleSwitches, authHeader, matchesScopeWhere, CUSTOMER_FIXTURE, LEAD_FIXTURE } from './helpers';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { numberBelongsTo, noNumberMatches } from './support/phone-match';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const LEAD_ID = 'e0000000-0000-0000-0000-0000000000c1';
const LEAD_ROW = { id: LEAD_ID, lead_number: 'L00201', customer_id: CUSTOMER_FIXTURE.id };
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000c1';
const MSG_ID = '99990000-0000-0000-0000-0000000000c1';
const CALL_ID = '77770000-0000-0000-0000-0000000000c1';
const EMAIL_ID = 'ee000000-0000-0000-0000-0000000000c1';

/**
 * Every CLOCK write the request made: the `lead.updateMany` calls that write `contacted_at`. Since
 * #2618 the same doors also move a New lead to Contacted through `transitionLeadStatus`, which is a
 * `lead.updateMany` too (on `status`); that write is not the clock and is covered, against a real
 * database, by lead-contact-moves-new-to-contacted-db.test.ts.
 */
function clockWrites() {
  return (p.lead.updateMany.mock.calls as any[][])
    .map((c) => c[0])
    .filter((a) => a?.data && 'contacted_at' in a.data);
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
  // The send doors hand the contact writer the PLAIN client, and it opens one transaction of its
  // own for the stamp and the New -> Contacted move (#2618). The real client runs the callback;
  // setup.ts's bare `vi.fn()` would drop it, so the mock runs it against itself.
  p.$transaction.mockImplementation(async (fn: any) => fn(p));
  // matchByPhone's lookups — no phone match, so nothing is attributed by accident.
  noNumberMatches(p);
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
    ctm_account_id: '596375',
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
    expect(clockWrites()).toHaveLength(2);
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
 * The call door resolves an explicit `lead_id` through `lead.findFirst`; the phone match finds no customer for the
 * number (and never carries a lead), so only the EXPLICIT lead is attributed.
 */
function mockExplicitLeadOnly() {
  p.lead.findFirst.mockResolvedValue(LEAD_ROW);
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

/**
 * The counterpart number is this lead's own (its customer's, and the one open record carrying it as its own), so the
 * call ingest files a call on the lead (#3015) and an incoming text with no recent text of ours is tied to it (#3020).
 * A customer match never carries a lead itself (#3020 removed that unreachable branch).
 */
function mockNumberIsTheLeadsOwn() {
  numberBelongsTo(p, CUSTOMER_FIXTURE, { leadId: LEAD_ID });
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

  it('stamps the clock for an OUTBOUND ingested call on a lead carrying the number as its own', async () => {
    mockNumberIsTheLeadsOwn();

    await ingestCall(prisma, ALPHA_ORG_ID, { ...CALL_ACTIVITY, direction: 'outbound' }, 'end');

    const created = p.callSession.upsert.mock.calls[0][0].create;
    expect(created.lead_id).toBe(LEAD_ID);
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: created.started_at } },
    ]);
  });

  // The lead ringing US is their effort. The same ingest handles both directions, so the filter is
  // the only thing keeping an inbound call off the clock — and inbound is the COMMON case here.
  it('does NOT stamp the clock for an INBOUND ingested call on a lead carrying the number as its own', async () => {
    mockNumberIsTheLeadsOwn();

    await ingestCall(prisma, ALPHA_ORG_ID, { ...CALL_ACTIVITY, direction: 'inbound' }, 'end');

    expect(p.callSession.upsert.mock.calls[0][0].create.lead_id).toBe(LEAD_ID);
    expect(clockWrites()).toEqual([]);
  });

  // The webhook fires twice for one call. First-touch-wins makes the second a no-op, and the
  // instant both carry is the call's own start rather than whenever the `end` payload arrived.
  it('does not move the stamp when the same call reports twice', async () => {
    mockNumberIsTheLeadsOwn();

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

  // An outbound text the phone system reports (sent from outside the app) is tied to no lead (#3020: the tie rule is for
  // incoming texts, and a phone match never carries a lead), so it stamps no clock: the case that stamped one here proved
  // it only through a mocked lead match no customer number could reach.

  it('does NOT stamp the clock for an INBOUND text tied to the lead', async () => {
    mockNumberIsTheLeadsOwn();
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
    // the wrong zone for every reader (MV-TZ-07). Every row this door writes is checked: since
    // #2618 a New lead's move to Contacted files a STATUS_CHANGE row ahead of the CONTACT_SET one.
    const descriptions = (p.timelineEvent.create.mock.calls as any[][]).map((c) => c[0].data.description);
    expect(descriptions).toContain('Contact time corrected by hand');
    for (const description of descriptions) {
      expect(description).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
    }
  });

  // D1/D6: status moves through the one transition writer and nowhere else. Since #2618 this door
  // DOES move a New lead to Contacted (lead-contact-correction-moves-status-db.test.ts asserts it
  // against a real database), but only through `transitionLeadStatus`: the clock write itself
  // never carries a status, and a status move never writes the clock.
  it('never writes the status in the clock write itself', async () => {
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

    expect(res.status).toBe(404);
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

// ─── Linking an existing communication to a lead (SPEC-4 §6.2, §7.1) ────────────────────────
//
// The attach doors on the customer page file a communication that already exists onto a lead.
// The rule they share (lead-contact.service.ts `contactFromLeadLink`) is table-tested in
// lead-contact-on-link.test.ts; these tests show what a REQUEST to the text door causes to be
// written: the clock stamp at the text's own instant, and the New -> Contacted move credited to
// the person who SENT the text (not the person who attached it), or neither.

/** The person who sent the text. Deliberately not the dispatcher who attaches it. */
const SENDER_ID = TEST_USERS.sales.id;
const TEXT_SENT_AT = new Date('2026-10-20T13:45:00.000Z');

/** A customer-level outbound human text that went out. Each test changes one thing. */
function storedText(overrides: Record<string, unknown> = {}) {
  return {
    id: MSG_ID, direction: 'out', body: 'Following up on your request', ts: TEXT_SENT_AT,
    status: 'sent', automated: false, job_id: null, job_label: null, lead_id: null,
    sent_by_user_id: SENDER_ID, organization_id: ALPHA_ORG_ID, ...overrides,
  };
}

/**
 * The stored message row, kept by the mock the way Postgres keeps it: `updateMany` writes its
 * `lead_id`, and every read sees the current row. So the door's read before its write sees the
 * row as it was, and its refetch after sees the link.
 */
function mockStoredText(row: Record<string, unknown>) {
  const stored = { ...row };
  p.message.updateMany.mockImplementation(({ data }: any) => {
    Object.assign(stored, data);
    return Promise.resolve({ count: 1 });
  });
  p.message.findMany.mockImplementation(() => Promise.resolve([{ ...stored }]));
  mockCustomerThread({ lead_id: null });
  p.lead.findUnique.mockResolvedValue(LEAD_ROW);
  p.timelineEvent.create.mockResolvedValue({});
}

function attachText(leadId: string | null, role: 'dispatcher' | 'sales' = 'dispatcher') {
  return request(app)
    .patch(`/api/communication/sms/${MSG_ID}/lead`)
    .set(authHeader(role))
    .send({ lead_id: leadId });
}

/** The New -> Contacted status writes: `lead.updateMany` calls that write `status`. */
function statusMoves() {
  return (p.lead.updateMany.mock.calls as any[][])
    .map((c) => c[0])
    .filter((a) => a?.data && 'status' in a.data);
}

/** The lead History rows the request wrote. */
function leadHistory() {
  return (p.timelineEvent.create.mock.calls as any[][])
    .map((c) => c[0].data)
    .filter((d) => d.entity_type === 'LEAD');
}

/** Nothing at all was written to any lead: no clock, no status, no History. */
function expectNoLeadWrite() {
  expect(p.lead.updateMany).not.toHaveBeenCalled();
  expect(leadHistory()).toEqual([]);
}

describe('contact clock — linking an existing communication to a lead (PATCH /api/communication/sms/:id/lead)', () => {
  beforeEach(() => {
    // These cases are about attribution, not the Text page's scope: a person on All reads every conversation.
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it.each(['sent', 'delivered'])(
    'attaching a %s outbound text to a New lead stamps the clock at the text\'s own time and moves the lead, credited to its sender',
    async (status) => {
      mockAuthAs('dispatcher');
      mockStoredText(storedText({ status }));

      const res = await attachText(LEAD_ID);

      expect(res.status).toBe(200);
      expect(res.body.message.leadId).toBe(LEAD_ID);
      expect(clockWrites()).toEqual([
        { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: TEXT_SENT_AT } },
      ]);
      expect(statusMoves()).toEqual([
        { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, status: { in: ['NEW'] } }, data: { status: 'CONTACTED' } },
      ]);
      expect(leadHistory()).toEqual([
        expect.objectContaining({
          organization_id: ALPHA_ORG_ID, entity_id: LEAD_ID, event_type: 'STATUS_CHANGE',
          description: 'Lead moved to Contacted: first outbound text',
          metadata: { from: 'NEW', to: 'CONTACTED', via: 'first_outbound_text' },
          created_by: SENDER_ID,
          created_at: TEXT_SENT_AT,
        }),
      ]);
    },
  );

  it.each(['skipped', 'failed', 'queued', null])(
    'attaching a text that never went out (status %s) links it and writes nothing to the lead',
    async (status) => {
      mockAuthAs('dispatcher');
      mockStoredText(storedText({ status }));

      const res = await attachText(LEAD_ID);

      expect(res.status).toBe(200);
      expect(res.body.message.leadId).toBe(LEAD_ID);
      expectNoLeadWrite();
    },
  );

  it('attaching an AUTOMATED text writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ automated: true }));

    const res = await attachText(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('attaching an INBOUND text from the customer writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ direction: 'in', status: 'received', sent_by_user_id: null }));

    const res = await attachText(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('re-attaching a text to the lead it is already on writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_ID }));

    const res = await attachText(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('detaching a sent text from a New lead writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_ID }));

    const res = await attachText(null);

    expect(res.status).toBe(200);
    expect(p.message.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null, job_id: null, job_label: null });
    expectNoLeadWrite();
  });

  // The text is linked by the time the contact is recorded. A bookkeeping failure must not turn a
  // link that plainly happened into a 500 (SPEC-4 statement 19), and it must not go unlogged.
  it('still answers 200, with the text linked, when recording the contact fails, and logs it', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText());
    p.lead.updateMany.mockRejectedValue(new Error('db down'));

    const res = await attachText(LEAD_ID);

    expect(res.status).toBe(200);
    expect(res.body.message.leadId).toBe(LEAD_ID);
    expect(p.message.updateMany.mock.calls[0][0].data).toEqual({ lead_id: LEAD_ID, job_id: null, job_label: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(LEAD_ID), expect.any(Error));
  });

  describe('the existing not-found answers still apply and record nothing', () => {
    it('another company\'s lead', async () => {
      mockAuthAs('dispatcher');
      mockStoredText(storedText());
      p.lead.findUnique.mockResolvedValue(null);

      const res = await attachText(LEAD_ID);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.message.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });

    it('another customer\'s lead', async () => {
      mockAuthAs('dispatcher');
      mockStoredText(storedText());
      p.lead.findUnique.mockResolvedValue({ ...LEAD_ROW, customer_id: 'c0000000-0000-0000-0000-000000000099' });

      const res = await attachText(LEAD_ID);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.message.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });

    it('a lead out of the person\'s reach', async () => {
      mockAuthAs('sales');
      mockStoredText(storedText());
      p.lead.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          matchesScopeWhere(where, {
            ...LEAD_ROW,
            organization_id: ALPHA_ORG_ID,
            // Assigned to a colleague: SALES reads Lead conditioned on OWN_LEAD.
            lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
          })
            ? LEAD_ROW
            : null,
        ),
      );

      const res = await attachText(LEAD_ID, 'sales');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.message.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });
  });
});

// SPEC-4 §6.7 / §7.1 #10: the lead's Communication tab sends `{ customerId, body, leadId }`. This
// path already releases once the text goes out; these two tests pin it so it keeps doing so.
describe('contact clock — a text sent from the lead\'s Communication tab (POST /api/communication/sms)', () => {
  function sendFromLeadTab() {
    return request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'Hi, following up on your request', leadId: LEAD_ID });
  }

  it('on a company whose texts go out: the text is filed on the lead, stamps the clock and moves the lead', async () => {
    mockAuthAs('dispatcher');
    mockDeliveringOrg();
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '5551234567' });
    mockCustomerThread({ lead_id: null });
    // #3016: a text sent from a lead goes to the lead's number, read off the lead's customer (the lead changed nothing here).
    p.lead.findFirst.mockResolvedValue({ ...LEAD_ROW, customer: { phone: '5551234567' } });
    mockMessageCreate();

    const res = await sendFromLeadTab();

    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('sent');
    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'out' });
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: sentMessageTs() } },
    ]);
    expect(statusMoves()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, status: { in: ['NEW'] } }, data: { status: 'CONTACTED' } },
    ]);
    expect(leadHistory()).toEqual([
      expect.objectContaining({
        entity_id: LEAD_ID, description: 'Lead moved to Contacted: first outbound text', created_by: TEST_USERS.dispatcher.id,
      }),
    ]);
  });

  it('on a company whose texts do not go out: the text is filed on the lead, and the lead is left alone', async () => {
    mockAuthAs('dispatcher');
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, phone: '5551234567' });
    mockCustomerThread({ lead_id: null });
    mockLeadResolve();
    mockMessageCreate();
    p.message.update.mockResolvedValue({ id: MSG_ID });

    const res = await sendFromLeadTab();

    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('skipped');
    expect(p.message.create.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID, direction: 'out' });
    expect(clockWrites()).toEqual([]);
    expect(statusMoves()).toEqual([]);
  });
});

// ─── Attaching a call or an email to a lead (SPEC-4 §6.3, §6.4, §7.1 #5 to #9) ──────────────
//
// The call and email attach doors use the same shared link rule as the text door above. These
// tests show what a REQUEST to each door causes to be written to the lead: the clock stamp at the
// communication's own instant, and the New -> Contacted move credited to the person who made the
// call or sent the email (not the person who attached it), or nothing at all.

const CALL_STARTED_AT = new Date('2026-10-20T14:10:00.000Z');
/** emails.ts is epoch milliseconds: the instant the email was sent. */
const EMAIL_SENT_AT = new Date('2026-10-20T15:20:00.000Z');
const JOB_ID = 'f0000000-0000-0000-0000-0000000000c1';

/** A customer-level outbound call. Each test changes one thing. */
function storedCall(overrides: Record<string, unknown> = {}) {
  return {
    id: CALL_ID, direction: 'out', from_number: '+15550100001', to_number: '+15550100002',
    tracking_source: null, status: 'completed', answered_by: { kind: 'none' },
    started_at: CALL_STARTED_AT, duration_sec: 60, customer_id: CUSTOMER_FIXTURE.id,
    lead_id: null, vendor_id: null, job_id: null, job_label: null,
    agent_id: SENDER_ID, organization_id: ALPHA_ORG_ID, ...overrides,
  };
}

/**
 * The stored call row, kept by the mock the way Postgres keeps it: `updateMany` writes the link,
 * and every read sees the current row.
 */
function mockStoredCall(row: Record<string, unknown>) {
  const stored = { ...row };
  p.callSession.updateMany.mockImplementation(({ data }: any) => {
    Object.assign(stored, data);
    return Promise.resolve({ count: 1 });
  });
  p.callSession.findMany.mockImplementation(() => Promise.resolve([{ ...stored }]));
  p.lead.findUnique.mockResolvedValue(LEAD_ROW);
  p.job.findFirst.mockResolvedValue(null); // the lead has no job yet
  p.timelineEvent.create.mockResolvedValue({});
}

function attachCall(leadId: string | null, role: 'dispatcher' | 'sales' = 'dispatcher') {
  return request(app)
    .patch(`/api/communication/calls/${CALL_ID}/lead`)
    .set(authHeader(role))
    .send({ lead_id: leadId });
}

/** A customer-level outbound human email that was sent. Each test changes one thing. */
function storedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: EMAIL_ID, account: 'user', from: { name: null, email: 'office@mail.test.com' },
    to: [{ name: null, email: 'angel@example.com' }], subject: 'About your enquiry', snippet: '',
    body: ['Following up on your request.'], ts: BigInt(EMAIL_SENT_AT.getTime()),
    direction: 'out', automated: false, delivery_status: 'SENT',
    customer_id: CUSTOMER_FIXTURE.id, lead_id: null, vendor_id: null, job_id: null, job_label: null,
    thread_id: null, labels: null, attachments: null, email_attachments: [],
    customer: null, lead: null, vendor: null,
    sent_by_user_id: SENDER_ID, organization_id: ALPHA_ORG_ID, ...overrides,
  };
}

function mockStoredEmail(row: Record<string, unknown>) {
  const stored = { ...row };
  p.email.updateMany.mockImplementation(({ data }: any) => {
    Object.assign(stored, data);
    return Promise.resolve({ count: 1 });
  });
  p.email.findFirst.mockImplementation(() => Promise.resolve({ ...stored }));
  p.lead.findUnique.mockResolvedValue(LEAD_ROW);
  p.timelineEvent.create.mockResolvedValue({});
}

function attachEmail(leadId: string | null, role: 'dispatcher' | 'sales' = 'dispatcher') {
  return request(app)
    .patch(`/api/communication/emails/${EMAIL_ID}/lead`)
    .set(authHeader(role))
    .send({ lead_id: leadId });
}

/** The lead's History row for a release, dated at the contact and credited to its maker. */
function releaseRow(channel: 'call' | 'email', at: Date) {
  return expect.objectContaining({
    organization_id: ALPHA_ORG_ID, entity_id: LEAD_ID, event_type: 'STATUS_CHANGE',
    description: `Lead moved to Contacted: first outbound ${channel}`,
    metadata: { from: 'NEW', to: 'CONTACTED', via: `first_outbound_${channel}` },
    created_by: SENDER_ID,
    created_at: at,
  });
}

/** SPEC-4 statement 21: an attach sends no pop-up, bell row, email or text, and runs no automation. */
function expectNothingWokenUpByAttach() {
  expect(dispatchAutomationEvent).not.toHaveBeenCalled();
  expect(p.notification.create).not.toHaveBeenCalled();
  expect(p.notification.createMany).not.toHaveBeenCalled();
  expect(p.notificationRecipient.create).not.toHaveBeenCalled();
  expect(p.notificationRecipient.createMany).not.toHaveBeenCalled();
}

/** A lead SALES cannot open: assigned to a colleague, and SALES reads Lead conditioned on OWN_LEAD. */
function mockLeadOutOfSalesReach() {
  p.lead.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(
      matchesScopeWhere(where, {
        ...LEAD_ROW,
        organization_id: ALPHA_ORG_ID,
        lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
      })
        ? LEAD_ROW
        : null,
    ),
  );
}

describe('contact clock — attaching a call to a lead (PATCH /api/communication/calls/:id/lead)', () => {
  beforeEach(() => {
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it('attaching an outbound call to a New lead stamps the clock at the call\'s start and moves the lead, credited to its agent', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall());

    const res = await attachCall(LEAD_ID);

    expect(res.status).toBe(200);
    expect(res.body.call.leadId).toBe(LEAD_ID);
    expect(clockWrites()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: CALL_STARTED_AT } },
    ]);
    expect(statusMoves()).toEqual([
      { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, status: { in: ['NEW'] } }, data: { status: 'CONTACTED' } },
    ]);
    expect(leadHistory()).toEqual([releaseRow('call', CALL_STARTED_AT)]);
    expectNothingWokenUpByAttach();
  });

  it('attaching an INBOUND call writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ direction: 'in', agent_id: null }));

    const res = await attachCall(LEAD_ID);

    expect(res.status).toBe(200);
    expect(res.body.call.leadId).toBe(LEAD_ID);
    expectNoLeadWrite();
  });

  it('re-attaching a call to the lead it is already on writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_ID }));

    const res = await attachCall(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('detaching an outbound call from a New lead writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_ID }));

    const res = await attachCall(null);

    expect(res.status).toBe(200);
    expect(p.callSession.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null, job_id: null, job_label: null });
    expectNoLeadWrite();
  });

  it('still answers 200, with the call linked, when recording the contact fails, and logs it', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall());
    p.lead.updateMany.mockRejectedValue(new Error('db down'));

    const res = await attachCall(LEAD_ID);

    expect(res.status).toBe(200);
    expect(res.body.call.leadId).toBe(LEAD_ID);
    expect(p.callSession.updateMany.mock.calls[0][0].data).toMatchObject({ lead_id: LEAD_ID });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(LEAD_ID), expect.any(Error));
  });

  describe('the existing not-found answers still apply and record nothing', () => {
    it('another company\'s lead', async () => {
      mockAuthAs('dispatcher');
      mockStoredCall(storedCall());
      p.lead.findUnique.mockResolvedValue(null);

      const res = await attachCall(LEAD_ID);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.callSession.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });

    it('a lead out of the person\'s reach', async () => {
      mockAuthAs('sales');
      mockStoredCall(storedCall());
      mockLeadOutOfSalesReach();

      const res = await attachCall(LEAD_ID, 'sales');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.callSession.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });
  });
});

// SPEC-4 §5: attaching a call to a JOB also files it on the job's lead, but that is an attach to a
// job, not to the lead, and it releases nothing.
describe('contact clock — attaching a call to a job (PATCH /api/communication/calls/:id/job)', () => {
  beforeEach(() => {
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it('filing an outbound call on a job of the lead writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall());
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00201', estimate: { lead_id: LEAD_ID } });

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/job`)
      .set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(200);
    expect(p.callSession.updateMany.mock.calls[0][0].data).toEqual({ job_id: JOB_ID, job_label: 'J00201', lead_id: LEAD_ID });
    expectNoLeadWrite();
  });
});

describe('contact clock — attaching an email to a lead (PATCH /api/communication/emails/:id/lead)', () => {
  beforeEach(() => {
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it.each(['SENT', 'DELIVERED'])(
    'attaching a %s outbound email to a New lead stamps the clock at its send time and moves the lead, credited to its sender',
    async (delivery_status) => {
      mockAuthAs('dispatcher');
      mockStoredEmail(storedEmail({ delivery_status }));

      const res = await attachEmail(LEAD_ID);

      expect(res.status).toBe(200);
      expect(res.body.email.leadId).toBe(LEAD_ID);
      expect(clockWrites()).toEqual([
        { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: EMAIL_SENT_AT } },
      ]);
      expect(statusMoves()).toEqual([
        { where: { id: LEAD_ID, organization_id: ALPHA_ORG_ID, status: { in: ['NEW'] } }, data: { status: 'CONTACTED' } },
      ]);
      expect(leadHistory()).toEqual([releaseRow('email', EMAIL_SENT_AT)]);
      expectNothingWokenUpByAttach();
    },
  );

  it.each(['BOUNCED', 'FAILED', 'QUEUED', 'DEFERRED', 'COMPLAINED', null])(
    'attaching an email that was not sent or delivered (status %s) links it and writes nothing to the lead',
    async (delivery_status) => {
      mockAuthAs('dispatcher');
      mockStoredEmail(storedEmail({ delivery_status }));

      const res = await attachEmail(LEAD_ID);

      expect(res.status).toBe(200);
      expect(res.body.email.leadId).toBe(LEAD_ID);
      expectNoLeadWrite();
    },
  );

  it('attaching an AUTOMATED email writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ automated: true, sent_by_user_id: null }));

    const res = await attachEmail(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('attaching an INBOUND email from the customer writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ direction: 'in', delivery_status: null, sent_by_user_id: null }));

    const res = await attachEmail(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('re-attaching an email to the lead it is already on writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ lead_id: LEAD_ID }));

    const res = await attachEmail(LEAD_ID);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it('detaching a sent email from a New lead writes nothing to the lead', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ lead_id: LEAD_ID }));

    const res = await attachEmail(null);

    expect(res.status).toBe(200);
    expect(p.email.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null });
    expectNoLeadWrite();
  });

  it('still answers 200, with the email linked, when recording the contact fails, and logs it', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail());
    p.lead.updateMany.mockRejectedValue(new Error('db down'));

    const res = await attachEmail(LEAD_ID);

    expect(res.status).toBe(200);
    expect(res.body.email.leadId).toBe(LEAD_ID);
    expect(p.email.updateMany.mock.calls[0][0].data).toEqual({ lead_id: LEAD_ID });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(LEAD_ID), expect.any(Error));
  });

  describe('the existing not-found answers still apply and record nothing', () => {
    it('another company\'s lead', async () => {
      mockAuthAs('dispatcher');
      mockStoredEmail(storedEmail());
      p.lead.findUnique.mockResolvedValue(null);

      const res = await attachEmail(LEAD_ID);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.email.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });

    it('another customer\'s lead', async () => {
      mockAuthAs('dispatcher');
      mockStoredEmail(storedEmail());
      p.lead.findUnique.mockResolvedValue({ ...LEAD_ROW, customer_id: 'c0000000-0000-0000-0000-000000000099' });

      const res = await attachEmail(LEAD_ID);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.email.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });

    it('a lead out of the person\'s reach', async () => {
      mockAuthAs('sales');
      mockStoredEmail(storedEmail());
      mockLeadOutOfSalesReach();

      const res = await attachEmail(LEAD_ID, 'sales');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Lead not found' });
      expect(p.email.updateMany).not.toHaveBeenCalled();
      expectNoLeadWrite();
    });
  });
});

// ─── D7: an outbound entry leaves a Contacted lead (SPEC-4 §6.12.5, §7.1 #11 to #20) ─────────
//
// Lead A is Contacted because an outbound text made it so (its newest move into Contacted is
// `via: first_outbound_text`), and the entry the request moves is the only one holding it, unless a
// test says otherwise. These tests show what a REQUEST to each door causes to be written to lead A:
// the move back to New (one status write that clears the clock and starts a fresh New stay, and one
// History row credited to the person who made the change), or nothing at all. The rule's query form
// and its concurrency are proved on Postgres in lead-contact-moves-new-to-contacted-db.test.ts.

const LEAD_A = LEAD_ID;
const LEAD_B = 'e0000000-0000-0000-0000-0000000000c2';
const LEAD_B_ROW = { id: LEAD_B, lead_number: 'L00202', customer_id: CUSTOMER_FIXTURE.id };
/** The person making the change: the dispatcher the requests below sign in as. */
const CHANGER_ID = TEST_USERS.dispatcher.id;

/** The contact-clock STAMPS (`WHERE contacted_at IS NULL`), not the move back's own clearing write. */
function clockStamps() {
  return clockWrites().filter((w) => w.where && 'contacted_at' in w.where);
}

type HoldingTable = 'message' | 'email' | 'callSession' | 'manualCommunicationLog';

/**
 * Lead A as the reconsider reads it under its lock, and what is left on it. `holding` names the
 * tables that still have a holding entry on A; `via` is its newest move into Contacted (null: none).
 */
function mockLeadA(opts: { status?: string; contactedSetBy?: string | null; via?: string | null; holding?: HoldingTable[] } = {}) {
  const { status = 'CONTACTED', contactedSetBy = null, via = 'first_outbound_text', holding = [] } = opts;
  p.lead.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(where?.id === LEAD_A && where?.organization_id === ALPHA_ORG_ID ? { status, contacted_set_by: contactedSetBy } : null),
  );
  for (const table of ['message', 'callSession', 'manualCommunicationLog'] as const) {
    p[table].findFirst.mockResolvedValue(holding.includes(table) ? { id: `held-by-${table}` } : null);
  }
  // The email door reads its own row through findFirst too (by id); the holding count reads without one.
  const doorRead = p.email.findFirst.getMockImplementation();
  p.email.findFirst.mockImplementation((args: any) => {
    if (args?.where?.id) return doorRead ? doorRead(args) : Promise.resolve(null);
    return Promise.resolve(holding.includes('email') ? { id: 'held-by-email' } : null);
  });
  p.timelineEvent.findFirst.mockResolvedValue(via ? { metadata: { from: 'NEW', to: 'CONTACTED', via } } : null);
  p.timelineEvent.create.mockResolvedValue({});
}

/** The lead row lock the reconsider takes first, on lead A in the request's company. */
function leadLocks() {
  return (p.$executeRaw.mock.calls as any[][]).filter(
    (c) => Array.isArray(c[0]) && c[0].join('?').includes('FOR NO KEY UPDATE') && c.includes(LEAD_A) && c.includes(ALPHA_ORG_ID),
  );
}

/** The holding counts the reconsider ran, one per table it reached. */
function holdingCounts() {
  return (['message', 'email', 'callSession', 'manualCommunicationLog'] as const).flatMap((table) =>
    (p[table].findFirst.mock.calls as any[][]).map((c) => c[0]).filter((a) => a?.where && !a.where.id),
  );
}

/** Lead A moved back to New by this request, credited to the person, with the entry's ids kept. */
function expectMovedBack(entrySource: string, entryId: string) {
  expect(leadLocks()).toHaveLength(1);
  const backToNew = statusMoves().filter((m) => m.data.status === 'NEW');
  expect(backToNew).toEqual([
    {
      where: { id: LEAD_A, organization_id: ALPHA_ORG_ID, status: { in: ['CONTACTED'] } },
      data: { status: 'NEW', contacted_at: null, returned_to_new_at: expect.any(Date) },
    },
  ]);
  expect(leadHistory().filter((h) => h.entity_id === LEAD_A)).toEqual([
    expect.objectContaining({
      organization_id: ALPHA_ORG_ID, entity_type: 'LEAD', entity_id: LEAD_A, event_type: 'STATUS_CHANGE',
      description: 'Lead moved back to New: no outbound contact left',
      metadata: { from: 'CONTACTED', to: 'NEW', via: 'no_outbound_contact_left', entry_source: entrySource, entry_id: entryId },
      created_by: CHANGER_ID,
    }),
  ]);
  // Every count, the lock and the write are scoped to the request's company and to lead A.
  for (const count of holdingCounts()) expect(count.where).toMatchObject({ organization_id: ALPHA_ORG_ID, lead_id: LEAD_A });
}

/** Lead A was left exactly as it was: no status write, no History row. */
function expectLeadAKept() {
  expect(statusMoves().filter((m) => m.where.id === LEAD_A)).toEqual([]);
  expect(leadHistory().filter((h) => h.entity_id === LEAD_A)).toEqual([]);
}

/** SPEC-4 statement 21, the D7 half: the only row written is the lead's STATUS_CHANGE. */
function expectNothingWokenUpByMoveAway() {
  expectNothingWokenUpByAttach();
  for (const [args] of p.timelineEvent.create.mock.calls as any[][]) expect(args.data.event_type).toBe('STATUS_CHANGE');
}

describe('D7 — an outbound entry leaves a Contacted lead (the text door, PATCH /api/communication/sms/:id/lead)', () => {
  beforeEach(() => {
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it('detaching the lead\'s only sent text moves the lead back to New, credited to the person who detached it', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_A }));
    mockLeadA();

    const res = await attachText(null);

    expect(res.status).toBe(200);
    expect(p.message.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null, job_id: null, job_label: null });
    expectMovedBack('text', MSG_ID);
    // Nothing is stamped: a move back writes no contact clock.
    expect(clockStamps()).toEqual([]);
    expectNothingWokenUpByMoveAway();
  });

  it('moving it to New lead B releases B and moves A back to New', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_A }));
    p.lead.findUnique.mockResolvedValue(LEAD_B_ROW);
    mockLeadA();

    const res = await attachText(LEAD_B);

    expect(res.status).toBe(200);
    expect(res.body.message.leadId).toBe(LEAD_B);
    expect(clockStamps()).toEqual([
      { where: { id: LEAD_B, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: TEXT_SENT_AT } },
    ]);
    expect(statusMoves().filter((m) => m.where.id === LEAD_B)).toEqual([
      { where: { id: LEAD_B, organization_id: ALPHA_ORG_ID, status: { in: ['NEW'] } }, data: { status: 'CONTACTED' } },
    ]);
    expectMovedBack('text', MSG_ID);
  });

  it.each<HoldingTable>(['message', 'email', 'callSession', 'manualCommunicationLog'])(
    'A keeps Contacted while another holding entry is on it (%s)',
    async (table) => {
      mockAuthAs('dispatcher');
      mockStoredText(storedText({ lead_id: LEAD_A }));
      mockLeadA({ holding: [table] });

      const res = await attachText(null);

      expect(res.status).toBe(200);
      expect(leadLocks()).toHaveLength(1);
      expectLeadAKept();
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['an inbound text', { direction: 'in', status: 'received', sent_by_user_id: null }],
    ['an automated text', { automated: true }],
    ['a skipped text', { status: 'skipped' }],
    ['a failed text', { status: 'failed' }],
    ['a queued text', { status: 'queued' }],
  ])('detaching %s, which never held A, takes no lock, counts nothing and writes nothing', async (_label, row) => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_A, ...row }));
    mockLeadA();

    const res = await attachText(null);

    expect(res.status).toBe(200);
    expect(leadLocks()).toEqual([]);
    expect(holdingCounts()).toEqual([]);
    expectNoLeadWrite();
  });

  it.each(['NEW', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST'])(
    'a lead that reads %s under the lock keeps its status',
    async (status) => {
      mockAuthAs('dispatcher');
      mockStoredText(storedText({ lead_id: LEAD_A }));
      mockLeadA({ status });

      const res = await attachText(null);

      expect(res.status).toBe(200);
      expectNoLeadWrite();
    },
  );

  it.each<[string, Parameters<typeof mockLeadA>[0]]>([
    ['its contact time was set by hand', { contactedSetBy: TEST_USERS.admin.id }],
    ['its newest move into Contacted was a status change by hand', { via: 'manual_edit' }],
    ['its newest move into Contacted was the contact time set by hand', { via: 'contact_set_by_hand' }],
    ['it moved back to Contacted when a walkthrough was cancelled', { via: 'walkthrough_cancelled' }],
    ['it has no recorded move into Contacted', { via: null }],
  ])('a Contacted that a person set is never undone: %s', async (_label, lead) => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_A }));
    mockLeadA(lead);

    const res = await attachText(null);

    expect(res.status).toBe(200);
    expectNoLeadWrite();
  });

  it.each<[string, () => void]>([
    ['the lock', () => p.$executeRaw.mockRejectedValueOnce(new Error('lock timeout'))],
    ['the lead write', () => p.lead.updateMany.mockRejectedValue(new Error('db down'))],
  ])('when %s fails: still 200, the text is detached, the failure is logged with the lead id', async (_label, fail) => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_A }));
    mockLeadA();
    fail();

    const res = await attachText(null);

    expect(res.status).toBe(200);
    expect(p.message.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null, job_id: null, job_label: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(LEAD_A));
    // Nothing of the move back stands: the History row is never reached.
    expect(leadHistory()).toEqual([]);
  });

  it('a text out of the person\'s reach 404s exactly as today and reconsiders nothing', async () => {
    mockAuthAs('dispatcher');
    mockStoredText(storedText({ lead_id: LEAD_A }));
    p.message.findMany.mockResolvedValue([]);
    p.message.updateMany.mockResolvedValue({ count: 0 });
    mockLeadA();

    const res = await attachText(null);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Message not found' });
    expect(leadLocks()).toEqual([]);
    expectNoLeadWrite();
  });
});

describe('D7 — the email door (PATCH /api/communication/emails/:id/lead)', () => {
  beforeEach(() => {
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it('detaching the lead\'s only sent email moves the lead back to New', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ lead_id: LEAD_A }));
    mockLeadA({ via: 'first_outbound_email' });

    const res = await attachEmail(null);

    expect(res.status).toBe(200);
    expect(p.email.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null });
    expectMovedBack('email', EMAIL_ID);
    expectNothingWokenUpByMoveAway();
  });

  it('moving it to New lead B releases B and moves A back to New', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ lead_id: LEAD_A }));
    p.lead.findUnique.mockResolvedValue(LEAD_B_ROW);
    mockLeadA({ via: 'first_outbound_email' });

    const res = await attachEmail(LEAD_B);

    expect(res.status).toBe(200);
    expect(clockStamps()).toEqual([
      { where: { id: LEAD_B, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: EMAIL_SENT_AT } },
    ]);
    expectMovedBack('email', EMAIL_ID);
  });

  it('a bounced email detached never held A: nothing is reconsidered', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ lead_id: LEAD_A, delivery_status: 'BOUNCED' }));
    mockLeadA({ via: 'first_outbound_email' });

    const res = await attachEmail(null);

    expect(res.status).toBe(200);
    expect(leadLocks()).toEqual([]);
    expectNoLeadWrite();
  });

  it('when the move back fails: still 200, detached, logged with the lead id', async () => {
    mockAuthAs('dispatcher');
    mockStoredEmail(storedEmail({ lead_id: LEAD_A }));
    mockLeadA({ via: 'first_outbound_email' });
    p.lead.updateMany.mockRejectedValue(new Error('db down'));

    const res = await attachEmail(null);

    expect(res.status).toBe(200);
    expect(p.email.updateMany.mock.calls[0][0].data).toEqual({ lead_id: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(LEAD_A));
  });
});

describe('D7 — the call doors (PATCH /api/communication/calls/:id/lead and /job)', () => {
  beforeEach(() => {
    mockRoleSwitches({ communication_scope: 'all' });
  });

  it('detaching the lead\'s only outbound call from the lead moves the lead back to New', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A }));
    mockLeadA({ via: 'first_outbound_call' });

    const res = await attachCall(null);

    expect(res.status).toBe(200);
    expectMovedBack('call', CALL_ID);
    expectNothingWokenUpByMoveAway();
  });

  it('moving it to New lead B releases B and moves A back to New', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A }));
    p.lead.findUnique.mockResolvedValue({ id: LEAD_B });
    mockLeadA({ via: 'first_outbound_call' });

    const res = await attachCall(LEAD_B);

    expect(res.status).toBe(200);
    expect(clockStamps()).toEqual([
      { where: { id: LEAD_B, organization_id: ALPHA_ORG_ID, contacted_at: null }, data: { contacted_at: CALL_STARTED_AT } },
    ]);
    expectMovedBack('call', CALL_ID);
  });

  it('an inbound call detached never held A: nothing is reconsidered', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A, direction: 'in', agent_id: null }));
    mockLeadA({ via: 'first_outbound_call' });

    const res = await attachCall(null);

    expect(res.status).toBe(200);
    expect(leadLocks()).toEqual([]);
    expectNoLeadWrite();
  });

  function fileOnJob(jobId: string | null) {
    return request(app)
      .patch(`/api/communication/calls/${CALL_ID}/job`)
      .set(authHeader('dispatcher'))
      .send({ job_id: jobId });
  }

  it.each<[string, string | null]>([
    ['a job of another lead', LEAD_B],
    ['a job with no lead', null],
  ])('filing the lead\'s only outbound call on %s moves the lead back to New, and releases nothing', async (_label, jobLead) => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A }));
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00201', estimate: jobLead ? { lead_id: jobLead } : null });
    mockLeadA({ via: 'first_outbound_call' });

    const res = await fileOnJob(JOB_ID);

    expect(res.status).toBe(200);
    expect(p.callSession.updateMany.mock.calls[0][0].data).toEqual({ job_id: JOB_ID, job_label: 'J00201', lead_id: jobLead });
    expect(clockStamps()).toEqual([]);
    expectMovedBack('call', CALL_ID);
  });

  it('detaching the call from its job, which clears its lead, moves the lead back to New', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A, job_id: JOB_ID, job_label: 'J00201' }));
    mockLeadA({ via: 'first_outbound_call' });

    const res = await fileOnJob(null);

    expect(res.status).toBe(200);
    expect(p.callSession.updateMany.mock.calls[0][0].data).toEqual({ job_id: null, job_label: null, lead_id: null });
    expectMovedBack('call', CALL_ID);
  });

  it('filing the call on a job of the same lead keeps it on the lead: nothing is reconsidered', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A }));
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00201', estimate: { lead_id: LEAD_A } });
    mockLeadA({ via: 'first_outbound_call' });

    const res = await fileOnJob(JOB_ID);

    expect(res.status).toBe(200);
    expect(leadLocks()).toEqual([]);
    expectNoLeadWrite();
  });

  it('when the move back fails: still 200, filed, logged with the lead id', async () => {
    mockAuthAs('dispatcher');
    mockStoredCall(storedCall({ lead_id: LEAD_A }));
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00201', estimate: null });
    mockLeadA({ via: 'first_outbound_call' });
    p.lead.updateMany.mockRejectedValue(new Error('db down'));

    const res = await fileOnJob(JOB_ID);

    expect(res.status).toBe(200);
    expect(p.callSession.updateMany.mock.calls[0][0].data).toMatchObject({ job_id: JOB_ID, lead_id: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(LEAD_A));
  });
});
