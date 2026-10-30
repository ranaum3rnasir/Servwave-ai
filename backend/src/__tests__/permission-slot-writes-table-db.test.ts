/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.21 - the route-level enforcement table for every slot write.

   One row for each way a person is placed in a people slot on a job or a lead: the job Dispatcher, the job
   Sold By, the lead Owner on create and on reassign, the lead Dispatcher, the job crew, the walkthrough crew
   and the crew named when a service plan visit is scheduled. Every row is run the same three ways:

     - the custom-role pair: a person whose base role says no but whose slot switch is on is taken, a person
       whose base role says yes but whose slot switch is off is refused in plain words, and so is an inactive
       person; a refused write leaves the slot as it was;
     - the Sales preset: a person on the built-in Sales role, on a record they are attached to, is refused
       (a lead created by a Sales user keeps them as Owner whoever the request names);
     - a person holding neither Assign people to jobs nor Assign people to leads can change none of the
       slots those two switches govern once the record exists.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) except
   the Sales rows, which are the built-in preset itself. Real migrated database (TEST_DATABASE_URL); the suite
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

// The suite-wide setup hands every record the same number; these cases create several records in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = realClient ? describe : describe.skip;

const NOT_OWNER = "This person can't own leads or be Sold By.";
const NOT_DISPATCHER = "This person can't be a dispatcher.";
const NOT_CREW = "This person can't be on a crew.";
const INACTIVE = 'This person is inactive.';

type Eligibility = 'can_own_leads' | 'can_be_dispatcher' | 'can_be_on_crew';
type Assigner = 'assign_people_to_jobs' | 'assign_people_to_leads';

