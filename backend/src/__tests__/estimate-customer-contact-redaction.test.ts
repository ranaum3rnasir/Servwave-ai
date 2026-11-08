/**
 * #1997 — coverage for the enumerated detail-shaped response sites the frozen
 * `repro-1997.test.ts` does NOT itself exercise: `estimate.controller.ts`'s `setStatus` (a BARE
 * site — no `stripEstimateCost` call at all) and `revise`, `estimate-lines.controller.ts`'s
 * `addLine`, the cross-controller `copyToInvoice`, `invoice-lines.controller.ts`'s `addLine`, and
 * two nuances the frozen suite's own five cases do not touch: `getById`'s tag-merge (`{
 * ...presented, tags }`) surviving redaction, and an invoice's `job.customer` anchor (the frozen
 * suite only exercises the top-level `customer`).
 *
 * `repro-1997.test.ts` already pins `GET /api/estimates/:id` (both anchors), `POST
 * /api/estimates/:id/duplicate`, the public estimate guard and `GET /api/invoices/:id` — not
 * repeated here.
 *
 * Mirrors `repro-1997.test.ts` / `customer-duplicate-redaction.test.ts`'s `mockDeniedCustomerRead`
 * — a conditioned `read Customer` grant built from real `DEFAULT_GRANTS`, never a bare CASL
 * literal — own local copy per that file's own convention.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE, CUSTOMER_FIXTURE, LEAD_FIXTURE } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

/** See repro-1997.test.ts for the full rationale — own local copy, not a shared import. */
function mockDeniedCustomerRead(role: string, deniedCustomerId: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + deniedCustomerId } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

const CONTACT_KEYS = [
  'email', 'phone',
  'billing_address_line1', 'billing_address_line2', 'billing_city', 'billing_state', 'billing_zip',
];

function expectContactAbsent(customer: Record<string, unknown>) {
  expect(customer).toBeTruthy();
  for (const key of CONTACT_KEYS) {
    expect(key in customer, `customer.${key} must not be present`).toBe(false);
  }
  expect(customer.first_name).toBeDefined();
}

