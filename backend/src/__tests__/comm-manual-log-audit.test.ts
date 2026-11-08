// Manual Communication Log — slice 9 (spec:
// md_files/specs/communication/2026-08-27-manual-communication-log.md).
//
// Logging a communication writes ONE activity-timeline event on the lead or job it names, and
// wakes NOTHING ELSE. The silence is the constraint that matters: an admin backfilling months of
// history may create hundreds of entries in an afternoon, and not one of them may dispatch an
// automation or raise a notification.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, LEAD_FIXTURE, TEST_USERS } from './helpers';
import { matchesWhere } from './whereMatcher';

// The notification seam. Mocked HERE rather than in setup.ts because ~20 suites already mock it
// themselves and a global replacement would change what they exercise. See manual-log-silence.ts
// for why a module mock (rather than a spy re-installed per test) is what survives another
// suite's resetAllMocks.
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue([]),
}));
// The automation seam is already mocked globally in setup.ts; manual-log-silence.ts fails loudly
// if either stops being a mock.
import { armSilenceSpies, expectNothingWokenUp } from './manual-log-silence';
import { armAtomicTransaction } from './manual-log-transaction';
import manualLogRouter from '../routes/comm-manual-log.routes';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

const LEAD_ID = LEAD_FIXTURE.id;
const JOB_ID = 'bb000000-0000-0000-0000-000000000011';
const ENDPOINT = '/api/communication/manual-log';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  armSilenceSpies();
  // The create path writes inside one interactive transaction (C15). Pass-through by default —
  // setup.ts ships `$transaction` with no implementation, so an unarmed one would never run the
  // callback at all. The rollback case below re-arms it with the journals it needs to undo.
  armAtomicTransaction();
});

function orgTimezone(tz: string) {
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: tz });
}

/** Echo the created row back the way Prisma would. */
function stubCreate() {
  mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) =>
    Promise.resolve({
      id: '11110000-0000-0000-0000-000000000001',
      duration_minutes: null,
      subject: null,
      job_id: null,
      lead_id: null,
      customer_id: null,
      ...args.data,
    }),
  );
}

/**
 * A real in-memory activity feed: the POST writes into it, the timeline endpoint reads out of it.
 * Canned return values would prove only that some object was handed to prisma; running the real
 * read against what the real write produced is what makes "exactly one event" mean anything.
 */
function stubActivityFeed() {
  const events: any[] = [];
  let n = 0;
  mockPrisma.timelineEvent.create.mockImplementation((args: any) => {
    const row = {
      id: `ee000000-0000-0000-0000-00000000000${++n}`,
      created_at: new Date('2026-08-27T10:00:00.000Z'),
      metadata: null,
      ...args.data,
      // The endpoints select `creator`, which Prisma resolves from created_by.
      creator: args.data.created_by
        ? { id: args.data.created_by, first_name: 'Test', last_name: 'Admin' }
        : null,
    };
    events.push(row);
    return Promise.resolve(row);
  });
  mockPrisma.timelineEvent.findMany.mockImplementation(({ where }: any) =>
    Promise.resolve(events.filter((e) => matchesWhere(e, where))),
  );
  // REMOVALS really remove (slice 8). Without this the feed is write-and-read only, and the one
  // thing the delete case most needs to be able to fail on — an implementation that erased the
  // create's audit event alongside the entry — would leave every assertion here green. Proven:
  // wiring a `timelineEvent.deleteMany` into the delete handler passed 17/17 before this existed.
  const removeMatching = (where: any) => {
    const kept = events.filter((e) => !matchesWhere(e, where));
    const removed = events.length - kept.length;
    events.length = 0;
    events.push(...kept);
    return { count: removed };
  };
  mockPrisma.timelineEvent.deleteMany.mockImplementation(({ where }: any) =>
    Promise.resolve(removeMatching(where)),
  );
  mockPrisma.timelineEvent.delete.mockImplementation(({ where }: any) => {
    removeMatching(where);
    return Promise.resolve({ id: where.id });
  });
  return events;
}

const LEAD_BODY = {
  lead_id: LEAD_ID,
  channel: 'call' as const,
  direction: 'out' as const,
  occurred_at: '2026-08-26T16:00',
  notes: 'Spoke to John from my mobile about the two garage doors.',
};

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

