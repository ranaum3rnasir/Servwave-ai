/**
 * Redaction helpers for the request logger.
 *
 * The HTTP request logger (morgan) prints the request URL, which can carry
 * single-use secrets in the query string — most notably the invite token on
 * the old `GET /api/auth/invite?token=…` route, plus OAuth codes, OTPs and
 * public-link signatures. Anything written here lands in stdout / Render logs,
 * so the value of any sensitive query param must be masked before it is logged.
 *
 * We mask the VALUE only and keep the key name, so a redacted line is still
 * useful for debugging ("something hit ?token="), and we never touch a URL that
 * has no query string (cheap + preserves exact formatting).
 */

const REDACTED = 'REDACTED';

// Exact key names (lower-cased) that are always sensitive.
const SENSITIVE_EXACT = new Set([
  'pwd',
  'otp',
  'code',
  'sig',
  'signature',
  'auth',
  'authorization',
  'apikey',
  'api_key',
  'key',
  'session',
]);

/** A query-param key is sensitive if it names (or contains) a credential. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('password') ||
    k.includes('passwd') ||
    SENSITIVE_EXACT.has(k)
  );
}

/**
 * Return `rawUrl` with the value of every sensitive query param replaced by
 * `REDACTED`. URLs without a query string are returned untouched.
 */
export function redactUrl(rawUrl: string): string {
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return rawUrl;

  const path = rawUrl.slice(0, qIndex);
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));

  let changed = false;
  for (const key of new Set(params.keys())) {
    if (isSensitiveKey(key)) {
      params.set(key, REDACTED); // set() collapses repeated keys — fine, they're masked
      changed = true;
    }
  }

  if (!changed) return rawUrl;
  return `${path}?${params.toString()}`;
}
