/* =============================================================================
   Spider sweep lease (#2993): one sweep at a time across servers, with no transaction held for the run.

   A run claims the lease row (spider_sweep_leases) with an expiry, renews it while it works, and gives it up at the
   end. A run that finds the lease held by a live run elsewhere does nothing. A lease left behind by a run that was
   killed is taken over once it has expired. A run that loses its lease (taken over, or expired because no renewal
   got through) stops before its next alert and its next company, so two runs never work side by side.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Each alert's email step is wrapped, not faked:
   the wrapper lets a case act at the exact moment the run is between two alerts. (It wrapped the in-app emit until
   #2990 moved every alert's in-app record to one write at the end of the company's run.) Every org it creates is
   removed again, and the lease row is cleared after every case.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, hook } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    /** Runs (awaited) just before each alert's email step, with the alert's company. */
    hook: { beforeAlert: null as null | ((orgId: string) => Promise<void>) },
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
  },
}));
vi.mock('../services/spider/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/spider/delivery')>();
  return {
    ...actual,
    // No email provider is set up here, so the real step records "not set up" and sends nothing.
    deliverSpiderEmails: vi.fn(async (args: Parameters<typeof actual.deliverSpiderEmails>[0]) => {
      if (hook.beforeAlert) await hook.beforeAlert(args.orgId);
      return actual.deliverSpiderEmails(args);
    }),
  };
});

import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE, _setSweepLeaseTiming, claimSweepLease } from '../services/spider/sweepLease';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

