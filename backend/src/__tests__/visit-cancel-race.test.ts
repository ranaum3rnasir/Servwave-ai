/**
 * visit-cancel-race.test.ts — the cancel half of the pre-transaction-read race.
 *
 * THE DEFECT, restated for the doors that were left unguarded when the completion race was
 * closed. `unscheduleWalkthrough`, `cancelWalkthrough` and the job side's `cancelVisit` all
 * resolve their target with a read that runs BEFORE the transaction opens, then write that row by
 * id. The read is a snapshot, not a lock, so two requests arriving together both hold the same
 * live visit and both write it. Three things that costs:
 *
 *   1. a cancel (or an unschedule) that raced a COMPLETION rewound the completed visit to
 *      CANCELLED, and the completion — the thing that actually happened — was gone;
 *   2. two cancels arriving together silently overwrote each other's `cancelled_reason`, which is
 *      the customer-facing history Q4 spent a slice protecting from exactly this;
 *   3. both losers still filed a timeline event, so the ledger recorded a cancellation that never
 *      landed.
 *
 * Completion was the loud instance because the lead's monotonic clock held a second opinion and
 * the two disagreed. Cancel has no second opinion anywhere in the system, so a clobbered row here
 * looks exactly like a correct one — which is the whole reason this file exists rather than a
 * production report.
 *
 * WHY A MOCKED CLIENT CAN PROVE IT. Same argument as walkthrough-completion-race.test.ts: the
 * race needs a STALE SNAPSHOT, not a particular interleaving. `visit.findFirst` always answers
 * the pre-transaction state, and the mocked `visit.updateMany` re-evaluates the WHERE against the
 * row as actually stored — what a real writer does after blocking on the row lock. A writer that
 * names an accept-set is refused; one that does not is not. Delete the guard and these go red.
 *
 * What it cannot prove is that Postgres really serialises the two updates. That is READ
 * COMMITTED's property, not this code's, and it is why the guard belongs in the WHERE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, LEAD_FIXTURE, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as Record<string, any>;

const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';

/** The visit as the DATABASE holds it — the authority every guarded write is re-evaluated against. */
let storedVisit: Record<string, unknown>;

/**
 * The visit as each racer READ it, before either wrote. Deliberately a constant: the snapshot is
 * stale by construction, which is the precondition the defect needs and the one thing a door
 * resolving its target outside the transaction cannot notice on its own.
 */
const SNAPSHOT_AS_READ = {
  id: VISIT_ID,
  job_id: JOB_FIXTURE.id,
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-09-05T13:00:00Z'),
  scheduled_end: new Date('2026-09-05T15:30:00Z'),
  assignees: [],
};

function freshStoredVisit(over: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    organization_id: ALPHA_ORG_ID,
    job_id: JOB_FIXTURE.id,
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00Z'),
    scheduled_end: new Date('2026-09-05T15:30:00Z'),
    completed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');

  storedVisit = freshStoredVisit();

  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.visit.findFirst.mockResolvedValue(SNAPSHOT_AS_READ);
  mockPrisma.visit.findMany.mockImplementation(() => Promise.resolve([{ ...storedVisit }]));
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.estimate.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.estimate.findMany.mockResolvedValue([]);

  // Postgres, not a blanket `{ count: 1 }`. A writer that names an accept-set for `status` is
  // refused when the STORED row has already left that set — the re-evaluation a real writer does
  // after the winner commits. A writer that names none has nothing to re-evaluate and overwrites
  // unconditionally, which is precisely the defect this file exists to prevent.
  mockPrisma.visit.updateMany.mockImplementation((args: any) => {
    const where = (args?.where ?? {}) as Record<string, any>;
    // Addressed by id (the visit doors), or by its lead (the lead-exit sweep, which cancels every
    // live trip of the lead - the stored row stands in for the lead's walkthrough there).
    const addressed = where.id !== undefined ? where.id === storedVisit.id : where.lead_id !== undefined;
    if (!addressed) return Promise.resolve({ count: 0 });
    const accepted: string[] | null = where.status?.in ?? null;
    if (accepted && !accepted.includes(storedVisit.status as string)) return Promise.resolve({ count: 0 });
    Object.assign(storedVisit, args?.data ?? {});
    return Promise.resolve({ count: 1 });
  });

  // The re-read the cancel writer does to hand the row back, and — for an UNGUARDED writer — the
  // write itself. Both go through the same stored row, so a mutation that drops the guard and
  // reverts to `update` still lands here and is still caught by the assertions below.
  mockPrisma.visit.update.mockImplementation((args: any) => {
    Object.assign(storedVisit, args?.data ?? {});
    return Promise.resolve({ ...storedVisit });
  });

  // The job side's derivation and its row-scope probe.
  mockPrisma.job.findUnique.mockResolvedValue({
    id: JOB_FIXTURE.id,
    status: 'SCHEDULED',
    job_number: JOB_FIXTURE.job_number,
    started_at: null,
    customer: { id: 'c1', first_name: 'Test', last_name: 'Client', company_name: null, email: null },
    service_location: { address_line1: '1 Test Way', city: 'Springfield', state: 'NY' },
  });
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
  mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
});