suite('every PRD 3 slot write is enforced at the route (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const planOrgs: string[] = [];
  afterAll(async () => {
    // Service plans are not part of the shared fixture's cleanup, and they pin their customer.
    for (const org of planOrgs) {
      await db.job.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
      await db.servicePlan.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `slot-table-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The stored grants the built-in Sales role has in a real company (a new test company has none until written). */
  async function seedSalesRole(org: string) {
    for (const g of DEFAULT_GRANTS.filter((x) => x.role === 'SALES')) {
      await db.rolePermission.create({
        data: { organization_id: org, role: 'SALES', action: g.action, subject: g.subject, conditions: (g.conditions ?? undefined) as never },
      });
    }
    clearPermissionCache(org);
  }

  /** Each write gets its own day, so one booking never collides with another's. */
  let dayOffset = 20;
  const nextStart = () => new Date(Date.now() + ++dayOffset * 86_400_000);
  const nextWindow = () => {
    const start = nextStart();
    return { scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 3_600_000).toISOString() };
  };

  interface Ctx {
    org: string;
    customer: string;
    /** Already in the slot where the slot holds a crew, so a write has something to replace. */
    existing: Person;
    /** A person the record is attached to (a Sales user working their own lead or job). */
    attach?: Person;
  }
  interface Written { status: number; error?: string; id?: string }

  interface SlotWrite {
    name: string;
    /** The switch a person must hold to be NAMED in this slot. */
    eligibility: Eligibility;
    refusal: string;
    /** The switch that decides who may change the slot once the record exists; null where another switch does. */
    assigner: Assigner | null;
    /** What a Sales-preset user's write comes to: refused, or (a create) the creator kept as Owner. */
    salesOutcome: 'refused' | 'creator-kept';
    prepare: (c: Ctx) => Promise<string>;
    write: (api: Api, id: string, target: Person, c: Ctx) => Promise<Written>;
    /** Who is in the slot, as stored. */
    holders: (id: string) => Promise<string[]>;
  }

  const reply = (res: { status: number; body: { error?: string } }): Written => ({ status: res.status, error: res.body?.error });

  const jobSlot = async (id: string, column: 'dispatcher_id' | 'salesperson_id') => {
    const job = await db.job.findUniqueOrThrow({ where: { id }, select: { dispatcher_id: true, salesperson_id: true } });
    return job[column] ? [job[column]!] : [];
  };
  const jobCrew = async (id: string) =>
    (await db.visitAssignee.findMany({ where: { visit: { job_id: id } }, select: { user_id: true } })).map((r) => r.user_id).sort();
  const leadOwner = async (id: string) => {
    const lead = await db.lead.findUnique({ where: { id }, select: { commission_owner_id: true } });
    return lead?.commission_owner_id ? [lead.commission_owner_id] : [];
  };

  const newJob = (c: Ctx) =>
    fx.addJob(c.org, c.customer, { crew: [c.existing.id], soldBy: c.attach?.id, createdBy: c.attach?.id }).then((j) => j.id);
  const newLead = (c: Ctx) =>
    fx.addLead(c.org, c.customer, {
      assignees: c.attach ? [c.attach.id] : [], owner: c.attach?.id, createdBy: c.attach?.id, walkthroughCrew: [c.existing.id],
    }).then((l) => l.id);

  const rows: SlotWrite[] = [
    {
      name: 'job Dispatcher',
      eligibility: 'can_be_dispatcher', refusal: NOT_DISPATCHER, assigner: 'assign_people_to_jobs', salesOutcome: 'refused',
      prepare: newJob,
      write: async (api, id, target) => reply(await api.post(`/api/jobs/${id}/dispatcher`, { dispatcher_id: target.id })),
      holders: (id) => jobSlot(id, 'dispatcher_id'),
    },
    {
      name: 'job Sold By',
      eligibility: 'can_own_leads', refusal: NOT_OWNER, assigner: 'assign_people_to_jobs', salesOutcome: 'refused',
      prepare: newJob,
      write: async (api, id, target) => reply(await api.post(`/api/jobs/${id}/sold-by`, { sold_by_id: target.id })),
      holders: (id) => jobSlot(id, 'salesperson_id'),
    },
    {
      name: 'lead Owner on create',
      eligibility: 'can_own_leads', refusal: NOT_OWNER, assigner: null, salesOutcome: 'creator-kept',
      // A create has no record to prepare; the write makes it.
      prepare: async () => '',
      write: async (api, _id, target, c) => {
        const res = await api.post('/api/leads', { customer_id: c.customer, service_request: 'Fix the door', assigned_to: target.id });
        return { ...reply(res), id: res.body?.lead?.id };
      },
      holders: (id) => (id ? leadOwner(id) : Promise.resolve([])),
    },
    {
      name: 'lead Owner on reassign',
      eligibility: 'can_own_leads', refusal: NOT_OWNER, assigner: 'assign_people_to_leads', salesOutcome: 'refused',
      prepare: newLead,
      write: async (api, id, target) => reply(await api.post(`/api/leads/${id}/assign`, { assigned_to: target.id })),
      holders: leadOwner,
    },
    {
      name: 'lead Dispatcher',
      eligibility: 'can_be_dispatcher', refusal: NOT_DISPATCHER, assigner: 'assign_people_to_leads', salesOutcome: 'refused',
      prepare: newLead,
      write: async (api, id, target) => reply(await api.post(`/api/leads/${id}/dispatcher`, { dispatcher_id: target.id })),
      holders: async (id) => {
        const lead = await db.lead.findUniqueOrThrow({ where: { id }, select: { dispatcher_id: true } });
        return lead.dispatcher_id ? [lead.dispatcher_id] : [];
      },
    },
    {
      name: 'job crew',
      eligibility: 'can_be_on_crew', refusal: NOT_CREW, assigner: 'assign_people_to_jobs', salesOutcome: 'refused',
      prepare: newJob,
      write: async (api, id, target) => reply(await api.post(`/api/jobs/${id}/assignees`, { assignee_ids: [target.id] })),
      holders: jobCrew,
    },
    {
      name: 'walkthrough crew',
      eligibility: 'can_be_on_crew', refusal: NOT_CREW, assigner: null, salesOutcome: 'refused',
      prepare: newLead,
      write: async (api, id, target) => reply(await api.post(`/api/leads/${id}/walkthrough/performers`, { performer_ids: [target.id] })),
      holders: async (id) =>
        (await db.visitAssignee.findMany({ where: { visit: { lead_id: id } }, select: { user_id: true } })).map((r) => r.user_id).sort(),
    },
    {
      name: 'plan visit crew',
      eligibility: 'can_be_on_crew', refusal: NOT_CREW, assigner: null, salesOutcome: 'refused',
      prepare: async (c) => {
        planOrgs.push(c.org);
        return (await fx.addServicePlan(c.org, c.customer, { soldBy: c.attach?.id })).id;
      },
      write: async (api, id, target) => reply(await api.post(`/api/service-plans/${id}/schedule-visit`, { ...nextWindow(), assigned_to: target.id })),
      holders: async (id) =>
        (await db.visitAssignee.findMany({ where: { visit: { job: { source_plan_id: id } } }, select: { user_id: true } })).map((r) => r.user_id).sort(),
    },
  ];

  /** Run a write and report what came back and who is in the slot afterwards. */
  async function attempt(row: SlotWrite, api: Api, id: string, target: Person, c: Ctx) {
    const written = await row.write(api, id, target, c);
    return { ...written, holders: await row.holders(written.id ?? id) };
  }

  it('has a row for every slot switch the catalog carries, and each one names the switch it checks', () => {
    const slotSwitches: Eligibility[] = ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew'];
    for (const key of slotSwitches) expect(SWITCH_CATALOG.some((s) => s.key === key), key).toBe(true);
    expect([...new Set(rows.map((r) => r.eligibility))].sort()).toEqual([...slotSwitches].sort());
    for (const row of rows) {
      if (row.assigner) expect(SWITCH_CATALOG.some((s) => s.key === row.assigner), row.name).toBe(true);
    }
    expect(rows.map((r) => r.name)).toEqual([
      'job Dispatcher', 'job Sold By', 'lead Owner on create', 'lead Owner on reassign', 'lead Dispatcher', 'job crew', 'walkthrough crew', 'plan visit crew',
    ]);
  });

  describe.each(rows.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    it('refuses a person who cannot hold the slot and one who is inactive, in plain words, and takes one who can, whatever the role is based on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
      const c: Ctx = { org, customer, existing };
      const api = await fx.signedInAs(admin);

      // The hard pairs: a Technician base with the switch on, and a Dispatcher base with it off.
      const technicianWhoCan = await personWith(org, { [row.eligibility]: true }, 'TECHNICIAN');
      const dispatcherWhoCannot = await personWith(org, { [row.eligibility]: false }, 'DISPATCHER');
      const inactive = await personWith(org, { [row.eligibility]: true }, 'TECHNICIAN', { active: false });

      for (const [who, message] of [[dispatcherWhoCannot, row.refusal], [inactive, INACTIVE]] as const) {
        const id = await row.prepare(c);
        const before = await row.holders(id);
        const refused = await attempt(row, api, id, who, c);
        expect(refused.status, `${who === inactive ? 'inactive' : 'switch off'}, status`).toBe(400);
        expect(refused.error, `${who === inactive ? 'inactive' : 'switch off'}, message`).toBe(message);
        expect(refused.holders, 'a refused write changes nothing').toEqual(before);
      }

      const id = await row.prepare(c);
      const allowed = await attempt(row, api, id, technicianWhoCan, c);
      expect(allowed.status, 'switch on').toBeLessThan(300);
      expect(allowed.holders, 'switch on').toEqual([technicianWhoCan.id]);
    });

    it('is refused to a person on the Sales preset, including on a record they are attached to', async () => {
      const { org, customer } = await fx.newOrg();
      await seedSalesRole(org);
      const seller = await fx.addUser(org, `seller${++sequence}`, 'SALES');
      const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
      // Someone who could hold any slot, so the Sales user's own rights are the only thing refusing.
      const target = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: true }, 'TECHNICIAN');
      const c: Ctx = { org, customer, existing, attach: seller };
      const id = await row.prepare(c);
      const before = await row.holders(id);

      const result = await attempt(row, await fx.signedInAs(seller), id, target, c);

      if (row.salesOutcome === 'creator-kept') {
        // A lead a Sales user creates holds exactly the pre-fill: them as Owner, never the person the request names.
        expect(result.status).toBe(201);
        expect(result.holders).toEqual([seller.id]);
      } else {
        expect(result.status).toBe(403);
        expect(result.holders).toEqual(before);
      }
    });

    if (row.assigner) {
      it('cannot be changed by a person holding neither Assign people to jobs nor Assign people to leads', async () => {
        const { org, customer } = await fx.newOrg();
        const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
        const target = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: true }, 'TECHNICIAN');
        // Every other switch these doors look at is on, so only the two Assign switches stand in the way.
        const everythingElse = {
          assign_people_to_jobs: false, assign_people_to_leads: false, assign_work_to_others: true, book_walkthroughs: true,
          can_own_leads: true, can_be_dispatcher: true, can_be_on_crew: true,
        };
        for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
          const me = await personWith(org, everythingElse, base);
          const c: Ctx = { org, customer, existing, attach: me };
          const id = await row.prepare(c);
          const before = await row.holders(id);

          const result = await attempt(row, await me.api(), id, target, c);

          expect(result.status, base).toBe(403);
          expect(result.holders, base).toEqual(before);
        }
      });
    }
  });
});
