/* =============================================================================
   #3107: History shows who was alerted, whether the list sits in the alert row (older rows) or in a stored recipient
   set (rows written since). Seam: the Admin History HTTP endpoints, real app, real migrated database; the rows come from
   the sweep's public entry (runSpiderSweep).

   1. The journey: an Admin switches Spider on over HTTP, saves who is told, leads are overdue, one sweep builds the
      starting summary, and the Admin's History lists the people who were told.
   2. Older and newer rows show the same people (rule S3: who was alerted at the time): the same list, and it does not
      change when a person is renamed or changes role afterwards.
   3. The Role filter finds a row by the role a person had WHEN they were alerted, for both kinds of row.
   4. The Role filter's "Administrator (Owner)" also finds a row whose stored list names the lead's owner.
   5. A row from before the History copies existed (no list anywhere) is still named from today's people.

   Companies come to exist in order (organization, people, customer, leads, then Spider switched on over HTTP). The older
   kind of row is not typed in: a real sweep at the time writes the alert with every column, and the row is then put in the
   shape this migration leaves an older row in (the list in `recipients`, no `recipient_set_id` - the only two columns #3107
   changes); see alertedBeforeThisChange.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { runSpiderSweep } from '../services/spider/sweep';

const suite = realClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const HISTORY = '/api/ai-farm/spider/history';
const EXPORT = '/api/ai-farm/spider/history/export';
const STATUS = '/api/ai-farm/spider/status';

const HOUR_MS = 3_600_000;

interface Told {
  id: string;
  name: string;
  email: string;
  role: string;
  type: string | null;
  email_outcome: string | null;
  text_outcome: string | null;
}

suite('History shows who was alerted, from the alert row or from a stored list (#3107, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    // The fixture removes the companies; their stored lists go with them (a company's delete cascades to both tables).
    await fx.cleanup();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = 'spider.sweep'`);
  });

  const settingsBody = (recipients: object) => ({
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients,
  });

  const DAY_MS = 24 * HOUR_MS;

  /** A person added to the company, who has existed for a month (before any lead or switch-on of these suites). */
  async function person(org: string, name: string, role: 'ADMIN' | 'SALES' | 'DISPATCHER') {
    const p = await fx.addUser(org, name, role);
    await db.user.update({ where: { id: p.id }, data: { created_at: new Date(Date.now() - 30 * DAY_MS) } });
    return p;
  }

  /** A Spider company (a demo company on Scale) whose Admin switches Spider on and saves "tell the Admins", all over HTTP. */
  async function onOrg() {
    const o = await fx.newOrg();
    // The company, its Admin and its customer were made a month ago: before any lead of these suites.
    const monthAgo = new Date(Date.now() - 30 * DAY_MS);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true, created_at: monthAgo } });
    await db.user.update({ where: { id: o.admin.id }, data: { created_at: monthAgo } });
    await db.customer.update({ where: { id: o.customer }, data: { created_at: monthAgo } });
    const api = await fx.signedInAs(o.admin);
    expect((await api.put(SETTINGS, settingsBody({ roles: ['ADMIN'], user_ids: [], lead_owner: false }))).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    return o;
  }

  /** An overdue New lead: it entered New five hours ago against a two-hour limit. */
  async function overdueLead(org: string, customer: string) {
    const lead = await fx.addLead(org, customer);
    await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - 5 * HOUR_MS) } });
    return lead.id;
  }

  /**
   * An alert-log row as it looks after this migration for an alert raised BEFORE #3107, made by the real writer rather than
   * typed in: the company's Spider was switched on four days ago (so its settings exist before the alert), a lead entered
   * New three days ago and sat there three hours against the two-hour limit, a real sweep at that moment alerted it with
   * every column the writer sets (messages, channels, delivery, the History copies), and the lead was contacted an hour later
   * (so Spider no longer watches it). The migration leaves such a row with exactly two columns different from what the
   * writer now writes: `recipients` holds the JSON list and `recipient_set_id` is NULL - they are the only two columns #3107
   * changes - so the row is put in that shape: the list copied from its set into `recipients`, the link cleared, the set
   * (which the older writer never made) removed. `pre-S3` goes one step further back, to a row from before the History
   * copies existed: the columns that migration added (20261015200000) are NULL again.
   */
  async function alertedBeforeThisChange(o: { org: string; customer: string }, shape: 'json' | 'pre-S3') {
    const now = Date.now();
    const switchedOn = new Date(now - 4 * DAY_MS);
    await db.spiderSettings.update({
      where: { organization_id: o.org },
      data: { created_at: switchedOn, activated_at: switchedOn, summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
    });
    const enteredNew = new Date(now - 3 * DAY_MS);
    const alertedAt = new Date(enteredNew.getTime() + 3 * HOUR_MS);
    const lead = await fx.addLead(o.org, o.customer);
    await db.lead.update({ where: { id: lead.id }, data: { created_at: enteredNew } });

    const swept = await runSpiderSweep(alertedAt);
    expect(swept.ran).toBe(true);
    const [row] = await db.spiderAlert.findMany({ where: { lead_id: lead.id } });
    expect(row).toMatchObject({ kind: 'ALERTED', alerted_at: alertedAt, entered_status_at: enteredNew, counted_from: enteredNew });
    // Every column the writer sets is there (messages, channels, delivery), as in a real older row.
    expect([row!.email_subject, row!.sms_message, row!.in_app_message, row!.service_request]).not.toContain(null);
    expect([row!.channels, row!.delivery]).not.toContain(null);

    await db.lead.update({
      where: { id: lead.id },
      data: { status: 'CONTACTED', contacted_at: new Date(alertedAt.getTime() + HOUR_MS), contacted_note: 'Called the customer, deciding this week' },
    });
    await db.$executeRawUnsafe(
      `UPDATE spider_alerts a SET recipients = s.recipients, recipient_set_id = NULL
         FROM spider_recipient_sets s WHERE a.id = $1::uuid AND a.recipient_set_id = s.id`, row!.id,
    );
    await db.$executeRawUnsafe(`DELETE FROM spider_recipient_sets WHERE id = $1::uuid`, row!.recipient_set_id!);
    if (shape === 'pre-S3') {
      await db.$executeRawUnsafe(
        `UPDATE spider_alerts SET lead_number = NULL, customer_id = NULL, customer_name = NULL, company_name = NULL, service_request = NULL,
                service_location = NULL, stage_name = NULL, elapsed_value = NULL, elapsed_unit = NULL, channels = NULL, recipients = NULL,
                email_subject = NULL, email_body = NULL, sms_message = NULL, in_app_message = NULL
          WHERE id = $1::uuid`, row!.id,
      );
    }
    return lead.id;
  }

  /** One sweep past the starting summary's quiet period. */
  async function sweepPastQuietPeriod() {
    const result = await runSpiderSweep(new Date(Date.now() + 15 * 60_000));
    expect(result.ran).toBe(true);
    return result;
  }

  async function historyItems(person: Person, query = '') {
    const res = await (await fx.signedInAs(person)).get(`${HISTORY}?page_size=100${query}`);
    expect(res.status).toBe(200);
    return res.body.items as { lead_id: string; in_starting_summary: boolean; recipients: Told[] }[];
  }

  /** What the Admin's History lists for a person told, as a row written by either kind of code. */
  const told = (p: { id: string; first: string; last: string; email: string; role: string }, type: string): Told => ({
    id: p.id, name: `${p.first} ${p.last}`, email: p.email, role: p.role, type, email_outcome: null, text_outcome: null,
  });

  /** How a lead's alert-log row holds its people, by plain SQL: in a stored set (and no copy), or in its own column. */
  const storageOf = async (leadId: string) =>
    (
      await db.$queryRawUnsafe<{ in_set: boolean; own_copy: boolean }[]>(
        `SELECT recipient_set_id IS NOT NULL AS in_set, recipients IS NOT NULL AS own_copy FROM spider_alerts WHERE lead_id = $1::uuid`, leadId,
      )
    )[0];

  /**
   * A company with two Admins and two rows in its History: `fresh`, written by the sweep's starting summary (the list in a
   * stored set), and `older`, written as the older code wrote it (the list in the row's own column). Both told the same
   * two Admins. The older row's lead is not overdue, so the sweep leaves it alone.
   */
  async function twoKindsOfRow() {
    const o = await onOrg();
    const second = await person(o.org, 'second', 'ADMIN');
    const people = [
      { id: o.admin.id, first: 'Test', last: 'Admin', email: o.admin.email, role: 'ADMIN' },
      { id: second.id, first: 'second', last: 'Tester', email: second.email, role: 'ADMIN' },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    const olderLead = await alertedBeforeThisChange(o, 'json');
    // Spider is switched off and on again over HTTP (the switch route), which starts a fresh wait for a starting summary.
    const api = await fx.signedInAs(o.admin);
    expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    const fresh = await overdueLead(o.org, o.customer);
    await sweepPastQuietPeriod();

    // The two rows really are the two kinds this suite compares.
    expect(await storageOf(fresh)).toEqual({ in_set: true, own_copy: false });
    expect(await storageOf(olderLead)).toEqual({ in_set: false, own_copy: true });
    return { ...o, second, people, fresh, olderLead };
  }

  it('an Admin switches Spider on over a backlog: History lists the people the starting summary told', async () => {
    const o = await onOrg();
    const lead = await overdueLead(o.org, o.customer);

    await sweepPastQuietPeriod();

    expect(await storageOf(lead)).toEqual({ in_set: true, own_copy: false });
    const items = await historyItems(o.admin);
    expect(items.map((i) => i.lead_id)).toEqual([lead]);
    expect(items[0]!.in_starting_summary).toBe(true);
    expect(items[0]!.recipients).toEqual([told({ id: o.admin.id, first: 'Test', last: 'Admin', email: o.admin.email, role: 'ADMIN' }, 'admin')]);
  });

  describe('the same people for an older row and a newer one', () => {
    it('History lists the same recipients for a row with its own list and a row with a stored list', async () => {
      const c = await twoKindsOfRow();
      const items = await historyItems(c.admin);
      const byLead = Object.fromEntries(items.map((i) => [i.lead_id, i]));
      const expected = c.people.map((p) => told(p, 'admin'));
      expect(byLead[c.olderLead]!.recipients).toEqual(expected);
      expect(byLead[c.fresh]!.recipients).toEqual(expected);
    });

    it('the export lists them the same way', async () => {
      const c = await twoKindsOfRow();
      const res = await (await fx.signedInAs(c.admin)).get(EXPORT);
      expect(res.status).toBe(200);
      const byLead = Object.fromEntries((res.body.items as { lead_id: string; recipients: Told[] }[]).map((i) => [i.lead_id, i.recipients]));
      const expected = c.people.map((p) => told(p, 'admin'));
      expect(byLead[c.olderLead]).toEqual(expected);
      expect(byLead[c.fresh]).toEqual(expected);
    });

    it.each([
      ['a row with its own list', 'olderLead'],
      ['a row with a stored list', 'fresh'],
    ] as const)('%s still names the people as they were when it was written, after one is renamed and the other changes role', async (_kind, which) => {
      const c = await twoKindsOfRow();
      await db.user.update({ where: { id: c.admin.id }, data: { first_name: 'Renamed', last_name: 'Afterwards' } });
      await db.user.update({ where: { id: c.second.id }, data: { role: 'DISPATCHER', is_admin: false } });

      const row = (await historyItems(c.admin)).find((i) => i.lead_id === c[which])!;
      expect(row.recipients).toEqual(c.people.map((p) => told(p, 'admin')));
    });
  });

  describe('the Role filter', () => {
    it.each([
      ['a row with its own list', 'olderLead'],
      ['a row with a stored list', 'fresh'],
    ] as const)('%s is found by the role its people had when they were alerted, not the role they hold now', async (_kind, which) => {
      const c = await twoKindsOfRow();
      // Both were Admins when alerted. One is a Dispatcher now, and is the only Dispatcher the company has.
      await db.user.update({ where: { id: c.second.id }, data: { role: 'DISPATCHER', is_admin: false } });

      const asAdmin = (await historyItems(c.admin, '&roles=ADMIN')).map((i) => i.lead_id);
      const asDispatcher = (await historyItems(c.admin, '&roles=DISPATCHER')).map((i) => i.lead_id);
      expect(asAdmin).toContain(c[which]);
      expect(asDispatcher).not.toContain(c[which]);
    });
  });

  describe('the Role filter "Administrator (Owner)"', () => {
    it('finds a row whose stored list names the lead\'s owner, though the owner is not an Admin', async () => {
      const o = await onOrg();
      const owner = await person(o.org, 'owner', 'SALES');
      const api = await fx.signedInAs(o.admin);
      // Spider tells the lead's owner and nobody else.
      expect((await api.put(SETTINGS, settingsBody({ roles: [], user_ids: [], lead_owner: true }))).status).toBe(200);
      const lead = (await fx.addLead(o.org, o.customer, { owner: owner.id })).id;
      await db.lead.update({ where: { id: lead }, data: { created_at: new Date(Date.now() - 5 * HOUR_MS) } });
      await sweepPastQuietPeriod();
      expect(await storageOf(lead)).toEqual({ in_set: true, own_copy: false });

      const [row] = await historyItems(o.admin);
      expect(row!.recipients.map((r) => [r.id, r.role, r.type])).toEqual([[owner.id, 'SALES', 'owner']]);
      expect((await historyItems(o.admin, '&roles=ADMIN')).map((i) => i.lead_id)).toEqual([lead]);
      expect((await historyItems(o.admin, '&roles=SALES')).map((i) => i.lead_id)).toEqual([lead]);
      expect(await historyItems(o.admin, '&roles=DISPATCHER')).toEqual([]);
    });
  });

  describe('a row from before History kept a copy', () => {
    it('is named from the people as they are now, and found by the role they hold now', async () => {
      const o = await onOrg();
      // Written before the History copies existed: only the ids of the people (see alertedBeforeThisChange).
      const lead = await alertedBeforeThisChange(o, 'pre-S3');
      await db.user.update({ where: { id: o.admin.id }, data: { first_name: 'Renamed', last_name: 'Afterwards' } });

      const [item] = await historyItems(o.admin, '&roles=ADMIN');
      expect(item!.lead_id).toBe(lead);
      expect(item!.recipients).toEqual([
        { id: o.admin.id, name: 'Renamed Afterwards', email: o.admin.email, role: 'ADMIN', type: null, email_outcome: null, text_outcome: null },
      ]);
      expect(await historyItems(o.admin, '&roles=DISPATCHER')).toEqual([]);
    });
  });
});
