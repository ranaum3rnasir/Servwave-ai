/**
 * ctm-webhook-answerer-warm.test.ts - the CTM roster is fetched OUTSIDE the
 * ingest transaction.
 *
 * Resolving "who picked up a forwarded call" needs CTM's receiving-numbers
 * roster, and ingestCall runs inside `prisma.$transaction`. Fetching it from
 * there would hold a database transaction open across an HTTP call: Prisma
 * aborts an interactive transaction after 5s, so one slow CTM response would
 * roll back the ingest and lose the call record entirely - trading a call for
 * a name. The webhook therefore warms the cache first and ingest reads it
 * synchronously.
 *
 * These tests pin that ordering, because nothing about the code's appearance
 * would reveal a regression: moving the warm inside the transaction still
 * passes every attribution test and only fails under a slow network, in
 * production, as a lost call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_WEBHOOK_TOKEN: 'hook-token' as string | undefined,
    CTM_SECRET_KEY: 'test-secret-key' as string | undefined,
    CTM_WEBHOOK_SIGNING_SECRET: 'test-signing-secret' as string | undefined,
    CTM_ACCESS_KEY: 'test-access-key' as string | undefined,
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../config/env', () => mockEnv);

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { clearReceivingNumberCache } from '../lib/ctm/receivingNumbers';

const app = express();
app.use('/api/webhooks', webhookRoutes);

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ACCOUNT_ID = '500001';
const ORG_ID = 'org-1';
const SAGIV_ID = 'b0000000-0000-0000-0000-00000000000b';

/** Answered inbound call, no agent object: forwarded to a staff mobile. */
const FORWARDED_END = {
  sid: 'CA-fwd-1',
  id: 12345,
  account_id: 500001,
  caller_number: '+12015551234',
  tracking_number: '+12019037784',
  direction: 'inbound',
  dial_status: 'answered',
  call_status: 'completed',
  talk_time: 48,
  unix_time: 1_752_000_000,
  receiving_number_id: 3831356,
};

function post(position: string, payload: unknown) {
  return request(app)
    .post(`/api/webhooks/ctm/${position}?token=hook-token`)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearReceivingNumberCache();
  mockEnv.env.CTM_WEBHOOK_TOKEN = 'hook-token';

  p.ctmEvent.findUnique.mockResolvedValue(null);
  p.ctmEvent.create.mockResolvedValue({ id: 'evt-1' });
  p.organization.findFirst.mockResolvedValue({ id: ORG_ID, ctm_account_id: ACCOUNT_ID });
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.user.findFirst.mockResolvedValue(null);
  p.user.findMany.mockResolvedValue([
    { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
  ]);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.pendingCallAttribution.findFirst.mockResolvedValue(null);
  p.notification.findFirst.mockResolvedValue(null);
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );

  client.isCtmConfigured.mockReturnValue(true);
  client.listReceivingNumbers.mockResolvedValue([
    { id: 'RPN-A', filter_id: 3831356, name: 'Sagiv Peker', number: '+16465550111' },
  ]);
});

describe('CTM webhook - forwarded-answer attribution', () => {
  it('fetches the roster BEFORE opening the ingest transaction', async () => {
    await post('end', FORWARDED_END);

    expect(client.listReceivingNumbers).toHaveBeenCalled();
    // The ordering IS the safety property - see the file header.
    expect(client.listReceivingNumbers.mock.invocationCallOrder[0]).toBeLessThan(
      p.$transaction.mock.invocationCallOrder[0],
    );
  });

  it('attributes the forwarded answer to the user who owns that phone', async () => {
    await post('end', FORWARDED_END);

    const create = p.callSession.upsert.mock.calls[0][0].create;
    expect(create.agent_id).toBe(SAGIV_ID);
    expect(create.answered_by).toMatchObject({ kind: 'external', user_id: SAGIV_ID });
  });

  it('still records the call when CTM cannot be reached', async () => {
    client.listReceivingNumbers.mockRejectedValue(new Error('CTM 503'));

    const res = await post('end', FORWARDED_END);

    // Fail-open, end to end: a 500 here would make CTM retry, and a persistent
    // CTM outage would turn every forwarded call into a lost record.
    expect(res.status).toBe(200);
    expect(p.callSession.upsert).toHaveBeenCalled();
    expect(p.callSession.upsert.mock.calls[0][0].create.agent_id).toBeNull();
  });

  it('does not fetch the roster for a call that already names its agent', async () => {
    await post('end', {
      ...FORWARDED_END,
      agent: { id: 9, name: 'Emanuel', email: 'emanuel@example.com' },
    });

    // An in-app CSR answer needs no resolution, and warming for it would spend
    // a CTM request on every single agent-answered call.
    expect(client.listReceivingNumbers).not.toHaveBeenCalled();
  });

  it('does not fetch the roster for a call with no receiving number', async () => {
    const { receiving_number_id: _omitted, ...noReceiving } = FORWARDED_END;

    await post('end', noReceiving);

    expect(client.listReceivingNumbers).not.toHaveBeenCalled();
  });
});
