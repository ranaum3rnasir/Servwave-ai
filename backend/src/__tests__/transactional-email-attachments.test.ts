import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

/*
 * #2251 - a transactional send that carried a PDF must be recorded as having
 * carried one.
 *
 * The four attaching senders (three estimate paths, one invoice path) put a
 * rendered PDF on the message and then mirrored it as an Email row that said
 * `has_attachment = false` with no EmailAttachment rows: the column fell to its
 * schema default because persistTransactionalEmail never set it, and nothing
 * about the attachment survived the hop from the dispatch to the persist call.
 *
 * The model is the human compose path (comm-whatsapp-email.controller.ts
 * sendEmail): `has_attachment` is stated on the row, and each file is stored
 * under `{orgId}/email/{emailId}/` and gets an EmailAttachment row whose
 * storage_path the download route signs.
 *
 * Deliberately a separate suite from email-persistence-honesty.test.ts, which
 * asserts a different claim (a row exists on a real send and not otherwise)
 * and is left as it is.
 *
 * Same module-mocking idiom as that suite: setup.ts mocks '../lib/email'
 * globally, so the REAL module is pulled in beforeAll.
 */

const { resendSend, upload } = vi.hoisted(() => ({ resendSend: vi.fn(), upload: vi.fn() }));

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

// Distinct bytes per document type, so an assertion that the STORED bytes are
// the SENT bytes cannot be satisfied by some other buffer that happens to match.
const ESTIMATE_PDF = Buffer.from('%PDF-1.4 estimate bytes');
const INVOICE_PDF = Buffer.from('%PDF-1.4 invoice bytes, a different length');

vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockImplementation(async () => ESTIMATE_PDF),
  generateInvoicePdf: vi.fn().mockImplementation(async () => INVOICE_PDF),
}));

import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { persistTransactionalEmail } from '../lib/comm-persist';

type Email = typeof import('../lib/email');
let email: Email;

beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const EMAIL_ROW_ID = 'e1000000-0000-0000-0000-000000000001';
const ORG = { id: ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A' };
const RECORD = { organizationId: ORG_ID, customerId: CUSTOMER_ID };

const ESTIMATE_ROW = {
  estimate_number: 'E00001', status: 'WON', created_at: new Date(), subtotal: 100, tax_rate: 0,
  tax_amount: 0, total_amount: 100, signature_data: null, signature_at: null, snapshot_terms: null,
  snapshot_notes: null, snapshot_payment_terms: null, organization_id: ORG_ID,
  lead: {
    service_address_line1: null, service_address_line2: null, service_city: null,
    service_state: null, service_zip: null,
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@example.com', phone: null, service_locations: [] },
  },
  line_items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_ok' }, error: null });
  upload.mockResolvedValue({ data: { path: 'stored' }, error: null });
  (supabaseAdmin.storage.from as Mock).mockReturnValue({ upload });
  (prisma.email.create as Mock).mockResolvedValue({ id: EMAIL_ROW_ID });
  (prisma.emailAttachment.create as Mock).mockResolvedValue({});
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: ORG.name });
  (prisma.estimate.findUnique as Mock).mockResolvedValue(ESTIMATE_ROW);
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
});

