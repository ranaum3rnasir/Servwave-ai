import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as unknown as {
  organization: { update: ReturnType<typeof vi.fn> };
  appSetting: { upsert: ReturnType<typeof vi.fn> };
};

describe('PATCH /api/settings/:key — updateByKey', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthAs('admin');
    mockPrisma.organization.update.mockResolvedValue({
      id: ALPHA_ORG_ID,
      deposit_default_percentage: 25,
    });
    mockPrisma.appSetting.upsert.mockResolvedValue({
      organization_id: ALPHA_ORG_ID,
      key: 'some_key',
      value: 'some_value',
    });
  });

  // ── Behavior 1: deposit_percentage routes to the org column ─────────────
  it('writes deposit_default_percentage to the org row and returns 200', async () => {
    const res = await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: '25' });

    expect(res.status).toBe(200);
    expect(mockPrisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ALPHA_ORG_ID },
        data: { deposit_default_percentage: 25 },
      })
    );
  });

  it('returns a body compatible with { data: { key, value } }', async () => {
    const res = await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: '25' });

    expect(res.body.data).toBeDefined();
    expect(res.body.data.key).toBe('deposit_percentage');
    expect(res.body.data.value).toBe('25');
  });

  // ── Behavior 2: AppSetting NOT touched for deposit_percentage ────────────
  it('does NOT upsert an AppSetting row for deposit_percentage', async () => {
    await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: '40' });

    expect(mockPrisma.appSetting.upsert).not.toHaveBeenCalled();
  });

  // ── Behavior 3: Validation — 400 on bad values ───────────────────────────
  it('returns 400 for a non-numeric value', async () => {
    const res = await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: 'abc' });

    expect(res.status).toBe(400);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });

  it('returns 400 when value > 100', async () => {
    const res = await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: '150' });

    expect(res.status).toBe(400);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });

  it('returns 400 when value < 0', async () => {
    const res = await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: '-5' });

    expect(res.status).toBe(400);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });

  // ── Behavior 4: Other keys still use AppSetting (regression guard) ───────
  it('upserts AppSetting for keys other than deposit_percentage', async () => {
    mockPrisma.appSetting.upsert.mockResolvedValue({
      organization_id: ALPHA_ORG_ID,
      key: 'estimate_terms',
      value: 'Net 30',
    });

    const res = await request(app)
      .patch('/api/settings/estimate_terms')
      .set(authHeader('admin'))
      .send({ value: 'Net 30' });

    expect(res.status).toBe(200);
    expect(mockPrisma.appSetting.upsert).toHaveBeenCalled();
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });

  // ── Behavior 5: Tenant isolation ─────────────────────────────────────────
  it('scopes the org update to the caller org, not another org', async () => {
    await request(app)
      .patch('/api/settings/deposit_percentage')
      .set(authHeader('admin'))
      .send({ value: '30' });

    const call = mockPrisma.organization.update.mock.calls[0][0];
    expect(call.where.id).toBe(ALPHA_ORG_ID);
    expect(call.where.id).not.toBe(ORG_B_ID);
  });
});
