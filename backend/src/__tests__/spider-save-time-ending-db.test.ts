/* =============================================================================
   #3456 + #3469, the real journey over HTTP on a real migrated database: a save that narrows what Spider alerts on ends
   the alerts it no longer covers in the same request, and the check (services/spider/tick.ts) never brings them back.

   An Admin sets Spider up and activates it through the app's own routes; the check alerts an overdue lead; then:
     1. The Admin excludes the lead (PATCH /spider/exclusions): its card is gone when the save answers. Included again
        within seconds: the card does not come back and no second alert goes out (#3450, "once is enough").
     2. The Admin lengthens the New limit past the lead's time in New (PUT /spider/settings): the same, and shortening it
        back brings nothing back.
     3. Switched off, its limit lengthened, switched on again (Skip): the lead was not past the new limit at Activate, so
        the check watches it again and alerts it in the new switched-on period once it crosses (D5).
     4. Activate (Send, then Skip) after an off/on with a lengthened limit: only the stays the new period may still alert
        on their own are watched again; the one past its limit at Activate stays settled and is only in the starting
        summary (Send) or never reported (Skip); one crossing 10 s after Activate alerts on its own (#3468).
     5. While Spider is on, a lead excluded at Activate is included again and a stage switched off at Activate is switched
        on: both are widening saves, so their stays go to the starting summary, never to a per-lead alert; the excluded
        lead's stay is watched again only once it is included; the skipped stay is never reported (#3469).

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL, SPIDER_PILOT_ORG_IDS: undefined } };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { clearLease } from './support/spider-summary-world';
import { runSpiderSweep } from '../services/spider/sweep';
import { _resetSpiderTick, runSpiderTick } from '../services/spider/tick';

const suite = realClient ? describe : describe.skip;

const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';
const EXCLUSIONS = '/api/ai-farm/spider/exclusions';
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

/** A settings save: New watched at `hours`, in-app alerts and the red frame to the Admins, Email and Text off. */
const settingsSave = (hours: number) => ({
  status_limits: {
    NEW: { enabled: true, value: hours, unit: 'HOUR' },
    CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
    WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
  },
  channels: { in_app: true, red_frame: true, email: false, text: false },
  recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
});