const ATTACHING_SENDERS: {
  name: string;
  fileName: string;
  bytes: Buffer;
  run: (e: Email) => Promise<unknown>;
}[] = [
  {
    name: 'sendEstimateEmail',
    fileName: 'estimate-E00001.pdf',
    bytes: ESTIMATE_PDF,
    run: (e) => e.sendEstimateEmail({
      estimateId: 'est-1', org: ORG, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', total: '$100.00', publicUrl: 'https://x/e', record: RECORD,
    }),
  },
  {
    name: 'sendEstimateApprovedNotification',
    fileName: 'estimate-E00001.pdf',
    bytes: ESTIMATE_PDF,
    run: (e) => e.sendEstimateApprovedNotification({
      estimateId: 'est-1', org: ORG, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', total: '$100.00', record: RECORD,
    }),
  },
  {
    name: 'sendEstimateWithDepositEmail',
    fileName: 'estimate-E00001.pdf',
    bytes: ESTIMATE_PDF,
    run: (e) => e.sendEstimateWithDepositEmail({
      estimateId: 'est-1', org: ORG, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', total: '$100.00', depositAmount: '$50.00', depositPercentage: 50,
      publicUrl: 'https://x/e', record: RECORD,
    }),
  },
  {
    name: 'sendInvoiceEmail',
    fileName: 'invoice-I00001.pdf',
    bytes: INVOICE_PDF,
    run: (e) => e.sendInvoiceEmail({
      invoiceId: 'inv-1', organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      invoiceNumber: 'I00001', total: 100, amountDue: 100, dueDate: new Date().toISOString(),
      publicUrl: 'https://x/i', record: RECORD,
    }),
  },
];

/** The data object of the one Email row the send wrote. */
function persistedRow(): Record<string, unknown> {
  expect(prisma.email.create).toHaveBeenCalledTimes(1);
  return (prisma.email.create as Mock).mock.calls[0][0].data;
}

describe('#2251 - an attaching transactional send records its attachment', () => {
  for (const { name, fileName, bytes, run } of ATTACHING_SENDERS) {
    describe(name, () => {
      it('the dispatch really carried the PDF (control: the premise of every assertion below)', async () => {
        await run(email);
        expect(resendSend).toHaveBeenCalledTimes(1);
        expect(resendSend.mock.calls[0][0].attachments).toEqual([{ filename: fileName, content: bytes }]);
      });

      it('persists has_attachment = true on the mirrored row', async () => {
        await run(email);
        // toBe(true), not objectContaining: an absent key is exactly the bug.
        expect(persistedRow().has_attachment).toBe(true);
      });

      it('stores the exact bytes that were sent, under the email row\'s own storage prefix', async () => {
        await run(email);
        expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('attachments');
        expect(upload).toHaveBeenCalledTimes(1);
        const [path, body, opts] = upload.mock.calls[0];
        expect(path).toMatch(new RegExp(`^${ORG_ID}/email/${EMAIL_ROW_ID}/\\d+-${fileName.replace('.', '\\.')}$`));
        expect(Buffer.compare(body, bytes)).toBe(0);
        expect(opts).toEqual({ contentType: 'application/pdf', upsert: false });
      });

      it('creates an EmailAttachment row pointing at the stored object', async () => {
        await run(email);
        const storedAt = upload.mock.calls[0][0];
        expect(prisma.emailAttachment.create).toHaveBeenCalledTimes(1);
        expect(prisma.emailAttachment.create).toHaveBeenCalledWith({
          data: {
            email_id: EMAIL_ROW_ID,
            file_name: fileName,
            content_type: 'application/pdf',
            file_size: bytes.length,
            storage_path: storedAt,
            position: 0,
            organization_id: ORG_ID,
          },
        });
      });

      it('a storage failure still records has_attachment and never leaves a row without an object', async () => {
        upload.mockResolvedValue({ data: null, error: { message: 'bucket unavailable' } });
        const result = await run(email);
        expect(persistedRow().has_attachment).toBe(true);
        expect(prisma.emailAttachment.create).not.toHaveBeenCalled();
        // The email left; bookkeeping must not report it as failed.
        if (result !== undefined) expect((result as { status: string }).status).toBe('sent');
      });
    });
  }
});

describe('#2251 - a send with no attachment says so', () => {
  it('sendPaymentReceivedEmail persists has_attachment = false and stores nothing', async () => {
    await email.sendPaymentReceivedEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      invoiceNumber: 'I00001', amount: 50, method: 'CARD', newBalance: 0, record: RECORD,
    });
    expect(persistedRow().has_attachment).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emailAttachment.create).not.toHaveBeenCalled();
  });
});

