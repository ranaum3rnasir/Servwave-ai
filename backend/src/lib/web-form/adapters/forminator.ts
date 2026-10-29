import { normalizeNAPhone, normalizeEmail } from '../../comms-identity';
import { logger } from '../../logger';
import type { WebFormSubmissionEvent } from '../types';

/**
 * The website form plugin's webhook integration. Behaviour verified against the
 * plugin distribution v1.57.3 (`addons/pro/webhook/`) on 2026-09-18 - there is
 * no published spec, so the source is the specification. Plan:
 * md_files/plans/communication/2026-09-18-web-form-lead-intake.md §2a/§3c.
 *
 * What the wire actually looks like:
 *  - POST, application/json, a FLAT object with no wrapper. Not configurable.
 *  - Field slugs arrive with dashes rewritten to UNDERSCORES: the form builder
 *    shows `name-1`, the webhook sends `name_1`. Keying the map on dashes maps
 *    nothing at all and does it silently, which is why every key below has an
 *    underscore.
 *  - `form_title` and `entry_time` are appended to every delivery.
 *  - Real submissions also carry `referer_url`, `current_url`, `page_id`,
 *    `form_type` and `render_id`. Those five were read from the plugin source
 *    and have NOT yet been observed on the wire, so every field here is
 *    optional and nothing is required to parse.
 *  - File uploads arrive null; spam and drafts never fire; passwords are
 *    stripped. There is nothing to design around attachments.
 *
 * This file is the only place vendor slugs live.
 */

/** The normalised keys a slug may be mapped onto. A `field_map` value outside this set is ignored. */
export const MAPPABLE_KEYS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'message',
  'messageFallback',
  'selection',
  'landingPageUrl',
  'referringUrl',
] as const;

export type MappableKey = (typeof MAPPABLE_KEYS)[number];

/**
 * The default slug -> normalised key map, from the labels the agency's own
 * notification template names (plan §1).
 *
 * `text_1` maps to `messageFallback`, not to `message`: it is only used when
 * `textarea_1` is absent or empty, so a form carrying both does not let the
 * short answer overwrite the long one.
 *
 * `select_1` and `text_1` carry the plugin's DEFAULT labels, so what they
 * actually ask is unknown, and both are POSITIONAL - a second form, or the
 * agency reordering fields on this one, changes what they mean without changing
 * their name. That is what the per-org `field_map` column is for.
 */
export const DEFAULT_FIELD_MAP: Readonly<Record<string, MappableKey>> = {
  name_1: 'firstName',
  name_2: 'lastName',
  phone_1: 'phone',
  email_1: 'email',
  textarea_1: 'message',
  text_1: 'messageFallback',
  select_1: 'selection',
  current_url: 'landingPageUrl',
  referer_url: 'referringUrl',
};

/**
 * Keys the plugin adds by itself. They are unmapped (they still land in
 * `extras`) but they are NOT drift: warning about them would fire the
 * unknown-key alarm on every single submission and make it worthless.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'form_title',
  'entry_time',
  'page_id',
  'form_type',
  'render_id',
]);

/** Keys that may carry the vendor's own entry id once the hidden field exists (plan §4 Q4). */
const SUBMISSION_ID_KEYS = ['entry_id', 'submission_id', 'entry'] as const;

/** Ad-tracking values worth lifting out of `extras` into `trackingParams`. */
const TRACKING_KEY = /^(utm_[a-z0-9_]+|gclid|gbraid|wbraid|fbclid|msclkid)$/i;

type Raw = Record<string, unknown>;

export function isPlainObject(body: unknown): body is Raw {
  return !!body && typeof body === 'object' && !Array.isArray(body);
}

/**
 * How deep `str()` follows nested arrays before refusing the value.
 *
 * THE REAL SHAPES NEED ONE LEVEL. A multi-select checkbox group arrives as a
 * flat array of strings and nothing the plugin sends nests further, so four is
 * already four times the observed maximum - chosen over a tighter
 * "primitives-only" rule so a grouped field from a future vendor still flattens.
 *
 * The cap is a SAFETY bound, not a parsing preference. `str()` runs
 * synchronously inside `parseWebFormSubmission`, which the receiver calls BEFORE
 * it has answered the plugin, so an unbounded recursion here is not a parse
 * error - it is a `RangeError: Maximum call stack size exceeded` thrown ahead of
 * the ack. A ~10KB body nesting an array 5000 deep, far under any body-size
 * limit, reached it; Express 4 does not adopt a rejected promise from an async
 * handler, so the plugin got NO RESPONSE AT ALL until the socket timed out. On a
 * vendor that never retries that is a destroyed submission, which is the one
 * outcome this endpoint exists to prevent.
 *
 * Refusing costs nothing real: a value past the cap is not a form field, and the
 * raw body reaches the ledger either way.
 */
const MAX_VALUE_DEPTH = 4;

/**
 * Cap on the form title, bounded HERE rather than at the write site because it
 * is not only stored: the receiver and the processor both quote it in their log
 * lines, and on this endpoint those lines are the only alarm anyone gets. A
 * 95KB title from a public form floods them. 200 is the ceiling the human paths
 * put on the longest comparable free-text label (`company_name`).
 */
const FORM_TITLE_MAX = 200;

/**
 * Coerce one submitted value to a trimmed string, or null. Most values arrive as
 * strings; a number field arrives as a number, an unfilled field as null or '',
 * and a multi-select as an array. An object (a multi-input field's sub-keys) has
 * no single sensible scalar, so it stays out of the mapped fields and is kept
 * verbatim in `extras` instead.
 *
 * `depth` is internal and bounded - see MAX_VALUE_DEPTH.
 */
