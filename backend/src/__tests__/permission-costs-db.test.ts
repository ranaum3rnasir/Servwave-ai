/* =============================================================================
   Roles & Permissions security fixes, M4 (ticket 35): costs hidden in one place. One table, every lane.

   A person holds one of three states of the two money switches:
     none    - no See prices, no See costs   -> no price and no cost anywhere
     prices  - See prices only               -> every price, no cost
     both    - See prices and See costs      -> everything
   and every route that returns a price column or a cost column of the schema is called in each state. A row names the
   names that must be ABSENT from the whole answer (at any depth) unless the person holds the switch, the names that must
   be PRESENT when they do, and a name that stays whatever they hold (proof the route answered). A route or a column added
   later is a new row, and the money-column guard (permission-money-columns-guard.test.ts) fails until its column is
   decided.

   Lanes: price presets, service plans, the customer page's deposits, the bell, the price book (items, brands, groups,
   picker, search), the inventory lists, estimate / invoice / job detail with their lines and cost model, the company
   answer, the Payments page (with a payment seeded, so its rule is exercised), reports and the dashboard.

   Everything goes through the public routes, as a person on a custom role made from blank holding exactly the switches
   the routes need. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const SEE_PRICES = keyOf('See prices');
const SEE_COSTS = keyOf('See costs');

type State = 'none' | 'prices' | 'both';
const STATES: Record<State, { prices: boolean; costs: boolean }> = {
  none: { prices: false, costs: false },
  prices: { prices: true, costs: false },
  both: { prices: true, costs: true },
};

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out); }
  return out;
}
/** True when the key the dotted path ends at is present on its parent, whatever its value (arrays are walked by index or transparently). */
function hasPath(body: unknown, path: string): boolean {
  const steps = path.split('.');
  let here: unknown[] = [body];
  for (const step of steps.slice(0, -1)) {
    here = here.flatMap((v) => (Array.isArray(v) ? v : [v])).flatMap((v) => (v != null && typeof v === 'object' ? [(v as Record<string, unknown>)[step]] : []));
  }
  return here.flatMap((v) => (Array.isArray(v) ? v : [v])).some((v) => v != null && typeof v === 'object' && steps[steps.length - 1]! in (v as object));
}