describe('persistTransactionalEmail - attachments (unit)', () => {
  const BASE = {
    organizationId: ORG_ID,
    to: 'jane@example.com',
    subject: 'Two documents',
    text: 'Hi',
    fromAddress: 'noreply@mail.test.servwave.com',
    fromName: null,
  };

  it('stores every attachment in order, with its position', async () => {
    await persistTransactionalEmail({
      ...BASE,
      attachments: [
        { filename: 'first.pdf', content: Buffer.from('one'), contentType: 'application/pdf' },
        { filename: 'second copy.pdf', content: Buffer.from('two!'), contentType: 'application/pdf' },
      ],
    });
    expect(persistedRow().has_attachment).toBe(true);
    const rows = (prisma.emailAttachment.create as Mock).mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => [r.file_name, r.position, r.file_size])).toEqual([
      ['first.pdf', 0, 3],
      ['second copy.pdf', 1, 4],
    ]);
    // The storage key is sanitized; the display name is not.
    expect(rows[1].storage_path).toMatch(/\/\d+-second_copy\.pdf$/);
  });

  it('one failed upload does not cost the others their rows', async () => {
    upload
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
      .mockResolvedValueOnce({ data: { path: 'ok' }, error: null });
    await persistTransactionalEmail({
      ...BASE,
      attachments: [
        { filename: 'lost.pdf', content: Buffer.from('a'), contentType: 'application/pdf' },
        { filename: 'kept.pdf', content: Buffer.from('b'), contentType: 'application/pdf' },
      ],
    });
    const rows = (prisma.emailAttachment.create as Mock).mock.calls.map((c) => c[0].data);
    expect(rows.map((r) => [r.file_name, r.position])).toEqual([['kept.pdf', 1]]);
  });

  it('an upload that throws is contained - never escapes the persist call', async () => {
    upload.mockRejectedValue(new Error('network down'));
    await expect(persistTransactionalEmail({
      ...BASE,
      attachments: [{ filename: 'x.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }],
    })).resolves.toBeUndefined();
    expect(persistedRow().has_attachment).toBe(true);
    expect(prisma.emailAttachment.create).not.toHaveBeenCalled();
  });

  it('a storage upload that never answers is abandoned after 10s, not awaited forever', async () => {
    // The senders' callers only mark the estimate/invoice SENT after this
    // returns, so a hung storage call would hold that write hostage to a
    // customer who already has the email.
    vi.useFakeTimers();
    try {
      upload.mockReturnValue(new Promise(() => {}));
      let settled = false;
      const done = persistTransactionalEmail({
        ...BASE,
        attachments: [{ filename: 'x.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }],
      }).then(() => { settled = true; });

      // Genuinely awaited up to the bound - not simply skipped.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(settled).toBe(true);
      expect(persistedRow().has_attachment).toBe(true);
      // No row for an object that may never land.
      expect(prisma.emailAttachment.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an EmailAttachment write that rejects after a good upload is contained', async () => {
    (prisma.emailAttachment.create as Mock)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({});
    await expect(persistTransactionalEmail({
      ...BASE,
      attachments: [
        { filename: 'a.pdf', content: Buffer.from('a'), contentType: 'application/pdf' },
        { filename: 'b.pdf', content: Buffer.from('b'), contentType: 'application/pdf' },
      ],
    })).resolves.toBeUndefined();
    // The second file is still attempted after the first row failed.
    expect(upload).toHaveBeenCalledTimes(2);
    expect(prisma.emailAttachment.create).toHaveBeenCalledTimes(2);
  });

  it('no Email row means nothing is uploaded - there is no email id to store under', async () => {
    (prisma.email.create as Mock).mockRejectedValue(new Error('db down'));
    await expect(persistTransactionalEmail({
      ...BASE,
      attachments: [{ filename: 'x.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }],
    })).resolves.toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.emailAttachment.create).not.toHaveBeenCalled();
  });

  it('no attachments: has_attachment = false and storage is never touched', async () => {
    await persistTransactionalEmail(BASE);
    expect(persistedRow().has_attachment).toBe(false);
    expect(supabaseAdmin.storage.from).not.toHaveBeenCalled();
  });
});
