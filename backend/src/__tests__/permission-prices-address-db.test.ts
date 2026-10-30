/* =============================================================================
   Roles & Permissions security fixes, H6 (ticket 34): prices can't be dodged.

   A person without See prices gets no amount in any answer, however the address is written: a trailing "/", capital
   letters or a doubled "/" reach the same handler as the tidy address, so they must get the same price filter. And the
   customer's private link token (the one the customer's own estimate and invoice pages open with, no sign-in needed)
   counts as a price: it is left out of every answer to a person without See prices, because with it they can open the
   customer's page and read every price there.

   Everything goes through the public interface: the routes, called as a person on a custom role made from blank, holding
   exactly the switch values under test (See prices on, then off). Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
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

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const SEE_PRICES = 'see_prices';
const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;

/** True when the key the dotted path ends at is present on its parent, whatever its value. */
function hasKey(body: unknown, path: string): boolean {
  const steps = path.split('.');
  const holder = steps.slice(0, -1).reduce<unknown>((value, step) => {
    if (value == null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[step];
  }, body);
  return holder != null && typeof holder === 'object' && steps[steps.length - 1]! in (holder as object);
}

suite('H6: prices cannot be dodged by retyping the address or through the customer link (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['job_line_items', 'credits', 'item_group_lines', 'item_groups']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let org: string;
  let customer: string;
  let roleKey: string;
  let me: Person;
  let estimateId: string;
  let invoiceId: string;
  let draftInvoiceId: string;
  let depositInvoiceId: string;
  let jobId: string;
  const estimateToken = randomUUID();
  const invoiceToken = randomUUID();
  const depositToken = randomUUID();

  const setSeePrices = (on: boolean) =>
    setRoleSwitchValues({ organizationId: org, roleKey, actorId: null, reason: 'manual', values: { [SEE_PRICES]: on } });
  const api = (): Promise<Api> => fx.signedInAs(me);

  beforeAll(async () => {
    const world = await fx.newOrg();
    org = world.org;
    customer = world.customer;
    orgs.push(org);

    roleKey = 'h6-prices';
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey, actorId: null, reason: 'manual',
      values: {
        ...allOff, jobs_scope: 'all', leads_scope: 'all', [SEE_PRICES]: true,
        [keyOf('View estimates')]: true, [keyOf('View invoices')]: true, [keyOf('View jobs')]: true, [keyOf('View leads')]: true,
        [keyOf('View customers')]: true, [keyOf('Access Reports')]: true, [keyOf('Send payment links')]: true,
        [keyOf('View price book')]: true, [keyOf('View payments and payouts')]: true,
      },
    });
    me = await fx.addUser(org, 'h6person', 'TECHNICIAN', { customRoleId: role.id });
    // The company's default deposit is a fixed amount: it is the deposit an estimate asks for, a price.
    await db.organization.update({
      where: { id: org },
      data: {
        deposit_default_type: 'FIXED', deposit_default_fixed_amount: 75, deposit_default_percentage: 25,
        // Card payments are taken but payouts are not on yet: the payout account status says what is waiting to be paid out.
        stripe_charges_enabled: true, stripe_payouts_enabled: false,
      },
    });

    // A sent estimate (it has a customer link) with a deposit invoice that has its own link.
    const est = await fx.addEstimate(org, customer, world.admin.id);
    estimateId = est.id;
    await db.estimate.update({ where: { id: est.id }, data: { status: 'SENT', public_token: estimateToken, sent_at: new Date() } });
    const deposit = await fx.addInvoice(org, customer, { estimateId: est.id });
    depositInvoiceId = deposit.id;
    await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT', status: 'SENT', public_token: depositToken } });
    await db.payment.create({
      data: { invoice_id: deposit.id, amount: 25, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' },
    });

    // A job with a sent invoice that has a card payment on it, and a draft invoice with no link yet.
    const job = await fx.addJob(org, customer);
    jobId = job.id;
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    invoiceId = inv.id;
    await db.invoice.update({
      where: { id: inv.id }, data: { status: 'PARTIAL', amount_due: 60, public_token: invoiceToken, sent_at: new Date() },
    });
    await db.payment.create({
      data: { invoice_id: inv.id, amount: 40, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED' },
    });
    await db.credit.create({
      data: { invoice_id: inv.id, organization_id: org, amount: 10, tax_portion: 1.5, reason: 'Goodwill', created_by: world.admin.id },
    });
    const group = await db.itemGroup.create({
      data: { organization_id: org, name: 'Door kit', group_type: 'kit', flat_rate_price_override: 250 },
    });
    await db.itemGroupLine.create({
      data: { organization_id: org, group_id: group.id, name: 'Hinge', quantity: 2, price_override: 30 },
    });
    await db.jobLineItem.create({
      data: { job_id: job.id, organization_id: org, sequence: 1, description: 'Hinge', quantity: 1, unit_price: 100, line_total: 100 },
    });
    draftInvoiceId = (await fx.addInvoice(org, customer, { jobId: job.id })).id;
    // A line of the invoice's history that says the amount in words.
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'INVOICE', entity_id: inv.id, event_type: 'PAYMENT_RECEIVED',
        description: 'Payment received via card', metadata: { amount: 40 }, created_by: world.admin.id,
      },
    });
  }, 120_000);

  /**
   * One address per priced route, each written the way the filter used to miss: a trailing "/", capital letters, a doubled
   * "/". `amounts` are the places a price sits on the answer that only the route's own rule knows to be money.
   */
  const dodges: Array<{ name: string; path: () => string; amounts: string[]; stays: string[] }> = [
    {
      name: 'search with a trailing "/"',
      path: () => '/api/search/?q=Pat',
      amounts: ['results.estimates.0.total', 'results.invoices.0.total'],
      stays: ['results.estimates.0.title', 'results.invoices.0.title'],
    },
    {
      name: 'invoice detail in capitals',
      path: () => `/API/invoices/${invoiceId}`,
      amounts: ['invoice.payments.0.amount'],
      stays: ['invoice.invoice_number', 'invoice.payments.0.method'],
    },
    {
      name: 'invoice list in mixed case with a trailing "/"',
      path: () => '/api/Invoices/',
      amounts: ['stats.due.total', 'stats.collected_this_month.total'],
      stays: ['invoices.0.invoice_number', 'stats.due.count'],
    },
    {
      name: 'estimate stats with a doubled "/"',
      path: () => '/api/estimates//stats',
      amounts: ['sent.value', 'pending_deposits.total'],
      stays: ['sent.count', 'pending_deposits.count'],
    },
    {
      name: 'estimate list with a trailing "/"',
      path: () => '/api/estimates/',
      amounts: ['stats.sent.value'],
      stays: ['estimates.0.estimate_number', 'stats.sent.count'],
    },
    {
      name: 'job money panel in capitals',
      path: () => `/API/JOBS/${jobId}/financials`,
      amounts: ['payments.0.amount', 'totals'],
      stays: ['invoices.0.invoice_number', 'payments.0.method'],
    },
    {
      name: 'customer page in capitals',
      path: () => `/Api/Customers/${customer}`,
      amounts: ['customer.jobs.0.invoices.0.payments.0.amount', 'summary.estimates.total_value'],
      stays: ['customer.first_name', 'customer.invoices.0.invoice_number'],
    },
    {
      name: 'invoice report in capitals with a trailing "/"',
      path: () => '/API/Reports/invoices/',
      amounts: ['rows.0.amount', 'rows.0.due'],
      stays: ['rows.0.number'],
    },
  ];

  it('without See prices, a retyped address still reaches the record and carries no amount', async () => {
    await setSeePrices(false);
    for (const d of dodges) {
      const res = await (await api()).get(d.path());
      expect(res.status, `${d.name} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      for (const p of d.stays) expect(hasKey(res.body, p), `${d.name}: ${p} stays`).toBe(true);
      // Soft, so a failure names every address that still carries an amount, not only the first.
      for (const p of d.amounts) expect.soft(hasKey(res.body, p), `${d.name}: ${p} is left out`).toBe(false);
    }
  });

  it('without See prices, a record\'s history read with a trailing "/" or in capitals carries no amount (the words name none for anyone)', async () => {
    await setSeePrices(false);
    for (const path of [`/api/invoices/${invoiceId}/timeline/`, `/API/Invoices/${invoiceId}/TIMELINE`]) {
      const res = await (await api()).get(path);
      expect(res.status, path).toBe(200);
      const paid = (res.body.events as Array<{ event_type: string; description: string; metadata?: { amount?: number } }>).find((e) => e.event_type === 'PAYMENT_RECEIVED');
      expect(paid, path).toBeDefined();
      expect(paid!.description, path).toBe('Payment received via card');
      expect(paid!.metadata ?? {}, path).not.toHaveProperty('amount');
    }
    await setSeePrices(true);
    const seen = await (await api()).get(`/api/invoices/${invoiceId}/timeline/`);
    expect(JSON.stringify(seen.body)).toMatch(/"amount":40/);
  });

  it('without See prices, a request written in absolute form (the whole address on the request line) carries no amount', async () => {
    await setSeePrices(false);
    const http = await import('http');
    const app = (await import('../app.js')).default as unknown as import('http').RequestListener;
    // Supertest always sends the path; the absolute form needs a raw request to a listening server.
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as import('net').AddressInfo;
    // Signs the person in (the auth mock answers for them) for the raw request below.
    await api();
    const get = (target: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const call = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, headers: { Authorization: `Bearer switches-${me.id}` } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      });
      call.on('error', reject);
      call.end();
    });
    try {
      for (const target of [`http://127.0.0.1:${port}/api/invoices/${invoiceId}`, `HTTP://127.0.0.1:${port}/API/Invoices/${invoiceId}/`]) {
        const res = await get(target);
        expect(res.status, `${target} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
        expect(hasKey(res.body, 'invoice.invoice_number'), target).toBe(true);
        expect(hasKey(res.body, 'invoice.payments.0.amount'), `${target}: the payment amount is left out`).toBe(false);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ── Every way of writing an address, on every priced route (story 51: "however the address is written") ──────────────

  /** A raw request to a listening copy of the app: supertest always sends a tidy path, and these forms are not tidy. */
  async function rawServer() {
    const http = await import('http');
    const app = (await import('../app.js')).default as unknown as import('http').RequestListener;
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as import('net').AddressInfo;
    await api(); // signs the person in: the auth mock answers for their bearer below
    const send = (method: string, target: string) => new Promise<{ status: number; text: string; body: any }>((resolve, reject) => {
      const call = http.request(
        { host: '127.0.0.1', port, method, path: target, headers: { Authorization: `Bearer switches-${me.id}`, 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => {
            let body: unknown = null;
            try { body = text ? JSON.parse(text) : null; } catch { body = null; }
            resolve({ status: res.statusCode ?? 0, text, body });
          });
        },
      );
      call.on('error', reject);
      call.end(method === 'GET' ? undefined : '{}');
    });
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return { port, send, close };
  }

  /** The priced routes, each with what proves it answered (`stays`) and the price it must not carry without See prices. */
  const pricedRoutes = (): Array<{ name: string; method: string; path: string; query?: string; stays: string; price: (body: any, text: string) => boolean }> => [
    { name: 'invoice detail', method: 'GET', path: `/api/invoices/${invoiceId}`, stays: 'invoice.invoice_number', price: (b) => hasKey(b, 'invoice.payments.0.amount') },
    { name: 'invoice list', method: 'GET', path: '/api/invoices', stays: 'stats.due.count', price: (b) => hasKey(b, 'stats.due.total') },
    { name: 'invoice history', method: 'GET', path: `/api/invoices/${invoiceId}/timeline`, stays: 'events', price: (_b, t) => /"amount":40/.test(t) },
    { name: 'search', method: 'GET', path: '/api/search', query: '?q=Pat', stays: 'results.invoices.0.title', price: (b) => hasKey(b, 'results.invoices.0.total') },
    { name: 'payment link', method: 'POST', path: `/api/invoices/${invoiceId}/payment-link`, stays: 'invoice.invoice_number', price: (b) => hasKey(b, 'url') || hasKey(b, 'invoice.public_token') },
    { name: 'estimate list', method: 'GET', path: '/api/estimates', stays: 'stats.sent.count', price: (b) => hasKey(b, 'stats.sent.value') },
    { name: 'job money panel', method: 'GET', path: `/api/jobs/${jobId}/financials`, stays: 'payments.0.method', price: (b) => hasKey(b, 'payments.0.amount') },
    { name: 'customer page', method: 'GET', path: `/api/customers/${customer}`, stays: 'customer.first_name', price: (b) => hasKey(b, 'customer.jobs.0.invoices.0.payments.0.amount') },
  ];

  /**
   * The ways to write one address. `reaches` marks the forms the router is known to send to the same handler; the others
   * may answer anything but a 2xx carrying a price.
   */
  function addressForms(path: string, query: string, port: number): Array<{ form: string; target: string; reaches: boolean }> {
    const [, , first, ...rest] = path.split('/'); // '', 'api', 'invoices', ...
    const tail = rest.length ? `/${rest.join('/')}` : '';
    const upper = `/API/${first!.toUpperCase()}${tail}`;
    const back = path.replace(/\//g, '\\').replace(/^\\/, '/');
    return [
      { form: 'plain', target: `${path}${query}`, reaches: true },
      { form: 'capitals', target: `${upper}${query}`, reaches: true },
      { form: 'trailing "/"', target: `${path}/${query}`, reaches: true },
      { form: 'doubled "/"', target: `/api//${first}${tail}${query}`, reaches: false },
      { form: 'fragment', target: `${path}${query}#frag`, reaches: true },
      { form: 'extra query', target: `${path}${query ? `${query}&x=1` : '?x=1'}`, reaches: true },
      { form: 'backslashes', target: `${back}${query}`, reaches: false },
      // With a fragment the router reads the address the lenient way, which turns "\\" into "/" (see prices.ts routeOf).
      { form: 'backslashes with a fragment', target: `${back}${query}#x`, reaches: rest.length === 0 },
      { form: 'one backslash with a fragment', target: `/api\\${first}${tail}${query}#x`, reaches: true },
      { form: 'full address, http', target: `http://127.0.0.1:${port}${path}${query}`, reaches: true },
      { form: 'full address, HTTP and capitals', target: `HTTP://127.0.0.1:${port}${upper}${query}`, reaches: true },
      { form: 'full address, another scheme', target: `foo://h${path}${query}`, reaches: rest.length > 0 },
      { form: 'full address, another scheme and a backslash', target: `foo://h/api\\${first}${tail}${query}`, reaches: rest.length > 0 },
      { form: 'encoded "/"', target: `/api%2F${first}${tail}${query}`, reaches: false },
      { form: '";" parameter', target: `${path};x=1${query}`, reaches: false },
      { form: '"." segment', target: `/api/./${first}${tail}${query}`, reaches: false },
      { form: '".." segment', target: `/api/x/../${first}${tail}${query}`, reaches: false },
    ];
  }

  it('without See prices, no way of writing the address of a priced route gets a price back', async () => {
    await setSeePrices(false);
    const raw = await rawServer();
    const failures: string[] = [];
    try {
      for (const route of pricedRoutes()) {
        for (const { form, target, reaches } of addressForms(route.path, route.query ?? '', raw.port)) {
          const res = await raw.send(route.method, target);
          const ok = res.status >= 200 && res.status < 300;
          if (reaches && !(ok && hasKey(res.body, route.stays))) failures.push(`${route.name}, ${form} (${target}): expected to reach the handler, answered ${res.status}`);
          if (ok && route.price(res.body, res.text)) failures.push(`${route.name}, ${form} (${target}): a price came back`);
        }
      }
    } finally {
      await raw.close();
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it('with See prices on, the plain address of every priced route carries its price', async () => {
    await setSeePrices(true);
    const raw = await rawServer();
    try {
      for (const route of pricedRoutes()) {
        const res = await raw.send(route.method, `${route.path}${route.query ?? ''}`);
        expect(res.status, route.name).toBeLessThan(300);
        expect(route.price(res.body, res.text), `${route.name} carries its price`).toBe(true);
      }
    } finally {
      await raw.close();
    }
  });

  it('with See prices on, the same retyped addresses carry every amount', async () => {
    await setSeePrices(true);
    for (const d of dodges) {
      const res = await (await api()).get(d.path());
      expect(res.status, d.name).toBe(200);
      for (const p of [...d.stays, ...d.amounts]) expect(hasKey(res.body, p), `${d.name}: ${p}`).toBe(true);
    }
  });

  /** Every place a staff answer carries the customer's private link, as the token or as the link built from it. */
  const links = [
    { name: 'estimate detail', run: (a: Api) => a.get(`/api/estimates/${estimateId}`), at: ['estimate.public_token'] },
    { name: 'deposit invoice detail', run: (a: Api) => a.get(`/api/invoices/${depositInvoiceId}`), at: ['invoice.public_token'] },
    { name: 'invoice detail', run: (a: Api) => a.get(`/api/invoices/${invoiceId}`), at: ['invoice.public_token'] },
    { name: 'payment link of a sent invoice', run: (a: Api) => a.post(`/api/invoices/${invoiceId}/payment-link`), at: ['url', 'invoice.public_token'] },
  ];

  /** Money whose name no rule knew until the money-column guard listed it. */
  const unlisted = [
    {
      name: 'a payment on the estimate\'s deposit invoice',
      run: (a: Api) => a.get(`/api/estimates/${estimateId}`),
      amounts: ['estimate.invoices.0.payments.0.amount'],
      stays: ['estimate.invoices.0.payments.0.method'],
    },
    {
      name: 'the tax part of a credit on an invoice',
      run: (a: Api) => a.get(`/api/invoices/${invoiceId}`),
      amounts: ['invoice.credits.0.tax_portion'],
      stays: ['invoice.credits.0.reason'],
    },
    {
      name: 'the price of an item group and of its line',
      run: (a: Api) => a.get('/api/inventory/item-groups'),
      amounts: ['itemGroups.0.flatRatePriceOverride', 'itemGroups.0.lines.0.priceOverride'],
      stays: ['itemGroups.0.name', 'itemGroups.0.lines.0.quantity'],
    },
  ];

  it('without See prices, money the money-column guard found unlisted is left out too', async () => {
    await setSeePrices(false);
    for (const u of unlisted) {
      const res = await u.run(await api());
      expect(res.status, `${u.name} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      for (const p of u.stays) expect(hasKey(res.body, p), `${u.name}: ${p} stays`).toBe(true);
      for (const p of u.amounts) expect(hasKey(res.body, p), `${u.name}: ${p} is left out`).toBe(false);
    }
  });

  it('with See prices on, that money comes back', async () => {
    await setSeePrices(true);
    for (const u of unlisted) {
      const res = await u.run(await api());
      expect(res.status, u.name).toBe(200);
      for (const p of [...u.stays, ...u.amounts]) expect(hasKey(res.body, p), `${u.name}: ${p}`).toBe(true);
    }
  });

  it('without See prices, the company\'s default fixed deposit is left out of the company answer; the percentage stays', async () => {
    await setSeePrices(false);
    const blind = await (await api()).get('/api/organization');
    expect(blind.status).toBe(200);
    expect(hasKey(blind.body, 'deposit_default_fixed_amount')).toBe(false);
    expect(hasKey(blind.body, 'deposit_default_percentage')).toBe(true);
    await setSeePrices(true);
    const seen = await (await api()).get('/api/organization');
    expect(Number(seen.body.deposit_default_fixed_amount)).toBe(75);
  });

  it('without See prices, the payout account status leaves out the money collected and waiting to be paid out', async () => {
    await setSeePrices(false);
    const blind = await (await api()).get('/api/organization/stripe/status');
    expect(blind.status, JSON.stringify(blind.body).slice(0, 200)).toBe(200);
    expect(hasKey(blind.body, 'connected')).toBe(true);
    expect(hasKey(blind.body, 'collected_awaiting_payout')).toBe(false);
    await setSeePrices(true);
    const seen = await (await api()).get('/api/organization/stripe/status');
    expect(seen.status).toBe(200);
    // The $40 card payment on the job's invoice.
    expect(seen.body.collected_awaiting_payout).toBe(40);
  });

  it('without See prices, the customer link token is left out of every staff answer, and the link answer carries no link', async () => {
    await setSeePrices(false);
    for (const l of links) {
      const res = await l.run(await api());
      expect(res.status, `${l.name} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      for (const p of l.at) expect(hasKey(res.body, p), `${l.name}: ${p} is left out`).toBe(false);
      const text = JSON.stringify(res.body);
      for (const token of [estimateToken, invoiceToken, depositToken]) expect(text, `${l.name} carries no token`).not.toContain(token);
    }
    // A link minted for a draft hands nothing back either.
    const minted = await (await api()).post(`/api/invoices/${draftInvoiceId}/payment-link`);
    expect(minted.status).toBe(200);
    expect(hasKey(minted.body, 'url')).toBe(false);
    expect(JSON.stringify(minted.body)).not.toMatch(/token=/);
  });

  it('with See prices on, the customer link token is in the staff answers', async () => {
    await setSeePrices(true);
    for (const l of links) {
      const res = await l.run(await api());
      expect(res.status, l.name).toBe(200);
      for (const p of l.at) expect(hasKey(res.body, p), `${l.name}: ${p}`).toBe(true);
    }
    const res = await (await api()).get(`/api/invoices/${invoiceId}`);
    expect(res.body.invoice.public_token).toBe(invoiceToken);
  });

  it('the customer page itself still opens with the token, signed in or not: the customer reads their own prices', async () => {
    const request = (await import('supertest')).default;
    const app = (await import('../app.js')).default as never;
    const res = await request(app).get(`/api/invoices/${invoiceId}/public`).query({ token: invoiceToken });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/total_amount/);
  });
});
