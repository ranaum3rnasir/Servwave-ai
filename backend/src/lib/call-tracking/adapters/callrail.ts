import { normalizeNAPhone } from '../../comms-identity';
import type { TrackedCallEvent } from '../types';

/**
 * CallRail Webhooks integration, pre_call + post_call.
 *
 * READ THE WIRE, NOT THE API REFERENCE (#3447). The first version of this file
 * read the field names of CallRail's API call record (`id`,
 * `tracking_phone_number`, `start_time`, `landing_page_url`...). The Webhooks
 * integration sends a different, older set, so for weeks every real event was
 * acked and ignored while a fixture built from the API reference kept the suite
 * green. The names below are the ones production received; the full key set,
 * with invented values, is __tests__/fixtures/callrail-webhook.ts.
 *
 *   resource_id           the call id (there is no `id`)
 *   customer_phone_number the caller; `callernum` carries the same value
 *   trackingnum           the tracking number that was dialled
 *   datetime              call start, UTC, "YYYY-MM-DD HH:MM:SS", NO offset
 *   callsource            the marketing source, snake_case ("google_ad_extension")
 *   utm_* / referrermedium / campaign / keywords / landingpage / referrer / gclid
 *   first_call, duration (post only, seconds), recording (post only, URL)
 *
 * Every value is a string and "nothing" is an empty string. The pre-call still
 * sends `duration` "0" and `recording` "", so a pre-call is never read as
 * carrying either.
 *
 * The API names are kept as a fallback: they cost one `??` and keep a payload
 * in that shape working if the vendor ever moves to it. For `source`, `medium`
 * and `campaign` the API name is read FIRST, because where it exists it is
 * already the readable, resolved value; the wire sends none of the three today
 * (`campaign` arrives empty), so the wire names below them decide.
 *
 * Deliberately NOT read: `callername`, `callercity`, `callerstate`,
 * `callercountry`. They describe the PERSON, not the campaign, the phone system
 * already has the caller, and personal data is not collected "in case" (same rule
 * as lib/ctm/ingest.ts ATTRIBUTION_KEYS).
 */

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // An object has no single sensible string; `String(obj)` is how a column ends
  // up full of "[object Object]" (md_files/plans/communication/2026-09-18-ctm-gclid-is-object-object.md).
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** The first non-empty value among `keys`, in order. Own keys only: the body is vendor-controlled JSON. */
function first(b: Raw, ...keys: string[]): string | null {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    const s = str(b[k]);
    if (s !== null) return s;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function num(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function phone(v: string | null): string | null {
  if (!v) return null;
  return normalizeNAPhone(v) ?? v;
}

/** "YYYY-MM-DD HH:MM:SS" with no offset is UTC on this wire; anything with a zone is parsed as written. */
const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

function date(v: string | null): Date | null {
  if (!v) return null;
  // `new Date('2026-11-11 14:20:45')` reads the string in the SERVER's zone,
  // which would shift every call by the host's offset. Pin it to UTC.
  const naive = NAIVE_DATETIME.exec(v);
  const d = new Date(naive ? `${naive[1]}T${naive[2]}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `callsource` is a snake_case slug ("google_ad_extension", "direct"). It is
 * shown to the office as the call's ad source, so a slug is re-cased into words
 * ("Google Ad Extension"); anything that is already words is kept as sent.
 */
function readableSource(v: string | null): string | null {
  if (!v) return null;
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(v)) return v;
  return v
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function callIdOf(b: Raw): string | null {
  return first(b, 'resource_id', 'id');
}

function callerOf(b: Raw): string | null {
  return first(b, 'customer_phone_number', 'callernum');
}

export function isCallRailPayload(body: unknown): body is Raw {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Raw;
  return callIdOf(b) !== null && callerOf(b) !== null;
}

export function parseCallRail(body: unknown, phase?: 'pre' | 'post'): TrackedCallEvent | null {
  if (!isCallRailPayload(body)) return null;
  const id = callIdOf(body);
  const caller = phone(callerOf(body));
  if (!caller || !id) return null;

  const rawDuration = num(body.duration);
  const rawRecording = str(body.recording);
  // The URL says which event this is; without it, a pre-call's "0" / "" must
  // not read as a finished call.
  const resolvedPhase = phase ?? ((rawDuration ?? 0) > 0 || rawRecording !== null ? 'post' : 'pre');
  const isPost = resolvedPhase === 'post';

  return {
    provider: 'callrail',
    phase: resolvedPhase,
    vendorCallId: id,
    callerNumber: caller,
    trackingNumber: phone(first(body, 'trackingnum', 'tracking_phone_number')),
    startedAt: date(first(body, 'datetime', 'start_time')) ?? new Date(),
    source: first(body, 'source') ?? readableSource(first(body, 'callsource')),
    medium: first(body, 'medium', 'utm_medium', 'referrermedium'),
    campaign: first(body, 'campaign', 'utm_campaign'),
    keywords: first(body, 'keywords', 'utm_term'),
    landingPageUrl: first(body, 'landingpage', 'landing_page_url'),
    referringUrl: first(body, 'referrer', 'referring_url'),
    gclid: first(body, 'gclid'),
    fbclid: first(body, 'fbclid'),
    msclkid: first(body, 'msclkid'),
    firstCall: bool(body.first_call),
    durationSec: isPost ? rawDuration : null,
    recordingUrl: isPost ? rawRecording : null,
  };
}
