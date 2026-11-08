import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, INVOICE_FIXTURE } from './helpers';
import { clearPermissionCache, setCachedGrants } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// B3-BUG-1 fix — a per-user GRANTED technician (ALLOW `create Invoice`, no role read-Invoice grant)
// can now LIST / GET / EXPORT their OWN job's invoices and is SCOPED OUT of others'. Before the fix,
// `scopeWhereForReq` ignored per-user overrides → MATCH_NOTHING → list/export empty + 403 on the
// invoice they just created. The fix folds the override-implied own-scoped `read Invoice` (the SAME
// OWN_INVOICE_VIA_JOB condition defineAbility materializes) into the SQL scope.
//
// The grant materializes a CONDITIONAL `read Invoice` in the CASL ability (impliesRead) which
// satisfies the bare-subject `canDo('read','Invoice')` route guard → the request reaches the
// controller, where the now-folded SQL scope narrows to job.assignees ∋ me.

// S8 (D6): OWN_JOB reaches crew through the job's trips.
const OWN_INVOICE_SCOPE = { job: { visits: { some: { assignees: { some: { user_id: TEST_USERS.technician.id } } } } } };

const mockPrisma = prisma as unknown as {
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  job: { count: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

function grantTechCreateInvoice() {
  // Bare per-user ALLOW override; defineAbility + scopeWhereForReq look up OWN_INVOICE_VIA_JOB.
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
    { action: 'create', subject: 'Invoice', effect: 'allow' },
  ]);
}

function denyTechCreateInvoice() {
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
    { action: 'create', subject: 'Invoice', effect: 'deny' },
  ]);
}

// Pull the `where` the controller handed to a list/count/findFirst mock.
function whereOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return mock.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  // Neutral list-stats mocks (the scope is what we assert on; the values are irrelevant).
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.invoice.count.mockResolvedValue(0);
  mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: {}, _count: 0 });
  mockPrisma.job.count.mockResolvedValue(0);
});

describe('GET /api/invoices (LIST) — granted-tech own-scope (B3-BUG-1)', () => {
  it('granted tech: list where is scoped to their OWN job invoices (NOT MATCH_NOTHING)', async () => {
    mockAuthAs('technician');
    grantTechCreateInvoice();

    const res = await request(app).get('/api/invoices').set(authHeader('technician'));

    expect(res.status).toBe(200);
    // The folded override read scopes the list to job.assignees ∋ me — not `{ id: { in: [] } }`.
    const where = whereOf(mockPrisma.invoice.findMany);
    expect(where).toMatchObject(OWN_INVOICE_SCOPE);
    expect(where).not.toHaveProperty('id', { in: [] });
  });

  it('strict (un-granted) tech: blocked at the read route guard (403), list never queried', async () => {
    mockAuthAs('technician'); // no override → strict default has no read Invoice

    const res = await request(app).get('/api/invoices').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('DENY override does NOT widen read scope: a deny grantee is still route-guard 403 (no list)', async () => {
    mockAuthAs('technician');
    denyTechCreateInvoice(); // deny create — never synthesizes a read

    const res = await request(app).get('/api/invoices').set(authHeader('technician'));

    // No read materialized → bare `read Invoice` guard fails → 403; list not reached.
    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('ADMIN unchanged: no row-scope restriction (org-wide list)', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/invoices').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = whereOf(mockPrisma.invoice.findMany);
    expect(where).not.toHaveProperty('id', { in: [] });
    expect(where).not.toHaveProperty('job');
    expect(where).not.toHaveProperty('OR');
  });

  it('role-grant user unchanged: a SALES role read grant still drives the list scope', async () => {
    mockAuthAs('sales');
    // SALES holds a persisted org-wide read Invoice grant (role-driven, no override).
    setCachedGrants(TEST_USERS.sales.organization_id, 'SALES', [
      { action: 'read', subject: 'Invoice', conditions: null },
    ]);

    const res = await request(app).get('/api/invoices').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = whereOf(mockPrisma.invoice.findMany);
    // Unconditional role read → no own/team restriction injected by overrides.
    expect(where).not.toHaveProperty('id', { in: [] });
    expect(where).not.toHaveProperty('job');
    expect(where).not.toHaveProperty('OR');
  });
});

describe('GET /api/invoices/export — granted-tech own-scope (B3-BUG-1)', () => {
  it('granted tech: export where is scoped to their OWN job invoices', async () => {
    mockAuthAs('technician');
    grantTechCreateInvoice();

    const res = await request(app).get('/api/invoices/export').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(whereOf(mockPrisma.invoice.findMany)).toMatchObject(OWN_INVOICE_SCOPE);
  });

  it('strict tech: export blocked at the read route guard (403)', async () => {
    mockAuthAs('technician');

    const res = await request(app).get('/api/invoices/export').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/invoices/:id (GET) — granted-tech own-scope via canAccessRow (B3-BUG-1)', () => {
  it('granted tech CAN GET an invoice on a job they are ASSIGNED to (200)', async () => {
    mockAuthAs('technician');
    grantTechCreateInvoice();
    // getById: findUnique returns the invoice; then canAccessRow probes findFirst with the scope.
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });
    // The probe returns a row → it IS within the tech's own-job scope.
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    // canAccessRow probed with the folded own-job scope (NOT MATCH_NOTHING).
    const probeWhere = whereOf(mockPrisma.invoice.findFirst);
    expect(probeWhere).toMatchObject(OWN_INVOICE_SCOPE);
    expect(probeWhere).not.toHaveProperty('id', { in: [] });
  });

  it('granted tech CANNOT GET an invoice on a job they are NOT assigned to (403)', async () => {
    mockAuthAs('technician');
    grantTechCreateInvoice();
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });
    // The scoped probe finds nothing → not their job → canAccessRow false → 403.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    // Still queried with the real own-job scope (the bug-fixed path), not skipped.
    expect(whereOf(mockPrisma.invoice.findFirst)).toMatchObject(OWN_INVOICE_SCOPE);
  });

  it('strict (un-granted) tech: blocked at the read route guard (403), invoice never loaded', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
  });

  it('ADMIN unchanged: canAccessRow fast-path (scope {}) → no findFirst probe, 200', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // ADMIN scope is {} → canAccessRow short-circuits without a probe query.
    expect(mockPrisma.invoice.findFirst).not.toHaveBeenCalled();
  });
});
