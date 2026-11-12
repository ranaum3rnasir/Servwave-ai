/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec stories 47 and 50, build item 3): "not found" means not found.

   A record a person can't reach answers exactly like a record that does not exist, on every route that takes a record
   id, so the answer never confirms that the id is real. The routes are not a hand list: they are read from the routers
   themselves, so a route added later is in this test the day it lands. Every route file with a parameter route is either
   a router of records that have reach (covered, every one of its parameter routes) or named below with the reason it is
   not; a new route file fails the classification test until someone decides which it is.

   The person is on a custom role holding every switch on (so no route refuses them by a switch, and only reach is left to
   decide) and every scope at Their own; the records are the Admin's, with nobody else on them. Each route is called twice,
   once with that record's id and once with an id that does not exist, and the two answers must match in status and body.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Router } from 'express';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { unscopedRequest } from '../middleware/unscopedRequest';
import { signUploadTicket } from '../lib/attachment-direct-upload';

const ROUTES_DIR = join(__dirname, '..', 'routes');

/** Route files whose parameter routes are not about a record with reach, and why. */
const NOT_RECORD_ROUTERS: Record<string, string> = {
  'auth.routes.ts': 'sign-in and invite tokens, no record',
  'user.routes.ts': 'people and their access: Admin-only management (ticket 28), not a record with reach',
  'role.routes.ts': 'roles: Admin-only management (ticket 28)',
  'department.routes.ts': 'company set-up list',
  'settings.routes.ts': 'company settings',
  'organization.routes.ts': 'the company itself',
  'tag.routes.ts': 'company tag list',
  'table-view.routes.ts': "the person's own saved views",
  'task-category.routes.ts': 'company set-up list',
  'location.routes.ts': 'company set-up list',
  'leadSource.routes.ts': 'company set-up list',
  'jobType.routes.ts': 'company set-up list',
  'jobSubStatus.routes.ts': 'company set-up list',
  'lostReasonOption.routes.ts': 'company set-up list',
  'jobCancelReason.routes.ts': 'company set-up list',
  'org-tax-rate.routes.ts': 'company set-up list',
  'price-book.routes.ts': 'the price book: company catalog, no scope',
  'service-plan.routes.ts': 'service plans have no scope of their own: a plan is opened by its switch, not by reach',
  'workflow.routes.ts': 'company automations',
  'custom-field-definitions.routes.ts': 'company set-up list',
  'notification.routes.ts': "the person's own bell",
  'copilot.routes.ts': 'the copilot is not running (CLAUDE.md)',
  'webhook.routes.ts': 'vendor callbacks, no signed-in person',
  'inv-catalog.routes.ts': 'inventory catalog: company stock, no scope',
  'inv-locations.routes.ts': 'inventory locations: company set-up',
  'inv-vendors.routes.ts': 'inventory vendors: company set-up',
  'inv-stock.routes.ts': 'stock levels: company stock, no scope',
  'comm-threads.routes.ts': 'message reach is per message (ticket 31)',
  'comm-email.routes.ts': 'message reach is per message (ticket 31)',
  'comm-calls.routes.ts': 'communication scope narrows lists and single reads by design (switch catalog: no route refuses by it); ticket 31',
  'comm-whatsapp.routes.ts': 'message reach is per message (ticket 31)',
  'comm-manual-log.routes.ts': 'logging onto records you cannot open is ticket 32',
  'comm-config.routes.ts': 'phone set-up, Admin settings',
  'comm-numbers.routes.ts': 'phone numbers: Admin-only (ticket 36)',
  'comm-number-assignments.routes.ts': 'phone numbers: Admin-only (ticket 36)',
  'comm-agents.routes.ts': 'phone set-up, Admin settings',
  // The payments pages show an item on an invoice the person can't open as "restricted" by design (View payments is company
  // money), so the item's existence is not a secret there; whether these follow invoice reach instead is raised with ticket 33.
  'payments-page.routes.ts': 'payment items show restricted by design (Payments build); open question, ticket 33',
  'payment-attention.routes.ts': 'payment items show restricted by design (Payments build); open question, ticket 33',
  'aiFarm.routes.ts': "Spider: Admin-only (requireSpiderAdmin), no reach scope. Its one record route (GET /spider/customers/:id/leads) answers another company's customer and an id that is no uuid exactly like a missing one: spider-picker-endpoints-db",
};

