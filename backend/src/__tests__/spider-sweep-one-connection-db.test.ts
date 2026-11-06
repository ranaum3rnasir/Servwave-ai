/* =============================================================================
   Spider lead watcher: the sweep on the hosted database's pool (one connection).

   The deployed pool holds ONE connection. The sweep once held a database-wide lock in a transaction for its whole run,
   which pinned a connection: the work could then never run on the app's client, so it took a second, private client.
   Since #2993 one run at a time is kept by a lease ROW instead (services/spider/sweepLease.ts): claimed, renewed and
   given up in single statements, so no transaction is held and the whole run, its renewals included, shares the app's
   one client and its single connection. Local and CI URLs carry five connections and would hide a run that needed a
   second one. These cases run the real sweep on a client with one connection and a short pool timeout.
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const clientPromise = vi.hoisted(async () => {
  const { oneConnectionClient } = await import('./one-connection-client.js');
  return oneConnectionClient(process.env.TEST_DATABASE_URL);
});

vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
  },
}));

import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE, _setSweepLeaseTiming } from '../services/spider/sweepLease';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T12:00:00.000Z');

suite('Spider sweep on a one-connection pool (real database)', () => {
  let db: PrismaClient;
  const orgs: string[] = [];

  beforeAll(async () => {
    db = (await clientPromise) as PrismaClient;
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
    await db.$disconnect();
  });

  /** A demo company watching New leads for 2 hours, with an admin to alert and a lead that has sat in New for a day. */
  async function watchedCompany() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-pool-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', plan: 'SCALE', is_demo: true,
      },
    });
    for (const g of DEFAULT_GRANTS) {
    }
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const lead = randomUUID();
    await db.lead.create({
      data: {
        id: lead, organization_id: org, customer_id: customer, lead_number: `L-${lead.slice(0, 8)}`, service_request: 'Fix the door',
        status: 'NEW', created_at: new Date(T0.getTime() - 24 * HOUR),
      },
    });
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org,
        is_active: true,
        activated_at: new Date(T0.getTime() - 60 * 24 * HOUR),
        status_limits: {
          NEW: { enabled: true, value: 2, unit: 'HOUR' },
          CONTACTED: off, WALKTHROUGH_SCHEDULED: off, WALKTHROUGH_COMPLETED: off, ESTIMATED: off,
        },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
        watch_all_leads: true,
        selected_lead_ids: [],
      },
    });
    return { org, lead };
  }

  it('runs to the end and alerts, instead of waiting for a second connection that never comes', async () => {
    const { org, lead } = await watchedCompany();

    const result = await runSpiderSweep(T0);

    expect(result.ran).toBe(true);
    expect(result.alertsSent).toBeGreaterThanOrEqual(1);
    expect(await db.spiderAlert.count({ where: { organization_id: org, lead_id: lead } })).toBe(1);
  });

  it('still refuses to run while another server holds the lease', async () => {
    const { org } = await watchedCompany();
    await db.$executeRawUnsafe(
      `INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at) VALUES ($1, 'other-server', now(), now() + interval '1 minute')
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at`,
      SPIDER_SWEEP_LEASE,
    );
    try {
      const blocked = await runSpiderSweep(T0);
      expect(blocked.ran).toBe(false);
      expect(await db.spiderAlert.count({ where: { organization_id: org } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);
    }
  });

  it('renews its lease on the same single connection while it works, and gives it up at the end', async () => {
    // Renewals every 50 ms against a 1 s lease, over a run that alerts several leads: each renewal queues for the one
    // connection between the sweep's own queries, and the run still finishes with every alert.
    _setSweepLeaseTiming({ ttlMs: 1_000, renewEveryMs: 50 });
    try {
      const { org } = await watchedCompany();
      for (let i = 0; i < 5; i += 1) {
        const lead = await db.lead.findFirstOrThrow({ where: { organization_id: org }, select: { customer_id: true } });
        await db.lead.create({
          data: {
            id: randomUUID(), organization_id: org, customer_id: lead.customer_id, lead_number: `L-extra-${i}-${org.slice(0, 4)}`,
            service_request: 'Fix the door', status: 'NEW', created_at: new Date(T0.getTime() - 24 * HOUR),
          },
        });
      }
      const result = await runSpiderSweep(T0);
      expect(result.ran).toBe(true);
      expect(await db.spiderAlert.count({ where: { organization_id: org } })).toBe(6);
      expect(await db.$queryRawUnsafe(`SELECT holder FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE)).toEqual([]);
    } finally {
      _setSweepLeaseTiming();
    }
  });
});