suite('Spider sweep lease (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];

  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);
  const leaseRow = async () =>
    (await db.$queryRawUnsafe<{ holder: string; live: boolean }[]>(
      `SELECT holder, expires_at > now() AS live FROM spider_sweep_leases WHERE name = $1`,
      SPIDER_SWEEP_LEASE,
    ))[0];
  /** Another server's lease, live for `ms` from now (negative: expired that long ago). */
  const otherServerHolds = (holder: string, ms: number) =>
    db.$executeRawUnsafe(
      `INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at)
       VALUES ($1, $2, now(), now() + make_interval(secs => $3::double precision))
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at`,
      SPIDER_SWEEP_LEASE, holder, ms / 1000,
    );

  beforeEach(async () => {
    // Every run sweeps every company with settings: one this file left switched on would alert inside a later case.
    if (orgs.length) await db.spiderSettings.updateMany({ where: { organization_id: { in: orgs } }, data: { is_active: false } });
    await clearLease();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    hook.beforeAlert = null;
    _setSweepLeaseTiming();
    await clearLease();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.spiderSettings.deleteMany({ where: { organization_id: org } }));
      for (const table of ['spider_alerts', 'notifications', 'timeline_events', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await clearLease().catch(() => undefined);
    await db.$disconnect();
  });

  /** A demo company watching New leads for 2 hours, in-app alerts and email (no provider set up here, so nothing is sent), with an admin and `leads` leads a day in New. */
  async function watchedCompany(leads: number, org: string = randomUUID()) {
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-lease-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', plan: 'SCALE', is_demo: true,
      },
    });
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    for (let i = 0; i < leads; i += 1) {
      const id = randomUUID();
      await db.lead.create({
        data: {
          id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
          status: 'NEW', created_at: new Date(T0.getTime() - 24 * HOUR),
        },
      });
    }
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org,
        is_active: true,
        activated_at: new Date(T0.getTime() - 60 * 24 * HOUR),
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: { in_app: true, red_frame: true, email: true, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
        watch_all_leads: true,
        selected_lead_ids: [],
      },
    });
    return org;
  }

  /** An open (unread) Spider record for the company's admin, as an earlier alert leaves it. Returns its id. */
  async function openSpiderRecord(org: string): Promise<string> {
    const admin = await db.user.findFirstOrThrow({ where: { organization_id: org }, select: { id: true } });
    const n = await db.notification.create({
      data: {
        organization_id: org, actor_id: null, verb: 'spider.frame', category: 'LEAD', priority: 'FEED', needs_action: false,
        object_type: 'LEAD', object_id: randomUUID(), object_label: 'L-open', title: 'Lead L-open', body: 'Still open',
        data: {}, dedup_key: `spider.frame:${randomUUID()}`,
      },
      select: { id: true },
    });
    await db.notificationRecipient.create({ data: { notification_id: n.id, organization_id: org, recipient_id: admin.id, priority: 'FEED' } });
    return n.id;
  }
  const isRead = async (notificationId: string) =>
    (await db.notificationRecipient.findFirstOrThrow({ where: { notification_id: notificationId }, select: { read_at: true } })).read_at !== null;

  const alertCount = (orgIds: string[]) => db.spiderAlert.count({ where: { organization_id: { in: orgIds } } });

  /** Calls `fn` once, at the first alert of one of these companies. */
  function atFirstAlertOf(orgIds: string[], fn: () => Promise<void>) {
    let fired = false;
    hook.beforeAlert = async (orgId) => {
      if (fired || !orgIds.includes(orgId)) return;
      fired = true;
      await fn();
    };
  }

  const loggedText = () =>
    JSON.stringify((['info', 'warn', 'error'] as const).flatMap((level) => vi.mocked(logger[level]).mock.calls));

  describe('one run at a time', () => {
    it('two servers sweeping at once: only one does the work, the other exits quietly', async () => {
      const org = await watchedCompany(2);
      // The second server: its own copy of the sweep module (its own in-process guard), on the same database.
      vi.resetModules();
      const second = await import('../services/spider/sweep.js');
      let secondResult: Awaited<ReturnType<typeof second.runSpiderSweep>> | undefined;
      // While the first run is between its alerts, the second server's sweep starts and must find the lease taken.
      atFirstAlertOf([org], async () => {
        secondResult = await second.runSpiderSweep(T0);
      });

      const first = await runSpiderSweep(T0);

      expect(first.ran).toBe(true);
      expect(secondResult?.ran).toBe(false);
      expect(await alertCount([org])).toBe(2);
      expect(loggedText()).not.toContain('sweep failed');
    });

    it('exactly one of many claims made at the same moment gets the lease', async () => {
      const claims = await Promise.all(Array.from({ length: 8 }, () => claimSweepLease()));
      const won = claims.filter((c) => c !== null);
      try {
        expect(won).toHaveLength(1);
        expect((await leaseRow())?.holder).toBe(won[0]!.holder);
      } finally {
        for (const c of won) await c!.release();
      }
      expect(await leaseRow()).toBeUndefined();
    });

    it('does nothing while another server holds a live lease, and leaves that lease alone', async () => {
      const org = await watchedCompany(1);
      await otherServerHolds('other-server', 60_000);

      const result = await runSpiderSweep(T0);

      expect(result.ran).toBe(false);
      expect(await alertCount([org])).toBe(0);
      expect(await leaseRow()).toEqual({ holder: 'other-server', live: true });
      expect(loggedText()).toContain('another server is running the sweep');
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('takes over a lease left by a killed run once it has expired, and gives it up at the end', async () => {
      const org = await watchedCompany(1);
      await otherServerHolds('killed-run', -1_000);

      const result = await runSpiderSweep(T0);

      expect(result.ran).toBe(true);
      expect(await alertCount([org])).toBe(1);
      expect(await leaseRow()).toBeUndefined();
    });

    it('gives the lease up at the end of a run, so the next run on any server can claim it', async () => {
      const org = await watchedCompany(1);
      expect((await runSpiderSweep(T0)).ran).toBe(true);
      expect(await leaseRow()).toBeUndefined();
      const next = await claimSweepLease();
      expect(next).not.toBeNull();
      await next!.release();
      expect(await alertCount([org])).toBe(1);
    });
  });

  describe('while it works', () => {
    it('holds no database transaction open during the run', async () => {
      const org = await watchedCompany(1);
      let openTransactions = -1;
      atFirstAlertOf([org], async () => {
        // Nothing of the sweep's is in flight at this point: any open transaction would be one held for the run.
        const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
        );
        openTransactions = row.n;
      });

      expect((await runSpiderSweep(T0)).ran).toBe(true);
      expect(openTransactions).toBe(0);
    });

    it('renews its lease while it works, so a run longer than the lease still finishes', async () => {
      _setSweepLeaseTiming({ ttlMs: 800, renewEveryMs: 100 });
      const org = await watchedCompany(3);
      let mid: { holder: string; live: boolean } | undefined;
      // One slow alert, twice the lease's length: only renewals keep the run's lease alive through it.
      atFirstAlertOf([org], async () => {
        await sleep(1_600);
        mid = await leaseRow();
      });

      const result = await runSpiderSweep(T0);

      expect(result.ran).toBe(true);
      expect(mid?.live).toBe(true);
      expect(await alertCount([org])).toBe(3);
      expect(loggedText()).not.toContain('lease lost');
    });

    it('a run whose lease is taken over stops before its next alert and its next company, and leaves the new lease alone', async () => {
      _setSweepLeaseTiming({ ttlMs: 60_000, renewEveryMs: 100 });
      // The sweep goes through companies in id order: `a` (three overdue leads) first, then `b`, a company switched off
      // with an alert still open, which any run that reaches `b` ends (a switched-off company keeps no open alert).
      const [first, second] = [randomUUID(), randomUUID()].sort();
      const a = await watchedCompany(3, first);
      const b = await watchedCompany(0, second);
      await db.spiderSettings.update({ where: { organization_id: b }, data: { is_active: false } });
      const openRecord = await openSpiderRecord(b);
      // At the first alert, another server takes the lease over (as it could after this run's lease expired), then
      // the run's next renewal finds the lease is no longer its own.
      atFirstAlertOf([a], async () => {
        await otherServerHolds('other-server', 5 * 60_000);
        await sleep(400);
      });

      const result = await runSpiderSweep(T0);

      expect(result.ran).toBe(true);
      // The alert already under way finishes; nothing after it starts, in this company or the next.
      expect(await alertCount([a])).toBe(1);
      expect(await isRead(openRecord)).toBe(false);
      expect(await leaseRow()).toEqual({ holder: 'other-server', live: true });
      expect(loggedText()).toContain('lease lost');

      // Once the lease is free again, the next run does both.
      await clearLease();
      _setSweepLeaseTiming();
      expect((await runSpiderSweep(T0)).ran).toBe(true);
      expect(await alertCount([a])).toBe(3);
      expect(await isRead(openRecord)).toBe(true);
    });

    it('a run whose lease ran out while it was slow (no renewal got through) stops before its next alert', async () => {
      _setSweepLeaseTiming({ ttlMs: 1_500, renewEveryMs: 60_000 });
      const org = await watchedCompany(3);
      atFirstAlertOf([org], () => sleep(1_600));

      const result = await runSpiderSweep(T0);

      expect(result.ran).toBe(true);
      expect(await alertCount([org])).toBe(1);
      expect(loggedText()).toContain('lease lost');

      // Nothing is lost: the next run alerts the rest.
      _setSweepLeaseTiming();
      expect((await runSpiderSweep(T0)).ran).toBe(true);
      expect(await alertCount([org])).toBe(3);
    });
  });
});
