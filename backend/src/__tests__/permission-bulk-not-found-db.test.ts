/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 47): bulk routes skip a record out of reach exactly as a
   missing one, and do nothing to it.

   One table over every route that takes a list of record ids: the bulk actions of the Estimates, Invoices, Jobs and
   Customers lists, the bulk-cancel preview, and making a job from one or several estimates. For each, the answer for an
   id the person cannot reach must be the answer for an id that does not exist (the id itself aside), and the record
   must come out untouched: same status, not deleted, no email, no timeline entry, no tag, no crew change, no new job.
   Leads, tasks, calendar entries and assets have no bulk route. The same goes for the create paths that take an estimate
   or invoice id in the body: making a job from estimates, and a logistic order anchored on an estimate or invoice, called
   by people who may convert from the lead or create orders but cannot reach the document.

   The person is on a custom role with every switch on and every scope at Their own; the records are the Admin's.
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

suite('bulk routes skip an out-of-reach record exactly as a missing one (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    // The bulk tag makes its tag on the first call; the fixture's cleanup does not know tags.
    await db.tagAssignment.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    await db.tag.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    await db.logisticOrder.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    await fx.cleanup();
  });

  let org = '';
  let customer = '';
  let admin: Person;
  let person: Person;
  /** Every switch on but View estimates (and what stands on it), both scopes All: may convert from any lead. */
  let noEstimates: Person;
  /** Every switch on, Jobs scope All, Leads scope Their own: may convert from a lead-less estimate and create any order. */
  let jobsAll: Person;
  /** Every switch on but View invoices (and what stands on it), both scopes All: may create any order. */
  let noInvoices: Person;

  beforeAll(async () => {
    const o = await fx.newOrg();
    ({ org, customer, admin } = o);
    const values: Record<string, unknown> = { ...presetSwitchSet('ADMIN') };
    for (const s of SWITCH_CATALOG) if (s.kind === 'choice' && s.key.endsWith('_scope')) values[s.key] = 'attached';
    await fx.addCustomRole(org, 'bulk-reach', 'DISPATCHER');
    await fx.setRoleSwitches(org, 'bulk-reach', values as never);
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: 'bulk-reach' } });
    person = await fx.addUser(org, 'bulky', 'DISPATCHER', { customRoleId: role.id });
    await fx.addUserMailbox(org, person);

    const standingOn = (key: string): string[] => {
      const direct = SWITCH_CATALOG.filter((s) => s.requires.includes(key)).map((s) => s.key);
      return [...new Set([...direct, ...direct.flatMap(standingOn)])];
    };
    const roleFor = async (key: string, v: Record<string, SwitchValue>) => {
      await fx.addCustomRole(org, key, 'DISPATCHER');
      await fx.setRoleSwitches(org, key, v);
      return (await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } })).id;
    };
    const noView: Record<string, SwitchValue> = { ...(values as Record<string, SwitchValue>), leads_scope: 'all', jobs_scope: 'all', view_estimates: false };
    for (const k of standingOn('view_estimates')) noView[k] = false;
    noEstimates = await fx.addUser(org, 'noestimates', 'DISPATCHER', { customRoleId: await roleFor('no-estimates', noView) });
    const noInvoiceView: Record<string, SwitchValue> = { ...(values as Record<string, SwitchValue>), leads_scope: 'all', jobs_scope: 'all', view_invoices: false };
    for (const k of standingOn('view_invoices')) noInvoiceView[k] = false;
    noInvoices = await fx.addUser(org, 'noinvoices', 'DISPATCHER', { customRoleId: await roleFor('no-invoices', noInvoiceView) });
    jobsAll = await fx.addUser(org, 'jobsall', 'DISPATCHER', {
      customRoleId: await roleFor('jobs-all', { ...(values as Record<string, SwitchValue>), jobs_scope: 'all', leads_scope: 'attached' }),
    });
    await db.customer.update({ where: { id: customer }, data: { email: `payer-${org.slice(0, 8)}@example.test` } });
  }, 120_000);

  const api = () => fx.signedInAs(person);

  /** Everything a skipped record must leave as it was: the company's emails, timeline, jobs and tags, and the record. */
  async function companyState(record: () => Promise<unknown>) {
    return {
      emails: await db.email.count({ where: { organization_id: org } }),
      timeline: await db.timelineEvent.count({ where: { organization_id: org } }),
      jobs: await db.job.count({ where: { organization_id: org } }),
      tags: await db.tagAssignment.count({ where: { organization_id: org } }),
      crew: await db.visitAssignee.count({ where: { organization_id: org } }),
      orders: await db.logisticOrder.count({ where: { organization_id: org } }),
      record: await record(),
    };
  }

  const estimateRow = (id: string) => () => db.estimate.findUnique({ where: { id }, select: { status: true, sent_at: true, updated_at: true } });
  const invoiceRow = (id: string) => () => db.invoice.findUnique({ where: { id }, select: { status: true, sent_at: true, updated_at: true, public_token: true } });
  const jobRow = (id: string) => () => db.job.findUnique({ where: { id }, select: { status: true, updated_at: true } });
  const customerRow = (id: string) => () => db.customer.findUnique({ where: { id }, select: { updated_at: true } });

  /** An estimate on a lead nobody but the Admin is on. */
  async function estimate(status: 'DRAFT' | 'SENT' | 'WON', lead?: string) {
    const l = lead ?? (await fx.addLead(org, customer, { owner: admin.id })).id;
    const e = await fx.addEstimate(org, customer, admin.id, { leadId: l });
    await db.estimate.update({ where: { id: e.id }, data: { status, ...(status === 'DRAFT' ? {} : { sent_at: new Date(), public_token: randomUUID() }) } });
    return { id: e.id, lead: l };
  }
  async function invoice(status: 'DRAFT' | 'SENT') {
    const j = await fx.addJob(org, customer, { crew: [admin.id] });
    const inv = await fx.addInvoice(org, customer, { jobId: j.id });
    if (status === 'SENT') await db.invoice.update({ where: { id: inv.id }, data: { status, sent_at: new Date(), public_token: randomUUID() } });
    return inv.id;
  }
  const job = async () => (await fx.addJob(org, customer, { crew: [admin.id] })).id;

  type Row = {
    name: string;
    /** Out-of-reach record ids for one call, and how to read the record back. */
    seed: () => Promise<{ ids: string[]; record: () => Promise<unknown> }>;
    call: (ids: string[]) => Promise<{ status: number; body: unknown }>;
  };

  const post = (path: string, body: (ids: string[]) => object, as: () => Person = () => person) =>
    async (ids: string[]) => (await fx.signedInAs(as())).post(path, body(ids));

  const table: Row[] = [
    {
      name: 'POST /api/estimates/bulk-delete (a draft)',
      seed: async () => { const e = await estimate('DRAFT'); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/estimates/bulk-delete', (ids) => ({ ids })),
    },
    ...(['DRAFT', 'SENT'] as const).map((status): Row => ({
      name: `POST /api/estimates/bulk-status backtodraft (a ${status.toLowerCase()} estimate)`,
      seed: async () => { const e = await estimate(status); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/estimates/bulk-status', (ids) => ({ ids, transition: 'backtodraft' })),
    })),
    {
      name: 'POST /api/estimates/bulk-status backtosent (a draft)',
      seed: async () => { const e = await estimate('DRAFT'); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/estimates/bulk-status', (ids) => ({ ids, transition: 'backtosent' })),
    },
    ...(['DRAFT', 'SENT', 'WON'] as const).map((status): Row => ({
      name: `POST /api/estimates/bulk-send-reminder (a ${status.toLowerCase()} estimate)`,
      seed: async () => { const e = await estimate(status); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/estimates/bulk-send-reminder', (ids) => ({ ids })),
    })),
    ...(['DRAFT', 'SENT'] as const).flatMap((status): Row[] => [
      {
        name: `POST /api/invoices/bulk-send (a ${status.toLowerCase()} invoice)`,
        seed: async () => { const id = await invoice(status); return { ids: [id], record: invoiceRow(id) }; },
        call: post('/api/invoices/bulk-send', (ids) => ({ ids })),
      },
      {
        name: `POST /api/invoices/bulk-resend (a ${status.toLowerCase()} invoice)`,
        seed: async () => { const id = await invoice(status); return { ids: [id], record: invoiceRow(id) }; },
        call: post('/api/invoices/bulk-resend', (ids) => ({ ids })),
      },
    ]),
    ...(['start', 'arrive', 'complete', 'cancel'] as const).map((action): Row => ({
      name: `POST /api/jobs/bulk-status ${action}`,
      seed: async () => { const id = await job(); return { ids: [id], record: jobRow(id) }; },
      call: post('/api/jobs/bulk-status', (ids) => ({ ids, action, ...(action === 'cancel' ? { cancel_reason_code: 'DUPLICATE_JOB' } : {}) })),
    })),
    {
      name: 'POST /api/jobs/bulk-assign',
      seed: async () => { const id = await job(); return { ids: [id], record: jobRow(id) }; },
      call: post('/api/jobs/bulk-assign', (ids) => ({ ids, assignee_ids: [person.id] })),
    },
    {
      name: 'GET /api/jobs/cancel-preview (a job with a paid invoice)',
      seed: async () => {
        const id = await job();
        const inv = await fx.addInvoice(org, customer, { jobId: id });
        await db.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', amount_due: 0, paid_at: new Date() } });
        await db.payment.create({ data: { invoice_id: inv.id, amount: 100, method: 'CHECK', paid_at: new Date() } });
        return { ids: [id], record: jobRow(id) };
      },
      call: async (ids) => (await api()).get(`/api/jobs/cancel-preview?ids=${ids.join(',')}`),
    },
    {
      name: 'POST /api/customers/bulk-tag',
      seed: async () => {
        const id = randomUUID();
        await db.customer.create({ data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Out', last_name: 'Ofreach', created_by_id: admin.id } });
        return { ids: [id], record: customerRow(id) };
      },
      call: post('/api/customers/bulk-tag', (ids) => ({ ids, name: 'Gold' })),
    },
    {
      name: 'POST /api/jobs from one won estimate',
      seed: async () => { const e = await estimate('WON'); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/jobs', (ids) => ({ estimate_ids: ids })),
    },
    {
      name: 'POST /api/jobs from a draft estimate on a lead they may convert from, with View estimates off',
      seed: async () => { const e = await estimate('DRAFT'); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/jobs', (ids) => ({ estimate_ids: ids }), () => noEstimates),
    },
    {
      name: 'POST /api/jobs from two draft estimates on a lead they may convert from, with View estimates off',
      seed: async () => {
        const a = await estimate('DRAFT');
        const b = await estimate('DRAFT', a.lead);
        return { ids: [a.id, b.id], record: async () => [await estimateRow(a.id)(), await estimateRow(b.id)()] };
      },
      call: post('/api/jobs', (ids) => ({ estimate_ids: ids }), () => noEstimates),
    },
    {
      name: 'POST /api/jobs from a draft lead-less estimate outside their Estimate reach, which they may convert from',
      seed: async () => {
        const e = await fx.addEstimate(org, customer, admin.id);
        return { ids: [e.id], record: estimateRow(e.id) };
      },
      call: post('/api/jobs', (ids) => ({ estimate_ids: ids }), () => jobsAll),
    },
    {
      name: 'POST /api/logistic-orders anchored on an estimate, with View estimates off',
      seed: async () => { const e = await estimate('SENT'); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/logistic-orders', (ids) => ({ estimate_id: ids[0] }), () => noEstimates),
    },
    {
      name: 'POST /api/logistic-orders anchored on an invoice, with View invoices off',
      seed: async () => {
        const e = await estimate('SENT');
        const inv = await fx.addInvoice(org, customer, { estimateId: e.id });
        return { ids: [inv.id], record: invoiceRow(inv.id) };
      },
      call: post('/api/logistic-orders', (ids) => ({ invoice_id: ids[0] }), () => noInvoices),
    },
    {
      name: 'POST /api/jobs from one won estimate, named as estimate_id',
      seed: async () => { const e = await estimate('WON'); return { ids: [e.id], record: estimateRow(e.id) }; },
      call: post('/api/jobs', (ids) => ({ estimate_id: ids[0] })),
    },
    {
      name: 'POST /api/jobs from two won estimates on one lead',
      seed: async () => {
        const a = await estimate('WON');
        const b = await estimate('WON', a.lead);
        return { ids: [a.id, b.id], record: async () => [await estimateRow(a.id)(), await estimateRow(b.id)()] };
      },
      call: post('/api/jobs', (ids) => ({ estimate_ids: ids })),
    },
  ];

  /** The body fields of the source guard (permission-body-id-doors.ts) each row stands for, by the start of its name. */
  const C = 'src/controllers/';
  const COVERS: [string, string][] = [
    ['POST /api/estimates/bulk-delete', `${C}estimate.controller.ts#bulkDeleteEstimatesSchema.ids`],
    ['POST /api/estimates/bulk-status', `${C}estimate.controller.ts#bulkSetEstimateStatusSchema.ids`],
    ['POST /api/estimates/bulk-send-reminder', `${C}estimate.controller.ts#bulkSendEstimateRemindersSchema.ids`],
    ['POST /api/invoices/bulk-send', `${C}invoice.controller.ts#bulkSendInvoicesSchema.ids`],
    ['POST /api/jobs/bulk-status', `${C}job.controller.ts#bulkStatusJobsSchema.ids`],
    ['POST /api/jobs/bulk-assign', `${C}job.controller.ts#bulkAssignJobsSchema.ids`],
    ['GET /api/jobs/cancel-preview', `${C}job.controller.ts#cancelPreviewQuerySchema.ids`],
    ['POST /api/customers/bulk-tag', `${C}tag.controller.ts#bulkTagEntitySchema.ids`],
    ['POST /api/jobs from two', `${C}job.controller.ts#createJobSchema.estimate_ids`],
    ['POST /api/jobs from one won estimate, named as estimate_id', `${C}job.controller.ts#createJobSchema.estimate_id`],
    ['POST /api/logistic-orders anchored on an estimate', `${C}logistic-order.controller.ts#createLogisticOrderSchema.estimate_id`],
    ['POST /api/logistic-orders anchored on an invoice', `${C}logistic-order.controller.ts#createLogisticOrderSchema.invoice_id`],
  ];

  it('covers every body field the source guard attributes to this file', () => {
    const mine = Object.entries(COVERED).filter(([, file]) => file === 'permission-bulk-not-found-db.test.ts').map(([k]) => k).sort();
    const rows = [...new Set(COVERS.filter(([prefix]) => table.some((r) => r.name.startsWith(prefix))).map(([, key]) => key))].sort();
    expect(rows).toEqual(mine);
  });

  /** The answer with each id named in it replaced by its position, so a missing id and a hidden id compare. */
  const answer = (res: { status: number; body: unknown }, ids: string[]) => {
    let text = JSON.stringify(res.body);
    ids.forEach((id, i) => { text = text.split(id).join(`<id${i}>`); });
    return { status: res.status, body: text };
  };

  for (const row of table) {
    it(`${row.name}: an out-of-reach record is skipped like a missing one, and left untouched`, async () => {
      const { ids, record } = await row.seed();
      const missing = ids.map(() => randomUUID());
      const missingAnswer = answer(await row.call(missing), missing);
      const before = await companyState(record);
      const hiddenAnswer = answer(await row.call(ids), ids);
      expect(hiddenAnswer).toEqual(missingAnswer);
      expect(await companyState(record)).toEqual(before);
    });
  }
});