/** Single routes on a covered router that answer by something other than reach, and why. */
const NOT_REACH_ROUTES: Record<string, string> = {
  'GET /api/customers/picker/:id': 'pickers are open (ruling 2026-09-10): a customer outside reach comes back restricted, by design',
  'GET /api/inventory/rfqs/:id': 'RFQs are parked (feature disabled), no record behind them',
  'PATCH /api/inventory/rfqs/:id': 'RFQs are parked (feature disabled), no record behind them',
};

type Ctx = { org: string; customer: string; admin: Person };
/** One way to call a route: the record parameter's out-of-reach id, and the values of the route's other parameters. */
type Call = { label?: string; recordParam: string; recordId: string; params: Record<string, string> };

/** The routers of records with reach, where they are mounted, and the out-of-reach record each route is called with. */
type Covered = { file: string; mount: string; calls: (ctx: Ctx, path: string) => Promise<Call[]> };

suite();

function suite() {
  const run = realClient ? describe : describe.skip;
  run('an out-of-reach record answers like a missing one on every record id route (real database)', () => {
    const db = realClient as PrismaClient;
    const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
    beforeAll(async () => {
      await import('../app.js');
    }, 120_000);
    afterAll(() => fx.cleanup());

    let ctx: Ctx;
    let person: Person;
    const uuid = () => randomUUID();

    beforeAll(async () => {
      const o = await fx.newOrg();
      ctx = { org: o.org, customer: o.customer, admin: o.admin };
      // Every switch on, every scope at Their own: no route refuses this person by a switch, so what is left is reach.
      const values: Record<string, unknown> = { ...presetSwitchSet('ADMIN') };
      for (const s of SWITCH_CATALOG) if (s.kind === 'choice' && s.key.endsWith('_scope')) values[s.key] = 'attached';
      await fx.addCustomRole(o.org, 'reach-only', 'DISPATCHER');
      await fx.setRoleSwitches(o.org, 'reach-only', values as never);
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: o.org, key: 'reach-only' } });
      person = await fx.addUser(o.org, 'reachless', 'DISPATCHER', { customRoleId: role.id });
      // A mailbox of their own, so a send is not refused for want of an address before the record is looked at.
      await fx.addUserMailbox(o.org, person);
    }, 120_000);

    // ─── Records nobody but the Admin is on ───────────────────────────────────────────────────────────────
    const job = () => fx.addJob(ctx.org, ctx.customer, { crew: [ctx.admin.id] });
    const lead = () => fx.addLead(ctx.org, ctx.customer, { walkthroughCrew: [ctx.admin.id] });
    async function customer() {
      const id = uuid();
      await db.customer.create({
        data: { id, organization_id: ctx.org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Out', last_name: 'Ofreach', created_by_id: ctx.admin.id },
      });
      const loc = uuid();
      await db.serviceLocation.create({ data: { id: loc, customer_id: id, address_line1: '2 Test Way', city: 'Testville', state: 'MA', zip: '02108' } });
      return { id, loc };
    }
    async function task() {
      const id = uuid();
      await db.task.create({
        data: { id, organization_id: ctx.org, task_number: `T-${id.slice(0, 8)}`, title: 'Call back', created_by: ctx.admin.id, assignee_ids: [ctx.admin.id] },
      });
      return id;
    }
    async function calendarEntry() {
      const id = uuid();
      const start = new Date(Date.now() + 86_400_000);
      await db.calendarEntry.create({
        data: { id, organization_id: ctx.org, title: 'Meeting', start, end: new Date(start.getTime() + 3_600_000), created_by: ctx.admin.id },
      });
      await db.calendarEntryParticipant.create({ data: { organization_id: ctx.org, calendar_entry_id: id, kind: 'USER', user_id: ctx.admin.id } });
      return id;
    }
    async function asset() {
      const id = uuid();
      await db.asset.create({ data: { id, organization_id: ctx.org, name: 'Ladder', assigned_user_id: ctx.admin.id } });
      return id;
    }
    async function purchaseOrder() {
      const j = await job();
      const id = uuid();
      await db.purchaseOrder.create({ data: { id, organization_id: ctx.org, po_number: `PO-${id.slice(0, 8)}`, vendor: 'Supply Co', status: 'draft', job_id: j.id } });
      return { id, jobId: j.id };
    }
    async function logisticOrder() {
      const j = await job();
      const id = uuid();
      await db.logisticOrder.create({ data: { id, organization_id: ctx.org, number: `LO-${id.slice(0, 8)}`, job_id: j.id, created_by: ctx.admin.id } });
      return id;
    }
    async function jobStage() {
      const j = await job();
      const id = uuid();
      await db.jobStage.create({
        data: { id, organization_id: ctx.org, job_id: j.id, job_number: `J-${id.slice(0, 8)}`, customer: 'Pat Payer', site: '1 Test Way', trade: 'Doors', status: 'staged', assigned_tech_id: ctx.admin.id },
      });
      return id;
    }

    const covered: Covered[] = [
      {
        file: 'estimate.routes.ts', mount: '/api/estimates',
        calls: async () => {
          const l = await lead();
          const e = await fx.addEstimate(ctx.org, ctx.customer, ctx.admin.id, { leadId: l.id });
          return [{ recordParam: 'id', recordId: e.id, params: { lineId: e.lineId, idx: '0', scopeId: uuid(), photoId: uuid(), version: '1', tagId: uuid() } }];
        },
      },
      {
        file: 'invoice.routes.ts', mount: '/api/invoices',
        calls: async () => {
          const j = await job();
          const inv = await fx.addInvoice(ctx.org, ctx.customer, { jobId: j.id });
          return [{ recordParam: 'id', recordId: inv.id, params: { lineId: inv.lineId, idx: '0', tagId: uuid() } }];
        },
      },
      {
        file: 'lead.routes.ts', mount: '/api/leads',
        calls: async () => {
          const l = await lead();
          return [{ recordParam: 'id', recordId: l.id, params: { visitId: l.walkthroughId!, noteId: uuid(), entryId: uuid(), tagId: uuid() } }];
        },
      },
      {
        file: 'job.routes.ts', mount: '/api/jobs',
        calls: async () => {
          const j = await job();
          return [{ recordParam: 'id', recordId: j.id, params: { visitId: j.visitId!, lineId: uuid(), idx: '0', noteId: uuid(), entryId: uuid(), tagId: uuid() } }];
        },
      },
      {
        file: 'customer.routes.ts', mount: '/api/customers',
        calls: async () => {
          const c = await customer();
          return [{ recordParam: 'id', recordId: c.id, params: { locId: c.loc, tagId: uuid() } }];
        },
      },
      {
        file: 'task.routes.ts', mount: '/api/tasks',
        calls: async () => [{ recordParam: 'id', recordId: await task(), params: { subtaskId: uuid() } }],
      },
      {
        file: 'calendar-entry.routes.ts', mount: '/api/calendar-entries',
        calls: async () => [{ recordParam: 'id', recordId: await calendarEntry(), params: {} }],
      },
      {
        file: 'inv-assets.routes.ts', mount: '/api/inventory',
        calls: async () => [{ recordParam: 'id', recordId: await asset(), params: {} }],
      },
      {
        file: 'inv-po.routes.ts', mount: '/api/inventory',
        calls: async (_c, path) => {
          if (path.includes(':jobId')) return [{ recordParam: 'jobId', recordId: (await job()).id, params: {} }];
          return [{ recordParam: 'id', recordId: (await purchaseOrder()).id, params: {} }];
        },
      },
      {
        file: 'logistic-order.routes.ts', mount: '/api/logistic-orders',
        calls: async () => [{ recordParam: 'id', recordId: await logisticOrder(), params: {} }],
      },
      {
        file: 'inv-stages.routes.ts', mount: '/api/inventory',
        calls: async () => [{ recordParam: 'id', recordId: await jobStage(), params: { attachmentId: uuid() } }],
      },
      {
        file: 'inv-techs-jobs.routes.ts', mount: '/api/inventory',
        calls: async () => [{ recordParam: 'id', recordId: (await job()).id, params: {} }],
      },
      {
        // Account statements (ticket 30): a job's and a customer's.
        file: 'statement.routes.ts', mount: '/api/statements',
        calls: async (_c, path) => (path.includes(':jobId')
          ? [{ recordParam: 'jobId', recordId: (await job()).id, params: {} }]
          : [{ recordParam: 'customerId', recordId: (await customer()).id, params: {} }]),
      },
      {
        file: 'attachment.routes.ts', mount: '/api/attachments',
        calls: async () => {
          const j = await job();
          const inv = await fx.addInvoice(ctx.org, ctx.customer, { jobId: j.id });
          const records: [string, string][] = [
            ['JOB', j.id], ['LEAD', (await lead()).id], ['INVOICE', inv.id], ['CUSTOMER', (await customer()).id], ['TASK', await task()],
          ];
          return records.map(([type, id]) => ({ label: type, recordParam: 'entityId', recordId: id, params: { entityType: type, attachmentId: uuid() } }));
        },
      },
    ];

    it('classifies every route file that has a parameter route: a router of records with reach, or named with its reason', () => {
      const withParams = readdirSync(ROUTES_DIR)
        .filter((f) => f.endsWith('.routes.ts'))
        // Any router variable (router, r, api...) and any quote style: a route whose path has a parameter.
        .filter((f) => /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|all)\(\s*(['"`])[^'"`]*\/:/.test(readFileSync(join(ROUTES_DIR, f), 'utf8')));
      const classified = new Set([...covered.map((c) => c.file), ...Object.keys(NOT_RECORD_ROUTERS)]);
      expect(withParams.filter((f) => !classified.has(f))).toEqual([]);
    });

    /** Every parameter route of a router, as the router itself holds it. Public routes (no signed-in person) are left out. */
    async function paramRoutes(c: Covered): Promise<{ method: string; path: string }[]> {
      const router = (await import(`../routes/${c.file.replace(/\.ts$/, '.js')}`)).default as Router;
      const out: { method: string; path: string }[] = [];
      for (const layer of router.stack as unknown as { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } }[]) {
        const route = layer.route;
        if (!route || !route.path.includes(':')) continue;
        if (route.stack.some((l) => l.handle === unscopedRequest)) continue; // a customer's own link, no signed-in person
        for (const method of Object.keys(route.methods)) {
          const full = `${method.toUpperCase()} ${c.mount}${route.path}`;
          if (!NOT_REACH_ROUTES[full]) out.push({ method, path: route.path });
        }
      }
      return out;
    }

    const fill = (path: string, values: Record<string, string>) =>
      path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
        const v = values[name];
        if (v === undefined) throw new Error(`no value for :${name} in ${path}`);
        return v;
      });

    /**
     * A body that gets each route past its request validation, so the comparison reaches the record lookup. A route not
     * named here takes `{}`; a route whose two answers are both a refused request is reported below (no vacuous rows).
     */
    const LOCATION = { address_line1: '3 Body Rd', city: 'Testville', state: 'MA', zip: '02108' };
    const BODIES: Record<string, object | ((values: Record<string, string>) => object)> = {
      'POST /api/customers/:id/number/preview': { number: 'C-9001' },
      'PATCH /api/customers/:id/number': { number: 'C-9002' },
      'POST /api/customers/:id/notes': { content: 'A note' },
      'POST /api/customers/:id/tags': { name: 'Gold' },
      'POST /api/customers/:id/locations': LOCATION,
      'PATCH /api/customers/:id/locations/:locId': { city: 'Elsewhere' },
      'POST /api/logistic-orders/:id/taken-by': { takenById: '00000000-0000-4000-8000-000000000001' },
      'POST /api/inventory/job-stages/:id/taken-by': { takenById: '00000000-0000-4000-8000-000000000001' },
      'POST /api/attachments/:entityType/:entityId/direct-upload': { file_name: 'walk.mp4', content_type: 'video/mp4', file_size: 1024 },
      // A ticket signed for this very record, as the first step would mint it, so the answer comes from the record check.
      'POST /api/attachments/:entityType/:entityId/direct-upload/complete': (v) => ({
        ticket: signUploadTicket({ org: ctx.org, et: v.entityType!, eid: v.entityId!, path: `${ctx.org}/t33/${v.entityId}.mp4`, mime: 'video/mp4', name: 'walk.mp4', uid: person.id }),
        display_name: 'Walk', description: '',
      }),
    };

    const send = async (method: string, url: string, body: object = {}) => {
      const api = await fx.signedInAs(person);
      const m = method as 'get' | 'post' | 'put' | 'patch' | 'delete';
      return m === 'delete' ? api.delete(url, body) : m === 'get' ? api.get(url) : api[m](url, body);
    };

    const answer = (res: { status: number; body: unknown; text: string }, id: string) => ({
      status: res.status,
      body: JSON.stringify(res.body && Object.keys(res.body as object).length ? res.body : res.text).split(id).join('<id>'),
    });

    // One case per router, listing every route whose two answers differ, so a failure names all of them at once.
    for (const name of ['estimate', 'invoice', 'lead', 'job', 'customer', 'task', 'calendar-entry', 'inv-assets', 'inv-po', 'logistic-order', 'inv-stages', 'inv-techs-jobs', 'attachment', 'statement']) {
      it(`${name}: every parameter route answers an out-of-reach record exactly as a missing one`, async () => {
        const c = covered.find((x) => x.file === `${name}.routes.ts`)!;
        const routes = await paramRoutes(c);
        expect(routes.length).toBeGreaterThan(0);
        const differing: string[] = [];
        const vacuous: string[] = [];
        for (const r of routes) {
          const key = `${r.method.toUpperCase()} ${c.mount}${r.path}`;
          // A fresh record per route, so a route that wrongly acts on the record can't hide the next route's answer.
          for (const call of await c.calls(ctx, r.path)) {
            const bodyFor = (values: Record<string, string>) => {
              const b = BODIES[key] ?? {};
              return typeof b === 'function' ? b(values) : b;
            };
            const missingId = randomUUID();
            const missingValues = { ...call.params, [call.recordParam]: missingId };
            const hiddenValues = { ...call.params, [call.recordParam]: call.recordId };
            const missing = await send(r.method, `${c.mount}${fill(r.path, missingValues)}`, bodyFor(missingValues));
            const hidden = await send(r.method, `${c.mount}${fill(r.path, hiddenValues)}`, bodyFor(hiddenValues));
            const a = answer(missing, missingId);
            const b = answer(hidden, call.recordId);
            const label = `${key}${call.label ? ` [${call.label}]` : ''}`;
            if (a.status !== b.status || a.body !== b.body) {
              differing.push(`${label}: missing ${a.status} ${a.body} / out of reach ${b.status} ${b.body}`);
            } else if (a.status === 400 || a.status === 422) {
              // Both refused as a bad request: the comparison never reached the record, so the row would prove nothing.
              vacuous.push(`${label}: both ${a.status} ${a.body}`);
            }
          }
        }
        expect(differing).toEqual([]);
        expect(vacuous).toEqual([]);
      }, 600_000);
    }

    // Spec story 47: bulk reminders take ids too. An estimate out of reach is skipped exactly as a missing one is, whatever
    // its status: the answer must not tell a closed estimate, or one that would have been sent, from an id that is not there.
    for (const status of ['SENT', 'WON', 'DRAFT'] as const) {
      it(`bulk reminders skip an out-of-reach ${status} estimate exactly as a missing one, and send nothing`, async () => {
        const l = await lead();
        const e = await fx.addEstimate(ctx.org, ctx.customer, ctx.admin.id, { leadId: l.id });
        await db.estimate.update({ where: { id: e.id }, data: { status, ...(status === 'DRAFT' ? {} : { sent_at: new Date() }) } });
        const missingId = randomUUID();
        const missing = await (await fx.signedInAs(person)).post('/api/estimates/bulk-send-reminder', { ids: [missingId] });
        const hidden = await (await fx.signedInAs(person)).post('/api/estimates/bulk-send-reminder', { ids: [e.id] });
        expect(answer(hidden, e.id)).toEqual(answer(missing, missingId));
        expect(hidden.body.sent).toEqual([]);
        const after = await db.estimate.findUniqueOrThrow({ where: { id: e.id }, select: { status: true } });
        expect(after.status).toBe(status);
      });
    }
  });
}
