/**
 * Payments go-live slice 19 - the payment options through the routes that read and write them.
 *
 * The settings and document APIs store the new fields; the public invoice payload and the
 * checkout door answer through the resolver (lib/payment-options.ts). The prisma mock here is a
 * small row store that HONOURS `select`, so a field the API forgets to read back does not
 * round-trip: what the test sees is what the route actually selected.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ESTIMATE_SENT_FIXTURE } from './helpers';
import { isStripeConfigured, createCheckoutSession } from '../lib/stripe';

type Row = Record<string, unknown>;

/**
 * Applies a Prisma `select` to a stored row (one level deep is all these routes need here). A
 * relation selected with its own select (the public payload's payments) comes back as stored.
 */
function pick(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if ((v === true || typeof v === 'object') && k in row) out[k] = row[k];
  }
  return out;
}

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

/** The account can take bank payments: ACH sits in the server-owned accepted list (slice 19). */
const ACH_LISTED = { accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER', 'ACH'] };

function storedOrg(overrides: Row = {}): Row {
  return {
    id: ALPHA_ORG_ID,
    name: 'Harbor Locksmiths LLC',
    stripe_account_id: 'acct_options_test',
    stripe_charges_enabled: true,
    accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER'],
    tips_enabled: false,
    tip_presets: [10, 15, 20],
    deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
    bank_transfer_instructions: null,
    ctm_account_id: null,
    ctm_sms_ready: false,
    ...overrides,
  };
}

describe('Settings API: org payment defaults round-trip', () => {
  let org: Row;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    org = storedOrg();
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockPrisma.organization.findUnique.mockImplementation(({ select }: { select?: Row }) => Promise.resolve(pick(org, select)));
    mockPrisma.organization.update.mockImplementation(({ data, select }: { data: Row; select?: Row }) => {
      org = { ...org, ...data };
      return Promise.resolve(pick(org, select));
    });
  });

  it('saves tips, presets, deposit policy and bank-transfer instructions, and reads them back', async () => {
    const instructions = 'Wire to account 000123, routing 000000. Recording the transfer stays manual.';
    const save = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ tips_enabled: true, tip_presets: [5, 12, 18], deposit_policy: 'PAY_LATER', bank_transfer_instructions: instructions });
    expect(save.status).toBe(200);

    const read = await request(app).get('/api/organization').set(authHeader('admin'));
    expect(read.status).toBe(200);
    expect({
      tips_enabled: read.body.tips_enabled,
      tip_presets: read.body.tip_presets,
      deposit_policy: read.body.deposit_policy,
      bank_transfer_instructions: read.body.bank_transfer_instructions,
    }).toEqual({ tips_enabled: true, tip_presets: [5, 12, 18], deposit_policy: 'PAY_LATER', bank_transfer_instructions: instructions });
  });

  it('existing orgs read the defaults: tips off, 10/15/20, deposit required before approval', async () => {
    const read = await request(app).get('/api/organization').set(authHeader('admin'));
    expect([read.body.tips_enabled, read.body.tip_presets, read.body.deposit_policy]).toEqual([
      false, [10, 15, 20], 'REQUIRED_BEFORE_APPROVAL',
    ]);
  });

  it('blank bank-transfer instructions clear them', async () => {
    org = storedOrg({ bank_transfer_instructions: 'Old text' });
    const save = await request(app).patch('/api/organization').set(authHeader('admin')).send({ bank_transfer_instructions: '   ' });
    expect(save.status).toBe(200);
    expect(org.bank_transfer_instructions).toBeNull();
  });

  // Each case names the field and the message, so a 400 for "unknown key" (the schema is strict)
  // can never stand in for the rule under test.
  it.each([
    ['two presets', { tip_presets: [10, 15] }, 'tip_presets', 'Set exactly three tip presets'],
    ['four presets', { tip_presets: [5, 10, 15, 20] }, 'tip_presets', 'Set exactly three tip presets'],
    ['a 0% preset', { tip_presets: [0, 15, 20] }, 'tip_presets.0', 'Tip presets must be between 1% and 50%'],
    ['a 51% preset', { tip_presets: [10, 15, 51] }, 'tip_presets.2', 'Tip presets must be between 1% and 50%'],
    ['a fractional preset', { tip_presets: [10, 12.5, 20] }, 'tip_presets.1', 'Tip presets must be whole percentages'],
    ['an unknown deposit policy', { deposit_policy: 'NEVER' }, 'deposit_policy',
      "Invalid enum value. Expected 'REQUIRED_BEFORE_APPROVAL' | 'PAY_LATER', received 'NEVER'"],
    ['tips on/off as a string', { tips_enabled: 'yes' }, 'tips_enabled', 'Expected boolean, received string'],
  ])('refuses %s with a 400 naming the field, and saves nothing', async (_name, body, field, message) => {
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send(body);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message }]);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });
});

