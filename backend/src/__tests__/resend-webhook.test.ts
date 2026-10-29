import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

// Capture fns must exist before the hoisted vi.mock factory references them.
const { resendSend, resendVerify } = vi.hoisted(() => ({
  resendSend: vi.fn(),
  resendVerify: vi.fn(),
}));

// Override the global env mock (setup.ts) — the webhook controller needs
// RESEND_WEBHOOK_SECRET, and the suppression tests below exercise the REAL
// dispatchEmail (lib/email.ts), which needs a real-shaped RESEND_API_KEY/
// EMAIL_FROM_BUSINESS to initialize its Resend client (email-dispatch.test.ts
// precedent).
const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test' as string,
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key' as string | undefined,
    RESEND_WEBHOOK_SECRET: 'whsec_test_secret' as string | undefined,
    FRONTEND_URL: 'http://localhost:5173',
  },
}));
vi.mock('../config/env', () => mockEnv);

// One Resend double covers BOTH lib/email.ts's send path (`.emails.send`) and
// resend-webhook.controller.ts's verification path (`.webhooks.verify`) —
// each module constructs its own `new Resend(...)`, but both land on this
// same mocked class.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    webhooks = { verify: resendVerify };
  },
}));

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

// setup.ts mocks '../lib/email' globally; pull the REAL module here so the
// suppression tests exercise dispatchEmail's actual gate (email-dispatch.test.ts
// precedent), not the pre-canned 'sent' stub.
let dispatchEmail: typeof import('../lib/email')['__dispatchEmailForTest'];
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  dispatchEmail = real.__dispatchEmailForTest;
});

const app = express();
app.use('/api/webhooks', webhookRoutes);

const SVIX_HEADERS = { id: 'evt_1', timestamp: '1754390400', signature: 'v1,test-sig' };

function post(payload: unknown, headers: { id?: string; timestamp?: string; signature?: string } = SVIX_HEADERS) {
  let req = request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json');
  if (headers.id !== undefined) req = req.set('svix-id', headers.id);
  if (headers.timestamp !== undefined) req = req.set('svix-timestamp', headers.timestamp);
  if (headers.signature !== undefined) req = req.set('svix-signature', headers.signature);
  return req.send(JSON.stringify(payload));
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    created_at: '2026-08-05T00:00:00.000Z',
    email_id: 're_msg_1',
    from: 'no-reply@mail.test.com',
    to: ['customer@example.com'],
    subject: 'Test subject',
    ...overrides,
  };
}

const SENT_EVENT = { type: 'email.sent', created_at: '2026-08-05T00:00:00.000Z', data: baseData() };
const DEFERRED_EVENT = { type: 'email.delivery_delayed', created_at: '2026-08-05T00:00:01.000Z', data: baseData() };
const DELIVERED_EVENT = { type: 'email.delivered', created_at: '2026-08-05T00:00:02.000Z', data: baseData() };
const HARD_BOUNCE_EVENT = {
  type: 'email.bounced',
  created_at: '2026-08-05T00:00:03.000Z',
  data: { ...baseData(), bounce: { message: 'Mailbox does not exist', subType: 'General', type: 'Permanent' } },
};
const SOFT_BOUNCE_EVENT = {
  type: 'email.bounced',
  created_at: '2026-08-05T00:00:03.000Z',
  data: { ...baseData({ to: ['fullbox@example.com'] }), bounce: { message: 'Mailbox full', subType: 'MailboxFull', type: 'Temporary' } },
};
const FAILED_EVENT = {
  type: 'email.failed',
  created_at: '2026-08-05T00:00:03.000Z',
  data: { ...baseData(), failed: { reason: 'Provider rejected the message' } },
};
const COMPLAINED_EVENT = { type: 'email.complained', created_at: '2026-08-05T00:00:04.000Z', data: baseData() };
const OPENED_EVENT = { type: 'email.opened', created_at: '2026-08-05T00:00:05.000Z', data: baseData() };

const EMAIL_ROW = {
  id: 'email-1',
  provider_message_id: 're_msg_1',
  delivery_status: null as string | null,
  delivery_status_reason: null,
  delivery_status_at: null,
  bounce_kind: null,
  organization_id: 'org-1',
};

