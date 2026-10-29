// Slice 3 — admin management of the User<->PhoneNumber mapping that
// resolveOutboundNumber (slice 2) reads. Every endpoint is admin-gated
// (canDo('update','Organization') — DISPATCHER/SALES have only read Organization)
// and tenant-scoped. db is mocked (codebase pattern); $transaction runs the
// interactive callback against the mocked client.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const PN1 = '00000000-0000-0000-0000-0000000000c1';
const UID_A = '00000000-0000-0000-0000-0000000000aa';
const UID_B = '00000000-0000-0000-0000-0000000000bb';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // Interactive $transaction: run the callback with the mocked client as `tx`.
  p.$transaction.mockImplementation((arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg),
  );
  p.auditLog.create.mockResolvedValue({});
});

describe('Communication number-assignments — admin gate', () => {
  it('403s a non-admin (dispatcher) on every endpoint before any work', async () => {
    mockAuthAs('dispatcher');
    const calls: Array<[('get' | 'put'), string]> = [
      ['get', '/api/communication/number-assignments'],
      ['put', `/api/communication/numbers/${PN1}/assignments`],
      ['put', `/api/communication/numbers/${PN1}/org-default`],
      ['put', `/api/communication/users/${UID_A}/default-number`],
    ];
    for (const [method, path] of calls) {
      const res = await (request(app) as any)[method](path).set(authHeader('dispatcher')).send({ user_ids: [], phone_number_id: null });
      expect(res.status).toBe(403);
    }
    expect(p.userPhoneNumber.deleteMany).not.toHaveBeenCalled();
    expect(p.userPhoneNumber.updateMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/communication/number-assignments', () => {
  it('returns numbers with assignments + the org user list, tenant-scoped', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findMany.mockResolvedValue([
      {
        id: PN1, e164: '+12015551234', label: 'Main', is_org_default: true,
        user_links: [{ user_id: UID_A, is_default: true, user: { id: UID_A, first_name: 'Ann', last_name: 'Lee' } }],
      },
    ]);
    p.user.findMany.mockResolvedValue([
      { id: UID_A, first_name: 'Ann', last_name: 'Lee' },
      { id: UID_B, first_name: 'Bo', last_name: null },
    ]);

    const res = await request(app).get('/api/communication/number-assignments').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.numbers).toEqual([
      {
        id: PN1, e164: '+12015551234', label: 'Main', is_org_default: true,
        assignments: [{ user_id: UID_A, user_name: 'Ann Lee', is_default: true }],
      },
    ]);
    expect(res.body.users).toEqual([{ id: UID_A, name: 'Ann Lee' }, { id: UID_B, name: 'Bo' }]);
    expect(p.phoneNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID }) }),
    );
  });

  // Caller ID slice 02: the page needs to know which numbers can text (the
  // calls-only warning), which are paused (never selectable as a default) and
  // the number type, and must never offer a released number.
  it("returns each number's texting capability, status and type", async () => {
    mockAuthAs('admin');
    p.phoneNumber.findMany.mockResolvedValue([
      {
        id: PN1, e164: '+12015551234', label: 'Main', is_org_default: false,
        sms_enabled: false, status: 'paused', type: 'tollfree', user_links: [],
      },
    ]);
    p.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/number-assignments').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.numbers).toEqual([
      {
        id: PN1, e164: '+12015551234', label: 'Main', is_org_default: false,
        sms_enabled: false, status: 'paused', type: 'tollfree', assignments: [],
      },
    ]);
    // The three fields are read from the row, not invented by the handler.
    expect(p.phoneNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ sms_enabled: true, status: true, type: true }),
      }),
    );
  });

  // Caller ID slice 03: a purchase that failed leaves a `failed` row behind
  // (comm-numbers.controller marks its claimed row). That is not a number the
  // org has, so it is left out alongside released ones. Paused and pending
  // numbers stay listed; the page shows them as not choosable as a default.
  it('leaves released and failed-purchase numbers out of the query and keeps paused ones, still tenant-scoped', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findMany.mockResolvedValue([]);
    p.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/number-assignments').set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Exactly the org plus "neither released nor failed": a paused number is
    // still listed.
    expect(p.phoneNumber.findMany.mock.calls[0][0].where).toEqual({
      organization_id: ALPHA_ORG_ID,
      status: { notIn: ['released', 'failed'] },
    });
  });
});

