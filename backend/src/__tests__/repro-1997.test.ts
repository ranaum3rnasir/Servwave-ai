/**
 * #1997 — the estimate detail projection exposes a customer's email, phone and billing address
 * regardless of the requester's Customer read scope.
 *
 * `estimateDetailSelect` (estimate.controller.ts:89-...) unconditionally selects `email`, `phone`
 * and every `billing_*` key on both the direct `customer` anchor (:147-164) and the nested
 * `lead.customer` (:194-220). Every detail-shaped handler that uses this select — `getById`,
 * `duplicate`, revisions, etc. — ships the leak, and there is NO post-projection check anywhere
 * against the requester's Customer read scope (`grep -rn redactCustomerContactFor` returns
 * nothing in this repo today). `invoiceDetailSelect` (invoice.controller.ts:246-...) carries the
 * same class of leak (email/phone only, no billing_* — Invoice/Customer projects no billing
 * fields there) on both `customer` and `job.customer`.
 *
 * Mechanism for "the requester cannot read this customer row" — mirrors
 * `customer-duplicate-redaction.test.ts` / `repro-1996.test.ts`'s `mockDeniedCustomerRead`: a
 * conditioned `read Customer` grant is built from REAL `DEFAULT_GRANTS` (SALES's default is
 * unconditional `read Customer`, defaultGrants.ts:96) with that one row swapped for a version
 * conditioned on an `id` that is NOT the estimate's customer — the requester holds the grant
 * (so an unrelated route-level `canDo('read','Customer')` guard, if any, still passes) but is
 * denied per-row on THIS customer, exactly the shape `can()` (enforce.ts:44) already evaluates
 * for Lead/Job/Estimate today. Acceptance criterion 5 ("ability built from real grants with a
 * conditioned Customer read, not only mockAuthAs") is satisfied by this helper, not by a bare
 * CASL rule literal.
 *
 * Every case is on SALES's `OWN_ESTIMATE_VIA_LEAD_OR_CREATOR` read (F-004): case 1 exercises the
 * lead-less/creator branch (direct `customer` anchor), case 2 the own-via-lead branch (nested
 * `lead.customer`), case 3 the `duplicate()` response (a second detail-shaped call site,
 * `estimateDetailSelect` verbatim). Case 4 is the unconditional-reader control (ADMIN — must not
 * regress). Case 5 is the public-page guard (`estimatePublicSelect` is already clean — no
 * email/phone/billing_* keys exist in that select at all). Case 6 is the invoice-detail parity
 * case, cheapened by using DISPATCHER (unconditional `read Invoice`, so `canAccessRow` short-
 * circuits without a `findFirst` query) with `read Customer` denied the same way.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

/**
 * Re-mock `role`'s grants as DEFAULT_GRANTS with its `read Customer` row swapped for one
 * conditioned on an `id` that is NOT `deniedCustomerId` — the requester holds `read Customer`
 * (unconditional route guards still pass) but is denied per-row on THIS customer. Call AFTER
 * `mockAuthAs`, which installs the unmodified defaults. Mirrors
 * customer-duplicate-redaction.test.ts's `mockDeniedCustomerRead` / repro-1996.test.ts's helper
 * of the same name (own local copy — this file's contract does not depend on importing from
 * either #1996 suite).
 */
function mockDeniedCustomerRead(role: string, deniedCustomerId: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + deniedCustomerId } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────
const CUSTOMER_ID = 'c1997000-0000-0000-0000-000000000001';
const LEAD_CUSTOMER_ID = 'c1997000-0000-0000-0000-000000000002';
const LEAD_ID = 'e1997000-0000-0000-0000-000000000001';
const ESTIMATE_ID_DIRECT = 'f1997000-0000-0000-0000-000000000001';
const ESTIMATE_ID_LEAD = 'f1997000-0000-0000-0000-000000000002';
const ESTIMATE_ID_SOURCE = 'f1997000-0000-0000-0000-000000000003';
const ESTIMATE_ID_NEW = 'f1997000-0000-0000-0000-000000000004';
const INVOICE_ID = 'i1997000-0000-0000-0000-000000000001';

// Every key the issue's ACs say must be ABSENT once the requester cannot read the customer.
const CONTACT_KEYS = [
  'email', 'phone',
  'billing_address_line1', 'billing_address_line2', 'billing_city', 'billing_state', 'billing_zip',
];

