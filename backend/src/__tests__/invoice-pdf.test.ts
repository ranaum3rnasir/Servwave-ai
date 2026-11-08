import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { generateInvoicePdf } from '../lib/pdf';
import { mockAuthAs, authHeader } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  invoice: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

// Mock the pdf lib so we don't run pdfmake in tests
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

// ─── Fixtures ─────────────────────────────────────────

const INVOICE_PDF_FIXTURE = {
  id: 'f0000000-0000-0000-0000-000000000199',
  invoice_number: 'I00099',
  status: 'SENT',
  created_at: new Date('2026-04-01T12:00:00Z'),
  due_date: new Date('2026-04-15T12:00:00Z'),
  organization_id: '00000000-0000-0000-0000-000000000001',
  subtotal: 800,
  discount_amount: 0,
  tax_rate: 0.0825,
  tax_amount: 66,
  deposit_credit: 0,
  total_amount: 866,
  amount_due: 866,
  scopes: null,
  customer: {
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
    phone: '5551234567',
    service_locations: [
      {
        is_primary: true,
        address_line1: '123 Main St',
        address_line2: null,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      },
    ],
  },
  job: {
    service_location: {
      address_line1: '123 Main St',
      address_line2: null,
      city: 'Austin',
      state: 'TX',
      zip: '78701',
    },
  },
  line_items: [
    {
      description: 'AC Unit replacement',
      item_type: 'LABOR',
      quantity: 1,
      unit_price: 800,
      line_total: 800,
      discount_amount: 0,
      price_book_item: null,
    },
  ],
  payments: [],
};

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

// ─── Tests ────────────────────────────────────────────

describe('GET /api/invoices/:id/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
  });

  it('returns 200 with application/pdf for authenticated admin', async () => {
    const res = await request(app)
      .get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/pdf`)
      .set(authHeader('admin'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline/);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/pdf`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown invoice id', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/invoices/00000000-0000-0000-0000-000000000000/pdf')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('passes org.estimate_template (the shared template picker) to generateInvoicePdf', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_FIXTURE, estimate_template: 'crm-default' });

    await request(app).get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/pdf`).set(authHeader('admin'));

    const call = vi.mocked(generateInvoicePdf).mock.calls.at(-1);
    expect(call?.[2]).toBe('crm-default');
  });
});

// ─── Public PDF ───────────────────────────────────────

const PUBLIC_TOKEN = 'test-invoice-public-token-abc';

const PUBLIC_PDF_TOKEN_FIXTURE = {
  id: INVOICE_PDF_FIXTURE.id,
  invoice_number: INVOICE_PDF_FIXTURE.invoice_number,
  public_token: PUBLIC_TOKEN,
};

describe('GET /api/invoices/:id/public/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns PDF with attachment disposition for valid token', async () => {
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(PUBLIC_PDF_TOKEN_FIXTURE)
      .mockResolvedValueOnce(INVOICE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/public/pdf?token=${PUBLIC_TOKEN}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(INVOICE_PDF_FIXTURE.invoice_number);
  });

  it('returns 404 for missing token', async () => {
    const res = await request(app).get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/public/pdf`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for invalid/mismatched token', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      ...PUBLIC_PDF_TOKEN_FIXTURE,
      public_token: 'correct-token',
    });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/public/pdf?token=wrong-token`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when invoice does not exist', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_PDF_FIXTURE.id}/public/pdf?token=${PUBLIC_TOKEN}`);
    expect(res.status).toBe(404);
  });
});
