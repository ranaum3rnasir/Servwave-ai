import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { logAudit, getClientIp, forgetRefusalsForTests, refusalKeysForTests } from '../audit';
import { prisma } from '../prisma';
import { logger } from '../logger';

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: { 'user-agent': 'test-agent/1.0' },
    ip: '203.0.113.9',
    socket: { remoteAddress: '10.0.0.1' },
    user: {
      id: 'user-1',
      email: 'admin@acme.test',
      organization_id: 'org-1',
    },
    ...overrides,
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logAudit', () => {
  it('writes an audit row from the authenticated request', async () => {
    const req = makeReq({
      headers: { 'user-agent': 'test-agent/1.0', 'cf-connecting-ip': '198.51.100.7' },
    });

    await logAudit({
      req,
      action: 'estimate.approved',
      resourceType: 'Estimate',
      resourceId: 'E00001',
      metadata: { amount: 500 },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        org_id: 'org-1',
        actor_id: 'user-1',
        actor_email: 'admin@acme.test',
        action: 'estimate.approved',
        resource_type: 'Estimate',
        resource_id: 'E00001',
        metadata: { amount: 500 },
        ip_address: '198.51.100.7',
        user_agent: 'test-agent/1.0',
      },
    });
  });

  it('writes a system row (no actor) using an explicit orgId override', async () => {
    await logAudit({
      action: 'invoice.paid_via_stripe',
      resourceType: 'Invoice',
      resourceId: 'I00007',
      orgId: 'org-9',
      actorId: null,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        org_id: 'org-9',
        actor_id: null,
        actor_email: null,
        action: 'invoice.paid_via_stripe',
        resource_type: 'Invoice',
        resource_id: 'I00007',
        metadata: {},
        ip_address: null,
        user_agent: null,
      },
    });
  });

  it('treats a public request (req present, no req.user) as a system/customer action', async () => {
    const req = makeReq({ user: undefined, headers: { 'cf-connecting-ip': '198.51.100.20' } });

    await logAudit({
      req,
      action: 'estimate.approved',
      resourceType: 'Estimate',
      resourceId: 'E00002',
      orgId: 'org-3',
      actorId: null,
      actorEmail: null,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          org_id: 'org-3',
          actor_id: null,
          actor_email: null,
          ip_address: '198.51.100.20',
        }),
      }),
    );
  });

  it('skips (with a warning) when no org_id can be resolved', async () => {
    await logAudit({ action: 'login.failed', metadata: { email: 'nobody@nowhere.test' } });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws when the insert fails — logs the error instead', async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error('db down'));

    await expect(
      logAudit({ req: makeReq(), action: 'user.invited', resourceType: 'User', resourceId: 'user-2' }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('getClientIp', () => {
  it('prefers the Cloudflare CF-Connecting-IP header', () => {
    const req = makeReq({ headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' } });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  it('falls back to req.ip when no Cloudflare header is present', () => {
    const req = makeReq({ headers: {}, ip: '203.0.113.9' });
    expect(getClientIp(req)).toBe('203.0.113.9');
  });

  it('falls back to the first X-Forwarded-For hop, then the socket address', () => {
    const xffReq = makeReq({ headers: { 'x-forwarded-for': '70.0.0.1, 10.0.0.2' }, ip: undefined });
    expect(getClientIp(xffReq)).toBe('70.0.0.1');

    const socketReq = makeReq({ headers: {}, ip: undefined, socket: { remoteAddress: '10.0.0.9' } });
    expect(getClientIp(socketReq)).toBe('10.0.0.9');
  });
});

describe('a repeated refusal, remembered in fixed-size keys (re-audit N19, memory)', () => {
  /** A refused GET on a route, as Express leaves the request once the route has matched. */
  const refuse = (path: string, route = '/:id') => logAudit({
    req: makeReq({ method: 'GET', baseUrl: '/api/customers', route: { path: route } }),
    action: 'access.denied', metadata: { method: 'GET', path, role: 'TECHNICIAN', needs: ['read:Customer'], switches: [] },
  });

  it('keeps one key of the same size however long the refused address is', async () => {
    forgetRefusalsForTests();
    await refuse('/api/customers/stats', '/stats');
    await refuse(`/api/customers/${'x'.repeat(8_192)}`);
    const keys = refusalKeysForTests();
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((k) => k.length)).size).toBe(1);
    expect(keys[0]!.length).toBeLessThanOrEqual(64);
  });

  it('writes the same refusal once a minute whatever id the address carries, and another route on its own (P2-6)', async () => {
    forgetRefusalsForTests();
    for (let i = 0; i < 25; i++) await refuse(`/api/customers/${i}-${'y'.repeat(i * 300)}`);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    await refuse('/api/customers/stats', '/stats');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it('writes one refusal however the letters of the address are cased (pass 3, N-p3-1)', async () => {
    forgetRefusalsForTests();
    // Express matches mount paths and routes without regard to case, and leaves req.baseUrl as the caller typed it.
    const casings = ['/api/customers', '/API/customers', '/api/Customers', '/API/CUSTOMERS', '/Api/Customers', '/aPi/cUsToMeRs'];
    for (const baseUrl of casings) {
      for (const route of ['/:id', '/:ID']) {
        await logAudit({
          req: makeReq({ method: 'GET', baseUrl, route: { path: route } }),
          action: 'access.denied', metadata: { method: 'GET', path: `${baseUrl}/x1`, needs: ['read:Customer'], switches: [] },
        });
      }
    }
    // A check the whole router makes, before any route matches: no route pattern, only the router's prefix as typed.
    for (const baseUrl of ['/api/roles', '/API/Roles', '/api/ROLES']) {
      await logAudit({
        req: makeReq({ method: 'GET', baseUrl }), action: 'access.denied',
        metadata: { method: 'GET', path: `${baseUrl}/x1/permissions`, needs: [], switches: [] },
      });
    }
    // And with no request to read the route from, the address itself.
    for (const path of ['/api/customers/x1', '/API/CUSTOMERS/x1']) {
      await logAudit({ orgId: 'org-1', actorId: 'user-1', action: 'access.hidden', metadata: { method: 'GET', path } });
    }
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(3);
  });

  it('reads an id out of the address when there is no request to read the route from', async () => {
    forgetRefusalsForTests();
    const bare = (path: string) => logAudit({
      orgId: 'org-1', actorId: 'user-1', action: 'access.denied', metadata: { method: 'GET', path, needs: [], switches: [] },
    });
    await bare('/api/customers/3f2a9c1e-0000-4000-8000-000000000001');
    await bare('/api/customers/3f2a9c1e-0000-4000-8000-000000000002');
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
