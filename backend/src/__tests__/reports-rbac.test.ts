import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

// Issue #234 — Reports gate on the dedicated `read Report` capability (Admin + Dispatcher only).
// Previously the routes gated on `read Estimate`; because SALES holds a `read Estimate` grant,
// Sales reached the reports, contradicting the role spec ("Sales: no global reports").
//
// Policy now enforced:
//   - ADMIN      → allowed (manage all)
//   - DISPATCHER → allowed (has `read Report` grant)
//   - SALES      → 403 (no `read Report` grant; the `read Estimate` grant no longer applies)
//   - TECHNICIAN → 403 (no `read Report` grant)

const mockPrisma = prisma as unknown as {
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
};

const REPORT_PATH = '/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28&model=sent';

describe('Reports RBAC — read Report capability (Admin + Dispatcher only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The report controller calls prisma.estimate.findMany; return an empty set so an
    // authorized request reaches the controller and returns 200 instead of erroring.
    mockPrisma.estimate.findMany.mockResolvedValue([]);
  });

  it('allows ADMIN (manage all) — not 403', async () => {
    mockAuthAs('admin');
    const res = await request(app).get(REPORT_PATH).set(authHeader('admin'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('allows DISPATCHER (has read Report grant) — not 403', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get(REPORT_PATH).set(authHeader('dispatcher'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('forbids SALES (no read Report grant) — 403', async () => {
    mockAuthAs('sales');
    const res = await request(app).get(REPORT_PATH).set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('forbids TECHNICIAN (no read Report grant) — 403', async () => {
    mockAuthAs('technician');
    const res = await request(app).get(REPORT_PATH).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});

describe('Reports RBAC — drill-down endpoint', () => {
  const DRILL_PATH =
    '/api/reports/estimate-conversion/estimates?anchor=sent&from=2026-02-01&to=2026-02-28&outcome=won';

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.estimate.findMany.mockResolvedValue([]);
  });

  it('allows ADMIN (manage all) — not 403', async () => {
    mockAuthAs('admin');
    const res = await request(app).get(DRILL_PATH).set(authHeader('admin'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('allows DISPATCHER — not 403', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get(DRILL_PATH).set(authHeader('dispatcher'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('forbids SALES — 403', async () => {
    mockAuthAs('sales');
    const res = await request(app).get(DRILL_PATH).set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('forbids TECHNICIAN — 403', async () => {
    mockAuthAs('technician');
    const res = await request(app).get(DRILL_PATH).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});

describe('Reports RBAC — AR aging endpoint', () => {
  const AR_PATH = '/api/reports/ar-aging';

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { total_amount: 0 } });
  });

  it('allows ADMIN (manage all) — not 403', async () => {
    mockAuthAs('admin');
    const res = await request(app).get(AR_PATH).set(authHeader('admin'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('allows DISPATCHER — not 403', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get(AR_PATH).set(authHeader('dispatcher'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('forbids SALES — 403', async () => {
    mockAuthAs('sales');
    const res = await request(app).get(AR_PATH).set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('forbids TECHNICIAN — 403', async () => {
    mockAuthAs('technician');
    const res = await request(app).get(AR_PATH).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});
