import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { CURRENT_PAYMENTS_TERMS_VERSION } from '../lib/legal';
import {
  createConnectedAccount,
  createAccountSession,
  createAccountLink,
  updateAccountStatementDescriptor,
} from '../lib/stripe';
import {
  acceptPaymentsTermsSchema,
  assertPaymentsTermsAccepted,
  PaymentsTermsError,
  toStatementDescriptor,
  updateDescriptorSchema,
} from '../controllers/organization-stripe.controller';

const mockPrisma = prisma as unknown as {
  organization: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  termsAcceptance: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

const mockCreateConnectedAccount = vi.mocked(createConnectedAccount);
const mockCreateAccountSession = vi.mocked(createAccountSession);
const mockCreateAccountLink = vi.mocked(createAccountLink);
const mockUpdateAccountStatementDescriptor = vi.mocked(updateAccountStatementDescriptor);

// Full org select shape connectStripe reads to build the ConnectedAccountPrefill.
const ORG_PREFILL_FIXTURE = {
  id: ALPHA_ORG_ID,
  name: 'Alpha Doors & Security',
  email: 'owner@alphadoors.com',
  website: 'https://alphadoors.com',
  support_email: 'support@alphadoors.com',
  industry: ['HVAC'],
  stripe_account_id: null as string | null,
  phone: '8045551234',
  business_type: 'llc',
  brand_color: '#0C2D3A',
  address_line1: '123 Main St',
  address_line2: null,
  city: 'Richmond',
  state: 'VA',
  postal_code: '23219',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.auditLog.create.mockResolvedValue({});
});

describe('acceptPaymentsTermsSchema', () => {
  it('requires both accepted:true and authority_attested:true', () => {
    expect(acceptPaymentsTermsSchema.safeParse({ accepted: true, authority_attested: true }).success).toBe(true);
    expect(acceptPaymentsTermsSchema.safeParse({ accepted: true, authority_attested: false }).success).toBe(false);
    expect(acceptPaymentsTermsSchema.safeParse({ accepted: false, authority_attested: true }).success).toBe(false);
    expect(acceptPaymentsTermsSchema.safeParse({}).success).toBe(false);
  });
});

describe('POST /api/organization/stripe/accept-terms', () => {
  it('400s without the authority attestation', async () => {
    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: false });
    expect(res.status).toBe(400);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('records an org-level payments_onboarding row (version + fee snapshot + attestation)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ platform_fee_bps: 50 });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 't1' });

    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, terms_version: CURRENT_PAYMENTS_TERMS_VERSION });
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organization_id: ALPHA_ORG_ID,
          context: 'payments_onboarding',
          terms_version: CURRENT_PAYMENTS_TERMS_VERSION,
          disclosed_fee_bps: 50,
          authority_attested: true,
        }),
      }),
    );
  });

  it('is idempotent: a P2002 from the partial unique index still resolves 200 (no re-throw)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ platform_fee_bps: 50 });
    mockPrisma.termsAcceptance.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, terms_version: CURRENT_PAYMENTS_TERMS_VERSION });
  });

  it('surfaces a non-P2002 create failure as 500 rather than swallowing it', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ platform_fee_bps: 50 });
    mockPrisma.termsAcceptance.create.mockRejectedValue(new Error('connection reset'));

    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: true });

    expect(res.status).toBe(500);
  });

  it('404s when the organization row is missing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: true });
    expect(res.status).toBe(404);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });
});

