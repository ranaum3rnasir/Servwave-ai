import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override the global env mock (setup.ts) so the email module initializes a
// real Resend client instead of short-circuiting on a missing key.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    // Deliberately DIFFERENT values: EMAIL_FROM is the root domain reserved for
    // auth-critical mail that bypasses dispatchEmail, EMAIL_FROM_BUSINESS is the
    // subdomain every dispatchEmail send actually leaves from. A mirror row that
    // records the former is recording an address the mail did not come from.
    EMAIL_FROM: 'noreply@test.servwave.com',
    EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

// Every email payload Resend would send goes through this fn.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

// sendInvoiceEmail now attaches a rendered PDF — stub the renderer so this suite
// stays focused on send-path persistence, not pdfmake.
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { persistTransactionalEmail } from '../lib/comm-persist';

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
let sendInvoiceEmail: typeof import('../lib/email')['sendInvoiceEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendInvoiceEmail = real.sendInvoiceEmail;
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const VENDOR_ID = 'd0000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
  // renderInvoicePdfBuffer's own lookups — generateInvoicePdf is stubbed above, so only
  // truthiness matters here, not the exact shape.
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: 'Acme Plumbing' });
});

// ─── persistTransactionalEmail (unit) ───────────────────

describe('persistTransactionalEmail', () => {
  it('creates a system Email row in the sent folder', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      subject: 'Invoice I00001 from ServWave',
      text: 'Hi John, invoice I00001 is ready.',
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account: 'system',
          from: { name: 'Alpha Co', email: 'noreply@mail.test.servwave.com' },
          to: 'cust@example.com',
          subject: 'Invoice I00001 from ServWave',
          snippet: 'Hi John, invoice I00001 is ready.',
          body: ['Hi John, invoice I00001 is ready.'],
          at: expect.any(String),
          ts: expect.any(Number),
          unread: false,
          starred: false,
          folder: 'sent',
          organization_id: ORG_ID,
        }),
      }),
    );
  });

  it('stamps job + customer + lead attribution when provided', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      leadId: LEAD_ID,
      jobId: JOB_ID,
      jobLabel: 'J00042',
      to: 'cust@example.com',
      subject: 'Service Scheduled: J00042',
      text: 'Your service has been scheduled.',
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customer_id: CUSTOMER_ID,
          lead_id: LEAD_ID,
          job_id: JOB_ID,
          job_label: 'J00042',
        }),
      }),
    );
  });

  // Vendors are the outside party on a purchase order. The column exists on the
  // Email model already; only the persist helper could not reach it (BUG C).
  it('stamps vendor attribution when provided', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      vendorId: VENDOR_ID,
      to: 'orders@acme.com',
      subject: 'Purchase Order PO-1001',
      text: 'Please find PO-1001 attached.',
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vendor_id: VENDOR_ID }),
      }),
    );
  });

  // The row exists BECAUSE a dispatch came back sent, so SENT is the honest
  // starting state, and the provider id is what a later delivery webhook will
  // find this row by.
  it('records the provider message id and an initial SENT delivery status', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      subject: 'Invoice I00001',
      text: 'Body',
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
      providerMessageId: 're_abc123',
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider_message_id: 're_abc123',
          delivery_status: 'SENT',
          delivery_status_at: expect.any(Date),
        }),
      }),
    );
  });

  // A null id is a real send we simply cannot correlate later. Still SENT.
  it('persists a null provider message id without downgrading the delivery status', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      subject: 'Invoice I00001',
      text: 'Body',
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
      providerMessageId: null,
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider_message_id: null,
          delivery_status: 'SENT',
        }),
      }),
    );
  });

  it('persists null attribution when not provided (cold transactional send)', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      subject: 'Estimate E00001',
      text: 'Your estimate is ready.',
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customer_id: null,
          lead_id: null,
          job_id: null,
          job_label: null,
        }),
      }),
    );
  });

  it('uses fromName when provided', async () => {
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      subject: 'Deposit Receipt — E00001',
      text: 'Deposit received.',
      fromName: 'Northwind Services',
      fromAddress: 'noreply@mail.test.servwave.com',
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          from: { name: 'Northwind Services', email: 'noreply@mail.test.servwave.com' },
        }),
      }),
    );
  });

  it('truncates the snippet to 200 characters', async () => {
    const text = 'x'.repeat(300);
    await persistTransactionalEmail({
      organizationId: ORG_ID,
      to: 'cust@example.com',
      subject: 'Long',
      text,
      fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
    });

    const call = (prisma.email.create as Mock).mock.calls[0][0];
    expect(call.data.snippet).toHaveLength(200);
    expect(call.data.body).toEqual([text]);
  });

  it('never throws when prisma fails — swallows and logs the error', async () => {
    (prisma.email.create as Mock).mockRejectedValueOnce(new Error('db down'));

    await expect(
      persistTransactionalEmail({
        organizationId: ORG_ID,
        to: 'cust@example.com',
        subject: 'Subject',
        text: 'Body',
        fromAddress: 'noreply@mail.test.servwave.com', fromName: 'Alpha Co',
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

// ─── Send-path wiring (real email.ts) ───────────────────

describe('transactional send-path persistence (sendInvoiceEmail)', () => {
  const baseParams = {
    invoiceId: 'inv-1',
    to: 'cust@example.com',
    customerName: 'John Doe',
    invoiceNumber: 'I00042',
    total: 500,
    amountDue: 500,
    dueDate: '2026-07-01',
    publicUrl: 'https://app.example/i/tok',
  };

  it('persists a job-tagged Email row when a record is passed', async () => {
    // The invoice subject names the sending org, so give the lookup a real row.
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: 'Acme Plumbing',
    });

    await sendInvoiceEmail({
      organizationId: ORG_ID,
      ...baseParams,
      record: {
        organizationId: ORG_ID,
        customerId: CUSTOMER_ID,
        jobId: JOB_ID,
        jobLabel: 'J00042',
      },
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account: 'system',
          folder: 'sent',
          to: 'cust@example.com',
          subject: 'Invoice I00042 from Acme Plumbing',
          customer_id: CUSTOMER_ID,
          job_id: JOB_ID,
          job_label: 'J00042',
          organization_id: ORG_ID,
        }),
      }),
    );
  });

  // BUG B: the mirror used to hardcode env.EMAIL_FROM (the auth-critical root
  // domain) while dispatchEmail transmitted from env.EMAIL_FROM_BUSINESS, so
  // every row on the Communication tab named an address the mail never came
  // from. The address now travels out of the dispatch result itself.
  it('records the address dispatchEmail actually transmitted from, not the auth-critical root domain', async () => {
    await sendInvoiceEmail({
      organizationId: ORG_ID,
      ...baseParams,
      record: { organizationId: ORG_ID, customerId: CUSTOMER_ID },
    });

    const data = (prisma.email.create as Mock).mock.calls[0]![0].data;
    // The local part now carries the org name; the DOMAIN half is what this
    // test is really about - the business subdomain, never the auth root.
    expect(data.from.email).toBe('acmeplumbing@mail.test.servwave.com');
    expect(data.from.email).not.toContain('@test.servwave.com');
  });

  it('carries the Resend message id through the send path onto the persisted row', async () => {
    resendSend.mockResolvedValue({ data: { id: 're_live_42' }, error: null });

    await sendInvoiceEmail({
      organizationId: ORG_ID,
      ...baseParams,
      record: { organizationId: ORG_ID, customerId: CUSTOMER_ID },
    });

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider_message_id: 're_live_42',
          delivery_status: 'SENT',
        }),
      }),
    );
  });

  it('persists nothing when no record is passed', async () => {
    await sendInvoiceEmail({ organizationId: ORG_ID, ...baseParams });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  // sendInvoiceEmail reports the outcome in its RETURN value rather than throwing
  // (#973 — "block false-success send/resend when email fails"), so these two assert
  // the reported status, not `undefined`: a failed send must say so, and a failed
  // persistence must not downgrade a send that genuinely went out.
  it('does not persist when the resend send fails, and reports the failure', async () => {
    resendSend.mockRejectedValueOnce(new Error('resend down'));

    await expect(
      sendInvoiceEmail({
        organizationId: ORG_ID,
        ...baseParams,
        record: { organizationId: ORG_ID, jobId: JOB_ID, jobLabel: 'J00042' },
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('a persistence failure does not reject the send path, and still reports sent', async () => {
    (prisma.email.create as Mock).mockRejectedValueOnce(new Error('db down'));

    await expect(
      sendInvoiceEmail({
        organizationId: ORG_ID,
        ...baseParams,
        record: { organizationId: ORG_ID, jobId: JOB_ID, jobLabel: 'J00042' },
      }),
    ).resolves.toMatchObject({ status: 'sent' });

    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});

// The walkthrough-scheduled hard-coded sender that used to live here (customer +
// performer + owner fan-out, customer-only Communication-tab persistence) was
// retired by the 2026-07-27 Phase 3 cutover — WALKTHROUGH_SCHEDULED now goes
// through the Automation Center's generic SEND_EMAIL action instead, which has
// its own (different) per-recipient persistence scoping. See
// executors.test.ts's "SEND_EMAIL — Communication-tab persistence scoping" for
// the equivalent coverage at the new call site.
