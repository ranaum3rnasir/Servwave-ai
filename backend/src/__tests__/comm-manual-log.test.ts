// Manual Communication Log — slice 1 (spec:
// md_files/specs/communication/2026-08-27-manual-communication-log.md).
//
// A user holding the new `log_past Communication` ability records, by hand, a
// call that already happened on a lead. It lands in that lead's Communication
// timeline and NOWHERE in the Communication module.
//
// Pattern follows lead-communications.test.ts: supertest against the real
// Express app with a fully-mocked Prisma, the shared auth helper, and two
// organisation fixtures for the tenancy assertions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, LEAD_FIXTURE, TEST_USERS } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { orgDayOf } from '../lib/orgDayRange';
import { formatInTimeZone } from 'date-fns-tz';
import { matchesWhere } from './whereMatcher';
import { armAtomicTransaction } from './manual-log-transaction';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

const LEAD_ID = LEAD_FIXTURE.id;
const JOB_ID = 'bb000000-0000-0000-0000-000000000011';
const ENDPOINT = '/api/communication/manual-log';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // The create path writes inside one interactive transaction (C15), and setup.ts ships
  // `$transaction` as a bare vi.fn() with no implementation — unarmed, it returns undefined and
  // the callback never runs. No journals are passed here: this suite drives the happy path, and a
  // pass-through is honest about proving nothing on its own. The rollback claim is made, and
  // mutation-proved, in comm-manual-log-audit.test.ts.
  armAtomicTransaction();
});

/** The org's configured zone. See invoice-overdue-org-clock.test.ts for the idiom. */
function orgTimezone(tz: string) {
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: tz });
}

/** Echo the created row back the way Prisma would, so the response is built from real data. */
function stubCreate() {
  mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) =>
    Promise.resolve({
      id: '11110000-0000-0000-0000-000000000001',
      created_at: new Date('2026-08-27T10:00:00.000Z'),
      updated_at: new Date('2026-08-27T10:00:00.000Z'),
      duration_minutes: null,
      subject: null,
      job_id: null,
      lead_id: null,
      customer_id: null,
      ...args.data,
    }),
  );
}

const VALID_BODY = {
  lead_id: LEAD_ID,
  direction: 'out',
  occurred_at: '2026-08-26T16:00',
  notes: 'Spoke to John from my mobile — he wants a quote for the two garage doors.',
};

/** The same entry, anchored on a JOB instead - the other half of the XOR (slice 5). */
const JOB_BODY = {
  job_id: JOB_ID,
  direction: 'out' as const,
  occurred_at: '2026-08-26T16:00',
  notes: 'Rang the customer from my mobile to confirm the install window.',
};

describe('POST /api/communication/manual-log', () => {
  it('records a past call on a lead for a user holding the ability', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({
      channel: 'call',
      direction: 'out',
      leadId: LEAD_ID,
      notes: VALID_BODY.notes,
      // ONE wire shape for one row. The same entity read back through the timeline carries this
      // (it is what the "Logged" chip renders from), so the create response has to as well - a
      // client that rendered the POST result would otherwise draw an unmarked row.
      manuallyLogged: true,
    });
    expect(res.body.entry.id).toBeTruthy();
    // 4pm on the org's clock (New York, UTC-4 in August) is 20:00 UTC.
    expect(res.body.entry.occurredAt).toBe('2026-08-26T20:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PAIR. The feature's central constraint is not "the entry shows on the lead"; it is "the
// entry shows on the lead AND NOWHERE in the Communication module". Asserting only the first
// half would stay green if a later change started writing these into call_sessions, which is the
// exact failure the dedicated table exists to make impossible. Both halves therefore live in ONE
// test, driven by ONE create.
//
// The stubs are a shared in-memory store rather than canned return values: the POST really
// writes, both reads really query, and the call list is deliberately NON-EMPTY (a genuine
// platform call sits in it), so "absent" means absent from a populated list rather than from an
// empty one.
// ─────────────────────────────────────────────────────────────────────────────

/** A real CTM-ingested call on the same lead, an hour after the logged one. */
const PLATFORM_CALL = {
  id: 'ca000000-0000-0000-0000-000000000001',
  direction: 'in',
  from_number: '+12125551042',
  to_number: '+15125550100',
  status: 'completed',
  duration_sec: 95,
  started_at: new Date('2026-08-26T21:00:00.000Z'),
  disposition: null,
  summary: 'Customer called back about the quote.',
  answered_by: { kind: 'csr', name: 'Dana Reyes' },
  lead_id: LEAD_ID,
  customer_id: null,
  customer: null,
  job_id: null,
  job_label: null,
  organization_id: ALPHA_ORG_ID,
};

describe('a logged entry is on the lead timeline and NOWHERE in the Communication module', () => {
  it('appears in the lead timeline in chronological position, and is absent from the calls list', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });

    // One shared store: the POST writes into it, the lead timeline reads out of it.
    const logged: any[] = [];
    mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
      const row = { id: '11110000-0000-0000-0000-000000000001', ...args.data };
      logged.push(row);
      return Promise.resolve(row);
    });
    mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        logged.filter((r) => r.organization_id === where.organization_id && r.lead_id === where.lead_id),
      ),
    );
    // The Communication module reads call_sessions, and so does the lead timeline's call arm.
    mockPrisma.callSession.findMany.mockResolvedValue([PLATFORM_CALL]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);
    expect(created.status).toBe(201);
    const entryId = created.body.entry.id;

    // ── Present: the lead's Communication timeline ──
    const timeline = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));

    expect(timeline.status).toBe(200);
    const ids = timeline.body.items.map((i: any) => i.id);
    expect(ids).toContain(entryId);
    // Chronological position among the real communications: logged at 16:00 org time (20:00Z),
    // the platform call an hour later - the logged entry sorts FIRST, not into a separate group.
    expect(ids).toEqual([entryId, PLATFORM_CALL.id]);

    const item = timeline.body.items.find((i: any) => i.id === entryId);
    expect(item).toMatchObject({ channel: 'call', direction: 'out', manuallyLogged: true });
    expect(item.preview).toBe(VALID_BODY.notes);
    // The platform call is NOT marked - the flag is what the "Logged" chip renders from.
    expect(timeline.body.items.find((i: any) => i.id === PLATFORM_CALL.id).manuallyLogged).toBeUndefined();

    // ── Absent: the Communication module's call list ──
    const calls = await request(app).get('/api/communication/calls').set(authHeader('admin'));

    expect(calls.status).toBe(200);
    expect(calls.body.calls.map((c: any) => c.id)).toEqual([PLATFORM_CALL.id]);
    expect(calls.body.calls.map((c: any) => c.id)).not.toContain(entryId);

    // ...and absent from agent performance metrics and call reports, which is the SAME fact:
    // every one of those surfaces is fed by call_sessions (the Performance view is handed the
    // payload above as `calls: CallSession[]`; there is no second aggregation). Logging wrote no
    // call record at all, so there is nothing for a future report to forget to filter out.
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.upsert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORG CLOCK. A test that does not discriminate proves nothing here, so the fixture is built
// so that all three readings of the same wall clock differ:
//
//   picked            2026-08-27 09:00, zoneless
//   ORG   (Auckland)  2026-08-26T21:00:00.000Z   <- the only correct answer
//   USER  (Los Angeles, pinned below)  2026-08-27T16:00:00.000Z
//   SERVER (UTC, which is what production runs as)  2026-08-27T09:00:00.000Z
//
// The user's zone differs from the org's, and the user's naive local DATE (the 27th) differs from
// the stored instant's UTC date (the 26th) - so composing against the browser, the server, or a
// bare `new Date(value)` each lands on a visibly different day.
// ─────────────────────────────────────────────────────────────────────────────

const AUCKLAND = 'Pacific/Auckland';
const PICKED = '2026-08-27T09:00';
const ORG_TRUTH = '2026-08-26T21:00:00.000Z';

