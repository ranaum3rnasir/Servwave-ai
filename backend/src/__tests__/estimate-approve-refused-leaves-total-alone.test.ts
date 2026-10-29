/**
 * A REFUSED approval must leave the estimate exactly as it found it.
 *
 * `POST /api/estimates/:id/approve` accepts an optional `selections` rider, and those selections
 * used to be committed BEFORE the payment method was validated. An approval the endpoint then
 * refused with a 400 still moved the customer's quoted total, permanently, and re-priced their
 * unpaid deposit to match. Measured on staging 2026-09-18: two consecutive refusals walked one
 * estimate's total from 1485 to 1925 to 2255, and the customer was never approved.
 *
 * The behaviour under test is the one the customer can observe, so it is asserted through the
 * endpoint, on the writes that reach the database: no `is_selected`, no recomputed money, no
 * deposit re-price, no send-time snapshot move.
 *
 * Note what that does and does not pin. Prisma is mocked, so these assertions see the writes the
 * handler ISSUES, not the ones that survive a commit. Validate-first passes. A genuine
 * roll-back-on-refusal would still have issued the tick inside its transaction and would fail
 * this file, so if that semantics is ever chosen instead, these assertions have to be rewritten
 * against a real database rather than relaxed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { isStripeConfigured } from '../lib/stripe';
import { ESTIMATE_SENT_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateSendConfig: { updateMany: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const TOKEN = ESTIMATE_SENT_FIXTURE.public_token;
const APPROVE_URL = `/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`;
const OPTIONAL_LINE = 'aa000000-0000-0000-0000-000000000011';
const REQUIRED_LINE = 'aa000000-0000-0000-0000-000000000012';
const OPTIONAL_LINE_2 = 'aa000000-0000-0000-0000-000000000013';

/** An unpaid deposit: the row the re-price is allowed to move, and therefore the one at risk. */
const UNPAID_DEPOSIT = { id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500 };

/** The estimate as `applyCustomerSelections` reads it, priced so the rider would move the total. */
function selectionTarget(over: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    organization_id: 'org-test-1',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    status: 'SENT',
    valid_until: new Date('2099-12-31'),
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    deposit_type: 'PERCENTAGE',
    deposit_value: 50,
    total_amount: 1000,
    scopes: [],
    line_items: [
      { id: REQUIRED_LINE, description: 'Door install', is_optional: false, is_selected: true },
      { id: OPTIONAL_LINE, description: 'Keypad entry', is_optional: true, is_selected: false },
      { id: OPTIONAL_LINE_2, description: 'Extra remote', is_optional: true, is_selected: false },
    ],
    invoices: [UNPAID_DEPOSIT],
    ...over,
  };
}

/** `approvePublic`'s own `existing` select. Deposit required, so the payment gates are live. */
function approveExisting(over: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    status: 'SENT',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    lead_id: null,
    lead: null,
    organization_id: 'org-test-1',
    total_amount: 1000,
    valid_until: new Date('2099-12-31'),
    signature_data: null,
    snapshot_terms: null,
    invoices: [UNPAID_DEPOSIT],
    send_config: { deposit_required: true, payment_methods: ['CHECK'] },
    organization: {
      id: 'org-test-1',
      stripe_account_id: 'acct_test',
      stripe_charges_enabled: true,
      accepted_payment_methods: ['CARD', 'CHECK'],
    },
    ...over,
  };
}

function mockApprove(existing = approveExisting(), target = selectionTarget()) {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          update: mockPrisma.estimateLineItem.update,
        },
        invoice: { findFirst: mockPrisma.invoice.findFirst, update: mockPrisma.invoice.update },
        estimateSendConfig: { updateMany: mockPrisma.estimateSendConfig.updateMany },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });

  mockPrisma.estimate.findFirst.mockResolvedValue(existing);
  mockPrisma.estimate.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
    if (args?.select?.scopes && !args.select.line_items) return { scopes: target.scopes };
    if (args?.select?.invoices && !args.select.line_items) return { invoices: target.invoices };
    if (args?.select?.line_items) return target;
    return null;
  });
  // The recompute reads the lines back: the optional rows are now ticked on, so the total moves
  // 1000 -> 1500 and the 50% deposit 500 -> 750. That is the damage a refusal must not do. Two
  // optional rows, priced differently, so an attempt can tick a DIFFERENT one each time and
  // model the walk that was measured, instead of repeating one idempotent tick.
  mockPrisma.estimateLineItem.findMany.mockResolvedValue([
    { id: REQUIRED_LINE, quantity: 1, unit_price: 1000, is_optional: false, is_selected: true, is_taxable: false },
    { id: OPTIONAL_LINE, quantity: 1, unit_price: 300, is_optional: true, is_selected: true, is_taxable: false },
    { id: OPTIONAL_LINE_2, quantity: 1, unit_price: 200, is_optional: true, is_selected: true, is_taxable: false },
  ]);
  mockPrisma.estimateLineItem.update.mockResolvedValue({});
  mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1500 });
  mockPrisma.invoice.findFirst.mockResolvedValue({
    id: 'dep-1', invoice_number: 'INV-D1', status: 'SENT', total_amount: 500, _count: { payments: 0 },
  });
  mockPrisma.invoice.update.mockResolvedValue({});
  mockPrisma.estimateSendConfig.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: 'org-test-1', deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50,
  });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
}

