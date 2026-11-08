// Slice 6 — outbound SMS through CTM: the shared delivery path (sendCtmSms),
// the pre-row compliance precheck (precheckCtmSms), the sendMessage controller
// wiring (409 gates for connected orgs, unchanged behavior when not connected),
// and the automations seam (smsRecord awaits delivery, never throws — SERV10X-70).
//
// Master plan §4 (comm-threads/smsRecord row) + v3.1 addendum §A.6 (≤1600).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { sendCtmSms, precheckCtmSms, _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { recordOutboundSms } from '../services/automations/smsRecord';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = ALPHA_ORG_ID;
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSG_ID = '99990000-0000-0000-0000-000000000001';
const TO = '+15551234567';

const sendParams = (overrides: Record<string, unknown> = {}) => ({
  orgId: ORG_ID,
  toE164: TO,
  body: 'Your technician is on the way',
  threadId: THREAD_ID,
  messageId: MSG_ID,
  ...overrides,
});

/** A fully connected + SMS-ready + entitled + kill-switch-on org record. */
const CONNECTED_ORG_ROW = {
  ctm_account_id: '111111',
  ctm_sms_ready: true,
  sms_sending_enabled: true,
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: { phone: true },
};

/** Wire up a fully connected + SMS-ready + entitled org with one usable number. */
function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ...CONNECTED_ORG_ROW });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.isOptedOut.mockResolvedValue(false);
  client.sendSms.mockResolvedValue({ id: 'MSG123' });
  p.message.update.mockResolvedValue({ id: MSG_ID });
  p.auditLog.create.mockResolvedValue({});
}