function str(v: unknown, depth = 0): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (depth >= MAX_VALUE_DEPTH) return null;
    const parts = v.map((x) => str(x, depth + 1)).filter((x): x is string => x !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/** The `extras` representation: never lose a value, even one `str()` cannot flatten. */
function verbatim(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Layer an org's `field_map` over the default, key by key. The column holds
 * operator-entered JSON, so this is defensive on purpose: a non-object, a
 * non-string value, or a value naming a key we do not have is ignored rather
 * than allowed to break the intake. An explicit null or empty string REMOVES a
 * default mapping, which is how an operator retires a slug whose meaning
 * changed and sends it to `extras` instead.
 */
export function resolveFieldMap(fieldMap: unknown): Record<string, MappableKey> {
  const resolved: Record<string, MappableKey> = { ...DEFAULT_FIELD_MAP };
  if (!isPlainObject(fieldMap)) return resolved;
  const allowed = new Set<string>(MAPPABLE_KEYS);
  for (const [slug, target] of Object.entries(fieldMap)) {
    if (!slug) continue;
    if (target === null || target === '') {
      delete resolved[slug];
      continue;
    }
    if (typeof target !== 'string' || !allowed.has(target)) {
      logger.warn(`[web-form] field_map entry ignored: slug maps to an unknown target key (slug=${slug})`);
      continue;
    }
    resolved[slug] = target as MappableKey;
  }
  return resolved;
}

/**
 * Parse one delivery into the normalised event. Returns null only when the body
 * is not a JSON object at all - every field is optional, so a thin payload
 * still parses and the caller's contact-handle gate decides whether it is worth
 * keeping.
 *
 * Never log a submitted value: names, phone numbers and email addresses are the
 * whole payload. The log lines below name the form and the KEYS only.
 */
export function parseForminator(body: unknown, fieldMap?: unknown): WebFormSubmissionEvent | null {
  if (!isPlainObject(body)) return null;
  const map = resolveFieldMap(fieldMap);

  // OWN KEYS ONLY, everywhere a payload key is looked up below. The payload is
  // attacker-chosen and `JSON.parse` makes `__proto__` an ORDINARY OWN KEY, so
  // every `key in obj` / `obj[key]` here would otherwise resolve through
  // Object.prototype and answer for `constructor`, `toString`, `valueOf`,
  // `hasOwnProperty` and `__proto__` when the payload or the map has no such
  // entry at all.
  const owns = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

  // NULL-PROTOTYPE for the same reason from the other side: on a plain object
  // `extras['__proto__'] = '…'` invokes the inherited setter and stores nothing,
  // so the one key this loop is trying hardest not to lose is the one it would.
  const extras: Record<string, string> = Object.create(null);
  const trackingParams: Record<string, string> = {};
  const unknownKeys: string[] = [];

  // Resolve the mapped fields in MAP order, not payload order: when an override
  // puts two slugs onto one key, the winner must be decided by the map an
  // operator can read rather than by whatever order the plugin serialised the
  // body in. The first slug in the map with a non-empty value wins.
  const mapped: Partial<Record<MappableKey, string | null>> = {};
  for (const [slug, target] of Object.entries(map)) {
    if (mapped[target] != null) continue;
    if (!owns(body, slug)) continue;
    mapped[target] = str(body[slug]);
  }

  for (const [key, value] of Object.entries(body)) {
    if (owns(map, key)) continue;
    extras[key] = verbatim(value);
    if (TRACKING_KEY.test(key)) {
      const v = str(value);
      if (v) trackingParams[key.toLowerCase()] = v;
    }
    if (!ENVELOPE_KEYS.has(key) && !(SUBMISSION_ID_KEYS as readonly string[]).includes(key)) {
      unknownKeys.push(key);
    }
  }

  if (unknownKeys.length) {
    // The drift alarm. The first time the agency adds or reorders a field we
    // would otherwise discover it by its absence. Keys only, never values.
    logger.warn(
      `[web-form] payload carried keys the field map does not know (provider=forminator, form=${
        str(body.form_title) ?? 'unknown'
      }, keys=${unknownKeys.join(',')})`,
    );
  }

  const vendorSubmissionId =
    SUBMISSION_ID_KEYS.map((k) => str(body[k])).find((v): v is string => v !== null) ?? null;

  const rawPhone = mapped.phone ?? null;
  const rawEmail = mapped.email ?? null;

  return {
    provider: 'forminator',
    vendorSubmissionId,
    formTitle: str(body.form_title)?.slice(0, FORM_TITLE_MAX) ?? null,
    firstName: mapped.firstName ?? null,
    lastName: mapped.lastName ?? null,
    // A number that does not normalise is dropped rather than kept raw: the
    // contact-handle gate treats "we have a phone" as "we can call them back",
    // and the raw value survives in the stored payload anyway.
    phone: rawPhone ? normalizeNAPhone(rawPhone) : null,
    email: rawEmail ? normalizeEmail(rawEmail) : null,
    message: mapped.message ?? mapped.messageFallback ?? null,
    selection: mapped.selection ?? null,
    landingPageUrl: mapped.landingPageUrl ?? null,
    referringUrl: mapped.referringUrl ?? null,
    trackingParams,
    // Our own receive time. `entry_time` is site-local with no offset (see
    // types.ts) and stays in `extras` verbatim.
    submittedAt: new Date(),
    extras,
  };
}
