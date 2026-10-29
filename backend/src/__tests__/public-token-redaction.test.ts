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
 * `repro-1997.test.ts`'s `mockDeniedCustomerRead` (a conditioned `read Customer` grant built from
 * real `DEFAULT_GRANTS`, never a bare CASL literal) and its direct/lead-anchor fixture split.
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
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
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
    mockAuthAs('sales'); // OWN_ESTIMATE_VIA_LEAD_OR_CREATOR — creator branch (lead_id: null)
    mockDeniedCustomerRead('SALES', CUSTOMER_ID);
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