suite('a narrowing save ends the alerts it no longer covers, and the check never brings them back (#3456, #3469)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  afterAll(async () => {
    await _resetSpiderTick();
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notifications', 'spider_alerts', 'spider_summaries', 'spider_recipient_sets', 'spider_settings']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
    }
    await fx.cleanup();
  }, 120_000);

  /**
   * A Scale demo company, Spider set up and switched on through the app (nothing overdue at Activate), then a New lead 3
   * hours in New, alerted by the check. Every other company's Spider is switched off (a check covers every company).
   */
  async function alertedLead() {
    const { org, admin, customer } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { is_demo: true } });
    const api = await fx.signedInAs(admin);
    expect((await api.put(SETTINGS, settingsSave(2))).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    await db.spiderSettings.updateMany({ where: { organization_id: { not: org }, is_active: true }, data: { is_active: false } });

    const lead = randomUUID();
    await db.lead.create({
      data: {
        id: lead, organization_id: org, customer_id: customer, lead_number: `L-${lead.slice(0, 8)}`, service_request: 'Fix the door',
        status: 'NEW', created_at: new Date(Date.now() - 3 * HOUR),
      },
    });
    await _resetSpiderTick();
    expect((await runSpiderTick()).claimed).toBe(1);
    expect(await cardsOf(admin)).toEqual([lead]);
    return { org, admin, api, lead };
  }

  /** The leads of the pop-up cards this person's screen shows (the unread-alerts read). */
  async function cardsOf(person: Person): Promise<string[]> {
    const read = await (await fx.signedInAs(person)).get(UNREAD);
    expect(read.status).toBe(200);
    return (read.body.alerts as { lead_id: string }[]).map((a) => a.lead_id);
  }

  const alertsOf = (org: string) => db.spiderAlert.count({ where: { organization_id: org } });

  /** Whether the check still watches the lead's stay (its watch row is pending). */
  const pendingOf = async (lead: string) =>
    (await db.$queryRawUnsafe<{ pending: boolean }[]>(`SELECT pending FROM spider_lead_watch WHERE lead_id = $1::uuid`, lead))[0]!.pending;

  it('excluded: the card is gone when the save answers; included again within seconds, no card comes back and no second alert goes out', async () => {
    const { org, admin, api, lead } = await alertedLead();

    expect((await api.patch(EXCLUSIONS, { exclude: [lead], include: [] })).status).toBe(200);
    expect(await cardsOf(admin)).toEqual([]);
    expect(await db.notificationRecipient.count({ where: { organization_id: org, read_at: null, notification: { object_id: lead } } })).toBe(0);

    expect((await api.patch(EXCLUSIONS, { exclude: [], include: [lead] })).status).toBe(200);
    expect((await runSpiderTick()).claimed).toBe(0);
    expect((await runSpiderTick(new Date(Date.now() + 10_000))).claimed).toBe(0);
    expect(await cardsOf(admin)).toEqual([]);
    expect(await alertsOf(org)).toBe(1);
  });

  it('a limit lengthened past the lead: the card is gone when the save answers; shortened back, nothing comes back', async () => {
    const { org, admin, api } = await alertedLead();

    expect((await api.put(SETTINGS, settingsSave(4))).status).toBe(200);
    expect(await cardsOf(admin)).toEqual([]);

    expect((await api.put(SETTINGS, settingsSave(2))).status).toBe(200);
    expect((await runSpiderTick()).claimed).toBe(0);
    expect(await cardsOf(admin)).toEqual([]);
    expect(await alertsOf(org)).toBe(1);
  });

  it('a save that narrows nothing the alert depends on leaves its card', async () => {
    const { admin, api, lead } = await alertedLead();
    const other = randomUUID();
    const { customer_id, organization_id } = await db.lead.findUniqueOrThrow({ where: { id: lead }, select: { customer_id: true, organization_id: true } });
    await db.lead.create({
      data: { id: other, organization_id, customer_id, lead_number: `L-${other.slice(0, 8)}`, service_request: 'Fix the gate', status: 'NEW' },
    });

    expect((await api.patch(EXCLUSIONS, { exclude: [other], include: [] })).status).toBe(200);
    expect((await api.put(SETTINGS, { ...settingsSave(2), channels: { in_app: true, red_frame: false, email: false, text: false } })).status).toBe(200);
    expect(await cardsOf(admin)).toEqual([lead]);
  });

  it('switched off, its limit lengthened, switched on again: the lead is watched again and alerts in the new period once it crosses', async () => {
    const { org, api, lead } = await alertedLead();
    const watched = async () =>
      (await db.$queryRawUnsafe<{ pending: boolean }[]>(`SELECT pending FROM spider_lead_watch WHERE lead_id = $1::uuid`, lead))[0]!.pending;
    expect(await watched()).toBe(false);

    expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
    expect((await api.put(SETTINGS, settingsSave(4))).status).toBe(200);
    // Not past 4 hours at Activate: nothing to skip, and the lead is watched again.
    expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    expect(await watched()).toBe(true);
    const { activated_at } = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });

    await _resetSpiderTick();
    expect((await runSpiderTick()).claimed).toBe(0);
    // An hour on, it crosses 4 hours in New (counted from when it entered New, #2794).
    expect((await runSpiderTick(new Date(Date.now() + HOUR + 1_000))).claimed).toBe(1);
    const alerts = await db.spiderAlert.findMany({ where: { organization_id: org }, orderBy: { alerted_at: 'asc' } });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ lead_id: lead, kind: 'ALERTED', counted_from: activated_at });
    expect(await watched()).toBe(false);
  });
  describe('Activate after an off/on with a lengthened limit: only the stays the new period may still alert are watched again (#3468)', () => {
    /**
     * A company alerted A (5 h in New) and B (2.5 h in New) at 2 hours, both settled; then Spider was switched off and
     * New lengthened to 3 hours, and C was created to cross 3 hours 10 s after `now0` (Activate comes a moment after).
     */
    async function offAndLengthened() {
      const { org, admin, customer } = await fx.newOrg();
      orgs.push(org);
      await db.organization.update({ where: { id: org }, data: { is_demo: true } });
      const api = await fx.signedInAs(admin);
      expect((await api.put(SETTINGS, settingsSave(2))).status).toBe(200);
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      await db.spiderSettings.updateMany({ where: { organization_id: { not: org }, is_active: true }, data: { is_active: false } });
      const lead = async (createdAt: Date) => {
        const id = randomUUID();
        await db.lead.create({
          data: { id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW', created_at: createdAt },
        });
        return id;
      };
      const now0 = Date.now();
      const A = await lead(new Date(now0 - 5 * HOUR));
      const B = await lead(new Date(now0 - 2.5 * HOUR));
      await _resetSpiderTick();
      expect((await runSpiderTick(new Date(now0))).claimed).toBe(2);
      expect(await pendingOf(A)).toBe(false);
      expect(await pendingOf(B)).toBe(false);
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await api.put(SETTINGS, settingsSave(3))).status).toBe(200);
      const C = await lead(new Date(now0 - 3 * HOUR + 10_000));
      return { org, api, A, B, C, now0 };
    }

    const perLeadRecordsSince = (org: string, lead: string, since: Date) =>
      db.notification.count({ where: { organization_id: org, object_id: lead, verb: { in: ['spider.alert', 'spider.frame'] }, created_at: { gt: since } } });

    it('Send: A stays settled and is only in the starting summary; C alerts on its own at its crossing; B alerts again when it crosses 3 hours', async () => {
      const { org, api, A, B, C, now0 } = await offAndLengthened();
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'send' })).status).toBe(200);
      const Ta = (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).activated_at!;
      // Watched again: B (not past 3 hours at Activate); C was never settled. A, past its limit at Activate, is not.
      expect(await pendingOf(A)).toBe(false);
      expect(await pendingOf(B)).toBe(true);
      expect(await pendingOf(C)).toBe(true);

      await _resetSpiderTick();
      expect((await runSpiderTick(new Date(Ta.getTime() + 5_000))).claimed).toBe(0);
      expect((await runSpiderTick(new Date(now0 + 10_000))).claimed).toBe(1);
      // The first check after Activate (Send) already built the starting summary (#3471: no wait): A only. C alerts on its own.
      const sofar = await db.spiderAlert.findMany({ where: { organization_id: org, counted_from: { gte: Ta } } });
      expect(sofar.filter((a) => a.kind === 'ALERTED').map((a) => a.lead_id)).toEqual([C]);
      expect(sofar.filter((a) => a.kind === 'SUMMARIZED').map((a) => a.lead_id)).toEqual([A]);

      // The starting summary: A only, and no per-lead record of A in this period.
      await clearLease(db);
      await runSpiderSweep(new Date(Ta.getTime() + 3 * MIN));
      const period2 = await db.spiderAlert.findMany({ where: { organization_id: org, counted_from: { gte: Ta } } });
      expect(period2.filter((a) => a.kind === 'SUMMARIZED').map((a) => a.lead_id)).toEqual([A]);
      expect(period2.filter((a) => a.kind === 'ALERTED').map((a) => a.lead_id)).toEqual([C]);
      expect((await runSpiderTick(new Date(Ta.getTime() + 3 * MIN + 1_000))).claimed).toBe(0);
      expect(await perLeadRecordsSince(org, A, Ta)).toBe(0);

      // B crosses 3 hours half an hour after now0: alerted again, in this period.
      expect((await runSpiderTick(new Date(now0 + 30 * MIN + 1_000))).claimed).toBe(1);
      const bRows = await db.spiderAlert.findMany({ where: { organization_id: org, lead_id: B }, orderBy: { alerted_at: 'asc' } });
      expect(bRows).toHaveLength(2);
      expect(bRows[1]!.counted_from.getTime()).toBe(Ta.getTime());
    });

    it('Skip: A stays settled and is never reported; C alerts on its own at its crossing; B alerts again when it crosses 3 hours', async () => {
      const { org, api, A, B, C, now0 } = await offAndLengthened();
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      const Ta = (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).activated_at!;
      expect(await pendingOf(A)).toBe(false);
      expect(await pendingOf(B)).toBe(true);
      expect(await pendingOf(C)).toBe(true);

      await _resetSpiderTick();
      expect((await runSpiderTick(new Date(Ta.getTime() + 5_000))).claimed).toBe(0);
      expect((await runSpiderTick(new Date(now0 + 10_000))).claimed).toBe(1);
      await clearLease(db);
      await runSpiderSweep(new Date(Ta.getTime() + 3 * MIN));
      expect((await runSpiderTick(new Date(now0 + 30 * MIN + 1_000))).claimed).toBe(1);
      const period2 = await db.spiderAlert.findMany({ where: { organization_id: org, counted_from: { gte: Ta } } });
      expect(period2.map((a) => a.lead_id).sort()).toEqual([B, C].sort());
      expect(await perLeadRecordsSince(org, A, Ta)).toBe(0);
      expect(await db.spiderSummary.count({ where: { organization_id: org } })).toBe(0);
    });
  });

  describe('widening saves while Spider is on: what they bring back goes to the starting summary, never to a per-lead alert (#3469)', () => {
    it('E (excluded, past its limit at Activate) is watched again once included; C (its stage off at Activate) once switched on; both are only in the summary; N (skipped) is never reported', async () => {
      const { org, admin, customer } = await fx.newOrg();
      orgs.push(org);
      await db.organization.update({ where: { id: org }, data: { is_demo: true } });
      const api = await fx.signedInAs(admin);
      const withContacted = (on: boolean) => {
        const save = settingsSave(2);
        return { ...save, status_limits: { ...save.status_limits, CONTACTED: { enabled: on, value: 1, unit: 'DAY' } } };
      };
      expect((await api.put(SETTINGS, withContacted(false))).status).toBe(200);
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      await db.spiderSettings.updateMany({ where: { organization_id: { not: org }, is_active: true }, data: { is_active: false } });
      const lead = async (status: 'NEW' | 'CONTACTED', createdAt: Date) => {
        const id = randomUUID();
        await db.lead.create({
          data: {
            id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status, created_at: createdAt,
            ...(status === 'CONTACTED' ? { contacted_at: new Date(Date.now() - 3 * DAY) } : {}),
          },
        });
        return id;
      };
      const E = await lead('NEW', new Date(Date.now() - 5 * HOUR));
      const N = await lead('NEW', new Date(Date.now() - 5 * HOUR));
      const C = await lead('CONTACTED', new Date(Date.now() - 4 * DAY));
      await _resetSpiderTick();
      expect((await runSpiderTick()).claimed).toBe(2);

      // Off, E excluded, on again with Skip: N's stay is skipped; E's (excluded, past its limit) is not watched until E is
      // included again; C's (its stage off) is watched, for when Contacted is switched on.
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await api.patch(EXCLUSIONS, { exclude: [E], include: [] })).status).toBe(200);
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      const Ta = (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).activated_at!;
      expect({ E: await pendingOf(E), N: await pendingOf(N), C: await pendingOf(C) }).toEqual({ E: false, N: false, C: true });
      await _resetSpiderTick();
      const checks = [await runSpiderTick()];

      // E included again: a widening save (its starting trigger is set), and E's stay is watched again.
      expect((await api.patch(EXCLUSIONS, { exclude: [], include: [E] })).status).toBe(200);
      expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).summary_trigger_at).not.toBeNull();
      expect(await pendingOf(E)).toBe(true);
      checks.push(await runSpiderTick());
      // Contacted switched on: another widening save.
      expect((await api.put(SETTINGS, withContacted(true))).status).toBe(200);
      checks.push(await runSpiderTick());

      // The summary after its quiet wait; then the next check settles the stays it took.
      await clearLease(db);
      await runSpiderSweep(new Date(Date.now() + 3 * MIN));
      checks.push(await runSpiderTick(new Date(Date.now() + 3 * MIN + 1_000)));
      expect(checks.map((c) => c.claimed)).toEqual([0, 0, 0, 0]);
      const name = (id: string) => (id === E ? 'E' : id === N ? 'N' : id === C ? 'C' : 'other');
      const period2 = await db.spiderAlert.findMany({ where: { organization_id: org, counted_from: { gte: Ta } }, select: { lead_id: true, kind: true } });
      expect(period2.map((a) => `${name(a.lead_id)}:${a.kind}`).sort()).toEqual(['C:SUMMARIZED', 'E:SUMMARIZED']);
      expect({ E: await pendingOf(E), C: await pendingOf(C) }).toEqual({ E: false, C: false });
    });
  });
});
