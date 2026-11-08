/**
 * #1997 round 2, finding 1/3 (HIGH) — the staff invoice PDF (`GET /api/invoices/:id/pdf`)
 * bypassed the customer-contact redaction the estimate twin already applies in this same issue's
 * first round: `invoice.controller.ts::getPdf` handed `invoicePdfSelect`'s row straight to
 * `generateInvoicePdf` with no `presentInvoiceDetail` call, so a requester whose `read Customer`
 * scope excludes the invoice's customer still got the full email/phone in the rendered document.
 *
 * `invoicePdfSelect.customer` carries no `id` (see `backend/src/lib/pdf/invoice-select.ts`), and
 * `redactRow` (customerContact.ts) fails closed without one — so the fix is `id: true` on that
 * sub-select PLUS the presenter call, not the presenter alone (would blank contact for ADMIN too).
 *
 * Mirrors `repro-1997.test.ts` / `estimate-customer-contact-redaction.test.ts`'s
 * `mockDeniedCustomerRead` — a conditioned `read Customer` grant built from real `DEFAULT_GRANTS`,
 * never a bare CASL literal. Uses DISPATCHER (unconditional `read Invoice`, defaultGrants.ts:241)
 * so `canAccessRow` short-circuits without a `findFirst` mock — the subject under test is the
 * Customer-read redaction, not Invoice row-scope (same cheapening `repro-1997.test.ts` case 5
 * uses).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { generateInvoicePdf } from '../lib/pdf';
import { mockAuthAs, authHeader } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

/** See repro-1997.test.ts for the full rationale — own local copy, not a shared import. */
function mockDeniedCustomerRead(role: string, deniedCustomerId: string) {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => !(g.role === role && g.action === 'read' && g.subject === 'Customer')),
    { role, action: 'read', subject: 'Customer', conditions: { id: 'zz-not-' + deniedCustomerId } },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows.filter((g) => g.role === role));
  clearPermissionCache();
}

const CUSTOMER_ID = 'c1997000-0000-0000-0000-000000000199';
const INVOICE_ID = 'i1997000-0000-0000-0000-000000000199';

function invoicePdfFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I01999',
    status: 'SENT',
    created_at: new Date('2026-04-01T12:00:00Z'),
    due_date: new Date('2026-04-15T12:00:00Z'),
    organization_id: '00000000-0000-0000-0000-000000000001',
    public_token: 'test-invoice-public-token-1997',
    subtotal: 800,
    discount_amount: 0,
    tax_rate: 0.0825,
    tax_amount: 66,
    deposit_credit: 0,
    total_amount: 866,
    amount_due: 866,
    scopes: null,
    customer: {
      id: CUSTOMER_ID,
      first_name: 'QA1997',
      last_name: 'Customer',
      company_name: null,
      email: 'qa-1997-customer@example.com',
      phone: '5555501997',
      service_locations: [
        { is_primary: true, address_line1: '123 Main St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' },
      ],
    },
    job: {
      service_location: { address_line1: '123 Main St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' },
    },
    line_items: [
      { description: 'AC Unit replacement', item_type: 'LABOR', quantity: 1, unit_price: 800, line_total: 800, discount_amount: 0, price_book_item: null },
    ],
    payments: [],
    ...overrides,
  };
}

const ORG_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Alpha HVAC',
  address_line1: '456 Business Blvd',
  address_line2: null,
  city: 'Austin',
  state: 'TX',
  postal_code: '78702',
  email: 'info@alphahvac.com',
  phone: '5559876543',
  website: null,
  logo_url: null,
  brand_color: '#242424',
  estimate_template: 'alpha-classic',
  estimate_terms: '',
  estimate_notes: '',
  estimate_payment_terms: '',
  invoice_terms: '',
  invoice_notes: '',
  invoice_payment_terms: '',
};

describe('GET /api/invoices/:id/pdf — customer redaction (#1997 round 2, finding 1/3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
  });

  it('RED then fixed — a requester denied Customer read gets a PDF payload with no email/phone', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_ID);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoicePdfFixture());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/pdf`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const call = vi.mocked(generateInvoicePdf).mock.calls.at(-1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customerArg = (call?.[0] as any).customer;
    expect('email' in customerArg).toBe(false);
    expect('phone' in customerArg).toBe(false);
    expect(customerArg.id).toBe(CUSTOMER_ID);
    expect(customerArg.first_name).toBe('QA1997'); // still renders a name
  });

  // #1997 round 3 (MEDIUM) — presentInvoiceDetail used to leave `service_locations` alone on the
  // invoice side (the invoice PDF template dereferenced it with no optional chaining), so the
  // customer's primary street address survived into the "Bill To" block even once email/phone
  // were stripped. The template now tolerates the key's absence (alpha-classic.ts), so the
  // presenter strips it here too, same as the estimate side.
  it('RED then fixed — a requester denied Customer read gets a PDF payload with no service_locations either', async () => {
    mockAuthAs('dispatcher');
    mockDeniedCustomerRead('DISPATCHER', CUSTOMER_ID);
    mockPrisma.invoice.findUnique.mockResolvedValue(invoicePdfFixture());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/pdf`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    const call = vi.mocked(generateInvoicePdf).mock.calls.at(-1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customerArg = (call?.[0] as any).customer;
    expect('service_locations' in customerArg).toBe(false);
    expect(customerArg.id).toBe(CUSTOMER_ID);
  });

  it('green control: ADMIN (unconditional read Customer) still gets email/phone in the PDF payload', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(invoicePdfFixture());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/pdf`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = vi.mocked(generateInvoicePdf).mock.calls.at(-1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customerArg = (call?.[0] as any).customer;
    expect(customerArg.email).toBe('qa-1997-customer@example.com');
    expect(customerArg.phone).toBe('5555501997');
    expect(customerArg.service_locations).toEqual(invoicePdfFixture().customer.service_locations);
  });

  it('guard: GET /api/invoices/:id/public/pdf (getPublicPdf) is untouched — the customer still gets their own full contact block', async () => {
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce({ id: INVOICE_ID, invoice_number: 'I01999', public_token: 'test-invoice-public-token-1997' })
      .mockResolvedValueOnce(invoicePdfFixture());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/public/pdf?token=test-invoice-public-token-1997`);

    expect(res.status).toBe(200);
    const call = vi.mocked(generateInvoicePdf).mock.calls.at(-1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customerArg = (call?.[0] as any).customer;
    expect(customerArg.email).toBe('qa-1997-customer@example.com');
    expect(customerArg.phone).toBe('5555501997');
  });
});
