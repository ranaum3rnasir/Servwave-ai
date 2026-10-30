/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.12 - per-visit status steps from the server's per-record answer.

   Every visit the job page loads carries `status_steps`: the steps (on my way, arrived, start, finish visit) THIS
   person may take on THAT visit. A step is on the list only with the step's own switch (Mark on my way, Mark arrived,
   Start and finish visits for both Start and Finish visit) AND either a place on that visit's crew or Update any
   visit's status. Update any visit's status never stands in for a step's own switch. The visit routes ask the same
   question, so a step the answer leaves out is a step the route refuses.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
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

suite('per-visit status steps come from the server (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values, with Jobs scope All. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `visit-steps-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A job with two upcoming visits, each with its own crew. */
  async function twoVisitJob(org: string, customer: string, onFirst: string[], onSecond: string[]) {
    const job = await fx.addJob(org, customer, { crew: onFirst });
    const second = await fx.addVisit(org, { jobId: job.id, crew: onSecond, daysFromNow: 5, seq: 2 });
    return { id: job.id, first: job.visitId!, second };
  }

  const allSteps = { mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true };
  const everyStep = ['en-route', 'arrive', 'start', 'complete'];

  /** The steps the list of a job's visits offers this person, by visit id. */
  async function stepsByVisit(api: Api, jobId: string): Promise<Record<string, string[]>> {
    const res = await api.get(`/api/jobs/${jobId}/visits`);
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.visits.map((v: { id: string; status_steps: string[] }) => [v.id, v.status_steps]));
  }

  it('gives a crewed person every step on their own visit and none on a colleague\'s', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
      const me = await personWith(org, { ...allSteps, update_any_visit_status: false }, base);
      const job = await twoVisitJob(org, customer, [me.id], [colleague.id]);
      const steps = await stepsByVisit(await me.api(), job.id);
      expect(steps[job.first], base).toEqual(everyStep);
      expect(steps[job.second], base).toEqual([]);
    }
  });
  it('carries the same answer on the job detail response, per visit', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await twoVisitJob(org, customer, [colleague.id], [me.id]);
    const res = await (await me.api()).get(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.job.visits.map((v: { id: string; status_steps: string[] }) => [v.id, v.status_steps]));
    expect(byId[job.first]).toEqual([]);
    expect(byId[job.second]).toEqual(everyStep);
  });

  it("gives Update any visit's status the steps on other visits, only those whose own switch they hold", async () => {
    const { org, customer } = await fx.newOrg();
    const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const job = await twoVisitJob(org, customer, [crew.id], [crew.id]);
    const cases: { values: Record<string, boolean>; expected: string[] }[] = [
      { values: { ...allSteps }, expected: everyStep },
      { values: { ...allSteps, start_and_finish_visits: false }, expected: ['en-route', 'arrive'] },
      { values: { ...allSteps, mark_on_my_way: false, mark_arrived: false }, expected: ['start', 'complete'] },
      { values: { mark_on_my_way: false, mark_arrived: false, start_and_finish_visits: false }, expected: [] },
    ];
    for (const { values, expected } of cases) {
      const me = await personWith(org, { ...values, update_any_visit_status: true });
      const steps = await stepsByVisit(await me.api(), job.id);
      expect(steps[job.first], JSON.stringify(values)).toEqual(expected);
      expect(steps[job.second], JSON.stringify(values)).toEqual(expected);
    }
  });

  it("with Start and finish visits off, a crewed person with Update any visit's status gets no Start and no Finish visit anywhere", async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...allSteps, start_and_finish_visits: false, update_any_visit_status: true });
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const job = await twoVisitJob(org, customer, [me.id], [colleague.id]);
    const steps = await stepsByVisit(await me.api(), job.id);
    expect(steps[job.first]).toEqual(['en-route', 'arrive']);
    expect(steps[job.second]).toEqual(['en-route', 'arrive']);
    const api = await me.api();
    for (const step of ['start', 'complete']) {
      for (const visit of [job.first, job.second]) {
        expect((await api.post(`/api/jobs/${job.id}/visits/${visit}/${step}`, {})).status, `${step} on ${visit}`).toBe(403);
      }
    }
  });

  it('lets the visit routes in exactly where the answer lists the step', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    for (const step of ['en-route', 'arrive', 'start', 'complete']) {
      const job = await twoVisitJob(org, customer, [me.id], [colleague.id]);
      const api = await me.api();
      const listed = await stepsByVisit(api, job.id);
      expect(listed[job.first]).toContain(step);
      expect(listed[job.second]).not.toContain(step);
      expect((await api.post(`/api/jobs/${job.id}/visits/${job.second}/${step}`, {})).status, `${step} on a colleague's visit`).toBe(403);
      expect((await api.post(`/api/jobs/${job.id}/visits/${job.first}/${step}`, {})).status, `${step} on their own visit`).toBe(200);
    }
  });

  it("lets an office user with Update any visit's status press any visit's buttons", async () => {
    const { org, customer } = await fx.newOrg();
    const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const office = await personWith(org, { ...allSteps, update_any_visit_status: true });
    const api = await office.api();
    for (const step of ['en-route', 'arrive', 'start', 'complete']) {
      const job = await twoVisitJob(org, customer, [crew.id], [crew.id]);
      for (const visit of [job.first, job.second]) {
        const res = await api.post(`/api/jobs/${job.id}/visits/${visit}/${step}`, {});
        expect(res.status, `${step} on ${visit}`).toBe(200);
      }
    }
  });

  it('takes the steps away on the next request once the person is off the visit', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...allSteps, update_any_visit_status: false });
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    const api = await me.api();
    expect((await stepsByVisit(api, job.id))[job.visitId!]).toEqual(everyStep);
    await fx.removeCrew(job.visitId!, me.id);
    // Removed from the only visit, the person also loses the job (Jobs scope All keeps it open here), and the steps.
    expect((await stepsByVisit(api, job.id))[job.visitId!]).toEqual([]);
  });
});
