import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { logout } from '../controllers/auth.controller';
import { supabaseAdmin } from '../lib/supabase';
import * as authenticateModule from '../middleware/authenticate';

// supabaseAdmin is globally mocked in setup.ts; admin.signOut is a vi.fn() there.
const mockSignOut = (supabaseAdmin as unknown as {
  auth: { admin: { signOut: ReturnType<typeof vi.fn> } };
}).auth.admin.signOut;

// Minimal Express res double that records status/json calls.
function mockRes() {
  const res = {} as Response & { body?: unknown; code?: number };
  res.status = vi.fn().mockImplementation((c: number) => {
    res.code = c;
    return res;
  });
  res.json = vi.fn().mockImplementation((b: unknown) => {
    res.body = b;
    return res;
  });
  return res;
}

describe('POST /api/auth/logout — logout()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revokes the Supabase session globally and clears the auth cache', async () => {
    mockSignOut.mockResolvedValue({ data: null, error: null });
    const clearSpy = vi.spyOn(authenticateModule, 'clearTokenCache');

    const req = {
      user: { id: 'user-1' },
      headers: { authorization: 'Bearer jwt-abc' },
    } as unknown as Request;
    const res = mockRes();

    await logout(req, res);

    expect(mockSignOut).toHaveBeenCalledWith('jwt-abc', 'global');
    expect(clearSpy).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
  });

  it('still returns 200 and clears the cache when the GoTrue signOut errors', async () => {
    mockSignOut.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });
    const clearSpy = vi.spyOn(authenticateModule, 'clearTokenCache');

    const req = {
      user: { id: 'user-2' },
      headers: { authorization: 'Bearer jwt-xyz' },
    } as unknown as Request;
    const res = mockRes();

    await logout(req, res);

    expect(clearSpy).toHaveBeenCalledWith('user-2'); // cache cleared regardless of GoTrue result
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('still returns 200 when the GoTrue signOut throws (outage)', async () => {
    mockSignOut.mockRejectedValue(new Error('network blip'));
    const clearSpy = vi.spyOn(authenticateModule, 'clearTokenCache');

    const req = {
      user: { id: 'user-3' },
      headers: { authorization: 'Bearer jwt-boom' },
    } as unknown as Request;
    const res = mockRes();

    await logout(req, res);

    expect(clearSpy).toHaveBeenCalledWith('user-3');
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('does not call signOut when no bearer token is present but still clears cache + 200s', async () => {
    const clearSpy = vi.spyOn(authenticateModule, 'clearTokenCache');

    const req = {
      user: { id: 'user-4' },
      headers: {},
    } as unknown as Request;
    const res = mockRes();

    await logout(req, res);

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalledWith('user-4');
    expect(res.json).toHaveBeenCalledWith({ message: 'Logged out successfully' });
  });
});
