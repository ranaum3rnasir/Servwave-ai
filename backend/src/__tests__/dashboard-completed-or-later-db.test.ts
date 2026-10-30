/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.2 - every dashboard figure that means "the work is done" counts a job in
   Completed, Office review, Ready to close and Done, and Coming Up leaves all of them (and Cancelled) out.

   Everything goes through the public interface: GET /api/dashboard as an admin. Real migrated database
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

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

const ORDER = Object.values(JobStatus);
/** Every status at or past Completed that is still a finished job. */
const COMPLETED_OR_LATER = ORDER.slice(ORDER.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');

type Dashboard = {
  kpis: {
    jobs_today: { completed: number; total: number };
    collected_today: { jobs_done: number };
    jobs_week: { completed: number };
  };
  pipeline: { key: string; value: number }[];
  tech_scoreboard: { user_id: string; jobs: number; revenue: number }[];
  dispatch_scoreboard: { user_id: string; jobs: number; revenue: number }[];
  lead_sources: { source: string; revenue: number }[];
  revenue_by_job_type: { label: string; revenue: number }[];
  jobs_by_status: { key: string; label: string; count: number }[];
  coming_up: { id: string }[];
};

suite('the dashboard counts the whole completed-or-later set as finished work (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  const dashboardOf = async (admin: { id: string; email: string }): Promise<Dashboard> => {
    const res = await (await fx.signedInAs(admin)).get('/api/dashboard');
    expect(res.status).toBe(200);
    // The answer is keyed by tile id (PRD 9); read it back into the figures this suite has always asserted on.
    const data = res.body.data as Record<string, any>;
    return {
      kpis: { jobs_today: data['kpi.jobs_today'], collected_today: data['kpi.collected_today'], jobs_week: data['kpi.jobs_week'] },
      pipeline: data.pipeline,
      tech_scoreboard: data.tech_scoreboard,
      dispatch_scoreboard: data.dispatch_scoreboard,
      lead_sources: data.lead_sources,
      revenue_by_job_type: data.revenue_by_job_type,
      jobs_by_status: data.jobs_by_status,
      coming_up: data.coming_up,
    };
  };

  it.each(COMPLETED_OR_LATER)('counts a job at status %s as completed work on every figure', async (status) => {
    const { org, customer, admin } = await fx.newOrg();
    const crew = await fx.addUser(org, 'crew', 'TECHNICIAN');
    const lead = await fx.addLead(org, customer);
    await db.lead.update({ where: { id: lead.id }, data: { source: 'referral' } });
    const job = await fx.addJob(org, customer, { status, fromLead: lead.id, dispatcher: admin.id });
    await db.estimate.update({ where: { id: job.estimateId! }, data: { job_type: 'locksmith' } });
    await db.job.update({ where: { id: job.id }, data: { completed_at: new Date(), amount_invoiced: 250 } });
    // A trip today, with the crew on it: "Jobs Today" counts a job by its trip, the tech scoreboard by its crew.
    await fx.addVisit(org, { jobId: job.id, crew: [crew.id], daysFromNow: 0 });

    const board = await dashboardOf(admin);

    expect(board.kpis.jobs_today.completed).toBe(1);
    expect(board.kpis.collected_today.jobs_done).toBe(1);
    expect(board.kpis.jobs_week.completed).toBe(1);
    expect(board.pipeline.find((s) => s.key === 'job')!.value).toBe(250);
    expect(board.tech_scoreboard.map((e) => [e.user_id, e.jobs])).toEqual([[crew.id, 1]]);
    expect(board.dispatch_scoreboard.map((e) => [e.user_id, e.jobs])).toEqual([[admin.id, 1]]);
    expect(board.lead_sources.find((s) => s.source === 'referral')!.revenue).toBe(250);
    expect(board.revenue_by_job_type.map((t) => [t.label, t.revenue])).toEqual([['Locksmith', 250]]);
    // The jobs-by-status chart keeps the job in its Completed slice instead of dropping it.
    expect(board.jobs_by_status).toEqual([{ key: 'completed', label: 'Completed', count: 1 }]);
  });

  it('counts the four statuses together, not one of them', async () => {
    const { org, customer, admin } = await fx.newOrg();
    for (const status of COMPLETED_OR_LATER) {
      const job = await fx.addJob(org, customer, { status });
      await db.job.update({ where: { id: job.id }, data: { completed_at: new Date(), amount_invoiced: 100 } });
      await fx.addVisit(org, { jobId: job.id, daysFromNow: 0 });
    }

    const board = await dashboardOf(admin);

    expect(board.kpis.jobs_today.completed).toBe(COMPLETED_OR_LATER.length);
    expect(board.kpis.collected_today.jobs_done).toBe(COMPLETED_OR_LATER.length);
    expect(board.kpis.jobs_week.completed).toBe(COMPLETED_OR_LATER.length);
    expect(board.pipeline.find((s) => s.key === 'job')!.value).toBe(100 * COMPLETED_OR_LATER.length);
    expect(board.jobs_by_status).toEqual([{ key: 'completed', label: 'Completed', count: COMPLETED_OR_LATER.length }]);
  });

  it('leaves a cancelled job out of every completed figure', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const job = await fx.addJob(org, customer, { status: 'CANCELLED' });
    await db.job.update({ where: { id: job.id }, data: { completed_at: new Date(), amount_invoiced: 100 } });
    await fx.addVisit(org, { jobId: job.id, daysFromNow: 0 });

    const board = await dashboardOf(admin);

    expect(board.kpis.jobs_today.completed).toBe(0);
    expect(board.kpis.collected_today.jobs_done).toBe(0);
    expect(board.kpis.jobs_week.completed).toBe(0);
    expect(board.pipeline.find((s) => s.key === 'job')!.value).toBe(0);
    expect(board.jobs_by_status).toEqual([]);
  });

  it('Coming Up leaves out a job in each finished status and a cancelled job, and keeps a live one', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const live = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [] });
    const left: string[] = [];
    for (const status of [...COMPLETED_OR_LATER, 'CANCELLED' as const]) {
      const job = await fx.addJob(org, customer, { status, crew: [] });
      left.push(job.id);
    }

    const board = await dashboardOf(admin);

    const ids = board.coming_up.map((j) => j.id);
    expect(ids).toEqual([live.id]);
    for (const id of left) expect(ids).not.toContain(id);
  });
});
