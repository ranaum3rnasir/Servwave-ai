/* =============================================================================
   Roles & Permissions, pre-PR review fixes (security review SR-1, SR-2, SR-7 and the older lock checks): a record id
   spelled any way but the canonical one names nothing.

   The database reads a uuid written in many ways: without dashes, in braces, as `urn:uuid:...`, in upper or mixed case,
   with a dash after every four digits. The reach wrapper (ticket 33), the Owner check (ticket 26) and the job and lead
   locks used to skip their check for any id that was not written the usual way, while the handler behind them still found
   the record. Now a record id a route names in any spelling but the canonical lower-case hyphenated one answers 404
   before anything reads the record, and so does a request field that names a record in another spelling.

   Each spelling is sent:
    - SR-1 and SR-7: to every parameter route of the calendar entry, asset, lead, job, estimate and invoice routers, as a
      person who can't reach the record (every switch on, every scope Their own), with the id of a real record they can't
      reach. Every answer is 404, the same as for a missing id spelled the same way, and the record is left as it was.
    - SR-2: to every `/:id` route of the people routes, as an Admin who is not the Owner, naming the Owner. Every answer is
      404, and the Owner's account and mailbox are left as they were; nothing is asked of the provider or sent.
    - Every router: to every mounted route that names a record id, read from the live app (so a route added later is in
      this test the day it lands), as the Owner. Every answer is 404.
    - Request fields: to a sample of the doors that take a record id in their body or query string. Every answer is 404 and
      nothing in the company changes.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Router } from 'express';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
const { sendUserInviteEmail, sendPasswordResetEmail, sendAdminChangeAlertEmail } = vi.hoisted(() => ({
  sendUserInviteEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendAdminChangeAlertEmail: vi.fn(),
}));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail,
  sendPasswordResetEmail,
  sendAdminChangeAlertEmail,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { unscopedRequest } from '../middleware/unscopedRequest';
import { routeCheckOf } from '../middleware/routeCheck';
import { supabaseAdmin } from '../lib/supabase';

/** Every other spelling of a canonical id that the database still reads as that id. */
const SPELLINGS: Record<string, (id: string) => string> = {
  'no dashes': (id) => id.replace(/-/g, ''),
  'in braces': (id) => `{${id}}`,
  'urn form': (id) => `urn:uuid:${id}`,
  'upper case': (id) => id.toUpperCase(),
  'mixed case': (id) => {
    let flip = false;
    const mixed = id.replace(/[a-f]/g, (c) => ((flip = !flip) ? c.toUpperCase() : c));
    return mixed === id ? id.toUpperCase() : mixed;
  },
  'a dash every four digits': (id) => id.replace(/-/g, '').replace(/(.{4})(?=.)/g, '$1-'),
};
const SPELLING_NAMES = Object.keys(SPELLINGS);
/** The spelling as it goes into a path: one segment, encoded. */
const inPath = (spelled: string) => encodeURIComponent(spelled);

const suite = realClient ? describe : describe.skip;

