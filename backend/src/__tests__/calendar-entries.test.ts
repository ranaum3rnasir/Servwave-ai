import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS, mockRoleGrantsWithout, CUSTOMER_FIXTURE } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  calendarEntry: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  calendarEntryParticipant: {
    createMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  user: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────

const ENTRY_ID = 'ce000000-0000-0000-0000-000000000001';
const USER_PARTICIPANT_ID = TEST_USERS.sales.id; // an org user distinct from the dispatcher actor
const PARTICIPANT_ROW_USER_ID = 'cep00000-0000-0000-0000-000000000001';
const PARTICIPANT_ROW_CUSTOMER_ID = 'cep00000-0000-0000-0000-000000000002';

// rrule/recurrence_until are here on purpose (the real row carries them - migration
// 20260824190000_calendar_entries_crud writes them null, never non-null, but the COLUMNS
// exist). Asserting "the response has no rrule" is only a real regression test if the fixture
// the mock returns actually HAS one to leak: with a mocked Prisma that (below, via selectFrom)
// honours the `select` argument, a controller that switches to a bare row-spread instead of
// CALENDAR_ENTRY_SELECT would leak this value into the response and turn those tests red.
const ENTRY_FIXTURE = {
  id: ENTRY_ID,
  organization_id: ALPHA_ORG_ID,
  title: 'Team meeting',
  description: '',
  start: new Date('2026-09-01T09:00:00.000Z'),
  end: new Date('2026-09-01T10:00:00.000Z'),
  is_all_day: false,
  rrule: 'FREQ=YEARLY',
  recurrence_until: new Date('2027-01-01T00:00:00.000Z'),
  created_by: TEST_USERS.dispatcher.id,
  created_at: new Date('2026-08-24T00:00:00.000Z'),
  updated_at: new Date('2026-08-24T00:00:00.000Z'),
  participants: [] as unknown[],
};

/**
 * Mini stand-in for Prisma's own `select` behaviour: return only the keys the caller asked
 * for. Without this, the mock would hand back rrule/recurrence_until regardless of what the
 * controller selected, and "the response has no rrule" would pass even if the code stopped
 * using CALENDAR_ENTRY_SELECT entirely — exactly the placebo QA flagged.
 */
function selectFrom<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>): Partial<T> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (key in row) out[key] = row[key as keyof T];
  }
  return out as Partial<T>;
}

const MULTI_DAY_ENTRY_FIXTURE = {
  ...ENTRY_FIXTURE,
  id: 'ce000000-0000-0000-0000-000000000002',
  title: 'Dave is on vacation',
  start: new Date('2026-09-07T09:00:00.000Z'), // Mon
  end:   new Date('2026-09-11T17:00:00.000Z'), // Fri
};

const PARTICIPANT_USER_ROW = { id: PARTICIPANT_ROW_USER_ID, kind: 'USER', user_id: USER_PARTICIPANT_ID, customer_id: null, notified_at: null };
const PARTICIPANT_CUSTOMER_ROW = { id: PARTICIPANT_ROW_CUSTOMER_ID, kind: 'CUSTOMER', user_id: null, customer_id: CUSTOMER_FIXTURE.id, notified_at: null };

beforeEach(() => {
  vi.clearAllMocks();

  mockPrisma.calendarEntry.findMany.mockImplementation(
    ({ select }: { select?: Record<string, unknown> } = {}) =>
      Promise.resolve([selectFrom(ENTRY_FIXTURE, select)]),
  );

  // findFirst is used two different ways by the controller: an existence+tenant check
  // ({id, organization_id}) before update/getOne/remove, and a post-write refetch inside the
  // transaction ({id} only, tenant safety already established at creation). Honour both by
  // keying purely on id and, when present, organization_id — and apply `select` the way real
  // Prisma would, so a controller regression to an unselected row-spread is observable here.
  mockPrisma.calendarEntry.findFirst.mockImplementation(
    ({ where, select }: { where: { id?: string; organization_id?: string }; select?: Record<string, unknown> }) => {
      const fixture = where.id === MULTI_DAY_ENTRY_FIXTURE.id ? MULTI_DAY_ENTRY_FIXTURE : ENTRY_FIXTURE;
      if (where.id && where.id !== fixture.id) return Promise.resolve(null);
      if (where.organization_id && where.organization_id !== ALPHA_ORG_ID) return Promise.resolve(null);
      return Promise.resolve(selectFrom(fixture, select));
    },
  );
  mockPrisma.calendarEntry.create.mockResolvedValue({ id: ENTRY_ID });
  mockPrisma.calendarEntry.update.mockResolvedValue({ id: ENTRY_ID });
  mockPrisma.calendarEntry.delete.mockResolvedValue({ id: ENTRY_ID });

  mockPrisma.calendarEntryParticipant.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.calendarEntryParticipant.deleteMany.mockResolvedValue({ count: 0 });

  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));

  // Org-membership check (validateParticipantRefs) AND display resolution
  // (resolveParticipantDisplay) both read through these two delegates.
  mockPrisma.user.findMany.mockResolvedValue([{ id: USER_PARTICIPANT_ID, first_name: 'Sam', last_name: 'Sales' }]);
  mockPrisma.customer.findMany.mockResolvedValue([{
    id: CUSTOMER_FIXTURE.id,
    company_name: null,
    first_name: CUSTOMER_FIXTURE.first_name,
    last_name: CUSTOMER_FIXTURE.last_name,
    customer_number: 'C00001',
    email: CUSTOMER_FIXTURE.email,
  }]);
});

