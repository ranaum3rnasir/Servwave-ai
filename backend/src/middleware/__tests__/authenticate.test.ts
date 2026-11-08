import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authenticate, clearTokenCache } from '../authenticate';
import { supabaseAdmin } from '../../lib/supabase';
import { prisma } from '../../lib/prisma';

function mockRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}
function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

const ORG = { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} };

const getUserMock = () => supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>;
const findUniqueMock = () => prisma.user.findUnique as ReturnType<typeof vi.fn>;

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'u1@test.com',
    first_name: 'T',
    last_name: 'U',
    role: 'ADMIN',
    custom_role_id: null,
    custom_role: null,
    is_active: true,
    has_login: true,
    organization_id: 'org-1',
    department_id: null,
    location_id: null,
    phone: null,
    phone_ext: null,
    organization: ORG,
    ...over,
  };
}

/**
 * Hold `getUser` open so a burst of requests is genuinely in flight at once,
 * which is the only state where the sharing is observable. Every caller's
 * resolver is collected rather than one being kept, so a regression that fires
 * twelve verifications fails on the call count instead of hanging on eleven
 * promises nobody resolves.
 */
function deferGetUser() {
  const pending: Array<(value: unknown) => void> = [];
  getUserMock().mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  return {
    calls: () => getUserMock().mock.calls.length,
    settleAll: (value: unknown) => pending.forEach((resolve) => resolve(value)),
  };
}

const req = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

describe('authenticate - SRVW-138 custom-role bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it('carries custom_role_id and custom_role.key from the DB row onto req.user', async () => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'u1', email: 'u1@test.com' } },
      error: null,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      email: 'u1@test.com',
      first_name: 'T',
      last_name: 'U',
      role: 'ADMIN',
      custom_role_id: 'cr-1',
      custom_role: { key: 'office-manager' },
      is_active: true,
      has_login: true,
      organization_id: 'org-1',
      department_id: null,
      location_id: null,
      phone: null,
      phone_ext: null,
      organization: ORG,
    });

    const req = { headers: { authorization: 'Bearer token-abc' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.custom_role_id).toBe('cr-1');
    expect((req.user as { custom_role?: { key: string } }).custom_role?.key).toBe('office-manager');
  });

  it('a plain (non-custom) user carries a null custom_role_id, not undefined-by-omission', async () => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'u2', email: 'u2@test.com' } },
      error: null,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u2',
      email: 'u2@test.com',
      first_name: 'T',
      last_name: 'U',
      role: 'SALES',
      custom_role_id: null,
      custom_role: null,
      is_active: true,
      has_login: true,
      organization_id: 'org-1',
      department_id: null,
      location_id: null,
      phone: null,
      phone_ext: null,
      organization: ORG,
    });

    const req = { headers: { authorization: 'Bearer token-def' } } as unknown as Request;
    const res = mockRes();
    const next = mockNext();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user?.custom_role_id).toBeNull();
  });

  it('a cached auth entry (second request, same token) still carries custom_role_id', async () => {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: 'u3', email: 'u3@test.com' } },
      error: null,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u3',
      email: 'u3@test.com',
      first_name: 'T',
      last_name: 'U',
      role: 'ADMIN',
      custom_role_id: 'cr-2',
      custom_role: { key: 'ops-lead' },
      is_active: true,
      has_login: true,
      organization_id: 'org-1',
      department_id: null,
      location_id: null,
      phone: null,
      phone_ext: null,
      organization: ORG,
    });

    const firstReq = { headers: { authorization: 'Bearer token-ghi' } } as unknown as Request;
    await authenticate(firstReq, mockRes(), mockNext());

    // Second request with the same token hits the in-memory cache path, not resolveAppUser again.
    const secondReq = { headers: { authorization: 'Bearer token-ghi' } } as unknown as Request;
    const res2 = mockRes();
    const next2 = mockNext();
    await authenticate(secondReq, res2, next2);

    expect(next2).toHaveBeenCalled();
    expect(secondReq.user?.custom_role_id).toBe('cr-2');
    expect((secondReq.user as { custom_role?: { key: string } }).custom_role?.key).toBe('ops-lead');
  });
});