describe('PUT /api/communication/numbers/:id/assignments', () => {
  it('404s for a number outside the org — no writes', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue(null);
    const res = await request(app).put(`/api/communication/numbers/${PN1}/assignments`).set(authHeader('admin')).send({ user_ids: [] });
    expect(res.status).toBe(404);
    expect(p.userPhoneNumber.deleteMany).not.toHaveBeenCalled();
  });

  it('sets the assignment set: removes unwanted links, adds the set (skipDuplicates)', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1 });
    p.user.count.mockResolvedValue(2);
    p.userPhoneNumber.deleteMany.mockResolvedValue({ count: 0 });
    p.userPhoneNumber.createMany.mockResolvedValue({ count: 2 });

    const res = await request(app).put(`/api/communication/numbers/${PN1}/assignments`).set(authHeader('admin')).send({ user_ids: [UID_A, UID_B] });

    expect(res.status).toBe(200);
    expect(p.userPhoneNumber.deleteMany).toHaveBeenCalledWith({ where: { phone_number_id: PN1, user_id: { notIn: [UID_A, UID_B] } } });
    expect(p.userPhoneNumber.createMany).toHaveBeenCalledWith({
      data: [{ user_id: UID_A, phone_number_id: PN1 }, { user_id: UID_B, phone_number_id: PN1 }],
      skipDuplicates: true,
    });
  });

  it('dedupes repeated user_ids: a duplicate of one in-org user is not a false 400', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1 });
    p.user.count.mockResolvedValue(1); // one distinct in-org user
    p.userPhoneNumber.deleteMany.mockResolvedValue({ count: 0 });
    p.userPhoneNumber.createMany.mockResolvedValue({ count: 1 });

    const res = await request(app).put(`/api/communication/numbers/${PN1}/assignments`).set(authHeader('admin')).send({ user_ids: [UID_A, UID_A] });

    expect(res.status).toBe(200);
    // Deduped to a single link — count check compares 1 === 1, not 1 === 2.
    expect(p.user.count).toHaveBeenCalledWith({ where: expect.objectContaining({ id: { in: [UID_A] } }) });
    expect(p.userPhoneNumber.createMany).toHaveBeenCalledWith({
      data: [{ user_id: UID_A, phone_number_id: PN1 }],
      skipDuplicates: true,
    });
  });

  it('400s when a user is not in the org — no writes', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1 });
    p.user.count.mockResolvedValue(1); // only 1 of 2 in org

    const res = await request(app).put(`/api/communication/numbers/${PN1}/assignments`).set(authHeader('admin')).send({ user_ids: [UID_A, UID_B] });

    expect(res.status).toBe(400);
    expect(p.userPhoneNumber.createMany).not.toHaveBeenCalled();
  });

  it('empty user_ids removes ALL links for the number (no createMany)', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1 });
    p.userPhoneNumber.deleteMany.mockResolvedValue({ count: 3 });

    const res = await request(app).put(`/api/communication/numbers/${PN1}/assignments`).set(authHeader('admin')).send({ user_ids: [] });

    expect(res.status).toBe(200);
    expect(p.userPhoneNumber.deleteMany).toHaveBeenCalledWith({ where: { phone_number_id: PN1 } });
    expect(p.userPhoneNumber.createMany).not.toHaveBeenCalled();
  });
});

