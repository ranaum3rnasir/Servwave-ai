// Manual Communication Log — slice 8 (spec:
// md_files/specs/communication/2026-08-27-manual-communication-log.md).
//
// A hand-typed record can be wrong: a mistyped date, the wrong colleague credited, the wrong lead
// entirely. This suite drives the correction and the removal.
//
// The extra rule this slice adds on top of the `log_past` ability is a ROW-LEVEL one: the
// requester must be the entry's LOGGER, or an organisation ADMIN. One person cannot quietly
// rewrite another's account of a conversation; an admin can clean up after a departed colleague.
//
// Pattern follows comm-manual-log.test.ts: supertest against the real Express app with a fully
// mocked Prisma, the shared auth helper, and two organisation fixtures for the tenancy assertions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const ENTRY_ID = '11110000-0000-0000-0000-000000000001';
const ENDPOINT = `/api/communication/manual-log/${ENTRY_ID}`;

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

function orgTimezone(tz: string) {
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: tz });
}

/** The stored entry as it is today: logged by the ADMIN fixture, anchored on the lead. */
function storedEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    organization_id: ALPHA_ORG_ID,
    channel: 'CALL',
    direction: 'OUT',
    occurred_at: new Date('2026-08-26T20:00:00.000Z'),
    notes: 'Spoke to John from my mobile about the two garage doors.',
    duration_minutes: null,
    subject: null,
    lead_id: LEAD_ID,
    job_id: null,
    customer_id: null,
    performed_by: TEST_USERS.admin.id,
    logged_by: TEST_USERS.admin.id,
    ...overrides,
  };
}

/** The row the endpoint resolves before it decides anything. */
function stubStored(row = storedEntry()) {
  mockPrisma.manualCommunicationLog.findFirst.mockResolvedValue(row);
  return row;
}

/** Echo the update back the way Prisma would, so the response is built from real data. */
function stubUpdate(base = storedEntry()) {
  mockPrisma.manualCommunicationLog.update.mockImplementation((args: any) =>
    Promise.resolve({ ...base, ...args.data }),
  );
}

/** A complete edit body. The update replaces the editable field set, so it names all of it. */
const EDIT_BODY = {
  lead_id: LEAD_ID,
  channel: 'call' as const,
  direction: 'in' as const,
  occurred_at: '2026-08-25T09:30',
  notes: 'Corrected: he rang US, on the Monday, not the Tuesday.',
  performed_by: TEST_USERS.admin.id,
};

