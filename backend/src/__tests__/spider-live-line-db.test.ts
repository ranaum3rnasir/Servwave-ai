/* =============================================================================
   #3472 - the live line on a real database, through the whole app: GET /api/live and Spider's messages on it.

   The journey: people of a Spider company hold a line open; the sweep raises an alert and each person it is for gets
   their own card on the line, the very card the unread-alerts read returns; the lead moves on and the same people are
   told it ended; the saves tell the company's screens to re-read; a starting summary's READY step tells the people it
   tells and the Admins. Nobody else, in that company or another, gets a message that is not theirs.

   And the line itself: no database connection held while it is open (more lines than the pool has connections, and a
   database request still answers), no query per message, the server's request timeouts never cut it, the caps answer
   429 / 503 with Retry-After, a thrown-away sign-in and a shutdown end it, many lines at once cost little.

   #3473 adds the bell: a notification written for a person rings "bell.changed" on that person's lines (any notification,
   not only Spider's; Spider's per-lead alerts never), after the rows are written, to nobody else.

   Skips when TEST_DATABASE_URL is unset. Every company it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/** The pool this file's client gets (`connection_limit` below): the "more lines than connections" test opens three times as many lines. */
const POOL = 4;

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const url = new URL(dbUrl);
  url.searchParams.set('connection_limit', '4');
  url.searchParams.set('pool_timeout', '5');
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  // The query-event log, so countQueries can count what this client sends (support/query-counter.ts).
  return { realClient: new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ emit: 'event', level: 'query' }] }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// Whether Spider's check runs in this server (#3469), as the line's hello says. Null: the real answer (it does not run
// here: SPIDER_WATCH_LIST is unset). A case sets it to see the line say so.
const { tickRunning } = vi.hoisted(() => ({ tickRunning: { value: null as boolean | null } }));
vi.mock('../services/spider/tick', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/spider/tick')>();
  return { ...real, spiderTickRunning: () => tickRunning.value ?? real.spiderTickRunning() };
});
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import http, { type IncomingHttpHeaders, type RequestListener, type Server } from 'http';
import type { AddressInfo } from 'net';
import { switchFixture, type Person } from './permission-switches-fixture';
import { countQueries } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { publishSpiderLive } from '../services/spider/liveMessages';
import { publishBellChanged } from '../services/notifications/bellLive';
import { endAllLiveLines, liveLinesOpen, LIVE_LINES_PER_PERSON } from '../services/live/liveLines';
import { clearTokenCache } from '../middleware/authenticate';
import { _resetStopRequest, requestStop } from '../lib/graceful-stop';
import { emit, emitMany } from '../services/notifications/notificationService';
import { supabaseAdmin } from '../lib/supabase';
import { randomUUID } from 'node:crypto';
import type { Mock } from 'vitest';

const suite = realClient ? describe : describe.skip;

const LIVE = '/api/live';
const SETTINGS = '/api/ai-farm/spider/settings';
const STATUS = '/api/ai-farm/spider/status';
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const EXCLUSIONS = '/api/ai-farm/spider/exclusions';
const HOUR = 3_600_000;
const VENDOR = /supabase|render|ctm|calltracking|stripe|resend|twilio|cloudflare|vercel|redis/i;

interface LiveEvent {
  type: string;
  data: Record<string, unknown>;
}

interface OpenedLine {
  status: number;
  headers: IncomingHttpHeaders;
  /** The line's first message (live.hello, #3469): what the server says about itself. Kept apart from `events`. */
  hello: Record<string, unknown> | null;
  events: LiveEvent[];
  /** Everything received, as text. */
  text: string;
  ended: boolean;
  close: () => void;
}

/** Opens GET /api/live as this bearer on this server, and reads what arrives into `events` as it comes. */
function openLineOn(server: Server, bearer: string | null): Promise<OpenedLine> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: LIVE, method: 'GET', headers: { Accept: 'text/event-stream', ...(bearer ? { Authorization: bearer } : {}) } },
      (res) => {
        const line: OpenedLine = { status: res.statusCode ?? 0, headers: res.headers, hello: null, events: [], text: '', ended: false, close: () => req.destroy() };
        let pending = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          line.text += chunk;
          pending += chunk;
          let cut: number;
          while ((cut = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, cut);
            pending = pending.slice(cut + 2);
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (type === 'live.hello' && data) line.hello = JSON.parse(data) as Record<string, unknown>;
            else if (type && data) line.events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
          }
        });
        res.on('close', () => {
          line.ended = true;
        });
        resolve(line);
      },
    );
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });
}