const unschedule = () =>
  request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/unschedule`)
    .set(authHeader('admin'))
    .send({});

const cancelWalkthrough = (reason: string) =>
  request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/cancel`)
    .set(authHeader('admin'))
    .send({ cancelled_reason: reason });

const cancelVisit = (reason: string) =>
  request(app)
    .post(`/api/jobs/${JOB_FIXTURE.id}/visits/${VISIT_ID}/cancel`)
    .set(authHeader('admin'))
    .send({ cancelled_reason: reason });

const eventsOfType = (type: string) =>
  mockPrisma.timelineEvent.create.mock.calls
    .map((c: any[]) => c[0]?.data)
    .filter((d: any) => d?.event_type === type);

describe('unscheduling the same walkthrough twice at once', () => {
  it('INVARIANT: exactly one unschedule lands, and the loser is refused', async () => {
    const [a, b] = await Promise.all([unschedule(), unschedule()]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    // The loser is told what a caller who was merely too late is told. Losing a race is not a
    // server fault, and the door must not leak that a race happened.
    const loser = a.status === 400 ? a : b;
    expect(loser.body.error).toContain('scheduled walkthrough');
  });

  it('INVARIANT: the loser writes nothing — one cancelled_at, one timeline entry', async () => {
    await Promise.all([unschedule(), unschedule()]);

    expect(storedVisit.status).toBe('CANCELLED');
    const accepted = await Promise.all(
      mockPrisma.visit.updateMany.mock.results.map((r: any) => r.value),
    );
    expect(accepted.map((c: any) => c.count).sort()).toEqual([0, 1]);
    expect(eventsOfType('WALKTHROUGH_UNSCHEDULED')).toHaveLength(1);
    // The guarded write is the FIRST statement in the transaction, so the loser throws before it
    // can file anything. That ordering is what makes "nothing happened" true without relying on
    // a rollback, which a mocked client cannot perform.
    expect(mockPrisma.lead.update).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: an unschedule that arrives after a completion never rewinds it', async () => {
    // The snapshot still says SCHEDULED — this request read the visit while it was live. The row
    // went COMPLETED in between. Unconditional, this wrote CANCELLED straight over the top and
    // the completion was gone with no error anywhere.
    const completedAt = new Date('2026-09-05T15:20:00Z');
    storedVisit = freshStoredVisit({ status: 'COMPLETED', completed_at: completedAt });

    const res = await unschedule();

    expect(res.status).toBe(400);
    expect(storedVisit.status).toBe('COMPLETED');
    expect(storedVisit.completed_at).toBe(completedAt);
    expect(storedVisit.cancelled_at).toBeNull();
    expect(eventsOfType('WALKTHROUGH_UNSCHEDULED')).toHaveLength(0);
  });

  it('is guarded on the SAME live set the door\'s own read accepts', async () => {
    // Narrowing to SCHEDULED alone would silently shrink the endpoint: findActiveWalkthrough hands
    // over any live visit, so a tighter guard would start refusing unschedules that succeed today.
    await unschedule();

    const where = mockPrisma.visit.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe(VISIT_ID);
    expect(where.status.in).toEqual(
      expect.arrayContaining(['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS']),
    );
    expect(where.status.in).not.toContain('COMPLETED');
    expect(where.status.in).not.toContain('CANCELLED');
  });
});

describe('cancelling the same walkthrough twice at once', () => {
  it('INVARIANT: exactly one cancellation lands, and the loser is refused', async () => {
    const [a, b] = await Promise.all([cancelWalkthrough('Customer moved out'), cancelWalkthrough('Duplicate lead')]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const loser = a.status === 400 ? a : b;
    expect(loser.body.error).toContain('scheduled walkthrough');
  });

  it('INVARIANT: the WINNER\'s reason is the one the customer keeps', async () => {
    // Q4 protected this against a sequential re-cancel. Concurrently it was still losable: the
    // second writer overwrote the first one's reason, so the row explained the cancellation with
    // words nobody was ever told.
    const [a] = await Promise.all([cancelWalkthrough('Customer moved out'), cancelWalkthrough('Duplicate lead')]);

    const winningReason = a.status === 200 ? 'Customer moved out' : 'Duplicate lead';
    expect(storedVisit.status).toBe('CANCELLED');
    expect(storedVisit.cancelled_reason).toBe(winningReason);
    expect(eventsOfType('WALKTHROUGH_CANCELLED')).toHaveLength(1);
    // A duplicate would tell every automation the walkthrough was called off twice.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a cancellation that arrives after a completion never rewinds it', async () => {
    const completedAt = new Date('2026-09-05T15:20:00Z');
    storedVisit = freshStoredVisit({ status: 'COMPLETED', completed_at: completedAt });

    const res = await cancelWalkthrough('Customer moved out');

    expect(res.status).toBe(400);
    expect(storedVisit.status).toBe('COMPLETED');
    expect(storedVisit.completed_at).toBe(completedAt);
    expect(storedVisit.cancelled_reason).toBeNull();
    expect(eventsOfType('WALKTHROUGH_CANCELLED')).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('cancelling the same JOB visit twice at once', () => {
  it('INVARIANT: exactly one cancellation lands, and the loser gets the door\'s own 409', async () => {
    const [a, b] = await Promise.all([cancelVisit('Crew unavailable'), cancelVisit('Customer rescheduled')]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    // The SAME answer the sequential second call already gets from the pre-transaction check —
    // the guard relocates that refusal, it does not invent a new one.
    expect(loser.body.error).toBe('Visit is cancelled');

    const winningReason = a.status === 200 ? 'Crew unavailable' : 'Customer rescheduled';
    expect(storedVisit.cancelled_reason).toBe(winningReason);
    expect(eventsOfType('VISIT_CANCELLED')).toHaveLength(1);
  });

  it('CONTRACT: still cancels a COMPLETED trip — the guard refuses one status, not two', async () => {
    // The job door has never screened on live-ness: it reads the visit with no status filter and
    // refuses only an already-CANCELLED one, so cancelling a trip the crew already finished has
    // always been allowed. Closing the race must not quietly take that away, which is why this
    // door passes live + COMPLETED and not LIVE_VISIT_STATUSES.
    storedVisit = freshStoredVisit({ status: 'COMPLETED', completed_at: new Date('2026-09-05T15:20:00Z') });

    const res = await cancelVisit('Billed in error');

    expect(res.status).toBe(200);
    expect(storedVisit.status).toBe('CANCELLED');
    expect(storedVisit.cancelled_reason).toBe('Billed in error');
  });

  it('the accept-set is every status except CANCELLED', async () => {
    await cancelVisit('Crew unavailable');

    const where = mockPrisma.visit.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe(VISIT_ID);
    expect([...where.status.in].sort()).toEqual(
      ['COMPLETED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_SITE', 'SCHEDULED'],
    );
  });
});

describe('a lead leaving the pipeline while its visit is being completed', () => {
  it('auto-cancel loses the race SILENTLY — the lead still reaches CANCELLED', async () => {
    // The asymmetry that matters. Auto-cancel is a side effect of the LEAD's own transition, not
    // the thing the caller asked for, so a lost race must not fail the request: refusing to cancel
    // the lead because somebody completed its walkthrough a moment earlier would be strictly
    // worse than the race. What it must not do is rewind the completion, which is what the
    // unconditional write did.
    const completedAt = new Date('2026-09-05T15:20:00Z');
    storedVisit = freshStoredVisit({ status: 'COMPLETED', completed_at: completedAt });
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CANCELLED');
    expect(storedVisit.status).toBe('COMPLETED');
    expect(storedVisit.completed_at).toBe(completedAt);
    expect(storedVisit.cancelled_at).toBeNull();
  });

  it('auto-cancel still calls off a visit that is genuinely still live', async () => {
    mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'No longer needed' });

    expect(res.status).toBe(200);
    expect(storedVisit.status).toBe('CANCELLED');
    expect(storedVisit.cancelled_reason).toBe('Lead cancelled');
  });
});