describe('PUT /api/communication/manual-log/:id', () => {
  it('lets the entry’s logger correct it', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app).put(ENDPOINT).set(authHeader('admin')).send(EDIT_BODY);

    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({
      id: ENTRY_ID,
      direction: 'in',
      notes: EDIT_BODY.notes,
      leadId: LEAD_ID,
      manuallyLogged: true,
    });
    // 09:30 on the org's clock (New York, UTC-4 in August) is 13:30 UTC.
    expect(res.body.entry.occurredAt).toBe('2026-08-25T13:30:00.000Z');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// A CORRECTION MAY NOT MOVE AN ENTRY INTO THE FUTURE EITHER.
//
// The create path refuses one (comm-manual-log.test.ts). Guarding only that half would be a guard
// a client walks straight around: POST a valid time, then PUT the future one. The rule lives in a
// single helper precisely so the two endpoints cannot answer this differently.
//
// AND THE ENTRY ALREADY IN THE FUTURE IS STILL CORRECTABLE — the case that matters most, because
// there is one in the staging database right now. The bound is on the value the REQUEST carries,
// never on the stored row, so the row can be read and then saved to a real time.
//
// Values are built from `Date.now()`, never hardcoded, for the reason the create suite gives.
// ──────────────────────────────────────────────────────────────────────────────

/** `Date.now()` offset by `ms`, as the ORG-zone wall clock a picker would emit for it. */
function orgWallClock(tz: string, ms = 0): string {
  return formatInTimeZone(new Date(Date.now() + ms), tz, "yyyy-MM-dd'T'HH:mm");
}

const MINUTE = 60_000;
const NY = 'America/New_York';

/** The entry the product owner is stuck with: already stored with a future occurred_at. */
function futureDatedEntry() {
  return storedEntry({ occurred_at: new Date(Date.now() + 6 * 60 * MINUTE), notes: 'Ran QA 9 - sales lead' });
}

describe('a correction may not date the entry in the future', () => {
  it('refuses an edit that moves the conversation ahead of now, and says why', async () => {
    mockAuthAs('admin');
    orgTimezone(NY);
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: orgWallClock(NY, 2 * 60 * MINUTE) });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      {
        field: 'occurred_at',
        message: 'must not be in the future - this records a conversation that already happened',
      },
    ]);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('accepts an edit onto the conversation that just happened', async () => {
    mockAuthAs('admin');
    orgTimezone(NY);
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: orgWallClock(NY) });

    expect(res.status).toBe(200);
    expect(mockPrisma.manualCommunicationLog.update).toHaveBeenCalled();
  });

  it('tolerates a couple of minutes of clock skew on an edit but not ten', async () => {
    mockAuthAs('admin');
    orgTimezone(NY);
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const withinSkew = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: orgWallClock(NY, 2 * MINUTE) });
    expect(withinSkew.status).toBe(200);

    const beyondSkew = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: orgWallClock(NY, 10 * MINUTE) });
    expect(beyondSkew.status).toBe(400);
  });

  // ────────────────────────────────────────────────────────────────────────
  // THE ROW THAT PREDATES THE GUARD. It was written before this rule existed and it must not
  // become unfixable — the person who typed it is the person who has to correct it.
  // ────────────────────────────────────────────────────────────────────────
  it('still reads back an entry already dated in the future', async () => {
    mockAuthAs('admin');
    orgTimezone(NY);
    const stored = stubStored(futureDatedEntry());

    const res = await request(app).get(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.entry.occurredAt).toBe(stored.occurred_at.toISOString());
    expect(res.body.entry.notes).toBe('Ran QA 9 - sales lead');
  });

  it('lets that entry be corrected to a real time', async () => {
    mockAuthAs('admin');
    orgTimezone(NY);
    const stored = futureDatedEntry();
    stubStored(stored);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate(stored);

    const corrected = orgWallClock(NY, -30 * MINUTE);
    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: corrected });

    expect(res.status).toBe(200);
    expect(res.body.entry.occurredAtLocal).toBe(corrected);
    expect(new Date(res.body.entry.occurredAt).getTime()).toBeLessThan(Date.now());
  });

  it('still deletes an entry already dated in the future', async () => {
    mockAuthAs('admin');
    orgTimezone(NY);
    stubStored(futureDatedEntry());
    mockPrisma.manualCommunicationLog.delete.mockResolvedValue({ id: ENTRY_ID });

    const res = await request(app).delete(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.manualCommunicationLog.delete).toHaveBeenCalled();
  });

  // The same straddling pair the create suite carries. Restated rather than shared, because the
  // claim being made is about THIS endpoint: the two handlers have drifted on occurred_at before,
  // and a rule proved once proves nothing about the other one.
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
      orgTimezone(NY);
      stubStored();
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubUpdate();

      const asUtcNow = orgWallClock('UTC');
      expect(new Date(`${asUtcNow}:00.000Z`).getTime()).toBeLessThanOrEqual(Date.now());

      const res = await request(app)
        .put(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...EDIT_BODY, occurred_at: asUtcNow });

      expect(res.status).toBe(400);
      expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
    });

    it('accepts a wall clock that is past for the ORG though its bare string is hours ahead in UTC', async () => {
      mockAuthAs('admin');
      orgTimezone(AUCKLAND);
      stubStored();
      mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
      stubUpdate();

      const aMinuteAgoInAuckland = orgWallClock(AUCKLAND, -MINUTE);
      expect(new Date(`${aMinuteAgoInAuckland}:00.000Z`).getTime()).toBeGreaterThan(Date.now());

      const res = await request(app)
        .put(ENDPOINT)
        .set(authHeader('admin'))
        .send({ ...EDIT_BODY, occurred_at: aMinuteAgoInAuckland });

      expect(res.status).toBe(200);
    });
  });
});

/**
 * A non-admin role that HOLDS the ability — the third party in the rule this slice adds.
 *
 * Built here rather than inherited, because `log_past` is deliberately absent from every role's
 * default grants (the roles UI that turns it on is slice 4). Without this the "another user
 * holding the ability" case cannot be reached at all: the request would be refused at the route
 * guard, 403 for the wrong reason, and the row-level rule would never run. Same shape as a row
 * the roles editor writes.
 */
function grantLogPastTo(role: 'SALES' | 'DISPATCHER' | 'TECHNICIAN') {
  mockPrisma.rolePermission.findMany.mockResolvedValue([
    ...DEFAULT_GRANTS.filter((g) => g.role === role),
    { role, action: 'log_past', subject: 'Communication', conditions: null },
  ]);
  clearPermissionCache();
}

/**
 * AN ADMIN-DERIVED CUSTOM ROLE — SRVW-138's "full access minus payroll" shape: `users.role` stays
 * ADMIN (the BASE role) while `custom_role_id` points at a row whose own grant set is what the
 * user actually holds.
 *
 * `mayModifyEntry` reads `req.user.role === 'ADMIN'` and NOT `isSuperUser`, deliberately —
 * effectiveRole.ts reserves `.role` for "what kind of user is this", and such a role is still the
 * organisation's admin, still the person expected to clean up after a departed colleague. That
 * was reasoned from the module's header and never exercised against a real principal. If it were
 * wrong, an admin would silently lose the ability the admin branch exists for.
 *
 * The principal built here is genuinely NOT a superuser: `custom_role_id` is set, so `isSuperUser`
 * is false and CASL resolves through the stored grants instead of the manage-all short-circuit.
 * That is why the grants have to carry `log_past` explicitly — and why `withoutLogPast` below can
 * refuse the very same user, which is the control that proves the short-circuit is not in play.
 */
