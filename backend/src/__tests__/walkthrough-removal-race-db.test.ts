/* =============================================================================
   Removing the last two walkthrough trips of one lead AT THE SAME TIME (fix pass,
   code review #1), against a real, migrated database: the race is Postgres's
   locking and snapshot behaviour, which no mock can reproduce.

   A lead with two booked trips, A and B. Two requests remove one trip each, both
   inside their own transaction. Each one's "is anything still booked?" count used
   to run on a snapshot that could not see the other's uncommitted removal, so both
   saw the other trip still booked, both skipped the fall-back, and the lead stayed
   Walkthrough Scheduled with nothing booked at all. The fall-back is now
   `syncLeadWalkthroughStatus`, the one rule that also handles completions (see
   lead-walkthrough-status.integration.test.ts for the completion race).

   The two transactions are made to overlap deterministically: both land their own
   visit write, meet at a barrier, run the fall-back, then hold the transaction open
   a little before committing. Whichever order Postgres serves them in, exactly one
   of them must return the lead to CONTACTED.

   Skips when TEST_DATABASE_URL is unset, the same idiom as the other *-db suites.
   Every org this suite creates is removed again in afterAll.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  unscheduleWalkthroughRow,
  cancelWalkthroughRow,
  LIVE_VISIT_STATUSES,
} from '../services/walkthrough.service';
import { syncLeadWalkthroughStatus } from '../services/lead-stage.service';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('removing two walkthrough trips of one lead concurrently (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  async function fixture(leadStatus: 'WALKTHROUGH_SCHEDULED' | 'ESTIMATED' = 'WALKTHROUGH_SCHEDULED') {
    const orgId = randomUUID();
    orgs.push(orgId);
    const tag = orgId.slice(0, 8);
    await prisma.organization.create({
      data: {
        id: orgId, name: `vtc-race-${tag}`, email: `race-${tag}@example.test`,
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
    const leadId = randomUUID();
    await prisma.lead.create({
      data: { id: leadId, organization_id: orgId, lead_number: 'L00001', customer_id: customerId, service_request: 'Door', status: leadStatus },
    });
    const [tripA, tripB] = [randomUUID(), randomUUID()];
    const day = (d: number) => new Date(Date.UTC(2031, 0, d, 15));
    await prisma.visit.createMany({
      data: [
        { id: tripA, organization_id: orgId, lead_id: leadId, purpose: 'WALKTHROUGH', visit_seq: 1, status: 'SCHEDULED', scheduled_at: day(10) },
        { id: tripB, organization_id: orgId, lead_id: leadId, purpose: 'WALKTHROUGH', visit_seq: 2, status: 'SCHEDULED', scheduled_at: day(12) },
      ],
    });
    return { orgId, adminId, leadId, tripA, tripB };
  }

  /** Resolves once `n` callers have arrived. */
  function barrier(n: number) {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => { release = r; });
    return async () => {
      arrived += 1;
      if (arrived === n) release();
      await all;
    };
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

  it('unschedule A and cancel B together: the lead returns to contacted exactly once', async () => {
    const f = await fixture();
    const bothWritten = barrier(2);
    const fallBack = (via: 'walkthrough_unscheduled' | 'walkthrough_cancelled') =>
      (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) =>
        syncLeadWalkthroughStatus(tx, { leadId: f.leadId, orgId: f.orgId, actorId: f.adminId, via });

    await Promise.all([
      prisma.$transaction(async (tx) => {
        expect(await unscheduleWalkthroughRow(tx, f.tripA)).toBe(true);
        await bothWritten();
        await fallBack('walkthrough_unscheduled')(tx);
        await hold(400);
      }, { timeout: 20_000 }),
      prisma.$transaction(async (tx) => {
        const { cancelled } = await cancelWalkthroughRow(tx, {
          walkthroughId: f.tripB, leadId: f.leadId, orgId: f.orgId, cancelledAt: new Date(),
          reason: 'Customer asked', cancelledBy: f.adminId, acceptStatuses: LIVE_VISIT_STATUSES,
        });
        expect(cancelled).not.toBeNull();
        await bothWritten();
        await fallBack('walkthrough_cancelled')(tx);
        await hold(400);
      }, { timeout: 20_000 }),
    ]);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId }, select: { status: true } });
    expect(lead.status).toBe('CONTACTED');
    const live = await prisma.visit.count({ where: { lead_id: f.leadId, status: { in: [...LIVE_VISIT_STATUSES] } } });
    expect(live).toBe(0);
    const ledger = await prisma.timelineEvent.findMany({
      where: { organization_id: f.orgId, entity_id: f.leadId, event_type: 'STATUS_CHANGE' },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ from: 'WALKTHROUGH_SCHEDULED', to: 'CONTACTED' });
  }, 30_000);

  it('removing one trip while the other stays booked leaves the lead where it was', async () => {
    const f = await fixture();

    await prisma.$transaction(async (tx) => {
      expect(await unscheduleWalkthroughRow(tx, f.tripA)).toBe(true);
      await syncLeadWalkthroughStatus(tx, {
        leadId: f.leadId, orgId: f.orgId, actorId: f.adminId, via: 'walkthrough_unscheduled',
      });
    });

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId }, select: { status: true } });
    expect(lead.status).toBe('WALKTHROUGH_SCHEDULED');
  });

  it('removing both trips of an Estimate Sent lead leaves it Estimate Sent', async () => {
    const f = await fixture('ESTIMATED');

    await prisma.$transaction(async (tx) => {
      expect(await unscheduleWalkthroughRow(tx, f.tripA)).toBe(true);
      expect(await unscheduleWalkthroughRow(tx, f.tripB)).toBe(true);
      await syncLeadWalkthroughStatus(tx, {
        leadId: f.leadId, orgId: f.orgId, actorId: f.adminId, via: 'walkthrough_unscheduled',
      });
    });

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId }, select: { status: true } });
    expect(lead.status).toBe('ESTIMATED');
  });
});
