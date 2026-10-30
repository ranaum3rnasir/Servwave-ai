/* =============================================================================
   Spider lead watcher: the sweep on the hosted database's pool (one connection).

   The sweep holds a database-wide lock for its whole run, so two servers never sweep at once. A lock held by a
   transaction pins one pooled connection; the work the sweep does while holding it runs on the app's client, which on
   a pool of ONE has no second connection to use. It then waits out the pool timeout, fails, and (worse) keeps every
   other request waiting for the same single connection while it does. Local and CI URLs carry five connections and hide
   it. These cases run the real sweep on a client with one connection and a short pool timeout.
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

// The sweep opens its lock on a connection of its own, to the same database as the app's client.
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

  it('still refuses to run while another server holds the lock', async () => {
    await watchedCompany();
    const { PrismaClient } = await import('@prisma/client');
    const other = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));
      const holder = other.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('spider.sweep', 0))::text`;
        locked();
        await held;
      }, { timeout: 30_000 });
      await lockTaken;
      const blocked = await runSpiderSweep(T0);
      release();
      await holder;
      expect(blocked.ran).toBe(false);
    } finally {
      await other.$disconnect();
    }
  });
});
