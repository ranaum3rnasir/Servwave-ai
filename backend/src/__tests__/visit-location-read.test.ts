/**
 * visit-location-read.test.ts - slice 6: the location on every surface that READS a visit.
 *
 * Spec:  md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 * Slice: md_files/issues/scheduling/06-show-the-location-where-the-visit-is-read.md
 *
 * Slices 1-5 let the office SET where a visit happens and let an automation TELL the customer.
 * Everyone inside the organisation still read the customer's address off the visit. A technician
 * sent to the wrong side of town is worse than a customer told the wrong place, because nobody
 * catches it until they arrive.
 *
 * ── WHAT THIS FILE IS ACTUALLY FOR ────────────────────────────────────────────────────────────
 *
 * The slice's acceptance criterion with teeth is not "the card shows something" - it is that what
 * a CARD shows and what the MERGE FIELD renders for the same visit AGREE, asserted as an
 * agreement rather than checked in isolation. Two assertions against two literals would both stay
 * green while the two answers drifted apart, which is the whole failure mode: a second resolution
 * is a second chance for the card and the email to disagree about where a customer is meant to be.
 *
 * So the agreement cases below compute BOTH SIDES LIVE from the same visit row and compare them to
 * each other. No literal stands between them.
 */
import { describe, it, expect } from 'vitest';

import {
  formatVisitLocation,
  formatVisitOwnLocation,
  SERVICE_ADDRESS_FALLBACK,
} from '../services/visitLocation';

const SHOWROOM_ID = 'aa000000-0000-0000-0000-0000000000a1';
const SERVICE_ADDRESS = '1820 Elmwood Drive, Charlotte, NC';

