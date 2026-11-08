/**
 * visit-location.test.ts - per-visit location, slice 1's write door.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 * Slice: md_files/issues/scheduling/01-hold-a-walkthrough-somewhere-other-than-the-service-address.md
 *
 * `POST /leads/:id/walkthrough/schedule` is the one door this slice opens, and the four things
 * that can go wrong at it are all here: writing the wrong columns, writing another organisation's
 * location, letting a contradictory body reach the database, and quietly resetting a showroom
 * meeting back to the customer's house on a plain reschedule.
 *
 * Driven through the HTTP API with Prisma mocked - the same seam the rest of the visit suite uses,
 * so these survive a rename or a split of the service functions underneath.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID, withLeadStatusSync } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  projectVisitLocation, formatVisitLocation, resolveVisitLocationWrite, LOCATION_NOT_FOUND,
} from '../services/visitLocation';
import { sendWalkthroughScheduledEmail, sendWalkthroughRescheduledEmail } from '../lib/email';
import { renderMergeFields } from '../services/automations/renderMergeFields';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../services/automations/mergeFieldFallbacks';
import type { Request } from 'express';

const mockPrisma = prisma as any;
const mockScheduledEmail = sendWalkthroughScheduledEmail as unknown as ReturnType<typeof vi.fn>;
const mockRescheduledEmail = sendWalkthroughRescheduledEmail as unknown as ReturnType<typeof vi.fn>;
const TECH_ID = TEST_USERS.technician.id;

const SHOWROOM_ID = 'aa000000-0000-0000-0000-0000000000a1';
/** A real uuid that belongs to nobody this caller can see - the other tenant's, or nobody's. */
const FOREIGN_LOCATION_ID = 'bb000000-0000-0000-0000-0000000000b2';
/**
 * A real uuid that names no location ANYWHERE - not this organisation's, not anybody's.
 *
 * Held apart from `FOREIGN_LOCATION_ID` only so the two can be compared: the whole claim is that
 * a door cannot tell them apart, and a test that reused one id for both cases would be comparing
 * a response with itself.
 */
const NOWHERE_LOCATION_ID = 'cc000000-0000-0000-0000-0000000000c3';
/**
 * This organisation's own yard, ARCHIVED (slice 2). A live row - every visit already booked here
 * still resolves against it - that no longer accepts a NEW booking.
 */
const CLOSED_YARD_ID = 'aa000000-0000-0000-0000-0000000000a2';

/** The organisation's locations, as Postgres holds them: one open, one archived. */
const ORG_LOCATIONS: Record<string, { id: string; is_active: boolean }> = {
  [SHOWROOM_ID]: { id: SHOWROOM_ID, is_active: true },
  [CLOSED_YARD_ID]: { id: CLOSED_YARD_ID, is_active: false },
};

/** A LIVE visit already at the showroom - the row a plain reschedule must not disturb. */
const LIVE_VISIT_AT_SHOWROOM = {
  id: 'v0000000-0000-0000-0000-000000000001',
  organization_id: ALPHA_ORG_ID,
  lead_id: LEAD_FIXTURE.id,
  job_id: null,
  purpose: 'WALKTHROUGH',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-09-01T13:00:00Z'),
  scheduled_end: new Date('2026-09-01T14:00:00Z'),
  duration_minutes: 60,
  is_all_day: false,
  completed_at: null,
  notes: null,
  cancelled_at: null,
  cancelled_reason: null,
  cancelled_by: null,
  customer_email_sent_at: null,
  location_id: SHOWROOM_ID,
  location_address_line1: null,
  location_address_line2: null,
  location_city: null,
  location_state: null,
  location_zip: null,
  created_at: new Date('2026-08-20T10:00:00Z'),
  updated_at: new Date('2026-08-20T10:00:00Z'),
  assignees: [],
};

function wireTx() {
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        findMany: mockPrisma.visit.findMany,
        aggregate: mockPrisma.visit.aggregate,
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      lead: {
        update: vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 0 } });
  mockPrisma.visit.create.mockResolvedValue({ ...LIVE_VISIT_AT_SHOWROOM, id: 'v-new', visit_seq: 1 });
  mockPrisma.visit.update.mockResolvedValue(LIVE_VISIT_AT_SHOWROOM);
  mockPrisma.lead.findUnique.mockResolvedValue({
    ...LEAD_FIXTURE,
    status: 'CONTACTED',
    visit_assignees: [],
  });
  mockLocationTable();
  mockScheduledEmail.mockResolvedValue({ status: 'sent' });
  mockRescheduledEmail.mockResolvedValue({ status: 'sent' });
  wireTx();
});

/**
 * `prisma.location.findFirst` answering the way Postgres would.
 *
 * The tenant clause is honoured, so an id from another organisation resolves to null here exactly
 * as it would in the database - and so is `is_active`, which is what makes the archive tests
 * below able to fail. A mock that ignored the clause would return the closed yard whether or not
 * the lookup asked for an active one, and a test asserting the 400 would pass on code that had
 * dropped the filter entirely.
 */
function mockLocationTable() {
  mockPrisma.location.findFirst.mockImplementation(
    (args: { where: { id: string; organization_id?: string; is_active?: boolean } }) => {
      const row = ORG_LOCATIONS[args.where.id];
      if (!row) return Promise.resolve(null);
      if (args.where.organization_id !== ALPHA_ORG_ID) return Promise.resolve(null);
      if (args.where.is_active !== undefined && row.is_active !== args.where.is_active) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ id: row.id });
    },
  );
}

function scheduleWalkthrough(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
    .set(authHeader('admin'))
    .send({
      walkthrough_scheduled_at: '2026-09-01T15:00:00Z',
      performer_ids: [TECH_ID],
      walkthrough_duration_minutes: 60,
      ...body,
    });
}

/** The data payload of whichever write the door actually made. */
function writtenData(): Record<string, unknown> {
  const created = mockPrisma.visit.create.mock.calls[0];
  if (created) return created[0].data;
  const updated = mockPrisma.visit.update.mock.calls[0];
  if (!updated) throw new Error('the door made no visit write at all');
  return updated[0].data;
}

