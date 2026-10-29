/**
 * #2031 slice 5 — the customer's deposit link must not take a payment at a superseded amount.
 *
 * Re-pricing on the next send (see deposit-reprice-on-resend.test.ts) makes the link correct again,
 * but it leaves a window: §A3 lets a SENT estimate be edited in place, and from that edit until the
 * salesperson re-sends, the deposit invoice sits at the amount the OLD total produced with its own
 * live public_token. The estimate's own link is invalidated by the edit (public_token nulled); the
 * deposit invoice's link is not, and it is the one with money behind it.
 *
 * So the link stays alive — it is never voided, never rotated — and simply declines to take money
 * while the figure behind it is known to be stale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { isStripeConfigured, createCheckoutSession, getStripeForOrg, expireCheckoutSession } from '../lib/stripe';

const mockPrisma = prisma as unknown as Record<string, any>;
const mockIsStripeConfigured = isStripeConfigured as ReturnType<typeof vi.fn>;
const mockCreateCheckoutSession = createCheckoutSession as ReturnType<typeof vi.fn>;
const mockGetStripeForOrg = getStripeForOrg as ReturnType<typeof vi.fn>;
const mockExpireSession = expireCheckoutSession as unknown as ReturnType<typeof vi.fn>;

const DEPOSIT_INVOICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TOKEN = 'deposit-link-token';

/**
 * The deposit document as the customer holds it: $531.25, which is 50% of the $1,062.50 total the
 * estimate had when it was sent. `estimate` carries the estimate as it stands NOW — whether the
 * figure is still true is exactly what the door has to decide.
 */
function depositInvoice(estimate: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: DEPOSIT_INVOICE_ID,
    invoice_number: 'INV-2001',
    status: 'SENT',
    kind: 'DEPOSIT',
    amount_due: 531.25,
    total_amount: 531.25,
    customer: { first_name: 'Pat', last_name: 'Q', company_name: null },
    job: null,
    estimate,
    organization: {
      id: 'org-test-1',
      stripe_account_id: 'acct_test',
      accepted_payment_methods: ['CARD', 'CHECK'],
      stripe_charges_enabled: true,
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      deposit_default_fixed_amount: 0,
    },
    ...overrides,
  };
}

/** An estimate that has been edited since the deposit went out. `total` decides whether the
 *  deposit figure actually moved with it. */
function editedEstimate(total: number, over: Record<string, unknown> = {}) {
  return { id: 'est-1', modified_after_send: true, deposit_type: null, deposit_value: null, total_amount: total, ...over };
}

/** The same estimate, unedited and in step with the deposit. */
function currentEstimate() {
  return { id: 'est-1', modified_after_send: false, deposit_type: null, deposit_value: null, total_amount: 1062.5 };
}

