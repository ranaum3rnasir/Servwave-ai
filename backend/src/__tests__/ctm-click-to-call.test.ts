// Slice 8 — click-to-call: POST /calls with direction 'out' on a CTM-connected
// org places a REAL call through CTM (`placeCall` bridge: the agent's phone
// rings first, then CTM dials the customer) and answers 202 {queued:true}
// WITHOUT creating any CallSession row — the 'starts'/'end' webhooks are the
// single source of truth (master plan §2: no optimistic local row; a fuzzy
// merge with the webhook's row would be a correctness minefield).
// Not-connected orgs and inbound calls keep the existing path byte-identical.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const OUT_BODY = {
  direction: 'out',
  from_number: '(551) 282-7064',
  to_number: '(555) 123-4567',
  status: 'ringing',
};

/** Org connected to CTM with one active tracking number to dial from. */
function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.placeCall.mockResolvedValue({ status: 'success' });
  p.auditLog.create.mockResolvedValue({});
}

/** Mocks for the legacy (not-connected) create path: unmatched caller + row. */
function mockLegacyCreatePath() {
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.callSession.create.mockImplementation((args: any) =>
    Promise.resolve({ id: 'call-1', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));
}

/** Let fire-and-forget continuations (logAudit) settle. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts default: platform unconfigured unless a test opts in.
  client.isCtmConfigured.mockReturnValue(false);
});

describe('POST /api/communication/calls — click-to-call (CTM-connected, direction out)', () => {
  it('places the call via CTM (TPN from + E.164 to), answers 202 queued, writes NO row, audits call.placed', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, outcome_since: expect.any(String) });
    expect(client.placeCall).toHaveBeenCalledWith('500001', {
      from_number: 'TPN-A',
      call_number: '+15551234567',
    });
    // Webhook is the single source of truth — no phantom local row.
    expect(p.callSession.create).not.toHaveBeenCalled();

    await flush();
    expect(p.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'call.placed', org_id: ALPHA_ORG_ID }),
      }),
    );
  });

  it('resolves the from-number org-scoped: first ACTIVE number carrying a CTM id', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();

    await request(app).post('/api/communication/calls').set(authHeader('dispatcher')).send(OUT_BODY);

    expect(p.phoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ALPHA_ORG_ID,
          status: 'active',
          ctm_number_id: { not: null },
        }),
      }),
    );
  });

  it('409s NO_PHONE_NUMBER when the org owns no usable number — CTM never called, no row', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.phoneNumber.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PHONE_NUMBER');
    expect(res.body.error).toBeTruthy();
    expect(client.placeCall).not.toHaveBeenCalled();
    expect(p.callSession.create).not.toHaveBeenCalled();
  });

  it('502s when CTM rejects the bridge — and still writes no row', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    const err = new client.CtmApiError('CTM API error 406: invalid number');
    client.placeCall.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
    expect(p.callSession.create).not.toHaveBeenCalled();
  });

  it('502s on a non-typed placeCall failure too (network throw) — no row', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.placeCall.mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(502);
    expect(p.callSession.create).not.toHaveBeenCalled();
  });

  it('places the call for SALES too, now that `create Communication` is a role-agnostic baseline (Task A0, ServWave phone master plan)', async () => {
    mockAuthAs('sales');
    mockConnectedOrg();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('sales'))
      .send(OUT_BODY);

    expect(res.status).toBe(202);
    expect(client.placeCall).toHaveBeenCalled();
  });
});

describe('POST /api/communication/calls — existing behavior stays byte-identical', () => {
  it('not-connected org (keys set, no sub-account): outbound keeps the legacy 201 + local row', async () => {
    mockAuthAs('dispatcher');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });
    mockLegacyCreatePath();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(201);
    expect(res.body.call).toBeTruthy();
    expect(p.callSession.create).toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it('unconfigured platform: outbound takes the legacy path without even reading the org', async () => {
    mockAuthAs('dispatcher');
    mockLegacyCreatePath();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(201);
    expect(p.organization.findUnique).not.toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it("direction 'in' on a CONNECTED org is unaffected — local row, no placeCall", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockLegacyCreatePath();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, direction: 'in' });

    expect(res.status).toBe(201);
    expect(p.callSession.create).toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });
});

// The bridge dialer's ended state polls GET /calls/outcome for "an outbound call
// to this number with started_at >= since". The phone service stamps started_at
// in WHOLE SECONDS on its own clock (staging, 2026-10-03: every bridge row reads
// hh:mm:ss.000), while the dialer used to stamp `since` on the PHONE's clock to
// the millisecond. A call placed at 22:03:36.800 lands as 22:03:36 - before the
// floor - so the poll never matched and the dialer read "Call placed" forever.
// The bridge therefore hands back the floor itself, from the server clock,
// rounded down to the second and padded for clock drift.
describe('POST /api/communication/calls - click-to-call hands back the outcome floor', () => {
  it('answers outcome_since = the dial second, minus a few seconds of drift', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T22:03:36.800Z'));
    try {
      mockAuthAs('dispatcher');
      mockConnectedOrg();

      const res = await request(app)
        .post('/api/communication/calls')
        .set(authHeader('dispatcher'))
        .send(OUT_BODY);

      expect(res.status).toBe(202);
      expect(res.body.queued).toBe(true);
      // Worked example: floor(22:03:36.800) = 22:03:36, minus 2s of drift.
      // A row the phone service stamps 22:03:36 (or up to 2s earlier on a
      // lagging clock) must match; a call that started a minute ago must not.
      expect(res.body.outcome_since).toBe('2026-10-03T22:03:34.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no outcome floor when the call was refused (nothing to poll for)', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.placeCall.mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(502);
    expect(res.body.outcome_since).toBeUndefined();
  });
});