// domain.* event fixtures. The events still ARRIVE - Resend sends them for
// the shared platform domains - they simply correlate to nothing we store.
function domainEventData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dom_1',
    name: 'acmeplumbing.com',
    status: 'pending',
    created_at: '2026-08-05T00:00:00.000Z',
    region: 'us-east-1',
    records: [],
    ...overrides,
  };
}

const DOMAIN_UPDATED_VERIFIED = {
  type: 'domain.updated',
  created_at: '2026-08-05T00:00:01.000Z',
  data: domainEventData({ status: 'verified' }),
};
const DOMAIN_CREATED_EVENT = {
  type: 'domain.created',
  created_at: '2026-08-05T00:00:00.000Z',
  data: domainEventData({ status: 'not_started' }),
};
const DOMAIN_DELETED_EVENT = {
  type: 'domain.deleted',
  created_at: '2026-08-05T00:00:02.000Z',
  data: domainEventData({ status: 'verified' }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.env.RESEND_WEBHOOK_SECRET = 'whsec_test_secret';
  mockEnv.env.RESEND_API_KEY = 're_test_key';

  resendVerify.mockImplementation((opts: { payload: string }) => JSON.parse(opts.payload));

  p.resendEvent.findUnique.mockResolvedValue(null);
  p.resendEvent.create.mockResolvedValue({ id: 'evt-row-1' });
  p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW });
  p.email.update.mockResolvedValue({});
  p.emailSuppression.findFirst.mockResolvedValue(null);
  p.emailSuppression.upsert.mockResolvedValue({});
  p.organization.findUnique.mockResolvedValue({ email_sending_enabled: true, name: 'Test Org' });
  p.user.findMany.mockResolvedValue([{ email: 'admin@acmeplumbing.com' }]);
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
});

describe('Resend webhook auth (fail closed)', () => {
  it('401s EVERY request when RESEND_WEBHOOK_SECRET is unset', async () => {
    mockEnv.env.RESEND_WEBHOOK_SECRET = undefined;
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(401);
    expect(resendVerify).not.toHaveBeenCalled();
    expect(p.resendEvent.create).not.toHaveBeenCalled();
  });

  it('401s when the svix-id header is missing', async () => {
    const res = await post(SENT_EVENT, { timestamp: SVIX_HEADERS.timestamp, signature: SVIX_HEADERS.signature });
    expect(res.status).toBe(401);
    expect(resendVerify).not.toHaveBeenCalled();
  });

  it('401s when the svix-timestamp header is missing', async () => {
    const res = await post(SENT_EVENT, { id: SVIX_HEADERS.id, signature: SVIX_HEADERS.signature });
    expect(res.status).toBe(401);
    expect(resendVerify).not.toHaveBeenCalled();
  });

  it('401s when the svix-signature header is missing', async () => {
    const res = await post(SENT_EVENT, { id: SVIX_HEADERS.id, timestamp: SVIX_HEADERS.timestamp });
    expect(res.status).toBe(401);
    expect(resendVerify).not.toHaveBeenCalled();
  });

  it('401s when resend.webhooks.verify() throws (bad signature)', async () => {
    resendVerify.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(401);
    expect(p.resendEvent.create).not.toHaveBeenCalled();
  });

  it('accepts a valid signature and processes the event', async () => {
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(resendVerify).toHaveBeenCalledWith({
      payload: JSON.stringify(SENT_EVENT),
      headers: { id: 'evt_1', timestamp: '1754390400', signature: 'v1,test-sig' },
      webhookSecret: 'whsec_test_secret',
    });
  });
});