/** The same entry, anchored on the CUSTOMER itself — the third anchor (#2021). */
const CUSTOMER_BODY = {
  customer_id: CUSTOMER_ID,
  channel: 'call' as const,
  direction: 'out' as const,
  occurred_at: '2026-08-26T16:00',
  notes: 'Rang Linda to check she was happy with the work. Nothing outstanding.',
};

/** The same entry, anchored on a JOB instead — the other half of the XOR. */
const JOB_BODY = {
  job_id: JOB_ID,
  channel: 'call' as const,
  direction: 'out' as const,
  occurred_at: '2026-08-26T16:00',
  notes: 'Rang the customer from my mobile to confirm the install window.',
};

describe('logging a communication is visible to anyone auditing the record', () => {
  it('puts exactly one event on the activity feed of the lead it names', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    stubCreate();
    stubActivityFeed();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(LEAD_BODY);
    expect(created.status).toBe(201);

    const feed = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));

    expect(feed.status).toBe(200);
    expect(feed.body.events).toHaveLength(1);
    expect(feed.body.events[0].creator).toMatchObject({ id: TEST_USERS.admin.id });
  });

  // The event has to say WHICH channel, or the feed reads "a communication was logged" for a call,
  // a text and an email alike and the audit trail cannot distinguish them. Every channel is
  // asserted, not one: a description built by concatenating a hardcoded noun would satisfy a
  // single-channel test.
  it.each([
    ['call', 'out', 'Outbound call logged'],
    ['call', 'in', 'Inbound call logged'],
    ['sms', 'out', 'Outbound text logged'],
    ['sms', 'in', 'Inbound text logged'],
    ['email', 'out', 'Outbound email logged'],
    ['email', 'in', 'Inbound email logged'],
  ])('says on the feed that a %s was logged %s-bound', async (channel, direction, expected) => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    stubCreate();
    stubActivityFeed();

    const created = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...LEAD_BODY, channel, direction });
    expect(created.status).toBe(201);

    const feed = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));

    expect(feed.body.events).toHaveLength(1);
    expect(feed.body.events[0].description).toBe(expected);
  });

  // The event goes on the anchor the entry NAMES. Both halves are asserted from one create: an
  // implementation that wrote to whichever anchor it liked, or to both, would satisfy either half
  // alone.
  it('puts the event on the job it names, and nothing on the lead', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    stubCreate();
    stubActivityFeed();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);
    expect(created.status).toBe(201);

    const jobFeed = await request(app).get(`/api/jobs/${JOB_ID}/timeline`).set(authHeader('admin'));
    expect(jobFeed.status).toBe(200);
    expect(jobFeed.body.events).toHaveLength(1);
    expect(jobFeed.body.events[0]).toMatchObject({
      event_type: 'COMMUNICATION_LOGGED',
      description: 'Outbound call logged',
      creator: { id: TEST_USERS.admin.id },
    });

    const leadFeed = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));
    expect(leadFeed.body.events).toHaveLength(0);
  });

  // Who ADDED the record, not who had the conversation. An admin typing up a colleague's call is
  // exactly the feature's primary use case, and the audit question is whose keystrokes these were.
  it('credits the logger on the feed even when the conversation was someone else’s', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.user.findFirst.mockResolvedValue({ id: TEST_USERS.sales.id });
    stubCreate();
    stubActivityFeed();

    const created = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...LEAD_BODY, performed_by: TEST_USERS.sales.id });
    expect(created.status).toBe(201);
    expect(created.body.entry.performedBy).toBe(TEST_USERS.sales.id);

    const feed = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));

    expect(feed.body.events).toHaveLength(1);
    expect(feed.body.events[0].creator.id).toBe(TEST_USERS.admin.id);
    expect(feed.body.events[0].creator.id).not.toBe(TEST_USERS.sales.id);
  });

  // The third anchor (#2021). There is no per-customer timeline ENDPOINT to read this back
  // through - a customer's activity reaches a user through the org-wide dashboard feed and the
  // activity report, both of which are entity-type-agnostic - so the assertion is made against
  // the feed the write actually landed in, and against the two feeds it must NOT have landed in.
  //
  // Getting the entity wrong here is invisible without this: an event written as JOB carrying a
  // CUSTOMER's id would still appear on the org-wide feed reading perfectly well, while pointing
  // at a job that does not exist.
  it('puts exactly one event on the CUSTOMER it names, and none on any lead or job', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    stubCreate();
    const events = stubActivityFeed();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(CUSTOMER_BODY);
    expect(created.status).toBe(201);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entity_type: 'CUSTOMER',
      entity_id: CUSTOMER_ID,
      event_type: 'COMMUNICATION_LOGGED',
      description: 'Outbound call logged',
      created_by: TEST_USERS.admin.id,
    });

    // …and the two anchors it did not name have empty feeds, read back over HTTP.
    const leadFeed = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));
    expect(leadFeed.body.events).toHaveLength(0);
    const jobFeed = await request(app).get(`/api/jobs/${JOB_ID}/timeline`).set(authHeader('admin'));
    expect(jobFeed.body.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ENTRY AND ITS AUDIT EVENT ARE ONE FACT (C15).
//
// The two used to be separate statements, and the gap between them opened for real: a QA runner
// SIGKILLed the backend mid-request and left entry 85eca0ee-… in `manual_communication_logs` with
// no `timeline_events` row behind it. C14 makes that event deliberately immutable — the delete
// path leaves it standing, so that the one surface an auditor can read is not erasable by the
// person with the most reason to erase it — and an immutable trail with silent holes in it buys
// nothing, because a reader cannot tell a missing event from an entry nobody ever logged.
//
// WHAT THE CASE BELOW ASSERTS, and why it is not the shape of a call. "The writes were passed to
// $transaction" is exactly the intermediate-call assertion this feature's testing standard
// forbids, and it would stay green against a transaction that rolled nothing back. The claim here
// is the observable one: after the audit write fails, the lead's Communication timeline holds no
// entry for it — read back through the real endpoint, out of the same store the POST writes into.
//
// AND WHY IT DISCRIMINATES, which under a mocked Prisma is the whole difficulty. The usual double
// — `$transaction.mockImplementation((fn) => fn(mockPrisma))` — passes a rollback assertion
// whether or not anything is wrapped, because it never undoes anything; mocked Prisma hides this
// exact class of defect. `armAtomicTransaction` (see manual-log-transaction.ts) instead snapshots
// the stores it is given and restores them when the callback rejects. Revert the controller to
// the three loose writes and no `$transaction` call happens at all, so no snapshot is taken, the
// entry stays in the store, and the second half of this case goes red — mutation-proved, not
// assumed.
//
// A SUCCESSFUL create runs FIRST, and stays. It is the control: an empty timeline proves nothing
// if the arrangement could never have shown an entry in the first place. So the claim is that the
// count did not MOVE — one entry before the failure and one after — which is strictly stronger
// than "the timeline is empty", and it also pins that a rollback undoes only its own writes.
// ─────────────────────────────────────────────────────────────────────────────

describe('an entry and its audit event are all-or-nothing', () => {
  it('leaves no entry on the timeline when the audit event cannot be written', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });

    // One real store: the POST writes into it, the lead's Communication timeline reads out of it.
    // The filter is the one comm-manual-log.test.ts already proves renders an entry on that
    // endpoint — a store the read could not match would make the absence assertion vacuous.
    const entries: any[] = [];
    let n = 0;
    mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
      const row = { id: `11110000-0000-0000-0000-00000000010${++n}`, ...args.data };
      entries.push(row);
      return Promise.resolve(row);
    });
    mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        entries.filter(
          (r) => r.organization_id === where.organization_id && r.lead_id === where.lead_id,
        ),
      ),
    );
    // The other four arms of the aggregator, empty — the entry is the only thing on this lead.
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);

    const feed = stubActivityFeed();
    // Real all-or-nothing over BOTH stores, replacing the pass-through armed in beforeEach.
    armAtomicTransaction(entries, feed);

    // ── The control: one entry that really is logged, and really is visible. ──
    const ok = await request(app).post(ENDPOINT).set(authHeader('admin')).send(LEAD_BODY);
    expect(ok.status).toBe(201);

    const before = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));
    expect(before.status).toBe(200);
    expect(before.body.items.map((i: any) => i.id)).toEqual([ok.body.entry.id]);
    expect(feed).toHaveLength(1);

    // ── Now the audit event cannot be written. ──
    mockPrisma.timelineEvent.create.mockRejectedValue(new Error('timeline_events write failed'));

    const failed = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...LEAD_BODY, notes: 'The entry this request must not leave behind.' });
    expect(failed.status).toBe(500);

    // THE CLAIM. The lead's Communication timeline is exactly what it was: the caller was told
    // the log failed, and no entry exists that says otherwise. Asserted on the ids, so an entry
    // that survived the failure could not hide behind the control's presence.
    const after = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));
    expect(after.status).toBe(200);
    expect(after.body.items.map((i: any) => i.id)).toEqual([ok.body.entry.id]);
    expect(after.body.items.map((i: any) => i.preview)).not.toContain(
      'The entry this request must not leave behind.',
    );

    // The other half of the pair, on the activity feed the rollback protects: still the one event
    // the successful create wrote, and no half-written second one.
    const activity = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));
    expect(activity.body.events).toHaveLength(1);
    expect(activity.body.events[0].description).toBe('Outbound call logged');

    // Whatever else a failed create may do, it still wakes nothing.
    expectNothingWokenUp();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SILENCE.
