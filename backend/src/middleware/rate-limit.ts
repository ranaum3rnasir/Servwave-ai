import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { redis } from '../lib/redis';
import { getClientIp } from '../lib/audit';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { reportSecuritySignal } from '../lib/security-signal';

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test';

// ─── Key derivation ──────────────────────────────────────────────────────────

/** The client IP, or the sentinel 'unknown' when it cannot be resolved. */
export function clientIp(req: Request): string {
  return getClientIp(req) ?? 'unknown';
}

/**
 * DECODE (never verify) the Supabase JWT to read its `sub` claim. We use it only
 * as a rate-limit bucket key, so a forged token simply lands in its own bucket —
 * verification happens later in `authenticate`. Returns null on any malformed
 * header/token.
 */
export function decodeSupabaseSub(req: Request): string | null {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object' && typeof decoded.sub === 'string') {
      return decoded.sub;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bucket key for an authenticated-API request: prefer the resolved user id, then
 * the token's `sub` (covers the request before `authenticate` runs), then the IP.
 */
export function rateLimitKey(req: Request): string {
  return (req as Request).user?.id ?? decodeSupabaseSub(req) ?? clientIp(req);
}

/** The request path with any query string stripped. */
function routePath(req: Request): string {
  return req.originalUrl.split('?')[0];
}

/**
 * Paths that must never be throttled: Stripe webhooks (many retries), the E2E
 * test doors, and the platform health check.
 */
export function isExempt(req: Request): boolean {
  const p = routePath(req);
  return (
    p.startsWith('/api/webhooks') ||
    p.startsWith('/api/test') ||
    p === '/health'
  );
}

// ─── Response helpers ────────────────────────────────────────────────────────

/** Set the standard X-RateLimit-* headers from an allowed-consume result. */
function setRateLimitHeaders(res: Response, limit: number, rlRes: RateLimiterRes): void {
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, rlRes.remainingPoints));
  res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + rlRes.msBeforeNext) / 1000));
}

/** Context identifying which limiter/bucket blocked a request, for the 429 log line. */
interface BlockContext {
  limiter: string;
  key: string;
  route: string;
  /** Extra fields specific to a limiter (e.g. the auth limiter's breached bucket). */
  extra?: Record<string, unknown>;
}

/**
 * Send the 429 response with Retry-After + X-RateLimit-* headers, and log a
 * structured warning so blocks are searchable/alertable (Render logs) — this is
 * the primary signal for spotting brute-force/scraping/abuse in production.
 */
function send429(res: Response, limit: number, rlRes: RateLimiterRes, ctx: BlockContext): void {
  const retryAfter = Math.max(1, Math.ceil(rlRes.msBeforeNext / 1000));
  res.setHeader('Retry-After', retryAfter);
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', 0);
  res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + rlRes.msBeforeNext) / 1000));
  logger.warn('rate limit exceeded', {
    limiter: ctx.limiter,
    key: ctx.key,
    route: ctx.route,
    retryAfter,
    ...ctx.extra,
  });
  res.status(429).json({ error: 'Too many requests', retryAfter });
}