describe('Resend webhook — event types update the right Email row', () => {
  it('email.sent -> SENT', async () => {
    await post(SENT_EVENT);
    expect(p.email.update).toHaveBeenCalledTimes(1);
    const call = p.email.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'email-1' });
    expect(call.data.delivery_status).toBe('SENT');
    expect(call.data.delivery_status_reason).toBeNull();
  });

  it('email.delivery_delayed -> DEFERRED', async () => {
    await post(DEFERRED_EVENT);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('DEFERRED');
  });

  it('email.delivered -> DELIVERED', async () => {
    await post(DELIVERED_EVENT);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('DELIVERED');
  });

  it('email.bounced (Permanent) -> BOUNCED with bounce_kind HARD and the provider message as the reason', async () => {
    await post(HARD_BOUNCE_EVENT);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('BOUNCED');
    expect(call.data.bounce_kind).toBe('HARD');
    expect(call.data.delivery_status_reason).toBe('Mailbox does not exist');
  });

  it('email.bounced (Temporary) -> BOUNCED with bounce_kind SOFT', async () => {
    await post(SOFT_BOUNCE_EVENT);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('BOUNCED');
    expect(call.data.bounce_kind).toBe('SOFT');
  });

  it('email.failed -> FAILED with the failure reason', async () => {
    await post(FAILED_EVENT);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('FAILED');
    expect(call.data.delivery_status_reason).toBe('Provider rejected the message');
  });

  it('email.complained -> COMPLAINED', async () => {
    await post(COMPLAINED_EVENT);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('COMPLAINED');
  });

  it('unknown/unmatched provider_message_id -> event recorded, 200, no Email update', async () => {
    p.email.findUnique.mockResolvedValue(null);
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(200);
    expect(p.resendEvent.create).toHaveBeenCalledTimes(1);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('email.opened (untracked event type) against a KNOWN email row -> recorded, 200, no Email update', async () => {
    // Distinct from the "unknown provider_message_id" case above: here the
    // row IS found (mapEventToUpdate's `if (!update) return;` branch), so a
    // regression that fell through to Email.update with garbage, or threw,
    // would only be caught by a case shaped exactly like this one.
    const res = await post(OPENED_EVENT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(p.resendEvent.create).toHaveBeenCalledTimes(1);
    expect(p.email.findUnique).toHaveBeenCalledTimes(1);
    expect(p.email.update).not.toHaveBeenCalled();
    expect(p.emailSuppression.upsert).not.toHaveBeenCalled();
  });
});

describe('Resend webhook idempotency', () => {
  it('duplicate svix-id (pre-existing ledger row) -> 200 duplicate, no reprocessing', async () => {
    p.resendEvent.findUnique.mockResolvedValue({ id: 'evt-existing' });
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('concurrent duplicate (P2002 on claim) -> 200 duplicate, no 500', async () => {
    p.resendEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  it('two identical deliveries of the same event -> Email.update runs exactly once', async () => {
    // First delivery: no ledger row yet -> processes normally.
    p.resendEvent.findUnique.mockResolvedValueOnce(null);
    const first = await post(SENT_EVENT);
    expect(first.status).toBe(200);
    expect(p.email.update).toHaveBeenCalledTimes(1);

    // Second (redelivered) request: same svix-id, now claimed -> short-circuits.
    p.resendEvent.findUnique.mockResolvedValueOnce({ id: 'evt-row-1' });
    const second = await post(SENT_EVENT);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(p.email.update).toHaveBeenCalledTimes(1);
  });
});

describe('Resend webhook — out-of-order delivery guard', () => {
  it('a late/out-of-order SENT does not regress an already-DELIVERED row', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'DELIVERED' });
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(200);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('a late/out-of-order DEFERRED does not regress an already-BOUNCED row', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'BOUNCED' });
    const res = await post(DEFERRED_EVENT);
    expect(res.status).toBe(200);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('a forward-moving status (SENT -> DELIVERED) still applies normally', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'SENT' });
    await post(DELIVERED_EVENT);
    expect(p.email.update).toHaveBeenCalledTimes(1);
    expect(p.email.update.mock.calls[0][0].data.delivery_status).toBe('DELIVERED');
  });

  it('a genuine DELIVERED after a SOFT bounce is NOT dropped (SOFT "may clear")', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'BOUNCED', bounce_kind: 'SOFT' });
    const res = await post(DELIVERED_EVENT);
    expect(res.status).toBe(200);
    expect(p.email.update).toHaveBeenCalledTimes(1);
    const call = p.email.update.mock.calls[0][0];
    expect(call.data.delivery_status).toBe('DELIVERED');
  });

  it('a late/out-of-order SENT does not regress an already-SOFT-BOUNCED row', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'BOUNCED', bounce_kind: 'SOFT' });
    const res = await post(SENT_EVENT);
    expect(res.status).toBe(200);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('a late/out-of-order SOFT bounce does not regress an already-DELIVERED row', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'DELIVERED' });
    const res = await post(SOFT_BOUNCE_EVENT);
    expect(res.status).toBe(200);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('a HARD bounce still remains terminal — a later DELIVERED does not regress it', async () => {
    p.email.findUnique.mockResolvedValue({ ...EMAIL_ROW, delivery_status: 'BOUNCED', bounce_kind: 'HARD' });
    const res = await post(DELIVERED_EVENT);
    expect(res.status).toBe(200);
    expect(p.email.update).not.toHaveBeenCalled();
  });
});

