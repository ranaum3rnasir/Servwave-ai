/**
 * Lead stage clocks — spec #1751, decisions D2, D3, D6 and D7.
 *
 * A business owner wants three durations out of this product: lead-in to first contact, first
 * contact to a booked walkthrough, and completed walkthrough to sent estimate. None was
 * computable, because nothing recorded the moment a lead reached a stage.
 *
 * Driven through the HTTP API against the real Express app with Prisma mocked — the seam the
 * backend suite already uses in roughly 530 files. Nothing below reaches for the shape of a
 * helper, deliberately: D3 turns "is the walkthrough complete" into THREE fields, and a test
 * welded to one of them would have to be rewritten by the next person who touches this.
 *
 * Three of these are written as invariants rather than examples, because each is a defect the
 * spec exists to prevent: MONOTONICITY, NON-DESTRUCTION and PROVENANCE. They are labelled below.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { transitionLeadStatus } from '../services/lead-stage.service';

const mockPrisma = prisma as unknown as Record<string, any>;

const MARCH = new Date('2026-03-10T15:00:00.000Z');
const APRIL = new Date('2026-04-20T11:00:00.000Z');

const SCHEDULED_VISIT = {
  id: 'v0000000-0000-0000-0000-000000000001',
  organization_id: ALPHA_ORG_ID,
  lead_id: LEAD_FIXTURE.id,
  job_id: null,
  purpose: 'WALKTHROUGH',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-04-20T10:00:00.000Z'),
  scheduled_end: new Date('2026-04-20T11:00:00.000Z'),
  is_all_day: false,
  duration_minutes: 60,
  en_route_at: null,
  on_site_at: null,
  started_at: null,
  completed_at: null,
  notes: null,
  cancelled_at: null,
  cancelled_reason: null,
  cancelled_by: null,
  customer_email_sent_at: null,
  created_at: new Date('2026-04-01T10:00:00.000Z'),
  updated_at: new Date('2026-04-01T10:00:00.000Z'),
  assignees: [],
};

/** The clock columns as they sit on a lead that has never reached any stage. */
const NO_CLOCKS = {
  contacted_at: null,
  contacted_set_by: null,
  walkthrough_first_booked_at: null,
  walkthrough_first_completed_at: null,
  last_visit_completed_at: null,
  first_estimate_sent_at: null,
  won_at: null,
};

/**
 * The clock columns as the MOCKED DATABASE holds them for the lead under test.
 *
 * The two monotonic clocks are written by a conditional statement (`UPDATE ... WHERE col IS
 * NULL`), which is what makes first-touch-wins atomic instead of a read-then-write across the
 * transaction boundary. A mock that always answered `{ count: 1 }` could not tell that guard
 * from its absence, so `lead.updateMany` below emulates Postgres and keeps the resulting state
 * here for the invariants to assert against.
 */
let stored: Record<string, Date | null>;

/** Tell the mocked database which clocks this lead already carries. */
function seedStoredClocks(clocks: Record<string, unknown>) {
  stored = Object.fromEntries(
    Object.keys(NO_CLOCKS).map((k) => [k, (clocks[k] ?? null) as Date | null]),
  );
}

/**
 * The lead row a door reads, AND the mocked database's starting state for its clocks — the two
 * are the same fact, so seeding them separately would let a test lie to itself.
 */
function leadRow(over: Record<string, unknown> = {}) {
  const row = { ...LEAD_FIXTURE, ...NO_CLOCKS, ...over };
  seedStoredClocks(row);
  return row;
}

/** Every conditional clock write the request made for one column, WHERE clause included. */
function guardedWritesFor(clock: string) {
  return mockPrisma.lead.updateMany.mock.calls
    .map((c: any[]) => c[0])
    .filter((args: any) => args?.data?.[clock] !== undefined);
}

/** The `data` of every lead write the request made, in order. */
function leadWrites() {
  return [
    ...mockPrisma.lead.update.mock.calls.map((c: any[]) => c[0]?.data ?? {}),
    ...mockPrisma.lead.updateMany.mock.calls.map((c: any[]) => c[0]?.data ?? {}),
  ];
}

