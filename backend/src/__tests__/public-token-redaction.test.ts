/**
 * #1997 round 3 (HIGH) — the redacted detail response still carried `public_token`, and the
 * unauthenticated public PDF twin (`GET /:id/public/pdf?token=`) accepts that token with no
 * `read Customer` check at all — so a requester whose Customer-read scope excludes the anchored
 * row could read the token off the (otherwise correctly redacted) response and use it to pull the
 * full, un-redacted contact block straight back through the public route.
 *
 * `presentEstimateDetail`/`presentInvoiceDetail` now delete `public_token` from the TOP-LEVEL
 * document whenever the anchored customer — the top-level `customer`, or (only when there is no
 * top-level one) `lead.customer` (estimate) / `job.customer` (invoice) — fails the SAME
 * `can(req,'read','Customer',row)` check that already strips the seven contact keys. Mirrors
 * `repro-1997.test.ts`'s `mockDeniedCustomerRead` (View customers turned off through the switch
 * catalog, which owns Customer reach since S01.5, never a bare CASL literal) and its direct/lead-anchor fixture split.
 *
 * `send`/`resend`/`markSent` are deliberately NOT re-tested here: they mint/resolve the token from
 * the loaded PRE-response row (`existing.public_token`/a freshly minted `publicToken` variable),
 * never from the presented response object — confirmed by reading
 * `estimate.controller.ts::sendEstimateInternal` (the `publicUrl` built at line ~2409 reads
 * `publicToken`, a local const, not `presentEstimateDetail`'s output) and
 * `invoice.controller.ts::sendInvoiceInternal`/`resendInvoiceInternal` (same pattern via
 * `invoice.public_token`/a local `publicToken`). This file only guards the READ side.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, mockRoleSwitches, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

/** See repro-1997.test.ts for the full rationale — own local copy, not a shared import. */
function mockDeniedCustomerRead(_role: string, _deniedCustomerId: string) {
  // View customers off: the person reaches no customer, so THIS one is denied.
  mockRoleSwitches({ view_customers: false });
}

const CUSTOMER_ID = 'c1997pt0-0000-0000-0000-000000000001';
const LEAD_CUSTOMER_ID = 'c1997pt0-0000-0000-0000-000000000002';
const JOB_CUSTOMER_ID = 'c1997pt0-0000-0000-0000-000000000003';
const LEAD_ID = 'e1997pt0-0000-0000-0000-000000000001';
const ESTIMATE_ID_DIRECT = 'f1997pt0-0000-0000-0000-000000000001';
const ESTIMATE_ID_LEAD = 'f1997pt0-0000-0000-0000-000000000002';
const INVOICE_ID_DIRECT = 'i1997pt0-0000-0000-0000-000000000001';
const INVOICE_ID_JOB = 'i1997pt0-0000-0000-0000-000000000002';

const PUBLIC_TOKEN = 'test-1997-public-token';