/** A visit at one of the organisation's own locations, relation loaded (D2: a pointer, followed). */
const AT_SHOWROOM = {
  location_id: SHOWROOM_ID,
  location: { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
};

/** A visit at a one-off address, frozen on the row itself. */
const AT_ONE_OFF = {
  location_id: null,
  location_address_line1: '400 Supplier Rd',
  location_city: 'Charlotte',
  location_state: 'NC',
};

/** A visit at the parent's service address - both column families null, today's behaviour. */
const AT_SERVICE_ADDRESS = { location_id: null, location_address_line1: null };

// ── the split the whole slice rests on ───────────────────────────────────────
//
// `formatVisitOwnLocation` answers "where is this trip, if it is anywhere of its own" and returns
// null when the answer is "the parent's address". `formatVisitLocation` is DEFINED as that answer
// with the service-address fallback applied. The card renders the first; the email renders the
// second. Because the second calls the first, the two cannot produce different strings for a visit
// that has a location - which is the guarantee, stated in code rather than in a comment.

describe('formatVisitOwnLocation - the visit’s OWN location, or nothing', () => {
  it('renders a company location the way the merge field does', () => {
    expect(formatVisitOwnLocation(AT_SHOWROOM as never))
      .toBe('Showroom, 12 Harbor St, Asheville, NC');
  });

  it('renders a one-off address the way the merge field does', () => {
    expect(formatVisitOwnLocation(AT_ONE_OFF as never)).toBe('400 Supplier Rd, Charlotte, NC');
  });

  // The common case, and the reason the card shows nothing rather than an empty label: the great
  // majority of visits are at the service address, and printing it on every card would be noise on
  // the common case to serve the rare one.
  it('answers null for a visit at the service address', () => {
    expect(formatVisitOwnLocation(AT_SERVICE_ADDRESS as never)).toBeNull();
  });

  it('answers null for a visit it is handed nothing about', () => {
    expect(formatVisitOwnLocation(null)).toBeNull();
    expect(formatVisitOwnLocation(undefined)).toBeNull();
  });

  /**
   * A pointer with nothing at the end of it is NOT a location to show.
   *
   * `location_id` set with no relation loaded means the caller's select omitted it. The merge
   * field's answer for that row is the service address (the safe way to be wrong - a real address
   * in the right format), and a card that printed a marked line here would be claiming a
   * difference that the email does not report. Null keeps the two saying the same thing.
   */
  it('answers null when the pointer was never followed', () => {
    expect(formatVisitOwnLocation({ location_id: SHOWROOM_ID, location: null } as never)).toBeNull();
  });

  /**
   * Rows the schemas can no longer create but the table may already hold. A `Location` written
   * before `createLocationSchema` refused a blank name has one, and ' ' is truthy: it takes its
   * branch and joins to whitespace. On a card that is a marked line with nothing in it - the
   * visual twin of the "Please meet us at  ." that D7 forbids in an inbox.
   */
  it('answers null rather than whitespace for a row that renders blank', () => {
    const blanks = [
      { location_id: 'x', location: { name: ' ', address_line1: null, city: null, state: null } },
      { location_id: 'x', location: { name: '', address_line1: '', city: '', state: '' } },
      { location_id: null, location_address_line1: '   ', location_city: '  ', location_state: ' ' },
    ];
    for (const row of blanks) {
      expect(formatVisitOwnLocation(row as never), JSON.stringify(row)).toBeNull();
    }
  });
});

// ── the agreement, asserted as an agreement ─────────────────────────────────
//
// Both sides computed live off ONE visit row and compared to EACH OTHER. A literal in the middle
// would let the two drift apart while both halves of a split assertion stayed green.

describe('a card and the merge field cannot disagree about where a visit is', () => {
  for (const [name, visit] of [
    ['a company location', AT_SHOWROOM],
    ['a one-off address', AT_ONE_OFF],
  ] as const) {
    it(`says exactly what the merge field says for ${name}`, () => {
      const card = formatVisitOwnLocation(visit as never);
      const email = formatVisitLocation(visit as never, SERVICE_ADDRESS);

      // Not `toBeTruthy()` on each: the point is that one equals the other.
      expect(card).toBe(email);
      // ...and that this case is genuinely the "there is a difference" one, so the equality above
      // is not the vacuous null === serviceAddress that a broken formatter would also satisfy.
      expect(card).not.toBeNull();
      expect(card).not.toBe(SERVICE_ADDRESS);
    });
  }

  /**
   * The no-difference case, stated the only way it can be stated: the card shows NOTHING exactly
   * when the merge field falls back to the address the customer already has. "Renders as it does
   * today" and "the email tells them their own address" are the same fact, so they are asserted
   * together.
   */
  it('shows nothing exactly when the merge field falls back to the service address', () => {
    const card = formatVisitOwnLocation(AT_SERVICE_ADDRESS as never);
    const email = formatVisitLocation(AT_SERVICE_ADDRESS as never, SERVICE_ADDRESS);

    expect(card).toBeNull();
    expect(email).toBe(SERVICE_ADDRESS);
  });

  /**
   * The phrase belongs to the EMAIL, not to the card - and since 2026-09-15 it does not belong to
   * this module either. `SERVICE_ADDRESS_FALLBACK` is now the SEEDED "If empty, fill with" text
   * for the four address merge fields (automations/mergeFieldFallbacks.ts) and the renderer
   * applies it, so an author can change the sentence instead of typing into a box the formatter
   * had already pre-empted.
   *
   * What that means HERE: both functions answer "nothing of its own" and neither invents words.
   * The card still shows nothing, for the same reason as before - there is no difference to
   * report - and the difference between the two is now only the SHAPE of that answer: `null` for
   * a caller that renders a line, '' for a merge field that a fallback then fills. The wording
   * assertion moved to `automations/__tests__/mergeFieldFallbacks.test.ts`, which pins this exact
   * constant as the default for all four fields.
   */
  it('shows nothing on the card and leaves the words to the email step', () => {
    expect(formatVisitOwnLocation(AT_SERVICE_ADDRESS as never)).toBeNull();
    expect(formatVisitLocation(AT_SERVICE_ADDRESS as never, '')).toBe('');
    // The phrase still exists and is still this module's to own - it is now READ from here by the
    // fallback map rather than substituted here.
    expect(SERVICE_ADDRESS_FALLBACK).toBe('the address we have on file for you');
  });
});

// ═══ THE READ SHAPES ════════════════════════════════════════════════════════
//
// The slice's second rule: WIRE IT THROUGH THE READ SHAPE ONCE. These surfaces read a visit
// through shared list and detail shapes, and the location belongs in those - resolved the same way
// the merge fields resolve it - rather than each surface joining to `Location` for itself.
//
// So every assertion below is about ONE key, `location_label`, on the shapes the three surfaces
// already consume:
//
//   the lead's visit cards  <- GET /api/leads/:id     (walkthrough_location_label + history rows)
//   the job's visits card   <- GET /api/jobs/:id/visits
//   the schedule's detail   <- GET /api/jobs (board cards) and GET /api/leads (walkthrough cards)
//
// A RESOLVED STRING, not the six raw columns, and that is the decision the agreement criterion
// forces. Slice 4's `visit_location` is the six columns because it seeds a FORM, which needs the
// stored value to post it back; a card needs the rendered answer, and rendering it on the client
// would mean the client owning a second copy of "name, then address, in this order, unless it is
// blank". That copy is the second resolution the slice forbids.

import request from 'supertest';
import { beforeEach, vi } from 'vitest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { loadExecutionBundle } from '../services/automations/context';
import { projectLegacyWalkthroughFields, type WalkthroughSnapshotRow } from '../services/walkthrough.service';
import { projectJobVisitLocations } from '../services/visitLocation';
import { mockAuthAs, authHeader, JOB_FIXTURE, LEAD_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as any;

/**
 * A row PROJECTED THROUGH THE CALLER'S OWN `select` / `include`, the way Postgres projects it -
 * relations included, and the nested `visits` relation projected against its own select.
 *
 * THIS IS WHAT MAKES EVERY ASSERTION BELOW ABLE TO FAIL. The one thing each read has to do is ask
 * for the `location` RELATION: without it `formatVisitOwnLocation` has only `location_id`, answers
 * null, and a showroom booking renders as "no difference" - a card that looks exactly like the
 * common case and is wrong. Against a mock that hands the whole fixture back whatever was asked
 * for, deleting `location` from production's select leaves this file green, so the single
 * guarantee these reads exist to give could not fail a test. Slice 4's post-mortem names this
 * exact class: "a mock honouring `where` while fabricating whatever `select` asked for".
 */
function projectRow(row: any, shape?: { select?: any; include?: any }): any {
  if (!row) return row ?? null;
  const select = shape?.select;
  const include = shape?.include;
  const project = (key: string, value: unknown, asked: unknown) => {
    if (key === 'visits' && Array.isArray(value)) {
      return value.map((v) => projectRow(v, asked as { select?: any; include?: any }));
    }
    return value ?? null;
  };
  if (select) {
    const out: Record<string, unknown> = {};
    for (const [key, asked] of Object.entries(select)) {
      if (!asked) continue;
      out[key] = project(key, row[key], asked);
    }
    return out;
  }
  if (include) {
    // Prisma's `include` gives every scalar plus the named relations - so a relation NOT named is
    // absent, which is the half that has to be modelled for these tests to be able to fail.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const isRelation = value !== null && typeof value === 'object' && !(value instanceof Date);
      if (isRelation && !(key in include)) continue;
      if (isRelation && !include[key]) continue;
      out[key] = project(key, value, include[key]);
    }
    // A relation the caller asked for that the fixture does not carry answers null, as Prisma does.
    for (const key of Object.keys(include)) if (!(key in out) && include[key]) out[key] = null;
    return out;
  }
  return row;
}

// ── the fixtures every surface below is asked about ─────────────────────────

const SHOWROOM_RELATION = {
  name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC',
};
/** What a company location must read as, on a card and in an email alike. */
const SHOWROOM_RENDERED = 'Showroom, 12 Harbor St, Asheville, NC';
const ONE_OFF_COLUMNS = {
  location_id: null,
  location_address_line1: '400 Supplier Rd',
  location_address_line2: 'Bay 2',
  location_city: 'Charlotte',
  location_state: 'NC',
  location_zip: '28202',
  location: null,
};
const ONE_OFF_RENDERED = '400 Supplier Rd, Charlotte, NC';

/** The six columns + the relation, all empty: the trip is at the parent's service address. */
const AT_SERVICE_COLUMNS = {
  location_id: null,
  location_address_line1: null,
  location_address_line2: null,
  location_city: null,
  location_state: null,
  location_zip: null,
  location: null,
};
const AT_SHOWROOM_COLUMNS = {
  ...AT_SERVICE_COLUMNS, location_id: SHOWROOM_ID, location: SHOWROOM_RELATION,
};

/**
 * A lead visit, as `walkthroughSnapshotSelect` + the location select load it.
 *
 * Typed as the row the readers actually take, not `Record<string, unknown>`: untyped, `status`
 * widened to `string` and the fixture could drift away from `VisitStatus` without anything
 * noticing. `assignees` is the one key beyond the snapshot shape - `projectLeadVisitCrew` reads
 * it off the same rows - so it is stated here rather than smuggled in as an excess property.
 */
function leadVisitRow(
  over: Partial<WalkthroughSnapshotRow> = {},
): WalkthroughSnapshotRow & { assignees: unknown[] } {
  return {
    id: 'w0000000-0000-0000-0000-000000000001',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    duration_minutes: 60,
    completed_at: null,
    notes: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    canceller: null,
    customer_email_sent_at: null,
    created_at: new Date('2026-08-20T10:00:00Z'),
    assignees: [],
    ...AT_SERVICE_COLUMNS,
    ...over,
  };
}

/** A job visit, as `listJobVisits` loads it with `include`. */
function jobVisitRow(over: Record<string, unknown> = {}) {
  return {
    id: 'v0000000-0000-0000-0000-000000000001',
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
    created_at: new Date('2026-08-20T10:00:00Z'),
    updated_at: new Date('2026-08-20T10:00:00Z'),
    assignees: [] as unknown[],
    ...AT_SERVICE_COLUMNS,
    ...over,
  };
}

// ── the lead's visit cards ──────────────────────────────────────────────────
//
// `projectLegacyWalkthroughFields` IS the lead read shape: every lead response - detail, list and
// every nested lead - is built from it, so putting the label here is what "wire it through the read
// shape once" means on this side. The walkthrough tab reads the CURRENT visit off the flat fields
// and the other trips off `walkthrough_history`, so both carry it.

describe('the lead read shape carries where each trip is', () => {
  it('states the current visit’s location on the flat fields', () => {
    const fields = projectLegacyWalkthroughFields([leadVisitRow(AT_SHOWROOM_COLUMNS)], { full: true });

    expect(fields.walkthrough_location_label).toBe(SHOWROOM_RENDERED);
  });

  it('states a one-off address the same way', () => {
    const fields = projectLegacyWalkthroughFields([leadVisitRow(ONE_OFF_COLUMNS)], { full: true });

    expect(fields.walkthrough_location_label).toBe(ONE_OFF_RENDERED);
  });

  // The common case. `null`, not '' and not the service address: the card renders nothing at all,
  // which is what "reads as it does today" means.
  it('says null for a trip at the service address', () => {
    const fields = projectLegacyWalkthroughFields([leadVisitRow()], { full: true });

    expect(fields).toHaveProperty('walkthrough_location_label');
    expect(fields.walkthrough_location_label).toBeNull();
  });

  // The board reads a walkthrough off the lead LIST, so the label cannot be detail-only the way
  // `walkthrough_location` (a booking-form seed, and only the detail has a booking form) is.
  it('states it on a LIST response too, because the schedule reads walkthroughs from the list', () => {
    const fields = projectLegacyWalkthroughFields([leadVisitRow(AT_SHOWROOM_COLUMNS)], { full: false });

    expect(fields.walkthrough_location_label).toBe(SHOWROOM_RENDERED);
  });

  /**
   * A caller whose select never asked for the location gets NO KEY, rather than `null`.
   *
   * `null` is the statement "this trip is at the service address", and a response is not entitled
   * to make it about columns it never read - the same distinction `walkthrough_location` already
   * draws, so the two keys appear and disappear together.
   */
  it('omits the key entirely for a select that never asked', () => {
    const { location_id, location, ...noLocation } = leadVisitRow(AT_SHOWROOM_COLUMNS) as any;
    const fields = projectLegacyWalkthroughFields([noLocation], { full: true });

    expect(fields).not.toHaveProperty('walkthrough_location_label');
  });

  /**
   * THE COLUMNS WITHOUT THE RELATION - the dangerous half, and the reason the guard reads
   * `location` rather than `location_id`.
   *
   * A select carrying the six columns and not the relation can see that the visit points
   * SOMEWHERE and cannot say where: the showroom's name and street are on the `Location` row. Keyed
   * on `location_id`, that row passed the guard and the response answered `null` - the statement
   * "this trip is at the customer's service address" - about a showroom booking, from columns that
   * never carried the showroom. A response contradicting itself, and one that reads on a card
   * exactly like the common case. Keyed on the relation, it says nothing, which is the only true
   * thing it can say.
   */
  it('omits the key for a select that read the columns but NOT the relation', () => {
    const { location, ...columnsOnly } = leadVisitRow(AT_SHOWROOM_COLUMNS) as any;
    // The row genuinely points at a location - this is not the "asked about nothing" case above.
    expect(columnsOnly.location_id).toBe(SHOWROOM_ID);

    const fields = projectLegacyWalkthroughFields([columnsOnly], { full: true });

    expect(fields).not.toHaveProperty('walkthrough_location_label');
    const history = fields.walkthrough_history as Record<string, unknown>[];
    expect(history[0]).not.toHaveProperty('location_label');
  });

  it('carries it on every history row, so the OTHER trips say where they are too', () => {
    const current = leadVisitRow({
      id: 'w-current', scheduled_at: new Date('2026-09-05T13:00:00Z'),
      created_at: new Date('2026-08-20T10:00:00Z'), ...AT_SHOWROOM_COLUMNS,
    });
    const later = leadVisitRow({
      id: 'w-later', visit_seq: 2, scheduled_at: new Date('2026-09-09T13:00:00Z'),
      created_at: new Date('2026-08-22T10:00:00Z'), ...ONE_OFF_COLUMNS,
    });
    const atService = leadVisitRow({
      id: 'w-service', visit_seq: 3, scheduled_at: new Date('2026-09-11T13:00:00Z'),
      created_at: new Date('2026-08-23T10:00:00Z'),
    });

    const fields = projectLegacyWalkthroughFields([current, later, atService], { full: true });
    const history = fields.walkthrough_history as { id: string; location_label: string | null }[];
    const labelOf = (id: string) => history.find((h) => h.id === id)!.location_label;

    expect(labelOf('w-current')).toBe(SHOWROOM_RENDERED);
    expect(labelOf('w-later')).toBe(ONE_OFF_RENDERED);
    expect(labelOf('w-service')).toBeNull();
  });
});

// ── the three surfaces, through the real routes ─────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
  mockPrisma.job.findFirst.mockResolvedValue(JOB_FIXTURE);
  mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
  mockPrisma.tag.findMany?.mockResolvedValue?.([]);
});