//
// Asserted against the DISPATCHER ITSELF — a spy that is never called — and never inferred from
// an absence of observed side effects. `dispatchAutomationEvent` is fire-and-forget through
// `setImmediate` and `emit` swallows every failure it meets, so both can be wired in and leave
// the HTTP response, the timeline and the notifications list byte-identical. A test built on
// what it can observe afterwards would stay green in exactly the world this slice exists to
// prevent.
//
// See manual-log-silence.ts for what `expectNothingWokenUp` asserts and why it fails loudly
// rather than silently when a suite forgets to arm the spies.
// ─────────────────────────────────────────────────────────────────────────────

describe('logging a communication wakes nothing', () => {
  /** Every arrangement the create path can take, so silence is asserted on all of them. */
  function arrangeCreate() {
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    stubCreate();
    stubActivityFeed();
  }

  it('dispatches no automation and raises no notification when logging on a lead', async () => {
    mockAuthAs('admin');
    arrangeCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(LEAD_BODY);

    expect(res.status).toBe(201);
    expectNothingWokenUp();
  });

  it('dispatches no automation and raises no notification when logging on a customer', async () => {
    mockAuthAs('admin');
    arrangeCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(CUSTOMER_BODY);

    expect(res.status).toBe(201);
    expectNothingWokenUp();
  });

  it('dispatches no automation and raises no notification when logging on a job', async () => {
    mockAuthAs('admin');
    arrangeCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);

    expect(res.status).toBe(201);
    expectNothingWokenUp();
  });

  // The one that actually protects the onboarding use case. An outbound entry on a lead also
  // STAMPS `contacted_at` (slice 7) — a real write to lead state, and precisely the kind of change
  // that elsewhere in this codebase is followed by a dispatch. A hundred of them in a row must
  // still wake nothing.
  it('stays silent through a hundred entries logged back to back', async () => {
    mockAuthAs('admin');
    arrangeCreate();

    const feed = stubActivityFeed();
    const channels = ['call', 'sms', 'email'] as const;

    for (let i = 0; i < 100; i++) {
      const onLead = i % 2 === 0;
      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({
          ...(onLead ? { lead_id: LEAD_ID } : { job_id: JOB_ID }),
          channel: channels[i % 3],
          direction: i % 4 === 0 ? 'in' : 'out',
          // Spread across three months, the way a real backfill is.
          occurred_at: `2026-0${(i % 3) + 5}-${String((i % 27) + 1).padStart(2, '0')}T09:30`,
          notes: `Backfilled conversation ${i} from the old system.`,
        });
      expect(res.status).toBe(201);
    }

    // One event per entry — the silence is not the silence of nothing having happened.
    expect(feed).toHaveLength(100);
    expectNothingWokenUp();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDITING AND DELETING WAKE NOTHING EITHER (slice 8).
//
// Slice 9 could only cover CREATE: update and delete did not exist, and a test asserting silence
// against the router's 404 would have asserted nothing at all. These are the cases the tripwire
// below sent slice 8 here to write.
//
// Each drives a REAL create first, so the activity feed genuinely has an event in it. "The feed
// gained no event" then means the count did not move — which is a different, and much stronger,
// claim than "the feed is empty", and it is the one that would fail if an edit started writing
// its own "communication edited" row.
// ─────────────────────────────────────────────────────────────────────────────

/** The stored entry the update and delete handlers resolve, and the writes they then perform. */
function stubStoredEntry() {
  const rows: any[] = [];
  mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
    const row = {
      id: '11110000-0000-0000-0000-000000000001',
      duration_minutes: null,
      subject: null,
      job_id: null,
      lead_id: null,
      customer_id: null,
      ...args.data,
    };
    rows.push(row);
    return Promise.resolve(row);
  });
  mockPrisma.manualCommunicationLog.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
  );
  mockPrisma.manualCommunicationLog.update.mockImplementation((args: any) => {
    const row = rows.find((r) => r.id === args.where.id);
    Object.assign(row, args.data);
    return Promise.resolve(row);
  });
  mockPrisma.manualCommunicationLog.delete.mockImplementation(({ where }: any) =>
    Promise.resolve(rows.splice(rows.findIndex((r) => r.id === where.id), 1)[0]),
  );
  return rows;
}

