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
 * has no query string (cheap + preserves exact formatting) - EXCEPT an inbound
 * webhook URL, which is reduced to its route shape whatever it carries (below).
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
 * INBOUND VENDOR WEBHOOKS LOG THEIR ROUTE SHAPE ONLY (#3446).
 *
 * The key-name list above cannot protect these routes, for two reasons:
 *  - their credential is a PATH segment (`/call-tracking/:provider/:urlToken`,
 *    `/web-form/:provider/:urlToken`), and for the website-form receiver that
 *    token is the only gate there is;
 *  - the vendor decides the query keys. The call-tracking vendor repeats the
 *    whole call in the query string (caller name, number, a recording link
 *    carrying its own access key), under names no key list would anticipate.
 *
 * So the rule is generic rather than another list: under `/api/webhooks`, every
 * path segment that is not a plain lowercase word (letters, `-`, `_`; route
 * words like `call-tracking`, `callrail`, `pre`) is masked, and any query string
 * is dropped whole. What survives is receiver, provider and phase - enough to
 * debug with, and nothing that authenticates or identifies anyone.
 */
const WEBHOOK_URL = /^((?:[a-z][a-z\d+.-]*:\/\/[^/?#\s]*)?\/api\/webhooks)(?=[/?#]|$)([^?#]*)(\?[^#]*)?/i;
/**
 * The same route anywhere inside a longer text: "POST /api/webhooks/…", an address quoted in an error
 * message. The path runs to the next space, `?` or `#`, and the query to the next space: a raw request
 * URL can hold a quote, `<`, `>` or a backtick (a caller named O'Brien), so stopping at one would leave
 * the rest of the query in the text. Each part is one character class after a fixed word, so the time
 * grows in step with the text and no input can exhaust the stack (lib/sentry-scrub.ts scrubText, #3390).
 */
const WEBHOOK_URL_IN_TEXT = /(\/api\/webhooks)(?=[/?#\s"'<>`]|$)(\/[^\s?#]*)?(\?\S*)?/gi;
const WEBHOOK_ROUTE_IN_TEXT = /\/api\/webhooks(?=[/?#\s"'<>`]|$)/i;
/**
 * A segment kept as written: a lowercase route word (`call-tracking`, `callrail`, `pre`), or a route
 * parameter's NAME (`:urlToken`, in a transaction name such as "POST /api/webhooks/web-form/:provider/:urlToken").
 * A URL token is never either: it is a long random string with digits and capitals.
 */
const ROUTE_WORD = /^(?:[a-z][a-z_-]{0,31}|:[A-Za-z][A-Za-z\d_]{0,31})$/;

/** True for a URL (a path, or absolute) on an inbound vendor webhook route. */
export function isWebhookUrl(rawUrl: string): boolean {
  return WEBHOOK_URL.test(rawUrl);
}

/**
 * True when a webhook address appears anywhere in `text`. For deciding what else to drop: the start of a
 * URL the error reporter rebuilds from request headers is the sender's to choose (`https,http://…`), so
 * an anchored test could be steered past.
 */
export function mentionsWebhookUrl(text: string): boolean {
  return WEBHOOK_ROUTE_IN_TEXT.test(text);
}

/** The path after `/api/webhooks` with every non-route segment masked, then the query dropped whole. */
function routeShape(rest: string | undefined, query: string | undefined): string {
  const path = (rest ?? '')
    .split('/')
    .map((segment) => (segment === '' || ROUTE_WORD.test(segment) ? segment : REDACTED))
    .join('/');
  // A lone "?" is an optional route parameter's mark (":phase?"), not a query: kept.
  return `${path}${query === undefined ? '' : query.length > 1 ? `?${REDACTED}` : query}`;
}

function redactWebhookUrl(rawUrl: string): string | null {
  const m = WEBHOOK_URL.exec(rawUrl);
  if (!m) return null;
  const [, prefix, rest, query] = m;
  return `${prefix}${routeShape(rest, query)}`;
}

/**
 * `text` with every inbound webhook address in it reduced to its route shape, wherever it sits in the text.
 * For the error reporter, which cleans every string of an event, not only fields that hold one URL.
 */
export function redactWebhookUrlsIn(text: string): string {
  return text.replace(
    WEBHOOK_URL_IN_TEXT,
    (_whole: string, prefix: string, rest: string | undefined, query: string | undefined) =>
      `${prefix}${routeShape(rest, query)}`,
  );
}

/**
 * Return `rawUrl` with the value of every sensitive query param replaced by
 * `REDACTED`, and an inbound webhook URL reduced to its route shape (above).
 * Any other URL without a query string is returned untouched.
 */
export function redactUrl(rawUrl: string): string {
  const webhook = redactWebhookUrl(rawUrl);
  if (webhook !== null) return webhook;

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
