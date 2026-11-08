/**
 * #2031 slice 5 — an unpaid deposit invoice must not stay payable at a superseded amount.
 *
 * Ran's decision: RE-PRICE ON NEXT SEND, never void. A deposit invoice that is still unpaid is
 * recalculated from the estimate's current total the next time the estimate goes out; the
 * customer's original link stays alive and starts reflecting the correct figure. A deposit with
 * ANY money against it is never touched — that is a reconciliation matter, not a mutation.
 *
 * Before this slice the re-pricing lived only inside `commitFirstSend`, which `sendEstimateInternal`
 * reaches when `status === 'DRAFT'`. The ordinary path — edit a SENT estimate in place (§A3 leaves
 * it SENT, bumps the version, flags modified_after_send) and send it again — took the SENT→SENT
 * resend branch, which re-snapshotted nothing and left the deposit invoice payable at the old
 * amount for ever.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, TEST_USERS, ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

/** A SENT estimate whose total has since moved to $2,000 — a 50% deposit is now $1,000. */
function sentEstimateAtNewTotal(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_FIXTURE.id,
    status: 'SENT',
    estimate_number: ESTIMATE_FIXTURE.estimate_number,
    total_amount: 2000,
    public_token: 'live-customer-token',
    valid_until: new Date('2030-01-01'),
    modified_after_send: true,
    version: 3,
    customer_id: CUSTOMER_ID,
    created_by: TEST_USERS.admin.id,
    deposit_type: null,
    deposit_value: null,
    _count: { line_items: 2 },
    lead: {
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      status: 'ESTIMATED',
      customer: { id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Q', company_name: null, email: 'pat@example.com' },
    },
    customer: { id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Q', company_name: null, email: 'pat@example.com' },
    send_config: { id: 'sc-1' },
    job_id: null,
    job: null,
    job_link: null,
    ...overrides,
  };
}

/**
 * Builds the transaction double for a resend. `depositInvoice` is what `tx.invoice.findFirst`
 * answers with — null for "no deposit document", or the row as it currently stands.
 */
function stubResendTransaction(depositInvoice: unknown, estimateTotal = 2000) {
  const tx = {
    estimate: {
      update: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, status: 'SENT' }),
      // A2 (publish at every send): the re-send branch now reads the estimate's LINES inside the
      // transaction and re-prices the deposit off the total they produce, so this double has to be
      // self-consistent - a row claiming `total_amount: 2000` whose lines price out at something
      // else is not a state the database can be in. One required line at the declared total, and
      // every `rep_selected` null so the publish itself is a no-op and the total does not move.
      findUnique: vi.fn().mockResolvedValue({
        ...ESTIMATE_FIXTURE,
        status: 'SENT',
        tax_rate: 0,
        discount_type: null,
        discount_value: null,
        scopes: null,
        line_items: [{
          quantity: 1, unit_price: estimateTotal, is_taxable: false,
          discount_type: null, discount_value: null,
          is_optional: false, is_selected: true, rep_selected: null,
        }],
      }),
    },
    estimateSendConfig: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    invoice: {
      findFirst: vi.fn().mockResolvedValue(depositInvoice),
      create: vi.fn().mockResolvedValue({ id: 'dep-new' }),
      update: vi.fn().mockResolvedValue({ id: 'dep-1' }),
    },
    invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
    // #2030 — version minting runs inside a transaction, so the double has to carry the delegate.
    estimateVersionSnapshot: mockPrisma.estimateVersionSnapshot,
    timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  mockPrisma.$transaction.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return tx;
}

function resend() {
  return request(app)
    .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
    .set(authHeader('admin'))
    .send({ deposit_required: true, payment_methods: ['CARD'] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.visit.count.mockResolvedValue(0);
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
    estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
    deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
  });
});

