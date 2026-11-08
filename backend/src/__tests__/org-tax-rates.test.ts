import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

const mockPrisma = prisma as unknown as {
  orgTaxRate: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  stateTaxRate: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/org-tax-rates', () => {
  it('lists org-scoped custom rates', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([
      { id: 'otr-1', organization_id: TEST_USERS.admin.organization_id, name: 'Hoboken Combined', rate: '0.07125' },
    ]);

    const res = await request(app).get('/api/org-tax-rates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.rates).toHaveLength(1);
    const callArgs = mockPrisma.orgTaxRate.findMany.mock.calls[0][0];
    expect(callArgs.where.organization_id).toBe(TEST_USERS.admin.organization_id);
  });

  it('returns hidden rates too - this is the Settings feed, not the picker feed', async () => {
    // Settings is where an admin switches a hidden state back on, so it must list every row.
    // The picker's own filtering happens in GET /api/state-tax-rates.
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([]);

    await request(app).get('/api/org-tax-rates').set(authHeader('admin'));

    const callArgs = mockPrisma.orgTaxRate.findMany.mock.calls[0][0];
    expect(callArgs.where.is_visible).toBeUndefined();
  });

  it('blocks unauthenticated access', async () => {
    const res = await request(app).get('/api/org-tax-rates');
    expect(res.status).toBe(401);
  });

  it('blocks TECHNICIAN access (no Organization read override, but read IS a default grant — verify SALES-level read still works, technician has read too)', async () => {
    mockAuthAs('technician');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/org-tax-rates').set(authHeader('technician'));
    // TECHNICIAN has `read Organization` as a default grant — this route intentionally reuses
    // that grant, so a technician CAN list (but not write, see below) org tax rates.
    expect(res.status).toBe(200);
  });
});

