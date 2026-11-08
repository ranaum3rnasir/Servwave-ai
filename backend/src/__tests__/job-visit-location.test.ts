/**
 * job-visit-location.test.ts - per-visit location, slice 4's two job-side doors.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 * Slice: md_files/issues/scheduling/04-give-job-visits-their-own-location.md
 *
 * `POST /jobs/:id/visits` and `PATCH /jobs/:id/visits/:visitId` are the doors. The PATCH is the
 * one that can hurt: it is a RESCHEDULE, the board's drag sends nothing but a window, and
 * "omitted means unchanged" failing there sends the crew to the customer's address instead of the
 * yard. It is also the FIRST door in the whole feature where omitted and null are distinguishable
 * at all - the two lead-side doors are a create and an upsert onto a fresh row, where six
 * explicit nulls and no columns at all are the same row afterwards.
 *
 * Driven through the HTTP API with Prisma mocked, the same seam visit-location.test.ts uses, so
 * these survive a rename or a split of the service functions underneath.
 *
 * THE MOCKS HONOUR THEIR OWN ARGUMENTS. `location.findFirst` answers against a two-row table with
 * the tenant clause and `is_active` applied, and `visit.findFirst` answers on the parent in the
 * where-clause - so a door that dropped the tenant check, or one that asked about the wrong
 * parent, resolves to null here exactly as it would in Postgres. A mock that answered a fixed row
 * would let every refusal below pass against a door with no check in it at all.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, TEST_ORG, mockAuthAs, authHeader, JOB_FIXTURE, LEAD_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { MAIN_LINE_FALLBACK } from '../services/performerPhone';
import { sendJobScheduledEmail, sendJobRescheduledEmail } from '../lib/email';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// S7: the per-visit routes feed the Automation Center. Mocked at the module boundary the way
// job-visits.test.ts does, so the assertions are about the EVENT these routes emit rather than
// about anything inside the engine.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as any;
const mockScheduledEmail = sendJobScheduledEmail as unknown as ReturnType<typeof vi.fn>;
const mockRescheduledEmail = sendJobRescheduledEmail as unknown as ReturnType<typeof vi.fn>;
const TECH_ID = TEST_USERS.technician.id;

const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';
const SHOWROOM_ID = 'aa000000-0000-0000-0000-0000000000a1';
/** This organisation's own yard, ARCHIVED (slice 2) - a live row that takes no NEW booking. */
const CLOSED_YARD_ID = 'aa000000-0000-0000-0000-0000000000a2';
/** A real uuid belonging to nobody this caller can see - another tenant's, or nobody's. */
const FOREIGN_LOCATION_ID = 'bb000000-0000-0000-0000-0000000000b2';

/**
 * The clock is PINNED, for the reason job-visits.test.ts documents at length: the reschedule door
 * runs through `resolveNextJobVisit`, which keeps only visits ending after `new Date()`, and this
 * file's fixtures are absolute literals. At module scope, not in `beforeAll`, so fixtures built
 * while the file is being READ see the same clock the assertions do.
 */
const PINNED_NOW = new Date('2026-08-25T09:00:00Z');
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(PINNED_NOW);
beforeAll(() => { vi.setSystemTime(PINNED_NOW); });
afterAll(() => { vi.useRealTimers(); });

/** The organisation's locations, as Postgres holds them: one open, one archived. */
const ORG_LOCATIONS: Record<string, { id: string; is_active: boolean }> = {
  [SHOWROOM_ID]: { id: SHOWROOM_ID, is_active: true },
  [CLOSED_YARD_ID]: { id: CLOSED_YARD_ID, is_active: false },
};

/** A live JOB visit, at the service address (both column families null). */
function jobVisitRow(over: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    organization_id: ALPHA_ORG_ID,
    lead_id: null,
    job_id: JOB_FIXTURE.id,
    purpose: 'WORK',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
    duration_minutes: 150,
    is_all_day: false,
    completed_at: null,
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    location_id: null,
    location_address_line1: null,
    location_address_line2: null,
    location_city: null,
    location_state: null,
    location_zip: null,
    created_at: new Date('2026-08-20T10:00:00Z'),
    updated_at: new Date('2026-08-20T10:00:00Z'),
    assignees: [] as { user_id: string; user: unknown }[],
    ...over,
  };
}

/** A live LEAD visit - the row the lead-side upsert door collapses onto. */
function leadVisitRow(over: Record<string, unknown> = {}) {
  return jobVisitRow({
    id: 'v0000000-0000-0000-0000-0000000000l1',
    lead_id: LEAD_FIXTURE.id,
    job_id: null,
    purpose: 'WALKTHROUGH',
    ...over,
  });
}

/**
 * `prisma.location.findFirst` answering the way Postgres would.
 *
 * The tenant clause is honoured, so an id from another organisation resolves to null here exactly
 * as it would in the database - and so is `is_active`, which is what makes the archived-location
 * tests able to fail at all. A mock that ignored the clause would hand the closed yard back
 * whether or not the lookup asked for an active one, and every refusal below would pass against a
 * door that had dropped its check.
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

/**
 * The rows `visit.findFirst` can return, keyed by which PARENT the caller asked about.
 *
 * Both the job reschedule door (`{ id, job_id, organization_id }`) and the lead upsert door
 * (`findActiveWalkthrough`, `{ lead_id, organization_id, status }`) call the same delegate, and
 * the two need different answers in the same test. Answering on the where-clause is also what
 * gives the cross-parent case teeth: a PATCH whose lookup forgot `job_id` would still find the
 * row in a fixed-row mock.
 */
const visitTable: { job: unknown; lead: unknown } = { job: null, lead: null };

/**
 * A fixture row PROJECTED THROUGH THE CALLER'S `select`, the way Postgres projects it.
 *
 * THIS MOCK HAS TO MODEL `select` AS WELL AS `where`, and modelling only one of the two is how a
 * load-bearing read becomes untestable. The read that resolves a visit-scoped occurrence's
 * location asks for the `location` RELATION deliberately: a row carrying `location_id` and no
 * relation makes `formatVisitLocation` fall through to the parent's service address - a real
 * address, correctly formatted, and the wrong place. Against a mock that hands back the whole
 * fixture whatever was asked for, dropping `location` from production's select leaves this file
 * green, so the single guarantee the read exists to give cannot fail a test. It did exactly that
 * until this projection was added.
 *
 * Only the TOP level is projected: which keys were asked for is the argument that matters, and a
 * nested `select` is handed the fixture's own value, which is already the minimal shape these
 * fixtures build. A caller using `include` (findActiveWalkthrough) gets the whole row, as Prisma
 * gives it.
 */
function projectSelect(row: unknown, select?: Record<string, unknown>) {
  if (!row || !select) return row ?? null;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, asked] of Object.entries(select)) {
    if (!asked) continue;
    // `?? null` is what an unloaded relation answers - undefined would let a reader that checks
    // `'location' in row` behave differently from one reading `row.location`.
    out[key] = source[key] ?? null;
  }
  return out;
}

function mockVisitFindFirst() {
  mockPrisma.visit.findFirst.mockImplementation(
    (args: {
      where: { id?: string; job_id?: string; lead_id?: string; organization_id?: string };
      select?: Record<string, unknown>;
    }) => {
      const w = args.where ?? {};
      const answer = (row: unknown) => Promise.resolve(projectSelect(row, args.select));
      if (w.organization_id !== undefined && w.organization_id !== ALPHA_ORG_ID) return Promise.resolve(null);
      if (w.job_id !== undefined) {
        const row = visitTable.job as { id: string; job_id: string } | null;
        if (!row || row.job_id !== w.job_id) return Promise.resolve(null);
        if (w.id !== undefined && row.id !== w.id) return Promise.resolve(null);
        return answer(row);
      }
      if (w.lead_id !== undefined) {
        const row = visitTable.lead as { id: string; lead_id: string } | null;
        if (!row || row.lead_id !== w.lead_id) return Promise.resolve(null);
        return answer(row);
      }
      // BY ID ALONE, no parent named: the post-write read that follows the location pointer for a
      // visit-scoped automation occurrence. Both slots are searched, because the id is whichever
      // row the request just wrote.
      if (w.id !== undefined) {
        const rows = [visitTable.job, visitTable.lead] as ({ id: string } | null)[];
        return answer(rows.find((r) => r?.id === w.id) ?? null);
      }
      return Promise.resolve(null);
    },
  );
}

/** Every `prisma.visit.findFirst` the request made, as production passed them. */
function visitReads(): { where: Record<string, unknown>; select?: Record<string, unknown> }[] {
  return mockPrisma.visit.findFirst.mock.calls.map(
    (c: [{ where: Record<string, unknown>; select?: Record<string, unknown> }]) => c[0],
  );
}

/**
 * The post-write read that resolves a visit-scoped occurrence's location, identified by WHAT IT
 * ADDRESSES - an id with no parent named - so that what it ASKS FOR can be asserted without
 * circularity.
 *
 * Asserting on the arguments, not only on the rendered string, is what makes two otherwise silent
 * mutations of this read fail. Selecting the six columns without the `location` relation renders
 * the service address, which is a real address in the right format; dropping `...tenantWhere(req)`
 * changes nothing at all in a single-tenant fixture. Both survived a full green run before these
 * assertions existed.
 */
function occurrenceLocationReadBack() {
  const reads = visitReads().filter(
    (a) => a.where?.id !== undefined && a.where.job_id === undefined && a.where.lead_id === undefined,
  );
  expect(reads).toHaveLength(1);
  return reads[0];
}

/** The two things the read-back must ask for, asserted wherever one is made. */
function expectResolvesLocationUnderTenant(read: { where: Record<string, unknown>; select?: Record<string, unknown> }) {
  // D2: the location is a POINTER, so the relation is the truth. Without it `formatVisitLocation`
  // has only `location_id` and falls through to the service address.
  expect(read.select?.location).toBeTruthy();
  // The read is scoped by an id the request itself produced, but it is still a read: another
  // organisation's visit must not be reachable through it.
  expect(read.where.organization_id).toBe(ALPHA_ORG_ID);
}

