import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// Feature parking (P0 §C, QA-902 / plan A-18 / D4-D6): RFQs and stock-approvals
// are parked — the routes stay mounted but every verb answers
// 404 {error:'FEATURE_DISABLED', feature} for ANY authenticated caller (incl.
// Admin). Auth still runs first, so no/invalid token stays 401. No handler or
// prisma delegate is ever reached.

const mockPrisma = prisma as unknown as {
  rfq: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  stockApproval: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

const RFQ_ID = 'aaaaaab1-0000-0000-0000-000000000001';
const APPROVAL_ID = 'aaaaaab2-0000-0000-0000-000000000001';

describe('RFQ routes — parked (featureDisabled)', () => {
  const cases: Array<[string, () => request.Test]> = [
    ['GET /api/inventory/rfqs', () => request(app).get('/api/inventory/rfqs')],
    ['POST /api/inventory/rfqs', () => request(app).post('/api/inventory/rfqs').send({ rfqNumber: 'RFQ-1' })],
    [`GET /api/inventory/rfqs/:id`, () => request(app).get(`/api/inventory/rfqs/${RFQ_ID}`)],
    [`PATCH /api/inventory/rfqs/:id`, () => request(app).patch(`/api/inventory/rfqs/${RFQ_ID}`).send({ status: 'winner_picked' })],
  ];

  it.each(cases)('%s → 404 FEATURE_DISABLED for an authenticated admin', async (_name, makeReq) => {
    mockAuthAs('admin');
    const res = await makeReq().set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'rfq' });
    expect(mockPrisma.rfq.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.rfq.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.rfq.create).not.toHaveBeenCalled();
    expect(mockPrisma.rfq.update).not.toHaveBeenCalled();
  });
});

describe('Stock-approval routes — parked (featureDisabled)', () => {
  const cases: Array<[string, () => request.Test]> = [
    ['GET /api/inventory/stock-approvals', () => request(app).get('/api/inventory/stock-approvals')],
    ['POST /api/inventory/stock-approvals', () => request(app).post('/api/inventory/stock-approvals').send({})],
    ['POST /api/inventory/stock-approvals/decide', () => request(app).post('/api/inventory/stock-approvals/decide').send({})],
    [`GET /api/inventory/stock-approvals/:id`, () => request(app).get(`/api/inventory/stock-approvals/${APPROVAL_ID}`)],
  ];

  it.each(cases)('%s → 404 FEATURE_DISABLED for an authenticated admin', async (_name, makeReq) => {
    mockAuthAs('admin');
    const res = await makeReq().set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'stock_approvals' });
    expect(mockPrisma.stockApproval.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.stockApproval.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.stockApproval.create).not.toHaveBeenCalled();
    expect(mockPrisma.stockApproval.updateMany).not.toHaveBeenCalled();
  });
});

describe('guard order preserved', () => {
  it('an unauthenticated request still 401s before the parked-feature 404', async () => {
    const res = await request(app).get('/api/inventory/rfqs');
    expect(res.status).toBe(401);
  });
});