describe('Settings API: ACH is server-owned in the accepted methods', () => {
  let org: Row;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockPrisma.organization.findUnique.mockImplementation(({ select }: { select?: Row }) => Promise.resolve(pick(org, select)));
    mockPrisma.organization.update.mockImplementation(({ data, select }: { data: Row; select?: Row }) => {
      org = { ...org, ...data };
      return Promise.resolve(pick(org, select));
    });
  });

  it('drops a client-sent ACH while the account has no ACH capability', async () => {
    org = storedOrg();
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ accepted_payment_methods: ['ACH', 'CHECK'] });
    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['CHECK', 'CARD']);
  });

  it('keeps ACH when the account can take bank payments, whether or not a save lists it', async () => {
    org = storedOrg(ACH_LISTED);
    const listed = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ accepted_payment_methods: ['ACH', 'CHECK'] });
    expect(listed.body.accepted_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);

    // ACH is a capability fact, not the owner's switch (that is bank_offered_by_default).
    const left = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CHECK'] });
    expect(left.body.accepted_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);
  });

  // Payments go-live slice 16 (slice 10 review): a save asks the account sync's own rule, so while
  // charges are off it keeps neither CARD nor ACH, exactly as the sync writes the list. This used to
  // keep both (slice 19 fix round 1), because the webhook's accepted-methods gate keyed on CARD and a
  // dropped CARD meant later money events were never recorded. That gate is gone: slice 16 pins
  // that refunds and disputes are recorded for an org without CARD
  // (methods-gate-skips-payment-events-db.test.ts). The sync never stores CARD or ACH with charges
  // off, so this only tidies a row written before slice 10.
  it('keeps neither CARD nor ACH on a save while card payments are off, as the account sync does', async () => {
    org = storedOrg({ ...ACH_LISTED, stripe_charges_enabled: false });
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CASH'] });
    expect(res.body.accepted_payment_methods).toEqual(['CASH']);
  });

  it('a save while card payments are off stores what the sync would have stored', async () => {
    org = storedOrg({ stripe_charges_enabled: false, accepted_payment_methods: ['CARD', 'CHECK'] });
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CHECK', 'VENMO'] });
    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['CHECK', 'VENMO']);
    expect(org.accepted_payment_methods).toEqual(['CHECK', 'VENMO']);
  });
});

// ─── The public invoice payload carries the resolved options ─────────────────

const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-000000000019';
const TOKEN = 'pay19-public-token';

function publicInvoice(overrides: Row = {}): Row {
  return {
    id: INVOICE_ID,
    invoice_number: 'INV-1901',
    organization_id: ALPHA_ORG_ID,
    status: 'SENT',
    subtotal: 1000,
    discount_amount: 0,
    tax_amount: 87.5,
    deposit_credit: 0,
    total_amount: 1087.5,
    amount_due: 1087.5,
    due_date: null,
    sent_at: new Date('2026-10-01'),
    paid_at: null,
    created_at: new Date('2026-10-01'),
    kind: 'STANDARD',
    estimate: null,
    customer: { first_name: 'Pat', last_name: 'Payer', company_name: null },
    line_items: [],
    job: null,
    payments: [],
    payment_methods_override: null,
    allow_partial_payment: null,
    ...overrides,
  };
}

