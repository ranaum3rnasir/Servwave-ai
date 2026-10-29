/**
 * LO-4 legacy retirement — restricted-tech angle (formerly "Inventory P3 van forcing").
 *
 * The four forward-deduction seams that the `location_restricted:Inventory` capability used to
 * force to the tech's van (job/invoice addLine, job/invoice sync, qty-INCREASE on a SYNCED line)
 * all RETIRED with LO-4: adding a line never deducts, the sync routes are parked (404), and a qty
 * edit on a legacy SYNCED line is FROZEN (400 LEGACY_STOCK_LINE) — the freeze fires before any van
 * check, so there is no VAN_RESTRICTED path left to assert. Logistic Orders own deduction now.
 *
 * The `location_restricted` capability rows stay in the schema (vestigial in v1; the van-balances
 * view still uses the my-van flag) but no line-write seam consults them. This suite now pins the
 * new behavior from the restricted-tech angle: a restricted tech still adds a plain NOT_TRACKED
 * billing line (zero movements), and the legacy freeze applies to them exactly as to anyone else.
 *
 * Harness: unchanged (supertest, prisma fully mocked, tx proxy over the stock delegates, grants
 * via mockAuthAs + override rows via userPermissionOverride.findMany).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  JOB_FIXTURE,
  INVOICE_FIXTURE,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// ─── Typed mock accessors ──────────────────────────────────
const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  jobLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  invoice: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  invoiceLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  priceBookItem: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  stockMovement: { create: ReturnType<typeof vi.fn> };
  stockBalance: {
    upsert: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;
const INVOICE_ID = INVOICE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const MAIN_ID = INVENTORY_LOCATION_FIXTURE.id;
const VAN_ID = 'aaaaaaa1-0000-0000-0000-000000000099';

// Toggled per test: whether the tech HAS a van (InventoryLocation.primary_tech_id = tech).
let techHasVan = true;

// Retired seams no longer resolve locations, but the my-van resolver + tenant check still route on
// `where`; keep the router so any residual lookup resolves deterministically.
function setupLocationLookup() {
  mockPrisma.inventoryLocation.findFirst.mockImplementation(({ where }: any) => {
    if (where?.primary_tech_id !== undefined) {
      return Promise.resolve(techHasVan ? { id: VAN_ID } : null);
    }
    if (where?.id === VAN_ID) return Promise.resolve({ id: VAN_ID });
    if (where?.id === MAIN_ID) return Promise.resolve({ id: MAIN_ID });
    return Promise.resolve(null);
  });
}

function existingJobLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    job_id: JOB_ID,
    sequence: 1,
    description: '12ga Wire (ft)',
    quantity: 2,
    unit_price: 4,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 8,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: TRACKED_ITEM_FIXTURE.id,
    stock_status: 'UNSYNCED',
    stock_location_id: null,
    ...over,
  };
}

function jobRow({ jobLineItems = [] as any[] } = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    source_plan_id: null,
    job_number: 'J00001',
    customer: { tax_exempt: false },
    assignees: [{ user_id: TEST_USERS.technician.id }],
    estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } },
    job_line_items: jobLineItems,
    invoices: [],
    scopes: null,
  };
}

function invoiceRow() {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status: 'DRAFT',
    kind: 'STANDARD',
    deposit_credit: 0,
    total_amount: 1080,
    amount_due: 1080,
    tax_rate: 0.08,
    discount_amount: 0,
    tip: 0,
    scopes: null,
    job_id: JOB_ID,
    customer: { tax_exempt: false },
    job: {
      assignees: [{ user_id: TEST_USERS.technician.id }],
      customer: { tax_exempt: false },
      estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } },
    },
  };
}

function invoiceLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    invoice_id: INVOICE_ID,
    sequence: 1,
    description: '12ga Wire (ft)',
    quantity: 2,
    unit_price: 4,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 8,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'MATERIAL',
    price_book_item_id: TRACKED_ITEM_FIXTURE.id,
    stock_status: 'UNSYNCED',
    stock_location_id: null,
    ...over,
  };
}

// invoiceDetailSelect-shaped object for the invoice response reads.
function invoiceDetailAfter() {
  return {
    ...invoiceRow(),
    subtotal: 8,
    line_items: [invoiceLine()],
    refunds: [],
    credits: [],
    customer: null,
    job: null,
    payments: [],
  };
}

// One tx proxy serving BOTH controllers (superset of the two P1 harnesses).
function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        job: { findUnique: mockPrisma.job.findUnique, update: mockPrisma.job.update },
        jobLineItem: {
          create: mockPrisma.jobLineItem.create,
          update: mockPrisma.jobLineItem.update,
          updateMany: mockPrisma.jobLineItem.updateMany,
          deleteMany: mockPrisma.jobLineItem.deleteMany,
        },
        invoice: {
          findUnique: mockPrisma.invoice.findUnique,
          findFirst: mockPrisma.invoice.findFirst,
          update: mockPrisma.invoice.update,
        },
        invoiceLineItem: {
          findMany: mockPrisma.invoiceLineItem.findMany,
          findFirst: mockPrisma.invoiceLineItem.findFirst,
          create: mockPrisma.invoiceLineItem.create,
          update: mockPrisma.invoiceLineItem.update,
          deleteMany: mockPrisma.invoiceLineItem.deleteMany,
        },
        priceBookItem: { findFirst: mockPrisma.priceBookItem.findFirst, findMany: mockPrisma.priceBookItem.findMany },
        stockMovement: { create: mockPrisma.stockMovement.create },
        stockBalance: {
          upsert: mockPrisma.stockBalance.upsert,
          updateMany: mockPrisma.stockBalance.updateMany,
          findUnique: mockPrisma.stockBalance.findUnique,
        },
        organization: { findUnique: mockPrisma.organization.findUnique },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

// The restricted fixture: role TECHNICIAN + allow-override rows. `update Job` /
// `manage_lines`+`update Invoice` open the line routes (per-user-granted paths);
// `location_restricted Inventory` is the (now vestigial) P3 restriction toggle.
const RESTRICTED_OVERRIDES = [
  { action: 'update', subject: 'Job', effect: 'allow' },
  { action: 'manage_lines', subject: 'Invoice', effect: 'allow' },
  { action: 'update', subject: 'Invoice', effect: 'allow' },
  { action: 'location_restricted', subject: 'Inventory', effect: 'allow' },
];

function mockTech(overrides: { action: string; subject: string; effect: string }[]) {
  mockAuthAs('technician');
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue(overrides);
  // canAccessRow(Job/Invoice) — conditional read scope does a real scoped findFirst.
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  techHasVan = true;
  setupTransaction();
  setupLocationLookup();
  mockTech(RESTRICTED_OVERRIDES);
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow());
  mockPrisma.invoice.update.mockResolvedValue(invoiceDetailAfter());
  mockPrisma.invoiceLineItem.findMany.mockResolvedValue([invoiceLine()]);
  mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(invoiceLine());
  mockPrisma.invoiceLineItem.create.mockResolvedValue(invoiceLine({ id: 'ili-p3-1' }));
  mockPrisma.invoiceLineItem.update.mockResolvedValue(invoiceLine());
  mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
  mockPrisma.priceBookItem.findFirst.mockResolvedValue(TRACKED_ITEM_FIXTURE);
  mockPrisma.jobLineItem.create.mockResolvedValue(existingJobLine({ id: 'jli-p3-1', stock_status: 'NOT_TRACKED', stock_location_id: null }));
  mockPrisma.jobLineItem.update.mockResolvedValue(existingJobLine());
  mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 5, min: null });
  mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 5, min: null });
  mockPrisma.stockMovement.create.mockResolvedValue({});
});

const trackedAdd = {
  description: '12ga Wire (ft)', quantity: 3, unit_price: 4, item_type: 'MATERIAL',
  price_book_item_id: TRACKED_ITEM_FIXTURE.id,
};

// ════════════════════════════════════════════════════════════════════════════
// addLine — van forcing retired: a restricted tech adds a plain NOT_TRACKED line
// ════════════════════════════════════════════════════════════════════════════
describe('addLine — restricted tech, van forcing retired', () => {
  it('job addLine with an explicit (formerly forbidden) location → 201 NOT_TRACKED, zero movements', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'))
      .send({ ...trackedAdd, stock_location_id: MAIN_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_location_id).toBeNull();
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
    // No VAN_RESTRICTED 403 anymore — the location is silently stripped and nothing deducts.
    expect(res.body).not.toHaveProperty('van_location_id');
  });

  it('invoice addLine with an explicit location → 200 NOT_TRACKED, zero movements', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`).set(authHeader('technician'))
      .send({ ...trackedAdd, stock_location_id: MAIN_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoiceLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('restricted tech with NO van still adds a plain line → 201 NOT_TRACKED', async () => {
    techHasVan = false;

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'))
      .send(trackedAdd);

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('non-restricted tech (no location_restricted row) adds a plain line → 201 NOT_TRACKED', async () => {
    mockTech(RESTRICTED_OVERRIDES.filter((o) => o.action !== 'location_restricted'));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items`).set(authHeader('technician'))
      .send(trackedAdd);

    expect(res.status).toBe(201);
    expect(mockPrisma.jobLineItem.create.mock.calls[0][0].data.stock_status).toBe('NOT_TRACKED');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// qty-delta — the freeze fires before any van check (no VAN_RESTRICTED path left)
// ════════════════════════════════════════════════════════════════════════════
describe('qty-delta on a legacy SYNCED line — restricted tech sees the freeze, not VAN_RESTRICTED', () => {
  it('job qty INCREASE on a Main-synced line → 400 LEGACY_STOCK_LINE (not 403), no movement', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [existingJobLine({ quantity: 3, stock_status: 'SYNCED', stock_location_id: MAIN_ID })] }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'LEGACY_STOCK_LINE', reason: 'qty_frozen' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('job qty DECREASE (former "return, allowed") on a Main-synced line → 400 (return path retired too)', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(
      jobRow({ jobLineItems: [existingJobLine({ quantity: 5, stock_status: 'SYNCED', stock_location_id: MAIN_ID })] }),
    );

    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_STOCK_LINE');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('invoice qty INCREASE on a Main-synced line → 400 LEGACY_STOCK_LINE, no movement', async () => {
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(
      invoiceLine({ quantity: 3, stock_status: 'SYNCED', stock_location_id: MAIN_ID }),
    );

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('technician'))
      .send({ quantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_STOCK_LINE');
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// sync-stock — parked for everyone, restricted tech included
// ════════════════════════════════════════════════════════════════════════════
describe('sync-stock — parked (404) for a restricted tech', () => {
  it('job single sync → 404 FEATURE_DISABLED', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(jobRow({ jobLineItems: [existingJobLine()] }));

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/line-items/${LINE_ID}/sync-stock`)
      .set(authHeader('technician'))
      .send({ location_id: VAN_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'line_stock_sync' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('invoice bulk sync → 404 FEATURE_DISABLED', async () => {
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items/sync-stock`)
      .set(authHeader('technician'))
      .send({ location_id: VAN_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'line_stock_sync' });
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});
