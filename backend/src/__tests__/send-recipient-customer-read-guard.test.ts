/**
 * #1997 round 2, finding 4 (MEDIUM) — send endpoints take a client-controlled recipient
 * (`recipient_override`/`cc_emails` on estimates, `to`/`cc_emails` on invoice send/resend) with no
 * `read Customer` check, so a requester who is redacted on screen (the round-1 fix) could mail the
 * full customer PDF to themselves, or CC themselves and read the customer's address in the To
 * header, by calling the API directly instead of using the (redacted) send dialog.
 *
 * Fix: when the requester cannot read the anchored customer row (same per-row `can(req, 'read',
 * 'Customer', customer)` check the round-1 presenter uses), reject any client-supplied recipient
 * with 403 and neutral copy. With no client recipient the send proceeds to the saved address
 * exactly as before.
 *
 * Mirrors `repro-1997.test.ts` / `estimate-customer-contact-redaction.test.ts`'s
 * `mockDeniedCustomerRead` — a conditioned `read Customer` grant built from real `DEFAULT_GRANTS`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { sendEstimateEmail } from '../lib/email';
import { sendInvoiceEmail } from '../lib/email';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;
const mockSendEstimateEmail = sendEstimateEmail as Mock;
const mockSendInvoiceEmail = sendInvoiceEmail as Mock;

const NEUTRAL_ERROR = "You can send this to the customer's saved address only.";

/** See repro-1997.test.ts for the full rationale — own local copy, not a shared import. */
function mockDeniedCustomerRead(role: string, deniedCustomerId: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + deniedCustomerId } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockSendEstimateEmail.mockResolvedValue({ status: 'sent' });
  mockSendInvoiceEmail.mockResolvedValue({ status: 'sent' });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// POST /api/estimates/:id/send
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('POST /api/estimates/:id/send — client-supplied recipient requires Customer read', () => {
  const ESTIMATE_ID = 'f1997000-0000-0000-0000-000000000201';
  const CUSTOMER_ID = 'c1997000-0000-0000-0000-000000000201';

  function draftEstimate(overrides: Record<string, unknown> = {}) {
    return {
      id: ESTIMATE_ID,
      status: 'DRAFT',
      estimate_number: 'E01997',
      total_amount: 1000,
      public_token: null,
      send_config: null,
      organization_id: ALPHA_ORG_ID,
      _count: { line_items: 2 },
      lead_id: 'e1997000-0000-0000-0000-000000000202',
      customer_id: null,
      customer: null,
      lead: {
        lead_assignees: [{ user_id: TEST_USERS.sales.id }],
        status: 'NEW',
        customer: { id: CUSTOMER_ID, first_name: 'QA1997', last_name: 'Customer', company_name: null, email: 'qa-1997-customer@example.com' },
      },
      job_id: null,
      job: null,
      job_link: null,
      ...overrides,
    };
  }

  function setupCommit() {
    mockPrisma.estimate.update.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      estimate: { update: vi.fn().mockResolvedValue({ ...draftEstimate(), status: 'SENT', public_token: 'tok', invoices: [] }), findUnique: vi.fn().mockResolvedValue(null) },
      estimateSendConfig: { upsert: vi.fn().mockResolvedValue({}) },
      invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }));
  }

  beforeEach(() => {
    mockAuthAs('sales'); // unconditional `send Estimate` (defaultGrants.ts:120), owns via lead_assignees
    mockDeniedCustomerRead('SALES', CUSTOMER_ID);
    mockPrisma.estimate.findUnique.mockResolvedValue(draftEstimate());
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ALPHA_ORG_ID, name: 'Org', logo_url: null, brand_color: '#000',
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: null,
    });
    setupCommit();
  });

  it('RED then fixed — recipient_override is rejected with 403 for a requester denied Customer read', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/send`)
      .set(authHeader('sales'))
      .send({ deposit_required: false, payment_methods: [], recipient_override: 'attacker@mailbox.test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NEUTRAL_ERROR);
    expect(mockSendEstimateEmail).not.toHaveBeenCalled();
  });

  it('RED then fixed — cc_emails is rejected with 403 for a requester denied Customer read', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/send`)
      .set(authHeader('sales'))
      .send({ deposit_required: false, payment_methods: [], cc_emails: ['attacker@mailbox.test'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NEUTRAL_ERROR);
    expect(mockSendEstimateEmail).not.toHaveBeenCalled();
  });

  it('green: with no client-supplied recipient, the send proceeds to the saved address', async () => {
    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/send`)
      .set(authHeader('sales'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(res.status).toBe(200);
    expect(mockSendEstimateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'qa-1997-customer@example.com' }),
    );
  });

  it('green control: ADMIN (unconditional read Customer) may still override the recipient', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(draftEstimate());

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [], recipient_override: 'staff-typo-fix@example.com' });

    expect(res.status).toBe(200);
    expect(mockSendEstimateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'staff-typo-fix@example.com' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// POST /api/invoices/:id/send and /:id/resend
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('POST /api/invoices/:id/send — client-supplied recipient requires Customer read', () => {
  const INVOICE_ID = 'i1997000-0000-0000-0000-000000000202';
  const CUSTOMER_ID = 'c1997000-0000-0000-0000-000000000202';

  function invoiceFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I01997',
      status: 'DRAFT',
      sent_at: null,
      public_token: null,
      due_date: null,
      total_amount: 1000,
      amount_due: 1000,
      customer_id: CUSTOMER_ID,
      customer: { id: CUSTOMER_ID, first_name: 'QA1997', last_name: 'Customer', company_name: null, email: 'qa-1997-customer@example.com', phone: '5555501997', payment_type: null, tax_exempt: false },
      job: null,
      line_items: [],
      refunds: [],
      credits: [],
      scopes: null,
      ...overrides,
    };
  }

  function setupCommit(resultInvoice: Record<string, unknown>) {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      invoice: { update: vi.fn().mockResolvedValue(resultInvoice) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    }));
  }

  beforeEach(() => {
    mockAuthAs('dispatcher'); // unconditional `send Invoice` + `read Invoice` (defaultGrants.ts:245/241)
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_ID);
    mockPrisma.organization.findUnique.mockResolvedValue({ id: ALPHA_ORG_ID, timezone: 'America/Chicago' });
  });

  it('RED then fixed — invoice send `to` is rejected with 403 for a requester denied Customer read', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture());
    setupCommit(invoiceFixture({ status: 'SENT' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/send`)
      .set(authHeader('dispatcher'))
      .send({ to: 'attacker@mailbox.test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NEUTRAL_ERROR);
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('RED then fixed — invoice send cc_emails is rejected with 403 for a requester denied Customer read', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture());
    setupCommit(invoiceFixture({ status: 'SENT' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/send`)
      .set(authHeader('dispatcher'))
      .send({ cc_emails: ['attacker@mailbox.test'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NEUTRAL_ERROR);
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('RED then fixed — invoice resend `to` is rejected with 403 for a requester denied Customer read', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture({ status: 'SENT', sent_at: new Date('2026-01-01'), public_token: 'tok-1997' }));
    setupCommit(invoiceFixture({ status: 'SENT' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/resend`)
      .set(authHeader('dispatcher'))
      .send({ to: 'attacker@mailbox.test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NEUTRAL_ERROR);
    expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('green: invoice send with no client-supplied recipient proceeds to the saved address', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture());
    setupCommit(invoiceFixture({ status: 'SENT' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/send`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockSendInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'qa-1997-customer@example.com' }),
    );
  });

  it('green control: ADMIN (unconditional read Customer) may still override the recipient with `to`', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceFixture());
    setupCommit(invoiceFixture({ status: 'SENT' }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/send`)
      .set(authHeader('admin'))
      .send({ to: 'staff-typo-fix@example.com' });

    expect(res.status).toBe(200);
    expect(mockSendInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'staff-typo-fix@example.com' }),
    );
  });
});