// Throttled fail-open warning so a flapping Redis doesn't flood the log.
// Returns true iff it emitted this call (i.e. passed the throttle gate).
let lastWarnAt = 0;
function warnThrottled(message: string, err: unknown): boolean {
  const now = Date.now();
  if (now - lastWarnAt > 30_000) {
    lastWarnAt = now;
    logger.warn(message, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
  return false;
}

/** Test-only: reset the fail-open warn throttle so each test observes its warn. */
export function __resetWarnThrottle(): void {
  lastWarnAt = 0;
}

/**
 * A limiter that exposes the slice of rate-limiter-flexible's surface this module
 * uses. Lets the unit tests pass a controllable fake without a real Redis.
 */
interface ConsumableLimiter {
  consume(key: string, points?: number): Promise<RateLimiterRes>;
  reward(key: string, points?: number): Promise<RateLimiterRes>;
}

interface LimiterOptions {
  /** Identifies this limiter in the 429 log line (e.g. 'general', 'expensive'). */
  name: string;
  limit: number;
  keyFn: (req: Request) => string;
  exemptFn?: (req: Request) => boolean;
  refundOnSuccess?: boolean;
}

// ─── Core factory ────────────────────────────────────────────────────────────

/**
 * Build an Express middleware around a single rate limiter.
 *
 * FAIL OPEN: if `consume` rejects with anything other than a RateLimiterRes
 * (i.e. Redis is unreachable and the in-memory insurance limiter also threw),
 * we log once and call next() — a rate-limiter outage must never block real
 * traffic. Only an actual over-limit (RateLimiterRes rejection) yields a 429.
 */
export function makeLimiterMiddleware(limiter: ConsumableLimiter, opts: LimiterOptions) {
  const { name, limit, keyFn, exemptFn, refundOnSuccess } = opts;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (exemptFn?.(req)) {
      next();
      return;
    }
    const key = keyFn(req);
    try {
      const rlRes = await limiter.consume(key);
      setRateLimitHeaders(res, limit, rlRes);
      if (refundOnSuccess) {
        res.on('finish', () => {
          if (res.statusCode < 400) limiter.reward(key).catch(() => {});
        });
      }
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        send429(res, limit, err, { limiter: name, key, route: routePath(req) });
      } else {
        // FAIL OPEN — Redis/insurance error must not block traffic.
        if (warnThrottled('rate limiter unavailable, failing open', err)) {
          reportSecuritySignal('rate_limiter_failing_open', { limiter: name });
        }
        next();
      }
    }
  };
}

// ─── Dual-bucket auth limiter ────────────────────────────────────────────────

/**
 * Build the auth middleware that consumes from BOTH an email-scoped bucket and an
 * IP-scoped bucket. Either bucket tripping yields a 429 (using the larger
 * msBeforeNext); a non-RateLimiterRes rejection fails OPEN. On a fully-allowed
 * request, a successful response (statusCode < 400) refunds both buckets so only
 * failed login attempts actually count against the limit.
 *
 * Exported as a factory taking the two limiters so it is unit-testable without a
 * live Redis (the gated export below wires the real Redis-backed limiters in).
 */
export function authLimiterImpl(emailRL: ConsumableLimiter, ipRL: ConsumableLimiter) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ipKey = clientIp(req);
    const emailKey = `${ipKey}|${(req.body?.email ?? '').toString().toLowerCase().trim()}`;

    const results = await Promise.allSettled([
      emailRL.consume(emailKey),
      ipRL.consume(ipKey),
    ]);

    const rejections = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    if (rejections.length > 0) {
      const overLimit = rejections
        .map((r) => r.reason)
        .filter((reason): reason is RateLimiterRes => reason instanceof RateLimiterRes);

      if (overLimit.length > 0) {
        // Over limit on at least one bucket → 429 using the larger backoff.
        const worst = overLimit.reduce((a, b) => (b.msBeforeNext > a.msBeforeNext ? b : a));
        const emailBreached = results[0].status === 'rejected' && results[0].reason instanceof RateLimiterRes;
        const ipBreached = results[1].status === 'rejected' && results[1].reason instanceof RateLimiterRes;
        // 'email' = one account under attack; 'ip' = one source spraying many accounts.
        const breached = emailBreached && ipBreached ? 'both' : emailBreached ? 'email' : 'ip';
        if (ipBreached) {
          reportSecuritySignal('credential_spray', { breached, route: routePath(req) });
        }
        send429(res, 5, worst, {
          limiter: 'auth',
          key: emailKey,
          route: routePath(req),
          extra: { breached },
        });
        return;
      }

      // A non-RateLimiterRes rejection means Redis is down → FAIL OPEN.
      const err = rejections.find((r) => !(r.reason instanceof RateLimiterRes))?.reason;
      if (warnThrottled('auth rate limiter unavailable, failing open', err)) {
        reportSecuritySignal('rate_limiter_failing_open', { limiter: 'auth' });
      }
      next();
      return;
    }

    // Both buckets allowed → headers from the email bucket + finish-refund.
    const emailRes = (results[0] as PromiseFulfilledResult<RateLimiterRes>).value;
    setRateLimitHeaders(res, 5, emailRes);
    res.on('finish', () => {
      if (res.statusCode < 400) {
        emailRL.reward(emailKey).catch(() => {});
        ipRL.reward(ipKey).catch(() => {});
      }
    });
    next();
  };
}

// ─── Redis-backed limiters (built only when limiting is active) ──────────────

