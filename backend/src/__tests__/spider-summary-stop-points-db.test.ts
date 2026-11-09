/* =============================================================================
   #3108: where a sweep can be stopped for real, and what the restart does.

   Seams (agreed with Ran): the sweep's public entry (runSpiderSweep) on a real migrated database across a stop and a
   restart, and the summary as the Spider page and the bell read it over HTTP.

   1. A stop DURING THE DELIVERY of a summary that is already READY - at the bell, at the emails, at the texts. The sweep
      runs in its own process on the jobs' client and is killed (SIGKILL) at that point; the restart is another process.
      The only boundary faked is the email provider and the phone system, as one small local server that every process
      reaches over HTTP, so every email and text that ever left is counted exactly. The restart must leave the summary
      readable (never superseded by "nothing to report"), finish the bell for everyone, and start no email or text channel
      that was already started: nobody gets a second email or text.
   2. A stop DURING PLANNING (before the first claim is saved): the attempt was counted before any work, so repeated stops
      use up the three attempts and the run is given up on, instead of starting over for ever.

   3. A provider's BOUNCE report that arrives while the texts are still going out is never answered and then lost: it is refused
      (the provider tries again) until the delivery is recorded, and then it shows as bounced on the summary and on every
      History row; a bounce that arrives after the run is done does too.
   4. A summary that went out is never replaced by the same trigger's next sweep, whether the sweep was killed after the run
      was closed and before the trigger was cleared, or the statement that clears the trigger failed.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, SECRET_BYTES } = vi.hoisted(() => {
  const { randomBytes } = require('crypto') as typeof import('crypto');
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = dbUrl;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } } as import('@prisma/client').Prisma.PrismaClientOptions) : undefined,
    SECRET_BYTES: randomBytes(24),
  };
});

vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL,
      RESEND_WEBHOOK_SECRET: `whsec_${SECRET_BYTES.toString('base64')}`,
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());

import { switchFixture } from './permission-switches-fixture';
import { HOUR, MIN, T0, addLead, at, removeCompanies, spiderCompany, type SpiderCompany } from './support/spider-company';
import {
  adminView, clearLease, expireLease, onlyThisCompany, personView, startFakeProviders, startSweepProcess, waitUntil,
  type FakeProviders, type SweepProcess,
} from './support/spider-summary-world';

const suite = adminClient ? describe : describe.skip;

const PEOPLE = 60;
/** Stop a channel after this many of its 60 sends. */
const STOP_AFTER = 20;