describe('occurred_at is composed against the ORGANISATION timezone', () => {
  const realTZ = process.env.TZ;
  // The user's/browser's zone, and the zone the server process itself is standing in. Node
  // re-reads process.env.TZ on mutation, so this really does move `new Date(naive)`.
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterEach(() => {
    /**
     * RESTORED AS ABSENT, not as the STRING "undefined".
     *
     * `process.env` coerces every assignment to a string, so `process.env.TZ = undefined` sets
     * TZ="undefined" - not a zone, and one Node resolves by falling back to UTC. The damage is not
     * local: `process.env` is shared by every file a vitest worker thread runs, so from here on
     * `new Date('2026-08-26T16:00')` in ANY later suite would be parsed as UTC rather than as the
     * machine's local zone, and every downstream assertion about local time would quietly stop being
     * able to fail. Planting that inside the suites written to guard against exactly this would be
     * the repo's dominant defect class, self-inflicted.
     */
    if (realTZ === undefined) delete process.env.TZ;
    else process.env.TZ = realTZ;
  });

  it('lands on the org day the user picked, not the user\'s day and not the server\'s', async () => {
    mockAuthAs('admin');
    orgTimezone(AUCKLAND);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: PICKED });

    expect(res.status).toBe(201);
    expect(res.body.entry.occurredAt).toBe(ORG_TRUTH);

    // The fixture really is discriminating: neither the user's zone nor the server's UTC reading
    // of the same string produces that instant.
    expect(res.body.entry.occurredAt).not.toBe(new Date(PICKED).toISOString());
    expect(res.body.entry.occurredAt).not.toBe(`${PICKED}:00.000Z`);
    // And the day genuinely straddles: the org calls it the 27th, UTC calls it the 26th.
    expect(orgDayOf(new Date(res.body.entry.occurredAt), AUCKLAND)).toBe('2026-08-27');
    expect(res.body.entry.occurredAt.slice(0, 10)).toBe('2026-08-26');
  });

  it('resolves per organisation - the same wall clock lands elsewhere for an org in another zone', async () => {
    mockAuthAs('orgB_admin');
    orgTimezone('America/Denver');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send({ ...VALID_BODY, occurred_at: PICKED });

    expect(res.status).toBe(201);
    // Denver is UTC-6 in August; Auckland is UTC+12. Same input, 18 hours apart.
    expect(res.body.entry.occurredAt).toBe('2026-08-27T15:00:00.000Z');
    expect(res.body.entry.occurredAt).not.toBe(ORG_TRUTH);
  });

  it('refuses an occurred_at that already carries a zone, so no client can impose its own', async () => {
    mockAuthAs('admin');
    orgTimezone(AUCKLAND);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: '2026-08-27T09:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AN ENTRY RECORDS SOMETHING THAT ALREADY HAPPENED, so `occurred_at` may not be in the future.
//
// Observed, not hypothetical: a call stamped 09:00 America/New_York was saved at 08:47, thirteen
// minutes before it happened. DateTimePicker defaults an unset time to 09:00 when a DATE is
// picked, so choosing "today" any morning before nine silently produces a future timestamp.
//
// The consequence is not cosmetic. The Communication tab renders newest-first, so the entry sorts
// above every real one; and on an OUTBOUND entry `recordLeadOutboundContact` stamps the lead's
// `contacted_at` with this very value, first-write-wins and therefore permanently.
//
// EVERY VALUE HERE IS BUILT FROM `Date.now()`, never hardcoded. A fixed literal would drift into
// the past as the wall calendar advanced and the suite would go green for the wrong reason —
// which is the same class of never-failing test the fixtures below are shaped to avoid.
// ──────────────────────────────────────────────────────────────────────────────

/** `Date.now()` offset by `ms`, as the ORG-zone wall clock a picker would emit for it. */
function orgWallClock(tz: string, ms = 0): string {
  return formatInTimeZone(new Date(Date.now() + ms), tz, "yyyy-MM-dd'T'HH:mm");
}

const MINUTE = 60_000;

describe('occurred_at may not be in the future', () => {
  it('refuses a conversation dated ahead of now, and says why', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: orgWallClock('America/New_York', 2 * 60 * MINUTE) });

    expect(res.status).toBe(400);
    // The message reaches the drawer verbatim through extractApiError, so it is asserted as
    // prose a user reads rather than as "some 400 happened".
    expect(res.body.details).toEqual([
      {
        field: 'occurred_at',
        message: 'must not be in the future - this records a conversation that already happened',
      },
    ]);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // THE OTHER HALF. Without it the refusal above is equally satisfied by an endpoint that refuses
  // every occurred_at, or one that refuses anything not comfortably in the past.
  it('accepts the conversation that just happened - the org-zone wall clock of NOW', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: orgWallClock('America/New_York') });

    expect(res.status).toBe(201);
    expect(mockPrisma.manualCommunicationLog.create).toHaveBeenCalled();
  });

  it('accepts a conversation from an hour ago', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: orgWallClock('America/New_York', -60 * MINUTE) });

    expect(res.status).toBe(201);
  });

  // THE GRACE WINDOW, pinned from both sides so the constant is a decision rather than an
  // accident. Two minutes ahead is a clock that disagrees slightly; ten minutes ahead is a
  // conversation that has not happened. A strict `> now` check fails the first of these.
  it('tolerates a couple of minutes of clock skew but not ten', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const withinSkew = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: orgWallClock('America/New_York', 2 * MINUTE) });
    expect(withinSkew.status).toBe(201);

    const beyondSkew = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: orgWallClock('America/New_York', 10 * MINUTE) });
    expect(beyondSkew.status).toBe(400);
  });

  // ────────────────────────────────────────────────────────────────────────
  // THE PAIR A NAIVE FIX FAILS. "In the future" is a question about the ORGANISATION's clock, and
  // the two tests below straddle it: each one is future on one clock and past on the other, so an
  // implementation that compares the wall-clock STRING (or resolves it against the server's own
  // zone, which is UTC in production) gets exactly one of them wrong.
  //
  // TZ is pinned to UTC here so the server's local reading and the string-as-UTC reading collapse
  // into the same wrong answer — a wrong fix cannot pass by accident of the developer's machine.
  // ────────────────────────────────────────────────────────────────────────
  describe('the future is measured on the ORG clock, not the wire string and not the server', () => {
    const realTZ = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = 'UTC';
    });
    afterEach(() => {
      /**
       * RESTORED AS ABSENT, not as the STRING "undefined".
       *
       * `process.env` coerces every assignment to a string, so `process.env.TZ = undefined` sets
       * TZ="undefined" - not a zone, and one Node resolves by falling back to UTC. The damage is not
       * local: `process.env` is shared by every file a vitest worker thread runs, so from here on
       * `new Date('2026-08-26T16:00')` in ANY later suite would be parsed as UTC rather than as the
       * machine's local zone, and every downstream assertion about local time would quietly stop being
       * able to fail. Planting that inside the suites written to guard against exactly this would be
       * the repo's dominant defect class, self-inflicted.
       */
      if (realTZ === undefined) delete process.env.TZ;
      else process.env.TZ = realTZ;
    });

    it('refuses a wall clock that is future for the ORG though its bare string is already past in UTC', async () => {
      mockAuthAs('admin');
      // New York is UTC-4 in August, so the CURRENT UTC wall clock names a moment four hours
      // ahead on the org's own clock: a naive `new Date(value)` reads it as now-ish and lets it
      // through.
      orgTimezone('America/New_York');
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubCreate();

      const asUtcNow = orgWallClock('UTC');
      // The fixture really does straddle: read as UTC the string is not ahead of now at all.
      expect(new Date(`${asUtcNow}:00.000Z`).getTime()).toBeLessThanOrEqual(Date.now());

      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, occurred_at: asUtcNow });

      expect(res.status).toBe(400);
      expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
    });

    it('accepts a wall clock that is past for the ORG though its bare string is hours ahead in UTC', async () => {
      mockAuthAs('admin');
      // Auckland is UTC+12, so a minute ago on the org's clock reads as twelve hours from now if
      // the string is taken for UTC: an implementation that compares the string refuses a
      // conversation that plainly already happened.
      orgTimezone(AUCKLAND);
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubCreate();

      const aMinuteAgoInAuckland = orgWallClock(AUCKLAND, -MINUTE);
      expect(new Date(`${aMinuteAgoInAuckland}:00.000Z`).getTime()).toBeGreaterThan(Date.now());

      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, occurred_at: aMinuteAgoInAuckland });

      expect(res.status).toBe(201);
    });
  });
});

describe('the entry names exactly one of lead or job', () => {
  it('rejects an entry naming BOTH a lead and a job', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, job_id: JOB_ID });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // The OTHER half of the XOR, and the half slice 1 could write but never read back: an entry
  // naming a job ALONE is a complete entry. Without this the two refusals around it would be
  // equally satisfied by an endpoint that refused every job anchor outright.
  it('accepts an entry naming ONLY a job', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    stubCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);

    expect(res.status).toBe(201);
    expect(res.body.entry.jobId).toBe(JOB_ID);
    expect(res.body.entry.leadId).toBeNull();
  });

  it('rejects an entry naming NEITHER', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubCreate();

    const { lead_id: _omitted, ...noAnchor } = VALID_BODY;
    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(noAnchor);

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  it('rejects an entry with no notes, no direction, or no occurred_at - all three are required', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubCreate();

    for (const patch of [{ notes: '   ' }, { direction: undefined }, { occurred_at: undefined }]) {
      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, ...patch });
      expect(res.status).toBe(400);
    }
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TENANCY, through behaviour.
//
// Leads are a FILTERING in-memory store rather than a canned `null`, the same idiom as the pair
// test's manual-log store above. The point is that the 404 has to FALL OUT of the requester's
// organisation not containing the row - if it came from a mock told to answer null, the only
// thing left holding `tenantWhere(req)` in place would be an assertion about the shape of a
// Prisma call, which is exactly what this feature's testing standard forbids.
//
// The lead id below is REAL and belongs to org A. That distinction is load-bearing: a random
// uuid would exercise "unknown id", a different code path from "exists, but not yours" - so the
// same id is posted twice, once by each organisation's admin, and only the owner's succeeds.
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA_LEAD = { id: LEAD_ID, organization_id: ALPHA_ORG_ID };
const ORG_B_LEAD = { id: 'e0000000-0000-0000-0000-0000000000b2', organization_id: ORG_B_ID };
const ALPHA_JOB = { id: JOB_ID, organization_id: ALPHA_ORG_ID };
/** A REAL job, belonging to org B. Not a random uuid - see the job tenancy spec for why. */
const ORG_B_JOB = { id: 'bb000000-0000-0000-0000-0000000000b2', organization_id: ORG_B_ID };

/**
 * `lead.findFirst` answering out of a two-org store, filtered the way the database would: a
 * `where` that carries no `organization_id` really does match across organisations. That
 * faithfulness is the whole point — drop `tenantWhere(req)` from the resolve and this fake hands
 * org A's lead to org B, so the refusal below turns into a 201 rather than into a mock artefact.
 */
function leadStore(...rows: { id: string; organization_id: string }[]) {
  mockPrisma.lead.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(
      rows.find(
        (r) =>
          r.id === where.id &&
          (where.organization_id === undefined || r.organization_id === where.organization_id),
      ) ?? null,
    ),
  );
}

/** The job anchor's counterpart, filtered the same faithful way. */
function jobStore(...rows: { id: string; organization_id: string }[]) {
  mockPrisma.job.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(
      rows.find(
        (r) =>
          r.id === where.id &&
          (where.organization_id === undefined || r.organization_id === where.organization_id),
      ) ?? null,
    ),
  );
}

/**
 * `user.findFirst` answering out of the shared TEST_USERS roster — which already spans BOTH
 * organisations — filtered the same faithful way as `leadStore` above. The performer resolve is
 * the second place `tenantWhere(req)` has to hold, and this is what makes its absence visible.
 */
function userStore() {
  mockPrisma.user.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(
      Object.values(TEST_USERS).find(
        (u) =>
          u.id === where.id &&
          (where.organization_id === undefined || u.organization_id === where.organization_id),
      ) ?? null,
    ),
  );
}

/** The joined-user shape an `include` resolves to, from the same roster. */
function userById(id: string) {
  const u = Object.values(TEST_USERS).find((x) => x.id === id);
  return u ? { first_name: u.first_name, last_name: u.last_name } : null;
}

