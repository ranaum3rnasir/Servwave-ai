/**
 * #2979 - the deposit's own checkout door, as the retry door for a signed estimate whose deposit is
 * not paid yet.
 *
 * - For an estimate's deposit it offers the methods the ESTIMATE was sent with. Sending writes no
 *   invoice override, so before this the door followed the org default and disagreed with the
 *   estimate page (a card the estimate offered was refused; a bank it never offered was taken).
 * - It writes the estimate's "Customer started deposit checkout" history event, as approval does.
 * - A checkout started on a signed (PENDING) estimate comes back as an approval return, the same
 *   return the signing checkout uses; one on a won estimate stays a deposit return.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { isStripeConfigured, createCheckoutSession, getStripeForOrg } from '../lib/stripe';

const mockPrisma = prisma as unknown as Record<string, any>;
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-000000002979';
const ESTIMATE_ID = 'bbbbbbbb-0000-4000-8000-000000002979';

function deposit(o: { estimateStatus?: string; sent?: string[] | null; org?: Record<string, unknown> } = {}) {
  return {
    id: INVOICE_ID, invoice_number: 'D-2979', status: 'SENT', kind: 'DEPOSIT', amount_due: 500, total_amount: 500,
    customer: { first_name: 'Pat', last_name: 'Q', company_name: null }, job: null,
    estimate: {
      id: ESTIMATE_ID, public_token: 'est-tok', status: o.estimateStatus ?? 'PENDING', modified_after_send: false,
      deposit_type: 'FIXED', deposit_value: 500, total_amount: 1000,
      send_config: o.sent === null ? null : { payment_methods: o.sent ?? ['CARD', 'ACH', 'CHECK'] },
    },
    organization: {
      id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD', 'ACH', 'CHECK'], stripe_charges_enabled: true,
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
      ...o.org,
    },
    payment_methods_override: null,
    allow_partial_payment: false,
    payments: [],
  };
}

const pay = (body: Record<string, unknown>) => request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=dep-tok`).send(body);
const session = () => (vi.mocked(createCheckoutSession).mock.calls[0]?.[0] as any);
const historyRows = () =>
  mockPrisma.auditLog.create.mock.calls.map(([arg]: [any]) => arg.data).filter((d: any) => d.action === 'estimate.deposit_checkout_started');

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.invoice.findFirst.mockReset();
  mockPrisma.auditLog.create.mockResolvedValue({});
  vi.mocked(isStripeConfigured).mockReturnValue(true);
  vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: 'acct_test' } as any);
  vi.mocked(createCheckoutSession).mockResolvedValue({ id: 'cs_2979', url: 'https://checkout.example/2979', created: 1790000000 } as any);
});

describe("the deposit door offers the methods the estimate was sent with", () => {
  it('takes a card the estimate was sent with although the org leaves card out of its default offer', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit({ sent: ['CARD', 'CHECK'], org: { card_offered_by_default: false } }));

    const res = await pay({ method: 'card', expected_amount: 500, return_to: 'estimate' });

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/2979');
    expect(session().method).toBe('card');
  });

  it('refuses a bank payment the estimate was not sent with, although the org offers bank by default', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit({ sent: ['CARD', 'CHECK'] }));

    const res = await pay({ method: 'bank', expected_amount: 500, return_to: 'estimate' });

    expect(res.status).toBe(400);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('a deposit whose estimate kept no sent list still follows the org default', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit({ sent: null }));

    const res = await pay({ method: 'bank', expected_amount: 500 });

    expect(res.status).toBe(200);
  });
});

describe("the deposit door writes the estimate's history", () => {
  it('writes "deposit checkout started" on the estimate once the checkout is handed out', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit());

    const res = await pay({ method: 'card', expected_amount: 500, return_to: 'estimate' });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(historyRows()).toHaveLength(1));
    expect(historyRows()[0]).toMatchObject({ resource_type: 'Estimate', resource_id: ESTIMATE_ID, org_id: 'org-test-1', actor_id: null });
  });

  it('writes nothing when the door refuses (the figure moved)', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit());

    const res = await pay({ method: 'card', expected_amount: 450, return_to: 'estimate' });

    expect(res.status).toBe(409);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(historyRows()).toHaveLength(0);
  });

  it('an ordinary invoice writes no estimate history', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ ...deposit(), kind: 'STANDARD', estimate: null });

    await pay({ method: 'card' });

    expect(historyRows()).toHaveLength(0);
  });
});

describe('where the deposit door returns the customer', () => {
  it('a signed estimate paying its deposit comes back as an approval, to the estimate page', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit({ estimateStatus: 'PENDING' }));

    await pay({ method: 'card', expected_amount: 500, return_to: 'estimate' });

    expect(session().successUrl).toMatch(new RegExp(`/p/estimates/${ESTIMATE_ID}\\?token=est-tok&payment=success&method=card$`));
    expect(session().cancelUrl).toMatch(new RegExp(`/p/estimates/${ESTIMATE_ID}\\?token=est-tok&payment=cancelled$`));
  });

  it('a won estimate paying its open deposit keeps the deposit return', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit({ estimateStatus: 'WON' }));

    await pay({ method: 'card', expected_amount: 500, return_to: 'estimate' });

    expect(session().successUrl).toMatch(/&payment=success&method=card&deposit=1$/);
  });
});
