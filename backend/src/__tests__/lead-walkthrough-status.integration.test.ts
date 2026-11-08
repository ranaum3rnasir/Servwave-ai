/**
 * The lead's walkthrough-driven status against a REAL Postgres (walkthrough lead-statuses PRD 6.1
 * and 12.2 item 17).
 *
 * What a mock cannot show, and so lives here:
 *   - the race. Two requests finishing the last two open visits of one lead at the same moment
 *     each hold their own uncommitted visit write, so each one's count on its own snapshot still
 *     sees the other visit open. Only the lead row lock in `syncLeadWalkthroughStatus` makes the
 *     second wait, re-count on a fresh snapshot, and see both done. Exactly one Completed move.
 *   - the lock ORDER (visit first, then lead) against the lead-exit writer, which does the same:
 *     run together, repeatedly, they must never deadlock.
 *   - the two counts themselves against the real schema (an open visit with no time still counts;
 *     another lead's and another organisation's visits never do).
 *
 * Skipped by default, and refuses to run against anything but a local database. To run, point
 * DATABASE_URL at a throwaway local database that has all the migrations applied:
 *   RUN_INTEGRATION_TESTS=1 DATABASE_URL=postgresql://<user>@localhost:5433/<db> \
 *     npx vitest run src/__tests__/lead-walkthrough-status.integration.test.ts
 *
 * Every organisation this suite creates is removed again in afterAll.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient, type LeadStatus, type VisitStatus } from '@prisma/client';
import {
  completeWalkthroughRow,
  unscheduleWalkthroughRow,
  cancelWalkthroughRow,
  cancelLiveWalkthroughsOnLeadExit,
  LIVE_VISIT_STATUSES,
} from '../services/walkthrough.service';
import {
  syncLeadWalkthroughStatus,
  transitionLeadStatus,
  walkthroughDrivenStatus,
} from '../services/lead-stage.service';

const url = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && isLocal;
const suite = enabled ? describe : describe.skip;

suite('lead walkthrough status (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const orgs: string[] = [];

  async function org() {
    const orgId = randomUUID();
    orgs.push(orgId);
    const tag = orgId.slice(0, 8);
    await prisma.organization.create({
      data: {
        id: orgId, name: `lws-${tag}`, email: `lws-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const adminId = randomUUID();
    await prisma.user.create({
      data: { id: adminId, email: `admin-${tag}@example.test`, first_name: 'Ada', last_name: 'Admin', role: 'ADMIN', organization_id: orgId },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, organization_id: orgId, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Test', last_name: 'Customer' },
    });
    return { orgId, adminId, customerId };
  }

  let leadCounter = 0;
  async function lead(
    o: { orgId: string; customerId: string },
    status: LeadStatus,
    visitStatuses: Array<VisitStatus | { status: VisitStatus; scheduled_at: Date | null }>,
  ) {
    const leadId = randomUUID();
    leadCounter += 1;
    await prisma.lead.create({
      data: { id: leadId, organization_id: o.orgId, lead_number: `L${String(leadCounter).padStart(5, '0')}`, customer_id: o.customerId, service_request: 'Door', status },
    });
    const visitIds: string[] = [];
    for (const [i, v] of visitStatuses.entries()) {
      const spec = typeof v === 'string' ? { status: v, scheduled_at: new Date(Date.UTC(2031, 0, 10 + i, 15)) } : v;
      const id = randomUUID();
      visitIds.push(id);
      await prisma.visit.create({
        data: {
          id, organization_id: o.orgId, lead_id: leadId, purpose: 'WALKTHROUGH', visit_seq: i + 1,
          status: spec.status, scheduled_at: spec.scheduled_at,
          ...(spec.status === 'COMPLETED' ? { completed_at: new Date(Date.UTC(2031, 0, 1)) } : {}),
        },
      });
    }
    return { leadId, visitIds };
  }

  const statusOf = async (leadId: string) =>
    (await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true } })).status;
  const moves = (orgId: string, leadId: string) =>
    prisma.timelineEvent.findMany({ where: { organization_id: orgId, entity_id: leadId, event_type: 'STATUS_CHANGE' }, orderBy: { created_at: 'asc' } });

  /** Resolves once `n` callers have arrived. */
  function barrier(n: number) {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => { release = r; });
    return async () => { arrived += 1; if (arrived === n) release(); await all; };
  }
  const hold = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const organization_id of orgs) {
      await quietly(prisma.timelineEvent.deleteMany({ where: { organization_id } }));
      await quietly(prisma.visit.deleteMany({ where: { organization_id } }));
      await quietly(prisma.lead.deleteMany({ where: { organization_id } }));
      await quietly(prisma.customer.deleteMany({ where: { organization_id } }));
      await quietly(prisma.user.deleteMany({ where: { organization_id } }));
      await quietly(prisma.organization.deleteMany({ where: { id: organization_id } }));
    }
    await prisma.$disconnect();
  });

  it('two parallel completions of the last two open visits end at Walkthrough Completed with exactly one Completed move', async () => {
    const o = await org();
    const l = await lead(o, 'WALKTHROUGH_SCHEDULED', ['SCHEDULED', 'SCHEDULED']);
    const bothWritten = barrier(2);

    const complete = (visitId: string) =>
      prisma.$transaction(async (tx) => {
        expect(await completeWalkthroughRow(tx, visitId, new Date())).toBe(true);
        // Both visit writes are landed (uncommitted) before either counts: the exact window in
        // which an unlocked count sees the other visit still open.
        await bothWritten();
        await syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_completed' });
        // Hold the transaction open so the second one genuinely has to wait on the lead lock.
        await hold(400);
      }, { timeout: 20_000 });

    await Promise.all([complete(l.visitIds[0]), complete(l.visitIds[1])]);

    expect(await statusOf(l.leadId)).toBe('WALKTHROUGH_COMPLETED');
    const history = await moves(o.orgId, l.leadId);
    expect(history).toHaveLength(1);
    expect(history[0].metadata).toMatchObject({ from: 'WALKTHROUGH_SCHEDULED', to: 'WALKTHROUGH_COMPLETED', via: 'walkthrough_completed' });
    expect(history[0].description).toBe('Lead moved to Walkthrough Completed: the walkthrough is done');
  }, 30_000);

  it('unscheduling one trip and cancelling the other together send the lead to Contacted exactly once', async () => {
    const o = await org();
    const l = await lead(o, 'WALKTHROUGH_SCHEDULED', ['SCHEDULED', 'SCHEDULED']);
    const bothWritten = barrier(2);
    const sync = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], via: 'walkthrough_unscheduled' | 'walkthrough_cancelled') =>
      syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via });

    await Promise.all([
      prisma.$transaction(async (tx) => {
        expect(await unscheduleWalkthroughRow(tx, l.visitIds[0])).toBe(true);
        await bothWritten();
        await sync(tx, 'walkthrough_unscheduled');
        await hold(400);
      }, { timeout: 20_000 }),
      prisma.$transaction(async (tx) => {
        const { cancelled } = await cancelWalkthroughRow(tx, {
          walkthroughId: l.visitIds[1], leadId: l.leadId, orgId: o.orgId, cancelledAt: new Date(),
          reason: 'Customer asked', cancelledBy: o.adminId, acceptStatuses: LIVE_VISIT_STATUSES,
        });
        expect(cancelled).not.toBeNull();
        await bothWritten();
        await sync(tx, 'walkthrough_cancelled');
        await hold(400);
      }, { timeout: 20_000 }),
    ]);

    expect(await statusOf(l.leadId)).toBe('CONTACTED');
    const history = await moves(o.orgId, l.leadId);
    expect(history).toHaveLength(1);
    expect(history[0].metadata).toMatchObject({ from: 'WALKTHROUGH_SCHEDULED', to: 'CONTACTED' });
  }, 30_000);

  it('removing the last two trips of an Estimate Sent lead moves nothing', async () => {
    const o = await org();
    const l = await lead(o, 'ESTIMATED', ['SCHEDULED', 'SCHEDULED']);
    await prisma.$transaction(async (tx) => {
      await unscheduleWalkthroughRow(tx, l.visitIds[0]);
      await unscheduleWalkthroughRow(tx, l.visitIds[1]);
      await syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_unscheduled' });
    });

    expect(await statusOf(l.leadId)).toBe('ESTIMATED');
    expect(await moves(o.orgId, l.leadId)).toHaveLength(0);
  });

  it('a lead that goes to Won while a completion is in flight stays Won: the status is re-read under the lock', async () => {
    const o = await org();
    const l = await lead(o, 'WALKTHROUGH_SCHEDULED', ['SCHEDULED']);
    let visitWritten!: () => void;
    const visitWrittenP = new Promise<void>((r) => { visitWritten = r; });
    let wonCommitted!: () => void;
    const wonCommittedP = new Promise<void>((r) => { wonCommitted = r; });

    await Promise.all([
      prisma.$transaction(async (tx) => {
        // The completion's visit write lands, then the lead is won and committed by someone else
        // before this request gets as far as syncing the status.
        expect(await completeWalkthroughRow(tx, l.visitIds[0], new Date())).toBe(true);
        visitWritten();
        await wonCommittedP;
        await syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_completed' });
      }, { timeout: 20_000 }),
      (async () => {
        await visitWrittenP;
        await prisma.$transaction((tx) =>
          transitionLeadStatus(tx, {
            leadId: l.leadId, orgId: o.orgId, to: 'WON', from: 'WALKTHROUGH_SCHEDULED', actorId: o.adminId,
            description: 'Lead status changed to Won',
          }));
        wonCommitted();
      })(),
    ]);

    expect(await statusOf(l.leadId)).toBe('WON');
    expect((await moves(o.orgId, l.leadId)).map((m) => (m.metadata as { to: string }).to)).toEqual(['WON']);
  }, 30_000);

  it('the visit rule and the lead-exit writer, run together, never deadlock (visit first, then lead)', async () => {
    for (let round = 0; round < 6; round += 1) {
      const o = await org();
      const l = await lead(o, 'WALKTHROUGH_SCHEDULED', ['SCHEDULED', 'SCHEDULED']);

      const results = await Promise.allSettled([
        prisma.$transaction(async (tx) => {
          await completeWalkthroughRow(tx, l.visitIds[0], new Date());
          await syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_completed' });
        }, { timeout: 20_000 }),
        prisma.$transaction(async (tx) => {
          await cancelLiveWalkthroughsOnLeadExit(tx, { leadId: l.leadId, orgId: o.orgId, cancelledAt: new Date(), reason: 'Lead marked as lost', cancelledBy: o.adminId });
          await transitionLeadStatus(tx, {
            leadId: l.leadId, orgId: o.orgId, to: 'LOST', from: 'WALKTHROUGH_SCHEDULED', actorId: o.adminId,
            description: 'Lead marked as lost', notFrom: [],
          });
        }, { timeout: 20_000 }),
      ]);

      for (const r of results) {
        if (r.status === 'rejected') throw r.reason; // a deadlock (40P01) would surface here
      }
      // Won/Lost/Cancelled are never moved by a visit, so once the exit lands the lead is Lost.
      expect(await statusOf(l.leadId)).toBe('LOST');
    }
  }, 60_000);

  describe('the two counts, against the real schema', () => {
    const table: Array<[string, LeadStatus, VisitStatus[]]> = [
      ['no visits at all, New', 'NEW', []],
      ['one open, Contacted', 'CONTACTED', ['SCHEDULED']],
      ['an en-route visit counts as open', 'CONTACTED', ['EN_ROUTE']],
      ['an in-progress visit counts as open', 'WALKTHROUGH_COMPLETED', ['IN_PROGRESS']],
      ['finished only, Walkthrough Scheduled', 'WALKTHROUGH_SCHEDULED', ['COMPLETED']],
      ['finished plus open, Walkthrough Completed', 'WALKTHROUGH_COMPLETED', ['COMPLETED', 'SCHEDULED']],
      ['only cancelled, Walkthrough Scheduled', 'WALKTHROUGH_SCHEDULED', ['CANCELLED']],
      ['cancelled plus finished, Walkthrough Scheduled', 'WALKTHROUGH_SCHEDULED', ['CANCELLED', 'COMPLETED']],
      ['open visits, Estimate Sent', 'ESTIMATED', ['SCHEDULED']],
      ['open visits, Won', 'WON', ['SCHEDULED']],
    ];
    for (const [name, status, visitStatuses] of table) {
      it(name, async () => {
        const o = await org();
        const l = await lead(o, status, visitStatuses);
        const open = visitStatuses.filter((v) => (LIVE_VISIT_STATUSES as readonly string[]).includes(v)).length;
        const finished = visitStatuses.filter((v) => v === 'COMPLETED').length;

        await prisma.$transaction((tx) =>
          syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_cancelled' }));

        expect(await statusOf(l.leadId)).toBe(walkthroughDrivenStatus(status, open, finished));
      });
    }

    it('a visit with no time set but a live status still counts as open', async () => {
      const o = await org();
      const l = await lead(o, 'CONTACTED', [{ status: 'SCHEDULED', scheduled_at: null }]);
      await prisma.$transaction((tx) =>
        syncLeadWalkthroughStatus(tx, { leadId: l.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_scheduled' }));

      expect(await statusOf(l.leadId)).toBe('WALKTHROUGH_SCHEDULED');
    });

    it("another lead's visits, and another organisation's, are never counted", async () => {
      const o = await org();
      const other = await org();
      const mine = await lead(o, 'WALKTHROUGH_SCHEDULED', ['CANCELLED']);
      await lead(o, 'WALKTHROUGH_SCHEDULED', ['SCHEDULED', 'COMPLETED']);
      await lead(other, 'WALKTHROUGH_SCHEDULED', ['SCHEDULED', 'COMPLETED']);

      await prisma.$transaction((tx) =>
        syncLeadWalkthroughStatus(tx, { leadId: mine.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_cancelled' }));

      expect(await statusOf(mine.leadId)).toBe('CONTACTED');
    });

    it('a lead id from another organisation is a no-op, not a move', async () => {
      const o = await org();
      const other = await org();
      const theirs = await lead(other, 'WALKTHROUGH_SCHEDULED', ['CANCELLED']);

      await prisma.$transaction((tx) =>
        syncLeadWalkthroughStatus(tx, { leadId: theirs.leadId, orgId: o.orgId, actorId: o.adminId, via: 'walkthrough_cancelled' }));

      expect(await statusOf(theirs.leadId)).toBe('WALKTHROUGH_SCHEDULED');
    });
  });
});
