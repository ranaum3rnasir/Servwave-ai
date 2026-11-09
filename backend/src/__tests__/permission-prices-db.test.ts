/* =============================================================================
   Roles & Permissions alignment, AL-05 (P11): See prices is the root of the three money classes. A person without it
   gets no price - no unit price, line total, subtotal, tax, discount, balance, deposit or payment amount, no customer
   balance built from them - in any list, page, export, document, picker or search result of estimates, invoices, jobs and
   payments. The key is LEFT OUT, never zero or null.

   Everything goes through the public interface: the routes, called as a person on a custom role (never a built-in role
   name) who holds exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when
   it is unset. Every org it creates is removed again.

   One row per server check the catalog lists for See prices. For each row the same request is made with the switch on
   and with it off:
     - on: every price field is on the response;
     - off: every price field is absent and every other field of the record is still there.
   A last sweep reads every response again for ANY key that is named like money and holds a figure, so a price a probe
   did not name is still caught.
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

// The real renderers, with a note of every document one was handed: a PDF's bytes cannot be read for a figure, so the
// proof that no price is drawn for a person without the switch is that the renderer was never handed a document at all.
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
    generateStatementPdf: (doc: never, ...rest: never[]) => {
      handedToRenderer.push(JSON.stringify(doc));
      return real.generateStatementPdf(doc, ...(rest as [never]));
    },
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues, setPersonSwitchValues, editRoleSwitchValues, InvalidSwitchSetError } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { MONEY_TILE_IDS } from '../lib/dashboard/tileCatalog';

const suite = realClient ? describe : describe.skip;

const SEE_PRICES = 'see_prices';

/** The value at a dotted path ("estimate.line_items.0.unit_price"); undefined when any step is missing. */
function at(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, step) => {
    if (value == null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[step];
  }, body);
}

/** True when the key the path ends at is present on its parent, whatever its value. */
function hasKey(body: unknown, path: string): boolean {
  const steps = path.split('.');
  const holder = steps.length === 1 ? body : at(body, steps.slice(0, -1).join('.'));
  return holder != null && typeof holder === 'object' && steps[steps.length - 1]! in (holder as object);
}

/** Every key that names money and holds a figure, at any depth: the sweep for a price no probe named. */
const MONEY_NAME = /(amount|price|balance|subtotal|deposit|owed|tip|fee|paid|due|billed|revenue|refund|credit|discount|collected|invoiced|total|net|value|payout)/i;
const NOT_A_FIGURE_OF_MONEY = /(count|pending|pct|percent|rate|_at|_date|date|_id|number|totalpages|total_pages|pagination|days|period|type|method|status|reason|label|name)$/i;
/** Places a `total` is a number of records, not money. */
const COUNTS = new Set(['summary.estimates.total', 'estimates.total', 'stats.total', 'total']);
function moneyKeys(node: unknown, path = ''): string[] {
  if (Array.isArray(node)) return node.slice(0, 3).flatMap((n) => moneyKeys(n, path));
  if (node && typeof node === 'object') {
    // Paging is a count of rows, not money.
    return Object.entries(node as Record<string, unknown>)
      .filter(([k]) => !['pagination', 'meta'].includes(k))
      .flatMap(([k, v]) => moneyKeys(v, path ? `${path}.${k}` : k));
  }
  const leaf = path.split('.').pop() ?? '';
  const isFigure = typeof node === 'number' || (typeof node === 'string' && /^-?\d+(\.\d+)?$/.test(node));
  return isFigure && MONEY_NAME.test(leaf) && !NOT_A_FIGURE_OF_MONEY.test(leaf) && !COUNTS.has(path) ? [path] : [];
}

