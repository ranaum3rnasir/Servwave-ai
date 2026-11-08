/**
 * Keeps the phone vendor's name out of the browser console.
 *
 * The CTM phone script (`ctm-phone-embed-1.0.js`, injected at runtime by ctmSoftphone.ts)
 * runs in OUR document, so its console.* calls go through this page's `console`. Several of
 * them print "[CTM Embed] ..." and one prints "attach ctm-phone-skeleton", which puts the
 * vendor's name in front of anyone who opens developer tools. Vendor names may appear in
 * backend logs only, never in anything an end user can reach, and dev tools count.
 *
 * Importing this module installs the filter on the global console. It is imported in
 * src/main.tsx straight after ./instrument (Sentry), so:
 *   - it is in place long before ctmSoftphone.ts injects the vendor script;
 *   - it wraps Sentry's console wrapper, so a dropped line never becomes a Sentry
 *     breadcrumb either, and a renamed error reaches Sentry already renamed.
 *
 * Treatment, by the first argument only and only when it is a string:
 *   - starts with a vendor prefix, on log/info/debug/warn  -> dropped;
 *   - exactly one of the `exact` lines, on any method       -> dropped;
 *   - starts with a vendor prefix, on error                 -> the prefix becomes "[Phone]",
 *     vendor tokens in the rest of the message are redacted, and every other argument is
 *     forwarded as a SANITISED COPY (see sanitizeConsoleArg), so a real phone failure stays
 *     diagnosable without the vendor's name;
 *   - anything else                                         -> forwarded untouched, same
 *     arguments, same order, same `this`.
 *
 * Measured 2026-10-01 against the vendor script (67,219 bytes): the four "[CTM Embed]"
 * console.log lines and "attach ctm-phone-skeleton" are dropped; "[CTM Embed] access
 * request failed" and "[CTM Embed] device embed script failed" are renamed. Its other lines
 * ("No access URL provided", "received paste:", "valHook set:") carry no vendor name and
 * pass through. The vendor can change its script at any time; a new prefix is a one-line
 * change to VENDOR_CONSOLE_PATTERNS.
 *
 * Part 2 (Ran, 2026-10-02): the renamed errors' extra arguments named the vendor too. The
 * script calls console.error("[CTM Embed] access request failed", {url: this.access, error})
 * with whatever fetch() threw - a TypeError whose stack reads "at CtmPhoneEmbed.fetchUserAccess
 * (https://app.calltrackingmetrics.com/...)" - and console.error("[CTM Embed] device embed
 * script failed", event) with the script element's error Event, whose target is the vendor's
 * <script data-ctm-device-embed-script> element. Expanding either in dev tools showed the
 * name. On the renamed path only, those arguments are now sanitised copies.
 *
 * Out of reach from here: the vendor's own cross-origin frame logs to its own console
 * context, and the element tag names and network calls stay visible in dev tools.
 */

import { PHONE_VENDOR_LONG, PHONE_VENDOR_SHORT } from './vendorName';

// The filter has to MATCH the vendor's lines, but written as plain literals the
// patterns below would ship the very name they hide: anyone reading the bundle
// would find "[CTM Embed]" in our own code. So they are assembled at runtime from
// vendorName.ts (character codes, which the minifier cannot fold back into a
// literal). They still equal the vendor's strings exactly: "[CTM Embed]",
// "attach ctm-phone-skeleton", and the token pattern /calltracking(?:metrics)?|ctm/gi.
const VENDOR_UPPER = PHONE_VENDOR_SHORT.toUpperCase();

/** The single list of vendor console lines the filter acts on. */
export const VENDOR_CONSOLE_PATTERNS = {
  /** A message starting with one of these is the vendor's: dropped, or renamed on error. */
  prefixes: [`[${VENDOR_UPPER} Embed]`],
  /** Whole messages dropped outright. */
  exact: [`attach ${PHONE_VENDOR_SHORT}-phone-skeleton`],
  /** What a vendor prefix becomes on console.error. */
  errorPrefixReplacement: '[Phone]',
  /**
   * The vendor's name, wherever it appears inside a renamed error: every match in its message
   * or in any string reachable from its other arguments becomes `tokenReplacement`. Global and
   * case-insensitive; use it with String.prototype.replace (which resets lastIndex), not .test.
   */
  vendorTokens: new RegExp(`${PHONE_VENDOR_LONG}(?:metrics)?|${PHONE_VENDOR_SHORT}`, 'gi'),
  /** What a vendor token becomes. */
  tokenReplacement: '[redacted]',
} as const;