const mockPublic = prisma as unknown as {
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

describe('GET /api/invoices/:id/public carries the resolved payment options', () => {
  const instructions = 'Wire to account 000123. Recording the transfer stays manual.';

  beforeEach(() => {
    vi.clearAllMocks();
    mockPublic.appSetting.findUnique.mockResolvedValue(null);
  });

  it('with no override, the org defaults: tips off, partial off, card offered', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(publicInvoice());
    mockPublic.organization.findUnique.mockResolvedValue(storedOrg({ bank_transfer_instructions: instructions }));

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.payment_options).toEqual({
      methods: ['CARD', 'CHECK', 'BANK_TRANSFER'],
      online_methods: ['CARD'],
      tips: { enabled: false, presets: [], preset_amounts: [] },
      allow_partial: false,
      deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
      bank_transfer_instructions: instructions,
    });
    expect(res.body.available_payment_methods).toEqual(['CARD', 'CHECK', 'BANK_TRANSFER']);
    expect(res.body.payment_instructions.bank_transfer).toBe(instructions);
  });

  it('an invoice made bank-only with partial payment allowed: the payload reflects the override', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(publicInvoice({ payment_methods_override: ['ACH'], allow_partial_payment: true }));
    mockPublic.organization.findUnique.mockResolvedValue(storedOrg({
      ...ACH_LISTED, tips_enabled: true, tip_presets: [10, 15, 20], bank_transfer_instructions: instructions,
    }));

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.payment_options).toEqual({
      methods: ['ACH'],
      online_methods: ['ACH'],
      // 10/15/20% of the $1,000.00 before tax, for paying the whole amount due.
      tips: { enabled: true, presets: [10, 15, 20], preset_amounts: [100, 150, 200] },
      allow_partial: true,
      deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
      bank_transfer_instructions: null,
    });
    expect(res.body.available_payment_methods).toEqual(['ACH']);
    expect(res.body.payment_instructions.bank_transfer).toBeNull();
    // Internal override columns are not echoed on the customer's invoice object.
    expect(res.body.invoice.payment_methods_override).toBeUndefined();
    expect(res.body.invoice.allow_partial_payment).toBeUndefined();
  });

  it('a bank-only override without the ACH capability offers no online method', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(publicInvoice({ payment_methods_override: ['ACH', 'CHECK'] }));
    mockPublic.organization.findUnique.mockResolvedValue(storedOrg());

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);

    expect(res.body.payment_options.methods).toEqual(['CHECK']);
    expect(res.body.payment_options.online_methods).toEqual([]);
  });

  // Payments go-live slice 16 (fix round 2) - an org whose plan lacks online payments offers no
  // online method on the customer's page, though its payout account could take both: the checkout
  // door refuses one, so a Pay button for it would only lead the customer to a refusal.
  it('an org whose plan lacks online payments offers no Card or Bank; the manual methods stay', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(publicInvoice({ payment_methods_override: ['CARD', 'ACH', 'CHECK'] }));
    mockPublic.organization.findUnique.mockResolvedValue(storedOrg({
      ...ACH_LISTED, plan: 'PRO', trial_ends_at: null, feature_overrides: { online_payments: false },
    }));

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.payment_options.methods).toEqual(['CHECK']);
    expect(res.body.payment_options.online_methods).toEqual([]);
    expect(res.body.available_payment_methods).toEqual(['CHECK']);
  });
});

// ─── The checkout door asks the same resolver ───────────────────────────────

describe('POST /api/invoices/:id/public/checkout refuses a method the resolver does not offer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublic.appSetting.findUnique.mockResolvedValue(null);
    (isStripeConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cs_test_19', url: 'https://checkout.test/cs_test_19' });
  });

  function checkoutInvoice(overrides: Row = {}): Row {
    return {
      id: INVOICE_ID, invoice_number: 'INV-1901', status: 'SENT', amount_due: 1087.5, total_amount: 1087.5,
      kind: 'STANDARD', estimate: null,
      customer: { first_name: 'Pat', last_name: 'Payer', company_name: null }, job: null,
      payment_methods_override: null,
      organization: storedOrg(),
      // No bank payment in flight (payments go-live slice 12's payable-now read).
      payments: [],
      ...overrides,
    };
  }

  it('an invoice made bank-only refuses a card checkout, though the org can take cards', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(checkoutInvoice({ payment_methods_override: ['ACH', 'CHECK'] }));

    const res = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Card payments are not offered on this invoice');
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('with no override the org default still opens a card checkout', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(checkoutInvoice());

    const res = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.test/cs_test_19');
  });

  it('refuses a tip while the org has tips off, even when the page is bypassed', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(checkoutInvoice({ organization: storedOrg({ tips_enabled: false }) }));

    const res = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({ tip: 15 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Tips are not accepted on this invoice');
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('still opens a checkout with no tip while tips are off', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(checkoutInvoice({ organization: storedOrg({ tips_enabled: false }) }));

    const res = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({ tip: 0 });

    expect(res.status).toBe(200);
  });

  it('takes the tip once the org switches tips on', async () => {
    mockPublic.invoice.findFirst.mockResolvedValue(checkoutInvoice({ organization: storedOrg({ tips_enabled: true }) }));

    const res = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({ tip: 15 });

    expect(res.status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ pricing: expect.objectContaining({ tipCents: 1500 }) }),
      expect.anything(),
    );
  });
});

