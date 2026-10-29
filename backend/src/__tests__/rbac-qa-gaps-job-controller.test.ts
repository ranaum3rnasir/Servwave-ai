import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// ─────────────────────────────────────────────────────────────────────────────
// RBAC QA gaps in job.controller.ts found by the security QA of PR #253
// (md_files/specs/permissions/QA-SCENARIO-MATRIX.md). One vertical slice per gap:
//
//   GAP-3 — getStats counts use tenantWhere ONLY (no scopeWhereForReq), so a row-scoped
//           role (TECHNICIAN/SALES) gets ORG-WIDE job counts. Fix: scope the counts with
//           the SAME grant-driven rowScope the list endpoint uses.
//
//   GAP-1 — canAccessJob (the per-instance gate for getById/getNotes/addNote/getTimeline)
//           short-circuits ADMIN||DISPATCHER → true and ignores the CASL ability/override
//           engine, so any non-default Job read-scope (a narrowed DISPATCHER read grant, or a
//           future per-user DENY) is silently ignored. Fix: make it canAccessRow-driven.
//
//   GAP-5 — cancel() returns collected_total/refund_suggested at the TOP LEVEL (outside the
//           presentJobDetail pricing strip) AND writes collected_total into timeline metadata
//           which getTimeline returns RAW — leaking money to a pricing-restricted role
//           (technician). Fix: gate both behind the same read-Invoice pricing check.
// ─────────────────────────────────────────────────────────────────────────────

