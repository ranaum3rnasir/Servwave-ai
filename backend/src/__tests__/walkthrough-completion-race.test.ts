/**
 * walkthrough-completion-race.test.ts — two requests completing the same visit at once.
 *
 * THE DEFECT. `completeWalkthrough` resolves its target with `findScheduledWalkthrough`, a read
 * that runs BEFORE the transaction opens. Two requests landing together therefore both hold the
 * same snapshot of the same live visit, and both go on to write it. The visit row was written
 * unconditionally (`update` by id), so the second write overwrote the first one's `completed_at`;
 * the lead's monotonic clock was written through `stampLeadClock`, whose `WHERE ... IS NULL`
 * settles first-touch-wins inside Postgres and so kept the FIRST instant.
 *
 * The two halves then disagreed, and that disagreement is the whole observable symptom: a lead
 * carrying a `walkthrough_first_completed_at` that matches none of its own visits. It is not a
 * regression from the stage-clock work — the row writer was byte-identical before it — but the
 * clocks are what made it visible, because before them nothing in the system held a second
 * opinion about when the visit finished.
 *
 * WHY THIS IS TESTABLE AGAINST A MOCKED CLIENT. The race does not depend on timing; it depends on
 * a STALE SNAPSHOT. `visit.findFirst` below always answers SCHEDULED — that is the pre-transaction
 * read, and it is what both racers hold no matter how the two requests interleave. The mocked
 * `visit.updateMany` plays the part of Postgres: it re-evaluates the WHERE against the row as
 * actually stored, which is exactly what a real writer does after blocking on the row lock. So a
 * writer that constrains the status is refused, and a writer that does not is not — which means
 * these assertions fail if the guard is ever dropped, rather than passing on a mock's goodwill.
 *
 * What a mocked client CANNOT prove is the lock itself: that Postgres really does serialise the
 * two updates. That is a property of READ COMMITTED, not of this code, and it is the reason the
 * guard belongs in the WHERE rather than in an `if` above the write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as Record<string, any>;

const VISIT_ID = 'v0000000-0000-0000-0000-000000000001';

/** The visit as the DATABASE holds it — the authority the guarded write is re-evaluated against. */
let storedVisit: { id: string; status: string; completed_at: Date | null };

/** The lead's clock columns as the DATABASE holds them. */
let storedLead: Record<string, Date | null>;

/**
 * The visit as each racer READ it, before either wrote. Deliberately a constant: the snapshot is
 * stale by construction, which is the precondition the whole defect needs and the one thing the
 * door cannot notice on its own.
 */
const SNAPSHOT_AS_READ = { id: VISIT_ID, status: 'SCHEDULED', assignees: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');

  storedVisit = { id: VISIT_ID, status: 'SCHEDULED', completed_at: null };
  storedLead = { walkthrough_first_completed_at: null, last_visit_completed_at: null };

  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.findFirst.mockResolvedValue(SNAPSHOT_AS_READ);
  mockPrisma.timelineEvent.create.mockResolvedValue({});

  // Postgres, not a blanket `{ count: 1 }`. A writer that names an accept-set for `status` is
  // refused when the STORED row has already left that set — the re-evaluation a real writer does
  // after the winner commits. A writer that names no accept-set has nothing to re-evaluate and
  // overwrites unconditionally, which is precisely the defect this file exists to prevent.
  mockPrisma.visit.updateMany.mockImplementation((args: any) => {
    const where = (args?.where ?? {}) as Record<string, any>;
    if (where.id !== storedVisit.id) return Promise.resolve({ count: 0 });
    const accepted: string[] | null = where.status?.in ?? null;
    if (accepted && !accepted.includes(storedVisit.status)) return Promise.resolve({ count: 0 });
    Object.assign(storedVisit, args?.data ?? {});
    return Promise.resolve({ count: 1 });
  });

  // The same emulation for the lead's monotonic clocks — a guarded write (one naming a clock
  // column as null in its WHERE) is refused once that column carries a value.
  mockPrisma.lead.updateMany.mockImplementation((args: any) => {
    const where = (args?.where ?? {}) as Record<string, unknown>;
    const data = (args?.data ?? {}) as Record<string, unknown>;
    const guarded = Object.keys(where).filter((k) => k in storedLead && where[k] === null);
    if (guarded.some((k) => storedLead[k] !== null)) return Promise.resolve({ count: 0 });
    for (const [k, v] of Object.entries(data)) if (k in storedLead) storedLead[k] = v as Date;
    return Promise.resolve({ count: 1 });
  });

  mockPrisma.lead.update.mockImplementation((args: any) => {
    for (const [k, v] of Object.entries((args?.data ?? {}) as Record<string, unknown>)) {
      if (k in storedLead) storedLead[k] = v as Date;
    }
    return Promise.resolve({ ...LEAD_FIXTURE, status: 'CONTACTED' });
  });
});