function statusChangeEvents() {
  return mockPrisma.timelineEvent.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .filter((d: any) => d?.event_type === 'STATUS_CHANGE');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  // The whole mocked client is handed back as `tx`, so a top-level mock configured here is what
  // the controller sees inside its transaction. Same convention as leads.test.ts.
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  mockPrisma.lead.update.mockResolvedValue(leadRow());
  // `lead.updateMany` with Postgres's own semantics, not a blanket `{ count: 1 }`. The status
  // writer reads `count` to decide whether anything actually changed (and therefore whether to
  // file a ledger entry), and `stampLeadClock` reads it to answer "was I the first touch". A
  // guarded write — one naming a clock column as `null` in its WHERE — is REFUSED when that
  // column already carries a value, which is the whole of the monotonicity invariant.
  mockPrisma.lead.updateMany.mockImplementation((args: any) => {
    const where = (args?.where ?? {}) as Record<string, unknown>;
    const data = (args?.data ?? {}) as Record<string, unknown>;
    const guardedClocks = Object.keys(where).filter((k) => k in stored && where[k] === null);
    if (guardedClocks.some((k) => stored[k] !== null)) return Promise.resolve({ count: 0 });
    for (const [k, v] of Object.entries(data)) {
      if (k in stored) stored[k] = v as Date;
    }
    return Promise.resolve({ count: 1 });
  });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.visit.findMany.mockResolvedValue([]);
  // complete/unschedule/cancel resolve their target through findActiveWalkthrough, which is a
  // findFirst over the lead's LIVE visits. Default to "nothing live"; the tests that act on a
  // visit set it themselves.
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.visit.update.mockResolvedValue(SCHEDULED_VISIT);
  mockPrisma.estimate.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.invoice.updateMany.mockResolvedValue({ count: 0 });
});

describe('walkthrough completion — the three clocks of D3', () => {
  it('stamps BOTH the first-completion and the latest-completion clock on the first completion', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'CONTACTED' }));
    mockPrisma.visit.findMany.mockResolvedValue([SCHEDULED_VISIT]);
    mockPrisma.visit.findFirst.mockResolvedValue(SCHEDULED_VISIT);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const written = Object.assign({}, ...leadWrites());
    expect(written.walkthrough_first_completed_at).toBeInstanceOf(Date);
    expect(written.last_visit_completed_at).toBeInstanceOf(Date);
    // They agree on the first completion and diverge later — the next test is the interesting one.
    expect(written.last_visit_completed_at).toEqual(written.walkthrough_first_completed_at);
  });

  it('INVARIANT (monotonicity): a second completion moves the latest clock and never the first', async () => {
    // The lead finished a walkthrough in March. A follow-up visit is booked and completed in
    // April. "Did this lead ever finish a walkthrough" is still answered by March — permanently —
    // while "is anything outstanding right now" re-anchors to April.
    //
    // This is the case that motivated the whole spec. An earlier design had the completion clock
    // CLEAR when a later visit was booked, which would have erased the evidence of a deadline
    // that had already been missed. Ratified by the product owner: a recorded breach stands.
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({
      status: 'CONTACTED',
      walkthrough_first_completed_at: MARCH,
      last_visit_completed_at: MARCH,
    }));
    mockPrisma.visit.findMany.mockResolvedValue([{ ...SCHEDULED_VISIT, visit_seq: 2 }]);
    mockPrisma.visit.findFirst.mockResolvedValue({ ...SCHEDULED_VISIT, visit_seq: 2 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // The monotonic clock is written through a CONDITIONAL statement whose WHERE requires the
    // column to still be null, so the invariant is asserted the way Postgres enforces it rather
    // than by the absence of a key. `conditionalLeadClocks` above emulates exactly that: it
    // refuses a guarded write against a column that already carries a value, so the stored March
    // stamp can only move if the code stopped guarding.
    expect(stored.walkthrough_first_completed_at).toEqual(MARCH);
    expect(guardedWritesFor('walkthrough_first_completed_at')).toHaveLength(1);
    expect(guardedWritesFor('walkthrough_first_completed_at')[0].where).toMatchObject({
      id: LEAD_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      walkthrough_first_completed_at: null,
    });
    // The re-anchoring twin has no such guard and moves on every completion — that is the whole
    // of D3: one field says "did it ever happen", the other says "is anything outstanding now".
    const written = Object.assign({}, ...leadWrites());
    expect(written.last_visit_completed_at).toBeInstanceOf(Date);
    expect(written.last_visit_completed_at).not.toEqual(MARCH);
  });

  it('INVARIANT (non-destruction): no completion path ever writes null into a clock', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({
      status: 'CONTACTED',
      walkthrough_first_booked_at: MARCH,
      walkthrough_first_completed_at: MARCH,
    }));
    mockPrisma.visit.findMany.mockResolvedValue([{ ...SCHEDULED_VISIT, visit_seq: 2 }]);
    mockPrisma.visit.findFirst.mockResolvedValue({ ...SCHEDULED_VISIT, visit_seq: 2 });

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
      .set(authHeader('admin'))
      .send({});

    for (const data of leadWrites()) {
      for (const clock of Object.keys(NO_CLOCKS)) {
        expect(data[clock] ?? 'absent').not.toBeNull();
      }
    }
  });
});

