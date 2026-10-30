/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.30 - Done leaves the Jobs list, and the tiles count what they show.

   The list's default view (no status asked for) leaves Done out; the status filter brings it back; top search
   and the customer's page still list it. The Completed and Need Invoices tiles count the completed-or-later
   set, Done included, and each tile's click-through is a filter the server understands that answers with
   exactly the rows the tile counted - for an All-scope person and for an Attached-scope person alike.

   Everything goes through the public interface (HTTP). Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.

   The statuses it walks are read from the job status enum, not from the set under test.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { JobStatus } from '@prisma/client';
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

// Every automation event the app raises is recorded here instead of enrolling anything.
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

const ORDER = Object.values(JobStatus);
/** Every status at or past Completed that is still a finished job. */
const FINISHED: JobStatus[] = ORDER.slice(ORDER.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');
/** Every status that is not finished work: the live ones and Cancelled. */
const NOT_FINISHED = ORDER.filter((s) => !FINISHED.includes(s));

suite('Done leaves the Jobs list and the tiles count what they show (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (on top of the base's preset). */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: 'DISPATCHER' | 'TECHNICIAN' = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `done-default-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** One job at `status` with a trip today (the month tiles count a job by its trip this month), crewed by `crew`. */
  async function jobAt(org: string, customer: string, status: JobStatus, crew: string[] = []) {
    const job = await fx.addJob(org, customer, { status });
    await fx.addVisit(org, { jobId: job.id, daysFromNow: 0, crew });
    return job;
  }

  const ids = (body: { jobs: { id: string }[] }) => body.jobs.map((j) => j.id).sort();

  describe('the default view', () => {
    it('leaves a Done job out of the list and out of its total, and keeps every other status', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const jobs = new Map<JobStatus, string>();
      for (const status of ORDER) jobs.set(status, (await jobAt(org, customer, status)).id);

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?limit=100');

      expect(res.status).toBe(200);
      const expected = ORDER.filter((s) => s !== 'DONE').map((s) => jobs.get(s)!).sort();
      expect(ids(res.body)).toEqual(expected);
      expect(res.body.pagination.total).toBe(expected.length);
    });

    it('keeps the page count right when Done jobs are left out', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (let i = 0; i < 3; i++) await jobAt(org, customer, 'IN_PROGRESS');
      for (let i = 0; i < 4; i++) await jobAt(org, customer, 'DONE');

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?limit=2');

      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.totalPages).toBe(2);
    });

    it('still leaves Done out when the request asks for a status that does not exist', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const open = await jobAt(org, customer, 'SCHEDULED');
      await jobAt(org, customer, 'DONE');

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?status=NOT_A_STATUS');

      expect(ids(res.body)).toEqual([open.id]);
    });

    it('leaves Done out of a search typed in the list, the same as the rest of the list', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');

      const res = await (await fx.signedInAs(admin)).get(`/api/jobs?search=${done.id.slice(0, 8)}`);

      expect(res.body.jobs).toEqual([]);
    });

    it('leaves Done out of the CSV export, which exports what the list shows', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const open = await jobAt(org, customer, 'COMPLETED');
      await jobAt(org, customer, 'DONE');

      const api = await fx.signedInAs(admin);
      expect(ids((await api.get('/api/jobs/export')).body)).toEqual([open.id]);
    });

    it('does not move the live-status tiles', async () => {
      const { org, customer, admin } = await fx.newOrg();
      await jobAt(org, customer, 'UNSCHEDULED');
      await jobAt(org, customer, 'SCHEDULED');
      await jobAt(org, customer, 'IN_PROGRESS');
      await jobAt(org, customer, 'DONE');

      const stats = (await (await fx.signedInAs(admin)).get('/api/jobs')).body.stats;

      expect(stats).toMatchObject({ unassigned: 1, scheduled: 1, in_progress: 1 });
    });
  });

  describe('asking for Done', () => {
    it('lists a Done job under the Done filter, and only Done jobs', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');
      await jobAt(org, customer, 'READY_TO_CLOSE');

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?status=DONE');

      expect(ids(res.body)).toEqual([done.id]);
      expect(res.body.pagination.total).toBe(1);
    });

    it('lists Done beside another status when both are asked for', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');
      const review = await jobAt(org, customer, 'OFFICE_REVIEW');
      await jobAt(org, customer, 'READY_TO_CLOSE');

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?status=DONE&status=OFFICE_REVIEW');

      expect(ids(res.body)).toEqual([done.id, review.id].sort());
    });

    it('lists every job, Done included, to a caller that says it wants them (a picker)', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');
      const open = await jobAt(org, customer, 'SCHEDULED');

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?include_done=true');

      expect(ids(res.body)).toEqual([done.id, open.id].sort());
    });
  });

  describe('where a Done job is still found', () => {
    it('top search finds it', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');
      const number = (await db.job.findUniqueOrThrow({ where: { id: done.id } })).job_number;

      const res = await (await fx.signedInAs(admin)).get(`/api/search?q=${number}`);

      expect(res.status).toBe(200);
      expect((res.body.results.jobs as { id: string }[]).map((j) => j.id)).toContain(done.id);
    });

    it("the customer's page lists it", async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');

      const res = await (await fx.signedInAs(admin)).get(`/api/customers/${customer}/jobs`);

      expect(res.status).toBe(200);
      expect((res.body.jobs as { id: string }[]).map((j) => j.id)).toContain(done.id);
    });
  });

  describe('the Completed and Need Invoices tiles equal the rows their filters show', () => {
    /**
     * A job in each finished status, plus a billed one, a live one and a cancelled one, all with a trip today.
     * `crew` is put on every one of those trips.
     */
    async function seed(org: string, customer: string, crew: string[]) {
      for (const status of FINISHED) await jobAt(org, customer, status, crew);
      const billed = await jobAt(org, customer, 'OFFICE_REVIEW', crew);
      await fx.addInvoice(org, customer, { jobId: billed.id });
      await jobAt(org, customer, 'IN_PROGRESS', crew);
      await jobAt(org, customer, 'CANCELLED', crew);
    }

    async function tilesAgainstRows(api: Api, expectedCompleted: number, expectedNeedInvoices: number) {
      const stats = (await api.get('/api/jobs')).body.stats as { completed: number; need_invoices: number };

      const completedRows = await api.get('/api/jobs?completed_this_month=true&limit=100');
      const needInvoiceRows = await api.get('/api/jobs?needs_invoice=true&limit=100');

      expect(completedRows.status).toBe(200);
      expect(needInvoiceRows.status).toBe(200);
      expect(stats.completed).toBe(expectedCompleted);
      expect(completedRows.body.jobs).toHaveLength(stats.completed);
      expect(completedRows.body.pagination.total).toBe(stats.completed);
      expect(stats.need_invoices).toBe(expectedNeedInvoices);
      expect(needInvoiceRows.body.jobs).toHaveLength(stats.need_invoices);
      expect(needInvoiceRows.body.pagination.total).toBe(stats.need_invoices);
      return { completedRows, needInvoiceRows };
    }

    it('for an All-scope person, with a job in Completed, Office review, Ready to close and Done', async () => {
      const { org, customer, admin } = await fx.newOrg();
      await seed(org, customer, []);

      const { completedRows, needInvoiceRows } = await tilesAgainstRows(
        await fx.signedInAs(admin),
        FINISHED.length + 1, // the finished statuses and the billed one
        FINISHED.length,
      );

      const statuses = (rows: { jobs: { status: string }[] }) => rows.jobs.map((j) => j.status);
      expect(statuses(completedRows.body)).toContain('DONE');
      expect(statuses(needInvoiceRows.body)).toContain('DONE');
      expect(statuses(completedRows.body)).not.toContain('CANCELLED');
      expect(statuses(completedRows.body)).not.toContain('IN_PROGRESS');
    });

    it('for an Attached-scope person, counting only the jobs they are attached to', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_jobs: true, view_invoices: true });
      await seed(org, customer, [me.id]);
      // The same set of jobs, crewed by somebody else: not this person's, so neither counted nor listed.
      await seed(org, customer, [admin.id]);

      const { completedRows } = await tilesAgainstRows(await me.api(), FINISHED.length + 1, FINISHED.length);

      const all = await (await fx.signedInAs(admin)).get('/api/jobs?completed_this_month=true&limit=100');
      expect(all.body.pagination.total).toBe(2 * (FINISHED.length + 1));
      expect(completedRows.body.jobs.map((j: { status: string }) => j.status)).toContain('DONE');
    });

    it('does not count or list a finished job of another company', async () => {
      const mine = await fx.newOrg();
      const other = await fx.newOrg();
      await seed(other.org, other.customer, []);
      await jobAt(mine.org, mine.customer, 'DONE');

      await tilesAgainstRows(await fx.signedInAs(mine.admin), 1, 1);
    });

    it('lists the Completed tile\'s rows from this month only, the way the tile counts', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const thisMonth = await jobAt(org, customer, 'DONE');
      const old = await fx.addJob(org, customer, { status: 'DONE' });
      await fx.addVisit(org, { jobId: old.id, daysFromNow: -90 });

      const api = await fx.signedInAs(admin);
      const rows = await api.get('/api/jobs?completed_this_month=true');

      expect(ids(rows.body)).toEqual([thisMonth.id]);
      expect((await api.get('/api/jobs')).body.stats.completed).toBe(1);
    });

    it('narrows the click-through further when a status is also chosen, never wider than the tile', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const done = await jobAt(org, customer, 'DONE');
      await jobAt(org, customer, 'READY_TO_CLOSE');
      await jobAt(org, customer, 'IN_PROGRESS');

      const rows = await (await fx.signedInAs(admin)).get('/api/jobs?completed_this_month=true&status=DONE&status=IN_PROGRESS');

      expect(ids(rows.body)).toEqual([done.id]);
    });

    it('leaves the Need Invoices count to people who can view invoices, and ignores the filter for the rest', async () => {
      const { org, customer } = await fx.newOrg();
      // The Technician preset holds no invoice switch, so View invoices is off.
      const me = await personWith(org, { jobs_scope: 'all', view_jobs: true }, 'TECHNICIAN');
      await jobAt(org, customer, 'DONE');
      const live = await jobAt(org, customer, 'IN_PROGRESS');

      const res = await (await me.api()).get('/api/jobs?needs_invoice=true');

      expect(res.body.stats.need_invoices).toBeUndefined();
      // Without View invoices the filter is ignored, so the list is the person's default view: Done left out.
      expect(ids(res.body)).toEqual([live.id]);
    });

    it.each(NOT_FINISHED)('the Completed click-through leaves out a job at status %s', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      await jobAt(org, customer, status);

      const rows = await (await fx.signedInAs(admin)).get('/api/jobs?completed_this_month=true');

      expect(rows.body.jobs).toEqual([]);
    });
  });
});