/** The transaction both job visit doors (and /assign) run their write inside. */
function wireTx() {
  const txJobUpdate = vi.fn().mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
  const txVisitAggregate = vi.fn().mockResolvedValue({ _max: { visit_seq: null } });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      visit: {
        create: mockPrisma.visit.create,
        update: mockPrisma.visit.update,
        updateMany: mockPrisma.visit.updateMany,
        findMany: mockPrisma.visit.findMany,
        aggregate: txVisitAggregate,
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      jobAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      job: { update: txJobUpdate, findUnique: mockPrisma.job.findUnique },
      lead: {
        update: vi.fn().mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      // Scheduling-notifications slice 08: the milestone doors append to the log in this same
      // transaction. Its rows are asserted in visit-milestone-skip-stamps.test.ts, not here.
      visitMilestoneLog: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
  return { txJobUpdate, txVisitAggregate };
}

/**
 * The `beforeEach` body, callable mid-test.
 *
 * The parity tests run two doors and have to compare two CLEAN responses, so they clear the mocks
 * between them - which also clears the wiring every request needs. Restating the setup by hand
 * would be a second copy free to drift from the real one.
 */
function beforeEachState() {
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  visitTable.job = jobVisitRow();
  visitTable.lead = null;
  mockVisitFindFirst();
  mockLocationTable();
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 0 } });
  mockPrisma.visit.create.mockResolvedValue(jobVisitRow({ id: 'v-new' }));
  mockPrisma.visit.update.mockResolvedValue(jobVisitRow());
  mockPrisma.visit.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'SCHEDULED' });
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED', visit_assignees: [] });
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockScheduledEmail.mockResolvedValue({ status: 'sent' });
  mockRescheduledEmail.mockResolvedValue({ status: 'sent' });
  wireTx();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(PINNED_NOW);
  beforeEachState();
});

// ─── the doors ──────────────────────────────────────────────────────────────

function bookJobVisit(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/jobs/${JOB_FIXTURE.id}/visits`)
    .set(authHeader('admin'))
    .send({
      scheduled_start: '2026-09-05T13:00:00Z',
      scheduled_end: '2026-09-05T15:30:00Z',
      ...body,
    });
}

function rescheduleJobVisit(body: Record<string, unknown> = {}) {
  return request(app)
    .patch(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}`)
    .set(authHeader('admin'))
    .send(body);
}

