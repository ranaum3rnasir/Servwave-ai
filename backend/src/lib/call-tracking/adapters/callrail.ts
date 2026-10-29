import { normalizeNAPhone } from '../../comms-identity';
import type { TrackedCallEvent } from '../types';

/**
 * CallRail Webhooks integration, pre_call + post_call. Field names per
 * CallRail's webhook reference (verified 2026-09-09):
 *   id, customer_phone_number, tracking_phone_number, start_time (ISO-8601 with
 *   offset), source (the MARKETING source), source_name (the TRACKER's display
 *   name - ignored for attribution on purpose), medium, campaign, keywords,
 *   landing_page_url, referring_url, gclid, fbclid, msclkid, first_call,
 *   duration (post only, seconds), recording (post only, URL).
 *
 * `pre_call` carries no duration and no recording; `post_call` carries both,
 * and that presence is how the phase is decided when the caller does not
 * pass one explicitly.
 */

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function phone(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return normalizeNAPhone(s) ?? s;
}

function date(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isCallRailPayload(body: unknown): body is Raw {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Raw;
  return str(b.id) !== null && str(b.customer_phone_number) !== null;
}

export function parseCallRail(body: unknown, phase?: 'pre' | 'post'): TrackedCallEvent | null {
  if (!isCallRailPayload(body)) return null;
  const caller = phone(body.customer_phone_number);
  const id = str(body.id);
  if (!caller || !id) return null;
  const durationSec = num(body.duration);
  const recordingUrl = str(body.recording);
  return {
    provider: 'callrail',
    phase: phase ?? (durationSec !== null || recordingUrl !== null ? 'post' : 'pre'),
    vendorCallId: id,
    callerNumber: caller,
    trackingNumber: phone(body.tracking_phone_number),
    startedAt: date(body.start_time) ?? new Date(),
    source: str(body.source),
    medium: str(body.medium),
    campaign: str(body.campaign),
    keywords: str(body.keywords),
    landingPageUrl: str(body.landing_page_url),
    referringUrl: str(body.referring_url),
    gclid: str(body.gclid),
    fbclid: str(body.fbclid),
    msclkid: str(body.msclkid),
    firstCall: bool(body.first_call),
    durationSec,
    recordingUrl,
  };
}
