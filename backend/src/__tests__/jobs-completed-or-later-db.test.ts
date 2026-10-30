/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.3 - the places that ask "is this job's work done?" outside the dashboard
   and the reports count a job in Completed, Office review, Ready to close and Done, and leave Cancelled and the
   live statuses out: the Jobs list tiles and their "needs invoice" rows, the jobs stats, the invoice page's Need
   Invoices count, the service plan's visit slot when a visit job is unassigned, the dialer's open jobs and the
   inventory board's job status.

   Everything goes through the public interface (HTTP, signed in as an admin). Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.

   The statuses it walks are read from the job status enum (everything from Completed on, except Cancelled), not
   from the set under test, so a status added to the enum later is covered without an edit here.
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
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { switchFixture } from './permission-switches-fixture';

const dispatched = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const suite = realClient ? describe : describe.skip;

const ORDER = Object.values(JobStatus);
/** Every status at or past Completed that is still a finished job. */
const FINISHED: JobStatus[] = ORDER.slice(ORDER.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');
/** Every status that is not finished work: the live ones and Cancelled. */
const NOT_FINISHED = ORDER.filter((s) => !FINISHED.includes(s));

type Tiles = Record<string, number | undefined>;

suite('the Jobs list, the stats and the invoice page count the whole completed-or-later set (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** One job at `status` with a trip today (the month tiles count a job by its trip this month). */
  async function jobAt(org: string, customer: string, status: JobStatus, opts: { sourcePlan?: string } = {}) {
    const job = await fx.addJob(org, customer, { status, sourcePlan: opts.sourcePlan });
    await fx.addVisit(org, { jobId: job.id, daysFromNow: 0 });
    return job;
  }

  describe('the Jobs list', () => {
    it.each(FINISHED)('the Completed and Need Invoices tiles count a job at status %s', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      await jobAt(org, customer, status);

      const res = await (await fx.signedInAs(admin)).get('/api/jobs');

      expect(res.status).toBe(200);
      const stats = res.body.stats as Tiles;
      expect(stats.completed).toBe(1);
      expect(stats.need_invoices).toBe(1);
    });

    it.each(NOT_FINISHED)('the Completed and Need Invoices tiles leave out a job at status %s', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      await jobAt(org, customer, status);

      const res = await (await fx.signedInAs(admin)).get('/api/jobs');

      const stats = res.body.stats as Tiles;
      expect(stats.completed).toBe(0);
      expect(stats.need_invoices).toBe(0);
    });

    it('counts the finished statuses together, not one of them', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const status of FINISHED) await jobAt(org, customer, status);

      const stats = (await (await fx.signedInAs(admin)).get('/api/jobs')).body.stats as Tiles;

      expect(stats.completed).toBe(FINISHED.length);
      expect(stats.need_invoices).toBe(FINISHED.length);
    });

    it.each(FINISHED)('a finished job at %s with a live invoice is not counted as needing one', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobAt(org, customer, status);
      await fx.addInvoice(org, customer, { jobId: job.id });

      const stats = (await (await fx.signedInAs(admin)).get('/api/jobs')).body.stats as Tiles;

      expect(stats.completed).toBe(1);
      expect(stats.need_invoices).toBe(0);
    });

    it('the needs-invoice filter lists the jobs the Need Invoices tile counts', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const wanted: string[] = [];
      for (const status of FINISHED) wanted.push((await jobAt(org, customer, status)).id);
      for (const status of NOT_FINISHED) await jobAt(org, customer, status);
      const billed = await jobAt(org, customer, 'OFFICE_REVIEW');
      await fx.addInvoice(org, customer, { jobId: billed.id });

      const res = await (await fx.signedInAs(admin)).get('/api/jobs?needs_invoice=true&limit=100');

      expect(res.status).toBe(200);
      expect((res.body.jobs as { id: string }[]).map((j) => j.id).sort()).toEqual(wanted.sort());
      expect(res.body.stats.need_invoices).toBe(wanted.length);
    });
  });

  describe('GET /api/jobs/stats', () => {
    it('counts a job at each finished status in the completed figure, and only those', async () => {
      const { org, customer, admin } = await fx.newOrg();
      for (const status of FINISHED) await fx.addJob(org, customer, { status });
      for (const status of NOT_FINISHED) await fx.addJob(org, customer, { status });

      const res = await (await fx.signedInAs(admin)).get('/api/jobs/stats');

      expect(res.status).toBe(200);
      expect(res.body.completed).toBe(FINISHED.length);
      expect(res.body.cancelled).toBe(1);
    });
  });

  describe('the invoice page', () => {
    it.each(FINISHED)('Need Invoices counts a job at status %s with no invoice', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      await fx.addJob(org, customer, { status });

      const res = await (await fx.signedInAs(admin)).get('/api/invoices');

      expect(res.status).toBe(200);
      expect(res.body.stats.need_invoices).toBe(1);
    });

    it.each(NOT_FINISHED)('Need Invoices leaves out a job at status %s', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      await fx.addJob(org, customer, { status });

      const res = await (await fx.signedInAs(admin)).get('/api/invoices');

      expect(res.body.stats.need_invoices).toBe(0);
    });

    it('Need Invoices drops a finished job once it has a live invoice', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      await fx.addInvoice(org, customer, { jobId: job.id });

      const res = await (await fx.signedInAs(admin)).get('/api/invoices');

      expect(res.body.stats.need_invoices).toBe(0);
    });
  });

  describe('service plans', () => {
    /** The plan visit's status after an unassign of its job. */
    async function planVisitAfterUnassign(status: JobStatus) {
      const { org, customer, admin } = await fx.newOrg();
      const plan = await fx.addServicePlan(org, customer);
      const job = await jobAt(org, customer, status, { sourcePlan: plan.id });
      const planVisit = await db.planVisit.create({
        data: {
          organization_id: org, service_plan_id: plan.id, job_id: job.id, visit_number: 1,
          scheduled_date: new Date(), status: 'COMPLETED', completed_at: new Date(),
        },
      });

      const res = await (await fx.signedInAs(admin)).post(`/api/jobs/${job.id}/unassign`, {});

      // S06.17: a Done job is unscheduled by no door (it must be reopened first), so the slot is untouched by a refusal.
      expect(res.status).toBe(status === 'DONE' ? 409 : 200);
      return (await db.planVisit.findUniqueOrThrow({ where: { id: planVisit.id } })).status;
    }

    it.each(FINISHED)('unassigning a visit job at %s does not free its plan slot', async (status) => {
      // S06.18: the admin holds Complete jobs, so an unschedule from Office review or Ready to close is a backward move: the job
      // is no longer completed, so its plan visit goes back to Scheduled (booked, not freed). A Completed or Done job is untouched.
      expect(await planVisitAfterUnassign(status)).toBe(status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE' ? 'SCHEDULED' : 'COMPLETED');
    });

    it('unassigning a live visit job still frees its plan slot', async () => {
      expect(await planVisitAfterUnassign('SCHEDULED')).toBe('CANCELLED');
    });
  });

  describe('automations', () => {
    it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'] as const)(
      'completing a %s job raises the job-completed event once, and the job stamps its completed time for the follow-up',
      async (status) => {
        const { org, customer, admin } = await fx.newOrg();
        const job = await fx.addJob(org, customer, { status });
        dispatched.mockClear();

        const res = await (await fx.signedInAs(admin)).post(`/api/jobs/${job.id}/complete`, {});

        expect(res.status).toBe(200);
        const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
        expect(row.status).toBe('OFFICE_REVIEW');
        expect(row.completed_at).not.toBeNull();
        const completedEvents = dispatched.mock.calls.filter(([e]) => e.type === 'JOB_COMPLETED' && e.entity.id === job.id);
        expect(completedEvents).toHaveLength(1);
      },
    );
  });

  describe('automation conditions that test a job status', () => {
    // A "sub-status entered" automation names a sub-status under one job status; the three close-out statuses have to
    // be statuses an org can put labels under, and a job in one of them has to accept its label.
    it.each(ORDER.slice(ORDER.indexOf('OFFICE_REVIEW')).filter((s) => s !== 'CANCELLED'))(
      'a sub-status can be created under %s, set on a job in it, and raises the sub-status-entered event',
      async (parent) => {
        const { org, customer, admin } = await fx.newOrg();
        try {
          const api = await fx.signedInAs(admin);
          const created = await api.post('/api/job-sub-statuses', { parent, label: 'Waiting on the customer' });
          expect(created.status).toBe(201);
          const job = await fx.addJob(org, customer, { status: parent });
          dispatched.mockClear();

          const set = await api.post(`/api/jobs/${job.id}/sub-status`, { sub_status_id: created.body.job_sub_status.id });

          expect(set.status).toBe(200);
          const entered = dispatched.mock.calls.filter(([e]) => e.type === 'JOB_SUB_STATUS_ENTERED' && e.entity.id === job.id);
          expect(entered).toHaveLength(1);
        } finally {
          await db.jobSubStatus.deleteMany({ where: { organization_id: org } });
        }
      },
    );
  });

  describe('the dialer search', () => {
    it.each(FINISHED)('does not offer a job at status %s as an open job', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      await jobAt(org, customer, status);

      const res = await (await fx.signedInAs(admin)).get('/api/communication/dialer-search?q=Payer');

      expect(res.status).toBe(200);
      expect(res.body.customers).toHaveLength(1);
      expect(res.body.customers[0].openJobs).toEqual([]);
    });

    it('still offers a live job', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const live = await jobAt(org, customer, 'IN_PROGRESS');

      const res = await (await fx.signedInAs(admin)).get('/api/communication/dialer-search?q=Payer');

      expect((res.body.customers[0].openJobs as { id: string }[]).map((j) => j.id)).toEqual([live.id]);
    });
  });

  describe('the inventory board', () => {
    it.each(FINISHED)('shows a job at status %s as completed', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobAt(org, customer, status);

      const res = await (await fx.signedInAs(admin)).get('/api/inventory/jobs');

      expect(res.status).toBe(200);
      const row = (res.body.jobs as { id: string; status: string }[]).find((j) => j.id === job.id);
      expect(row?.status).toBe('completed');
    });

    it('still shows a live job as scheduled', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await jobAt(org, customer, 'SCHEDULED');

      const res = await (await fx.signedInAs(admin)).get('/api/inventory/jobs');

      const row = (res.body.jobs as { id: string; status: string }[]).find((j) => j.id === job.id);
      expect(row?.status).toBe('scheduled');
    });
  });
});
