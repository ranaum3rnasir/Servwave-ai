import { COMPOSE_PARAMS } from '@/components/contact/contactHrefs';

/**
 * Keeps two kinds of secret address out of error reports. Everything the SDK sends goes through here first.
 *
 * - The Email compose address (V7-07a, C-27). A link that opens the compose window carries the message body in its
 *   address, and the body of a failed bank payment's email can hold the invoice's public pay link.
 * - A `token` parameter (password reset spec §5.2): the reset link (`/reset-password?token=`) and the invite link
 *   (`/accept-invite?token=`) carry a live single-use credential.
 *
 * Each page removes its parameters once it has read them, but the SDK has already seen the address by then
 * (page-load transaction, navigation breadcrumbs, replay URLs).
 *
 * Imports nothing from the SDK, so both entries can share it without weight.
 */

const COMPOSE_MARKER = 'compose';
/** Removed from any address, wherever it appears. */
const TOKEN_PARAM = 'token';

function scrubQuery(query: string): string {
  const params = new URLSearchParams(query);
  const compose = params.has(COMPOSE_MARKER);
  if (!compose && !params.has(TOKEN_PARAM)) return query;
  if (compose) for (const key of COMPOSE_PARAMS) params.delete(key);
  params.delete(TOKEN_PARAM);
  return params.toString();
}

const mayHoldSecret = (url: string) => url.includes(`${COMPOSE_MARKER}=`) || url.includes(`${TOKEN_PARAM}=`);

/** A URL (absolute or relative, optionally after "GET " and the like) with the compose and token parameters removed. */
export function scrubComposeParams(url: string): string {
  if (!mayHoldSecret(url)) return url;
  // A whole query string on its own ("compose=1&to=...", as some span data keys hold it).
  if (!url.includes('?') && /^[^\s/]*=/.test(url)) return scrubQuery(url);
  return url.replace(/\?([^#\s"']*)/g, (_whole, query: string) => {
    const kept = scrubQuery(query);
    return kept ? `?${kept}` : '';
  });
}

/** The fields the SDK puts an address in: events, transactions, spans, breadcrumbs, replay and recording events. */
const URL_KEYS = ['url', 'href', 'from', 'to', 'url.full', 'url.query', 'http.url', 'http.query', 'query_string', 'description', 'message', 'transaction', 'name'] as const;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);

/** The parameter names to drop from one query: the token always, the compose set only on a compose address. */
function secretKeys(isCompose: boolean): readonly string[] {
  return isCompose ? [...COMPOSE_PARAMS, TOKEN_PARAM] : [TOKEN_PARAM];
}

/** A query string given as text, as pairs, or as an object. Anything else is returned untouched. */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubComposeParams(value);
  if (Array.isArray(value)) {
    const keys = value.map((p) => (Array.isArray(p) ? String(p[0]) : null));
    const drop = secretKeys(keys.includes(COMPOSE_MARKER));
    return keys.some((k) => k !== null && drop.includes(k)) ? value.filter((_p, i) => !(keys[i] !== null && drop.includes(keys[i]!))) : value;
  }
  if (isBag(value)) {
    const drop = secretKeys(COMPOSE_MARKER in value);
    return Object.keys(value).some((k) => drop.includes(k))
      ? Object.fromEntries(Object.entries(value).filter(([k]) => !drop.includes(k)))
      : value;
  }
  return value;
}

/**
 * The object with its address fields scrubbed. NEVER writes into the object it was given (the SDK's own objects have
 * getter-only and frozen properties): when something has to change it returns a shallow copy, otherwise the same object.
 */
function fix(obj: unknown): unknown {
  if (!isBag(obj)) return obj;
  let out: Bag | null = null;
  for (const key of URL_KEYS) {
    const before = obj[key];
    if (before === undefined) continue;
    const after = scrubValue(before);
    if (after !== before) (out ??= { ...obj })[key] = after;
  }
  return out ?? obj;
}

/** `fix` for the object and for its `data`. */
function fixWithData(obj: unknown): unknown {
  const top = fix(obj);
  if (!isBag(top)) return top;
  const data = fix(top.data);
  return data === top.data ? top : { ...top, data };
}

function mapChanged(list: unknown, each: (x: unknown) => unknown): unknown {
  if (!Array.isArray(list)) return list;
  const mapped = list.map(each);
  return mapped.some((x, i) => x !== list[i]) ? mapped : list;
}

function scrubPayload(payload: Bag): Bag {
  let out = fixWithData(payload) as Bag;
  const set = (key: string, value: unknown) => {
    if (value !== out[key]) out = { ...out, [key]: value };
  };
  set('request', fix(out.request));
  set('spans', mapChanged(out.spans, fixWithData));
  set('breadcrumbs', mapChanged(out.breadcrumbs, fixWithData));
  set('urls', mapChanged(out.urls, (u) => (typeof u === 'string' ? scrubComposeParams(u) : u)));
  if (isBag(out.contexts) && isBag(out.contexts.trace)) {
    const trace = fixWithData(out.contexts.trace);
    if (trace !== out.contexts.trace) set('contexts', { ...out.contexts, trace });
  }
  // A recording event's breadcrumb (rrweb custom event): data.payload holds the breadcrumb.
  if (isBag(out.data) && isBag(out.data.payload)) {
    const inner = fixWithData(out.data.payload);
    if (inner !== out.data.payload) set('data', { ...out.data, payload: inner });
  }
  return out;
}

/**
 * An event, transaction, breadcrumb, replay event or recording event with the compose parameters removed from every
 * address in it. Reads known fields only and returns a copy when it changes anything. It must never throw or drop what
 * the SDK is sending: on any failure the original payload is returned.
 */
export function scrubEventUrls<T>(payload: T): T {
  try {
    return isBag(payload) ? (scrubPayload(payload) as T) : payload;
  } catch {
    return payload;
  }
}
