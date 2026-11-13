/* =============================================================================
   #3462: removing a role or a person from Spider's alert recipients ends their open alerts, on a real migrated database,
   through the public routes (PUT /spider/settings, GET /spider/alerts/unread, the live line) and the sweep.

   The journey: an Admin removes the Dispatcher role while 5 alerts are open. The Dispatcher's next read has no cards and
   no frame, their screen is told on the live line, and their rows are read. The Admins and the lead's owner keep theirs.
   Then "lead owner" is switched off: the owner's cards go unless the owner is also chosen by role or by name.

   Also pinned: the read hides a removed person's card on its own (no ending yet), the sweep ends exactly their rows, adding
   recipients alerts nobody back or forward ("once is enough"), a second company is never touched, the Admins backstop
   (nobody chosen can be reached) keeps the Admins' alerts, and the cost at 60 people x 50 alerts.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, hooks } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const hooks = { beforeResolve: undefined as undefined | (() => Promise<void>), org: '' };
  if (!dbUrl) return { realClient: undefined, hooks };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }), hooks };
});
// Spider's recipient rule, plus a one-shot hook a case uses to save settings while the sweep's run is in flight.
vi.mock('../services/spider/recipients', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/spider/recipients')>();
  return {
    ...real,
    resolveSpiderRecipientsForLeads: async (...args: Parameters<typeof real.resolveSpiderRecipientsForLeads>) => {
      // Only for the company the case is about: a sweep serves every company in the database, in id order.
      const h = args[1].orgId === hooks.org ? hooks.beforeResolve : undefined;
      if (h) hooks.beforeResolve = undefined;
      if (h) await h();
      return real.resolveSpiderRecipientsForLeads(...args);
    },
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL, SPIDER_PILOT_ORG_IDS: undefined } };
});

import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import { switchFixture, type Person } from './permission-switches-fixture';
import { countQueries } from './support/query-counter';
import { endUncoveredRecipientRows, runSpiderSweep } from '../services/spider/sweep';
import { endAllLiveLines } from '../services/live/liveLines';

const suite = realClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const STATUS = '/api/ai-farm/spider/status';
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const HOUR = 3_600_000;
const ALERTS = 5;

interface Recipients {
  roles: string[];
  user_ids: string[];
  lead_owner: boolean;
}

interface Line {
  events: { type: string; data: Record<string, unknown> }[];
  text: string;
  close: () => void;
}

function openLineOn(server: Server, bearer: string): Promise<Line> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/live', method: 'GET', headers: { Accept: 'text/event-stream', Authorization: bearer } },
      (res) => {
        const line: Line = { events: [], text: '', close: () => req.destroy() };
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
            if (type && type !== 'live.hello' && data) line.events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
          }
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

suite('removing a recipient ends their open alerts (#3462, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  const lines: Line[] = [];

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  afterEach(() => {
    endAllLiveLines();
    for (const l of lines.splice(0)) l.close();
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

  const body = (recipients: Recipients) => ({
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients,
  });

  /**
   * A Spider company (demo, Scale) with an Admin, a Dispatcher, the leads' owner (Sales) and a Technician, its recipients
   * saved, Spider switched on, and `ALERTS` New leads past their limit (owned by the Sales person, on the Dispatcher's desk)
   * alerted by the sweep.
   */
  async function company(recipients: Recipients, opts: { technician?: boolean } = {}) {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    const dispatcher = await fx.addUser(o.org, 'dispatcher', 'DISPATCHER');
    const owner = await fx.addUser(o.org, 'owner', 'SALES');
    const tech = opts.technician === false ? null : await fx.addUser(o.org, 'tech', 'TECHNICIAN');
    const api = await fx.signedInAs(o.admin);
    expect((await api.put(SETTINGS, body(recipients))).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    const leads: string[] = [];
    for (let i = 0; i < ALERTS; i++) {
      const lead = await fx.addLead(o.org, o.customer, { owner: owner.id, dispatcher: dispatcher.id, assignees: [owner.id, dispatcher.id] });
      await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - 3 * HOUR) } });
      leads.push(lead.id);
    }
    await runSpiderSweep();
    return { ...o, dispatcher, owner, tech, leads, api };
  }

  const read = async (person: Person) => {
    const res = await (await fx.signedInAs(person)).get(UNREAD);
    expect(res.status).toBe(200);
    return res.body as { alerts: { id: string; lead_id: string }[]; frame: boolean; frame_ids: string[] };
  };
  const unreadRows = (org: string, person: Person) =>
    db.notificationRecipient.count({ where: { organization_id: org, recipient_id: person.id, read_at: null, notification: { verb: { startsWith: 'spider.' } } } });
  const readRows = (org: string, person: Person) =>
    db.notificationRecipient.count({ where: { organization_id: org, recipient_id: person.id, read_at: { not: null }, notification: { verb: { startsWith: 'spider.' } } } });
  const alertsOf = (org: string) => db.spiderAlert.count({ where: { organization_id: org } });

  async function openLine(person: Person): Promise<Line> {
    await fx.signedInAs(person);
    const line = await openLineOn(await fx.listener(), `Bearer switches-${person.id}`);
    lines.push(line);
    await until(() => line.text.startsWith(': open'), 'the line to open');
    return line;
  }
  const typesOf = (l: Line) => l.events.map((e) => e.type);

  it('the journey: the Dispatcher role removed with 5 alerts open ends their cards, frame and rows; the Admins and the owner keep theirs; lead owner off ends the owner\'s', async () => {
    const c = await company({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true });
    for (const p of [c.admin, c.dispatcher, c.owner]) expect((await read(p)).alerts).toHaveLength(ALERTS);
    expect((await read(c.dispatcher)).frame).toBe(true);
    expect(await alertsOf(c.org)).toBe(ALERTS);

    const dispatcherLine = await openLine(c.dispatcher);
    const adminLine = await openLine(c.admin);
    const ownerLine = await openLine(c.owner);
    const dispatcherRowIds = (await db.notificationRecipient.findMany({ where: { organization_id: c.org, recipient_id: c.dispatcher.id }, select: { id: true } })).map((r) => r.id);

    // The Admin removes the Dispatcher role: 200, and in the same request ...
    expect((await c.api.put(SETTINGS, body({ roles: ['ADMIN'], user_ids: [], lead_owner: true }))).status).toBe(200);
    const after = await read(c.dispatcher);
    expect(after.alerts).toEqual([]);
    expect(after.frame).toBe(false);
    expect(after.frame_ids).toEqual([]);
    // ... their rows are read, and nobody else's are touched.
    expect(await unreadRows(c.org, c.dispatcher)).toBe(0);
    expect(await readRows(c.org, c.dispatcher)).toBe(ALERTS);
    expect(await unreadRows(c.org, c.admin)).toBe(ALERTS);
    expect(await unreadRows(c.org, c.owner)).toBe(ALERTS);
    // Their screen is told, and only theirs: the frame goes with their last open alert.
    await until(() => typesOf(dispatcherLine).includes('spider.alert.ended'), 'the Dispatcher\'s alerts_ended');
    const endedIds = dispatcherLine.events.filter((e) => e.type === 'spider.alert.ended').flatMap((e) => e.data.ids as string[]);
    expect([...endedIds].sort()).toEqual([...dispatcherRowIds].sort());
    await until(() => typesOf(adminLine).includes('spider.settings.changed') && typesOf(ownerLine).includes('spider.settings.changed'), 'the save to reach the others');
    expect(typesOf(adminLine)).not.toContain('spider.alert.ended');
    expect(typesOf(ownerLine)).not.toContain('spider.alert.ended');
    expect((await read(c.admin)).alerts).toHaveLength(ALERTS);
    expect((await read(c.owner)).alerts).toHaveLength(ALERTS);

    // Added back: nobody is alerted again for the same stage visit (once is enough), and no card comes back.
    expect((await c.api.put(SETTINGS, body({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true }))).status).toBe(200);
    await runSpiderSweep();
    expect((await read(c.dispatcher)).alerts).toEqual([]);
    expect(await alertsOf(c.org)).toBe(ALERTS);
    expect(await unreadRows(c.org, c.dispatcher)).toBe(0);

    // "Lead owner" switched off: the owner, chosen by nothing else, loses their cards; the Admins keep theirs.
    expect((await c.api.put(SETTINGS, body({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false }))).status).toBe(200);
    expect((await read(c.owner)).alerts).toEqual([]);
    expect((await read(c.owner)).frame).toBe(false);
    expect(await unreadRows(c.org, c.owner)).toBe(0);
    expect((await read(c.admin)).alerts).toHaveLength(ALERTS);
    expect(await unreadRows(c.org, c.admin)).toBe(ALERTS);
  }, 120_000);

  it('the read hides a removed person\'s cards on its own, and the sweep then ends exactly their rows', async () => {
    const c = await company({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true });
    const dispatcherLine = await openLine(c.dispatcher);
    // Written straight to the settings: no save-time ending ran.
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: true } } });
    expect((await read(c.dispatcher)).alerts).toEqual([]);
    expect((await read(c.dispatcher)).frame).toBe(false);
    expect(await unreadRows(c.org, c.dispatcher)).toBe(ALERTS);

    await runSpiderSweep();
    expect(await unreadRows(c.org, c.dispatcher)).toBe(0);
    expect(await readRows(c.org, c.dispatcher)).toBe(ALERTS);
    expect(await unreadRows(c.org, c.admin)).toBe(ALERTS);
    expect(await unreadRows(c.org, c.owner)).toBe(ALERTS);
    await until(() => typesOf(dispatcherLine).includes('spider.alert.ended'), 'the Dispatcher\'s alerts_ended');
    expect(await alertsOf(c.org)).toBe(ALERTS);
  }, 120_000);

  it('a named person removed ends their cards; "lead owner" off keeps the owner who is still chosen by name or by role', async () => {
    const named = await company({ roles: ['ADMIN'], user_ids: [], lead_owner: true });
    expect((await named.api.put(SETTINGS, body({ roles: ['ADMIN'], user_ids: [named.owner.id], lead_owner: true }))).status).toBe(200);
    expect((await named.api.put(SETTINGS, body({ roles: ['ADMIN'], user_ids: [named.owner.id], lead_owner: false }))).status).toBe(200);
    expect((await read(named.owner)).alerts).toHaveLength(ALERTS);
    expect(await unreadRows(named.org, named.owner)).toBe(ALERTS);
    // The name taken out as well: now nothing chooses them.
    expect((await named.api.put(SETTINGS, body({ roles: ['ADMIN'], user_ids: [], lead_owner: false }))).status).toBe(200);
    expect((await read(named.owner)).alerts).toEqual([]);
    expect(await unreadRows(named.org, named.owner)).toBe(0);
    expect((await read(named.admin)).alerts).toHaveLength(ALERTS);

    const byRole = await company({ roles: ['ADMIN', 'SALES'], user_ids: [], lead_owner: true });
    expect((await byRole.api.put(SETTINGS, body({ roles: ['ADMIN', 'SALES'], user_ids: [], lead_owner: false }))).status).toBe(200);
    expect((await read(byRole.owner)).alerts).toHaveLength(ALERTS);
    expect(await unreadRows(byRole.org, byRole.owner)).toBe(ALERTS);
  }, 120_000);

  it('adding recipients alerts nobody retroactively, not on the save and not on the next sweep', async () => {
    const c = await company({ roles: ['ADMIN'], user_ids: [], lead_owner: false });
    expect(await unreadRows(c.org, c.tech!)).toBe(0);
    expect((await c.api.put(SETTINGS, body({ roles: ['ADMIN', 'TECHNICIAN', 'DISPATCHER'], user_ids: [c.owner.id], lead_owner: true }))).status).toBe(200);
    await runSpiderSweep();
    for (const p of [c.tech!, c.dispatcher, c.owner]) {
      expect((await read(p)).alerts).toEqual([]);
      expect(await unreadRows(c.org, p)).toBe(0);
      expect(await readRows(c.org, p)).toBe(0);
    }
    expect((await read(c.admin)).alerts).toHaveLength(ALERTS);
    expect(await alertsOf(c.org)).toBe(ALERTS);
  }, 120_000);

  it('one company\'s recipients save never touches another company\'s rows', async () => {
    const a = await company({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true });
    const b = await company({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true });
    expect((await a.api.put(SETTINGS, body({ roles: ['ADMIN'], user_ids: [], lead_owner: false }))).status).toBe(200);
    await runSpiderSweep();
    expect(await unreadRows(a.org, a.dispatcher)).toBe(0);
    expect(await unreadRows(a.org, a.owner)).toBe(0);
    for (const p of [b.admin, b.dispatcher, b.owner]) {
      expect(await unreadRows(b.org, p)).toBe(ALERTS);
      expect((await read(p)).alerts).toHaveLength(ALERTS);
    }
  }, 120_000);

  it('the Admins backstop: while nobody chosen can be reached the Admins keep their alerts, read and sweep alike', async () => {
    const c = await company({ roles: ['TECHNICIAN'], user_ids: [], lead_owner: false }, { technician: false });
    expect(await unreadRows(c.org, c.admin)).toBe(ALERTS);
    expect((await read(c.admin)).alerts).toHaveLength(ALERTS);
    await runSpiderSweep();
    expect(await unreadRows(c.org, c.admin)).toBe(ALERTS);
    expect((await read(c.admin)).alerts).toHaveLength(ALERTS);
  }, 120_000);

  /**
   * A bare Spider company: only the Admin exists besides what `setup` adds. Saves `recipients`, switches Spider on, adds
   * `leads` overdue leads (not assigned to anyone unless `setup` says so) and sweeps. The Admin has an open line.
   */
  async function bare(
    recipientsOf: Recipients | ((extra: Record<string, Person>) => Recipients),
    setup: (c: { org: string; customer: string; admin: Person }) => Promise<{ owner?: string; assignees?: string[]; extra?: Record<string, Person> }> = async () => ({}),
    leadsCount = 1,
  ) {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    const made = await setup(o);
    const api = await fx.signedInAs(o.admin);
    const recipients = typeof recipientsOf === 'function' ? recipientsOf(made.extra ?? {}) : recipientsOf;
    expect((await api.put(SETTINGS, body(recipients))).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    const adminLine = await openLine(o.admin);
    const leads: string[] = [];
    for (let i = 0; i < leadsCount; i++) {
      const lead = await fx.addLead(o.org, o.customer, { owner: made.owner, assignees: made.assignees ?? [] });
      await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - 3 * HOUR) } });
      leads.push(lead.id);
    }
    await runSpiderSweep();
    return { ...o, api, adminLine, leads, extra: made.extra ?? {} };
  }

  const pushedCards = (l: Line) => l.events.filter((e) => e.type === 'spider.alert.added').flatMap((e) => e.data.alerts as { id: string }[]);

  /** M1-M6: with no change at all, nothing is ever hidden or ended, and a card pushed on the line is the card the next read returns. */
  const NO_CHANGE: [string, Recipients | ((extra: Record<string, Person>) => Recipients), (c: { org: string; customer: string; admin: Person }) => Promise<{ owner?: string; assignees?: string[]; extra?: Record<string, Person> }>][] = [
    ['M1 nobody chosen can be reached: a lead owner is chosen and the lead has none', { roles: [], user_ids: [], lead_owner: true }, async () => ({})],
    ['M2 a chosen Technician cannot open the lead', { roles: ['TECHNICIAN'], user_ids: [], lead_owner: false }, async (c) => ({ extra: { tech: await fx.addUser(c.org, 'tech', 'TECHNICIAN') } })],
    ['M3 the lead\'s owner is deactivated', { roles: [], user_ids: [], lead_owner: true }, async (c) => {
      const owner = await fx.addUser(c.org, 'owner', 'SALES');
      await db.user.update({ where: { id: owner.id }, data: { is_active: false } });
      return { owner: owner.id, extra: { owner } };
    }],
    ['M4 the lead\'s owner cannot sign in', { roles: [], user_ids: [], lead_owner: true }, async (c) => {
      const owner = await fx.addUser(c.org, 'owner', 'SALES');
      await db.user.update({ where: { id: owner.id }, data: { has_login: false } });
      return { owner: owner.id, extra: { owner } };
    }],
    ['M5 the one chosen person is deactivated', (e) => ({ roles: [], user_ids: [e.named!.id], lead_owner: false }), async (c) => {
      const named = await fx.addUser(c.org, 'named', 'DISPATCHER');
      await db.user.update({ where: { id: named.id }, data: { is_active: false } });
      return { extra: { named } };
    }],
    ['M6 a chosen role has nobody in it', { roles: ['SALES'], user_ids: [], lead_owner: false }, async () => ({})],
  ];
  for (const [title, recipients, setup] of NO_CHANGE) {
    it(`${title}: the Admin fallback is raised, pushed, read and kept by the sweep, with no change at all`, async () => {
      const c = await bare(recipients, setup);
      expect(await unreadRows(c.org, c.admin)).toBe(1);
      await until(() => pushedCards(c.adminLine).length >= 1, 'the pushed card');
      const pushed = pushedCards(c.adminLine).map((a) => a.id);
      const read1 = (await read(c.admin)).alerts.map((a) => a.id);
      expect(read1).toEqual(pushed);
      await runSpiderSweep();
      expect(await unreadRows(c.org, c.admin)).toBe(1);
      expect((await read(c.admin)).alerts).toHaveLength(1);
      expect(c.adminLine.events.some((e) => e.type === 'spider.alert.ended')).toBe(false);
    }, 120_000);
  }

  it('Q1 adding people never takes an alert away: the Admin keeps 3, the new person gets nothing', async () => {
    const c = await bare({ roles: ['TECHNICIAN'], user_ids: [], lead_owner: false }, async () => ({}), 3);
    expect(await unreadRows(c.org, c.admin)).toBe(3);
    const dana = await fx.addUser(c.org, 'dana', 'DISPATCHER');
    expect((await c.api.put(SETTINGS, body({ roles: ['TECHNICIAN', 'DISPATCHER'], user_ids: [dana.id], lead_owner: false }))).status).toBe(200);
    await runSpiderSweep();
    expect((await read(c.admin)).alerts).toHaveLength(3);
    expect((await read(c.admin)).frame).toBe(true);
    expect(await unreadRows(c.org, c.admin)).toBe(3);
    expect(await unreadRows(c.org, dana)).toBe(0);
    expect(await readRows(c.org, dana)).toBe(0);
    // A save that removes one entry and adds another: the Admin was only the fallback, so they keep theirs.
    expect((await c.api.put(SETTINGS, body({ roles: ['DISPATCHER'], user_ids: [], lead_owner: false }))).status).toBe(200);
    await runSpiderSweep();
    expect(await unreadRows(c.org, c.admin)).toBe(3);
  }, 120_000);

  it('R1 a reassigned lead: the old owner loses the alert unless a role or name covers them; the new owner gets nothing; the Admin is unchanged', async () => {
    const c = await bare({ roles: ['ADMIN'], user_ids: [], lead_owner: true }, async (o) => {
      const sam = await fx.addUser(o.org, 'sam', 'SALES');
      const alex = await fx.addUser(o.org, 'alex', 'SALES');
      return { owner: sam.id, assignees: [sam.id, alex.id], extra: { sam, alex } };
    });
    const { sam, alex } = c.extra as { sam: Person; alex: Person };
    expect(await unreadRows(c.org, sam)).toBe(1);
    expect((await read(sam)).alerts).toHaveLength(1);
    await db.lead.update({ where: { id: c.leads[0]! }, data: { commission_owner_id: alex.id } });
    expect((await read(sam)).alerts).toEqual([]);
    expect((await read(sam)).frame).toBe(false);
    await runSpiderSweep();
    expect(await unreadRows(c.org, sam)).toBe(0);
    expect(await unreadRows(c.org, alex)).toBe(0);
    expect(await readRows(c.org, alex)).toBe(0);
    expect(await unreadRows(c.org, c.admin)).toBe(1);
    expect((await read(c.admin)).alerts).toHaveLength(1);

    // Covered by the Sales role: the same reassignment takes nothing from Sam.
    const d = await bare({ roles: ['ADMIN', 'SALES'], user_ids: [], lead_owner: true }, async (o) => {
      const sam2 = await fx.addUser(o.org, 'sam', 'SALES');
      const alex2 = await fx.addUser(o.org, 'alex', 'SALES');
      return { owner: sam2.id, assignees: [sam2.id, alex2.id], extra: { sam2, alex2 } };
    });
    const { sam2, alex2 } = d.extra as { sam2: Person; alex2: Person };
    await db.lead.update({ where: { id: d.leads[0]! }, data: { commission_owner_id: alex2.id } });
    await runSpiderSweep();
    expect(await unreadRows(d.org, sam2)).toBe(1);
    expect((await read(sam2)).alerts).toHaveLength(1);
  }, 120_000);

  it('the ADMIN role removed while other chosen people can reach the lead: the Admin loses theirs, the rest keep theirs', async () => {
    const c = await company({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false });
    expect(await unreadRows(c.org, c.admin)).toBe(ALERTS);
    expect((await c.api.put(SETTINGS, body({ roles: ['DISPATCHER'], user_ids: [], lead_owner: false }))).status).toBe(200);
    expect((await read(c.admin)).alerts).toEqual([]);
    expect(await unreadRows(c.org, c.admin)).toBe(0);
    expect(await readRows(c.org, c.admin)).toBe(ALERTS);
    expect(await unreadRows(c.org, c.dispatcher)).toBe(ALERTS);
    expect((await read(c.dispatcher)).alerts).toHaveLength(ALERTS);
  }, 120_000);

  it('the ADMIN role removed and nobody chosen can be reached for the lead: the Admin keeps theirs as the fallback', async () => {
    const c = await bare({ roles: ['ADMIN', 'TECHNICIAN'], user_ids: [], lead_owner: false }, async () => ({}), 2);
    expect(await unreadRows(c.org, c.admin)).toBe(2);
    expect((await c.api.put(SETTINGS, body({ roles: ['TECHNICIAN'], user_ids: [], lead_owner: false }))).status).toBe(200);
    await runSpiderSweep();
    expect(await unreadRows(c.org, c.admin)).toBe(2);
    expect((await read(c.admin)).alerts).toHaveLength(2);
  }, 120_000);

  it('O1 an Admin alerted as the lead\'s owner loses the card and the frame when the lead is reassigned; the new owner gets nothing', async () => {
    const c = await bare({ roles: [], user_ids: [], lead_owner: true }, async (o) => {
      const sam = await fx.addUser(o.org, 'sam', 'SALES');
      return { owner: o.admin.id, assignees: [o.admin.id, sam.id], extra: { sam } };
    });
    const sam = c.extra.sam!;
    expect(await unreadRows(c.org, c.admin)).toBe(1);
    expect((await read(c.admin)).alerts).toHaveLength(1);
    await db.lead.update({ where: { id: c.leads[0]! }, data: { commission_owner_id: sam.id } });
    const after = await read(c.admin);
    expect(after.alerts).toEqual([]);
    expect(after.frame).toBe(false);
    await runSpiderSweep();
    expect(await unreadRows(c.org, c.admin)).toBe(0);
    expect(await readRows(c.org, c.admin)).toBe(1);
    expect(await unreadRows(c.org, sam)).toBe(0);
    expect(await readRows(c.org, sam)).toBe(0);
    await until(() => typesOf(c.adminLine).includes('spider.alert.ended'), 'the Admin\'s alerts_ended');
  }, 120_000);

  it('O2 with ADMIN unticked, a second Admin who owned the lead loses it on reassignment; the Admin the role named never held it', async () => {
    const c = await bare({ roles: ['SALES', 'DISPATCHER'], user_ids: [], lead_owner: true }, async (o) => {
      const a2 = await fx.addUser(o.org, 'admintwo', 'ADMIN');
      const sam = await fx.addUser(o.org, 'sam', 'SALES');
      return { owner: a2.id, assignees: [a2.id, sam.id], extra: { a2, sam } };
    });
    const { a2, sam } = c.extra as { a2: Person; sam: Person };
    expect(await unreadRows(c.org, a2)).toBe(1);
    await db.lead.update({ where: { id: c.leads[0]! }, data: { commission_owner_id: sam.id } });
    expect((await read(a2)).alerts).toEqual([]);
    await runSpiderSweep();
    expect(await unreadRows(c.org, a2)).toBe(0);
    expect(await unreadRows(c.org, sam)).toBe(1);
  }, 120_000);

  it('O3 an Admin who owned the lead keeps the alert when the lead is left with no owner and nobody chosen can be reached (the fallback)', async () => {
    const c = await bare({ roles: [], user_ids: [], lead_owner: true }, async (o) => ({ owner: o.admin.id, assignees: [o.admin.id] }));
    expect(await unreadRows(c.org, c.admin)).toBe(1);
    await db.lead.update({ where: { id: c.leads[0]! }, data: { commission_owner_id: null } });
    expect((await read(c.admin)).alerts).toHaveLength(1);
    await runSpiderSweep();
    expect(await unreadRows(c.org, c.admin)).toBe(1);
  }, 120_000);

  it('RB the unread read costs an Admin the same statements as anyone, when the saved roles name them (no extra users read)', async () => {
    const c = await company({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false });
    await read(c.admin);
    await read(c.dispatcher);
    const statements = async (p: Person) => {
      const api = await fx.signedInAs(p);
      const { result, queries } = await countQueries(() => api.get(UNREAD), db);
      expect(result.status).toBe(200);
      expect(result.body.alerts).toHaveLength(ALERTS);
      return { count: queries.length, users: queries.filter((q) => /FROM "public"\."users"|FROM users/.test(q.sql)).length };
    };
    const admin = await statements(c.admin);
    const dispatcher = await statements(c.dispatcher);
    expect(admin.count).toBe(dispatcher.count);
  }, 120_000);

  it('RC the sweep\'s ending judges by the recipients saved at the ending, not the ones read when the run began', async () => {
    const c = await bare({ roles: ['ADMIN'], user_ids: [], lead_owner: false });
    const dispatcher = await fx.addUser(c.org, 'dispatcher', 'DISPATCHER');
    const lead2 = await fx.addLead(c.org, c.customer, {});
    await db.lead.update({ where: { id: lead2.id }, data: { created_at: new Date(Date.now() - 3 * HOUR) } });
    const [n1] = await db.notification.findMany({ where: { organization_id: c.org, object_id: c.leads[0]!, verb: 'spider.alert' }, select: { id: true } });
    // While the run raises the second lead's alert, a save adds DISPATCHER and a Dispatcher row exists for the first.
    hooks.org = c.org;
    hooks.beforeResolve = async () => {
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { recipients: { roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false } } });
      await db.notificationRecipient.create({ data: { notification_id: n1!.id, organization_id: c.org, recipient_id: dispatcher.id, priority: 'FEED' } });
    };
    await runSpiderSweep();
    expect(hooks.beforeResolve).toBeUndefined();
    // The row the save's own world holds for the Dispatcher is still open (the run-start recipients would have ended it).
    expect(await db.notificationRecipient.count({ where: { notification_id: n1!.id, recipient_id: dispatcher.id, read_at: null } })).toBe(1);
  }, 120_000);

  it('cost at 60 people x 50 alerts, one role removed: a fixed number of statements, no per-alert query, well under 1 s', { timeout: 180_000 }, async () => {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    const PEOPLE = 60;
    const LEADS = 50;
    const dispatchers: string[] = [];
    const sales: string[] = [];
    const users = Array.from({ length: PEOPLE }, (_, i) => {
      const id = randomUUID();
      (i % 2 === 0 ? dispatchers : sales).push(id);
      return {
        id, organization_id: o.org, email: `p${i}-${id.slice(0, 8)}@example.test`, first_name: `P${i}`, last_name: 'Tester',
        role: i % 2 === 0 ? ('DISPATCHER' as const) : ('SALES' as const), is_admin: false,
      };
    });
    await db.user.createMany({ data: users });
    const enteredAt = new Date(Date.now() - 3 * HOUR);
    const leadIds = Array.from({ length: LEADS }, () => randomUUID());
    await db.lead.createMany({
      data: leadIds.map((id, i) => ({
        id, organization_id: o.org, customer_id: o.customer, lead_number: `L-${i}`, service_request: 'Fix the door', created_at: enteredAt,
        commission_owner_id: sales[0]!,
      })),
    });
    const notificationIds = leadIds.map(() => randomUUID());
    await db.notification.createMany({
      data: leadIds.map((leadId, i) => ({
        id: notificationIds[i]!, organization_id: o.org, verb: 'spider.alert', category: 'LEAD' as const, priority: 'FEED' as const,
        object_type: 'LEAD', object_id: leadId, object_label: 'L', title: 'Spider',
        data: { lead_number: 'L', customer_name: 'Pat Payer', status: 'NEW', status_label: 'New', entered_status_at: enteredAt.toISOString() },
      })),
    });
    await db.notificationRecipient.createMany({
      data: notificationIds.flatMap((id) => users.map((u) => ({ notification_id: id, organization_id: o.org, recipient_id: u.id, priority: 'FEED' as const }))),
    });
    expect(await db.notificationRecipient.count({ where: { organization_id: o.org } })).toBe(PEOPLE * LEADS);

    // Dispatchers removed: 30 people x 50 alerts = 1,500 rows end; the Sales people's 1,500 stay.
    const recipients = { roles: ['SALES' as const], user_ids: [], lead_owner: true };
    const started = Date.now();
    const { result: ended, count, queries } = await countQueries(() => endUncoveredRecipientRows(o.org, new Date(), recipients as never), db);
    const ms = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`[#3462 scale] ${PEOPLE} people x ${LEADS} alerts, one role removed: ${ended} rows ended in ${count} statements (${queries.length} counted), ${ms} ms`);
    expect(ended).toBe((PEOPLE / 2) * LEADS);
    expect(ms).toBeLessThan(1_000);
    expect(await db.notificationRecipient.count({ where: { organization_id: o.org, read_at: null } })).toBe((PEOPLE / 2) * LEADS);
    expect(await db.notificationRecipient.count({ where: { organization_id: o.org, read_at: null, recipient_id: { in: dispatchers } } })).toBe(0);

    // The same call again ends nothing, in the statements of one page: the cost does not depend on the number of alerts.
    const again = await countQueries(() => endUncoveredRecipientRows(o.org, new Date(), recipients as never), db);
    expect(again.result).toBe(0);
    expect(again.count).toBeLessThanOrEqual(count);
  });
});