describe('POST /api/org-tax-rates', () => {
  it('creates a custom rate scoped to the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.create.mockResolvedValue({
      id: 'otr-2', organization_id: TEST_USERS.admin.organization_id, name: 'Hoboken Combined', rate: '0.07125',
    });

    const res = await request(app)
      .post('/api/org-tax-rates')
      .set(authHeader('admin'))
      .send({ name: 'Hoboken Combined', rate: 0.07125 });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.orgTaxRate.create.mock.calls[0][0];
    expect(createArgs.data.organization_id).toBe(TEST_USERS.admin.organization_id);
    expect(createArgs.data.name).toBe('Hoboken Combined');
    expect(createArgs.data.rate).toBe(0.07125);
  });

  it('rejects a rate above 1 (100%)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/org-tax-rates')
      .set(authHeader('admin'))
      .send({ name: 'Bad Rate', rate: 1.5 });
    expect(res.status).toBe(400);
  });

  it('rejects a missing name', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/org-tax-rates')
      .set(authHeader('admin'))
      .send({ rate: 0.07 });
    expect(res.status).toBe(400);
  });

  it('TECHNICIAN cannot create (no update-Organization grant)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/org-tax-rates')
      .set(authHeader('technician'))
      .send({ name: 'Hoboken Combined', rate: 0.07125 });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/org-tax-rates/:id', () => {
  it('updates a rate owned by the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findUnique.mockResolvedValue({
      id: 'otr-3', organization_id: TEST_USERS.admin.organization_id, name: 'Old Name', rate: '0.07',
    });
    mockPrisma.orgTaxRate.update.mockResolvedValue({
      id: 'otr-3', organization_id: TEST_USERS.admin.organization_id, name: 'New Name', rate: '0.075',
    });

    const res = await request(app)
      .patch('/api/org-tax-rates/otr-3')
      .set(authHeader('admin'))
      .send({ name: 'New Name', rate: 0.075 });

    expect(res.status).toBe(200);
    expect(res.body.rate.name).toBe('New Name');
  });

  it('toggles is_visible on its own, without touching name or rate', async () => {
    // The Settings switch sends only this field. It must not have to resend name/rate to flip it.
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findUnique.mockResolvedValue({
      id: 'otr-nj', organization_id: TEST_USERS.admin.organization_id, name: 'New Jersey', rate: '0.066', state_code: 'NJ', is_visible: false,
    });
    mockPrisma.orgTaxRate.update.mockResolvedValue({
      id: 'otr-nj', organization_id: TEST_USERS.admin.organization_id, name: 'New Jersey', rate: '0.066', state_code: 'NJ', is_visible: true,
    });

    const res = await request(app)
      .patch('/api/org-tax-rates/otr-nj')
      .set(authHeader('admin'))
      .send({ is_visible: true });

    expect(res.status).toBe(200);
    expect(res.body.rate.is_visible).toBe(true);
    expect(mockPrisma.orgTaxRate.update.mock.calls[0][0].data).toEqual({ is_visible: true });
  });

  it("404s on a rate belonging to another org (tenantWhere excludes it from findUnique)", async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/org-tax-rates/otr-other-org')
      .set(authHeader('admin'))
      .send({ name: 'Hijack attempt' });

    expect(res.status).toBe(404);
    expect(mockPrisma.orgTaxRate.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/org-tax-rates/:id', () => {
  it('deletes a rate owned by the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findUnique.mockResolvedValue({
      id: 'otr-4', organization_id: TEST_USERS.admin.organization_id, name: 'To Delete', rate: '0.07',
    });
    mockPrisma.orgTaxRate.delete.mockResolvedValue({});

    const res = await request(app).delete('/api/org-tax-rates/otr-4').set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.orgTaxRate.delete).toHaveBeenCalledWith({ where: { id: 'otr-4' } });
  });

  it('404s on a rate belonging to another org', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findUnique.mockResolvedValue(null);

    const res = await request(app).delete('/api/org-tax-rates/otr-other-org').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.orgTaxRate.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/state-tax-rates - the org-owned picker feed (2026-08-05)', () => {
  // This endpoint used to return all 52 global states plus the org's hand-made rates. It now
  // returns the org's OWN list, filtered to the rates the admin chose to show, so a contractor
  // working one state stops scrolling past 51 irrelevant ones.
  const orgId = TEST_USERS.admin.organization_id;

  it('returns only the org rates flagged visible', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([
      { id: 'otr-nj', organization_id: orgId, name: 'New Jersey', rate: '0.066', state_code: 'NJ', is_visible: true },
      { id: 'otr-tx', organization_id: orgId, name: 'Texas', rate: '0.082', state_code: 'TX', is_visible: false },
    ]);

    const res = await request(app).get('/api/state-tax-rates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].state_code).toBe('NJ');
    expect(res.body.data[0].state_name).toBe('New Jersey');
    expect(res.body.data[0].tax_rate).toBe('0.066');
    expect(mockPrisma.stateTaxRate.findMany).not.toHaveBeenCalled();
  });

  it('keeps the CUSTOM-<id> synthetic code for a hand-made rate with no state_code', async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([
      { id: 'otr-5', organization_id: orgId, name: 'Hoboken Combined', rate: '0.07125', state_code: null, is_visible: true },
    ]);

    const res = await request(app).get('/api/state-tax-rates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const custom = res.body.data.find((r: { state_code: string }) => r.state_code === 'CUSTOM-otr-5');
    expect(custom).toBeDefined();
    expect(custom.state_name).toBe('Hoboken Combined');
    expect(custom.tax_rate).toBe('0.07125');
  });

  it('falls back to the global list when the org has no rates at all', async () => {
    // An org created before the backfill would otherwise get an empty picker.
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([]);
    mockPrisma.stateTaxRate.findMany.mockResolvedValue([
      { id: 'st-1', state_code: 'NJ', state_name: 'New Jersey', tax_rate: '0.066' },
    ]);

    const res = await request(app).get('/api/state-tax-rates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].state_code).toBe('NJ');
  });

  it('does NOT fall back when the org has rates but has hidden every one of them', async () => {
    // An org whose `state` is blank ends up here. Falling back would hand it all 52 again and
    // undo the admin's choices, so an empty picker is the honest answer.
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([
      { id: 'otr-nj', organization_id: orgId, name: 'New Jersey', rate: '0.066', state_code: 'NJ', is_visible: false },
    ]);

    const res = await request(app).get('/api/state-tax-rates').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockPrisma.stateTaxRate.findMany).not.toHaveBeenCalled();
  });

  it("scopes the rates to the caller's own org", async () => {
    mockAuthAs('admin');
    mockPrisma.orgTaxRate.findMany.mockResolvedValue([]);
    mockPrisma.stateTaxRate.findMany.mockResolvedValue([]);

    await request(app).get('/api/state-tax-rates').set(authHeader('admin'));

    const callArgs = mockPrisma.orgTaxRate.findMany.mock.calls[0][0];
    expect(callArgs.where.organization_id).toBe(orgId);
  });
});
