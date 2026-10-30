/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 47): a record named in a request BODY that the person can't
   reach answers exactly like a record that does not exist, and nothing is written.

   The route-path ids are proven in permission-not-found-means-not-found-db.test.ts and the id lists in
   permission-bulk-not-found-db.test.ts. This table covers every other request field that names a record: making an invoice
   from a job, an estimate on a lead or job, attaching an estimate to a job, a task linked to a record, a calendar entry
   with a customer, a service plan on a customer, a logistic order, a purchase order or a job stage on a job, lead,
   customer or purchase order, receiving or notifying a stage, a parent customer, and the payment attached to an invoice.
   Which fields exist is not a hand list: permission-body-id-guard.test.ts reads them out of the source and holds each to a
   row here or a reason in permission-body-id-doors.ts.

   Each row calls the route twice, with an id that does not exist and with the Admin's record, and the two answers must
   match in status and body (the id itself aside); then the company must look exactly as it did. The person is on a custom
   role with every switch on and every scope at Their own, unless the row says otherwise.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, presetSwitchSet, type SwitchValue } from '../lib/permissions/switches/catalog';
import { COVERED } from './permission-body-id-doors';

const suite = realClient ? describe : describe.skip;
const THIS_FILE = 'permission-body-id-not-found-db.test.ts';

