import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, ESTIMATE_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/estimates/:id/history', () => {
  it('returns audit events scoped to this estimate and the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { id: 'al-1', action: 'estimate.sent', resource_type: 'Estimate', resource_id: ESTIMATE_FIXTURE.id, created_at: new Date() },
    ]);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/history`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    const callArgs = mockPrisma.auditLog.findMany.mock.calls[0][0];
    expect(callArgs.where).toEqual({
      org_id: TEST_USERS.admin.organization_id,
      resource_type: 'Estimate',
      resource_id: ESTIMATE_FIXTURE.id,
    });
  });

  it('returns 404 for a non-existent estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/estimates/nonexistent/history')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('SALES cannot view history for another rep\'s estimate (403)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/history`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('blocks unauthenticated access', async () => {
    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}/history`);
    expect(res.status).toBe(401);
  });
});
