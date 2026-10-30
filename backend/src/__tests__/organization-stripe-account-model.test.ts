import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// setup.ts mocks ../lib/stripe wholesale. Onboarding start must be exercised with the REAL
// account library so the route proves what reaches the processor; only the processor SDK
// call itself (accounts.create) is stubbed, at the vendor boundary.
vi.unmock('../lib/stripe');

import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { getStripeForOrg } from '../lib/stripe';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

// PRD Module 1 / D13: the controller block and capabilities every new account carries.
const NO_DASHBOARD_CONTROLLER = {
  stripe_dashboard: { type: 'none' },
  fees: { payer: 'account' },
  losses: { payments: 'stripe' },
  requirement_collection: 'stripe',
};
const REQUESTED_CAPABILITIES = {
  card_payments: { requested: true },
  transfers: { requested: true },
  us_bank_account_ach_payments: { requested: true },
};

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

// A one-row in-memory organization table, so the second onboarding start sees whatever the
// first one claimed, exactly as it would against the database.
function useOrgRow(initial: { stripe_account_id: string | null }) {
  const row = {
    id: ALPHA_ORG_ID,
    name: 'Test Garage Doors',
    email: 'owner@test.invalid',
    website: null,
    support_email: null,
    industry: ['HVAC'],
    phone: null,
    business_type: null,
    brand_color: '#242424',
    address_line1: null, address_line2: null, city: null, state: null, postal_code: null,
    ...initial,
  };
  mockPrisma.organization.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === row.id ? { ...row } : null));
  mockPrisma.organization.updateMany.mockImplementation(
    ({ where, data }: { where: { id: string; stripe_account_id: null }; data: { stripe_account_id: string } }) => {
      if (where.id !== row.id || row.stripe_account_id !== null) return Promise.resolve({ count: 0 });
      row.stripe_account_id = data.stripe_account_id;
      return Promise.resolve({ count: 1 });
    });
  return row;
}

const originalKey = (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY;
let accountsCreate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = 'sk_test_dummy';
  mockAuthAs('admin');
  mockPrisma.auditLog.create.mockResolvedValue({});
  const { stripe } = getStripeForOrg({ stripe_account_id: null });
  accountsCreate = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({ id: 'acct_model_1' } as never);
});

afterEach(() => {
  accountsCreate.mockRestore();
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = originalKey;
});

describe('POST /api/organization/stripe/connect: account model on create', () => {
  it('creates exactly one no-dashboard account for an org that has none', async () => {
    useOrgRow({ stripe_account_id: null });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
    expect(accountsCreate).toHaveBeenCalledTimes(1);
    const [params] = accountsCreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params.controller).toEqual(NO_DASHBOARD_CONTROLLER);
    expect(params.capabilities).toEqual(REQUESTED_CAPABILITIES);
    expect(params.metadata).toEqual({ servwave_org_id: ALPHA_ORG_ID });
  });

  it('does not create a second account when onboarding is started again', async () => {
    useOrgRow({ stripe_account_id: null });

    const first = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});
    const second = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(first.body).toEqual({ connected: true });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ connected: true });
    expect(accountsCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps an org that already holds an older account on that account (no re-create)', async () => {
    useOrgRow({ stripe_account_id: 'acct_existing_old_model' });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
    expect(accountsCreate).not.toHaveBeenCalled();
  });
});