describe('POST /leads/:id/walkthrough/schedule - where the walkthrough is', () => {
  it('books at one of the organisation’s own locations, as a pointer', async () => {
    const res = await scheduleWalkthrough({ location: { location_id: SHOWROOM_ID } });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.location_id).toBe(SHOWROOM_ID);
    // The other state's columns are nulled, not left alone: both set is a CHECK violation, and
    // this is the write that would produce it on a visit that used to hold a one-off address.
    expect(data.location_address_line1).toBeNull();
    expect(data.location_city).toBeNull();
    expect(data.location_state).toBeNull();
  });

  it('books at a one-off address, parsed into the five structured columns', async () => {
    const res = await scheduleWalkthrough({
      location: {
        address_line1: '12 Harbor St',
        address_line2: 'Suite 4',
        city: 'Asheville',
        state: 'NC',
        zip: '28801',
      },
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    // Parsed, NOT one blob in line 1 - the acceptance criterion the autocomplete exists to meet.
    expect(data.location_address_line1).toBe('12 Harbor St');
    expect(data.location_address_line2).toBe('Suite 4');
    expect(data.location_city).toBe('Asheville');
    expect(data.location_state).toBe('NC');
    expect(data.location_zip).toBe('28801');
    expect(data.location_id).toBeNull();
  });

  it('books with no location at all, which is the service address and today’s behaviour', async () => {
    const res = await scheduleWalkthrough();

    expect(res.status).toBe(200);
    const data = writtenData();
    // A create with no location keys leaves all six columns at their NULL default. Asserting the
    // ABSENCE rather than `null` is the point: this door must not start writing a location it was
    // never given.
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
  });

  it('leaves the stored location alone when a reschedule carries no location', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT_AT_SHOWROOM);

    const res = await scheduleWalkthrough({ walkthrough_scheduled_at: '2026-09-02T15:00:00Z' });

    expect(res.status).toBe(200);
    const data = writtenData();
    // The whole point of omitted-means-unchanged: moving the time must not reset a showroom
    // meeting back to the customer's house after the customer has been told to come to the
    // showroom. Not "writes the same id back" - writes NOTHING about the location.
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
    expect(data).not.toHaveProperty('location_city');
    // ...and it really did reschedule, so this is not passing because the door refused.
    expect((data.scheduled_at as Date).toISOString()).toBe('2026-09-02T15:00:00.000Z');
  });

  it('clears the location back to the service address on an explicit null', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT_AT_SHOWROOM);

    const res = await scheduleWalkthrough({ location: null });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.location_id).toBeNull();
    expect(data.location_address_line1).toBeNull();
    expect(data.location_address_line2).toBeNull();
    expect(data.location_city).toBeNull();
    expect(data.location_state).toBeNull();
    expect(data.location_zip).toBeNull();
  });
});

// ── An archived location leaves the picker, and the API is what enforces it ──
//
// Hiding a closed branch in the dropdown is a courtesy, not a guard. A tab left open before the
// yard closed still holds it in its options, and a crafted body never opened a dropdown at all -
// so the refusal has to live at the door, or "nobody books into a closed branch" is a claim about
// one React component rather than about the product.
//
// The exception is the one that stops the archive being destructive: a visit ALREADY standing at
// that location can still be rescheduled. The booking form states a location on every save, so
// without it an admin moving a closed-branch meeting by an hour would get a 400 and no way
// through - and D9's note is explicit that a visit's own location stays editable for its life.