suite('M4: every lane hides costs without See costs and prices without See prices (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'scope_presets', 'item_group_lines', 'item_groups', 'price_book_items', 'brands', 'job_line_items', 'service_plans']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let org: string;
  let customer: string;
  let roleKey: string;
  let editorKey: string;
  let me: Person;
  let editor: Person;
  const ids: Record<string, string> = {};

  const setState = async (key: string, state: State) => {
    await setRoleSwitchValues({ organizationId: org, roleKey: key, actorId: null, reason: 'manual', values: { [SEE_COSTS]: false } });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, actorId: null, reason: 'manual', values: { [SEE_PRICES]: STATES[state].prices } });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, actorId: null, reason: 'manual', values: { [SEE_COSTS]: STATES[state].costs } });
  };

  beforeAll(async () => {
    const world = await fx.newOrg();
    org = world.org;
    customer = world.customer;
    orgs.push(org);

    roleKey = 'm4-costs';
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey, actorId: null, reason: 'manual',
      values: {
        ...allOff, jobs_scope: 'all', leads_scope: 'all', [SEE_PRICES]: true,
        [keyOf('View estimates')]: true, [keyOf('View invoices')]: true, [keyOf('View jobs')]: true,
        [keyOf('View leads')]: true, [keyOf('View customers')]: true, [keyOf('View price book')]: true, [keyOf('View stock')]: true,
        [keyOf('View service plans')]: true, [keyOf('View purchase orders')]: true,
        [keyOf('View payments and payouts')]: true, [keyOf('Access Reports')]: true,
      },
    });
    me = await fx.addUser(org, 'm4person', 'TECHNICIAN', { customRoleId: role.id });
    // The person who can also WRITE: Edit needs See prices, so this person is only ever tested with it on.
    editorKey = 'm4-costs-editor';
    const editorRole = await fx.addCustomRole(org, editorKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({
      organizationId: org, roleKey: editorKey, actorId: null, reason: 'manual',
      values: {
        ...allOff, jobs_scope: 'all', leads_scope: 'all', [SEE_PRICES]: true, [keyOf('View jobs')]: true, [keyOf('View leads')]: true, [keyOf('View estimates')]: true, [keyOf('Edit estimates')]: true, [keyOf('Export estimates')]: true,
        [keyOf('View service plans')]: true, [keyOf('Edit service plans')]: true,
      },
    });
    editor = await fx.addUser(org, 'm4editor', 'TECHNICIAN', { customRoleId: editorRole.id });

    // The company's cost model.
    await db.organization.update({ where: { id: org }, data: { labor_rate: 55, overhead_mode: 'FIXED', overhead_value: 12 } });

    // A price preset with a price and an internal cost.
    await db.scopePreset.create({
      data: { organization_id: org, name: 'Door install', scope_text: 'Install the door', priced: true, price: 120, internal_cost: 45 },
    });

    // A service plan with its price.
    ids.plan = (await fx.addServicePlan(org, customer)).id;

    // A brand with a markup, a costed item, a group whose line has a cost.
    await db.brand.create({ data: { organization_id: org, name: 'Brandy', default_markup_pct: 1.43 } });
    const item = randomUUID();
    await db.priceBookItem.create({
      data: { id: item, organization_id: org, name: 'Ball bearing hinge', sku: `SKU-${item.slice(0, 8)}`, unit_price: 99.5, sell_price: 99.5, unit_cost: 41.37 },
    });
    ids.item = item;
    await db.itemGroup.create({
      data: {
        organization_id: org, name: 'Starter kit', group_type: 'individual',
        lines: { create: [{ organization_id: org, item_id: item, name: 'Hinge', quantity: 2, price_override: 20, cost_override: 12.34 }] },
      },
    });

    // An estimate, an invoice and a job whose lines and cost model carry costs.
    const costModel = { labor_hours: 3.5, overhead_mode: 'FIXED' as const, overhead_value: 12 };
    const job = await fx.addJob(org, customer);
    ids.job = job.id;
    await db.job.update({ where: { id: job.id }, data: costModel });
    await db.jobLineItem.create({
      data: { job_id: job.id, organization_id: org, sequence: 1, description: 'Hinge', quantity: 1, unit_price: 100, line_total: 100, unit_cost: 40, markup_percent: 25 },
    });
    const est = await fx.addEstimate(org, customer, world.admin.id, { jobId: job.id });
    ids.estimate = est.id;
    await db.estimate.update({ where: { id: est.id }, data: { ...costModel, status: 'SENT', sent_at: new Date(), public_token: randomUUID() } });
    await db.estimateLineItem.update({ where: { id: est.lineId }, data: { unit_cost: 40, markup_percent: 25 } });
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    ids.invoice = inv.id;
    await db.invoice.update({ where: { id: inv.id }, data: { ...costModel, status: 'PARTIAL', amount_due: 60, sent_at: new Date() } });
    await db.invoiceLineItem.update({ where: { id: inv.lineId }, data: { unit_cost: 40, markup_percent: 25 } });
    // A card payment on the invoice: the Payments page lists it.
    await db.payment.create({
      data: {
        invoice_id: inv.id, amount: 40, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED', stripe_payment_intent_id: `pi_m4_${randomUUID().slice(0, 8)}`,
        stripe_fee_amount: 1.46, net_amount: 38.54,
      },
    });

    // The customer page's pending deposit: a sent deposit invoice on an estimate of the customer.
    const deposit = await fx.addInvoice(org, customer, { estimateId: est.id });
    await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT', status: 'SENT', amount_due: 25, sent_at: new Date() } });

    // A bell alert that names an amount, addressed to the person.
    const note = await db.notification.create({
      data: {
        organization_id: org, verb: 'billing.payment_received', category: 'BILLING', priority: 'FEED', needs_action: false,
        object_type: 'INVOICE', object_id: inv.id, object_label: 'INV-1', title: 'Payment received for INV-1', body: null,
        data: { object_label: 'INV-1', amount: '40.00', deposit_amount: 25 },
      },
    });
    await db.notificationRecipient.create({
      data: { notification_id: note.id, organization_id: org, recipient_id: me.id, priority: 'FEED', needs_action: false },
    });
    // A customer's text, whose preview names a figure: the words are the customer's and are never scanned.
    const text = await db.notification.create({
      data: {
        organization_id: org, verb: 'communication.sms_inbound', category: 'COMMUNICATION', priority: 'FEED', needs_action: false,
        object_type: 'MESSAGE_THREAD', object_id: randomUUID(), object_label: 'Pat Payer', title: 'New text — Pat Payer',
        body: 'Can you do it for $500?', data: { customer_name: 'Pat Payer', preview: 'Can you do it for $500?' },
      },
    });
    await db.notificationRecipient.create({
      data: { notification_id: text.id, organization_id: org, recipient_id: me.id, priority: 'FEED', needs_action: false },
    });
  }, 180_000);

  interface Row {
    lane: string;
    run: (a: Api) => Promise<{ status: number; body: any }>;
    /** Cost names that must be absent from the whole answer unless the person holds See costs, present when they do. */
    cost?: string[];
    /** Price names (or dotted paths) that must be absent unless See prices, present when held. */
    price?: string[];
    /** Cost names that must be absent without See costs, with no demand that they appear with it (a list that never carries them). */
    noCost?: string[];
    /** Price names that must be absent without See prices, with no demand that they appear with it. */
    noPrice?: string[];
    /** Names that are absent from the answer in EVERY state, even for someone who holds both switches (a bell names no amount to anyone). */
    never?: string[];
    /** Text that is in the answer in every state, exactly as written (words in a message are never scanned). */
    contains?: string[];
    /** Present in every state: proof the route answered with the record. */
    stays: string[];
    /** Who calls it: the reader (default) or the person who can also edit (then only the states with See prices apply). */
    as?: 'editor';
    /** The route may refuse a person without See prices instead (the Payments page needs it to open at all). */
    refusesWithoutPrices?: boolean;
  }

  const get = (path: () => string) => (a: Api) => a.get(path());
  const rows: Row[] = [
    { lane: 'price presets (list)', run: get(() => '/api/scope-presets'), cost: ['internal_cost'], price: ['price'], stays: ['presets.name'] },
    {
      lane: 'price presets (create)', as: 'editor',
      run: (a) => a.post('/api/scope-presets', { name: 'Made now', scope_text: 'x', priced: true, price: 10, internal_cost: 4 }),
      cost: ['internal_cost'], price: ['price'], stays: ['preset.name'],
    },
    { lane: 'service plans (list)', run: get(() => '/api/service-plans'), price: ['contract_price'], stays: ['servicePlans.service_plan_number'] },
    { lane: 'service plans (detail)', run: get(() => `/api/service-plans/${ids.plan}`), price: ['contract_price'], stays: ['servicePlan.service_plan_number'] },
    {
      lane: 'service plans (edit)', as: 'editor', run: (a) => a.patch(`/api/service-plans/${ids.plan}`, { name: 'Quarterly checks II' }),
      price: ['contract_price'], stays: ['servicePlan.service_plan_number'],
    },
    { lane: 'customer page (deposits)', run: get(() => `/api/customers/${customer}`), price: ['summary.deposits.pending', 'summary.deposits.collected'], stays: ['summary.estimates.pending', 'customer.first_name'] },
    { lane: 'customer summary (deposits)', run: get(() => `/api/customers/${customer}/summary`), price: ['deposits.pending', 'deposits.collected'], stays: ['estimates.pending'] },
    {
      lane: 'bell (list)', run: get(() => '/api/notifications'),
      never: ['items.data.amount', 'items.data.deposit_amount'], contains: ['Can you do it for $500?'],
      stays: ['items.verb', 'items.data.object_label'],
    },
    { lane: 'brands (inventory list)', run: get(() => '/api/inventory/brands'), cost: ['defaultMarkupPct'], stays: ['brands.name'] },
    { lane: 'item groups (inventory list)', run: get(() => '/api/inventory/item-groups'), cost: ['costOverride'], price: ['priceOverride'], stays: ['itemGroups.name'] },
    { lane: 'inventory items (list)', run: get(() => '/api/inventory/items'), cost: ['unitCost'], stays: ['data.name'] },
    { lane: 'inventory item (detail)', run: get(() => `/api/inventory/items/${ids.item}`), cost: ['unitCost'], stays: ['item.name'] },
    { lane: 'price book items (list)', run: get(() => '/api/price-book/items'), cost: ['unit_cost'], price: ['sell_price'], stays: ['data.name'] },
    { lane: 'price book item (detail)', run: get(() => `/api/price-book/items/${ids.item}`), cost: ['unit_cost'], price: ['sell_price'], stays: ['data.name'] },
    { lane: 'price book search (picker)', run: get(() => '/api/price-book/items/search?q=hinge'), cost: ['unitCost', 'unit_cost'], stays: ['data.name'] },
    { lane: 'price book catalog items', run: get(() => '/api/price-book/catalog-items'), cost: ['unitCost'], noCost: ['unit_cost'], stays: ['data.name'] },
    {
      lane: 'estimate detail (lines, cost model)', run: get(() => `/api/estimates/${ids.estimate}`),
      cost: ['unit_cost', 'markup_percent', 'labor_hours', 'overhead_value'], price: ['total_amount', 'unit_price'], stays: ['estimate.estimate_number'],
    },
    { lane: 'estimates (list)', run: get(() => '/api/estimates'), noCost: ['unit_cost', 'labor_hours', 'overhead_value'], price: ['total_amount'], stays: ['estimates.estimate_number'] },
    { lane: 'estimates (export)', as: 'editor', run: get(() => '/api/estimates/export'), noCost: ['unit_cost', 'labor_hours', 'overhead_value'], stays: ['estimates.estimate_number'] },
    {
      lane: 'invoice detail (lines, cost model)', run: get(() => `/api/invoices/${ids.invoice}`),
      cost: ['unit_cost', 'markup_percent', 'labor_hours', 'overhead_value'], price: ['total_amount', 'unit_price'], stays: ['invoice.invoice_number'],
    },
    { lane: 'invoices (list)', run: get(() => '/api/invoices'), noCost: ['unit_cost', 'labor_hours', 'overhead_value'], price: ['total_amount'], stays: ['invoices.invoice_number'] },
    {
      lane: 'job detail (lines, cost model)', run: get(() => `/api/jobs/${ids.job}`),
      cost: ['labor_hours', 'overhead_value'], noCost: ['unit_cost', 'markup_percent'], stays: ['job.job_number'],
    },
    { lane: 'jobs (list)', run: get(() => '/api/jobs'), noCost: ['unit_cost', 'labor_hours', 'overhead_value'], stays: ['jobs.job_number'] },
    { lane: 'job money panel', run: get(() => `/api/jobs/${ids.job}/financials`), noCost: ['unit_cost', 'labor_hours'], price: ['amount'], stays: ['payments.method'] },
    { lane: 'the company answer (cost model)', run: get(() => '/api/organization'), cost: ['labor_rate', 'overhead_value', 'overhead_mode'], stays: ['name'] },
    { lane: 'customer page (jobs and their cost model)', run: get(() => `/api/customers/${customer}`), noCost: ['unit_cost', 'labor_hours', 'overhead_value'], stays: ['customer.first_name'] },
    { lane: 'search', run: get(() => '/api/search?q=Pat'), noCost: ['unit_cost', 'labor_hours'], noPrice: ['total', 'amount_due'], stays: ['results'] },
    { lane: 'Payments page (list)', run: get(() => '/api/payments-page/payments'), price: ['amount', 'net', 'fee'], stays: ['payments.method', 'payments.invoice'], refusesWithoutPrices: true },
    { lane: 'Payments page (summary)', run: get(() => '/api/payments-page/summary?from=2026-01-01&to=2026-12-31'), noPrice: ['collected', 'fees', 'net', 'refunded'], stays: [], refusesWithoutPrices: true },
    { lane: 'Payments page (attention list)', run: get(() => '/api/payments-page/attention'), noPrice: ['amount'], stays: [], refusesWithoutPrices: true },
  ];

  const present = (body: unknown, name: string) => (name.includes('.') ? hasPath(body, name) : allKeys(body).has(name));

  for (const row of rows) {
    it(`${row.lane}: costs only with See costs, prices only with See prices`, async () => {
      const problems: string[] = [];
      const who = row.as === 'editor' ? editor : me;
      const key = row.as === 'editor' ? editorKey : roleKey;
      for (const state of (row.as === 'editor' ? ['prices', 'both'] : ['none', 'prices', 'both']) as State[]) {
        await setState(key, state);
        const res = await row.run(await fx.signedInAs(who));
        const refused = res.status === 403 && row.refusesWithoutPrices && !STATES[state].prices;
        if (refused) continue;
        if (res.status >= 300) { problems.push(`${state}: answered ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`); continue; }
        for (const name of row.stays) if (!present(res.body, name)) problems.push(`${state}: ${name} should stay`);
        for (const name of row.cost ?? []) {
          if (present(res.body, name) !== STATES[state].costs) problems.push(`${state}: cost ${name} ${STATES[state].costs ? 'is missing' : 'leaks'}`);
        }
        for (const name of row.never ?? []) if (present(res.body, name)) problems.push(`${state}: ${name} must never be shown`);
        for (const text of row.contains ?? []) if (!JSON.stringify(res.body).includes(text)) problems.push(`${state}: "${text}" should be there exactly as written`);
        for (const name of row.noCost ?? []) if (!STATES[state].costs && present(res.body, name)) problems.push(`${state}: cost ${name} leaks`);
        for (const name of row.noPrice ?? []) if (!STATES[state].prices && present(res.body, name)) problems.push(`${state}: price ${name} leaks`);
        for (const name of row.price ?? []) {
          if (present(res.body, name) !== STATES[state].prices) problems.push(`${state}: price ${name} ${STATES[state].prices ? 'is missing' : 'leaks'}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('a row that is only a cost or only a price is checked in both directions (the table can fail)', () => {
    // Every row names at least one thing to hide or the route it proves; the cost rows name only cost keys the schema has.
    const costNames = new Set(rows.flatMap((r) => [...(r.cost ?? []), ...(r.noCost ?? [])]));
    for (const must of ['internal_cost', 'defaultMarkupPct', 'costOverride', 'unit_cost', 'labor_rate']) expect(costNames.has(must), must).toBe(true);
    const priceNames = new Set(rows.flatMap((r) => [...(r.price ?? []), ...(r.noPrice ?? [])]));
    for (const must of ['price', 'contract_price', 'summary.deposits.pending']) expect(priceNames.has(must), must).toBe(true);
  });

  // Ran, 2026-10-28 ("builders see prices"): a preset is a priced scope, so applying or saving one is only for a person who sees
  // prices. On the server that is the Create / Edit switches: each requires See prices, so a person without it cannot hold them,
  // and the routes that apply (add a scope to an estimate or an invoice) and save (a preset) are behind them.
  it('applying or saving a preset is unreachable without See prices: the switches that open the routes require it, and the routes refuse', async () => {
    for (const label of ['Edit estimates', 'Create estimates', 'Edit invoices', 'Create invoices']) {
      const key = keyOf(label);
      const needs = { view_estimates: true, view_invoices: true, edit_estimates: true, edit_invoices: true, [key]: true, [SEE_PRICES]: false };
      expect(validateSwitchSet(needs).map((v) => v.switchKey), label).toContain(key);
    }
    await setState(roleKey, 'none');
    const a = await fx.signedInAs(me);
    expect((await a.post('/api/scope-presets', { name: 'Mine', scope_text: 'x', priced: true, price: 10 })).status).toBe(403);
    expect((await (await fx.signedInAs(me)).post(`/api/estimates/${ids.estimate}/scopes`, { title: 'From a preset', body: 'x', flat_price: 120 })).status).toBe(403);
    expect((await (await fx.signedInAs(me)).post(`/api/invoices/${ids.invoice}/scopes`, { title: 'From a preset', body: 'x', flat_price: 120 })).status).toBe(403);
    expect(await db.scopePreset.count({ where: { organization_id: org, name: 'Mine' } })).toBe(0);
  });

  // F2 (verifier round 2): every figure a history entry keeps on its metadata, under any key its writer chose, is left out of the
  // history of an invoice, an estimate, a job and a lead for a person without See prices. One table, over the four routes.
  it('history metadata: every money key is left out without See prices on all four history routes, the other keys stay, with See prices all are there', async () => {
    const MONEY_META = {
      amount: 40, tip_amount: 2, amount_due: 3, owed_amount: 1100, overpaid: 20, amount_cents: 50000, charged_cents: 50000,
      unapplied_cents: 12000, expected_cents: 10000, disputed_cents: 4000, unrefunded_cents: 12000, collected_total: 75, estimate_total: 100,
      from_amount: 1, to_amount: 2,
    };
    const PLAIN_META = { payment_id: 'p-1', reason: 'OVERPAYMENT', method: 'CHECK', event_id: 'evt_1', bank_return: false };
    const lead = await fx.addLead(org, customer);
    const routes: Array<{ lane: string; entity: string; id: string; path: string; events: (b: any) => any[] }> = [
      { lane: 'invoice', entity: 'INVOICE', id: ids.invoice, path: `/api/invoices/${ids.invoice}/timeline`, events: (b) => b.events },
      { lane: 'job', entity: 'JOB', id: ids.job, path: `/api/jobs/${ids.job}/timeline`, events: (b) => b.events },
      { lane: 'estimate', entity: 'ESTIMATE', id: ids.estimate, path: `/api/estimates/${ids.estimate}/history`, events: (b) => b.events ?? b.history ?? [] },
      { lane: 'lead', entity: 'LEAD', id: lead.id, path: `/api/leads/${lead.id}/timeline`, events: (b) => b.events },
    ];
    for (const r of routes) {
      // The estimate's History tab is served from the audit trail (action + metadata); the other three from timeline entries.
      if (r.lane === 'estimate') {
        await db.auditLog.create({ data: { org_id: org, action: 'PAYMENT_UNRECORDED', resource_type: 'Estimate', resource_id: r.id, metadata: { ...MONEY_META, ...PLAIN_META } } });
      } else {
        await db.timelineEvent.create({
          data: { organization_id: org, entity_type: r.entity, entity_id: r.id, event_type: 'PAYMENT_UNRECORDED', description: 'A payment was not recorded', metadata: { ...MONEY_META, ...PLAIN_META } },
        });
      }
    }
    for (const state of ['none', 'prices', 'both'] as State[]) {
      await setState(roleKey, state);
      for (const r of routes) {
        const res = await (await fx.signedInAs(me)).get(r.path);
        expect(res.status, `${r.lane} ${state} ${JSON.stringify(res.body).slice(0, 120)}`).toBe(200);
        const entry = r.events(res.body).find((e: { event_type?: string; action?: string }) => (e.event_type ?? e.action) === 'PAYMENT_UNRECORDED');
        expect(entry, `${r.lane} ${state}: the entry`).toBeDefined();
        const meta = (entry.metadata ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(MONEY_META)) expect(k in meta, `${r.lane} ${state}: ${k} ${STATES[state].prices ? 'is there' : 'is left out'}`).toBe(STATES[state].prices);
        for (const k of Object.keys(PLAIN_META)) expect(k in meta, `${r.lane} ${state}: ${k} stays`).toBe(true);
        if (r.lane !== 'estimate') expect(entry.description).toBe('A payment was not recorded');
      }
    }
  });
});