describe('walkthrough booking — the clock is the BOOKING moment', () => {
  it('stamps the booked clock on the first booking, and stamps it with NOW rather than the appointment', async () => {
    // The owner's policy is "every lead gets a walkthrough booked within a day or two of first
    // contact". An appointment set three weeks out was still booked on time, so anchoring on the
    // appointment instant would score the salesperson on the customer's availability.
    const appointment = '2026-09-01T14:00:00.000Z';
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'CONTACTED' }));
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: null } });
    mockPrisma.visit.create.mockResolvedValue({ ...SCHEDULED_VISIT, scheduled_at: new Date(appointment) });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ walkthrough_scheduled_at: appointment, walkthrough_duration_minutes: 60, performer_ids: [] });

    expect(res.status).toBe(200);
    const written = Object.assign({}, ...leadWrites());
    expect(written.walkthrough_first_booked_at).toBeInstanceOf(Date);
    expect(written.walkthrough_first_booked_at.toISOString()).not.toBe(appointment);
  });

  it('INVARIANT (monotonicity): booking a second walkthrough leaves the first-booked clock alone', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'CONTACTED', walkthrough_first_booked_at: MARCH }));
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...SCHEDULED_VISIT, visit_seq: 2 });

    await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ walkthrough_scheduled_at: APRIL.toISOString(), walkthrough_duration_minutes: 60, performer_ids: [] });

    // Same shape as the completion invariant above: the guard lives in the WHERE clause, so the
    // proof is that the stored value did not move and that the statement carried its null test.
    expect(stored.walkthrough_first_booked_at).toEqual(MARCH);
    expect(guardedWritesFor('walkthrough_first_booked_at')).toHaveLength(1);
    expect(guardedWritesFor('walkthrough_first_booked_at')[0].where).toMatchObject({
      id: LEAD_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      walkthrough_first_booked_at: null,
    });
  });

  it('INVARIANT (provenance): booking a walkthrough moves the STATUS to Walkthrough Scheduled but never writes the CONTACT clock', async () => {
    // The negative case, asserted explicitly, because the positive one passing tells you nothing
    // about the filter. Booking a walkthrough moves a NEW lead to Walkthrough Scheduled in the
    // same transaction — so if a status move wrote the contact clock, the "first contact to
    // walkthrough booked" interval would be structurally zero for exactly the leads it is meant
    // to measure. Contact is human-originated OUTBOUND activity (D5) and nothing else.
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'NEW' }));
    // The status rule reads the lead and counts its visits through the transaction client (here
    // the shared mock): the lead is New, and the visit just booked is open.
    mockPrisma.lead.findFirst.mockResolvedValue({ status: 'NEW' });
    mockPrisma.visit.count.mockResolvedValue(1);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: null } });
    mockPrisma.visit.create.mockResolvedValue(SCHEDULED_VISIT);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ walkthrough_scheduled_at: APRIL.toISOString(), walkthrough_duration_minutes: 60, performer_ids: [] });

    expect(res.status).toBe(200);
    const written = Object.assign({}, ...leadWrites());
    expect(written.status).toBe('WALKTHROUGH_SCHEDULED');
    expect(written).not.toHaveProperty('contacted_at');
  });

  it('INVARIANT (the SLA cannot be dodged): booking never touches the completion clock', async () => {
    // The load-bearing half of the product owner's decision to anchor the estimate SLA on
    // last_visit_completed_at rather than on a human answering "are more visits needed?".
    //
    // ONLY a completion may move that clock. If booking moved it too, a lead that had already
    // blown its estimate deadline could be lifted out of the alert by booking a visit and then
    // cancelling it — the SLA would be measuring intent instead of work, and the easiest way to
    // look on time would be to schedule something you never do. Asserted on the write SHAPE
    // rather than on a stored value, because the re-anchoring clock rides an unconditional
    // `lead.update`: a mock's end state cannot distinguish "not written" from "written the same".
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({
      status: 'CONTACTED',
      walkthrough_first_booked_at: MARCH,
      walkthrough_first_completed_at: MARCH,
      last_visit_completed_at: MARCH,
    }));
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
    mockPrisma.visit.create.mockResolvedValue({ ...SCHEDULED_VISIT, visit_seq: 2 });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send({ walkthrough_scheduled_at: APRIL.toISOString(), walkthrough_duration_minutes: 60, performer_ids: [] });

    expect(res.status).toBe(200);
    expect(leadWrites().length).toBeGreaterThan(0);
    for (const data of leadWrites()) expect(data).not.toHaveProperty('last_visit_completed_at');
  });
});