// ─── Invoice overrides through the document API ─────────────────────────────

describe('PATCH /api/invoices/:id stores the payment-option overrides for that invoice only', () => {
  let invoice: Row;
  const mockInvoice = prisma as unknown as {
    invoice: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    timelineEvent: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    invoice = { id: INVOICE_ID, organization_id: ALPHA_ORG_ID, status: 'SENT', sent_at: null, due_date: null, payment_methods_override: null, allow_partial_payment: null, job: null };
    mockInvoice.invoice.findUnique.mockImplementation(({ select }: { select?: Row }) => Promise.resolve(pick(invoice, select)));
    mockInvoice.invoice.update.mockImplementation(({ data, select }: { data: Row; select?: Row }) => {
      for (const [k, v] of Object.entries(data)) if (v !== undefined) invoice[k] = v;
      return Promise.resolve(pick(invoice, select));
    });
    mockInvoice.timelineEvent.findFirst.mockResolvedValue(null);
  });

  it('makes one invoice bank-only with partial payments allowed, and reads it back', async () => {
    const save = await request(app).patch(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'))
      .send({ payment_methods_override: ['ACH'], allow_partial_payment: true });
    expect(save.status).toBe(200);

    // Written to this invoice only, scoped to the caller's org.
    expect(mockInvoice.invoice.update).toHaveBeenCalledTimes(1);
    expect(mockInvoice.invoice.update.mock.calls[0][0].where).toEqual({ id: INVOICE_ID, organization_id: ALPHA_ORG_ID });

    const read = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'));
    expect(read.status).toBe(200);
    expect([read.body.invoice.payment_methods_override, read.body.invoice.allow_partial_payment]).toEqual([['ACH'], true]);
  });

  it('refuses to allow partial payments on a deposit invoice', async () => {
    invoice.kind = 'DEPOSIT';
    const save = await request(app).patch(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'))
      .send({ allow_partial_payment: true });
    expect(save.status).toBe(400);
    expect(save.body.error).toMatch(/deposit/i);
    expect(mockInvoice.invoice.update).not.toHaveBeenCalled();
  });

  it('null resets the invoice to the org default', async () => {
    invoice.payment_methods_override = ['ACH'];
    invoice.allow_partial_payment = true;
    const save = await request(app).patch(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'))
      .send({ payment_methods_override: null, allow_partial_payment: null });
    expect(save.status).toBe(200);
    const data = mockInvoice.invoice.update.mock.calls[0][0].data;
    expect([data.payment_methods_override, data.allow_partial_payment]).toEqual([Prisma.DbNull, null]);
  });

  it.each([
    ['an empty methods list', { payment_methods_override: [] }, 'payment_methods_override',
      'Choose at least one payment method, or use the org default'],
    ['an unknown method', { payment_methods_override: ['WIRE'] }, 'payment_methods_override.0', /^Invalid enum value/],
    // Slice 21 - the override's own words, not the org setting's field name the schema came from.
    ['a duplicated method', { payment_methods_override: ['ACH', 'ACH'] }, 'payment_methods_override',
      /^Each payment method can be listed only once$/],
    ['allow-partial as a string', { allow_partial_payment: 'yes' }, 'allow_partial_payment', 'Expected boolean, received string'],
  ])('refuses %s with a 400 naming the field', async (_name, body, field, message) => {
    const res = await request(app).patch(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin')).send(body);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field, message: expect.stringMatching(message) }]);
    expect(mockInvoice.invoice.update).not.toHaveBeenCalled();
  });
});

// ─── Estimate deposit-policy override ───────────────────────────────────────

const ESTIMATE_ID = 'bbbbbbbb-0000-4000-8000-000000000019';

describe('PATCH /api/estimates/:id stores the deposit-policy override for that estimate only', () => {
  const mockEstimate = prisma as unknown as {
    estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockEstimate.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    mockEstimate.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID, status: 'DRAFT', tax_rate: 0, discount_type: null, discount_value: null, discount_name: null,
      deposit_type: null, deposit_value: null, subtotal: 1000, tax_amount: 0, total_amount: 1000, discount_amount: 0,
      version: 1, scopes: null, scope_notes: null, line_items: [], invoices: [], job_id: null, created_by: null,
      organization: { lock_on_send: false }, lead: { lead_assignees: [] }, customer: { tax_exempt: false },
    });
    mockEstimate.estimate.update.mockImplementation(({ data, select }: { data: Row; select?: Row }) =>
      Promise.resolve(pick({ id: ESTIMATE_ID, status: 'DRAFT', line_items: [], deposit_policy: null, ...data }, select)));
  });

  it('a trusted customer can approve now and pay the deposit later', async () => {
    const res = await request(app).patch(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('admin')).send({ deposit_policy: 'PAY_LATER' });
    expect(res.status).toBe(200);
    // Read back through the estimate's own detail projection.
    expect(res.body.estimate.deposit_policy).toBe('PAY_LATER');
    expect(mockEstimate.estimate.update).toHaveBeenCalledTimes(1);
    const call = mockEstimate.estimate.update.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: ESTIMATE_ID });
    expect(call.data.deposit_policy).toBe('PAY_LATER');
  });

  it('null resets the estimate to the org policy', async () => {
    const res = await request(app).patch(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('admin')).send({ deposit_policy: null });
    expect(res.status).toBe(200);
    expect(mockEstimate.estimate.update.mock.calls[0][0].data.deposit_policy).toBeNull();
  });

  it('refuses an unknown deposit policy', async () => {
    const res = await request(app).patch(`/api/estimates/${ESTIMATE_ID}`).set(authHeader('admin')).send({ deposit_policy: 'NEVER' });
    expect(res.status).toBe(400);
    expect(mockEstimate.estimate.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/estimates/:id/public carries the resolved payment options', () => {
  const mockEst = prisma as unknown as {
    estimate: { findFirst: ReturnType<typeof vi.fn> };
    appSetting: { findUnique: ReturnType<typeof vi.fn> };
    organization: { findUnique: ReturnType<typeof vi.fn> };
  };
  const instructions = 'Wire to account 000123. Recording the transfer stays manual.';

  function sentEstimate(overrides: Row = {}): Row {
    return {
      ...ESTIMATE_SENT_FIXTURE,
      organization_id: ALPHA_ORG_ID,
      valid_until: null,
      send_config: { deposit_required: true, payment_methods: ['CARD', 'ACH', 'BANK_TRANSFER'] },
      lead: { customer: { first_name: 'Pat', last_name: 'Payer', company_name: null } },
      deposit_policy: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEst.appSetting.findUnique.mockResolvedValue(null);
  });

  it('sent with ACH while the account cannot take bank payments: ACH is not offered, the org policy applies', async () => {
    mockEst.estimate.findFirst.mockResolvedValue(sentEstimate());
    mockEst.organization.findUnique.mockResolvedValue(storedOrg({ bank_transfer_instructions: instructions }));

    const res = await request(app).get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.payment_options).toMatchObject({
      methods: ['CARD', 'BANK_TRANSFER'],
      online_methods: ['CARD'],
      deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
      bank_transfer_instructions: instructions,
    });
    expect(res.body.estimate.send_config.payment_methods).toEqual(['CARD', 'BANK_TRANSFER']);
    expect(res.body.payment_instructions.bank_transfer).toBe(instructions);
  });

  it('an estimate overriding the deposit policy, on an account that takes bank payments', async () => {
    mockEst.estimate.findFirst.mockResolvedValue(sentEstimate({ deposit_policy: 'PAY_LATER' }));
    mockEst.organization.findUnique.mockResolvedValue(storedOrg(ACH_LISTED));

    const res = await request(app).get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.body.payment_options).toMatchObject({
      methods: ['CARD', 'ACH', 'BANK_TRANSFER'],
      online_methods: ['CARD', 'ACH'],
      deposit_policy: 'PAY_LATER',
    });
  });

  // Payments go-live slice 16 (fix round 2) - the estimate page asks the same resolver, so an org
  // whose plan lacks online payments shows no Card or Bank deposit button that approve would refuse.
  it('an org whose plan lacks online payments offers no Card or Bank deposit; the manual methods stay', async () => {
    mockEst.estimate.findFirst.mockResolvedValue(sentEstimate());
    mockEst.organization.findUnique.mockResolvedValue(storedOrg({
      ...ACH_LISTED, plan: 'PRO', trial_ends_at: null, feature_overrides: { online_payments: false },
    }));

    const res = await request(app).get(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(res.body.payment_options).toMatchObject({ methods: ['BANK_TRANSFER'], online_methods: [] });
    expect(res.body.estimate.send_config.payment_methods).toEqual(['BANK_TRANSFER']);
  });
});

