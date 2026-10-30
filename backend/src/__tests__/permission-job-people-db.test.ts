/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.8 - job people, visit steps, job complete, job duplicate and job
   line items follow switches.

   Assign people to jobs decides every people field on a job; Update any visit's status decides the status
   steps on a visit or job the person is not crew on; Complete jobs decides the job-level complete (no crew
   requirement); Duplicate jobs decides the duplicate; Edit job line items alone decides job line and scope
   writes (no creator exception).

   Everything goes through the public interface: the job routes, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('job people, visit steps, job complete and job line items follow switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /**
   * A person on a fresh custom role of this base holding exactly these switch values, with Jobs scope All
   * unless the case says otherwise. A Dispatcher base is the hard case: no role name may decide anything.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `job-people-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  describe('Complete jobs', () => {
    it('lets a custom role with Complete jobs complete a job in its Jobs scope it is not crewed on, and refuses it without', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      // Whatever the role is based on: no role name decides.
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(org, { complete_jobs: true }, { base });
        const without = await personWith(org, { complete_jobs: false }, { base });

        const refusedJob = await fx.addJob(org, customer, { crew: [crew.id], status: 'IN_PROGRESS' });
        const refused = await (await without.api()).post(`/api/jobs/${refusedJob.id}/complete`, {});
        expect(refused.status, base).toBe(403);
        expect((await db.job.findUniqueOrThrow({ where: { id: refusedJob.id } })).status, base).toBe('IN_PROGRESS');

        const allowedJob = await fx.addJob(org, customer, { crew: [crew.id], status: 'IN_PROGRESS' });
        const allowed = await (await holder.api()).post(`/api/jobs/${allowedJob.id}/complete`, { cancel_open_visits: true });
        expect(allowed.status, base).toBe(200);
        expect((await db.job.findUniqueOrThrow({ where: { id: allowedJob.id } })).status, base).toBe('OFFICE_REVIEW');
      }
    });

    it('reaches only the jobs in the holder\'s Jobs scope, on every path that offers it', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const holder = await personWith(org, { complete_jobs: true, jobs_scope: 'attached' }, { base: 'TECHNICIAN' });
      const api = await holder.api();

      const outside = await fx.addJob(org, customer, { crew: [crew.id], status: 'IN_PROGRESS' });
      const inside = await fx.addJob(org, customer, { crew: [holder.id], status: 'IN_PROGRESS' });
      const insideStatus = await fx.addJob(org, customer, { crew: [holder.id], status: 'IN_PROGRESS' });
      const insideBulk = await fx.addJob(org, customer, { crew: [holder.id], status: 'IN_PROGRESS' });

      expect([403, 404]).toContain((await api.post(`/api/jobs/${outside.id}/complete`, {})).status);
      expect((await api.post(`/api/jobs/${inside.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
      expect((await api.post(`/api/jobs/${insideStatus.id}/status`, { status: 'COMPLETED', cancel_open_visits: true })).status).toBe(200);
      const bulk = await api.post('/api/jobs/bulk-status', { ids: [outside.id, insideBulk.id], action: 'complete', cancel_open_visits: true });
      expect(bulk.status).toBe(200);
      expect(bulk.body.updated).toEqual([insideBulk.id]);
      expect(bulk.body.failed.map((f: { id: string }) => f.id)).toEqual([outside.id]);
      expect((await db.job.findUniqueOrThrow({ where: { id: outside.id } })).status).toBe('IN_PROGRESS');
    });
  });

  describe("Update any visit's status", () => {
    // The four places that step a visit or job's status, and the step switch each one needs.
    const steps = [
      { name: 'job on my way', needs: 'mark_on_my_way', path: (j: string) => `/api/jobs/${j}/en-route` },
      { name: 'job arrived', needs: 'mark_arrived', path: (j: string) => `/api/jobs/${j}/arrive` },
      { name: 'job start', needs: 'start_and_finish_visits', path: (j: string) => `/api/jobs/${j}/start` },
      { name: 'visit on my way', needs: 'mark_on_my_way', path: (j: string, v: string) => `/api/jobs/${j}/visits/${v}/en-route` },
      { name: 'visit arrived', needs: 'mark_arrived', path: (j: string, v: string) => `/api/jobs/${j}/visits/${v}/arrive` },
      { name: 'visit start', needs: 'start_and_finish_visits', path: (j: string, v: string) => `/api/jobs/${j}/visits/${v}/start` },
      { name: 'visit finish', needs: 'start_and_finish_visits', path: (j: string, v: string) => `/api/jobs/${j}/visits/${v}/complete` },
    ];

    it('refuses a step on a visit the person is not crew on without the switch, and lets it in with it, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const stepSwitches = { mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true };
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { ...stepSwitches, update_any_visit_status: false }, { base });
        const withIt = await personWith(org, { ...stepSwitches, update_any_visit_status: true }, { base });
        for (const step of steps) {
          const refusedJob = await fx.addJob(org, customer, { crew: [crew.id] });
          const refused = await (await without.api()).post(step.path(refusedJob.id, refusedJob.visitId!), {});
          expect(refused.status, `${base} ${step.name} without`).toBe(403);

          const allowedJob = await fx.addJob(org, customer, { crew: [crew.id] });
          const allowed = await (await withIt.api()).post(step.path(allowedJob.id, allowedJob.visitId!), {});
          expect(allowed.status, `${base} ${step.name} with`).toBe(200);
        }
      }
    });

    it('lets the crew on a visit step it with only the step switch, and still needs that switch', async () => {
      const { org, customer } = await fx.newOrg();
      const stepSwitches = { mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true };
      for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
        const crew = await personWith(org, { ...stepSwitches, update_any_visit_status: false }, { base });
        const noSwitch = await personWith(org, { ...stepSwitches, mark_on_my_way: false, mark_arrived: false, start_and_finish_visits: false, update_any_visit_status: false }, { base });
        for (const step of steps) {
          const job = await fx.addJob(org, customer, { crew: [crew.id, noSwitch.id] });
          expect((await (await crew.api()).post(step.path(job.id, job.visitId!), {})).status, `${base} ${step.name} crew`).toBe(200);
          const own = await fx.addJob(org, customer, { crew: [noSwitch.id] });
          expect((await (await noSwitch.api()).post(step.path(own.id, own.visitId!), {})).status, `${base} ${step.name} no switch`).toBe(403);
        }
      }
    });
  });

  describe('Edit job line items', () => {
    const newLine = { description: 'Hinge', quantity: 1, unit_price: 10 };
    const linesOf = (jobId: string) => db.jobLineItem.count({ where: { job_id: jobId } });

    it("refuses a line edit to a job's creator who is its Sold By when the switch is off, whatever the role is based on", async () => {
      const { org, customer } = await fx.newOrg();
      for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
        const me = await personWith(org, { edit_job_line_items: false }, { base });
        const api = await me.api();
        const job = await fx.addJob(org, customer, { createdBy: me.id, soldBy: me.id, crew: [me.id] });
        expect((await api.post(`/api/jobs/${job.id}/line-items`, newLine)).status, base).toBe(403);
        expect((await api.post(`/api/jobs/${job.id}/scopes`, { title: 'Replace door', flat_price: 100 })).status, base).toBe(403);
        expect((await api.patch(`/api/jobs/${job.id}`, { tax_rate: 0.05 })).status, base).toBe(403);
        expect(await linesOf(job.id), base).toBe(0);
      }
    });

    it('lets a holder edit the lines of any job they can open, created by them or not', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const me = await personWith(org, { edit_job_line_items: true }, { base });
        const api = await me.api();
        const theirs = await fx.addJob(org, customer, { createdBy: me.id, crew: [me.id] });
        const someoneElses = await fx.addJob(org, customer, { createdBy: admin.id, crew: [me.id] });
        for (const job of [theirs, someoneElses]) {
          const added = await api.post(`/api/jobs/${job.id}/line-items`, newLine);
          expect(added.status, base).toBe(201);
          expect(await linesOf(job.id), base).toBe(1);
        }
      }
    });

    it("no longer has the per-person 'edit line items on jobs they created' capability: a stored allow row grants nothing", async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { edit_job_line_items: false }, { base: 'TECHNICIAN' });
      const job = await fx.addJob(org, customer, { createdBy: me.id, soldBy: me.id, crew: [me.id] });
      expect((await (await me.api()).post(`/api/jobs/${job.id}/line-items`, newLine)).status).toBe(403);
      expect(await linesOf(job.id)).toBe(0);
    });

    it('reaches only the jobs in the holder\'s Jobs scope', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { edit_job_line_items: true, jobs_scope: 'attached' }, { base: 'TECHNICIAN' });
      const outside = await fx.addJob(org, customer, { createdBy: me.id, crew: [admin.id] });
      const res = await (await me.api()).post(`/api/jobs/${outside.id}/line-items`, newLine);
      expect([403, 404]).toContain(res.status);
      expect(await linesOf(outside.id)).toBe(0);
    });
  });

  describe('Assign people to jobs', () => {
    // Every door that changes a people field on a job.
    type Door = { name: string; run: (api: Api, job: { id: string; visitId?: string }, target: Person) => Promise<{ status: number }> };
    const doors: Door[] = [
      { name: 'assign', run: (api, job, target) => api.post(`/api/jobs/${job.id}/assign`, { assignee_ids: [target.id] }) },
      { name: 'unassign', run: (api, job) => api.post(`/api/jobs/${job.id}/unassign`, {}) },
      { name: 'set the job crew', run: (api, job, target) => api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [target.id] }) },
      { name: 'set a visit crew', run: (api, job, target) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [target.id] }) },
      { name: 'set the dispatcher', run: (api, job, target) => api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: target.id }) },
      {
        name: 'bulk assign',
        run: async (api, job, target) => {
          const res = await api.post('/api/jobs/bulk-assign', { ids: [job.id], assignee_ids: [target.id] });
          // The batch answers 200 whatever happened to each job; a refused job is in `failed`.
          const body = (res as unknown as { body: { failed?: unknown[] } }).body;
          return { status: res.status === 200 && (body.failed?.length ?? 0) > 0 ? 403 : res.status };
        },
      },
    ];

    it('refuses every door without the switch and lets it in with it, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      // A Dispatcher-eligible person to name, and the switch that lets the holder name someone other than themself.
      const target = await fx.addUser(org, `target${++sequence}`, 'DISPATCHER');
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { assign_people_to_jobs: false, assign_work_to_others: true }, { base });
        const withIt = await personWith(org, { assign_people_to_jobs: true, assign_work_to_others: true }, { base });
        for (const door of doors) {
          const refusedJob = await fx.addJob(org, customer, { crew: [target.id] });
          const refused = await door.run(await without.api(), refusedJob, target);
          expect(refused.status, `${base} ${door.name} without`).toBe(403);

          const allowedJob = await fx.addJob(org, customer, { crew: [target.id] });
          const allowed = await door.run(await withIt.api(), allowedJob, target);
          expect(allowed.status, `${base} ${door.name} with`).toBe(200);
        }
      }
    });

    it('keeps whatever people the request names off the job for a person without the switch, and accepts a job a holder saves with nobody on it', async () => {
      const { org, customer } = await fx.newOrg();
      const named = await fx.addUser(org, `named${++sequence}`, 'DISPATCHER');
      const location = await db.serviceLocation.create({
        data: { customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
      });
      const body = { customer_id: customer, service_location_id: location.id };
      const storedOf = (id: string) => db.job.findUniqueOrThrow({
        where: { id },
        select: { salesperson_id: true, dispatcher_id: true, visits: { select: { assignees: true } } },
      });
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        // Without the switch the people in the request are ignored: the job holds the creator rule's result (S03.16),
        // which the form's own pre-fill route reports.
        const without = await personWith(org, { edit_jobs: true, create_jobs: true, assign_people_to_jobs: false }, { base });
        const api = await without.api();
        const prefill = (await api.get('/api/jobs/creator-prefill')).body.prefill;
        const created = await api.post('/api/jobs', { ...body, salesperson_id: named.id, sold_by_id: named.id, dispatcher_id: named.id, assignee_ids: [named.id] });
        expect(created.status, `${base} without`).toBe(201);
        const stored = await storedOf(created.body.job.id);
        expect(stored.salesperson_id, `${base} without`).toBe(prefill.sold_by_id);
        expect(stored.dispatcher_id, `${base} without`).toBe(prefill.dispatcher_id);
        expect(stored.visits.flatMap((v) => v.assignees), `${base} without`).toEqual([]);

        // A holder may empty both fields on purpose, and the job is accepted with nobody on it.
        const holder = await personWith(org, { edit_jobs: true, create_jobs: true, assign_people_to_jobs: true }, { base });
        const emptied = await (await holder.api()).post('/api/jobs', { ...body, sold_by_id: null, dispatcher_id: null });
        expect(emptied.status, `${base} holder`).toBe(201);
        const emptyStored = await storedOf(emptied.body.job.id);
        expect(emptyStored.salesperson_id, `${base} holder`).toBeNull();
        expect(emptyStored.dispatcher_id, `${base} holder`).toBeNull();
      }
    });

    it('does not let the creator of a job, with the switch off, put anyone on it', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await fx.addUser(org, `target${++sequence}`, 'DISPATCHER');
      const me = await personWith(org, { assign_people_to_jobs: false, assign_work_to_others: true }, { base: 'TECHNICIAN' });
      const job = await fx.addJob(org, customer, { createdBy: me.id, soldBy: me.id, crew: [me.id] });
      expect((await (await me.api()).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [target.id] })).status).toBe(403);
    });
  });

  describe('Duplicate jobs', () => {
    it('refuses a duplicate without the switch even with Create jobs, and lets it in with it, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { edit_jobs: true, create_jobs: true, duplicate_jobs: false }, { base });
        const withIt = await personWith(org, { edit_jobs: true, create_jobs: true, duplicate_jobs: true }, { base });
        const job = await fx.addJob(org, customer, { crew: [without.id, withIt.id] });
        expect((await (await without.api()).post(`/api/jobs/${job.id}/duplicate`, {})).status, base).toBe(403);
        const allowed = await (await withIt.api()).post(`/api/jobs/${job.id}/duplicate`, {});
        expect(allowed.status, base).toBe(201);
      }
    });

    it('cannot be stored on with Create jobs off: Duplicate jobs needs Create jobs', async () => {
      const { org } = await fx.newOrg();
      await expect(personWith(org, { create_jobs: false, duplicate_jobs: true })).rejects.toThrow(/Create jobs/);
    });
  });
});