const CUSTOM_ROLE_KEY = 'ops-lead';
function mockAuthAsAdminDerivedCustomRole({ withLogPast = true } = {}) {
  mockAuthAs('admin');
  mockPrisma.user.findUnique.mockResolvedValue({
    ...TEST_USERS.admin,
    custom_role_id: 'cc000000-0000-0000-0000-0000000000c1',
    // MUST be selected alongside custom_role_id — grantRoleKey throws without it (a 500), rather
    // than silently falling back to the wider base role.
    custom_role: { key: CUSTOM_ROLE_KEY },
    organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} },
  });
  mockPrisma.rolePermission.findMany.mockResolvedValue([
    // A narrowed set, keyed on the CUSTOM role — not ADMIN's, which does not exist as rows at all.
    ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES').map((g) => ({ ...g, role: CUSTOM_ROLE_KEY })),
    ...(withLogPast
      ? [{ role: CUSTOM_ROLE_KEY, action: 'log_past', subject: 'Communication', conditions: null }]
      : []),
  ]);
  clearTokenCache();
  clearPermissionCache();
}

describe('an ADMIN-derived custom role is still the organisation\u2019s admin', () => {
  // THE CONTROL, and it is what makes the two tests below mean anything: strip `log_past` from the
  // same principal and it is refused. A manage-all short-circuit would have let it through, so
  // this pins that the role is resolving through its grants — i.e. that it is genuinely not a
  // superuser and the admin branch below is doing real work.
  it('is NOT a superuser: without the ability in its own grants, it is refused', async () => {
    mockAuthAsAdminDerivedCustomRole({ withLogPast: false });
    orgTimezone('America/New_York');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('corrects an entry somebody else logged', async () => {
    mockAuthAsAdminDerivedCustomRole();
    orgTimezone('America/New_York');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.user.findFirst.mockResolvedValue({ id: TEST_USERS.sales.id });
    stubUpdate(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    expect(res.body.entry.notes).toBe(EDIT_BODY.notes);
  });

  it('removes an entry somebody else logged', async () => {
    mockAuthAsAdminDerivedCustomRole();
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    mockPrisma.manualCommunicationLog.delete.mockResolvedValue(storedEntry());

    const res = await request(app).delete(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.manualCommunicationLog.delete).toHaveBeenCalled();
  });
});

describe('who may change an entry: the logger, or an organisation admin', () => {
  it('lets an organisation ADMIN correct an entry somebody else logged', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    // Logged by the SALES colleague, not by the admin who is editing it.
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.user.findFirst.mockResolvedValue({ id: TEST_USERS.sales.id });
    stubUpdate(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    expect(res.body.entry.notes).toBe(EDIT_BODY.notes);
  });

  it('refuses another user who holds the ability but neither logged it nor is an admin', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    orgTimezone('America/New_York');
    // Logged by the ADMIN. The SALES user can READ it on the lead timeline; they may not rewrite it.
    stubStored(storedEntry({ logged_by: TEST_USERS.admin.id }));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('sales'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(403);
    // And nothing was written. A 403 that had already updated the row would be a refusal in name.
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('lets that same user correct an entry THEY logged', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('sales'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    expect(res.body.entry.notes).toBe(EDIT_BODY.notes);
  });

  it('refuses a user who does not hold the ability at all, logger or not', async () => {
    mockAuthAs('sales');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('sales'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const res = await request(app).put(ENDPOINT).send(EDIT_BODY);
    expect(res.status).toBe(401);
  });
});

describe('an edit changes everything the drawer captures — and nothing it does not', () => {
  it('changes channel, direction, occurred-at, performer, notes, duration and subject', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    // Starts as a call: outbound, 12 minutes, no subject.
    stubStored(storedEntry({ channel: 'CALL', duration_minutes: 12, subject: null }));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.user.findFirst.mockResolvedValue({ id: TEST_USERS.sales.id });
    stubUpdate(storedEntry({ channel: 'CALL', duration_minutes: 12 }));

    // …and is corrected into an email the SALES colleague sent, on a different day.
    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({
        lead_id: LEAD_ID,
        channel: 'email',
        direction: 'in',
        occurred_at: '2026-08-20T08:15',
        notes: 'Actually it was an email he sent us, not a call I made.',
        performed_by: TEST_USERS.sales.id,
        subject: 'Revised scope — two garage doors',
      });

    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({
      channel: 'email',
      direction: 'in',
      notes: 'Actually it was an email he sent us, not a call I made.',
      performedBy: TEST_USERS.sales.id,
      subject: 'Revised scope — two garage doors',
      // The call-shaped answer no longer applies and is CLEARED, not retained. A duration left
      // behind on an email is what renders as "Outbound email · 12m".
      durationMinutes: null,
    });
    // 08:15 New York (UTC-4 in August) is 12:15 UTC.
    expect(res.body.entry.occurredAt).toBe('2026-08-20T12:15:00.000Z');
  });

  it('adds a duration to a call that was logged without one', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, duration_minutes: 0 });

    expect(res.status).toBe(200);
    // Zero is a real answer to "how long?", not a missing one — the same reading create gives it.
    expect(res.body.entry.durationMinutes).toBe(0);
  });

  it('does NOT change the logger, even when an admin edits somebody else’s entry', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const stored = storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id });
    stubStored(stored);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.user.findFirst.mockResolvedValue({ id: TEST_USERS.sales.id });
    stubUpdate(stored);

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, performed_by: TEST_USERS.sales.id });

    expect(res.status).toBe(200);
    // Still the colleague who typed it, never the admin who corrected it. Telling an eyewitness
    // record from a second-hand one is the point of keeping both names.
    expect(res.body.entry.loggedBy).toBe(TEST_USERS.sales.id);
    expect(res.body.entry.loggedBy).not.toBe(TEST_USERS.admin.id);
  });

  it('refuses a caller who tries to name the logger, rather than ignoring the field', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, logged_by: TEST_USERS.sales.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('refuses an edit that says nothing about the performer, rather than re-crediting the editor', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.sales.id }));
    stubUpdate();

    const { performed_by: _omitted, ...noPerformer } = EDIT_BODY;
    const res = await request(app).put(ENDPOINT).set(authHeader('admin')).send(noPerformer);

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('refuses an edit that says nothing about the channel, rather than silently making it a call', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ channel: 'EMAIL', subject: 'Revised scope' }));
    stubUpdate();

    const { channel: _omitted, ...noChannel } = EDIT_BODY;
    const res = await request(app).put(ENDPOINT).set(authHeader('admin')).send(noChannel);

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RE-POINTING, AND TENANCY.
//
// Moving an entry between a lead and a job IS an edit — the shared timeline row's
// attach/move/detach menu drives a call-record endpoint and is deliberately not extended to
// manual entries, so this is the only way it happens.
//
// The stores below filter the way the database would: a `where` carrying no `organization_id`
// really does match across organisations. That faithfulness is the point — drop the tenant filter
// from a resolve and the fake hands org A's row to org B, so a refusal turns into a 200 rather
// than into a mock artefact. The foreign ids are REAL rows of org B, never random uuids: a random
// uuid exercises "unknown id", which is a different code path from "exists, but not yours".
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA_LEAD = { id: LEAD_ID, organization_id: ALPHA_ORG_ID };
const ORG_B_LEAD = { id: 'e0000000-0000-0000-0000-0000000000b2', organization_id: ORG_B_ID };
const ALPHA_JOB = { id: JOB_ID, organization_id: ALPHA_ORG_ID };
const ORG_B_JOB = { id: 'bb000000-0000-0000-0000-0000000000b2', organization_id: ORG_B_ID };
// The literal, not `CUSTOMER_ID`: that const is declared further down this file, and a
// module-scope initializer referencing it from up here is a temporal-dead-zone error at load.
const ALPHA_CUSTOMER = { id: 'c0000000-0000-0000-0000-000000000001', organization_id: ALPHA_ORG_ID };
const ORG_B_CUSTOMER = { id: 'c0000000-0000-0000-0000-0000000000b2', organization_id: ORG_B_ID };

