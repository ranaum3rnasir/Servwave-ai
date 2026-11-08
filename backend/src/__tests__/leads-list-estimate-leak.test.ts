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
// Issue #233 (audit F-012) — LIST + EXPORT leak (same class as the getById fix).
//
// `leadListSelect` embeds estimates { id, total_amount }, and that select feeds
// BOTH the list handler (GET /api/leads) and the export handler (GET
// /api/leads/export). A walkthrough-only TECHNICIAN can read the lead
// (OWN_WALKTHROUGH grant) but has NO `read Estimate` grant → they must NOT
// receive estimate total_amount in the list JSON or the CSV export.
//
// Visibility is ABILITY-driven, never a role literal. Estimate-readers
// (sales/dispatcher/admin) are unaffected and still receive total_amount.
// ════════════════════════════════════════════════════════════════════════

const mockPrisma = prisma as unknown as {
  lead: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

// Build a FRESH lead carrying an embedded estimate with monetary data on every call.
// The strip mutates the estimate object in place (delete), so each test needs its own
// copy — sharing one module-level object would let the technician test's strip bleed
// into the admin test (a fixture aliasing artifact; production gets a fresh row per query).
const ESTIMATE_TOTAL = '1500.00';
function leadWithEstimate(performerIds: string[] = []) {
  return {
    ...LEAD_FIXTURE,
    // A walkthrough performer (OWN_WALKTHROUGH) is how a TECHNICIAN can read the lead.
    visit_assignees: performerIds.map((id) => ({ user_id: id, user: { id, first_name: 'Test', last_name: 'Tech' } })),
    // leadListSelect embeds only { id, total_amount } per estimate.
    estimates: [
      {
        id: 'd0000000-0000-0000-0000-000000000001',
        total_amount: ESTIMATE_TOTAL,
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  // Tag enrichment runs on the list payload (withTagsMany); default to no tags.
  (prisma.tagAssignment.findMany as any).mockResolvedValue([]);
  // attachAbility loads grants for non-ADMIN; default empty (mockAuthAs sets role grants).
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
  // The list handler fires 6 count queries (total + stats); one resolver covers all.
  mockPrisma.lead.count.mockResolvedValue(1);
});

describe('GET /api/leads — estimate monetary leak in the LIST (#233 / F-012)', () => {
  it('strips estimate total_amount for a walkthrough-only TECHNICIAN (no read Estimate grant)', async () => {
    mockAuthAs('technician');
    // The technician's Lead read-scope resolves to walkthrough_performers.some — the
    // findMany returns the lead because the tech is a walkthrough performer.
    mockPrisma.lead.findMany.mockResolvedValue([leadWithEstimate([TEST_USERS.technician.id])]);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    const est = res.body.leads[0].estimates[0];
    // Non-monetary field survives — the FE still knows an estimate exists.
    expect(est.id).toBe('d0000000-0000-0000-0000-000000000001');
    // Monetary field MUST be gone.
    expect(est.total_amount).toBeUndefined();
  });

  it('keeps estimate total_amount for ADMIN (can read Estimate)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([leadWithEstimate()]);

    const res = await request(app)
      .get('/api/leads')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].estimates[0].total_amount).toBe(ESTIMATE_TOTAL);
  });
});

describe('GET /api/leads/export — estimate monetary leak in the EXPORT (#233 / F-012)', () => {
  it('strips estimate total_amount for a walkthrough-only TECHNICIAN (no read Estimate grant)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findMany.mockResolvedValue([leadWithEstimate([TEST_USERS.technician.id])]);

    const res = await request(app)
      .get('/api/leads/export')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].estimates[0].total_amount).toBeUndefined();
  });

  it('keeps estimate total_amount for ADMIN (can read Estimate)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([leadWithEstimate()]);

    const res = await request(app)
      .get('/api/leads/export')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.leads[0].estimates[0].total_amount).toBe(ESTIMATE_TOTAL);
  });
});