describe('PUT /api/communication/users/:userId/default-number', () => {
  it('sets a user default, clearing any prior default first', async () => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue({ id: UID_A });
    p.userPhoneNumber.findUnique.mockResolvedValue({ user_id: UID_A, phone_number: { status: 'active' } });
    p.userPhoneNumber.updateMany.mockResolvedValue({ count: 1 });
    p.userPhoneNumber.update.mockResolvedValue({});

    const res = await request(app).put(`/api/communication/users/${UID_A}/default-number`).set(authHeader('admin')).send({ phone_number_id: PN1 });

    expect(res.status).toBe(200);
    expect(p.userPhoneNumber.updateMany).toHaveBeenCalledWith({ where: { user_id: UID_A, is_default: true }, data: { is_default: false } });
    expect(p.userPhoneNumber.update).toHaveBeenCalledWith({
      where: { user_id_phone_number_id: { user_id: UID_A, phone_number_id: PN1 } },
      data: { is_default: true },
    });
  });

  it('400s setting a default number the user is not assigned to', async () => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue({ id: UID_A });
    p.userPhoneNumber.findUnique.mockResolvedValue(null);

    const res = await request(app).put(`/api/communication/users/${UID_A}/default-number`).set(authHeader('admin')).send({ phone_number_id: PN1 });

    expect(res.status).toBe(400);
    expect(p.userPhoneNumber.update).not.toHaveBeenCalled();
  });

  // Caller ID slice 02 hardening: the resolver only ever presents an ACTIVE
  // number, so a paused or released number must not be accepted as a default
  // even when a client skips the page's own check.
  it.each([
    ['paused', "A paused number can't be a default caller ID."],
    ['released', "A released number can't be a default caller ID."],
  ])('400s making a %s number a user default - no writes', async (status, message) => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue({ id: UID_A });
    p.userPhoneNumber.findUnique.mockResolvedValue({ user_id: UID_A, phone_number: { status } });

    const res = await request(app).put(`/api/communication/users/${UID_A}/default-number`).set(authHeader('admin')).send({ phone_number_id: PN1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(p.userPhoneNumber.updateMany).not.toHaveBeenCalled();
    expect(p.userPhoneNumber.update).not.toHaveBeenCalled();
  });

  it('null phone_number_id clears the user default (no set)', async () => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue({ id: UID_A });
    p.userPhoneNumber.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).put(`/api/communication/users/${UID_A}/default-number`).set(authHeader('admin')).send({ phone_number_id: null });

    expect(res.status).toBe(200);
    expect(p.userPhoneNumber.updateMany).toHaveBeenCalledWith({ where: { user_id: UID_A, is_default: true }, data: { is_default: false } });
    expect(p.userPhoneNumber.update).not.toHaveBeenCalled();
  });

  it('404s for a user outside the org', async () => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue(null);
    const res = await request(app).put(`/api/communication/users/${UID_A}/default-number`).set(authHeader('admin')).send({ phone_number_id: null });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/communication/numbers/:id/org-default', () => {
  it('sets the org default, clearing the prior org default first', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1, status: 'active' });
    p.phoneNumber.updateMany.mockResolvedValue({ count: 1 });
    p.phoneNumber.update.mockResolvedValue({});

    const res = await request(app).put(`/api/communication/numbers/${PN1}/org-default`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(p.phoneNumber.updateMany).toHaveBeenCalledWith({ where: { organization_id: ALPHA_ORG_ID, is_org_default: true }, data: { is_org_default: false } });
    expect(p.phoneNumber.update).toHaveBeenCalledWith({ where: { id: PN1 }, data: { is_org_default: true } });
  });

  it('404s for a number outside the org — no writes', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue(null);
    const res = await request(app).put(`/api/communication/numbers/${PN1}/org-default`).set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
    expect(p.phoneNumber.updateMany).not.toHaveBeenCalled();
  });

  it('is_org_default:false unsets without touching siblings', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1, status: 'active' });
    p.phoneNumber.update.mockResolvedValue({});

    const res = await request(app).put(`/api/communication/numbers/${PN1}/org-default`).set(authHeader('admin')).send({ is_org_default: false });

    expect(res.status).toBe(200);
    expect(p.phoneNumber.updateMany).not.toHaveBeenCalled();
    expect(p.phoneNumber.update).toHaveBeenCalledWith({ where: { id: PN1 }, data: { is_org_default: false } });
  });

  it.each([
    ['paused', "A paused number can't be a default caller ID."],
    ['released', "A released number can't be a default caller ID."],
  ])('400s making a %s number the org default - no writes', async (status, message) => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1, status });

    const res = await request(app).put(`/api/communication/numbers/${PN1}/org-default`).set(authHeader('admin')).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(p.phoneNumber.updateMany).not.toHaveBeenCalled();
    expect(p.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('still lets a paused number stop being the org default', async () => {
    mockAuthAs('admin');
    p.phoneNumber.findFirst.mockResolvedValue({ id: PN1, status: 'paused' });
    p.phoneNumber.update.mockResolvedValue({});

    const res = await request(app).put(`/api/communication/numbers/${PN1}/org-default`).set(authHeader('admin')).send({ is_org_default: false });

    expect(res.status).toBe(200);
    expect(p.phoneNumber.update).toHaveBeenCalledWith({ where: { id: PN1 }, data: { is_org_default: false } });
  });
});