suite('a record named in a request body that the person cannot reach answers like a missing one (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  let org = '';
  let customer = '';
  let admin: Person;
  /** Every switch on, every scope Their own. */
  let person: Person;
  /** Every switch on, Jobs scope All, Leads scope Their own: may create any order, but reaches only some leads and customers. */
  let jobsAll: Person;

  afterAll(async () => {
    const where = { where: { organization_id: org } };
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.calendarEntryParticipant.deleteMany(where));
    await quietly(db.calendarEntry.deleteMany(where));
    await quietly(db.task.deleteMany(where));
    await quietly(db.unappliedCapture.deleteMany(where));
    await quietly(db.logisticOrder.deleteMany(where));
    await quietly(db.jobStage.deleteMany(where));
    await quietly(db.purchaseOrder.deleteMany(where));
    // A price-book item outlives its company until the estimate lines that name it are gone (no cascade).
    await quietly(db.estimateLineItem.deleteMany({ where: { estimate: { organization_id: org } } }));
    await quietly(db.priceBookItem.deleteMany(where));
    await fx.cleanup();
  });

  beforeAll(async () => {
    const o = await fx.newOrg();
    ({ org, customer, admin } = o);
    const all: Record<string, SwitchValue> = { ...presetSwitchSet('ADMIN') } as Record<string, SwitchValue>;
    for (const s of SWITCH_CATALOG) if (s.kind === 'choice' && s.key.endsWith('_scope')) all[s.key] = 'attached';
    const roleFor = async (key: string, v: Record<string, SwitchValue>) => {
      await fx.addCustomRole(org, key, 'DISPATCHER');
      await fx.setRoleSwitches(org, key, v);
      return (await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } })).id;
    };
    person = await fx.addUser(org, 'bodyreach', 'DISPATCHER', { customRoleId: await roleFor('body-reach', all) });
    jobsAll = await fx.addUser(org, 'bodyjobsall', 'DISPATCHER', {
      customRoleId: await roleFor('body-jobs-all', { ...all, jobs_scope: 'all', leads_scope: 'attached' }),
    });
  }, 120_000);

  // ─── Records ─────────────────────────────────────────────────────────────────────────────────────────
  /** A customer of the Admin's with nothing anyone else is on, and its location. */
  async function hiddenCustomer(opts: { isParent?: boolean } = {}) {
    const id = randomUUID();
    await db.customer.create({
      data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Out', last_name: 'Ofreach', created_by_id: admin.id, is_parent: opts.isParent ?? false },
    });
    const loc = randomUUID();
    await db.serviceLocation.create({ data: { id: loc, customer_id: id, address_line1: '9 Hidden Rd', city: 'Testville', state: 'MA', zip: '02108' } });
    return { id, loc };
  }
  /** A customer the person reaches: they are an assignee of one of its leads. */
  async function reachableCustomer() {
    const c = await hiddenCustomer();
    await fx.addLead(org, c.id, { assignees: [person.id] });
    return c.id;
  }
  const hiddenJob = async () => (await fx.addJob(org, customer, { crew: [admin.id] })).id;
  const myJob = async () => fx.addJob(org, customer, { crew: [person.id] });
  async function purchaseOrder(jobId: string) {
    const id = randomUUID();
    await db.purchaseOrder.create({ data: { id, organization_id: org, po_number: `PO-${id.slice(0, 8)}`, vendor: 'Supply Co', status: 'draft', job_id: jobId } });
    return id;
  }
  async function stage(jobId: string, tech: string) {
    const id = randomUUID();
    await db.jobStage.create({
      data: { id, organization_id: org, job_id: jobId, job_number: `J-${id.slice(0, 8)}`, customer: 'Pat Payer', site: '1 Test Way', trade: 'door', status: 'staged', assigned_tech_id: tech },
    });
    return id;
  }
  async function capture(invoiceId: string | null) {
    const id = randomUUID();
    await db.unappliedCapture.create({ data: { id, organization_id: org, invoice_id: invoiceId, reason: 'INVOICE_NOT_PAYABLE', amount: 10, source_key: `t33b-${id}` } });
    return id;
  }

  /** Everything a refused request must leave as it was. */
  async function companyState() {
    const where = { where: { organization_id: org } };
    return {
      invoices: await db.invoice.count(where), estimates: await db.estimate.count(where), jobs: await db.job.count(where),
      leads: await db.lead.count(where), customers: await db.customer.count(where), tasks: await db.task.count(where),
      entries: await db.calendarEntry.count(where), participants: await db.calendarEntryParticipant.count(where),
      plans: await db.servicePlan.findMany({ ...where, select: { id: true, customer_id: true, service_location_id: true, name: true }, orderBy: { id: 'asc' } }), orders: await db.logisticOrder.count(where), pos: await db.purchaseOrder.count(where),
      stages: await db.jobStage.count(where), captures: await db.unappliedCapture.findMany({ ...where, select: { id: true, status: true, invoice_id: true }, orderBy: { id: 'asc' } }),
      estimateJobs: await db.estimate.findMany({ ...where, select: { id: true, job_id: true }, orderBy: { id: 'asc' } }),
      poJobs: await db.purchaseOrder.findMany({ ...where, select: { id: true, job_id: true, customer_id: true, status: true, staged_as_job_stage_id: true }, orderBy: { id: 'asc' } }),
      stageRows: await db.jobStage.findMany({ ...where, select: { id: true, job_id: true, customer_id: true, status: true }, orderBy: { id: 'asc' } }),
      emails: await db.email.count(where), timeline: await db.timelineEvent.count(where),
      phones: await db.customerPhone.count({ where: { customer: { organization_id: org } } }),
    };
  }

  type Ctx = Record<string, string>;
  type Row = {
    name: string;
    covers: string[];
    as?: () => Person;
    /** The field is refused by the request's own validation for every id, by design (nothing is looked up for it). */
    refusedForAnyId?: true;
    /** The out-of-reach record's id, and whatever else the call needs (set up once, used for both calls). */
    seed: () => Promise<{ id: string; ctx?: Ctx }>;
    call: (id: string, ctx: Ctx) => { method: 'get' | 'post' | 'patch'; path: string; body?: object };
  };

  const LINE = { description: 'Service', quantity: 1, unit_price: 10, is_taxable: false };
  const STAGE = { jobNumber: 'J-1', customer: 'Pat Payer', site: '1 Test Way', trade: 'door', status: 'staged' };
  const C = 'src/controllers/';

  const table: Row[] = [
    {
      name: 'POST /api/invoices from a job that already has an invoice',
      covers: [`${C}invoice.controller.ts#createInvoiceSchema.job_id`],
      seed: async () => { const j = await hiddenJob(); await fx.addInvoice(org, customer, { jobId: j }); return { id: j }; },
      call: (id) => ({ method: 'post', path: '/api/invoices', body: { job_id: id } }),
    },
    {
      name: 'POST /api/invoices from a service plan visit job',
      covers: [`${C}invoice.controller.ts#createInvoiceSchema.job_id`],
      seed: async () => {
        const plan = await fx.addServicePlan(org, customer, {});
        return { id: (await fx.addJob(org, customer, { crew: [admin.id], sourcePlan: plan.id })).id };
      },
      call: (id) => ({ method: 'post', path: '/api/invoices', body: { job_id: id } }),
    },
    {
      name: 'POST /api/invoices for a customer, recording an unapplied payment the person cannot act on',
      covers: [`${C}invoice.controller.ts#createInvoiceSchema.unapplied_capture_id`],
      seed: async () => {
        const inv = await fx.addInvoice(org, customer, { jobId: await hiddenJob() });
        return { id: await capture(inv.id), ctx: { customer: await reachableCustomer() } };
      },
      call: (id, ctx) => ({ method: 'post', path: '/api/invoices', body: { customer_id: ctx.customer, line_items: [LINE], unapplied_capture_id: id } }),
    },
    {
      name: 'POST /api/estimates on a won lead',
      covers: [`${C}estimate.controller.ts#createEstimateSchema.lead_id`],
      seed: async () => {
        const l = await fx.addLead(org, customer, { owner: admin.id });
        await db.lead.update({ where: { id: l.id }, data: { status: 'WON' } });
        return { id: l.id };
      },
      call: (id) => ({ method: 'post', path: '/api/estimates', body: { lead_id: id } }),
    },
    {
      name: 'POST /api/estimates on a job',
      covers: [`${C}estimate.controller.ts#createEstimateSchema.job_id`],
      seed: async () => ({ id: await hiddenJob() }),
      call: (id) => ({ method: 'post', path: '/api/estimates', body: { job_id: id } }),
    },
    {
      name: 'POST /api/estimates/:id/attach-to-job onto a service plan visit job',
      covers: [`${C}estimate.controller.ts#attachToJobSchema.job_id`],
      seed: async () => {
        const mine = await fx.addEstimate(org, customer, person.id);
        const plan = await fx.addServicePlan(org, customer, {});
        return { id: (await fx.addJob(org, customer, { crew: [admin.id], sourcePlan: plan.id })).id, ctx: { estimate: mine.id } };
      },
      call: (id, ctx) => ({ method: 'post', path: `/api/estimates/${ctx.estimate}/attach-to-job`, body: { job_id: id } }),
    },
    {
      name: 'POST /api/estimates/:id/attach-to-job onto another customer\'s job',
      covers: [`${C}estimate.controller.ts#attachToJobSchema.job_id`],
      seed: async () => {
        const mine = await fx.addEstimate(org, customer, person.id);
        const other = await hiddenCustomer();
        return { id: (await fx.addJob(org, other.id, { crew: [admin.id] })).id, ctx: { estimate: mine.id } };
      },
      call: (id, ctx) => ({ method: 'post', path: `/api/estimates/${ctx.estimate}/attach-to-job`, body: { job_id: id } }),
    },
    ...(['JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE'] as const).map((type): Row => ({
      name: `POST /api/tasks linked to a ${type.toLowerCase()}`,
      covers: [`${C}task.controller.ts#createTaskSchema.linked_entity_id`],
      seed: async () => {
        if (type === 'JOB') return { id: await hiddenJob() };
        if (type === 'LEAD') return { id: (await fx.addLead(org, customer, { owner: admin.id })).id };
        if (type === 'CUSTOMER') return { id: (await hiddenCustomer()).id };
        const l = await fx.addLead(org, customer, { owner: admin.id });
        return { id: (await fx.addEstimate(org, customer, admin.id, { leadId: l.id })).id };
      },
      call: (id) => ({ method: 'post', path: '/api/tasks', body: { title: 'Call back', linked_entity_type: type, linked_entity_id: id } }),
    })),
    ...(['customer_id', 'service_location_id'] as const).map((field): Row => ({
      name: `PATCH /api/service-plans/:id naming a new ${field === 'customer_id' ? 'customer' : 'address'} (ticket 33b)`,
      covers: [`${C}service-plan.controller.ts#updatePlanSchema.${field}`],
      refusedForAnyId: true,
      seed: async () => {
        const plan = await fx.addServicePlan(org, customer, {});
        await db.servicePlan.update({ where: { id: plan.id }, data: { status: 'DRAFT' } });
        const c = await hiddenCustomer();
        return { id: field === 'customer_id' ? c.id : c.loc, ctx: { plan: plan.id } };
      },
      call: (id, ctx) => ({ method: 'patch', path: `/api/service-plans/${ctx.plan}`, body: { [field]: id } }),
    })),
    {
      name: 'POST /api/customers under a parent franchise',
      covers: [`${C}customer.controller.ts#redesignFields.parent_id`],
      seed: async () => ({ id: (await hiddenCustomer({ isParent: true })).id }),
      call: (id) => ({ method: 'post', path: '/api/customers', body: { first_name: 'Kid', email: `kid-${org.slice(0, 8)}@example.test`, parent_id: id } }),
    },
    {
      name: 'POST /api/logistic-orders on a job (a person whose orders are limited to their jobs)',
      covers: [`${C}logistic-order.controller.ts#createLogisticOrderSchema.job_id`],
      seed: async () => ({ id: await hiddenJob() }),
      call: (id) => ({ method: 'post', path: '/api/logistic-orders', body: { job_id: id } }),
    },
    {
      name: 'POST /api/logistic-orders on a lead (a person who may create any order)',
      covers: [`${C}logistic-order.controller.ts#createLogisticOrderSchema.lead_id`],
      as: () => jobsAll,
      seed: async () => ({ id: (await fx.addLead(org, customer, { owner: admin.id })).id }),
      call: (id) => ({ method: 'post', path: '/api/logistic-orders', body: { lead_id: id } }),
    },
    {
      name: 'POST /api/logistic-orders on a customer (a person who may create any order)',
      covers: [`${C}logistic-order.controller.ts#createLogisticOrderSchema.customer_id`],
      as: () => jobsAll,
      seed: async () => ({ id: (await hiddenCustomer()).id }),
      call: (id) => ({ method: 'post', path: '/api/logistic-orders', body: { customer_id: id } }),
    },
    {
      name: 'POST /api/inventory/purchase-orders on a job',
      covers: [`${C}inv-po.controller.ts#createPurchaseOrderSchema.jobId`],
      seed: async () => ({ id: await hiddenJob() }),
      call: (id) => ({ method: 'post', path: '/api/inventory/purchase-orders', body: { vendor: 'Supply Co', jobId: id, lines: [{ itemName: 'Hinge', uom: 'ea', qtyOrdered: 1 }] } }),
    },
    {
      name: 'POST /api/inventory/purchase-orders for a customer (a person who may create any order)',
      covers: [`${C}inv-po.controller.ts#createPurchaseOrderSchema.customerId`],
      as: () => jobsAll,
      seed: async () => ({ id: (await hiddenCustomer()).id }),
      call: (id) => ({ method: 'post', path: '/api/inventory/purchase-orders', body: { vendor: 'Supply Co', customerId: id, lines: [{ itemName: 'Hinge', uom: 'ea', qtyOrdered: 1 }] } }),
    },
    {
      name: 'POST /api/inventory/purchase-orders/from-job',
      covers: [`${C}inv-po.controller.ts#createPurchaseOrderFromJobSchema.jobId`],
      seed: async () => {
        const j = await hiddenJob();
        await db.job.update({ where: { id: j }, data: { status: 'CANCELLED' } });
        return { id: j };
      },
      call: (id) => ({ method: 'post', path: '/api/inventory/purchase-orders/from-job', body: { jobId: id, lines: [{ priceBookItemId: randomUUID(), qty: 1 }] } }),
    },
    ...(['jobId', 'customerId'] as const).map((field): Row => ({
      name: `PATCH /api/inventory/purchase-orders/:id moving the order to another ${field === 'jobId' ? 'job' : 'customer'}`,
      covers: [`${C}inv-po.controller.ts#updatePurchaseOrderSchema.${field}`],
      seed: async () => {
        const po = await purchaseOrder((await myJob()).id);
        return { id: field === 'jobId' ? await hiddenJob() : (await hiddenCustomer()).id, ctx: { po } };
      },
      call: (id, ctx) => ({ method: 'patch', path: `/api/inventory/purchase-orders/${ctx.po}`, body: { [field]: id } }),
    })),
    {
      name: 'POST /api/inventory/purchase-orders/receive',
      covers: [`${C}inv-po.controller.ts#receivePurchaseOrderSchema.poId`],
      seed: async () => ({ id: await purchaseOrder(await hiddenJob()) }),
      call: (id) => ({ method: 'post', path: '/api/inventory/purchase-orders/receive', body: { poId: id, lines: [{ lineId: randomUUID(), qtyReceived: 1 }] } }),
    },
    {
      name: 'POST /api/inventory/job-stages on a job',
      covers: [`${C}inv-stages.controller.ts#createStageSchema.jobId`],
      seed: async () => ({ id: await hiddenJob() }),
      call: (id) => ({ method: 'post', path: '/api/inventory/job-stages', body: { ...STAGE, jobId: id } }),
    },
    {
      name: 'POST /api/inventory/job-stages for a customer',
      covers: [`${C}inv-stages.controller.ts#createStageSchema.customerId`],
      seed: async () => ({ id: (await hiddenCustomer()).id, ctx: { job: (await myJob()).id } }),
      call: (id, ctx) => ({ method: 'post', path: '/api/inventory/job-stages', body: { ...STAGE, jobId: ctx.job, customerId: id } }),
    },
    {
      name: 'POST /api/inventory/job-stages staged from a purchase order',
      covers: [`${C}inv-stages.controller.ts#createStageSchema.stagedFromPurchaseOrderId`],
      seed: async () => ({ id: await purchaseOrder(await hiddenJob()) }),
      call: (id) => ({ method: 'post', path: '/api/inventory/job-stages', body: { ...STAGE, stagedFromPurchaseOrderId: id } }),
    },
    {
      name: 'POST /api/inventory/job-stages linked to a purchase order',
      covers: [`${C}inv-stages.controller.ts#createStageSchema.linkedPurchaseOrderId`],
      seed: async () => ({ id: await purchaseOrder(await hiddenJob()), ctx: { job: (await myJob()).id } }),
      call: (id, ctx) => ({ method: 'post', path: '/api/inventory/job-stages', body: { ...STAGE, jobId: ctx.job, linkedPurchaseOrderId: id } }),
    },
    ...(['jobId', 'customerId'] as const).map((field): Row => ({
      name: `PATCH /api/inventory/job-stages/:id moving the stage to another ${field === 'jobId' ? 'job' : 'customer'}`,
      covers: [`${C}inv-stages.controller.ts#updateStageSchema.${field}`],
      seed: async () => {
        const st = await stage((await myJob()).id, person.id);
        return { id: field === 'jobId' ? await hiddenJob() : (await hiddenCustomer()).id, ctx: { stage: st } };
      },
      call: (id, ctx) => ({ method: 'patch', path: `/api/inventory/job-stages/${ctx.stage}`, body: { [field]: id } }),
    })),
    {
      name: 'POST /api/inventory/job-stages/receive',
      covers: [`${C}inv-stages.controller.ts#receiveStageSchema.stageId`],
      seed: async () => ({ id: await stage(await hiddenJob(), admin.id) }),
      call: (id) => ({ method: 'post', path: '/api/inventory/job-stages/receive', body: { stageId: id, itemId: randomUUID() } }),
    },
    {
      name: 'POST /api/inventory/job-stages/notify',
      covers: [`${C}inv-stages.controller.ts#notifyStageSchema.stageId`],
      seed: async () => ({ id: await stage(await hiddenJob(), admin.id) }),
      call: (id) => ({ method: 'post', path: '/api/inventory/job-stages/notify', body: { stageId: id } }),
    },
    {
      name: 'POST /api/inventory/job-stages/email',
      covers: [`${C}inv-stages.controller.ts#emailStageSchema.stageId`],
      seed: async () => ({ id: await stage(await hiddenJob(), admin.id) }),
      call: (id) => ({ method: 'post', path: '/api/inventory/job-stages/email', body: { stageId: id, to: ['shop@example.test'], subject: 'Pickup' } }),
    },
    ...(['JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE'] as const).flatMap((type): Row[] => {
      const seed = async () => {
        if (type === 'JOB') return { id: await hiddenJob() };
        if (type === 'LEAD') return { id: (await fx.addLead(org, customer, { owner: admin.id })).id };
        if (type === 'CUSTOMER') return { id: (await hiddenCustomer()).id };
        const l = await fx.addLead(org, customer, { owner: admin.id });
        return { id: (await fx.addEstimate(org, customer, admin.id, { leadId: l.id })).id };
      };
      const t = type.toLowerCase();
      return [
        {
          name: `GET /api/tasks/entity-access for a ${t} (who on the team could open it)`,
          covers: [`${C}task.controller.ts#req.query.entity_id`],
          seed,
          call: (id) => ({ method: 'get', path: `/api/tasks/entity-access?entity_type=${type}&entity_id=${id}` }),
        },
        {
          name: `GET /api/tasks for a ${t}'s tasks`,
          covers: [`${C}task.controller.ts#req.query.linked_entity_id`],
          seed: async () => {
            const r = await seed();
            await db.task.create({ data: { organization_id: org, task_number: `T-${r.id.slice(0, 8)}`, title: 'On it', created_by: admin.id, assignee_ids: [admin.id], linked_entity_type: type, linked_entity_id: r.id } });
            return r;
          },
          call: (id) => ({ method: 'get', path: `/api/tasks?linked_entity_type=${type}&linked_entity_id=${id}` }),
        },
        {
          name: `GET /api/tasks/summary for a ${t}`,
          covers: [`${C}task.controller.ts#req.query.linked_entity_id`],
          seed,
          call: (id) => ({ method: 'get', path: `/api/tasks/summary?linked_entity_type=${type}&linked_entity_id=${id}` }),
        },
      ];
    }),
    {
      name: 'GET /api/calendar-entries for a customer (an entry the person is not on)',
      covers: [`${C}calendar-entry.controller.ts#req.query.customer_id`],
      seed: async () => {
        const c = await hiddenCustomer();
        const start = new Date(Date.now() + 86_400_000);
        const entry = await db.calendarEntry.create({ data: { organization_id: org, title: 'Visit', start, end: new Date(start.getTime() + 3_600_000), created_by: admin.id } });
        await db.calendarEntryParticipant.createMany({ data: [
          { organization_id: org, calendar_entry_id: entry.id, kind: 'USER', user_id: admin.id },
          { organization_id: org, calendar_entry_id: entry.id, kind: 'CUSTOMER', customer_id: c.id },
        ] });
        return { id: c.id };
      },
      call: (id) => ({ method: 'get', path: `/api/calendar-entries?customer_id=${id}` }),
    },
    {
      name: 'GET /api/inventory/job-stages for a job',
      covers: [`${C}inv-stages.controller.ts#req.query.job_id`],
      seed: async () => { const j = await hiddenJob(); await stage(j, admin.id); return { id: j }; },
      call: (id) => ({ method: 'get', path: `/api/inventory/job-stages?job_id=${id}` }),
    },
    {
      name: 'POST /api/payments-needing-attention/:id/attach onto an invoice',
      covers: [`${C}payment-attention.controller.ts#attachBodySchema.invoice_id`],
      seed: async () => {
        const mine = await myJob();
        const myInvoice = await fx.addInvoice(org, customer, { jobId: mine.id });
        const theirs = await fx.addInvoice(org, customer, { jobId: await hiddenJob() });
        return { id: theirs.id, ctx: { capture: await capture(myInvoice.id) } };
      },
      call: (id, ctx) => ({ method: 'post', path: `/api/payments-needing-attention/${ctx.capture}/attach`, body: { invoice_id: id } }),
    },
    {
      // Re-audit P2-4. The upload form is multipart; permission-reaudit-p2-fixes-f-db.test.ts sends the same field both ways.
      name: 'POST /api/price-book/items/:id/image naming the estimate the picture comes from',
      covers: [`${C}price-book-image.controller.ts#req.body.estimate_id`],
      seed: async () => {
        const item = randomUUID();
        await db.priceBookItem.create({ data: { id: item, organization_id: org, name: 'Door', sku: `SKU-${item.slice(0, 8)}`, unit_price: 10 } });
        const theirs = await fx.addEstimate(org, customer, admin.id);
        await db.estimateLineItem.update({ where: { id: theirs.lineId }, data: { price_book_item_id: item } });
        return { id: theirs.id, ctx: { item } };
      },
      call: (id, ctx) => ({ method: 'post', path: `/api/price-book/items/${ctx.item}/image`, body: { estimate_id: id } }),
    },
  ];

  it('covers every body field the source guard attributes to this file', () => {
    const mine = Object.entries(COVERED).filter(([, file]) => file === THIS_FILE).map(([k]) => k).sort();
    const rows = [...new Set(table.flatMap((r) => r.covers))].sort();
    expect(rows).toEqual(mine);
  });

  const answer = (res: { status: number; body: unknown; text: string }, id: string) => ({
    status: res.status,
    body: JSON.stringify(res.body && Object.keys(res.body as object).length ? res.body : res.text).split(id).join('<id>'),
  });

  for (const row of table) {
    it(`${row.name}: a record out of reach answers like a missing one, and nothing is written`, async () => {
      const { id, ctx = {} } = await row.seed();
      const who = row.as?.() ?? person;
      const send = async (target: string) => {
        const { method, path, body } = row.call(target, ctx);
        const api = await fx.signedInAs(who);
        return method === 'get' ? api.get(path) : api[method](path, body ?? {});
      };
      const missingId = randomUUID();
      const missing = answer(await send(missingId), missingId);
      const before = await companyState();
      const hidden = answer(await send(id), id);
      expect(hidden).toEqual(missing);
      // The comparison must reach the record: a request refused by its own validation proves nothing.
      if (!row.refusedForAnyId) expect(missing.body).not.toMatch(/Validation failed/);
      expect(await companyState()).toEqual(before);
    });
  }

  it('creating a lead for a customer out of reach (the picker is open) writes nothing onto that customer', async () => {
    const c = await hiddenCustomer();
    const before = { phones: await db.customerPhone.count({ where: { customer_id: c.id } }), emails: await db.customerEmail.count({ where: { customer_id: c.id } }) };
    const res = await (await fx.signedInAs(person)).post('/api/leads', {
      customer_id: c.id, service_request: 'Fix the door', phone: '6175550142', email: `new-${c.id.slice(0, 8)}@example.test`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect({ phones: await db.customerPhone.count({ where: { customer_id: c.id } }), emails: await db.customerEmail.count({ where: { customer_id: c.id } }) }).toEqual(before);
  });

  // ─── Ran's picker ruling (2026-10-28): a form that picks from the org-wide picker accepts any customer it offers ────────
  describe('forms whose customer comes from the org-wide picker', () => {
    /** The journey: the picker offers a customer the person cannot read (restricted), and the person picks it. */
    async function pickRestricted() {
      const c = await hiddenCustomer();
      const tag = c.id.slice(0, 6);
      await db.customer.update({ where: { id: c.id }, data: { last_name: `Picked${tag}`, email: `picked-${tag}@example.test` } });
      const found = await (await fx.signedInAs(person)).get(`/api/customers/picker?search=Picked${tag}`);
      expect(found.status).toBe(200);
      const row = (found.body.customers as { id: string; restricted: boolean }[]).find((x) => x.id === c.id);
      expect(row?.restricted).toBe(true);
      return c;
    }
    const otherCompanyCustomer = async () => {
      const other = await fx.newOrg();
      const loc = randomUUID();
      await db.serviceLocation.create({ data: { id: loc, customer_id: other.customer, address_line1: '5 Far Rd', city: 'Elsewhere', state: 'NY', zip: '10001' } });
      return { id: other.customer, loc };
    };

    const plan = (customerId: string, locationId: string) => ({
      customer_id: customerId, service_location_id: locationId, name: 'Checks', visit_cadence: 'QUARTERLY',
      start_date: new Date().toISOString(), contract_price: 100,
    });

    it('a service plan saves on a customer the picker offers, and says no more of it than the picker does', async () => {
      const c = await pickRestricted();
      const res = await (await fx.signedInAs(person)).post('/api/service-plans', plan(c.id, c.loc));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.servicePlan.customer).toMatchObject({ id: c.id, first_name: 'Out' });
      expect(res.body.servicePlan.service_location).toEqual({ id: c.loc, city: 'Testville', address_line1: null, state: null });
      expect(JSON.stringify(res.body)).not.toContain('9 Hidden Rd');
      expect(JSON.stringify(res.body)).not.toContain('@example.test');
    });

    it('a service plan on a missing customer, or another company\'s, is refused the same way', async () => {
      const missing = await (await fx.signedInAs(person)).post('/api/service-plans', plan(randomUUID(), randomUUID()));
      const foreign = await otherCompanyCustomer();
      const theirs = await (await fx.signedInAs(person)).post('/api/service-plans', plan(foreign.id, foreign.loc));
      expect(missing.status).toBe(404);
      expect({ status: theirs.status, body: theirs.body }).toEqual({ status: missing.status, body: missing.body });
    });

    const entry = (customerIds: string[], extraUser?: string) => {
      const start = new Date(Date.now() + 86_400_000);
      return {
        title: 'Visit', start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(),
        participants: [
          ...(extraUser ? [{ kind: 'USER', user_id: extraUser }] : []),
          ...customerIds.map((id) => ({ kind: 'CUSTOMER', customer_id: id })),
        ],
      };
    };

    it('a calendar entry takes a customer the picker offers, on create and when an edit re-sends the participants, without its email', async () => {
      const c = await pickRestricted();
      const created = await (await fx.signedInAs(person)).post('/api/calendar-entries', entry([c.id], person.id));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const theirs = (created.body.calendar_entry.participants as { kind: string; customer_id: string | null; email: string | null }[]).find((p) => p.customer_id === c.id);
      expect(theirs).toMatchObject({ kind: 'CUSTOMER', email: null });
      expect(JSON.stringify(created.body)).not.toContain(`picked-${c.id.slice(0, 6)}@example.test`);

      const edited = await (await fx.signedInAs(person)).patch(`/api/calendar-entries/${created.body.calendar_entry.id}`, { ...entry([c.id], person.id), title: 'Visit, moved' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(JSON.stringify(edited.body)).not.toContain(`picked-${c.id.slice(0, 6)}@example.test`);
    });

    it('a calendar entry with a missing customer, or another company\'s, is refused the same way', async () => {
      const missing = await (await fx.signedInAs(person)).post('/api/calendar-entries', entry([randomUUID()]));
      const foreign = await otherCompanyCustomer();
      const theirs = await (await fx.signedInAs(person)).post('/api/calendar-entries', entry([foreign.id]));
      expect(missing.status).toBe(400);
      expect({ status: theirs.status, body: theirs.body }).toEqual({ status: missing.status, body: missing.body });
    });
  });

  // ─── A customer under a franchise: keeping its parent is not choosing it ──────────────────────────────────────────────
  describe('a customer under a parent franchise', () => {
    /** A child customer the person reaches (they are on its lead), under a franchise of the Admin's they cannot. */
    async function childUnderHiddenParent() {
      const parent = await hiddenCustomer({ isParent: true });
      const child = await hiddenCustomer();
      await db.customer.update({ where: { id: child.id }, data: { parent_id: parent.id, bill_to_customer_id: parent.id } });
      await fx.addLead(org, child.id, { assignees: [person.id] });
      return { parent: parent.id, child: child.id };
    }

    it('saves an edit that re-sends the stored parent, as the edit form does on every save', async () => {
      const { parent, child } = await childUnderHiddenParent();
      const res = await (await fx.signedInAs(person)).patch(`/api/customers/${child}`, { first_name: 'Renamed', parent_id: parent, bill_to_customer_id: parent });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await db.customer.findUniqueOrThrow({ where: { id: child } })).first_name).toBe('Renamed');
    });

    it('refuses moving it under a franchise out of reach exactly as under one that does not exist', async () => {
      const { child } = await childUnderHiddenParent();
      const other = await hiddenCustomer({ isParent: true });
      const api = async () => fx.signedInAs(person);
      const missing = await (await api()).patch(`/api/customers/${child}`, { parent_id: randomUUID(), bill_to_customer_id: null });
      const hidden = await (await api()).patch(`/api/customers/${child}`, { parent_id: other.id, bill_to_customer_id: null });
      expect(missing.status).toBe(400);
      expect({ status: hidden.status, body: hidden.body }).toEqual({ status: missing.status, body: missing.body });
      expect((await db.customer.findUniqueOrThrow({ where: { id: child } })).parent_id).not.toBe(other.id);
    });
  });
});