function scheduleWalkthrough(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
    .set(authHeader('admin'))
    .send({
      walkthrough_scheduled_at: '2026-09-01T15:00:00Z',
      performer_ids: [],
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

// ── POST /jobs/:id/visits ───────────────────────────────────────────────────


/**
 * One hop only: `const x = … someHelper(…)` where `someHelper` is defined in THIS file and its own
 * body calls `visitMergeFields(`. Scans the 400 characters after the assignment for any callee,
 * because the assignment is not always a bare call — the /en-route door's is a ternary
 * (`stampedVisitId ? await stampedVisitOccurrence(…) : null`), and a pattern anchored to
 * `= await name(` silently fails to match it and reports the site as hand-rolled.
 */
function builtByHelper(source: string, ident: string): boolean {
  const window = new RegExp(`\\b${ident}\\s*(?::[^=]*)?=([\\s\\S]{0,400})`).exec(source);
  if (!window) return false;
  for (const [, callee] of window[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (callee === 'visitMergeFields') return true;
    const body = new RegExp(`function\\s+${callee}\\b[\\s\\S]{0,4000}?visitMergeFields\\(`);
    if (body.test(source)) return true;
  }
  return false;
}

describe('POST /jobs/:id/visits - where the job visit is', () => {
  it('books at one of the organisation’s own locations, as a pointer', async () => {
    const res = await bookJobVisit({ location: { location_id: SHOWROOM_ID } });

    expect(res.status).toBe(201);
    const data = writtenData();
    expect(data.location_id).toBe(SHOWROOM_ID);
    // A pointer, never a snapshot (D2): correcting the showroom's address in Settings has to
    // change what tomorrow's unsent reminder renders. The other state's columns are nulled rather
    // than left alone, or `visits_location_not_both` fires as an opaque 500.
    expect(data.location_address_line1).toBeNull();
    expect(data.location_city).toBeNull();
    expect(data.location_state).toBeNull();
  });

  it('books at a one-off address, parsed into the five structured columns', async () => {
    const res = await bookJobVisit({
      location: {
        address_line1: '400 Supplier Rd',
        address_line2: 'Bay 2',
        city: 'Charlotte',
        state: 'NC',
        zip: '28202',
      },
    });

    expect(res.status).toBe(201);
    const data = writtenData();
    expect(data.location_address_line1).toBe('400 Supplier Rd');
    expect(data.location_address_line2).toBe('Bay 2');
    expect(data.location_city).toBe('Charlotte');
    expect(data.location_state).toBe('NC');
    expect(data.location_zip).toBe('28202');
    expect(data.location_id).toBeNull();
  });

  it('books with no location at all, which is the service address and today’s behaviour', async () => {
    const res = await bookJobVisit();

    expect(res.status).toBe(201);
    const data = writtenData();
    // Asserting the ABSENCE of the keys rather than `null`: a door that started writing six
    // explicit nulls would pass a `toBeNull()` and would also have stopped being able to say "I
    // was told nothing about where", which is the distinction the three-state field rests on.
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
    expect(data).not.toHaveProperty('location_city');
    // ...and it really did book, so this is not green because the door refused.
    expect(new Date(data.scheduled_at as Date).toISOString()).toBe('2026-09-05T13:00:00.000Z');
  });

  it('refuses a NEW booking at an archived location, at the API', async () => {
    const res = await bookJobVisit({ location: { location_id: CLOSED_YARD_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    // A create stands nowhere yet, so the "already there" exception cannot apply and the lookup
    // must ask for an ACTIVE row. Without this clause the archived location comes back and the
    // booking goes through.
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: CLOSED_YARD_ID,
      organization_id: ALPHA_ORG_ID,
      is_active: true,
    });
  });
});

// ── PATCH /jobs/:id/visits/:visitId - the door that can hurt ─────────────────
//
// This is the FIRST door in the feature where "omitted" and "null" are observably different. The
// two lead-side doors are a create and an upsert onto a fresh row: writing six explicit nulls and
// writing no location columns at all leave the same row behind, so nothing there could tell the
// two apart. Here the row already exists and already holds an answer, and the board's drag sends
// a window and nothing else.

describe('PATCH /jobs/:id/visits/:visitId - omitted means unchanged', () => {
  it('leaves the stored location alone when a reschedule carries no location', async () => {
    visitTable.job = jobVisitRow({ location_id: SHOWROOM_ID });

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    // The headline: moving a job visit by an hour must not silently send the crew to the
    // customer's address instead of the yard. Not "writes the same id back" - writes NOTHING
    // about the location, because the caller said nothing about it.
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
    expect(data).not.toHaveProperty('location_city');
    expect(data).not.toHaveProperty('location_zip');
    // ...and it really did move, so this is not passing because the door refused.
    expect(new Date(data.scheduled_at as Date).toISOString()).toBe('2026-09-06T13:00:00.000Z');
  });

  it('leaves a ONE-OFF address alone on a window-only reschedule too', async () => {
    // The other state, because a guard written as `if (location_id)` would protect the pointer
    // and quietly wipe the frozen address beside it.
    visitTable.job = jobVisitRow({
      location_address_line1: '400 Supplier Rd',
      location_city: 'Charlotte',
      location_state: 'NC',
    });

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data).not.toHaveProperty('location_address_line1');
    expect(data).not.toHaveProperty('location_city');
    expect(data).not.toHaveProperty('location_id');
  });

  it('leaves the location alone on a crew-only PATCH, which states no window either', async () => {
    // S8 §2b: both window fields omitted is a legal body. The location has to survive the one
    // request that mentions neither where nor when.
    visitTable.job = jobVisitRow({ location_id: SHOWROOM_ID });

    const res = await rescheduleJobVisit({ notes: 'bring the long ladder' });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
  });

  it('moves the visit to a company location when the body says so', async () => {
    const res = await rescheduleJobVisit({ location: { location_id: SHOWROOM_ID } });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.location_id).toBe(SHOWROOM_ID);
    expect(data.location_address_line1).toBeNull();
  });

  it('clears the location back to the service address on an explicit null', async () => {
    visitTable.job = jobVisitRow({ location_id: SHOWROOM_ID });

    const res = await rescheduleJobVisit({ location: null });

    expect(res.status).toBe(200);
    const data = writtenData();
    // Six explicit nulls, which on an UPDATE is a real clear rather than the no-op it would be on
    // a create. D9's note is explicit that a visit's own location stays editable for its life.
    expect(data.location_id).toBeNull();
    expect(data.location_address_line1).toBeNull();
    expect(data.location_address_line2).toBeNull();
    expect(data.location_city).toBeNull();
    expect(data.location_state).toBeNull();
    expect(data.location_zip).toBeNull();
  });

  it('moves the visit from a company location to a one-off address, nulling the pointer', async () => {
    visitTable.job = jobVisitRow({ location_id: SHOWROOM_ID });

    const res = await rescheduleJobVisit({
      location: { address_line1: '400 Supplier Rd', city: 'Charlotte', state: 'NC' },
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.location_address_line1).toBe('400 Supplier Rd');
    // Left set, both states would be live at once and `visits_location_not_both` would refuse the
    // write as an opaque 500.
    expect(data.location_id).toBeNull();
  });
});

// ── the stored id is what `currentLocationId` has to carry ──────────────────
//
// `resolveVisitLocationWrite` takes a REQUIRED `currentLocationId` precisely so this door cannot
// forget it. Passing `null` to silence the type error typechecks, passes every test that does not
// look, and 400s every reschedule of a visit standing at a since-archived branch - the one case
// where an admin has no way through at all.

describe('PATCH /jobs/:id/visits/:visitId - a visit standing at an archived location', () => {
  it('can still be rescheduled while restating the archived location it stands at', async () => {
    visitTable.job = jobVisitRow({ location_id: CLOSED_YARD_ID });

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
      location: { location_id: CLOSED_YARD_ID },
    });

    expect(res.status).toBe(200);
    const data = writtenData();
    expect(data.location_id).toBe(CLOSED_YARD_ID);
    // The lookup did NOT ask for an active row, which is the only way an archived location can
    // answer. `currentLocationId: null` would have added `is_active: true` and 400'd.
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).not.toHaveProperty('is_active');
    // ...and it really did move.
    expect(new Date(data.scheduled_at as Date).toISOString()).toBe('2026-09-06T13:00:00.000Z');
  });

  it('will not MOVE a visit onto a DIFFERENT archived location', async () => {
    // The exception is keyed off the visit's own stored id, so this is an ordinary new booking
    // into a closed branch and is refused like one.
    visitTable.job = jobVisitRow({ location_id: SHOWROOM_ID });

    const res = await rescheduleJobVisit({ location: { location_id: CLOSED_YARD_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({ is_active: true });
  });

  it('refuses a visit at the service address being moved to an archived location', async () => {
    // `currentLocationId` is null-as-a-FACT here (the visit stands nowhere), which is a different
    // thing from a door that never threaded it - and it must still refuse.
    visitTable.job = jobVisitRow();

    const res = await rescheduleJobVisit({ location: { location_id: CLOSED_YARD_ID } });

    expect(res.status).toBe(400);
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });
});

// ── parity with the lead side, proved by comparing responses ────────────────
//
// The acceptance criterion is worded "the same helper, so the same behaviour as the lead side",
// and shared code is not itself evidence: a door can validate its own copy of the shape before
// the shared helper is ever reached, refuse at a different layer, or answer a different body.
// Only running the same body through every door and comparing the ANSWERS can fail when one
// drifts.

/** The same `location` value through all four doors, each against clean mocks. */
async function allFourDoors(location: unknown) {
  const walkthrough = await scheduleWalkthrough({ location });
  const walkthroughLookups = mockPrisma.location.findFirst.mock.calls.length;
  vi.clearAllMocks();
  beforeEachState();

  const jobCreate = await bookJobVisit({ location });
  const jobCreateLookups = mockPrisma.location.findFirst.mock.calls.length;
  vi.clearAllMocks();
  beforeEachState();

  const jobPatch = await rescheduleJobVisit({ location });
  const jobPatchLookups = mockPrisma.location.findFirst.mock.calls.length;

  return { walkthrough, jobCreate, jobPatch, walkthroughLookups, jobCreateLookups, jobPatchLookups };
}

describe('both job doors refuse the same bodies the lead side refuses, identically', () => {
  it('a cross-tenant location id', async () => {
    const doors = await allFourDoors({ location_id: FOREIGN_LOCATION_ID });

    expect(doors.walkthrough.status).toBe(400);
    expect(doors.jobCreate.status).toBe(doors.walkthrough.status);
    expect(doors.jobCreate.body).toEqual(doors.walkthrough.body);
    expect(doors.jobPatch.status).toBe(doors.walkthrough.status);
    expect(doors.jobPatch.body).toEqual(doors.walkthrough.body);
    // Each really ASKED the database with the tenant clause. Without this the comparisons would be
    // satisfied by a door that refused for some unrelated reason and never checked tenancy at all.
    expect(doors.walkthroughLookups).toBeGreaterThan(0);
    expect(doors.jobCreateLookups).toBe(doors.walkthroughLookups);
    expect(doors.jobPatchLookups).toBe(doors.walkthroughLookups);
    expect(mockPrisma.location.findFirst.mock.calls[0][0].where).toMatchObject({
      id: FOREIGN_LOCATION_ID,
      organization_id: ALPHA_ORG_ID,
    });
    // And no body is an oracle for a row in somebody else's organisation.
    expect(JSON.stringify(doors.jobPatch.body)).not.toContain(FOREIGN_LOCATION_ID);
    expect(JSON.stringify(doors.jobPatch.body)).not.toMatch(/organi[sz]ation|tenant|another/i);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('a location id and a one-off address sent together', async () => {
    const doors = await allFourDoors({
      location_id: SHOWROOM_ID,
      address_line1: '12 Harbor St',
      city: 'Asheville',
      state: 'NC',
    });

    expect(doors.walkthrough.status).toBe(400);
    expect(doors.jobCreate.status).toBe(doors.walkthrough.status);
    expect(doors.jobCreate.body).toEqual(doors.walkthrough.body);
    expect(doors.jobPatch.status).toBe(doors.walkthrough.status);
    expect(doors.jobPatch.body).toEqual(doors.walkthrough.body);
    expect(doors.jobPatch.body.error).toBe('Validation failed');
    // SCHEMA-level on every door, not something one of them discovers when Postgres raises
    // `visits_location_not_both` and the generic catch turns it into an opaque 500: the handler
    // never ran, so the tenant lookup was never reached.
    expect(doors.jobCreateLookups).toBe(0);
    expect(doors.jobPatchLookups).toBe(0);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('a half-typed one-off address', async () => {
    const doors = await allFourDoors({ address_line1: '12 Harbor St', state: 'NC' });

    expect(doors.walkthrough.status).toBe(400);
    expect(doors.jobCreate.body).toEqual(doors.walkthrough.body);
    expect(doors.jobPatch.body).toEqual(doors.walkthrough.body);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('a whitespace-only line 1', async () => {
    const doors = await allFourDoors({ address_line1: '   ', city: 'Asheville', state: 'NC' });

    expect(doors.walkthrough.status).toBe(400);
    expect(doors.jobCreate.body).toEqual(doors.walkthrough.body);
    expect(doors.jobPatch.body).toEqual(doors.walkthrough.body);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    expect(mockPrisma.visit.update).not.toHaveBeenCalled();
  });

  it('an archived location, refused on every door a NEW booking can go through', async () => {
    const doors = await allFourDoors({ location_id: CLOSED_YARD_ID });

    expect(doors.walkthrough.status).toBe(400);
    expect(doors.jobCreate.status).toBe(400);
    // The PATCH's visit stands at the SERVICE ADDRESS in the default fixture, so it is not
    // "already there" and gets the same refusal.
    expect(doors.jobPatch.status).toBe(400);
    expect(doors.jobCreate.body).toEqual(doors.walkthrough.body);
    expect(doors.jobPatch.body).toEqual(doors.walkthrough.body);
    // Indistinguishable from a foreign id - saying "that location is archived" would make the
    // door an oracle for a row the caller may not be able to see.
    expect(JSON.stringify(doors.jobPatch.body)).not.toMatch(/archiv/i);
  });
});

// ── the fifth path: /assign first-books, and gets no change ──────────────────
//
// The slice is explicit that `POST /jobs/:id/assign` needs no change: a visit it creates leaves
// both column families null, which derives to the service address, which is today's behaviour.
// A test saying so is worth more than a change, because the risk here is a REGRESSION - a shared
// writer gaining a location default would reach this path without anyone meaning it to.

describe('POST /jobs/:id/assign - first-booking is unaffected', () => {
  it('books visit 1 with both location column families untouched', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [],
        scheduled_start: '2026-09-07T13:00:00Z',
        scheduled_end: '2026-09-07T15:30:00Z',
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.visit.create.mock.calls[0][0].data;
    // NOT `toBeNull()`: no location key is written at all, so the six columns sit at their NULL
    // default. That is the same row this path has always produced, and it derives to the job's
    // service address.
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
    expect(data).not.toHaveProperty('location_city');
    expect(data.job_id).toBe(JOB_FIXTURE.id);
  });

  it('accepts no location key - /assign is not a booking-location door', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_FIXTURE, status: 'UNSCHEDULED' });
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [],
        scheduled_start: '2026-09-07T13:00:00Z',
        scheduled_end: '2026-09-07T15:30:00Z',
        location: { location_id: SHOWROOM_ID },
      });

    // Zod strips the unknown key rather than 400ing, so the booking still succeeds - and the
    // location is simply not written. Asserted so that "assign ignores it" is a stated fact
    // rather than something a reader has to infer from the schema.
    expect(res.status).toBe(200);
    const data = mockPrisma.visit.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('location_id');
    expect(mockPrisma.location.findFirst).not.toHaveBeenCalled();
  });

  it('MOVES an existing visit without touching its location', async () => {
    // The other half of syncJobWindowOntoVisits: a job that already holds a live trip is moved,
    // not re-booked. A showroom visit moved through the hero tile must stay at the showroom.
    const existing = jobVisitRow({ location_id: SHOWROOM_ID });
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      scheduled_start: new Date('2026-09-05T13:00:00Z'),
    });
    mockPrisma.visit.findMany.mockResolvedValue([existing]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [],
        scheduled_start: '2026-09-06T13:00:00Z',
        scheduled_end: '2026-09-06T15:30:00Z',
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.create).not.toHaveBeenCalled();
    const data = mockPrisma.visit.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('location_id');
    expect(data).not.toHaveProperty('location_address_line1');
  });
});

// ── what the automation enrolled by THIS trip renders ────────────────────────
//
// D18: the enrollment is visit-scoped, and `visitMergeFields` is what makes what it SENDS
// visit-scoped too. The date already travels that way; without the location travelling with it an
// email enrolled by visit 3 names visit 3's date beside visit 2's address - which is the exact
// class of error the whole spec exists to remove, made worse by a field that now CLAIMS to say
// where.

describe('the JOB_SCHEDULED / JOB_RESCHEDULED occurrence carries this trip’s location', () => {
  /** The merge-field overrides on the one automation event the request dispatched. */
  function dispatchedMergeFields(): Record<string, string> {
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    return mockDispatch.mock.calls[0][0].eventPayload.mergeFields;
  }

  it('renders the company location the visit was just booked at', async () => {
    mockPrisma.visit.create.mockResolvedValue(jobVisitRow({ id: 'v-new', location_id: SHOWROOM_ID }));
    // The read-back that follows the pointer - a created row carries `location_id` and no
    // relation, and a formatter handed that falls through to the service address.
    visitTable.job = jobVisitRow({
      id: 'v-new',
      location_id: SHOWROOM_ID,
      location: { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
    });

    const res = await bookJobVisit({ location: { location_id: SHOWROOM_ID } });

    expect(res.status).toBe(201);
    expect(dispatchedMergeFields()['job.visit_location']).toBe('Showroom, 12 Harbor St, Asheville, NC');
    // …and the read that produced it asked for the relation, under the tenant clause. The string
    // alone cannot say so: drop either and this door still renders a real, well-formatted address.
    expectResolvesLocationUnderTenant(occurrenceLocationReadBack());
  });

  it('renders the job’s service address when the trip names no location', async () => {
    const res = await bookJobVisit();

    expect(res.status).toBe(201);
    const value = dispatchedMergeFields()['job.visit_location'];
    // JOB_FIXTURE's service location, formatted the way {{job.address}} formats it.
    expect(value).toBe('123 Main St, Austin, TX');
    expect(value).not.toBe('');
  });

  it('renders the location a RESCHEDULE left alone', async () => {
    visitTable.job = jobVisitRow({
      location_id: SHOWROOM_ID,
      location: { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
    });
    mockPrisma.visit.update.mockResolvedValue(jobVisitRow({ location_id: SHOWROOM_ID }));

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
    });

    expect(res.status).toBe(200);
    // The trip did not move location, so the email must not say it did. This is the reschedule
    // half of the headline: the window changed, the address did not.
    expect(dispatchedMergeFields()['job.visit_location']).toBe('Showroom, 12 Harbor St, Asheville, NC');
    expectResolvesLocationUnderTenant(occurrenceLocationReadBack());
  });

  it('never renders an empty string, even for a job whose service address is blank', async () => {
    // THE REACHABLE DEGENERATE ROW, and it is not the one this comment used to describe.
    // `Job.service_location_id` is NOT NULL (`model Job`: `service_location_id String`), so a job
    // with no service location at all cannot exist - that is Lead and Estimate, where the column
    // is `String?`. What IS reachable is a ServiceLocation whose address columns are empty
    // strings: `address_line1`/`city`/`state` are NOT NULL but Postgres stores '' happily, and
    // `[..].filter(Boolean).join(', ')` then makes {{job.address}} resolve to '' for that job.
    // D7: '' gives "Please meet us at ." and undefined prints the token verbatim - and since
    // 2026-09-15 the words come from the step's seeded "If empty, fill with" rather than from the
    // formatter, so what this door owes is a DECLARED, EMPTY override (which the renderer will
    // fill) and never a missing key (which would print the raw token). See
    // automations/__tests__/mergeFieldFallbacks.test.ts for the wording, and
    // context.emptyMergeFields.test.ts for the no-holes guarantee over every advertised field.
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      service_location: { ...JOB_FIXTURE.service_location, address_line1: '', city: '', state: '' },
    });

    const res = await bookJobVisit();

    expect(res.status).toBe(201);
    const fields = dispatchedMergeFields();
    // PRESENT is the whole assertion now, and it is the one that was always load-bearing here.
    // `loadExecutionBundle` spreads the override over the per-entity context, so an OMITTED key
    // silently keeps the entity's own answer - the partial-spread trap this file exists to guard -
    // while a declared '' correctly states "this trip has no address of its own" and lets the
    // step's fallback supply the sentence.
    expect(fields).toHaveProperty('job.visit_location');
    expect(fields['job.visit_location']).toBe('');
    expect(fields['job.visit_location']).not.toContain('{{');
  });
});

