/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.9 - the Schedule's job feed under Jobs scope Attached.

   Under Jobs scope Attached the feed the Schedule board reads (the jobs list asked for a window of full
   instants) returns only the visits whose crew the person is on. Being a job's Sold By or Dispatcher makes the job
   openable but puts no other crew's visit on the Schedule. Team, Location, All and Through own leads are
   unchanged, and the job page still shows every visit of a job to anyone who can open it.

   Everything goes through the public interface: the routes, called as people on custom roles built from switches
   (never a built-in role name) holding exactly the switch values under test. Real migrated database
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { presetSwitchSet } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

const BASES: Role[] = ['TECHNICIAN', 'SALES', 'DISPATCHER'];

suite('the Schedule job feed under Jobs scope Attached (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding the Dispatcher preset's values with these changed. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `feed-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...presetSwitchSet('DISPATCHER'), view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `f${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The window the board asks for: full instants around the visits the fixture books (a day or two ahead). */
  const boardWindow = () => {
    const after = new Date(Date.now() - 86_400_000).toISOString();
    const before = new Date(Date.now() + 10 * 86_400_000).toISOString();
    return `scheduled_after=${encodeURIComponent(after)}&scheduled_before=${encodeURIComponent(before)}`;
  };

  /** The board's feed: each job in it with the visit ids it carries. */
  async function feed(api: Api) {
    const res = await api.get(`/api/jobs?status=SCHEDULED&status=IN_PROGRESS&status=COMPLETED&${boardWindow()}&limit=500`);
    expect(res.status).toBe(200);
    return new Map<string, string[]>(
      res.body.jobs.map((j: { id: string; visits: { id: string }[] }) => [j.id, j.visits.map((v) => v.id).sort()]),
    );
  }

  /** A job with visit 1 crewed by `first` and visit 2 (later) crewed by `second`. */
  async function twoVisitJob(org: string, customer: string, first: string[], second: string[], opts: { soldBy?: string; dispatcher?: string; fromLead?: string } = {}) {
    const job = await fx.addJob(org, customer, { crew: first, ...opts });
    const visit2 = await fx.addVisit(org, { jobId: job.id, crew: second, daysFromNow: 5, seq: 2 });
    return { id: job.id, visit1: job.visitId!, visit2 };
  }

  describe('Jobs scope Attached', () => {
    it('keeps the visits the person is crewed on and drops the visits crewed by someone else, whatever the role is based on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { jobs_scope: 'attached' }, base);
        const job = await twoVisitJob(org, customer, [me.id], [admin.id]);
        const seen = await feed(await me.api());
        expect(seen.get(job.id), `${base} sees the job with only their own visit`).toEqual([job.visit1]);
      }
    });

    it('leaves a job whose only visits are other people\'s off the board, even when the person is its Sold By or Dispatcher, and still opens the job page with every visit', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const base of BASES) {
        const me = await personWith(org, { jobs_scope: 'attached' }, base);
        const soldBy = await twoVisitJob(org, customer, [admin.id], [admin.id], { soldBy: me.id });
        const dispatching = await twoVisitJob(org, customer, [admin.id], [admin.id], { dispatcher: me.id });
        const api = await me.api();

        const seen = await feed(api);
        expect(seen.has(soldBy.id), `${base} Sold By job on the board`).toBe(false);
        expect(seen.has(dispatching.id), `${base} Dispatcher job on the board`).toBe(false);

        for (const job of [soldBy, dispatching]) {
          const page = await api.get(`/api/jobs/${job.id}`);
          expect(page.status, `${base} job page`).toBe(200);
          expect(page.body.job.visits.map((v: { id: string }) => v.id).sort(), `${base} job page visits`).toEqual([job.visit1, job.visit2].sort());
        }
      }
    });

    it('still lists a Sold By job in the Jobs list, with a date filter of bare days and with none', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached' });
      const job = await twoVisitJob(org, customer, [admin.id], [admin.id], { soldBy: me.id });
      const api = await me.api();
      const today = new Date().toISOString().slice(0, 10);
      const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

      for (const query of ['', `?scheduled_after=${today}&scheduled_before=${later}`]) {
        const res = await api.get(`/api/jobs${query}`);
        expect(res.status).toBe(200);
        const listed = res.body.jobs.find((j: { id: string }) => j.id === job.id);
        expect(listed, `list ${query}`).toBeTruthy();
        expect(listed.visits.map((v: { id: string }) => v.id).sort(), `list ${query}`).toEqual([job.visit1, job.visit2].sort());
      }
    });

    it('takes a visit off the board on the next request once the person is taken off its crew', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached' });
      const job = await twoVisitJob(org, customer, [me.id], [me.id], { soldBy: admin.id });
      const api = await me.api();
      expect((await feed(api)).get(job.id)).toEqual([job.visit1, job.visit2].sort());

      await fx.removeCrew(job.visit2, me.id);
      expect((await feed(api)).get(job.id)).toEqual([job.visit1]);

      await fx.removeCrew(job.visit1, me.id);
      expect((await feed(api)).has(job.id)).toBe(false);
    });

    it('does not mix two visits: a job with the person\'s visit outside the window and another crew\'s inside it is not on the board', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached' });
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      await fx.addVisit(org, { jobId: job.id, crew: [me.id], daysFromNow: 60, seq: 2 });
      expect((await feed(await me.api())).has(job.id)).toBe(false);
    });
  });

  describe('every other scope is unchanged', () => {
    it('shows both visits under All, Team and Location', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const department = await fx.addDepartment(org, 'Field');
      const location = await fx.addLocation(org, 'Yard');
      const me = await personWith(org, { jobs_scope: 'all' });
      const team = await fx.addUser(org, 'team', 'TECHNICIAN', { departmentId: department, locationId: location });
      const job = await twoVisitJob(org, customer, [team.id], [admin.id]);
      const both = [job.visit1, job.visit2].sort();

      expect((await feed(await me.api())).get(job.id), 'All').toEqual(both);

      for (const scope of ['team']) {
        const mate = await personWith(org, { jobs_scope: scope });
        await db.user.update({ where: { id: mate.id }, data: { department_id: department, location_id: location } });
        expect((await feed(await mate.api())).get(job.id), scope).toEqual(both);
      }
    });

    it('shows both visits to a person on Through own leads', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'through_own_leads' }, 'SALES');
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const job = await twoVisitJob(org, customer, [admin.id], [admin.id], { fromLead: lead.id });
      expect((await feed(await me.api())).get(job.id)).toEqual([job.visit1, job.visit2].sort());
    });
  });
});