describe('POST /api/estimates/:id/approve asks the resolver before taking an online deposit', () => {
  const mockApprove = prisma as unknown as {
    estimate: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    appSetting: { findUnique: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  function approvable(org: Row): Row {
    return {
      id: ESTIMATE_SENT_FIXTURE.id, status: 'SENT', estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: ESTIMATE_SENT_FIXTURE.lead_id, organization_id: ALPHA_ORG_ID,
      lead: { commission_owner_id: null, status: 'ESTIMATED' },
      total_amount: 1000, valid_until: new Date('2027-12-31'), signature_data: null, snapshot_terms: null,
      invoices: [{ id: 'dep-inv-19', status: 'SENT', total_amount: 500, amount_due: 500 }],
      send_config: { deposit_required: true, payment_methods: ['CARD', 'ACH', 'CHECK'] },
      organization: org,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockApprove.appSetting.findUnique.mockResolvedValue(null);
  });

  it('refuses a bank deposit while the account cannot take bank payments, and changes nothing', async () => {
    mockApprove.estimate.findFirst.mockResolvedValue(approvable(storedOrg()));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'ACH' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bank payments are not enabled for this organization');
    expect(mockApprove.estimate.update).not.toHaveBeenCalled();
    expect(mockApprove.$transaction).not.toHaveBeenCalled();
  });

  // #904 for ACH: an online method must reach the processor or be refused, never fall through to
  // the manual branch (PENDING, 200, no checkout, a deposit nothing collects). Payments go-live
  // slice 12 added the bank checkout, so an ACH deposit the resolver admits now opens one.
  it('opens a bank checkout for the deposit while the account can take bank payments, never the manual branch', async () => {
    mockApprove.estimate.findFirst.mockResolvedValue(approvable(storedOrg(ACH_LISTED)));
    (isStripeConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cs_bank_19', url: 'https://checkout.test/cs_bank_19' });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123', payment_method: 'ACH' });

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.test/cs_bank_19');
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'bank' }),
      expect.anything(),
    );
    expect(mockApprove.$transaction).not.toHaveBeenCalled();
  });
});