// ── the board's own projection, on its own ─────────────────────────────────
//
// `projectJobVisitLocations` is what puts `location_label` on every visit of every job the board
// lists. Exercised directly as well as through the route, because the route can only show what ONE
// select asks for and the guard is about what happens under a DIFFERENT one.

describe('projectJobVisitLocations - the board payload states only what it read', () => {
  const visitsOf = (job: Record<string, unknown>) =>
    projectJobVisitLocations(job).visits as Record<string, unknown>[];

  it('resolves the label, and drops the relation it followed (D2)', () => {
    const [visit] = visitsOf({ visits: [{ id: 'v1', ...AT_SHOWROOM_COLUMNS }] });

    expect(visit!.location_label).toBe(SHOWROOM_RENDERED);
    expect(visit).not.toHaveProperty('location');
  });

  it('says null for a trip at the service address, because the select DID ask', () => {
    const [visit] = visitsOf({ visits: [{ id: 'v1', ...AT_SERVICE_COLUMNS }] });

    expect(visit).toHaveProperty('location_label');
    expect(visit!.location_label).toBeNull();
  });

  /**
   * THE NEVER-ASKED GUARD. This projection had none at all: it put `location_label` on every visit
   * of every payload whatever the select carried, so `null` - "this trip is at the job's service
   * address" - was stated about columns nothing had read. A test could then pin that `null` on a
   * payload whose select named no location column, and dropping `...visitLocationSelect` from
   * `jobListSelect` stayed green while every board card went back to painting the customer's
   * street on a yard-booked trip.
   */
  it('omits the key for a select that asked about no location at all', () => {
    const [visit] = visitsOf({ visits: [{ id: 'v1', status: 'SCHEDULED' }] });

    expect(visit).not.toHaveProperty('location_label');
  });

  /**
   * And for the columns WITHOUT the relation, which is why the guard reads `location`: those six
   * columns can see a visit points somewhere and cannot say where, so the honest answer is no key
   * rather than the `null` that means "at the service address".
   */
  it('omits the key for a select that read the columns but NOT the relation', () => {
    const { location, ...columnsOnly } = AT_SHOWROOM_COLUMNS;
    const [visit] = visitsOf({ visits: [{ id: 'v1', ...columnsOnly }] });

    expect(visit!.location_id).toBe(SHOWROOM_ID);
    expect(visit).not.toHaveProperty('location_label');
  });

  it('leaves a payload whose select never carried visits at all alone', () => {
    const job = { id: 'j1', job_number: 'J00042' };

    expect(projectJobVisitLocations(job)).toEqual(job);
  });
});