suite('a record id in any spelling but the canonical one names nothing (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com', MAILBOX_ADDRESS_HASH_KEY: 'test-mailbox-hash-key-0123456789abcdef' });
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const where = { where: { organization_id: { in: orgs } } };
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.calendarEntryParticipant.deleteMany(where));
    await quietly(db.calendarEntry.deleteMany(where));
    await quietly(db.asset.deleteMany(where));
    await quietly(db.task.deleteMany(where));
    await quietly(db.mailboxAddress.deleteMany(where));
    await fx.cleanup();
  });

  const authAdmin = supabaseAdmin.auth.admin as unknown as Record<'listUsers' | 'deleteUser' | 'createUser' | 'generateLink', ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    authAdmin.listUsers.mockReset().mockResolvedValue({ data: { users: [], nextPage: null }, error: null });
    authAdmin.deleteUser.mockReset().mockResolvedValue({ data: null, error: null });
    authAdmin.createUser.mockReset().mockImplementation(async () => ({ data: { user: { id: randomUUID() } }, error: null }));
    authAdmin.generateLink.mockReset().mockResolvedValue({ data: { properties: { hashed_token: 'hashed-recovery-token' } }, error: null });
    sendUserInviteEmail.mockReset().mockResolvedValue(true);
    sendPasswordResetEmail.mockReset().mockResolvedValue(true);
    sendAdminChangeAlertEmail.mockReset().mockResolvedValue(true);
  });

  let org = '';
  let customer = '';
  let owner: Person;
  /** Every switch on, every scope Their own. */
  let reachless: Person;

  beforeAll(async () => {
    const o = await fx.newOrg();
    orgs.push(o.org);
    ({ org, customer } = o);
    owner = o.admin;
    const values: Record<string, unknown> = { ...presetSwitchSet('ADMIN') };
    for (const s of SWITCH_CATALOG) if (s.kind === 'choice' && s.key.endsWith('_scope')) values[s.key] = 'attached';
    await fx.addCustomRole(org, 'spelled-reach', 'DISPATCHER');
    await fx.setRoleSwitches(org, 'spelled-reach', values as never);
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: 'spelled-reach' } });
    reachless = await fx.addUser(org, 'spelled', 'DISPATCHER', { customRoleId: role.id });
    await fx.addUserMailbox(org, reachless);
  }, 120_000);

  type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
  const send = async (as: Person, method: Method, url: string, body: object = {}) => {
    const api = await fx.signedInAs(as);
    return method === 'delete' ? api.delete(url, body) : method === 'get' ? api.get(url) : api[method](url, body);
  };
  const answer = (res: { status: number; body: unknown; text: string }, spelled: string) => ({
    status: res.status,
    body: JSON.stringify(res.body && Object.keys(res.body as object).length ? res.body : res.text)
      .split(spelled).join('<id>').split(inPath(spelled)).join('<id>'),
  });

  const fill = (path: string, values: Record<string, string>) =>
    path.replace(/:([A-Za-z]+)\??/g, (_m, name: string) => {
      const v = values[name];
      if (v === undefined) throw new Error(`no value for :${name} in ${path}`);
      return v;
    });

  /**
   * A route whose permission gate refuses this person whatever the record (a switch they lack, an Owner-only action) answers
   * them 403 before any record is read. That is allowed only when a canonical id of no record gets the very same answer.
   */
  async function gateRefuses(as: Person, r: { method: Method; path: string }, mount: string, params: Record<string, string>, res: { status: number; body: unknown }) {
    if (res.status !== 403) return false;
    const missing = await send(as, r.method, `${mount}${fill(r.path, { ...params, id: randomUUID() })}`);
    return missing.status === 403 && JSON.stringify(missing.body) === JSON.stringify(res.body);
  }

  // ─── SR-1 and SR-7: records the person can't reach, spelled another way ───────────────────────────────────────────
  async function calendarEntry() {
    const id = randomUUID();
    const start = new Date(Date.now() + 86_400_000);
    await db.calendarEntry.create({ data: { id, organization_id: org, title: 'Meeting', start, end: new Date(start.getTime() + 3_600_000), created_by: owner.id } });
    await db.calendarEntryParticipant.create({ data: { organization_id: org, calendar_entry_id: id, kind: 'USER', user_id: owner.id } });
    return id;
  }
  async function asset() {
    const id = randomUUID();
    await db.asset.create({ data: { id, organization_id: org, name: 'Ladder', assigned_user_id: owner.id } });
    return id;
  }

  type Covered = {
    file: string;
    mount: string;
    /** The out-of-reach record, the other parameters the routes need, and the record's row as it stands. */
    record: () => Promise<{ id: string; params: Record<string, string> }>;
    row: (id: string) => Promise<unknown>;
  };
  const COVERED: Covered[] = [
    {
      file: 'calendar-entry.routes.ts', mount: '/api/calendar-entries',
      record: async () => ({ id: await calendarEntry(), params: {} }),
      row: (id) => db.calendarEntry.findUnique({ where: { id }, include: { participants: true } }),
    },
    {
      file: 'inv-assets.routes.ts', mount: '/api/inventory',
      record: async () => ({ id: await asset(), params: {} }),
      row: (id) => db.asset.findUnique({ where: { id } }),
    },
    {
      file: 'lead.routes.ts', mount: '/api/leads',
      record: async () => {
        const l = await fx.addLead(org, customer, { walkthroughCrew: [owner.id] });
        return { id: l.id, params: { visitId: l.walkthroughId!, noteId: randomUUID(), entryId: randomUUID(), tagId: randomUUID() } };
      },
      row: (id) => db.lead.findUnique({ where: { id } }),
    },
    {
      file: 'job.routes.ts', mount: '/api/jobs',
      record: async () => {
        const j = await fx.addJob(org, customer, { crew: [owner.id] });
        return { id: j.id, params: { visitId: j.visitId!, lineId: randomUUID(), idx: '0', noteId: randomUUID(), entryId: randomUUID(), tagId: randomUUID() } };
      },
      row: (id) => db.job.findUnique({ where: { id } }),
    },
    {
      file: 'estimate.routes.ts', mount: '/api/estimates',
      record: async () => {
        const l = await fx.addLead(org, customer, { walkthroughCrew: [owner.id] });
        const e = await fx.addEstimate(org, customer, owner.id, { leadId: l.id });
        return { id: e.id, params: { lineId: e.lineId, idx: '0', scopeId: randomUUID(), photoId: randomUUID(), version: '1', tagId: randomUUID() } };
      },
      row: (id) => db.estimate.findUnique({ where: { id } }),
    },
    {
      file: 'invoice.routes.ts', mount: '/api/invoices',
      record: async () => {
        const j = await fx.addJob(org, customer, { crew: [owner.id] });
        const inv = await fx.addInvoice(org, customer, { jobId: j.id });
        return { id: inv.id, params: { lineId: inv.lineId, idx: '0', tagId: randomUUID() } };
      },
      row: (id) => db.invoice.findUnique({ where: { id } }),
    },
  ];

  /** The router's `:id` routes for a signed-in person (a customer's own link is left out: no person, no reach). */
  async function idRoutes(file: string): Promise<{ method: Method; path: string }[]> {
    const router = (await import(`../routes/${file.replace(/\.ts$/, '.js')}`)).default as Router;
    const out: { method: Method; path: string }[] = [];
    for (const layer of router.stack as unknown as { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } }[]) {
      const route = layer.route;
      if (!route || !/\/:id(?=\/|$)/.test(route.path)) continue;
      if (route.stack.some((l) => l.handle === unscopedRequest)) continue;
      // A parked route answers the same to everyone and touches nothing.
      if (route.stack.some((l) => routeCheckOf(l.handle) === 'closed')) continue;
      for (const method of Object.keys(route.methods)) out.push({ method: method as Method, path: route.path });
    }
    return out;
  }

  for (const c of COVERED) {
    it(`${c.file}: every :id route answers 404 for an out-of-reach record in every other spelling, the same as a missing one, and changes nothing`, async () => {
      const routes = await idRoutes(c.file);
      expect(routes.length).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const [n, r] of routes.entries()) {
        const rec = await c.record();
        const before = JSON.stringify(await c.row(rec.id));
        for (const name of SPELLING_NAMES) {
          const spelled = SPELLINGS[name]!(rec.id);
          const res = await send(reachless, r.method, `${c.mount}${fill(r.path, { ...rec.params, id: inPath(spelled) })}`);
          if (res.status !== 404 && !(await gateRefuses(reachless, r, `${c.mount}`, rec.params, res))) wrong.push(`${r.method.toUpperCase()} ${r.path} [${name}]: ${res.status} ${JSON.stringify(res.body)}`);
        }
        // One spelling per route (in turn) is also compared with a missing id spelled the same way: the answers match.
        const name = SPELLING_NAMES[n % SPELLING_NAMES.length]!;
        const missingId = randomUUID();
        const hidden = SPELLINGS[name]!(rec.id);
        const missing = SPELLINGS[name]!(missingId);
        const a = answer(await send(reachless, r.method, `${c.mount}${fill(r.path, { ...rec.params, id: inPath(hidden) })}`), hidden);
        const b = answer(await send(reachless, r.method, `${c.mount}${fill(r.path, { ...rec.params, id: inPath(missing) })}`), missing);
        if (a.status !== b.status || a.body !== b.body) wrong.push(`${r.method.toUpperCase()} ${r.path} [${name}]: out of reach ${a.status} ${a.body} / missing ${b.status} ${b.body}`);
        if (JSON.stringify(await c.row(rec.id)) !== before) wrong.push(`${r.method.toUpperCase()} ${r.path}: the record changed`);
      }
      expect(wrong).toEqual([]);
    }, 900_000);
  }

  // ─── SR-2: an Admin who is not the Owner, naming the Owner in another spelling ─────────────────────────────────────
  it("users: every /:id route answers 404 to an Admin who is not the Owner naming the Owner in any other spelling, and the Owner's account is untouched", async () => {
    const other = await fx.addUser(org, 'ada', 'ADMIN');
    await db.organization.update({ where: { id: org }, data: { email_sender_local_part: `co${randomUUID().slice(0, 6).replace(/[0-9]/g, 'x')}` } });
    const box = await db.mailbox.findFirst({ where: { user_id: owner.id } }) ?? await db.mailbox.create({
      data: { organization_id: org, kind: 'user', user_id: owner.id, holder_user_id: owner.id, status: 'active' },
    });
    await db.mailboxAddress.create({ data: { local_part: `owner${randomUUID().slice(0, 6).replace(/[0-9]/g, 'y')}`, organization_id: org, mailbox_id: box.id, is_primary: true } });
    const ownerNow = async () => ({
      user: await db.user.findUniqueOrThrow({ where: { id: owner.id } }),
      mailbox: await db.mailbox.findMany({ where: { user_id: owner.id }, include: { addresses: { select: { local_part: true, is_primary: true } } } }),
      owner: (await db.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } })).owner_user_id,
    });
    const before = JSON.stringify(await ownerNow());

    const BODIES: Record<string, object> = {
      'PUT /:id/mailbox-address': { name_part: 'takenover' },
      'PATCH /:id': { first_name: 'Renamed', is_admin: false },
      'PUT /:id/mailbox-handover': { handover_to: 'main' },
      'PUT /:id/permissions': { values: { show_email: true } },
      'POST /:id/permissions/reset': { all: true },
      'POST /:id/permissions/save-as-role': { label: 'Taken over' },
    };
    const routes = await idRoutes('user.routes.ts');
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`)).toContain('PUT /:id/mailbox-address');
    const wrong: string[] = [];
    for (const r of routes) {
      for (const name of SPELLING_NAMES) {
        const res = await send(other, r.method, `/api/users${fill(r.path, { id: inPath(SPELLINGS[name]!(owner.id)) })}`, BODIES[`${r.method.toUpperCase()} ${r.path}`] ?? {});
        if (res.status !== 404 && !(await gateRefuses(other, r, '/api/users', {}, res))) wrong.push(`${r.method.toUpperCase()} ${r.path} [${name}]: ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(JSON.stringify(await ownerNow())).toBe(before);
    expect(authAdmin.createUser).not.toHaveBeenCalled();
    expect(authAdmin.deleteUser).not.toHaveBeenCalled();
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
    expect(sendUserInviteEmail).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(sendAdminChangeAlertEmail).not.toHaveBeenCalled();
  }, 300_000);

  // ─── Every router: every mounted route that names a record id, read from the live app ─────────────────────────────
  type Layer = { name: string; handle: unknown; regexp: RegExp; route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] } };
  /** The path a `use` layer was mounted at, read back from the regexp Express 4 compiled for it ('' for the root). */
  function mountPathOf(re: RegExp): string {
    const s = re.source;
    if (s === '^\\/?$' || s === '^\\/?(?=\\/|$)') return '';
    return s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/');
  }
  function mounted(stack: Layer[], prefix = ''): { method: Method; path: string; steps: unknown[] }[] {
    const out: { method: Method; path: string; steps: unknown[] }[] = [];
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) for (const m of Object.keys(layer.route.methods)) out.push({ method: (m === '_all' ? 'get' : m) as Method, path: prefix + p, steps: layer.route.stack.map((l) => l.handle) });
      } else if (layer.name === 'router') {
        out.push(...mounted((layer.handle as { stack: Layer[] }).stack, prefix + mountPathOf(layer.regexp)));
      }
    }
    return out;
  }
  /** A parameter that names a record: `:id`, or `:<thing>Id`. A scope's id names a block inside an estimate, not a record. */
  const RECORD_PARAM = /:((?:id)|(?:[a-z][A-Za-z]*Id))(?=\/|$|\?)/g;
  const NOT_A_RECORD_PARAM = new Set(['scopeId']);

  it('every mounted route that names a record id answers 404 when the id is spelled another way (the Owner, every router)', async () => {
    const app = (await import('../app.js')).default as unknown as { _router: { stack: Layer[] } };
    const routes = mounted(app._router.stack)
      .filter((r) => r.path.startsWith('/api/') && !r.path.startsWith('/api/webhooks/'))
      .filter((r) => !r.steps.some((s) => routeCheckOf(s) === 'closed'))
      .filter((r) => [...r.path.matchAll(RECORD_PARAM)].some((m) => !NOT_A_RECORD_PARAM.has(m[1]!)));
    expect(routes.length).toBeGreaterThan(300);
    const routers = new Set(routes.map((r) => r.path.split('/').slice(0, 4).join('/')));
    expect(routers.size).toBeGreaterThan(30);
    const wrong: string[] = [];
    for (const [n, r] of routes.entries()) {
      const name = SPELLING_NAMES[n % SPELLING_NAMES.length]!;
      const id = randomUUID();
      const url = r.path.replace(/:([A-Za-z]+)\??/g, (_m, p: string) => {
        if (p === 'id' || (/[a-z]Id$/.test(p) && !NOT_A_RECORD_PARAM.has(p))) return inPath(SPELLINGS[name]!(id));
        return p === 'entityType' ? 'job' : p === 'role' ? 'ADMIN' : p === 'idx' || p === 'index' || p === 'version' ? '0' : randomUUID();
      });
      const res = await send(owner, r.method, url);
      if (res.status !== 404) wrong.push(`${r.method.toUpperCase()} ${r.path} [${name}]: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  }, 900_000);

  // ─── Request fields that name a record ───────────────────────────────────────────────────────────────────────────
  it('a record named in a request body or query string in another spelling answers 404, and nothing in the company changes', async () => {
    const job = await fx.addJob(org, customer, { crew: [owner.id] });
    const lead = await fx.addLead(org, customer, { walkthroughCrew: [owner.id] });
    const est = await fx.addEstimate(org, customer, owner.id, { leadId: lead.id });
    await db.estimate.update({ where: { id: est.id }, data: { status: 'SENT', sent_at: new Date() } });
    const state = async () => {
      const where = { where: { organization_id: org } };
      return JSON.stringify({
        invoices: await db.invoice.count(where), estimates: await db.estimate.findMany({ ...where, select: { id: true, status: true, job_id: true }, orderBy: { id: 'asc' } }),
        jobs: await db.job.findMany({ ...where, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
        tasks: await db.task.count(where), entries: await db.calendarEntry.count(where), orders: await db.logisticOrder.count(where),
        tags: await db.tagAssignment.count({ where: { organization_id: org } }),
      });
    };
    const before = await state();
    const DOORS: { name: string; method: Method; url: (s: string) => string; body?: (s: string) => object; as: Person }[] = [
      { name: 'POST /api/invoices job_id', method: 'post', url: () => '/api/invoices', body: (s) => ({ job_id: s }), as: reachless },
      { name: 'POST /api/estimates lead_id', method: 'post', url: () => '/api/estimates', body: (s) => ({ lead_id: s }), as: reachless },
      { name: 'POST /api/estimates job_id', method: 'post', url: () => '/api/estimates', body: (s) => ({ job_id: s }), as: reachless },
      { name: 'POST /api/tasks linked_entity_id', method: 'post', url: () => '/api/tasks', body: (s) => ({ title: 'Call', linked_entity_type: 'JOB', linked_entity_id: s }), as: reachless },
      { name: 'POST /api/estimates/bulk-send-reminder ids', method: 'post', url: () => '/api/estimates/bulk-send-reminder', body: (s) => ({ ids: [s] }), as: reachless },
      { name: 'POST /api/jobs/bulk-status ids', method: 'post', url: () => '/api/jobs/bulk-status', body: (s) => ({ ids: [s], status: 'CANCELLED' }), as: reachless },
      { name: 'POST /api/logistic-orders job_id', method: 'post', url: () => '/api/logistic-orders', body: (s) => ({ job_id: s, items: [] }), as: reachless },
      { name: 'GET /api/tasks?linked_entity_id', method: 'get', url: (s) => `/api/tasks?linked_entity_type=JOB&linked_entity_id=${encodeURIComponent(s)}`, as: reachless },
      { name: 'GET /api/inventory/job-stages?job_id', method: 'get', url: (s) => `/api/inventory/job-stages?job_id=${encodeURIComponent(s)}`, as: reachless },
      { name: 'GET /api/jobs/cancel-preview?ids', method: 'get', url: (s) => `/api/jobs/cancel-preview?ids=${encodeURIComponent(s)}`, as: reachless },
      { name: 'GET /api/tasks?entity_id', method: 'get', url: (s) => `/api/tasks/entity-access?entity_type=JOB&entity_id=${encodeURIComponent(s)}`, as: reachless },
    ];
    const idFor = (door: string) => (/lead_id/.test(door) ? lead.id : /bulk-send-reminder/.test(door) ? est.id : job.id);
    const wrong: string[] = [];
    for (const d of DOORS) {
      for (const name of SPELLING_NAMES) {
        const spelled = SPELLINGS[name]!(idFor(d.name));
        const res = await send(d.as, d.method, d.url(spelled), d.body?.(spelled) ?? {});
        if (res.status !== 404) wrong.push(`${d.name} [${name}]: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(await state()).toBe(before);
  }, 300_000);
});
