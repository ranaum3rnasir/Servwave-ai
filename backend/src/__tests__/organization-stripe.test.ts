import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';
import { CURRENT_PAYMENTS_TERMS_VERSION } from '../lib/legal';
import {
  createConnectedAccount,
  createAccountSession,
  createAccountLink,
} from '../lib/stripe';
import {
  acceptPaymentsTermsSchema,
  assertPaymentsTermsAccepted,
  PaymentsTermsError,
  toStatementDescriptor,
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
  payout: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

const mockCreateConnectedAccount = vi.mocked(createConnectedAccount);
const mockCreateAccountSession = vi.mocked(createAccountSession);
const mockCreateAccountLink = vi.mocked(createAccountLink);

// Full org select shape connectStripe reads to build the ConnectedAccountPrefill.
const ORG_PREFILL_FIXTURE = {
  id: ALPHA_ORG_ID,
  name: 'Example Doors & Security',
  email: 'owner@example-company.test',
  website: 'https://example-company.test',
  support_email: 'support@example-company.test',
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

  // Payments go-live slice 03 (D9/D12): the terms the admin accepts now say ServWave charges no
  // payment fee, so the acceptance records the 2026-10-06 terms and a disclosed fee of 0 - even
  // though the org row still carries the retired platform_fee_bps (50 = the old 0.5%).
  it('records the 2026-10-06 payments terms with a disclosed fee of 0, even when the org row still carries a platform fee', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ id: ALPHA_ORG_ID, platform_fee_bps: 50 });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 't1' });

    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, terms_version: '2026-10-06' });
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organization_id: ALPHA_ORG_ID,
          context: 'payments_onboarding',
          terms_version: '2026-10-06',
          disclosed_fee_bps: 0,
          authority_attested: true,
        }),
      }),
    );
    // The audit trail carries the same disclosed fee as the acceptance row.
    await vi.waitFor(() => expect(mockPrisma.auditLog.create).toHaveBeenCalled());
    expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls[0][0])).toContain('"disclosed_fee_bps":0');
  });

  it('still 404s when the organization does not exist (no acceptance row written)', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('admin'))
      .send({ accepted: true, authority_attested: true });

    expect(res.status).toBe(404);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
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
    expect(toStatementDescriptor('  Example   Doors  ')).toBe('Example Doors');
  });

  it('strips disallowed characters < > / \' " *', () => {
    expect(toStatementDescriptor('<Bob\'s "Shop"/>*')).toBe('Bobs Shop');
  });

  it('truncates to at most 22 characters', () => {
    const longName = 'Example Doors And Security Services LLC';
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
    expect(res.body).toEqual({ connected: true });
    expect(mockCreateConnectedAccount).not.toHaveBeenCalled();
  });

  it('maps org fields (incl. industry → MCC) into the prefill and claims the new id via race-safe updateMany', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_PREFILL_FIXTURE, stripe_account_id: null });
    mockCreateConnectedAccount.mockResolvedValue({ id: 'acct_new_1' } as never);
    mockPrisma.organization.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
    expect(mockCreateConnectedAccount).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ALPHA_ORG_ID,
      email: 'owner@example-company.test',
      businessName: 'Example Doors & Security',
      mcc: '1711', // industry: ['HVAC'] → mccForIndustry
      url: 'https://example-company.test',
      supportEmail: 'support@example-company.test',
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
    expect(res.body).toEqual({ connected: true });
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
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1', 'owner');
  });
});

