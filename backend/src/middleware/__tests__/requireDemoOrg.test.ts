import { describe, it, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { requireDemoOrg } from '../requireDemoOrg';

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    user: {
      id: 'u1',
      email: 'u@test.com',
      first_name: 'Test',
      last_name: 'User',
      role: 'ADMIN',
      organization_id: 'org-1',
      org_is_demo: false,
      org_plan: 'SCALE',
      org_features: ['phone', 'email'],
      has_login: true,
      ...overrides,
    },
  } as unknown as Request;
}
function mockRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}
function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}
function body(res: Response) {
  return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

describe('requireDemoOrg', () => {
  it('401s when req.user is not set', () => {
    const res = mockRes(); const next = mockNext();
    requireDemoOrg('whatsapp')({ user: undefined } as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next for a demo org', () => {
    const res = mockRes(); const next = mockNext();
    requireDemoOrg('whatsapp')(mockReq({ org_is_demo: true }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('404s FEATURE_DISABLED for a real (non-demo) org', () => {
    const res = mockRes(); const next = mockNext();
    requireDemoOrg('whatsapp')(mockReq({ org_is_demo: false }), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(body(res)).toEqual({ error: 'FEATURE_DISABLED', feature: 'whatsapp' });
    expect(next).not.toHaveBeenCalled();
  });

  it('404s - never 403 - so the app-wide auditAccessDenied hook does not log a false access.denied', () => {
    const res = mockRes();
    requireDemoOrg('whatsapp')(mockReq(), res, mockNext());
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('404s - never 402 - a demo lock is not an upsellable plan block', () => {
    const res = mockRes();
    requireDemoOrg('whatsapp')(mockReq(), res, mockNext());
    expect(res.status).not.toHaveBeenCalledWith(402);
  });

  it('FAILS CLOSED when org_is_demo is undefined (a JWT cached before the flag shipped)', () => {
    const res = mockRes(); const next = mockNext();
    requireDemoOrg('whatsapp')(mockReq({ org_is_demo: undefined }), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('is independent of entitlements - a full-featured real org is still locked out', () => {
    const res = mockRes(); const next = mockNext();
    requireDemoOrg('whatsapp')(
      mockReq({ org_is_demo: false, org_plan: 'ENTERPRISE', org_features: ['phone', 'email', 'inventory'] }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});