describe('GET /jobs/:id/visits - the job’s visits card', () => {
  function mockVisits(rows: Record<string, unknown>[]) {
    mockPrisma.visit.findMany.mockImplementation((args: { include?: any; select?: any }) =>
      Promise.resolve(rows.map((r) => projectRow(r, args))),
    );
  }
  const listVisits = () =>
    request(app).get(`/api/jobs/${JOB_FIXTURE.id}/visits`).set(authHeader('admin'));

  it('says where a trip at a company location is', async () => {
    mockVisits([jobVisitRow(AT_SHOWROOM_COLUMNS)]);

    const res = await listVisits();

    expect(res.status).toBe(200);
    expect(res.body.visits[0].location_label).toBe(SHOWROOM_RENDERED);
  });

  it('says where a trip at a one-off address is', async () => {
    mockVisits([jobVisitRow(ONE_OFF_COLUMNS)]);

    const res = await listVisits();

    expect(res.body.visits[0].location_label).toBe(ONE_OFF_RENDERED);
  });

  it('says null for a trip at the service address, so the card renders as it does today', async () => {
    mockVisits([jobVisitRow()]);

    const res = await listVisits();

    expect(res.body.visits[0]).toHaveProperty('location_label');
    expect(res.body.visits[0].location_label).toBeNull();
  });

  /**
   * D2, on the WIRE. The relation is followed to RESOLVE the label and must not be shipped beside
   * it: a `location` object on the response is a copy of the Settings row, and a client rendering
   * from it would keep showing yesterday's address after an admin corrected the typo. The label is
   * re-resolved on every read, which is the whole point of a pointer.
   */
  it('never ships the location relation itself, only the resolved line', async () => {
    mockVisits([jobVisitRow(AT_SHOWROOM_COLUMNS)]);

    const res = await listVisits();

    expect(res.body.visits[0]).not.toHaveProperty('location');
    // The label legitimately CONTAINS the address - that is the point. What must not be there is
    // the relation's own shape, which is what a client could re-render from.
    expect(JSON.stringify(res.body)).not.toContain('"name":"Showroom"');
  });
});

