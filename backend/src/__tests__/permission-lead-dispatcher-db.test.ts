/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.4 - a lead has a Dispatcher.

   A person with Assign people to leads sets, changes or clears a lead's Dispatcher on a lead they can
   open; every newly named person goes through slot eligibility (M5). The Owner can be cleared too. Each
   change is written to the lead's timeline (who, when, from, to or "cleared") and to the audit log, and
   the Dispatcher counts as being attached to the lead. Deleting the user empties the field.

   Every case uses people on custom roles whose base role and slot switch disagree (a Technician base with
   Can be a dispatcher on, a Dispatcher base with it off), so no role-name or base-role check can pass.
   Everything goes through the lead and user routes. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

const NOT_DISPATCHER = "This person can't be a dispatcher.";
const INACTIVE = 'This person is inactive.';

suite('a lead has a Dispatcher (real database)', () => {
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
  ): Promise<Person & { name: string; roleKey: string; api: () => Promise<Api> }> {
    const key = `lead-dispatcher-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const name = `p${sequence}`;
    const person = await fx.addUser(org, name, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { name: `${name} Tester`, roleKey: key, api: () => fx.signedInAs(person) });
  }

  const dispatcherOf = async (leadId: string) =>
    (await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { dispatcher_id: true } })).dispatcher_id;
  const ownerOf = async (leadId: string) => {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { commission_owner_id: true, lead_assignees: { select: { user_id: true } } } });
    return { owner: lead.commission_owner_id, assignees: lead.lead_assignees.map((a) => a.user_id) };
  };
  const leadNumberOf = async (leadId: string) => (await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { lead_number: true } })).lead_number;
  const setDispatcher = (api: Api, leadId: string, dispatcherId: string | null) => api.post(`/api/leads/${leadId}/dispatcher`, { dispatcher_id: dispatcherId });

  describe('setting, changing and clearing', () => {
    it('is done by a custom role with Assign people to leads, whatever it is based on, and returns the lead with its Dispatcher', async () => {
      const { org, customer } = await fx.newOrg();
      const first = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const second = await personWith(org, { can_be_dispatcher: true }, 'SALES');

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(org, { assign_people_to_leads: true }, base);
        const api = await holder.api();
        const lead = await fx.addLead(org, customer);

        const set = await setDispatcher(api, lead.id, first.id);
        expect(set.status, `${base}, set`).toBe(200);
        expect(set.body.lead.dispatcher, `${base}, set`).toMatchObject({ id: first.id });
        expect(await dispatcherOf(lead.id), `${base}, set`).toBe(first.id);

        const changed = await setDispatcher(api, lead.id, second.id);
        expect(changed.status, `${base}, change`).toBe(200);
        expect(await dispatcherOf(lead.id), `${base}, change`).toBe(second.id);

        const cleared = await setDispatcher(api, lead.id, null);
        expect(cleared.status, `${base}, clear`).toBe(200);
        expect(cleared.body.lead.dispatcher, `${base}, clear`).toBeNull();
        expect(await dispatcherOf(lead.id), `${base}, clear`).toBeNull();
      }
    });

    it('is refused without Assign people to leads, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { assign_people_to_leads: false }, base);
        const lead = await fx.addLead(org, customer);
        const refused = await setDispatcher(await without.api(), lead.id, target.id);
        expect(refused.status, base).toBe(403);
        expect(await dispatcherOf(lead.id), base).toBeNull();
      }
    });

    it('is refused on a lead the person cannot open', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const holder = await personWith(org, { assign_people_to_leads: true, leads_scope: 'attached' }, 'SALES');
      const lead = await fx.addLead(org, customer);

      const refused = await setDispatcher(await holder.api(), lead.id, target.id);
      expect(refused.status).toBe(403);
      expect(await dispatcherOf(lead.id)).toBeNull();
    });

    it('refuses a newly named person who cannot be a dispatcher or who is inactive, in plain words, and takes one who can', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);

      // The hard pairs: a Technician base with the switch on, and a Dispatcher base with it off.
      const technicianWhoCan = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const dispatcherWhoCannot = await personWith(org, { can_be_dispatcher: false }, 'DISPATCHER');
      const technicianWhoCannot = await personWith(org, { can_be_dispatcher: false }, 'TECHNICIAN');
      const dispatcherWhoCan = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
      const inactive = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN', { active: false });

      for (const cannot of [technicianWhoCannot, dispatcherWhoCannot]) {
        const lead = await fx.addLead(org, customer);
        const refused = await setDispatcher(api, lead.id, cannot.id);
        expect(refused.status).toBe(400);
        expect(refused.body.error).toBe(NOT_DISPATCHER);
        expect(await dispatcherOf(lead.id)).toBeNull();
      }

      const inactiveLead = await fx.addLead(org, customer);
      const refusedInactive = await setDispatcher(api, inactiveLead.id, inactive.id);
      expect(refusedInactive.status).toBe(400);
      expect(refusedInactive.body.error).toBe(INACTIVE);
      expect(await dispatcherOf(inactiveLead.id)).toBeNull();

      for (const can of [technicianWhoCan, dispatcherWhoCan]) {
        const lead = await fx.addLead(org, customer);
        expect((await setDispatcher(api, lead.id, can.id)).status).toBe(200);
        expect(await dispatcherOf(lead.id)).toBe(can.id);
      }
    });

    it('says a person who is not in the company is not found', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const other = await fx.newOrg();
      const outsider = await personWith(other.org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer);
      const refused = await setDispatcher(await fx.signedInAs(admin), lead.id, outsider.id);
      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe('User not found');
    });

    it('keeps the Dispatcher a lead already has when their switch is turned off, and lets the same person be named again', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const holder = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer, { dispatcher: holder.id });
      await setRoleSwitchValues({ organizationId: org, roleKey: holder.roleKey, values: { can_be_dispatcher: false }, actorId: null, reason: 'manual' });

      expect(await dispatcherOf(lead.id)).toBe(holder.id);
      expect((await setDispatcher(api, lead.id, holder.id)).status).toBe(200);
      expect(await dispatcherOf(lead.id)).toBe(holder.id);
    });
  });

  describe('clearing the Owner', () => {
    it('leaves the lead with no Owner and no assignee row, and the page contract reads no Owner', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_leads: true, can_own_leads: true }, 'TECHNICIAN');
      const api = await holder.api();
      const lead = await fx.addLead(org, customer, { owner: holder.id, assignees: [holder.id] });

      const cleared = await api.post(`/api/leads/${lead.id}/assign`, { assigned_to: null });
      expect(cleared.status).toBe(200);
      expect(await ownerOf(lead.id)).toEqual({ owner: null, assignees: [] });
      const detail = await api.get(`/api/leads/${lead.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.lead.commission_owner).toBeNull();
    });
  });

  describe('the lead page contract', () => {
    it('gives an existing lead no Dispatcher, and names the Dispatcher once one is set', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const person = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer);

      const before = await api.get(`/api/leads/${lead.id}`);
      expect(before.status).toBe(200);
      expect(before.body.lead.dispatcher).toBeNull();

      await setDispatcher(api, lead.id, person.id);
      const after = await api.get(`/api/leads/${lead.id}`);
      expect(after.body.lead.dispatcher).toMatchObject({ id: person.id, first_name: person.name.split(' ')[0], last_name: 'Tester' });
    });

    it('counts no lead as missing anything because it has no Dispatcher', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const crew = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const crewed = await fx.addLead(org, customer, { walkthroughCrew: [crew.id] });
      const { findMissingCrew, countMissingCrew } = await import('../lib/missingCrew.js');
      const viewer = await db.user.findUniqueOrThrow({
        where: { id: admin.id },
        select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
      });

      expect(await dispatcherOf(crewed.id)).toBeNull();
      expect((await findMissingCrew(viewer as never)).filter((v) => v.lead_id === crewed.id)).toEqual([]);
      expect(await countMissingCrew(viewer as never)).toBe(0);
    });
  });

  describe('history', () => {
    const timelineOf = async (api: Api, leadId: string) => {
      const res = await api.get(`/api/leads/${leadId}/timeline`);
      expect(res.status).toBe(200);
      return res.body.events as { event_type: string; description: string; metadata: unknown; created_at: string; creator: { id: string } | null }[];
    };
    const dispatcherEvents = async (api: Api, leadId: string) =>
      (await timelineOf(api, leadId)).filter((e) => e.event_type === 'DISPATCHER_CHANGED').reverse();

    it('writes who, when, from and to for each change, and "cleared" for a clear, and nothing for naming the same person', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const first = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const second = await personWith(org, { can_be_dispatcher: true }, 'SALES');
      const lead = await fx.addLead(org, customer);
      const number = await leadNumberOf(lead.id);

      await setDispatcher(api, lead.id, first.id);
      await setDispatcher(api, lead.id, first.id);
      await setDispatcher(api, lead.id, second.id);
      await setDispatcher(api, lead.id, null);

      const events = await dispatcherEvents(api, lead.id);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.metadata)).toEqual([
        { from_user_id: null, to_user_id: first.id },
        { from_user_id: first.id, to_user_id: second.id },
        { from_user_id: second.id, to_user_id: null },
      ]);
      expect(events[0]!.description).toBe(`${first.name} set as Dispatcher on ${number}`);
      expect(events[1]!.description).toBe(`Dispatcher changed from ${first.name} to ${second.name} on ${number}`);
      expect(events[2]!.description).toBe(`Dispatcher cleared on ${number} (was ${second.name})`);
      for (const e of events) {
        expect(e.creator?.id).toBe(admin.id);
        expect(Number.isNaN(Date.parse(e.created_at))).toBe(false);
      }
    });

    it('writes an audit entry for each change, naming the lead, the actor and the people', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const person = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer);

      await setDispatcher(api, lead.id, person.id);
      await setDispatcher(api, lead.id, null);

      await vi.waitFor(async () => {
        const rows = await db.auditLog.findMany({ where: { org_id: org, action: 'lead.dispatcher_set', resource_id: lead.id }, orderBy: { created_at: 'asc' } });
        expect(rows.map((r) => r.metadata)).toEqual([
          { dispatcher_id: person.id, previous_dispatcher_id: null },
          { dispatcher_id: null, previous_dispatcher_id: person.id },
        ]);
        expect(rows.every((r) => r.actor_id === admin.id && r.resource_type === 'Lead')).toBe(true);
      });
    });

    it('words an Owner change as "Owner", never "sold-by"', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const owner = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const lead = await fx.addLead(org, customer);
      const number = await leadNumberOf(lead.id);

      expect((await api.post(`/api/leads/${lead.id}/assign`, { assigned_to: owner.id })).status).toBe(200);
      expect((await api.post(`/api/leads/${lead.id}/assign`, { assigned_to: null })).status).toBe(200);

      const events = (await timelineOf(api, lead.id)).filter((e) => e.event_type === 'OWNER_CHANGED').reverse();
      expect(events.map((e) => e.description)).toEqual([`${owner.name} set as Owner on ${number}`, `Owner cleared on ${number}`]);
    });
  });

  describe('deleting the Dispatcher', () => {
    it('succeeds for a deactivated user who is a lead\'s Dispatcher, and empties the field', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const gone = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN', { active: false });
      const lead = await fx.addLead(org, customer, { dispatcher: gone.id });

      const deleted = await api.delete(`/api/users/${gone.id}/permanent`);
      expect(deleted.status).toBe(200);
      expect(await db.user.count({ where: { id: gone.id } })).toBe(0);
      expect(await dispatcherOf(lead.id)).toBeNull();
      expect(await db.lead.count({ where: { id: lead.id } })).toBe(1);
    });
  });
});