suite('a sweep stopped during the delivery or the planning of a summary (#3108, real database)', () => {
  const db = adminClient as PrismaClient;
  const dbUrl = process.env.TEST_DATABASE_URL as string;
  const orgs: string[] = [];
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let providers: FakeProviders;

  beforeAll(async () => {
    await import('../app.js');
    providers = await startFakeProviders();
  }, 120_000);
  afterAll(async () => {
    await clearLease(db).catch(() => undefined);
    await fx.cleanup();
    await removeCompanies(db, orgs);
    await db.$disconnect();
  });

  /** A whole sweep in its own process, to the end, at this clock time (the stopped one's lease first runs out). */
  async function sweepToEnd(time: Date): Promise<void> {
    await expireLease(db);
    const child: SweepProcess = startSweepProcess(dbUrl, time, providers);
    await child.exited;
  }

  /** A sweep in its own process, killed the moment `reached` is true. */
  async function sweepKilledWhen(time: Date, reached: () => Promise<boolean>): Promise<{ killed: boolean }> {
    await expireLease(db);
    const child = startSweepProcess(dbUrl, time, providers);
    await waitUntil(async () => child.process.exitCode !== null || (await reached()), 'the stop point');
    child.process.kill('SIGKILL');
    const code = await child.exited;
    // An answer already on its way reaches the server; after this the counts are final.
    await new Promise((r) => setTimeout(r, 400));
    // The process was still running when the signal came (a process that had ended by itself has an exit code).
    return { killed: code === null };
  }

  const bellCount = (org: string) => db.notification.count({ where: { organization_id: org, verb: 'spider.starting_summary' } });
  const perPerson = (sent: { to: string }[]) => Math.max(0, ...Object.values(sent.reduce<Record<string, number>>((m, x) => ({ ...m, [x.to]: (m[x.to] ?? 0) + 1 }), {})));

  describe('stopped during the delivery', () => {
    // [where it stops, how it knows it has stopped there]
    const points: [string, (c: SpiderCompany) => Promise<boolean>, { emails: 'all' | 'stopped'; texts: 'all' | 'stopped' }][] = [
      ['at the bell', async (c) => (await bellCount(c.org)) >= STOP_AFTER, { emails: 'all', texts: 'all' }],
      ['at the emails', async () => providers.emails.length >= STOP_AFTER, { emails: 'stopped', texts: 'all' }],
      ['at the texts', async () => providers.texts.length >= STOP_AFTER, { emails: 'all', texts: 'stopped' }],
    ];

    it.each(points)('%s: the restart keeps the summary, finishes the bell, and sends no email or text twice', async (_where, reached, expected) => {
      const c = await spiderCompany(db, orgs, { leads: 300, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
      await onlyThisCompany(db, c.org);
      providers.emails.length = 0;
      providers.texts.length = 0;
      // Each answer takes a moment, so the stop lands between two sends.
      providers.setDelay(100);

      await sweepKilledWhen(T0, () => reached(c));
      const stopped = { bell: await bellCount(c.org), emails: providers.emails.length, texts: providers.texts.length };
      expect(await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'READY' });

      providers.setDelay(0);
      await sweepToEnd(at(3 * MIN));
      await sweepToEnd(at(10 * MIN));

      // The summary people were told about is still the company's summary, readable on the Spider page and by a person.
      const admin = c.people.find((p) => p.role === 'ADMIN')!;
      const dispatcher = c.people.find((p) => p.role === 'DISPATCHER')!;
      expect((await adminView(await fx.signedInAs(admin))).card?.total).toBe(300);
      const person = await personView(await fx.signedInAs(dispatcher));
      expect(person.mine?.total).toBe(300);
      expect(person.summaryNotices).toHaveLength(1);
      expect(await db.spiderSummary.findMany({ where: { organization_id: c.org }, select: { status: true } })).toEqual([{ status: 'READY' }]);

      // The bell reached all 60, once each; email and text: what was started is not started again, the rest goes once.
      expect(await bellCount(c.org)).toBe(PEOPLE);
      expect(await db.notificationRecipient.count({ where: { organization_id: c.org, notification: { verb: 'spider.starting_summary' } } })).toBe(PEOPLE);
      expect(providers.emails.length).toBe(expected.emails === 'all' ? PEOPLE : stopped.emails);
      expect(providers.texts.length).toBe(expected.texts === 'all' ? PEOPLE : stopped.texts);
      expect(perPerson(providers.emails)).toBeLessThanOrEqual(1);
      expect(perPerson(providers.texts)).toBeLessThanOrEqual(1);
      if (expected.emails === 'stopped') expect(stopped.emails).toBeGreaterThanOrEqual(STOP_AFTER);
      if (expected.texts === 'stopped') expect(stopped.texts).toBeGreaterThanOrEqual(STOP_AFTER);

      // The outcome is recorded once on the summary, and the run is closed.
      const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } });
      expect(summary).toMatchObject({ lead_count: 300, recipient_count: PEOPLE });
      expect(summary.delivery).toMatchObject({
        in_app: { outcome: 'Shown in the app' },
        email: { outcome: expected.emails === 'all' ? 'Email sent' : 'Emails were interrupted by a restart and are not sent again' },
        text: { outcome: expected.texts === 'all' ? 'Text message sent' : 'Texts were interrupted by a restart and are not sent again' },
      });
      expect(summary.delivery).not.toHaveProperty('state');
      expect(await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'DONE' });
      // Its leads stay claimed by the summary: nothing was alerted one by one.
      expect(await db.spiderAlert.count({ where: { organization_id: c.org, kind: 'SUMMARIZED' } })).toBe(300);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org, kind: 'ALERTED' } })).toBe(0);
    }, 600_000);
  });

  describe('stopped during the planning', () => {
    /**
     * Holds the users table locked from another connection until released: the summary's planning reads the people it will
     * tell, so a sweep that reaches it waits there - which is where the test stops it.
     */
    function holdUsers(): { release: () => void; held: Promise<void> } {
      let release: () => void = () => undefined;
      const done = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (locked = resolve));
      void db
        .$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
            locked();
            await done;
          },
          { timeout: 600_000, maxWait: 10_000 },
        )
        .catch(() => undefined);
      return { release, held };
    }
    const waitingOnUsers = async () =>
      (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%"users"%'`))[0]!.n > 0;

    it('counts every stopped attempt, so three stops use the run up and it is given up on, not started over for ever', async () => {
      const c = await spiderCompany(db, orgs, { leads: 1_000, admins: 2, dispatchers: 1, trigger: true });
      await onlyThisCompany(db, c.org);
      const runOf = () => db.spiderSummaryRun.findFirst({ where: { organization_id: c.org } });

      // Stopped while it waits to read the people to tell: nothing is saved, and the attempt is already counted.
      const attempts: number[] = [];
      for (const when of [T0, at(2 * MIN), at(10 * MIN)]) {
        const lock = holdUsers();
        await lock.held;
        await sweepKilledWhen(when, waitingOnUsers);
        lock.release();
        attempts.push((await runOf())?.attempts ?? 0);
        expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(0);
      }
      expect(attempts).toEqual([1, 2, 3]);

      // After the third attempt's wait, the restart does not start a fourth: it gives up and the per-lead alerts take over
      // (with the email and text channels off here, so those alerts only reach the bell).
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: { in_app: true, red_frame: true, email: false, text: false } } });
      await sweepToEnd(at(41 * MIN));
      expect(await runOf()).toMatchObject({ status: 'ABANDONED', attempts: 3 });
      expect(await db.spiderSummary.findMany({ where: { organization_id: c.org }, select: { status: true } })).toEqual([{ status: 'SUPERSEDED' }]);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org, kind: 'SUMMARIZED' } })).toBe(0);
    }, 600_000);
  });

  describe('a provider bounce report during and after the delivery', () => {
    const WEBHOOK = '/api/webhooks/resend';

    /** A delivery event as the provider sends it, signed with the shared secret, for one of Spider's summary emails. */
    async function bounce(email: { id: string; to: string }, summaryId: string, svixId: string) {
      const app = await fx.listener();
      const body = JSON.stringify({
        type: 'email.bounced',
        created_at: new Date().toISOString(),
        data: {
          created_at: new Date().toISOString(), email_id: email.id, to: [email.to], subject: 'Spider summary',
          tags: { spider_summary_id: summaryId }, bounce: { message: 'Mailbox does not exist', subType: 'General', type: 'Permanent' },
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
      return request(app).post(WEBHOOK).set('Content-Type', 'application/json')
        .set({ 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` }).send(body);
    }

    /** Every History row of the company, as the Admin reads it over HTTP: how many emails each says were sent and failed. */
    async function emailCounts(c: SpiderCompany): Promise<{ rows: number; sent: Set<number>; failed: Set<number> }> {
      const api = await fx.signedInAs(c.people.find((p) => p.role === 'ADMIN')!);
      const sent = new Set<number>();
      const failed = new Set<number>();
      let rows = 0;
      for (let page = 1; page <= 3; page++) {
        const res = await api.get(`/api/ai-farm/spider/history?page_size=100&page=${page}`);
        for (const i of res.body.items as { outcomes: { email: { sent: number; failed: number } } }[]) {
          rows += 1;
          sent.add(i.outcomes.email.sent);
          failed.add(i.outcomes.email.failed);
        }
      }
      return { rows, sent, failed };
    }
    const personOutcome = async (org: string, userId: string) => {
      const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: org } });
      const email = (summary.delivery as { email: { outcome: string; recipients: { user_id: string; outcome: string }[] } }).email;
      const others = new Set(email.recipients.filter((r) => r.user_id !== userId).map((r) => r.outcome));
      return { summary: email.outcome, person: email.recipients.find((r) => r.user_id === userId)?.outcome, others: [...others] };
    };

    it('a bounce that arrives while the texts are still going out is refused, then kept when the provider tries again after the restart', async () => {
      const c = await spiderCompany(db, orgs, { leads: 300, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
      await onlyThisCompany(db, c.org);
      providers.emails.length = 0;
      providers.texts.length = 0;
      providers.setDelay(100);
      await sweepKilledWhen(T0, async () => providers.texts.length >= STOP_AFTER);
      providers.setDelay(0);
      const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } });
      const bounced = providers.emails[0]!;
      const person = c.people.find((p) => p.email === bounced.to)!;

      const svixId = `se3108-${randomUUID()}`;
      expect((await bounce(bounced, summary.id, svixId)).status).toBeGreaterThanOrEqual(500);

      await sweepToEnd(at(3 * MIN));
      expect((await bounce(bounced, summary.id, svixId)).status).toBe(200);

      expect(await personOutcome(c.org, person.id)).toEqual({ summary: 'Email sent (59 of 60)', person: 'Email could not be delivered', others: ['Email sent'] });
      expect(await emailCounts(c)).toEqual({ rows: 300, sent: new Set([59]), failed: new Set([1]) });
    }, 600_000);

    it('a bounce that arrives after the run is done shows as bounced too', async () => {
      const c = await spiderCompany(db, orgs, { leads: 300, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
      await onlyThisCompany(db, c.org);
      providers.emails.length = 0;
      providers.texts.length = 0;
      await sweepToEnd(T0);
      const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } });
      const bounced = providers.emails[1]!;
      const person = c.people.find((p) => p.email === bounced.to)!;

      expect((await bounce(bounced, summary.id, `se3108-${randomUUID()}`)).status).toBe(200);

      expect(await personOutcome(c.org, person.id)).toEqual({ summary: 'Email sent (59 of 60)', person: 'Email could not be delivered', others: ['Email sent'] });
      expect(await emailCounts(c)).toEqual({ rows: 300, sent: new Set([59]), failed: new Set([1]) });
    }, 600_000);
  });

  describe('a summary that went out, before its trigger is cleared', () => {
    /** Another connection holds the company's settings row, so the sweep's statement that clears the trigger cannot get it. */
    function holdSettings(org: string): { release: () => void; held: Promise<void> } {
      let release: () => void = () => undefined;
      const done = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (locked = resolve));
      void db
        .$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe('SELECT 1 FROM spider_settings WHERE organization_id = $1::uuid FOR UPDATE', org);
            locked();
            await done;
          },
          { timeout: 600_000, maxWait: 10_000 },
        )
        .catch(() => undefined);
      return { release, held };
    }
    const triggerOf = async (org: string) => (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).summary_trigger_at;

    /** What a person can see and what was sent, for the comparison before and after the restart. */
    async function picture(c: SpiderCompany) {
      const admin = await adminView(await fx.signedInAs(c.people.find((p) => p.role === 'ADMIN')!));
      const card = admin.card;
      const mine = (await personView(await fx.signedInAs(c.people.find((p) => p.role === 'DISPATCHER')!))).mine;
      return {
        history: { rows: admin.historyTotal, inSummary: admin.historyItems.filter((i) => i.in_starting_summary).length },
        summaries: await db.spiderSummary.findMany({ where: { organization_id: c.org }, select: { id: true, status: true } }),
        runs: await db.spiderSummaryRun.count({ where: { organization_id: c.org } }),
        card: card && { id: card.id, total: card.total },
        mine: mine && { id: mine.id, total: mine.total },
        bell: await db.notification.count({ where: { organization_id: c.org, verb: 'spider.starting_summary' } }),
        emails: providers.emails.length,
        texts: providers.texts.length,
      };
    }

    /** Leads that became overdue while the trigger was still waiting to be cleared: the same trigger must not summarize them. */
    async function lateLeads(c: SpiderCompany): Promise<string[]> {
      return Promise.all([1, 2, 3].map((i) => addLead(db, c, at(-3 * HOUR - i * MIN))));
    }

    async function company() {
      const c = await spiderCompany(db, orgs, { leads: 300, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
      await onlyThisCompany(db, c.org);
      providers.emails.length = 0;
      providers.texts.length = 0;
      return c;
    }

    it('a sweep stopped after the run was closed and before the trigger was cleared does not replace the summary on restart', async () => {
      const c = await company();
      const lock = holdSettings(c.org);
      await lock.held;
      const stop = await sweepKilledWhen(T0, async () => (await db.spiderSummaryRun.count({ where: { organization_id: c.org, status: 'DONE' } })) > 0);
      lock.release();
      expect(stop.killed).toBe(true);
      expect(await triggerOf(c.org)).not.toBeNull();
      const before = await picture(c);
      expect(before).toMatchObject({ history: { rows: 300 }, card: { total: 300 }, mine: { total: 300 }, bell: PEOPLE, emails: PEOPLE, texts: PEOPLE });
      const late = await lateLeads(c);

      await sweepToEnd(at(3 * MIN));

      expect(await picture(c)).toEqual(before);
      expect(await triggerOf(c.org)).toBeNull();
      expect(await db.spiderAlert.count({ where: { organization_id: c.org, lead_id: { in: late } } })).toBe(0);
    }, 600_000);

    it('a sweep whose statement that clears the trigger fails does not replace the summary on the next sweep', async () => {
      const c = await company();
      // A real database rule that refuses exactly that statement, for the length of this sweep.
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sp3108_refuse_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER sp3108_refuse_clear BEFORE UPDATE ON spider_settings FOR EACH ROW
           WHEN (OLD.summary_trigger_at IS NOT NULL AND NEW.summary_trigger_at IS NULL) EXECUTE FUNCTION sp3108_refuse_clear()`,
      );
      try {
        await sweepToEnd(T0);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3108_refuse_clear ON spider_settings');
      }
      expect(await triggerOf(c.org)).not.toBeNull();
      const before = await picture(c);
      expect(before).toMatchObject({ history: { rows: 300 }, card: { total: 300 }, mine: { total: 300 }, bell: PEOPLE, emails: PEOPLE, texts: PEOPLE });
      const late = await lateLeads(c);

      await sweepToEnd(at(3 * MIN));

      expect(await picture(c)).toEqual(before);
      expect(await triggerOf(c.org)).toBeNull();
      expect(await db.spiderAlert.count({ where: { organization_id: c.org, lead_id: { in: late } } })).toBe(0);
    }, 600_000);
  });
});
