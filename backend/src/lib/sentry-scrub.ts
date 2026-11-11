import { isSensitiveKey, isWebhookUrl, redactUrl } from './log-redact';

/**
 * Strip credentials from an error report before the SDK sends it (instrument.ts beforeSend,
 * beforeSendTransaction and beforeBreadcrumb).
 *
 * The backend reports with request data and stack-frame local variables turned on, so without this
 * a throw in the password reset path would ship the reset token and the new password (password
 * reset spec §5.2: the token is never logged). It removes:
 *  - every value under a sensitive key (token, password, secret, code, any `*_otp`, action_link,
 *    any `*_key` or `…Key`, ...) in frame locals and in the request body, at any depth;
 *  - every local of a frame in the password code itself, whatever the variable is called;
 *  - the value of every sensitive query parameter in a URL-valued string in any frame's locals, so
 *    a link held by a vendor SDK frame (a recovery `action_link`, a `?token=` URL) is masked too;
 *  - the value of every sensitive query parameter in request and breadcrumb URLs.
 *
 * Imports nothing heavy: it loads with instrument.ts, before the app. Never throws; on any failure
 * the original event is returned rather than lost.
 */

const FILTERED = '[Filtered]';
/** Frames whose locals are dropped wholesale: they handle passwords and reset tokens directly. */
const PASSWORD_CODE = /password-reset|auth-provider-errors|controllers[\\/](auth|user)\.controller/;
const PASSWORD_ROUTE = /\/password\b|\/auth\//;

/**
 * Keys the log redactor does not cover but an error report must: one-time codes under any name
 * (`email_otp`, `otp_code`) and the provider's ready-made sign-in link (`action_link`).
 */
const REPORT_ONLY_KEY = /(^|_)otp($|_)|^action_link$/i;
/**
 * A field named as a key, `signing_key`, `PRIVATE_KEY` or `signingKey`: a vendor's signing key held in a
 * frame local (a webhook integration row, #3446). A bare `key` is sensitive already. The camel form needs
 * the capital K, so a word that merely ends in "key" is not taken for one.
 */
const NAMED_KEY = /_key$/i;
const CAMEL_KEY = /[a-z\d]Key$/;
const isSecretKey = (key: string) =>
  isSensitiveKey(key) || REPORT_ONLY_KEY.test(key) || NAMED_KEY.test(key) || CAMEL_KEY.test(key);
/** A whole string that is a URL (absolute, or a path) with a query string. */
const URL_WITH_QUERY = /^(?:[a-z][a-z\d+.-]*:\/\/|\/)[^\s?]*\?\S*$/i;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Replace the value under every sensitive key, at any depth. With `urls`, also mask sensitive query
 * parameters in every string that is a URL (used for frame locals).
 */
function redactDeep(value: unknown, depth = 0, urls = false): unknown {
  if (depth > 8) return value;
  if (urls && typeof value === 'string') return URL_WITH_QUERY.test(value) ? redactUrl(value) : value;
  if (Array.isArray(value)) {
    const mapped = value.map((v) => redactDeep(v, depth + 1, urls));
    return mapped.some((v, i) => v !== value[i]) ? mapped : value;
  }
  if (!isBag(value)) return value;
  let out: Bag | null = null;
  for (const [key, v] of Object.entries(value)) {
    const next = isSecretKey(key) ? FILTERED : redactDeep(v, depth + 1, urls);
    if (next !== v) (out ??= { ...value })[key] = next;
  }
  return out ?? value;
}

function scrubBody(data: unknown, url: string): unknown {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      const scrubbed = redactDeep(parsed);
      return scrubbed === parsed ? data : JSON.stringify(scrubbed);
    } catch {
      return PASSWORD_ROUTE.test(url) ? FILTERED : data;
    }
  }
  return redactDeep(data);
}

function scrubUrlField(v: unknown): unknown {
  if (Array.isArray(v)) {
    // A query string as [key, value] pairs.
    const mapped = v.map((p) => (Array.isArray(p) && isSecretKey(String(p[0])) ? [p[0], FILTERED] : p));
    return mapped.some((p, i) => p !== v[i]) ? mapped : v;
  }
  if (isBag(v)) return redactDeep(v);
  if (typeof v !== 'string') return v;
  // A webhook URL carries its credential in the PATH, so it is reduced even with no query string.
  if (v.includes('?') || isWebhookUrl(v)) return redactUrl(v);
  // A bare query string ("token=...&x=1").
  if (/^[^\s/?]*=/.test(v)) {
    const redacted = redactUrl(`?${v}`).slice(1);
    return redacted === v ? v : redacted;
  }
  return v;
}

function scrubFrame(frame: unknown): unknown {
  if (!isBag(frame) || frame.vars === undefined) return frame;
  const filename = typeof frame.filename === 'string' ? frame.filename : '';
  const vars = PASSWORD_CODE.test(filename) ? FILTERED : redactDeep(frame.vars, 0, true);
  return vars === frame.vars ? frame : { ...frame, vars };
}