describe('GET /api/organization/stripe/status', () => {
  const connectedRow = {
    stripe_account_id: 'acct_1', stripe_charges_enabled: true, stripe_payouts_enabled: true,
    stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null,
  };

  // The company read every signed-in person holds is NOT a way into the payments status (connected, charges and
  // payouts enabled, requirements due, disabled reason): only the three switches below open it. A person's access
  // is built from switches alone; the stored role grants are no longer read.
  const asSalesWith = (switches: Record<string, boolean>) => {
    mockAuthAs('sales');
    mockRoleSwitches(switches);
    mockPrisma.organization.findUnique.mockResolvedValue(connectedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 't1' });
  };
  const getStatusAsSales = () => request(app).get('/api/organization/stripe/status').set(authHeader('sales'));

  it('answers a user holding only View payments and payouts, with no account identifier', async () => {
    asSalesWith({ view_payments: true });
    const res = await getStatusAsSales();
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('acct_');
  });

  // Until the first payout reaches the bank the payout pages explain the wait; then they confirm it. Read from ServWave's rows.
  it('reports the first payout: waiting with none, on the way while one travels, arrived once one is paid', async () => {
    asSalesWith({ view_payments: true });
    mockPrisma.payout.findFirst.mockResolvedValue(null);
    expect((await getStatusAsSales()).body.first_payout).toEqual({ state: 'waiting' });

    mockPrisma.payout.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ arrival_date: new Date('2026-11-13T00:00:00Z') });
    expect((await getStatusAsSales()).body.first_payout).toEqual({ state: 'on_the_way', arrival_date: '2026-11-13' });

    mockPrisma.payout.findFirst.mockResolvedValueOnce({ arrival_date: new Date('2026-11-06T00:00:00Z') });
    expect((await getStatusAsSales()).body.first_payout).toEqual({ state: 'arrived', arrival_date: '2026-11-06' });
    expect(mockPrisma.payout.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { organization_id: expect.any(String), status: { in: ['PAID'] } },
    }));
  });

  it('answers a user holding only Manage payout account, with no account identifier', async () => {
    asSalesWith({ manage_payout_account: true });
    const res = await getStatusAsSales();
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('acct_');
  });

  // V7-02a: the four verification rows. Stored in organizations.stripe_verification, sent as `verification`.
  const storedVerification = { business_details: 'verified', owner_identity: 'action_needed', bank_account: 'pending', tax_id: 'verified' };

  it('returns verification with exactly the four rows, for a user holding only Manage payout account', async () => {
    asSalesWith({ manage_payout_account: true });
    mockPrisma.organization.findUnique.mockResolvedValue({ ...connectedRow, stripe_verification: { ...storedVerification, stray_key: 'individual.verification.document' } });
    const res = await getStatusAsSales();
    expect(res.status).toBe(200);
    expect(res.body.verification).toEqual(storedVerification);
    expect(Object.keys(res.body.verification).sort()).toEqual(['bank_account', 'business_details', 'owner_identity', 'tax_id']);
    // The column name stays in the database: the browser reads `verification`.
    expect(res.body).not.toHaveProperty('stripe_verification');
    expect(JSON.stringify(res.body)).not.toContain('acct_');
  });

  it('returns verification: null until the first sync', async () => {
    asSalesWith({ manage_payout_account: true });
    mockPrisma.organization.findUnique.mockResolvedValue({ ...connectedRow, stripe_verification: null });
    const res = await getStatusAsSales();
    expect(res.status).toBe(200);
    expect(res.body.verification).toBeNull();
  });

  it('selects the verification column on the status read', async () => {
    asSalesWith({ view_payments: true });
    await getStatusAsSales();
    expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ stripe_verification: true }),
    }));
  });

  it('refuses a user with every payments switch off, who holds only the reads everyone has', async () => {
    asSalesWith({ view_payments: false, manage_payout_account: false });
    const res = await getStatusAsSales();
    expect(res.status).toBe(403);
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the organization row is missing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  // Payments go-live slice 03: the retired org platform fee is no longer shown anywhere, so the
  // status the settings card reads never asks for it and never returns it.
  it('never reads or returns the retired platform fee', async () => {
    mockPrisma.organization.findUnique.mockImplementation(
      async (args: { select: Record<string, boolean> }) => {
        // Answer exactly what was selected, the way the real client does.
        const row: Record<string, unknown> = {
          stripe_account_id: 'acct_1', stripe_charges_enabled: true, stripe_payouts_enabled: true,
          stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null,
          platform_fee_bps: 50,
        };
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
      },
    );

    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, stripe_charges_enabled: true });
    expect(res.body).not.toHaveProperty('platform_fee_bps');
  });

  it('reflects stripe_charges_enabled (not stripe_account_id presence) and skips the payout-nudge query once payouts are enabled', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      stripe_account_id: 'acct_1', stripe_charges_enabled: true, stripe_payouts_enabled: true,
      stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null,
    });

    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
      collected_awaiting_payout: 0,
    });
    expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
  });

  it('sums CARD and online bank payments awaiting payout only while charges are enabled and payouts are not', async () => {
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
      where: {
        invoice: { organization_id: ALPHA_ORG_ID },
        // Cleared online bank debits are collected money too (slice 35); a hand-recorded bank transfer is not, it has no processor payment.
        OR: [{ method: 'CARD' }, { method: 'ACH', stripe_payment_intent_id: { not: null } }],
        voided_at: null, state: 'SUCCEEDED',
      },
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

  // Payments go-live slice 06: the return lands with ?onboarding=return so the settings page
  // re-reads the account status (fail closed) instead of trusting the stored flags.
  it('returns the hosted onboarding url; refresh goes back to settings/servwave-payments, return marks the onboarding return', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 't1' });
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: 'acct_1' });
    mockCreateAccountLink.mockResolvedValue('https://connect.stripe.com/setup/e/acct_1/xyz');

    const res = await request(app).post('/api/organization/stripe/account-link').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://connect.stripe.com/setup/e/acct_1/xyz' });
    expect(mockCreateAccountLink).toHaveBeenCalledWith(
      'acct_1',
      'http://localhost:5173/settings/servwave-payments',
      'http://localhost:5173/settings/servwave-payments?onboarding=return',
      'now',
    );
  });

  // The "add details now" flow: the link also collects what will only be asked for later (a co-owner's details).
  it('collects everything, later items included, when asked to; refuses an unknown setup type', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 't1' });
    mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: 'acct_1' });
    mockCreateAccountLink.mockResolvedValue('https://connect.stripe.com/setup/e/acct_1/xyz');

    const all = await request(app).post('/api/organization/stripe/account-link').set(authHeader('admin')).send({ collect: 'all' });
    expect(all.status).toBe(200);
    expect(mockCreateAccountLink).toHaveBeenLastCalledWith('acct_1', expect.any(String), expect.any(String), 'all');

    mockCreateAccountLink.mockClear();
    const bad = await request(app).post('/api/organization/stripe/account-link').set(authHeader('admin')).send({ collect: 'everything' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Unknown setup type.' });
    expect(mockCreateAccountLink).not.toHaveBeenCalled();
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

  it('403s DISPATCHER on GET /stripe/status: the company read everyone holds does not open the payments status', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
  });
});

// Each payments switch opens its own doors and no others: holding one never opens the other's.
describe('ServWave Payments routes: View payments and Manage payout account are separate doors', () => {
  it('refuses the VIEWER account session to a person holding only Manage payout account', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ manage_payout_account: true, view_payments: false });
    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({ surface: 'viewer' });
    expect(res.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('refuses the OWNER account session to a person holding only View payments and payouts', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ view_payments: true, manage_payout_account: false });
    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({ surface: 'owner' });
    expect(res.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('refuses connect, account-link and accept-terms to a person holding only View payments and payouts', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ view_payments: true, manage_payout_account: false });
    const connect = await request(app).post('/api/organization/stripe/connect').set(authHeader('sales')).send({});
    const link = await request(app).post('/api/organization/stripe/account-link').set(authHeader('sales')).send({});
    const terms = await request(app)
      .post('/api/organization/stripe/accept-terms')
      .set(authHeader('sales'))
      .send({ accepted: true, authority_attested: true });
    expect([connect.status, link.status, terms.status]).toEqual([403, 403, 403]);
    expect(mockCreateConnectedAccount).not.toHaveBeenCalled();
    expect(mockCreateAccountLink).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });
});