describe('resending an estimate whose total moved', () => {
  it('re-prices the unpaid deposit invoice to the deposit the current total produces', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    const args = tx.invoice.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'dep-1' });
    expect(Number(args.data.subtotal)).toBe(1000);
    expect(Number(args.data.total_amount)).toBe(1000);
    expect(Number(args.data.amount_due)).toBe(1000);
    // The one deposit line is re-snapshotted, never appended to.
    expect(args.data.line_items.deleteMany).toEqual({});
    expect(Number(args.data.line_items.create[0].line_total)).toBe(1000);
  });

  it('leaves a PAID deposit invoice alone — a payment against a superseded amount is reconciliation, not a mutation', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'PAID', total_amount: 531.25, _count: { payments: 1 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).not.toHaveBeenCalled();
    // The frozen configuration the receipt card reads must not move either, or the card would
    // report a corrected deposit while the money on file says otherwise.
    expect(tx.estimateSendConfig.update).not.toHaveBeenCalled();
  });

  it('leaves a PARTIAL deposit invoice alone — partly paid is not unpaid', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'PARTIAL', total_amount: 531.25, _count: { payments: 1 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('refuses on the payment count alone, even for a row still labelled SENT', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'SENT', total_amount: 531.25, _count: { payments: 1 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  // Under a mocked Prisma the row is whatever the double returns, so the previous test would pass
  // just as happily against code that never asked the database for the payment count. This asserts
  // the lookup actually selects it.
  it('asks for the deposit invoice\'s payment count, org-scoped, inside the transaction', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
    });

    await resend();

    expect(tx.invoice.findFirst).toHaveBeenCalledTimes(1);
    const args = tx.invoice.findFirst.mock.calls[0][0];
    expect(args.select._count).toEqual({ select: { payments: true } });
    expect(args.select.status).toBe(true);
    expect(args.where).toMatchObject({
      estimate_id: ESTIMATE_FIXTURE.id,
      kind: 'DEPOSIT',
      organization_id: ALPHA_ORG_ID,
    });
  });

  // The discriminating case for the STATUS half of the guard: cancel() voids an estimate's unpaid
  // deposit invoices, so a VOIDED row legitimately carries zero payments. Re-pricing one would
  // resurrect a deliberately killed payable document.
  it('leaves a VOIDED deposit invoice alone even though nothing was ever paid against it', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'VOIDED', total_amount: 531.25, _count: { payments: 0 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  // A resend that changes nothing must not churn the invoice or file a history entry. The
  // comparison is at cents because Decimal(12,2) is what the column holds.
  it('does not rewrite a deposit invoice that is already at the current figure', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'SENT', total_amount: 1000, _count: { payments: 0 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.estimateSendConfig.update).not.toHaveBeenCalled();
  });

  /**
   * F3 — a total whose half lands exactly on a half-cent. `512.05 * 0.5` is `256.025`, and the
   * float and the Decimal(12,2) column do not round it the same way: Postgres stores `256.03`,
   * `Math.round(n * 100) / 100` yields `256.02`. Resolve it unrounded and the two never agree
   * again, so EVERY resend re-prices, deletes and recreates the line, re-stamps send_config and
   * files a fresh history entry — and the history states a figure one cent below what the invoice
   * holds and the customer is asked to pay. Rounding at the resolver makes the written value and
   * the compared value the same value.
   */
  describe('a deposit that lands on a half-cent', () => {
    function halfCentEstimate() {
      return sentEstimateAtNewTotal({ total_amount: 512.05 });
    }

    it('writes the figure the column will hold, not the one the float produced', async () => {
      mockAuthAs('admin');
      mockPrisma.estimate.findUnique.mockResolvedValue(halfCentEstimate());
      const tx = stubResendTransaction({
        id: 'dep-1', invoice_number: 'INV-77', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
      }, 512.05);

      await resend();

      const args = tx.invoice.update.mock.calls[0][0];
      expect(Number(args.data.total_amount)).toBe(256.02);
      expect(Number(args.data.amount_due)).toBe(256.02);
      expect(Number(args.data.line_items.create[0].line_total)).toBe(256.02);

      // Claim 4 puts the traceability in this entry and nowhere else, so it has to state the
      // figure the customer is actually asked for.
      const row = mockPrisma.auditLog.create.mock.calls
        .map((c: any[]) => c[0].data)
        .find((d: any) => d.action === 'estimate.deposit_repriced');
      expect(row.metadata.to_amount).toBe(256.02);
    });

    it('does not churn on a second identical send', async () => {
      mockAuthAs('admin');
      mockPrisma.estimate.findUnique.mockResolvedValue(halfCentEstimate());

      // Send once, and take what the write actually handed the column.
      const first = stubResendTransaction({
        id: 'dep-1', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
      }, 512.05);
      await resend();
      const written = Number(first.invoice.update.mock.calls[0][0].data.total_amount);

      // Decimal(12,2) is what the row then holds. This is the step that made the two conventions
      // diverge: the column rounds the decimal literal, not the float. Doing it here rather than
      // asserting a hardcoded figure is what makes this test fail against an unrounded resolver.
      const stored = new Prisma.Decimal(written).toDecimalPlaces(2).toNumber();

      // Send again, unchanged.
      const second = stubResendTransaction({
        id: 'dep-1', status: 'SENT', total_amount: stored, _count: { payments: 0 },
      }, 512.05);
      const res = await resend();

      expect(res.status).toBe(200);
      expect(second.invoice.update).not.toHaveBeenCalled();
      expect(second.estimateSendConfig.update).not.toHaveBeenCalled();
    });
  });

  // F8 — the comment says ignoring `deposit_required` on this branch is deliberate: whether a
  // deposit was asked for at all was settled at the first send, and an unpaid deposit document
  // that EXISTS must be honest regardless of what the client happened to echo back. Nothing
  // enforced that, so gating the re-price on the flag left the whole suite green.
  it('re-prices regardless of what the resend body says about deposits', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    expect(Number(tx.invoice.update.mock.calls[0][0].data.total_amount)).toBe(1000);
  });

  // send_config.deposit_amount is the HELD figure every deposit surface reads
  // (resolveDepositState, frontend/src/lib/deposit.ts). Left behind, the receipt card would go on
  // reporting a mismatch against a deposit invoice that has just been corrected.
  it('moves the frozen send configuration with the invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    const tx = stubResendTransaction({
      id: 'dep-1', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
    });

    await resend();

    const call = tx.estimateSendConfig.update.mock.calls
      .find((c: any[]) => c[0].data.deposit_amount !== undefined);
    expect(call).toBeDefined();
    expect(call![0].where).toEqual({ id: 'sc-1' });
    expect(Number(call![0].data.deposit_amount)).toBe(1000);
    expect(Number(call![0].data.deposit_percentage)).toBe(50);
    // Whether a deposit was asked for at all was settled at the first send.
    expect(call![0].data.deposit_required).toBeUndefined();
  });

  // "Deposit changes are recorded in the estimate's history": getHistory reads auditLog scoped to
  // resource_type 'Estimate'. The metadata is also the traceability record — estimate_version and
  // estimate_total name the estimate state the new figure was minted from, and every send mints an
  // EstimateVersionSnapshot for that version.
  it("records the re-price on the estimate's history, traceable to the estimate state behind it", async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    stubResendTransaction({ id: 'dep-1', invoice_number: 'INV-77', status: 'SENT', total_amount: 531.25, _count: { payments: 0 } });

    await resend();

    const row = mockPrisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'estimate.deposit_repriced');
    expect(row).toBeDefined();
    expect(row.resource_type).toBe('Estimate');
    expect(row.resource_id).toBe(ESTIMATE_FIXTURE.id);
    expect(row.metadata).toMatchObject({
      invoice_id: 'dep-1',
      invoice_number: 'INV-77',
      from_amount: 531.25,
      to_amount: 1000,
      estimate_version: 3,
      estimate_total: 2000,
    });
  });

  it('files no history entry when the deposit was left alone', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    stubResendTransaction({ id: 'dep-1', status: 'PAID', total_amount: 531.25, _count: { payments: 1 } });

    await resend();

    const actions = mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).not.toContain('estimate.deposit_repriced');
  });

  // markSent is the OTHER first-send door (delivered outside the app). It is DRAFT-only, so it
  // reaches the re-price branch whenever an estimate was recalled to draft (#2031 slice 4),
  // re-priced, and marked sent again. Its history entry must say the same thing send()'s does.
  it('re-prices and records it on the mark-sent door too', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(
      sentEstimateAtNewTotal({ status: 'DRAFT', public_token: null, send_config: null, version: 5 }),
    );
    const tx = stubResendTransaction({
      id: 'dep-1', invoice_number: 'INV-88', status: 'SENT', total_amount: 531.25, _count: { payments: 0 },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/mark-sent`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });

    expect(res.status).toBe(200);
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    expect(Number(tx.invoice.update.mock.calls[0][0].data.total_amount)).toBe(1000);

    const row = mockPrisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'estimate.deposit_repriced');
    expect(row).toBeDefined();
    expect(row.metadata).toMatchObject({
      invoice_number: 'INV-88', from_amount: 531.25, to_amount: 1000, estimate_version: 5,
    });
  });
});
