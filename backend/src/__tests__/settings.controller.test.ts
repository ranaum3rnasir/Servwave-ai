import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as unknown as {
  organization: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  appSetting: { upsert: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
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

// Payments go-live slice 19 - bank-transfer instructions moved to the organization row, which both
// public pages read. The old per-org settings row must not be a second, silently ignored copy.
describe('/api/settings/bank_transfer_instructions follows the organization column', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthAs('admin');
  });

  it('refuses a write to the old settings row and changes nothing', async () => {
    const res = await request(app)
      .patch('/api/settings/bank_transfer_instructions')
      .set(authHeader('admin'))
      .send({ value: 'Wire to account 123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bank-transfer instructions are saved with the payment settings');
    expect(mockPrisma.appSetting.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });

  it('reads the instructions the public pages show, from the caller org only', async () => {
    mockPrisma.appSetting.findUnique.mockResolvedValue({ organization_id: ALPHA_ORG_ID, key: 'bank_transfer_instructions', value: 'Stale text' });
    mockPrisma.organization.findUnique.mockResolvedValue({ bank_transfer_instructions: 'Current text' });

    const res = await request(app).get('/api/settings/bank_transfer_instructions').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ key: 'bank_transfer_instructions', value: 'Current text' });
    expect(mockPrisma.organization.findUnique.mock.calls[0][0].where).toEqual({ id: ALPHA_ORG_ID });
  });

  it('answers 404 while the org has no instructions', async () => {
    mockPrisma.appSetting.findUnique.mockResolvedValue({ organization_id: ALPHA_ORG_ID, key: 'bank_transfer_instructions', value: 'Stale text' });
    mockPrisma.organization.findUnique.mockResolvedValue({ bank_transfer_instructions: null });

    const res = await request(app).get('/api/settings/bank_transfer_instructions').set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});
