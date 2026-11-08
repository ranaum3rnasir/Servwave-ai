// DELETE /numbers/:id - give a number back and stop the recurring charge.
//
// Until now there was no way out: buy was a one-way door, the routes exposed
// no delete or release, and the Numbers table had no row actions. A customer
// could start a recurring charge from the UI and had no way to stop it
// (SRVW-240). Both paths below were then confirmed against the live provider
// on 2026-08-12, not just against these mocks: a real number was released and
// left the account, and the already-released branch was driven by a real 404.
// See releaseNumber's header.
//
// The row is NOT deleted. Calls and messages reference the number, and a
// customer looking at last month's calls should still see which number took
// them, so release is a status change.
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
const CTM_ACCOUNT_ID = '500002';

const numberRow = (over: Record<string, unknown> = {}) => ({
  id: PN1,
  e164: '+16097191235',
  formatted: '(609) 719-1235',
  label: null,
  source: 'ctm',
  type: 'local',
  sms_enabled: true,
  ctm_number_id: 'TPN123',
  call_flow_id: null,
  route_to: { forward_to: '+15555550199' },
  status: 'active',
  is_org_default: false,
  created_at: new Date('2026-08-06T02:46:37.507Z'),
  ...over,
});

const release = () =>
  request(app).delete(`/api/communication/numbers/${PN1}`).set(authHeader('admin'));

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
  client.releaseNumber.mockResolvedValue(undefined);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: CTM_ACCOUNT_ID });
  p.phoneNumber.findFirst.mockResolvedValue(numberRow());
  p.phoneNumber.update.mockImplementation((args: any) =>
    Promise.resolve(numberRow(args.data ?? {})),
  );
  p.userPhoneNumber.deleteMany.mockResolvedValue({ count: 0 });
  // Not in the shared prisma mock - spied here so "the row survives" is a real
  // assertion rather than a call on undefined.
  p.phoneNumber.delete = vi.fn();
});

describe('DELETE /api/communication/numbers/:id', () => {
  it('gives the number back to the phone system', async () => {
    const res = await release();

    expect(res.status).toBe(200);
    expect(client.releaseNumber).toHaveBeenCalledWith(CTM_ACCOUNT_ID, 'TPN123');
  });

  it('marks the row released rather than deleting it', async () => {
    // Calls and messages reference this number; deleting the row would strip
    // last month's calls of the number that took them.
    await release();

    expect(p.phoneNumber.delete).not.toHaveBeenCalled();
    expect(p.phoneNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PN1 },
        data: expect.objectContaining({ status: 'released' }),
      }),
    );
  });

  it('stops the released number being anyone caller ID', async () => {
    // A released number is unreachable; leaving it as the org default or on a
    // user's list would have outbound calls presenting a dead number.
    await release();

    const data = p.phoneNumber.update.mock.calls[0][0].data;
    expect(data.is_org_default).toBe(false);
    expect(p.userPhoneNumber.deleteMany).toHaveBeenCalledWith({
      where: { phone_number_id: PN1 },
    });
  });

  it('does not touch our records when the phone system refuses', async () => {
    // Reporting a release that did not happen would silently keep billing the
    // customer for a number they believe they gave back.
    client.releaseNumber.mockRejectedValue(new ctmClient.CtmApiError(500, 'boom'));

    const res = await release();

    expect(res.status).toBe(502);
    expect(p.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('treats a number the phone system does not have as already released', async () => {
    // The goal is "stop billing me". If it is not on the account, that is done.
    client.releaseNumber.mockRejectedValue(new ctmClient.CtmApiError(404, 'object not found'));

    const res = await release();

    expect(res.status).toBe(200);
    expect(p.phoneNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'released' }) }),
    );
  });

  it('releases a bring-your-own number locally, with no phone-system call', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(
      numberRow({ source: 'byo', ctm_number_id: null, route_to: null }),
    );

    const res = await release();

    expect(res.status).toBe(200);
    expect(client.releaseNumber).not.toHaveBeenCalled();
    expect(p.phoneNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'released' }) }),
    );
  });

  it('is idempotent - releasing an already-released number is not an error', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(numberRow({ status: 'released' }));

    const res = await release();

    expect(res.status).toBe(200);
    expect(client.releaseNumber).not.toHaveBeenCalled();
  });

  it('404s for a number outside the caller org, before any release', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(null);

    const res = await release();

    expect(res.status).toBe(404);
    expect(client.releaseNumber).not.toHaveBeenCalled();
  });

  it('is refused to a non-admin - it ends a paid subscription', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .delete(`/api/communication/numbers/${PN1}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(client.releaseNumber).not.toHaveBeenCalled();
  });
});