// ── the OTHER three visit-scoped dispatch sites ─────────────────────────────
//
// The two booking doors above are not the whole of it. `/assign` and the per-visit en-route route
// key their occurrence to a visit too, and until this change they carried no merge fields at all
// - so each fell back to context.ts's per-ENTITY resolution, which answers with the job's NEXT
// upcoming live visit. A job holding a later trip somewhere else then gets an email naming THAT
// trip's date beside THAT trip's address, for a trip happening on another day at another place.
//
// The date half of that mismatch is older than this feature. It travels out with the same fix.

/** Every automation event of one type the request dispatched. */
function dispatchedOfType(type: string): Record<string, any>[] {
  return mockDispatch.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.type === type);
}

describe('POST /jobs/:id/assign - the occurrence renders the trip it touched', () => {
  /** The earlier live trip - the one `/assign` moves - standing at the showroom. */
  const VISIT_A_ID = 'v0000000-0000-0000-0000-00000000000a';
  /** A LATER trip somewhere else. This is the one per-entity resolution would answer with. */
  const VISIT_B_ID = 'v0000000-0000-0000-0000-00000000000b';
  const MOVED_TO = '2026-12-20T15:00:00Z';

  /**
   * A job with two live trips in two places, and the read-back pointed at the one that moves.
   *
   * `resolveNextJobVisit` picks the earlier of the two, so `/assign` moves visit A - and visit B,
   * on a date the request never mentions and at an address it never touches, is precisely what
   * the job-level resolution would have rendered instead.
   */
  function twoTripsInTwoPlaces() {
    mockPrisma.visit.findMany.mockResolvedValue([
      jobVisitRow({
        id: VISIT_A_ID,
        scheduled_at: new Date('2026-11-10T15:00:00Z'),
        scheduled_end: new Date('2026-11-10T17:00:00Z'),
        location_id: SHOWROOM_ID,
      }),
      jobVisitRow({
        id: VISIT_B_ID,
        visit_seq: 2,
        scheduled_at: new Date('2026-12-01T15:00:00Z'),
        scheduled_end: new Date('2026-12-01T17:00:00Z'),
        location_address_line1: '400 Supplier Rd',
        location_city: 'Charlotte',
        location_state: 'NC',
      }),
    ]);
    visitTable.job = jobVisitRow({
      id: VISIT_A_ID,
      scheduled_at: new Date(MOVED_TO),
      location_id: SHOWROOM_ID,
      location: { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
    });
  }

  /** The job's own visit set, as `resolveJobScheduleWindow`/`jobCrewIds` read it off the job row. */
  const JOB_VISIT_PROJECTION = [
    {
      status: 'SCHEDULED', scheduled_at: new Date('2026-11-10T15:00:00Z'),
      scheduled_end: new Date('2026-11-10T17:00:00Z'), is_all_day: false,
      created_at: new Date('2026-08-20T10:00:00Z'), assignees: [],
    },
    {
      status: 'SCHEDULED', scheduled_at: new Date('2026-12-01T15:00:00Z'),
      scheduled_end: new Date('2026-12-01T17:00:00Z'), is_all_day: false,
      created_at: new Date('2026-08-20T10:00:00Z'), assignees: [],
    },
  ];

  function assignTo(start: string) {
    return request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_ID],
        scheduled_start: start,
        scheduled_end: '2026-12-20T17:00:00Z',
      });
  }

  it('JOB_SCHEDULED names the moved trip’s place and date, not the job’s next visit’s', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'UNSCHEDULED',
      customer_scheduled_email_sent_at: null,
      // Scheduling-notifications PRD: "Job is scheduled" is the job's FIRST scheduled start, read
      // off its visit window, so the job row holds no window yet. The two live trips the
      // transaction finds (twoTripsInTwoPlaces) are what the window sync moves and what the
      // per-entity resolution would otherwise render.
      visits: [],
    });
    twoTripsInTwoPlaces();

    const res = await assignTo(MOVED_TO);

    expect(res.status).toBe(200);
    const [event] = dispatchedOfType('JOB_SCHEDULED');
    expect(event.visitId).toBe(VISIT_A_ID);
    // The place: visit A's showroom, not visit B's Charlotte address.
    expect(event.eventPayload.mergeFields['job.visit_location']).toBe('Showroom, 12 Harbor St, Asheville, NC');
    expect(event.eventPayload.mergeFields['job.visit_location']).not.toContain('Charlotte');
    // The date: the slot this request booked, not visit B's. This half was wrong before the
    // location ever existed - an occurrence that names a visit and renders the job.
    expect(event.eventPayload.mergeFields['job.scheduled_date']).toContain('Dec 20');
    expectResolvesLocationUnderTenant(occurrenceLocationReadBack());
  });

  it('JOB_RESCHEDULED carries the same override', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      // The gate on the reschedule dispatch: the customer was told about the original booking.
      customer_scheduled_email_sent_at: new Date('2026-08-01T00:00:00Z'),
      visits: JOB_VISIT_PROJECTION,
    });
    twoTripsInTwoPlaces();

    const res = await assignTo(MOVED_TO);

    expect(res.status).toBe(200);
    expect(dispatchedOfType('JOB_SCHEDULED')).toHaveLength(0);
    const [event] = dispatchedOfType('JOB_RESCHEDULED');
    expect(event.visitId).toBe(VISIT_A_ID);
    expect(event.eventPayload.mergeFields['job.visit_location']).toBe('Showroom, 12 Harbor St, Asheville, NC');
    expect(event.eventPayload.mergeFields['job.scheduled_date']).toContain('Dec 20');
    expectResolvesLocationUnderTenant(occurrenceLocationReadBack());
  });

  it('a crew-only assign stays job-scoped and states nothing about one trip', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      customer_scheduled_email_sent_at: new Date('2026-08-01T00:00:00Z'),
      visits: JOB_VISIT_PROJECTION,
    });
    twoTripsInTwoPlaces();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_ID] });

    expect(res.status).toBe(200);
    // No window named, so no trip was booked or moved and the occurrence names no visit. Handing
    // it one trip's answers would be this fix applied inside out, so the override is gated on
    // exactly the condition the visit id is.
    for (const event of mockDispatch.mock.calls.map((c: any[]) => c[0])) {
      expect(event.visitId).toBeUndefined();
      expect(event.eventPayload?.mergeFields).toBeUndefined();
    }
  });
});