async function until(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const typesOf = (line: OpenedLine) => line.events.map((e) => e.type);

suite('the live line (real database, whole app)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const opened: OpenedLine[] = [];
  const orgs: string[] = [];

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  afterEach(() => {
    endAllLiveLines();
    for (const l of opened.splice(0)) l.close();
    _resetStopRequest();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notifications', 'spider_alerts', 'spider_summaries', 'spider_recipient_sets', 'spider_settings']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
    }
    await fx.cleanup();
  }, 120_000);

  /** Opens a line as this person on the app's own server. */
  async function open(person: Person): Promise<OpenedLine> {
    await fx.signedInAs(person);
    const line = await openLineOn(await fx.listener(), `Bearer switches-${person.id}`);
    opened.push(line);
    if (line.status === 200) await until(() => line.text.startsWith(': open'), 'the line to open');
    return line;
  }

  /**
   * A Spider company (demo, Scale) with its settings saved: New at 2 hours, Email and Text off. `inApp` false keeps only
   * the red frame (red-frame-only records).
   */
  async function spiderCompany(opts: { roles: string[]; inApp?: boolean }) {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    const off = { enabled: false, value: 1, unit: 'DAY' };
    const api = await fx.signedInAs(o.admin);
    const saved = await api.put(SETTINGS, {
      status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
      channels: { in_app: opts.inApp ?? true, red_frame: true, email: false, text: false },
      recipients: { roles: opts.roles, user_ids: [], lead_owner: false },
    });
    expect(saved.status).toBe(200);
    return o;
  }

  /** A New lead past its 2-hour limit (created 3 hours ago), on this person's desk so a Sales person may open it. */
  async function overdueLead(org: string, customer: string, owner?: Person) {
    const lead = await fx.addLead(org, customer, owner ? { owner: owner.id, assignees: [owner.id] } : {});
    await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - 3 * HOUR) } });
    return lead;
  }

  /** Every line has received `n` messages of this type: what came before them on each line is all it will get. */
  async function allHave(lines: OpenedLine[], type: string, n: number) {
    await until(() => lines.every((l) => typesOf(l).filter((t) => t === type).length >= n), `${n} x ${type} on every line`);
  }

  it('the journey: each person gets their own new card (the one the unread read returns), then its end; the saves tell the company; nobody else hears', async () => {
    const a = await spiderCompany({ roles: ['ADMIN', 'SALES'] });
    const salesA = await fx.addUser(a.org, 'sales', 'SALES');
    const techA = await fx.addUser(a.org, 'tech', 'TECHNICIAN');
    // A second company, with in-app alerts off: its people get red-frame-only records.
    const b = await spiderCompany({ roles: ['ADMIN'], inApp: false });
    expect((await (await fx.signedInAs(b.admin)).put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);

    const adminLine = await open(a.admin);
    const salesLine = await open(salesA);
    const techLine = await open(techA);
    const otherLine = await open(b.admin);
    expect(liveLinesOpen()).toBe(4);

    // Activate: every screen of the company re-reads; the other company hears nothing.
    expect((await (await fx.signedInAs(a.admin)).put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    await allHave([adminLine, salesLine, techLine], 'spider.settings.changed', 1);

    // The sweep raises an alert in each company.
    const leadA = await overdueLead(a.org, a.customer, salesA);
    const leadB = await overdueLead(b.org, b.customer);
    await runSpiderSweep();
    await allHave([adminLine, salesLine, otherLine], 'spider.alert.added', 1);

    // Each person's card is exactly what their own unread read returns: nothing more to read.
    for (const [person, line] of [[a.admin, adminLine], [salesA, salesLine]] as const) {
      const read = await (await fx.signedInAs(person)).get(UNREAD);
      expect(read.status).toBe(200);
      expect(read.body.alerts).toHaveLength(1);
      expect(read.body.frame_ids).toEqual([]);
      const added = line.events.find((e) => e.type === 'spider.alert.added')!.data;
      expect(added).toEqual({ alerts: read.body.alerts, frame_ids: [] });
      expect(read.body.alerts[0].lead_id).toBe(leadA.id);
    }
    // The other company's record is red-frame-only: its id, no card, the same the read returns.
    const otherRead = await (await fx.signedInAs(b.admin)).get(UNREAD);
    expect(otherRead.body).toMatchObject({ alerts: [], frame: true });
    expect(otherRead.body.frame_ids).toHaveLength(1);
    expect(otherLine.events.find((e) => e.type === 'spider.alert.added')!.data).toEqual({ alerts: [], frame_ids: otherRead.body.frame_ids });
    const otherRow = await db.notificationRecipient.findUniqueOrThrow({ where: { id: otherRead.body.frame_ids[0] }, include: { notification: true } });
    expect(otherRow.notification.object_id).toBe(leadB.id);

    // The lead moves on: the sweep ends the alert, and each person is told which of their own rows ended.
    await db.lead.update({ where: { id: leadA.id }, data: { status: 'CONTACTED', contacted_at: new Date() } });
    await runSpiderSweep();
    await allHave([adminLine, salesLine], 'spider.alert.ended', 1);
    for (const line of [adminLine, salesLine]) {
      const card = (line.events.find((e) => e.type === 'spider.alert.added')!.data.alerts as { id: string }[])[0]!;
      expect(line.events.find((e) => e.type === 'spider.alert.ended')!.data).toEqual({ ids: [card.id] });
    }

    // Nobody got what was not theirs: a marker to each company, and what came before it on each line is all there is.
    publishSpiderLive(a.org, { type: 'settings_changed' });
    publishSpiderLive(b.org, { type: 'settings_changed' });
    await allHave([adminLine, salesLine, techLine], 'spider.settings.changed', 2);
    await allHave([otherLine], 'spider.settings.changed', 1);
    expect(typesOf(adminLine)).toEqual(['spider.settings.changed', 'spider.alert.added', 'spider.alert.ended', 'spider.settings.changed']);
    expect(typesOf(salesLine)).toEqual(['spider.settings.changed', 'spider.alert.added', 'spider.alert.ended', 'spider.settings.changed']);
    expect(typesOf(techLine)).toEqual(['spider.settings.changed', 'spider.settings.changed']);
    expect(typesOf(otherLine)).toEqual(['spider.alert.added', 'spider.settings.changed']);

    // Each save tells the company's screens to re-read, once: the settings, the excluded leads, the switch.
    const admin = await fx.signedInAs(a.admin);
    const current = (await admin.get(SETTINGS)).body.settings;
    expect((await admin.put(SETTINGS, { status_limits: current.status_limits, channels: current.channels, recipients: current.recipients })).status).toBe(200);
    await allHave([adminLine, salesLine, techLine], 'spider.settings.changed', 3);
    expect((await admin.patch(EXCLUSIONS, { exclude: [leadA.id], include: [] })).status).toBe(200);
    await allHave([adminLine, salesLine, techLine], 'spider.settings.changed', 4);
    expect((await admin.put(STATUS, { isActive: false })).status).toBe(200);
    await allHave([adminLine, salesLine, techLine], 'spider.settings.changed', 5);
    publishSpiderLive(b.org, { type: 'settings_changed' });
    await allHave([otherLine], 'spider.settings.changed', 2);
    expect(typesOf(otherLine)).toEqual(['spider.alert.added', 'spider.settings.changed', 'spider.settings.changed']);

    // Nothing on the line names a vendor.
    for (const line of [adminLine, salesLine, techLine, otherLine]) {
      expect(line.text).not.toMatch(VENDOR);
      expect(JSON.stringify(line.headers)).not.toMatch(VENDOR);
    }
  });

  it("a switch-off ends each person's open alerts on their line at once", async () => {
    const a = await spiderCompany({ roles: ['ADMIN'] });
    const api = await fx.signedInAs(a.admin);
    expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    const line = await open(a.admin);
    await overdueLead(a.org, a.customer);
    await runSpiderSweep();
    await allHave([line], 'spider.alert.added', 1);
    const card = (line.events.find((e) => e.type === 'spider.alert.added')!.data.alerts as { id: string }[])[0]!;

    expect((await (await fx.signedInAs(a.admin)).put(STATUS, { isActive: false })).status).toBe(200);
    await allHave([line], 'spider.settings.changed', 1);
    expect(typesOf(line)).toEqual(['spider.alert.added', 'spider.alert.ended', 'spider.settings.changed']);
    expect(line.events[1]!.data).toEqual({ ids: [card.id] });
  });

  it("a starting summary's READY step tells the people it tells and the company's Admins, and nobody else", async () => {
    // Spider tells Sales only: the Admin hears because they are an Admin (the company-wide summary card is theirs).
    const c = await spiderCompany({ roles: ['SALES'] });
    const salesC = await fx.addUser(c.org, 'sales', 'SALES');
    const techC = await fx.addUser(c.org, 'tech', 'TECHNICIAN');
    const other = await spiderCompany({ roles: ['ADMIN'] });
    await overdueLead(c.org, c.customer, salesC);

    const adminLine = await open(c.admin);
    const salesLine = await open(salesC);
    const techLine = await open(techC);
    const otherLine = await open(other.admin);

    // Activate with the starting summary: the backlog goes into one summary per person once the settings are quiet.
    expect((await (await fx.signedInAs(c.admin)).put(STATUS, { isActive: true, startingSummary: 'send' })).status).toBe(200);
    await runSpiderSweep(new Date(Date.now() + 15 * 60_000));
    await allHave([adminLine, salesLine], 'spider.summary.ready', 1);
    expect(await db.spiderSummary.count({ where: { organization_id: c.org, status: 'READY' } })).toBe(1);

    publishSpiderLive(c.org, { type: 'settings_changed' });
    publishSpiderLive(other.org, { type: 'settings_changed' });
    await allHave([adminLine, salesLine, techLine], 'spider.settings.changed', 2);
    await allHave([otherLine], 'spider.settings.changed', 1);
    expect(typesOf(adminLine)).toEqual(['spider.settings.changed', 'spider.summary.ready', 'spider.settings.changed']);
    // The summary is also a bell notification for Sales (#3473): their bell rings once its notification is written.
    expect(typesOf(salesLine)).toEqual(['spider.settings.changed', 'spider.summary.ready', 'bell.changed', 'spider.settings.changed']);
    expect(typesOf(techLine)).toEqual(['spider.settings.changed', 'spider.settings.changed']);
    expect(typesOf(otherLine)).toEqual(['spider.settings.changed']);
    expect(salesLine.events[1]!.data).toEqual({});
  });

  describe('the bell on the line (#3473)', () => {
    /** One bell notification (a lead assigned) to this person, through the notification service. */
    const assignTo = (org: string, person: Person) =>
      emit({
        verb: 'lead.assigned',
        organizationId: org,
        actorId: null,
        object: { type: 'LEAD', id: randomUUID(), label: 'L-bell' },
        entity: { commission_owner_id: person.id },
        personal: true,
      });
    const rangFor = (line: OpenedLine) => typesOf(line).filter((t) => t === 'bell.changed').length;

    it("a notification rings the bell on the recipient's lines only (every tab), with no content: not a same-company non-recipient, not another company", async () => {
      const a = await fx.newOrg();
      const salesA = await fx.addUser(a.org, 'sales', 'SALES');
      const techA = await fx.addUser(a.org, 'tech', 'TECHNICIAN');
      const b = await fx.newOrg();
      const salesB = await fx.addUser(b.org, 'sales', 'SALES');

      const salesTabs = [await open(salesA), await open(salesA)];
      const adminLine = await open(a.admin);
      const techLine = await open(techA);
      const otherLine = await open(salesB);
      const others = [adminLine, techLine, otherLine];

      expect(await assignTo(a.org, salesA)).toEqual([salesA.id]);
      await allHave(salesTabs, 'bell.changed', 1);
      // The rows are written when the message arrives: the person's bell read already sees the notification.
      const read = await (await fx.signedInAs(salesA)).get('/api/notifications/unread-count');
      expect(read.body.unseen).toBe(1);
      expect(salesTabs[0]!.events[0]).toEqual({ type: 'bell.changed', data: {} });

      // The other company's person gets theirs only from their own company's write; a marker proves the absence for the rest.
      expect(await assignTo(b.org, salesB)).toEqual([salesB.id]);
      await allHave([otherLine], 'bell.changed', 1);
      publishSpiderLive(a.org, { type: 'settings_changed' });
      publishSpiderLive(b.org, { type: 'settings_changed' });
      await allHave([...salesTabs, adminLine, techLine], 'spider.settings.changed', 1);
      await allHave([otherLine], 'spider.settings.changed', 1);
      expect(salesTabs.map(typesOf)).toEqual([['bell.changed', 'spider.settings.changed'], ['bell.changed', 'spider.settings.changed']]);
      expect(typesOf(adminLine)).toEqual(['spider.settings.changed']);
      expect(typesOf(techLine)).toEqual(['spider.settings.changed']);
      expect(typesOf(otherLine)).toEqual(['bell.changed', 'spider.settings.changed']);
      for (const line of [...salesTabs, ...others]) expect(line.text).not.toMatch(VENDOR);
    });

    it("emitMany: one message per person for the whole write, and Spider's per-lead alert (hidden from the bell) rings nothing", async () => {
      const a = await fx.newOrg();
      const salesA = await fx.addUser(a.org, 'sales', 'SALES');
      const other = await fx.addUser(a.org, 'other', 'SALES');
      const salesLine = await open(salesA);
      const otherLine = await open(other);
      const args = (verb: string, ...people: Person[]) => ({
        verb,
        organizationId: a.org,
        actorId: null,
        object: { type: 'LEAD', id: randomUUID(), label: 'L-many' },
        entity: verb === 'spider.alert' ? { recipient_ids: people.map((p) => p.id) } : { commission_owner_id: people[0]!.id },
        personal: true,
        dedupKey: `${verb}:${randomUUID()}`,
      });

      // Two bell alerts to the same person in one write, one Spider alert to both: one bell message, for that person only.
      const result = await emitMany([args('lead.assigned', salesA), args('lead.assigned', salesA), args('spider.alert', salesA, other)]);
      expect(result.told.map((t) => t.length)).toEqual([1, 1, 2]);
      await allHave([salesLine], 'bell.changed', 1);
      publishSpiderLive(a.org, { type: 'settings_changed' });
      await allHave([salesLine, otherLine], 'spider.settings.changed', 1);
      expect(typesOf(salesLine)).toEqual(['bell.changed', 'spider.settings.changed']);
      expect(typesOf(otherLine)).toEqual(['spider.settings.changed']);

      // A write of Spider's alerts alone rings no bell for anyone.
      await emitMany([args('spider.alert', salesA, other)]);
      publishSpiderLive(a.org, { type: 'settings_changed' });
      await allHave([salesLine, otherLine], 'spider.settings.changed', 2);
      expect(typesOf(salesLine)).toEqual(['bell.changed', 'spider.settings.changed', 'spider.settings.changed']);
      expect(typesOf(otherLine)).toEqual(['spider.settings.changed', 'spider.settings.changed']);
    });

    it('a write that fails rings nothing (the bell is rung only after the rows are written)', async () => {
      const a = await fx.newOrg();
      const salesA = await fx.addUser(a.org, 'sales', 'SALES');
      const line = await open(salesA);
      // The recipient insert fails (the database refuses it): emit swallows the failure, tells nobody, and rings nothing.
      const failing = vi.spyOn(db.notificationRecipient, 'createMany').mockRejectedValueOnce(new Error('insert refused') as never);
      try {
        expect(await assignTo(a.org, salesA)).toEqual([]);
        expect(failing).toHaveBeenCalledTimes(1);
      } finally {
        failing.mockRestore();
      }
      expect(await db.notificationRecipient.count({ where: { organization_id: a.org } })).toBe(0);
      publishSpiderLive(a.org, { type: 'settings_changed' });
      await allHave([line], 'spider.settings.changed', 1);
      expect(typesOf(line)).toEqual(['spider.settings.changed']);
      // The same write a moment later, for a real person, rings: the line is not broken.
      expect(await assignTo(a.org, salesA)).toEqual([salesA.id]);
      await allHave([line], 'bell.changed', 1);
      expect(typesOf(line)).toEqual(['spider.settings.changed', 'bell.changed']);
    });

    it("Spider's starting summary rings the bell of the people it tells (the Activate-with-Send journey) and its per-lead alerts ring nothing", async () => {
      const c = await spiderCompany({ roles: ['SALES'] });
      const salesC = await fx.addUser(c.org, 'sales', 'SALES');
      await overdueLead(c.org, c.customer, salesC);
      const salesLine = await open(salesC);
      const adminLine = await open(c.admin);

      expect((await (await fx.signedInAs(c.admin)).put(STATUS, { isActive: true, startingSummary: 'send' })).status).toBe(200);
      await runSpiderSweep(new Date(Date.now() + 15 * 60_000));
      await allHave([salesLine], 'spider.summary.ready', 1);
      // Their bell has the summary: the count is there when the message is.
      const read = await (await fx.signedInAs(salesC)).get('/api/notifications/unread-count');
      expect(read.body.unseen).toBe(1);
      expect(rangFor(salesLine)).toBe(1);
      expect(rangFor(adminLine)).toBe(0);

      // The lead's own Spider alert (a later sweep) changes nothing in the bell.
      const before = rangFor(salesLine);
      await db.lead.updateMany({ where: { organization_id: c.org }, data: { created_at: new Date(Date.now() - 20 * HOUR) } });
      await runSpiderSweep(new Date(Date.now() + 30 * 60_000));
      publishSpiderLive(c.org, { type: 'settings_changed' });
      await allHave([salesLine], 'spider.settings.changed', 1);
      expect(rangFor(salesLine)).toBe(before);
    });
  });

  describe('what the line does not do (#3472 verifier)', () => {
    it('an exclusions save whose transaction rolls back sends nothing: the live message goes out only after the rows are written', async () => {
      const a = await spiderCompany({ roles: ['ADMIN'] });
      const line = await open(a.admin);
      const lead = await overdueLead(a.org, a.customer);
      const orig = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
      const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, opts: unknown) =>
        typeof fn === 'function'
          ? orig(async (tx: unknown) => {
              await (fn as (t: unknown) => Promise<unknown>)(tx);
              throw new Error('rollback after the work');
            }, opts)
          : orig(fn, opts)) as never);
      let status: number;
      try {
        status = (await (await fx.signedInAs(a.admin)).patch(EXCLUSIONS, { exclude: [lead.id], include: [] })).status;
      } finally {
        spy.mockRestore();
      }
      expect(status).toBe(500);
      const row = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: a.org } });
      expect(row.excluded_lead_ids).not.toContain(lead.id);
      // A marker of another type: everything sent before it has arrived once it has.
      publishSpiderLive(a.org, { type: 'alerts_ended', rows: [{ id: 'marker', recipient_id: a.admin.id }] });
      await allHave([line], 'spider.alert.ended', 1);
      expect(typesOf(line)).toEqual(['spider.alert.ended']);
    });

    it('a browser that gives up while its sign-in is still being checked leaves no line behind (it would count against the caps for 55 minutes)', async () => {
      const { admin } = await fx.newOrg();
      await fx.signedInAs(admin);
      (supabaseAdmin.auth.getUser as unknown as Mock).mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ data: { user: { id: admin.id, email: admin.email } }, error: null }), 400)),
      );
      const server = await fx.listener();
      const { port } = server.address() as AddressInfo;
      const before = liveLinesOpen();
      const req = http.request({ host: '127.0.0.1', port, path: LIVE, method: 'GET', headers: { Accept: 'text/event-stream', Authorization: `Bearer abort-${randomUUID()}` } });
      req.on('error', () => undefined);
      req.end();
      await new Promise((r) => setTimeout(r, 100));
      req.destroy();
      await new Promise((r) => setTimeout(r, 1_000));
      expect(liveLinesOpen()).toBe(before);
      // The person's five places are all still free.
      for (let i = 0; i < LIVE_LINES_PER_PERSON; i++) expect((await open(admin)).status).toBe(200);
    });
  });

  describe('the line itself', () => {
    it('opens only for a signed-in person, as an unbuffered event stream that names no vendor', async () => {
      const server = await fx.listener();
      const anonymous = await openLineOn(server, null);
      opened.push(anonymous);
      expect(anonymous.status).toBe(401);

      const { admin } = await fx.newOrg();
      const line = await open(admin);
      expect(line.status).toBe(200);
      expect(line.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(line.headers['cache-control']).toBe('no-cache, no-transform');
      expect(line.headers['x-accel-buffering']).toBe('no');
      // Not one of the app's middleware steps held the bytes back: the opening comment, then the server's hello, arrived
      // while the answer is open. The hello says Spider's check does not run here (SPIDER_WATCH_LIST is unset, #3469), so
      // the screen keeps its 30-second check.
      await until(() => line.hello !== null, 'the hello');
      expect(line.text).toBe(': open\n\nevent: live.hello\ndata: {"spider_tick":false,"bell":true}\n\n');
      expect(line.hello).toEqual({ spider_tick: false, bell: true });
      expect(line.ended).toBe(false);
      for (const [name, value] of Object.entries(line.headers)) expect(`${name}: ${String(value)}`).not.toMatch(VENDOR);
    });

    it("says, as it opens, whether Spider's check runs in this server: only then may the screen slow its own check", async () => {
      const { admin } = await fx.newOrg();
      try {
        tickRunning.value = true;
        const line = await open(admin);
        await until(() => line.hello !== null, 'the hello');
        expect(line.hello).toEqual({ spider_tick: true, bell: true });
        expect(line.events).toEqual([]);
        // Asked when each line opens: a line opened once the check no longer runs says so.
        tickRunning.value = false;
        const later = await open(admin);
        await until(() => later.hello !== null, 'the hello');
        expect(later.hello).toEqual({ spider_tick: false, bell: true });
      } finally {
        tickRunning.value = null;
      }
    });

    it('holds no database connection: three times as many lines as the pool has connections, and a database request still answers', async () => {
      const a = await spiderCompany({ roles: ['ADMIN'] });
      const people = [a.admin, await fx.addUser(a.org, 'p2', 'SALES'), await fx.addUser(a.org, 'p3', 'SALES')];
      const lines: OpenedLine[] = [];
      for (const person of people) for (let i = 0; i < POOL; i++) lines.push(await open(person));
      expect(liveLinesOpen()).toBe(3 * POOL);
      expect(lines.every((l) => l.status === 200 && !l.ended)).toBe(true);

      // A request that reads the database, answered within the pool's 5 s wait, while every line stays open.
      const read = await (await fx.signedInAs(a.admin)).get(UNREAD);
      expect(read.status).toBe(200);
      expect(lines.every((l) => !l.ended)).toBe(true);
    });

    it('sends a message with no query, and a save costs the same queries with 0 lines open as with 10', async () => {
      const a = await spiderCompany({ roles: ['ADMIN'] });
      const api = await fx.signedInAs(a.admin);
      const current = (await api.get(SETTINGS)).body.settings;
      const save = () => api.put(SETTINGS, { status_limits: current.status_limits, channels: current.channels, recipients: current.recipients });
      expect((await save()).status).toBe(200); // warm: the sign-in is cached from here on

      const none = await countQueries(async () => expect((await save()).status).toBe(200), db);
      const people = [a.admin, await fx.addUser(a.org, 'q2', 'SALES')];
      const lines: OpenedLine[] = [];
      for (const person of people) for (let i = 0; i < 5; i++) lines.push(await open(person));
      await fx.signedInAs(a.admin);
      const ten = await countQueries(async () => expect((await save()).status).toBe(200), db);
      expect(ten.count).toBe(none.count);
      await allHave(lines, 'spider.settings.changed', 1);

      const sent = await countQueries(async () => publishSpiderLive(a.org, { type: 'settings_changed' }), db);
      expect(sent.count).toBe(0);
      await allHave(lines, 'spider.settings.changed', 2);
      // The bell's message reads nothing either. (A read inside a publish that nobody awaits could land after the
      // counter stops, so the source guard notification-live-publish-guard.test.ts also holds both publish functions and the
      // line itself to importing no database client.)
      const rung = await countQueries(async () => publishBellChanged([{ organizationId: a.org, verb: 'lead.assigned', recipientIds: [a.admin.id] }]), db);
      expect(rung.count).toBe(0);
      await allHave(lines.slice(0, 5), 'bell.changed', 1);
    });

    it("is never cut by the server's request timeouts: it outlives them and still delivers", async () => {
      const app = (await import('../app.js')).default as unknown as RequestListener;
      // The production server bounds receiving a request (index.ts: headers 20 s, request 30 s); here far tighter.
      const server = http.createServer({ requestTimeout: 1_000, headersTimeout: 500, connectionsCheckingInterval: 100 }, app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      try {
        const a = await spiderCompany({ roles: ['ADMIN'] });
        await fx.signedInAs(a.admin);
        const line = await openLineOn(server, `Bearer switches-${a.admin.id}`);
        opened.push(line);
        expect(line.status).toBe(200);
        await new Promise((r) => setTimeout(r, 2_500));
        expect(line.ended).toBe(false);
        publishSpiderLive(a.org, { type: 'settings_changed' });
        await allHave([line], 'spider.settings.changed', 1);
      } finally {
        endAllLiveLines();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('caps each person at 5 lines (429) and refuses while the server stops (503), both with Retry-After', async () => {
      const { admin } = await fx.newOrg();
      for (let i = 0; i < LIVE_LINES_PER_PERSON; i++) expect((await open(admin)).status).toBe(200);
      const sixth = await open(admin);
      expect(sixth.status).toBe(429);
      expect(sixth.headers['retry-after']).toBe('60');
      await until(() => sixth.ended, 'the refusal to end');
      expect(JSON.parse(sixth.text)).toEqual({ error: 'Too many live updates open for this account' });

      endAllLiveLines();
      requestStop();
      const stopping = await open(admin);
      expect(stopping.status).toBe(503);
      expect(stopping.headers['retry-after']).toBe('60');
    });

    it("ends a person's lines when their sign-in is thrown away, and every line on shutdown", async () => {
      const a = await spiderCompany({ roles: ['ADMIN'] });
      const sales = await fx.addUser(a.org, 's', 'SALES');
      const adminLine = await open(a.admin);
      const salesLines = [await open(sales), await open(sales)];
      clearTokenCache(sales.id);
      await until(() => salesLines.every((l) => l.ended), "the person's lines to end");
      expect(adminLine.ended).toBe(false);

      const more = [await open(sales), await open(a.admin)];
      expect(endAllLiveLines()).toBe(3);
      await until(() => [adminLine, ...more].every((l) => l.ended), 'every line to end');
      expect(liveLinesOpen()).toBe(0);
    });

    it('many lines at once: 200 open, the server still answers, one message reaches all of them, and each costs little memory', async () => {
      const a = await spiderCompany({ roles: ['ADMIN'] });
      const people: Person[] = [a.admin];
      for (let i = 1; i < 40; i++) people.push(await fx.addUser(a.org, `m${i}`, 'SALES'));
      const heapBefore = process.memoryUsage().heapUsed;
      const lines: OpenedLine[] = [];
      for (const person of people) for (let i = 0; i < 5; i++) lines.push(await open(person));
      expect(liveLinesOpen()).toBe(200);

      // /health answers quickly with 200 lines open: the best of five (a noisy neighbour on the machine cannot fail it).
      const healthApi = await fx.signedInAs(a.admin);
      const healthMs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        const health = await healthApi.get('/health');
        healthMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        expect(health.status).toBe(200);
      }
      const bestHealthMs = Math.min(...healthMs);
      const started = Date.now();
      publishSpiderLive(a.org, { type: 'settings_changed' });
      await allHave(lines, 'spider.settings.changed', 1);
      const deliveredMs = Date.now() - started;
      const perLineKb = (process.memoryUsage().heapUsed - heapBefore) / 200 / 1024;
      console.info(`[live lines] 200 open: /health best of 5 ${bestHealthMs.toFixed(1)} ms; one message reached all in ${deliveredMs} ms; heap ~${perLineKb.toFixed(1)} KB per line (both ends in this process)`);
      expect(bestHealthMs).toBeLessThan(100);
      expect(deliveredMs).toBeLessThan(2_000);
      expect(perLineKb).toBeLessThan(200);
    }, 60_000);
  });
});