describe('assertPaymentsTermsAccepted — version-aware gate (NOT existence-only)', () => {
  it('throws 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED when no row exists at all', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);

    await expect(assertPaymentsTermsAccepted(ALPHA_ORG_ID)).rejects.toMatchObject({
      status: 403,
      code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED',
    });
    // The gate must query BY current version, not just by org+context — this is
    // what makes it version-aware rather than a copy of the pre-existing
    // existence-only invite-acceptance gate (auth.controller.ts).
    expect(mockPrisma.termsAcceptance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organization_id: ALPHA_ORG_ID,
          context: 'payments_onboarding',
          terms_version: CURRENT_PAYMENTS_TERMS_VERSION,
        },
      }),
    );
  });

  it('does NOT satisfy the gate when only an OLD-version acceptance is on file', async () => {
    // Simulates a real DB where a payments_onboarding row for this org exists, but
    // for a stale version. Keyed off "any non-current version" rather than a
    // hardcoded literal: if the implementation ever queries with a terms_version
    // that isn't CURRENT_PAYMENTS_TERMS_VERSION (wrong constant, stale import, off-
    // by-one bug, ...), the mock still hands back the stale row and the assertion
    // below fails. A mock keyed to one specific literal string couldn't catch that
    // — no realistic regression queries for a hardcoded old-version string.
    //
    // This test intentionally does not cover an implementation that regresses to
    // fully existence-only (omits terms_version from `where` entirely, like the
    // pre-existing invite-acceptance gate) — that class of regression is caught by
    // the exact `where`-shape assertion above (a deep-equality match on all 3 keys,
    // including terms_version, which would fail if the key were dropped).
    mockPrisma.termsAcceptance.findFirst.mockImplementation(
      (args: { where?: { terms_version?: string } }) =>
        Promise.resolve(
          args.where?.terms_version && args.where.terms_version !== CURRENT_PAYMENTS_TERMS_VERSION
            ? { id: 'old-row' }
            : null,
        ),
    );

    await expect(assertPaymentsTermsAccepted(ALPHA_ORG_ID)).rejects.toBeInstanceOf(PaymentsTermsError);
    await expect(assertPaymentsTermsAccepted(ALPHA_ORG_ID)).rejects.toMatchObject({
      status: 403,
      code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED',
    });
  });

  it('resolves without throwing once a CURRENT-version acceptance exists', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'current-row' });
    await expect(assertPaymentsTermsAccepted(ALPHA_ORG_ID)).resolves.toBeUndefined();
  });
});

describe('toStatementDescriptor', () => {
  it('trims and collapses internal whitespace', () => {
    expect(toStatementDescriptor('  Alpha   Doors  ')).toBe('Alpha Doors');
  });

  it('strips disallowed characters < > / \' " *', () => {
    expect(toStatementDescriptor('<Bob\'s "Shop"/>*')).toBe('Bobs Shop');
  });

  it('truncates to at most 22 characters', () => {
    const longName = 'Alpha Doors And Security Services LLC';
    expect(toStatementDescriptor(longName)).toBe(longName.slice(0, 22));
    expect(toStatementDescriptor(longName)!.length).toBe(22);
  });

  it('returns null when the cleaned name is under 5 characters (Stripe collects it instead)', () => {
    expect(toStatementDescriptor('AB')).toBeNull();
  });

  it('returns null when the cleaned name has no letters', () => {
    expect(toStatementDescriptor('12345')).toBeNull();
  });
});

describe('updateDescriptorSchema', () => {
  it('accepts a 5-22 char descriptor with a letter and no disallowed chars', () => {
    expect(updateDescriptorSchema.safeParse({ statement_descriptor: 'ALPHA DOORS' }).success).toBe(true);
  });

  it('rejects under 5 characters', () => {
    expect(updateDescriptorSchema.safeParse({ statement_descriptor: 'AB' }).success).toBe(false);
  });

  it('rejects over 22 characters', () => {
    expect(updateDescriptorSchema.safeParse({ statement_descriptor: 'A'.repeat(23) }).success).toBe(false);
  });

  it('rejects disallowed characters', () => {
    expect(updateDescriptorSchema.safeParse({ statement_descriptor: "Bob's Shop" }).success).toBe(false);
  });

  it('rejects a descriptor with no letters', () => {
    expect(updateDescriptorSchema.safeParse({ statement_descriptor: '12345' }).success).toBe(false);
  });
});

