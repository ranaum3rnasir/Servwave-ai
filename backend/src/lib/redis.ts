import Redis from 'ioredis';
import { logger } from './logger';
import { env } from '../config/env';

// Throttled error logger: emit at most one warn every 30 s so a flapping Redis
// connection doesn't flood the log with identical messages.
let lastErrorLogAt = 0;

/**
 * Creates a shared ioredis client for the given URL, or returns null when the
 * URL is falsy/empty (local dev / CI / test — limiters run in passthrough mode).
 *
 * Key options:
 *   enableOfflineQueue: false — commands fail fast (reject) when Redis is
 *     unreachable, so rate-limiters can fail OPEN immediately rather than
 *     hanging behind a queue of buffered commands.
 *   maxRetriesPerRequest: 1  — one retry before the command rejects, keeping
 *     latency predictable under a flapping connection.
 *
 * The 'error' event handler MUST NOT rethrow. ioredis emits 'error' for every
 * connection failure; an unhandled 'error' event crashes the Node process. A
 * Redis outage must never take down the application — we log once per 30 s and
 * let the process continue. Rate-limiters that detect a null/failed client fall
 * back to passthrough mode.
 */
export function createRedisClient(url?: string): Redis | null {
  if (!url) return null;

  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 10_000,
    lazyConnect: false,
  });

  client.on('error', (err: Error) => {
    // Deliberately swallow — rethrow here would propagate to Node's uncaught
    // exception handler and crash the process. Log throttled to avoid log spam.
    const now = Date.now();
    if (now - lastErrorLogAt > 30_000) {
      lastErrorLogAt = now;
      logger.warn('[redis] connection error (rate-limiters will fail open)', {
        message: err.message,
      });
    }
  });

  return client;
}

/**
 * Shared Redis client (singleton).
 *
 * Always null in test environments (NODE_ENV=test) so no real connection is
 * attempted during vitest runs. Also null when REDIS_URL is not configured —
 * rate-limiters detect null and run in passthrough mode.
 */
export const redis: Redis | null =
  env.NODE_ENV === 'test' ? null : createRedisClient(env.REDIS_URL);
