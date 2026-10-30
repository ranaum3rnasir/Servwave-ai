import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, mockRoleSwitches, authHeader, attachedInvoiceWhere, JOB_FIXTURE, INVOICE_FIXTURE, ownLeadsInvoiceWhere, creatorInvoiceWhere } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// B3-BUG-1 - a technician who is given View invoices (Attached) can LIST / GET / EXPORT the invoices of the jobs they
// are attached to and is SCOPED OUT of others'. The reach comes from the person's switches (View invoices and the
// Invoices scope), which the SQL scope and the ability both read, so the two agree.

// Attached: an invoice on a job the person is crew, Sold By or Dispatcher of, or a job-less one through its estimate.
const OWN_INVOICE_SCOPE = { OR: attachedInvoiceWhere(TEST_USERS.technician.id) };
// The creator rule adds the invoices the person made, on top of whatever the scope reaches.
const OWN_OR_CREATED = [OWN_INVOICE_SCOPE, creatorInvoiceWhere(TEST_USERS.technician.id)];
const ONLY_CREATED = [creatorInvoiceWhere(TEST_USERS.technician.id)];

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
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

function grantTechViewInvoices() {
  // View invoices is off in the Technician preset; turn it on, reaching the invoices of attached jobs.
  mockRoleSwitches({ view_invoices: true, invoices_scope: 'attached' });
}

// Pull the `where` the controller handed to a list/count/findFirst mock.
function whereOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return mock.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
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
    grantTechViewInvoices();

    const res = await request(app).get('/api/invoices').set(authHeader('technician'));

    expect(res.status).toBe(200);
    // The folded override read scopes the list to job.assignees ∋ me — not `{ id: { in: [] } }`.
    const where = whereOf(mockPrisma.invoice.findMany);
    expect(where.OR).toEqual(OWN_OR_CREATED);
    expect(where).not.toHaveProperty('id', { in: [] });
  });

  it('strict (un-granted) tech: View invoices is off, so the list answers 200 and matches nothing', async () => {
    mockAuthAs('technician'); // the preset has View invoices off

    const res = await request(app).get('/api/invoices').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(whereOf(mockPrisma.invoice.findMany).OR).toEqual(ONLY_CREATED);
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

  it('role user unchanged: Sales keeps the Through own leads reach, nothing extra injected', async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/invoices').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = whereOf(mockPrisma.invoice.findMany);
    // The invoices whose job's estimate's lead has them as an assignee.
    expect(where.OR).toEqual([ownLeadsInvoiceWhere(TEST_USERS.sales.id), creatorInvoiceWhere(TEST_USERS.sales.id)]);
    expect(where).not.toHaveProperty('id', { in: [] });
  });
});

describe('GET /api/invoices/export — granted-tech own-scope (B3-BUG-1)', () => {
  it('granted tech: export where is scoped to their OWN job invoices', async () => {
    mockAuthAs('technician');
    // View invoices and the download (its own switch, Export invoices) are both off in the Technician preset.
    mockRoleSwitches({ view_invoices: true, invoices_scope: 'attached', export_invoices: true });

    const res = await request(app).get('/api/invoices/export').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(whereOf(mockPrisma.invoice.findMany).OR).toEqual(OWN_OR_CREATED);
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
    grantTechViewInvoices();
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
    expect(probeWhere.OR).toEqual(OWN_OR_CREATED);
    expect(probeWhere).not.toHaveProperty('id', { in: [] });
  });

  it('granted tech CANNOT GET an invoice on a job they are NOT assigned to (403)', async () => {
    mockAuthAs('technician');
    grantTechViewInvoices();
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });
    // The scoped probe finds nothing → not their job → canAccessRow false → 403.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    // Still queried with the real own-job scope (the bug-fixed path), not skipped.
    expect(whereOf(mockPrisma.invoice.findFirst).OR).toEqual(OWN_OR_CREATED);
  });

  it('strict (un-granted) tech: blocked at the read route guard (403), invoice never loaded', async () => {
    mockAuthAs('technician');
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_FIXTURE });
    mockPrisma.invoice.findFirst.mockResolvedValue(null); // not an invoice this technician made

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
