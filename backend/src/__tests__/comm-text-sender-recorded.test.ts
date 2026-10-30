// Roles & Permissions Overhaul, slice S08.1 - a text sent from the app stores the person who sent it
// and the company number it went out from. The seam is the app's own send route; the assertions are
// on what the text row is written with. Texts nobody in the app sent (automations, simulated inbound
// writes) store no sender.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { recordOutboundSms } from '../services/automations/smsRecord';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSG_ID = '99990000-0000-0000-0000-000000000001';
const LINE_ID = 'c0c0c0c0-0000-0000-0000-0000000000a1';

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  client.isCtmConfigured.mockReturnValue(true);
  client.isOptedOut.mockResolvedValue(false);
  client.sendSms.mockResolvedValue({ id: 'MSG123' });
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '111111',
    ctm_sms_ready: true,
    sms_sending_enabled: true,
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: { phone: true },
  });
  // The org's one sms-enabled company number.
  p.phoneNumber.findFirst.mockResolvedValue({ id: LINE_ID, ctm_number_id: 'TPN-A' });
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
    organization_id: ALPHA_ORG_ID,
  });
  p.customer.findFirst.mockResolvedValue({ phone: '5551234567' });
  p.timelineEvent.create.mockResolvedValue({});
  p.auditLog.create.mockResolvedValue({});
  p.message.create.mockImplementation((a: any) => Promise.resolve({ id: MSG_ID, ts: new Date(), ...a.data }));
  p.message.update.mockResolvedValue({ id: MSG_ID });
  p.message.findMany.mockResolvedValue([]);
});

describe('a text sent from the app', () => {
  it('stores the person who sent it', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'On our way' });

    expect(res.status).toBe(201);
    expect(p.message.create.mock.calls[0][0].data.sent_by_user_id).toBe(TEST_USERS.dispatcher.id);
  });

  it('stores the company number it went out from once it is sent', async () => {
    mockAuthAs('dispatcher');
    await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'On our way' });

    expect(client.sendSms.mock.calls[0][1].from).toBe('TPN-A');
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: MSG_ID },
      data: { status: 'sent', status_reason: null, ctm_sms_id: 'MSG123', phone_number_id: LINE_ID },
    });
  });

  it('a text that was never sent stores no company number', async () => {
    mockAuthAs('dispatcher');
    client.sendSms.mockRejectedValue(new client.CtmApiError('boom'));
    await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'On our way' });

    for (const [arg] of p.message.update.mock.calls) {
      expect(arg.data).not.toHaveProperty('phone_number_id');
    }
  });

  it('a simulated inbound write through the route has no sender', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'Hi from the customer', direction: 'in' });

    expect(res.status).toBe(201);
    expect(p.message.create.mock.calls[0][0].data.sent_by_user_id).toBeUndefined();
  });
});

describe('a text an automation sent', () => {
  it('stores no sender', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: THREAD_ID });
    await recordOutboundSms({
      organizationId: ALPHA_ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(p.message.create.mock.calls[0][0].data.sent_by_user_id).toBeUndefined();
  });

  it('still stores the company number it went out from', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: THREAD_ID });
    await recordOutboundSms({
      organizationId: ALPHA_ORG_ID,
      to: { type: 'customer', customerId: CUSTOMER_FIXTURE.id },
      body: 'Automated reminder',
    });

    expect(p.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent', phone_number_id: LINE_ID }) }),
    );
  });
});