// Limiting is ON only outside tests and when a Redis client exists. Constructing
// a RateLimiterRedis with a null storeClient throws at module load, so every
// `new RateLimiterRedis(...)` stays behind this flag.
const ON = env.NODE_ENV !== 'test' && !!redis;

const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();

let generalLimiterImpl: ReturnType<typeof makeLimiterMiddleware> | typeof passthrough = passthrough;
let expensiveLimiterImpl: ReturnType<typeof makeLimiterMiddleware> | typeof passthrough = passthrough;
let publicReadLimiterImpl: ReturnType<typeof makeLimiterMiddleware> | typeof passthrough = passthrough;
let publicActionLimiterImpl: ReturnType<typeof makeLimiterMiddleware> | typeof passthrough = passthrough;
let publicSelectionLimiterImpl: ReturnType<typeof makeLimiterMiddleware> | typeof passthrough = passthrough;
let authLimiterGated: ReturnType<typeof authLimiterImpl> | typeof passthrough = passthrough;

if (ON) {
  const mk = (keyPrefix: string, points: number, duration: number) =>
    new RateLimiterRedis({
      storeClient: redis!,
      keyPrefix,
      points,
      duration,
      insuranceLimiter: new RateLimiterMemory({ points, duration }),
    });

  const generalRL = mk('rl:general', 100, 60);
  const expensiveRL = mk('rl:expensive', 15, 60);
  const publicReadRL = mk('rl:publicread', 20, 60);
  const publicActionRL = mk('rl:publicaction', 5, 900);
  // #2090 - approve/decline happen ONCE, so 5 per 15 minutes is right for them. Ticking option
  // boxes is a decision session: a customer weighing three add-ons writes on every change and
  // would be locked out mid-decision at that ceiling. 30 is generous for a real session and still
  // bounded for an unauthenticated write door.
  const publicSelectionRL = mk('rl:publicselection', 30, 900);
  const authEmailRL = mk('rl:authemail', 5, 900);
  const authIpRL = mk('rl:authip', 30, 900);

  generalLimiterImpl = makeLimiterMiddleware(generalRL, {
    name: 'general',
    limit: 100,
    keyFn: rateLimitKey,
    exemptFn: isExempt,
  });
  expensiveLimiterImpl = makeLimiterMiddleware(expensiveRL, { name: 'expensive', limit: 15, keyFn: rateLimitKey });
  publicReadLimiterImpl = makeLimiterMiddleware(publicReadRL, { name: 'publicRead', limit: 20, keyFn: clientIp });
  publicActionLimiterImpl = makeLimiterMiddleware(publicActionRL, { name: 'publicAction', limit: 5, keyFn: clientIp });
  publicSelectionLimiterImpl = makeLimiterMiddleware(publicSelectionRL, { name: 'publicSelection', limit: 30, keyFn: clientIp });
  authLimiterGated = authLimiterImpl(authEmailRL, authIpRL);
}

// ─── Public middleware exports ───────────────────────────────────────────────

/** General per-user/IP API limiter — replaces the old express-rate-limit general tier. */
export const generalLimiter = generalLimiterImpl;
/** Tighter limiter for expensive endpoints (PDF render, search, reports). */
export const expensiveLimiter = expensiveLimiterImpl;
/** Per-IP limiter for public read endpoints (token-based public pages). */
export const publicReadLimiter = publicReadLimiterImpl;
/** Per-IP limiter for public action endpoints (approve/decline/checkout). */
export const publicActionLimiter = publicActionLimiterImpl;
/** Per-IP limiter for the public per-tick selection write (#2090) - 30 per 15 minutes. */
export const publicSelectionLimiter = publicSelectionLimiterImpl;
/** Dual-bucket (email + IP) limiter for the auth endpoints. */
export const authLimiter = authLimiterGated;

// ─── Email-bomb guard (unchanged — express-rate-limit) ───────────────────────

// Email-bomb guard for the OTP-sending endpoints (/mfa/resend, /mfa/setup):
// tighter than authLimiter and counts EVERY request (no skipSuccessfulRequests),
// since each success dispatches an email. Per-user caps are also enforced in the
// controller against the DB; this is the IP-level first line of defense.
export const mfaResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 30 : 3,
  skip: () => isTest, // unlimited in test env
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests, please wait a few minutes and try again' },
});
