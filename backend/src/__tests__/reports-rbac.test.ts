import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleSwitches, authHeader } from './helpers';

// Issue #234 — Reports gate on the dedicated `read Report` capability, never on `read Estimate`
// (SALES holds that one and must not reach the reports).
//
// Roles & Permissions S01.14 — that capability is what the "Access Reports" switch compiles into, so
// the built-in presets decide who has it and a stored switch value can move it:
//   - ADMIN      → allowed (manage all)
//   - DISPATCHER → refused by preset (Access Reports off), allowed once the role holds the switch
//   - SALES      → 403 (preset off; the `read Estimate` grant never applied)
//   - TECHNICIAN → 403 (preset off)

const mockPrisma = prisma as unknown as {
  estimate: { findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
};

const REPORT_PATH = '/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28&model=sent';

describe('Reports RBAC — read Report capability (the Access Reports switch)', () => {
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

  it('forbids DISPATCHER by preset (Access Reports off) — 403', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get(REPORT_PATH).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });

  it('allows DISPATCHER once the role holds Access Reports — not 403', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_reports: true });
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

  it('allows DISPATCHER holding Access Reports — not 403', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_reports: true });
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

  it('allows DISPATCHER holding Access Reports — not 403', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_reports: true });
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

  // Roles & Permissions S07.20 - the unpaid-invoices endpoint is shared by Billing and Reports: either switch lets a
  // person in, neither does not.
  it('allows DISPATCHER holding Access Billing alone — not 403', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_billing: true, access_reports: false });
    const res = await request(app).get(AR_PATH).set(authHeader('dispatcher'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('allows DISPATCHER holding Access Reports alone — not 403', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_billing: false, access_reports: true });
    const res = await request(app).get(AR_PATH).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });

  it('forbids DISPATCHER holding neither Access Billing nor Access Reports — 403', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_billing: false, access_reports: false });
    const res = await request(app).get(AR_PATH).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });

  it('does not read the base role: the same Access Billing switch opens it on a SALES base', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ access_billing: true });
    const res = await request(app).get(AR_PATH).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });
});

describe('Reports RBAC — Access Billing opens the unpaid-invoices endpoint and nothing else', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.estimate.findMany.mockResolvedValue([]);
  });

  it.each([
    '/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28&model=sent',
    '/api/reports/jobs',
    '/api/reports/revenue',
    '/api/reports/payments',
    '/api/reports/invoices',
  ])('forbids DISPATCHER holding Access Billing alone on %s — 403', async (path) => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ access_billing: true, access_reports: false });
    const res = await request(app).get(path).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });
});
