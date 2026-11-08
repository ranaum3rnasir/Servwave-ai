import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

/*
 * Persistence honesty across the transactional senders.
 *
 * Two defects, one theme - the Communication tab must not describe mail that
 * never left the building, and must not stay silent about mail that did.
 *
 * BUG A: six senders called persistTransactionalEmail unconditionally after
 *   dispatchEmail, so a send suppressed by the org kill switch, or rejected by
 *   Resend, still left a "sent"-shaped row on the customer timeline. The four
 *   senders that already got this right (sendEstimateEmail,
 *   sendEstimateWithDepositEmail, sendInvoiceEmail, sendAutomationEmail) gate on
 *   `result.status === 'sent'`; these six now match that idiom.
 *
 * BUG C: the outside-party senders persisted nothing at all, so there was no
 *   evidence a pickup ticket was ever sent. (The vendor PO sender that shared
 *   this bug was removed outright - ServWave does not send POs.)
 *
 * Same module-mocking idiom as email-org-toggle.test.ts: setup.ts mocks
 * '../lib/email' globally, so the REAL module is pulled in beforeAll.
 */

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

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

// sendEstimateApprovedNotification attaches a rendered PDF - stub the renderer so
// this suite stays focused on persistence, not pdfmake.
vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';

type Email = typeof import('../lib/email');
let email: Email;

beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
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
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
  (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: true, name: ORG.name });
  (prisma.estimate.findUnique as Mock).mockResolvedValue(ESTIMATE_ROW);
});

// ─── BUG A: the six unconditional persisters ─────────────
//
// Each entry invokes one sender with a `record`, so a persisted row is the
// sender's own decision and nothing else's.

const BUG_A_SENDERS: { name: string; run: (e: Email) => Promise<unknown> }[] = [
  {
    name: 'sendEstimateApprovedNotification',
    run: (e) => e.sendEstimateApprovedNotification({
      estimateId: 'est-1', org: ORG, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', total: '$100.00', record: RECORD,
    }),
  },
  {
    name: 'sendDepositPaymentConfirmation',
    run: (e) => e.sendDepositPaymentConfirmation({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', depositAmount: 50, totalCharged: 50, paymentMethod: 'Card',
      companyName: ORG.name, record: RECORD,
    }),
  },
  {
    name: 'sendDepositReceivedConfirmation',
    run: (e) => e.sendDepositReceivedConfirmation({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', depositAmount: 50, paymentMethod: 'CHECK',
      receivedDate: '2026-08-04', companyName: ORG.name, record: RECORD,
    }),
  },
  {
    name: 'sendRefundNotification',
    run: (e) => e.sendRefundNotification({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      estimateNumber: 'E00001', refundAmount: 50, reason: 'Cancelled', companyName: ORG.name,
      record: RECORD,
    }),
  },
  {
    name: 'sendInvoiceRefundNotification',
    run: (e) => e.sendInvoiceRefundNotification({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      invoiceNumber: 'I00001', refundAmount: 50, record: RECORD,
    }),
  },
  {
    name: 'sendPaymentReceivedEmail',
    run: (e) => e.sendPaymentReceivedEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      invoiceNumber: 'I00001', amount: 50, method: 'CARD', newBalance: 0, record: RECORD,
    }),
  },
];

describe('BUG A - senders must not mirror a send that did not happen', () => {
  for (const { name, run } of BUG_A_SENDERS) {
    describe(name, () => {
      it('persists a row on a real send (control - proves the assertions below are not vacuous)', async () => {
        await run(email);

        expect(resendSend).toHaveBeenCalledTimes(1);
        expect(prisma.email.create).toHaveBeenCalledTimes(1);
      });

      it('persists NOTHING when the org kill switch suppressed the send', async () => {
        (prisma.organization.findUnique as Mock).mockResolvedValue({ email_sending_enabled: false });

        await run(email);

        expect(resendSend).not.toHaveBeenCalled();
        expect(prisma.email.create).not.toHaveBeenCalled();
      });

      it('persists NOTHING when Resend rejects the message', async () => {
        resendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });

        await run(email);

        expect(prisma.email.create).not.toHaveBeenCalled();
      });
    });
  }
});

// ─── BUG C: the two outside-party senders ────────────────

describe('BUG C - outside-party sends leave a record', () => {
  const STAGE_PARAMS = {
    organizationId: ORG_ID,
    org: ORG,
    to: 'tech@acme.com',
    jobNumber: 'J00042',
    customer: 'Jane Doe',
    site: '1 Main St',
    lines: [{ sku: 'LOCK-100', name: 'Deadbolt', qtyReceived: 5, qtyOrdered: 5, uom: 'EA' }],
    record: { organizationId: ORG_ID, jobId: JOB_ID, jobLabel: 'J00042' },
  };

  it('sendStagePickupEmail persists a job-attributed row', async () => {
    await email.sendStagePickupEmail(STAGE_PARAMS);

    expect(prisma.email.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account: 'system',
          folder: 'sent',
          to: 'tech@acme.com',
          job_id: JOB_ID,
          job_label: 'J00042',
          organization_id: ORG_ID,
        }),
      }),
    );
  });

  it('sendStagePickupEmail persists NOTHING when Resend rejects the message', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

    await email.sendStagePickupEmail(STAGE_PARAMS);

    expect(prisma.email.create).not.toHaveBeenCalled();
  });
});

// ─── Deliberately NOT persisted: the six internal staff alerts ──
//
// sendDepositPaidAlert, sendPaymentMethodSelectedAlert, sendPaymentsActionNeededEmail,
// sendPaymentsRateChangeNotice, sendClockOverrideRequestedEmail and
// sendClockOverrideDecisionEmail are ServWave or the app talking TO the
// contractor, not correspondence with a customer, so they do not belong on a
// customer timeline. Two are asserted here as representatives, rather than
// merely omitted, so a future "persist every sender" sweep has to argue with a
// test instead of silently polluting the tab.
describe('internal staff alerts stay off the customer timeline', () => {
  it('sendDepositPaidAlert sends but persists nothing', async () => {
    await email.sendDepositPaidAlert({
      organizationId: ORG_ID, to: 'owner@acme.com', estimateNumber: 'E00001',
      customerName: 'Jane Doe', depositAmount: 50, paymentMethod: 'CARD',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('sendClockOverrideDecisionEmail sends but persists nothing', async () => {
    await email.sendClockOverrideDecisionEmail({
      org: ORG, to: 'tech@acme.com', technicianName: 'Tech',
      decision: 'approved', decidedByName: 'Boss',
    });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(prisma.email.create).not.toHaveBeenCalled();
  });
});