function bareCustomer(id: string, overrides: Record<string, unknown> = {}) {
  return { id, first_name: 'QA1997', last_name: 'Customer', company_name: null, ...overrides };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (1) GET /api/estimates/:id — direct `customer` anchor, creator branch
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 round 3 (1) GET /api/estimates/:id — public_token, direct customer anchor', () => {
  it('a requester denied read Customer on the direct anchor gets no public_token', async () => {
    mockAuthAs('sales'); // the estimate is inside their Estimates scope (the scoped probe finds it)
    mockDeniedCustomerRead('SALES', CUSTOMER_ID);
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID_DIRECT });
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID_DIRECT,
      lead_id: null,
      customer_id: CUSTOMER_ID,
      job_id: null,
      job: null,
      job_link: null,
      estimate_number: 'E01997',
      status: 'SENT',
      created_by: TEST_USERS.sales.id,
      public_token: PUBLIC_TOKEN,
      customer: bareCustomer(CUSTOMER_ID),
      lead: null,
      line_items: [],
      scope_photos: [],
      invoices: [],
      creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_DIRECT}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect('public_token' in res.body.estimate).toBe(false);
    // sanity: this IS the redaction path — the seven contact keys are gone too
    expect('email' in res.body.estimate.customer).toBe(false);
  });

  it('green control: ADMIN (unconditional read Customer) still gets public_token — must not regress', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID_DIRECT,
      lead_id: null,
      customer_id: CUSTOMER_ID,
      job_id: null,
      job: null,
      job_link: null,
      estimate_number: 'E01997',
      status: 'SENT',
      created_by: TEST_USERS.admin.id,
      public_token: PUBLIC_TOKEN,
      customer: bareCustomer(CUSTOMER_ID),
      lead: null,
      line_items: [],
      scope_photos: [],
      invoices: [],
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_DIRECT}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.public_token).toBe(PUBLIC_TOKEN);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (2) GET /api/estimates/:id — no top-level customer, anchored only through `lead.customer`
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 round 3 (2) GET /api/estimates/:id — public_token, lead-only anchor', () => {
  it('a requester denied read Customer on lead.customer gets no public_token even though the top-level customer is null', async () => {
    mockAuthAs('sales'); // owns the lead via lead_assignees, not the creator
    mockDeniedCustomerRead('SALES', LEAD_CUSTOMER_ID);
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID_LEAD });
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID_LEAD,
      lead_id: LEAD_ID,
      customer_id: null,
      job_id: null,
      job: null,
      job_link: null,
      estimate_number: 'E01998',
      status: 'SENT',
      created_by: TEST_USERS.dispatcher.id,
      public_token: PUBLIC_TOKEN,
      customer: null,
      lead: {
        id: LEAD_ID,
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        customer: bareCustomer(LEAD_CUSTOMER_ID),
      },
      line_items: [],
      scope_photos: [],
      invoices: [],
      creator: { id: TEST_USERS.dispatcher.id, first_name: 'Test', last_name: 'Dispatcher' },
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_LEAD}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect('public_token' in res.body.estimate).toBe(false);
    expect('email' in res.body.estimate.lead.customer).toBe(false);
  });


  it('a requester with Customers View off keeps the public_token of a lead-only-anchored estimate whose customer has a lead they are on (S01.5: it comes with that record)', async () => {
    mockAuthAs('sales'); // owns the lead via lead_assignees, not the creator
    mockDeniedCustomerRead('SALES', LEAD_CUSTOMER_ID);
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID_LEAD });
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID_LEAD,
      lead_id: LEAD_ID,
      customer_id: null,
      job_id: null,
      job: null,
      job_link: null,
      estimate_number: 'E01998',
      status: 'SENT',
      created_by: TEST_USERS.dispatcher.id,
      public_token: PUBLIC_TOKEN,
      customer: null,
      lead: {
        id: LEAD_ID,
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        customer: bareCustomer(LEAD_CUSTOMER_ID, { leads: [{ lead_assignees: [{ user_id: TEST_USERS.sales.id }] }] }),
      },
      line_items: [],
      scope_photos: [],
      invoices: [],
      creator: { id: TEST_USERS.dispatcher.id, first_name: 'Test', last_name: 'Dispatcher' },
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_LEAD}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect('public_token' in res.body.estimate).toBe(true);
  });

  it('green control: unconditional reader keeps public_token on a lead-only-anchored estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID_LEAD,
      lead_id: LEAD_ID,
      customer_id: null,
      job_id: null,
      job: null,
      job_link: null,
      estimate_number: 'E01998',
      status: 'SENT',
      created_by: TEST_USERS.admin.id,
      public_token: PUBLIC_TOKEN,
      customer: null,
      lead: {
        id: LEAD_ID,
        lead_assignees: [],
        customer: bareCustomer(LEAD_CUSTOMER_ID),
      },
      line_items: [],
      scope_photos: [],
      invoices: [],
      creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });

    const res = await request(app).get(`/api/estimates/${ESTIMATE_ID_LEAD}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.public_token).toBe(PUBLIC_TOKEN);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (3) GET /api/invoices/:id — direct `customer` anchor. Cheapened via DISPATCHER's UNCONDITIONAL
//     `read Invoice` so `canAccessRow` short-circuits — the subject under test is the
//     Customer-read redaction, not Invoice row-scope.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 round 3 (3) GET /api/invoices/:id — public_token, direct customer anchor', () => {
  it('a requester denied read Customer gets no public_token', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_ID);
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID_DIRECT,
      invoice_number: 'I01997',
      status: 'SENT',
      sent_at: new Date('2026-01-01T00:00:00.000Z'),
      customer_id: CUSTOMER_ID,
      public_token: PUBLIC_TOKEN,
      customer: bareCustomer(CUSTOMER_ID, { payment_type: null, tax_exempt: false }),
      job: null,
      line_items: [],
      refunds: [],
      credits: [],
    });
    mockPrisma.timelineEvent.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID_DIRECT}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect('public_token' in res.body.invoice).toBe(false);
    expect('email' in res.body.invoice.customer).toBe(false);
  });

  it('green control: DISPATCHER (unconditional read Customer) keeps public_token — must not regress', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID_DIRECT,
      invoice_number: 'I01997',
      status: 'SENT',
      sent_at: new Date('2026-01-01T00:00:00.000Z'),
      customer_id: CUSTOMER_ID,
      public_token: PUBLIC_TOKEN,
      customer: bareCustomer(CUSTOMER_ID, { payment_type: null, tax_exempt: false }),
      job: null,
      line_items: [],
      refunds: [],
      credits: [],
    });
    mockPrisma.timelineEvent.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID_DIRECT}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.public_token).toBe(PUBLIC_TOKEN);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (4) GET /api/invoices/:id — no top-level customer (legacy job-anchored invoice), anchored only
//     through `job.customer`.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#1997 round 3 (4) GET /api/invoices/:id — public_token, job-only anchor', () => {
  it('a requester denied read Customer on job.customer gets no public_token even though the top-level customer is null', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', JOB_CUSTOMER_ID);
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID_JOB,
      invoice_number: 'I01998',
      status: 'SENT',
      sent_at: new Date('2026-01-01T00:00:00.000Z'),
      customer_id: null,
      public_token: PUBLIC_TOKEN,
      customer: null,
      job: { id: 'job-1997pt', job_number: 'J01997', customer: bareCustomer(JOB_CUSTOMER_ID, { payment_type: null, tax_exempt: false }) },
      line_items: [],
      refunds: [],
      credits: [],
    });
    mockPrisma.timelineEvent.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID_JOB}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect('public_token' in res.body.invoice).toBe(false);
    expect('email' in res.body.invoice.job.customer).toBe(false);
  });


  it('a requester with Customers View off keeps the public_token of a job-only-anchored invoice whose customer has a job they can open (S01.5: it comes with that record)', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', JOB_CUSTOMER_ID);
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID_JOB,
      invoice_number: 'I01998',
      status: 'SENT',
      sent_at: new Date('2026-01-01T00:00:00.000Z'),
      customer_id: null,
      public_token: PUBLIC_TOKEN,
      customer: null,
      job: { id: 'job-1997pt', job_number: 'J01997', customer: bareCustomer(JOB_CUSTOMER_ID, { payment_type: null, tax_exempt: false, jobs: [{ visits: [] }] }) },
      line_items: [],
      refunds: [],
      credits: [],
    });
    mockPrisma.timelineEvent.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID_JOB}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect('public_token' in res.body.invoice).toBe(true);
  });

  it('green control: unconditional reader keeps public_token on a job-only-anchored invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID_JOB,
      invoice_number: 'I01998',
      status: 'SENT',
      sent_at: new Date('2026-01-01T00:00:00.000Z'),
      customer_id: null,
      public_token: PUBLIC_TOKEN,
      customer: null,
      job: { id: 'job-1997pt', job_number: 'J01997', customer: bareCustomer(JOB_CUSTOMER_ID, { payment_type: null, tax_exempt: false }) },
      line_items: [],
      refunds: [],
      credits: [],
    });
    mockPrisma.timelineEvent.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID_JOB}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.public_token).toBe(PUBLIC_TOKEN);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (5) GET /api/invoices/:id/public?token= — payments go-live slice 24 (#1073). The token route
//     now carries the scope of work. It has no requester, so the redaction is not judged per
//     caller: every scope block reaches the customer with its customer-safe keys only, whatever
//     else the stored block carries. The real-database twin (public-invoice-scope-of-work-db)
//     proves the column is actually read; this case pins the projection on a row that carries
//     every staff-only key a stored block can hold.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('slice 24 (5) GET /api/invoices/:id/public — scope of work, staff-only keys stripped', () => {
  it('a stored scope carrying margin and rep state reaches the customer as title, body, price and taxable flag only', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID_DIRECT,
      invoice_number: 'I01999',
      organization_id: '00000000-0000-0000-0000-000000000001',
      status: 'SENT',
      subtotal: 1200, discount_amount: 0, tax_amount: 0, deposit_credit: 0, total_amount: 1200, amount_due: 1200,
      due_date: null, sent_at: new Date('2026-01-01T00:00:00.000Z'), paid_at: null, created_at: new Date('2026-01-01T00:00:00.000Z'),
      kind: 'STANDARD',
      scopes: [
        {
          id: 's1', title: 'Panel upgrade', body: 'Replace the panel', flat_price: 1200, is_taxable: true,
          internal_cost: 700, rep_selected: true, is_optional: false, is_selected: true,
        },
      ],
      estimate: null,
      customer: { first_name: 'QA1997', last_name: 'Customer', company_name: null },
      line_items: [],
      job: null,
      payments: [],
      payment_methods_override: null,
      allow_partial_payment: null,
    });

    const res = await request(app).get(`/api/invoices/${INVOICE_ID_DIRECT}/public?token=${PUBLIC_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.scopes).toEqual([
      { id: 's1', title: 'Panel upgrade', body: 'Replace the panel', flat_price: 1200, is_taxable: true },
    ]);
    expect('organization_id' in res.body.invoice).toBe(false);
  });
});
