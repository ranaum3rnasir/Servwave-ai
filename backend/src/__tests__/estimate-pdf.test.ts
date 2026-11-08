import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { generateEstimatePdf } from '../lib/pdf';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

// Mock the pdf lib so we don't run pdfmake in tests
vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

// ─── Fixtures ─────────────────────────────────────────

const ESTIMATE_PDF_FIXTURE = {
  ...ESTIMATE_FIXTURE,
  id: 'f0000000-0000-0000-0000-000000000099',
  estimate_number: 'E00099',
  status: 'SENT',
  organization_id: '00000000-0000-0000-0000-000000000001',
  snapshot_terms: null,
  snapshot_notes: null,
  snapshot_payment_terms: null,
  lead: {
    service_address_line1: '123 Main St',
    service_address_line2: null,
    service_city: 'Austin',
    service_state: 'TX',
    service_zip: '78701',
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
  },
  line_items: [
    {
      description: 'AC Unit replacement',
      item_type: 'LABOR',
      quantity: 1,
      unit_price: 800,
      line_total: 800,
      discount_amount: 0,
    },
  ],
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
  estimate_terms: '',
  estimate_notes: '',
  estimate_payment_terms: '',
};

// ─── Tests ────────────────────────────────────────────

describe('GET /api/estimates/:id/pdf', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
  });

  it('returns 200 with application/pdf for authenticated admin', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/pdf`)
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
    const res = await request(app).get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/pdf`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown estimate id', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/estimates/00000000-0000-0000-0000-000000000000/pdf')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

describe('estimate PDF — lead-linked estimate (entity-redesign §4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('getPdf renders an estimate with the customer reached via lead.customer (no throw)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', name: 'Alpha', logo_url: null, brand_color: '#242424', estimate_template: 'alpha-classic' });
    const res = await request(app).get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/pdf`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    // R6 (2026-07-22) — REVERSED from the entity-redesign §4 era: the top-level estimate.customer
    // select is back (the direct anchor), alongside lead.select.customer (the compat fallback for
    // rows still reached only through their lead — see the "selects created_by/customer/
    // service_location" test above, which supersedes this test's old "sel.customer undefined"
    // assertion).
    const sel = (mockPrisma.estimate.findUnique.mock.calls[0]![0] as any).select;
    expect(sel.lead.select.customer).toBeDefined();
    expect(sel.customer).toBeDefined();
  });
});

// ─── §2.2 / §2.5b — getPdf must match getPublicPdf's contract ─────────────
//
// Before the fix, getPdf's select omitted `scope_notes`/`scopes` entirely (so a template's
// "Scope of Work" block/priced-scope rows could never render for the STAFF preview, even though
// the template code supports both) and its generateEstimatePdf() call omitted the template
// argument (silently defaulting to 'alpha-classic' regardless of the org's actual
// estimate_template setting) — so staff Preview/Download showed a different document than the
// one the customer receives via getPublicPdf.
describe('estimate PDF — getPdf matches getPublicPdf (§2.2 / §2.5b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
  });

  it('passes org.estimate_template to generateEstimatePdf, not a hardcoded default', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_FIXTURE, estimate_template: 'crm-default' });

    await request(app).get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/pdf`).set(authHeader('admin'));

    const call = vi.mocked(generateEstimatePdf).mock.calls.at(-1);
    expect(call?.[2]).toBe('crm-default');
  });

  it('selects scope_notes and scopes so the template can render them (they were silently omitted before)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);

    await request(app).get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/pdf`).set(authHeader('admin'));

    const sel = (mockPrisma.estimate.findUnique.mock.calls[0]![0] as any).select;
    expect(sel.scope_notes).toBe(true);
    expect(sel.scopes).toBe(true);
  });

  // R6 (2026-07-22, independent-review fix) — getPdf's select had its own hand-rolled shape
  // that never picked up the R6 anchor columns (unlike estimateDetailSelect-based reads), so
  // canAccessEstimate's null-lead fallback could never resolve here and generateEstimatePdf would
  // throw 'Estimate has no customer' for a lead-less estimate. Locks the select shape so it can't
  // silently regress again.
  it('selects created_by/customer/service_location (the R6 anchor + null-lead RBAC fallback)', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_PDF_FIXTURE);
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);

    await request(app).get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/pdf`).set(authHeader('admin'));

    const sel = (mockPrisma.estimate.findUnique.mock.calls[0]![0] as any).select;
    expect(sel.created_by).toBe(true);
    expect(sel.customer).toBeTruthy();
    expect(sel.service_location).toBeTruthy();
  });
});

// ─── Public PDF ───────────────────────────────────────

const PUBLIC_TOKEN = 'test-public-token-abc';

const PUBLIC_PDF_TOKEN_FIXTURE = {
  id: ESTIMATE_PDF_FIXTURE.id,
  estimate_number: ESTIMATE_PDF_FIXTURE.estimate_number,
  public_token: PUBLIC_TOKEN,
};

describe('GET /api/estimates/:id/public/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns PDF with attachment disposition for valid token', async () => {
    // First call: token validation (findUnique with select id/estimate_number/public_token)
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(PUBLIC_PDF_TOKEN_FIXTURE)
      // Second call: full estimate for PDF
      .mockResolvedValueOnce(ESTIMATE_PDF_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/public/pdf?token=${PUBLIC_TOKEN}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(ESTIMATE_PDF_FIXTURE.estimate_number);
  });

  it('returns 404 for missing token', async () => {
    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/public/pdf`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for invalid/mismatched token', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValueOnce({
      ...PUBLIC_PDF_TOKEN_FIXTURE,
      public_token: 'correct-token',
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/public/pdf?token=wrong-token`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when estimate does not exist', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/public/pdf?token=${PUBLIC_TOKEN}`);
    expect(res.status).toBe(404);
  });

  // R6 (2026-07-22, independent-review fix) — same gap as getPdf above: this route's own
  // hand-rolled select never picked up the anchor columns, so generateEstimatePdf would throw
  // for a lead-less estimate. No RBAC check here (public/token-gated), so just the anchor.
  it('selects customer/service_location (the R6 anchor)', async () => {
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce(PUBLIC_PDF_TOKEN_FIXTURE)
      .mockResolvedValueOnce(ESTIMATE_PDF_FIXTURE);

    await request(app).get(`/api/estimates/${ESTIMATE_PDF_FIXTURE.id}/public/pdf?token=${PUBLIC_TOKEN}`);

    const sel = (mockPrisma.estimate.findUnique.mock.calls[1]![0] as any).select;
    expect(sel.customer).toBeTruthy();
    expect(sel.service_location).toBeTruthy();
  });
});