function customerWithContact(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    first_name: 'QA1997',
    last_name: 'Customer',
    company_name: null,
    email: 'qa-1997-customer@example.com',
    phone: '5555501997',
    billing_address_line1: '1997 Fixture Ave',
    billing_address_line2: 'Suite 1997',
    billing_city: 'Fixtureville',
    billing_state: 'CA',
    billing_zip: '94997',
    ...overrides,
  };
}

function expectContactAbsent(customer: Record<string, unknown>, expectedId: string) {
  expect(customer).toBeTruthy();
  for (const key of CONTACT_KEYS) {
    expect(key in customer, `customer.${key} must not be present when the requester cannot read this customer`).toBe(false);
  }
  // Names/id are what let the estimate still render.
  expect(customer.id).toBe(expectedId);
  expect(customer.first_name).toBeDefined();
  expect(customer.last_name).toBeDefined();
}

function expectContactPresent(customer: Record<string, unknown>) {
  expect(customer.email).toBeDefined();
  expect(customer.phone).toBeDefined();
}

// The estimate.controller.ts getById/duplicate response shape — only the fields those handlers'
// post-processing (canAccessEstimate / projectEstimateLeadWalkthrough / resolveEstimatePhotoUrls /
// stripEstimateCost) or this file's assertions touch. Everything else is untouched by a mocked
// Prisma client, so it does not need to be present.
function directAnchorEstimate(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID_DIRECT,
    lead_id: null,
    customer_id: CUSTOMER_ID,
    job_id: null,
    job: null,
    job_link: null,
    estimate_number: 'E01997',
    status: 'DRAFT',
    created_by: TEST_USERS.sales.id,
    customer: customerWithContact(),
    lead: null,
    line_items: [],
    scope_photos: [],
    invoices: [],
    creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
    ...overrides,
  };
}