// ─── Acceptance: set org defaults and an invoice override via the API; the public payload
// reflects the override ──────────────────────────────────────────────────────

describe('acceptance: org defaults + one invoice override, set through the API, reach the public payload', () => {
  let org: Row;
  let invoice: Row;
  const db = prisma as unknown as {
    organization: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    invoice: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    appSetting: { findUnique: ReturnType<typeof vi.fn> };
    timelineEvent: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    org = storedOrg(ACH_LISTED);
    invoice = { ...publicInvoice(), sent_at: null };
    db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    db.$executeRaw.mockResolvedValue(0);
    db.appSetting.findUnique.mockResolvedValue(null);
    db.timelineEvent.findFirst.mockResolvedValue(null);
    db.organization.findUnique.mockImplementation(({ select }: { select?: Row }) => Promise.resolve(pick(org, select)));
    db.organization.update.mockImplementation(({ data, select }: { data: Row; select?: Row }) => {
      org = { ...org, ...data };
      return Promise.resolve(pick(org, select));
    });
    db.invoice.findUnique.mockImplementation(({ select }: { select?: Row }) => Promise.resolve(pick(invoice, select)));
    db.invoice.update.mockImplementation(({ data, select }: { data: Row; select?: Row }) => {
      for (const [k, v] of Object.entries(data)) if (v !== undefined) invoice[k] = v;
      return Promise.resolve(pick(invoice, select));
    });
    // The public reads are by id + token; they return the stored invoice as their select asks,
    // with the checkout's organization relation resolved to the stored org.
    db.invoice.findFirst.mockImplementation(({ select }: { select?: Row }) => Promise.resolve({
      ...pick(invoice, select),
      ...(select && 'organization' in select ? { organization: org } : {}),
    }));
  });

  it('tips on with custom presets at the org, bank-only with partial on one invoice', async () => {
    const orgSave = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ tips_enabled: true, tip_presets: [8, 12, 16], accepted_payment_methods: ['ACH', 'CHECK'] });
    expect(orgSave.status).toBe(200);
    const invSave = await request(app).patch(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'))
      .send({ payment_methods_override: ['ACH'], allow_partial_payment: true });
    expect(invSave.status).toBe(200);

    const page = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);

    expect(page.status).toBe(200);
    expect(page.body.payment_options).toEqual({
      methods: ['ACH'],
      online_methods: ['ACH'],
      // 8/12/16% of the $1,000.00 before tax.
      tips: { enabled: true, presets: [8, 12, 16], preset_amounts: [80, 120, 160] },
      allow_partial: true,
      deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
      bank_transfer_instructions: null,
    });
    // The card door follows the same answer.
    const card = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({});
    expect(card.status).toBe(400);
  });

  // Story 24: the owner chooses which online methods are offered BY DEFAULT, card included. CARD
  // in accepted_payment_methods stays server-owned (it mirrors that the account can take cards,
  // and the webhook gate keys on it), so "card off by default" is its own setting.
  it('the owner switches Card off by default: no card without an override, card on an invoice that asks for it', async () => {
    const off = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ card_offered_by_default: false });
    expect(off.status).toBe(200);

    const read = await request(app).get('/api/organization').set(authHeader('admin'));
    expect(read.body.card_offered_by_default).toBe(false);
    // The account can still take cards; only the default offer changed.
    expect(read.body.accepted_payment_methods).toContain('CARD');

    // Bank stays on by default (this account can take bank payments); card is gone.
    const page = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);
    expect(page.body.payment_options.methods).toEqual(['CHECK', 'BANK_TRANSFER', 'ACH']);
    expect(page.body.payment_options.online_methods).toEqual(['ACH']);
    const card = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`).send({});
    expect(card.status).toBe(400);

    // One invoice can still offer card (story 25), since the account can take it.
    await request(app).patch(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'))
      .send({ payment_methods_override: ['CARD', 'CHECK'] });
    const overridden = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);
    expect(overridden.body.payment_options.online_methods).toEqual(['CARD']);
  });

  it('switching Card back on by default offers it again, and a methods save cannot switch it off', async () => {
    org = storedOrg({ ...ACH_LISTED, card_offered_by_default: false });

    const on = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ card_offered_by_default: true });
    expect(on.body.card_offered_by_default).toBe(true);
    // A stale methods list without CARD (the settings page never renders a CARD checkbox) is not
    // an intent about card.
    const stale = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CHECK'] });
    expect(stale.body.card_offered_by_default).toBe(true);

    const page = await request(app).get(`/api/invoices/${INVOICE_ID}/public?token=${TOKEN}`);
    expect(page.body.payment_options.online_methods).toEqual(['CARD', 'ACH']);
  });

  it('refuses a non-boolean card default, naming the field, and saves nothing', async () => {
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ card_offered_by_default: 'no' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'card_offered_by_default', message: 'Expected boolean, received string' }]);
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  it('refuses a non-boolean bank default, naming the field, and saves nothing', async () => {
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ bank_offered_by_default: 'no' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'bank_offered_by_default', message: 'Expected boolean, received string' }]);
    expect(db.organization.update).not.toHaveBeenCalled();
  });
});
