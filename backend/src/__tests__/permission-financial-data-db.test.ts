/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.15 - See financial data covers costs only, stripped on the server.

   Everything goes through the public interface: the routes, called as a person on a custom role (never a
   built-in role name) who holds exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.

   One row per server check the catalog lists for See financial data. For each row the same request is made
   with the switch on and with it off:
     - on: every cost field is on the response;
     - off: every cost field is absent (the key is gone, never zero or null) and every price field is still there.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The real renderers, with a note of the document each one was handed: the bytes of a PDF cannot be read
// for a figure, so the proof that no cost is drawn is that none is on the document the renderer receives.
const { handedToRenderer } = vi.hoisted(() => ({ handedToRenderer: [] as string[] }));
vi.mock('../lib/pdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/pdf')>();
  return {
    ...real,
    generateEstimatePdf: (doc: never, ...rest: never[]) => {
      handedToRenderer.push(JSON.stringify(doc));
      return real.generateEstimatePdf(doc, ...(rest as [never, never]));
    },
    generateInvoicePdf: (doc: never, ...rest: never[]) => {
      handedToRenderer.push(JSON.stringify(doc));
      return real.generateInvoicePdf(doc, ...(rest as [never, never]));
    },
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const SEE_FINANCIAL_DATA = keyOf('See financial data');
/** Figures no price, total or tax on the test records can equal, so finding one on a document means a cost was carried. */
const PDF_COST = { unitCost: 41.37, markup: 151.3, scopeCost: 25.91 };

/** The value at a dotted path ("estimate.line_items.0.unit_cost"); undefined when any step is missing. */
function at(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, step) => {
    if (value == null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[step];
  }, body);
}

/** True when the key the path ends at is present on its parent, whatever its value. */
function hasKey(body: unknown, path: string): boolean {
  const steps = path.split('.');
  const parent = at(body, steps.slice(0, -1).join('.') || '');
  const holder = steps.length === 1 ? body : parent;
  return holder != null && typeof holder === 'object' && steps[steps.length - 1]! in (holder as object);
}

