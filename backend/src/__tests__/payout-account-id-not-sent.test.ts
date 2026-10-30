// Payments go-live slice 34 - the processor's account id never reaches the browser (CLAUDE.md: never expose a
// vendor account identifier). Each response says whether the org is connected, as a boolean, and nothing else.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { createConnectedAccount, retrieveAccount } from '../lib/stripe';
import { env } from '../config/env';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const SECRET_ACCOUNT_ID = 'acct_1SecretProcessorId';

const orgRow = (accountId: string | null) => ({
  id: ALPHA_ORG_ID, name: 'Test Org', email: 'o@test.invalid', website: null, support_email: null, industry: ['HVAC'],
  phone: null, business_type: null, brand_color: '#242424',
  address_line1: null, address_line2: null, city: null, state: null, postal_code: null,
  ctm_account_id: null, ctm_sms_ready: false,
  stripe_account_id: accountId, stripe_charges_enabled: true, stripe_payouts_enabled: true,
  stripe_details_submitted: true, stripe_requirements_due: [] as string[], stripe_disabled_reason: null,
});

let row: ReturnType<typeof orgRow>;
const useRow = (accountId: string | null) => {
  row = orgRow(accountId);
  mockPrisma.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === row.id ? { ...row } : null));
  mockPrisma.organization.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(row, data);
    return { count: 1 };
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = 'sk_test_unit';
  mockAuthAs('admin');
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
  vi.mocked(retrieveAccount).mockResolvedValue({
    id: SECRET_ACCOUNT_ID, charges_enabled: true, payouts_enabled: true, details_submitted: true,
    requirements: { currently_due: [], disabled_reason: null },
  } as never);
});

const leaksAnId = (body: unknown) => JSON.stringify(body).includes('acct_');

describe('no processor account id in a response to the browser', () => {
  it('GET /stripe/status says connected: true, with no id', async () => {
    useRow(SECRET_ACCOUNT_ID);
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(leaksAnId(res.body)).toBe(false);
  });

  it('GET /stripe/status says connected: false for an org with no account', async () => {
    useRow(null);
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    expect(res.body.connected).toBe(false);
    expect(leaksAnId(res.body)).toBe(false);
  });

  it('POST /stripe/refresh-status answers with the same shape and no id', async () => {
    useRow(SECRET_ACCOUNT_ID);
    const res = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(leaksAnId(res.body)).toBe(false);
  });

  it('POST /stripe/connect answers connected: true for a new account, with no id', async () => {
    useRow(null);
    vi.mocked(createConnectedAccount).mockResolvedValue({ id: SECRET_ACCOUNT_ID } as never);
    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
  });

  it('POST /stripe/connect answers connected: true for an org that already has one, with no id', async () => {
    useRow(SECRET_ACCOUNT_ID);
    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});
    expect(res.body).toEqual({ connected: true });
  });

  it('GET /api/organization carries stripe_connected and no id', async () => {
    useRow(SECRET_ACCOUNT_ID);
    const res = await request(app).get('/api/organization').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.stripe_connected).toBe(true);
    expect(leaksAnId(res.body)).toBe(false);
  });

  it('carries no processor-named key at all on status, refresh-status or the organization record', async () => {
    useRow(SECRET_ACCOUNT_ID);
    const status = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    const refresh = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));
    const org = await request(app).get('/api/organization').set(authHeader('admin'));
    for (const res of [status, refresh, org]) {
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('stripe_account_id');
    }
  });
});
