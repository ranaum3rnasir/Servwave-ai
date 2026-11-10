// Roles & Permissions Overhaul, slice S08.1 - calls and texts record the company number they went
// through. The seam is the phone service's feed (the webhook route) and the app's own text send
// route; the assertion is on what the call or text row is written with. The company number comes
// from the feed's tracking number, matched against THIS organization's own numbers only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_WEBHOOK_TOKEN: 'hook-token' as string | undefined,
    CTM_SECRET_KEY: 'test-secret-key' as string | undefined,
    CTM_WEBHOOK_SIGNING_SECRET: undefined as string | undefined,
    CTM_ACCESS_KEY: 'test-access-key' as string | undefined,
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../config/env', () => mockEnv);

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';

const app = express();
app.use('/api/webhooks', webhookRoutes);

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const LINE = '+12019037784';
const OTHER_LINE = '+12015550100';

/** The organization's stored company numbers, keyed the way the schema is: one row per (org, e164). */
let numbers: Array<{ id: string; organization_id: string; e164: string }>;

function post(position: string, payload: unknown) {
  return request(app)
    .post(`/api/webhooks/ctm/${position}?token=hook-token`)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
}

const call = (over: Record<string, unknown> = {}) => ({
  sid: 'CA-S081-1',
  account_id: 596375,
  caller_number: '+12015551234',
  tracking_number: LINE,
  direction: 'inbound',
  dial_status: 'answered',
  duration: 62,
  talk_time: 48,
  unix_time: 1_752_000_000,
  ...over,
});

const text = (over: Record<string, unknown> = {}) => ({
  message_id: 'MSG-S081-1',
  account_id: 596375,
  caller_number: '+12015551234',
  tracking_number: LINE,
  direction: 'msg_inbound',
  message_body: 'Is anyone there?',
  unix_time: 1_752_000_100,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.env.CTM_WEBHOOK_TOKEN = 'hook-token';
  numbers = [
    { id: 'pn-line', organization_id: ORG, e164: LINE },
    { id: 'pn-other-org', organization_id: OTHER_ORG, e164: OTHER_LINE },
  ];
  p.phoneNumber.findFirst.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    const hit = numbers.find(
      (n) => (!w.organization_id || n.organization_id === w.organization_id) && (!w.e164 || n.e164 === w.e164),
    );
    // `user_links` is read by the answerer fallback on the same table.
    return hit ? { ...hit, user_links: [] } : null;
  });
  p.ctmEvent.findUnique.mockResolvedValue(null);
  p.ctmEvent.create.mockResolvedValue({ id: 'evt-1' });
  p.organization.findFirst.mockResolvedValue({ id: ORG });
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.user.findFirst.mockResolvedValue(null);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  // #3019: the lookup for a conversation from before pairs also lists the customer's ones holding an unsent reply.
  p.messageThread.findMany.mockResolvedValue([]);
  p.messageThread.create.mockResolvedValue({ id: 'th-1' });
  p.messageThread.update.mockResolvedValue({ id: 'th-1' });
  p.message.findFirst.mockResolvedValue(null);
  p.message.findMany.mockResolvedValue([]);
  p.message.create.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  p.message.update.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  p.notification.findFirst.mockResolvedValue(null);
  p.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(p) : Promise.all(arg)));
});

describe('a call arriving from the phone feed stores the company number it went through', () => {
  it('inbound: the number that was called', async () => {
    await post('end', call());
    const upsert = p.callSession.upsert.mock.calls[0][0];
    expect(upsert.create.phone_number_id).toBe('pn-line');
    expect(upsert.update.phone_number_id).toBe('pn-line');
  });

  it('outbound: the number it went out from', async () => {
    await post('end', call({ sid: 'CA-S081-2', direction: 'outbound', called_number: '+12015551234' }));
    const upsert = p.callSession.upsert.mock.calls[0][0];
    expect(upsert.create.from_number).toBe(LINE);
    expect(upsert.create.phone_number_id).toBe('pn-line');
  });

  it('a start event stores it too, so a ringing call is already on its line', async () => {
    await post('starts', call({ sid: 'CA-S081-3' }));
    expect(p.callSession.upsert.mock.calls[0][0].create.phone_number_id).toBe('pn-line');
  });

  it('matches a number the feed spells without the plus sign or with punctuation', async () => {
    await post('end', call({ sid: 'CA-S081-4', tracking_number: '(201) 903-7784' }));
    expect(p.callSession.upsert.mock.calls[0][0].create.phone_number_id).toBe('pn-line');
  });

  it("never takes another organization's number, even for the same digits", async () => {
    numbers.push({ id: 'pn-same-digits-other-org', organization_id: OTHER_ORG, e164: '+12015559999' });
    await post('end', call({ sid: 'CA-S081-5', tracking_number: '+12015559999' }));
    const upsert = p.callSession.upsert.mock.calls[0][0];
    expect(upsert.create.phone_number_id).toBeNull();
    expect(upsert.update.phone_number_id).toBeUndefined();
  });

  it('a call on a number the organization does not have yet stays without a company number', async () => {
    await post('end', call({ sid: 'CA-S081-6', tracking_number: '+19995550000' }));
    expect(p.callSession.upsert.mock.calls[0][0].create.phone_number_id).toBeNull();
  });
});

describe('a text arriving from the phone feed stores the company number it went through', () => {
  it('inbound: the number the customer texted', async () => {
    await post('inbound_text', text());
    expect(p.message.create.mock.calls[0][0].data.phone_number_id).toBe('pn-line');
  });

  it('outbound: the number it was sent from', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    await post('outbound_text', text({ message_id: 'MSG-S081-2', direction: 'msg_outbound', called_number: '+12015551234' }));
    expect(p.message.create.mock.calls[0][0].data.phone_number_id).toBe('pn-line');
  });

  it('a sid-less app-sent row reconciled from the feed gets the number too', async () => {
    p.messageThread.findFirst.mockResolvedValue({ id: 'th-1' });
    p.message.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'shell-1' });
    await post('outbound_text', text({ message_id: 'MSG-S081-3', direction: 'msg_outbound', called_number: '+12015551234' }));
    expect(p.message.update.mock.calls[0][0].data.phone_number_id).toBe('pn-line');
  });

  it("never takes another organization's number", async () => {
    await post('inbound_text', text({ message_id: 'MSG-S081-4', tracking_number: OTHER_LINE }));
    expect(p.message.create.mock.calls[0][0].data.phone_number_id).toBeNull();
  });

  it('a redelivered text does not blank a stored number', async () => {
    p.message.findFirst.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
    await post('inbound_text', text({ message_id: 'MSG-S081-5', tracking_number: undefined }));
    expect(p.message.update.mock.calls[0][0].data).not.toHaveProperty('phone_number_id');
  });
});
