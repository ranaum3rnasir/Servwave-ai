/**
 * lead-contact-clock-transactional.test.ts — spec #1751 D5, the OTHER email writer.
 *
 * `persistTransactionalEmail` mirrors every notice the platform sends on the company's behalf:
 * estimate and invoice notices, purchase orders, appointment confirmations. None of them is a
 * salesperson reaching out, so none of them may set `leads.contacted_at` — user stories 12 and 13
 * are about exactly this, because a metric that counts the software's own mail measures the
 * software rather than the people.
 *
 * WHY A SECOND FILE. Every transactional sender lives in `lib/email.ts`, which setup.ts mocks
 * globally, so no HTTP door in the shared harness reaches this code at all. Getting to it needs
 * module-scope `env` and `resend` overrides — the established shape, copied from
 * comm-persist.test.ts — and those overrides would break every door in lead-contact-clock.test.ts.
 * So the assertions run through a REAL sender with the provider stubbed, which is a stronger claim
 * than calling the persist helper by hand: it proves an actual invoice notice to a lead is filed
 * as automated and stamps nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override setup.ts's env mock so the email module builds a real Resend client instead of
// short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'noreply@test.servwave.com',
    EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

// The invoice sender attaches a rendered PDF; this suite is about provenance, not pdfmake.
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
let sendInvoiceEmail: typeof import('../lib/email')['sendInvoiceEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendInvoiceEmail = real.sendInvoiceEmail;
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const LEAD_ID = 'e0000000-0000-0000-0000-0000000000c1';

const INVOICE_PARAMS = {
  invoiceId: 'inv-1',
  to: 'cust@example.com',
  customerName: 'John Doe',
  invoiceNumber: 'I00042',
  total: 500,
  amountDue: 500,
  dueDate: '2026-09-01',
  publicUrl: 'https://app.example/i/tok',
};

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    email_sending_enabled: true,
    name: 'Acme Plumbing',
  });
  (prisma.lead.updateMany as Mock).mockResolvedValue({ count: 1 });
});

describe('transactional email provenance (spec #1751 D5)', () => {
  it('files a real invoice notice as AUTOMATED', async () => {
    await sendInvoiceEmail({
      organizationId: ORG_ID,
      ...INVOICE_PARAMS,
      record: { organizationId: ORG_ID, customerId: CUSTOMER_ID, leadId: LEAD_ID },
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account: 'system',
          direction: 'out',
          lead_id: LEAD_ID,
          // The whole point. `true` is written outright rather than inferred from the absence of a
          // thread id — that structural proxy is rejected in schema.prisma, because this function
          // already accepts a `threadId` and the first sender to pass one would otherwise mark
          // every lead in the system contacted.
          automated: true,
        }),
      }),
    );
  });

  // THE NEGATIVE, asserted outright. An automated notice reaches a lead constantly (a booked
  // walkthrough sends one the moment the lead is created), so if this leaked, every lead in the
  // org would read as contacted within seconds of arriving and the response-time report would
  // show a company that answers instantly. Nothing would go red.
  it('does NOT stamp the lead contact clock for an automated notice', async () => {
    await sendInvoiceEmail({
      organizationId: ORG_ID,
      ...INVOICE_PARAMS,
      record: { organizationId: ORG_ID, customerId: CUSTOMER_ID, leadId: LEAD_ID },
    });

    expect(prisma.email.create).toHaveBeenCalledTimes(1);
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});
