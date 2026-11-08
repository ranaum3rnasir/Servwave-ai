import { describe, it, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { requireFeature } from '../requireFeature';

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
      org_plan: 'STARTER',
      org_features: [],
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

describe('requireFeature', () => {
  it('401s when req.user is not set', () => {
    const res = mockRes(); const next = mockNext();
    requireFeature('leads')({ user: undefined } as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('402s with FEATURE_NOT_IN_PLAN when the feature is absent', () => {
    const res = mockRes(); const next = mockNext();
    requireFeature('leads')(mockReq({ org_plan: 'STARTER', org_features: [] }), res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(body(res)).toMatchObject({
      error: 'FEATURE_NOT_IN_PLAN',
      feature: 'leads',
      current_plan: 'STARTER',
      required_plan: 'PRO',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('402s — never 403 — so a plan block is not misread as a permissions bug', () => {
    const res = mockRes();
    requireFeature('inventory')(mockReq(), res, mockNext());
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('calls next when the feature is present', () => {
    const res = mockRes(); const next = mockNext();
    requireFeature('leads')(mockReq({ org_plan: 'PRO', org_features: ['leads', 'phone'] }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next when granted via a per-org override on a lower plan', () => {
    const res = mockRes(); const next = mockNext();
    requireFeature('phone')(mockReq({ org_plan: 'STARTER', org_features: ['phone'] }), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('reports the right required_plan for a SCALE feature', () => {
    const res = mockRes();
    requireFeature('inventory')(mockReq({ org_plan: 'PRO', org_features: [] }), res, mockNext());
    expect(body(res)).toMatchObject({ required_plan: 'SCALE', current_plan: 'PRO' });
  });

  it('FAILS CLOSED when org_features is undefined (pre-deploy cached JWT)', () => {
    const res = mockRes(); const next = mockNext();
    requireFeature('leads')(mockReq({ org_features: undefined }), res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not blow up when org_plan is undefined', () => {
    const res = mockRes();
    expect(() =>
      requireFeature('leads')(mockReq({ org_plan: undefined, org_features: [] }), res, mockNext()),
    ).not.toThrow();
    expect(body(res).current_plan).toBe('STARTER');
  });
});