/** The corrected entry, in full — the update endpoint replaces the editable record. */
const EDIT_BODY = {
  lead_id: LEAD_ID,
  channel: 'call' as const,
  direction: 'in' as const,
  occurred_at: '2026-08-25T09:30',
  notes: 'Corrected: he rang US, on the Monday.',
  performed_by: TEST_USERS.admin.id,
};

describe('editing and deleting an entry wake nothing', () => {
  function arrange() {
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    stubStoredEntry();
    return stubActivityFeed();
  }

  it('writes no activity event, dispatches no automation and raises no notification on an EDIT', async () => {
    mockAuthAs('admin');
    const feed = arrange();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(LEAD_BODY);
    expect(created.status).toBe(201);
    // The create's own event — the baseline the edit must not move.
    expect(feed).toHaveLength(1);

    const edited = await request(app)
      .put(`${ENDPOINT}/${created.body.entry.id}`)
      .set(authHeader('admin'))
      .send(EDIT_BODY);

    expect(edited.status).toBe(200);
    expect(feed).toHaveLength(1);
    expectNothingWokenUp();

    // Read back through the real endpoint, not only off the fixture: the lead's activity feed
    // still shows the one event the CREATE wrote, and nothing about the correction.
    const activity = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));
    expect(activity.body.events).toHaveLength(1);
    expect(activity.body.events[0].description).toBe('Outbound call logged');
  });

  it('writes no activity event, dispatches no automation and raises no notification on a DELETE', async () => {
    mockAuthAs('admin');
    const feed = arrange();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(LEAD_BODY);
    expect(created.status).toBe(201);
    expect(feed).toHaveLength(1);

    const removed = await request(app)
      .delete(`${ENDPOINT}/${created.body.entry.id}`)
      .set(authHeader('admin'));

    expect(removed.status).toBe(204);
    expectNothingWokenUp();

    // NO "deleted" event is written — and the CREATE's event is deliberately left standing. An
    // audit trail a deletion can erase is a weak audit trail: "a human added a record here, and
    // this is who" stays true after the record is removed, and it is exactly what somebody
    // auditing a disputed entry needs to be able to read. See the delete handler's own comment.
    expect(feed).toHaveLength(1);
    const activity = await request(app)
      .get(`/api/leads/${LEAD_ID}/timeline`)
      .set(authHeader('admin'));
    expect(activity.body.events).toHaveLength(1);
    expect(activity.body.events[0].description).toBe('Outbound call logged');
  });

  it('stays silent through a hundred corrections back to back', async () => {
    mockAuthAs('admin');
    const feed = arrange();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(LEAD_BODY);
    expect(created.status).toBe(201);

    for (let i = 0; i < 100; i++) {
      const res = await request(app)
        .put(`${ENDPOINT}/${created.body.entry.id}`)
        .set(authHeader('admin'))
        .send({ ...EDIT_BODY, notes: `Correction pass ${i}.` });
      expect(res.status).toBe(200);
    }

    // Still the one event the create wrote — the silence is not the silence of nothing happening.
    expect(feed).toHaveLength(1);
    expectNothingWokenUp();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE ROUTER MOUNTS.
//
// An enumeration of the verbs this router genuinely handles, so that a NEW mutating verb cannot
// be added without somebody being sent to the silence suite above. It was a tripwire for slice 8
// and it fired: the list below is what slice 8 grew it to.
// ─────────────────────────────────────────────────────────────────────────────

/** Every `verb path` this router mounts a handler for, read off the live Express stack. */
function mountedRoutes(): string[] {
  const stack = (manualLogRouter as any).stack as any[];
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => `${m.toUpperCase()} ${layer.route.path}`),
    )
    .sort();
}

