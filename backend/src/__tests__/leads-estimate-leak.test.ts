import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  LEAD_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ════════════════════════════════════════════════════════════════════════
// Issue #233 (audit F-012): GET /api/leads/:id must NOT leak estimate
// monetary fields (total_amount, …) to a requester who cannot `read Estimate`.
//
// Visibility is ABILITY-driven, never a role literal. A walkthrough-only
// technician can read the lead (OWN_WALKTHROUGH grant) but has NO `read
// Estimate` grant → they may see that an estimate exists (id / number /
// status) but NOT its dollar value. Estimate-readers (sales/dispatcher/admin)
// are unaffected and still receive total_amount.
// ════════════════════════════════════════════════════════════════════════

const mockPrisma = prisma as unknown as {
  lead: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

// Build a FRESH lead carrying an embedded estimate with monetary data on every call.
// The strip mutates the estimate object in place (delete), so each test needs its own copy
// — sharing one module-level object would let the technician test's strip bleed into the
// admin/sales tests (a test-fixture aliasing artifact; production gets a fresh row per query).
const ESTIMATE_TOTAL = '1500.00';
function leadWithEstimate(performerIds: string[] = []) {
  return {
    ...LEAD_FIXTURE,
    // A walkthrough performer (OWN_WALKTHROUGH) is how a TECHNICIAN can read the lead.
    visit_assignees: performerIds.map((id) => ({ user_id: id, user: { id, first_name: 'Test', last_name: 'Tech', email: 'tech@test.com' } })),
    estimates: [
      {
        id: 'd0000000-0000-0000-0000-000000000001',
        estimate_number: 'E00001',
        status: 'DRAFT',
        total_amount: ESTIMATE_TOTAL,
        created_at: new Date('2026-01-16'),
        creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  // Tag enrichment runs on the detail payload; default to no tags.
  (prisma.tagAssignment.findMany as any).mockResolvedValue([]);
  // attachAbility loads grants for non-ADMIN; default empty (mockAuthAs sets role grants).
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
});

describe('GET /api/leads/:id — estimate monetary leak (#233 / F-012)', () => {
  it('strips estimate total_amount for a walkthrough-only TECHNICIAN (no read Estimate grant)', async () => {
    mockAuthAs('technician');
    // findUnique returns the full lead (with monetary estimate); canAccessRow's scoped
    // findFirst matches because the technician is the walkthrough performer (OWN_WALKTHROUGH).
    mockPrisma.lead.findUnique.mockResolvedValue(leadWithEstimate([TEST_USERS.technician.id]));
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates).toHaveLength(1);
    const est = res.body.lead.estimates[0];
    // Non-monetary fields survive — the FE still shows an estimate exists.
    expect(est.id).toBe('d0000000-0000-0000-0000-000000000001');
    expect(est.estimate_number).toBe('E00001');
    expect(est.status).toBe('DRAFT');
    // Monetary field MUST be gone.
    expect(est.total_amount).toBeUndefined();
    // Defensive: any future monetary summary fields must not be present either.
    expect(est.subtotal).toBeUndefined();
    expect(est.tax_amount).toBeUndefined();
    expect(est.discount_amount).toBeUndefined();
  });

  it('keeps estimate total_amount for ADMIN (can read Estimate)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(leadWithEstimate());

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates).toHaveLength(1);
    expect(res.body.lead.estimates[0].total_amount).toBe(ESTIMATE_TOTAL);
  });

  it('keeps estimate total_amount for SALES (owner, can read Estimate)', async () => {
    mockAuthAs('sales');
    // LEAD_FIXTURE is owned by sales (lead_assignees → sales.id); SALES has read Estimate.
    mockPrisma.lead.findUnique.mockResolvedValue(leadWithEstimate());
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates[0].total_amount).toBe(ESTIMATE_TOTAL);
  });
});
