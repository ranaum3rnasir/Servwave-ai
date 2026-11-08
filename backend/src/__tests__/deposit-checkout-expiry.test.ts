/**
 * #2031 slice 5, F2 — the window a superseded deposit link leaves open at the card processor.
 *
 * Refusing to OPEN a new checkout (deposit-link-superseded.test.ts) does not stop a checkout the
 * customer opened BEFORE the estimate was edited: that session is already live at the processor,
 * for ~24h, at the old figure, and it settles against an amount_due that has not moved yet — so
 * the payment is recorded, the deposit flips to PAID and the estimate is won, at a figure
 * calculated from an estimate that no longer exists.
 *
 * The window is closed by killing the session, not by cross-checking it afterwards: an expired
 * session cannot settle at all, which makes "two live payable links at different amounts" false
 * by construction. The trigger is the material edit — the moment the figure goes stale — and
 * again the re-price, which is the moment it actually moves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { expireOpenCheckoutSessionsForInvoice } from '../lib/stripe';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, ESTIMATE_SENT_FIXTURE, TEST_USERS } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;
const mockExpire = expireOpenCheckoutSessionsForInvoice as unknown as ReturnType<typeof vi.fn>;

const DEPOSIT_INVOICE_ID = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

/** The estimate as it stood BEFORE this edit: 1 line @ $1000, 6.25% tax -> total 1062.50. */
function sentEstimateBeforeEdit(overrides: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_SENT_FIXTURE.id,
    status: 'SENT',
    tax_rate: 0.0625,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    deposit_type: null,
    deposit_value: null,
    subtotal: 1000,
    tax_amount: 62.5,
    total_amount: 1062.5,
    discount_amount: 0,
    version: 1,
    invoices: [],
    organization: { lock_on_send: false },
    lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    ...overrides,
  };
}

/** The unpaid deposit document the customer already holds a link to: 50% of the OLD total. */
function unpaidDepositInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPOSIT_INVOICE_ID,
    invoice_number: 'INV-2001',
    status: 'SENT',
    total_amount: 531.25,
    organization: {
      stripe_account_id: 'acct_test',
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      deposit_default_fixed_amount: 0,
    },
    estimate: { deposit_type: null, deposit_value: null, total_amount: 956.25 },
    ...overrides,
  };
}

function stubMaterialEditTransaction() {
  const txUpdate = vi.fn().mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, version: 2 });
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
    estimateLineItem: { deleteMany: vi.fn().mockResolvedValue({}) },
    estimate: { update: txUpdate },
  }));
  return txUpdate;
}

/** Replace the $1000 line with a $900 one — totals move, so the edit is material. */
function materialEdit() {
  return request(app)
    .patch(`/api/estimates/${ESTIMATE_SENT_FIXTURE.id}`)
    .set(authHeader('admin'))
    .send({ line_items: [{ description: 'Changed item', quantity: 1, unit_price: 900, is_taxable: true }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExpire.mockResolvedValue({ expired: ['cs_live_1'], failed: 0, ok: true });
});

describe('a checkout opened before the estimate moved', () => {
  it('is expired at the processor when a material edit supersedes the deposit figure', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateBeforeEdit());
    stubMaterialEditTransaction();
    mockPrisma.invoice.findFirst.mockResolvedValue(unpaidDepositInvoice());

    const res = await materialEdit();

    expect(res.status).toBe(200);
    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire.mock.calls[0][0]).toBe(DEPOSIT_INVOICE_ID);
  });

  // F4 — a FIXED deposit is the same money before and after the total moves. The customer's link
  // is still asking for exactly the right amount, so killing it would take a working payment
  // link away from a paying customer for no reason at all.
  it('leaves the link alive when the edit does not move the deposit figure', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateBeforeEdit());
    stubMaterialEditTransaction();
    mockPrisma.invoice.findFirst.mockResolvedValue(unpaidDepositInvoice({
      total_amount: 500,
      estimate: { deposit_type: 'FIXED', deposit_value: 500, total_amount: 956.25 },
    }));

    const res = await materialEdit();

    expect(res.status).toBe(200);
    expect(mockExpire).not.toHaveBeenCalled();
  });

  // The call is external and can fail. What it must never do is fail the edit, or let the edit
  // finish believing a link is dead that is in fact still taking money.
  it('lets the edit through, and says so on the record, when the link could not be killed', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateBeforeEdit());
    stubMaterialEditTransaction();
    mockPrisma.invoice.findFirst.mockResolvedValue(unpaidDepositInvoice());
    mockExpire.mockResolvedValue({ expired: [], failed: 1, ok: false });

    const res = await materialEdit();

    expect(res.status).toBe(200);
    const row = mockPrisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'estimate.deposit_checkout_expiry_failed');
    expect(row).toBeDefined();
    expect(row.resource_type).toBe('Invoice');
    expect(row.resource_id).toBe(DEPOSIT_INVOICE_ID);
  });

  it('files nothing when the sweep came back clean', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateBeforeEdit());
    stubMaterialEditTransaction();
    mockPrisma.invoice.findFirst.mockResolvedValue(unpaidDepositInvoice());

    await materialEdit();

    const actions = mockPrisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).not.toContain('estimate.deposit_checkout_expiry_failed');
  });

  // A thrown error inside the guard must not reach the customer's edit either.
  it('still completes the edit when the guard itself blows up', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateBeforeEdit());
    stubMaterialEditTransaction();
    mockPrisma.invoice.findFirst.mockRejectedValue(new Error('database went away'));

    const res = await materialEdit();

    expect(res.status).toBe(200);
  });
});

