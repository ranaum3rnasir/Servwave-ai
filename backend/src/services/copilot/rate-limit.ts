/**
 * Per-user/org token-bucket rate limiter for the copilot ("Servy").
 *
 * Pure + injectable-clock so it can be unit-tested without timers. A bucket
 * starts full (capacity), refills linearly at `refillPerMin`, and each call to
 * tryConsume() spends one token. When empty, the caller is told how long until
 * the next token is available. State is in-memory (per process) — adequate for
 * the single-active-session model; a distributed limiter is out of scope (v1).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  tryConsume(key: string, now?: number): RateLimitResult;
  /** Test/maintenance helper — wipe all buckets. */
  reset(): void;
}

interface Bucket {
  tokens: number;
  last: number;
}

export function createRateLimiter(opts: { capacity: number; refillPerMin: number }): RateLimiter {
  const capacity = Math.max(1, opts.capacity);
  const refillPerMs = Math.max(opts.refillPerMin, 0) / 60_000;
  const buckets = new Map<string, Bucket>();

  return {
    tryConsume(key: string, now: number = Date.now()): RateLimitResult {
      const bucket = buckets.get(key) ?? { tokens: capacity, last: now };
      const elapsed = Math.max(0, now - bucket.last);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.last = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        buckets.set(key, bucket);
        return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
      }

      buckets.set(key, bucket);
      const deficit = 1 - bucket.tokens;
      const retryAfterMs = refillPerMs > 0 ? Math.ceil(deficit / refillPerMs) : Number.POSITIVE_INFINITY;
      return { allowed: false, remaining: 0, retryAfterMs };
    },
    reset() {
      buckets.clear();
    },
  };
}

export function rateKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

// Shared singleton, configured from env. Imported lazily inside the function so
// tests that mock ../config/env still pick up the mocked values.
import { env } from '../../config/env';

export const copilotRateLimiter: RateLimiter = createRateLimiter({
  capacity: env.COPILOT_RATELIMIT_CAPACITY ?? 30,
  refillPerMin: env.COPILOT_RATELIMIT_REFILL_PER_MIN ?? 15,
});
