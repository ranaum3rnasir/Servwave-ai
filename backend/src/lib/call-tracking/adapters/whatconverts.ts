import { normalizeNAPhone } from '../../comms-identity';
import type { TrackedCallEvent } from '../types';

/**
 * WhatConverts lead webhook (the agency's next vendor). No signature, no
 * pre/post split: one event per lead. Field names per WhatConverts' webhook
 * reference: lead_id, caller_number, date_created (UTC, 'Z'), lead_source,
 * lead_medium, lead_campaign, lead_keyword, landing_url, gclid, plus
 * call_duration / recording when present. Every event is treated as `pre`
 * (stash, then the ingest claims it); the processor promotes it to an
 * enrichment itself when a matching call row already exists.
 */

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function isWhatConvertsPayload(body: unknown): body is Raw {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Raw;
  return str(b.lead_id) !== null && str(b.caller_number) !== null;
}

export function parseWhatConverts(body: unknown): TrackedCallEvent | null {
  if (!isWhatConvertsPayload(body)) return null;
  const rawCaller = str(body.caller_number);
  const id = str(body.lead_id);
  if (!rawCaller || !id) return null;
  const startedRaw = str(body.date_created);
  const started = startedRaw ? new Date(startedRaw) : null;
  const tracking = str(body.tracking_number);
  return {
    provider: 'whatconverts',
    phase: 'pre',
    vendorCallId: id,
    callerNumber: normalizeNAPhone(rawCaller) ?? rawCaller,
    trackingNumber: tracking ? normalizeNAPhone(tracking) ?? tracking : null,
    startedAt: started && !Number.isNaN(started.getTime()) ? started : new Date(),
    source: str(body.lead_source),
    medium: str(body.lead_medium),
    campaign: str(body.lead_campaign),
    keywords: str(body.lead_keyword),
    landingPageUrl: str(body.landing_url),
    referringUrl: str(body.referring_url) ?? str(body.referrer),
    gclid: str(body.gclid),
    fbclid: str(body.fbclid),
    msclkid: str(body.msclkid),
    firstCall: null,
    durationSec: num(body.call_duration),
    recordingUrl: str(body.recording),
  };
}
