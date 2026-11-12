/* =============================================================================
   #3107: Spider stores each recipient list once, not inside every alert row.

   Seam: the sweep's public entry (runSpiderSweep, which runs the starting summary and the per-lead alerts) on a real
   migrated database. What is stored is read back with plain SQL, because the point is what the rows hold; what a
   person sees (History) is proven over HTTP in spider-recipient-sets-history-db.test.ts.

   1. A list is written once and reused while it is unchanged: two starting summaries, and a per-lead alert after them,
      all told the same people, write ONE set; their alert rows point at it and hold no copy of the list.
   2. A different list is a different set (the owner of a lead was told as `owner`, not as `admin`).
   3. A starting summary's rows leave the message columns empty; a per-lead alert keeps its own messages.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    resendSend: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
    SPIDER_PILOT_ORG_IDS: undefined,
  },
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DAY, HOUR, MIN, T0, addLead, at, removeCompanies, spiderCompany } from './support/spider-company';

const suite = realClient ? describe : describe.skip;


suite('Spider stores each recipient list once (#3107, real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];

  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);

  /** A sweep at `now`, the lease free first. */
  async function sweep(now: Date) {
    await clearLease();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    return runSpiderSweep(now);
  }

  /** The stored recipient lists of a company, by plain SQL. */
  const setsOf = (org: string) =>
    db.$queryRawUnsafe<{ id: string; recipients: { id: string; name: string; email: string; role: string; type: string }[] }[]>(
      `SELECT id, recipients FROM spider_recipient_sets WHERE organization_id = $1::uuid`, org,
    );

  /** What each alert-log row of a company holds about its people and its messages, by plain SQL. */
  const rowsOf = (org: string) =>
    db.$queryRawUnsafe<
      { lead_id: string; kind: string; recipient_set_id: string | null; recipients: unknown; email_subject: string | null; email_body: string | null; sms_message: string | null; in_app_message: string | null }[]
    >(
      `SELECT lead_id, kind, recipient_set_id, recipients, email_subject, email_body, sms_message, in_app_message
         FROM spider_alerts WHERE organization_id = $1::uuid ORDER BY alerted_at, lead_id`, org,
    );

  beforeEach(async () => {
    await clearLease();
    vi.clearAllMocks();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });

  afterAll(async () => {
    await clearLease().catch(() => undefined);
    await removeCompanies(db, orgs);
    await db.$disconnect();
  });

  describe('a list already stored is reused', () => {
    it('two starting summaries told the same people write one set, and their rows hold no copy of the list', async () => {
      const c = await spiderCompany(db, orgs, { leads: 4, trigger: true });
      // Spider watches these four leads at first.
      await sweep(T0);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org, kind: 'SUMMARIZED' } })).toBe(4);

      // Two more leads, past their limit all along, come under watch: a second starting summary, to the same three people.
      await addLead(db, c, at(-2 * DAY - 100 * MIN));
      await addLead(db, c, at(-2 * DAY - 101 * MIN));
      await db.spiderSettings.update({
        where: { organization_id: c.org },
        data: { summary_trigger_at: at(MIN), summary_trigger_since: at(MIN), summary_trigger_kind: 'SCOPE_WIDENED' },
      });
      await sweep(at(10 * MIN));

      const rows = await rowsOf(c.org);
      expect(rows).toHaveLength(6);
      const sets = await setsOf(c.org);
      expect(sets).toHaveLength(1);
      for (const r of rows) {
        expect(r.recipient_set_id).toBe(sets[0]!.id);
        expect(r.recipients).toBeNull();
      }
      // The one stored list is the three people, in the order History lists them (by user id).
      expect(sets[0]!.recipients.map((p) => p.id)).toEqual(c.people.map((p) => p.id).sort());
    });

    it('a per-lead alert after a starting summary, told the same people, reuses the summary\'s set', async () => {
      const c = await spiderCompany(db, orgs, { leads: 3, trigger: true });
      await sweep(T0);
      // A lead created a minute after that sweep, and past its two-hour limit at the next.
      const fresh = await addLead(db, c, at(MIN));
      await sweep(at(3 * HOUR));

      const rows = await rowsOf(c.org);
      expect(rows.map((r) => r.kind).sort()).toEqual(['ALERTED', 'SUMMARIZED', 'SUMMARIZED', 'SUMMARIZED']);
      const sets = await setsOf(c.org);
      expect(sets).toHaveLength(1);
      for (const r of rows) {
        expect(r.recipient_set_id).toBe(sets[0]!.id);
        expect(r.recipients).toBeNull();
      }
    });
  });

  describe('a different list is a different set', () => {
    it('the lead\'s owner is told as the owner: that list is stored apart from the Admins\' list', async () => {
      const c = await spiderCompany(db, orgs, { leads: 2, trigger: false });
      // The first lead is owned by the first Admin, who Spider tells as the owner now; the second has no owner.
      const [owned, unowned] = c.leads as [string, string];
      const owner = c.people.find((p) => p.role === 'ADMIN')!;
      await db.lead.update({ where: { id: owned }, data: { commission_owner_id: owner.id } });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { recipients: { roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true } } });
      await sweep(T0);

      const rows = await rowsOf(c.org);
      expect(rows).toHaveLength(2);
      const setOf = (leadId: string) => rows.find((r) => r.lead_id === leadId)!.recipient_set_id;
      expect(setOf(owned)).not.toBe(setOf(unowned));
      const sets = await setsOf(c.org);
      expect(sets).toHaveLength(2);
      const typeOf = (setId: string | null) => Object.fromEntries(sets.find((s) => s.id === setId)!.recipients.map((p) => [p.id, p.type]));
      expect(typeOf(setOf(owned))[owner.id]).toBe('owner');
      expect(typeOf(setOf(unowned))[owner.id]).toBe('admin');
    });
  });

  describe('the messages', () => {
    it('a starting summary\'s rows leave the message columns empty; a per-lead alert keeps its own messages', async () => {
      const c = await spiderCompany(db, orgs, { leads: 2, trigger: true });
      await sweep(T0);
      // A lead created a minute after that sweep, and past its two-hour limit at the next.
      const fresh = await addLead(db, c, at(MIN));
      await sweep(at(3 * HOUR));

      const rows = await rowsOf(c.org);
      for (const r of rows.filter((x) => x.kind === 'SUMMARIZED')) {
        expect([r.email_subject, r.email_body, r.sms_message, r.in_app_message]).toEqual([null, null, null, null]);
      }
      const [alert] = rows.filter((x) => x.kind === 'ALERTED');
      expect(alert!.email_subject).toContain(`L-${fresh.slice(0, 8)}`);
      expect(alert!.sms_message).toContain(`/leads/${fresh}`);
      expect(alert!.in_app_message).toBeTruthy();
      expect(alert!.recipients).toBeNull();
      expect(alert!.recipient_set_id).not.toBeNull();
    });
  });
});
