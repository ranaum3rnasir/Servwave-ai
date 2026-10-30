/**
 * Payments go-live slice 27 - a deposit paid from the ESTIMATE page comes back to the estimate page.
 * The deposit invoice page stays the return for a customer who started on that page.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { isStripeConfigured, createCheckoutSession, getStripeForOrg } from '../lib/stripe';

const mockPrisma = prisma as unknown as Record<string, any>;
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function deposit(estimate: Record<string, unknown> | null = { id: 'est-1', public_token: 'est-tok', status: 'WON', modified_after_send: false, deposit_type: 'FIXED', deposit_value: 500, total_amount: 1000 }) {
  return {
    id: INVOICE_ID, invoice_number: 'INV-2001', status: 'SENT', kind: 'DEPOSIT', amount_due: 500, total_amount: 500,
    customer: { first_name: 'Pat', last_name: 'Q', company_name: null }, job: null, estimate,
    organization: { id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD'], stripe_charges_enabled: true, deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0 },
    payments: [],
  };
}

const pay = (body: Record<string, unknown>) => request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=dep-tok`).send(body);
const urls = () => (vi.mocked(createCheckoutSession).mock.calls[0][0] as any);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.invoice.findFirst.mockReset();
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  vi.mocked(isStripeConfigured).mockReturnValue(true);
  vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: 'acct_test' } as any);
  vi.mocked(createCheckoutSession).mockResolvedValue({ id: 'cs_1', url: 'https://checkout.example/x' } as any);
});

describe('deposit checkout return address', () => {
  it('returns to the estimate page when the estimate page asked, keeping the method', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit());

    const res = await pay({ method: 'card', return_to: 'estimate' });

    expect(res.status).toBe(200);
    expect(urls().successUrl).toMatch(/\/p\/estimates\/est-1\?token=est-tok&payment=success&method=card&deposit=1$/);
    expect(urls().cancelUrl).toMatch(/\/p\/estimates\/est-1\?token=est-tok&payment=cancelled$/);
  });

  it('returns to the deposit invoice page when nothing asked otherwise', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit());

    await pay({ method: 'card' });

    expect(urls().successUrl).toMatch(/\/p\/invoices\/aaaaaaaa-0000-4000-8000-000000000001\?token=dep-tok&payment=success&method=card$/);
  });

  it('falls back to the invoice page when the estimate link was withdrawn (no public token)', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(deposit({ id: 'est-1', public_token: null, status: 'WON', modified_after_send: false, deposit_type: 'FIXED', deposit_value: 500, total_amount: 1000 }));

    await pay({ method: 'card', return_to: 'estimate' });

    expect(urls().successUrl).toContain('/p/invoices/');
  });

  it('ignores the request on an ordinary invoice', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ ...deposit(null), kind: 'STANDARD' });

    await pay({ method: 'card', return_to: 'estimate' });

    expect(urls().successUrl).toContain('/p/invoices/');
  });
});