describe('tenancy', () => {
  it('rejects a lead belonging to another organisation as not-found, and writes nothing', async () => {
    orgTimezone('America/New_York');
    leadStore(ALPHA_LEAD, ORG_B_LEAD);
    stubCreate();

    // Org B's admin naming org A's lead. 404, not 403: the caller learns nothing about whether
    // the row exists elsewhere.
    mockAuthAs('orgB_admin');
    const refused = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send(VALID_BODY);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'Lead not found' });
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();

    // …and the SAME id from its own organisation is accepted, so the 404 above is a tenancy
    // refusal and not simply an id nothing recognises.
    clearTokenCache();
    clearPermissionCache();
    mockAuthAs('admin');
    const accepted = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(accepted.status).toBe(201);
    expect(accepted.body.entry.leadId).toBe(LEAD_ID);
  });

  // The job anchor's own tenancy (slice 5). The id posted below is a REAL job that really exists
  // in org A - which is the whole point: a random uuid would exercise "unknown id", a different
  // branch from "exists, but not yours", and would pass even if `tenantWhere(req)` were dropped
  // from the resolve. Posted twice against the same store, once by each organisation's admin.
  it('rejects a job belonging to another organisation as not-found, and writes nothing', async () => {
    orgTimezone('America/New_York');
    jobStore(ALPHA_JOB, ORG_B_JOB);
    stubCreate();

    mockAuthAs('orgB_admin');
    const refused = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send(JOB_BODY);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'Job not found' });
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();

    // Org B CAN log against its OWN job, so the refusal above is about whose job it is and not
    // about the endpoint refusing job anchors in general.
    const ownJob = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send({ ...JOB_BODY, job_id: ORG_B_JOB.id });

    expect(ownJob.status).toBe(201);
    expect(ownJob.body.entry.jobId).toBe(ORG_B_JOB.id);

    // …and so is the SAME id org B was refused, from the organisation that owns it.
    clearTokenCache();
    clearPermissionCache();
    mockAuthAs('admin');
    const accepted = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);

    expect(accepted.status).toBe(201);
    expect(accepted.body.entry.jobId).toBe(JOB_ID);
  });

  it('stamps the entry with the caller\'s organisation', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(mockPrisma.manualCommunicationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CREDITING THE COLLEAGUE WHO HAD THE CONVERSATION (slice 2).
//
// The feature's primary use case is an onboarding admin typing up conversations OTHER PEOPLE
// had. Recording the typist as the performer would credit the wrong person on every one of those
// entries, so the performer is chosen and the logger is not.
// ─────────────────────────────────────────────────────────────────────────────

describe('the performer is chosen; the logger is always the caller', () => {
  it('credits the colleague who had the conversation and the caller who typed it', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    leadStore(ALPHA_LEAD);
    userStore();
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(201);
    // Two different people, recorded independently - the whole point of the two columns.
    expect(res.body.entry.performedBy).toBe(TEST_USERS.sales.id);
    expect(res.body.entry.loggedBy).toBe(TEST_USERS.admin.id);
  });

  it('falls back to the caller when no performer is named', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    leadStore(ALPHA_LEAD);
    userStore();
    stubCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.entry.performedBy).toBe(TEST_USERS.admin.id);
    expect(res.body.entry.loggedBy).toBe(TEST_USERS.admin.id);
  });

  // Ids on their own credit nobody a reader can recognise. Once the two can differ, the timeline
  // has to NAME both, or "who had this conversation" is answerable only by a second lookup that
  // no reader of the timeline is going to make.
  //
  // The store below resolves relations the way Prisma does - ONLY the ones the `include` asks
  // for - so this pins the aggregator's join as well as its mapper: stop requesting the performer
  // and the name goes missing, exactly as it would against a real database.
  it('names both people on the lead timeline, not only their ids', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    leadStore(ALPHA_LEAD);
    userStore();
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);

    const logged: any[] = [];
    mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
      const row = { id: '11110000-0000-0000-0000-000000000001', ...args.data };
      logged.push(row);
      return Promise.resolve(row);
    });
    mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where, include }: any) =>
      Promise.resolve(
        logged
          .filter((r) => r.organization_id === where.organization_id && r.lead_id === where.lead_id)
          .map((r) => ({
            ...r,
            ...(include?.lead && { lead: { lead_number: 'L00001', customer: null } }),
            ...(include?.performer && { performer: userById(r.performed_by) }),
            ...(include?.logger && { logger: userById(r.logged_by) }),
          })),
      ),
    );

    const created = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, performed_by: TEST_USERS.sales.id });
    expect(created.status).toBe(201);

    const timeline = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));

    expect(timeline.status).toBe(200);
    const item = timeline.body.items.find((i: any) => i.id === created.body.entry.id);
    expect(item).toMatchObject({
      manuallyLogged: true,
      performedByName: 'Test Sales',
      loggedByName: 'Test Admin',
    });
  });

  // The logger is set at creation from the authenticated principal and is never a client input:
  // it is what tells an eyewitness record from a second-hand one, so a caller who could name it
  // could disown their own entry. The schema is `.strict()`, which refuses the field outright
  // rather than silently ignoring it.
  it('refuses a caller who tries to name the logger', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    leadStore(ALPHA_LEAD);
    userStore();
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, logged_by: TEST_USERS.sales.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // A REAL user of another organisation, not a random uuid: an unknown id exercises "no such
  // row", which is a different code path from "exists, but not yours". Without the tenant scope
  // on the performer resolve, this request would succeed and credit a stranger.
  it('rejects a performer from another organisation as not-found, and writes nothing', async () => {
    orgTimezone('America/New_York');
    leadStore(ALPHA_LEAD);
    userStore();
    stubCreate();

    mockAuthAs('admin');
    const refused = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, performed_by: TEST_USERS.orgB_admin.id });

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'Performer not found' });
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();

    // …and that same id IS a real user, accepted by the organisation it belongs to - so the 404
    // above is a tenancy refusal, not an unrecognised identifier.
    clearTokenCache();
    clearPermissionCache();
    mockAuthAs('orgB_admin');
    leadStore(ORG_B_LEAD);
    const accepted = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send({ ...VALID_BODY, lead_id: ORG_B_LEAD.id, performed_by: TEST_USERS.orgB_admin.id });

    expect(accepted.status).toBe(201);
    expect(accepted.body.entry.performedBy).toBe(TEST_USERS.orgB_admin.id);
  });
});

/**
 * A non-admin role that HOLDS the ability — the shape the Roles UI's sensitive switch writes.
 *
 * Built here rather than inherited, because `log_past` is deliberately absent from every role's
 * DEFAULT_GRANTS: the capability is off by default for every existing organisation, and turning
 * it on is an admin's deliberate act. One row, org-wide, exactly as `viewModelToGrants` emits it.
 */
function grantLogPastTo(role: 'SALES' | 'DISPATCHER' | 'TECHNICIAN') {
  mockPrisma.rolePermission.findMany.mockResolvedValue([
    ...DEFAULT_GRANTS.filter((g) => g.role === role),
    { role, action: 'log_past', subject: 'Communication', conditions: null },
  ]);
  clearPermissionCache();
}

describe('the new ability guards the endpoint', () => {
  it('records the performer and the logger as the current user', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.entry.performedBy).toBe(TEST_USERS.admin.id);
    expect(res.body.entry.loggedBy).toBe(TEST_USERS.admin.id);
  });

  // ADMIN reaches it through the manage-all short-circuit, which is why the capability is fully
  // usable in this slice with no roles-UI work. Everyone else is off by default (slice 4 adds the
  // toggle) - and critically, they all still hold `create Communication`, so this proves the
  // endpoint is NOT gated on the shared baseline.
  for (const role of ['sales', 'dispatcher', 'technician'] as const) {
    it(`refuses ${role}, who holds create Communication but not the new ability`, async () => {
      mockAuthAs(role);
      orgTimezone('America/New_York');
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubCreate();

      const res = await request(app).post(ENDPOINT).set(authHeader(role)).send(VALID_BODY);

      expect(res.status).toBe(403);
      expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
    });
  }

  it('401s an unauthenticated caller', async () => {
    stubCreate();
    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // THE POSITIVE CASE, which slice 1 could not write: until slice 4 shipped the roles-UI bundle,
  // `log_past` was unreachable for every non-admin role, so the refusals above were the only
  // thing testable and "the guard is on the right action" rested on them alone. A guard that
  // refused EVERYONE would have passed all four. This is the other half.
  for (const [role, key] of [['SALES', 'sales'], ['DISPATCHER', 'dispatcher'], ['TECHNICIAN', 'technician']] as const) {
    it(`admits ${role} once an admin has granted the capability`, async () => {
      mockAuthAs(key);
      grantLogPastTo(role);
      orgTimezone('America/New_York');
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubCreate();

      const res = await request(app).post(ENDPOINT).set(authHeader(key)).send(VALID_BODY);

      expect(res.status).toBe(201);
      expect(res.body.entry.loggedBy).toBe(TEST_USERS[key].id);
    });
  }
});

// The whole point of the feature is the organisation that never had ServWave Phone. Gating this
// router on the phone entitlement would 402 exactly the people it was built for.
describe('the router is NOT behind the phone entitlement middleware', () => {
  it('accepts an org whose plan lacks `phone`, in the same request pair that 402s a sibling phone route', async () => {
    mockAuthAs('admin', { plan: 'STARTER' });
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    stubCreate();

    // The fixture really does lack the entitlement - a phone-gated sibling on the SAME base path
    // refuses it. Without this half, a 201 below would prove nothing.
    const gated = await request(app).get('/api/communication/calls').set(authHeader('admin'));
    expect(gated.status).toBe(402);
    expect(gated.body.feature).toBe('phone');

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HOW LONG THE CALL WAS (slice 3).
//
// `duration_minutes` makes a long discovery call distinguishable from a thirty-second
// confirmation. It stays OPTIONAL, which is the assertion that protects every entry logged before
// slice 3: those rows carry NULL and have to read exactly as they did.
//
// Slice 3 shipped a SECOND optional detail here, `outcome`, meant to tell an ATTEMPT from a
// CONVERSATION. It is retired: phase 1 removed every reader and writer, phase 2 dropped the
// column and the `ManualCommOutcome` enum. What survives below is the API's refusal of the KEY,
// which is a `.strict()` schema behaviour and owes nothing to the column.
// ─────────────────────────────────────────────────────────────────────────────

describe('how long the call was - duration', () => {
  it('round-trips a duration in minutes', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, duration_minutes: 12 });

    expect(res.status).toBe(201);
    expect(res.body.entry.durationMinutes).toBe(12);
  });

  // The entry slice 1 could already record is STILL a complete entry. This is what protects
  // every row logged before this slice existed: they carry NULL in the duration column.
  it('accepts an entry naming no duration, and says so rather than inventing a value', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.entry.durationMinutes).toBeNull();
  });

  it('refuses a duration that is negative, fractional, or not a number at all', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    // '12' is refused alongside 'abc' deliberately: a numeric STRING is a client that has lost
    // track of its own types, and coercing it would let a broken form write a value nobody
    // typed. `null` too - an absent duration omits the field rather than naming nothing.
    for (const duration_minutes of [-1, -30, 2.5, 'abc', '12', null, true, {}]) {
      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, duration_minutes });

      expect(res.status).toBe(400);
    }
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // THE CEILING, which nothing else in this file exercises: delete `.max(...)` from the schema
  // and every other spec here stays green while an absurd duration stops being a 400 and becomes
  // an int4 overflow 500 at the column.
  //
  // The MESSAGE is asserted, not just the status, because it is the whole UX for this case: the
  // drawer deliberately does not restate the bound (one owner for the rule - see its comment), so
  // what the user is told about an absurd value is exactly what the server says here.
  it('refuses a duration longer than a day, and names the ceiling when it does', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const refused = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, duration_minutes: 1441 });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: 'Validation failed',
      details: [{ field: 'duration_minutes', message: 'must be at most 1440 minutes' }],
    });

    // 2_147_483_648 is one past a 4-byte integer - the value that reaches the column and 500s
    // when the ceiling is gone. A 500 tells the user nothing and looks like an outage.
    const overflow = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, duration_minutes: 2_147_483_648 });

    expect(overflow.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();

    // ...and a full day is ACCEPTED, so the rule is "at most a day" rather than "shorter than
    // whatever this test happened to send" - a ceiling lowered by mistake reddens here too.
    const accepted = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, duration_minutes: 1440 });

    expect(accepted.status).toBe(201);
    expect(accepted.body.entry.durationMinutes).toBe(1440);
  });

  // THE OUTCOME IS RETIRED, AND THE API SAYS SO OUT LOUD.
  //
  // The schema is `.strict()`, so an unknown key is a 400 rather than a silent drop. That is the
  // deliberate contract: a client still sending an outcome is a client operating on a version of
  // this product that no longer exists, and telling it nothing while discarding the value is how
  // a caller comes to believe it recorded something it did not.
  //
  // THE FIRST FOUR VALUES WERE VALID BEFORE THIS CHANGE. That is what makes this test able to
  // fail: it is a 201 on the old schema and a 400 on the new one.
  it('refuses a body naming an outcome at all, including the values that used to be valid', async () => {
    for (const outcome of [
      'connected',
      'no_answer',
      'voicemail',
      'callback_requested',
      'busy',
      'NO_ANSWER',
      '',
      42,
      null,
    ]) {
      clearTokenCache();
      clearPermissionCache();
      mockAuthAs('admin');
      orgTimezone('America/New_York');
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubCreate();

      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, outcome });

      expect(res.status).toBe(400);
      expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
    }
  });

  // The key is refused because it is UNKNOWN, not because it sat on the wrong channel - so it is
  // refused on all three, and the old `outcomeBelongsToACall` refinement it replaces is gone.
  it.each([['call'], ['sms'], ['email']])(
    'refuses an outcome on a %s alike - the key itself is unknown now',
    async (channel) => {
      mockAuthAs('admin');
      orgTimezone('America/New_York');
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubCreate();

      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, channel, outcome: 'voicemail' });

      expect(res.status).toBe(400);
      expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// …AND HOW THE TIMELINE READS IT.