function anchorStores() {
  const filtered = (rows: { id: string; organization_id: string }[]) => ({ where }: any) =>
    Promise.resolve(
      rows.find(
        (r) =>
          r.id === where.id &&
          (where.organization_id === undefined || r.organization_id === where.organization_id),
      ) ?? null,
    );
  mockPrisma.lead.findFirst.mockImplementation(filtered([ALPHA_LEAD, ORG_B_LEAD]));
  mockPrisma.job.findFirst.mockImplementation(filtered([ALPHA_JOB, ORG_B_JOB]));
  mockPrisma.customer.findFirst.mockImplementation(filtered([ALPHA_CUSTOMER, ORG_B_CUSTOMER]));
}

/** The stored entry, resolved out of a two-org store the same faithful way. */
function entryStore(...rows: { id: string; organization_id: string }[]) {
  mockPrisma.manualCommunicationLog.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(
      rows.find(
        (r) =>
          r.id === where.id &&
          (where.organization_id === undefined || r.organization_id === where.organization_id),
      ) ?? null,
    ),
  );
}

describe('an edit re-points an entry between a lead and a job', () => {
  it('moves a lead-anchored entry onto a job, clearing the lead it left', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    anchorStores();
    stubUpdate();

    const { lead_id: _dropped, ...onJob } = EDIT_BODY;
    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...onJob, job_id: JOB_ID });

    expect(res.status).toBe(200);
    expect(res.body.entry.jobId).toBe(JOB_ID);
    // The lead it came off is CLEARED. Leaving it set would name both anchors — the state the
    // database's own `manual_communication_logs_exactly_one_anchor` CHECK refuses, and a row that
    // would be counted on two timelines at once.
    expect(res.body.entry.leadId).toBeNull();
  });

  it('moves a job-anchored entry back onto a lead, clearing the job it left', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ lead_id: null, job_id: JOB_ID }));
    anchorStores();
    stubUpdate(storedEntry({ lead_id: null, job_id: JOB_ID }));

    const res = await request(app).put(ENDPOINT).set(authHeader('admin')).send(EDIT_BODY);

    expect(res.status).toBe(200);
    expect(res.body.entry.leadId).toBe(LEAD_ID);
    expect(res.body.entry.jobId).toBeNull();
  });

  // The third anchor (#2021). An entry logged on the wrong record is exactly what the edit path
  // exists for, and "on a lead, when it was really just an account call" is the commonest form
  // of that mistake now three anchors exist. Both directions, because a re-point that could only
  // go one way would leave a customer-anchored entry stranded.
  it('moves a lead-anchored entry onto the customer, clearing the lead it left', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    anchorStores();
    stubUpdate();

    const { lead_id: _dropped, ...onCustomer } = EDIT_BODY;
    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...onCustomer, customer_id: ALPHA_CUSTOMER.id });

    expect(res.status).toBe(200);
    expect(res.body.entry.customerId).toBe(ALPHA_CUSTOMER.id);
    expect(res.body.entry.leadId).toBeNull();
    expect(res.body.entry.jobId).toBeNull();
  });

  it('moves a customer-anchored entry back onto a lead, clearing the customer it left', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ lead_id: null, customer_id: ALPHA_CUSTOMER.id }));
    anchorStores();
    stubUpdate(storedEntry({ lead_id: null, customer_id: ALPHA_CUSTOMER.id }));

    const res = await request(app).put(ENDPOINT).set(authHeader('admin')).send(EDIT_BODY);

    expect(res.status).toBe(200);
    expect(res.body.entry.leadId).toBe(LEAD_ID);
    expect(res.body.entry.customerId).toBeNull();
  });

  // The all-three case at the UPDATE endpoint too. Both endpoints refine the SAME rule object, so
  // this cannot drift from create - but "cannot drift" is a property of today's file, and the
  // rule is the one line in this feature whose broken form looks right.
  it('refuses an edit naming all three anchors', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    anchorStores();
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, job_id: JOB_ID, customer_id: ALPHA_CUSTOMER.id });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('refuses an edit re-pointing onto another organisation\'s customer, as not-found', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    anchorStores();
    stubUpdate();

    const { lead_id: _dropped, ...onCustomer } = EDIT_BODY;
    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...onCustomer, customer_id: ORG_B_CUSTOMER.id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('refuses an edit naming BOTH a lead and a job, and one naming NEITHER', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    anchorStores();
    stubUpdate();

    const both = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, job_id: JOB_ID });
    expect(both.status).toBe(400);

    const { lead_id: _dropped, ...neither } = EDIT_BODY;
    const none = await request(app).put(ENDPOINT).set(authHeader('admin')).send(neither);
    expect(none.status).toBe(400);

    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('rejects a lead belonging to another organisation as not-found, and writes nothing', async () => {
    orgTimezone('America/New_York');
    anchorStores();
    stubUpdate();

    // Org B's own admin can re-point onto org B's lead — the id is real and reachable by someone.
    mockAuthAs('orgB_admin');
    entryStore({ ...storedEntry(), organization_id: ORG_B_ID } as any);
    const owner = await request(app)
      .put(ENDPOINT)
      .set(authHeader('orgB_admin'))
      .send({ ...EDIT_BODY, lead_id: ORG_B_LEAD.id, performed_by: TEST_USERS.orgB_admin.id });
    expect(owner.status).toBe(200);

    // The SAME id, from org A, is not-found.
    vi.clearAllMocks();
    clearTokenCache();
    clearPermissionCache();
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    anchorStores();
    stubStored();
    stubUpdate();
    const stranger = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, lead_id: ORG_B_LEAD.id });

    expect(stranger.status).toBe(404);
    expect(stranger.body.error).toBe('Lead not found');
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('rejects a job belonging to another organisation as not-found, and writes nothing', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored();
    anchorStores();
    stubUpdate();

    const { lead_id: _dropped, ...onJob } = EDIT_BODY;
    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...onJob, job_id: ORG_B_JOB.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('rejects an ENTRY belonging to another organisation as not-found', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    // The entry is real — org B's admin owns it — and the requester is org A's admin, who is an
    // ADMIN and would pass the row-level rule if the entry were theirs to see at all.
    entryStore({ ...storedEntry(), organization_id: ORG_B_ID } as any);
    anchorStores();
    stubUpdate();

    const res = await request(app).put(ENDPOINT).set(authHeader('admin')).send(EDIT_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Entry not found');
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ORG CLOCK, ON THE EDIT PATH.
//
// The same discriminating fixture the create suite uses, because an edit is exactly as capable of
// landing on the wrong day as a creation is — and a test whose zones do not straddle would pass
// against the browser's clock, the server's clock, and the org's alike:
//
//   picked            2026-08-27 09:00, zoneless
//   ORG   (Auckland)  2026-08-26T21:00:00.000Z   <- the only correct answer
//   USER  (Los Angeles, pinned below)  2026-08-27T16:00:00.000Z
//   SERVER (UTC, which is what production runs as)  2026-08-27T09:00:00.000Z
// ─────────────────────────────────────────────────────────────────────────────

const AUCKLAND = 'Pacific/Auckland';
const PICKED = '2026-08-27T09:00';
const ORG_TRUTH = '2026-08-26T21:00:00.000Z';

describe('occurred_at on an edit is composed against the ORGANISATION timezone', () => {
  const realTZ = process.env.TZ;
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

  it('lands on the org day the editor picked, not the editor’s day and not the server’s', async () => {
    mockAuthAs('admin');
    orgTimezone(AUCKLAND);
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: PICKED });

    expect(res.status).toBe(200);
    expect(res.body.entry.occurredAt).toBe(ORG_TRUTH);

    // The fixture really is discriminating: neither the editor's zone nor the server's UTC
    // reading of the same string produces that instant.
    expect(res.body.entry.occurredAt).not.toBe(new Date(PICKED).toISOString());
    expect(res.body.entry.occurredAt).not.toBe(`${PICKED}:00.000Z`);
    // And the day genuinely straddles: the org calls it the 27th, UTC calls it the 26th.
    expect(orgDayOf(new Date(res.body.entry.occurredAt), AUCKLAND)).toBe('2026-08-27');
    expect(res.body.entry.occurredAt.slice(0, 10)).toBe('2026-08-26');
  });

  it('refuses an occurred_at that already carries a zone, so no client can impose its own', async () => {
    mockAuthAs('admin');
    orgTimezone(AUCKLAND);
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, occurred_at: '2026-08-27T09:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C9 — THE OPTIONAL FIELDS FOLLOW THE CHANNEL, ON UPDATE TOO.
//
// The create endpoint's refusal was, until this slice, the SOLE enforcement of this rule: there
// is no DB CHECK behind it, and the timeline mapper read `duration_minutes` without
// consulting the channel. A row with channel=EMAIL and duration=12 renders "Outbound email · 12m"
// — a statement that a conversation had a length. An update endpoint that let the pairing through
// would have made that reachable for the first time. (The mapper is pinned as well now; see
// job-communications-manual-channel.test.ts.)
// ─────────────────────────────────────────────────────────────────────────────

describe('the optional fields belong to their own channel on an edit as on a create', () => {
  function arrangeEdit() {
    orgTimezone('America/New_York');
    stubStored();
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();
  }

  it.each([['sms'], ['email']])('refuses a duration on a %s', async (channel) => {
    mockAuthAs('admin');
    arrangeEdit();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, channel, duration_minutes: 12 });

    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({
      field: 'duration_minutes',
      message: 'a duration belongs to a call',
    });
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  // THE RETIRED OUTCOME, ON THE UPDATE SCHEMA TOO. It is no longer refused for sitting on the
  // wrong CHANNEL - it is refused because the key is UNKNOWN and the schema is `.strict()`, so
  // every channel and every value is a 400. 'voicemail' and the rest were accepted before the
  // retirement, which is what lets these fail against the old schema instead of passing vacuously.
  // This survives the column drop unchanged: `.strict()` refuses the KEY, and it would refuse it
  // just the same if the word had never named a column.
  it.each([['call'], ['sms'], ['email']])(
    'refuses a body naming an outcome on a %s',
    async (channel) => {
      for (const outcome of ['connected', 'no_answer', 'voicemail', 'callback_requested']) {
        mockAuthAs('admin');
        arrangeEdit();

        const res = await request(app)
          .put(ENDPOINT)
          .set(authHeader('admin'))
          .send({ ...EDIT_BODY, channel, outcome });

        expect(res.status).toBe(400);
        expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
      }
    },
  );

  it.each([['call'], ['sms']])('refuses a subject on a %s', async (channel) => {
    mockAuthAs('admin');
    arrangeEdit();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, channel, subject: 'Revised scope' });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  // The whole shape of the hazard in one request: an entry that WAS a call with a duration,
  // edited to be an email, with the call-shaped answer still attached.
  it('refuses turning a call with a duration into an email that keeps it', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ duration_minutes: 12 }));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    stubUpdate();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, channel: 'email', duration_minutes: 12 });

    expect(res.status).toBe(400);
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });

  it('still refuses a duration longer than a day, and names the ceiling when it does', async () => {
    mockAuthAs('admin');
    arrangeEdit();

    const res = await request(app)
      .put(ENDPOINT)
      .set(authHeader('admin'))
      .send({ ...EDIT_BODY, duration_minutes: 1441 });

    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({
      field: 'duration_minutes',
      message: 'must be at most 1440 minutes',
    });
    expect(mockPrisma.manualCommunicationLog.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — the same three rules, and the entry really goes.
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/communication/manual-log/:id', () => {
  it('lets the entry’s logger remove it', async () => {
    mockAuthAs('admin');
    stubStored();
    mockPrisma.manualCommunicationLog.delete.mockResolvedValue(storedEntry());

    const res = await request(app).delete(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  it('lets an organisation ADMIN remove an entry somebody else logged', async () => {
    mockAuthAs('admin');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id }));
    mockPrisma.manualCommunicationLog.delete.mockResolvedValue(storedEntry());

    const res = await request(app).delete(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(204);
  });

  it('refuses another user who holds the ability but neither logged it nor is an admin', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    stubStored(storedEntry({ logged_by: TEST_USERS.admin.id }));

    const res = await request(app).delete(ENDPOINT).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.manualCommunicationLog.delete).not.toHaveBeenCalled();
  });

  it('lets that same user remove an entry THEY logged', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id }));
    mockPrisma.manualCommunicationLog.delete.mockResolvedValue(storedEntry());

    const res = await request(app).delete(ENDPOINT).set(authHeader('sales'));

    expect(res.status).toBe(204);
  });

  it('refuses a user who does not hold the ability at all, logger or not', async () => {
    mockAuthAs('sales');
    stubStored(storedEntry({ logged_by: TEST_USERS.sales.id }));

    const res = await request(app).delete(ENDPOINT).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.manualCommunicationLog.delete).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const res = await request(app).delete(ENDPOINT);
    expect(res.status).toBe(401);
  });

  it('rejects an entry belonging to another organisation as not-found, and removes nothing', async () => {
    mockAuthAs('admin');
    entryStore({ ...storedEntry(), organization_id: ORG_B_ID } as any);

    const res = await request(app).delete(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.manualCommunicationLog.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A DELETED ENTRY DISAPPEARS — from the lead, the job AND the customer roll-up.
//
// Driven end to end through HTTP against a REAL in-memory store: the POSTs write into it, the
// DELETE removes from it, and all three aggregations really query it through the shared
// `whereMatcher`. A canned `findMany` returning [] afterwards would prove only that a mock was
// told to answer nothing.
//
// Two entries are created, and only one is deleted. Without the survivor, an aggregation that had
// simply stopped reading the table at all would pass.
// ─────────────────────────────────────────────────────────────────────────────

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const CUSTOMER = { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' };
const ANCHOR_LEAD = { lead_number: 'L00001', customer_id: CUSTOMER_ID, customer: CUSTOMER };
const ANCHOR_JOB = { job_number: 'J00042', customer_id: CUSTOMER_ID, customer: CUSTOMER };

/** The store the three aggregations read, and the DELETE really removes from. */
function liveStore() {
  const rows: any[] = [];
  mockPrisma.manualCommunicationLog.create.mockImplementation((args: any) => {
    const row = { id: `11110000-0000-0000-0000-00000000000${rows.length + 1}`, ...args.data };
    rows.push(row);
    return Promise.resolve(row);
  });
  mockPrisma.manualCommunicationLog.findFirst.mockImplementation(({ where }: any) =>
    Promise.resolve(
      rows.find(
        (r) =>
          r.id === where.id &&
          (where.organization_id === undefined || r.organization_id === where.organization_id),
      ) ?? null,
    ),
  );
  mockPrisma.manualCommunicationLog.delete.mockImplementation(({ where }: any) => {
    const i = rows.findIndex((r) => r.id === where.id);
    const [gone] = rows.splice(i, 1);
    return Promise.resolve(gone);
  });
  mockPrisma.manualCommunicationLog.findMany.mockImplementation(({ where, include }: any) =>
    Promise.resolve(
      rows
        .map((r) => ({
          ...r,
          lead: r.lead_id ? ANCHOR_LEAD : null,
          job: r.job_id ? ANCHOR_JOB : null,
        }))
        .filter((r) => matchesWhere(r, where))
        .map(({ lead, job, ...columns }: any) => ({
          ...columns,
          ...(include?.lead ? { lead } : {}),
          ...(include?.job ? { job } : {}),
        })),
    ),
  );
  return rows;
}

describe('a deleted entry disappears from the lead, job and customer timelines', () => {
  it('is gone from all three, while the entry beside it stays', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_ID });
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    liveStore();

    const create = '/api/communication/manual-log';
    const onLead = await request(app)
      .post(create)
      .set(authHeader('admin'))
      .send({
        lead_id: LEAD_ID,
        direction: 'out',
        occurred_at: '2026-08-26T16:00',
        notes: 'The one that gets deleted — logged on the wrong lead.',
      });
    const onJob = await request(app)
      .post(create)
      .set(authHeader('admin'))
      .send({
        job_id: JOB_ID,
        direction: 'out',
        occurred_at: '2026-08-26T17:00',
        notes: 'The survivor — a real conversation about the install window.',
      });
    expect(onLead.status).toBe(201);
    expect(onJob.status).toBe(201);

    const idsOn = async (path: string) => {
      const res = await request(app).get(path).set(authHeader('admin'));
      expect(res.status).toBe(200);
      return res.body.items.map((i: any) => i.id);
    };
    const LEAD_TIMELINE = `/api/leads/${LEAD_ID}/communications`;
    const JOB_TIMELINE = `/api/jobs/${JOB_ID}/communications`;
    const CUSTOMER_TIMELINE = `/api/customers/${CUSTOMER_ID}/communications`;

    // Present on all three before the delete — otherwise "absent afterwards" says nothing.
    expect(await idsOn(LEAD_TIMELINE)).toContain(onLead.body.entry.id);
    expect(await idsOn(JOB_TIMELINE)).toContain(onJob.body.entry.id);
    expect(await idsOn(CUSTOMER_TIMELINE)).toEqual([onLead.body.entry.id, onJob.body.entry.id]);

    const removed = await request(app)
      .delete(`${create}/${onLead.body.entry.id}`)
      .set(authHeader('admin'));
    expect(removed.status).toBe(204);

    expect(await idsOn(LEAD_TIMELINE)).not.toContain(onLead.body.entry.id);
    expect(await idsOn(CUSTOMER_TIMELINE)).not.toContain(onLead.body.entry.id);
    // …and the survivor is still on the job AND still rolling up onto the customer.
    expect(await idsOn(JOB_TIMELINE)).toEqual([onJob.body.entry.id]);
    expect(await idsOn(CUSTOMER_TIMELINE)).toEqual([onJob.body.entry.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE EDITOR'S READ.
//
// The capture form has to reopen on what is actually stored, and the timeline item is NOT enough
// to do that from: its `preview` is truncated at 160 characters, and it carries no duration, no
// performer id and no subject. Seeding an edit form from it would silently discard
// the tail of somebody's notes the moment they pressed save.
//
// Scoped to the same principals as the edit itself. This is the EDITOR's read, not a general one
// — the timeline is the general read, and it is guarded by `read Communication`.
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/communication/manual-log/:id', () => {
  it('returns the whole stored entry, untruncated, for the logger to edit', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    const long = 'He walked me through the whole job. '.repeat(20);
    stubStored(storedEntry({ notes: long, duration_minutes: 12 }));

    const res = await request(app).get(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({
      id: ENTRY_ID,
      channel: 'call',
      direction: 'out',
      durationMinutes: 12,
      performedBy: TEST_USERS.admin.id,
      loggedBy: TEST_USERS.admin.id,
      leadId: LEAD_ID,
    });
    // The FULL notes, not the timeline's 160-character preview.
    expect(res.body.entry.notes).toBe(long);
    expect(res.body.entry.notes.length).toBeGreaterThan(160);
  });

  it('reopens on the ORGANISATION’s wall clock, which is what the form captured', async () => {
    mockAuthAs('admin');
    orgTimezone(AUCKLAND);
    // The instant an Auckland org stores for a 09:00 entry on the 27th.
    stubStored(storedEntry({ occurred_at: new Date(ORG_TRUTH) }));

    const res = await request(app).get(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.entry.occurredAt).toBe(ORG_TRUTH);
    // …and the value the picker reopens on is the ORG's reading of it, not UTC's and not the
    // editor's. Reopening on the wrong one and saving unchanged would MOVE the entry.
    expect(res.body.entry.occurredAtLocal).toBe(PICKED);
    expect(res.body.entry.occurredAtLocal).not.toBe(ORG_TRUTH.slice(0, 16));
  });

  it('refuses a user who holds the ability but may not modify the entry', async () => {
    mockAuthAs('sales');
    grantLogPastTo('SALES');
    orgTimezone('America/New_York');
    stubStored(storedEntry({ logged_by: TEST_USERS.admin.id }));

    const res = await request(app).get(ENDPOINT).set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('rejects an entry belonging to another organisation as not-found', async () => {
    mockAuthAs('admin');
    orgTimezone('America/New_York');
    entryStore({ ...storedEntry(), organization_id: ORG_B_ID } as any);

    const res = await request(app).get(ENDPOINT).set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('401s an unauthenticated caller', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE TIMELINE HAS TO CARRY FOR THE EDIT AFFORDANCE TO EXIST.
//
// A row offers an edit only to somebody who may actually perform one, and the client cannot work
// that out from a display name — two colleagues can share one. The LOGGER'S ID rides the item, as
// a fact about the row; the client pairs it with who it knows itself to be. The server still
// enforces the rule on the write, so a client that got the pairing wrong offers a button that
// 403s rather than a change that lands.
// ─────────────────────────────────────────────────────────────────────────────

describe('a logged entry names its logger by id on the timeline', () => {
  it('carries loggedById, beside the display names it already carried', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([
      {
        ...storedEntry({ logged_by: TEST_USERS.sales.id, performed_by: TEST_USERS.admin.id }),
        lead: { lead_number: 'L00001', customer: null },
        job: null,
        performer: { first_name: 'Test', last_name: 'Admin' },
        logger: { first_name: 'Test', last_name: 'Sales' },
      },
    ]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      manuallyLogged: true,
      loggedById: TEST_USERS.sales.id,
      loggedByName: 'Test Sales',
      performedByName: 'Test Admin',
    });
    // The PERFORMER's id is deliberately absent: being credited with a conversation somebody else
    // typed up does not make their record of it yours to rewrite, so no client needs it to decide
    // whether to offer an edit.
    expect(res.body.items[0].performedById).toBeUndefined();
  });

  it('does not put it on a platform row, which nobody hand-edits', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.callSession.findMany.mockResolvedValue([
      {
        id: 'ca000000-0000-0000-0000-000000000001',
        direction: 'in',
        from_number: '+12125551042',
        to_number: '+15125550100',
        status: 'completed',
        duration_sec: 95,
        started_at: new Date('2026-08-26T21:00:00.000Z'),
        disposition: null,
        summary: 'Customer called back.',
        answered_by: null,
        lead_id: LEAD_ID,
        customer: null,
        job: null,
        lead: { lead_number: 'L00001' },
        agent: null,
        organization_id: ALPHA_ORG_ID,
      },
    ]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_ID}/communications`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.items[0].loggedById).toBeUndefined();
    expect(res.body.items[0].manuallyLogged).toBeUndefined();
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
