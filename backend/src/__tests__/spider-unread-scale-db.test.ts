/* =============================================================================
   #3450: the unread-alerts read checks every open alert against the saved settings (the lead excluded, its stage's
   limit off or lengthened) and must stay cheap at the synthetic big company's scale (Spider once froze the app, #2983):
   5,000 open leads, most of them excluded, and more than 100 open alerts for one person.

   - The same number of queries for 1 open alert as for 140: no per-alert query. The settings are read once, and only
     the listed leads' exclusions, never the whole list.
   - The answer is right at that scale: the alerts of excluded leads are left out, every other one is listed.
   - The request takes under 1 s.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One client for the app and the test, built with the query event log so the query counter can read what it sends.
const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture } from './permission-switches-fixture';
import { countQueries, reads } from './support/query-counter';

const suite = realClient ? describe : describe.skip;

const UNREAD = '/api/ai-farm/spider/alerts/unread';
const HOUR = 3_600_000;
const OPEN_LEADS = 5_000;
const EXCLUDED = 4_000;
/** Open alerts on watched leads, and on excluded ones. */
const WATCHED_ALERTS = 120;
const EXCLUDED_ALERTS = 20;

suite('Spider unread alerts at scale (#3450, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** One unread in-app alert for `recipient` on each of these New leads, entered at `enteredAt`. Two statements. */
  async function alertsOn(org: string, recipient: string, leadIds: string[], enteredAt: Date, createdAt: Date) {
    const ids = leadIds.map(() => randomUUID());
    await db.notification.createMany({
      data: leadIds.map((leadId, i) => ({
        id: ids[i]!, organization_id: org, verb: 'spider.alert', category: 'LEAD' as const, priority: 'FEED' as const,
        object_type: 'LEAD', object_id: leadId, object_label: 'L-1', title: 'Spider',
        data: { lead_number: 'L-1', customer_name: 'Pat Payer', status: 'NEW', status_label: 'New', entered_status_at: enteredAt.toISOString() },
      })),
    });
    await db.notificationRecipient.createMany({
      data: ids.map((id) => ({ notification_id: id, organization_id: org, recipient_id: recipient, priority: 'FEED' as const, created_at: createdAt })),
    });
  }

  it('5,000 open leads, 4,000 excluded, 140 open alerts: right answer, the same queries as for 1 alert, under 1 s', { timeout: 120_000 }, async () => {
    const { org, admin, customer } = await fx.newOrg();
    await db.organization.update({ where: { id: org }, data: { is_demo: true } });
    const enteredAt = new Date(Date.now() - 3 * HOUR);
    const leadIds = Array.from({ length: OPEN_LEADS }, () => randomUUID());
    await db.lead.createMany({
      data: leadIds.map((id, i) => ({
        id, organization_id: org, customer_id: customer, lead_number: `L-${i}`, service_request: 'Fix the door', created_at: enteredAt,
      })),
    });
    const excluded = leadIds.slice(0, EXCLUDED);
    const watched = leadIds.slice(EXCLUDED);
    await db.spiderSettings.create({
      data: {
        organization_id: org, is_active: true, activated_at: new Date(Date.now() - 30 * 24 * HOUR),
        status_limits: {
          NEW: { enabled: true, value: 2, unit: 'HOUR' },
          CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
          WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
        },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: [], user_ids: [], lead_owner: true },
        excluded_lead_ids: excluded,
      },
    });
    const api = await fx.signedInAs(admin);

    /** The request's Spider reads (sign-in and permission reads left out: they do not depend on the alerts). */
    const measure = async () => {
      await api.get(UNREAD); // warm: the sign-in and permission caches
      const started = Date.now();
      const { result, queries } = await countQueries(() => api.get(UNREAD), db);
      const ms = Date.now() - started;
      expect(result.status).toBe(200);
      return { body: result.body, ms, spiderReads: reads(queries, ['notification_recipients', 'notifications', 'leads', 'spider_settings']).length };
    };

    const earlier = new Date(Date.now() - 60_000);
    await alertsOn(org, admin.id, watched.slice(0, 1), enteredAt, earlier);
    const one = await measure();
    expect(one.body.alerts).toHaveLength(1);

    await alertsOn(org, admin.id, watched.slice(1, WATCHED_ALERTS), enteredAt, earlier);
    // The excluded leads' alerts are the newest, so they are among the 100 the list reads (newest first) and are left out.
    await alertsOn(org, admin.id, excluded.slice(0, EXCLUDED_ALERTS), enteredAt, new Date());
    const many = await measure();
    // eslint-disable-next-line no-console
    console.log(`[#3450 scale] spider reads per request: ${many.spiderReads}; 1 alert ${one.ms} ms, 140 alerts ${many.ms} ms`);
    expect(many.body.alerts).toHaveLength(100 - EXCLUDED_ALERTS);
    const listedLeads = new Set(many.body.alerts.map((a: { lead_id: string }) => a.lead_id));
    expect(excluded.some((id) => listedLeads.has(id))).toBe(false);
    expect(many.body.frame).toBe(true);

    expect(many.spiderReads).toBe(one.spiderReads);
    expect(many.ms).toBeLessThan(1_000);
  });
});