suite('See prices hides every price, on the server (real database)', () => {
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
      for (const sql of [
        `UPDATE payments SET payout_id = NULL WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`,
        `DELETE FROM payouts WHERE organization_id = '${org}'`,
        `DELETE FROM job_line_items WHERE organization_id = '${org}'`,
        `DELETE FROM price_book_items WHERE organization_id = '${org}'`,
      ]) await quietly(db.$executeRawUnsafe(sql));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  interface World {
    org: string;
    customer: string;
    estimateId: string;
    invoiceId: string;
    jobId: string;
    leadId: string;
    itemId: string;
    paymentId: string;
    roleKey: string;
    me: Person & { api: () => Promise<Api> };
  }

  async function buildWorld(): Promise<World> {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);

    // A person on a custom role made from blank, holding the reads the probes need and nothing else.
    const roleKey = 'prices-role';
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
    await setRoleSwitchValues({
      organizationId: org, roleKey, actorId: null, reason: 'manual',
      values: {
        ...allOff, jobs_scope: 'all', leads_scope: 'all',
        [keyOf('View estimates')]: true, [keyOf('View invoices')]: true, [keyOf('View jobs')]: true, [keyOf('View leads')]: true,
        [keyOf('View customers')]: true, [keyOf('Export estimates')]: true, [keyOf('Export invoices')]: true,
        [keyOf('View payments and payouts')]: true, [keyOf('View price book')]: true, [keyOf('View stock')]: true,
        [keyOf('Access Reports')]: true,
      },
    });
    const person = await fx.addUser(org, 'priceperson', 'TECHNICIAN', { customRoleId: role.id });
    const me = Object.assign(person, { api: () => fx.signedInAs(person) });

    // An estimate with a discount, one line and a scope.
    const est = await fx.addEstimate(org, customer, admin.id, { discount: { type: 'FIXED_AMOUNT', value: 5 } });
    await db.estimate.update({
      where: { id: est.id },
      data: { scopes: [{ id: randomUUID(), title: 'Scope', body: 'Fit it', flat_price: 50, is_taxable: true }] },
    });

    // A job with a line, its estimate and an invoice that has a card payment, a tip and a refund.
    const job = await fx.addJob(org, customer);
    const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    await db.invoice.update({ where: { id: inv.id }, data: { status: 'PARTIAL', amount_due: 60, tip: 3 } });
    const paymentId = randomUUID();
    await db.payment.create({
      data: {
        id: paymentId, invoice_id: inv.id, amount: 40, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED', tip_amount: 3,
        stripe_fee_amount: 1.5, platform_fee_amount: 0, net_amount: 38.5, stripe_payment_intent_id: `pi_test_${paymentId.slice(0, 12)}`,
      },
    });
    await db.jobLineItem.create({
      data: { job_id: job.id, organization_id: org, sequence: 1, description: 'Hinge', quantity: 1, unit_price: 100, line_total: 100 },
    });
    await db.job.update({ where: { id: job.id }, data: { estimate_id: jobEstimate.id, amount_invoiced: 100 } });
    // The job's own history: a payment recorded (nothing but money) and a line whose price changed.
    await db.timelineEvent.createMany({
      data: [
        {
          organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_PAYMENT_RECORDED',
          description: 'Payment recorded on the job', metadata: { amount: 40, method: 'CARD' }, created_by: admin.id,
        },
        {
          organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_LINE_CHANGED',
          description: 'Hinge changed', metadata: { line_id: 'x', old: { description: 'Hinge', unit_price: 90 }, new: { description: 'Hinge', unit_price: 100 } },
          created_by: admin.id,
        },
      ],
    });
    // A line of the invoice's own history that says an amount in words.
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'INVOICE', entity_id: inv.id, event_type: 'PAYMENT_RECEIVED',
        description: 'Payment received via card', metadata: { amount: 40 }, created_by: admin.id,
      },
    });
    await db.payout.create({
      data: {
        organization_id: org, stripe_payout_id: `po_test_${randomUUID().slice(0, 12)}`, status: 'PAID', amount: 500,
        arrival_date: new Date('2026-10-10T00:00:00Z'), destination_label: 'Test Bank',
      },
    });

    // A lead with an estimate on it.
    const lead = await fx.addLead(org, customer);
    await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });

    // A catalog item with a sell price and a list price.
    const item = await db.priceBookItem.create({
      data: {
        organization_id: org, name: 'Deadbolt', sku: `SKU-${org.slice(0, 6)}`, type: 'MATERIAL', kind: 'material',
        unit_cost: 20, unit_price: 80, sell_price: 90, list_price: 95, track_inventory: true,
      },
    });

    return {
      org, customer, estimateId: est.id, invoiceId: inv.id, jobId: job.id, leadId: lead.id,
      itemId: item.id, paymentId, roleKey, me,
    };
  }

  /** One request per server check: the prices it carries, and the fields of the same record that must stay. */
  interface Probe {
    check: string;
    run: (api: Api, w: World) => Promise<{ status: number; body: unknown }>;
    prices: string[];
    stays: string[];
    /** The person the request is made as (default: the person with no actions of their own). */
  }

  const documentPrices = (root: string) => [
    `${root}.total_amount`, `${root}.subtotal`, `${root}.tax_amount`, `${root}.line_items.0.unit_price`, `${root}.line_items.0.line_total`,
  ];
  const documentStays = (root: string, number: string) => [`${root}.${number}`, `${root}.status`, `${root}.line_items.0.description`, `${root}.line_items.0.quantity`];

  const probes: Probe[] = [
    {
      check: 'estimate-list-prices',
      run: (api) => api.get('/api/estimates'),
      prices: ['estimates.0.total_amount', 'estimates.0.subtotal', 'estimates.0.tax_amount', 'stats.draft.value'],
      stays: ['estimates.0.estimate_number', 'estimates.0.status', 'stats.draft.count', 'pagination.total'],
    },
    {
      check: 'estimate-detail-prices',
      run: (api, w) => api.get(`/api/estimates/${w.estimateId}`),
      prices: [...documentPrices('estimate'), 'estimate.discount_amount', 'estimate.discount_value', 'estimate.scopes.0.flat_price'],
      stays: [...documentStays('estimate', 'estimate_number'), 'estimate.scopes.0.title'],
    },
    {
      check: 'estimate-export-prices',
      run: (api) => api.get('/api/estimates/export'),
      prices: ['estimates.0.total_amount', 'estimates.0.subtotal'],
      stays: ['estimates.0.estimate_number', 'estimates.0.status'],
    },
    {
      check: 'invoice-list-prices',
      run: (api) => api.get('/api/invoices'),
      prices: ['invoices.0.total_amount', 'invoices.0.amount_due', 'invoices.0.subtotal', 'stats.due.total', 'stats.collected_this_month.total'],
      stays: ['invoices.0.invoice_number', 'invoices.0.status', 'pagination.total'],
    },
    {
      check: 'invoice-detail-prices',
      run: (api, w) => api.get(`/api/invoices/${w.invoiceId}`),
      prices: [
        ...documentPrices('invoice'), 'invoice.amount_due', 'invoice.tip', 'invoice.payments.0.amount', 'invoice.payments.0.tip_amount',
        'invoice.payments.0.stripe_fee_amount', 'invoice.payments.0.net_amount',
      ],
      stays: [...documentStays('invoice', 'invoice_number'), 'invoice.payments.0.method'],
    },
    {
      check: 'invoice-export-prices',
      run: (api) => api.get('/api/invoices/export'),
      prices: ['invoices.0.total_amount', 'invoices.0.amount_due'],
      stays: ['invoices.0.invoice_number', 'invoices.0.status'],
    },
    {
      check: 'job-detail-prices',
      run: (api, w) => api.get(`/api/jobs/${w.jobId}`),
      prices: ['job.amount_invoiced', 'job.estimate.total_amount', 'job.invoices.0.total_amount', 'job.invoices.0.amount_due', 'job.remaining_unbilled'],
      stays: ['job.job_number', 'job.status', 'job.invoices.0.invoice_number', 'job.estimate.estimate_number'],
    },
    {
      check: 'job-line-prices',
      run: (api, w) => api.get(`/api/jobs/${w.jobId}/line-items`),
      prices: ['lines.0.unit_price', 'lines.0.line_total', 'billing'],
      stays: ['lines.0.description', 'lines.0.quantity'],
    },
    {
      check: 'job-money-panel-prices',
      run: (api, w) => api.get(`/api/jobs/${w.jobId}/financials`),
      prices: [
        'invoices.0.total_amount', 'invoices.0.amount_due', 'payments.0.amount', 'total_invoiced', 'total_paid', 'totals',
        'final_invoice.total_amount',
      ],
      stays: ['invoices.0.invoice_number', 'invoices.0.status', 'payments.0.method'],
    },
    {
      check: 'payments-page-summary-prices',
      run: (api) => api.get('/api/payments-page/summary?from=2026-01-01&to=2026-12-31'),
      prices: ['collected', 'fees', 'net', 'refunds', 'next_payout.amount', 'next_payout.in_transit'],
      stays: ['count', 'next_payout.date'],
    },
    {
      check: 'payments-page-list-prices',
      run: (api) => api.get('/api/payments-page/payments'),
      prices: ['payments.0.amount', 'payments.0.fee', 'payments.0.net', 'payments.0.refunded'],
      stays: ['payments.0.method_label', 'payments.0.status', 'pagination.total'],
    },
    {
      check: 'payments-page-detail-prices',
      run: (api, w) => api.get(`/api/payments-page/payments/${w.paymentId}`),
      prices: ['amount', 'fee', 'net', 'tip', 'invoice_amount', 'refundable_amount'],
      stays: ['id', 'method_label'],
    },
    {
      check: 'payments-page-export-prices',
      run: (api) => api.get('/api/payments-page/payments/export'),
      prices: ['payments.0.amount', 'payments.0.fee', 'payments.0.net'],
      stays: ['payments.0.method_label', 'payments.0.status'],
    },
    {
      check: 'payments-page-payouts-prices',
      run: (api) => api.get('/api/payments-page/payouts'),
      prices: ['payouts.0.amount'],
      stays: ['payouts.0.status', 'pagination.total'],
    },
    {
      check: 'customer-detail-prices',
      run: (api, w) => api.get(`/api/customers/${w.customer}`),
      prices: [
        'customer.invoices.0.total_amount', 'customer.invoices.0.amount_due', 'customer.invoices.0.payments.0.amount',
        'summary.financials.lifetime_revenue', 'summary.financials.due_balance', 'summary.estimates.total_value',
      ],
      stays: ['customer.first_name', 'customer.invoices.0.invoice_number', 'summary.financials.unpaid_invoice_count', 'summary.estimates.total'],
    },
    {
      check: 'customer-summary-prices',
      run: (api, w) => api.get(`/api/customers/${w.customer}/summary`),
      prices: ['financials.lifetime_revenue', 'financials.total_invoiced', 'financials.past_due_balance', 'financials.due_balance', 'estimates.total_value'],
      stays: ['financials.unpaid_invoice_count', 'estimates.total'],
    },
    {
      check: 'price-book-list-prices',
      run: (api) => api.get('/api/price-book/items'),
      prices: ['data.0.unit_price', 'data.0.sell_price', 'data.0.list_price', 'data.0.sellPrice'],
      stays: ['data.0.name', 'data.0.sku'],
    },
    {
      check: 'price-book-detail-prices',
      run: (api, w) => api.get(`/api/price-book/items/${w.itemId}`),
      prices: ['data.unit_price', 'data.sell_price', 'data.list_price'],
      stays: ['data.name', 'data.sku'],
    },
    {
      check: 'stock-item-list-prices',
      run: (api) => api.get('/api/inventory/items'),
      prices: ['data.0.sellPrice', 'data.0.listPrice'],
      stays: ['data.0.name', 'data.0.sku'],
    },
    {
      check: 'stock-item-detail-prices',
      run: (api, w) => api.get(`/api/inventory/items/${w.itemId}`),
      prices: ['item.sellPrice', 'item.listPrice'],
      stays: ['item.name', 'item.sku'],
    },
    {
      check: 'search-prices',
      run: (api) => api.get('/api/search?q=Pat'),
      prices: ['results.estimates.0.total', 'results.invoices.0.total', 'results.invoices.0.amount_due'],
      stays: ['results.estimates.0.title', 'results.invoices.0.title'],
    },
    {
      check: 'lead-detail-prices',
      run: (api, w) => api.get(`/api/leads/${w.leadId}`),
      prices: ['lead.estimates.0.total_amount'],
      stays: ['lead.lead_number', 'lead.estimates.0.estimate_number'],
    },
    {
      check: 'record-history-amounts',
      run: (api, w) => api.get(`/api/invoices/${w.invoiceId}/timeline`),
      prices: ['events.0.metadata.amount'],
      stays: ['events.0.event_type'],
    },
    {
      check: 'report-row-prices',
      run: (api) => api.get('/api/reports/invoices'),
      prices: ['rows.0.amount', 'rows.0.due', 'rows.0.subtotal'],
      stays: ['rows.0.number'],
    },
  ];

  /** Checks answered by a refusal rather than an answer with the figures cut out. */
  const refused: Array<{ check: string; path: (w: World) => string; renderer: boolean }> = [
    { check: 'estimate-pdf-prices', path: (w) => `/api/estimates/${w.estimateId}/pdf`, renderer: true },
    { check: 'invoice-pdf-prices', path: (w) => `/api/invoices/${w.invoiceId}/pdf`, renderer: true },
    { check: 'customer-statement-prices', path: (w) => `/api/statements/customer/${w.customer}`, renderer: false },
  ];
  /** Checks answered by tiles or rows that are simply not offered. */
  const SPECIAL = ['dashboard-money-tiles', 'job-history-prices'];

  it('has a row for every server check the catalog lists for See prices', () => {
    const listed = SWITCH_CATALOG.find((s) => s.key === SEE_PRICES)!.serverChecks;
    const rows = [...probes.map((p) => p.check), ...refused.map((r) => r.check), ...SPECIAL];
    expect(rows.sort()).toEqual([...listed].sort());
  });

  describe('with the switch on and off, for a custom role', () => {
    let world: World;
    const setSwitch = (on: boolean) =>
      setRoleSwitchValues({
        organizationId: world.org, roleKey: world.roleKey, actorId: null, reason: 'manual', values: { [SEE_PRICES]: on },
      });
    const apiFor = () => world.me.api();

    beforeAll(async () => {
      world = await buildWorld();
    }, 120_000);

    it('carries every price with the switch on, each check reaching a real record', async () => {
      await setSwitch(true);
      for (const probe of probes) {
        const api = await apiFor();
        const res = await probe.run(api, world);
        expect(res.status, `${probe.check} ${JSON.stringify(res.body).slice(0, 200)}`).toBeLessThan(300);
        for (const path of probe.prices) expect(at(res.body, path), `${probe.check} ${path}`).not.toBeUndefined();
        for (const path of probe.stays) expect(at(res.body, path), `${probe.check} ${path} stays`).not.toBeUndefined();
      }
    });

    it('leaves every price out with the switch off, the key gone and not zero, and keeps the rest of the record', async () => {
      await setSwitch(false);
      for (const probe of probes) {
        const api = await apiFor();
        const res = await probe.run(api, world);
        expect(res.status, `${probe.check} ${JSON.stringify(res.body).slice(0, 200)}`).toBeLessThan(300);
        for (const path of probe.prices) expect(hasKey(res.body, path), `${probe.check} ${path} is absent`).toBe(false);
        for (const path of probe.stays) expect(at(res.body, path), `${probe.check} ${path} stays`).not.toBeUndefined();
        // Nothing else that names money and holds a figure is left on the answer.
        expect(moneyKeys(res.body), `${probe.check} money keys left`).toEqual([]);
      }
    });

    it('refuses the documents and the statement instead of handing out a copy with the figures cut out', async () => {
      handedToRenderer.length = 0;
      await setSwitch(false);
      const blind = await world.me.api();
      for (const r of refused) {
        const res = await blind.get(r.path(world));
        expect(res.status, r.check).toBe(403);
        expect(JSON.stringify(res.body), r.check).not.toMatch(/\d+\.\d\d/);
      }
      // The renderer was never handed a document for a person without the switch.
      expect(handedToRenderer).toEqual([]);

      // With the switch on the same requests are answered.
      await setSwitch(true);
      const seer = await world.me.api();
      for (const r of refused) {
        const res = await seer.get(r.path(world)).buffer(true).parse((resp, done) => {
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
          resp.on('end', () => done(null, Buffer.concat(chunks)));
        });
        expect(res.status, r.check).toBe(200);
      }
      expect(handedToRenderer.length).toBeGreaterThanOrEqual(2);
    }, 120_000);

    it('leaves the prices out of the job history: the money movements go, a changed line keeps what changed and not what it cost, the figure of an entry goes', async () => {
      type Entry = { event_type: string; description?: string; metadata?: { amount?: number; old?: Record<string, unknown>; new?: Record<string, unknown> } };
      const entries = async (api: Api) => {
        const res = await api.get(`/api/jobs/${world.jobId}/timeline`);
        expect(res.status).toBe(200);
        return res.body.events as Entry[];
      };
      await setSwitch(true);
      const seen = await entries(await world.me.api());
      expect(seen.find((e) => e.event_type === 'JOB_LINE_CHANGED')!.metadata!.new).toHaveProperty('unit_price');
      expect(seen.find((e) => e.event_type === 'PAYMENT_RECEIVED')!.metadata!.amount).toBe(40);

      await setSwitch(false);
      const blind = await entries(await world.me.api());
      expect(blind.map((e) => e.event_type)).not.toContain('JOB_PAYMENT_RECORDED');
      const changed = blind.find((e) => e.event_type === 'JOB_LINE_CHANGED')!;
      expect(changed.metadata!.new).not.toHaveProperty('unit_price');
      expect(changed.metadata!.new).toHaveProperty('description');
      const paid = blind.find((e) => e.event_type === 'PAYMENT_RECEIVED')!;
      // The words of an entry name no figure for anyone (Ran, 2026-10-28), so they come back as written; the figure is the metadata's.
      expect(paid.description).toBe('Payment received via card');
      expect(paid.metadata ?? {}).not.toHaveProperty('amount');
    });

    it('does not offer the dashboard money tiles, and does not compute them, without the switch', async () => {
      await setSwitch(false);
      const blind = await world.me.api();
      const res = await blind.get('/api/dashboard');
      expect(res.status).toBe(200);
      const offered = (res.body.tiles as Array<{ id: string }>).map((t) => t.id);
      for (const id of MONEY_TILE_IDS) {
        expect(offered, `${id} is not offered`).not.toContain(id);
        expect(res.body.data?.[id], `${id} is not computed`).toBeUndefined();
      }
    });

    it('keeps the record fields on the customer-facing page: a price on a document sent to the customer is not an output shown to staff', async () => {
      await setSwitch(false);
      const token = randomUUID();
      await db.estimate.update({ where: { id: world.estimateId }, data: { public_token: token, status: 'SENT' } });
      const request = (await import('supertest')).default;
      const app = await fx.listener();
      const res = await request(app).get(`/api/estimates/${world.estimateId}/public`).query({ token });
      // A customer reads their own estimate with its prices, whoever on staff cannot.
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toMatch(/total_amount/);
    });

    it('ignores a sort or a filter by price for a person without the switch, so the order and the count cannot give a price away', async () => {
      const { org, customer, admin } = await fx.newOrg();
      orgs.push(org);
      await fx.addCustomRole(org, 'sorter', 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
      await setRoleSwitchValues({
        organizationId: org, roleKey: 'sorter', actorId: null, reason: 'manual',
        values: { ...allOff, jobs_scope: 'all', leads_scope: 'all', view_estimates: true, view_invoices: true, export_estimates: true },
      });
      const sorter = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: 'sorter' } });
      const person = await fx.addUser(org, 'sorter', 'TECHNICIAN', { customRoleId: sorter.id });
      const cheap = await fx.addEstimate(org, customer, admin.id);
      const dear = await fx.addEstimate(org, customer, admin.id);
      await db.estimate.update({ where: { id: cheap.id }, data: { total_amount: 10, estimate_number: 'E-CHEAP' } });
      await db.estimate.update({ where: { id: dear.id }, data: { total_amount: 9000, estimate_number: 'E-DEAR' } });
      const api = await fx.signedInAs(person);

      const sorted = await api.get('/api/estimates?sortBy=total&sortDir=desc');
      expect(sorted.status).toBe(200);
      const filtered = await api.get('/api/estimates?total_min=5000');
      expect(filtered.status).toBe(200);
      // A filter by price that was honoured would leave only the dear estimate.
      expect((filtered.body.estimates as unknown[]).length).toBe(2);
      const exported = await api.get('/api/estimates/export?total_min=5000');
      expect((exported.body.estimates as unknown[]).length).toBe(2);
    }, 60_000);

    it('takes a person\'s own Record payments away when their role loses See prices, and says so in the change log', async () => {
      const { org } = await fx.newOrg();
      orgs.push(org);
      await fx.addCustomRole(org, 'drops', 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      await setRoleSwitchValues({
        organizationId: org, roleKey: 'drops', actorId: null, reason: 'manual',
        values: { view_invoices: true, [SEE_PRICES]: true, record_payments: false },
      });
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: 'drops' } });
      const person = await fx.addUser(org, 'dropper', 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: 'drops' });
      await setPersonSwitchValues({ organizationId: org, userId: person.id, values: { record_payments: true }, actorId: null });
      expect(await db.permissionUserSwitch.count({ where: { user_id: person.id, switch_key: 'record_payments' } })).toBe(1);

      await editRoleSwitchValues({
        organizationId: org, roleKey: 'drops', actorId: null, userBaseRole: 'TECHNICIAN',
        values: { view_invoices: true, [SEE_PRICES]: false, record_payments: false },
      });

      // The role no longer offers prices, so the person's own Record payments cannot stand on nothing.
      expect(await db.permissionUserSwitch.count({ where: { user_id: person.id, switch_key: 'record_payments' } })).toBe(0);
      const log = await db.permissionChangeLog.findFirst({ where: { organization_id: org, target_id: person.id, switch_key: 'record_payments', reason: 'role edit' } });
      expect(log).not.toBeNull();
    });

    it('refuses to store a set with Record payments, Create or Edit estimates or invoices on while See prices is off', async () => {
      const { org } = await fx.newOrg();
      orgs.push(org);
      await fx.addCustomRole(org, 'chain', 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      for (const key of ['record_payments', 'edit_estimates', 'edit_invoices']) {
        await expect(
          setRoleSwitchValues({
            organizationId: org, roleKey: 'chain', actorId: null, reason: 'manual',
            values: { view_estimates: true, view_invoices: true, [key]: true, [SEE_PRICES]: false },
          }),
          key,
        ).rejects.toBeInstanceOf(InvalidSwitchSetError);
      }
    });
  });
});