function complete() {
  return request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/complete`)
    .set(authHeader('admin'))
    .send({});
}

describe('completing the same walkthrough twice at once', () => {
  it('INVARIANT: exactly one completion lands, and the loser is refused', async () => {
    const [a, b] = await Promise.all([complete(), complete()]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    // The loser is told the same thing a caller who was merely too late is told — losing a race
    // is not a server fault, and the door must not leak that a race happened.
    const loser = a.status === 400 ? a : b;
    expect(loser.body.error).toContain('scheduled walkthrough');
  });

  it('INVARIANT: the visit keeps the WINNER\'s completed_at — it is never overwritten', async () => {
    await Promise.all([complete(), complete()]);

    expect(storedVisit.status).toBe('COMPLETED');
    expect(storedVisit.completed_at).toBeInstanceOf(Date);
    // Only one write reached the row. Two would be indistinguishable by value alone, so this
    // counts the writes that the guard ACCEPTED rather than the calls that were attempted.
    const accepted = mockPrisma.visit.updateMany.mock.results.filter(
      (r: any) => r.type === 'return',
    );
    expect(accepted.length).toBe(2);
    const counts = await Promise.all(accepted.map((r: any) => r.value));
    expect(counts.map((c: any) => c.count).sort()).toEqual([0, 1]);
  });

  it('INVARIANT: the lead clock and the visit row agree — the L00238 signature', async () => {
    // The symptom that surfaced this: a lead whose first-completion stamp matched neither of its
    // visits. The clock was always right (it is guarded); the visit row was the one that moved.
    await Promise.all([complete(), complete()]);

    expect(storedLead.walkthrough_first_completed_at).toBeInstanceOf(Date);
    expect(storedLead.walkthrough_first_completed_at).toEqual(storedVisit.completed_at);
    expect(storedLead.last_visit_completed_at).toEqual(storedVisit.completed_at);
  });

  it('the losing request writes nothing at all — no clock, no timeline entry, no automation', async () => {
    // The guarded write is the FIRST statement in the transaction, so the loser throws before it
    // can file anything. That ordering is load-bearing: it is what makes "nothing happened"
    // true without relying on the rollback, which a mocked client cannot perform.
    await Promise.all([complete(), complete()]);

    const completedEvents = mockPrisma.timelineEvent.create.mock.calls
      .map((c: any[]) => c[0]?.data)
      .filter((d: any) => d?.event_type === 'WALKTHROUGH_COMPLETED');
    expect(completedEvents).toHaveLength(1);
    expect(mockPrisma.lead.update).toHaveBeenCalledTimes(1);
    // A duplicate here would tell every automation the walkthrough finished twice.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('the transition is guarded on the SAME live set the door\'s own read accepts', async () => {
    // Narrowing this to SCHEDULED alone would silently shrink the endpoint: findActiveWalkthrough
    // hands over any live visit, so a guard that accepted less would start refusing completions
    // that succeed today. Asserted as a shape so a future edit cannot quietly change the set.
    await complete();

    const where = mockPrisma.visit.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe(VISIT_ID);
    expect(where.status.in).toEqual(
      expect.arrayContaining(['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS']),
    );
  });
});