describe('POST /api/organization/stripe/connect', () => {
  it('404s when the organization row is missing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
    expect(mockCreateConnectedAccount).not.toHaveBeenCalled();
  });

  it('short-circuits with the existing id and never calls createConnectedAccount', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_PREFILL_FIXTURE, stripe_account_id: 'acct_existing' });
    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stripe_account_id: 'acct_existing' });
    expect(mockCreateConnectedAccount).not.toHaveBeenCalled();
  });

  it('maps org fields (incl. industry → MCC) into the prefill and claims the new id via race-safe updateMany', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_PREFILL_FIXTURE, stripe_account_id: null });
    mockCreateConnectedAccount.mockResolvedValue({ id: 'acct_new_1' } as never);
    mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stripe_account_id: 'acct_new_1' });
    expect(mockCreateConnectedAccount).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ALPHA_ORG_ID,
      email: 'owner@alphadoors.com',
      businessName: 'Alpha Doors & Security',
      mcc: '1711', // industry: ['HVAC'] → mccForIndustry
      url: 'https://alphadoors.com',
      supportEmail: 'support@alphadoors.com',
      supportPhone: '8045551234',
      brandColorHex: '#0C2D3A',
      businessType: 'company',
      address: { line1: '123 Main St', line2: null, city: 'Richmond', state: 'VA', postal_code: '23219' },
    }));
    expect(mockPrisma.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ALPHA_ORG_ID, stripe_account_id: null },
      data: { stripe_account_id: 'acct_new_1' },
    });
  });

  it('loses the race (updateMany count 0) and returns the winner’s id WITHOUT a second create', async () => {
    mockPrisma.organization.findUnique
      .mockResolvedValueOnce({ ...ORG_PREFILL_FIXTURE, stripe_account_id: null })
      .mockResolvedValueOnce({ stripe_account_id: 'acct_winner' });
    mockCreateConnectedAccount.mockResolvedValue({ id: 'acct_loser' } as never);
    mockPrisma.organization.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stripe_account_id: 'acct_winner' });
    expect(mockCreateConnectedAccount).toHaveBeenCalledTimes(1);
  });

  it('maps a sole-proprietor business_type to individual', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      ...ORG_PREFILL_FIXTURE, stripe_account_id: null, business_type: 'Sole Proprietorship',
    });
    mockCreateConnectedAccount.mockResolvedValue({ id: 'acct_sole' } as never);
    mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });

    await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(mockCreateConnectedAccount).toHaveBeenCalledWith(expect.objectContaining({ businessType: 'individual' }));
  });

  it('leaves businessType null when business_type is unset (Stripe collects it)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      ...ORG_PREFILL_FIXTURE, stripe_account_id: null, business_type: null,
    });
    mockCreateConnectedAccount.mockResolvedValue({ id: 'acct_unset' } as never);
    mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });

    await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(mockCreateConnectedAccount).toHaveBeenCalledWith(expect.objectContaining({ businessType: null }));
  });

  it('500s and never claims when createConnectedAccount throws', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_PREFILL_FIXTURE, stripe_account_id: null });
    mockCreateConnectedAccount.mockRejectedValue(new Error('stripe down'));

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(res.status).toBe(500);
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/organization/stripe/account-session', () => {
  it('403s PAYMENTS_TERMS_ACCEPTANCE_REQUIRED when no terms row exists', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('admin')).send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' });
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('409s once terms are accepted but no stripe_account_id exists yet', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'terms-1' });
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: null });

    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('admin')).send({});

    expect(res.status).toBe(409);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('200s with a fresh client_secret once terms are accepted and an account exists', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'terms-1' });
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: 'acct_1' });
    mockCreateAccountSession.mockResolvedValue('cs_secret_abc');

    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ client_secret: 'cs_secret_abc' });
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1');
  });
});

describe('GET /api/organization/stripe/status', () => {
  it('404s when the organization row is missing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('reflects stripe_charges_enabled (not stripe_account_id presence) and skips the payout-nudge query once payouts are enabled', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      stripe_account_id: 'acct_1', stripe_charges_enabled: true, stripe_payouts_enabled: true,
      stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null,
      platform_fee_bps: 50,
    });

    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stripe_account_id: 'acct_1', stripe_charges_enabled: true, stripe_payouts_enabled: true,
      platform_fee_bps: 50, collected_awaiting_payout: 0,
    });
    expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
  });

  it('sums CARD payments awaiting payout only while charges are enabled and payouts are not', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      stripe_account_id: 'acct_1', stripe_charges_enabled: true, stripe_payouts_enabled: false,
      stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null,
      platform_fee_bps: 50,
    });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 432.1 } });

    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.collected_awaiting_payout).toBe(432.1);
    expect(mockPrisma.payment.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: { invoice: { organization_id: ALPHA_ORG_ID }, method: 'CARD', voided_at: null },
    }));
  });

  it('never queries the payout nudge while stripe_charges_enabled is false, even with a stripe_account_id set', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      stripe_account_id: 'acct_1', stripe_charges_enabled: false, stripe_payouts_enabled: false,
      stripe_details_submitted: false, stripe_requirements_due: ['individual.verification.document'],
      stripe_disabled_reason: 'requirements.past_due', platform_fee_bps: 50,
    });

    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stripe_charges_enabled: false, collected_awaiting_payout: 0 });
    expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
  });
});