function payTheLink() {
  return request(app).post(`/api/invoices/${DEPOSIT_INVOICE_ID}/public/checkout?token=${TOKEN}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps a queued mockResolvedValueOnce, and the checkout door reads the invoice
  // twice — so a leftover queue from one test answers the FIRST read of the next one.
  mockPrisma.invoice.findFirst.mockReset();
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockIsStripeConfigured.mockReturnValue(true);
  mockGetStripeForOrg.mockReturnValue({ stripe: {}, stripeAccount: undefined });
  mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.example/test' });
});

describe('the public deposit link while the estimate has moved on', () => {
  it('refuses to open a payment when the estimate has changed since the deposit was minted', async () => {
    // The total moved to $1,912.50, so a 50% deposit is now $956.25 — not the $531.25 the
    // customer's link is asking for.
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(editedEstimate(1912.5)));

    const res = await payTheLink();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'This deposit request is out of date because the estimate has changed. Please contact us for the current amount.',
      // F5 — the page the customer already had open recognises the refusal by this code, never by
      // the wording, so it can say what actually happened instead of "please try again".
      code: 'DEPOSIT_SUPERSEDED',
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('takes the payment normally once the estimate and the deposit agree again', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(currentEstimate()));

    const res = await payTheLink();

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/test');
  });

  // A plain job invoice has no estimate behind it and must be unaffected.
  it('does not gate an ordinary invoice that has no estimate', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      ...depositInvoice(null), kind: 'STANDARD',
    });

    const res = await payTheLink();

    expect(res.status).toBe(200);
  });

  // Under a mocked Prisma the row is whatever the double returns, so the gate proves nothing
  // unless the handler actually asks the database for the flag.
  it("selects the estimate's changed-since-sent flag on the checkout lookup", async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(currentEstimate()));

    await payTheLink();

    const args = mockPrisma.invoice.findFirst.mock.calls[0][0];
    expect(args.select.kind).toBe(true);
    expect(args.select.total_amount).toBe(true);
    expect(args.select.estimate.select.modified_after_send).toBe(true);
    // F4 — the door compares AMOUNTS, so it has to read what the amount is calculated from.
    expect(args.select.estimate.select.deposit_type).toBe(true);
    expect(args.select.estimate.select.deposit_value).toBe(true);
    expect(args.select.estimate.select.total_amount).toBe(true);
    expect(args.select.organization.select.deposit_default_percentage).toBe(true);
  });

  // The page must stop OFFERING to pay rather than walking the customer into the refusal above.
  it('tells the public page the deposit is awaiting an update, without leaking the internal flag', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: DEPOSIT_INVOICE_ID,
      invoice_number: 'INV-2001',
      organization_id: 'org-test-1',
      status: 'SENT',
      kind: 'DEPOSIT',
      amount_due: 531.25,
      total_amount: 531.25,
      subtotal: 531.25,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      estimate: editedEstimate(1912.5),
      customer: { first_name: 'Pat', last_name: 'Q', company_name: null },
      line_items: [],
      job: null,
    });
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Org', logo_url: null, brand_color: null, phone: null, timezone: null,
      accepted_payment_methods: ['CARD'], stripe_charges_enabled: true,
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const res = await request(app).get(`/api/invoices/${DEPOSIT_INVOICE_ID}/public?token=${TOKEN}`);

    expect(res.status).toBe(200);
    // One field carries BOTH holds now (a recall suspends the link too), so the page reads the
    // reason rather than a boolean it would have to interpret.
    expect(res.body.deposit_hold_reason).toBe('SUPERSEDED');
    // The estimate's internal changed-since-sent flag is not part of the customer's payload.
    expect(res.body.invoice.estimate).toBeUndefined();
  });

  // F4 — a FIXED deposit does not move when the total does. $500 fixed is $500 before and after
  // the estimate goes from $2,000 to $2,200, so the customer's link is asking for exactly the
  // right money and killing it would be a defect of its own.
  it('still takes the payment when the edit did not move a FIXED deposit', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(
      editedEstimate(2200, { deposit_type: 'FIXED', deposit_value: 500 }),
      { amount_due: 500, total_amount: 500 },
    ));

    const res = await payTheLink();

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/test');
  });

  // The material-change flag is raised by a discount RENAME too (nonTotalsMaterialChange), which
  // moves no money at all.
  it('still takes the payment after a cosmetic edit that moved no money', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(editedEstimate(1062.5)));

    const res = await payTheLink();

    expect(res.status).toBe(200);
  });

  // The flag is load-bearing in its own right, and not redundant with the amount comparison. An
  // org that changes its default deposit percentage has not changed anything about an estimate it
  // already sent: the customer was quoted 50%%, the estimate has not moved, and the figure they
  // were given stands until that estimate is re-sent. Only an edit to the ESTIMATE opens this door.
  it('honours a quoted deposit after the org changed its default percentage', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(
      currentEstimate(),
      {
        organization: {
          id: 'org-test-1', stripe_account_id: 'acct_test',
          accepted_payment_methods: ['CARD', 'CHECK'], stripe_charges_enabled: true,
          deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 60, deposit_default_fixed_amount: 0,
        },
      },
    ));

    const res = await payTheLink();

    expect(res.status).toBe(200);
  });

  /**
   * F2's remaining sliver. The door reads the invoice, then asks the processor for a session — and
   * the edit can land in between, which is the one way a session can still be minted against a
   * figure that is already superseded. So the answer is re-checked after the session exists, and
   * a session that lost the race is killed before its URL is ever handed out.
   */
  it('kills a session that the edit overtook, rather than handing over its link', async () => {
    mockPrisma.invoice.findFirst
      .mockResolvedValueOnce(depositInvoice(currentEstimate()))
      .mockResolvedValueOnce(depositInvoice(editedEstimate(1912.5)));

    const res = await payTheLink();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'This deposit request is out of date because the estimate has changed. Please contact us for the current amount.',
      // F5 — the page the customer already had open recognises the refusal by this code, never by
      // the wording, so it can say what actually happened instead of "please try again".
      code: 'DEPOSIT_SUPERSEDED',
    });
    expect(mockExpireSession).toHaveBeenCalledWith('cs_1', expect.anything());
  });

  it('hands over the link when nothing moved underneath it', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(currentEstimate()));

    const res = await payTheLink();

    expect(res.status).toBe(200);
    expect(mockExpireSession).not.toHaveBeenCalled();
  });

  // F8 — a job invoice raised from an estimate is STANDARD and carries an estimate_id, so
  // `estimate` is NOT null on it. Without the kind check it would be refused the moment that
  // estimate was edited, which would block every such invoice from ever being paid.
  it('does not gate an ordinary invoice that carries an estimate of its own', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice(
      editedEstimate(1912.5),
      { kind: 'STANDARD' },
    ));

    const res = await payTheLink();

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/test');
  });

  it('reports a deposit in step with its estimate as payable', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: DEPOSIT_INVOICE_ID,
      invoice_number: 'INV-2001',
      organization_id: 'org-test-1',
      status: 'SENT',
      kind: 'DEPOSIT',
      amount_due: 531.25,
      total_amount: 531.25,
      subtotal: 531.25,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      estimate: currentEstimate(),
      customer: { first_name: 'Pat', last_name: 'Q', company_name: null },
      line_items: [],
      job: null,
    });
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Test Org', logo_url: null, brand_color: null, phone: null, timezone: null,
      accepted_payment_methods: ['CARD'], stripe_charges_enabled: true,
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });

    const res = await request(app).get(`/api/invoices/${DEPOSIT_INVOICE_ID}/public?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.deposit_hold_reason).toBeNull();
  });
});