describe('GET /jobs - the board the schedule detail opens from', () => {
  function mockJobs(visits: Record<string, unknown>[]) {
    mockPrisma.job.findMany.mockImplementation((args: { select?: any; include?: any }) =>
      Promise.resolve([projectRow({ ...JOB_FIXTURE, visits, tags: [] }, args)]),
    );
    mockPrisma.job.count.mockResolvedValue(1);
    mockPrisma.job.groupBy.mockResolvedValue([]);
  }
  const listJobs = () => request(app).get('/api/jobs').set(authHeader('admin'));

  it('carries each trip’s location, so a board card and its detail can say where it is', async () => {
    mockJobs([
      { ...jobVisitRow(AT_SHOWROOM_COLUMNS), id: 'v-showroom' },
      { ...jobVisitRow(ONE_OFF_COLUMNS), id: 'v-oneoff', visit_seq: 2 },
      { ...jobVisitRow(), id: 'v-service', visit_seq: 3 },
    ]);

    const res = await listJobs();

    expect(res.status).toBe(200);
    const visits = res.body.jobs[0].visits as { id: string; location_label: string | null }[];
    const labelOf = (id: string) => visits.find((v) => v.id === id)!.location_label;
    expect(labelOf('v-showroom')).toBe(SHOWROOM_RENDERED);
    expect(labelOf('v-oneoff')).toBe(ONE_OFF_RENDERED);
    expect(labelOf('v-service')).toBeNull();
  });

  it('never ships the location relation on a board payload either', async () => {
    mockJobs([jobVisitRow(AT_SHOWROOM_COLUMNS)]);

    const res = await listJobs();

    expect(res.body.jobs[0].visits[0]).not.toHaveProperty('location');
  });
});

