import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import app from '../app';
import { prisma } from '../lib/prisma';
import { retrieveAccount } from '../lib/stripe';
import { env } from '../config/env';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mockRetrieveAccount = vi.mocked(retrieveAccount);
const mutableEnv = env as unknown as { STRIPE_SECRET_KEY?: string };

// One org row standing in for the database: the refresh writes into it, the status read reads it.
let row: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.STRIPE_SECRET_KEY = 'sk_test_unit';
  row = {
    id: ALPHA_ORG_ID,
    stripe_account_id: 'acct_bogus',
    stripe_charges_enabled: true, // what the old fail-open backfill left behind
    stripe_payouts_enabled: true,
    stripe_details_submitted: true,
    stripe_requirements_due: [],
    stripe_disabled_reason: null,
    platform_fee_bps: 0,
  };
  mockPrisma.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    (where.id === row.id ? { ...row } : null));
  mockPrisma.organization.updateMany.mockImplementation(
    async ({ where, data }: { where: { id: string; stripe_account_id: string }; data: Record<string, unknown> }) => {
      if (where.id !== row.id || where.stripe_account_id !== row.stripe_account_id) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  // Slice 10: the refresh writes in one transaction, under the org row lock.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
});
afterEach(() => {
  delete mutableEnv.STRIPE_SECRET_KEY;
});

describe('POST /api/organization/stripe/refresh-status (return from onboarding)', () => {
  it('re-reads the account and reports "cannot take cards" for a bogus account id', async () => {
    mockAuthAs('admin');
    mockRetrieveAccount.mockRejectedValue(new Stripe.errors.StripePermissionError({
      type: 'invalid_request_error', code: 'account_invalid', message: 'no access to acct_bogus',
    }));

    const res = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockRetrieveAccount).toHaveBeenCalledWith('acct_bogus');
    expect(res.body).toMatchObject({ connected: true, stripe_charges_enabled: false, stripe_payouts_enabled: false });
    expect(row.stripe_charges_enabled).toBe(false);
  });

  it('reports "can take cards" once the account can', async () => {
    mockAuthAs('admin');
    row.stripe_charges_enabled = false;
    mockRetrieveAccount.mockResolvedValue({
      id: 'acct_bogus', charges_enabled: true, payouts_enabled: false, details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    } as unknown as Stripe.Account);

    const res = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stripe_charges_enabled: true, stripe_payouts_enabled: false });
  });

  it('is refused for a role that cannot manage the organization, without calling the processor', async () => {
    mockAuthAs('technician');

    const res = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockRetrieveAccount).not.toHaveBeenCalled();
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });

  describe('the gate is Manage payout account OR update Organization', () => {
    const okAccount = {
      id: 'acct_bogus', charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], disabled_reason: null },
    } as unknown as Stripe.Account;
    const post = () => request(app).post('/api/organization/stripe/refresh-status').set(authHeader('sales'));

    it('a person holding only Manage payout account gets 200 (the embedded form calls this when it closes)', async () => {
      mockAuthAs('sales');
      mockRoleSwitches({ manage_payout_account: true, company_settings: false });
      mockRetrieveAccount.mockResolvedValue(okAccount);
      const res = await post();
      expect(res.status).toBe(200);
      expect(mockRetrieveAccount).toHaveBeenCalledWith('acct_bogus');
    });

    it('a person holding only update Organization still gets 200', async () => {
      mockAuthAs('sales');
      mockRoleSwitches({ manage_payout_account: false, company_settings: true });
      mockRetrieveAccount.mockResolvedValue(okAccount);
      const res = await post();
      expect(res.status).toBe(200);
    });

    it('a person holding neither gets 403 and nothing is read or written', async () => {
      mockAuthAs('sales');
      mockRoleSwitches({ manage_payout_account: false, company_settings: false, view_payments: true });
      const res = await post();
      expect(res.status).toBe(403);
      expect(mockRetrieveAccount).not.toHaveBeenCalled();
      expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
    });
  });

  it('answers with a ServWave error and no vendor name when the refresh itself breaks', async () => {
    mockAuthAs('admin');
    mockPrisma.organization.findUnique.mockRejectedValue(new Error('db down'));

    const res = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/stripe/i);
  });
});
