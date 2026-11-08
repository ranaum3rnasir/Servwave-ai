import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import { generateEstimatePdf } from '../lib/pdf';

let sendEstimateEmail: typeof import('../lib/email')['sendEstimateEmail'];
let sendEstimateWithDepositEmail: typeof import('../lib/email')['sendEstimateWithDepositEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendEstimateEmail = real.sendEstimateEmail;
  sendEstimateWithDepositEmail = real.sendEstimateWithDepositEmail;
});

const ORG = { id: 'org-1', name: 'Acme', logo_url: null, brand_color: '#0C2D3A' };

const ESTIMATE_ROW = {
  estimate_number: 'E00001', status: 'SENT', created_at: new Date(), subtotal: 100, tax_rate: 0, tax_amount: 0,
  total_amount: 100, signature_data: null, signature_at: null, snapshot_terms: null, snapshot_notes: null,
  snapshot_payment_terms: null, organization_id: ORG.id,
  lead: {
    service_address_line1: null, service_address_line2: null, service_city: null, service_state: null, service_zip: null,
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@example.com', phone: null, service_locations: [] },
  },
  line_items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true });
  (prisma.estimate.findUnique as Mock).mockResolvedValue(ESTIMATE_ROW);
  (prisma.email.create as Mock).mockResolvedValue({});
});

const BASE_PARAMS = {
  estimateId: 'est-1', org: ORG, to: 'jane@example.com', customerName: 'Jane Doe',
  estimateNumber: 'E00001', total: '$100.00', publicUrl: 'https://x/y',
  record: { organizationId: ORG.id, customerId: 'cust-1', leadId: 'lead-1' },
};

describe('sendEstimateEmail — propagates the dispatch result', () => {
  it('returns {status:"sent"} and persists a transactional record on success', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'sent', providerMessageId: 're_1', fromAddress: 'no-reply@mail.test.com', fromName: null });
    expect(prisma.email.create).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ to: 'jane@example.com' }),
    }));
  });

  it('returns {status:"failed", error} and does NOT persist a record when Resend rejects', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'failed', error: 'domain not verified' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('returns {status:"skipped", reason:"org_disabled"} and never calls Resend', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'skipped', reason: 'org_disabled' });
    expect(resendSend).not.toHaveBeenCalled();
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('returns {status:"failed", error} and does NOT persist a record when PDF rendering throws', async () => {
    (generateEstimatePdf as Mock).mockRejectedValueOnce(new Error('pdf render boom'));
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res).toEqual({ status: 'failed', error: 'pdf render boom' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  // R6 (2026-07-22, independent-review fix) — renderEstimatePdfBuffer's select had its own
  // hand-rolled shape (same class of gap as getPdf/getPublicPdf) that never picked up the R6
  // anchor columns, so generateEstimatePdf would throw for a lead-less estimate. Locks the shape.
  it("renderEstimatePdfBuffer's select includes customer/service_location (the R6 anchor)", async () => {
    resendSend.mockResolvedValue({ data: { id: 're_3' }, error: null });
    await sendEstimateEmail(BASE_PARAMS);

    const sel = (prisma.estimate.findUnique as Mock).mock.calls[0]![0].select;
    expect(sel.customer).toBeTruthy();
    expect(sel.service_location).toBeTruthy();
  });
});

describe('sendEstimateWithDepositEmail — propagates the dispatch result', () => {
  it('returns {status:"sent"} and persists a transactional record on success', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_2' }, error: null });
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res).toEqual({ status: 'sent', providerMessageId: 're_2', fromAddress: 'no-reply@mail.test.com', fromName: null });
    expect(prisma.email.create).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ to: 'jane@example.com' }),
    }));
  });

  it('returns {status:"failed", error} and does NOT persist a record when Resend rejects', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res).toEqual({ status: 'failed', error: 'rate limited' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('returns {status:"failed", error} and does NOT persist a record when PDF rendering throws', async () => {
    (generateEstimatePdf as Mock).mockRejectedValueOnce(new Error('pdf render boom'));
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res).toEqual({ status: 'failed', error: 'pdf render boom' });
    expect(prisma.email.create).not.toHaveBeenCalled();
  });
});