suite('See financial data hides costs only, on the server (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of [
        'stock_movements', 'job_stage_lines', 'job_stages', 'purchase_order_lines', 'purchase_orders', 'job_line_items', 'stock_balances',
        'price_book_items', 'vendors',
      ]) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** Everything the probes read, made once in one company. */
  interface World {
    org: string;
    customer: string;
    estimateId: string;
    invoiceId: string;
    jobId: string;
    itemId: string;
    poId: string;
    me: Person & { roleKey: string; api: () => Promise<Api> };
  }

  async function buildWorld(): Promise<World> {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { labor_rate: 55, overhead_mode: 'PERCENTAGE', overhead_value: 12 } });

    // A person on a custom role made from blank, holding the reads the probes need and nothing else.
    const roleKey = 'financial-role';
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey, actorId: null, reason: 'manual',
      values: {
        ...allOff,
        estimates_scope: 'all', invoices_scope: 'all', jobs_scope: 'all', leads_scope: 'all',
        [keyOf('View estimates')]: true, [keyOf('View invoices')]: true, [keyOf('View jobs')]: true,
        [keyOf('Edit job line items')]: true,
        // The exports are their own switches (S01.23); the list-and-export probe downloads all three.
        [keyOf('Export estimates')]: true, [keyOf('Export invoices')]: true, [keyOf('Export jobs')]: true,
        [keyOf('View stock')]: true, [keyOf('See inventory activity')]: true, [keyOf('View price book')]: true,
        [keyOf('View purchase orders')]: true, [keyOf('View vendors')]: true,
      },
    });
    const person = await fx.addUser(org, 'finperson', 'TECHNICIAN', { customRoleId: role.id });
    const me = Object.assign(person, { roleKey, api: () => fx.signedInAs(person) });

    // An estimate with cost on its line, its scope and its cost model.
    const est = await fx.addEstimate(org, customer, admin.id);
    await db.estimateLineItem.update({ where: { id: est.lineId }, data: { unit_cost: PDF_COST.unitCost, markup_percent: PDF_COST.markup } });
    await db.estimate.update({
      where: { id: est.id },
      data: {
        labor_hours: 3, overhead_mode: 'PERCENTAGE', overhead_value: 10,
        scopes: [{ id: randomUUID(), title: 'Scope', body: '', flat_price: 50, is_taxable: true, internal_cost: PDF_COST.scopeCost }],
      },
    });

    // An invoice, the same way.
    const inv = await fx.addInvoice(org, customer);
    await db.invoiceLineItem.update({ where: { id: inv.lineId }, data: { unit_cost: PDF_COST.unitCost, markup_percent: PDF_COST.markup } });
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        labor_hours: 3, overhead_mode: 'PERCENTAGE', overhead_value: 10,
        scopes: [{ id: randomUUID(), title: 'Scope', body: '', flat_price: 50, is_taxable: true, internal_cost: PDF_COST.scopeCost }],
      },
    });

    // A job with a line, a cost model, an estimate with a total and an invoice on it.
    const job = await fx.addJob(org, customer);
    const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const jobInvoice = await fx.addInvoice(org, customer, { jobId: job.id });
    await db.job.update({
      where: { id: job.id },
      data: { estimate_id: jobEstimate.id, labor_hours: 2, overhead_mode: 'FIXED', overhead_value: 15, amount_invoiced: 100 },
    });
    await db.jobLineItem.create({
      data: {
        job_id: job.id, organization_id: org, sequence: 1, description: 'Hinge', quantity: 1,
        unit_price: 100, unit_cost: 30, markup_percent: 233, line_total: 100,
      },
    });
    void jobInvoice;

    // A catalog item with a cost, a sell price and a list price; the stock it holds; a movement of it.
    const vendor = await db.vendor.create({
      data: { organization_id: org, name: 'Supply Co', category: 'Hardware', account_number: 'ACCT-4471' },
    });
    const item = await db.priceBookItem.create({
      data: {
        organization_id: org, name: 'Deadbolt', sku: `SKU-${org.slice(0, 6)}`, type: 'MATERIAL', kind: 'material',
        unit_cost: 20, unit_price: 80, sell_price: 90, list_price: 95, track_inventory: true, vendor_id: vendor.id,
      },
    });
    await db.stockMovement.create({
      data: {
        organization_id: org, occurred_at: new Date(), item_sku: item.sku!, item_name: item.name, type: 'receive',
        qty: 5, reference: 'PO-1', actor: 'Tester', item_id: item.id, unit_cost: 20,
      },
    });

    // A purchase order with a line costed by the order and by the catalog.
    const po = await db.purchaseOrder.create({
      data: {
        organization_id: org, po_number: `PO-${org.slice(0, 6)}`, vendor: 'Supply Co', vendor_id: vendor.id, status: 'draft', job_id: job.id,
      },
    });
    await db.purchaseOrderLine.create({
      data: {
        organization_id: org, purchase_order_id: po.id, item_sku: item.sku!, item_name: item.name, uom: 'EA',
        qty_ordered: 4, qty_received: 0, unit_cost: 18, price_book_item_id: item.id,
      },
    });

    // A job stage holding a line whose cost came from the purchase order.
    const stage = await db.jobStage.create({
      data: {
        organization_id: org, job_id: job.id, job_number: 'J-1', customer: 'Customer', site: 'Site', trade: 'Locksmith', status: 'pending',
      },
    });
    await db.jobStageLine.create({
      data: {
        organization_id: org, job_stage_id: stage.id, item_sku: item.sku!, item_name: item.name, uom: 'EA',
        qty_ordered: 4, qty_received: 0, unit_cost: 22.5, vendor: 'Supply Co', po_number: po.po_number,
      },
    });

    return { org, customer, estimateId: est.id, invoiceId: inv.id, jobId: job.id, itemId: item.id, poId: po.id, me };
  }

  /** One request per server check: the costs it carries, and the prices that must stay either way. */
  interface Probe {
    check: string;
    run: (api: Api, w: World) => Promise<{ status: number; body: unknown }>;
    costs: string[];
    prices: string[];
  }

  const documentCosts = (root: string) => [
    `${root}.labor_hours`, `${root}.overhead_mode`, `${root}.overhead_value`,
    `${root}.line_items.0.unit_cost`, `${root}.line_items.0.markup_percent`, `${root}.scopes.0.internal_cost`,
  ];
  const documentPrices = (root: string) => [
    `${root}.total_amount`, `${root}.subtotal`, `${root}.tax_amount`,
    `${root}.line_items.0.unit_price`, `${root}.line_items.0.line_total`, `${root}.scopes.0.flat_price`,
  ];

  const probes: Probe[] = [
    {
      check: 'estimate-cost',
      run: (api, w) => api.get(`/api/estimates/${w.estimateId}`),
      costs: documentCosts('estimate'),
      prices: documentPrices('estimate'),
    },
    {
      check: 'invoice-cost',
      run: (api, w) => api.get(`/api/invoices/${w.invoiceId}`),
      costs: documentCosts('invoice'),
      prices: [...documentPrices('invoice'), 'invoice.amount_due'],
    },
    {
      check: 'job-cost',
      run: (api, w) => api.get(`/api/jobs/${w.jobId}`),
      costs: ['job.labor_hours', 'job.overhead_mode', 'job.overhead_value'],
      prices: ['job.amount_invoiced', 'job.estimate.total_amount', 'job.invoices.0.total_amount', 'job.invoices.0.amount_due'],
    },
    {
      check: 'job-line-cost',
      run: (api, w) => api.get(`/api/jobs/${w.jobId}/line-items`),
      costs: ['lines.0.unit_cost', 'lines.0.markup_percent'],
      prices: ['lines.0.unit_price', 'lines.0.line_total', 'billing.total', 'billing.subtotal'],
    },
    {
      check: 'organization-cost-model',
      run: (api) => api.get('/api/organization'),
      costs: ['labor_rate', 'overhead_mode', 'overhead_value'],
      prices: [],
    },
    {
      check: 'price-book-cost',
      run: (api, w) => api.get(`/api/price-book/items/${w.itemId}`),
      costs: ['data.unit_cost'],
      prices: ['data.unit_price', 'data.sell_price', 'data.list_price'],
    },
    {
      check: 'price-book-list-cost',
      run: (api) => api.get('/api/price-book/items'),
      costs: ['data.0.unit_cost', 'data.0.unitCost'],
      prices: ['data.0.unit_price', 'data.0.sell_price', 'data.0.list_price', 'data.0.sellPrice'],
    },
    {
      check: 'stock-item-cost',
      run: (api, w) => api.get(`/api/inventory/items/${w.itemId}`),
      costs: ['item.unitCost'],
      prices: ['item.sellPrice', 'item.listPrice'],
    },
    {
      check: 'stock-item-list-cost',
      run: (api) => api.get('/api/inventory/items'),
      costs: ['data.0.unitCost'],
      prices: ['data.0.sellPrice', 'data.0.listPrice'],
    },
    {
      check: 'stock-movement-cost',
      run: (api) => api.get('/api/inventory/movements'),
      costs: ['data.0.unitCost'],
      prices: [],
    },
    {
      check: 'purchase-order-cost',
      run: (api, w) => api.get(`/api/inventory/purchase-orders/${w.poId}`),
      costs: ['purchaseOrder.lines.0.unitCost', 'purchaseOrder.lines.0.catalogUnitCost'],
      prices: [],
    },
    {
      check: 'job-stage-cost',
      run: (api) => api.get('/api/inventory/job-stages'),
      costs: ['jobStages.0.items.0.unitCost'],
      prices: ['jobStages.0.items.0.qtyOrdered'],
    },
    {
      check: 'vendor-account-number',
      run: (api) => api.get('/api/inventory/vendors'),
      costs: ['vendors.0.accountNumber'],
      prices: [],
    },
  ];

  it('has a row for every server check the catalog lists for See financial data', () => {
    const listed = SWITCH_CATALOG.find((s) => s.key === SEE_FINANCIAL_DATA)!.serverChecks;
    expect(probes.map((p) => p.check).sort()).toEqual([...listed].sort());
  });

  describe('with the switch on and off, for a custom role', () => {
    let world: World;
    const setSwitch = (on: boolean) =>
      setRoleSwitchValues({
        organizationId: world.org, roleKey: world.me.roleKey, actorId: null, reason: 'manual',
        values: { [SEE_FINANCIAL_DATA]: on },
      });

    beforeAll(async () => {
      world = await buildWorld();
    }, 60_000);

    it('carries every cost with the switch on, each check reaching a real record', async () => {
      await setSwitch(true);
      const api = await world.me.api();
      for (const probe of probes) {
        const res = await probe.run(api, world);
        expect(res.status, probe.check).toBe(200);
        for (const path of probe.costs) expect(at(res.body, path), `${probe.check} ${path}`).not.toBeUndefined();
        for (const path of probe.prices) expect(at(res.body, path), `${probe.check} ${path}`).not.toBeUndefined();
      }
    });

    it('leaves every cost out with the switch off, the key gone and not zero, and keeps every price', async () => {
      await setSwitch(false);
      const api = await world.me.api();
      for (const probe of probes) {
        const res = await probe.run(api, world);
        expect(res.status, probe.check).toBe(200);
        for (const path of probe.costs) {
          expect(hasKey(res.body, path), `${probe.check} ${path} is absent`).toBe(false);
        }
        for (const path of probe.prices) expect(at(res.body, path), `${probe.check} ${path} stays`).not.toBeUndefined();
      }
    });

    it('keeps list prices, totals, tax, balance and deposit on the lists and exports of estimates, jobs and invoices', async () => {
      await setSwitch(false);
      const api = await world.me.api();

      const estimates = await api.get('/api/estimates');
      expect(estimates.status).toBe(200);
      const estimate = (estimates.body.estimates as Record<string, unknown>[]).find((e) => e.id === world.estimateId)!;
      expect(estimate.total_amount).toBeDefined();
      for (const key of ['unit_cost', 'markup_percent', 'labor_hours', 'overhead_mode', 'overhead_value']) expect(key in estimate, key).toBe(false);

      const invoices = await api.get('/api/invoices');
      expect(invoices.status).toBe(200);
      const invoice = (invoices.body.invoices as Record<string, unknown>[]).find((i) => i.id === world.invoiceId)!;
      expect(invoice.total_amount).toBeDefined();
      expect(invoice.amount_due).toBeDefined();
      for (const key of ['unit_cost', 'markup_percent', 'labor_hours', 'overhead_mode', 'overhead_value']) expect(key in invoice, key).toBe(false);

      const jobs = await api.get('/api/jobs');
      expect(jobs.status).toBe(200);
      for (const job of jobs.body.jobs as Record<string, unknown>[]) {
        for (const key of ['labor_hours', 'overhead_mode', 'overhead_value']) expect(key in job, key).toBe(false);
      }

      const estimateExport = await api.get('/api/estimates/export');
      expect(estimateExport.status).toBe(200);
      const exported = (estimateExport.body.estimates as Record<string, unknown>[]).find((e) => e.id === world.estimateId)!;
      expect(exported.total_amount).toBeDefined();
      for (const key of ['unit_cost', 'markup_percent', 'labor_hours', 'overhead_mode', 'overhead_value']) expect(key in exported, key).toBe(false);

      const invoiceExport = await api.get('/api/invoices/export');
      expect(invoiceExport.status).toBe(200);
      const exportedInvoice = (invoiceExport.body.invoices as Record<string, unknown>[]).find((i) => i.id === world.invoiceId)!;
      expect(exportedInvoice.total_amount).toBeDefined();
      expect(exportedInvoice.amount_due).toBeDefined();

      const jobExport = await api.get('/api/jobs/export');
      expect(jobExport.status).toBe(200);
      for (const job of jobExport.body.jobs as Record<string, unknown>[]) {
        for (const key of ['labor_hours', 'overhead_mode', 'overhead_value']) expect(key in job, key).toBe(false);
      }
    });

    it('renders the estimate and invoice PDFs for a person without the switch: the document carries prices and never a cost', async () => {
      await setSwitch(false);
      handedToRenderer.length = 0;
      const api = await world.me.api();
      for (const path of [`/api/estimates/${world.estimateId}/pdf`, `/api/invoices/${world.invoiceId}/pdf`]) {
        const res = await api.get(path).buffer(true).parse((r, done) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
          r.on('end', () => done(null, Buffer.concat(chunks)));
        });
        expect(res.status, path).toBe(200);
        expect(res.headers['content-type'], path).toMatch(/application\/pdf/);
        expect(res.body.subarray(0, 4).toString(), path).toBe('%PDF');
      }

      // One document per request, each handed to the renderer with its prices and without a cost.
      expect(handedToRenderer).toHaveLength(2);
      for (const document of handedToRenderer) {
        expect(document).toContain('"unit_price"');
        for (const key of ['unit_cost', 'markup_percent', 'labor_hours', 'overhead_mode', 'overhead_value', 'internal_cost']) {
          expect(document, key).not.toContain(`"${key}"`);
        }
        for (const figure of Object.values(PDF_COST)) expect(document, String(figure)).not.toContain(String(figure));
      }
    }, 60_000);

    // Every estimate action answers with the whole estimate again. Each one is called against its own
    // record, in the state the action needs, by a person who can do everything except see costs.
    describe('on the answers to estimate actions', () => {
      const ACTION_COSTS = [
        'estimate.labor_hours', 'estimate.overhead_mode', 'estimate.overhead_value',
        'estimate.line_items.0.unit_cost', 'estimate.line_items.0.markup_percent', 'estimate.scopes.0.internal_cost',
      ];
      const ACTION_PRICES = ['estimate.total_amount', 'estimate.line_items.0.unit_price', 'estimate.line_items.0.line_total'];

      let doer: World['me'];
      beforeAll(async () => {
        const roleKey = 'estimate-doer';
        const role = await fx.addCustomRole(world.org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
        const allOn = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true]));
        await setRoleSwitchValues({
          organizationId: world.org, roleKey, actorId: null, reason: 'manual',
          values: {
            ...allOn, [SEE_FINANCIAL_DATA]: false,
            estimates_scope: 'all', invoices_scope: 'all', jobs_scope: 'all', leads_scope: 'all',
          },
        });
        const person = await fx.addUser(world.org, 'estimatedoer', 'TECHNICIAN', { customRoleId: role.id });
        doer = Object.assign(person, { roleKey, api: () => fx.signedInAs(person) });
      }, 60_000);

      /** A fresh estimate carrying cost on its line, its scope and its cost model, in the given status. */
      async function costedEstimate(status: 'DRAFT' | 'SENT' | 'WON') {
        const owner = await db.user.findFirstOrThrow({ where: { organization_id: world.org } });
        const est = await fx.addEstimate(world.org, world.customer, owner.id);
        await db.estimateLineItem.update({ where: { id: est.lineId }, data: { unit_cost: 40, markup_percent: 150 } });
        await db.estimate.update({
          where: { id: est.id },
          data: {
            status, labor_hours: 3, overhead_mode: 'PERCENTAGE', overhead_value: 10,
            scopes: [{ id: randomUUID(), title: 'Scope', body: '', flat_price: 50, is_taxable: true, internal_cost: 25 }],
          },
        });
        return est.id;
      }

      const actions: Array<{ name: string; status: 'DRAFT' | 'SENT' | 'WON'; call: (api: Api, id: string) => Promise<{ status: number; body: unknown }> }> = [
        { name: 'mark as sent', status: 'DRAFT', call: (api, id) => api.post(`/api/estimates/${id}/mark-sent`, {}) },
        { name: 'recall to draft', status: 'SENT', call: (api, id) => api.patch(`/api/estimates/${id}/status`, { transition: 'backtodraft' }) },
        { name: 'approve internally', status: 'SENT', call: (api, id) => api.post(`/api/estimates/${id}/approve-internal`, {}) },
        { name: 'decline internally', status: 'SENT', call: (api, id) => api.post(`/api/estimates/${id}/decline-internal`, { lost_reason: 'PRICE' }) },
        {
          name: 'waive the deposit', status: 'SENT',
          call: async (api, id) => {
            await db.invoice.create({
              data: {
                id: randomUUID(), organization_id: world.org, customer_id: world.customer, estimate_id: id, kind: 'DEPOSIT',
                invoice_number: `DEP-${id.slice(0, 8)}`, subtotal: 10, tax_amount: 0, total_amount: 10, amount_due: 10, status: 'SENT',
              },
            });
            return api.post(`/api/estimates/${id}/waive-deposit`, {});
          },
        },
        { name: 'cancel', status: 'DRAFT', call: (api, id) => api.post(`/api/estimates/${id}/cancel`, { cancelled_reason: 'No longer needed' }) },
      ];

      it.each(actions)('leaves every cost out of the answer to: $name', async ({ status, call }) => {
        const api = await doer.api();
        const res = await call(api, await costedEstimate(status));
        expect(res.status).toBe(200);
        for (const path of ACTION_COSTS) expect(hasKey(res.body, path), `${path} is absent`).toBe(false);
        for (const path of ACTION_PRICES) expect(at(res.body, path), `${path} stays`).not.toBeUndefined();
      }, 60_000);
    });

    // Copy to invoice answers with the NEW INVOICE, built from the estimate's cost model. It is open to
    // the Dispatcher base, whose preset has See financial data off, so the default case is exposed.
    it('leaves every cost out of the invoice that copying an estimate to an invoice answers with', async () => {
      // A company of its own: the shared one already holds an invoice whose number the next one would take.
      const { org, customer, admin } = await fx.newOrg();
      const copier = await fx.addCustomRole(org, 'estimate-copier', 'DISPATCHER', {
        copyGrants: false,
        extraGrants: [
          { action: 'create', subject: 'Invoice' }, { action: 'read', subject: 'Invoice' }, { action: 'read', subject: 'Estimate' },
        ],
      });
      await setRoleSwitchValues({
        organizationId: org, roleKey: 'estimate-copier', actorId: null, reason: 'manual',
        values: { [SEE_FINANCIAL_DATA]: false, invoices_scope: 'all', estimates_scope: 'all' },
      });
      const person = await fx.addUser(org, 'estimatecopier', 'DISPATCHER', { customRoleId: copier.id });
      const api = await fx.signedInAs(person);
      const est = await fx.addEstimate(org, customer, admin.id);
      await db.estimateLineItem.update({ where: { id: est.lineId }, data: { unit_cost: 41.37, markup_percent: 151.3 } });
      await db.estimate.update({
        where: { id: est.id },
        data: {
          status: 'WON', labor_hours: 3, overhead_mode: 'PERCENTAGE', overhead_value: 10,
          scopes: [{ id: randomUUID(), title: 'Scope', body: '', flat_price: 50, is_taxable: true, internal_cost: 25.91 }],
        },
      });
      const res = await api.post(`/api/estimates/${est.id}/copy-to-invoice`, {});
      expect(res.status).toBe(201);
      for (const path of [
        'invoice.labor_hours', 'invoice.overhead_mode', 'invoice.overhead_value',
        'invoice.line_items.0.unit_cost', 'invoice.line_items.0.markup_percent', 'invoice.scopes.0.internal_cost',
      ]) expect(hasKey(res.body, path), `${path} is absent`).toBe(false);
      expect(at(res.body, 'invoice.total_amount')).toBeDefined();
      expect(at(res.body, 'invoice.line_items.0.unit_price')).toBeDefined();
    }, 60_000);

    it('keeps the job money panel: invoices, totals and payments follow the invoices the person can open', async () => {
      await setSwitch(false);
      const api = await world.me.api();
      const res = await api.get(`/api/jobs/${world.jobId}/financials`);
      expect(res.status).toBe(200);
      expect(at(res.body, 'invoices.0.total_amount')).toBeDefined();
      expect(at(res.body, 'invoices.0.amount_due')).toBeDefined();
      expect(at(res.body, 'total_invoiced')).toBeDefined();
      expect(at(res.body, 'total_paid')).toBeDefined();
    });

    it('lets a person without the switch add a priced job line while the server fills the cost from the catalog', async () => {
      await setSwitch(false);
      const api = await world.me.api();
      const res = await api.post(`/api/jobs/${world.jobId}/line-items`, {
        description: 'Deadbolt', quantity: 2, unit_price: 77, item_type: 'MATERIAL', is_taxable: true, price_book_item_id: world.itemId,
      });
      expect(res.status).toBe(201);
      expect(Number(at(res.body, 'line.unit_price'))).toBe(77);
      expect(hasKey(res.body, 'line.unit_cost')).toBe(false);
      const stored = await db.jobLineItem.findFirstOrThrow({ where: { job_id: world.jobId, description: 'Deadbolt' } });
      expect(Number(stored.unit_price)).toBe(77);
      expect(Number(stored.unit_cost)).toBe(20);
    });
  });
});
