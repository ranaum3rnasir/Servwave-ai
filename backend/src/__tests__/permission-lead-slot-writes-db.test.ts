/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.3 - lead Owner and walkthrough crew writes follow eligibility (M5).

   The lead Owner write (at create and at reassign) and the walkthrough performer write (schedule a
   walkthrough, set its performers, book an extra visit, move a visit) ask slot eligibility for every newly
   named person and refuse an ineligible or an inactive one in plain words. Only a newly named person is
   asked about: a performer already on the walkthrough passes when re-saved. Changing a lead's Owner follows
   Assign people to leads, and the lead's one assignee row stays the Owner's mirror.

   Every case uses people on custom roles whose base role and slot switch disagree (a Technician base with
   the switch on, a Dispatcher base with it off), so no role-name or base-role check can pass. Everything goes
   through the lead routes. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed again.
   ========================================================================== */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The suite-wide setup hands every record the same number; these cases create several leads in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = realClient ? describe : describe.skip;

const NOT_OWNER = "This person can't own leads or be Sold By.";
const NOT_CREW = "This person can't be on a crew.";
const INACTIVE = 'This person is inactive.';

suite('lead Owner and walkthrough crew writes follow slot eligibility (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean } = {},
  ): Promise<Person & { roleKey: string; api: () => Promise<Api> }> {
    const key = `lead-slot-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  /** The stored grants a built-in role has in a real company (a new test company has none until they are written). */
  async function seedBuiltInRole(org: string, role: 'SALES' | 'DISPATCHER') {
    for (const g of DEFAULT_GRANTS.filter((x) => x.role === role)) {
      await db.rolePermission.create({
        data: { organization_id: org, role, action: g.action, subject: g.subject, conditions: (g.conditions ?? undefined) as never },
      });
    }
    clearPermissionCache(org);
  }

  /** The owner of a lead as stored: the commission owner and the assignee rows that mirror it. */
  async function ownerOf(leadId: string) {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { commission_owner_id: true, lead_assignees: { select: { user_id: true } } } });
    return { owner: lead.commission_owner_id, assignees: lead.lead_assignees.map((a) => a.user_id) };
  }

  /** The crew of a lead's walkthrough visits, as stored. */
  async function performersOf(leadId: string) {
    const rows = await db.visitAssignee.findMany({ where: { visit: { lead_id: leadId } }, select: { user_id: true } });
    return rows.map((r) => r.user_id).sort();
  }

  describe('Owner', () => {
    it('refuses, at create and at reassign, a person who cannot own leads and one who is inactive, and takes one who can, whatever the role is based on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);

      // The hard pairs: a Technician base with the switch on, and a Dispatcher base with it off.
      const technicianWhoCan = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const dispatcherWhoCannot = await personWith(org, { can_own_leads: false }, 'DISPATCHER');
      const technicianWhoCannot = await personWith(org, { can_own_leads: false }, 'TECHNICIAN');
      const dispatcherWhoCan = await personWith(org, { can_own_leads: true }, 'DISPATCHER');
      const inactive = await personWith(org, { can_own_leads: true }, 'TECHNICIAN', { active: false });

      const createBody = (assigned_to: string) => ({ customer_id: customer, service_request: 'Fix the door', assigned_to });
      for (const cannot of [technicianWhoCannot, dispatcherWhoCannot]) {
        const refused = await api.post('/api/leads', createBody(cannot.id));
        expect(refused.status, 'create, switch off').toBe(400);
        expect(refused.body.error, 'create, switch off').toBe(NOT_OWNER);

        const lead = await fx.addLead(org, customer);
        const refusedReassign = await api.post(`/api/leads/${lead.id}/assign`, { assigned_to: cannot.id });
        expect(refusedReassign.status, 'reassign, switch off').toBe(400);
        expect(refusedReassign.body.error, 'reassign, switch off').toBe(NOT_OWNER);
        expect(await ownerOf(lead.id)).toEqual({ owner: null, assignees: [] });
      }

      const refusedInactive = await api.post('/api/leads', createBody(inactive.id));
      expect(refusedInactive.status, 'create, inactive').toBe(400);
      expect(refusedInactive.body.error, 'create, inactive').toBe(INACTIVE);
      const inactiveLead = await fx.addLead(org, customer);
      const refusedInactiveReassign = await api.post(`/api/leads/${inactiveLead.id}/assign`, { assigned_to: inactive.id });
      expect(refusedInactiveReassign.status, 'reassign, inactive').toBe(400);
      expect(refusedInactiveReassign.body.error, 'reassign, inactive').toBe(INACTIVE);

      for (const can of [technicianWhoCan, dispatcherWhoCan]) {
        const created = await api.post('/api/leads', createBody(can.id));
        expect(created.status, 'create, switch on').toBe(201);
        expect(await ownerOf(created.body.lead.id)).toEqual({ owner: can.id, assignees: [can.id] });

        const lead = await fx.addLead(org, customer);
        const reassigned = await api.post(`/api/leads/${lead.id}/assign`, { assigned_to: can.id });
        expect(reassigned.status, 'reassign, switch on').toBe(200);
        expect(await ownerOf(lead.id)).toEqual({ owner: can.id, assignees: [can.id] });
      }
    });

    it('still says a person who is not in the company is not found', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const other = await fx.newOrg();
      const outsider = await personWith(other.org, { can_own_leads: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer);
      const refused = await (await fx.signedInAs(admin)).post(`/api/leads/${lead.id}/assign`, { assigned_to: outsider.id });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('Target user not found');
    });

    it('is refused without Assign people to leads and let in with it, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { assign_people_to_leads: false }, base);
        const withIt = await personWith(org, { assign_people_to_leads: true }, base);
        const refusedLead = await fx.addLead(org, customer);
        expect((await (await without.api()).post(`/api/leads/${refusedLead.id}/assign`, { assigned_to: target.id })).status, base).toBe(403);
        expect(await ownerOf(refusedLead.id), base).toEqual({ owner: null, assignees: [] });
        const allowedLead = await fx.addLead(org, customer);
        expect((await (await withIt.api()).post(`/api/leads/${allowedLead.id}/assign`, { assigned_to: target.id })).status, base).toBe(200);
      }
    });

    it('refuses a user on the Sales preset, including on a lead they own', async () => {
      const { org, customer } = await fx.newOrg();
      await seedBuiltInRole(org, 'SALES');
      const seller = await fx.addUser(org, `seller${++sequence}`, 'SALES');
      const target = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer, { assignees: [seller.id], owner: seller.id });

      const refused = await (await fx.signedInAs(seller)).post(`/api/leads/${lead.id}/assign`, { assigned_to: target.id });
      expect(refused.status).toBe(403);
      expect(await ownerOf(lead.id)).toEqual({ owner: seller.id, assignees: [seller.id] });
    });

    it('leaves the single assignee row equal to the new Owner after a reassign', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const first = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const second = await personWith(org, { can_own_leads: true }, 'DISPATCHER');
      const lead = await fx.addLead(org, customer, { assignees: [first.id], owner: first.id });

      expect((await api.post(`/api/leads/${lead.id}/assign`, { assigned_to: second.id })).status).toBe(200);
      expect(await ownerOf(lead.id)).toEqual({ owner: second.id, assignees: [second.id] });
    });

    it('keeps a lead with its Owner after their switch is turned off or they are deactivated', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer, { assignees: [holder.id], owner: holder.id });

      await setRoleSwitchValues({ organizationId: org, roleKey: holder.roleKey, values: { can_own_leads: false }, actorId: null, reason: 'manual' });
      await db.user.update({ where: { id: holder.id }, data: { is_active: false } });

      const detail = await (await fx.signedInAs(admin)).get(`/api/leads/${lead.id}`);
      expect(detail.status).toBe(200);
      expect(await ownerOf(lead.id)).toEqual({ owner: holder.id, assignees: [holder.id] });
    });
  });

  describe('walkthrough crew', () => {
    /** Each door gets its own day, so one door's booking never collides with another's. */
    let dayOffset = 20;
    const nextStart = () => new Date(Date.now() + ++dayOffset * 86_400_000).toISOString();

    type LeadRef = { id: string; walkthroughId?: string };
    type CrewDoor = {
      name: string;
      /** The lead the door writes to, with a walkthrough crew it may replace. */
      prepare: (org: string, customer: string, existing: Person) => Promise<LeadRef>;
      run: (api: Api, lead: LeadRef, performers: Person[]) => Promise<{ status: number; error?: string }>;
    };
    const reply = (res: { status: number; body: { error?: string } }) => ({ status: res.status, error: res.body?.error });
    const withWalkthrough = (org: string, customer: string, existing: Person) => fx.addLead(org, customer, { walkthroughCrew: [existing.id] });
    const ids = (people: Person[]) => people.map((p) => p.id);

    const crewDoors: CrewDoor[] = [
      {
        name: 'schedule a walkthrough',
        prepare: withWalkthrough,
        run: async (api, lead, people) => reply(await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, {
          walkthrough_scheduled_at: nextStart(), performer_ids: ids(people), send_email: false,
        })),
      },
      {
        name: 'set the performers',
        prepare: withWalkthrough,
        run: async (api, lead, people) => reply(await api.post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: ids(people) })),
      },
      {
        name: 'set a visit\'s performers',
        prepare: withWalkthrough,
        run: async (api, lead, people) => reply(await api.post(`/api/leads/${lead.id}/visits/${lead.walkthroughId}/performers`, { performer_ids: ids(people) })),
      },
      {
        name: 'move a visit',
        prepare: withWalkthrough,
        run: async (api, lead, people) => reply(await api.patch(`/api/leads/${lead.id}/visits/${lead.walkthroughId}`, {
          walkthrough_scheduled_at: nextStart(), performer_ids: ids(people), send_email: false,
        })),
      },
      {
        name: 'book another visit',
        prepare: withWalkthrough,
        run: async (api, lead, people) => reply(await api.post(`/api/leads/${lead.id}/visits`, { scheduled_at: nextStart(), assignee_ids: ids(people) })),
      },
    ];

    it.each(crewDoors.map((d) => [d.name, d] as const))('%s refuses a person who cannot be on a crew and one who is inactive, and takes one who can, whatever the role is based on', async (_name, door) => {
      const { org, customer, admin } = await fx.newOrg();
      const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
      const api = await fx.signedInAs(admin);

      // The hard pairs: a Technician base with the switch on, and a Dispatcher base with it off.
      const technicianWhoCan = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const dispatcherWhoCannot = await personWith(org, { can_be_on_crew: false }, 'DISPATCHER');
      const inactive = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN', { active: false });

      const refusedOff = await door.run(api, await door.prepare(org, customer, existing), [dispatcherWhoCannot]);
      expect(refusedOff.status, 'switch off').toBe(400);
      expect(refusedOff.error, 'switch off').toBe(NOT_CREW);

      const refusedInactive = await door.run(api, await door.prepare(org, customer, existing), [inactive]);
      expect(refusedInactive.status, 'inactive').toBe(400);
      expect(refusedInactive.error, 'inactive').toBe(INACTIVE);

      const allowed = await door.run(api, await door.prepare(org, customer, existing), [technicianWhoCan]);
      expect(allowed.status, 'switch on').toBeLessThan(300);
    });

    it('writes nothing when the person is ineligible: the crew stays as it was', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
      const cannot = await personWith(org, { can_be_on_crew: false }, 'DISPATCHER');
      const lead = await fx.addLead(org, customer, { walkthroughCrew: [existing.id] });

      const refused = await (await fx.signedInAs(admin)).post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [cannot.id] });
      expect(refused.status).toBe(400);
      expect(await performersOf(lead.id)).toEqual([existing.id]);
    });

    it('accepts a performer already on the walkthrough when re-saved, and refuses a newly named ineligible one in the same request', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const member = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const colleague = await personWith(org, { can_be_on_crew: true }, 'DISPATCHER');
      const stranger = await personWith(org, { can_be_on_crew: false }, 'DISPATCHER');
      const lead = await fx.addLead(org, customer, { walkthroughCrew: [member.id] });

      // Their switch is turned off, then they are deactivated: the walkthrough still holds them.
      await setRoleSwitchValues({ organizationId: org, roleKey: member.roleKey, values: { can_be_on_crew: false }, actorId: null, reason: 'manual' });
      await db.user.update({ where: { id: member.id }, data: { is_active: false } });

      const restated = await api.post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [member.id, colleague.id] });
      expect(restated.status).toBe(200);
      expect(await performersOf(lead.id)).toEqual([member.id, colleague.id].sort());

      const mixed = await api.post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [member.id, colleague.id, stranger.id] });
      expect(mixed.status).toBe(400);
      expect(mixed.body.error).toBe(NOT_CREW);
      expect(await performersOf(lead.id)).toEqual([member.id, colleague.id].sort());
    });

    it('still says a performer who is not in the company is not found', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const other = await fx.newOrg();
      const outsider = await personWith(other.org, { can_be_on_crew: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer, { walkthroughCrew: [] });
      const refused = await (await fx.signedInAs(admin)).post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [outsider.id] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('Performer not found');
    });

    it('still refuses naming someone other than oneself without Assign work to other people', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
        const me = await personWith(org, { book_walkthroughs: true, assign_work_to_others: false, can_be_on_crew: true }, base);
        const lead = await fx.addLead(org, customer, { walkthroughCrew: [me.id] });
        const api = await me.api();
        expect((await api.post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [me.id, target.id] })).status, base).toBe(403);
        expect((await api.post(`/api/leads/${lead.id}/walkthrough/performers`, { performer_ids: [me.id] })).status, base).toBe(200);
      }
    });
  });

  describe('role-name lists', () => {
    it('are gone: the module that held them no longer exists', () => {
      expect(existsSync(join(__dirname, '../lib/permissions/assignableRoles.ts'))).toBe(false);
    });
  });
});