const FILTERED_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;
type FilteredMethod = (typeof FILTERED_METHODS)[number];
type ConsoleFn = (...args: unknown[]) => void;

// Stored on the console object itself, so the guard survives a re-evaluated module (Vite hot
// reload) as well as a repeated call. Symbol.for is shared across module instances.
const INSTALLED = Symbol.for('servwave.vendorConsoleFilter.installed');

function vendorPrefixOf(message: string): string | undefined {
  return VENDOR_CONSOLE_PATTERNS.prefixes.find((prefix) => message.startsWith(prefix));
}

function redact(text: string): string {
  return text.replace(VENDOR_CONSOLE_PATTERNS.vendorTokens, VENDOR_CONSOLE_PATTERNS.tokenReplacement);
}

/** Plain objects and arrays deeper than this become MAX_DEPTH_MARKER. */
const MAX_DEPTH = 3;
const MAX_DEPTH_MARKER = '[…]';
const CIRCULAR_MARKER = '[circular]';
const UNAVAILABLE_MARKER = '[unavailable]';
const ELEMENT_MARKER = '[element]';
const OPAQUE_MARKER = '[object]';

// Duck-typed as well as instanceof, so a value from another realm (an iframe's Event, Node or
// Error, which fails this realm's instanceof) is still recognised.
function isEvent(value: object): value is Event {
  if (typeof Event === 'function' && value instanceof Event) return true;
  const v = value as Partial<Event>;
  if (typeof v.type !== 'string') return false;
  // A real Event from another realm carries the Event methods on its prototype; an
  // Event-shaped snapshot carries the targets and isTrusted as data.
  const hasEventMethods =
    typeof v.preventDefault === 'function' && typeof v.stopPropagation === 'function';
  const hasEventFields = 'currentTarget' in v && 'isTrusted' in v;
  return hasEventMethods || hasEventFields;
}

function isNode(value: object): boolean {
  if (typeof Node === 'function' && value instanceof Node) return true;
  const v = value as Partial<Node>;
  return typeof v.nodeType === 'number' && typeof v.nodeName === 'string';
}

function isErrorLike(value: object): value is { message: unknown; name?: unknown } {
  if (value instanceof Error || Object.prototype.toString.call(value) === '[object Error]') return true;
  return typeof (value as { message?: unknown }).message === 'string' && ('name' in value || 'stack' in value);
}

/** Object.prototype from this realm or any other: its own prototype is null. */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** A primitive with its strings redacted; `{ ok: false }` when `value` is not a primitive. */
function sanitizePrimitive(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value === 'string') return { ok: true, value: redact(value) };
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return { ok: true, value };
  }
  return { ok: false };
}

/**
 * Sets a key on a copy as plain data. defineProperty, not assignment, so an own "__proto__"
 * key in the source stays a key instead of re-pointing the copy's prototype.
 */
