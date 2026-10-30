/**
 * Payments go-live slice 16 - the `online_payments` plan entitlement is enforced (PRD call 5).
 *
 * An org whose plan lacks it is told so at setup and cannot start onboarding, and no checkout
 * opens for its documents. Every plan includes the entitlement today (catalog minPlan STARTER), so
 * the org without it is one whose `feature_overrides` switches it off, which is exactly how the
 * change-org-plan flow takes it away.
 *
 * Full-stack route tests: the gate sits in the route chain and in the public checkout handlers,
 * so only a request through the app proves it is wired where it has to be.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { createConnectedAccount, createAccountSession, createAccountLink, createCheckoutSession } from '../lib/stripe';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const WITHOUT_ONLINE_PAYMENTS = { plan: 'PRO', feature_overrides: { online_payments: false } };
const PLAN_MESSAGE = "Online payments aren't included in your plan.";
const VENDOR_NAMES = /stripe|connect\b/i;

const ORG_PREFILL = {
  id: ALPHA_ORG_ID,
  name: 'Test Org',
  email: 'owner@example.test',
  website: null,
  support_email: null,
  industry: [],
  stripe_account_id: null as string | null,
  phone: null,
  business_type: null,
  brand_color: '#242424',
  address_line1: '1 Test Way',
  address_line2: null,
  city: 'Testville',
  state: 'MA',
  postal_code: '02108',
};

beforeEach(() => {
  vi.clearAllMocks();
  // The org's features ride on the cached sign-in; each case brings its own plan.
  clearTokenCache();
  clearPermissionCache();
  p.auditLog.create.mockResolvedValue({});
});

describe('onboarding start, for an org whose plan lacks online payments', () => {
  it('POST /stripe/connect answers 403 with the ServWave message and opens no account', async () => {
    mockAuthAs('admin', WITHOUT_ONLINE_PAYMENTS);
    p.organization.findUnique.mockResolvedValue(ORG_PREFILL);

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'ONLINE_PAYMENTS_NOT_IN_PLAN', error: PLAN_MESSAGE });
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_NAMES);
    expect(createConnectedAccount).not.toHaveBeenCalled();
    expect(p.organization.updateMany).not.toHaveBeenCalled();
  });

  // Fix round 1: the gate covers opening a NEW account only. An org that already has one and then
  // loses the entitlement keeps every remediation step, so it can still supply missing details and
  // get money it already collected paid out ("Fix now" / "Resume setup" open the drawer, which
  // needs terms, account-session and account-link).
  it('POST /stripe/connect for an org that already has an account answers with that account, as before', async () => {
    mockAuthAs('admin', WITHOUT_ONLINE_PAYMENTS);
    p.organization.findUnique.mockResolvedValue({ ...ORG_PREFILL, stripe_account_id: 'acct_plan_gate_started' });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
    expect(createConnectedAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['accept-terms', { accepted: true, authority_attested: true }],
    ['account-session', {}],
    ['account-link', {}],
  ])('POST /stripe/%s stays open for an org with an existing account, so it can fix that account', async (step, body) => {
    mockAuthAs('admin', WITHOUT_ONLINE_PAYMENTS);
    p.organization.findUnique.mockResolvedValue({ ...ORG_PREFILL, stripe_account_id: 'acct_plan_gate_started' });
    p.termsAcceptance.findFirst.mockResolvedValue({ id: 'terms-1' });
    p.termsAcceptance.create.mockResolvedValue({ id: 'terms-2' });
    vi.mocked(createAccountSession).mockResolvedValue('cs_secret_plan_gate' as any);
    vi.mocked(createAccountLink).mockResolvedValue('https://hosted.example.test/link' as any);

    const res = await request(app).post(`/api/organization/stripe/${step}`).set(authHeader('admin')).send(body);

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
  });

  it('GET /stripe/status still answers, so the page can show where the account stands', async () => {
    mockAuthAs('admin', WITHOUT_ONLINE_PAYMENTS);
    p.organization.findUnique.mockResolvedValue({
      stripe_account_id: null, stripe_charges_enabled: false, stripe_payouts_enabled: false,
      stripe_details_submitted: false, stripe_requirements_due: [], stripe_disabled_reason: null,
    });

    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));

    expect(res.status).toBe(200);
  });
});

describe('onboarding start, for an org whose plan includes online payments', () => {
  it('POST /stripe/connect opens the account', async () => {
    mockAuthAs('admin', { plan: 'STARTER', feature_overrides: {} });
    p.organization.findUnique.mockResolvedValue(ORG_PREFILL);
    vi.mocked(createConnectedAccount).mockResolvedValue({ id: 'acct_plan_gate_ok' } as any);
    p.organization.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/api/organization/stripe/connect').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: true });
    expect(createConnectedAccount).toHaveBeenCalledTimes(1);
  });
});

const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-0000000016a1';
const INVOICE_CHECKOUT_URL = `/api/invoices/${INVOICE_ID}/public/checkout?token=tok-plan-gate`;

/** A SENT invoice of $100 whose org's account can take cards and bank payments. */
function payableInvoice(org: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'I01601',
    status: 'SENT',
    kind: 'STANDARD',
    amount_due: 100,
    total_amount: 100,
    estimate: null,
    customer: { first_name: 'Sam', last_name: 'Example', company_name: null },
    job: null,
    organization: {
      id: ALPHA_ORG_ID,
      stripe_account_id: 'acct_plan_gate_live',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      plan: 'STARTER',
      trial_ends_at: null,
      feature_overrides: {},
      ...org,
    },
    payment_methods_override: null,
    payments: [],
  };
}