/**
 * The line-item door. Editing a line on a sent estimate is the ordinary way a total moves, and it
 * raises modified_after_send through the same shared guardrail — so it has to kill the open
 * checkout for the same reason the whole-document PATCH does.
 */
describe('a checkout open while a line item is edited', () => {
  const LINE_ID = 'aa000000-0000-0000-0000-000000000003';

  function line(over: Record<string, unknown> = {}) {
    return {
      id: LINE_ID,
      estimate_id: ESTIMATE_FIXTURE.id,
      sequence: 1,
      description: 'AC Unit',
      quantity: 1,
      unit_price: 1000,
      unit_cost: null,
      markup_percent: null,
      is_taxable: true,
      line_total: 1000,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'SERVICE',
      price_book_item_id: null,
      ...over,
    };
  }

  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation((arg: unknown) => (arg as (tx: unknown) => unknown)({
      estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
      estimateLineItem: {
        findMany: mockPrisma.estimateLineItem.findMany,
        create: mockPrisma.estimateLineItem.create,
        update: mockPrisma.estimateLineItem.update,
        deleteMany: mockPrisma.estimateLineItem.deleteMany,
      },
      estimateScopePhoto: { findMany: vi.fn(), deleteMany: vi.fn() },
    }));
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'SENT',
      version: 1,
      tax_rate: 0,
      discount_type: null,
      discount_value: null,
      subtotal: 1000,
      tax_amount: 0,
      total_amount: 1000,
      discount_amount: 0,
      scopes: null,
      organization: { lock_on_send: false },
      invoices: [],
      line_items: [line()],
    });
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ quantity: 2, line_total: 2000 })]);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_FIXTURE, line_items: [], scopes: null });
    mockPrisma.invoice.findFirst.mockResolvedValue(unpaidDepositInvoice({
      total_amount: 500, estimate: { deposit_type: null, deposit_value: null, total_amount: 2000 },
    }));
  });

  it('is expired when a line edit moves the total on a sent estimate', async () => {
    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire.mock.calls[0][0]).toBe(DEPOSIT_INVOICE_ID);
  });
});

/**
 * The second trigger. By the time the re-price has run, the document already holds the NEW figure,
 * so "has the figure gone stale" is false — while any session still open at the processor was
 * opened against the OLD one. Nothing else in the system would ever kill those.
 */
describe('a checkout still open when the deposit is re-priced', () => {
  const SEND_ESTIMATE_ID = ESTIMATE_FIXTURE.id;

  function sentEstimateAtNewTotal() {
    return {
      id: SEND_ESTIMATE_ID,
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
    };
  }

  function stubResendTransaction(depositInvoice: unknown) {
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
            quantity: 1, unit_price: 2000, is_taxable: false,
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
        update: vi.fn().mockResolvedValue({ id: DEPOSIT_INVOICE_ID }),
      },
      invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
      estimateVersionSnapshot: mockPrisma.estimateVersionSnapshot,
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mockPrisma.$transaction.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));
    return tx;
  }

  function resend() {
    return request(app)
      .post(`/api/estimates/${SEND_ESTIMATE_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: true, payment_methods: ['CARD'] });
  }

  beforeEach(() => {
    mockPrisma.estimate.count.mockResolvedValue(0);
    mockPrisma.visit.count.mockResolvedValue(0);
    mockPrisma.visit.findFirst.mockResolvedValue(null);
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-1', name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
    // The post-commit guard re-reads the deposit document on its own connection.
    mockPrisma.invoice.findFirst.mockResolvedValue(unpaidDepositInvoice({
      total_amount: 1000,
      estimate: { deposit_type: null, deposit_value: null, total_amount: 2000 },
    }));
  });

  it('expires the open sessions once the figure has actually moved', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    stubResendTransaction({
      id: DEPOSIT_INVOICE_ID, invoice_number: 'INV-2001', status: 'SENT',
      total_amount: 531.25, _count: { payments: 0 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire.mock.calls[0][0]).toBe(DEPOSIT_INVOICE_ID);
  });

  it('does not touch the processor when the resend left the deposit alone', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(sentEstimateAtNewTotal());
    stubResendTransaction({
      id: DEPOSIT_INVOICE_ID, invoice_number: 'INV-2001', status: 'SENT',
      total_amount: 1000, _count: { payments: 0 },
    });

    const res = await resend();

    expect(res.status).toBe(200);
    expect(mockExpire).not.toHaveBeenCalled();
  });
});