// ══════════════════════════════════════════════════════
// POST /api/calendar-entries
// ══════════════════════════════════════════════════════

describe('POST /api/calendar-entries', () => {
  it('creates with 0 participants → 201, and does not write a participant row for created_by', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({ title: 'Solo reminder', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(res.body.calendar_entry.participants).toEqual([]);
    // The creator is not a participant (spec §2) — nothing is ever inserted when none were sent.
    expect(mockPrisma.calendarEntryParticipant.createMany).not.toHaveBeenCalled();
  });

  it('creates with 1 user + 1 customer participant → both rows written, neither is the creator', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [PARTICIPANT_USER_ROW, PARTICIPANT_CUSTOMER_ROW] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Team meeting',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T10:00:00.000Z',
        participants: [
          { kind: 'USER', user_id: USER_PARTICIPANT_ID },
          { kind: 'CUSTOMER', customer_id: CUSTOMER_FIXTURE.id },
        ],
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.calendarEntryParticipant.createMany).toHaveBeenCalledTimes(1);
    const written = mockPrisma.calendarEntryParticipant.createMany.mock.calls[0][0].data as Record<string, unknown>[];
    expect(written).toHaveLength(2);
    expect(written).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'USER', user_id: USER_PARTICIPANT_ID, customer_id: null }),
      expect.objectContaining({ kind: 'CUSTOMER', customer_id: CUSTOMER_FIXTURE.id, user_id: null }),
    ]));
    // Nobody wrote a row for the actor (dispatcher) — the creator is not a participant.
    expect(written.every((r) => r.user_id !== TEST_USERS.dispatcher.id)).toBe(true);

    // Response resolves display fields so later slices don't re-resolve them.
    // 'CUSTOMER' < 'USER' alphabetically, so the sorted order is [customer, user].
    const [customerP, userP] = res.body.calendar_entry.participants.sort((a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind));
    expect(customerP).toMatchObject({ kind: 'CUSTOMER', name: expect.any(String), email: CUSTOMER_FIXTURE.email });
    expect(userP).toMatchObject({ kind: 'USER', first_name: 'Sam', last_name: 'Sales' });
  });

  it('rejects a participant whose user_id does not belong to the org (400)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.user.findMany.mockResolvedValue([]); // no match in-org

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Team meeting',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'USER', user_id: '99999999-0000-0000-0000-000000000099' }],
      });

    expect(res.status).toBe(400);
    expect(mockPrisma.calendarEntry.create).not.toHaveBeenCalled();
  });

  it('rejects a participant whose kind does not match its id field (400, zod)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Team meeting',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'USER', customer_id: CUSTOMER_FIXTURE.id }],
      });

    expect(res.status).toBe(400);
  });

  it('rejects rrule and recurrence_until — reserved columns, never API-writable', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Birthday',
        start: '2026-09-01T09:00:00.000Z',
        end: '2026-09-01T10:00:00.000Z',
        rrule: 'FREQ=YEARLY',
      });

    expect(res.status).toBe(400);
    expect(mockPrisma.calendarEntry.create).not.toHaveBeenCalled();
  });

  // Slice 05's zero-length decision: a genuine zero-length entry (start === end) is impossible
  // BY CONSTRUCTION, not merely discouraged by the frontend's own `minutes > 0` save gate — the
  // API itself must refuse it too, since all-day is exactly where whole-day/zero-length shapes
  // start to matter and a second client (or a future recurrence writer) has no frontend gate at
  // all. `end > start` strictly, not `>=`.
  it('rejects a zero-length entry (start === end) → 400', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({ title: 'Instant', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(mockPrisma.calendarEntry.create).not.toHaveBeenCalled();
  });

  it('never returns rrule or recurrence_until in the response body (fixture carries both, to prove this isn\'t a placebo)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({ title: 'Team meeting', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z' });

    expect(res.status).toBe(201);
    // ENTRY_FIXTURE.rrule/.recurrence_until are non-null and the mock honours `select` (see
    // selectFrom) — so this only passes because CALENDAR_ENTRY_SELECT is actually what's sent.
    // A regression to a bare row-spread would leak both fields right back into the body.
    expect(res.body.calendar_entry).not.toHaveProperty('rrule');
    expect(res.body.calendar_entry).not.toHaveProperty('recurrence_until');

    // Pin the mechanism, not just the outcome: the `select` argument itself must exclude both.
    const refetchCall = mockPrisma.calendarEntry.findFirst.mock.calls.at(-1)?.[0] as { select?: Record<string, unknown> };
    expect(refetchCall.select).toBeDefined();
    expect(refetchCall.select).not.toHaveProperty('rrule');
    expect(refetchCall.select).not.toHaveProperty('recurrence_until');
  });

  it('SALES caller without the grant gets 403; DISPATCHER gets 201', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['create', 'CalendarEntry']);

    const resSales = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('sales'))
      .send({ title: 'Team meeting', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z' });
    expect(resSales.status).toBe(403);

    mockAuthAs('dispatcher');
    const resDispatcher = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({ title: 'Team meeting', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z' });
    expect(resDispatcher.status).toBe(201);
  });
});

