import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// ─── Per-row RBAC on the authed estimate PDF (FINAL-role-audit §4d) ───────────
//
// `GET /api/estimates/:id/pdf` is route-gated `canDo('read','Estimate')`. SALES holds an
// UNCONDITIONAL `read Estimate` grant, so it passes the route guard. The handler emits a
// fully-priced PDF (subtotal/tax/total + per-line unit_price/line_total). Before this fix the
// handler loaded the row with `tenantWhere` ONLY — no per-row ownership check — so a SALES rep
// could pull the priced PDF of ANY estimate in the org, including leads they don't own, even
// though the JSON `getById` for the SAME estimate is own-scoped (`canAccessEstimate`).
//
// Fix: `getPdf` now applies the SAME `canAccessEstimate` gate `getById` uses (and selects
// `lead.lead_assignees` so it can evaluate ownership). Non-owner SALES → 403, PDF never generated.

// Mock the pdf lib so we don't run pdfmake; also lets us assert it's NOT invoked on a 403.
const generateEstimatePdf = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: (...args: unknown[]) => generateEstimatePdf(...args),
}));

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

const ORG_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Alpha HVAC',
  brand_color: '#242424',
  logo_url: null,
  estimate_terms: '',
  estimate_notes: '',
  estimate_payment_terms: '',
};

// Estimate whose parent lead is owned by SALES (TEST_USERS.sales.id) — the default fixture owner.
const PDF_FIXTURE_OWNED_BY_SALES = {
  ...ESTIMATE_FIXTURE,
  id: 'f0000000-0000-0000-0000-000000000099',
  estimate_number: 'E00099',
  status: 'SENT',
  organization_id: '00000000-0000-0000-0000-000000000001',
  snapshot_terms: null,
  snapshot_notes: null,
  snapshot_payment_terms: null,
  lead: {
    ...ESTIMATE_FIXTURE.lead,
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
  },
};

// Same estimate but the parent lead is owned by SOMEONE ELSE (a different sales user) — the
// requesting SALES rep does NOT own it.
const PDF_FIXTURE_OWNED_BY_OTHER = {
  ...PDF_FIXTURE_OWNED_BY_SALES,
  lead: {
    ...PDF_FIXTURE_OWNED_BY_SALES.lead,
    lead_assignees: [{ user_id: '00000000-0000-0000-0000-0000000000ff' }],
  },
};

describe('GET /api/estimates/:id/pdf — per-row RBAC (in-tenant cross-user pricing leak)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_FIXTURE);
    // canAccessRow may probe estimate.findFirst for conditional readers; harmless for SALES/ADMIN
    // (SALES scope is {} → fast-path no query; ADMIN short-circuits).
    mockPrisma.estimate.findFirst?.mockResolvedValue(null);
  });

  it('SALES requesting the PDF of an estimate on a lead they do NOT own → 403 (PDF not generated)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(PDF_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .get(`/api/estimates/${PDF_FIXTURE_OWNED_BY_OTHER.id}/pdf`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(generateEstimatePdf).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 200 + application/pdf for their own estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(PDF_FIXTURE_OWNED_BY_SALES);

    const res = await request(app)
      .get(`/api/estimates/${PDF_FIXTURE_OWNED_BY_SALES.id}/pdf`)
      .set(authHeader('sales'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(generateEstimatePdf).toHaveBeenCalledTimes(1);
  });

  it('ADMIN gets 200 for an estimate they do not own (unconditional access preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(PDF_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .get(`/api/estimates/${PDF_FIXTURE_OWNED_BY_OTHER.id}/pdf`)
      .set(authHeader('admin'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(generateEstimatePdf).toHaveBeenCalledTimes(1);
  });

  it('DISPATCHER (unconditional read) gets 200 for an estimate they do not own', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(PDF_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .get(`/api/estimates/${PDF_FIXTURE_OWNED_BY_OTHER.id}/pdf`)
      .set(authHeader('dispatcher'))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(generateEstimatePdf).toHaveBeenCalledTimes(1);
  });

  it('TECHNICIAN is blocked at the route (no read Estimate grant) → 403, PDF not generated', async () => {
    mockAuthAs('technician');
    mockPrisma.estimate.findUnique.mockResolvedValue(PDF_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .get(`/api/estimates/${PDF_FIXTURE_OWNED_BY_OTHER.id}/pdf`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(generateEstimatePdf).not.toHaveBeenCalled();
  });

  // R6 (2026-07-22) — getPdf's select previously omitted created_by/customer/service_location,
  // so canAccessEstimate's null-lead fallback (D19) could never resolve here and PDF generation
  // would throw for a null-lead estimate (independent review caught this: the anchor fix landed
  // for estimateDetailSelect-based reads but not this hand-rolled select). No estimate currently
  // has a null lead, but the gate must already be correct.
  it('lead-less estimate: the CREATOR gets 200 (created_by fallback), a non-creator SALES gets 403', async () => {
    const LEAD_LESS_FIXTURE = {
      ...PDF_FIXTURE_OWNED_BY_SALES,
      lead: null,
      created_by: TEST_USERS.sales.id,
      customer: { first_name: 'Jane', last_name: 'Roe', company_name: null, email: null, phone: '5551234567' },
      service_location: null,
    };

    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(LEAD_LESS_FIXTURE);
    const ownRes = await request(app).get(`/api/estimates/${LEAD_LESS_FIXTURE.id}/pdf`).set(authHeader('sales'));
    expect(ownRes.status).toBe(200);

    mockPrisma.estimate.findUnique.mockResolvedValue({ ...LEAD_LESS_FIXTURE, created_by: TEST_USERS.dispatcher.id });
    const otherRes = await request(app).get(`/api/estimates/${LEAD_LESS_FIXTURE.id}/pdf`).set(authHeader('sales'));
    expect(otherRes.status).toBe(403);
  });

  it('still 404s an unknown estimate id (own-check runs only after the row loads)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/estimates/00000000-0000-0000-0000-000000000000/pdf')
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(generateEstimatePdf).not.toHaveBeenCalled();
  });
});