describe('the lead responses carry it through the real route', () => {
  function leadWith(visits: Record<string, unknown>[]) {
    return { ...LEAD_FIXTURE, visits, tags: [], customer: null, service_location: null, estimates: [] };
  }

  it('GET /leads/:id - the walkthrough tab’s own trip and its other trips', async () => {
    const current = { ...leadVisitRow(AT_SHOWROOM_COLUMNS), id: 'w-current' };
    const other = {
      ...leadVisitRow(ONE_OFF_COLUMNS),
      id: 'w-other', visit_seq: 2,
      scheduled_at: new Date('2026-09-09T13:00:00Z'),
      created_at: new Date('2026-08-22T10:00:00Z'),
    };
    mockPrisma.lead.findUnique.mockImplementation((args: { select?: any }) =>
      Promise.resolve(projectRow(leadWith([current, other]), args)),
    );

    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.walkthrough_location_label).toBe(SHOWROOM_RENDERED);
    const history = res.body.lead.walkthrough_history as { id: string; location_label: string | null }[];
    expect(history.find((h) => h.id === 'w-other')!.location_label).toBe(ONE_OFF_RENDERED);
  });

  it('GET /leads/:id - a trip at the service address reads as it always has', async () => {
    mockPrisma.lead.findUnique.mockImplementation((args: { select?: any }) =>
      Promise.resolve(projectRow(leadWith([leadVisitRow()]), args)),
    );

    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.walkthrough_location_label).toBeNull();
  });

  /** The scheduler board builds its walkthrough cards from the LIST, so the label rides there too. */
  it('GET /leads - the board’s walkthrough card can say where the meeting is', async () => {
    mockPrisma.lead.findMany.mockImplementation((args: { select?: any }) =>
      Promise.resolve([projectRow(leadWith([leadVisitRow(AT_SHOWROOM_COLUMNS)]), args)]),
    );
    mockPrisma.lead.count.mockResolvedValue(1);

    const res = await request(app).get('/api/leads').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads[0].walkthrough_location_label).toBe(SHOWROOM_RENDERED);
  });

  /**
   * D2 on the wire, the lead half: the relation is followed, never shipped.
   *
   * The rendered LABEL contains the address, and must - that is what the card shows. What must not
   * ship is the relation's own shape, because a client holding that would be free to re-render from
   * its own copy and keep showing yesterday's address after an admin corrected it in Settings.
   */
  it('never ships the location relation on a lead payload', async () => {
    mockPrisma.lead.findUnique.mockImplementation((args: { select?: any }) =>
      Promise.resolve(projectRow(leadWith([leadVisitRow(AT_SHOWROOM_COLUMNS)]), args)),
    );

    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.body.lead.walkthrough_location_label).toBe(SHOWROOM_RENDERED);
    expect(res.body.lead).not.toHaveProperty('visits');
    expect(JSON.stringify(res.body)).not.toContain('"name":"Showroom"');
  });
});

