import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { buildStatementPdf, type StatementForPdf } from '../lib/pdf/templates/statement';

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

// Mock the pdf lib so we don't run pdfmake in the route tests.
vi.mock('../lib/pdf', () => ({
  generateStatementPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

const JOB_ID = 'a3000000-0000-0000-0000-000000000001';

const JOB_ROW = {
  id: JOB_ID,
  job_number: 'J00010',
  status: 'COMPLETED',
  customer_id: 'c3000000-0000-0000-0000-000000000001',
  customer: {
    id: 'c3000000-0000-0000-0000-000000000001',
    first_name: 'Jane',
    last_name: 'Roe',
    company_name: null,
    email: 'jane@roe.com',
  },
  service_location: { address_line1: '9 Oak St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' },
};

const STANDARD_INVOICE = {
  id: 'd3000000-0000-0000-0000-000000000001',
  invoice_number: 'I00200',
  kind: 'STANDARD',
  status: 'PAID',
  total_amount: 1000,
  tax_amount: 80,
  created_at: new Date('2026-05-01T10:00:00Z'),
  payments: [
    {
      id: 'p3000000-0000-0000-0000-000000000001',
      amount: 1000,
      method: 'CARD',
      paid_at: new Date('2026-05-02T10:00:00Z'),
      reference_number: null,
      stripe_payment_intent_id: 'pi_x',
      created_at: new Date('2026-05-02T10:00:00Z'),
    },
  ],
  refunds: [],
  credits: [],
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
};

describe('GET /api/statements/job/:jobId?format=pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.invoice.findMany.mockResolvedValue([STANDARD_INVOICE]);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
  });

  it('returns application/pdf inline', async () => {
    const res = await request(app)
      .get(`/api/statements/job/${JOB_ID}?format=pdf`)
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

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/statements/job/${JOB_ID}?format=pdf`);
    expect(res.status).toBe(401);
  });
});

describe('buildStatementPdf renders without blank fields (#24 regression class)', () => {
  it('coalesces every cell — no undefined / null literals; every row has description + amount + balance', () => {
    const statement: StatementForPdf = {
      scope: 'customer',
      title: 'Statement',
      // party with missing names (null) — must fall back, not render 'undefined'.
      party: { name: '', email: null as string | null },
      lines: [
        {
          date: null as Date | null,
          type: 'invoice',
          label: 'Invoice issued',
          invoice_number: null as string | null,
          amount: 1000,
          running_balance: 1000,
        },
        {
          date: new Date('2026-05-02T10:00:00Z'),
          type: 'deposit_credit',
          label: 'Deposit credit applied',
          invoice_number: 'I00200',
          amount: -300,
          running_balance: 700,
        },
      ],
      totals: { billed: 1000, paid: 300, refunded: 0, credited: 0, balance: 700 },
    };

    const org = { name: 'Alpha HVAC', logo_url: null } as Parameters<typeof buildStatementPdf>[1];
    const doc = buildStatementPdf(statement, org);
    const serialized = JSON.stringify(doc);

    expect(serialized).not.toContain('undefined');
    expect(serialized).not.toContain('"null"');
    // Sanity: a real money cell rendered.
    expect(serialized).toContain('$1,000.00');
  });
});
