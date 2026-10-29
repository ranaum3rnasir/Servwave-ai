/**
 * The phone service's org routes carry ServWave's own name in the path, never
 * the vendor's (CLAUDE.md boundary: no vendor names in user-visible URLs).
 *
 *   POST /api/organization/phone/connect                  (was /connect-ctm)
 *   POST /api/organization/phone/check-texting-approval   (was /connect-ctm/check-a2p)
 *   POST /api/organization/phone/disconnect               (was /disconnect-ctm)
 *
 * The old paths stay as aliases for one release (support scripts and a browser
 * still on an old bundle call them), so both are exercised here through the
 * real router: authenticate -> attachAbility -> canDo -> handler. The connect
 * body takes `account_id`; the old `ctm_account_id` is still accepted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { installPhoneNumberStore } from '../lib/ctm/__tests__/phoneNumberStore';
import { resetNumberSyncThrottle } from '../lib/ctm/numberSync';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ACCOUNT_ID = '111111';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  resetNumberSyncThrottle();

  client.isCtmConfigured.mockReturnValue(true);
  client.listAccounts.mockResolvedValue([{ id: 111111, name: 'Pilot Org' }]);
  client.listNumbers.mockResolvedValue([]);
  client.listWebhooks.mockResolvedValue([]);
  client.createWebhook.mockResolvedValue({ id: 1 });
  client.getA2pStatus.mockResolvedValue({ a2p_campaigns: [{ status: 'Approved' }] });

  p.organization.update.mockResolvedValue({ id: 'org-1' });
  installPhoneNumberStore();
  p.phoneNumber.updateMany.mockResolvedValue({ count: 0 });
  p.auditLog.create.mockResolvedValue({});
});

/** Admin-authenticated POST; the org reads as connected unless told otherwise. */
function asAdmin(path: string, body: Record<string, unknown> = {}, orgAccount: string | null = ACCOUNT_ID) {
  mockAuthAs('admin');
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: orgAccount });
  return request(app).post(path).set(authHeader('admin')).send(body);
}

describe('check texting approval', () => {
  it.each([
    ['the neutral path', '/api/organization/phone/check-texting-approval'],
    ['the deprecated alias', '/api/organization/connect-ctm/check-a2p'],
  ])('%s reaches the handler and answers sms_ready', async (_label, path) => {
    const res = await asAdmin(path);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sms_ready: true });
    expect(client.getA2pStatus).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});

describe('disconnect', () => {
  it.each([
    ['the neutral path', '/api/organization/phone/disconnect'],
    ['the deprecated alias', '/api/organization/disconnect-ctm'],
  ])('%s reaches the handler and detaches the account', async (_label, path) => {
    const res = await asAdmin(path);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_account_id: null, ctm_sms_ready: false } }),
    );
  });
});

describe('connect', () => {
  it.each([
    ['the neutral path with account_id', '/api/organization/phone/connect', { account_id: ACCOUNT_ID }],
    ['the neutral path with the old ctm_account_id', '/api/organization/phone/connect', { ctm_account_id: ACCOUNT_ID }],
    ['the deprecated alias with account_id', '/api/organization/connect-ctm', { account_id: ACCOUNT_ID }],
    ['the deprecated alias with the old ctm_account_id', '/api/organization/connect-ctm', { ctm_account_id: ACCOUNT_ID }],
  ])('%s connects the chosen account', async (_label, path, body) => {
    const res = await asAdmin(path, body, null);

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_account_id: ACCOUNT_ID } }),
    );
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT_ID);
  });

  it('refuses a body that names two different accounts', async () => {
    const res = await asAdmin('/api/organization/phone/connect', { account_id: ACCOUNT_ID, ctm_account_id: '999' }, null);

    expect(res.status).toBe(400);
    expect(p.organization.update).not.toHaveBeenCalled();
  });
});

describe('the neutral paths require a signed-in user', () => {
  it.each([
    '/api/organization/phone/connect',
    '/api/organization/phone/check-texting-approval',
    '/api/organization/phone/disconnect',
  ])('%s 401s with no token, before any phone-service call or org write', async (path) => {
    const res = await request(app).post(path).send({ account_id: ACCOUNT_ID });

    expect(res.status).toBe(401);
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(client.getA2pStatus).not.toHaveBeenCalled();
    expect(client.listWebhooks).not.toHaveBeenCalled();
    expect(p.organization.update).not.toHaveBeenCalled();
  });
});

describe('the neutral paths keep the ADMIN gate', () => {
  it.each([
    '/api/organization/phone/connect',
    '/api/organization/phone/check-texting-approval',
    '/api/organization/phone/disconnect',
  ])('%s 403s DISPATCHER before any phone-service call or org write', async (path) => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post(path)
      .set(authHeader('dispatcher'))
      .send({ account_id: ACCOUNT_ID });

    expect(res.status).toBe(403);
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(client.getA2pStatus).not.toHaveBeenCalled();
    expect(p.organization.update).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
