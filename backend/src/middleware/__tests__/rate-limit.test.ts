import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiterRes } from 'rate-limiter-flexible';

// getClientIp is the source of the client-IP key. Mock it so the IP-derived
// helpers are deterministic regardless of the fake request shape.
vi.mock('../../lib/audit', () => ({
  getClientIp: vi.fn((_req: unknown) => '203.0.113.7'),
}));

vi.mock('../../lib/security-signal', () => ({
  reportSecuritySignal: vi.fn(),
}));

import { getClientIp } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { reportSecuritySignal } from '../../lib/security-signal';
import {
  makeLimiterMiddleware,
  authLimiterImpl,
  rateLimitKey,
  clientIp,
  decodeSupabaseSub,
  isExempt,
  __resetWarnThrottle,
} from '../rate-limit';

// ─── Test doubles ──────────────────────────────────────────────────────────

/** A minimal Express Response stand-in capturing status/headers/finish hooks. */
function makeRes() {
  const headers: Record<string, string | number> = {};
  let finishCb: (() => void) | undefined;
  const res: any = {
    statusCode: 200,
    headers,
    setHeader: vi.fn((k: string, v: string | number) => {
      headers[k] = v;
    }),
    set: vi.fn((k: string, v: string | number) => {
      headers[k] = v;
    }),
    status: vi.fn(function (this: any, code: number) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'finish') finishCb = cb;
      return res;
    }),
    // test helper to fire the registered finish listener
    triggerFinish: () => finishCb?.(),
  };
  return res;
}

/** A fake limiter whose consume/reward outcomes the test controls. */
function makeFakeLimiter() {
  return {
    consume: vi.fn(),
    reward: vi.fn().mockResolvedValue(undefined),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    originalUrl: '/api/customers',
    headers: {},
    body: {},
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getClientIp as any).mockReturnValue('203.0.113.7');
  // Reset the fail-open warn throttle so the two redis-down cases each observe
  // their own logger.warn (otherwise the 30s throttle suppresses the second).
  __resetWarnThrottle();
});

// ─── makeLimiterMiddleware ──────────────────────────────────────────────────