//
// The two fields are DISPLAY ONLY, so the only thing that can be asserted about them is what a
// reader sees. These drive a real POST and a real GET of the lead timeline, so a change that
// stored the values but never surfaced them would fail here.
//
// The store below is the same faithful in-memory shape the tenancy and attribution suites above
// use: `create` really writes into it, `findMany` really filters it, and relations resolve only
// where the `include` asked for them.
// ─────────────────────────────────────────────────────────────────────────────

/** POST an entry, then read the lead timeline back, and return the item that entry became. */
async function loggedTimelineItem(body: Record<string, unknown>) {
  mockAuthAs('admin');
  orgTimezone('America/New_York');
  mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
  mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);

  const logged: any[] = [];
  mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
    const row = { id: '11110000-0000-0000-0000-000000000001', ...args.data };
    logged.push(row);
    return Promise.resolve(row);
  });
  mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where, include }: any) =>
    Promise.resolve(
      logged
        .filter((r) => r.organization_id === where.organization_id && r.lead_id === where.lead_id)
        .map((r) => ({
          ...r,
          ...(include?.lead && { lead: { lead_number: 'L00001', customer: null } }),
          ...(include?.performer && { performer: userById(r.performed_by) }),
          ...(include?.logger && { logger: userById(r.logged_by) }),
        })),
    ),
  );

  const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(body);
  expect(created.status).toBe(201);

  const timeline = await request(app)
    .get(`/api/leads/${LEAD_ID}/communications`)
    .set(authHeader('admin'));
  expect(timeline.status).toBe(200);

  return timeline.body.items.find((i: any) => i.id === created.body.entry.id);
}

describe('the timeline row surfaces how long the call was', () => {
  it('says how long an entry lasted', async () => {
    const item = await loggedTimelineItem({ ...VALID_BODY, duration_minutes: 12 });

    // Duration in the title, alongside the direction - exactly where a platform-recorded call
    // already carries its own ("Inbound call · 4m 07s"), so a reader scanning the column reads
    // one shape, not two.
    expect(item.title).toBe('Outbound call · 12m');
    // …and nothing else rides the row. The outcome that once put "Connected" here is retired;
    // `meta` survives only for a PLATFORM call's disposition (mapCall), which a logged entry has
    // no equivalent of.
    expect(item.meta).toBeUndefined();
  });

  it('keeps saying it on an inbound entry too', async () => {
    const item = await loggedTimelineItem({
      ...VALID_BODY,
      direction: 'in',
      duration_minutes: 1,
    });

    expect(item.title).toBe('Inbound call · 1m');
    expect(item.title).not.toContain('attempt');
  });

  // Zero is a real answer to "how long?" - a thirty-second confirmation rounds to it - and it is
  // a different statement from saying nothing, which is why it is rendered rather than dropped.
  it('says a zero-minute call lasted zero minutes rather than saying nothing', async () => {
    const item = await loggedTimelineItem({ ...VALID_BODY, duration_minutes: 0 });

    expect(item.title).toBe('Outbound call · 0m');
  });

  it('reads exactly as it did before this slice when the entry carries no duration', async () => {
    const item = await loggedTimelineItem(VALID_BODY);

    expect(item.title).toBe('Outbound call');
    expect(item.meta).toBeUndefined();
    // Everything slice 1 and slice 2 put on the row is untouched.
    expect(item).toMatchObject({
      channel: 'call',
      direction: 'out',
      manuallyLogged: true,
      leadId: LEAD_ID,
      leadLabel: 'L00001',
      loggedByName: 'Test Admin',
    });
    expect(item.preview).toBe(VALID_BODY.notes);
  });

  // AN ENTRY LOGGED BEFORE THIS SLICE EXISTED. Slice 1's controller never named these columns at
  // all, so such a row reaches the mapper with the keys ABSENT as well as null-valued - both
  // readings have to be the untouched slice-1 one, or shipping this slice would silently rewrite
  // history that is already in the database.
  it.each([
    ['columns absent, as slice 1 wrote them', {}],
    ['columns explicitly null', { duration_minutes: null }],
  ])('leaves an entry logged before this slice untouched (%s)', async (_name, columns) => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([
      {
        id: '11110000-0000-0000-0000-00000000009f',
        channel: 'CALL',
        direction: 'OUT',
        occurred_at: new Date('2026-08-26T20:00:00.000Z'),
        notes: 'Logged last month, long before anyone could say how it went.',
        performed_by: TEST_USERS.admin.id,
        logged_by: TEST_USERS.admin.id,
        lead_id: LEAD_ID,
        job_id: null,
        organization_id: ALPHA_ORG_ID,
        lead: { lead_number: 'L00001', customer: null },
        performer: userById(TEST_USERS.admin.id),
        logger: userById(TEST_USERS.admin.id),
        ...columns,
      },
    ]);

    const timeline = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));

    expect(timeline.status).toBe(200);
    const item = timeline.body.items[0];
    expect(item.title).toBe('Outbound call');
    expect(item.meta).toBeUndefined();
    expect(item.manuallyLogged).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 6 — THE OTHER TWO CHANNELS.
//
// A text sent from someone's own phone and an email sent from Outlook are the conversations the
// feature exists to capture just as much as a call from a personal mobile is. Channel stops
// being the constant `CALL` the API pinned in slice 1.
// ─────────────────────────────────────────────────────────────────────────────

describe('the channel is chosen, not pinned', () => {
  it('records a logged TEXT', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel: 'sms', notes: 'Texted him the arrival window from my phone.' });

    expect(res.status).toBe(201);
    expect(res.body.entry.channel).toBe('sms');
  });

  // C3 — THE TITLE FOLLOWS THE CHANNEL. `mapManual` read the row's `channel` column while
  // hardcoding the noun "call", which was harmless only for as long as CALL was the only value
  // anything could write. A logged text titled "Outbound call" is not a cosmetic slip: it states
  // that a phone conversation happened when none did.
  it('reads a logged text as a TEXT on the timeline, not as a call', async () => {
    const item = await loggedTimelineItem({
      ...VALID_BODY,
      channel: 'sms',
      notes: 'Texted him the arrival window from my phone.',
    });

    expect(item.channel).toBe('sms');
    expect(item.title).toBe('Outbound text');
    expect(item.title).not.toContain('call');
  });

  it('records a logged EMAIL, and reads it as an email on the timeline', async () => {
    const item = await loggedTimelineItem({
      ...VALID_BODY,
      channel: 'email',
      notes: 'Replied from Outlook with the revised scope.',
    });

    expect(item.channel).toBe('email');
    expect(item.title).toBe('Outbound email');
    expect(item.title).not.toContain('call');
  });

  // The subject line (user story 15) - what makes one logged email identifiable among several.
  // It rides the TITLE, the slot slice 3 put the duration in and the slot mapEmail already puts a
  // platform email's subject in. No new CommItem field for a consumer to forget to render.
  it('shows the subject of a logged email when one was given', async () => {
    const item = await loggedTimelineItem({
      ...VALID_BODY,
      channel: 'email',
      subject: 'Revised scope - two garage doors',
      notes: 'Replied from Outlook with the revised scope.',
    });

    expect(item.title).toBe('Outbound email · Revised scope - two garage doors');
  });

  // An email logged with no subject is a COMPLETE entry, not a partial one - somebody typing up
  // months of history will not remember every subject line. It reads as the channel and nothing
  // more, rather than as mapEmail's "(no subject)", which says a header was empty; here no header
  // was ever recorded.
  it('reads an email logged without a subject as an email, not as one with an empty subject', async () => {
    const item = await loggedTimelineItem({
      ...VALID_BODY,
      channel: 'email',
      notes: 'Replied from Outlook with the revised scope.',
    });

    expect(item.title).toBe('Outbound email');
    expect(item.title).not.toContain('no subject');
  });

  it('still logs a CALL when the client names no channel at all - every entry before slice 6 is one', async () => {
    const item = await loggedTimelineItem(VALID_BODY);

    expect(item.channel).toBe('call');
    expect(item.title).toBe('Outbound call');
  });

  it('refuses a channel outside the three supported ones', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();

    // In-person, voicemail-left, letters and walk-ins are explicitly out of scope - they have no
    // slot in CommItem's channel union. 'CALL' is refused alongside them because the wire
    // vocabulary is lower-case, and 'text' because the contract's word for the channel is 'sms'.
    for (const channel of ['whatsapp', 'in_person', 'letter', 'text', 'CALL', '', null, 42]) {
      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, channel });

      expect(res.status).toBe(400);
    }
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OPTIONAL FIELDS FOLLOW THE CHANNEL.
//
// A duration on an email and a subject on a call are not merely unused: they would be RENDERED.
// The timeline builds its title out of exactly these columns, so "Outbound email · 12m" is a
// statement about a conversation that never had a length. The rule is enforced at the API boundary rather than papered over in the
// mapper, so a broken client is told what is wrong instead of writing a row that reads as a lie.
// ─────────────────────────────────────────────────────────────────────────────