// ─── Cross-tenant guard ──────────────────────────────────
//
// renderEstimatePdfBuffer resolves the organization whose branding goes ON the PDF the customer
// receives. It once read `prisma.organization.findFirst()` with NO where clause, so on a
// multi-tenant instance the attached document could carry whichever org row the database happened
// to return first — a different tenant's name, contact details, logo, brand colour and template,
// mailed to someone else's customer. The scoping fix shipped without a test: reverting that one
// line left the entire backend suite green, so this block is the only thing standing under it.
describe("renderEstimatePdfBuffer — brands the PDF with the ESTIMATE's own org", () => {
  // TWO organizations, distinguishable in every field the PDF renders. A single-org fixture would
  // make this whole block vacuous: the scoped and the unscoped lookup would return the same row and
  // every assertion below would hold on broken code too.
  const SENDING_ORG = {
    id: 'org-1', // === ESTIMATE_ROW.organization_id — the estimate's own org
    name: 'Acme', email: 'billing@org-one.example', phone: '555-0100',
    website: 'https://org-one.example', logo_url: 'https://cdn.example/org-one.png',
    brand_color: '#0C2D3A', estimate_template: 'alpha-classic', email_sending_enabled: true,
  };
  const OTHER_TENANT = {
    id: 'org-2', // a co-tenant with nothing to do with this estimate
    name: 'Second Tenant', email: 'billing@org-two.example', phone: '555-0200',
    website: 'https://org-two.example', logo_url: 'https://cdn.example/org-two.png',
    brand_color: '#B91C1C', estimate_template: 'crm-default', email_sending_enabled: true,
  };
  const ORGS: Record<string, typeof SENDING_ORG> = {
    [SENDING_ORG.id]: SENDING_ORG,
    [OTHER_TENANT.id]: OTHER_TENANT,
  };

  beforeEach(() => {
    // Keyed on where.id rather than one blanket mockResolvedValue: a single global answer hands the
    // PDF path the same row whatever id it asked for, which is precisely how the leak stayed
    // invisible. Asking for the wrong org here yields the WRONG org, as it would in production.
    (prisma.organization.findUnique as Mock).mockImplementation(
      async ({ where }: { where: { id: string } }) => ORGS[where.id] ?? null,
    );
    // Deliberately live, NOT a leftover: this is the row an unscoped findFirst() would hand back.
    // Without it the reverted code would hit `if (!org) throw` and this block would go red for the
    // wrong reason — an exception — instead of on the branding it actually asserts.
    (prisma.organization.findFirst as Mock).mockResolvedValue(OTHER_TENANT);
    resendSend.mockResolvedValue({ data: { id: 're_org_scope' }, error: null });
  });

  it("sendEstimateEmail renders the PDF with the estimate's org, not an arbitrary one", async () => {
    const res = await sendEstimateEmail(BASE_PARAMS);
    expect(res.status).toBe('sent');

    // The org ARGUMENT, by identity — not "the send resolved", which is true either way.
    expect(generateEstimatePdf).toHaveBeenCalledTimes(1);
    const [, orgArg, templateArg] = (generateEstimatePdf as Mock).mock.calls[0]!;
    expect(orgArg).toBe(SENDING_ORG);
    expect(orgArg.id).toBe(ESTIMATE_ROW.organization_id);
    expect(templateArg).toBe(SENDING_ORG.estimate_template);

    // Spelled out per field, so a failure names the branding that leaked rather than just
    // "objects are not equal".
    expect(orgArg.name).not.toBe(OTHER_TENANT.name);
    expect(orgArg.email).not.toBe(OTHER_TENANT.email);
    expect(orgArg.website).not.toBe(OTHER_TENANT.website);
    expect(orgArg.logo_url).not.toBe(OTHER_TENANT.logo_url);
    expect(orgArg.brand_color).not.toBe(OTHER_TENANT.brand_color);
    expect(templateArg).not.toBe(OTHER_TENANT.estimate_template);
  });

  it('sendEstimateWithDepositEmail scopes the same way', async () => {
    const res = await sendEstimateWithDepositEmail({ ...BASE_PARAMS, depositAmount: '$50.00', depositPercentage: 50 });
    expect(res.status).toBe('sent');

    const [, orgArg, templateArg] = (generateEstimatePdf as Mock).mock.calls[0]!;
    expect(orgArg).toBe(SENDING_ORG);
    expect(orgArg.name).not.toBe(OTHER_TENANT.name);
    expect(templateArg).toBe(SENDING_ORG.estimate_template);
  });

  it("looks the org up BY the estimate's organization_id, and never unscoped", async () => {
    await sendEstimateEmail(BASE_PARAMS);

    const ids = (prisma.organization.findUnique as Mock).mock.calls.map((c) => c[0].where.id);
    expect(ids).toContain(ESTIMATE_ROW.organization_id);
    // A where-less read of `organization` cannot be tenant-correct by construction, whatever row it
    // happens to return, so the call itself is the defect.
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });
});
