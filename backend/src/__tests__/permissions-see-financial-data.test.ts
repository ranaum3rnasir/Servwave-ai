/**
 * SRVW-140 - the Roles UI "See financial data" switch must gate financial data.
 *
 * Before this card the switch wrote exactly one grant, `read Report`, which gates the /api/reports
 * routes and the Reports/Billing nav and appears NOWHERE in the cost/price path. The predicate that
 * actually strips every cost, margin and money field - `canSeeCosts` (lib/permissions/enforce.ts)
 * - keyed on `read Invoice`, a completely different control (the Invoices "View" cell in the CRUD
 * matrix). SALES therefore rendered the switch OFF in all 16 staging orgs while seeing every cost.
 *
 * The fix introduces a dedicated `read Pricing` catalog grant, repoints canSeeCosts at it, and
 * makes the switch its single writer. `read Report` gets its own honest "View reports" sensitive
 * row so 13 report routes and 8 nav entries stay admin-configurable.
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts), grants via setCachedGrants and the
 * person's switch values via mockRoleSwitches - mirrors job-lines-pricing-leak.test.ts /
 * estimate-pricing-leak.test.ts.
 *
 * Roles & Permissions S01.15: the switch is a catalog switch (`see_financial_data`) now, so the stored
 * `read Pricing` row no longer counts and each state below is a switch value. It covers COSTS only: the
 * prices on the same responses stay.
 *
 * THE FIXTURE THIS FILE EXISTS FOR is a requester holding `read Invoice` and NOT `read Pricing`.
 * That is the one state this card changes, and it is the state estimate-pricing-leak.test.ts and
 * job-financials-pricing.test.ts cannot reach (the first grants no `read Invoice` at all; the
 * second builds a subject-agnostic `{ can: () => true/false }` stub).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, ESTIMATE_FIXTURE, mockRoleSwitches } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { canSeeCosts } from '../lib/permissions/enforce';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  invoice: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;
const ESTIMATE_ID = ESTIMATE_FIXTURE.id;
const INVOICE_ID = '00000000-0000-0000-0000-000000000901';

type TestGrant = { action: string; subject: string; conditions: Record<string, unknown> | null };

// Jobs, estimates and invoices are reached through their Data Scope switches, not stored grants: an
// unconditional read is the module's View on with its scope All. See financial data is a switch too.
function openRecordsIfAsked(extra: string[], opts: { invoices: boolean; seeFinancialData: boolean }) {
  const open: Record<string, boolean | string> = { see_financial_data: opts.seeFinancialData };
  if (extra.includes('Job')) open.jobs_scope = 'all';
  if (extra.includes('Estimate')) Object.assign(open, { view_estimates: true, estimates_scope: 'all' });
  if (opts.invoices || extra.includes('Invoice')) Object.assign(open, { view_invoices: true, invoices_scope: 'all' });
  mockRoleSwitches(open);
}

// The switch-OFF state: See financial data off and `read Invoice` present, plus whatever route gate
// the surface under test needs. Unconditional grants so canAccessRow short-circuits.
function grantsWithoutPricing(...extra: string[]) {
  const grants: TestGrant[] = [{ action: 'read', subject: 'Invoice', conditions: null }];
  for (const subject of extra) grants.push({ action: 'read', subject, conditions: null });
  openRecordsIfAsked(extra, { invoices: true, seeFinancialData: false });
}

// The switch-ON state without any invoice access: proves the switch is the door to costs, not a second
// lock stacked on top of read Invoice.
function grantsWithPricingOnly(...extra: string[]) {
  const grants: TestGrant[] = [];
  for (const subject of extra) grants.push({ action: 'read', subject, conditions: null });
  openRecordsIfAsked(extra, { invoices: false, seeFinancialData: true });
}

function priceBookSearchRow() {
  return {
    id: 'aaaaaaa2-0000-0000-0000-000000000002',
    name: '12ga Wire (ft)',
    description: null,
    image_url: null,
    type: 'MATERIAL',
    unit_cost: 2,
    unit_price: 4,
    taxable: true,
    category: null,
  };
}

function catalogItemRow() {
  return {
    id: 'aaaaaaa2-0000-0000-0000-000000000003',
    sku: 'LOCK-100',
    name: 'Deadbolt Lock',
    unit_cost: 20,
    unit_price: 40,
    sell_price: 40,
    list_price: 55,
    uom: 'EA',
    track_inventory: false,
    is_active: true,
    updated_at: new Date('2026-02-01'),
    category: null,
    vendor: null,
    stock_balances: [],
  };
}

function jobLineWithCost() {
  return {
    id: 'aa000000-0000-0000-0000-000000000001',
    job_id: JOB_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: 500,
    markup_percent: 50,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    stock_status: 'NOT_TRACKED',
    stock_location_id: null,
  };
}

// The owner-chain + billing-input shape job-lines.controller's loadGuardedJob loads.
function jobGuardRow(lines: unknown[] = []) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    source_plan_id: null,
    job_number: 'J00001',
    customer: { tax_exempt: false },
    visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } },
    job_line_items: lines,
    invoices: [],
    scopes: null,
  };
}

function estimateLineWithCost() {
  return {
    id: 'li000000-0000-0000-0000-000000000009',
    estimate_id: ESTIMATE_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: 500,
    markup_percent: 50,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
  };
}

function scopeWithCost() {
  return {
    id: 'cc000000-0000-0000-0000-000000000009',
    title: 'Permit fee',
    body: '',
    flat_price: 300,
    is_taxable: true,
    internal_cost: 150,
  };
}

function estimateDetailRow() {
  return {
    ...ESTIMATE_FIXTURE,
    lead: { ...ESTIMATE_FIXTURE.lead, lead_assignees: [{ user_id: TEST_USERS.technician.id }] },
    line_items: [estimateLineWithCost()],
    scopes: [scopeWithCost()],
    labor_hours: 6,
    overhead_mode: 'FIXED',
    overhead_value: 75,
  };
}

// The billing-inputs shape estimate-lines.controller's loadGuardedEstimate loads.
function estimateGuardRow() {
  return {
    id: ESTIMATE_ID,
    status: 'DRAFT',
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    scopes: [scopeWithCost()],
    line_items: [estimateLineWithCost()],
    lead: { lead_assignees: [{ user_id: TEST_USERS.technician.id }] },
  };
}

function invoiceDetailRow() {
  return {
    id: INVOICE_ID,
    invoice_number: 'I00001',
    status: 'DRAFT',
    kind: 'STANDARD',
    estimate_id: null,
    customer_id: null,
    net_collected: 0,
    tip: 0,
    subtotal: 2300,
    discount_amount: 0,
    tax_rate: 0.08,
    tax_amount: 168,
    deposit_credit: 0,
    total_amount: 2468,
    amount_due: 2468,
    labor_hours: 6,
    overhead_mode: 'FIXED',
    overhead_value: 75,
    line_items: [
      {
        id: 'ili00000-0000-0000-0000-000000000001',
        sequence: 1,
        description: 'AC Unit',
        quantity: 1,
        unit_price: 1800,
        unit_cost: 900,
        markup_percent: 100,
        is_taxable: true,
        line_total: 1800,
        item_type: 'PART',
        discount_type: null,
        discount_value: null,
        discount_amount: 0,
        price_book_item_id: null,
        stock_status: 'NOT_TRACKED',
        stock_location_id: null,
        price_book_item: null,
      },
    ],
    scopes: [scopeWithCost()],
    public_token: null,
    sent_at: null,
    paid_at: null,
    due_date: null,
    voided_at: null,
    refunds: [],
    credits: [],
    payments: [],
    job: null,
    customer: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('technician');
});

// ════════════════════════════════════════════════════════════════════════════
// 1. The predicate itself
// ════════════════════════════════════════════════════════════════════════════
describe('canSeeCosts - the predicate', () => {
  it('is FALSE for an ability holding read Invoice but NOT read Pricing', () => {
    const ability = defineAbilityFor({ id: TEST_USERS.technician.id, role: 'TECHNICIAN' }, [
      { action: 'read', subject: 'Invoice', conditions: null },
    ]);
    expect(canSeeCosts({ ability } as unknown as Request)).toBe(false);
  });

  it('is TRUE for an ability holding read Pricing and NOT read Invoice', () => {
    const ability = defineAbilityFor({ id: TEST_USERS.technician.id, role: 'TECHNICIAN' }, [
      { action: 'read', subject: 'Pricing', conditions: null },
    ]);
    expect(canSeeCosts({ ability } as unknown as Request)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2-8. The consumer surfaces, driven over HTTP in the switch-OFF state
// ════════════════════════════════════════════════════════════════════════════
describe('switch OFF (read Invoice, See financial data off) - costs are stripped everywhere, prices stay', () => {
  it('price-book search strips unit_cost', async () => {
    grantsWithoutPricing('PriceBook');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([priceBookSearchRow()]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=wire')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].unit_cost).toBeUndefined();
    // The customer-facing selling price is NEVER stripped.
    expect(res.body.data[0].unit_price).toBe(4);
  });

  it('inventory catalog strips unitCost and keeps the prices', async () => {
    grantsWithoutPricing('Inventory');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([catalogItemRow()]);
    mockPrisma.priceBookItem.count.mockResolvedValue(1);

    const res = await request(app).get('/api/inventory/items').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].unitCost).toBeUndefined();
    expect(res.body.data[0].listPrice).toBe(55);
    expect(res.body.data[0].sellPrice).toBe(40);
  });

  it('GET /api/organization omits labor_rate/overhead_mode/overhead_value', async () => {
    grantsWithoutPricing('Organization');
    mockPrisma.organization.findUnique.mockResolvedValue({ id: ALPHA_ORG_ID, name: 'Alpha HVAC' });

    const res = await request(app).get('/api/organization').set(authHeader('technician'));

    expect(res.status).toBe(200);
    const select = mockPrisma.organization.findUnique.mock.calls[0][0].select;
    expect(select.labor_rate).toBeUndefined();
    expect(select.overhead_mode).toBeUndefined();
    expect(select.overhead_value).toBeUndefined();
    expect(res.body.labor_rate).toBeUndefined();
  });

  it('job line items strip cost, keep the prices and the billing totals', async () => {
    grantsWithoutPricing('Job');
    mockPrisma.job.findUnique.mockResolvedValue(jobGuardRow([jobLineWithCost()]));

    const res = await request(app).get(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const line = res.body.lines[0];
    expect(line.unit_cost).toBeUndefined();
    expect(line.markup_percent).toBeUndefined();
    expect(line.unit_price).toBe(1000);
    expect(line.line_total).toBe(1000);
    expect(res.body.billing).not.toBeNull();
    // Work detail survives - a technician still needs to know WHAT is on the job.
    expect(line.description).toBe('AC Unit');
  });

  it('estimate detail strips line cost and scope internal_cost', async () => {
    grantsWithoutPricing('Estimate');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateDetailRow());

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const line = res.body.estimate.line_items[0];
    expect(line.unit_cost).toBeUndefined();
    expect(line.markup_percent).toBeUndefined();
    expect(res.body.estimate.scopes[0].internal_cost).toBeUndefined();
    expect(res.body.estimate.labor_hours).toBeUndefined();
  });

  it('estimate scopes strip internal_cost', async () => {
    grantsWithoutPricing('Estimate');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateGuardRow());

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].internal_cost).toBeUndefined();
    expect(res.body.scopes[0].flat_price).toBe(300);
  });

  const financialsInvoiceRow = () => ({
    id: INVOICE_ID,
    invoice_number: 'I00001',
    kind: 'STANDARD',
    status: 'SENT',
    total_amount: 2468,
    amount_due: 1268,
    sent_at: new Date('2026-02-02'),
    paid_at: null,
    voided_at: null,
    tip: 0,
    tax_rate: 0.08,
    tax_amount: 168,
    discount_amount: 0,
    subtotal: 2300,
    line_items: [
      { id: 'l1', sequence: 1, description: 'AC Unit', quantity: 1, unit_price: 1800, is_taxable: true, line_total: 1800, discount_type: null, discount_value: null, discount_amount: 0, item_type: 'PART', price_book_item_id: null, price_book_item: null },
    ],
    payments: [
      { id: 'p1', amount: 1200, method: 'CHECK', paid_at: new Date('2026-02-03'), voided_at: null, reference_number: 'CHK-1', stripe_fee_amount: null, platform_fee_amount: null, net_amount: null },
    ],
  });

  it('job financials keep the invoice money for someone who reads invoices: it is prices, and See financial data covers costs only', async () => {
    grantsWithoutPricing('Job');
    mockPrisma.job.findUnique.mockResolvedValue({ estimate_id: null });
    mockPrisma.invoice.findMany.mockResolvedValue([financialsInvoiceRow()]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/financials`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.final_invoice.total_amount).toBe(2468);
    expect(res.body.final_invoice.amount_due).toBe(1268);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.total_invoiced).toBe(2468);
  });

  it('job financials list no invoice for someone who can open none, but the job\'s own figures and the lifecycle bar stay', async () => {
    // View invoices off (the Technician preset), and the invoice is not one they made.
    mockRoleSwitches({ jobs_scope: 'all', view_invoices: false, see_financial_data: true });
    mockPrisma.job.findUnique.mockResolvedValue({ estimate_id: null });
    mockPrisma.invoice.findMany.mockResolvedValueOnce([financialsInvoiceRow()]).mockResolvedValueOnce([]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/financials`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([]);
    expect(res.body.payments).toEqual([]);
    // The job's totals and balance show to anyone who can open the job.
    expect(res.body.final_invoice.total_amount).toBe(2468);
    expect(res.body.final_invoice.amount_due).toBe(1268);
    expect(res.body.total_invoiced).toBe(2468);
    expect(res.body.final_invoice.invoice_number).toBe('I00001');
  });

  it('invoice records stay listable and openable while their costs go', async () => {
    grantsWithoutPricing();
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceDetailRow());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const invoice = res.body.invoice;
    // The RECORD is visible - this requester holds read Invoice.
    expect(invoice.invoice_number).toBe('I00001');
    expect(invoice.total_amount).toBe(2468);
    expect(invoice.amount_due).toBe(2468);
    // The COST MODEL is not.
    expect(invoice.labor_hours).toBeUndefined();
    expect(invoice.overhead_mode).toBeUndefined();
    expect(invoice.overhead_value).toBeUndefined();
    expect(invoice.line_items[0].unit_cost).toBeUndefined();
    expect(invoice.line_items[0].markup_percent).toBeUndefined();
    expect(invoice.scopes[0].internal_cost).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. read Pricing is the door, not a second lock
// ════════════════════════════════════════════════════════════════════════════
describe('See financial data WITHOUT read Invoice is sufficient to see costs', () => {
  it('price-book search returns unit_cost', async () => {
    grantsWithPricingOnly('PriceBook');
    mockPrisma.priceBookItem.findMany.mockResolvedValue([priceBookSearchRow()]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=wire')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].unit_cost).toBe(2);
  });
});
