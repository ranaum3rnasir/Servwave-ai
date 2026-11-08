// Buying a number is two untied steps: spend money at the provider, then save
// a row. Anything that goes wrong between them loses a number that is already
// billing - which is not hypothetical. `+1 609-596-8565` was bought on
// 2026-08-05, has a next_billing_date, is still on the account, and has no
// phone_numbers row: the audit row recorded `e164: "[object Object]"`.
//
// That specific cause was fixed in 46be48d91 (a guard rejecting a non-string
// from the provider). What remains is structural: any OTHER failure of the
// save still loses a paid-for number, silently, because nothing recorded the
// intent to buy.
//
// So the row is claimed BEFORE the money moves. A purchase that then fails
// leaves a visible `failed` row instead of nothing at all, and one that never
// resolves leaves a `pending` row - an anomaly someone can see, rather than an
// invisible charge.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import * as ctmClient from '../../lib/ctm/client';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const CTM_ACCOUNT_ID = '500002';
const WANTED = '+16097775555';

const buy = (body: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/communication/numbers/buy')
    .set(authHeader('admin'))
    .send({ phone_number: WANTED, forward_to_e164: '+15555550199', ...body });

/** The create-side of the claim written before the provider is called. */
const claim = () =>
  p.phoneNumber.upsert.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.create?.status === 'pending');

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.$transaction.mockImplementation((arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
  p.auditLog.create.mockResolvedValue({});
  mockAuthAs('admin');

  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: CTM_ACCOUNT_ID });
  p.phoneNumber.findFirst.mockResolvedValue(null);
  p.phoneNumber.upsert.mockImplementation((args: any) =>
    Promise.resolve({
      id: 'pn-new',
      e164: WANTED,
      formatted: null,
      label: null,
      source: 'ctm',
      type: null,
      sms_enabled: false,
      ctm_number_id: 'TPN-new',
      call_flow_id: null,
      route_to: null,
      status: 'active',
      created_at: new Date('2026-08-12T10:00:00Z'),
      ...(args.create ?? {}),
      ...(args.update ?? {}),
      organization_id: ALPHA_ORG_ID,
    }),
  );
  p.phoneNumber.update.mockResolvedValue({});

  client.buyNumber.mockResolvedValue({ id: 'TPN-new', number: WANTED, formatted: '(609) 777-5555' });
  client.enableSms.mockResolvedValue('ok');
  client.createReceivingNumber.mockResolvedValue({});
  client.updateNumberRouting.mockResolvedValue({});
});

describe('POST /api/communication/numbers/buy - claiming the row before the money moves', () => {
  it('records the intent to buy BEFORE calling the provider', async () => {
    await buy();

    expect(claim()).toBeTruthy();
    expect(claim().create.e164).toBe(WANTED);
    expect(p.phoneNumber.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      client.buyNumber.mock.invocationCallOrder[0],
    );
  });

  it('promotes the claim to an active number once the purchase lands', async () => {
    const res = await buy();

    expect(res.status).toBe(201);
    expect(res.body.number.status).toBe('active');
  });

  it('leaves a visible failed row when the purchase blows up', async () => {
    // The whole point: a charge that may have happened must not vanish.
    client.buyNumber.mockRejectedValue(new ctmClient.CtmApiError(500, 'boom'));

    const res = await buy();

    expect(res.status).toBe(502);
    expect(p.phoneNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('marks the claim failed when the number was taken first, too', async () => {
    client.buyNumber.mockRejectedValue(new ctmClient.CtmApiError(409, 'number unavailable'));

    const res = await buy();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NUMBER_UNAVAILABLE');
    expect(p.phoneNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('never downgrades a number the org already owns', async () => {
    // Re-buying a number already on file must not flip a working number to
    // pending, nor mark it failed if the duplicate purchase is rejected.
    p.phoneNumber.findFirst.mockResolvedValue({ id: 'pn-existing', status: 'active' });
    client.buyNumber.mockRejectedValue(new ctmClient.CtmApiError(409, 'duplicate'));

    await buy();

    expect(claim()).toBeUndefined();
    expect(p.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('does not fail the purchase if recording the failure itself fails', async () => {
    // A best-effort marker must never turn a 502 into a 500 and lose the typed
    // error the UI branches on.
    client.buyNumber.mockRejectedValue(new ctmClient.CtmApiError(409, 'number unavailable'));
    p.phoneNumber.update.mockRejectedValue(new Error('db down'));

    const res = await buy();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NUMBER_UNAVAILABLE');
  });

  it('still refuses an invalid request before claiming anything', async () => {
    const res = await buy({ forward_to_e164: '12345' });

    expect(res.status).toBe(400);
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
    expect(client.buyNumber).not.toHaveBeenCalled();
  });

  it('claims nothing when the org is not connected to a phone system', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });

    const res = await buy();

    expect(res.status).toBe(409);
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });

  it('clears the claim when the provider hands back a different number', async () => {
    // The claim is keyed to the number ASKED for. If a different one arrives,
    // the claim is a pending row for a number nobody owns - a false anomaly
    // sitting among the real ones.
    p.phoneNumber.delete = vi.fn().mockResolvedValue({});
    client.buyNumber.mockResolvedValue({ id: 'TPN-other', number: '+16097770000' });
    p.phoneNumber.upsert
      .mockImplementationOnce(() => Promise.resolve({ id: 'pn-claim', e164: WANTED }))
      .mockImplementationOnce((args: any) =>
        Promise.resolve({
          id: 'pn-other',
          e164: '+16097770000',
          formatted: null,
          label: null,
          source: 'ctm',
          type: null,
          sms_enabled: false,
          ctm_number_id: 'TPN-other',
          call_flow_id: null,
          route_to: null,
          status: 'active',
          created_at: new Date('2026-08-12T10:00:00Z'),
          ...(args.create ?? {}),
        }),
      );

    const res = await buy();

    expect(res.status).toBe(201);
    expect(p.phoneNumber.delete).toHaveBeenCalledWith({ where: { id: 'pn-claim' } });
  });
});
