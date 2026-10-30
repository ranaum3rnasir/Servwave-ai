/**
 * The bell alert for a missed call or an inbound text is written AFTER the webhook's own transaction commits and after the
 * webhook has answered, never inside it (Roles & Permissions S08.21).
 *
 * Why it matters now: the alert's access filter reads the call or the text conversation to decide who may open it. The ingest
 * creates that row inside the webhook's transaction; an alert raised from inside it would ask the database about a row no
 * other connection can see yet, and the filter would find nobody to tell. And a webhook must acknowledge whatever the alert
 * costs: CTM's timeout is not the place to wait for a bell.
 */
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

vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn() }));

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import { emit } from '../services/notifications/notificationService';
import { installPhoneNumberStore } from '../lib/ctm/__tests__/phoneNumberStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const app = express();
app.use('/api/webhooks', webhookRoutes);

const MISSED_CALL = {
  sid: 'CA7001', account_id: 596375, caller_number: '+12015551234', tracking_number: '+12019037784',
  direction: 'inbound', dial_status: 'no-answer', call_status: 'no-answer', talk_time: 0, unix_time: 1_752_000_000,
};
const INBOUND_TEXT = {
  message_id: 'MSG7001', account_id: 596375, caller_number: '+12015551234', tracking_number: '+12019037784',
  direction: 'msg_inbound', message_body: 'Hi, is my door fixed?', unix_time: 1_752_000_100,
};

const post = (position: string, payload: unknown) =>
  request(app).post(`/api/webhooks/ctm/${position}?token=hook-token`).set('Content-Type', 'application/json').send(JSON.stringify(payload));

/** What had happened when the alert was raised. */
let committed = false;
let raisedAfterCommit: boolean[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  installPhoneNumberStore([]);
  committed = false;
  raisedAfterCommit = [];
  vi.mocked(emit).mockImplementation((async () => {
    raisedAfterCommit.push(committed);
    return [];
  }) as never);
  p.ctmEvent.findUnique.mockResolvedValue(null);
  p.ctmEvent.create.mockResolvedValue({ id: 'evt-1' });
  p.organization.findFirst.mockResolvedValue({ id: 'org-1' });
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1', lead_id: null, organization_id: 'org-1', direction: 'in', started_at: new Date(), agent_id: null });
  p.user.findFirst.mockResolvedValue(null);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.messageThread.findFirst.mockResolvedValue(null);
  p.messageThread.create.mockResolvedValue({ id: 'th-1' });
  p.messageThread.update.mockResolvedValue({ id: 'th-1' });
  p.message.findFirst.mockResolvedValue(null);
  p.message.findMany.mockResolvedValue([]);
  p.message.create.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  p.notification.findFirst.mockResolvedValue(null);
  // The callback runs, then the transaction commits (or, when the callback throws, never does).
  p.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg !== 'function') return Promise.all(arg);
    const result = await arg(p);
    committed = true;
    return result;
  });
});

describe('the bell alert of a CTM webhook', () => {
  it('is raised for a missed call only after the transaction has committed', async () => {
    const res = await post('end', MISSED_CALL);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(emit).mock.calls[0]![0].verb).toBe('communication.call_missed');
    expect(raisedAfterCommit).toEqual([true]);
  });

  it('is raised for an inbound text only after the transaction has committed', async () => {
    const res = await post('inbound_text', INBOUND_TEXT);

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(emit).mock.calls[0]![0].verb).toBe('communication.sms_inbound');
    expect(raisedAfterCommit).toEqual([true]);
  });

  it('is not raised at all when the transaction rolls back', async () => {
    p.message.create.mockRejectedValue(new Error('constraint'));

    const res = await post('inbound_text', INBOUND_TEXT);

    expect(res.status).toBe(500);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not hold the acknowledgement for the alert', async () => {
    let release!: () => void;
    vi.mocked(emit).mockImplementation((() => new Promise((resolve) => { release = () => resolve([]); })) as never);

    const res = await post('end', MISSED_CALL);

    // The webhook has answered while the alert is still being written.
    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    release();
  });
});
