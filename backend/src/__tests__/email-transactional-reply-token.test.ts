/*
 * Two-way email for TRANSACTIONAL sends - the half the compose path already has.
 *
 * comm-email-reply-token.test.ts pins this behaviour for the inbox compose
 * dialog. These pin it for the senders a customer actually hears from: the
 * estimate, the invoice, the "your job is scheduled" notice. Before this, those
 * left with NO Reply-To at all, so a customer hitting Reply wrote to the org's
 * own From address on mail.servwave.com - a domain with RECEIVING DISABLED. The
 * reply bounced, silently, and the customer had no way to know.
 *
 * That was survivable while the From read `no-reply@`. Email slice 10 derives it
 * from the org name instead (`servwavedemo@mail.servwave.com`), which reads like
 * a real business address and invites the reply it cannot accept.
 *
 * The invariants are the compose path's, restated for a sender with no thread:
 *
 *   - the address in the header resolves: the token transmitted is byte-for-byte
 *     the token persisted
 *   - a dispatch that never left persists NOTHING - no token row, no thread
 *   - every send about ONE entity shares ONE reply address, so the estimate, its
 *     reminder and the customer's reply are one conversation rather than three
 *   - the mirrored row is a real outbound message: `direction` and `thread_id`
 *     set, not the NULLs persistTransactionalEmail used to leave behind
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'noreply@test.servwave.com',
    EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
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
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';

type Email = typeof import('../lib/email');
let email: Email;

beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const REPLY_DOMAIN = 'reply.test.com';
const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const ESTIMATE_ID = 'e0000000-0000-0000-0000-000000000001';
const WHEN = new Date('2026-08-18T13:00:00Z');
const TZ = 'America/New_York';

/** The anchor that makes every send about one estimate share one address. */
const ORG = { id: ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A' };

const ESTIMATE_ROW = {
  estimate_number: 'E00001', status: 'SENT', created_at: WHEN, subtotal: 1200, tax_rate: 0,
  tax_amount: 0, total_amount: 1200, signature_data: null, signature_at: null,
  snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
  organization_id: ORG_ID,
  lead: {
    service_address_line1: null, service_address_line2: null, service_city: null,
    service_state: null, service_zip: null,
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@example.com', phone: null, service_locations: [] },
  },
  line_items: [],
};

const RECORD = {
  organizationId: ORG_ID,
  customerId: CUSTOMER_ID,
  entityType: 'estimate',
  entityId: ESTIMATE_ID,
};

function sendEstimate(extra: Record<string, unknown> = {}) {
  return email.sendEstimateEmail({
    estimateId: ESTIMATE_ID,
    org: ORG,
    to: 'jane@example.com',
    customerName: 'Jane Doe',
    estimateNumber: 'E00001',
    total: '$1,200.00',
    publicUrl: 'http://localhost:5173/e/tok',
    record: RECORD,
    ...extra,
  } as never);
}

/** The Reply-To Resend was actually handed, unwrapped from any display name. */
function replyToAddress(): string {
  const raw = resendSend.mock.calls[0][0].replyTo;
  const one = Array.isArray(raw) ? raw[0] : raw;
  const angled = String(one ?? '').match(/<([^>]*)>/);
  return (angled ? angled[1] : String(one ?? '')).trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_ok' }, error: null });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
  (prisma.replyToken.findFirst as Mock).mockResolvedValue(null);
  (prisma.emailThread.findFirst as Mock).mockResolvedValue(null);
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    email_sending_enabled: true,
    name: 'Acme Plumbing',
  });
  (prisma.estimate.findUnique as Mock).mockResolvedValue(ESTIMATE_ROW);
});

describe('a transactional send advertises a reply address that resolves', () => {
  it('sets Reply-To to <token>@ the reply domain', async () => {
    await sendEstimate();

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(replyToAddress()).toMatch(
      new RegExp(`^[A-Za-z0-9_-]{22}@${REPLY_DOMAIN.replace('.', '\\.')}$`),
    );
  });

  it('persists the SAME token it transmitted', async () => {
    await sendEstimate();

    const transmitted = replyToAddress().split('@')[0];
    expect(prisma.replyToken.create).toHaveBeenCalledTimes(1);
    const row = (prisma.replyToken.create as Mock).mock.calls[0][0].data;
    expect(row.token).toBe(transmitted);
    expect(row.organization_id).toBe(ORG_ID);
    expect(row.expected_from).toBe('jane@example.com');
    expect(row.entity_type).toBe('estimate');
    expect(row.entity_id).toBe(ESTIMATE_ID);
  });

  it('reuses one address for every send about the same entity', async () => {
    (prisma.replyToken.findFirst as Mock).mockResolvedValue({
      token: 'ReUsEdToKeN0123456789',
      thread_id: 'thread-existing',
      expires_at: null,
      revoked_at: null,
    });

    await sendEstimate();

    expect(replyToAddress()).toBe(`ReUsEdToKeN0123456789@${REPLY_DOMAIN}`);
    expect(prisma.replyToken.create).not.toHaveBeenCalled();
  });
});

describe('a dispatch that never left persists nothing', () => {
  it('writes no token row when Resend rejects the message', async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: 'nope' } });

    await sendEstimate();

    expect(prisma.replyToken.create).not.toHaveBeenCalled();
    expect(prisma.emailThread.create).not.toHaveBeenCalled();
    expect(prisma.email.create).not.toHaveBeenCalled();
  });

  it('writes no token row when the org has sending disabled', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: false,
      name: 'Acme Plumbing',
    });

    await sendEstimate();

    expect(resendSend).not.toHaveBeenCalled();
    expect(prisma.replyToken.create).not.toHaveBeenCalled();
  });
});

describe('the mirrored row is a real outbound message', () => {
  it("stamps direction 'out' and a thread id", async () => {
    await sendEstimate();

    const row = (prisma.email.create as Mock).mock.calls[0][0].data;
    expect(row.direction).toBe('out');
    expect(row.thread_id).toBeTruthy();
  });

  it('puts the reply on the SAME thread the token carries', async () => {
    (prisma.replyToken.findFirst as Mock).mockResolvedValue({
      token: 'ReUsEdToKeN0123456789',
      thread_id: 'thread-existing',
      expires_at: null,
      revoked_at: null,
    });

    await sendEstimate();

    const row = (prisma.email.create as Mock).mock.calls[0][0].data;
    expect(row.thread_id).toBe('thread-existing');
    expect(prisma.emailThread.create).not.toHaveBeenCalled();
  });
});

describe('sends with no record stay unreplyable', () => {
  it('mints no token when the sender records nothing', async () => {
    await sendEstimate({ record: undefined });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0][0].replyTo).toBeUndefined();
    expect(prisma.replyToken.create).not.toHaveBeenCalled();
  });
});