function setKey(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Reads one property, turning a throwing getter into UNAVAILABLE_MARKER. */
function read(source: object, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (source as Record<PropertyKey, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function errorNameAndMessage(value: { message: unknown; name?: unknown }): {
  name: string;
  message: string;
} {
  const name = read(value, 'name');
  const message = read(value, 'message');
  return {
    name: name.ok && typeof name.value === 'string' ? redact(name.value) : 'Error',
    message: message.ok ? redact(String(message.value)) : UNAVAILABLE_MARKER,
  };
}

/** A top-level error argument: { name, message } plus its other own primitive properties. */
function sanitizeErrorLike(value: { message: unknown; name?: unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = errorNameAndMessage(value);
  for (const key of Object.keys(value)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    const field = read(value, key);
    if (!field.ok) continue;
    const primitive = sanitizePrimitive(field.value);
    if (primitive.ok) setKey(out, redact(key), primitive.value);
  }
  return out;
}

/**
 * An error nested inside another argument: one string, "TypeError: Failed to fetch". A
 * nested object would sit at or below Sentry's normalizeDepth (3) in the breadcrumb - data ->
 * arguments -> argument -> error - and be sent as "[Object]", losing the error class that a
 * raw Error kept ("[TypeError]"). A string survives at any depth.
 */
function flattenErrorLike(value: { message: unknown; name?: unknown }): string {
  const { name, message } = errorNameAndMessage(value);
  return message ? `${name}: ${message}` : name;
}

function sanitize(value: unknown, depth: number, ancestors: Set<object>): unknown {
  const primitive = sanitizePrimitive(value);
  if (primitive.ok) return primitive.value;
  if (typeof value !== 'object' || value === null) return OPAQUE_MARKER; // function, symbol
  if (isEvent(value)) return { type: redact(String(value.type)) };
  if (isNode(value)) return ELEMENT_MARKER;
  if (isErrorLike(value)) return depth === 0 ? sanitizeErrorLike(value) : flattenErrorLike(value);

  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return OPAQUE_MARKER; // Map, Set, class instances...
  if (ancestors.has(value)) return CIRCULAR_MARKER;
  if (depth >= MAX_DEPTH) return MAX_DEPTH_MARKER;

  ancestors.add(value);
  try {
    if (isArray) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = read(value, i);
        out.push(item.ok ? sanitize(item.value, depth + 1, ancestors) : UNAVAILABLE_MARKER);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const field = read(value, key);
      setKey(out, redact(key), field.ok ? sanitize(field.value, depth + 1, ancestors) : UNAVAILABLE_MARKER);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * A copy of one extra argument of a renamed vendor error that is safe to print:
 *   - strings: vendor tokens redacted;
 *   - number, boolean, bigint, null, undefined: unchanged;
 *   - an Event: { type } only (no target / currentTarget / srcElement);
 *   - a DOM node: "[element]";
 *   - an Error, or Error-like (message plus name or stack): never the stack. As the argument
 *     itself, { name, message } redacted plus its other own PRIMITIVE properties redacted;
 *     nested inside an object or array, the single string "Name: message" redacted, so it
 *     survives Sentry's breadcrumb normalisation depth;
 *   - a plain object or array: a copy with keys and values sanitised recursively, 3 levels
 *     deep ("[…]" below that), a cycle marked "[circular]";
 *   - anything else (functions, Map, Set, class instances): "[object]".
 * Never throws: a throwing getter becomes "[unavailable]" for that value, and a value that
 * cannot be inspected at all becomes "[unavailable]" - a console call must never break.
 */
function sanitizeConsoleArg(value: unknown): unknown {
  try {
    return sanitize(value, 0, new Set());
  } catch {
    return UNAVAILABLE_MARKER;
  }
}

function wrap(method: FilteredMethod, original: ConsoleFn): ConsoleFn {
  return function filteredConsoleMethod(this: unknown, ...args: unknown[]) {
    const first = args[0];
    if (typeof first === 'string') {
      if ((VENDOR_CONSOLE_PATTERNS.exact as readonly string[]).includes(first)) return;
      const prefix = vendorPrefixOf(first);
      if (prefix !== undefined) {
        if (method !== 'error') return;
        const renamed =
          VENDOR_CONSOLE_PATTERNS.errorPrefixReplacement + redact(first.slice(prefix.length));
        return original.apply(this, [renamed, ...args.slice(1).map(sanitizeConsoleArg)]);
      }
    }
    return original.apply(this, args);
  };
}

/**
 * Wraps console.log/info/debug/warn/error on `target` once. Returns true when it installed,
 * false when `target` was already filtered (a second call never double-wraps).
 */
export function installVendorConsoleFilter(target: Console = console): boolean {
  const marked = target as Console & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return false;
  for (const method of FILTERED_METHODS) {
    const original = target[method] as ConsoleFn | undefined;
    if (typeof original !== 'function') continue;
    target[method] = wrap(method, original);
  }
  Object.defineProperty(marked, INSTALLED, { value: true, enumerable: false });
  return true;
}

installVendorConsoleFilter();