describe('the optional fields belong to their own channel', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();
  });

  it.each([['sms'], ['email']])('refuses a duration on a %s', async (channel) => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel, duration_minutes: 12 });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  it.each([['call'], ['sms']])('refuses a subject on a %s', async (channel) => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel, subject: 'Revised scope' });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // THE SUBJECT'S OWN BOUNDS, which nothing else in this file exercises - the same gap the
  // duration ceiling had until it was pointed out. A subject is a HEADER, not a body: the notes
  // carry what was said. Delete `.max(...)` or `.min(1)` and every other spec here stays green
  // while a 10,000-character "subject" becomes a timeline title, or a blank one becomes an
  // "Outbound email · " with nothing after it.
  it('refuses a subject longer than 500 characters, and accepts one exactly that long', async () => {
    const tooLong = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel: 'email', subject: 'x'.repeat(501) });

    expect(tooLong.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();

    // …and the bound itself, so a ceiling lowered by mistake reddens here too.
    const atTheBound = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel: 'email', subject: 'x'.repeat(500) });

    expect(atTheBound.status).toBe(201);
    expect(atTheBound.body.entry.subject).toHaveLength(500);
  });

  // A BLANK SUBJECT IS NOT A SUBJECT. Whitespace would otherwise reach the column and render as
  // a trailing "Outbound email · " with nothing after it - saying a header existed and was empty,
  // which is the one thing an entry with no subject does NOT say.
  it('refuses a blank subject rather than storing whitespace', async () => {
    for (const subject of ['', '   ', '\n\t']) {
      const res = await request(app)
        .post(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...VALID_BODY, channel: 'email', subject });

      expect(res.status).toBe(400);
    }
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // …and the pairings that DO belong still work, so the rule above is "each field with its own
  // channel" rather than "these fields are now unusable".
  it('keeps a duration on a call, and a subject on an email', async () => {
    const call = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel: 'call', duration_minutes: 12 });

    expect(call.status).toBe(201);
    expect(call.body.entry).toMatchObject({ durationMinutes: 12 });

    const email = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel: 'email', subject: 'Revised scope' });

    expect(email.status).toBe(201);
    expect(email.body.entry.subject).toBe('Revised scope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PAIR, RE-ASSERTED PER CHANNEL.
//
// Slice 1's exclusion holds because the Communication module reads call_sessions and a logged
// entry is not one. That argument does NOT carry over on its own once the channel picker ships:
// the module has a texts surface (GET /threads, reading message_threads) and an emails surface
// (GET /emails, reading emails), each its own query, and "a logged text is not a platform text"
// has to be true of THOSE lists too - it is the feature's central constraint, and asserting only
// that the entry reaches the timeline would leave it untested.
//
// Every platform list is POPULATED FIRST. Absence from an empty list proves nothing at all.
// ─────────────────────────────────────────────────────────────────────────────

/** A real platform text, in a real thread, on the same lead. */
const PLATFORM_THREAD = {
  id: 'th000000-0000-0000-0000-000000000001',
  channel: 'sms',
  campaign_type: null,
  unread: false,
  customer_id: null,
  customer: null,
  lead: null,
  lead_id: null,
  vendor: null,
  vendor_id: null,
  messages: [
    {
      id: 'ms000000-0000-0000-0000-000000000001',
      direction: 'in',
      body: 'Thursday works for the walkthrough.',
      ts: new Date('2026-08-26T21:00:00.000Z'),
      status: 'delivered',
      organization_id: ALPHA_ORG_ID,
    },
  ],
  organization_id: ALPHA_ORG_ID,
};

/** A real platform email, on the same lead. */
const PLATFORM_EMAIL = {
  id: 'em000000-0000-0000-0000-000000000001',
  account: 'user',
  from: { name: 'John Doe', email: 'john@doe.com' },
  to: 'me@org.com',
  subject: 'Re: the two garage doors',
  snippet: 'Sounds good.',
  body: ['Sounds good.'],
  at: '5:00 PM',
  ts: 1,
  created_at: new Date('2026-08-26T21:00:00.000Z'),
  unread: false,
  starred: false,
  folder: 'inbox',
  customer: null,
  customer_id: null,
  lead: null,
  lead_id: LEAD_ID,
  vendor: null,
  job_id: null,
  job_label: null,
  organization_id: ALPHA_ORG_ID,
};

describe('a logged text and a logged email reach the timeline and NOWHERE in the Communication module', () => {
  /** Every platform surface populated, and the manual log read out of one shared store. */
  function stubEveryChannel(logged: any[]) {
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
      const row = { id: `11110000-0000-0000-0000-00000000000${logged.length + 1}`, ...args.data };
      logged.push(row);
      return Promise.resolve(row);
    });
    mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        logged.filter((r) => r.organization_id === where.organization_id && r.lead_id === where.lead_id),
      ),
    );
    mockPrisma.callSession.findMany.mockResolvedValue([PLATFORM_CALL]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([PLATFORM_EMAIL]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.messageThread.findMany.mockResolvedValue([PLATFORM_THREAD]);
  }

  it('puts both in the lead timeline and neither in the calls, texts or emails lists', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubEveryChannel([]);

    const text = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, channel: 'sms', notes: 'Texted him the arrival window from my phone.' });
    const email = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({
        ...VALID_BODY,
        channel: 'email',
        subject: 'Revised scope - two garage doors',
        notes: 'Replied from Outlook with the revised scope.',
      });
    expect(text.status).toBe(201);
    expect(email.status).toBe(201);

    // ── Present: the lead's timeline, each reading as its own channel ──
    const timeline = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));
    expect(timeline.status).toBe(200);
    const items = timeline.body.items;
    const loggedText = items.find((i: any) => i.id === text.body.entry.id);
    const loggedEmail = items.find((i: any) => i.id === email.body.entry.id);

    expect(loggedText).toMatchObject({ channel: 'sms', manuallyLogged: true, title: 'Outbound text' });
    expect(loggedEmail).toMatchObject({
      channel: 'email',
      manuallyLogged: true,
      title: 'Outbound email · Revised scope - two garage doors',
    });
    // …in the chronology beside the REAL text and the REAL email, not in a group of their own.
    expect(items.map((i: any) => i.id)).toContain(PLATFORM_EMAIL.id);

    // ── Absent: the module's TEXTS list, which is populated ──
    const threads = await request(app).get('/api/communication/threads').set(authHeader('admin'));
    expect(threads.status).toBe(200);
    expect(threads.body.threads).toHaveLength(1);
    expect(JSON.stringify(threads.body)).not.toContain(text.body.entry.id);
    expect(JSON.stringify(threads.body)).not.toContain('arrival window');

    // ── Absent: the module's EMAILS list, which is populated ──
    const emails = await request(app).get('/api/communication/emails').set(authHeader('admin'));
    expect(emails.status).toBe(200);
    expect(emails.body.emails).toHaveLength(1);
    expect(emails.body.emails.map((e: any) => e.id)).toEqual([PLATFORM_EMAIL.id]);
    expect(JSON.stringify(emails.body)).not.toContain(email.body.entry.id);
    expect(JSON.stringify(emails.body)).not.toContain('Revised scope');

    // ── Absent: the calls list too, which is what feeds Performance and the reports ──
    const calls = await request(app).get('/api/communication/calls').set(authHeader('admin'));
    expect(calls.status).toBe(200);
    expect(calls.body.calls.map((c: any) => c.id)).toEqual([PLATFORM_CALL.id]);

    // Logging wrote no platform record of ANY channel - so there is nothing for a future report,
    // an inbox or a thread list to forget to filter out.
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
    expect(mockPrisma.email.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PAIR AGAIN, FOR AN ENTRY THAT CARRIES A DURATION.
//
// This is the specific risk slice 3 introduces. Slice 1's exclusion holds because the module
// reads call_sessions and these are not call_sessions - but slice 3 gives a manual entry a
// DURATION, which is the one field an average-handle-time could plausibly want. A hand-typed 45
// minutes reaching AHT would corrupt a number a manager reports upward, and would stay invisible
// until somebody disputed it. So the pair is re-asserted against an entry that carries one.
// ─────────────────────────────────────────────────────────────────────────────

describe('a logged duration reaches the timeline and NEVER the module\'s numbers', () => {
  it('is on the lead timeline, and absent from the calls list that feeds Performance, agent metrics and call reports', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });

    const logged: any[] = [];
    mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
      const row = { id: '11110000-0000-0000-0000-000000000001', ...args.data };
      logged.push(row);
      return Promise.resolve(row);
    });
    mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        logged.filter((r) => r.organization_id === where.organization_id && r.lead_id === where.lead_id),
      ),
    );
    mockPrisma.callSession.findMany.mockResolvedValue([PLATFORM_CALL]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);

    // 45 minutes - an order of magnitude longer than the real 95-second call beside it, so a
    // leak into any average would be unmissable rather than a rounding difference.
    const created = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, duration_minutes: 45 });
    expect(created.status).toBe(201);
    const entryId = created.body.entry.id;

    // ── Present, and saying how long it was ──
    const timeline = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));
    expect(timeline.status).toBe(200);
    const item = timeline.body.items.find((i: any) => i.id === entryId);
    expect(item.title).toBe('Outbound call · 45m');

    // ── Absent from the call list, which is what every metric surface is fed from ──
    const calls = await request(app).get('/api/communication/calls').set(authHeader('admin'));
    expect(calls.status).toBe(200);
    // Non-empty first: absence from an empty list would prove nothing at all.
    expect(calls.body.calls).toHaveLength(1);
    expect(calls.body.calls.map((c: any) => c.id)).toEqual([PLATFORM_CALL.id]);

    // …and no duration in that payload is the one that was typed. The Performance view is handed
    // exactly this array as `calls: CallSession[]`, so average handle time can only ever be an
    // average of these numbers - 45 minutes (2700s) is not among them.
    const durations = calls.body.calls.map((c: any) => c.durationSec);
    expect(durations).toEqual([PLATFORM_CALL.duration_sec]);
    expect(durations).not.toContain(45);
    expect(durations).not.toContain(2700);

    // The agent metrics the Performance view renders (answer rate, AHT, containment) are read
    // from phone_agents, which the logging path never touches, and no call record was written
    // for a future report to forget to filter out.
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.update).not.toHaveBeenCalled();
    expect(mockPrisma.phoneAgent.create).not.toHaveBeenCalled();
    expect(mockPrisma.phoneAgent.update).not.toHaveBeenCalled();
  });

  it('does not appear in the agent metrics payload either', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubCreate();
    mockPrisma.phoneAgent.findMany.mockResolvedValue([
      {
        id: 'ag000000-0000-0000-0000-000000000001',
        kind: 'human',
        name: 'Dana Reyes',
        role: 'CSR',
        calls: 10,
        answer_rate_pct: 90,
        booking_rate_pct: 40,
        aht_sec: 240,
        sentiment_pct: 70,
        revenue: 0,
        script_adherence_pct: 80,
        containment_pct: null,
        user: null,
      },
    ]);

    const created = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, duration_minutes: 45, performed_by: undefined });
    expect(created.status).toBe(201);

    const agents = await request(app).get('/api/communication/agents').set(authHeader('admin'));

    expect(agents.status).toBe(200);
    // The one agent, with the handle time the platform computed - one entry, unchanged, and the
    // logged 45 minutes nowhere in the payload at all.
    expect(agents.body.agents).toHaveLength(1);
    expect(agents.body.agents[0].ahtSec).toBe(240);
    expect(agents.body.agents[0].calls).toBe(10);
    expect(JSON.stringify(agents.body)).not.toContain(created.body.entry.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE JOB SIDE, AND THE CUSTOMER ROLL-UP (slice 5).
//
// Slice 1 wired only the lead-scoped aggregation, so a job-anchored entry was writable by the
// API and readable by nobody. This section drives the two remaining aggregations through HTTP.
//
// Every one of them re-asserts THE PAIR - present in the timeline, absent from the module's
// call list - because the pair is a property of each READ PATH, not of the feature in general:
// a new aggregation is exactly where a future change could start unioning call_sessions and
// manual entries into one list. The call list is populated first in every case; absence from an
// empty list would prove nothing.
// ─────────────────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

/** A real CTM-ingested call on the JOB, an hour after the logged one. */
const PLATFORM_JOB_CALL = {
  ...PLATFORM_CALL,
  id: 'ca000000-0000-0000-0000-000000000002',
  summary: 'Customer called about the install window.',
  lead_id: null,
  job_id: JOB_ID,
  job_label: 'J00042',
  customer_id: CUSTOMER_ID,
};

/**
 * The manual store the two new aggregations read out of: the POST really writes into it, both
 * reads really query it, and the query is applied the way the DATABASE would apply it.
 *
 * `join` resolves the row's `lead` / `job` relations at READ time, exactly where Prisma's
 * `include` resolves them - and, critically, BEFORE the filter runs, because the customer
 * roll-up's anchor disjunction arrives as
 * `AND: [{ OR: [{ lead: { customer_id } }, { job: { customer_id } }] }]` and is a condition on
 * the joined rows.
 *
 * The `where` is evaluated by the SHARED matcher (whereMatcher.ts), not by a private one written
 * to fit these queries: a to-one relation whose row is absent is a non-match there, exactly as a
 * SQL join would decide, which is what makes "not on this customer" a real answer rather than a
 * canned one.
 */
function manualStore(rows: any[], join: (row: any) => any = (r) => r) {
  mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
    const row = { id: `11110000-0000-0000-0000-00000000000${rows.length + 1}`, ...args.data };
    rows.push(row);
    return Promise.resolve(row);
  });
  mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where, include }: any) =>
    Promise.resolve(
      rows
        .map(join)
        .filter((r) => matchesWhere(r, where))
        .map((r) => withIncludedRelations(r, include)),
    ),
  );
  return rows;
}

