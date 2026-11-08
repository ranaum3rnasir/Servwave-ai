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
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// ════════════════════════════════════════════════════════════════════════
// Issue #233 (audit F-012) — WRITE-PATH leak (same class as the getById /
// list / export fixes). The mutating handlers that respond with a
// `leadDetailSelect`-shaped lead (PATCH /api/leads/:id and
// POST /api/leads/:id/walkthrough) embed estimates { …, total_amount }.
//
// A technician reaches these endpoints WITHOUT a `read Estimate` grant, so the
// response must NOT carry estimate total_amount. The two reach-paths differ post
// Phase B (technician redesign):
//   • POST /api/leads/:id/walkthrough — reached via the strict-default
//     `perform_walkthrough Lead` (OWN_WALKTHROUGH) capability.
//   • PATCH /api/leads/:id — reached ONLY via a per-user `update Lead` (own-scoped)
//     allow override; a strict technician no longer has general `update Lead`.
// The strip is the same ability-driven gate as getById; estimate-readers
// (admin/sales/dispatcher) are unaffected.
// ════════════════════════════════════════════════════════════════════════

const mockPrisma = prisma as unknown as {
  lead: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  // Walkthrough-as-entity redesign, PR-B2: updateWalkthrough now resolves the CURRENT (D15)
  // visit via findCurrentWalkthroughForLead before writing, and wraps its write in a
  // $transaction (dual-writing the Walkthrough row alongside the legacy Lead columns).
  walkthrough: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// Build a FRESH lead carrying an embedded estimate with monetary data on every call.
// The strip mutates the estimate object in place (delete), so each test needs its own
// copy — sharing one module-level object would let the technician test's strip bleed
// into the admin test (a fixture aliasing artifact; production gets a fresh row per query).
const ESTIMATE_TOTAL = '1500.00';
function leadWithEstimate(performerIds: string[] = []) {
  return {
    ...LEAD_FIXTURE,
    // A walkthrough performer (OWN_WALKTHROUGH) is how a TECHNICIAN reaches the walkthrough
    // write path (perform_walkthrough); for the PATCH path the tech is given a per-user
    // `update Lead` (own-scoped) override and is also a lead_assignee (see existingForTechnician).
    visit_assignees: performerIds.map((id) => ({
      user_id: id,
      user: { id, first_name: 'Test', last_name: 'Tech', email: 'tech@test.com' },
    })),
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

// The pre-mutation `existing` lookup (findUnique with assignees/performers includes).
// canAccessRow's scoped findFirst is mocked separately to grant row access.
function existingForTechnician() {
  return {
    ...LEAD_FIXTURE,
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    visit_assignees: [{ user_id: TEST_USERS.technician.id }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  clearUserOverrideCache(); // overrides are keyed by user_id and cached separately from role grants
  (prisma.tagAssignment.findMany as any).mockResolvedValue([]);
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
  // Default: no per-user overrides (resetAllMocks cleared the setup default); tests opt in.
  (prisma.userPermissionOverride.findMany as any).mockResolvedValue([]);
  (prisma.timelineEvent.create as any).mockResolvedValue({});
  // Walkthrough-as-entity redesign, PR-B2: default to "no current visit" so
  // updateWalkthrough's extra Walkthrough-row write is a no-op unless a test opts in.
  (prisma.visit.findMany as any).mockResolvedValue([]);
  // updateWalkthrough now wraps its write in a $transaction — hand the same mocked `prisma`
  // object back as `tx` so mockPrisma.lead.update/walkthrough.update keep working transparently.
  (prisma.$transaction as any).mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
});

describe('POST /api/leads/:id/walkthrough — estimate monetary leak (#233 / F-012, write path)', () => {
  it('strips estimate total_amount for a walkthrough-only TECHNICIAN (no read Estimate grant)', async () => {
    mockAuthAs('technician');
    // existing lookup (with includes) → technician is a walkthrough performer.
    mockPrisma.lead.findUnique.mockResolvedValue(existingForTechnician());
    // canAccessRow scoped findFirst matches (OWN_WALKTHROUGH).
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    // the updated row returned in the response carries an estimate with money.
    mockPrisma.lead.update.mockResolvedValue(leadWithEstimate([TEST_USERS.technician.id]));

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('technician'))
      .send({ walkthrough_notes: 'Replaced capacitor', walkthrough_duration_minutes: 30 });

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates).toHaveLength(1);
    const est = res.body.lead.estimates[0];
    // Non-monetary fields survive.
    expect(est.id).toBe('d0000000-0000-0000-0000-000000000001');
    expect(est.estimate_number).toBe('E00001');
    expect(est.status).toBe('DRAFT');
    // Monetary field MUST be gone.
    expect(est.total_amount).toBeUndefined();
    expect(est.subtotal).toBeUndefined();
    expect(est.tax_amount).toBeUndefined();
  });

  it('keeps estimate total_amount for ADMIN (can read Estimate)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(existingForTechnician());
    mockPrisma.lead.update.mockResolvedValue(leadWithEstimate());

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough`)
      .set(authHeader('admin'))
      .send({ walkthrough_notes: 'Admin note' });

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates[0].total_amount).toBe(ESTIMATE_TOTAL);
  });
});

describe('PATCH /api/leads/:id — estimate monetary leak (#233 / F-012, write path)', () => {
  // Phase B (technician redesign): a strict technician can no longer reach PATCH /api/leads/:id —
  // general `update Lead` is a per-user toggle now. To still exercise the estimate-pricing STRIP on
  // this write path, the technician is given an own-scoped `update Lead` allow override (the route
  // guard then passes; canAccessRow's visibility probe is mocked truthy). The tech still has NO
  // `read Estimate` grant, so the embedded estimate's monetary fields must be stripped.
  it('strips estimate total_amount for a TECHNICIAN granted update Lead but no read Estimate', async () => {
    mockAuthAs('technician');
    // Per-user own-scoped `update Lead` allow override → reaches the PATCH route guard.
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
      { action: 'update', subject: 'Lead', effect: 'allow' },
    ]);
    clearUserOverrideCache(); // a prior test cached this user's (empty) overrides — drop it.
    mockPrisma.lead.findUnique.mockResolvedValue(existingForTechnician());
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });
    mockPrisma.lead.update.mockResolvedValue(leadWithEstimate([TEST_USERS.technician.id]));

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('technician'))
      .send({ service_request: 'AC still not cooling' });

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates).toHaveLength(1);
    const est = res.body.lead.estimates[0];
    expect(est.id).toBe('d0000000-0000-0000-0000-000000000001');
    expect(est.estimate_number).toBe('E00001');
    // Monetary field MUST be gone.
    expect(est.total_amount).toBeUndefined();
    expect(est.subtotal).toBeUndefined();
  });

  it('keeps estimate total_amount for ADMIN (can read Estimate)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue(existingForTechnician());
    mockPrisma.lead.update.mockResolvedValue(leadWithEstimate());

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ service_request: 'AC still not cooling' });

    expect(res.status).toBe(200);
    expect(res.body.lead.estimates[0].total_amount).toBe(ESTIMATE_TOTAL);
  });
});