// ═══ THE AGREEMENT, END TO END ══════════════════════════════════════════════
//
// "What a card shows and what the merge field renders for the same visit agree, and a test asserts
// the AGREEMENT rather than checking each in isolation."
//
// So: ONE visit row, handed to BOTH production paths - the read route the card is built from, and
// `loadExecutionBundle`, which is what actually renders a customer's email - and the two answers
// compared to each other. Nothing is compared to a literal, because two literals are exactly how
// the two would drift apart while both halves stayed green.
//
// The comparison is stated as a rule rather than as a pair of equalities, because the two surfaces
// answer DIFFERENT QUESTIONS about the same fact: a card shows the difference and the email shows
// the address. So where the card says something, it must be the string the email says; and where
// the card says nothing, the email must be saying the customer's own address. Either half alone
// would be satisfiable by a card that shows nothing at all.

/** Far enough ahead that `resolveNextJobVisit`'s "still to come" filter holds without a fake clock. */
const FUTURE = new Date('2027-05-04T13:00:00.000Z');

const AGREEMENT_ORG = {
  name: 'Blue Ridge Plumbing', phone: '(555) 204-7788', timezone: 'America/New_York',
  currency: 'USD', logo_url: null, brand_color: '#0C2D3A',
};

/**
 * Which of the two answers this trip is entitled to. The CASE states it; the helper never infers
 * it from what the code under test returned.
 *
 * That inversion is the whole of this helper's protection. Deriving the branch from `cardLabel`
 * meant a formatter that answered `null` for EVERY visit - the slice dead, every card blank - took
 * the no-difference branch for all three cases and passed all six of them: the one criterion this
 * block exists to prove was satisfiable by precisely the state it exists to rule out, because the
 * `not.toBe(serviceAddress)` guard only ever ran on the branch that was already passing.
 */
type WhereTheTripIs = 'somewhere of its own' | 'the service address';

/**
 * Assert the two surfaces agree about one trip, given where the case says the trip is.
 *
 * `cardLabel` is what the read route served; `emailLocation` / `emailServiceAddress` are the two
 * merge fields that land in the same message body. The two surfaces answer DIFFERENT questions
 * about the same fact - a card shows the difference, an email shows the address - so agreement is
 * stated as a rule per state rather than as one equality.
 */