// ══════════════════════════════════════════════════════
// GET /api/calendar-entries
// ══════════════════════════════════════════════════════

describe('GET /api/calendar-entries', () => {
  it('a multi-day entry (Mon 09:00 → Fri 17:00) is returned by a window covering only Wednesday', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findMany.mockResolvedValue([MULTI_DAY_ENTRY_FIXTURE]);

    const startAfter = '2026-09-09T00:00:00.000Z';  // Wed 00:00
    const startBefore = '2026-09-09T23:59:59.000Z'; // Wed 23:59

    const res = await request(app)
      .get(`/api/calendar-entries?start_after=${startAfter}&start_before=${startBefore}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.calendar_entries).toHaveLength(1);
    expect(res.body.calendar_entries[0].id).toBe(MULTI_DAY_ENTRY_FIXTURE.id);

    // The filter is an OVERLAP test, not containment: start <= start_before AND end >= start_after.
    const args = mockPrisma.calendarEntry.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      start: { lte: new Date(startBefore) },
      end: { gte: new Date(startAfter) },
    });
  });

  it('SALES caller without the grant gets 403; DISPATCHER gets 200', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['read', 'CalendarEntry']);

    const resSales = await request(app).get('/api/calendar-entries').set(authHeader('sales'));
    expect(resSales.status).toBe(403);

    mockAuthAs('dispatcher');
    const resDispatcher = await request(app).get('/api/calendar-entries').set(authHeader('dispatcher'));
    expect(resDispatcher.status).toBe(200);
  });

  describe('customer_id filter (slice 10 — customer Schedule tab)', () => {
    // Two entries carrying a CUSTOMER participant for the SAME customer_id, but living in
    // different orgs — the shape a broken filter (customer_id alone, no tenant scope) would
    // conflate. A real cross-org customer can never actually share an id (UUIDs), so this is
    // the deliberately adversarial fixture for "same-named customer in another org": if the
    // controller ever dropped tenantWhere from the composed `where`, this is what would leak.
    const ALPHA_ENTRY = {
      ...ENTRY_FIXTURE,
      id: 'ce000000-0000-0000-0000-00000000000a',
      title: 'Alpha org walkthrough follow-up',
      organization_id: ALPHA_ORG_ID,
      participants: [PARTICIPANT_CUSTOMER_ROW],
    };
    const ORG_B_ENTRY = {
      ...ENTRY_FIXTURE,
      id: 'ce000000-0000-0000-0000-00000000000b',
      title: 'Org B entry for a same-id customer row',
      organization_id: ORG_B_ID,
      participants: [PARTICIPANT_CUSTOMER_ROW],
    };
    // An entry in the caller's own org with NO customer participant at all — proves the filter
    // excludes entries that hold no matching CUSTOMER-kind participant, not just other orgs'.
    const ALPHA_ENTRY_NO_CUSTOMER = {
      ...ENTRY_FIXTURE,
      id: 'ce000000-0000-0000-0000-00000000000c',
      title: 'Alpha org entry with no customer participant',
      organization_id: ALPHA_ORG_ID,
      participants: [],
    };
    const ALL_ENTRIES = [ALPHA_ENTRY, ORG_B_ENTRY, ALPHA_ENTRY_NO_CUSTOMER];

    beforeEach(() => {
      // Faithful-enough restatement of the controller's own where-clause semantics
      // (organization_id equality + participants.some(kind/customer_id match)) so this test
      // actually exercises filtering rather than only inspecting the where object passed in.
      mockPrisma.calendarEntry.findMany.mockImplementation(
        ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
          const participantsSome = (where.participants as { some?: { kind?: string; customer_id?: string } } | undefined)?.some;
          const matches = ALL_ENTRIES.filter((e) => {
            if (where.organization_id && e.organization_id !== where.organization_id) return false;
            if (participantsSome) {
              return e.participants.some(
                (p) => p.kind === participantsSome.kind && p.customer_id === participantsSome.customer_id,
              );
            }
            return true;
          });
          return Promise.resolve(matches.map((e) => selectFrom(e, select)));
        },
      );
    });

    it('returns only entries holding a CUSTOMER participant with that id, tenant-scoped', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .get(`/api/calendar-entries?customer_id=${CUSTOMER_FIXTURE.id}`)
        .set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      expect(res.body.calendar_entries).toHaveLength(1);
      expect(res.body.calendar_entries[0].id).toBe(ALPHA_ENTRY.id);

      const args = mockPrisma.calendarEntry.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(args.where).toMatchObject({
        organization_id: ALPHA_ORG_ID,
        participants: { some: { kind: 'CUSTOMER', customer_id: CUSTOMER_FIXTURE.id } },
      });
    });

    it('does NOT return another org\'s entry for a same-id customer participant', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .get(`/api/calendar-entries?customer_id=${CUSTOMER_FIXTURE.id}`)
        .set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      const ids = (res.body.calendar_entries as { id: string }[]).map((e) => e.id);
      expect(ids).not.toContain(ORG_B_ENTRY.id);
    });

    it('excludes an in-org entry with no matching CUSTOMER participant', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .get(`/api/calendar-entries?customer_id=${CUSTOMER_FIXTURE.id}`)
        .set(authHeader('dispatcher'));

      expect(res.status).toBe(200);
      const ids = (res.body.calendar_entries as { id: string }[]).map((e) => e.id);
      expect(ids).not.toContain(ALPHA_ENTRY_NO_CUSTOMER.id);
    });

    it('with no customer_id, the where clause carries no participants filter at all', async () => {
      mockAuthAs('dispatcher');

      await request(app).get('/api/calendar-entries').set(authHeader('dispatcher'));

      const args = mockPrisma.calendarEntry.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(args.where).not.toHaveProperty('participants');
    });
  });

  it('never leaks rrule/recurrence_until (fixture carries both; default mock honours select)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).get('/api/calendar-entries').set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.calendar_entries[0]).not.toHaveProperty('rrule');
    expect(res.body.calendar_entries[0]).not.toHaveProperty('recurrence_until');

    const call = mockPrisma.calendarEntry.findMany.mock.calls[0][0] as { select?: Record<string, unknown> };
    expect(call.select).not.toHaveProperty('rrule');
    expect(call.select).not.toHaveProperty('recurrence_until');
  });
});

// ══════════════════════════════════════════════════════
// GET /api/calendar-entries/:id
// ══════════════════════════════════════════════════════

describe('GET /api/calendar-entries/:id', () => {
  it('returns the entry for the owning org, and never leaks rrule/recurrence_until (fixture carries both)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).get(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.calendar_entry.id).toBe(ENTRY_ID);
    expect(res.body.calendar_entry).not.toHaveProperty('rrule');
    expect(res.body.calendar_entry).not.toHaveProperty('recurrence_until');

    const call = mockPrisma.calendarEntry.findFirst.mock.calls[0][0] as { select?: Record<string, unknown> };
    expect(call.select).not.toHaveProperty('rrule');
    expect(call.select).not.toHaveProperty('recurrence_until');
  });

  it('a cross-org read returns 404, not the row', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).get(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(res.body.calendar_entry).toBeUndefined();
  });

  it('SALES caller without the grant gets 403; DISPATCHER gets 200', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['read', 'CalendarEntry']);

    const resSales = await request(app).get(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('sales'));
    expect(resSales.status).toBe(403);

    mockAuthAs('dispatcher');
    const resDispatcher = await request(app).get(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher'));
    expect(resDispatcher.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════
// PATCH /api/calendar-entries/:id
// ══════════════════════════════════════════════════════

describe('PATCH /api/calendar-entries/:id', () => {
  it('replaces the participant set wholesale', async () => {
    mockAuthAs('dispatcher');
    // Existing entry already has 2 participants.
    mockPrisma.calendarEntry.findFirst.mockImplementation(({ where }: { where: { id?: string; organization_id?: string } }) => {
      if (where.organization_id && where.organization_id !== ALPHA_ORG_ID) return Promise.resolve(null);
      return Promise.resolve({ ...ENTRY_FIXTURE, participants: [PARTICIPANT_USER_ROW, PARTICIPANT_CUSTOMER_ROW] });
    });

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ participants: [{ kind: 'CUSTOMER', customer_id: CUSTOMER_FIXTURE.id }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.calendarEntryParticipant.deleteMany).toHaveBeenCalledWith({ where: { calendar_entry_id: ENTRY_ID } });
    expect(mockPrisma.calendarEntryParticipant.createMany).toHaveBeenCalledTimes(1);
    const written = mockPrisma.calendarEntryParticipant.createMany.mock.calls[0][0].data as Record<string, unknown>[];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'CUSTOMER', customer_id: CUSTOMER_FIXTURE.id });
  });

  it('replacing with an empty array clears participants (zero participants is valid)', async () => {
    mockAuthAs('dispatcher');
    // Existence check returns the entry as it stands before the replace; the default mock's
    // participants: [] on the fixture is fine here — this test's assertions are on the WRITES
    // (deleteMany fires, createMany does not) and on the post-replace response, not on what
    // existed beforehand.
    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ participants: [] });

    expect(res.status).toBe(200);
    expect(mockPrisma.calendarEntryParticipant.deleteMany).toHaveBeenCalledWith({ where: { calendar_entry_id: ENTRY_ID } });
    expect(mockPrisma.calendarEntryParticipant.createMany).not.toHaveBeenCalled();
    expect(res.body.calendar_entry.participants).toEqual([]);
  });

  it('omitting participants entirely leaves the existing set untouched, and never leaks rrule/recurrence_until', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ title: 'Renamed' });

    expect(res.status).toBe(200);
    expect(mockPrisma.calendarEntryParticipant.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.calendarEntryParticipant.createMany).not.toHaveBeenCalled();
    expect(res.body.calendar_entry).not.toHaveProperty('rrule');
    expect(res.body.calendar_entry).not.toHaveProperty('recurrence_until');

    // Last findFirst call is the post-update refetch inside the transaction — pin its select.
    const refetchCall = mockPrisma.calendarEntry.findFirst.mock.calls.at(-1)?.[0] as { select?: Record<string, unknown> };
    expect(refetchCall.select).not.toHaveProperty('rrule');
    expect(refetchCall.select).not.toHaveProperty('recurrence_until');
  });

  // Effective-range validation: the zod schema only cross-checks start/end when BOTH are in
  // the same request body. A single-field PATCH has to be checked against the STORED row's
  // other field, in the controller, or an inverted row slips through. ENTRY_FIXTURE is
  // 2026-09-01T09:00 → 2026-09-01T10:00.
  describe('effective start/end range (stored row + partial patch)', () => {
    it('PATCH start only, past the stored end → 400', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ start: '2026-09-01T11:00:00.000Z' }); // stored end is 10:00

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });

    it('PATCH end only, before the stored start → 400', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ end: '2026-09-01T08:00:00.000Z' }); // stored start is 09:00

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });

    it('PATCH start only, still before the stored end → 200', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ start: '2026-09-01T09:30:00.000Z' }); // stored end is 10:00 — still valid

      expect(res.status).toBe(200);
      expect(mockPrisma.calendarEntry.update).toHaveBeenCalled();
    });

    it('PATCH both, inverted → 400 (caught earlier by the zod refine)', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ start: '2026-09-01T11:00:00.000Z', end: '2026-09-01T10:00:00.000Z' });

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });

    // Slice 05's zero-length decision (see the matching POST test): equal start/end is
    // impossible by construction on PATCH too, both when the zod refine can see both fields
    // and when only one field is sent and the effective range collapses against the stored row.
    it('PATCH both, equal (zero-length) → 400 (zod refine)', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:00:00.000Z' });

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });

    it('PATCH start only, landing exactly on the stored end (zero-length) → 400', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ start: '2026-09-01T10:00:00.000Z' }); // stored end is 10:00 exactly

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });

    it('PATCH end only, landing exactly on the stored start (zero-length) → 400', async () => {
      mockAuthAs('dispatcher');

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ end: '2026-09-01T09:00:00.000Z' }); // stored start is 09:00 exactly

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });

    // QA FINDING 1 — a row that is ALREADY zero-length (start === end) must still be editable
    // for anything that doesn't touch the dates. The effective-range check must not run at all
    // when the caller sends neither start nor end, or a title-only PATCH on such a row 400s
    // forever and the row can never be fixed or even renamed. (Reachable pre-slice-05: the old
    // refine allowed `end >= start`; a live check found 0 such rows on staging today, but the
    // window was open from slice 02 until the tightening in this slice.)
    it('PATCH title-only against an ALREADY zero-length stored row → 200 (dates untouched, so unchecked)', async () => {
      mockAuthAs('dispatcher');
      // A PERSISTENT mockImplementation, not mockImplementationOnce: `update` calls findFirst
      // twice — the pre-write existence check, and the post-write refetch inside the
      // transaction that feeds withEnrichedParticipants and the notify diff. A `Once` mock is
      // consumed by the first call, so the second returns undefined and the handler 500s on a
      // row it just wrote. The full fixture shape matters for the same reason.
      mockPrisma.calendarEntry.findFirst.mockImplementation(() =>
        Promise.resolve({
          ...ENTRY_FIXTURE,
          start: new Date('2026-09-01T09:00:00.000Z'),
          end: new Date('2026-09-01T09:00:00.000Z'),
          participants: [],
        }),
      );

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ title: 'Fixed typo' });

      expect(res.status).toBe(200);
      expect(mockPrisma.calendarEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ title: 'Fixed typo' }) }),
      );
    });

    // The same already-zero-length row, but this time a date IS sent — the rejection must
    // still fire, since sending a date is a decision to keep (or re-affirm) a zero-length span.
    it('PATCH start-only against an already zero-length row, unchanged → still 400', async () => {
      mockAuthAs('dispatcher');
      mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
        Promise.resolve({ id: ENTRY_ID, start: new Date('2026-09-01T09:00:00.000Z'), end: new Date('2026-09-01T09:00:00.000Z') }),
      );

      const res = await request(app)
        .patch(`/api/calendar-entries/${ENTRY_ID}`)
        .set(authHeader('dispatcher'))
        .send({ start: '2026-09-01T09:00:00.000Z' }); // re-sends the same (zero-length) start

      expect(res.status).toBe(400);
      expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
    });
  });

  it('rejects recurrence_until — reserved column, never API-writable', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ recurrence_until: '2027-01-01T00:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
  });

  it('a cross-org update returns 404, not the row', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('orgB_admin'))
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(mockPrisma.calendarEntry.update).not.toHaveBeenCalled();
  });

  it('SALES caller without the grant gets 403; DISPATCHER gets 200', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['update', 'CalendarEntry']);

    const resSales = await request(app).patch(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('sales')).send({ title: 'x' });
    expect(resSales.status).toBe(403);

    mockAuthAs('dispatcher');
    const resDispatcher = await request(app).patch(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher')).send({ title: 'x' });
    expect(resDispatcher.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════
// DELETE /api/calendar-entries/:id
// ══════════════════════════════════════════════════════

describe('DELETE /api/calendar-entries/:id', () => {
  it('hard-deletes the entry (204); participant cleanup is DB-level ON DELETE CASCADE, not app code', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app).delete(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(204);
    expect(mockPrisma.calendarEntry.delete).toHaveBeenCalledWith({ where: { id: ENTRY_ID } });
  });

  it('a cross-org delete returns 404, not the row', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app).delete(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.calendarEntry.delete).not.toHaveBeenCalled();
  });

  it('SALES caller without the grant gets 403; DISPATCHER gets 204', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['delete', 'CalendarEntry']);

    const resSales = await request(app).delete(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('sales'));
    expect(resSales.status).toBe(403);

    mockAuthAs('dispatcher');
    const resDispatcher = await request(app).delete(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher'));
    expect(resDispatcher.status).toBe(204);
  });
});
