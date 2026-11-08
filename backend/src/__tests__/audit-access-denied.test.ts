/**
 * audit-access-denied.test.ts
 *
 * Unit coverage for the `auditAccessDenied` middleware: a passive response-level
 * observer that records an `access.denied` audit row whenever a request finishes
 * with HTTP 403 — regardless of which layer produced the 403 (authorize, canGuard,
 * instance CASL checks, or a thrown ForbiddenError caught by the error handler).
 *
 * Behavior under test (the middleware's public contract):
 *   - finishes 403  → logAudit('access.denied', { method, path, role })
 *   - finishes !403 → logAudit NOT called
 *   - query string is stripped from the logged path (never leak tokens)
 *   - it is passive: always calls next(), never touches the response
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';
import { auditAccessDenied } from '../middleware/auditAccessDenied';
import { logAudit } from '../lib/audit';

vi.mock('../lib/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

const mockLogAudit = logAudit as ReturnType<typeof vi.fn>;

/** A res that behaves like Express's (EventEmitter) so we can emit 'finish'. */
function mockRes(statusCode: number): Response & EventEmitter {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res as unknown as Response & EventEmitter;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    originalUrl: '/api/jobs',
    headers: { 'user-agent': 'vitest' },
    user: {
      id: 'user-1',
      email: 'tech@test.com',
      role: 'TECHNICIAN',
      organization_id: '00000000-0000-0000-0000-000000000001',
    },
    ...overrides,
  } as unknown as Request;
}

function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auditAccessDenied middleware', () => {
  it('records access.denied when the response finishes with 403', () => {
    const req = mockReq();
    const res = mockRes(403);
    const next = mockNext();

    auditAccessDenied(req, res, next);
    res.emit('finish');

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        action: 'access.denied',
        metadata: expect.objectContaining({
          method: 'POST',
          path: '/api/jobs',
          role: 'TECHNICIAN',
        }),
      }),
    );
  });

  it.each([200, 201, 401, 404, 409, 500])(
    'does NOT record anything when the response finishes with %i',
    (status) => {
      const req = mockReq();
      const res = mockRes(status);
      const next = mockNext();

      auditAccessDenied(req, res, next);
      res.emit('finish');

      expect(mockLogAudit).not.toHaveBeenCalled();
    },
  );

  it('strips the query string from the logged path (never leaks tokens)', () => {
    const req = mockReq({
      method: 'GET',
      originalUrl: '/api/estimates/abc/public?token=super-secret-value',
    });
    const res = mockRes(403);
    const next = mockNext();

    auditAccessDenied(req, res, next);
    res.emit('finish');

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const arg = mockLogAudit.mock.calls[0][0];
    expect(arg.metadata.path).toBe('/api/estimates/abc/public');
    expect(JSON.stringify(arg.metadata)).not.toContain('super-secret-value');
  });

  it('is passive: always calls next() and writes nothing before the response finishes', () => {
    const req = mockReq();
    const res = mockRes(403);
    const next = mockNext();

    auditAccessDenied(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    // No audit row until the response actually finishes.
    expect(mockLogAudit).not.toHaveBeenCalled();

    res.emit('finish');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
  });

  it('records role as null when the 403 has no authenticated user', () => {
    const req = mockReq({ user: undefined });
    const res = mockRes(403);
    const next = mockNext();

    auditAccessDenied(req, res, next);
    res.emit('finish');

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access.denied',
        metadata: expect.objectContaining({ role: null }),
      }),
    );
  });
});