function expectSurfacesAgree(
  where: WhereTheTripIs,
  cardLabel: string | null,
  emailLocation: string,
  emailServiceAddress: string,
) {
  if (where === 'the service address') {
    // Nothing to report, and the card must actually be reporting nothing...
    expect(cardLabel).toBeNull();
    // ...while the email sends the customer to the address they already have.
    expect(emailLocation).toBe(emailServiceAddress);
    return;
  }
  // The case says this trip IS somewhere else, so a null label is the DEFECT, not a branch to
  // take. Asserted before the equality, because it is what stops a dead formatter reaching an
  // agreement it satisfies trivially.
  expect(cardLabel).not.toBeNull();
  expect(cardLabel).toBe(emailLocation);
  // ...and the string really is a difference, not the customer's own address restated.
  expect(cardLabel).not.toBe(emailServiceAddress);
}

describe('the card and the email cannot disagree - through both production paths', () => {
  // Each case names the location state it exercises, so the assertions below are chosen by the
  // FIXTURE rather than by the answer the code gave - see `expectSurfacesAgree`.
  for (const [name, columns, where] of [
    ['a company location', AT_SHOWROOM_COLUMNS, 'somewhere of its own'],
    ['a one-off address', ONE_OFF_COLUMNS, 'somewhere of its own'],
    ['the service address', AT_SERVICE_COLUMNS, 'the service address'],
  ] as const) {
    it(`agrees about a LEAD walkthrough at ${name}`, async () => {
      const visit = { ...leadVisitRow(columns), scheduled_at: FUTURE };
      const leadRow = {
        ...LEAD_FIXTURE, visits: [visit], tags: [], estimates: [],
        customer: { id: 'c1', first_name: 'Sarah', last_name: 'Mitchell', email: 's@example.com', phone: '+15551234567' },
        service_location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' },
        commission_owner: null,
      };

      // (1) the card: the real read route, projected through the real select.
      mockPrisma.lead.findUnique.mockImplementation((args: { select?: any }) =>
        Promise.resolve(projectRow(leadRow, args)),
      );
      const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));
      expect(res.status).toBe(200);

      // (2) the email: the real automation context, over the SAME visit row.
      mockPrisma.organization.findUnique.mockResolvedValue(AGREEMENT_ORG);
      mockPrisma.lead.findFirst.mockResolvedValue(leadRow);
      const bundle = await loadExecutionBundle({
        entityType: 'lead', entityId: LEAD_FIXTURE.id,
        organizationId: ALPHA_ORG_ID, dedupeKey: `agree-lead-${name}`,
      });

      expectSurfacesAgree(
        where,
        res.body.lead.walkthrough_location_label,
        bundle!.bundle.mergeCtx['lead.walkthrough_location'] as string,
        bundle!.bundle.mergeCtx['lead.address'] as string,
      );
    });

    it(`agrees about a JOB visit at ${name}`, async () => {
      const visit = {
        ...jobVisitRow(columns),
        scheduled_at: FUTURE,
        scheduled_end: new Date('2027-05-04T15:30:00.000Z'),
      };

      // (1) the card: GET /jobs/:id/visits, the shape the Visits card renders from.
      mockPrisma.visit.findMany.mockImplementation((args: { include?: any; select?: any }) =>
        Promise.resolve([projectRow(visit, args)]),
      );
      const res = await request(app)
        .get(`/api/jobs/${JOB_FIXTURE.id}/visits`).set(authHeader('admin'));
      expect(res.status).toBe(200);

      // (2) the email, over the SAME visit row.
      mockPrisma.organization.findUnique.mockResolvedValue(AGREEMENT_ORG);
      mockPrisma.job.findFirst.mockResolvedValue({
        ...JOB_FIXTURE, job_number: 'J00042', scope_notes: null, job_type: 'Repair',
        customer: { id: 'c1', first_name: 'Sarah', last_name: 'Mitchell', email: 's@example.com', phone: '+15551234567' },
        service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
        visits: [visit], dispatcher: null, salesperson: null, estimate: null,
      });
      const bundle = await loadExecutionBundle({
        entityType: 'job', entityId: JOB_FIXTURE.id,
        organizationId: ALPHA_ORG_ID, dedupeKey: `agree-job-${name}`,
      });

      expectSurfacesAgree(
        where,
        res.body.visits[0].location_label,
        bundle!.bundle.mergeCtx['job.visit_location'] as string,
        bundle!.bundle.mergeCtx['job.address'] as string,
      );
    });
  }
});