/**
 * The relations the query ASKED FOR, and only those - the projection Prisma performs after the
 * filter. `join` above resolves every relation so the `where` can be evaluated against them (a
 * join condition is evaluated on the joined rows); this then hands back only what `include`
 * named, exactly as the database would.
 *
 * Without it MANUAL_INCLUDE is untestable: deleting its `job:` line leaves every spec here green
 * while `who` and `jobLabel` blank on every job-anchored row in production.
 */
function withIncludedRelations(row: any, include?: any) {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { lead, job, customer, performer, logger, ...columns } = row;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return {
    ...columns,
    ...(include?.lead ? { lead } : {}),
    ...(include?.job ? { job } : {}),
    ...(include?.customer ? { customer } : {}),
    ...(include?.performer ? { performer } : {}),
    ...(include?.logger ? { logger } : {}),
  };
}

/** The four real channels, with a genuine platform call in the list so "absent" means something. */
function realChannels(calls: any[]) {
  mockPrisma.callSession.findMany.mockResolvedValue(calls);
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
}

describe('a logged entry is on the JOB timeline and NOWHERE in the Communication module', () => {
  it('appears in the job timeline, marked as hand-entered, and is absent from the calls list', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    manualStore([]);
    realChannels([PLATFORM_JOB_CALL]);

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);

    expect(created.status).toBe(201);
    expect(created.body.entry.jobId).toBe(JOB_ID);
    expect(created.body.entry.leadId).toBeNull();
    const entryId = created.body.entry.id;

    // ── Present: the job's Communication timeline ──
    const timeline = await request(app)
      .get(`/api/jobs/${JOB_ID}/communications`)
      .set(authHeader('admin'));

    expect(timeline.status).toBe(200);
    const ids = timeline.body.items.map((i: any) => i.id);
    // Chronological position among the real communications - 16:00 org time (20:00Z), the
    // platform call an hour later - not a section of its own.
    expect(ids).toEqual([entryId, PLATFORM_JOB_CALL.id]);

    const item = timeline.body.items.find((i: any) => i.id === entryId);
    // The same hand-entered treatment the lead tab gives it: the flag the "Logged" chip renders
    // from, and the attribution names the row carries.
    expect(item).toMatchObject({ channel: 'call', direction: 'out', manuallyLogged: true, jobId: JOB_ID });
    expect(item.preview).toBe(JOB_BODY.notes);
    expect(timeline.body.items.find((i: any) => i.id === PLATFORM_JOB_CALL.id).manuallyLogged)
      .toBeUndefined();

    // ── Absent: the Communication module's call list ──
    const calls = await request(app).get('/api/communication/calls').set(authHeader('admin'));

    expect(calls.status).toBe(200);
    expect(calls.body.calls).toHaveLength(1);
    expect(calls.body.calls.map((c: any) => c.id)).toEqual([PLATFORM_JOB_CALL.id]);
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.upsert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER ROLL-UP.
//
// An entry carries NO customer of its own - the spec's "the lead or job already resolves to the
// customer" - so the roll-up has to reach it THROUGH the anchor it was logged against. Both
// routes are exercised in ONE read, because they are one query: with only the lead branch
// populated, a job branch that was never written would go unnoticed.
//
// A third entry, on ANOTHER customer's lead, is what stops the whole thing passing on a query
// that simply returns the organisation's rows.
// ─────────────────────────────────────────────────────────────────────────────

const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000099';
const OTHER_LEAD_ID = 'e0000000-0000-0000-0000-0000000000aa';

/** What the `include` resolves for each anchor - the customer the roll-up reaches through. */
const ANCHOR_LEADS: Record<string, any> = {
  // `jobs` is the conversion back-relation (Job.lead_id → Lead.jobs): THIS LEAD BECAME THIS JOB.
  // It is populated so that a query walking from the lead to its jobs would really return this
  // lead's entries on the job - see the conversion spec below, which asserts it does not happen.
  [LEAD_ID]: { lead_number: 'L00001', customer_id: CUSTOMER_ID, jobs: [{ id: JOB_ID }], customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' } },
  [OTHER_LEAD_ID]: { lead_number: 'L00099', customer_id: OTHER_CUSTOMER_ID, customer: { id: OTHER_CUSTOMER_ID, first_name: 'Jane', last_name: 'Roe', company_name: null } },
};
const ANCHOR_JOBS: Record<string, any> = {
  [JOB_ID]: { job_number: 'J00042', customer_id: CUSTOMER_ID, customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' } },
};
const joinAnchors = (row: any) => ({
  ...row,
  lead: row.lead_id ? ANCHOR_LEADS[row.lead_id] ?? null : null,
  job: row.job_id ? ANCHOR_JOBS[row.job_id] ?? null : null,
});

describe('a logged entry rolls up onto the customer, through whichever anchor it names', () => {
  it('reaches the customer through the lead AND through the job, and neither reaches the calls list', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    // Both anchors resolve for the caller's org; the customer gate resolves too.
    mockPrisma.lead.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(ANCHOR_LEADS[where.id] ? { id: where.id } : null),
    );
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_ID });
    manualStore([], joinAnchors);
    realChannels([PLATFORM_JOB_CALL]);

    const onLead = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);
    const onJob = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);
    // …and one on somebody ELSE's lead, which must not surface on this customer.
    const elsewhere = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, lead_id: OTHER_LEAD_ID, notes: 'Different customer entirely.' });
    for (const r of [onLead, onJob, elsewhere]) expect(r.status).toBe(201);

    // ── Present: the customer's Communication roll-up, by both routes ──
    const rollup = await request(app)
      .get(`/api/customers/${CUSTOMER_ID}/communications`)
      .set(authHeader('admin'));

    expect(rollup.status).toBe(200);
    const ids = rollup.body.items.map((i: any) => i.id);
    expect(ids).toContain(onLead.body.entry.id);
    expect(ids).toContain(onJob.body.entry.id);
    expect(ids).not.toContain(elsewhere.body.entry.id);
    // In the chronology with the platform call, not in a group of their own.
    expect(ids).toEqual([onLead.body.entry.id, onJob.body.entry.id, PLATFORM_JOB_CALL.id]);

    for (const id of [onLead.body.entry.id, onJob.body.entry.id]) {
      const item = rollup.body.items.find((i: any) => i.id === id);
      expect(item.manuallyLogged).toBe(true);
      // The counterparty the entry never stored: resolved through the anchor, as the spec says.
      expect(item.who).toBe('Doe HVAC');
    }

    // ── Absent: the Communication module's call list ──
    const calls = await request(app).get('/api/communication/calls').set(authHeader('admin'));

    expect(calls.status).toBe(200);
    expect(calls.body.calls).toHaveLength(1);
    const callIds = calls.body.calls.map((c: any) => c.id);
    expect(callIds).toEqual([PLATFORM_JOB_CALL.id]);
    for (const id of [onLead.body.entry.id, onJob.body.entry.id]) {
      expect(callIds).not.toContain(id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTRIES STAY WHERE THEY WERE LOGGED.
//
// A lead becomes a job (Job.lead_id), and the temptation is to carry its history forward so the
// job "has everything". That would make the record lie: the conversation happened while this was
// still a lead, and a reader comparing the lead and the job has to be able to see where the
// contact actually sat. The entry is not migrated and is not unioned in.
//
// The fixtures really do carry the conversion in both directions - the job knows its lead_id, the
// lead knows its jobs - so the absence below is a decision this code makes, not a link the test
// forgot to draw.
// ─────────────────────────────────────────────────────────────────────────────

describe('an entry logged on a lead that later became a job stays on the lead', () => {
  it('is on the lead\'s timeline and NOT on the timeline of the job it converted into', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // The conversion: this job was built from that lead.
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, lead_id: LEAD_ID });
    manualStore([], joinAnchors);
    realChannels([PLATFORM_JOB_CALL]);

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);
    expect(created.status).toBe(201);
    const entryId = created.body.entry.id;

    const onLead = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));
    expect(onLead.status).toBe(200);
    expect(onLead.body.items.map((i: any) => i.id)).toContain(entryId);

    const onJob = await request(app)
      .get(`/api/jobs/${JOB_ID}/communications`)
      .set(authHeader('admin'));
    expect(onJob.status).toBe(200);
    // Non-empty: the job's own platform call is there, so this is an absence from a populated
    // timeline rather than from a timeline that failed to load.
    expect(onJob.body.items.map((i: any) => i.id)).toEqual([PLATFORM_JOB_CALL.id]);
    expect(onJob.body.items.map((i: any) => i.id)).not.toContain(entryId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE MIGRATION IS ONE MIGRATION, NOT FOUR.
//
// duration_minutes, outcome, subject and job_id were written by nobody in slice 1. That made them
// exactly the columns a reviewer would ask to remove, and re-adding each one later is three more
// migrations against a table with no rows to gain from the delay. These assertions are what says
// the absence of a writer is deliberate.
//
// The payoff is that each writer arrived WITHOUT a migration of its own: slice 3 gave
// duration_minutes one (controller header, "HOW LONG THE CALL WAS (slice 3)"), slice 5 gave
// job_id one (the other half of the lead/job XOR), and slice 6 gave subject one
// (comm-manual-log.controller.ts:165, "The subject line of a logged email (slice 6, user
// story 15)"). Slice 3 gave `outcome` a writer on the same terms.
//
// `outcome` is NOT in the list below any more. Slice 1 did create it here - that file is frozen
// history and still names it - but the column and its enum were dropped in the retirement's
// phase 2, so asserting slice 1 created it no longer pins anything a reader can act on. The
// phase-2 migration has its own assertions below.
//
// The RLS pair is asserted here rather than left to the `Database (migrations + RLS)` job alone:
// that job only runs where a Postgres is available, and this file runs everywhere.
// ─────────────────────────────────────────────────────────────────────────────
describe('the migration', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260827160000_manual_communication_log/migration.sql'),
    'utf8',
  );

  it('creates the columns the later slices need, not only slice 1\'s', () => {
    for (const column of ['duration_minutes', 'subject', 'job_id']) {
      expect(sql).toContain(`"${column}"`);
    }
  });

  it('indexes organisation, lead and job - the three aggregators\' access patterns', () => {
    for (const idx of ['organization_id_idx', 'lead_id_idx', 'job_id_idx']) {
      expect(sql).toContain(`"manual_communication_logs_${idx}"`);
    }
  });

  it('enforces exactly-one-anchor in the database, not only in the API', () => {
    expect(sql).toContain('CHECK (num_nonnulls("lead_id", "job_id") = 1)');
  });

  it('carries the canonical tenant_isolation backstop, on both USING and WITH CHECK', () => {
    const predicate =
      `current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = ` +
      `NULLIF(current_setting('app.current_org_id', true), '')::uuid`;
    expect(sql).toContain('ALTER TABLE "manual_communication_logs" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "manual_communication_logs" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain(`USING (${predicate})`);
    expect(sql).toContain(`WITH CHECK (${predicate})`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PHASE-2 DROP MIGRATION.
//
// ORDER IS LOAD-BEARING, and it is the one thing about this migration that can be got wrong
// silently in review: Postgres refuses to drop a type while a column still uses it, so a file
// that dropped the enum first would fail on apply. CI's `Database (migrations + RLS)` job is the
// real judge — it applies this against a disposable Postgres — but that job only runs where a
// Postgres is available, and this file runs everywhere, so the ordering is pinned here too.
// ─────────────────────────────────────────────────────────────────────────────
describe('the phase-2 drop migration', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260831120000_drop_manual_comm_outcome/migration.sql'),
    'utf8',
  );

  it('drops the column and then the enum, in that order', () => {
    const dropColumn = sql.indexOf('DROP COLUMN IF EXISTS "outcome"');
    const dropType = sql.indexOf('DROP TYPE IF EXISTS "ManualCommOutcome"');
    expect(dropColumn).toBeGreaterThan(-1);
    expect(dropType).toBeGreaterThan(-1);
    expect(dropColumn).toBeLessThan(dropType);
  });

  // Re-runnable, and applicable to a database that never had the table: production has neither
  // the table nor the enum, so an unguarded ALTER TABLE there is a hard error, not a no-op.
  it('guards both statements so a re-run and a table-less database are both no-ops', () => {
    expect(sql).toContain('ALTER TABLE IF EXISTS "manual_communication_logs"');
    expect(sql).toContain('DROP COLUMN IF EXISTS');
    expect(sql).toContain('DROP TYPE IF EXISTS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 7 — AN OUTBOUND LOG MARKS THE LEAD CONTACTED.
//
// `leads.contacted_at` is a MONOTONIC clock: the first human outbound touch sets it and nothing
// moves it afterwards, because lead responsiveness is measured from the FIRST time somebody
// reached out. A logged outbound communication is outbound activity — recorded by a human rather
// than by a webhook, but an assertion that a real conversation took place.
//
// THE ASSERTION IS THE STORED VALUE, READ BACK OVER HTTP, not the shape of the write. The lead
// store below enforces the same conditional-write semantics Postgres does (a write whose WHERE
// names `contacted_at: null` is refused once the column carries a value), so a first-touch-wins
// test can only pass while the code really is guarding on null — and `GET /api/leads/:id` is
// what a reader, a report and the followup KPI actually see.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A one-lead store behaving the way the database does under `updateMany`.
 *
 * Returns the store so a test can seed `contacted_at` and read it back. `matchesWhere` evaluates
 * the real WHERE the code emitted; nothing here inspects the call, so the whole mechanism —
 * including the `contacted_at: null` condition that IS first-write-wins — has to be present in
 * the source for these to pass.
 */
function leadContactStore(seed: Date | null = null) {
  const lead: any = { ...LEAD_FIXTURE, id: LEAD_ID, organization_id: ALPHA_ORG_ID, contacted_at: seed };
  // The anchor resolve inside the create handler.
  mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
  // GET /api/leads/:id reads this.
  mockPrisma.lead.findUnique.mockImplementation(() => Promise.resolve(lead));
  mockPrisma.lead.updateMany.mockImplementation(({ where, data }: any) => {
    if (!matchesWhere(lead, where)) return Promise.resolve({ count: 0 });
    Object.assign(lead, data);
    return Promise.resolve({ count: 1 });
  });
  return lead;
}

/** What a reader of the lead actually sees. */
async function readContactedAt() {
  const res = await request(app).get(`/api/leads/${LEAD_ID}`).set(authHeader('admin'));
  expect(res.status).toBe(200);
  return res.body.lead.contacted_at;
}

describe('an outbound log marks the lead contacted', () => {
  it('fills an empty contacted timestamp with the ENTRY\'s instant, not with now', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const lead = leadContactStore(null);
    stubCreate();

    expect(await readContactedAt()).toBeNull();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);
    expect(created.status).toBe(201);

    // 4pm on the org's clock, which is the moment the conversation happened — NOT the moment it
    // was typed up. An admin backfilling three months of history would otherwise stamp every one
    // of those leads as contacted today.
    expect(created.body.entry.occurredAt).toBe('2026-08-26T20:00:00.000Z');
    expect(await readContactedAt()).toBe(created.body.entry.occurredAt);
    expect(lead.contacted_at).toEqual(new Date('2026-08-26T20:00:00.000Z'));
  });

  // FIRST WRITE WINS. Responsiveness is measured from the FIRST time somebody reached out, so a
  // fifth follow-up must not keep resetting the clock — and, since the clock is never re-set, a
  // missed response-time breach can never be erased by logging again.
  it('leaves an existing contacted timestamp alone', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const FIRST_TOUCH = new Date('2026-08-01T13:00:00.000Z');
    leadContactStore(FIRST_TOUCH);
    stubCreate();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);
    expect(created.status).toBe(201);
    // The entry really is LATER than the stored value, so "unchanged" is a decision and not an
    // accident of the two happening to be equal.
    expect(new Date(created.body.entry.occurredAt).getTime()).toBeGreaterThan(FIRST_TOUCH.getTime());

    expect(await readContactedAt()).toBe(FIRST_TOUCH.toISOString());
  });

  // A CUSTOMER CHASING US IS NOT US DOING OUR JOB (user story 15). Both halves matter: an inbound
  // entry must not FILL an empty clock, and must not disturb one that is already set.
  it('never writes the clock for an inbound entry, empty or already set', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const empty = leadContactStore(null);
    stubCreate();

    const first = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, direction: 'in' });
    expect(first.status).toBe(201);
    expect(await readContactedAt()).toBeNull();
    expect(empty.contacted_at).toBeNull();

    // ...and again on a lead that already carries one.
    const EXISTING = new Date('2026-08-01T13:00:00.000Z');
    leadContactStore(EXISTING);
    const second = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, direction: 'in' });
    expect(second.status).toBe(201);
    expect(await readContactedAt()).toBe(EXISTING.toISOString());
  });

  // BACKDATING CANNOT MOVE THE CLOCK BACKWARDS. Distinct from the test above, because here BOTH
  // values are written by this feature through the real code path: the first log fills the clock,
  // and a colleague then types up an EARLIER conversation they had forgotten. First WRITE wins,
  // not earliest occurrence — the alternative would let any backfill rewrite an org's measured
  // response time months after the fact.
  it('does not move the clock backwards when an earlier conversation is logged afterwards', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    leadContactStore(null);
    stubCreate();

    const later = await request(app).post(ENDPOINT).set(authHeader('admin')).send(VALID_BODY);
    expect(later.status).toBe(201);
    const stamped = await readContactedAt();
    expect(stamped).toBe(later.body.entry.occurredAt);

    const earlier = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, occurred_at: '2026-08-20T09:00', notes: 'Forgot to log this one.' });
    expect(earlier.status).toBe(201);
    expect(new Date(earlier.body.entry.occurredAt).getTime()).toBeLessThan(new Date(stamped).getTime());

    expect(await readContactedAt()).toBe(stamped);
  });

  // A JOB-ANCHORED ENTRY TOUCHES NO LEAD'S CLOCK — including the lead that job converted from.
  // The job resolve below deliberately OFFERS a `lead_id`, so an implementation that reached
  // through the job to stamp its originating lead would be caught here rather than shipping.
  it('writes no lead clock at all when the entry is logged on a job', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const lead = leadContactStore(null);
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID, lead_id: LEAD_ID });
    stubCreate();

    const created = await request(app).post(ENDPOINT).set(authHeader('admin')).send(JOB_BODY);
    expect(created.status).toBe(201);
    expect(created.body.entry.jobId).toBe(JOB_ID);

    expect(await readContactedAt()).toBeNull();
    expect(lead.contacted_at).toBeNull();
    // Not merely "wrote null" — no lead write was attempted at all.
    expect(mockPrisma.lead.updateMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PERFORMER ROSTER (slice 4, C1).
//
// The drawer asks "who had the conversation?" and offers a picker over the organisation. That
// picker used to read `GET /api/users`, which is gated on `read User` — and `read User` appears in
// DEFAULT_GRANTS exactly twice, for DISPATCHER and TECHNICIAN. There is no SALES row and
// SHARED_BASELINE carries only `create Communication`, so the moment an admin granted `log_past`
// to SALES the picker 403'd and came back EMPTY: that user could not pick anyone at all, not even
// themselves. The capability existed and did not work.
//
// The fix is a roster of its own, scoped to the capability that needs it. The alternative —
// bundling `read User` in beside `log_past` — was rejected on two grounds. It widens who can
// enumerate staff (`GET /api/users` carries every colleague's email, phone and login state) as a
// side effect of a COMMUNICATION capability. And `User` is itself a MODULES subject, so the bundle
// would emit `read User` a second time: unticking the Users → View cell would then silently do
// nothing, because this bundle would keep re-emitting the row the admin had just cleared.
//
// This endpoint returns id and display name and NOTHING ELSE, which is the whole of what a picker
// needs and materially less than `GET /api/users` hands out.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PERFORMERS_ENDPOINT = '/api/communication/manual-log/performers';

/** The org's active users, as Prisma would return them for this endpoint's narrow select. */
function stubRoster(rows = [
  { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
  { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
]) {
  mockPrisma.user.findMany.mockResolvedValue(rows);
  return rows;
}

describe('the performer picker has a roster of its own', () => {
  // THE POINT OF THE WHOLE ITEM. A SALES user holds no `read User` grant and never will as a
  // consequence of this feature; they must still be able to name a colleague.
  it('gives a SALES user holding the capability a usable roster', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    stubRoster();

    const res = await request(app).get(PERFORMERS_ENDPOINT).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users).toContainEqual({
      id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales',
    });
    // Including themselves — an empty picker is the failure this endpoint exists to prevent, and
    // "I logged my own call" is the commonest entry there is.
    expect(res.body.users.map((u: { id: string }) => u.id)).toContain(TEST_USERS.sales.id);
  });

  // The control that proves the point above is real rather than incidental: the SAME principal is
  // refused the roster the picker used to read, so nothing here widened `read User`.
  it('and that same user is still refused GET /api/users', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    mockPrisma.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/users?assignable=true').set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('refuses a user who does not hold the capability', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app).get(PERFORMERS_ENDPOINT).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    stubRoster();
    const res = await request(app).get(PERFORMERS_ENDPOINT);

    expect(res.status).toBe(401);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  // It is a PICKER's roster, not a staff directory. `GET /api/users` returns email, phone, login
  // state, avatar, department and role for every colleague; this hands back the two fields needed
  // to write a name in a dropdown and nothing that would make it worth reaching for otherwise.
  it('returns names and ids only — no email, no phone, no login state', async () => {
    mockAuthAs('admin');
    stubRoster();

    const res = await request(app).get(PERFORMERS_ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(200);
    for (const user of res.body.users) {
      expect(Object.keys(user).sort()).toEqual(['first_name', 'id', 'last_name']);
    }
    // …and the query itself never asked for more, so a widened response cannot leak in later.
    const args = mockPrisma.user.findMany.mock.calls[0][0];
    expect(args.select).toEqual({ id: true, first_name: true, last_name: true });
  });

  it('is scoped to the caller’s organisation, and to its active users', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    stubRoster();

    await request(app).get(PERFORMERS_ENDPOINT).set(authHeader('sales'));

    const { where } = mockPrisma.user.findMany.mock.calls[0][0];
    expect(matchesWhere(where, { organization_id: ALPHA_ORG_ID, is_active: true })).toBe(true);
    expect(matchesWhere(where, { organization_id: ORG_B_ID, is_active: true })).toBe(false);
    expect(matchesWhere(where, { organization_id: ALPHA_ORG_ID, is_active: false })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER ANCHOR (#2021).
//
// A conversation that was about the CUSTOMER and not about any one lead or job — "I rang Linda
// to check she was happy with the work" — had nowhere to go: the only two anchors were a lead
// and a job, and a customer holding neither could not be logged against at all. The anchor set
// widens to three, and stays "exactly one".
// ─────────────────────────────────────────────────────────────────────────────

/** The same entry, anchored on the CUSTOMER itself — the third arm of the anchor rule. */
const CUSTOMER_BODY = {
  customer_id: CUSTOMER_ID,
  direction: 'out' as const,
  occurred_at: '2026-08-26T16:00',
  notes: 'Rang Linda to check she was happy with the work. Nothing outstanding.',
};

describe('an entry can be anchored on a customer', () => {
  it('records a past call on a customer that names no lead and no job', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    stubCreate();

    const res = await request(app).post(ENDPOINT).set(authHeader('admin')).send(CUSTOMER_BODY);

    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({
      channel: 'call',
      direction: 'out',
      customerId: CUSTOMER_ID,
      leadId: null,
      jobId: null,
      notes: CUSTOMER_BODY.notes,
      manuallyLogged: true,
    });
    // The org's clock composes the instant here exactly as it does on the other two anchors.
    expect(res.body.entry.occurredAt).toBe('2026-08-26T20:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THAT A THIRD ANCHOR BREAKS.
//
// The two-anchor rule was an EXCLUSIVE-OR: `(lead != null) !== (job != null)`. That is correct
// for two anchors and silently wrong for three - with all three supplied the XOR of the first
// two is false, the third flips nothing, and the endpoint ADMITS a row the database's own
// num_nonnulls CHECK then refuses.
//
// This is the case that discriminates. A suite trying lead-only, job-only, customer-only and the
// three PAIRS passes against the broken rule; only all-three fails it. It is the first test
// written for this change for that reason.
// ─────────────────────────────────────────────────────────────────────────────

describe('the entry still names EXACTLY one anchor, now out of three', () => {
  it('rejects an entry naming all three - the case an exclusive-or lets through', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    stubCreate();

    const res = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, job_id: JOB_ID, customer_id: CUSTOMER_ID });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // The two pairs the customer anchor newly makes expressible. Neither discriminates on its own -
  // both are refused by the old XOR too - but leaving them out would let a rule that counted
  // `>= 1` rather than `=== 1` through.
  it('rejects a lead paired with a customer, and a job paired with a customer', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    stubCreate();

    const withLead = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...VALID_BODY, customer_id: CUSTOMER_ID });
    const withJob = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...CUSTOMER_BODY, job_id: JOB_ID });

    expect(withLead.status).toBe(400);
    expect(withJob.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();
  });

  // The DB half of the same rule. The API's refusal is one guard; this is the one that stands if
  // a future writer bypasses the controller entirely.
  it('widens the database CHECK to count all three, so the API is not the only guard', () => {
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20260908120000_manual_comm_customer_anchor/migration.sql'),
      'utf8',
    );
    expect(sql).toContain('CHECK (num_nonnulls("lead_id", "job_id", "customer_id") = 1)');
    // The old two-operand CHECK has to GO, not merely be joined by a second one: leaving it
    // standing would refuse every customer-anchored insert.
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "manual_communication_logs_exactly_one_anchor"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TENANCY ON THE NEW ANCHOR.
//
// A customer id from another organisation is a 404 and not a 403, exactly as a lead's and a
// job's are: the caller learns nothing about whether the row exists elsewhere.
//
// The id posted is a REAL customer that really exists in org A - a random uuid would exercise
// "unknown id", a different branch, and would stay green if `tenantWhere(req)` were dropped from
// the customer resolve entirely.
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA_CUSTOMER = { id: CUSTOMER_ID, organization_id: ALPHA_ORG_ID };
const ORG_B_CUSTOMER = { id: 'c0000000-0000-0000-0000-0000000000b2', organization_id: ORG_B_ID };

/** The customer anchor's counterpart to leadStore / jobStore, filtered the same faithful way. */
function customerStore(...rows: { id: string; organization_id: string }[]) {
  mockPrisma.customer.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(
      rows.find(
        (r) =>
          r.id === where.id &&
          (where.organization_id === undefined || r.organization_id === where.organization_id),
      ) ?? null,
    ),
  );
}

describe('the customer anchor is tenant-scoped', () => {
  it('rejects a customer belonging to another organisation as not-found, and writes nothing', async () => {
    orgTimezone('America/New_York');
    customerStore(ALPHA_CUSTOMER, ORG_B_CUSTOMER);
    stubCreate();

    mockAuthAs('orgB_admin');
    const refused = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send(CUSTOMER_BODY);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'Customer not found' });
    expect(mockPrisma.manualCommunicationLog.create).not.toHaveBeenCalled();

    // Org B CAN log against its OWN customer, so the refusal above is about whose customer it is
    // and not about the endpoint refusing customer anchors in general.
    const ownCustomer = await request(app)
      .post(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send({ ...CUSTOMER_BODY, customer_id: ORG_B_CUSTOMER.id });

    expect(ownCustomer.status).toBe(201);
    expect(ownCustomer.body.entry.customerId).toBe(ORG_B_CUSTOMER.id);

    // …and so is the SAME id org B was refused, from the organisation that owns it.
    clearTokenCache();
    clearPermissionCache();
    mockAuthAs('admin');
    const accepted = await request(app).post(ENDPOINT).set(authHeader('admin')).send(CUSTOMER_BODY);

    expect(accepted.status).toBe(201);
    expect(accepted.body.entry.customerId).toBe(CUSTOMER_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A CUSTOMER-ANCHORED ENTRY MOVES NO LEAD'S CLOCK.
//
// `contacted_at` is a LEAD-level column - customers carry no equivalent - and it is
// FIRST-WRITE-WINS, so a stamp written from the wrong place can never be corrected. The
// temptation is to resolve the customer's leads and stamp them, on the reasoning that reaching
// the customer is reaching the lead. That would move the lead response-time metric using a
// conversation that was explicitly not about any lead, and it would do so permanently.
//
// The customer branch therefore has strictly FEWER side effects than the lead branch, and this
// is the assertion that keeps it that way.
// ─────────────────────────────────────────────────────────────────────────────

describe('an outbound entry logged on a CUSTOMER stamps no lead', () => {
  it('leaves the contacted timestamp of that customer\'s lead exactly as it found it', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    // A real, reachable lead sitting on the same customer with an EMPTY clock - the state a
    // stamp would be visible in. `leadContactStore` writes through the same conditional-write
    // semantics Postgres uses, so a stamp really would land.
    const lead = leadContactStore(null);
    lead.customer_id = CUSTOMER_ID;
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    stubCreate();

    const created = await request(app)
      .post(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...CUSTOMER_BODY, direction: 'out' });

    expect(created.status).toBe(201);
    // Read back the way a reader, a report and the followup KPI see it - not by inspecting the
    // write that was or was not issued.
    expect(await readContactedAt()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AND THE TIMEZONE-SHIFTING SUITES LEFT THE PROCESS ZONE AS THEY FOUND IT.
//
// Two describes in this file move `process.env.TZ` to make their fixtures discriminating.
// `process.env` is shared by every file a vitest worker thread runs, so a restore that puts back
// the STRING "undefined" instead of the ABSENCE does not fail here - it silently reparses every
// later unzoned `new Date(...)` in that worker as UTC, and every downstream assertion about local
// time stops being able to fail. That is this repo's dominant defect class, and it would be
// planted inside the very suites written to guard against it.
//
// LAST IN THE FILE ON PURPOSE: vitest executes a file's blocks in order, so this observes the
// state every shifting describe above it left behind.
// ──────────────────────────────────────────────────────────────────────────────

/** Captured at COLLECTION time - before any beforeEach/afterEach in this file has run. */
const TZ_AT_IMPORT = process.env.TZ;

describe('the timezone-shifting suites restore the process zone exactly', () => {
  it('puts back an absent TZ as absent, never as the string "undefined"', () => {
    expect(process.env.TZ).toBe(TZ_AT_IMPORT);
    // The distinction the value alone cannot make: `process.env.TZ = undefined` leaves the key
    // PRESENT holding "undefined", which reads back as the string and not as undefined.
    expect('TZ' in process.env).toBe(TZ_AT_IMPORT !== undefined);
    expect(process.env.TZ).not.toBe('undefined');
  });

  it('leaves Node still able to resolve a zone, so unzoned dates stay LOCAL', () => {
    // With TZ="undefined" this resolves to undefined and unzoned parsing falls back to UTC.
    // Asserting the type rather than a particular zone keeps this true on any machine and on CI.
    expect(typeof Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('string');
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBeTruthy();
  });
});
