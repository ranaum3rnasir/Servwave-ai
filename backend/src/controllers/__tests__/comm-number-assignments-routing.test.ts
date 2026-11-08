// Assignment is a statement of responsibility, NOT a routing instruction.
//
// This suite used to pin the opposite: assigning a number created a voicemail
// menu, pointed the number's dial route at it, and overwrote `route_to`. The
// practical effect was that buying a number made it ring and then assigning it
// to a user made it stop ringing and go to voicemail, destroying the forward
// destination the purchase had set. What is pinned here now is the absence of
// all of that - assignment and org-default are pure DB writes, and where a
// number rings is changed only through PATCH /numbers/:id (see
// comm-number-forwarding.test.ts).
//
// The CTM client is globally mocked by setup.ts, so a stray call would be
// caught here rather than reaching the network.
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
const UID_A = '00000000-0000-0000-0000-0000000000ea';
const UID_B = '00000000-0000-0000-0000-0000000000eb';
const CTM_ACCOUNT_ID = '500001';

const numberRow = (over: Record<string, unknown> = {}) => ({
  id: PN1,
  e164: '+16097191235',
  label: null,
  ctm_number_id: 'TPN123',
  route_to: { forward_to: '+15555550199' },
  // A real row always carries a status (the column defaults to active); the
  // org-default endpoint refuses a non-active number.
  status: 'active',
  ...over,
});

/** Every CTM call this controller could conceivably make. */
const ctmCalls = () => [
  client.createVoiceMenu,
  client.addReceivingToTracking,
  client.updateNumberRouting,
  client.createReceivingNumber,
];

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.$transaction.mockImplementation((arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
  p.auditLog.create.mockResolvedValue({});

  mockAuthAs('admin');

  // Fully connected and configured: nothing below is passing because CTM
  // happens to be unavailable.
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: CTM_ACCOUNT_ID });
  p.phoneNumber.findFirst.mockResolvedValue(numberRow());
  p.phoneNumber.update.mockResolvedValue({});
  p.phoneNumber.updateMany.mockResolvedValue({ count: 0 });
  p.user.count.mockResolvedValue(1);
  p.user.findFirst.mockResolvedValue({ first_name: 'Art', last_name: 'Nakamura' });
  p.userPhoneNumber.deleteMany.mockResolvedValue({ count: 0 });
  p.userPhoneNumber.createMany.mockResolvedValue({ count: 1 });
});

const assign = (userIds: string[]) =>
  request(app)
    .put(`/api/communication/numbers/${PN1}/assignments`)
    .set(authHeader('admin'))
    .send({ user_ids: userIds });

describe('PUT /api/communication/numbers/:id/assignments - routing is untouched', () => {
  it('assigning a single user makes no call to the phone system', async () => {
    const res = await assign([UID_A]);

    expect(res.status).toBe(200);
    ctmCalls().forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('leaves the forward destination the purchase set exactly as it was', async () => {
    // The regression that motivated this slice: route_to was overwritten with
    // a voice-menu reference, so the number silently stopped ringing.
    await assign([UID_A]);

    expect(p.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('still writes the assignment links themselves', async () => {
    p.user.count.mockResolvedValue(2); // both ids are in-org
    await assign([UID_A, UID_B]);

    expect(p.userPhoneNumber.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { user_id: UID_A, phone_number_id: PN1 },
          { user_id: UID_B, phone_number_id: PN1 },
        ],
        skipDuplicates: true,
      }),
    );
  });

  it('no longer reports a routing outcome it does not produce', async () => {
    const res = await assign([UID_A]);

    expect(res.body).toEqual({ ok: true });
  });

  it('unassigning to zero users is also inert', async () => {
    const res = await assign([]);

    expect(res.status).toBe(200);
    ctmCalls().forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('404s for a number outside the caller org, before any write', async () => {
    p.phoneNumber.findFirst.mockResolvedValue(null);

    const res = await assign([UID_A]);

    expect(res.status).toBe(404);
    expect(p.userPhoneNumber.createMany).not.toHaveBeenCalled();
  });

  it('rejects a user from another organization', async () => {
    p.user.count.mockResolvedValue(0);

    const res = await assign([UID_A]);

    expect(res.status).toBe(400);
    expect(p.userPhoneNumber.deleteMany).not.toHaveBeenCalled();
  });
});

describe('PUT /api/communication/numbers/:id/org-default - routing is untouched', () => {
  const orgDefault = (isOrgDefault: boolean) =>
    request(app)
      .put(`/api/communication/numbers/${PN1}/org-default`)
      .set(authHeader('admin'))
      .send({ is_org_default: isOrgDefault });

  it('setting the org default makes no call to the phone system', async () => {
    const res = await orgDefault(true);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    ctmCalls().forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it('still flips the flag, clearing any prior default first', async () => {
    await orgDefault(true);

    expect(p.phoneNumber.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { is_org_default: false } }),
    );
    expect(p.phoneNumber.update).toHaveBeenCalledWith({
      where: { id: PN1 },
      data: { is_org_default: true },
    });
  });

  it('unsetting the org default is inert too', async () => {
    const res = await orgDefault(false);

    expect(res.status).toBe(200);
    ctmCalls().forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
});
