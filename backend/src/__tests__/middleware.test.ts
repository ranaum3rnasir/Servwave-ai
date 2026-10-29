import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, clearTokenCache } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { validate } from '../middleware/validate';
import { supabaseAdmin } from '../lib/supabase';
import { prisma } from '../lib/prisma';

// ─── Typed mocks ──────────────────────────────────────

const mockGetUser = supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: {},
    user: undefined,
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

// ═══════════════════════════════════════════════════════
// authenticate middleware
// ═══════════════════════════════════════════════════════

describe('authenticate middleware', () => {
  it('returns 401 for missing authorization header', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for non-Bearer format', async () => {
    const req = mockReq({ headers: { authorization: 'Basic abc123' } as Record<string, string> });
    const res = mockRes();
    const next = mockNext();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when supabase returns error', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer bad-token' } as Record<string, string> });
    const res = mockRes();
    const next = mockNext();

    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid token' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when user not found in database', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer valid-token' } as Record<string, string> });
    const res = mockRes();
    const next = mockNext();

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'missing-user-id', email: 'test@test.com' } },
      error: null,
    });
    mockFindUnique.mockResolvedValue(null);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for inactive user', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer valid-token' } as Record<string, string> });
    const res = mockRes();
    const next = mockNext();

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-id', email: 'test@test.com' } },
      error: null,
    });
    mockFindUnique.mockResolvedValue({
      id: 'user-id',
      email: 'test@test.com',
      first_name: 'Test',
      last_name: 'User',
      role: 'ADMIN',
      is_active: false,
    });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Account is deactivated' }));
  });

  it('sets req.user and calls next on success', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer valid-token' } as Record<string, string> });
    const res = mockRes();
    const next = mockNext();

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-id', email: 'admin@test.com' } },
      error: null,
    });
    mockFindUnique.mockResolvedValue({
      id: 'user-id',
      email: 'admin@test.com',
      first_name: 'Admin',
      last_name: 'User',
      role: 'ADMIN',
      is_active: true,
    });

    await authenticate(req, res, next);

    expect(req.user).toMatchObject({
      id: 'user-id',
      email: 'admin@test.com',
      role: 'ADMIN',
    });
    expect(next).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// authorize middleware
// ═══════════════════════════════════════════════════════

describe('authorize middleware', () => {
  it('returns 401 when req.user is not set', () => {
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    authorize('ADMIN')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when role is not in allowed list', () => {
    const req = mockReq();
    req.user = { id: '1', email: 'tech@test.com', first_name: 'T', last_name: 'U', role: 'TECHNICIAN' as const, organization_id: '00000000-0000-0000-0000-000000000001' };
    const res = mockRes();
    const next = mockNext();

    authorize('ADMIN', 'DISPATCHER')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('calls next when role matches', () => {
    const req = mockReq();
    req.user = { id: '1', email: 'admin@test.com', first_name: 'A', last_name: 'U', role: 'ADMIN' as const, organization_id: '00000000-0000-0000-0000-000000000001' };
    const res = mockRes();
    const next = mockNext();

    authorize('ADMIN', 'DISPATCHER')(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// validate middleware
// ═══════════════════════════════════════════════════════

describe('validate middleware', () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it('returns 400 with errors on invalid body', () => {
    const req = mockReq({ body: { name: '', age: -5 } });
    const res = mockRes();
    const next = mockNext();

    validate(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'name' }),
        ]),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('passes with valid body and calls next', () => {
    const req = mockReq({ body: { name: 'John', age: 30 } });
    const res = mockRes();
    const next = mockNext();

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: 'John', age: 30 });
  });
});