function leadAnchorEstimate(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID_LEAD,
    lead_id: LEAD_ID,
    customer_id: null,
    job_id: null,
    job: null,
    job_link: null,
    estimate_number: 'E01998',
    status: 'DRAFT',
    // Own-via-lead branch: created_by is deliberately someone else so `canAccessEstimate`'s
    // ownership signal is provably coming from `lead.lead_assignees`, not the creator fallback.
    created_by: TEST_USERS.dispatcher.id,
    customer: null,
    lead: {
      id: LEAD_ID,
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      customer: customerWithContact({
        id: LEAD_CUSTOMER_ID,
        last_name: 'LeadCustomer',
        email: 'qa-1997-leadcustomer@example.com',
        phone: '5555501998',
      }),
    },
    line_items: [],
    scope_photos: [],
    invoices: [],
    creator: { id: TEST_USERS.dispatcher.id, first_name: 'Test', last_name: 'Dispatcher' },
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (1) GET /api/estimates/:id — direct `customer` anchor, creator branch
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 (1) GET /api/estimates/:id — direct customer anchor', () => {
  it('RED — a requester whose Customer read scope excludes this customer still gets the full contact block today; desired: absent', async () => {
    mockAuthAs('sales'); // OWN_ESTIMATE_VIA_LEAD_OR_CREATOR — creator branch (lead_id: null)
    mockDeniedCustomerRead('SALES', CUSTOMER_ID);
    mockPrisma.estimate.findUnique.mockResolvedValue(directAnchorEstimate());

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_DIRECT}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.customer, CUSTOMER_ID);
  });

  it('green control: ADMIN (unconditional read Customer) gets the full block — must not regress', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(directAnchorEstimate({ created_by: TEST_USERS.admin.id }));

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_DIRECT}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectContactPresent(res.body.estimate.customer);
    expect(res.body.estimate.customer.billing_address_line1).toBe('1997 Fixture Ave');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (2) GET /api/estimates/:id — nested `lead.customer`, own-via-lead branch
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 (2) GET /api/estimates/:id — lead.customer anchor', () => {
  it('RED — a requester whose Customer read scope excludes lead.customer still gets the full contact block today; desired: absent', async () => {
    mockAuthAs('sales'); // owns the lead via lead_assignees, not the creator
    mockDeniedCustomerRead('SALES', LEAD_CUSTOMER_ID);
    mockPrisma.estimate.findUnique.mockResolvedValue(leadAnchorEstimate());

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_LEAD}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expectContactAbsent(res.body.estimate.lead.customer, LEAD_CUSTOMER_ID);
  });

  it('green control: ADMIN (unconditional read Customer) gets the full block on lead.customer too', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(leadAnchorEstimate());

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_LEAD}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectContactPresent(res.body.estimate.lead.customer);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (3) POST /api/estimates/:id/duplicate — second detail-shaped call site (estimateDetailSelect
//     verbatim, estimate.controller.ts:3879)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 (3) POST /api/estimates/:id/duplicate — response carries the same leak', () => {
  it('RED — a requester whose Customer read scope excludes this customer still gets the full contact block on the duplicate response today; desired: absent', async () => {
    mockAuthAs('sales');
    mockDeniedCustomerRead('SALES', CUSTOMER_ID);
    // The lighter read `duplicate()` performs on the SOURCE estimate before cloning it —
    // lead-less/creator branch, mirrors estimates.test.ts's duplicate() fixture shape.
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: null,
      customer_id: CUSTOMER_ID,
      service_location_id: null,
      created_by: TEST_USERS.sales.id,
      scope_notes: 'qa-1997 probe',
      scopes: null,
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      customer: { tax_exempt: false },
      lead: null,
      line_items: [],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ estimate: { create: vi.fn().mockResolvedValue(directAnchorEstimate({ id: ESTIMATE_ID_NEW, estimate_number: 'E01999' })) } }),
    );

    const res = await request(app).post(`/api/estimates/${ESTIMATE_ID_SOURCE}/duplicate`).set(authHeader('sales'));

    expect(res.status).toBe(201);
    expectContactAbsent(res.body.estimate.customer, CUSTOMER_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (4) GET /api/estimates/:id/public — control: already clean, must stay clean
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 (4) GET /api/estimates/:id/public — no auth, always clean (guard)', () => {
  it('green control: neither `customer` nor `lead.customer` ever carries email/phone/billing_* keys', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_ID_DIRECT,
      estimate_number: 'E01997',
      status: 'SENT',
      public_token: 'qa-1997-public-token',
      organization_id: TEST_USERS.sales.organization_id,
      customer: { first_name: 'QA1997', last_name: 'Customer', company_name: null },
      lead: { customer: { first_name: 'QA1997', last_name: 'LeadCustomer', company_name: null } },
      line_items: [],
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_DIRECT}/public?token=qa-1997-public-token`);

    expect(res.status).toBe(200);
    for (const key of CONTACT_KEYS) {
      expect(key in res.body.estimate.customer).toBe(false);
      expect(key in res.body.estimate.lead.customer).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (5) GET /api/invoices/:id — invoiceDetailSelect carries the same class of leak (email/phone,
//     no billing_* — Invoice/Customer has no billing fields projected there). Cheapened via
//     DISPATCHER's UNCONDITIONAL `read Invoice` (defaultGrants.ts:241) so `canAccessRow` short-
//     circuits without needing an `invoice.findFirst` row-scope mock — the subject under test is
//     the Customer-read redaction, not Invoice row-scope.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 (5) GET /api/invoices/:id — invoice detail parity', () => {
  it('RED — a requester whose Customer read scope excludes this customer still gets email/phone on invoice.customer today; desired: absent', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_ID);
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID,
      invoice_number: 'I01997',
      status: 'DRAFT', // DRAFT — skips the isSentInvoice() needs-resend query entirely
      sent_at: null,
      customer_id: CUSTOMER_ID,
      customer: {
        id: CUSTOMER_ID,
        first_name: 'QA1997',
        last_name: 'Customer',
        company_name: null,
        email: 'qa-1997-customer@example.com',
        phone: '5555501997',
        payment_type: null,
        tax_exempt: false,
      },
      job: null,
      line_items: [],
      refunds: [],
      credits: [],
    });

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect('email' in res.body.invoice.customer).toBe(false);
    expect('phone' in res.body.invoice.customer).toBe(false);
    expect(res.body.invoice.customer.id).toBe(CUSTOMER_ID);
  });

  it('green control: DISPATCHER with unconditional read Customer gets the full block — must not regress', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID,
      invoice_number: 'I01997',
      status: 'DRAFT',
      sent_at: null,
      customer_id: CUSTOMER_ID,
      customer: {
        id: CUSTOMER_ID,
        first_name: 'QA1997',
        last_name: 'Customer',
        company_name: null,
        email: 'qa-1997-customer@example.com',
        phone: '5555501997',
        payment_type: null,
        tax_exempt: false,
      },
      job: null,
      line_items: [],
      refunds: [],
      credits: [],
    });

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.customer.email).toBe('qa-1997-customer@example.com');
    expect(res.body.invoice.customer.phone).toBe('5555501997');
  });
});