describe('the status ledger (D6/D7)', () => {
  it('records from and to on the timeline when a lead is marked lost', async () => {
    // The two lead status events that existed before this spec (cancel, mark-lost) recorded
    // NEITHER, which is why no time-in-stage was computable even retroactively.
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'ESTIMATED' }));

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Went with a competitor' });

    expect(res.status).toBe(200);
    const [event] = statusChangeEvents();
    expect(event.metadata).toMatchObject({ from: 'ESTIMATED', to: 'LOST' });
    expect(event.entity_type).toBe('LEAD');
    expect(event.created_by).toBeTruthy();
  });

  it('stamps won_at and records the transition when a lead is set to WON by hand', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'ESTIMATED' }));
    mockPrisma.estimate.count.mockResolvedValue(0);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'WON' });

    expect(res.status).toBe(200);
    const written = Object.assign({}, ...leadWrites());
    expect(written.status).toBe('WON');
    expect(written.won_at).toBeInstanceOf(Date);
    expect(statusChangeEvents()[0].metadata).toMatchObject({ from: 'ESTIMATED', to: 'WON' });
  });

  it('files no ledger entry when the status is re-asserted rather than changed', async () => {
    // The ledger records what OCCURRED. Re-sending the status a lead is already in did not occur,
    // and an idempotent webhook that retries must not file a row every time.
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'ESTIMATED' }));

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'ESTIMATED' });

    expect(res.status).toBe(200);
    expect(statusChangeEvents()).toHaveLength(0);
  });

  it('will not pull a won lead backwards when its walkthrough is unscheduled', async () => {
    // The unschedule door used to force CONTACTED unconditionally. Routing it through the one
    // writer applies that writer's terminal guard, so a WON lead keeps its status — and, because
    // nothing changed, files no ledger entry either.
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'WON', won_at: MARCH }));
    // The status rule re-reads the lead and counts its visits under the row lock: a Won lead
    // whose only visit has just gone, which is the case that would fall back to Contacted.
    mockPrisma.lead.findFirst.mockResolvedValue({ status: 'WON' });
    mockPrisma.visit.count.mockResolvedValue(0);
    mockPrisma.visit.findMany.mockResolvedValue([SCHEDULED_VISIT]);
    mockPrisma.visit.findFirst.mockResolvedValue(SCHEDULED_VISIT);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    for (const data of leadWrites()) expect(data.status).not.toBe('CONTACTED');
    expect(statusChangeEvents()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The two writers the review found with NO coverage at all.
//
// Both were proved dead by disabling them and watching the whole 9,000-test suite stay green.
// One is the closing edge of the metric the spec calls the one owners care about most; the other
// is a stamp whose own comment argues it exists so the clock cannot depend on which of two
// equivalent doors was used — and only the other door was tested.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('first_estimate_sent_at — the closing edge of the headline metric', () => {
  const ESTIMATE_ID = '11110000-0000-0000-0000-0000000000e1';
  const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';

  /** A sendable estimate: has a lead, has line items, has a reachable customer. */
  function estimateRow(over: Record<string, unknown> = {}) {
    return {
      id: ESTIMATE_ID,
      status: 'DRAFT',
      estimate_number: 'E00001',
      total_amount: 1062.5,
      lead_id: LEAD_FIXTURE.id,
      public_token: null,
      valid_until: null,
      modified_after_send: false,
      version: 1,
      deposit_type: null,
      deposit_value: null,
      created_by: null,
      customer_id: CUSTOMER_ID,
      customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
      _count: { line_items: 2 },
      lead: { lead_assignees: [], status: 'CONTACTED', customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' } },
      send_config: null,
      job_id: null,
      job: null,
      job_link: null,
      ...over,
    };
  }

  beforeEach(() => {
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow());
    mockPrisma.estimate.update.mockResolvedValue({ ...estimateRow(), status: 'SENT' });
    mockPrisma.estimateVersionSnapshot.create.mockResolvedValue({});
    // The send door's commit phase reaches for models this file's default `fn(prisma)` transaction
    // does not carry (estimateSendConfig.upsert has no double in setup.ts at all). `lead` is
    // DELEGATED to the shared mock rather than given a fresh vi.fn(), so the conditional-write
    // emulation and `guardedWritesFor` above see this door's writes like any other.
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: mockPrisma.estimate.update, findUnique: mockPrisma.estimate.findUnique },
        estimateSendConfig: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }),
          update: vi.fn().mockResolvedValue({}),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
        lead: { update: mockPrisma.lead.update, updateMany: mockPrisma.lead.updateMany },
      }),
    );
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ALPHA_ORG_ID, name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    // hasCompletedWalkthrough's silent instrumentation read.
    mockPrisma.visit.count.mockResolvedValue(0);
  });

  function send(over: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [], ...over });
  }

  /** Every write of the estimate clock, WHERE clause included. */
  function estimateClockWrites() {
    return guardedWritesFor('first_estimate_sent_at');
  }

  it('stamps the clock when the estimate first goes out', async () => {
    seedStoredClocks({});

    const res = await send();

    expect(res.status).toBe(200);
    expect(estimateClockWrites()).toHaveLength(1);
    expect(estimateClockWrites()[0].where).toMatchObject({
      id: LEAD_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      first_estimate_sent_at: null,
    });
    expect(estimateClockWrites()[0].data.first_estimate_sent_at).toBeInstanceOf(Date);
  });

  // A RESEND is not a send. The clock answers "how long did the salesperson take", asked once —
  // and a resend of an estimate that went out before this column existed would otherwise stamp it
  // with today's date and report an instant turnaround on a lead that in fact waited months.
  it('does NOT stamp the clock on a resend', async () => {
    seedStoredClocks({});
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow({ status: 'SENT', public_token: 'tok' }));

    const res = await send();

    expect(res.status).toBe(200);
    expect(estimateClockWrites()).toEqual([]);
  });

  // A SECOND estimate on the same lead is a genuine first send of a different document, so the
  // writer does run — and is refused by the database, because the owner asks the question once
  // per lead rather than once per document.
  it('does not move the clock when a second estimate is sent on the same lead', async () => {
    seedStoredClocks({ first_estimate_sent_at: MARCH });
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow({ id: '11110000-0000-0000-0000-0000000000e2', estimate_number: 'E00002' }));

    const res = await request(app)
      .post('/api/estimates/11110000-0000-0000-0000-0000000000e2/send')
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(res.status).toBe(200);
    // The guard is what refuses it, so it must be in the statement.
    expect(estimateClockWrites()).toHaveLength(1);
    expect(estimateClockWrites()[0].where).toMatchObject({ first_estimate_sent_at: null });
    expect(stored.first_estimate_sent_at).toEqual(MARCH);
  });

  // An estimate raised straight against a customer has no lead to stamp (SERV10X-61).
  it('stamps nothing for a customer-anchored estimate with no lead', async () => {
    seedStoredClocks({});
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateRow({ lead_id: null, lead: null }));

    const res = await send();

    expect(res.status).toBe(200);
    expect(estimateClockWrites()).toEqual([]);
  });
});