/** Every write a committed selection makes. A refusal must have made none of them. */
function expectNothingWasCommitted() {
  // The tick itself.
  expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  // The recomputed money on the estimate: subtotal, tax, total.
  const moneyWrites = mockPrisma.estimate.update.mock.calls
    .map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data)
    .filter((d) => d.subtotal !== undefined || d.tax_amount !== undefined || d.total_amount !== undefined);
  expect(moneyWrites).toEqual([]);
  // The deposit invoice the re-price rides along to, and the send-time snapshot every surface
  // reads the deposit figure off.
  expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  expect(mockPrisma.estimateSendConfig.updateMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` wipes recorded calls, not implementations, and the shared setup leaves the
  // processor reported as configured for every suite. Re-assert it so the one case below that
  // turns it off cannot leak into the others.
  vi.mocked(isStripeConfigured).mockReturnValue(true);
});

describe('POST /api/estimates/:id/approve - a refused approval changes nothing', () => {
  it('commits no selection when the deposit needs a payment method and none was sent', async () => {
    mockApprove();

    const res = await request(app).post(APPROVE_URL).send({
      signature_data: 'data:image/png;base64,AAA',
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Payment method is required');
    expectNothingWasCommitted();
  });

  it('commits no selection when the payment method was never offered on this estimate', async () => {
    mockApprove();

    const res = await request(app).post(APPROVE_URL).send({
      signature_data: 'data:image/png;base64,AAA',
      payment_method: 'BANK_TRANSFER',
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Payment method not available');
    expectNothingWasCommitted();
  });

  it('commits no selection when a card approval is refused because cards cannot be charged', async () => {
    mockApprove(approveExisting({
      send_config: { deposit_required: true, payment_methods: ['CARD'] },
      organization: {
        id: 'org-test-1',
        stripe_account_id: 'acct_test',
        stripe_charges_enabled: false,
        accepted_payment_methods: ['CARD', 'CHECK'],
      },
    }));

    const res = await request(app).post(APPROVE_URL).send({
      signature_data: 'data:image/png;base64,AAA',
      payment_method: 'CARD',
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Card payments are not enabled for this organization');
    expectNothingWasCommitted();
  });

  /**
   * The gate whose place in the control flow actually changed. It used to sit inside the card
   * branch, BELOW the rider, so an unconfigured processor was the one refusal that still moved
   * the total on its way out. Nothing else in the repo asserts this message, and the shared
   * setup reports the processor as configured everywhere, so without this case the hoist would
   * ship with no coverage at all.
   */
  it('commits no selection when a card approval is refused because no processor is configured', async () => {
    vi.mocked(isStripeConfigured).mockReturnValue(false);
    mockApprove(approveExisting({ send_config: { deposit_required: true, payment_methods: ['CARD'] } }));

    const res = await request(app).post(APPROVE_URL).send({
      signature_data: 'data:image/png;base64,AAA',
      payment_method: 'CARD',
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Card payment is not available');
    expectNothingWasCommitted();
  });

  /**
   * Two refusals in a row were what made this visible on staging: the total walked once per
   * attempt. One estimate, two calls, and the quoted figure has to be where it started.
   */
  it('does not accumulate across repeated refusals', async () => {
    mockApprove();
    const signature_data = 'data:image/png;base64,AAA';

    // A DIFFERENT row on each attempt. Repeating one tick would recompute the same figure and
    // could not show a walk even against the unfixed code; ticking a second row is what took
    // the measured total up a second time.
    const first = await request(app).post(APPROVE_URL).send({
      signature_data,
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });
    const second = await request(app).post(APPROVE_URL).send({
      signature_data,
      payment_method: 'BANK_TRANSFER',
      selections: [{ kind: 'line', id: OPTIONAL_LINE_2, is_selected: true }],
    });

    // Both attempts have to have actually been refused, or "nothing was committed" is vacuous.
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expectNothingWasCommitted();
  });

  /**
   * The control. Moving the validation must not disable the rider: an approval that is ACCEPTED
   * still applies the selections and still re-prices the deposit behind them.
   */
  it('still applies the selections when the approval is accepted', async () => {
    mockApprove();

    const res = await request(app).post(APPROVE_URL).send({
      signature_data: 'data:image/png;base64,AAA',
      payment_method: 'CHECK',
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.estimateLineItem.update.mock.calls[0][0].data).toEqual({ is_selected: true });
    expect(mockPrisma.invoice.update).toHaveBeenCalled();
  });
});