describe('POST /jobs/:id/visits/:visitId/en-route - the trip the crew is driving to', () => {
  it('renders that trip’s place and crew, not the job’s', async () => {
    visitTable.job = jobVisitRow({
      scheduled_at: new Date('2026-09-05T13:00:00Z'),
      location_id: SHOWROOM_ID,
      location: { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
      assignees: [{ user_id: TECH_ID, user: { first_name: 'Dana', last_name: 'Reyes' } }],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const [event] = dispatchedOfType('JOB_EN_ROUTE');
    expect(event.visitId).toBe(VISIT_ID);
    const fields = event.eventPayload.mergeFields;
    expect(fields['job.visit_location']).toBe('Showroom, 12 Harbor St, Asheville, NC');
    // The crew ON THIS TRIP - the same set the gate above the dispatch counts.
    expect(fields['technician.names']).toBe('Dana Reyes');

    // This door resolves the location on the read it ALREADY makes - a genuine findFirst scoped
    // to the job and the tenant - rather than adding a second one. What has to hold either way is
    // that the read asks for the relation and carries the tenant clause.
    const read = visitReads().find((a) => a.where?.id === VISIT_ID && a.where?.job_id === JOB_FIXTURE.id);
    expect(read).toBeDefined();
    expectResolvesLocationUnderTenant(read!);
  });

  it('still says nothing when nobody is on the trip', async () => {
    visitTable.job = jobVisitRow({ assignees: [] });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    // The crew gate predates this change and survives it: an "on our way" naming nobody is worse
    // than silence, whatever address it would have carried.
    expect(res.status).toBe(200);
    expect(dispatchedOfType('JOB_EN_ROUTE')).toHaveLength(0);
  });
});

// ── the enumeration, so the NEXT dispatch site cannot escape ─────────────────

describe('every visit-scoped automation dispatch resolves the visit’s location', () => {
  /**
   * Extract the argument text of each `dispatchAutomationEvent({ ... })` CALL in a source file.
   *
   * Balanced-paren extraction, the idiom estimate-optional-items.test.ts already uses on this
   * controller's sibling. Only calls whose argument opens with `{` are taken, which drops
   * dispatch.ts's own `export function dispatchAutomationEvent(ev: AutomationEvent)`.
   */
  function dispatchCallArgs(source: string): { text: string; line: number }[] {
    const out: { text: string; line: number }[] = [];
    const needle = 'dispatchAutomationEvent(';
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
      const open = at + needle.length - 1;
      if (source[open + 1] !== '{') continue;
      let depth = 0;
      for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')') {
          depth--;
          if (depth === 0) {
            out.push({ text: source.slice(open + 1, i), line: source.slice(0, at).split('\n').length });
            break;
          }
        }
      }
    }
    return out;
  }

  /**
   * A LEAD occurrence needs no job-style override: there is no lead-side visitMergeFields, and the
   * lead arm of the context resolves every visit-derived field off the enrollment's persisted
   * visit_id itself - pinned field by field in context.lead.test.ts ("renders the SITE visit for
   * all five visit-derived fields"). The walkthrough doors (visits slice 03) are the first lead
   * dispatches to carry a visitId; WALKTHROUGH_CANCELLED's `mergeFields` is only `event.reason`.
   */
  function isLeadDispatch(text: string): boolean {
    return /\bentity\s*:\s*\{\s*type\s*:\s*'lead'/.test(text);
  }

  /** Every backend source file (tests excluded) that dispatches an automation event. */
  function dispatchingSources(): string[] {
    const root = join(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
      }
    };
    walk(root);
    return found.filter((f) => readFileSync(f, 'utf8').includes('dispatchAutomationEvent({'));
  }

  it('a dispatch that names a visit also states that visit’s merge fields', () => {
    const visitScoped: { where: string; text: string }[] = [];
    for (const file of dispatchingSources()) {
      const source = readFileSync(file, 'utf8');
      for (const call of dispatchCallArgs(source)) {
        if (!/\bvisitId\s*:/.test(call.text)) continue;
        if (isLeadDispatch(call.text)) continue;
        visitScoped.push({ where: `${file.slice(file.indexOf('/src/') + 1)}:${call.line}`, text: call.text });
      }
    }

    // A floor, not an exact count: adding a SIXTH visit-scoped dispatch is fine as long as it
    // carries the override, and pinning the number would turn a correct addition red. The floor is
    // what guards against the scan matching nothing and reporting success - the failure mode a
    // source-reading test is actually prone to.
    expect(visitScoped.length).toBeGreaterThanOrEqual(5);

    // `mergeFields` is what `visitMergeFields` produces and what enrollment.ts persists on the
    // enrollment; without it the occurrence names a visit and renders the parent ENTITY, which is
    // one visit's date and another's address in a single email.
    const unresolved = visitScoped.filter((c) => !/\bmergeFields\s*:/.test(c.text)).map((c) => c.where);
    expect(unresolved).toEqual([]);
  });

  /**
   * …AND BUILDS THEM WITH `visitMergeFields`, WHICH IS THE HALF THE TEST ABOVE CANNOT SEE.
   *
   * The override is applied as a PARTIAL SPREAD over the per-entity context, so a key it omits
   * silently keeps the parent's answer. `visitMergeFields` is the one place that knows the whole
   * set of per-visit keys, and every argument it needs is REQUIRED - so a field added to it is a
   * compile error at all four call sites until each one answers for it.
   *
   * A dispatch that hand-rolled `mergeFields: { 'job.scheduled_date': … }` would satisfy the test
   * above and be missing everything the author did not think of, permanently and silently. Slice 5
   * shipped a field resolved at two of five sites on exactly that shape of gap, and the suite
   * stayed green; slice 7 adds a second key to the same object, so the hole would now swallow two.
   *
   * `/assign` builds ONE override into a const and hands it to two dispatches, so an identifier is
   * accepted - provided that identifier is assigned from a `visitMergeFields(` call in the same
   * file. Anything else is a hand-built object by another name.
   */
  it('a dispatch that names a visit builds those fields with visitMergeFields', () => {
    const handRolled: string[] = [];
    let checked = 0;
    for (const file of dispatchingSources()) {
      const source = readFileSync(file, 'utf8');
      for (const call of dispatchCallArgs(source)) {
        if (!/\bvisitId\s*:/.test(call.text)) continue;
        if (isLeadDispatch(call.text)) continue;
        // `(\w*)` and not `(\w+)`, which is the whole point. An object literal -
        // `mergeFields: { 'job.scheduled_date': … }`, the hand-rolled shape this test exists to
        // refuse - has no identifier after the colon, and a `+` quantifier makes the match FAIL
        // rather than match empty, so the site is skipped and reported as fine. That is the same
        // class of hole as the defect being guarded against, and it survived a deliberate sixth
        // dispatch site until the quantifier changed.
        const stated = /\bmergeFields\s*:\s*(\w*)/.exec(call.text);
        // No `mergeFields` at all is the test above's business, not this one's.
        if (!stated) continue;
        checked++;
        const built = stated[1] === 'visitMergeFields'
          // …or a const in this file that IS one.
          || (stated[1] !== ''
            && (new RegExp(`\\b${stated[1]}\\s*(?::[^=]*)?=[\\s\\S]{0,400}?visitMergeFields\\(`).test(source)
              // …or a const assigned from a HELPER in this file that builds with it. The
              // /en-route door reads its override from `stampedVisitOccurrence`, a function
              // rather than a const 400 characters up, so the window search alone reports a
              // correct site as hand-rolled. One hop, same file, and the callee's own body must
              // contain the call - a longer or cross-module chain would let the hand-built
              // object back in by a quieter route, which is the thing being refused.
              || builtByHelper(source, stated[1])));
        if (!built) handRolled.push(`${file.slice(file.indexOf('/src/') + 1)}:${call.line}`);
      }
    }

    // The same floor argument the scan above makes: a regex that matched nothing would otherwise
    // report success for a controller with no overrides in it at all.
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(handRolled).toEqual([]);
  });
});

// ── the seed the booking dialog is destructive without ──────────────────────
//
// `VisitScheduleDialog`'s location control defaults to the service address and the form states a
// location on EVERY save, so a Reschedule opened on a yard booking would post `location: null`
// and send the crew to the customer's house - through the very door whose omitted-means-unchanged
// rule was written to stop exactly that. The API's rule cannot save a form that always states one;
// the seed is what does.
//
// This is not slice 6's "show the location on the surfaces that read a visit". It is the one key
// without which the WRITE path above is unsafe from the only client that uses it.

describe('GET /jobs/:id/visits - each trip carries the seed its dialog needs', () => {
  function listVisits() {
    return request(app).get(`/api/jobs/${JOB_FIXTURE.id}/visits`).set(authHeader('admin'));
  }

  it('carries a company location as a POINTER, never a copy of its address', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([jobVisitRow({ location_id: SHOWROOM_ID })]);

    const res = await listVisits();

    expect(res.status).toBe(200);
    expect(res.body.visits[0].visit_location).toEqual({
      location_id: SHOWROOM_ID,
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      zip: null,
    });
  });

  it('carries a one-off address as its five separate fields', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([jobVisitRow({
      location_address_line1: '400 Supplier Rd',
      location_address_line2: 'Bay 2',
      location_city: 'Charlotte',
      location_state: 'NC',
      location_zip: '28202',
    })]);

    const res = await listVisits();

    expect(res.body.visits[0].visit_location).toEqual({
      location_id: null,
      address_line1: '400 Supplier Rd',
      address_line2: 'Bay 2',
      city: 'Charlotte',
      state: 'NC',
      zip: '28202',
    });
  });

  it('says null - a FACT - for a trip at the service address', async () => {
    mockPrisma.visit.findMany.mockResolvedValue([jobVisitRow()]);

    const res = await listVisits();

    // `null` is "this trip is at the service address", which the control reads as its default.
    // The key being PRESENT is what separates that from "nobody asked", and both read the same way
    // in the dialog - but only one of them is a statement the response is entitled to make.
    expect(res.body.visits[0]).toHaveProperty('visit_location');
    expect(res.body.visits[0].visit_location).toBeNull();
  });
});

