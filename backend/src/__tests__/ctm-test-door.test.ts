/**
 * ctm-test-door.test.ts — the /api/test/ctm-webhook E2E door (non-production).
 *
 * Gated exactly like the Stripe door (E2E_TEST_DOORS env flag inside the
 * non-prod block) PLUS an org constraint the Stripe door doesn't need: the
 * payload's account_id must resolve to an E2E-provisioned org (name prefixed
 * 'e2e-qa-' by the provision-org door). The door can never write into a real
 * org. Production absence is asserted in webhook-production-trust.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import * as ctmClient from '../lib/ctm/client';
import { resetNumberSyncThrottle } from '../lib/ctm/numberSync';
import { clearOrgNumberRoster } from '../lib/ctm/unknownNumberSync';
import { processCtmEvent } from '../controllers/ctm-webhook.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const E2E_ORG = { id: 'org-e2e', name: 'e2e-qa-run1', ctm_account_id: '500001' };

const CALL_END_PAYLOAD = {
  sid: 'CA_DOOR_1',
  account_id: 500001,
  caller_number: '+12015551234',
  tracking_number: '+12019037784',
  direction: 'inbound',
  dial_status: 'answered',
  unix_time: 1_752_000_000,
};

const originalFlag = env.E2E_TEST_DOORS;

beforeEach(() => {
  (env as any).E2E_TEST_DOORS = 'true';
  p.organization.findFirst.mockResolvedValue(E2E_ORG);
  p.ctmEvent.findUnique.mockResolvedValue(null);
  p.ctmEvent.create.mockResolvedValue({ id: 'evt-1' });
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.user.findFirst.mockResolvedValue(null);
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.notification.findFirst.mockResolvedValue(null);
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
});

afterEach(() => {
  (env as any).E2E_TEST_DOORS = originalFlag;
});

describe('POST /api/test/ctm-webhook', () => {
  it('403s when E2E_TEST_DOORS is not enabled (same gate as the Stripe door)', async () => {
    (env as any).E2E_TEST_DOORS = undefined;
    const res = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end', payload: CALL_END_PAYLOAD });
    expect(res.status).toBe(403);
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('400s a malformed body (position + payload required)', async () => {
    const missingPayload = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end' });
    expect(missingPayload.status).toBe(400);

    const missingPosition = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ payload: CALL_END_PAYLOAD });
    expect(missingPosition.status).toBe(400);
  });

  it('403s when the account_id resolves to a REAL (non-E2E) org — no ingest', async () => {
    p.organization.findFirst.mockResolvedValue({
      id: 'org-real',
      name: 'Pilot Org INC.',
      ctm_account_id: '500001',
    });
    const res = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end', payload: CALL_END_PAYLOAD });

    expect(res.status).toBe(403);
    expect(p.ctmEvent.create).not.toHaveBeenCalled();
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('403s an unknown/unconnected account_id — no ingest', async () => {
    p.organization.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end', payload: { ...CALL_END_PAYLOAD, account_id: 999999 } });

    expect(res.status).toBe(403);
    expect(p.callSession.upsert).not.toHaveBeenCalled();
  });

  it('processes an E2E-org payload through the REAL processCtmEvent (row ingested + event claimed)', async () => {
    const res = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end', payload: CALL_END_PAYLOAD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(p.ctmEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ctm_event_id: 'CA_DOOR_1:end', event_type: 'end' }),
      }),
    );
    expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
    expect(p.callSession.upsert.mock.calls[0][0].create.organization_id).toBe('org-e2e');
  });
});

// The door is unauthenticated (only env-gated and limited to E2E orgs), so it
// must not reach the phone system: the real webhook's "a call on a number we do
// not have syncs the org's numbers" step is skipped for door events.
describe('the door and the unknown-number sync', () => {
  const client = ctmClient as any;

  /** Let the post-response work run (or not start at all). */
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    resetNumberSyncThrottle();
    clearOrgNumberRoster();
    client.isCtmConfigured.mockReturnValue(true);
    client.listNumbers.mockReset();
    client.listNumbers.mockResolvedValue([]);
    // The org has no numbers stored, so the event's tracking number is unknown.
    p.phoneNumber.findMany.mockResolvedValue([]);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: E2E_ORG.ctm_account_id });
    p.auditLog.create.mockResolvedValue({});
  });

  afterEach(() => {
    client.isCtmConfigured.mockReturnValue(false);
    client.listNumbers.mockReset();
    resetNumberSyncThrottle();
    clearOrgNumberRoster();
  });

  it('does not sync the org numbers for a door event on a number the org does not have', async () => {
    const res = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end', payload: CALL_END_PAYLOAD });
    await settle();

    expect(res.status).toBe(200);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });

  it('still syncs for the same event arriving through the real webhook processing', async () => {
    const res: any = { json: vi.fn(), status: vi.fn() };
    res.status.mockReturnValue(res);

    await processCtmEvent('end', { ...CALL_END_PAYLOAD, sid: 'CA_DOOR_2' }, res);
    await settle();

    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(client.listNumbers).toHaveBeenCalledWith(E2E_ORG.ctm_account_id);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