describe('POST /api/organization/stripe/account-link', () => {
  it('403s PAYMENTS_TERMS_ACCEPTANCE_REQUIRED when terms are not accepted', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/organization/stripe/account-link').set(authHeader('admin')).send({});
    expect(res.status).toBe(403);
    expect(mockCreateAccountLink).not.toHaveBeenCalled();
  });

  it('409s when there is no stripe_account_id yet', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 't1' });
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: null });
    const res = await request(app).post('/api/organization/stripe/account-link').set(authHeader('admin')).send({});
    expect(res.status).toBe(409);
    expect(mockCreateAccountLink).not.toHaveBeenCalled();
  });

  it('returns the hosted onboarding url, refresh/return both pointed at settings/payments', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 't1' });
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: 'acct_1' });
    mockCreateAccountLink.mockResolvedValue('https://connect.stripe.com/setup/e/acct_1/xyz');

    const res = await request(app).post('/api/organization/stripe/account-link').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://connect.stripe.com/setup/e/acct_1/xyz' });
    expect(mockCreateAccountLink).toHaveBeenCalledWith(
      'acct_1',
      'http://localhost:5173/settings/payments',
      'http://localhost:5173/settings/payments',
    );
  });
});

describe('PATCH /api/organization/stripe/statement-descriptor', () => {
  it('400s on an invalid descriptor before touching Stripe', async () => {
    const res = await request(app)
      .patch('/api/organization/stripe/statement-descriptor')
      .set(authHeader('admin'))
      .send({ statement_descriptor: 'AB' });

    expect(res.status).toBe(400);
    expect(mockUpdateAccountStatementDescriptor).not.toHaveBeenCalled();
  });

  it('409s when ServWave Payments is not connected', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: null });
    const res = await request(app)
      .patch('/api/organization/stripe/statement-descriptor')
      .set(authHeader('admin'))
      .send({ statement_descriptor: 'ALPHA DOORS' });

    expect(res.status).toBe(409);
    expect(mockUpdateAccountStatementDescriptor).not.toHaveBeenCalled();
  });

  it('updates the descriptor on the connected account (no platform prefix)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: 'acct_1' });

    const res = await request(app)
      .patch('/api/organization/stripe/statement-descriptor')
      .set(authHeader('admin'))
      .send({ statement_descriptor: 'ALPHA DOORS' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statement_descriptor: 'ALPHA DOORS' });
    expect(mockUpdateAccountStatementDescriptor).toHaveBeenCalledWith('acct_1', 'ALPHA DOORS');
  });
});

describe('ServWave Payments routes — behavioral 403 (non-ADMIN lacks update-Organization)', () => {
  it('403s DISPATCHER on POST /stripe/connect before any Stripe call or org write', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('dispatcher')).send({});
    expect(res.status).toBe(403);
    expect(mockCreateConnectedAccount).not.toHaveBeenCalled();
    expect(mockPrisma.organization.updateMany).not.toHaveBeenCalled();
  });

  it('403s SALES on POST /stripe/account-session before the terms gate or any Stripe call', async () => {
    mockAuthAs('sales');
    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({});
    expect(res.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('403s DISPATCHER on PATCH /stripe/statement-descriptor', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .patch('/api/organization/stripe/statement-descriptor')
      .set(authHeader('dispatcher'))
      .send({ statement_descriptor: 'ALPHA DOORS' });
    expect(res.status).toBe(403);
    expect(mockUpdateAccountStatementDescriptor).not.toHaveBeenCalled();
  });

  it('does NOT 403 a non-admin role on GET /stripe/status (read-Organization is broadly granted)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.organization.findUnique.mockResolvedValue({
      stripe_account_id: null, stripe_charges_enabled: false, stripe_payouts_enabled: false,
      stripe_details_submitted: false, stripe_requirements_due: [], stripe_disabled_reason: null,
      platform_fee_bps: 50,
    });
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });
});