const mockPrisma = prisma as unknown as {
  job: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = JOB_FIXTURE.id;

// Recursively collect whether any node in the where tree carries `key` (e.g. the OWN_JOB
// ownership relation `assignees`) — lets us assert the row-scope reached the count `where`.
function deepHas(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => deepHas(n, key));
  if (node && typeof node === 'object') {
    if (key in (node as Record<string, unknown>)) return true;
    return Object.values(node as Record<string, unknown>).some((v) => deepHas(v, key));
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ─── GAP-3 — GET /api/jobs/stats scopes counts to the requester ──────────────
describe('GET /api/jobs/stats — counts are row-scoped, not org-wide (GAP-3)', () => {
  beforeEach(() => {
    mockPrisma.job.count.mockResolvedValue(0);
  });

  it('TECHNICIAN: every status count `where` carries the OWN_JOB row-scope (not just tenantWhere)', async () => {
    mockAuthAs('technician');
    // TECHNICIAN default role read Job = OWN_JOB (assignees.some.user_id === me).
    // (mockAuthAs already loads the default grants; this is the conditional read scopeWhereForReq derives.)

    const res = await request(app).get('/api/jobs/stats').set(authHeader('technician'));

    expect(res.status).toBe(200);
    // Five per-status counts (S4 D17 retired EN_ROUTE/ON_SITE); EACH must be scoped to the
    // requester's own jobs.
    expect(mockPrisma.job.count).toHaveBeenCalledTimes(5);
    for (const call of mockPrisma.job.count.mock.calls) {
      const where = call[0].where as Record<string, unknown>;
      // org filter still present…
      expect(where.organization_id).toBe(TEST_USERS.technician.organization_id);
      // …AND the OWN_JOB ownership relation is folded in (the leak fix).
      expect(deepHas(where, 'assignees')).toBe(true);
    }
  });

  it('ADMIN: counts stay org-wide (no row-scope restriction)', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/jobs/stats').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.count).toHaveBeenCalledTimes(5);
    for (const call of mockPrisma.job.count.mock.calls) {
      const where = call[0].where as Record<string, unknown>;
      expect(where.organization_id).toBe(TEST_USERS.admin.organization_id);
      // ADMIN → scopeWhereForReq returns {} → NO ownership relation, NO match-nothing id filter.
      expect(deepHas(where, 'assignees')).toBe(false);
      expect(deepHas(where, 'id')).toBe(false);
    }
  });
});

// ─── GAP-1 — getById ownership gate honors the grant scope, not a role literal ─
describe('GET /api/jobs/:id — per-instance gate is grant/override-aware (GAP-1)', () => {
  // The 4 endpoints that gate on canAccessJob (getById/getNotes/addNote/getTimeline) selected only
  // the ownership relations; the fixed canAccessRow re-derives visibility via a scoped findFirst.
  const ACCESS_SELECT_FOREIGN = {
    assignees: [{ user_id: '99999999-9999-9999-9999-999999999999' }], // NOT the requester
    estimate: { lead: { lead_assignees: [{ user_id: '99999999-9999-9999-9999-999999999999' }] } },
  };
  const ACCESS_SELECT_OWN_TECH = {
    assignees: [{ user_id: TEST_USERS.technician.id }],
    estimate: { lead: { lead_assignees: [] } },
  };

  it('DISPATCHER with a NARROWED (own-only) read Job grant is 403 on a FOREIGN job', async () => {
    mockAuthAs('dispatcher');
    // Org narrows the DISPATCHER read-Job grant to OWN_JOB (no longer the unconditional default).
    // Route guard canDo('read','Job') still passes (bare-subject: a conditional `can` exists),
    // so enforcement falls entirely to the per-instance gate — which must now be scope-driven.
    setCachedGrants(TEST_USERS.dispatcher.organization_id, 'DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    // 1st findUnique = the access-check projection (relations only). The fixed canAccessRow then
    // issues a SCOPED findFirst that returns null for a job the dispatcher does not own → 403.
    mockPrisma.job.findUnique.mockResolvedValue(ACCESS_SELECT_FOREIGN);
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    // Old role-literal canAccessJob → ADMIN||DISPATCHER → true → 200 LEAK. Fixed → 403.
    expect(res.status).toBe(403);
  });

  it('DISPATCHER with a NARROWED read Job grant still sees their OWN job', async () => {
    mockAuthAs('dispatcher');
    setCachedGrants(TEST_USERS.dispatcher.organization_id, 'DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    mockPrisma.job.findUnique
      .mockResolvedValueOnce({ assignees: [{ user_id: TEST_USERS.dispatcher.id }], estimate: { lead: { lead_assignees: [] } } })
      .mockResolvedValueOnce({ ...JOB_FIXTURE }); // the full jobDetailSelect fetch
    // canAccessRow's scoped findFirst matches the owned row.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  it('ADMIN still passes (manage all → unconditional, no scoped query)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(ACCESS_SELECT_FOREIGN) // access-check projection
      .mockResolvedValueOnce({ ...JOB_FIXTURE }); // full detail

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('own-assigned TECHNICIAN (default OWN_JOB read) still passes', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(ACCESS_SELECT_OWN_TECH) // access-check projection
      .mockResolvedValueOnce({ ...JOB_FIXTURE }); // full detail
    // canAccessRow scoped findFirst matches the tech's own job.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
  });

  it('FOREIGN job → TECHNICIAN still 403 (own-scope unchanged)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue(ACCESS_SELECT_FOREIGN);
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/jobs/${JOB_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});

// ─── GAP-5 — money does not leak via timeline metadata / cancel response ──────
describe('GET /api/jobs/:id/timeline — $ metadata redacted for non-pricing readers (GAP-5)', () => {
  // A CANCELLED event whose metadata cancel() persisted carries collected_total (a money figure)
  // plus non-money fields that must survive the redaction.
  const CANCELLED_EVENT = {
    id: 'ev-cancel',
    event_type: 'CANCELLED',
    description: 'Job J00001 cancelled',
    metadata: { reason: 'Customer cancelled', collected_total: 300, voided_invoice_ids: ['inv-1'] },
    created_at: new Date('2026-03-01'),
    creator: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
  };

  it('TECHNICIAN (own job, no read Invoice) does NOT receive collected_total in timeline metadata', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    // Own job → passes the (fixed) per-instance gate.
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockPrisma.timelineEvent.findMany.mockResolvedValue([{ ...CANCELLED_EVENT }]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/timeline`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    const ev = res.body.events[0];
    // The money figure is stripped…
    expect(ev.metadata.collected_total).toBeUndefined();
    // …but the non-money context survives (so the tech still sees WHY/WHAT was cancelled).
    expect(ev.metadata.reason).toBe('Customer cancelled');
    expect(ev.metadata.voided_invoice_ids).toEqual(['inv-1']);
  });

  it('ADMIN (read Invoice) sees collected_total in timeline metadata raw', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    // Spec B2 N6 — ADMIN can see pricing, so getTimeline also queries this job's invoices.
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([{ ...CANCELLED_EVENT }]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/timeline`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events[0].metadata.collected_total).toBe(300);
  });
});

describe('POST /api/jobs/:id/cancel — money fields gated behind pricing visibility (GAP-5)', () => {
  // Cancel cascade tx wiring (mirrors jobs.test.ts wireCancelTx).
  function wireCancelTx(updated: Record<string, unknown>) {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        job: { update: vi.fn().mockResolvedValue(updated) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        // Inventory P1 (§4.2): cancel's auto-return pass — nothing SYNCED in these flows.
        jobLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        invoiceLineItem: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
        // S4 (D19): job cancel cascades onto its live visits inside this same transaction.
        visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
  }

  const CANCELLABLE_WITH_COLLECTED = {
    ...JOB_FIXTURE,
    status: 'IN_PROGRESS',
    invoices: [
      { id: 'inv-open-1', status: 'SENT', kind: 'STANDARD', amount_due: 700, total_amount: 1000, payments: [{ amount: 300, reference_number: null }], refunds: [] },
    ],
  };

  it('DISPATCHER narrowed to NO read Invoice does NOT get collected_total/refund_suggested in the cancel response', async () => {
    mockAuthAs('dispatcher');
    // Org keeps DISPATCHER's cancel + read Job but REMOVES read Invoice (a valid narrowing). The
    // cancel route guard (canDo('cancel','Job')) still passes; the money fields must be gated.
    setCachedGrants(TEST_USERS.dispatcher.organization_id, 'DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: null },
      { action: 'cancel', subject: 'Job', conditions: null },
    ]);
    mockPrisma.job.findUnique.mockResolvedValue(CANCELLABLE_WITH_COLLECTED);
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/cancel`)
      .set(authHeader('dispatcher'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    // Money fields withheld for a non-pricing role…
    expect(res.body.collected_total).toBeUndefined();
    expect(res.body.refund_suggested).toBeUndefined();
    // …non-money operational result still returned.
    expect(res.body.voided_invoice_ids).toEqual(['inv-open-1']);
  });

  it('ADMIN still gets collected_total/refund_suggested at the top level of the cancel response', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(CANCELLABLE_WITH_COLLECTED);
    wireCancelTx({ ...JOB_FIXTURE, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/jobs/${JOB_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.collected_total).toBe(300);
    expect(res.body.refund_suggested).toBe(true);
  });
});