// ── SLICE 5: the number that reaches the crew on THIS trip ───────────────────
//
// Slice: md_files/issues/scheduling/05-give-the-customer-a-number-that-reaches-the-person-coming.md
//
// `{{technician.phones}}` travels the same per-visit channel `{{job.visit_location}}` does, and it
// lives HERE rather than in performer-phone.test.ts because what these cases prove is a property
// of the CONTROLLER, not of the formatter: that the read feeding each dispatch site asks Postgres
// for the two columns, and that each site states the org's main line as the fallback. The
// formatter and both arms of the context loader are covered at their own seams in
// performer-phone.test.ts; duplicating a second copy of this file's ~150 lines of mock wiring over
// there would be two harnesses free to drift.
//
// The mocks answer with whatever the fixture holds whatever the select says, so the rendered
// string alone cannot tell a door that asked for `phone_ext` from one that did not - which is why
// each case asserts the arguments of the read as well, exactly as
// `expectResolvesLocationUnderTenant` does for the location relation.
//
// TWO OF THE FOUR SITES ARE HELD BY NOTHING ELSE. `tsc` catches a crew read that loses the columns
// wherever the rows are ASSIGNED into a shape demanding them - validateCrew's `CrewMember`, the
// en-route door's declared context, context.ts's `VisitPerson`. The PATCH reschedule door's
// pre-read is narrowed by `(u): u is VisitCrewMember` instead, and a type predicate is a cast
// rather than a check: it accepts the two names alone. Likewise the main line is an argument each
// dispatch site passes, so replacing one site's `getOrgMainLine(...)` with `''` compiles. Both are
// pinned below, and both were proved able to fail by applying exactly that mutation.

describe('a visit-scoped occurrence carries the crew’s own number', () => {
  /** Invented, in the 555 range, and reaching nobody. Stored E.164; rendered the product's way. */
  const DANA_STORED = '+15550100142';
  const DANA_SHOWN = '(555) 010-0142';
  /** The organisation's own line, also invented: what D7 falls back to when the crew have none. */
  const ORG_MAIN_LINE = '(555) 204-7788';
  /** Whoever `validateCrew` resolves TECH_ID to, named the way `technician.names` names them. */
  const THE_TECHNICIAN = `${TEST_USERS.technician.first_name} ${TEST_USERS.technician.last_name}`;

  /** One person on the trip, as the pre-read projects them off `visit.assignees`. */
  function crewOnTheTrip(phone: string | null, phoneExt: string | null) {
    return [{
      user_id: TECH_ID,
      user: { first_name: 'Dana', last_name: 'Reyes', phone, phone_ext: phoneExt },
    }];
  }

  /**
   * `validateCrew`'s read answering with somebody who has NO number on file - nullable columns
   * most organisations adopting this have several people sitting in.
   *
   * LAYERED over `mockAuthAs`'s own implementation rather than replacing it: the authenticate
   * middleware reads the same delegate, so a fixed row here would answer the request's own
   * principal with somebody else and the door would be exercised as the wrong role.
   */
  function nobodyHasANumberOnFile() {
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      return Promise.resolve(
        match ? { ...match, phone: null, phone_ext: null, organization: TEST_ORG } : null,
      );
    });
  }

  /**
   * The `visit.findFirst` a job-side door makes against ONE trip of ONE job: the PATCH reschedule
   * door's pre-read, and the en-route door's single read.
   *
   * Identified by the two where-keys, which the post-write location read-back - addressed by id
   * alone - does not carry, so this cannot pick up the wrong call.
   */
  function crewPreReadOnTheTrip() {
    const read = visitReads().find((a) => a.where?.id === VISIT_ID && a.where?.job_id === JOB_FIXTURE.id);
    expect(read).toBeDefined();
    return read!;
  }

  /**
   * That read asked Postgres for BOTH columns.
   *
   * `phone` alone renders a switchboard number with no way through it, which reads to the
   * customer as a working contact; neither column renders the main line for a crew who are
   * perfectly reachable. The mock projects only the top level of a `select`, so the nested crew
   * rows come back whole either way - the rendered string cannot fail here, only the arguments.
   */
  function expectCrewReadAsksForBothColumns(read: { select?: Record<string, unknown> }) {
    const crewSelect = (read.select as any)?.assignees?.select?.user?.select;
    expect(crewSelect).toBeDefined();
    expect(crewSelect.phone).toBe(true);
    expect(crewSelect.phone_ext).toBe(true);
  }

  /**
   * A trip whose crew have no numbers renders the ORGANISATION'S line - the same string
   * `{{org.phone}}` renders - and not the last-resort phrase.
   *
   * `crewNamed` is the point of the second assertion, not decoration: `formatPerformerPhones`
   * falls back for an EMPTY crew too, so without proving somebody was resolved first, every case
   * below would pass against a door that lost its crew entirely. And `MAIN_LINE_FALLBACK` is
   * exactly what a dispatch site whose `getOrgMainLine(...)` argument became `''` would render,
   * which is the mutation these four cases exist to kill.
   */
  function expectFallsBackToTheMainLine(fields: Record<string, string>, crewNamed: string) {
    expect(fields['technician.names']).toBe(crewNamed);
    expect(fields['technician.phones']).toBe(ORG_MAIN_LINE);
    expect(fields['technician.phones']).not.toBe(MAIN_LINE_FALLBACK);
    // D7, at the door: never '', and never the token itself.
    expect(fields['technician.phones']).not.toBe('');
    expect(fields['technician.phones']).not.toContain('{{');
  }

  it('en-route renders the number of the person driving there, with their extension', async () => {
    visitTable.job = jobVisitRow({
      scheduled_at: new Date('2026-09-05T13:00:00Z'),
      assignees: crewOnTheTrip(DANA_STORED, '214'),
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const [event] = dispatchedOfType('JOB_EN_ROUTE');
    const fields = event.eventPayload.mergeFields;
    // A number and its extension are ONE contact - the customer must not read them as two
    // numbers and dial the second.
    expect(fields['technician.phones']).toBe(`${DANA_SHOWN} ext. 214`);
    // …named beside the same person, off the same read.
    expect(fields['technician.names']).toBe('Dana Reyes');

    expectCrewReadAsksForBothColumns(crewPreReadOnTheTrip());
  });

  it('en-route falls back to the main line when the crew have no numbers', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    visitTable.job = jobVisitRow({ assignees: crewOnTheTrip(null, null) });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expectFallsBackToTheMainLine(
      dispatchedOfType('JOB_EN_ROUTE')[0].eventPayload.mergeFields, 'Dana Reyes',
    );
  });

  it('a booking resolves the crew it just named, columns and all', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    // validateCrew is what turns `assignee_ids` into the people the occurrence renders, so its
    // own read is the third place the two columns have to be asked for.
    mockPrisma.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve({
        id: args.where.id, role: 'TECHNICIAN', is_active: true, email: 'dana@example.com',
        first_name: 'Dana', last_name: 'Reyes', phone: DANA_STORED, phone_ext: null,
        organization: { is_demo: false, plan: 'PRO', trial_ends_at: null, feature_overrides: {} },
      }),
    );

    const res = await bookJobVisit({ assignee_ids: [TECH_ID] });

    expect(res.status).toBe(201);
    const [event] = dispatchedOfType('JOB_SCHEDULED');
    expect(event.eventPayload.mergeFields['technician.phones']).toBe(DANA_SHOWN);
    expect(event.eventPayload.mergeFields['technician.phones']).not.toBe(ORG_MAIN_LINE);

    const crewRead = mockPrisma.user.findUnique.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.select?.first_name === true && a.select?.role === true);
    expect(crewRead.select.phone).toBe(true);
    expect(crewRead.select.phone_ext).toBe(true);
  });

  // ── the PATCH door, which the compiler does not hold ──────────────────────

  it('a move that re-crews nobody renders the crew already on the trip, columns and all', async () => {
    // The ORG HAS A LINE, which is what makes the regression this pins invisible in a rendered
    // string: a pre-read that lost the two columns does not blank the field, it degrades to the
    // front desk - a real, well-formatted number, for a crew the customer could have reached
    // directly. That is the exact failure this slice exists to remove.
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    visitTable.job = jobVisitRow({ assignees: crewOnTheTrip(DANA_STORED, '214') });

    // No `assignee_ids`: "crew unchanged" - the body the board's drag and a window-only save
    // send. `incomingCrew` is undefined on that path, so the people the occurrence renders come
    // off the PRE-READ rather than off validateCrew, and the pre-read is the one crew read in
    // the feature that reaches `formatPerformerPhones` through a type predicate.
    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
    });

    expect(res.status).toBe(200);
    const fields = dispatchedOfType('JOB_RESCHEDULED')[0].eventPayload.mergeFields;
    expect(fields['technician.phones']).toBe(`${DANA_SHOWN} ext. 214`);
    expect(fields['technician.phones']).not.toBe(ORG_MAIN_LINE);
    expect(fields['technician.names']).toBe('Dana Reyes');

    // …AND THIS, which is the assertion nothing else in the feature makes. A type predicate is a
    // cast: strip `...performerPhoneSelect` from the pre-read's select and `tsc` stays at exit 0,
    // every suite stays green, and the customer's reschedule notice hands them the front desk.
    expectCrewReadAsksForBothColumns(crewPreReadOnTheTrip());
  });

  // ── the main line is an ARGUMENT, so every site has to be pinned ───────────
  //
  // `getOrgMainLine(...)` is resolved per dispatch site and passed in; replacing one site's call
  // with `''` therefore compiles, and `formatPerformerPhones` answers with MAIN_LINE_FALLBACK.
  // The customer of an org that HAS a line then reads "Call our office." instead of the number
  // they were meant to dial. Only the en-route site was pinned; these are the other three.

  it('a first booking through /assign states the org’s line, not the phrase', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    nobodyHasANumberOnFile();
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'UNSCHEDULED',
      customer_scheduled_email_sent_at: null,
      visits: [],
    });
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_ID],
        scheduled_start: '2026-09-07T13:00:00Z',
        scheduled_end: '2026-09-07T15:30:00Z',
      });

    expect(res.status).toBe(200);
    expectFallsBackToTheMainLine(
      dispatchedOfType('JOB_SCHEDULED')[0].eventPayload.mergeFields, THE_TECHNICIAN,
    );
  });

  it('an additional booking states the org’s line, not the phrase', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    nobodyHasANumberOnFile();

    const res = await bookJobVisit({ assignee_ids: [TECH_ID] });

    expect(res.status).toBe(201);
    expectFallsBackToTheMainLine(
      dispatchedOfType('JOB_SCHEDULED')[0].eventPayload.mergeFields, THE_TECHNICIAN,
    );
  });

  it('a move states the org’s line, not the phrase', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    visitTable.job = jobVisitRow({ assignees: crewOnTheTrip(null, null) });

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
    });

    expect(res.status).toBe(200);
    expectFallsBackToTheMainLine(
      dispatchedOfType('JOB_RESCHEDULED')[0].eventPayload.mergeFields, 'Dana Reyes',
    );
  });
});