/** Let fire-and-forget continuations (logAudit, automations delivery) settle. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts defaults: isCtmConfigured false, isOptedOut false, sendSms undefined.
  client.isCtmConfigured.mockReturnValue(false);
  client.isOptedOut.mockResolvedValue(false);
});

// ─── sendCtmSms — gate order ──────────────────────────────

describe('sendCtmSms — compliance gates', () => {
  it('sends nothing when the org is not connected - the record stands, marked skipped', async () => {
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null, ctm_sms_ready: false });
    p.message.update.mockResolvedValue({ id: MSG_ID });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'NOT_CONNECTED' });
    expect(client.sendSms).not.toHaveBeenCalled();
    // The row is settled, not left at whatever the caller optimistically wrote.
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NOT_CONNECTED' },
    });
  });

  it('no-ops without touching the DB when the platform keys are unconfigured', async () => {
    const result = await sendCtmSms(prisma, sendParams());
    expect(result).toEqual({ delivered: false, reason: 'NOT_CONNECTED' });
    expect(p.organization.findUnique).not.toHaveBeenCalled();
    expect(client.sendSms).not.toHaveBeenCalled();
  });

  it('blocks on SMS_NOT_READY (A2P pending) — client never called, row untouched', async () => {
    mockConnectedOrg();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111', ctm_sms_ready: false });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'SMS_NOT_READY' });
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(client.isOptedOut).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'SMS_NOT_READY' },
    });
  });

  it('blocks on ORG_SMS_DISABLED when the org kill switch is off — no from-number lookup, no delivery', async () => {
    mockConnectedOrg();
    p.organization.findUnique.mockResolvedValue({ ...CONNECTED_ORG_ROW, sms_sending_enabled: false });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'ORG_SMS_DISABLED' });
    expect(p.phoneNumber.findFirst).not.toHaveBeenCalled();
    expect(client.isOptedOut).not.toHaveBeenCalled();
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'ORG_SMS_DISABLED' },
    });
  });

  it('blocks on NOT_ENTITLED when the org is not entitled to phone (STARTER, no override)', async () => {
    mockConnectedOrg();
    p.organization.findUnique.mockResolvedValue({
      ...CONNECTED_ORG_ROW,
      plan: 'STARTER',
      feature_overrides: {},
    });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'NOT_ENTITLED' });
    expect(p.phoneNumber.findFirst).not.toHaveBeenCalled();
    expect(client.isOptedOut).not.toHaveBeenCalled();
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NOT_ENTITLED' },
    });
  });

  it('blocks on NOT_ENTITLED for a PRO org whose Communication module was never turned on (feature_overrides.phone: false)', async () => {
    mockConnectedOrg();
    p.organization.findUnique.mockResolvedValue({
      ...CONNECTED_ORG_ROW,
      plan: 'PRO',
      feature_overrides: { phone: false },
    });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'NOT_ENTITLED' });
    expect(client.sendSms).not.toHaveBeenCalled();
  });

  it('allows a SCALE org with no explicit override (phone is plan-included, on by default at that tier)', async () => {
    mockConnectedOrg();
    p.organization.findUnique.mockResolvedValue({
      ...CONNECTED_ORG_ROW,
      plan: 'SCALE',
      feature_overrides: {},
    });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: true });
  });

  it('blocks on NO_SMS_NUMBER when the org has no sms-enabled active number', async () => {
    mockConnectedOrg();
    p.phoneNumber.findFirst.mockResolvedValue(null);

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'NO_SMS_NUMBER' });
    expect(client.sendSms).not.toHaveBeenCalled();
    // The from-number lookup is org-scoped and only considers usable numbers.
    expect(p.phoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ORG_ID,
          sms_enabled: true,
          status: 'active',
        }),
      }),
    );
  });

  it('fresh opt-out check blocks the send — client.sendSms is NEVER called', async () => {
    mockConnectedOrg();
    client.isOptedOut.mockResolvedValue(true);

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'RECIPIENT_OPTED_OUT' });
    expect(client.isOptedOut).toHaveBeenCalledWith('111111', TO);
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'RECIPIENT_OPTED_OUT' },
    });
  });

  it('double-fire guard: identical (org, thread, body) within 15s → DUPLICATE_SEND', async () => {
    mockConnectedOrg();

    const first = await sendCtmSms(prisma, sendParams());
    const second = await sendCtmSms(prisma, sendParams({ messageId: '99990000-0000-0000-0000-000000000002' }));

    expect(first).toEqual({ delivered: true });
    expect(second).toEqual({ delivered: false, reason: 'DUPLICATE_SEND' });
    expect(client.sendSms).toHaveBeenCalledTimes(1);
  });

  it('double-fire guard expires after the 15s window', async () => {
    mockConnectedOrg();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    await sendCtmSms(prisma, sendParams());
    nowSpy.mockReturnValue(1_016_001); // > 15s later
    const again = await sendCtmSms(prisma, sendParams());
    nowSpy.mockRestore();

    expect(again).toEqual({ delivered: true });
    expect(client.sendSms).toHaveBeenCalledTimes(2);
  });

  it('a different body within the window is NOT a duplicate', async () => {
    mockConnectedOrg();
    await sendCtmSms(prisma, sendParams());
    const other = await sendCtmSms(prisma, sendParams({ body: 'Different text' }));
    expect(other).toEqual({ delivered: true });
    expect(client.sendSms).toHaveBeenCalledTimes(2);
  });
});

// ─── sendCtmSms — happy path + failure ────────────────────

describe('sendCtmSms — delivery outcomes', () => {
  it('happy path: sends from the TPN id, stores the returned sid + status sent, audits sms.sent', async () => {
    mockConnectedOrg();

    const result = await sendCtmSms(prisma, sendParams());
    await flush();

    expect(result).toEqual({ delivered: true });
    expect(client.sendSms).toHaveBeenCalledWith('111111', {
      from: 'TPN-A',
      to: TO,
      msg: 'Your technician is on the way',
    });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG123' },
    });
    expect(p.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ org_id: ORG_ID, action: 'sms.sent', resource_id: MSG_ID }),
      }),
    );
  });

  it("reads the sid defensively from 'message_id' when 'id' is absent", async () => {
    mockConnectedOrg();
    client.sendSms.mockResolvedValue({ message_id: 'MSG777' });

    await sendCtmSms(prisma, sendParams());

    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG777' },
    });
  });

  it('still marks the row sent when CTM returns no sid (the status_change webhook reconciles it)', async () => {
    mockConnectedOrg();
    client.sendSms.mockResolvedValue({});

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: true });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null },
    });
  });

  it('CtmApiError: marks the Message failed, warns, returns CTM_ERROR — never throws', async () => {
    mockConnectedOrg();
    client.sendSms.mockRejectedValue(new client.CtmApiError('CTM API error 406: not deliverable'));

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'CTM_ERROR' });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'failed', status_reason: 'CTM_ERROR' },
    });
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });

  it('never throws even when marking the row failed also fails', async () => {
    mockConnectedOrg();
    client.sendSms.mockRejectedValue(new Error('network down'));
    p.message.update.mockRejectedValue(new Error('db down'));

    await expect(sendCtmSms(prisma, sendParams())).resolves.toEqual({
      delivered: false,
      reason: 'CTM_ERROR',
    });
  });
});

// ─── sendCtmSms — webhook-first sid race ──────────────────
// The `outbound_text` webhook can store a row for our sid BEFORE the POST
// response lands, so stamping ctm_sms_id on the user's row P2002s. The send
// SUCCEEDED: the user's row must win (never be marked failed), the webhook's
// duplicate must go, and the sid must land on the user's row.

describe('sendCtmSms — webhook-first sid race (P2002 reconcile)', () => {
  beforeEach(() => {
    // The reconcile wraps delete+retry in a transaction; pass it through.
    p.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(p) : Promise.all(arg),
    );
  });

  it('keeps exactly one row — the user’s messageId — and deletes the webhook duplicate', async () => {
    mockConnectedOrg();
    p.message.update
      .mockRejectedValueOnce({ code: 'P2002' }) // first sid stamp collides
      .mockResolvedValue({ id: MSG_ID });
    p.message.findFirst.mockResolvedValue({ id: 'webhook-row', direction: 'out' });
    p.message.delete.mockResolvedValue({ id: 'webhook-row' });

    const result = await sendCtmSms(prisma, sendParams());
    await flush();

    expect(result).toEqual({ delivered: true });
    // The webhook's duplicate row is the one deleted — never the user's.
    expect(p.message.delete).toHaveBeenCalledTimes(1);
    expect(p.message.delete).toHaveBeenCalledWith({ where: { id: 'webhook-row' } });
    // The retry stamps sid + sent onto the USER's row.
    expect(p.message.update).toHaveBeenLastCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG123' },
    });
    // The user's row is NEVER marked failed on this path.
    const failedCalls = p.message.update.mock.calls.filter(
      (c: any[]) => c[0]?.data?.status === 'failed',
    );
    expect(failedCalls).toHaveLength(0);
    // Still a delivered send: sms.sent audits.
    expect(p.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'sms.sent', resource_id: MSG_ID }),
      }),
    );
  });

  it('a non-outbound sid conflict keeps both rows (evidence rule) — user row still sent', async () => {
    mockConnectedOrg();
    p.message.update
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockResolvedValue({ id: MSG_ID });
    p.message.findFirst.mockResolvedValue({ id: 'inbound-row', direction: 'in' });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: true });
    expect(p.message.delete).not.toHaveBeenCalled();
    // Our row is marked sent WITHOUT the sid (it stays on the other row).
    expect(p.message.update).toHaveBeenLastCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null },
    });
  });

  it('a non-P2002 update failure still marks the row failed (unchanged behavior)', async () => {
    mockConnectedOrg();
    p.message.update
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ id: MSG_ID });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'CTM_ERROR' });
    expect(p.message.delete).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenLastCalledWith({
      where: { id: MSG_ID },
      data: { status: 'failed', status_reason: 'CTM_ERROR' },
    });
  });
});

// ─── precheckCtmSms ───────────────────────────────────────

describe('precheckCtmSms', () => {
  it('returns ok on a clean path WITHOUT sending or recording the double-fire guard', async () => {
    mockConnectedOrg();

    const pre = await precheckCtmSms(prisma, {
      orgId: ORG_ID,
      toE164: TO,
      threadId: THREAD_ID,
      body: 'Your technician is on the way',
    });
    expect(pre).toEqual({ ok: true });
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).not.toHaveBeenCalled();

    // The precheck must NOT have armed the guard against its own send.
    const result = await sendCtmSms(prisma, sendParams());
    expect(result).toEqual({ delivered: true });
  });

  it('returns the typed gate reasons', async () => {
    mockConnectedOrg();
    client.isOptedOut.mockResolvedValue(true);
    expect(
      await precheckCtmSms(prisma, { orgId: ORG_ID, toE164: TO, threadId: THREAD_ID, body: 'x' }),
    ).toEqual({ ok: false, reason: 'RECIPIENT_OPTED_OUT' });

    client.isOptedOut.mockResolvedValue(false);
    p.phoneNumber.findFirst.mockResolvedValue(null);
    expect(
      await precheckCtmSms(prisma, { orgId: ORG_ID, toE164: TO, threadId: THREAD_ID, body: 'x' }),
    ).toEqual({ ok: false, reason: 'NO_SMS_NUMBER' });
  });

  it('treats a missing destination number as NO_SMS_NUMBER', async () => {
    mockConnectedOrg();
    expect(
      await precheckCtmSms(prisma, { orgId: ORG_ID, toE164: null, threadId: THREAD_ID, body: 'x' }),
    ).toEqual({ ok: false, reason: 'NO_SMS_NUMBER' });
    expect(client.isOptedOut).not.toHaveBeenCalled();
  });

  it('never throws — an unexpected gate error degrades to CTM_ERROR', async () => {
    mockConnectedOrg();
    client.isOptedOut.mockRejectedValue(new Error('CTM down'));
    await expect(
      precheckCtmSms(prisma, { orgId: ORG_ID, toE164: TO, threadId: THREAD_ID, body: 'x' }),
    ).resolves.toEqual({ ok: false, reason: 'CTM_ERROR' });
  });
});

// ─── automations seam (smsRecord) ─────────────────────────

describe('recordOutboundSms — CTM delivery seam', () => {
  function mockRecordWrites() {
    p.messageThread.findFirst.mockResolvedValue({ id: THREAD_ID });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    p.timelineEvent.create.mockResolvedValue({});
  }

  it('records the message when the org is not connected, marks it skipped, and reports the outcome (never throws)', async () => {
    mockRecordWrites();

    const result = await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      messageId: MSG_ID,
      delivery: { delivered: false, reason: 'NOT_CONNECTED' },
    });
    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'queued', automated: true }) }),
    );
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NOT_CONNECTED' },
    });
  });

  it('delivers through CTM when connected and awaits the result (no fire-and-forget)', async () => {
    mockRecordWrites();
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });

    const result = await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(client.sendSms).toHaveBeenCalledWith('111111', {
      from: 'TPN-A',
      to: '+15551234567',
      msg: 'Automated reminder',
    });
    expect(result.delivery).toEqual({ delivered: true });
  });

  it('swallows delivery failures — the run never throws, the row is marked failed, and the result reports CTM_ERROR', async () => {
    mockRecordWrites();
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });
    client.sendSms.mockRejectedValue(new client.CtmApiError('CTM API error 500: boom'));

    const result = await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      messageId: MSG_ID,
      delivery: { delivered: false, reason: 'CTM_ERROR' },
    });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'failed', status_reason: 'CTM_ERROR' },
    });
  });

  // REGRESSION GUARD. The customer arm is the riskiest thing in Spec C to disturb, and
  // Spec C disturbs it twice (this recorder and the executor above it). This pins the
  // three rows it writes in full, so a change to the staff arm that quietly alters the
  // customer arm cannot pass.
  it('writes the SAME thread, message and timeline rows it always has - the customer arm is untouched', async () => {
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: THREAD_ID });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    p.timelineEvent.create.mockResolvedValue({});
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });

    await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id, job: { id: 'job-1', label: 'J00042' } },
      body: 'Automated reminder',
    });

    // The thread is looked up and created exactly as before - no kind, customer_care.
    expect(p.messageThread.findFirst).toHaveBeenCalledWith({
      where: { customer_id: CUSTOMER_FIXTURE.id, channel: 'sms', organization_id: ORG_ID },
    });
    expect(p.messageThread.create.mock.calls[0][0].data).toEqual({
      channel: 'sms',
      campaign_type: 'customer_care',
      customer_id: CUSTOMER_FIXTURE.id,
      organization_id: ORG_ID,
    });
    expect(p.messageThread.create.mock.calls[0][0].data).not.toHaveProperty('kind');

    // The message row keeps its job attribution and its queued-never-sent invariant.
    const msg = p.message.create.mock.calls[0][0].data;
    expect(msg).toMatchObject({
      thread_id: THREAD_ID,
      direction: 'out',
      body: 'Automated reminder',
      status: 'queued',
      automated: true,
      job_id: 'job-1',
      job_label: 'J00042',
      organization_id: ORG_ID,
    });

    // The customer timeline event still fires, with the same shape.
    expect(p.timelineEvent.create).toHaveBeenCalledWith({
      data: {
        organization_id: ORG_ID,
        entity_type: 'CUSTOMER',
        entity_id: CUSTOMER_FIXTURE.id,
        event_type: 'SMS_SENT',
        description: 'Automated SMS recorded',
        metadata: { thread_id: THREAD_ID, message_id: MSG_ID, automated: true },
        created_by: null,
      },
    });

    // And the destination still comes from a live customer lookup, normalized at the seam.
    expect(p.customer.findFirst).toHaveBeenCalledWith({
      where: { id: CUSTOMER_FIXTURE.id, organization_id: ORG_ID },
      select: { phone: true },
    });
    expect(client.sendSms).toHaveBeenCalledWith('111111', expect.objectContaining({ to: '+15551234567' }));
  });

  it('skips delivery when the customer has no phone on file (record stays the product) — reports NO_SMS_NUMBER', async () => {
    mockRecordWrites();
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue({ phone: null });

    const result = await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NO_SMS_NUMBER' },
    });
    expect(result.delivery).toEqual({ delivered: false, reason: 'NO_SMS_NUMBER' });
  });
});

// ─── automations seam (smsRecord) ─ the STAFF counterparty ───────
//
// Spec C: the same recorder, addressed to a member of staff instead of a customer.
// The staff branch is a genuinely different row shape, not a customer row with a
// different id on it - it is keyed on user_id, marked `kind: 'team'` so the
// Communication module puts it in the internal lane, and carries NO job attribution.

const STAFF_ID = 'd0000000-0000-0000-0000-0000000000aa';
const STAFF_THREAD_ID = 'a1b2c3d4-0000-0000-0000-0000000000ff';

describe('recordOutboundSms - the staff counterparty', () => {
  function mockStaffWrites() {
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create.mockResolvedValue({ id: STAFF_THREAD_ID, user_id: STAFF_ID });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    p.timelineEvent.create.mockResolvedValue({});
  }

  const staffTo = (overrides: Record<string, unknown> = {}) => ({
    type: 'user' as const,
    userId: STAFF_ID,
    name: 'Mike Torres',
    toE164: '+15558675309',
    ...overrides,
  });

  it('creates ONE thread keyed on the user, marked team/tech_ops and titled with their name', async () => {
    mockStaffWrites();
    mockConnectedOrg();

    const result = await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'Job J00042 is yours' });

    expect(p.messageThread.findFirst).toHaveBeenCalledWith({
      where: { user_id: STAFF_ID, channel: 'sms', organization_id: ORG_ID },
    });
    expect(p.messageThread.create).toHaveBeenCalledTimes(1);
    expect(p.messageThread.create.mock.calls[0][0].data).toEqual({
      channel: 'sms',
      // `kind` is the load-bearing half: the Communication module derives a thread's
      // bucket from it and reads an absent kind as `customer`, so campaign_type on its
      // own would leave a staff thread sitting in the customer conversations lane.
      kind: 'team',
      campaign_type: 'tech_ops',
      // A staff thread has no customer row to derive a display name from.
      title: 'Mike Torres',
      user_id: STAFF_ID,
      organization_id: ORG_ID,
    });
    expect(result.threadId).toBe(STAFF_THREAD_ID);
  });

  it('reuses the existing thread on a second text to the same person', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: STAFF_THREAD_ID, user_id: STAFF_ID });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    mockConnectedOrg();

    await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'first' });
    _resetCtmSmsDoubleFireGuard();
    await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'second' });

    expect(p.messageThread.create).not.toHaveBeenCalled();
    expect(p.message.create).toHaveBeenCalledTimes(2);
  });

  it('writes an outbound, queued, automated row carrying NEITHER job_id NOR job_label', async () => {
    mockStaffWrites();
    mockConnectedOrg();

    await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'Job J00042 is yours' });

    const data = p.message.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      thread_id: STAFF_THREAD_ID,
      direction: 'out',
      body: 'Job J00042 is yours',
      status: 'queued',
      automated: true,
      organization_id: ORG_ID,
    });
    // Internal lanes NEVER carry a job id (comm-threads.controller.ts): a job id here
    // would interleave staff texts into the Job -> Communications tab beside the
    // customer conversation, and route the whole thread's visibility through the
    // requester's Job scope. The job context rides in the body instead.
    expect(data).not.toHaveProperty('job_id');
    expect(data).not.toHaveProperty('job_label');
  });

  it('writes NO customer timeline event and performs NO customer lookup', async () => {
    mockStaffWrites();
    mockConnectedOrg();

    await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'b' });

    // The timeline is customer-side only - there is no per-user timeline anywhere.
    expect(p.timelineEvent.create).not.toHaveBeenCalled();
    expect(p.customer.findFirst).not.toHaveBeenCalled();
  });

  it('texts the number it was handed, without re-querying it', async () => {
    mockStaffWrites();
    mockConnectedOrg();

    const result = await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'b' });

    expect(client.sendSms).toHaveBeenCalledWith('111111', { from: 'TPN-A', to: '+15558675309', msg: 'b' });
    expect(result.delivery).toEqual({ delivered: true });
  });

  it('normalizes a legacy display-formatted stored number at the seam, exactly as the customer path does', async () => {
    mockStaffWrites();
    mockConnectedOrg();

    // Capture-time normalization only protects NEW writes; the column still holds
    // display-formatted values on live rows. Without this the provider is handed
    // "(555) 867-5309" verbatim and the text never lands.
    await recordOutboundSms({
      organizationId: ORG_ID,
      to: staffTo({ toE164: '(555) 867-5309' }),
      body: 'b',
    });

    expect(client.sendSms).toHaveBeenCalledWith('111111', expect.objectContaining({ to: '+15558675309' }));
  });

  it('settles the row skipped rather than leaving it queued when the org is not connected', async () => {
    mockStaffWrites();

    const result = await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'b' });

    expect(result.delivery).toEqual({ delivered: false, reason: 'NOT_CONNECTED' });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NOT_CONNECTED' },
    });
  });

  it('never throws on a provider error - the row is marked failed and CTM_ERROR is reported', async () => {
    mockStaffWrites();
    mockConnectedOrg();
    client.sendSms.mockRejectedValue(new client.CtmApiError('CTM API error 500: boom'));

    const result = await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'b' });

    expect(result.delivery).toEqual({ delivered: false, reason: 'CTM_ERROR' });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'failed', status_reason: 'CTM_ERROR' },
    });
  });

  it('two different people get two different threads', async () => {
    p.messageThread.findFirst.mockResolvedValue(null);
    p.messageThread.create
      .mockResolvedValueOnce({ id: STAFF_THREAD_ID })
      .mockResolvedValueOnce({ id: 'a1b2c3d4-0000-0000-0000-0000000000fe' });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    mockConnectedOrg();

    await recordOutboundSms({ organizationId: ORG_ID, to: staffTo(), body: 'b' });
    _resetCtmSmsDoubleFireGuard();
    await recordOutboundSms({
      organizationId: ORG_ID,
      to: staffTo({ userId: 'd0000000-0000-0000-0000-0000000000bb', name: 'Ana Lee', toE164: '+15558675310' }),
      body: 'b',
    });

    expect(p.messageThread.create).toHaveBeenCalledTimes(2);
    expect(p.messageThread.create.mock.calls.map((c: any[]) => c[0].data.user_id)).toEqual([
      STAFF_ID,
      'd0000000-0000-0000-0000-0000000000bb',
    ]);
  });
});

// ─── sendMessage controller wiring ────────────────────────

describe('POST /api/communication/sms — connected-org gating', () => {
  function mockCustomerThread(overrides: Record<string, unknown> = {}) {
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID,
      channel: 'sms',
      campaign_type: 'customer_care',
      unread: 0,
      customer_id: CUSTOMER_FIXTURE.id,
      lead_id: null,
      vendor_id: null,
      kind: null,
      title: null,
      organization_id: ORG_ID,
      ...overrides,
    });
  }

  function mockMessageCreate() {
    p.message.create.mockImplementation((a: any) =>
      Promise.resolve({ id: MSG_ID, ts: new Date(), ...a.data }),
    );
  }

  function mockConnectedSendPath() {
    mockConnectedOrg();
    mockCustomerThread();
    // Destination lookup: the thread's customer phone (stored unformatted).
    p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });
    p.timelineEvent.create.mockResolvedValue({});
    mockMessageCreate();
  }

  it('409s RECIPIENT_OPTED_OUT before any row is created', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();
    client.isOptedOut.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECIPIENT_OPTED_OUT');
    expect(res.body.error).toBeTruthy();
    expect(p.message.create).not.toHaveBeenCalled();
    expect(client.sendSms).not.toHaveBeenCalled();
  });

  it('409s SMS_NOT_READY with no row created', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111', ctm_sms_ready: false });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SMS_NOT_READY');
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('409s NO_SMS_NUMBER with no row created', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();
    p.phoneNumber.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_SMS_NUMBER');
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('409s ORG_SMS_DISABLED with no row created when the org kill switch is off', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();
    p.organization.findUnique.mockResolvedValue({ ...CONNECTED_ORG_ROW, sms_sending_enabled: false });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORG_SMS_DISABLED');
    expect(res.body.error).toBeTruthy();
    expect(p.message.create).not.toHaveBeenCalled();
  });

  it('NOT_ENTITLED falls back to record-only, and the row says so (defence in depth - the route already requires phone)', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();
    p.organization.findUnique.mockResolvedValue({
      ...CONNECTED_ORG_ROW,
      plan: 'STARTER',
      feature_overrides: {},
    });

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('skipped');
    expect(res.body.message.status).toBe('skipped');
    expect(res.body.message.statusReason).toBe('NOT_ENTITLED');
    expect(client.sendSms).not.toHaveBeenCalled();
  });

  it('409s DUPLICATE_SEND on a rapid identical re-send', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();

    const first = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_SEND');
    expect(p.message.create).toHaveBeenCalledTimes(1);
  });

  it('201 happy path: row created, CTM send fired, delivery reported', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('sent');
    expect(client.sendSms).toHaveBeenCalledWith('111111', {
      from: 'TPN-A',
      to: '+15551234567',
      msg: 'hello',
    });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG123' },
    });
  });

  it('CTM failure after creation: 201 with delivery failed, row marked failed', async () => {
    mockAuthAs('dispatcher');
    mockConnectedSendPath();
    client.sendSms.mockRejectedValue(new client.CtmApiError('CTM API error 500: boom'));

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('failed');
    expect(res.body.message.status).toBe('failed');
    // The stored reason keeps its integration name; the browser gets a
    // neutral code (CLAUDE.md: no vendor names in anything the API sends).
    expect(res.body.message.statusReason).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('CTM');
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'failed', status_reason: 'CTM_ERROR' },
    });
  });

  it('a stored provider failure reads back as PROVIDER_ERROR on GET /threads/:id; other reasons pass through', async () => {
    mockAuthAs('admin');
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID,
      customer_id: null,
      channel: 'sms',
      unread: 0,
      messages: [
        { id: 'm-failed', direction: 'out', body: 'a', ts: new Date('2026-09-01T10:00:00Z'), status: 'failed', status_reason: 'CTM_ERROR' },
        { id: 'm-skipped', direction: 'out', body: 'b', ts: new Date('2026-09-01T10:01:00Z'), status: 'skipped', status_reason: 'RECIPIENT_OPTED_OUT' },
      ],
    });

    const res = await request(app)
      .get(`/api/communication/threads/${THREAD_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const [failed, skipped] = res.body.thread.messages;
    expect(failed.statusReason).toBe('PROVIDER_ERROR');
    expect(skipped.statusReason).toBe('RECIPIENT_OPTED_OUT');
    expect(JSON.stringify(res.body)).not.toContain('CTM');
  });

  it('not-connected orgs still record the message, but it reads skipped - never sent', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockMessageCreate();
    p.timelineEvent.create.mockResolvedValue({});
    // isCtmConfigured stays false (setup default) — the platform gate short-circuits.

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello' });

    expect(res.status).toBe(201);
    // The record is still the product - it just does not claim to have been sent.
    expect(res.body.message.body).toBe('hello');
    expect(res.body.delivery).toBe('skipped');
    expect(res.body.message.status).toBe('skipped');
    expect(res.body.message.statusReason).toBe('NOT_CONNECTED');
    expect(client.isOptedOut).not.toHaveBeenCalled();
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NOT_CONNECTED' },
    });
  });

  it('rejects bodies over 1600 chars (addendum A.6) at validation', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'x'.repeat(1601) });

    expect(res.status).toBe(400);
    expect(p.message.create).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────────────────────
// Honest message status (SERV10X-77 prerequisite).
//
// A row must not read `sent` until something outside this process confirms the
// message left. Measured on staging 2026-08-01: 24 automated outbound rows sit
// at status 'sent' with no sid, and 42 of 58 message rows carry no sid at all -
// every one of them written 'sent' at create time and never revisited, because
// sendCtmSms only touches the row on success or CTM_ERROR. Every other gate
// outcome silently leaves the optimistic 'sent' in place.
//
// Same class as GitHub #1068 / PR #1070 (SEND_EMAIL reporting SENT when the org
// kill switch suppressed it), and the same remedy: a suppressed send is
// SKIPPED with a recorded reason, never SENT.
// ─────────────────────────────────────────────────────────────────────────────
describe('honest status - a suppressed send is skipped, never left reading sent', () => {
  const SUPPRESSED: Array<[string, () => void]> = [
    ['SMS_NOT_READY', () => p.organization.findUnique.mockResolvedValue({ ...CONNECTED_ORG_ROW, ctm_sms_ready: false })],
    ['ORG_SMS_DISABLED', () => p.organization.findUnique.mockResolvedValue({ ...CONNECTED_ORG_ROW, sms_sending_enabled: false })],
    ['NOT_ENTITLED', () => p.organization.findUnique.mockResolvedValue({ ...CONNECTED_ORG_ROW, plan: 'STARTER', feature_overrides: {} })],
    ['NO_SMS_NUMBER', () => p.phoneNumber.findFirst.mockResolvedValue(null)],
    ['RECIPIENT_OPTED_OUT', () => client.isOptedOut.mockResolvedValue(true)],
  ];

  for (const [reason, arrange] of SUPPRESSED) {
    it(`${reason}: marks the row skipped with the reason recorded`, async () => {
      mockConnectedOrg();
      arrange();

      const result = await sendCtmSms(prisma, sendParams());

      expect(result).toEqual({ delivered: false, reason });
      expect(client.sendSms).not.toHaveBeenCalled();
      expect(p.message.update).toHaveBeenCalledWith({
        where: { id: MSG_ID },
        data: { status: 'skipped', status_reason: reason },
      });
    });
  }

  it('NOT_CONNECTED marks the row skipped too - the record is still the product, it just is not a send', async () => {
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null, ctm_sms_ready: false });
    p.message.update.mockResolvedValue({ id: MSG_ID });

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'NOT_CONNECTED' });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NOT_CONNECTED' },
    });
  });

  it('a real send failure records the reason alongside failed', async () => {
    mockConnectedOrg();
    client.sendSms.mockRejectedValue(new client.CtmApiError('CTM API error 500: boom'));

    const result = await sendCtmSms(prisma, sendParams());

    expect(result).toEqual({ delivered: false, reason: 'CTM_ERROR' });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'failed', status_reason: 'CTM_ERROR' },
    });
  });

  it('a successful send clears any stale reason', async () => {
    mockConnectedOrg();

    await sendCtmSms(prisma, sendParams());

    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG123' },
    });
  });

  it('recordOutboundSms writes the row queued - the automation seam never claims sent up front', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: THREAD_ID });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    p.timelineEvent.create.mockResolvedValue({});
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });

    await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(p.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'queued', automated: true }) }),
    );
    // …and only the real CTM acceptance promotes it.
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG123' },
    });
  });

  it('a customer with no phone leaves the automation row skipped, not sent', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: THREAD_ID });
    p.message.create.mockResolvedValue({ id: MSG_ID });
    p.timelineEvent.create.mockResolvedValue({});
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue({ phone: null });

    const result = await recordOutboundSms({
      organizationId: ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(result.delivery).toEqual({ delivered: false, reason: 'NO_SMS_NUMBER' });
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'skipped', status_reason: 'NO_SMS_NUMBER' },
    });
  });
});