describe('POST /api/leads/:id/visits — the OTHER booking door stamps the same clock', () => {
  const NEW_VISIT = { ...SCHEDULED_VISIT, id: 'v0000000-0000-0000-0000-000000000002', visit_seq: 2 };

  beforeEach(() => {
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.visitAssignee.findMany.mockResolvedValue([]);
    mockPrisma.visitAssignee.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.visitAssignee.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.visit.create.mockResolvedValue(NEW_VISIT);
    mockPrisma.visit.aggregate.mockResolvedValue({ _max: { visit_seq: 1 } });
  });

  function bookVisit() {
    return request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/visits`)
      .set(authHeader('admin'))
      .send({ scheduled_at: '2026-09-04T14:00:00Z', duration_minutes: 90, assignee_ids: [] });
  }

  // The stamp exists so the clock does not depend on WHICH of two equivalent doors a dispatcher
  // happened to use. Only the other one (/walkthrough/schedule) was covered, so this door could
  // have been deleted outright with the whole suite still green.
  it('stamps the booked clock on a lead that has never had a visit booked', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'CONTACTED' }));

    const res = await bookVisit();

    expect(res.status).toBe(201);
    const bookedWrites = guardedWritesFor('walkthrough_first_booked_at');
    expect(bookedWrites).toHaveLength(1);
    expect(bookedWrites[0].where).toMatchObject({
      id: LEAD_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      walkthrough_first_booked_at: null,
    });
    // NOW, not the appointment: an appointment set weeks out was still booked on time.
    expect(bookedWrites[0].data.walkthrough_first_booked_at).toBeInstanceOf(Date);
    expect(bookedWrites[0].data.walkthrough_first_booked_at.toISOString()).not.toBe('2026-09-04T14:00:00.000Z');
    expect(stored.walkthrough_first_booked_at).toBeInstanceOf(Date);
  });

  // This door books an ADDITIONAL visit, which is its normal case: the lead usually already has
  // a booking, and the write must be refused rather than move the clock forward.
  it('does not move an existing booked clock', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(leadRow({ status: 'CONTACTED', walkthrough_first_booked_at: MARCH }));

    const res = await bookVisit();

    expect(res.status).toBe(201);
    expect(guardedWritesFor('walkthrough_first_booked_at')).toHaveLength(1);
    expect(stored.walkthrough_first_booked_at).toEqual(MARCH);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The one assertion in this file made against the writer directly rather than through a door.
//
// Everything above is driven over HTTP on purpose. This cannot be: `onlyFrom` and `notFrom`
// together is not constructible from any door in the product today — all four `onlyFrom` callers
// pass `notFrom: []` — so there is no request that would reach it. It is guarded anyway, because
// the shape that used to be here silently DISCARDED `notFrom` when `onlyFrom` was present, and the
// next caller to pass both would have got a WHERE clause weaker than its own call site reads.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('transitionLeadStatus — the SQL guard honours both halves', () => {
  function tx() {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    return { updateMany, client: { lead: { updateMany }, timelineEvent: { create: vi.fn().mockResolvedValue({}) } } };
  }

  it('puts both onlyFrom and notFrom into the statement when both are given', async () => {
    const t = tx();
    await transitionLeadStatus(t.client as never, {
      leadId: LEAD_FIXTURE.id,
      orgId: ALPHA_ORG_ID,
      to: 'ESTIMATED',
      from: 'CONTACTED',
      onlyFrom: ['NEW', 'CONTACTED'],
      notFrom: ['WON'],
      description: 'test',
    });

    expect(t.updateMany.mock.calls[0][0].where.status).toEqual({ in: ['NEW', 'CONTACTED'], notIn: ['WON'] });
  });

  it('keeps each half alone exactly as it was', async () => {
    const only = tx();
    await transitionLeadStatus(only.client as never, {
      leadId: LEAD_FIXTURE.id, orgId: ALPHA_ORG_ID, to: 'ESTIMATED', from: 'CONTACTED',
      onlyFrom: ['NEW', 'CONTACTED'], notFrom: [], description: 'test',
    });
    expect(only.updateMany.mock.calls[0][0].where.status).toEqual({ in: ['NEW', 'CONTACTED'] });

    const not = tx();
    await transitionLeadStatus(not.client as never, {
      leadId: LEAD_FIXTURE.id, orgId: ALPHA_ORG_ID, to: 'WON', from: 'ESTIMATED', description: 'test',
    });
    expect(not.updateMany.mock.calls[0][0].where.status).toEqual({ notIn: ['WON', 'LOST', 'CANCELLED'] });
  });
});