// ── SLICE 7: the organisation's own number, on the same five dispatch sites ──
//
// Slice: md_files/issues/scheduling/07-let-the-author-choose-the-servwave-number-instead-of-the-personal-one.md
//
// `{{technician.servwave_phones}}` travels the same per-visit channel `{{technician.phones}}` does,
// and it is pinned here for the same reason its sibling is: what these cases prove is a property of
// the CONTROLLER - that every dispatch site resolves the number for the crew on THIS trip, under
// THIS organisation. The resolver, the fallback chain and both arms of the context loader are
// covered at their own seams in servwave-phone.test.ts.
//
// FIVE DISPATCHES, FOUR CALL SITES. `/assign` builds one override and hands it to both its
// JOB_SCHEDULED and its JOB_RESCHEDULED dispatch, so the four `visitMergeFields(` calls in the
// controller cover five doors. `tsc` holds all four - the argument is REQUIRED, so a site that does
// not state it does not compile - but a site that states the WRONG string compiles perfectly, and
// the two most likely wrong strings both render a real, well-formatted number: the organisation's
// default, and its main line. Only a fixture where those three differ can tell them apart, which is
// what the three constants below are for.

describe('a visit-scoped occurrence carries the organisation’s number for the crew', () => {
  /** The number the organisation has assigned to the person on the trip - the right answer. */
  const TECH_SERVWAVE = '(555) 204-0701';
  /** The organisation's fallback caller ID - right only when nobody on the trip has one. */
  const ORG_DEFAULT_SERVWAVE = '(555) 204-0700';
  /** `{{org.phone}}`. Right only when the organisation owns no number at all. */
  const ORG_MAIN_LINE = '(555) 204-7788';
  /** The crew's PERSONAL number, which this field must never render whatever is missing. */
  const DANA_PERSONAL_STORED = '+15550100142';
  const DANA_PERSONAL_SHOWN = '(555) 010-0142';

  /** One person on the trip, as the pre-read projects them off `visit.assignees`. */
  function crewOnTheTrip() {
    return [{
      user_id: TECH_ID,
      user: { first_name: 'Dana', last_name: 'Reyes', phone: DANA_PERSONAL_STORED, phone_ext: null },
    }];
  }

  /** The person on the trip has an assignment; rung 1 of D7's chain answers. */
  function theCrewHasAnAssignment() {
    mockPrisma.userPhoneNumber.findMany.mockResolvedValue([
      { user_id: TECH_ID, phone_number: { e164: '+15552040701', formatted: TECH_SERVWAVE } },
    ]);
  }

  /** Nobody on the trip has one, so the chain has to walk down to the organisation's default. */
  function nobodyOnTheTripHasAnAssignment() {
    mockPrisma.userPhoneNumber.findMany.mockResolvedValue([]);
  }

  /** `validateCrew`'s read, answering with the person the booking doors actually name. */
  function theCrewIsDana() {
    mockPrisma.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve({
        id: args.where.id, role: 'TECHNICIAN', is_active: true, email: 'dana@example.com',
        first_name: 'Dana', last_name: 'Reyes', phone: DANA_PERSONAL_STORED, phone_ext: null,
        organization: { is_demo: false, plan: 'PRO', trial_ends_at: null, feature_overrides: {} },
      }),
    );
  }

  beforeEach(() => {
    mockPrisma.organization.findUnique.mockResolvedValue({ phone: ORG_MAIN_LINE });
    mockPrisma.phoneNumber.findFirst.mockResolvedValue({
      e164: '+15552040700', formatted: ORG_DEFAULT_SERVWAVE,
    });
    theCrewHasAnAssignment();
    visitTable.job = jobVisitRow({ assignees: crewOnTheTrip() });
  });

  /**
   * The organisation's number for the crew on this trip, and NONE of the three things a site that
   * stated the wrong string would render instead.
   *
   * The personal number is in the set deliberately. It is the one substitution that would look
   * right in every screenshot and be wrong in exactly the way the field exists to prevent: an
   * author who chose this chip over `{{technician.phones}}` chose not to publish mobiles.
   */
  function expectTheCrewsOrganisationNumber(fields: Record<string, string>) {
    expect(fields['technician.servwave_phones']).toBe(TECH_SERVWAVE);
    expect(fields['technician.servwave_phones']).not.toBe(ORG_DEFAULT_SERVWAVE);
    expect(fields['technician.servwave_phones']).not.toBe(ORG_MAIN_LINE);
    expect(fields['technician.servwave_phones']).not.toBe(DANA_PERSONAL_SHOWN);
    // D7, at the door: never '', and never the token itself.
    expect(fields['technician.servwave_phones']).not.toBe('');
    expect(fields['technician.servwave_phones']).not.toContain('{{');
    // …and the personal field is untouched beside it. The author picks one; shipping this must not
    // silently change what the other one prints.
    expect(fields['technician.phones']).toBe(DANA_PERSONAL_SHOWN);
  }

  /** Nobody on the trip has an assignment, so rung 2 answers - and never the personal number. */
  function expectTheOrganisationsDefault(fields: Record<string, string>) {
    expect(fields['technician.servwave_phones']).toBe(ORG_DEFAULT_SERVWAVE);
    expect(fields['technician.servwave_phones']).not.toBe(DANA_PERSONAL_SHOWN);
    expect(fields['technician.servwave_phones']).not.toBe('');
  }

  // ── site 1 + 2: POST /jobs/:id/assign, which builds ONE override for two dispatches ──

  function assignTo(start: string) {
    return request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_ID], scheduled_start: start, scheduled_end: '2026-12-20T17:00:00Z' });
  }

  it('a first booking through /assign states the crew’s organisation number', async () => {
    theCrewIsDana();
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'UNSCHEDULED', customer_scheduled_email_sent_at: null, visits: [],
    });
    mockPrisma.visit.findMany.mockResolvedValue([]);

    const res = await assignTo('2026-12-20T15:00:00Z');

    expect(res.status).toBe(200);
    expectTheCrewsOrganisationNumber(dispatchedOfType('JOB_SCHEDULED')[0].eventPayload.mergeFields);
  });

  it('a move through /assign carries the same override on JOB_RESCHEDULED', async () => {
    theCrewIsDana();
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      customer_scheduled_email_sent_at: new Date('2026-08-01T00:00:00Z'),
      visits: [{
        status: 'SCHEDULED', scheduled_at: new Date('2026-11-10T15:00:00Z'),
        scheduled_end: new Date('2026-11-10T17:00:00Z'), is_all_day: false,
        created_at: new Date('2026-08-20T10:00:00Z'), assignees: [],
      }],
    });
    mockPrisma.visit.findMany.mockResolvedValue([
      jobVisitRow({
        scheduled_at: new Date('2026-11-10T15:00:00Z'),
        scheduled_end: new Date('2026-11-10T17:00:00Z'),
      }),
    ]);

    const res = await assignTo('2026-12-20T15:00:00Z');

    expect(res.status).toBe(200);
    expectTheCrewsOrganisationNumber(dispatchedOfType('JOB_RESCHEDULED')[0].eventPayload.mergeFields);
  });

  // ── site 3: POST /jobs/:id/visits, an additional trip on a live job ──

  it('an additional booking states the crew’s organisation number', async () => {
    theCrewIsDana();

    const res = await bookJobVisit({ assignee_ids: [TECH_ID] });

    expect(res.status).toBe(201);
    expectTheCrewsOrganisationNumber(dispatchedOfType('JOB_SCHEDULED')[0].eventPayload.mergeFields);
  });

  it('an additional booking falls to the organisation’s default when the crew have none', async () => {
    theCrewIsDana();
    nobodyOnTheTripHasAnAssignment();

    const res = await bookJobVisit({ assignee_ids: [TECH_ID] });

    expect(res.status).toBe(201);
    expectTheOrganisationsDefault(dispatchedOfType('JOB_SCHEDULED')[0].eventPayload.mergeFields);
  });

  // ── site 4: PATCH /jobs/:id/visits/:visitId, the door the compiler holds least ──

  it('a move that re-crews nobody states the organisation number of the crew already on it', async () => {
    // No `assignee_ids`: "crew unchanged", the body the board's drag sends. The people the
    // occurrence renders come off the PRE-READ, which reaches the formatter through a type
    // predicate - a cast, not a check.
    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
    });

    expect(res.status).toBe(200);
    expectTheCrewsOrganisationNumber(
      dispatchedOfType('JOB_RESCHEDULED')[0].eventPayload.mergeFields,
    );
  });

  it('a move that re-crews the trip states the number of the INCOMING crew', async () => {
    theCrewIsDana();

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
      assignee_ids: [TECH_ID],
    });

    expect(res.status).toBe(200);
    expectTheCrewsOrganisationNumber(
      dispatchedOfType('JOB_RESCHEDULED')[0].eventPayload.mergeFields,
    );
  });

  // ── site 5: POST /jobs/:id/visits/:visitId/en-route ──

  it('en-route states the organisation number of the person driving there', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const fields = dispatchedOfType('JOB_EN_ROUTE')[0].eventPayload.mergeFields;
    expectTheCrewsOrganisationNumber(fields);
    expect(fields['technician.names']).toBe('Dana Reyes');
  });

  it('en-route falls to the organisation’s default when the crew have none', async () => {
    nobodyOnTheTripHasAnAssignment();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expectTheOrganisationsDefault(
      dispatchedOfType('JOB_EN_ROUTE')[0].eventPayload.mergeFields,
    );
  });

  // ── and the key itself, on every one of the five ─────────────────────────
  //
  // The value assertions above each pin ONE door. This pins the property that makes the override
  // work at all: `loadExecutionBundle` applies it as a PARTIAL SPREAD, so a door whose override
  // simply has no such key keeps the per-ENTITY answer - the job-level union's number - with no
  // error and nothing in a rendered string to say so.

  it('every visit-scoped dispatch this suite can reach states the key, not merely a value', async () => {
    theCrewIsDana();
    await bookJobVisit({ assignee_ids: [TECH_ID] });
    await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z', scheduled_end: '2026-09-06T15:30:00Z',
    });
    await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/en-route`)
      .set(authHeader('admin'))
      .send({});

    const visitScoped = mockDispatch.mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e.visitId !== undefined);
    // A floor, not an exact count - the same reason the source scan below states one.
    expect(visitScoped.length).toBeGreaterThanOrEqual(3);
    for (const event of visitScoped) {
      expect(
        Object.keys(event.eventPayload?.mergeFields ?? {}),
        `${event.type} names a visit but states no organisation number for its crew`,
      ).toContain('technician.servwave_phones');
    }
  });
});

// ── the BUILT-IN transactional emails (#2175) ───────────────────────────────
//
// Everything above is about the AUTOMATION path - {{job.visit_location}}, rendered into whatever
// the workflow author wrote. The built-in "Service Scheduled" / "rescheduled" emails are a
// different sender with its own gate: the `notify_customer` tick, which is DELIBERATELY
// independent of the engine (see notifyCustomerOfSchedule, and the note at the lead door it
// mirrors). Both can fire for one booking.
//
// So until #2175 an office that booked the pre-build measure at the showroom, ticked "notify
// customer", and also ran a job-scheduled automation sent that customer TWO emails naming TWO
// different places - the workflow saying the showroom, the built-in saying their house - because
// the built-in one still addressed the parent JOB's service location and never saw the trip.
//
// These are written against the sender's arguments rather than the rendered body for the reason
// the rest of the file drives the HTTP API: `serviceAddress` is the whole of what the template
// does with it, and asserting the string it is handed survives a rewrite of the markup.

describe('the built-in job emails name the trip’s own place (#2175)', () => {
  const SHOWROOM = { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' };
  /** A saved company location leads with its NAME - the deliberate difference from a bare address. */
  const SHOWROOM_LINE = 'Showroom, 12 Harbor St, Asheville, NC';
  /** JOB_FIXTURE's service location, joined the way {{job.address}} joins it. */
  const SERVICE_ADDRESS = '123 Main St, Austin, TX';

  /** The tick. Ticking it also suppresses the automation dispatch, which is the point. */
  const TICKED = { notify: { notify_customer: true } };

  /** The one `serviceAddress` the scheduled template was handed. */
  function scheduledAddress(): string {
    expect(mockScheduledEmail).toHaveBeenCalledTimes(1);
    return mockScheduledEmail.mock.calls[0][0].serviceAddress;
  }

  function rescheduledAddress(): string {
    expect(mockRescheduledEmail).toHaveBeenCalledTimes(1);
    return mockRescheduledEmail.mock.calls[0][0].serviceAddress;
  }

  it('a booking at one of the organisation’s own locations names that location', async () => {
    mockPrisma.visit.create.mockResolvedValue(jobVisitRow({ id: 'v-new', location_id: SHOWROOM_ID }));
    // The read-back that follows the pointer. A created row carries `location_id` and no relation,
    // and a formatter handed that falls through to the service address - a real address, correctly
    // formatted, and the wrong place.
    visitTable.job = jobVisitRow({ id: 'v-new', location_id: SHOWROOM_ID, location: SHOWROOM });

    const res = await bookJobVisit({ location: { location_id: SHOWROOM_ID }, ...TICKED });

    expect(res.status).toBe(201);
    expect(scheduledAddress()).toBe(SHOWROOM_LINE);
    // The headline defect, stated as the thing that must NOT be in the email.
    expect(scheduledAddress()).not.toBe(SERVICE_ADDRESS);
    // …and the read that produced it asked for the relation, under the tenant clause. The string
    // alone cannot say so: drop either and this door still mails a real, well-formatted address.
    expectResolvesLocationUnderTenant(occurrenceLocationReadBack());
  });

  it('a booking at a one-off address names that address', async () => {
    const oneOff = {
      location_address_line1: '400 Supplier Rd', location_city: 'Charlotte', location_state: 'NC',
    };
    mockPrisma.visit.create.mockResolvedValue(jobVisitRow({ id: 'v-new', ...oneOff }));
    visitTable.job = jobVisitRow({ id: 'v-new', ...oneOff });

    const res = await bookJobVisit({
      location: { address_line1: '400 Supplier Rd', city: 'Charlotte', state: 'NC' },
      ...TICKED,
    });

    expect(res.status).toBe(201);
    // No name to lead with - a one-off is an address and nothing else, so it renders as one.
    expect(scheduledAddress()).toBe('400 Supplier Rd, Charlotte, NC');
  });

  it('a booking with no location of its own still names the job’s service address', async () => {
    // THE MAJORITY CASE, and the one this fix must not move: every visit booked before the feature
    // existed, and every one booked at the customer's house since.
    const res = await bookJobVisit(TICKED);

    expect(res.status).toBe(201);
    expect(scheduledAddress()).toBe(SERVICE_ADDRESS);
  });

  it('a RESCHEDULE of a trip standing at a location names the location, not the house', async () => {
    visitTable.job = jobVisitRow({
      location_id: SHOWROOM_ID,
      location: SHOWROOM,
      // What makes this a 'rescheduled' rather than a 'scheduled': the customer was already told.
      customer_email_sent_at: new Date('2026-08-21T10:00:00Z'),
    });
    mockPrisma.visit.update.mockResolvedValue(jobVisitRow({ location_id: SHOWROOM_ID }));

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
      ...TICKED,
    });

    expect(res.status).toBe(200);
    // The window changed, the place did not - and the notice must not say it did.
    expect(rescheduledAddress()).toBe(SHOWROOM_LINE);
    expect(mockScheduledEmail).not.toHaveBeenCalled();
    expectResolvesLocationUnderTenant(occurrenceLocationReadBack());
  });

  it('a reschedule of a trip with no location of its own is unchanged', async () => {
    visitTable.job = jobVisitRow({ customer_email_sent_at: new Date('2026-08-21T10:00:00Z') });
    mockPrisma.visit.update.mockResolvedValue(jobVisitRow());

    const res = await rescheduleJobVisit({
      scheduled_start: '2026-09-06T13:00:00Z',
      scheduled_end: '2026-09-06T15:30:00Z',
      ...TICKED,
    });

    expect(res.status).toBe(200);
    expect(rescheduledAddress()).toBe(SERVICE_ADDRESS);
  });

  it('/assign names the trip it moved, not the job’s other visit', async () => {
    // The same two-trips-in-two-places shape the occurrence tests use, because the direct email is
    // reachable through exactly the same door and had exactly the same per-ENTITY blind spot: the
    // job's next upcoming visit is a different trip, on a different day, somewhere else.
    const VISIT_A_ID = 'v0000000-0000-0000-0000-00000000000a';
    const VISIT_B_ID = 'v0000000-0000-0000-0000-00000000000b';
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE, status: 'UNSCHEDULED', customer_scheduled_email_sent_at: null, visits: [],
    });
    mockPrisma.visit.findMany.mockResolvedValue([
      jobVisitRow({
        id: VISIT_A_ID,
        scheduled_at: new Date('2026-11-10T15:00:00Z'),
        scheduled_end: new Date('2026-11-10T17:00:00Z'),
        location_id: SHOWROOM_ID,
      }),
      jobVisitRow({
        id: VISIT_B_ID,
        visit_seq: 2,
        scheduled_at: new Date('2026-12-01T15:00:00Z'),
        scheduled_end: new Date('2026-12-01T17:00:00Z'),
        location_address_line1: '400 Supplier Rd',
        location_city: 'Charlotte',
        location_state: 'NC',
      }),
    ]);
    visitTable.job = jobVisitRow({
      id: VISIT_A_ID,
      scheduled_at: new Date('2026-12-20T15:00:00Z'),
      location_id: SHOWROOM_ID,
      location: SHOWROOM,
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({
        assignee_ids: [TECH_ID],
        scheduled_start: '2026-12-20T15:00:00Z',
        scheduled_end: '2026-12-20T17:00:00Z',
        // This door's tick is FLAT, not nested - see assignJobSchema.
        notify_customer: true,
      });

    expect(res.status).toBe(200);
    expect(scheduledAddress()).toBe(SHOWROOM_LINE);
    expect(scheduledAddress()).not.toContain('Charlotte');
  });

  it('a crew-only assign, which books no trip, still names the job’s service address', async () => {
    // No window in the body, so nothing was booked or moved and there is no ONE trip to speak for.
    // The notice falls back to the job's own address, exactly as it did before this change - the
    // same gate the automation occurrence applies to its visit id.
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      status: 'SCHEDULED',
      customer_scheduled_email_sent_at: new Date('2026-08-01T00:00:00Z'),
      visits: [{
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-11-10T15:00:00Z'),
        scheduled_end: new Date('2026-11-10T17:00:00Z'),
        is_all_day: false,
        created_at: new Date('2026-08-20T10:00:00Z'),
        assignees: [],
      }],
    });
    mockPrisma.visit.findMany.mockResolvedValue([
      jobVisitRow({
        scheduled_at: new Date('2026-11-10T15:00:00Z'),
        scheduled_end: new Date('2026-11-10T17:00:00Z'),
        location_id: SHOWROOM_ID,
      }),
    ]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [TECH_ID], notify_customer: true });

    expect(res.status).toBe(200);
    // The 'scheduled' template, not the 'rescheduled' one: a crew-only assign names no window at
    // all, and the reschedule copy is gated on having a new start to state.
    expect(scheduledAddress()).toBe(SERVICE_ADDRESS);
    // Nothing was read back, because no trip was named. A read here would mean the door had
    // picked a trip for the customer, which is the resolution this gate exists to refuse.
    expect(visitReads().filter(
      (a) => a.where?.id !== undefined && a.where.job_id === undefined && a.where.lead_id === undefined,
    )).toHaveLength(0);
  });
});
