// A purchased number's forwarding destination is the whole mechanism: it is
// where the call actually rings, and buy is currently the ONLY place it can be
// set. That makes it immutable in practice - a tech changes phone, or the
// number moves to someone else, and the owner has to go into CTM, which is
// deliberately never exposed to them. These tests pin editing it on
// PATCH /numbers/:id via `updateNumberRouting` - the same CONFIRMED CTM
// endpoint buy already uses (and that we watched route a live call).
//
// The CTM client is globally mocked by setup.ts, so this suite never leaves
// the process.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import * as ctmClient from '../../lib/ctm/client';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const PN1 = '00000000-0000-0000-0000-0000000000e1';
const CTM_ACCOUNT_ID = '500001';

const numberRow = (over: Record<string, unknown> = {}) => ({
  id: PN1,
  e164: '+12017401509',
  formatted: null,
  label: null,
  source: 'ctm',
  type: 'local',
  sms_enabled: true,
  ctm_number_id: 'TPN123',
  call_flow_id: null,
  route_to: null,
  status: 'active',
  created_at: new Date('2026-08-06T02:46:37.507Z'),
  ...over,
});

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
  p.phoneNumber.findFirst.mockResolvedValue(numberRow());
  p.phoneNumber.update.mockImplementation((args: any) =>
    Promise.resolve(numberRow(args.data ?? {})),
  );
  client.updateNumberRouting.mockResolvedValue({});
  client.createReceivingNumber.mockResolvedValue({});
});

const patch = (body: Record<string, unknown>) =>
  request(app).patch(`/api/communication/numbers/${PN1}`).set(authHeader('admin')).send(body);

describe('PATCH /api/communication/numbers/:id - forwarding destination', () => {
  it('points the CTM dial route at the new destination', async () => {
    const res = await patch({ forward_to_e164: '+16097191235' });

    expect(res.status).toBe(200);
    expect(client.updateNumberRouting).toHaveBeenCalledWith(CTM_ACCOUNT_ID, 'TPN123', {
      dial_route: 'forward',
      numbers: ['+16097191235'],
    });
  });

  it('registers the destination as a receiving number before routing to it', async () => {
    // Mirrors buy: CTM will not dial a destination it does not know about.
    await patch({ forward_to_e164: '+16097191235' });

    expect(client.createReceivingNumber).toHaveBeenCalledWith(CTM_ACCOUNT_ID, '+16097191235');
    expect(client.createReceivingNumber.mock.invocationCallOrder[0]).toBeLessThan(
      client.updateNumberRouting.mock.invocationCallOrder[0],
    );
  });

  it('persists the destination so the UI can show where a number rings', async () => {
    await patch({ forward_to_e164: '+16097191235' });

    expect(p.phoneNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PN1 },
        data: expect.objectContaining({ route_to: { forward_to: '+16097191235' } }),
      }),
    );
  });

  it('accepts a human-typed number and stores strict E.164', async () => {
    await patch({ forward_to_e164: '(609) 719-1235' });

    expect(client.updateNumberRouting).toHaveBeenCalledWith(
      CTM_ACCOUNT_ID,
      'TPN123',
      expect.objectContaining({ numbers: ['+16097191235'] }),
    );
  });

  it('accepts forwarding on its own, without a call_flow_id', async () => {
    // Guards the three negative tests below from passing for the wrong reason:
    // while call_flow_id is a REQUIRED field, every payload here 400s on the
    // schema and never reaches the forwarding logic at all.
    const res = await patch({ forward_to_e164: '+16097191235' });

    expect(res.status).toBe(200);
  });

  it('rejects a number that is not dialable, before any CTM call', async () => {
    const res = await patch({ forward_to_e164: '12345' });

    expect(res.status).toBe(400);
    expect(client.updateNumberRouting).not.toHaveBeenCalled();
  });

  it('reports failure instead of claiming a reroute that did not happen', async () => {
    // Silence here is the dangerous case: the owner believes calls now reach a
    // new phone while CTM still rings the old one.
    client.updateNumberRouting.mockRejectedValueOnce(new Error('CTM down'));

    const res = await patch({ forward_to_e164: '+16097191235' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(p.phoneNumber.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ route_to: { forward_to: '+16097191235' } }),
      }),
    );
  });

  it('exposes the forwarding destination in the wire shape', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(
      numberRow({ route_to: { forward_to: '+15555550199' } }),
    );
    p.phoneNumber.update.mockResolvedValue(numberRow({ route_to: { forward_to: '+15555550199' } }));

    const res = await patch({ call_flow_id: null });

    expect(res.body.number).toMatchObject({ forward_to: '+15555550199' });
  });

  it('still updates call_flow_id on its own, with no CTM call', async () => {
    const res = await patch({ call_flow_id: null });

    expect(res.status).toBe(200);
    expect(client.updateNumberRouting).not.toHaveBeenCalled();
  });

  it('refuses to reroute a BYO number that CTM does not track', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(numberRow({ source: 'byo', ctm_number_id: null }));

    const res = await patch({ forward_to_e164: '+16097191235' });

    expect(res.status).toBe(400);
    expect(client.updateNumberRouting).not.toHaveBeenCalled();
  });
});