function scrubException(exception: unknown): unknown {
  if (!isBag(exception) || !Array.isArray(exception.values)) return exception;
  const values = exception.values.map((value: unknown) => {
    if (!isBag(value) || !isBag(value.stacktrace) || !Array.isArray(value.stacktrace.frames)) return value;
    const frames = value.stacktrace.frames.map(scrubFrame);
    if (frames.every((f, i) => f === (value.stacktrace as Bag & { frames: unknown[] }).frames[i])) return value;
    return { ...value, stacktrace: { ...value.stacktrace, frames } };
  });
  return values.some((v, i) => v !== (exception.values as unknown[])[i]) ? { ...exception, values } : exception;
}

/** A shallow copy of `obj` with `key` set, or `obj` itself when nothing changes. */
function withField(obj: Bag, key: string, value: unknown): Bag {
  return value === obj[key] ? obj : { ...obj, [key]: value };
}

function scrubRequest(request: unknown): unknown {
  if (!isBag(request)) return request;
  const url = typeof request.url === 'string' ? request.url : '';
  let out = request;
  if ('url' in request) out = withField(out, 'url', scrubUrlField(request.url));
  if ('query_string' in request) {
    // On an inbound webhook the vendor chooses the query keys (a caller's name and number among
    // them), so no key list can clean it: drop it whole, as the request logger does (#3446).
    const query = isWebhookUrl(url) && request.query_string ? FILTERED : scrubUrlField(request.query_string);
    out = withField(out, 'query_string', query);
  }
  if ('data' in request) out = withField(out, 'data', scrubBody(request.data, url));
  if ('cookies' in request) out = withField(out, 'cookies', redactDeep(request.cookies));
  return out;
}

function scrubBreadcrumb(crumb: unknown): unknown {
  if (!isBag(crumb)) return crumb;
  let out = crumb;
  if ('message' in crumb) out = withField(out, 'message', scrubUrlField(crumb.message));
  if (isBag(crumb.data)) {
    let data = redactDeep(crumb.data) as Bag;
    if ('url' in data) data = withField(data, 'url', scrubUrlField(data.url));
    out = withField(out, 'data', data);
  }
  return out;
}

/** An OpenTelemetry-style attribute that holds a bare query string (`url.query`, `http.query`). */
const QUERY_ATTRIBUTE = /(^|\.)query$/i;
/** "POST /api/webhooks/…": a span description or transaction name that is a method plus a URL. */
const METHOD_AND_URL = /^([A-Z]+ )(\S+)$/;

/** A string that may be a URL, a bare query string, or "METHOD url": masked like any URL field. */
function scrubLabel(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const m = METHOD_AND_URL.exec(v);
  if (!m) return scrubUrlField(v);
  const url = scrubUrlField(m[2]);
  return url === m[2] ? v : `${m[1]}${url}`;
}

/**
 * The attributes a sampled TRACE carries (`contexts.trace.data`, `contexts.otel`,
 * each `spans[].data`). The server span records the incoming request's URL
 * there under `url.full`, `http.url`, `http.target`, `url.path` and `url.query`
 * - outside `request`, so the request scrub never saw them (#3446, found in
 * review). Every string is masked like a URL field, and when the bag describes
 * an inbound webhook its query attributes are dropped whole: their keys are the
 * vendor's (a caller's name and number among them).
 */
function scrubAttributes(bag: unknown, depth = 0): unknown {
  if (!isBag(bag) || depth > 4) return bag;
  const webhook = Object.values(bag).some((v) => typeof v === 'string' && isWebhookUrl(v));
  let out: Bag | null = null;
  for (const [key, v] of Object.entries(bag)) {
    let next: unknown = v;
    if (typeof v === 'string') next = webhook && QUERY_ATTRIBUTE.test(key) && v ? FILTERED : scrubLabel(v);
    else if (isBag(v)) next = scrubAttributes(v, depth + 1);
    if (next !== v) (out ??= { ...bag })[key] = next;
  }
  return out ?? bag;
}

function scrubSpans(spans: unknown[]): unknown[] {
  const mapped = spans.map((span) => {
    if (!isBag(span)) return span;
    let out = span;
    if ('data' in span) out = withField(out, 'data', scrubAttributes(span.data));
    if ('description' in span) out = withField(out, 'description', scrubLabel(span.description));
    return out;
  });
  return mapped.some((s, i) => s !== spans[i]) ? mapped : spans;
}

export function scrubSentryEvent<T>(event: T): T {
  try {
    if (!isBag(event)) return event;
    let out: Bag = event;
    if ('exception' in out) out = withField(out, 'exception', scrubException(out.exception));
    if ('request' in out) out = withField(out, 'request', scrubRequest(out.request));
    if ('contexts' in out) out = withField(out, 'contexts', scrubAttributes(out.contexts));
    if (Array.isArray(out.spans)) out = withField(out, 'spans', scrubSpans(out.spans));
    if ('transaction' in out) out = withField(out, 'transaction', scrubLabel(out.transaction));
    if (Array.isArray(out.breadcrumbs)) {
      const before = out.breadcrumbs as unknown[];
      const crumbs = before.map(scrubBreadcrumb);
      if (crumbs.some((c, i) => c !== before[i])) out = { ...out, breadcrumbs: crumbs };
    }
    // A breadcrumb handed to beforeBreadcrumb on its own, or an event's top-level message and data.
    out = scrubBreadcrumb(out) as Bag;
    return out as T;
  } catch {
    return event;
  }
}