describe('public invoice checkout and the plan', () => {
  it.each(['card', 'bank'])('an org without online payments opens no %s checkout: 403, nothing sent to the processor', async (method) => {
    p.invoice.findFirst.mockResolvedValue(payableInvoice({ feature_overrides: { online_payments: false } }));

    const res = await request(app).post(INVOICE_CHECKOUT_URL).send({ method });

    expect(res.status).toBe(403);
    // The homeowner is never told about the business's subscription: a neutral code, no "plan".
    expect(res.body.code).toBe('ONLINE_PAYMENT_UNAVAILABLE');
    expect(res.body.error).toBe("Paying online isn't available for this invoice.");
    expect(JSON.stringify(res.body)).not.toMatch(/plan/i);
    expect(JSON.stringify(res.body)).not.toMatch(VENDOR_NAMES);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('an org with online payments opens the checkout', async () => {
    p.invoice.findFirst.mockResolvedValue(payableInvoice());

    const res = await request(app).post(INVOICE_CHECKOUT_URL).send({ method: 'card' });

    expect(res.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
});

describe('public estimate deposit checkout and the plan', () => {
  const ESTIMATE_ID = 'f0000000-0000-0000-0000-000000001601';
  const APPROVE_URL = `/api/estimates/${ESTIMATE_ID}/approve?token=tok-plan-gate-estimate`;

  /** A SENT estimate that requires a $250 deposit, payable by card, bank or check. */
  function depositEstimate(org: Record<string, unknown>) {
    return {
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: 'E01601',
      lead_id: null,
      organization_id: ALPHA_ORG_ID,
      lead: null,
      total_amount: 1000,
      valid_until: new Date('2027-12-31'),
      signature_data: null,
      snapshot_terms: null,
      invoices: [{ id: 'dep-inv-plan-gate', status: 'SENT', total_amount: 250, amount_due: 250 }],
      send_config: { deposit_required: true, payment_methods: ['CARD', 'ACH', 'CHECK'] },
      organization: {
        id: ALPHA_ORG_ID,
        stripe_account_id: 'acct_plan_gate_live',
        stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
        plan: 'STARTER',
        trial_ends_at: null,
        feature_overrides: {},
        ...org,
      },
    };
  }

  it.each(['CARD', 'ACH'])('an org without online payments opens no %s deposit checkout: 403, and the estimate is left as it was', async (method) => {
    p.estimate.findFirst.mockResolvedValue(depositEstimate({ feature_overrides: { online_payments: false } }));

    const res = await request(app)
      .post(APPROVE_URL)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: method });

    expect(res.status).toBe(403);
    // The homeowner is never told about the business's subscription: a neutral code, no "plan".
    expect(res.body).toEqual({ code: 'ONLINE_PAYMENT_UNAVAILABLE', error: "Paying online isn't available for this estimate." });
    expect(JSON.stringify(res.body)).not.toMatch(/plan/i);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(p.estimate.update).not.toHaveBeenCalled();
  });

  it('an org with online payments opens the deposit checkout', async () => {
    p.estimate.findFirst.mockResolvedValue(depositEstimate({}));
    p.estimate.update.mockResolvedValue({ id: ESTIMATE_ID, status: 'PENDING' });

    const res = await request(app)
      .post(APPROVE_URL)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
});