/**
 * The token cache stored the RESOLVED user but not the in-flight promise, so it
 * only ever helped the SECOND request. A cold page load is not a second
 * request - the v2 Phone page fires roughly a dozen queries in the same tick,
 * every one of them a cache miss, and each independently called Supabase Auth
 * and re-read the user row. Measured against staging: one auth-path request is
 * ~85-100ms, twelve concurrent ones 341-1003ms each.
 */
describe('authenticate - one verification per token, however many requests share it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it('verifies once for a burst of twelve concurrent requests on the same token', async () => {
    const gate = deferGetUser();
    findUniqueMock().mockResolvedValue(userRow());

    const reqs = Array.from({ length: 12 }, () => req('token-burst'));
    const nexts = reqs.map(() => mockNext());
    const done = reqs.map((r, i) => authenticate(r, mockRes(), nexts[i]));

    // Asserted while they are all still waiting - once they resolve, the
    // ordinary result cache would hide the difference.
    expect(gate.calls()).toBe(1);

    gate.settleAll({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null });
    await Promise.all(done);

    // The user row is read once too, not twelve times.
    expect(findUniqueMock()).toHaveBeenCalledTimes(1);
    nexts.forEach((next) => expect(next).toHaveBeenCalled());
    reqs.forEach((r) => expect(r.user?.organization_id).toBe('org-1'));
  });

  it('keeps different tokens separate', async () => {
    const gate = deferGetUser();
    findUniqueMock().mockResolvedValue(userRow());

    const done = [
      authenticate(req('token-a'), mockRes(), mockNext()),
      authenticate(req('token-a'), mockRes(), mockNext()),
      authenticate(req('token-b'), mockRes(), mockNext()),
    ];

    // Two distinct tokens are two distinct verifications - sharing across
    // tokens would hand one user another user's session.
    expect(gate.calls()).toBe(2);

    gate.settleAll({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null });
    await Promise.all(done);
  });

  it('gives every request in a failing burst its own 401 and does not cache the failure', async () => {
    const gate = deferGetUser();

    const resps = [mockRes(), mockRes(), mockRes()];
    const nexts = resps.map(() => mockNext());
    const done = resps.map((res, i) => authenticate(req('token-bad'), res, nexts[i]));
    expect(gate.calls()).toBe(1);

    gate.settleAll({ data: { user: null }, error: { message: 'invalid' } });
    await Promise.all(done);

    resps.forEach((res) => expect(res.status).toHaveBeenCalledWith(401));
    nexts.forEach((next) => expect(next).not.toHaveBeenCalled());

    // A rejected token must not stick: the next request re-verifies rather than
    // being answered from a dead in-flight entry.
    getUserMock().mockResolvedValue({
      data: { user: { id: 'u1', email: 'u1@test.com' } },
      error: null,
    });
    findUniqueMock().mockResolvedValue(userRow());
    const later = mockNext();
    await authenticate(req('token-bad'), mockRes(), later);
    expect(later).toHaveBeenCalled();
  });

  it('answers a deactivated account with 403 for every request in the burst', async () => {
    const gate = deferGetUser();
    findUniqueMock().mockResolvedValue(userRow({ is_active: false }));

    const resps = [mockRes(), mockRes()];
    const nexts = resps.map(() => mockNext());
    const done = resps.map((res, i) => authenticate(req('token-off'), res, nexts[i]));

    gate.settleAll({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null });
    await Promise.all(done);

    resps.forEach((res) => expect(res.status).toHaveBeenCalledWith(403));
    nexts.forEach((next) => expect(next).not.toHaveBeenCalled());
  });

  it('re-verifies after the burst has settled, so a revoked token is not pinned', async () => {
    getUserMock().mockResolvedValue({
      data: { user: { id: 'u1', email: 'u1@test.com' } },
      error: null,
    });
    findUniqueMock().mockResolvedValue(userRow());

    await authenticate(req('token-seq'), mockRes(), mockNext());
    clearTokenCache();
    await authenticate(req('token-seq'), mockRes(), mockNext());

    // Sharing is for concurrency only. With the result cache cleared there is
    // no in-flight entry left to serve the second request from.
    expect(getUserMock()).toHaveBeenCalledTimes(2);
  });
});
