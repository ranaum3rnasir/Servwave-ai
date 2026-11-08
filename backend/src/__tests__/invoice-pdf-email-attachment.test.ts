import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import { generateInvoicePdf } from '../lib/pdf';

let sendInvoiceEmail: typeof import('../lib/email')['sendInvoiceEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendInvoiceEmail = real.sendInvoiceEmail;
});

const ORG = {
  id: 'org-1',
  name: 'Acme',
  logo_url: null,
  brand_color: '#0C2D3A',
  estimate_template: 'alpha-classic',
  email_sending_enabled: true,
};

const INVOICE_ROW = {
  invoice_number: 'I00001',
  status: 'SENT',
  created_at: new Date(),
  due_date: new Date(),
  organization_id: ORG.id,
  subtotal: 100,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  deposit_credit: 0,
  total_amount: 100,
  amount_due: 100,
  scopes: null,
  customer: {
    first_name: 'Jane',
    last_name: 'Doe',
    company_name: null,
    email: 'jane@example.com',
    phone: null,
    service_locations: [],
  },
  job: null,
  line_items: [],
  payments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue(ORG);
  (prisma.invoice.findUnique as Mock).mockResolvedValue(INVOICE_ROW);
  (prisma.email.create as Mock).mockResolvedValue({});
});

const BASE_PARAMS = {
  invoiceId: 'inv-1',
  organizationId: ORG.id,
  to: 'jane@example.com',
  customerName: 'Jane Doe',
  invoiceNumber: 'I00001',
  total: 100,
  amountDue: 100,
  dueDate: new Date().toISOString(),
  publicUrl: 'https://x/y',
};

describe('sendInvoiceEmail — attaches the invoice PDF', () => {
  it('renders the invoice PDF and attaches it to the outgoing email', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });

    const res = await sendInvoiceEmail(BASE_PARAMS);

    expect(res).toEqual({ status: 'sent', providerMessageId: 're_1', fromAddress: 'Alpha <noreply@test.com>', fromName: 'Acme' });
    expect(generateInvoicePdf).toHaveBeenCalledTimes(1);
    const sendCall = resendSend.mock.calls.at(-1)?.[0];
    expect(sendCall.attachments).toEqual([
      { filename: 'invoice-I00001.pdf', content: Buffer.from('%PDF-1.4 fake') },
    ]);
  });

  it('fetches the invoice by the id passed in params, not a hardcoded default', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });

    await sendInvoiceEmail(BASE_PARAMS);

    expect(prisma.invoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'inv-1' }) }),
    );
  });

  it('renders the SAME template the org has picked (org.estimate_template)', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
    (prisma.organization.findUnique as Mock).mockResolvedValue({ ...ORG, estimate_template: 'crm-default' });

    await sendInvoiceEmail(BASE_PARAMS);

    const call = vi.mocked(generateInvoicePdf).mock.calls.at(-1);
    expect(call?.[2]).toBe('crm-default');
  });

  it('fails the whole send (no partial email) when PDF rendering throws', async () => {
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);

    const res = await sendInvoiceEmail(BASE_PARAMS);

    expect(res.status).toBe('failed');
    expect(resendSend).not.toHaveBeenCalled();
  });
});
