// Slice 1 — per-agent CTM softphone access token.
//
// POST /api/communication/phone-access mints a SHORT-LIVED CTM softphone token
// for the logged-in user, keyed to their email so CTM maps it to their agent
// (Basic-auth server-to-server; the browser never sees CTM credentials). The
// embed calls this to authenticate its WebRTC device.
//
// Gating mirrors every other comm surface: `authenticate` (401 unauthenticated)
// → `requireFeature('phone')` (402 for a plan without phone) → controller.
// A platform/ org that isn't CTM-connected is a 409 PHONE_NOT_CONNECTED (CTM never
// called); an upstream CTM failure is a typed 502 PHONE_TOKEN_FAILED. No DB writes.
// The codes carry ServWave's own name, never the vendor's (CLAUDE.md boundary);
// no frontend ever branched on the old CTM_* codes, so there is no alias.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

/** Org connected to CTM: platform configured + sub-account id present, CTM
 *  returns a token. */
function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
  // CTM's phone_access payload carries the account-binding fields the embed's
  // `accessToken` setter reads (account_id / user.account) — not just the token.
  client.requestPhoneAccess.mockResolvedValue({
    token: 'CTM-TOKEN-XYZ',
    valid_until: 1799999999,
    account_id: '111111',
    user: { account: '111111' },
    session_id: 'ctm-sess-1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts default: platform unconfigured unless a test opts in.
  client.isCtmConfigured.mockReturnValue(false);
});

describe('POST /api/communication/phone-access — per-agent CTM softphone token', () => {
  it('401s when unauthenticated (no bearer token) — CTM never called', async () => {
    const res = await request(app).post('/api/communication/phone-access').send({});

    expect(res.status).toBe(401);
    expect(client.requestPhoneAccess).not.toHaveBeenCalled();
  });

  it("402s an authed user whose org plan lacks `phone` — even when CTM-connected", async () => {
    mockAuthAs('realOrgAdmin');
    // Override the SCALE-org test default with a STARTER org lacking `phone`,
    // for this one request only — proves the gate is wired on this router.
    p.user.findUnique.mockResolvedValueOnce({
      ...TEST_USERS.realOrgAdmin,
      organization: { is_demo: false, plan: 'STARTER', trial_ends_at: null, feature_overrides: {} },
    });
    mockConnectedOrg(); // the org gate must block BEFORE any CTM/DB work

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('realOrgAdmin'))
      .send({});

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('FEATURE_NOT_IN_PLAN');
    expect(res.body.feature).toBe('phone');
    expect(client.requestPhoneAccess).not.toHaveBeenCalled();
  });

  it('200s for SALES now that `create Communication` is a role-agnostic baseline (Task A0, ServWave phone master plan)', async () => {
    mockAuthAs('sales');
    mockConnectedOrg();

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(200);
    expect(client.requestPhoneAccess).toHaveBeenCalled();
  });

  it('409 PHONE_NOT_CONNECTED when the platform is unconfigured — CTM never called, org never read', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(false);

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_NOT_CONNECTED');
    expect(JSON.stringify(res.body)).not.toMatch(/ctm/i);
    expect(res.body.error).toBeTruthy();
    expect(p.organization.findUnique).not.toHaveBeenCalled();
    expect(client.requestPhoneAccess).not.toHaveBeenCalled();
  });

  it('409 PHONE_NOT_CONNECTED when the org has no ctm_account_id — CTM never called', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_NOT_CONNECTED');
    expect(JSON.stringify(res.body)).not.toMatch(/ctm/i);
    expect(client.requestPhoneAccess).not.toHaveBeenCalled();
  });

  it('mints a token for the logged-in agent (keyed to their email) → 200 { token, valid_until }', async () => {
    mockAuthAs('admin');
    mockConnectedOrg();

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    // The FULL phone_access payload is proxied so the embed's `accessToken`
    // setter can bind the device to the account (it reads account_id /
    // user.account). Reconstructing {token, valid_until} was the bug that left
    // the WebRTC device unauthenticated.
    expect(res.body).toMatchObject({
      token: 'CTM-TOKEN-XYZ',
      valid_until: 1799999999,
      account_id: '111111',
      user: { account: '111111' },
    });
    // camelCase sessionId is added alongside CTM's fields (embed convention).
    expect(res.body.sessionId).toBe('ctm-sess-1');
    expect(client.requestPhoneAccess).toHaveBeenCalledWith('111111', {
      email: TEST_USERS.admin.email,
      first_name: TEST_USERS.admin.first_name,
      last_name: TEST_USERS.admin.last_name,
      session_id: TEST_USERS.admin.id,
    });
  });

  it('proxies the account-binding fields (account_id / user) — regression for the {token}-only drop', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
    client.requestPhoneAccess.mockResolvedValue({
      token: 'T',
      account_id: '111111',
      user: { account: '111111', id: 42 },
    });

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.account_id).toBe('111111');
    expect(res.body.user).toEqual({ account: '111111', id: 42 });
  });

  it('does not fabricate valid_until when CTM omits it; sessionId falls back to the user id', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
    client.requestPhoneAccess.mockResolvedValue({ token: 'CTM-TOKEN-ONLY' });

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('CTM-TOKEN-ONLY');
    expect(res.body).not.toHaveProperty('valid_until');
    expect(res.body.sessionId).toBe(TEST_USERS.admin.id);
  });

  // Live incident 2026-08-06 (account 500002): the softphone sat on
  // "Connecting..." forever with no error anywhere - 200 from this route,
  // `status: "ok"` from CTM, both embed scripts loading fine. CTM's shipped
  // device_embed builds the WebRTC iframe URL straight off this response body:
  //   accessGranted(e){ const s=e.token, t=e.sessionId, i=e.email;
  //     iframe.src = `.../embed_device?token=${s}&session=${t}&email=${i}` }
  // and its phone control reads the same two keys off the `ctm:access`
  // message. CTM's own phone_access response carries ONLY
  // {status, token, valid_until}, so every key the device reads has to be
  // added here. Without `email` the URL was built with the literal string
  // "undefined" and the device never registered.
  it('returns the agent email the device embed reads, not just sessionId', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
    client.requestPhoneAccess.mockResolvedValue({ token: 'CTM-TOKEN-ONLY' });

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(TEST_USERS.admin.email);
    // Both device-side keys must survive together - either one missing
    // stringifies to "undefined" in the iframe URL.
    expect(res.body.sessionId).toBe(TEST_USERS.admin.id);
    expect(String(res.body.email)).not.toBe('undefined');
  });

  it('502 PHONE_TOKEN_FAILED when CTM rejects the token request (typed error) — no leak', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
    const err = new client.CtmApiError('CTM API error 406: bad request');
    client.requestPhoneAccess.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PHONE_TOKEN_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/ctm/i);
    expect(res.body.error).toBeTruthy();
  });

  it('502 PHONE_TOKEN_FAILED on a non-typed failure too (network throw)', async () => {
    mockAuthAs('admin');
    client.isCtmConfigured.mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
    client.requestPhoneAccess.mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .post('/api/communication/phone-access')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PHONE_TOKEN_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/ctm/i);
  });
});
