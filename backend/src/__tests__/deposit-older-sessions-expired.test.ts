/**
 * Payments go-live slice 27 (slice 15 acceptance 3) - minting a new deposit checkout closes the
 * earlier ones, so a customer who opened card and bank (or reloaded) never holds several live links
 * to the same deposit. The new session is kept; an ordinary invoice is left alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  isStripeConfigured, createCheckoutSession, getStripeForOrg, expireOpenCheckoutSessionsForInvoice,
} from '../lib/stripe';
import { ESTIMATE_SENT_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;
const mockExpireOpen = expireOpenCheckoutSessionsForInvoice as unknown as ReturnType<typeof vi.fn>;

const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TOKEN = 'deposit-link-token';

function depositInvoice(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'INV-2001',
    status: 'SENT',
    kind: 'DEPOSIT',
    amount_due: 500,
    total_amount: 500,
    customer: { first_name: 'Pat', last_name: 'Q', company_name: null },
    job: null,
    estimate: { status: 'SENT', modified_after_send: false, deposit_type: 'FIXED', deposit_value: 500, total_amount: 1000 },
    organization: {
      id: 'org-test-1', stripe_account_id: 'acct_test', accepted_payment_methods: ['CARD'], stripe_charges_enabled: true,
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    },
    payments: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.invoice.findFirst.mockReset();
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  vi.mocked(isStripeConfigured).mockReturnValue(true);
  vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: 'acct_test' } as any);
  vi.mocked(createCheckoutSession).mockResolvedValue({ id: 'cs_new', url: 'https://checkout.example/new' } as any);
});

describe('deposit link checkout', () => {
  it('expires the earlier open sessions of the deposit, keeping the one just minted', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice());

    const res = await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockExpireOpen).toHaveBeenCalledWith(INVOICE_ID, expect.anything(), { exceptSessionId: 'cs_new' });
  });

  it('leaves an ordinary invoice alone', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue(depositInvoice({ kind: 'STANDARD', estimate: null }));

    await request(app).post(`/api/invoices/${INVOICE_ID}/public/checkout?token=${TOKEN}`);

    expect(mockExpireOpen).not.toHaveBeenCalled();
  });
});

describe('estimate approval checkout', () => {
  it('expires the earlier open sessions of the deposit, keeping the one just minted', async () => {
    const id = ESTIMATE_SENT_FIXTURE.id;
    mockPrisma.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function' ? (arg as any)({ estimate: mockPrisma.estimate, invoice: mockPrisma.invoice, timelineEvent: mockPrisma.timelineEvent, lead: mockPrisma.lead }) : Promise.all(arg as any[]));
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id, status: 'SENT', estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number, lead_id: null, lead: null,
      organization_id: 'org-test-1', total_amount: 1000, valid_until: new Date('2099-12-31'), signature_data: null,
      snapshot_terms: null, modified_after_send: false, deposit_type: 'PERCENTAGE', deposit_value: 50, deposit_policy: null,
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, payments: [] }],
      send_config: { deposit_required: true, payment_methods: ['CARD'] },
      organization: { id: 'org-test-1', stripe_account_id: 'acct_test', stripe_charges_enabled: true, accepted_payment_methods: ['CARD'], deposit_policy: 'REQUIRED_BEFORE_APPROVAL' },
    });
    mockPrisma.estimate.update.mockResolvedValue({ id, status: 'PENDING', line_items: [], invoices: [] });
    mockPrisma.estimate.findUnique.mockResolvedValue(null);
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/estimates/${id}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,AAA', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/new');
    expect(mockExpireOpen).toHaveBeenCalledWith('dep-1', expect.anything(), { exceptSessionId: 'cs_new' });
  });
});
