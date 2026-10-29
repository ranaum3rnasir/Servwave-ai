/* =============================================================================
   A technician's lead row scope AND the scheduler's walkthrough window, together, against
   a real, migrated database (fix pass, code review #16; visits slice 03).

   buildLeadListWhere composes two separate questions under AND: the technician's read scope
   (OWN_WALKTHROUGH - "is this tech on ANY trip of the lead?") and the board's window ("is ANY
   live trip of the lead in view?"). Merged into one `visits.some` they would mean "is the
   tech's OWN trip in view", and assigned over the scope they would drop it (an RBAC bypass).
   Both are nested relation filters that only Postgres evaluates honestly, so the composed
   `where` is built by the real code and run against real rows:
     - the tech whose own trip is outside the window, with a sibling trip inside it, gets the lead;
     - a tech on no trip of the lead never does, window or not;
     - a sibling trip inside the window that was CANCELLED does not bring the lead into view.

   The role's grants are the TECHNICIAN defaults, handed to the permission cache (the same
   cache attachAbility fills); the app's own client stays the suite-wide mock and is only asked
   for per-user overrides (none). Skips when TEST_DATABASE_URL is unset, like the other *-db
   suites, and removes every org it creates.
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { prisma as appClient } from '../lib/prisma';
import { buildLeadListWhere } from '../controllers/lead.controller';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('technician lead scope + walkthrough window (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  const DAY = 24 * 3_600_000;
  const WEEK_START = new Date(Date.UTC(2031, 2, 3));         // the board's week
  const WEEK_END = new Date(WEEK_START.getTime() + 7 * DAY);
  const inWeek = new Date(WEEK_START.getTime() + 2 * DAY + 15 * 3_600_000);
  const nextMonth = new Date(WEEK_START.getTime() + 30 * DAY);

  async function fixture() {
    const orgId = randomUUID();
    orgs.push(orgId);
    const tag = orgId.slice(0, 8);
    await db.organization.create({
      data: {
        id: orgId, name: `vtc-scope-${tag}`, email: `scope-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const [ownTripTech, siblingTech, strangerTech] = [randomUUID(), randomUUID(), randomUUID()];
    await db.user.createMany({
      data: [ownTripTech, siblingTech, strangerTech].map((id, i) => ({
        id, organization_id: orgId, email: `tech${i}-${tag}@example.test`, first_name: 'Tech', last_name: String(i), role: 'TECHNICIAN' as const,
      })),
    });
    const customerId = randomUUID();
    await db.customer.create({
      data: { id: customerId, organization_id: orgId, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Test', last_name: 'Customer' },
    });
    const lead = async (n: number, trips: Array<{ at: Date; status: 'SCHEDULED' | 'CANCELLED'; crew: string }>) => {
      const id = randomUUID();
      await db.lead.create({ data: { id, organization_id: orgId, lead_number: `L0000${n}`, customer_id: customerId, service_request: 'Door' } });
      for (const [i, t] of trips.entries()) {
        const visitId = randomUUID();
        await db.visit.create({
          data: { id: visitId, organization_id: orgId, lead_id: id, purpose: 'WALKTHROUGH', visit_seq: i + 1, status: t.status, scheduled_at: t.at },
        });
        await db.visitAssignee.create({ data: { visit_id: visitId, user_id: t.crew, organization_id: orgId } });
      }
      return id;
    };
    // The tech's own trip is next month; a colleague's trip on the same lead is this week.
    const splitLead = await lead(1, [
      { at: nextMonth, status: 'SCHEDULED', crew: ownTripTech },
      { at: inWeek, status: 'SCHEDULED', crew: siblingTech },
    ]);
    // Same shape, but the colleague's in-week trip was called off.
    const cancelledSiblingLead = await lead(2, [
      { at: nextMonth, status: 'SCHEDULED', crew: ownTripTech },
      { at: inWeek, status: 'CANCELLED', crew: siblingTech },
    ]);
    return { orgId, ownTripTech, strangerTech, splitLead, cancelledSiblingLead };
  }

  /** The board's windowed lead list, as `userId` (a TECHNICIAN) asks for it. */
  async function boardLeads(orgId: string, userId: string, window = true): Promise<string[]> {
    const req = {
      user: { id: userId, role: 'TECHNICIAN', organization_id: orgId },
      query: window ? { walkthrough_after: WEEK_START.toISOString(), walkthrough_before: WEEK_END.toISOString() } : {},
    } as unknown as Request;
    const { where } = await buildLeadListWhere(req);
    const rows = await db.lead.findMany({ where: where as never, select: { id: true } });
    return rows.map((r) => r.id);
  }

  beforeEach(() => {
    clearPermissionCache();
    (appClient.userPermissionOverride.findMany as Mock).mockResolvedValue([]);
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const organization_id of orgs) {
      await quietly(db.visitAssignee.deleteMany({ where: { organization_id } }));
      await quietly(db.visit.deleteMany({ where: { organization_id } }));
      await quietly(db.lead.deleteMany({ where: { organization_id } }));
      await quietly(db.customer.deleteMany({ where: { organization_id } }));
      await quietly(db.user.deleteMany({ where: { organization_id } }));
      await quietly(db.organization.deleteMany({ where: { id: organization_id } }));
    }
    await db.$disconnect();
  });

  function grantTechnicianDefaults(orgId: string) {
    setCachedGrants(
      orgId,
      'TECHNICIAN',
      DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN').map((g) => ({
        action: g.action, subject: g.subject, conditions: (g as { conditions?: Record<string, unknown> }).conditions ?? null,
      })),
    );
  }

  it("returns the lead to a tech whose own trip is outside the window when a sibling trip is inside it", async () => {
    const f = await fixture();
    grantTechnicianDefaults(f.orgId);

    expect(await boardLeads(f.orgId, f.ownTripTech)).toEqual([f.splitLead]);
  });

  it('never returns it to a tech on no trip of the lead, with or without the window', async () => {
    const f = await fixture();
    grantTechnicianDefaults(f.orgId);

    expect(await boardLeads(f.orgId, f.strangerTech)).toEqual([]);
    expect(await boardLeads(f.orgId, f.strangerTech, false)).toEqual([]);
    // Control: the same tech-scoped list without the window does see both of the tech's own leads.
    expect((await boardLeads(f.orgId, f.ownTripTech, false)).sort()).toEqual([f.splitLead, f.cancelledSiblingLead].sort());
  });
});
