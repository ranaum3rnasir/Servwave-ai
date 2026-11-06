/* =============================================================================
   JOBS_PAUSED (#3109, Spider phase 1) on the Spider sweep, real app, real migrated database.

   Seam (agreed with Ran): the sweep and job entry points with JOBS_PAUSED set and unset. The sweep job is started through the
   door the server uses (`scheduleJob`, lib/scheduleJob.ts) around `runSpiderSweep`, and run now instead of at its clock time.
   The table over every job name, with probes, is jobs-paused.test.ts.

   "Reads nothing" is measured, not assumed: the query counter (support/query-counter.ts) counts what the database
   is really sent on BOTH of the app's database clients, the users' and the jobs'. Each count sits beside the same run unpaused,
   which is counted too, so a counter that saw nothing could not pass for a paused job.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  // The app's clients (users' and jobs') are built from DATABASE_URL when lib/prisma is first imported.
  if (dbUrl) {
    process.env.DATABASE_URL = dbUrl;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

// The app's config points at the same test database. Every other value is the shared test env.
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL } };
});

// The app runs on the real client module (setup.ts gives every suite a mocked one).
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());

// The fee sweep is the real one too (setup.ts gives every suite a stub): its boot run must really read the database for the control.
vi.unmock('../lib/reconcile-stripe-fees');

import { env } from '../config/env';
import { logger } from '../lib/logger';
import { switchFixture } from './permission-switches-fixture';
import { countQueries } from './support/query-counter';

const suite = adminClient ? describe : describe.skip;

const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';
const MY_SUMMARY = '/api/ai-farm/spider/summary';

// The setting is read through the app's configuration (config/env.ts, mocked above to point at the test database).
const originalPaused = env.JOBS_PAUSED;
const setPaused = (value: string | undefined) => {
  if (value === undefined) delete env.JOBS_PAUSED;
  else env.JOBS_PAUSED = value;
};

suite('JOBS_PAUSED on the Spider sweep (real database)', () => {
  const db = adminClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let scheduleJob: typeof import('../lib/scheduleJob').scheduleJob;
  let runJobAtBoot: typeof import('../lib/scheduleJob').runJobAtBoot;
  let runUnscoped: typeof import('../lib/tenant-context').runUnscoped;
  let sweepUncapturedFees: typeof import('../lib/reconcile-stripe-fees').sweepUncapturedFees;
  let runSpiderSweep: typeof import('../services/spider/sweep').runSpiderSweep;
  let runAutomationTick: typeof import('../services/automations/cron').runAutomationTick;
  let usersClient: PrismaClient;
  let jobsClient: PrismaClient;

  beforeAll(async () => {
    await import('../app.js');
    ({ scheduleJob, runJobAtBoot } = await import('../lib/scheduleJob.js'));
    ({ runUnscoped } = await import('../lib/tenant-context.js'));
    ({ sweepUncapturedFees } = await import('../lib/reconcile-stripe-fees.js'));
    ({ runSpiderSweep } = await import('../services/spider/sweep.js'));
    ({ runAutomationTick } = await import('../services/automations/cron.js'));
    ({ prisma: usersClient } = await import('../lib/prisma.js'));
    ({ prismaJobs: jobsClient } = await import('../lib/prismaJobs.js'));
  }, 120_000);
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setPaused(originalPaused));
  afterAll(() => fx.cleanup());

  /** The sweep job exactly as index.ts starts it (name and entry), run now instead of at its clock time. */
  async function runSweepJob(now?: Date) {
    const job = scheduleJob('spider', '0 0 1 1 *', () => runSpiderSweep(now));
    try {
      await job.execute();
    } finally {
      await job.destroy();
    }
  }

  /** The automations job as index.ts starts it, run now. */
  async function runAutomationsJob() {
    const job = scheduleJob('automations', '0 0 1 1 *', () => runAutomationTick());
    try {
      await job.execute();
    } finally {
      await job.destroy();
    }
  }

  /** How many queries `run` sends in all: on the jobs' lines (where a job's queries go) and on the users' lines. */
  async function queriesSent(run: () => Promise<unknown>) {
    let onUsers = 0;
    const onJobs = await countQueries(async () => {
      onUsers = (await countQueries(run, usersClient)).count;
    }, jobsClient);
    return { onJobs: onJobs.count, onUsers };
  }

  const pausedLines = () => vi.mocked(logger.info).mock.calls.map((c) => String(c[0])).filter((l) => /paused/i.test(l));

  /** A company that passes the Spider gate. */
  async function spiderOrg() {
    const o = await fx.newOrg();
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    return o;
  }

  it('JOBS_PAUSED=spider: the sweep logs "paused" and sends no query; the automations job still runs', async () => {
    // Unpaused first, as the control: this run really does read the database, so the counter can see it.
    setPaused(undefined);
    const running = await queriesSent(() => runSweepJob());
    expect(running.onJobs + running.onUsers).toBeGreaterThan(0);
    expect(pausedLines()).toEqual([]);

    setPaused('spider');
    const paused = await queriesSent(() => runSweepJob());
    expect(paused).toEqual({ onJobs: 0, onUsers: 0 });
    expect(pausedLines()).toHaveLength(1);
    expect(pausedLines()[0]).toContain('spider');

    // Another job is not paused by that setting.
    const automations = await queriesSent(() => runAutomationsJob());
    expect(automations.onJobs + automations.onUsers).toBeGreaterThan(0);
    expect(pausedLines()).toHaveLength(1);
  });

  it('JOBS_PAUSED=stripe-fees: the fee sweep\'s run at boot is skipped too - paused line logged, no query', async () => {
    // The boot run exactly as index.ts starts it. Unpaused first, as the control: it really reads the database.
    const bootRun = () => runJobAtBoot('stripe-fees', () => runUnscoped(() => sweepUncapturedFees()));
    setPaused(undefined);
    const running = await queriesSent(bootRun);
    expect(running.onJobs + running.onUsers).toBeGreaterThan(0);
    expect(pausedLines()).toEqual([]);

    setPaused('stripe-fees');
    const paused = await queriesSent(bootRun);
    expect(paused).toEqual({ onJobs: 0, onUsers: 0 });
    expect(pausedLines()).toHaveLength(1);
    expect(pausedLines()[0]).toContain('stripe-fees');
  });

  // The journey: an Admin switches Spider on over a backlog; the sweep is paused, then not.
  it('Spider switched on over HTTP: while the sweep is paused nothing is raised for anyone; unpaused, each company is told about its own backlog', async () => {
    const companies = [await spiderOrg(), await spiderOrg()];
    for (const { org, admin, customer } of companies) {
      const api = await fx.signedInAs(admin);
      expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
      const save = await api.put(SETTINGS, {
        status_limits: {
          NEW: { enabled: true, value: 2, unit: 'HOUR' },
          CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
          WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
        },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
        watch_all_leads: true,
        selected_lead_ids: [],
      });
      expect(save.status).toBe(200);
      const backlog = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: backlog.id }, data: { created_at: new Date(Date.now() - 5 * 3_600_000) } });
    }
    const orgIds = companies.map((c) => c.org);
    const raised = () => db.spiderAlert.count({ where: { organization_id: { in: orgIds } } });
    // Past the starting summary's quiet period.
    const later = new Date(Date.now() + 15 * 60_000);

    setPaused('spider');
    await runSweepJob(later);
    expect(await raised()).toBe(0);
    for (const { admin } of companies) {
      expect((await (await fx.signedInAs(admin)).get(MY_SUMMARY)).body).toEqual({ summary: null });
    }
    expect(pausedLines()).toHaveLength(1);

    setPaused(undefined);
    await runSweepJob(later);
    expect(await raised()).toBeGreaterThanOrEqual(2);
    for (const { org, admin, customer } of companies) {
      const mine = await (await fx.signedInAs(admin)).get(MY_SUMMARY);
      expect(mine.status).toBe(200);
      const backlogLeads = await db.lead.findMany({ where: { organization_id: org, customer_id: customer }, select: { id: true } });
      expect(mine.body.summary.leads.map((l: { lead_id: string }) => l.lead_id)).toEqual(backlogLeads.map((l) => l.id));
    }
  });
});