describe('the manual-log router mounts only what has been proved silent', () => {
  it('mounts exactly three mutating verbs — create, update and delete', () => {
    // `router.all([...], 404)` is a catch-all, not a handler, so it appears here as a route for
    // every verb. Only what is genuinely handled is interesting.
    const handled = mountedRoutes().filter((r) => !r.endsWith('/manual-log/*'));
    const mutating = handled.filter((r) => /^(POST|PATCH|PUT|DELETE) /.test(r));

    expect(
      mutating,
      'A new mutating verb is mounted on the manual-log router. Every path here must be proved ' +
        'to dispatch no automation and raise no notification, and — for anything but the create ' +
        '— to add no activity event. Add a case above that reaches the new handler with real ' +
        'fixtures and calls expectNothingWokenUp(), then update this list.',
    ).toEqual(['DELETE /manual-log/:id', 'POST /manual-log', 'PUT /manual-log/:id']);
  });

  // ── C13. WHAT THIS TEST ACTUALLY PINS, which is less than its predecessor claimed. ──────────
  //
  // Its pre-slice-8 version was commented as pinning "this router's own mount and terminator".
  // It does not, and that was proven twice by the slice 9 verifier: unmounting the manual-log
  // router from app.ts entirely left all three verbs still passing, and repointing the same
  // assertions at /api/communication/definitely-not-a-manual-log/xyz left the whole file green.
  //
  // The 401 comes from SEVEN SIBLING ROUTERS' path-unscoped `router.use(authenticate, …)` on the
  // shared /api/communication base — comm-agents, comm-calls, comm-config, comm-numbers,
  // comm-number-assignments, comm-phone-access and comm-threads all call it with no path — not
  // from this router. And the 404 is indistinguishable from the app's own fallback, which
  // answers with the byte-identical `{ error: 'Not found' }` at app.ts:464. Re-checked against a
  // running server: PATCH /api/communication/definitely-not-a-manual-log/xyz returns the SAME
  // 401 anonymously and the SAME 404 authenticated.
  //
  // So what it pins is only this: a verb this router does not handle is challenged for
  // credentials like any other authenticated path under that base, and is then refused rather
  // than falling through into a sibling's handler or a phone entitlement gate. That is worth
  // keeping — it is the assertion that would fail if `/manual-log/:id` ever started matching a
  // phone route — but it is NOT coverage of this router's mount, of its terminator, or of the
  // update and delete handlers. Those are covered above.
  //
  // PATCH is the only mutating verb left unhandled. PUT and DELETE were in this list until slice
  // 8 mounted real handlers on them; asserting a 404 against them now would assert that the
  // handler could not find a row, which is a different fact wearing the same status code.
  it('challenges, and then refuses, a verb it does not handle — writing no activity event and waking nothing', async () => {
    const path = `${ENDPOINT}/11110000-0000-0000-0000-000000000001`;

    const anonymous = await request(app).patch(path).send({ notes: 'Edited after the fact.' });
    expect(anonymous.status).toBe(401);

    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const feed = stubActivityFeed();

    const res = await request(app)
      .patch(path)
      .set(authHeader('admin'))
      .send({ notes: 'Edited after the fact.' });

    expect(res.status).toBe(404);
    expect(feed).toHaveLength(0);
    expectNothingWokenUp();
  });
});