describe('Resend webhook — suppression side effects', () => {
  it('a hard bounce upserts an EmailSuppression row (address + TRANSACTIONAL category, kind HARD_BOUNCE)', async () => {
    await post(HARD_BOUNCE_EVENT);
    expect(p.emailSuppression.upsert).toHaveBeenCalledTimes(1);
    const call = p.emailSuppression.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ address_category: { address: 'customer@example.com', category: 'TRANSACTIONAL' } });
    expect(call.create).toMatchObject({
      address: 'customer@example.com',
      category: 'TRANSACTIONAL',
      kind: 'HARD_BOUNCE',
      organization_id: 'org-1',
    });
  });

  it('a soft bounce does NOT create a suppression row', async () => {
    await post(SOFT_BOUNCE_EVENT);
    expect(p.emailSuppression.upsert).not.toHaveBeenCalled();
  });

  it('a complaint upserts an EmailSuppression row with kind COMPLAINT', async () => {
    await post(COMPLAINED_EVENT);
    expect(p.emailSuppression.upsert).toHaveBeenCalledTimes(1);
    const call = p.emailSuppression.upsert.mock.calls[0][0];
    expect(call.create.kind).toBe('COMPLAINT');
  });
});

describe('dispatchEmail — TRANSACTIONAL suppression gate', () => {
  const PAYLOAD = { to: 'clean@example.com', subject: 's', text: 't' } as any;

  // Control test FIRST: an ordinary send to a non-suppressed address must be
  // completely unaffected by this slice — same result shape as before
  // suppression existed (email-dispatch.test.ts's own expectations).
  it('sends normally when the recipient is NOT suppressed (no behavior change for the 99% path)', async () => {
    p.emailSuppression.findFirst.mockResolvedValue(null);
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });

    const res = await dispatchEmail('org-1', PAYLOAD);

    expect(res).toEqual({
      status: 'sent',
      providerMessageId: 're_1',
      fromAddress: 'testorg@mail.test.com',
      fromName: 'Test Org',
    });
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it('skips the send and returns {status:"skipped", reason:"suppressed"} when the recipient IS suppressed', async () => {
    p.emailSuppression.findFirst.mockResolvedValue({ id: 'suppression-1' });

    const res = await dispatchEmail('org-1', { to: 'bounced@example.com', subject: 's', text: 't' } as any);

    expect(res).toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('checks the suppression list case-insensitively and trimmed', async () => {
    p.emailSuppression.findFirst.mockResolvedValue({ id: 'suppression-1' });

    await dispatchEmail('org-1', { to: '  Bounced@Example.com  ', subject: 's', text: 't' } as any);

    const call = p.emailSuppression.findFirst.mock.calls[0][0];
    expect(call.where.address.in).toEqual(['bounced@example.com']);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe('Resend webhook — domain.* events', () => {
  // Per-org sending domains were removed: every org sends from the one shared
  // platform domain. Resend still emits domain.* for the platform's OWN
  // domains, so the handler must keep accepting them - it just has nothing to
  // correlate them to. Recorded in the ledger, acknowledged, no side effect.
  it.each([
    ['domain.created', DOMAIN_CREATED_EVENT],
    ['domain.updated', DOMAIN_UPDATED_VERIFIED],
    ['domain.deleted', DOMAIN_DELETED_EVENT],
  ])('%s is recorded and acknowledged with no side effect', async (_type, event) => {
    const res = await post(event);

    expect(res.status).toBe(200);
    // Recorded in the idempotency ledger like every other event type...
    expect(p.resendEvent.create).toHaveBeenCalledTimes(1);
    // ...but touches no Email row: these carry no email_id to correlate on.
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('a duplicate domain.updated delivery is still deduplicated', async () => {
    p.resendEvent.findUnique.mockResolvedValueOnce(null);
    const first = await post(DOMAIN_UPDATED_VERIFIED);
    expect(first.status).toBe(200);

    p.resendEvent.findUnique.mockResolvedValueOnce({ id: 'evt-row-1' });
    const second = await post(DOMAIN_UPDATED_VERIFIED);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
  });
});