function expectContactPresent(customer: Record<string, unknown>) {
  expect(customer.email).toBeDefined();
  expect(customer.phone).toBeDefined();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// estimate-lines.controller.ts::addLine — the estimate-lines site (all 8 share recomputeAndPersist)
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('POST /api/estimates/:id/line-items — customer redaction (#1997)', () => {
  function guardRow(overrides: Record<string, unknown> = {}) {
    return {
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      version: 1,
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      subtotal: 1000,
      tax_amount: 62.5,
      total_amount: 1062.5,
      discount_amount: 0,
      scopes: null,
      organization: { lock_on_send: false },
      invoices: [],
      line_items: [],
      ...overrides,
    };
  }

  function setupTransaction() {
    mockPrisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)({
          estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
          estimateLineItem: {
            findMany: mockPrisma.estimateLineItem.findMany,
            create: mockPrisma.estimateLineItem.create,
          },
        });
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
  }

  beforeEach(() => {
    setupTransaction();
    mockPrisma.estimateLineItem.create.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
  });

  it('RED then fixed — a SALES requester denied Customer read on the lead-anchored customer gets no contact block on the response', async () => {
    mockAuthAs('sales'); // owns via lead_assignees, matching ESTIMATE_FIXTURE.lead
    mockDeniedCustomerRead('SALES', CUSTOMER_FIXTURE.id);
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
    // canAccessRow's per-row owner check on the (conditioned) read-Estimate scope.
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, id: ESTIMATE_FIXTURE.id, line_items: [], scopes: null });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'Extra part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(201);
    expectContactAbsent(res.body.estimate.lead.customer);
  });

  it('green control: ADMIN (unconditional read Customer) still gets the full block', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow());
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, id: ESTIMATE_FIXTURE.id, line_items: [], scopes: null });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(201);
    expectContactPresent(res.body.estimate.lead.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// estimate.controller.ts::setStatus — a BARE site (no stripEstimateCost call at all today)
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/estimates/:id/status — customer redaction (#1997, BARE site)', () => {
  function mockExisting(overrides: Record<string, unknown> = {}) {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'SENT',
      estimate_number: ESTIMATE_FIXTURE.estimate_number,
      created_by: TEST_USERS.sales.id,
      lead_id: LEAD_FIXTURE.id,
      public_token: 'live-token',
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }], commission_owner_id: null, status: 'ESTIMATED' },
      job: null,
      invoices: [],
      ...overrides,
    });
  }

  function mockStatusTransaction(result: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue(result) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  }

  it('RED then fixed — setStatus is BARE (projectEstimateLeadWalkthrough only) yet still redacts for a denied SALES requester', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES', CUSTOMER_FIXTURE.id);
    mockExisting();
    mockStatusTransaction({ ...ESTIMATE_FIXTURE, id: ESTIMATE_FIXTURE.id, status: 'PENDING' });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}/status`)
      .set(authHeader('sales'))
      .send({ status: 'PENDING' });

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.lead.customer);
  });

  it('green control: ADMIN still gets the full block on the same BARE site', async () => {
    mockAuthAs('admin');
    mockExisting();
    mockStatusTransaction({ ...ESTIMATE_FIXTURE, id: ESTIMATE_FIXTURE.id, status: 'PENDING' });

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}/status`)
      .set(authHeader('admin'))
      .send({ status: 'PENDING' });

    expect(res.status).toBe(200);
    expectContactPresent(res.body.estimate.lead.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// estimate.controller.ts::revise
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('POST /api/estimates/:id/revise — customer redaction (#1997)', () => {
  const REVISE_SOURCE = {
    id: ESTIMATE_FIXTURE.id,
    status: 'SENT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    lead_id: LEAD_FIXTURE.id,
    organization_id: TEST_USERS.sales.organization_id,
    customer_id: null,
    service_location_id: null,
    created_by: TEST_USERS.sales.id,
    name: null,
    scope_name: null,
    scope_notes: 'Scope',
    scopes: null,
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    discount_amount: 0,
    deposit_type: null,
    deposit_value: null,
    subtotal: 1000,
    tax_amount: 62.5,
    total_amount: 1062.5,
    line_items: [],
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
  };

  function mockReviseTransaction(newEstimate: unknown) {
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { create: vi.fn().mockResolvedValue(newEstimate), update: vi.fn().mockResolvedValue({}) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  }

  it('RED then fixed — a denied SALES requester gets no contact block on the revised clone', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES', CUSTOMER_FIXTURE.id);
    mockPrisma.estimate.findUnique.mockResolvedValue(REVISE_SOURCE);
    mockReviseTransaction({ ...ESTIMATE_FIXTURE, id: 'new-est-1', status: 'DRAFT' });

    const res = await request(app).post(`/api/estimates/${ESTIMATE_FIXTURE.id}/revise`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.lead.customer);
  });

  it('green control: ADMIN still gets the full block on the revised clone', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(REVISE_SOURCE);
    mockReviseTransaction({ ...ESTIMATE_FIXTURE, id: 'new-est-1', status: 'DRAFT' });

    const res = await request(app).post(`/api/estimates/${ESTIMATE_FIXTURE.id}/revise`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectContactPresent(res.body.estimate.lead.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// estimate.controller.ts::copyToInvoice — the invoice-shaped cross-controller site
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('POST /api/estimates/:id/copy-to-invoice — customer redaction (#1997)', () => {
  function copyToInvoiceEstimate(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ce000000-0000-0000-0000-000000000099',
      job: null,
      job_id: null,
      job_link: null,
      tax_rate: 0.0625,
      discount_amount: 0,
      labor_hours: null,
      overhead_mode: null,
      overhead_value: null,
      scopes: null,
      customer_id: null,
      customer: null,
      lead: { customer_id: CUSTOMER_FIXTURE.id, customer: { payment_type: null } },
      line_items: [
        { sequence: 1, description: 'AC Unit', quantity: 1, unit_price: 1000, is_taxable: true, line_total: 1000, discount_type: null, discount_value: null, discount_amount: 0, markup_percent: null, unit_cost: null, item_type: 'SERVICE', price_book_item_id: null },
      ],
      ...overrides,
    };
  }

  function copyToInvoiceTx(createdInvoice: Record<string, unknown>) {
    return {
      estimate: {
        findUnique: async () => ({ job: null, job_id: null, job_link: null }),
      },
      invoice: {
        findFirst: async () => null,
        create: () => createdInvoice,
      },
      timelineEvent: { create: async () => ({}) },
    };
  }

  beforeEach(() => {
    // copyToInvoice is role-gated to ADMIN/DISPATCHER only — DISPATCHER is the vehicle for the
    // denied case (unlike SALES, its default `manage_lines`/`read Customer` grants are the ones
    // DENIED_READ_CUSTOMER swaps out, and it clears the ADMIN/DISPATCHER-only route gate).
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
  });

  it('RED then fixed — a denied DISPATCHER requester gets no contact block on the created invoice', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_FIXTURE.id);
    const estimate = copyToInvoiceEstimate();
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const createdInvoice = {
      id: 'new-invoice-1',
      invoice_number: 'I00099',
      customer_id: CUSTOMER_FIXTURE.id,
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC', email: 'john@doe.com', phone: '5551234567', payment_type: null, tax_exempt: false },
    };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(copyToInvoiceTx(createdInvoice)));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(201);
    expectContactAbsent(res.body.invoice.customer);
  });

  it('green control: DISPATCHER with unconditional read Customer still gets the full block', async () => {
    mockAuthAs('dispatcher');
    const estimate = copyToInvoiceEstimate();
    mockPrisma.estimate.findUnique.mockResolvedValue(estimate);
    const createdInvoice = {
      id: 'new-invoice-2',
      invoice_number: 'I00098',
      customer_id: CUSTOMER_FIXTURE.id,
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC', email: 'john@doe.com', phone: '5551234567', payment_type: null, tax_exempt: false },
    };
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(copyToInvoiceTx(createdInvoice)));

    const res = await request(app)
      .post(`/api/estimates/${estimate.id}/copy-to-invoice`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(201);
    expectContactPresent(res.body.invoice.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// invoice-lines.controller.ts::addLine — the invoice-lines site (all 11 share this response shape)
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('POST /api/invoices/:id/line-items — customer redaction (#1997)', () => {
  const INVOICE_ID = 'i0000000-0000-0000-0000-000000000099';

  function invoiceGuardRow(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I00099',
      status: 'DRAFT',
      sent_at: null,
      kind: 'STANDARD',
      job_id: null,
      deposit_credit: 0,
      total_amount: 1000,
      amount_due: 1000,
      tax_rate: 0.0625,
      discount_amount: 0,
      tip: 0,
      scopes: null,
      credits: [],
      customer: { tax_exempt: false },
      job: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      ...overrides,
    };
  }

  function setupTransaction() {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        invoiceLineItem: {
          findMany: mockPrisma.invoiceLineItem.findMany,
          create: mockPrisma.invoiceLineItem.create,
        },
        invoice: {
          findUnique: mockPrisma.invoice.findUnique,
          update: mockPrisma.invoice.update,
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        priceBookItem: { findFirst: vi.fn().mockResolvedValue(null) },
      }),
    );
  }

  beforeEach(() => {
    setupTransaction();
    mockPrisma.priceBookItem.findFirst.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({ block_negative_stock: false, default_inventory_location_id: null });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);
    mockPrisma.invoiceLineItem.create.mockResolvedValue({ id: 'new-line' });
  });

  function detailAfter(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I00099',
      status: 'DRAFT',
      kind: 'STANDARD',
      tip: 0,
      subtotal: 1000,
      discount_amount: 0,
      tax_rate: 0.0625,
      tax_amount: 62.5,
      deposit_credit: 0,
      total_amount: 1062.5,
      amount_due: 1062.5,
      line_items: [],
      refunds: [],
      credits: [],
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        email: 'john@doe.com',
        phone: '5551234567',
        payment_type: null,
        tax_exempt: false,
      },
      job: null,
      payments: [],
      ...overrides,
    };
  }

  it('RED then fixed — a SALES requester (OWN_INVOICE_VIA_LEAD) denied Customer read gets no contact block', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES', CUSTOMER_FIXTURE.id);
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceGuardRow({ job: { estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } } }));
    // canAccessRow's per-row owner check on the (conditioned) read-Invoice scope.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID });
    mockPrisma.invoice.update.mockResolvedValue(detailAfter());

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('sales'))
      .send({ description: 'Extra part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.invoice.customer);
  });

  it('green control: ADMIN still gets the full block', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(invoiceGuardRow());
    mockPrisma.invoice.update.mockResolvedValue(detailAfter());

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(200);
    expectContactPresent(res.body.invoice.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// getById tag-merge nuance: `{ ...presented, tags }` — the presenter must be the LAST transform
// applied to that merged object, not to `presented` alone (or `tags` would ride outside it and
// the redaction would still have run — but proving the merge shape stays correct matters because
// a future edit could easily wrap `presented` before the spread and silently skip this site).
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/estimates/:id — tag-merge survives redaction (#1997)', () => {
  it('a denied SALES requester gets no contact block AND the tags array is still present', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES', CUSTOMER_FIXTURE.id);
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      lead: { ...ESTIMATE_FIXTURE.lead, lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.lead.customer);
    expect(res.body.estimate.tags).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// invoice getById — the job.customer anchor (frozen suite only exercises the top-level customer)
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/invoices/:id — job.customer anchor (#1997)', () => {
  const INVOICE_ID = 'i0000000-0000-0000-0000-000000000098';

  function jobAnchoredInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I00098',
      status: 'DRAFT',
      sent_at: null,
      customer_id: null,
      customer: null,
      job: {
        id: 'job-1',
        job_number: 'J00042',
        assignees: [{ user_id: TEST_USERS.technician.id }],
        customer: {
          id: CUSTOMER_FIXTURE.id,
          first_name: 'John',
          last_name: 'Doe',
          company_name: 'Doe HVAC',
          email: 'john@doe.com',
          phone: '5551234567',
          payment_type: null,
          tax_exempt: false,
        },
      },
      line_items: [],
      refunds: [],
      credits: [],
      ...overrides,
    };
  }

  it('RED then fixed — a DISPATCHER denied Customer read gets no contact block on job.customer (frozen suite only covers the top-level customer anchor)', async () => {
    mockAuthAs('dispatcher'); // unconditional read Invoice — isolates the Customer-read decision
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_FIXTURE.id);
    mockPrisma.invoice.findUnique.mockResolvedValue(jobAnchoredInvoice());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.invoice.job.customer);
    expect(res.body.invoice.job.job_number).toBe('J00042'); // sibling job field survives
  });

  it('green control: DISPATCHER with unconditional read Customer still gets the full block on job.customer', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue(jobAnchoredInvoice());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expectContactPresent(res.body.invoice.job.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// AC9 — TECHNICIAN, the one DEFAULT role this changes in production. defaultGrants.ts grants
// TECHNICIAN `read Estimate` (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR) and there is NO `read Customer`
// row for TECHNICIAN anywhere in the defaults — so a technician reading their own lead-less
// estimate must be redacted WITHOUT any conditioned-grant setup at all (the ability simply never
// grants `read Customer`, unconditionally or otherwise).
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/estimates/:id — TECHNICIAN, no read Customer grant at all (#1997 AC9)', () => {
  it('a technician reading their own (creator-owned) lead-less estimate gets no contact block', async () => {
    mockAuthAs('technician');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      ...ESTIMATE_FIXTURE,
      id: ESTIMATE_FIXTURE.id,
      lead_id: null,
      lead: null,
      customer_id: CUSTOMER_FIXTURE.id,
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        email: 'john@doe.com',
        phone: '5551234567',
        billing_address_line1: '900 Oak Ave',
        billing_address_line2: null,
        billing_city: 'Round Rock',
        billing_state: 'TX',
        billing_zip: '78664',
      },
      created_by: TEST_USERS.technician.id, // R6/D19 — lead-less own-scope signal is the creator
    });
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #2041 findings 1/6 — the SIBLING top-level `service_location` (the R6 direct anchor,
// denormalized alongside `customer`) is the SAME customer's street address one key over. A
// requester whose `customer` block came back contact-stripped must not still receive it there.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('GET /api/estimates/:id — the sibling service_location is redacted too (#2041 findings 1/6)', () => {
  function estimateWithServiceLocation(overrides: Record<string, unknown> = {}) {
    return {
      ...ESTIMATE_FIXTURE,
      id: ESTIMATE_FIXTURE.id,
      lead_id: null,
      lead: null,
      customer_id: CUSTOMER_FIXTURE.id,
      customer: {
        id: CUSTOMER_FIXTURE.id,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        email: 'john@doe.com',
        phone: '5551234567',
      },
      service_location: {
        address_line1: '1600 Victim Lane',
        address_line2: 'Apt 4',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      },
      created_by: TEST_USERS.technician.id, // R6/D19 — lead-less own-scope signal is the creator
      ...overrides,
    };
  }

  it('RED then fixed — TECHNICIAN (no read Customer at all) gets no address on the sibling service_location, not just the customer block', async () => {
    mockAuthAs('technician');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateWithServiceLocation());
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.customer);
    const location = res.body.estimate.service_location as Record<string, unknown>;
    expect(location).toBeTruthy();
    for (const key of ['address_line1', 'address_line2', 'city', 'state', 'zip']) {
      expect(key in location, `service_location.${key} must not be present`).toBe(false);
    }
  });

  it('green control: ADMIN (unconditional read Customer) still gets the full service_location', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(estimateWithServiceLocation());
    mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.service_location.address_line1).toBe('1600 Victim Lane');
    expect(res.body.estimate.service_location.city).toBe('Austin');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /api/estimates/:id/public — the token-gated payload carries display names only
// ═══════════════════════════════════════════════════════════════════════════════════════════
/**
 * #1997 × #2028 — the public estimate page is UNAUTHENTICATED (token-gated), so there is no
 * requester for `presentEstimateDetail` to judge and the redaction cannot run there. Its safety
 * comes entirely from the PROJECTION: `estimatePublicSelect` must never select the customer's
 * contact columns in the first place — the same rule `invoice.controller.ts::getPublic` states as
 * "F-55: email/phone withheld from the public (token) payload — display name only".
 *
 * #2028 made every document surface spread the shared `estimateDocumentSelect`, which DOES carry
 * `email`/`phone`/`service_locations` (the PDF's Bill To block needs them, and `getPublicPdf`
 * runs its own query off that projection). The public JSON must override them back out.
 *
 * Asserted on the SELECT ARGS, not on the response body: `setup.ts` mocks Prisma wholesale, so a
 * widened `select` is invisible to any assertion that reads a hand-written `mockResolvedValue`.
 */
describe('GET /api/estimates/:id/public — projection carries no customer contact (#1997 × #2028)', () => {
  const PUBLIC_ID = 'pub-est-1';

  function selectArg(): Record<string, any> {
    const call = mockPrisma.estimate.findFirst.mock.calls[0];
    expect(call, 'estimate.findFirst was never called').toBeTruthy();
    return call[0].select;
  }

  beforeEach(() => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: PUBLIC_ID,
      estimate_number: 'E00900',
      status: 'SENT',
      organization_id: ESTIMATE_FIXTURE.organization_id,
      valid_until: null,
      snapshot_terms: null,
      lead: null,
      customer: { first_name: 'Nora', last_name: 'Vance', company_name: 'Vance Plumbing' },
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Acme Org', logo_url: null, brand_color: '#0C2D3A',
      email: 'org@acme.com', phone: null, website: null, estimate_terms: '',
    });
  });

  it('never selects email/phone/service_locations on either customer anchor', async () => {
    const res = await request(app).get(`/api/estimates/${PUBLIC_ID}/public?token=tok`);
    expect(res.status).toBe(200);

    const select = selectArg();
    const direct = select.customer.select;
    const nested = select.lead.select.customer.select;
    for (const anchor of [direct, nested]) {
      expect('email' in anchor, 'public select must not carry customer.email').toBe(false);
      expect('phone' in anchor, 'public select must not carry customer.phone').toBe(false);
      expect('service_locations' in anchor, 'public select must not carry the customer address').toBe(false);
    }
    // Sanity: the anchors are still projected at all, so a select that silently lost its
    // customer does not read as "no contact leaked".
    expect(direct.first_name).toBe(true);
    expect(nested.first_name).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /api/estimates/:id/versions/:version — the FROZEN document is a detail-shaped response
// ═══════════════════════════════════════════════════════════════════════════════════════════
/**
 * #1997 × #2030 — a version snapshot froze the whole customer row (`buildVersionSnapshotDocument`
 * mints off `estimateDocumentSelect`, which carries `email`/`phone`), and `getVersion` served it
 * back behind nothing but `canDo('read','Estimate')` + the per-row `canAccessEstimate` gate. That
 * is exactly the premise #1997 rejects: clearing the ESTIMATE row gate says nothing about whether
 * this requester may read that CUSTOMER.
 *
 * The source-scanning guard could not see it — the payload key is `version:`, not `estimate:`.
 *
 * The verdict is taken on the LIVE customer row, never on the frozen copy: the frozen one carries
 * no `id` (the document projection never selected one), so `isCustomerReadable` would fail closed
 * for every requester, and a scope granted since the send would still be answered from a row
 * frozen years ago.
 */
describe('GET /api/estimates/:id/versions/:version — frozen customer contact (#1997 × #2030)', () => {
  const EST_ID = ESTIMATE_FIXTURE.id;

  function mockVersionRead() {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: EST_ID,
      estimate_number: 'E00042',
      organization_id: ESTIMATE_FIXTURE.organization_id,
      created_by: TEST_USERS.admin.id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'Jane', last_name: 'Doe' },
    });
    mockPrisma.estimateVersionSnapshot.findFirst.mockResolvedValue({
      id: 'ver-1',
      version: 1,
      trigger: 'SEND',
      sent_at: new Date('2026-09-01T00:00:00Z'),
      total_amount: 2200,
      document: {
        view: { rows: [], totals: [] },
        org: { name: 'Acme' },
        templateKey: 'alpha-classic',
        // Frozen verbatim off estimateDocumentSelect — contact included, no `id`.
        customer: {
          first_name: 'Jane', last_name: 'Doe', company_name: null,
          email: 'jane@example.com', phone: '5551234567',
        },
        serviceLocation: null,
        photoPaths: [],
      },
    });
  }

  it('withholds the frozen contact block from a requester who cannot read that customer', async () => {
    mockAuthAs('sales');
    mockVersionRead();
    mockDeniedCustomerRead('SALES', CUSTOMER_FIXTURE.id);

    const res = await request(app)
      .get(`/api/estimates/${EST_ID}/versions/1`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.version.document.customer);
  });

  it('still serves it to a requester who can read that customer', async () => {
    mockAuthAs('admin');
    mockVersionRead();

    const res = await request(app)
      .get(`/api/estimates/${EST_ID}/versions/1`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectContactPresent(res.body.version.document.customer);
  });
});