describe('makeLimiterMiddleware', () => {
  it('under limit: calls next once, no 429, sets X-RateLimit-* headers', async () => {
    const limiter = makeFakeLimiter();
    limiter.consume.mockResolvedValue({
      remainingPoints: 99,
      msBeforeNext: 1000,
      consumedPoints: 1,
    });
    const mw = makeLimiterMiddleware(limiter as any, { name: 'test', limit: 100, keyFn: () => 'k' });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(99);
    expect(res.headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('over limit: returns 429 with the documented body + Retry-After, next NOT called', async () => {
    const limiter = makeFakeLimiter();
    // remainingPoints=0, msBeforeNext=60000 → retryAfter 60
    limiter.consume.mockRejectedValue(new RateLimiterRes(0, 60000, 5, false));
    const mw = makeLimiterMiddleware(limiter as any, { name: 'test', limit: 100, keyFn: () => 'k' });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.body).toEqual({ error: 'Too many requests', retryAfter: 60 });
    expect(res.headers['Retry-After']).toBe(60);
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
  });

  it('over limit: logs a structured warn with limiter name, key, route, retryAfter', async () => {
    const limiter = makeFakeLimiter();
    limiter.consume.mockRejectedValue(new RateLimiterRes(0, 60000, 5, false));
    const mw = makeLimiterMiddleware(limiter as any, { name: 'general', limit: 100, keyFn: () => 'user-42' });
    const req = makeReq({ originalUrl: '/api/customers?page=2' });
    const res = makeRes();

    await mw(req, res, vi.fn());

    expect(logger.warn).toHaveBeenCalledWith(
      'rate limit exceeded',
      expect.objectContaining({
        limiter: 'general',
        key: 'user-42',
        route: '/api/customers',
        retryAfter: 60,
      }),
    );
  });

  it('redis down (non-RateLimiterRes error): fails OPEN — next() called + logger.warn, no 429', async () => {
    const limiter = makeFakeLimiter();
    limiter.consume.mockRejectedValue(new Error('redis down'));
    const mw = makeLimiterMiddleware(limiter as any, { name: 'test', limit: 100, keyFn: () => 'k' });
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(logger.warn).toHaveBeenCalled();
    // Distinct from the 429 log — a fail-open must never be mistaken for a block.
    expect(logger.warn).not.toHaveBeenCalledWith('rate limit exceeded', expect.anything());
  });

  it('fail-open path emits rate_limiter_failing_open tagged with the limiter name', async () => {
    __resetWarnThrottle();
    const down = { consume: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), reward: vi.fn() };
    const mw = makeLimiterMiddleware(down as any, { name: 'general', limit: 100, keyFn: () => 'user-1' });
    const next = vi.fn();
    await mw({ originalUrl: '/api/customers' } as any, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(reportSecuritySignal).toHaveBeenCalledWith(
      'rate_limiter_failing_open',
      expect.objectContaining({ limiter: 'general' }),
    );
  });

  it('exempt request: next() called, consume NOT called', async () => {
    const limiter = makeFakeLimiter();
    const mw = makeLimiterMiddleware(limiter as any, {
      name: 'test',
      limit: 100,
      keyFn: () => 'k',
      exemptFn: isExempt,
    });
    const next = vi.fn();

    for (const url of ['/api/webhooks/stripe', '/api/test/cleanup', '/health']) {
      next.mockClear();
      const res = makeRes();
      await mw(makeReq({ originalUrl: url }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it('refundOnSuccess: rewards the key on finish when statusCode < 400', async () => {
    const limiter = makeFakeLimiter();
    limiter.consume.mockResolvedValue({ remainingPoints: 99, msBeforeNext: 1000, consumedPoints: 1 });
    const mw = makeLimiterMiddleware(limiter as any, {
      name: 'test',
      limit: 100,
      keyFn: () => 'k',
      refundOnSuccess: true,
    });
    const res = makeRes();
    await mw(makeReq(), res, vi.fn());

    res.statusCode = 200;
    res.triggerFinish();
    expect(limiter.reward).toHaveBeenCalledWith('k');
  });

  it('refundOnSuccess: does NOT reward when statusCode >= 400', async () => {
    const limiter = makeFakeLimiter();
    limiter.consume.mockResolvedValue({ remainingPoints: 99, msBeforeNext: 1000, consumedPoints: 1 });
    const mw = makeLimiterMiddleware(limiter as any, {
      name: 'test',
      limit: 100,
      keyFn: () => 'k',
      refundOnSuccess: true,
    });
    const res = makeRes();
    await mw(makeReq(), res, vi.fn());

    res.statusCode = 500;
    res.triggerFinish();
    expect(limiter.reward).not.toHaveBeenCalled();
  });
});

// ─── isExempt ────────────────────────────────────────────────────────────────

describe('isExempt', () => {
  it('returns true for webhook, test, and health paths (incl. query strings)', () => {
    expect(isExempt(makeReq({ originalUrl: '/api/webhooks/stripe' }))).toBe(true);
    expect(isExempt(makeReq({ originalUrl: '/api/test/cleanup' }))).toBe(true);
    expect(isExempt(makeReq({ originalUrl: '/health' }))).toBe(true);
    expect(isExempt(makeReq({ originalUrl: '/health?foo=bar' }))).toBe(true);
  });

  it('returns false for ordinary API paths', () => {
    expect(isExempt(makeReq({ originalUrl: '/api/customers' }))).toBe(false);
    expect(isExempt(makeReq({ originalUrl: '/api/invoices/x' }))).toBe(false);
  });
});

// ─── decodeSupabaseSub ───────────────────────────────────────────────────────

describe('decodeSupabaseSub', () => {
  it('returns the sub claim for a Bearer token carrying one', () => {
    // header.payload.signature — payload base64url-encodes {"sub":"user-123"}
    const payload = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    expect(decodeSupabaseSub(req)).toBe('user-123');
  });

  it('returns null for a missing or garbage Authorization header', () => {
    expect(decodeSupabaseSub(makeReq({ headers: {} }))).toBeNull();
    expect(decodeSupabaseSub(makeReq({ headers: { authorization: 'Bearer not-a-jwt' } }))).toBeNull();
  });
});

// ─── key helpers ─────────────────────────────────────────────────────────────

describe('clientIp / rateLimitKey', () => {
  it('clientIp falls back to "unknown" when getClientIp returns null', () => {
    (getClientIp as any).mockReturnValue(null);
    expect(clientIp(makeReq())).toBe('unknown');
  });

  it('rateLimitKey prefers req.user.id over token sub over IP', () => {
    expect(rateLimitKey(makeReq({ user: { id: 'u-1' } }))).toBe('u-1');
  });

  it('rateLimitKey falls back to the IP when no user and no token', () => {
    expect(rateLimitKey(makeReq())).toBe('203.0.113.7');
  });
});

// ─── authLimiterImpl (dual bucket) ───────────────────────────────────────────

describe('authLimiterImpl (dual bucket)', () => {
  it('under limit: both buckets ok → next() + finish-refund registered', async () => {
    const emailRL = makeFakeLimiter();
    const ipRL = makeFakeLimiter();
    emailRL.consume.mockResolvedValue({ remainingPoints: 4, msBeforeNext: 1000, consumedPoints: 1 });
    ipRL.consume.mockResolvedValue({ remainingPoints: 29, msBeforeNext: 1000, consumedPoints: 1 });

    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const req = makeReq({ body: { email: 'Test@Example.com' } });
    const res = makeRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
    // finish-refund registered
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    res.statusCode = 200;
    res.triggerFinish();
    expect(emailRL.reward).toHaveBeenCalled();
    expect(ipRL.reward).toHaveBeenCalled();
  });

  it('one bucket over: returns 429, next NOT called', async () => {
    const emailRL = makeFakeLimiter();
    const ipRL = makeFakeLimiter();
    emailRL.consume.mockRejectedValue(new RateLimiterRes(0, 60000, 5, false));
    ipRL.consume.mockResolvedValue({ remainingPoints: 29, msBeforeNext: 1000, consumedPoints: 1 });

    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const res = makeRes();
    const next = vi.fn();

    await mw(makeReq({ body: { email: 'a@b.com' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.body).toEqual({ error: 'Too many requests', retryAfter: 60 });
  });

  it('email bucket over: logs a warn tagged breached=email, keyed by IP+email', async () => {
    const emailRL = makeFakeLimiter();
    const ipRL = makeFakeLimiter();
    emailRL.consume.mockRejectedValue(new RateLimiterRes(0, 60000, 5, false));
    ipRL.consume.mockResolvedValue({ remainingPoints: 29, msBeforeNext: 1000, consumedPoints: 1 });

    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const res = makeRes();

    await mw(makeReq({ originalUrl: '/api/auth/login', body: { email: 'Victim@Example.com' } }), res, vi.fn());

    expect(logger.warn).toHaveBeenCalledWith(
      'rate limit exceeded',
      expect.objectContaining({
        limiter: 'auth',
        key: '203.0.113.7|victim@example.com',
        route: '/api/auth/login',
        retryAfter: 60,
        breached: 'email',
      }),
    );
  });

  it('ip bucket over: logs a warn tagged breached=ip (spray-across-accounts signal)', async () => {
    const emailRL = makeFakeLimiter();
    const ipRL = makeFakeLimiter();
    emailRL.consume.mockResolvedValue({ remainingPoints: 4, msBeforeNext: 1000, consumedPoints: 1 });
    ipRL.consume.mockRejectedValue(new RateLimiterRes(0, 60000, 30, false));

    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const res = makeRes();

    await mw(makeReq({ originalUrl: '/api/auth/login', body: { email: 'another@example.com' } }), res, vi.fn());

    expect(logger.warn).toHaveBeenCalledWith(
      'rate limit exceeded',
      expect.objectContaining({ limiter: 'auth', breached: 'ip' }),
    );
  });

  it('redis down on a bucket (plain Error): fails OPEN → next() + warn', async () => {
    const emailRL = makeFakeLimiter();
    const ipRL = makeFakeLimiter();
    emailRL.consume.mockRejectedValue(new Error('redis down'));
    ipRL.consume.mockResolvedValue({ remainingPoints: 29, msBeforeNext: 1000, consumedPoints: 1 });

    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const res = makeRes();
    const next = vi.fn();

    await mw(makeReq({ body: { email: 'a@b.com' } }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('ip bucket over → emits credential_spray tagged with breached', async () => {
    __resetWarnThrottle();
    const emailRL = { consume: vi.fn().mockResolvedValue(new RateLimiterRes(4, 0, 1)), reward: vi.fn() };
    const ipRL = { consume: vi.fn().mockRejectedValue(new RateLimiterRes(0, 900_000, 30)), reward: vi.fn() };
    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const req: any = { body: { email: 'victim@example.com' }, originalUrl: '/api/auth/login' };
    await mw(req, makeRes(), vi.fn());
    expect(reportSecuritySignal).toHaveBeenCalledWith(
      'credential_spray',
      expect.objectContaining({ breached: 'ip', route: '/api/auth/login' }),
    );
  });

  it('email bucket over only → does NOT emit credential_spray (single-account, not spray)', async () => {
    __resetWarnThrottle();
    const emailRL = { consume: vi.fn().mockRejectedValue(new RateLimiterRes(0, 900_000, 5)), reward: vi.fn() };
    const ipRL = { consume: vi.fn().mockResolvedValue(new RateLimiterRes(20, 0, 1)), reward: vi.fn() };
    const mw = authLimiterImpl(emailRL as any, ipRL as any);
    const req: any = { body: { email: 'target@example.com' }, originalUrl: '/api/auth/login' };
    await mw(req, makeRes(), vi.fn());
    expect(reportSecuritySignal).not.toHaveBeenCalledWith('credential_spray', expect.anything());
  });

  it('redis down (both buckets error) → emits rate_limiter_failing_open once (throttled)', async () => {
    __resetWarnThrottle();
    const down = { consume: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), reward: vi.fn() };
    const mw = authLimiterImpl(down as any, down as any);
    const req: any = { body: { email: 'a@b.com' }, originalUrl: '/api/auth/login' };
    const next1 = vi.fn();
    await mw(req, makeRes(), next1);
    expect(next1).toHaveBeenCalled(); // fail-open
    expect(reportSecuritySignal).toHaveBeenCalledWith(
      'rate_limiter_failing_open',
      expect.objectContaining({ limiter: 'auth' }),
    );
    // Second call within the 30s throttle window → no second signal.
    (reportSecuritySignal as any).mockClear();
    await mw(req, makeRes(), vi.fn());
    expect(reportSecuritySignal).not.toHaveBeenCalled();
  });
});
