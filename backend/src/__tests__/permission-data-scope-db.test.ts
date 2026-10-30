/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.2 - jobs and leads open by Data Scope, with Attached meaning
   crew, Sold By and Dispatcher.

   Everything goes through the public interface: the catalog read and the lead and job routes, called
   as people on custom roles (never a built-in role name) whose Jobs scope and Leads scope are the
   switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

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

// The suite-wide setup hands every record the same number; the enforcement table creates several leads in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { presetSwitchSet } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('jobs and leads open by Data Scope (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (on top of the Dispatcher base). */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { departmentId?: string; locationId?: string; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `scope-role-${++sequence}`;
    // The role copies the legacy grants of its base the way creating a role does; the catalog, not
    // those stored grants, decides what the person reaches in leads and jobs.
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, 'DISPATCHER', {
      customRoleId: role.id, departmentId: opts.departmentId, locationId: opts.locationId,
    });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const listedJobs = async (api: Api) => {
    const res = await api.get('/api/jobs');
    expect(res.status).toBe(200);
    return (res.body.jobs as { id: string }[]).map((j) => j.id);
  };
  const listedLeads = async (api: Api) => {
    const res = await api.get('/api/leads');
    expect(res.status).toBe(200);
    return (res.body.leads as { id: string }[]).map((l) => l.id);
  };

  describe('Attached on Jobs scope', () => {
    // Each way a person is attached to a job, and how the office takes them off it again.
    type JobPath = {
      name: string;
      attach: (org: string, customer: string, me: Person) => Promise<{ id: string; detach: () => Promise<unknown> }>;
    };
    const paths: JobPath[] = [
      {
        name: 'crew on a past visit',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { crew: [me.id], pastVisit: true });
          return { id: job.id, detach: () => fx.removeCrew(job.visitId!, me.id) };
        },
      },
      {
        name: 'crew on an upcoming visit',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { crew: [me.id] });
          return { id: job.id, detach: () => fx.removeCrew(job.visitId!, me.id) };
        },
      },
      {
        name: 'Sold By',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { soldBy: me.id });
          return { id: job.id, detach: () => db.job.update({ where: { id: job.id }, data: { salesperson_id: null } }) };
        },
      },
      {
        // A job built from several estimates of one lead has no single estimate, only the lead it came from.
        name: 'Sold By on a job with no single estimate',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer);
          const job = await fx.addJob(org, customer, { soldBy: me.id });
          await db.job.update({ where: { id: job.id }, data: { lead_id: lead.id } });
          return { id: job.id, detach: () => db.job.update({ where: { id: job.id }, data: { salesperson_id: null } }) };
        },
      },
      {
        name: 'Dispatcher',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { dispatcher: me.id });
          return { id: job.id, detach: () => db.job.update({ where: { id: job.id }, data: { dispatcher_id: null } }) };
        },
      },
    ];

    it.each(paths)('lets a person on Attached open the job and see it listed when they are $name, and hides it on the next request once they are not', async (path) => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const api = await me.api();
      const decoy = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, 'other', 'TECHNICIAN')).id] });
      const attached = await path.attach(org, customer, me);

      expect((await api.get(`/api/jobs/${attached.id}`)).status).toBe(200);
      const listed = await listedJobs(api);
      expect(listed).toContain(attached.id);
      expect(listed).not.toContain(decoy.id);
      expect((await api.get(`/api/jobs/${decoy.id}`)).status).toBe(403);

      await attached.detach();

      expect((await api.get(`/api/jobs/${attached.id}`)).status).toBe(403);
      expect(await listedJobs(api)).not.toContain(attached.id);
    });

    it('does not let a person attached only to a lead open the job converted from it', async () => {
      const { org, customer } = await fx.newOrg();
      const assignee = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached' });
      const walker = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { assignees: [assignee.id], walkthroughCrew: [walker.id] });
      const job = await fx.addJob(org, customer, { fromLead: lead.id, crew: [(await fx.addUser(org, 'crew', 'TECHNICIAN')).id] });

      for (const person of [assignee, walker]) {
        const api = await person.api();
        expect((await api.get(`/api/leads/${lead.id}`)).status).toBe(200);
        expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(403);
        expect(await listedJobs(api)).not.toContain(job.id);
      }
    });

    it("does not let the Owner of the lead a job came from open it unless the job's own Sold By names them", async () => {
      const { org, customer } = await fx.newOrg();
      const owner = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached', view_jobs: true });
      const lead = await fx.addLead(org, customer, { owner: owner.id });
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      const api = await owner.api();

      // The live walk job -> estimate -> lead -> Owner is no longer part of access.
      expect((await api.get(`/api/leads/${lead.id}`)).status).toBe(200);
      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(403);
      expect(await listedJobs(api)).not.toContain(job.id);

      // Stored on the job, the same person opens it; clearing it closes it again on the next request.
      await db.job.update({ where: { id: job.id }, data: { salesperson_id: owner.id } });
      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(200);
      expect(await listedJobs(api)).toContain(job.id);
      await db.job.update({ where: { id: job.id }, data: { salesperson_id: null } });
      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(403);
    });

    it('keeps a person who is Sold By and also on the crew attached after Sold By is cleared', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const job = await fx.addJob(org, customer, { soldBy: me.id, crew: [me.id] });
      const api = await me.api();

      await db.job.update({ where: { id: job.id }, data: { salesperson_id: null } });
      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(200);
    });

    it('does not let the person who created a job open it when they are on nothing', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const job = await fx.addJob(org, customer, { createdBy: creator.id });
      const api = await creator.api();

      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(403);
      expect(await listedJobs(api)).not.toContain(job.id);
    });
  });

  describe('Attached on Leads scope', () => {
    type LeadPath = {
      name: string;
      attach: (org: string, customer: string, me: Person) => Promise<{ id: string; detach: () => Promise<unknown> }>;
    };
    const paths: LeadPath[] = [
      {
        name: 'an assignee',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer, { assignees: [me.id] });
          return { id: lead.id, detach: () => db.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: me.id } }) };
        },
      },
      {
        name: 'its Owner',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer, { owner: me.id });
          return { id: lead.id, detach: () => db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } }) };
        },
      },
      {
        name: 'on a walkthrough crew',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer, { walkthroughCrew: [me.id] });
          return { id: lead.id, detach: () => fx.removeCrew(lead.walkthroughId!, me.id) };
        },
      },
      {
        name: 'its Dispatcher',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer, { dispatcher: me.id });
          return { id: lead.id, detach: () => db.lead.update({ where: { id: lead.id }, data: { dispatcher_id: null } }) };
        },
      },
    ];

    it.each(paths)('lets a person on Attached open the lead and see it listed when they are $name, and hides it on the next request once they are not', async (path) => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', view_leads: true });
      const api = await me.api();
      const decoy = await fx.addLead(org, customer, { assignees: [(await fx.addUser(org, 'other', 'SALES')).id] });
      const attached = await path.attach(org, customer, me);

      expect((await api.get(`/api/leads/${attached.id}`)).status).toBe(200);
      const listed = await listedLeads(api);
      expect(listed).toContain(attached.id);
      expect(listed).not.toContain(decoy.id);
      expect((await api.get(`/api/leads/${decoy.id}`)).status).toBe(403);

      await attached.detach();

      expect((await api.get(`/api/leads/${attached.id}`)).status).toBe(403);
      expect(await listedLeads(api)).not.toContain(attached.id);
    });

    it('does not let the person who created a lead open it when they are on nothing', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await personWith(org, { leads_scope: 'attached', view_leads: true });
      const lead = await fx.addLead(org, customer, { createdBy: creator.id });
      const api = await creator.api();

      expect((await api.get(`/api/leads/${lead.id}`)).status).toBe(403);
      expect(await listedLeads(api)).not.toContain(lead.id);
    });
  });

  describe('Team and Location', () => {
    it('reach jobs and leads with someone attached in the person\'s department or location', async () => {
      const { org, customer } = await fx.newOrg();
      const [mine, theirs] = [await fx.addDepartment(org, 'mine'), await fx.addDepartment(org, 'theirs')];
      const [here, there] = [await fx.addLocation(org, 'here'), await fx.addLocation(org, 'there')];
      const teammate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: mine, locationId: here });
      const stranger = await fx.addUser(org, 'away', 'TECHNICIAN', { departmentId: theirs, locationId: there });
      const jobOfMate = await fx.addJob(org, customer, { crew: [teammate.id] });
      const jobOfStranger = await fx.addJob(org, customer, { crew: [stranger.id] });
      const dispatchedByMate = await fx.addJob(org, customer, { dispatcher: teammate.id });
      const leadOfMate = await fx.addLead(org, customer, { assignees: [teammate.id] });
      const leadOfStranger = await fx.addLead(org, customer, { assignees: [stranger.id] });
      const leadDispatchedByMate = await fx.addLead(org, customer, { dispatcher: teammate.id });

      for (const [scope, opts] of [['team', { departmentId: mine }], ['location', { locationId: here }]] as const) {
        const me = await personWith(org, { jobs_scope: scope, leads_scope: scope }, opts);
        const api = await me.api();
        const jobs = await listedJobs(api);
        expect(jobs, scope).toEqual(expect.arrayContaining([jobOfMate.id, dispatchedByMate.id]));
        expect(jobs, scope).not.toContain(jobOfStranger.id);
        expect((await api.get(`/api/jobs/${jobOfMate.id}`)).status).toBe(200);
        expect((await api.get(`/api/jobs/${jobOfStranger.id}`)).status).toBe(403);
        const leads = await listedLeads(api);
        expect(leads, scope).toEqual(expect.arrayContaining([leadOfMate.id, leadDispatchedByMate.id]));
        expect(leads, scope).not.toContain(leadOfStranger.id);
      }
    });

    it('reach nothing for a person with no department or location, even a record with nobody in one', async () => {
      const { org, customer } = await fx.newOrg();
      const nobody = await fx.addUser(org, 'nodept', 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [nobody.id] });
      const lead = await fx.addLead(org, customer, { assignees: [nobody.id] });

      for (const scope of ['team', 'location']) {
        const me = await personWith(org, { jobs_scope: scope, leads_scope: scope });
        const api = await me.api();
        expect(await listedJobs(api), scope).toEqual([]);
        expect(await listedLeads(api), scope).toEqual([]);
        expect((await api.get(`/api/jobs/${job.id}`)).status, scope).toBe(403);
        expect((await api.get(`/api/leads/${lead.id}`)).status, scope).toBe(403);
      }
    });
  });

  describe('View off', () => {
    it('refuses every detail read of jobs and returns an empty list, not a 403', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { view_jobs: false, create_jobs: false, edit_jobs: false, delete_jobs: false, show_jobs_page: false, export_jobs: false,
        assign_work_to_others: false, schedule_visits: false, mark_on_my_way: false, mark_arrived: false, office_review: false,
        close_jobs: false, close_jobs_with_money_owed: false, cancel_jobs: false, reopen_done_jobs: false, change_locked_jobs: false,
        edit_job_record_ids: false, alert_every_job: false,
        assign_people_to_jobs: false, start_and_finish_visits: false, update_any_visit_status: false, complete_jobs: false, duplicate_jobs: false,
        edit_job_line_items: false, jobs_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [me.id], soldBy: me.id, dispatcher: me.id });
      const api = await me.api();

      const list = await api.get('/api/jobs');
      expect(list.status).toBe(200);
      expect(list.body.jobs).toEqual([]);
      for (const path of ['', '/timeline', '/notes', '/visits', '/financials', '/line-items']) {
        expect((await api.get(`/api/jobs/${job.id}${path}`)).status, `jobs/:id${path}`).toBe(403);
      }
    });

    it('refuses every detail read of leads and returns an empty list, not a 403', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { view_leads: false, create_leads: false, edit_leads: false, delete_leads: false, show_leads_page: false,
        export_leads: false, assign_people_to_leads: false, change_lead_status_by_hand: false, log_contact_attempts: false, mark_leads_lost: false, reopen_leads: false, book_walkthroughs: false,
        perform_walkthroughs: false, edit_lead_record_ids: false, alert_every_lead: false, leads_scope: 'all' });
      const lead = await fx.addLead(org, customer, { assignees: [me.id], owner: me.id });
      const api = await me.api();

      const list = await api.get('/api/leads');
      expect(list.status).toBe(200);
      expect(list.body.leads).toEqual([]);
      for (const path of ['', '/timeline', '/notes', '/visits']) {
        expect((await api.get(`/api/leads/${lead.id}${path}`)).status, `leads/:id${path}`).toBe(403);
      }
    });
  });

  // Roles & Permissions, PRD 7, slice S07.2: the inventory job list and detail are the jobs a person can
  // open, the same answer the Jobs list gives (PRD 7 adds inventory-job reach to this resolver).
  describe('the inventory job list', () => {
    const inventoryJobs = async (api: Api) => {
      const res = await api.get('/api/inventory/jobs');
      expect(res.status).toBe(200);
      return (res.body.jobs as { id: string }[]).map((j) => j.id);
    };

    it('lists only the jobs an Attached person is attached to, and answers "not found" on any other job\'s detail', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const colleague = await fx.addUser(org, 'colleague', 'TECHNICIAN');
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const notMine = await fx.addJob(org, customer, { crew: [colleague.id] });
      const api = await me.api();

      expect(await inventoryJobs(api)).toEqual([mine.id]);
      expect((await api.get(`/api/inventory/jobs/${mine.id}`)).status).toBe(200);
      const other = await api.get(`/api/inventory/jobs/${notMine.id}`);
      expect(other.status).toBe(404);
      // The refusal says nothing about the job it refused.
      expect(JSON.stringify(other.body)).not.toContain(notMine.id);
    });

    it('never sends the customer name of a job the person cannot open', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const colleague = await fx.addUser(org, 'colleague', 'TECHNICIAN');
      await fx.addJob(org, customer, { crew: [colleague.id] });
      const api = await me.api();

      const res = await api.get('/api/inventory/jobs');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('Payer');
    });

    it('lists every job when Jobs scope is All', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', view_jobs: true });
      const colleague = await fx.addUser(org, 'colleague', 'TECHNICIAN');
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [colleague.id] });
      const unstaffed = await fx.addJob(org, customer, {});
      const api = await me.api();

      expect(await inventoryJobs(api)).toEqual(expect.arrayContaining([mine.id, theirs.id, unstaffed.id]));
      for (const job of [mine, theirs, unstaffed]) {
        expect((await api.get(`/api/inventory/jobs/${job.id}`)).status).toBe(200);
      }
    });

    it('drops a job from the list on the next request once the person is taken off it', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await me.api();

      expect(await inventoryJobs(api)).toContain(job.id);
      await fx.removeCrew(job.visitId!, me.id);
      expect(await inventoryJobs(api)).not.toContain(job.id);
      expect((await api.get(`/api/inventory/jobs/${job.id}`)).status).toBe(404);
    });

    it('holds the same jobs as the Jobs list, for every way of being attached', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true });
      const colleague = await fx.addUser(org, 'colleague', 'TECHNICIAN');
      await fx.addJob(org, customer, { crew: [me.id] });
      await fx.addJob(org, customer, { soldBy: me.id });
      await fx.addJob(org, customer, { dispatcher: me.id });
      // The Owner of the lead a job came from is not attached to it unless the job's own Sold By names them.
      await fx.addJob(org, customer, { fromLead: (await fx.addLead(org, customer, { owner: me.id })).id });
      await fx.addJob(org, customer, { crew: [colleague.id] });
      await fx.addJob(org, customer, { createdBy: me.id });
      const api = await me.api();

      const reached = await listedJobs(api);
      expect(reached).toHaveLength(3);
      expect([...(await inventoryJobs(api))].sort()).toEqual([...reached].sort());
    });

    it('reaches only jobs with someone attached in the person\'s department on Team, and nothing with no department', async () => {
      const { org, customer } = await fx.newOrg();
      const [mine, theirs] = [await fx.addDepartment(org, 'mine'), await fx.addDepartment(org, 'theirs')];
      const teammate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: mine });
      const stranger = await fx.addUser(org, 'away', 'TECHNICIAN', { departmentId: theirs });
      const jobOfMate = await fx.addJob(org, customer, { crew: [teammate.id] });
      const jobOfStranger = await fx.addJob(org, customer, { crew: [stranger.id] });

      const inTeam = await (await personWith(org, { jobs_scope: 'team', view_jobs: true }, { departmentId: mine })).api();
      expect(await inventoryJobs(inTeam)).toEqual([jobOfMate.id]);
      expect((await inTeam.get(`/api/inventory/jobs/${jobOfStranger.id}`)).status).toBe(404);

      const noTeam = await (await personWith(org, { jobs_scope: 'team', view_jobs: true })).api();
      expect(await inventoryJobs(noTeam)).toEqual([]);
    });

    it('lists nothing, with no error, when View jobs is off', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { view_jobs: false, create_jobs: false, edit_jobs: false, delete_jobs: false, show_jobs_page: false, export_jobs: false,
        assign_work_to_others: false, schedule_visits: false, mark_on_my_way: false, mark_arrived: false, office_review: false,
        close_jobs: false, close_jobs_with_money_owed: false, cancel_jobs: false, reopen_done_jobs: false, change_locked_jobs: false,
        edit_job_record_ids: false, alert_every_job: false,
        assign_people_to_jobs: false, start_and_finish_visits: false, update_any_visit_status: false, complete_jobs: false, duplicate_jobs: false,
        edit_job_line_items: false, jobs_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await me.api();

      expect(await inventoryJobs(api)).toEqual([]);
      expect((await api.get(`/api/inventory/jobs/${job.id}`)).status).toBe(404);
    });
  });

  describe('the built-in presets, as the catalog states them', () => {
    it('lets Dispatcher open every job and lead, and Technician only the jobs and leads they are attached to', async () => {
      const { org, customer } = await fx.newOrg();
      const dispatcher = await fx.addUser(org, 'dee', 'DISPATCHER');
      const technician = await fx.addUser(org, 'tom', 'TECHNICIAN');
      const mine = await fx.addJob(org, customer, { crew: [technician.id] });
      const notMine = await fx.addJob(org, customer, { dispatcher: dispatcher.id });
      const myLead = await fx.addLead(org, customer, { walkthroughCrew: [technician.id] });
      const otherLead = await fx.addLead(org, customer, {});

      const asDispatcher = await fx.signedInAs(dispatcher);
      expect(await listedJobs(asDispatcher)).toEqual(expect.arrayContaining([mine.id, notMine.id]));
      expect(await listedLeads(asDispatcher)).toEqual(expect.arrayContaining([myLead.id, otherLead.id]));

      const asTechnician = await fx.signedInAs(technician);
      const jobs = await listedJobs(asTechnician);
      expect(jobs).toContain(mine.id);
      expect(jobs).not.toContain(notMine.id);
      const leads = await listedLeads(asTechnician);
      expect(leads).toContain(myLead.id);
      expect(leads).not.toContain(otherLead.id);
    });

    it('keeps Sales\' reach to the jobs of leads they are an assignee of, and Attached on Leads', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await fx.addUser(org, 'sam', 'SALES');
      const ownLead = await fx.addLead(org, customer, { assignees: [seller.id] });
      const ownJob = await fx.addJob(org, customer, { fromLead: ownLead.id });
      const otherJob = await fx.addJob(org, customer, {});
      const otherLead = await fx.addLead(org, customer, {});
      const api = await fx.signedInAs(seller);

      const jobs = await listedJobs(api);
      expect(jobs).toContain(ownJob.id);
      expect(jobs).not.toContain(otherJob.id);
      const leads = await listedLeads(api);
      expect(leads).toContain(ownLead.id);
      expect(leads).not.toContain(otherLead.id);
    });
  });

  describe('the catalog read', () => {
    it('serves both scopes with their four choices and without the kept value, and the Leads and Jobs rows with their presets', async () => {
      const { org } = await fx.newOrg();
      const technician = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const res = await (await fx.signedInAs(technician)).get('/api/permission-switches/catalog');

      expect(res.status).toBe(200);
      const byKey = Object.fromEntries((res.body.switches as { key: string }[]).map((s) => [s.key, s])) as Record<string, Record<string, unknown>>;
      for (const key of ['leads_scope', 'jobs_scope']) {
        expect(byKey[key]).toMatchObject({ kind: 'choice', module: 'Data Scope', choices: ['attached', 'team', 'location', 'all'] });
      }
      // The kept value is Sales' stored preset; it is never among the options a screen offers.
      expect(byKey['jobs_scope']!.choices).not.toContain('through_own_leads');
      // What the screens read is what the server enforces from.
      for (const s of SWITCH_CATALOG) {
        expect(byKey[s.key], s.key).toMatchObject({ label: s.label, presets: s.presets });
      }
    });
  });

  describe('the validator on a written role', () => {
    it('refuses a role set that breaks the row rule, and stores nothing', async () => {
      const { org } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'invalid-role', 'DISPATCHER');
      await expect(
        setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { view_leads: false }, actorId: null, reason: 'manual' }),
      ).rejects.toThrow(/Create leads needs View leads/);
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, role_key: role.key } })).toBe(0);
    });

    it('accepts every built-in preset', () => {
      for (const role of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const) {
        expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
      }
    });
  });

  describe('the route-level enforcement table', () => {
    // One request per server check, each against a record of its own. With the switch on the request
    // is let in (anything but a refusal); with it off it is refused with a 403, except a list, which
    // answers with no rows.
    // `whenOff` replaces the 403 for a check whose refusal is not a refusal: lead create keeps the creator as the Owner.
    type Probe = {
      switchKey: string; check: string; run: (api: Api, org: string, customer: string, me: Person, other: Person) => Promise<{ status: number; body?: unknown }>;
      isList?: 'jobs' | 'leads';
      /** Other switches the request needs, kept on for both the let-in and the refused request. */
      also?: Record<string, boolean>;
      whenOn?: (res: { status: number; body?: unknown }, me: Person, other: Person) => void;
      whenOff?: (res: { status: number; body?: unknown }, me: Person, other: Person) => void;
    };
    // Edit leads off takes Change lead status by hand with it (that switch needs Edit leads on).
    const LEADS_OFF = { edit_leads: false, change_lead_status_by_hand: false };
    const probes: Probe[] = [
      { switchKey: 'view_leads', check: 'lead-list', isList: 'leads', run: (api) => api.get('/api/leads') },
      { switchKey: 'view_leads', check: 'lead-detail', run: async (api, org, customer) => api.get(`/api/leads/${(await fx.addLead(org, customer)).id}`) },
      { switchKey: 'create_leads', check: 'lead-create', run: (api, _org, customer) => api.post('/api/leads', { customer_id: customer, service_request: 'New lead' }) },
      { switchKey: 'delete_leads', check: 'lead-delete', run: async (api, org, customer) => api.delete(`/api/leads/${(await fx.addLead(org, customer)).id}`) },
      { switchKey: 'assign_people_to_leads', check: 'lead-reassign', run: async (api, org, customer, me) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/assign`, { assigned_to: me.id }) },
      {
        switchKey: 'assign_people_to_leads', check: 'lead-create-owner',
        // Without the switch the lead holds the creator rule's result (S03.15): Can own leads on lands the creator as Owner.
        also: { can_own_leads: true, can_be_dispatcher: false },
        run: async (api, _org, customer, _me, other) => api.post('/api/leads', { customer_id: customer, service_request: 'New lead', assigned_to: other.id }),
        whenOn: (res, _me, other) => { expect(res.status).toBe(201); expect((res.body as { lead: { commission_owner: { id: string } } }).lead.commission_owner.id).toBe(other.id); },
        whenOff: (res, me) => { expect(res.status).toBe(201); expect((res.body as { lead: { commission_owner: { id: string } } }).lead.commission_owner.id).toBe(me.id); },
      },
      { switchKey: 'assign_people_to_leads', check: 'lead-set-dispatcher', run: async (api, org, customer, me) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/dispatcher`, { dispatcher_id: me.id }) },
      { switchKey: 'change_lead_status_by_hand', check: 'lead-status-change', run: async (api, org, customer) => api.patch(`/api/leads/${(await fx.addLead(org, customer)).id}`, { status: 'CONTACTED' }) },
      { switchKey: 'log_contact_attempts', check: 'lead-contact', run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/contact`, { contacted_at: new Date().toISOString() }) },
      { switchKey: 'mark_leads_lost', check: 'lead-mark-lost', run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/mark-lost`, { lost_reason: 'Went elsewhere' }) },
      // Slice S05.19 - Reopen lead on a closed lead: Reopen leads alone, whatever Change lead status by hand says.
      { switchKey: 'reopen_leads', check: 'lead-reopen', run: async (api, org, customer) => {
          const lead = await fx.addLead(org, customer);
          await db.lead.update({ where: { id: lead.id }, data: { status: 'LOST' } });
          return api.post(`/api/leads/${lead.id}/reopen`, { reason: 'The customer called back' });
        } },
      { switchKey: 'book_walkthroughs', check: 'lead-walkthrough-schedule', run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/walkthrough/unschedule`, {}) },
      { switchKey: 'perform_walkthroughs', check: 'lead-walkthrough-perform', run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/walkthrough/complete`, {}) },
      { switchKey: 'view_jobs', check: 'job-list', isList: 'jobs', run: (api) => api.get('/api/jobs') },
      { switchKey: 'view_jobs', check: 'job-detail', run: async (api, org, customer) => api.get(`/api/jobs/${(await fx.addJob(org, customer)).id}`) },
      { switchKey: 'create_jobs', check: 'job-create', run: (api) => api.post('/api/jobs', {}) },
      { switchKey: 'delete_jobs', check: 'job-delete', run: async (api, org, customer) => api.delete(`/api/jobs/${(await fx.addJob(org, customer)).id}`) },
      { switchKey: 'assign_work_to_others', check: 'crew-other-person', also: { assign_people_to_jobs: true }, run: async (api, org, customer) => {
          const other = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
          return api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/assignees`, { assignee_ids: [other.id] });
        } },
      { switchKey: 'schedule_visits', check: 'job-visit-create', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/visits`, {}) },
      // The status steps are the crew's own: the person is on the visit they step.
      { switchKey: 'mark_on_my_way', check: 'job-en-route', run: async (api, org, customer, me) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { crew: [me.id] })).id}/en-route`, {}) },
      { switchKey: 'mark_arrived', check: 'job-arrive', run: async (api, org, customer, me) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { crew: [me.id] })).id}/arrive`, {}) },
      // Slice S01.8 - job people, visit steps, job complete, duplicate and job line items.
      { switchKey: 'assign_people_to_jobs', check: 'job-assign', also: { assign_work_to_others: true }, run: async (api, org, customer, me) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { crew: [me.id] })).id}/assign`, { assignee_ids: [me.id] }) },
      { switchKey: 'assign_people_to_jobs', check: 'job-unassign', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/unassign`, {}) },
      { switchKey: 'assign_people_to_jobs', check: 'job-set-dispatcher', run: async (api, org, customer, me) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/dispatcher`, { dispatcher_id: me.id }) },
      { switchKey: 'assign_people_to_jobs', check: 'job-set-sold-by', run: async (api, org, customer, me) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/sold-by`, { sold_by_id: me.id }) },
      { switchKey: 'assign_people_to_jobs', check: 'job-bulk-assign', also: { assign_work_to_others: true }, run: async (api, org, customer, me) => api.post('/api/jobs/bulk-assign', { ids: [(await fx.addJob(org, customer, { crew: [me.id] })).id], assignee_ids: [me.id] }) },
      { switchKey: 'start_and_finish_visits', check: 'job-start', run: async (api, org, customer, me) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { crew: [me.id] })).id}/start`, {}) },
      {
        switchKey: 'start_and_finish_visits', check: 'visit-start',
        run: async (api, org, customer, me) => {
          const job = await fx.addJob(org, customer, { crew: [me.id] });
          return api.post(`/api/jobs/${job.id}/visits/${job.visitId}/start`, {});
        },
      },
      {
        switchKey: 'start_and_finish_visits', check: 'visit-finish',
        run: async (api, org, customer, me) => {
          const job = await fx.addJob(org, customer, { crew: [me.id] });
          return api.post(`/api/jobs/${job.id}/visits/${job.visitId}/complete`, {});
        },
      },
      // Not crew on the visit: only this switch lets the step in.
      { switchKey: 'update_any_visit_status', check: 'job-status-step-any-visit', also: { mark_on_my_way: true }, run: async (api, org, customer, _me, other) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { crew: [other.id] })).id}/en-route`, {}) },
      { switchKey: 'complete_jobs', check: 'job-complete', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { status: 'IN_PROGRESS' })).id}/complete`, {}) },
      { switchKey: 'duplicate_jobs', check: 'job-duplicate', also: { create_jobs: true }, run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/duplicate`, {}) },
      { switchKey: 'edit_job_line_items', check: 'job-line-write', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 10 }) },
      // Slice S01.11 - Edit leads and Edit jobs gate the update route and the tag and sub-status routes; notes follow Add notes.
      { switchKey: 'edit_leads', check: 'lead-update', run: async (api, org, customer) => api.patch(`/api/leads/${(await fx.addLead(org, customer)).id}`, { service_request: 'Edited' }) },
      { switchKey: 'edit_leads', check: 'lead-tag-add', run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/tags`, { name: 'Priority' }) },
      { switchKey: 'edit_leads', check: 'lead-tag-remove', run: async (api, org, customer) => api.delete(`/api/leads/${(await fx.addLead(org, customer)).id}/tags/${randomUUID()}`) },
      { switchKey: 'edit_jobs', check: 'job-update', run: async (api, org, customer) => api.patch(`/api/jobs/${(await fx.addJob(org, customer)).id}`, { scope_notes: 'Edited' }) },
      { switchKey: 'edit_jobs', check: 'job-sub-status', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/sub-status`, { sub_status_id: null }) },
      { switchKey: 'edit_jobs', check: 'job-tag-add', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/tags`, { name: 'Priority' }) },
      { switchKey: 'edit_jobs', check: 'job-tag-remove', run: async (api, org, customer) => api.delete(`/api/jobs/${(await fx.addJob(org, customer)).id}/tags/${randomUUID()}`) },
      // Slice S01.23 - each module's Export and Edit record ID numbers switches; the renumber preview answers with the same guard as the rename.
      { switchKey: 'export_leads', check: 'lead-export', run: (api) => api.get('/api/leads/export') },
      { switchKey: 'export_jobs', check: 'job-export', run: (api) => api.get('/api/jobs/export') },
      { switchKey: 'edit_lead_record_ids', check: 'lead-renumber', run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/number/preview`, { number: 'L-9001' }) },
      { switchKey: 'edit_job_record_ids', check: 'job-renumber', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/number/preview`, { number: 'J-9001' }) },
      // Slice S05.7 - a job-only phone or email: Edit job and lead contact details OR Edit jobs lets the add in, so each row keeps the other off.
      { switchKey: 'edit_job_and_lead_contact_details', check: 'job-contact-entry-add', also: { edit_jobs: false }, run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries`, { kind: 'EMAIL', value: 'probe@example.test' }) },
      { switchKey: 'edit_jobs', check: 'job-contact-entry-add', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries`, { kind: 'EMAIL', value: 'probe@example.test' }) },
      // Slice S05.8 - replacing one of the customer's values for this job only: the same two switches, either one is enough.
      { switchKey: 'edit_job_and_lead_contact_details', check: 'job-contact-entry-change', also: { edit_jobs: false }, run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/change`, { kind: 'EMAIL', replaces: 'probe-old@example.test', value: 'probe-new@example.test' }) },
      { switchKey: 'edit_jobs', check: 'job-contact-entry-change', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/change`, { kind: 'EMAIL', replaces: 'probe-old@example.test', value: 'probe-new@example.test' }) },
      // Slice S05.9 - correcting or removing an entry, whoever added it: the same two switches, either one is enough.
      { switchKey: 'edit_job_and_lead_contact_details', check: 'job-contact-entry-correct', also: { edit_jobs: false }, run: async (api, org, customer) => api.patch(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/${randomUUID()}`, { label: 'Probe' }) },
      { switchKey: 'edit_job_and_lead_contact_details', check: 'job-contact-entry-remove', also: { edit_jobs: false }, run: async (api, org, customer) => api.delete(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/${randomUUID()}`) },
      { switchKey: 'edit_jobs', check: 'job-contact-entry-correct', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.patch(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/${randomUUID()}`, { label: 'Probe' }) },
      { switchKey: 'edit_jobs', check: 'job-contact-entry-remove', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.delete(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/${randomUUID()}`) },
      // Slice S05.13 - a lead's own phone, email, name and company: the same two switches let a phone or email in (so each row keeps the
      // other off), and a name or company needs Edit leads alone (the contact-details switch stays on while Edit leads is under test).
      { switchKey: 'edit_job_and_lead_contact_details', check: 'lead-contact-entry-add', also: LEADS_OFF, run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries`, { kind: 'EMAIL', value: 'probe@example.test' }) },
      { switchKey: 'edit_job_and_lead_contact_details', check: 'lead-contact-entry-change', also: LEADS_OFF, run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/change`, { kind: 'EMAIL', replaces: 'probe-old@example.test', value: 'probe-new@example.test' }) },
      { switchKey: 'edit_job_and_lead_contact_details', check: 'lead-contact-entry-correct', also: LEADS_OFF, run: async (api, org, customer) => api.patch(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/${randomUUID()}`, { label: 'Probe' }) },
      { switchKey: 'edit_job_and_lead_contact_details', check: 'lead-contact-entry-remove', also: LEADS_OFF, run: async (api, org, customer) => api.delete(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/${randomUUID()}`) },
      { switchKey: 'edit_leads', check: 'lead-contact-entry-add', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries`, { kind: 'EMAIL', value: 'probe@example.test' }) },
      { switchKey: 'edit_leads', check: 'lead-contact-entry-change', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/change`, { kind: 'EMAIL', replaces: 'probe-old@example.test', value: 'probe-new@example.test' }) },
      { switchKey: 'edit_leads', check: 'lead-contact-entry-correct', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.patch(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/${randomUUID()}`, { label: 'Probe' }) },
      { switchKey: 'edit_leads', check: 'lead-contact-entry-remove', also: { edit_job_and_lead_contact_details: false }, run: async (api, org, customer) => api.delete(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/${randomUUID()}`) },
      { switchKey: 'edit_leads', check: 'lead-contact-name-change', also: { edit_job_and_lead_contact_details: true }, run: async (api, org, customer) => api.post(`/api/leads/${(await fx.addLead(org, customer)).id}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Probe' }) },
      // Slice S05.10 - changing the customer's name or company for this job: Edit jobs alone, so the contact-details switch stays on
      // while Edit jobs is the one under test.
      // Slice S04.22 - the completed-job lock: a detail edit on a Completed job passes only with Change locked jobs on (Edit jobs stays on).
      { switchKey: 'change_locked_jobs', check: 'job-locked-change', also: { edit_jobs: true }, run: async (api, org, customer) => api.patch(`/api/jobs/${(await fx.addJob(org, customer, { status: 'COMPLETED' })).id}`, { scope_notes: 'Edited' }) },
      // Slice S06.8 - the office review panel's route: Office review alone opens it, on a job that has reached the review.
      { switchKey: 'office_review', check: 'job-office-review', run: async (api, org, customer) => api.get(`/api/jobs/${(await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' })).id}/review`) },
      // Slice S06.13 - Mark Done: Close jobs alone lets a Ready to close job with nothing owed go Done; with money owed it also needs its own switch and the amount confirmed.
      { switchKey: 'close_jobs', check: 'job-mark-done', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { status: 'READY_TO_CLOSE' })).id}/mark-done`, {}) },
      {
        switchKey: 'close_jobs_with_money_owed', check: 'job-mark-done-money-owed', also: { close_jobs: true },
        run: async (api, org, customer) => {
          const job = await fx.addJob(org, customer, { status: 'READY_TO_CLOSE' });
          await fx.addInvoice(org, customer, { jobId: job.id });
          return api.post(`/api/jobs/${job.id}/mark-done`, { confirmed_amount: 100 });
        },
      },
      // Slice S06.15 - Cancel: Cancel jobs alone lets a job be cancelled with a reason from the list, single and in bulk.
      { switchKey: 'cancel_jobs', check: 'job-cancel', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { status: 'IN_PROGRESS' })).id}/cancel`, { cancel_reason_code: 'PRICE' }) },
      { switchKey: 'cancel_jobs', check: 'job-cancel-bulk', run: async (api, org, customer) => api.post('/api/jobs/bulk-status', { ids: [(await fx.addJob(org, customer, { status: 'IN_PROGRESS' })).id], action: 'cancel', cancel_reason_code: 'PRICE' }) },
      // Slice S06.16 - Reopen: Reopen Done jobs alone sends a Done job back to In Progress.
      { switchKey: 'reopen_done_jobs', check: 'job-reopen', run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer, { status: 'DONE' })).id}/reopen`) },
      { switchKey: 'edit_jobs', check: 'job-contact-name-change', also: { edit_job_and_lead_contact_details: true }, run: async (api, org, customer) => api.post(`/api/jobs/${(await fx.addJob(org, customer)).id}/contact-entries/name`, { kind: 'FIRST_NAME', value: 'Probe' }) },
    ];

    it('has a row for every server check the catalog lists for a Leads or Jobs switch, and no switch is left unaccounted for', () => {
      const listed = SWITCH_CATALOG.filter((s) => ['Leads', 'Jobs'].includes(s.module)).flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      expect(probes.map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual([...listed].sort());
      // A switch with no server check here says which slice or PRD builds it.
      for (const s of SWITCH_CATALOG.filter((x) => ['Leads', 'Jobs', 'Data Scope'].includes(x.module))) {
        expect(s.serverChecks.length > 0 || Boolean(s.pending), s.key).toBe(true);
      }
      // The pending ones are listed in the table as pending, with who builds them.
      const pending = SWITCH_CATALOG.filter((s) => ['Leads', 'Jobs'].includes(s.module) && s.serverChecks.length === 0);
      expect(pending.map((s) => s.key)).toEqual(expect.arrayContaining(['show_jobs_page']));
      // S06.15 built the two cancel checks; Cancel jobs is not pending any more.
      expect(pending.map((s) => s.key)).not.toContain('cancel_jobs');
      // S06.16 built the Reopen check; Reopen Done jobs is not pending any more.
      expect(pending.map((s) => s.key)).not.toContain('reopen_done_jobs');
      expect(pending.map((s) => s.key)).not.toContain('reopen_leads');
      // The exports and the renumber switches have their checks now (S01.23).
      expect(pending.map((s) => s.key)).not.toContain('export_leads');
      expect(pending.map((s) => s.key)).not.toContain('export_jobs');
    });

    it('lets each check in with its switch on and refuses it with the switch off, for a custom role', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all', jobs_scope: 'all' }, { name: 'table' });
      const roleKey = (await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: { startsWith: 'scope-role-' } } })).key;
      const api = await me.api();
      const switchOf = (key: string) => findSwitch(key)!;
      // Someone else the checks can name (a lead's Owner).
      const other = await fx.addUser(org, 'tabletarget', 'TECHNICIAN');
      const roleSwitches = async (values: Record<string, boolean>) =>
        setRoleSwitchValues({ organizationId: org, roleKey, values, actorId: null, reason: 'manual' });

      for (const probe of probes) {
        expect(switchOf(probe.switchKey).serverChecks, probe.check).toContain(probe.check);
        // Everything that needs this switch, directly or through another switch that does.
        const dependants = [probe.switchKey];
        for (let i = 0; i < dependants.length; i += 1) {
          for (const s of SWITCH_CATALOG) if (s.requires.includes(dependants[i]!) && !dependants.includes(s.key)) dependants.push(s.key);
        }
        dependants.shift();

        // On: a record exists for the request to reach.
        await roleSwitches({ ...probe.also, [probe.switchKey]: true });
        if (probe.isList === 'jobs') await fx.addJob(org, customer);
        if (probe.isList === 'leads') await fx.addLead(org, customer);
        const letIn = await probe.run(api, org, customer, me, other);
        if (probe.whenOn) {
          probe.whenOn(letIn, me, other);
        } else if (probe.isList) {
          expect(letIn.status, `${probe.check} on`).toBe(200);
          expect((letIn.body as Record<string, unknown[]>)[probe.isList]!.length, `${probe.check} on`).toBeGreaterThan(0);
        } else {
          expect(letIn.status, `${probe.check} with the switch on`).not.toBe(403);
          expect(letIn.status, `${probe.check} with the switch on`).not.toBe(401);
        }

        // Off: the row rule takes everything that needs this switch off with it.
        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, false])), ...probe.also, [probe.switchKey]: false });
        const refused = await probe.run(api, org, customer, me, other);
        if (probe.whenOff) {
          probe.whenOff(refused, me, other);
        } else if (probe.isList) {
          expect(refused.status, `${probe.check} off`).toBe(200);
          expect((refused.body as Record<string, unknown[]>)[probe.isList], `${probe.check} off`).toEqual([]);
        } else {
          expect(refused.status, `${probe.check} with the switch off`).toBe(403);
        }

        // Back on for the next check, with what depended on it.
        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, true])), [probe.switchKey]: true });
      }
    });
  });
});
