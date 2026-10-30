/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.15 - Finish visit: one switch, own visit, never completes the job.

   The visit-level finish rides Start and finish visits (the same switch as Start) plus the per-visit crew rule. One
   tap finishes the visit for the whole crew; it never moves the job to Completed, never stamps the job's completion,
   and a service-plan visit's finish does not complete the plan. A cancelled visit is still refused.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

suite('finishing a visit (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const planIds: string[] = [];
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    // The fixture's cleanup knows nothing of service plans, which hold their customer.
    for (const id of planIds) {
      await db.planVisit.deleteMany({ where: { service_plan_id: id } });
      await db.job.deleteMany({ where: { source_plan_id: id } });
      await db.servicePlan.deleteMany({ where: { id } });
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values, with Jobs scope All. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `visit-finish-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const allSteps = { mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true };

  /** A job with two visits, the first started, so each can be finished. */
  async function startedJob(org: string, customer: string, onFirst: string[], onSecond: string[] = []) {
    const job = await fx.addJob(org, customer, { crew: onFirst, status: 'IN_PROGRESS' });
    const second = await fx.addVisit(org, { jobId: job.id, crew: onSecond, daysFromNow: 5, seq: 2 });
    await db.visit.updateMany({ where: { id: { in: [job.visitId!, second] } }, data: { status: 'IN_PROGRESS', started_at: new Date() } });
    return { id: job.id, first: job.visitId!, second };
  }

  const finishPath = (job: string, visit: string) => `/api/jobs/${job}/visits/${visit}/complete`;

  it("refuses a person holding Update any visit's status with Start and finish visits off, crewed or not", async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...allSteps, start_and_finish_visits: false, update_any_visit_status: true });
    const job = await startedJob(org, customer, [me.id], [colleague.id]);
    const api = await me.api();
    expect((await api.post(finishPath(job.id, job.first))).status, 'their own visit').toBe(403);
    expect((await api.post(finishPath(job.id, job.second))).status, "a colleague's visit").toBe(403);
    const rows = await db.visit.findMany({ where: { job_id: job.id } });
    expect(rows.map((v) => v.status)).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
  });

  it("refuses a person with Start and finish visits who is not on the crew and lacks Update any visit's status", async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await startedJob(org, customer, [me.id], [colleague.id]);
    const api = await me.api();
    expect((await api.post(finishPath(job.id, job.second))).status).toBe(403);
    expect((await api.post(finishPath(job.id, job.first))).status).toBe(200);
  });

  it('finishes the visit for every crew member with one tap', async () => {
    const { org, customer } = await fx.newOrg();
    const mate = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await startedJob(org, customer, [me.id, mate.id]);

    expect((await (await me.api()).post(finishPath(job.id, job.first))).status).toBe(200);

    const seenByMate = await (await mate.api()).get(`/api/jobs/${job.id}/visits`);
    expect(seenByMate.status).toBe(200);
    const finished = seenByMate.body.visits.find((v: { id: string }) => v.id === job.first);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.completed_at).toBeTruthy();
    // The crew mate has nothing left to tap on it.
    expect(finished.status_steps).toEqual(expect.any(Array));
    expect(await db.visit.count({ where: { job_id: job.id, status: 'COMPLETED' } })).toBe(1);
  });

  it('leaves the job open after the last open visit is finished: not Completed, no completion stamp', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await fx.addJob(org, customer, { crew: [me.id], status: 'IN_PROGRESS' });
    await db.visit.update({ where: { id: job.visitId! }, data: { status: 'IN_PROGRESS', started_at: new Date() } });

    const res = await (await me.api()).post(finishPath(job.id, job.visitId!));
    expect(res.status).toBe(200);

    const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).not.toBe('COMPLETED');
    expect(after.completed_at).toBeNull();
    const detail = await (await me.api()).get(`/api/jobs/${job.id}`);
    expect(detail.body.job.status).not.toBe('COMPLETED');
    expect(detail.body.job.completed_at).toBeNull();
  });

  it('moves a Scheduled job to In progress when its only visit is finished, and nothing further', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await fx.addJob(org, customer, { crew: [me.id], status: 'SCHEDULED' });

    expect((await (await me.api()).post(finishPath(job.id, job.visitId!))).status).toBe(200);

    const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.completed_at).toBeNull();
  });

  it("does not complete a service plan when a plan visit's job has its visit finished", async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await fx.addJob(org, customer, { crew: [me.id], status: 'IN_PROGRESS' });
    await db.visit.update({ where: { id: job.visitId! }, data: { status: 'IN_PROGRESS', started_at: new Date() } });
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    const plan = randomUUID();
    planIds.push(plan);
    await db.servicePlan.create({
      data: {
        id: plan, organization_id: org, customer_id: customer, service_location_id: row.service_location_id,
        service_plan_number: `SP-${plan.slice(0, 8)}`, name: 'Plan', status: 'ACTIVE', visit_cadence: 'MONTHLY',
        start_date: new Date(), contract_price: 100, sold_by: admin.id,
      },
    });
    await db.job.update({ where: { id: job.id }, data: { source_plan_id: plan } });
    await db.planVisit.create({
      data: { organization_id: org, service_plan_id: plan, job_id: job.id, visit_number: 1, scheduled_date: new Date() },
    });

    expect((await (await me.api()).post(finishPath(job.id, job.visitId!))).status).toBe(200);

    const planVisit = await db.planVisit.findFirstOrThrow({ where: { service_plan_id: plan } });
    expect(planVisit.status).toBe('SCHEDULED');
    expect(planVisit.completed_at).toBeNull();
    expect((await db.servicePlan.findUniqueOrThrow({ where: { id: plan } })).status).toBe('ACTIVE');
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).completed_at).toBeNull();
  });

  it('still refuses a cancelled visit', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    await db.visit.update({ where: { id: job.visitId! }, data: { status: 'CANCELLED', cancelled_at: new Date() } });

    const res = await (await me.api()).post(finishPath(job.id, job.visitId!));
    expect(res.status).toBe(409);
    expect((await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } })).status).toBe('CANCELLED');
  });
});
