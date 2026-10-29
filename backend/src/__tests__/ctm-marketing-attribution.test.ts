/**
 * ctm-marketing-attribution.test.ts - persist the FULL CTM attribution block.
 *
 * Alpha Doors runs campaign numbers (Google Ads, Meta, website pools) that
 * forward to the office, so "which campaign did this caller come from" is a
 * reporting requirement. CTM's webhook already carries the whole answer -
 * source, medium, campaign, keyword, referrer, ad network / group / creative
 * ids, gclid - and ingest persisted exactly ONE field (`tracking_source` <-
 * payload.source), dropping the rest on the floor.
 *
 * The payload shapes below are taken from REAL rows observed in staging's
 * ctm_events on 2026-08-07, not invented:
 *   +18626262706 -> source 'Google Ads',  medium 'cpc', referrer google.com
 *   +15513219015 -> source '(alphadoorsnewjersey website pool) Source'
 *   campaign/keyword are null on every observed row, because CTM fills those
 *   from a web session and a caller dialling off a truck has none. Null-vs-
 *   absent therefore matters, and is asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ingestCall } from '../lib/ctm/ingest';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG_ID = 'a0000000-0000-0000-0000-0000000000aa';

/** A real Google-Ads-sourced inbound 'end' payload, trimmed to what ingest reads. */
const GOOGLE_ADS_END = {
  sid: 'CAL-ads-1',
  direction: 'inbound',
  tracking_number: '+18626262706',
  caller_number: '+19735550111',
  call_status: 'completed',
  dial_status: 'answered',
  talk_time: 74,
  unix_time: 1786000000,
  receiving_number_id: 3902576,
  // ── attribution block ──
  source: 'Google Ads',
  source_id: 'SRC-1',
  medium: 'cpc',
  campaign: null,
  keyword: null,
  referrer: 'https://www.google.com/',
  ad_network: 'google',
  ad_group_id: 'AG-9',
  creative_id: 'CR-3',
  ad_content: 'headline-b',
  ga: 'GA1.2.123.456',
};

function upsertPayload() {
  expect(p.callSession.upsert, 'ingest should have upserted a call').toHaveBeenCalled();
  return p.callSession.upsert.mock.calls[0][0].create as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.user.findFirst.mockResolvedValue(null);
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.pendingCallAttribution.findFirst.mockResolvedValue(null);
  p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 0 });
});

describe('ingestCall - marketing attribution', () => {
  it('persists the whole attribution block, not just source', async () => {
    await ingestCall(prisma, ORG_ID, GOOGLE_ADS_END, 'end');

    const attribution = upsertPayload().attribution;
    expect(attribution).toMatchObject({
      source: 'Google Ads',
      source_id: 'SRC-1',
      medium: 'cpc',
      referrer: 'https://www.google.com/',
      ad_network: 'google',
      ad_group_id: 'AG-9',
      creative_id: 'CR-3',
      ad_content: 'headline-b',
      gclid: 'GA1.2.123.456',
    });
  });

  it('keeps tracking_source as the denormalised label reports group by', async () => {
    await ingestCall(prisma, ORG_ID, GOOGLE_ADS_END, 'end');

    // The new column is the full record BEHIND the label, never a replacement:
    // existing reports and the call list read tracking_source and must not move.
    expect(upsertPayload().tracking_source).toBe('Google Ads');
  });

  it('stores the campaign number the caller actually dialled, not the forward target', async () => {
    await ingestCall(prisma, ORG_ID, GOOGLE_ADS_END, 'end');

    // The whole point of a campaign number: it forwards (Dimitris -> office),
    // but the number DIALLED is what ties the call to the campaign. CTM calls
    // it tracking_number; ingest must not overwrite it with a forward leg.
    expect(upsertPayload().to_number).toBe('+18626262706');
  });

  it('omits keys CTM did not send rather than storing a wall of nulls', async () => {
    await ingestCall(prisma, ORG_ID, GOOGLE_ADS_END, 'end');

    const attribution = upsertPayload().attribution;
    // campaign/keyword are null on every real row today (no web session).
    // Storing them as explicit nulls makes "we asked and CTM had nothing"
    // indistinguishable from "we never captured this field" for a future
    // reader, and bloats every row.
    expect(attribution).not.toHaveProperty('campaign');
    expect(attribution).not.toHaveProperty('keyword');
  });

  it('writes SQL NULL, not an empty object, when there is no attribution at all', async () => {
    const bare = { ...GOOGLE_ADS_END };
    for (const k of [
      'source', 'source_id', 'medium', 'campaign', 'keyword', 'referrer',
      'ad_network', 'ad_group_id', 'creative_id', 'ad_content', 'ga',
    ]) {
      delete (bare as Record<string, unknown>)[k];
    }

    await ingestCall(prisma, ORG_ID, bare, 'end');

    // Prisma.DbNull is SQL NULL; a bare `null` would write JSON null, and `{}`
    // would make the partial GIN index carry every unattributed row and read as
    // "attributed, with nothing in it". All three are different states here.
    expect(upsertPayload().attribution).toBe(Prisma.DbNull);
  });

  it('ignores empty strings CTM sends for unset fields', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...GOOGLE_ADS_END, referrer: '', ad_content: '   ', source: 'Google Ads' },
      'end',
    );

    // Observed live: CTM sends '' for tracking_label/referrer on real rows.
    // An empty string is absence, not a value, and would otherwise pollute a
    // GROUP BY with a phantom bucket.
    const attribution = upsertPayload().attribution;
    expect(attribution).not.toHaveProperty('referrer');
    expect(attribution).not.toHaveProperty('ad_content');
    expect(attribution.source).toBe('Google Ads');
  });
});
