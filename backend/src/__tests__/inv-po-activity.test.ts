import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, matchesScopeWhere } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// D7 — GET /api/inventory/purchase-orders/:id/activity returns a REAL timeline
// (replacing the fully-synthesized ActivityTabStub). It merges two truthful
// sources: AuditLog lifecycle verbs (created/updated/received + actor) and the
// historical InventoryEmail rows. ServWave no longer sends POs (Purchasing Audit
// Verdict PR 1), so the mapper no longer special-cases `inventory.po_sent`: a
// legacy audit row with that action renders generically like any other event.
const mockPrisma = prisma as unknown as {
  purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { findMany: ReturnType<typeof vi.fn> };
  inventoryEmail: { findMany: ReturnType<typeof vi.fn> };
};

const PO_ID = 'aaaaaaa5-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/inventory/purchase-orders/:id/activity (D7)', () => {
  it('merges audit lifecycle + historical email rows, renders a legacy po_sent audit generically, sorts chronologically', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue({ id: PO_ID });
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { id: 'aud-created', action: 'inventory.po_created', actor_email: 'buyer@acme.test', metadata: { po_number: 'PO-1', vendor: 'ADI' }, created_at: new Date('2026-02-01T10:00:00Z') },
      // Legacy audit row from before sending was removed — rendered generically.
      { id: 'aud-sent', action: 'inventory.po_sent', actor_email: 'buyer@acme.test', metadata: { po_number: 'PO-1', to: 'sales@adi.test' }, created_at: new Date('2026-02-02T10:00:00Z') },
      { id: 'aud-received', action: 'inventory.po_received', actor_email: 'counter@acme.test', metadata: { po_number: 'PO-1', status: 'partial', lines_received: 2 }, created_at: new Date('2026-02-04T10:00:00Z') },
    ]);
    mockPrisma.inventoryEmail.findMany.mockResolvedValue([
      { id: 'em-1', to: ['sales@adi.test', 'ap@adi.test'], subject: 'PO-1 — ADI', sent_at: new Date('2026-02-02T10:00:05Z') },
    ]);

    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_ID}/activity`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const activity = res.body.activity as { id: string; at: string; kind: string; summary: string; actor: string | null; detail?: string }[];

    // Chronological (created → legacy po_sent audit → email row → received); no special case.
    expect(activity.map((e) => e.kind)).toEqual(['created', 'event', 'email_sent', 'received']);

    const created = activity[0];
    expect(created).toMatchObject({ kind: 'created', summary: 'Purchase order created', actor: 'buyer@acme.test', detail: 'Vendor: ADI' });

    const legacySent = activity[1];
    expect(legacySent).toMatchObject({ kind: 'event', summary: 'inventory.po_sent', actor: 'buyer@acme.test' });

    const email = activity[2];
    expect(email.kind).toBe('email_sent');
    expect(email.summary).toContain('sales@adi.test');
    expect(email.summary).toContain('ap@adi.test');
    expect(email.detail).toBe('PO-1 — ADI');
    expect(email.actor).toBeNull();

    const received = activity[3];
    expect(received).toMatchObject({ kind: 'received', summary: 'Received 2 lines', actor: 'counter@acme.test', detail: 'Status: partial' });
  });

  it('404s when the PO is not in the org, without reading the audit trail', async () => {
    mockAuthAs('admin');
    mockPrisma.purchaseOrder.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/inventory/purchase-orders/${PO_ID}/activity`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('404s on a malformed id via the param guard, before any Prisma read', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/inventory/purchase-orders/not-a-uuid/activity').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});

// #2042 — the same own/other/no-job triple as inv-po.test.ts's list/detail cases, on the
// activity route's own findFirst probe. DEFAULT_GRANTS carries no `read PurchaseOrder` row for
// SALES yet (slice 2), so the job-scoped condition is hand-injected on top of SALES's defaults.
describe('GET /api/inventory/purchase-orders/:id/activity — #2042 scoped to a conditioned read PurchaseOrder grant', () => {
  const OWN_JOB_PO_CONDITION = {
    job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
  };
  const PO_OWN_ID = 'aaaaaaa5-0000-0000-0000-000000000101';
  const PO_OTHER_ID = 'aaaaaaa5-0000-0000-0000-000000000102';
  const PO_NOJOB_ID = 'aaaaaaa5-0000-0000-0000-000000000103';
  const PO_OWN = {
    id: PO_OWN_ID,
    organization_id: TEST_USERS.sales.organization_id,
    job: { estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] } } },
  };
  const PO_OTHER = {
    id: PO_OTHER_ID,
    organization_id: TEST_USERS.sales.organization_id,
    job: { estimate: { lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] } } },
  };
  const PO_NOJOB = { id: PO_NOJOB_ID, organization_id: TEST_USERS.sales.organization_id, job: null };
  const ALL_POS = [PO_OWN, PO_OTHER, PO_NOJOB];

  function mockSalesConditionedPoRead() {
    mockAuthAs('sales');
    const rows = [
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
      { role: 'SALES', action: 'read', subject: 'PurchaseOrder', conditions: OWN_JOB_PO_CONDITION },
    ];
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    clearPermissionCache();
    mockPrisma.purchaseOrder.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const row = ALL_POS.find((p) => p.id === where.id);
      if (!row) return Promise.resolve(null);
      return Promise.resolve(matchesScopeWhere(where, row) ? row : null);
    });
    const anyPrisma = prisma as unknown as { auditLog: { findMany: ReturnType<typeof vi.fn> }; inventoryEmail: { findMany: ReturnType<typeof vi.fn> } };
    anyPrisma.auditLog.findMany.mockResolvedValue([]);
    anyPrisma.inventoryEmail.findMany.mockResolvedValue([]);
  }

  it('other-job 404, no-job 404 — identical body to a random uuid; own-job control 200s', async () => {
    mockSalesConditionedPoRead();

    const other = await request(app).get(`/api/inventory/purchase-orders/${PO_OTHER_ID}/activity`).set(authHeader('sales'));
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: 'Purchase order not found' });

    const noJob = await request(app).get(`/api/inventory/purchase-orders/${PO_NOJOB_ID}/activity`).set(authHeader('sales'));
    expect(noJob.status).toBe(404);
    expect(noJob.body).toEqual({ error: 'Purchase order not found' });

    const own = await request(app).get(`/api/inventory/purchase-orders/${PO_OWN_ID}/activity`).set(authHeader('sales'));
    expect(own.status).toBe(200);
  });
});
