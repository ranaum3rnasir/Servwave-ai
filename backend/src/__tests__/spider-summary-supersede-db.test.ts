/* =============================================================================
   #3108: Switching Spider off and on again replaces the company's starting summary without rewriting the old one, and
   one real journey through the HTTP API.

   Seams (agreed with Ran): the sweep's public entry (runSpiderSweep) on a real migrated database, and the summary as
   History and the bell read it over HTTP. The switch is the real route (PUT /spider/status); nothing is faked but the
   email provider's client and the phone system's client (the boundaries).

   1. The journey: an Admin switches Spider on, the sweep builds the summary, a recipient sees it in the bell and on their
      summary page, and the Admin sees it in History and on the Spider page.
   2. Off and on again: the old summary is marked superseded and every row of its claims is exactly the row it was (a
      row rewritten gets a new row version, so the count of old rows whose version changed is the count of rows
      rewritten); the Spider page and the person's summary page show only the new one, and the new one is READY.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = dbUrl;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } } as import('@prisma/client').Prisma.PrismaClientOptions) : undefined, resendSend: vi.fn() };
});

vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL,
      FRONTEND_URL: 'https://staging.app.test',
      RESEND_API_KEY: 're_test_key',
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { runOnJobsClient } from '../lib/prismaJobs';
import { switchFixture } from './permission-switches-fixture';
import { runSpiderSweep } from '../services/spider/sweep';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { MIN, T0, removeCompanies, spiderCompany } from './support/spider-company';
import { STATUS, adminView, clearLease, onlyThisCompany, personView } from './support/spider-summary-world';

const suite = adminClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LEADS = 5_000;

suite('the starting summary through switching Spider on, and off and on again (#3108, real database)', () => {
  const db = adminClient as PrismaClient;
  const orgs: string[] = [];
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  /** The sweep, started the way the server's scheduler starts it. */
  const sweepAt = (time: Date) => runOnJobsClient(() => runSpiderSweep(time));

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await clearLease(db).catch(() => undefined);
    await fx.cleanup();
    await removeCompanies(db, orgs);
    await db.$disconnect();
  });
  beforeEach(async () => {
    await clearLease(db);
    vi.clearAllMocks();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });

  const settingsBody = (recipients: object) => ({
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients,
    watch_all_leads: true,
    selected_lead_ids: [],
  });

  it('journey: an Admin switches Spider on, the sweep builds the summary, a recipient sees it in the bell and the Admin in History', async () => {
    const o = await fx.newOrg();
    // The company, its Admin and its customer were made a month ago: before any lead of this test.
    const monthAgo = new Date(Date.now() - 30 * DAY_MS);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true, created_at: monthAgo } });
    await db.user.update({ where: { id: o.admin.id }, data: { created_at: monthAgo } });
    await db.customer.update({ where: { id: o.customer }, data: { created_at: monthAgo } });
    const dispatcher = await fx.addUser(o.org, 'dispatcher', 'DISPATCHER');
    await db.user.update({ where: { id: dispatcher.id }, data: { created_at: monthAgo } });

    const admin = await fx.signedInAs(o.admin);
    expect((await admin.put(STATUS, { isActive: true })).status).toBe(200);
    expect((await admin.put(SETTINGS, settingsBody({ roles: ['DISPATCHER'], user_ids: [], lead_owner: false }))).status).toBe(200);
    // Three leads that entered New five hours ago, against a two-hour limit.
    for (let i = 0; i < 3; i++) {
      const lead = await fx.addLead(o.org, o.customer);
      await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - 5 * HOUR_MS) } });
    }

    // The switch-on is the trigger; the sweep acts once the settings have been quiet for a sweep interval.
    const swept = await sweepAt(new Date(Date.now() + 3 * MIN));
    expect(swept.ran).toBe(true);

    const seen = await personView(await fx.signedInAs(dispatcher));
    expect(seen.mine?.total).toBe(3);
    expect(seen.summaryNotices).toHaveLength(1);
    expect(seen.summaryNotices[0]!.data?.lead_count).toBe(3);
    const view = await adminView(await fx.signedInAs(o.admin));
    expect(view).toMatchObject({ historyTotal: 3, countTotal: 3, exportTotal: 3 });
    expect(view.historyItems.every((i) => i.in_starting_summary)).toBe(true);
    expect(view.card?.total).toBe(3);
    expect(view.card?.id).toBe(seen.mine?.id);
    // It was written as a run of one counted attempt, in a summary that became READY.
    expect(await db.spiderSummaryRun.findMany({ where: { organization_id: o.org }, select: { status: true, attempts: true } })).toEqual([{ status: 'DONE', attempts: 1 }]);
    expect(await db.spiderSummary.findMany({ where: { organization_id: o.org }, select: { status: true } })).toEqual([{ status: 'READY' }]);
  }, 300_000);

  it('off and on again supersedes the old summary without rewriting one of its 5,000 alert rows, and only the new one is shown', async () => {
    const c = await spiderCompany(db, orgs, { leads: LEADS, admins: 2, dispatchers: 1, trigger: true });
    await onlyThisCompany(db, c.org);
    const admin = c.people.find((p) => p.role === 'ADMIN')!;
    const dispatcher = c.people.find((p) => p.role === 'DISPATCHER')!;

    await sweepAt(T0);
    const first = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org, status: 'READY' } });
    expect(first.lead_count).toBe(LEADS);
    const rowVersions = () =>
      db.$queryRawUnsafe<{ id: string; version: string; summary_id: string | null }[]>(
        `SELECT id::text, xmin::text AS version, summary_id::text FROM spider_alerts WHERE organization_id = $1::uuid AND summary_id = $2::uuid ORDER BY id`,
        c.org,
        first.id,
      );
    const before = await rowVersions();
    expect(before).toHaveLength(LEADS);

    // The Admin switches Spider off and on again over HTTP; the sweep, some minutes later, summarizes the new switched-on period.
    const api = await fx.signedInAs(admin);
    expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    await sweepAt(new Date(Date.now() + 3 * MIN));

    const after = await rowVersions();
    expect(after).toEqual(before);
    const summaries = await db.spiderSummary.findMany({ where: { organization_id: c.org }, orderBy: { created_at: 'asc' }, select: { id: true, status: true, lead_count: true } });
    expect(summaries).toEqual([
      { id: first.id, status: 'SUPERSEDED', lead_count: LEADS },
      { id: expect.any(String), status: 'READY', lead_count: LEADS },
    ]);
    const current = summaries[1]!.id;

    const card = await adminView(await fx.signedInAs(admin));
    expect(card.card?.id).toBe(current);
    const mine = await personView(await fx.signedInAs(dispatcher));
    expect(mine.mine?.id).toBe(current);
  }, 900_000);
});
