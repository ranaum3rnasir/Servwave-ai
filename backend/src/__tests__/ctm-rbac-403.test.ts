/**
 * ctm-rbac-403.test.ts — behavioral RBAC proof for the money/config CTM routes.
 *
 * The route-string tests (ctm-numbers/ctm-connect) prove the canDo gate is
 * WRITTEN; these prove it WORKS: real supertest requests through authenticate →
 * attachAbility → canDo, following organization.test.ts's behavioral-403
 * pattern (mockAuthAs + authHeader fixtures, DEFAULT_GRANTS-backed abilities).
 * DISPATCHER and SALES lack update-Organization, so both must 403 BEFORE any
 * controller/CTM side effect.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

beforeEach(() => {
  clearTokenCache();
  clearPermissionCache();
});

describe('POST /api/communication/numbers/buy — behavioral 403', () => {
  const body = { phone_number: '+12015550123', forward_to_e164: '+16462023002' };

  it('403s DISPATCHER before any CTM call or DB write', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/communication/numbers/buy')
      .set(authHeader('dispatcher'))
      .send(body);

    expect(res.status).toBe(403);
    expect(client.buyNumber).not.toHaveBeenCalled();
    expect(client.createReceivingNumber).not.toHaveBeenCalled();
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });

  it('403s SALES before any CTM call or DB write', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .post('/api/communication/numbers/buy')
      .set(authHeader('sales'))
      .send(body);

    expect(res.status).toBe(403);
    expect(client.buyNumber).not.toHaveBeenCalled();
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/organization/connect-ctm — behavioral 403', () => {
  const body = { ctm_account_id: '596375' };

  it('403s DISPATCHER before any CTM call or org write', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/organization/connect-ctm')
      .set(authHeader('dispatcher'))
      .send(body);

    expect(res.status).toBe(403);
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(p.organization.update).not.toHaveBeenCalled();
  });

  it('403s SALES before any CTM call or org write', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .post('/api/organization/connect-ctm')
      .set(authHeader('sales'))
      .send(body);

    expect(res.status).toBe(403);
    expect(client.listAccounts).not.toHaveBeenCalled();
    expect(p.organization.update).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
