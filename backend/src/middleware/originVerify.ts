import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../lib/logger';

// Cloudflare injects this header (with the ORIGIN_VERIFY_SECRET value) on every
// request it forwards to the Render origin. Header lookup is case-insensitive.
const HEADER_NAME = 'X-Origin-Verify';

// ─── Exempt path allowlist ───────────────────────────────────────────────────
// Paths whose prefix appears here SKIP the origin check entirely. Add an entry
// whenever a service must reach the backend WITHOUT going through Cloudflare:
//   • /api/webhooks — Stripe (and any future provider) webhooks. The sender is a
//     third party that can't attach our secret header, and these routes are
//     already authenticated by their OWN signature verification. (They are also
//     mounted before this middleware in app.ts, so in practice they never even
//     reach here — this entry is defense-in-depth in case mount order changes.)
//   • /health — Render's platform health check reaches the service INTERNALLY. It
//     does not traverse Cloudflare, so it carries no X-Origin-Verify header and
//     would be 403'd without this exemption.
//     MEASURED 2026-09-24, when this service's onrender.com subdomain was
//     disabled: requests carrying `Host: *.onrender.com` are now rejected at
//     Render's router and never reach Express (their 404 produces a router log
//     line but no app log line), yet the health check kept answering 200 every
//     5s on the same instance with no restart. So it never arrived via the
//     public subdomain, contrary to what this comment used to claim.
// Matching is exact-or-subpath so a lookalike like "/api/webhooks-fake" is NOT
// accidentally exempted.
const EXEMPT_PREFIXES = ['/api/webhooks', '/health'];

// Latch so a missing secret logs ONCE per process instead of on every request
// (which would flood the logs). The condition surfaces at the first request
// after boot, which is when you'd notice it anyway.
let warnedMissingSecret = false;

function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

// Constant-time string compare. We hash both sides to a fixed 32-byte SHA-256
// digest before calling crypto.timingSafeEqual for two reasons:
//   1. timingSafeEqual throws a RangeError on buffers of differing length, so a
//      raw compare of attacker-controlled input would 500 (or need a non-constant
//      early length check); hashing makes both inputs always 32 bytes.
//   2. It avoids leaking the secret's length through timing or an early return.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * Rejects traffic that did not arrive via Cloudflare.
 *
 * Cloudflare attaches a secret X-Origin-Verify header on every forwarded
 * request; a request that hits the Render origin directly (bypassing Cloudflare)
 * won't have it and is answered with 403. Webhook and health-check paths are
 * exempt (see EXEMPT_PREFIXES).
 *
 * FAIL-OPEN by design: if ORIGIN_VERIFY_SECRET is not configured, the check is
 * skipped (with a loud warning) rather than 403-ing all traffic. This is a
 * deliberate safety valve so a missing or mistyped env var can't lock the entire
 * API out. The trade-off is that origin verification is INACTIVE until the secret
 * is set — which is why the warning exists.
 */
export function originVerify(req: Request, res: Response, next: NextFunction) {
  if (isExempt(req.path)) {
    return next();
  }

  const expected = process.env.ORIGIN_VERIFY_SECRET;

  // Fail-open guard (see doc comment above): no secret configured → allow through.
  if (!expected) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn(
        '[originVerify] ORIGIN_VERIFY_SECRET is not set — origin verification is DISABLED (fail-open). ' +
          'Traffic bypassing Cloudflare is currently ACCEPTED. Set ORIGIN_VERIFY_SECRET to enforce it.'
      );
    }
    return next();
  }

  const provided = req.header(HEADER_NAME);
  if (typeof provided === 'string' && timingSafeEqualStr(provided, expected)) {
    return next();
  }

  res.status(403).json({ error: 'Forbidden' });
}