describe('POST /leads/:id/walkthrough/schedule - an archived location', () => {
  it('refuses a NEW booking at an archived location, at the API', async () => {
    const res = await scheduleWalkthrough({ location: { location_id: CLOSED_YARD_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    // The lookup asked for an ACTIVE location. Without this clause the archived row comes back and
    // the booking goes through, which is the whole defect this slice would otherwise ship.
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: CLOSED_YARD_ID,
      organization_id: ALPHA_ORG_ID,
      is_active: true,
    });
  });

  it('answers an archived id exactly as it answers a foreign one - no oracle', async () => {
    const archived = await scheduleWalkthrough({ location: { location_id: CLOSED_YARD_ID } });
    vi.clearAllMocks();
    beforeEachState();
    const foreign = await scheduleWalkthrough({ location: { location_id: FOREIGN_LOCATION_ID } });

    expect(archived.status).toBe(foreign.status);
    expect(archived.body).toEqual(foreign.body);
    expect(JSON.stringify(archived.body)).not.toMatch(/archiv/i);
  });

  it('still lets a visit ALREADY at that location be rescheduled', async () => {
    mockPrisma.visit.findFirst.mockResolvedValue({
      ...LIVE_VISIT_AT_SHOWROOM,
      location_id: CLOSED_YARD_ID,
    });

    const res = await scheduleWalkthrough({
      walkthrough_scheduled_at: '2026-09-02T15:00:00Z',
      location: { location_id: CLOSED_YARD_ID },
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.location_id).toBe(CLOSED_YARD_ID);
    // ...and it really did move, so this is not green because the door refused quietly.
    expect((data.scheduled_at as Date).toISOString()).toBe('2026-09-02T15:00:00.000Z');
  });

  it('will not MOVE a visit from one location to a different archived one', async () => {
    // Standing at the showroom, asked to move to the closed yard. "Already there" is keyed off the
    // visit's own stored id, so this is an ordinary new booking at an archived location.
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT_AT_SHOWROOM);

    const res = await scheduleWalkthrough({ location: { location_id: CLOSED_YARD_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('lets an unarchived location be booked again', async () => {
    ORG_LOCATIONS[CLOSED_YARD_ID] = { id: CLOSED_YARD_ID, is_active: true };
    try {
      const res = await scheduleWalkthrough({ location: { location_id: CLOSED_YARD_ID } });

      expect(res.status).toBe(200);
      expect(writtenData().location_id).toBe(CLOSED_YARD_ID);
    } finally {
      ORG_LOCATIONS[CLOSED_YARD_ID] = { id: CLOSED_YARD_ID, is_active: false };
    }
  });
});

// ── The seam every later booking door calls ─────────────────────────────────
//
// `resolveVisitLocationWrite` is where the archived-location refusal lives, and `currentLocationId`
// is the exception that keeps the refusal from being destructive. It is a REQUIRED property of the
// options object rather than an optional one, so a door added later - `POST /jobs/:id/visits`,
// `PATCH /jobs/:id/visits/:visitId` - cannot inherit the refusal without also being made to state
// its answer: TypeScript refuses to compile a call that leaves it out. Optional, the default was
// "this is a create", which is right for a create and silently wrong for a reschedule, and the
// symptom would be a job visit at a since-closed branch answering 400 on every save.
//
// The two tests below pin what the two answers MEAN, at the seam itself rather than only through
// the lead route above, because the lead route is not the caller that will get this wrong.
describe('resolveVisitLocationWrite - the two answers currentLocationId forces', () => {
  const asRequest = () => ({ user: { organization_id: ALPHA_ORG_ID } }) as unknown as Request;

  it('null - a create, standing nowhere yet - refuses an archived location', async () => {
    const out = await resolveVisitLocationWrite(
      asRequest(),
      { location_id: CLOSED_YARD_ID },
      { currentLocationId: null },
    );

    expect(out).toEqual({ ok: false, status: 400, error: LOCATION_NOT_FOUND });
  });

  it('the stored id - an update - lets the visit stay where it already is', async () => {
    const out = await resolveVisitLocationWrite(
      asRequest(),
      { location_id: CLOSED_YARD_ID },
      { currentLocationId: CLOSED_YARD_ID },
    );

    expect(out.ok).toBe(true);
    expect(out.ok && out.data.location_id).toBe(CLOSED_YARD_ID);
  });
});

describe('POST /leads/:id/walkthrough/schedule - refusals', () => {
  it('rejects a location id from another organisation, without revealing it exists', async () => {
    const res = await scheduleWalkthrough({ location: { location_id: FOREIGN_LOCATION_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    // The lookup carried the tenant clause - without it the row would have been found and written.
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: FOREIGN_LOCATION_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('answers a foreign id and a nonexistent id identically - no existence oracle', async () => {
    const foreign = await scheduleWalkthrough({ location: { location_id: FOREIGN_LOCATION_ID } });
    vi.clearAllMocks();
    beforeEachState();
    const nonexistent = await scheduleWalkthrough({ location: { location_id: NOWHERE_LOCATION_ID } });

    expect(foreign.status).toBe(nonexistent.status);
    expect(foreign.body).toEqual(nonexistent.body);
    // And neither body names the id, quotes a location, or says "in another organisation".
    expect(JSON.stringify(foreign.body)).not.toContain(FOREIGN_LOCATION_ID);
    expect(JSON.stringify(foreign.body)).not.toMatch(/organi[sz]ation|tenant|another/i);
  });

  it('rejects a location id AND a one-off address together, at the schema', async () => {
    const res = await scheduleWalkthrough({
      location: {
        location_id: SHOWROOM_ID,
        address_line1: '12 Harbor St',
        city: 'Asheville',
        state: 'NC',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    // SCHEMA-level, not discovered when the database raises visits_location_not_both: the handler
    // never ran, so neither the tenant lookup nor any write was reached.
    expect(mockPrisma.location.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('rejects a one-off address missing its city', async () => {
    const res = await scheduleWalkthrough({
      location: { address_line1: '12 Harbor St', state: 'NC' },
    });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('rejects a one-off address missing its state', async () => {
    const res = await scheduleWalkthrough({
      location: { address_line1: '12 Harbor St', city: 'Asheville' },
    });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('rejects a blank line 1 - a half-typed address cannot be stored', async () => {
    const res = await scheduleWalkthrough({
      location: { address_line1: '', city: 'Asheville', state: 'NC' },
    });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  // A WHITESPACE-ONLY address reached a customer's inbox: `.min(1)` counts spaces, so
  // '   ' was stored and rendered "Please meet us at    , Asheville, NC." The control that feeds
  // this door has always refused a blank-after-trim address, so the schema was the LAXER of the
  // two - the wrong way round for the layer that is also reachable by anything but the UI.
  it.each([
    ['address_line1', { address_line1: '   ', city: 'Asheville', state: 'NC' }],
    ['city', { address_line1: '12 Harbor St', city: '  ', state: 'NC' }],
    ['state', { address_line1: '12 Harbor St', city: 'Asheville', state: ' ' }],
  ])('rejects a whitespace-only %s rather than storing spaces', async (_field, location) => {
    const res = await scheduleWalkthrough({ location });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('stores the TRIMMED value, so padding never reaches the column either', async () => {
    const res = await scheduleWalkthrough({
      location: { address_line1: '  12 Harbor St  ', city: ' Asheville ', state: ' NC ' },
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    // Validating a trimmed string and then storing the padded one would pass every refusal above
    // and still render "Please meet us at   12 Harbor St  , ..." - the check and the write have to
    // be the same string.
    expect(data.location_address_line1).toBe('12 Harbor St');
    expect(data.location_city).toBe('Asheville');
    expect(data.location_state).toBe('NC');
  });

  // The control that enters this field is capped at two characters and the lead form's own
  // `state` is exactly two, so a fifty-character state was a shape only a non-UI caller could
  // produce - and it rendered in full, beside a service address that never can.
  it('rejects a state longer than the two characters the field accepts', async () => {
    const res = await scheduleWalkthrough({
      location: { address_line1: '12 Harbor St', city: 'Asheville', state: 'N'.repeat(50) },
    });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });
});

// ── SLICE 3: the ADDITIONAL-visit door ──────────────────────────────────────
//
// Slice: md_files/issues/scheduling/03-book-an-additional-visit-at-its-own-location.md
//
// `POST /leads/:id/visits` books a trip ALONGSIDE the one `/walkthrough/schedule` owns, and this
// is the case the whole feature exists for: the first meeting at the showroom, the measure at the
// customer's house, a design review back at the showroom. One lead, three visits, three different
// answers - which is unreachable while only one of the two lead-side doors takes a location.
//
// NOTHING NEW IS VALIDATED HERE. The point of the shared helper is that this door inherits the
// refusals rather than restating them, so the tests below are written as PARITY tests wherever a
// refusal is shared: they run both doors with the same body and compare the two answers, which is
// the only shape that can fail when one door drifts from the other. A test asserting "this door
// answers 400" on its own would stay green against a second, subtly different copy of the rule.

function bookAdditionalVisit(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
    .set(authHeader('admin'))
    .send({
      scheduled_at: '2026-09-08T15:00:00Z',
      duration_minutes: 60,
      assignee_ids: [TECH_ID],
      ...body,
    });
}

/** The data payload of the Nth `visit.create` this test has caused. */
function createdData(n = 0): Record<string, unknown> {
  const call = mockPrisma.visit.create.mock.calls[n];
  if (!call) throw new Error(`the door made no visit create #${n}`);
  return call[0].data;
}

/**
 * The same body through BOTH lead-side doors, each against clean mocks.
 *
 * The acceptance criteria this serves are worded as "both doors reject X identically", and
 * identically is the load-bearing word: two doors that both answer 400 with different bodies, or
 * one that refuses at the schema and one that refuses after reaching the database, are two
 * behaviours a caller has to learn separately. Comparing the responses is what pins the shared
 * helper as actually shared.
 */
async function bothDoors(location: unknown) {
  const schedule = await scheduleWalkthrough({ location });
  const scheduleLookups = mockPrisma.location.findFirst.mock.calls.length;
  vi.clearAllMocks();
  beforeEachState();
  const additional = await bookAdditionalVisit({ location });
  return { schedule, additional, scheduleLookups, additionalLookups: mockPrisma.location.findFirst.mock.calls.length };
}

describe('POST /leads/:id/visits - a second visit at its own location', () => {
  it('books the additional visit at a DIFFERENT location, without touching the first', async () => {
    // The lead already holds a live visit at the showroom - the row this must leave alone.
    mockPrisma.visit.findFirst.mockResolvedValue(LIVE_VISIT_AT_SHOWROOM);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await bookAdditionalVisit({
      location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' },
    });

    expect(res.status).toBe(201);
    // A NEW row, carrying its OWN answer...
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    const created = createdData();
    expect(created.location_address_line1).toBe('88 Cedar Lane');
    expect(created.location_city).toBe('Asheville');
    expect(created.location_id).toBeNull();
    // ...and the visit already standing at the showroom was never written to. This is the whole
    // invariant of the slice: three visits, three different answers, and booking the third does
    // not move the first two.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('books two additional visits at two different locations, neither disturbing the other', async () => {
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    const first = await bookAdditionalVisit({ location: { location_id: SHOWROOM_ID } });
    const second = await bookAdditionalVisit({
      location: { address_line1: '400 Supplier Rd', city: 'Charlotte', state: 'NC' },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(2);
    // Two rows, two answers, and the SECOND write carries no trace of the first: the showroom
    // pointer is not still sitting on the one-off row, which is what a patch that merged instead
    // of replacing would produce - and which the DB CHECK would then refuse as a 500.
    expect(createdData(0).location_id).toBe(SHOWROOM_ID);
    expect(createdData(0).location_address_line1).toBeNull();
    expect(createdData(1).location_id).toBeNull();
    expect(createdData(1).location_address_line1).toBe('400 Supplier Rd');
    // Neither create was an update in disguise.
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('books at one of the organisation’s own locations, as a pointer', async () => {
    const res = await bookAdditionalVisit({ location: { location_id: SHOWROOM_ID } });

    expect(res.status).toBe(201);
    const created = createdData();
    expect(created.location_id).toBe(SHOWROOM_ID);
    // A pointer, never a snapshot: correcting the showroom's address in Settings has to change
    // what tomorrow's unsent reminder renders (D2).
    expect(created.location_address_line1).toBeNull();
    expect(created.location_city).toBeNull();
    expect(created.location_state).toBeNull();
  });

  it('leaves an additional visit booked with NO location at the service address', async () => {
    const res = await bookAdditionalVisit();

    expect(res.status).toBe(201);
    const created = createdData();
    // Asserting the ABSENCE of the keys, not `null`: a door that started writing six explicit
    // nulls would pass a `toBeNull()` and would also have stopped being able to say "I was told
    // nothing about where" - which is the distinction the whole three-state field rests on.
    expect(created).not.toHaveProperty('location_id');
    expect(created).not.toHaveProperty('location_address_line1');
    expect(created).not.toHaveProperty('location_city');
    // ...and it really did book, so this is not green because the door refused.
    expect((created.scheduled_at as Date).toISOString()).toBe('2026-09-08T15:00:00.000Z');
  });

  it('clears to the service address on an explicit null, exactly as its sibling does', async () => {
    const res = await bookAdditionalVisit({ location: null });

    expect(res.status).toBe(201);
    const created = createdData();
    expect(created.location_id).toBeNull();
    expect(created.location_address_line1).toBeNull();
    expect(created.location_zip).toBeNull();
  });

  it('refuses a NEW booking at an archived location on this door too', async () => {
    // A create stands nowhere yet, so the "already there" exception cannot apply - the refusal
    // must reach this door as well, or slice 2's guard is a claim about one endpoint.
    const res = await bookAdditionalVisit({ location: { location_id: CLOSED_YARD_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: CLOSED_YARD_ID,
      organization_id: ALPHA_ORG_ID,
      is_active: true,
    });
  });
});

describe('both lead-side doors refuse the same bodies identically', () => {
  it('a cross-tenant location id', async () => {
    const { schedule, additional, scheduleLookups, additionalLookups } =
      await bothDoors({ location_id: FOREIGN_LOCATION_ID });

    expect(schedule.status).toBe(400);
    expect(additional.status).toBe(schedule.status);
    expect(additional.body).toEqual(schedule.body);
    // Both actually ASKED the database with the tenant clause. Without this the test would pass
    // on a door that refused for some unrelated reason - a missing field, a bad uuid - and the
    // tenant check would be unproven on the new door.
    expect(scheduleLookups).toBeGreaterThan(0);
    expect(additionalLookups).toBe(scheduleLookups);
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: FOREIGN_LOCATION_ID,
      organization_id: ALPHA_ORG_ID,
    });
    // And neither body is an oracle for a row in somebody else's organisation.
    expect(JSON.stringify(additional.body)).not.toContain(FOREIGN_LOCATION_ID);
    expect(JSON.stringify(additional.body)).not.toMatch(/organi[sz]ation|tenant|another/i);
  });

  it('a location id and a one-off address sent together', async () => {
    const { schedule, additional, additionalLookups } = await bothDoors({
      location_id: SHOWROOM_ID,
      address_line1: '12 Harbor St',
      city: 'Asheville',
      state: 'NC',
    });

    expect(schedule.status).toBe(400);
    expect(additional.status).toBe(schedule.status);
    expect(additional.body).toEqual(schedule.body);
    expect(additional.body.error).toBe('Validation failed');
    // SCHEMA-level on BOTH doors, not something one of them discovers when Postgres raises
    // visits_location_not_both and the generic catch turns it into an opaque 500: the handler
    // never ran, so the tenant lookup was never reached.
    expect(additionalLookups).toBe(0);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('a half-typed one-off address', async () => {
    const { schedule, additional } = await bothDoors({ address_line1: '12 Harbor St', state: 'NC' });

    expect(schedule.status).toBe(400);
    expect(additional.status).toBe(schedule.status);
    expect(additional.body).toEqual(schedule.body);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('a whitespace-only line 1', async () => {
    const { schedule, additional } = await bothDoors({
      address_line1: '   ', city: 'Asheville', state: 'NC',
    });

    expect(schedule.status).toBe(400);
    expect(additional.status).toBe(schedule.status);
    expect(additional.body).toEqual(schedule.body);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });

  it('a nonexistent location id - and the newer door still cannot tell it from a foreign one', async () => {
    // Slice 1 pinned "a foreign id and a nonexistent id answer identically" on
    // POST /walkthrough/schedule alone. The refusal is one helper's, so the door opened after it
    // inherits the property rather than restating it - and an inherited property is exactly the
    // kind a later change breaks without noticing. What it would cost is an existence oracle:
    // two different answers here would let anyone with a login enumerate which location ids are
    // real in organisations they cannot see.
    const nowhere = await bothDoors({ location_id: NOWHERE_LOCATION_ID });
    vi.clearAllMocks();
    beforeEachState();
    const foreign = await bothDoors({ location_id: FOREIGN_LOCATION_ID });

    expect(nowhere.schedule.status).toBe(400);
    // The two DOORS agree about an id that names nothing...
    expect(nowhere.additional.status).toBe(nowhere.schedule.status);
    expect(nowhere.additional.body).toEqual(nowhere.schedule.body);
    // ...and at the NEWER door the two CASES are byte-identical, which is the pin slice 1 has at
    // its own door and this block did not yet have at this one.
    expect(nowhere.additional.status).toBe(foreign.additional.status);
    expect(nowhere.additional.body).toEqual(foreign.additional.body);
    // It really reached the tenant lookup. Without this the comparisons above would be satisfied
    // by a door that refused both bodies for some unrelated reason and never asked at all.
    expect(nowhere.additionalLookups).toBeGreaterThan(0);
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: FOREIGN_LOCATION_ID,
      organization_id: ALPHA_ORG_ID,
    });
    // And neither body quotes the id back, which would be the oracle stated out loud.
    expect(JSON.stringify(nowhere.additional.body)).not.toContain(NOWHERE_LOCATION_ID);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
  });
});

// ── the two fields that were never normalised ──────────────────────────────
//
// `address_line1`, `city` and `state` have been `.trim().min(1)` since slice 1. `address_line2`
// and `zip` carried neither, so `zip: '   '` was stored as three spaces. Neither reaches the merge
// field, so nothing renders "Please meet us at    " off them - what they reach is the static map's
// query string and the booking form that seeds itself back off the row. Normalising all five in
// the one schema both doors share is the honest fix; leaving two of five untrimmed is a rule that
// reads as an oversight to the next person who adds a field.
//
// TRIMMING ALONE LEFT THE SMALLER HALF OF IT STANDING, which is what the second block below
// covers: '   ' trims to '', `input.zip ?? null` does not catch '', and '' reached the column -
// so of the six location columns it was the one "nothing" that was not NULL, and the one the
// booking form seeds itself back off through `projectVisitLocation`. Blank now collapses to NULL
// in the same schema, so all five say "nothing" the same way.

describe('the one-off address is trimmed in all five fields', () => {
  const PADDED = {
    address_line1: '  12 Harbor St  ',
    address_line2: '  Suite 4  ',
    city: ' Asheville ',
    state: ' NC ',
    zip: '  28801  ',
  };

  /** Every one of the five, with no padding left anywhere. */
  function expectTrimmed(data: Record<string, unknown>) {
    expect(data.location_address_line1).toBe('12 Harbor St');
    expect(data.location_address_line2).toBe('Suite 4');
    expect(data.location_city).toBe('Asheville');
    expect(data.location_state).toBe('NC');
    expect(data.location_zip).toBe('28801');
  }

  it('stores no padding through POST /leads/:id/walkthrough/schedule', async () => {
    const res = await scheduleWalkthrough({ location: PADDED });

    expect(res.status).toBe(200);
    expectTrimmed(writtenData());
  });

  it('stores no padding through POST /leads/:id/visits', async () => {
    const res = await bookAdditionalVisit({ location: PADDED });

    expect(res.status).toBe(201);
    expectTrimmed(createdData());
  });

  it('still accepts a one-off with no unit and no zip at all', async () => {
    // Trimming must not have made either field required: "Suite 4, 12 Harbor St, Asheville, NC"
    // typed for a supplier's premises anchors no ServiceLocation row and needs no postcode.
    const res = await bookAdditionalVisit({
      location: { address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
    });

    expect(res.status).toBe(201);
    expect(createdData().location_address_line2).toBeNull();
    expect(createdData().location_zip).toBeNull();
  });
});

describe('a blank optional field is stored as NULL, not as an empty string', () => {
  /** The same one-off address through BOTH doors, returning what each one actually wrote. */
  async function writtenAtBothDoors(location: Record<string, unknown>) {
    const schedule = await scheduleWalkthrough({ location });
    const scheduleData = writtenData();
    vi.clearAllMocks();
    beforeEachState();
    const additional = await bookAdditionalVisit({ location });
    return { schedule, scheduleData, additional, additionalData: createdData() };
  }

  it.each([
    ['whitespace only', '   '],
    ['an empty string', ''],
  ])('a zip and a unit line that are %s reach the columns as NULL, at both doors', async (_label, blank) => {
    const { schedule, scheduleData, additional, additionalData } = await writtenAtBothDoors({
      address_line1: '12 Harbor St',
      address_line2: blank,
      city: 'Asheville',
      state: 'NC',
      zip: blank,
    });

    // Optional, so neither is REFUSED - the address is perfectly bookable without them.
    expect(schedule.status).toBe(200);
    expect(additional.status).toBe(201);
    for (const data of [scheduleData, additionalData]) {
      // NULL, not ''. `toBeNull()` rather than a falsy check on purpose: '' is falsy, renders as
      // nothing, and passes every loose assertion - and is still the one value among these six
      // columns that means "nothing" in a second way, which `projectVisitLocation` hands straight
      // back into the booking form's ZIP field.
      expect(data.location_zip).toBeNull();
      expect(data.location_address_line2).toBeNull();
    }
  });

  it('a real zip and a real unit line still round-trip through both doors', async () => {
    const { schedule, scheduleData, additional, additionalData } = await writtenAtBothDoors({
      address_line1: '12 Harbor St',
      address_line2: 'Suite 4',
      city: 'Asheville',
      state: 'NC',
      zip: '28801',
    });

    expect(schedule.status).toBe(200);
    expect(additional.status).toBe(201);
    // The collapse is blank-to-null, not optional-to-null: a postcode somebody typed is stored.
    // Without this the previous case would be satisfied by a schema that dropped both fields.
    for (const data of [scheduleData, additionalData]) {
      expect(data.location_zip).toBe('28801');
      expect(data.location_address_line2).toBe('Suite 4');
    }
  });
});

/**
 * The `beforeEach` body, callable mid-test.
 *
 * The no-oracle test runs the door TWICE and has to compare two clean responses, so it clears the
 * mocks between them - which also clears the wiring every request needs. Re-stating the setup by
 * hand would be a second copy free to drift from the real one.
 */
function beforeEachState() {
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 0 } });
  mockPrisma.visit.create.mockResolvedValue({ ...LIVE_VISIT_AT_SHOWROOM, id: 'v-new', visit_seq: 1 });
  mockPrisma.visit.update.mockResolvedValue(LIVE_VISIT_AT_SHOWROOM);
  mockPrisma.lead.findUnique.mockResolvedValue({
    ...LEAD_FIXTURE,
    status: 'CONTACTED',
    visit_assignees: [],
  });
  mockLocationTable();
  mockScheduledEmail.mockResolvedValue({ status: 'sent' });
  mockRescheduledEmail.mockResolvedValue({ status: 'sent' });
  wireTx();
}

// ── the seed the booking form reads ─────────────────────────────────────────
//
// `projectVisitLocation` is what stops the dialog being destructive. The control defaults to the
// service address, so a form opened on a showroom booking to change only the TIME would show
// "Service address", post it, and send the customer somewhere they have already been told not to
// go. The API's omitted-means-unchanged rule cannot save a form that states a location explicitly
// on every save - only a correct seed can.
//
// The three-way return is the point: `undefined` means "this caller's select never asked", which
// is NOT the same as `null` meaning "no location, i.e. the service address". Collapsing them
// would have every list response quietly assert every visit is at the customer's house.

describe('projectVisitLocation - the three states, plus "not selected"', () => {
  it('returns undefined when the select never carried the columns', () => {
    expect(projectVisitLocation({ } as never)).toBeUndefined();
    expect(projectVisitLocation(null)).toBeUndefined();
  });

  it('returns null for a visit at the service address', () => {
    expect(projectVisitLocation({ location_id: null, location_address_line1: null })).toBeNull();
  });

  it('returns the pointer for a visit at a company location', () => {
    expect(projectVisitLocation({ location_id: SHOWROOM_ID, location_address_line1: null }))
      .toMatchObject({ location_id: SHOWROOM_ID, address_line1: null });
  });

  it('returns the five fields for a one-off address, not a formatted blob', () => {
    const projected = projectVisitLocation({
      location_id: null,
      location_address_line1: '12 Harbor St',
      location_address_line2: 'Suite 4',
      location_city: 'Asheville',
      location_state: 'NC',
      location_zip: '28801',
    } as never);

    expect(projected).toEqual({
      location_id: null,
      address_line1: '12 Harbor St',
      address_line2: 'Suite 4',
      city: 'Asheville',
      state: 'NC',
      zip: '28801',
    });
  });
});

// ── the merge-field formatter, at its own seam ──────────────────────────────
//
// Covered end-to-end through the automation context too (context.lead.test.ts). Pinned here as
// well because the fallback is a RULE, not a rendering: every path through it has to produce
// something a customer can drive to, and the two obvious guards - undefined and '' - are both
// shipping defects (D7).

describe('formatVisitLocation - never a hole', () => {
  // SINCE 2026-09-15 THE CONTRACT IS THE OPPOSITE ONE, and it is stricter, not weaker. This
  // formatter used to substitute SERVICE_ADDRESS_FALLBACK itself, which is exactly what made the
  // step's "If empty, fill with" box dead for this field: `renderMergeFields` applies the author's
  // text only when a field resolves to '', and this never let it. The words now live in that box
  // (seeded from mergeFieldFallbacks.ts), so what a customer reads is unchanged and the author can
  // change it - see the two render-level tests below, which is where that guarantee moved.
  //
  // What is pinned here is what the formatter itself must do: a real value, or EXACTLY ''. The bug
  // this test was written for - a truthy row joining to whitespace, "Please meet us at  ." - fails
  // `toBe('')` just as it failed `toBeTruthy()`, and so does a half-joined ", , NC".
  it('returns a real value or exactly the empty string - never whitespace, never half a join', () => {
    const inputs = [
      undefined,
      null,
      { location_id: null, location_address_line1: null },
      { location_id: 'x', location: null },
      { location_id: null, location_address_line1: '' },
      // Rows a schema can no longer create but the table may already hold: a location whose name
      // is blank, and a one-off address stored before the write door trimmed. Both are TRUTHY, so
      // both used to take their branch and join to whitespace.
      { location_id: 'x', location: { name: ' ', address_line1: null, city: null, state: null } },
      { location_id: 'x', location: { name: '', address_line1: '', city: '', state: '' } },
      { location_id: null, location_address_line1: '   ', location_city: '  ', location_state: ' ' },
    ];
    for (const input of inputs) {
      const rendered = formatVisitLocation(input as never, '');
      expect(rendered, `not exactly '' for ${JSON.stringify(input)}`).toBe('');
    }
  });

  // Verbatim the sentence D7 exists to forbid: an admin could create a location with a blank name
  // and no address through the ordinary API, book a walkthrough there, and the confirmation read
  // "Please meet us at  . Your service address is 1820 Elmwood Drive." The schema refuses that row
  // now, but a formatter that can be handed one - an older row, a hand-edited one - has to fall
  // through to something a customer can drive to rather than return the whitespace it joined.
  it('falls through to the service address when a company location renders blank', () => {
    const blank = {
      location_id: 'loc-1',
      location: { name: '  ', address_line1: null, city: null, state: null },
    };

    expect(formatVisitLocation(blank as never, '1820 Elmwood Drive, Charlotte, NC'))
      .toBe('1820 Elmwood Drive, Charlotte, NC');
  });

  // ...but a location with a real name and no address at all is NOT blank, and is not the failure
  // above. Its name is what tells the customer which of the organisation's places to drive to.
  it('renders a named location with no address as just its name', () => {
    const nameOnly = {
      location_id: 'loc-1',
      location: { name: 'Showroom', address_line1: null, city: null, state: null },
    };

    expect(formatVisitLocation(nameOnly as never, '1820 Elmwood Drive, Charlotte, NC'))
      .toBe('Showroom');
  });

  it('prefers the parent’s own service address over the generic phrase', () => {
    expect(formatVisitLocation(null, '88 Cedar Lane, Asheville, NC'))
      .toBe('88 Cedar Lane, Asheville, NC');
  });

  // The last resort is reachable - `Lead.service_location_id` is nullable, so a lead with no
  // address at all can carry a booked walkthrough - which is why the wording is pinned rather than
  // just its non-emptiness. "the service address" is a self-referential non-answer in an email that
  // by definition has no address to state; this says what is actually known and reads as a prompt
  // to call rather than as an answer the customer is meant to act on.
  //
  // Asserted THROUGH the renderer, because that is the only place it is true any more. Asserting
  // the formatter would pass on an implementation that never reaches an author's setting, which is
  // the defect this change exists to fix.
  it('renders as an address the organisation holds, not as a field, when there is nothing to state', () => {
    const rendered = renderMergeFields(
      'Please meet us at {{lead.walkthrough_location}}.',
      { 'lead.walkthrough_location': formatVisitLocation(null, '') },
      { html: false, fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS } },
    );

    expect(rendered).toBe('Please meet us at the address we have on file for you.');
    // "Please meet us at ..." is the author's sentence; whatever this is, it has to slot into it
    // without pointing back at the product's own vocabulary for a field the customer cannot see.
    expect(rendered).not.toMatch(/service address/i);
  });

  // The half that was impossible before, and the whole reason the phrase moved: an author who
  // knows where their own customers should go can say so. With the phrase inside the formatter
  // this test could not be written - the field never reached '' and the box was never consulted.
  it('lets the author replace those words for their own step', () => {
    const rendered = renderMergeFields(
      'Please meet us at {{lead.walkthrough_location}}.',
      { 'lead.walkthrough_location': formatVisitLocation(null, '') },
      { html: false, fallbacks: { 'lead.walkthrough_location': 'our showroom on Elm Street' } },
    );

    expect(rendered).toBe('Please meet us at our showroom on Elm Street.');
  });
});

// ── the BUILT-IN walkthrough notice (#2175) ─────────────────────────────────
//
// Everything above is about the stored columns and the AUTOMATION path -
// {{lead.walkthrough_location}}, rendered into whatever the workflow author wrote. The built-in
// "Site Visit Scheduled" / "rescheduled" notice is a different sender with its own gate: the
// `notify_customer` tick, which is DELIBERATELY independent of the engine (scheduleWalkthrough:
// "send_email governs the automation engine, and an explicit tick is not the engine").
//
// Both can therefore fire for one booking. Until #2175 an office that booked the walkthrough at
// its showroom, ticked "notify customer", and also ran a walkthrough-scheduled automation sent
// that customer TWO emails naming TWO different places - the workflow saying the showroom, the
// built-in saying their own house - because the built-in one addressed the LEAD's service address
// and never saw the visit. Holding the first meeting at the showroom is the case this whole
// feature was asked for, so it was also the one path where the feature did not hold.
//
// Asserted on the sender's `serviceAddress` argument rather than on the rendered body: that string
// is the whole of what the template does with it, and this survives a rewrite of the markup.

describe('the built-in walkthrough notice names the trip’s own place (#2175)', () => {
  const SHOWROOM = { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' };
  /** A saved company location leads with its NAME - the deliberate difference from a bare address. */
  const SHOWROOM_LINE = 'Showroom, 12 Harbor St, Asheville, NC';
  /** LEAD_FIXTURE's own service address, joined the way {{lead.address}} joins it. */
  const SERVICE_ADDRESS = '123 Main St, Austin, TX';

  /**
   * `visit.findFirst` answering on the WHERE clause and projecting the SELECT, because this suite
   * now needs two different answers from one delegate in one request.
   *
   * `findActiveWalkthrough` asks by PARENT (`lead_id`) and decides whether the upsert door creates
   * or moves; the notice's read-back asks by ID ALONE and is what follows the location pointer.
   * The default fixed `mockResolvedValue(null)` cannot distinguish them, so a create could never
   * be tested beside a read-back that finds something.
   *
   * MODELLING `select` IS NOT DECORATION. The read-back asks for the `location` RELATION
   * deliberately: a row carrying `location_id` and nothing behind it makes the formatter fall
   * through to the parent's service address - a real address, correctly formatted, and the wrong
   * place. Against a mock that returned the whole fixture whatever was asked for, dropping
   * `location` from production's select would leave every assertion below green.
   */
  function mockVisitReads(opts: { active?: unknown; stored?: unknown } = {}) {
    mockPrisma.visit.findFirst.mockImplementation(
      (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const w = args.where ?? {};
        if (w.organization_id !== undefined && w.organization_id !== ALPHA_ORG_ID) {
          return Promise.resolve(null);
        }
        if (w.lead_id !== undefined) return Promise.resolve(opts.active ?? null);
        if (w.id !== undefined) {
          const row = opts.stored as Record<string, unknown> | undefined;
          if (!row || row.id !== w.id) return Promise.resolve(null);
          if (!args.select) return Promise.resolve(row);
          const out: Record<string, unknown> = {};
          for (const [key, asked] of Object.entries(args.select)) {
            // `?? null` is what an unloaded relation answers; undefined would let a reader that
            // checks `'location' in row` behave differently from one reading `row.location`.
            if (asked) out[key] = row[key] ?? null;
          }
          return Promise.resolve(out);
        }
        return Promise.resolve(null);
      },
    );
  }

  /** The read-back, identified by WHAT IT ADDRESSES - an id with no parent named. */
  function locationReadBack() {
    const reads = mockPrisma.visit.findFirst.mock.calls
      .map((c: [{ where: Record<string, unknown>; select?: Record<string, unknown> }]) => c[0])
      .filter((a: { where: Record<string, unknown> }) => a.where?.id !== undefined && a.where.lead_id === undefined);
    expect(reads).toHaveLength(1);
    // D2: the location is a POINTER, so the relation is the truth. Without it the formatter has
    // only `location_id` and falls through to the lead's service address.
    expect(reads[0].select?.location).toBeTruthy();
    // The id came from this request's own write, but it is still a read: another organisation's
    // visit must not be reachable through it.
    expect(reads[0].where.organization_id).toBe(ALPHA_ORG_ID);
  }

  function scheduledAddress(): string {
    expect(mockScheduledEmail).toHaveBeenCalledTimes(1);
    return mockScheduledEmail.mock.calls[0][0].serviceAddress;
  }

  function rescheduledAddress(): string {
    expect(mockRescheduledEmail).toHaveBeenCalledTimes(1);
    return mockRescheduledEmail.mock.calls[0][0].serviceAddress;
  }

  /** A walkthrough row as it stands in Postgres, with the pointer already FOLLOWED. */
  function storedVisit(over: Record<string, unknown> = {}) {
    return {
      ...LIVE_VISIT_AT_SHOWROOM,
      id: 'v-new',
      location_id: null,
      location: null,
      ...over,
    };
  }

  // ── POST /leads/:id/walkthrough/schedule - the upsert door ────────────────

  it('a walkthrough booked at one of the organisation’s own locations names that location', async () => {
    mockVisitReads({ stored: storedVisit({ location_id: SHOWROOM_ID, location: SHOWROOM }) });

    const res = await scheduleWalkthrough({
      location: { location_id: SHOWROOM_ID },
      notify_customer: true,
    });

    expect(res.status).toBe(200);
    expect(scheduledAddress()).toBe(SHOWROOM_LINE);
    // The headline defect, stated as the thing that must NOT be in the email.
    expect(scheduledAddress()).not.toBe(SERVICE_ADDRESS);
    locationReadBack();
  });

  it('a walkthrough booked at a one-off address names that address', async () => {
    mockVisitReads({
      stored: storedVisit({
        location_address_line1: '88 Cedar Lane', location_city: 'Asheville', location_state: 'NC',
      }),
    });

    const res = await scheduleWalkthrough({
      location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' },
      notify_customer: true,
    });

    expect(res.status).toBe(200);
    // No name to lead with - a one-off is an address and nothing else, so it renders as one.
    expect(scheduledAddress()).toBe('88 Cedar Lane, Asheville, NC');
  });

  it('a walkthrough with no location of its own still names the lead’s service address', async () => {
    // THE MAJORITY CASE, and the one this fix must not move: every walkthrough booked before the
    // feature existed, and every one held at the customer's house since.
    mockVisitReads({ stored: storedVisit() });

    const res = await scheduleWalkthrough({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(scheduledAddress()).toBe(SERVICE_ADDRESS);
  });

  it('a RESCHEDULE of a walkthrough standing at a location names the location, not the house', async () => {
    // The lead already holds a live visit at the showroom, so this door MOVES it rather than
    // booking a second one - and the notice is the 'rescheduled' one.
    mockVisitReads({
      active: { ...LIVE_VISIT_AT_SHOWROOM, assignees: [] },
      stored: { ...LIVE_VISIT_AT_SHOWROOM, location: SHOWROOM },
    });

    const res = await scheduleWalkthrough({
      walkthrough_scheduled_at: '2026-09-02T15:00:00Z',
      notify_customer: true,
    });

    expect(res.status).toBe(200);
    // The time changed, the place did not - and the notice must not say it did.
    expect(rescheduledAddress()).toBe(SHOWROOM_LINE);
    expect(mockScheduledEmail).not.toHaveBeenCalled();
    locationReadBack();
  });

  // ── POST /leads/:id/visits - the additional-visit door ────────────────────

  it('an ADDITIONAL visit at a location names that location, not the lead’s address', async () => {
    mockVisitReads({ stored: storedVisit({ location_id: SHOWROOM_ID, location: SHOWROOM }) });
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await bookAdditionalVisit({
      location: { location_id: SHOWROOM_ID },
      notify: { notify_customer: true },
    });

    expect(res.status).toBe(201);
    expect(scheduledAddress()).toBe(SHOWROOM_LINE);
    locationReadBack();
  });

  it('an ADDITIONAL visit at a one-off address names that address', async () => {
    mockVisitReads({
      stored: storedVisit({
        location_address_line1: '400 Supplier Rd', location_city: 'Charlotte', location_state: 'NC',
      }),
    });
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await bookAdditionalVisit({
      location: { address_line1: '400 Supplier Rd', city: 'Charlotte', state: 'NC' },
      notify: { notify_customer: true },
    });

    expect(res.status).toBe(201);
    expect(scheduledAddress()).toBe('400 Supplier Rd, Charlotte, NC');
  });

  it('an ADDITIONAL visit with no location of its own is unchanged', async () => {
    mockVisitReads({ stored: storedVisit() });
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });

    const res = await bookAdditionalVisit({ notify: { notify_customer: true } });

    expect(res.status).toBe(201);
    expect(scheduledAddress()).toBe(SERVICE_ADDRESS);
  });
});
