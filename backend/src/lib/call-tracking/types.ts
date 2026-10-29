import type { CallTrackingProvider } from '@prisma/client';

/**
 * One normalised shape for every external call-tracking vendor. The adapters
 * under ./adapters are the only place vendor field names live; everything
 * downstream (the stash, the inbound ingest join, post-call enrichment) reads
 * this. Plan: md_files/plans/communication/2026-09-10-external-call-tracking-webhook-receiver.md §4c.
 */
export interface TrackedCallEvent {
  provider: CallTrackingProvider;
  /** `pre` = the tracking number is ringing (stash it); `post` = the call ended (enrich). */
  phase: 'pre' | 'post';
  vendorCallId: string;
  /** E.164 when the vendor sent a North American number; the raw string otherwise. */
  callerNumber: string;
  trackingNumber: string | null;
  startedAt: Date;
  /** The MARKETING source (Google Ads, organic, direct...), never the tracker's display name. */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  keywords: string | null;
  landingPageUrl: string | null;
  referringUrl: string | null;
  gclid: string | null;
  fbclid: string | null;
  msclkid: string | null;
  firstCall: boolean | null;
  durationSec: number | null;
  recordingUrl: string | null;
}

/**
 * The attribution block written onto CallSession.attribution / the stash. Key
 * names deliberately match the phone system's own block (lib/ctm/ingest.ts
 * ATTRIBUTION_KEYS: source, medium, campaign, keyword, referrer) so one column
 * reads the same whichever vendor filled it; the extras are additive.
 */
export type TrackedCallAttribution = Record<string, string | boolean | number>;

export function attributionOfEvent(e: TrackedCallEvent): TrackedCallAttribution {
  const out: TrackedCallAttribution = {};
  const put = (k: string, v: string | boolean | number | null) => {
    if (v === null || v === undefined || v === '') return;
    out[k] = v;
  };
  put('source', e.source);
  put('medium', e.medium);
  put('campaign', e.campaign);
  put('keyword', e.keywords);
  put('referrer', e.referringUrl);
  put('landing_page', e.landingPageUrl);
  put('gclid', e.gclid);
  put('fbclid', e.fbclid);
  put('msclkid', e.msclkid);
  put('first_call', e.firstCall);
  put('tracking_number', e.trackingNumber);
  put('vendor_duration_sec', e.durationSec);
  put('vendor_recording_url', e.recordingUrl);
  return out;
}
