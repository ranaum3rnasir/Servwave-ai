/**
 * The join between an external call-tracking vendor's pre-call stash and the
 * phone system's own inbound webhook (lib/ctm/ingest.ts + lib/call-tracking/process.ts).
 *
 * Plan §4d/§4e: md_files/plans/communication/2026-09-10-external-call-tracking-webhook-receiver.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ingestCall } from '../lib/ctm/ingest';
import { processTrackedCallEvent, INBOUND_CLAIM_WINDOW_MS } from '../lib/call-tracking/process';
import type { TrackedCallEvent } from '../lib/call-tracking/types';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG_ID = 'a0000000-0000-0000-0000-0000000000aa';
const CALL_START_UNIX = 1_786_000_000;
const CALL_START = new Date(CALL_START_UNIX * 1000);

/** The phone system's inbound webhook for a call forwarded from the vendor's pool. */
const INBOUND = (position: 'starts' | 'end') => ({
  sid: 'CA-join-1',
  direction: 'inbound',
  caller_number: '(609) 555-0123',
  tracking_number: '+18565708007',
  dial_status: position === 'end' ? 'answered' : undefined,
  talk_time: position === 'end' ? 74 : undefined,
  unix_time: CALL_START_UNIX,
  // The phone system's own (renamed) tracking-source label - the fallback.
  source: 'Website',
  medium: 'offsite',
});

/** The vendor's pre-call stash row, as the claim query would return it. */
const STASH = {
  id: 'stash-1',
  tracking_source: 'Google Ads',
  attribution: { source: 'Google Ads', medium: 'cpc', gclid: 'Cj0abc', landing_page: 'https://example.com/k' },
  provider: 'callrail',
  vendor_call_id: 'CAL-1',
};

function upsertArgs() {
  expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
  return p.callSession.upsert.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockImplementation((args: any) =>
    Promise.resolve({ id: 'cs-1', organization_id: ORG_ID, lead_id: null, direction: 'in', started_at: CALL_START, ...args.create }),
  );
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.user.findFirst.mockResolvedValue(null);
  p.blockedNumber?.findFirst?.mockResolvedValue?.(null);
  p.pendingCallAttribution.findFirst.mockResolvedValue(null);
  p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });
});

describe('inbound ingest claims the vendor stash', () => {
  it("stash before 'starts' joins: vendor source wins, attribution merged over the phone system's block, vendor handle stored", async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(STASH);

    await ingestCall(prisma, ORG_ID, INBOUND('starts'), 'starts');

    const q = p.pendingCallAttribution.findFirst.mock.calls[0][0];
    expect(q.where).toMatchObject({
      organization_id: ORG_ID,
      consumed_at: null,
      provider: { not: null },
      from_number: '+16095550123',
    });
    // Window is around the CALL's start time, ±90 s, not the wall clock.
    expect(q.where.created_at.gte.getTime()).toBe(CALL_START.getTime() - INBOUND_CLAIM_WINDOW_MS);
    expect(q.where.created_at.lte.getTime()).toBe(CALL_START.getTime() + INBOUND_CLAIM_WINDOW_MS);
    expect(INBOUND_CLAIM_WINDOW_MS).toBe(90_000);

    // Atomic claim on consumed_at: null.
    expect(p.pendingCallAttribution.updateMany).toHaveBeenCalledWith({
      where: { id: 'stash-1', consumed_at: null },
      data: { consumed_at: expect.any(Date) },
    });

    const { create } = upsertArgs();
    expect(create.tracking_source).toBe('Google Ads');
    expect(create.attribution).toEqual({
      source: 'Google Ads', // vendor overrides the phone system's 'Website'
      medium: 'cpc',
      gclid: 'Cj0abc',
      landing_page: 'https://example.com/k',
    });
    expect(create.call_tracking_provider).toBe('callrail');
    expect(create.vendor_call_id).toBe('CAL-1');
  });

  it("stash after 'starts' but before 'end' joins on the update path: the existing row gets the vendor join", async () => {
    p.callSession.findFirst.mockResolvedValue({
      organization_id: ORG_ID,
      job_id: null,
      call_tracking_provider: null,
      attribution: { source: 'Website', medium: 'offsite' },
    });
    p.pendingCallAttribution.findFirst.mockResolvedValue(STASH);

    await ingestCall(prisma, ORG_ID, INBOUND('end'), 'end');

    const { update } = upsertArgs();
    expect(update.tracking_source).toBe('Google Ads');
    expect(update.attribution).toEqual({
      source: 'Google Ads',
      medium: 'cpc',
      gclid: 'Cj0abc',
      landing_page: 'https://example.com/k',
    });
    expect(update.call_tracking_provider).toBe('callrail');
    expect(update.vendor_call_id).toBe('CAL-1');
  });

  it('a row that already carries a vendor join never consults the stash again', async () => {
    p.callSession.findFirst.mockResolvedValue({
      organization_id: ORG_ID,
      job_id: null,
      call_tracking_provider: 'callrail',
      attribution: { source: 'Google Ads' },
    });

    await ingestCall(prisma, ORG_ID, INBOUND('end'), 'end');

    expect(p.pendingCallAttribution.findFirst).not.toHaveBeenCalled();
    const { update } = upsertArgs();
    expect(update).not.toHaveProperty('tracking_source');
    expect(update).not.toHaveProperty('call_tracking_provider');
  });

  it("no stash in the window: the phone system's own label and block are written unchanged, vendor columns null", async () => {
    await ingestCall(prisma, ORG_ID, INBOUND('starts'), 'starts');

    const { create } = upsertArgs();
    expect(create.tracking_source).toBe('Website');
    expect(create.attribution).toEqual({ source: 'Website', medium: 'offsite' });
    expect(create.call_tracking_provider).toBeNull();
    expect(create.vendor_call_id).toBeNull();
  });

  it('a stash lost to a concurrent claim (updateMany count 0) is not applied', async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(STASH);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 0 });

    await ingestCall(prisma, ORG_ID, INBOUND('starts'), 'starts');

    const { create } = upsertArgs();
    expect(create.tracking_source).toBe('Website');
    expect(create.call_tracking_provider).toBeNull();
  });

  it('two callers never cross: the claim is keyed on THIS call\'s normalised caller', async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(null);
    await ingestCall(prisma, ORG_ID, { ...INBOUND('starts'), caller_number: '+17325550199' }, 'starts');
    const q = p.pendingCallAttribution.findFirst.mock.calls[0][0];
    expect(q.where.from_number).toBe('+17325550199');
    expect(q.where.from_number).not.toBe('+16095550123');
  });

  it('outbound calls never consult the vendor half of the stash', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { sid: 'CA-out', direction: 'outbound', caller_number: '+18565708007', called_number: '+16095550123', unix_time: CALL_START_UNIX },
      'starts',
    );
    for (const call of p.pendingCallAttribution.findFirst.mock.calls) {
      expect(call[0].where.provider).toBeUndefined();
      expect(call[0].where.from_number).toBeUndefined();
    }
  });
});

const POST: TrackedCallEvent = {
  provider: 'callrail',
  phase: 'post',
  vendorCallId: 'CAL-1',
  callerNumber: '+16095550123',
  trackingNumber: '+18565708007',
  startedAt: CALL_START,
  source: 'Google Ads',
  medium: 'cpc',
  campaign: null,
  keywords: null,
  landingPageUrl: null,
  referringUrl: null,
  gclid: 'Cj0abc',
  fbclid: null,
  msclkid: null,
  firstCall: true,
  durationSec: 184,
  recordingUrl: 'https://app.callrail.com/r/1',
};

describe('post-call enrichment (processTrackedCallEvent)', () => {
  beforeEach(() => {
    p.callSession.update.mockResolvedValue({});
    p.pendingCallAttribution.upsert.mockResolvedValue({ id: 'stash-1' });
  });

  it('finds the row by (provider, vendor id) and merges without touching duration_sec / recording', async () => {
    p.callSession.findFirst.mockResolvedValueOnce({ id: 'cs-1', attribution: { source: 'Google Ads', medium: 'cpc' }, tracking_source: 'Google Ads' });

    const outcome = await processTrackedCallEvent(prisma, ORG_ID, POST);

    expect(outcome).toBe('enriched');
    const upd = p.callSession.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'cs-1' });
    expect(upd.data.attribution).toMatchObject({ vendor_duration_sec: 184, vendor_recording_url: 'https://app.callrail.com/r/1' });
    expect(upd.data).not.toHaveProperty('duration_sec');
    expect(upd.data).not.toHaveProperty('connected_sec');
    expect(upd.data).not.toHaveProperty('recording_key');
    expect(p.pendingCallAttribution.upsert).not.toHaveBeenCalled();
  });

  it('falls back to caller + 30-minute window on an un-joined inbound row and stamps the vendor handle', async () => {
    p.callSession.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'cs-2', attribution: null, tracking_source: 'Website' });

    const outcome = await processTrackedCallEvent(prisma, ORG_ID, POST);

    expect(outcome).toBe('enriched_by_caller');
    const q = p.callSession.findFirst.mock.calls[1][0];
    expect(q.where).toMatchObject({ organization_id: ORG_ID, direction: 'in', from_number: '+16095550123', call_tracking_provider: null });
    expect(q.where.started_at.gte.getTime()).toBe(CALL_START.getTime() - 30 * 60_000);
    expect(q.where.started_at.lte.getTime()).toBe(CALL_START.getTime() + 30 * 60_000);
    const upd = p.callSession.update.mock.calls[0][0];
    expect(upd.data.call_tracking_provider).toBe('callrail');
    expect(upd.data.vendor_call_id).toBe('CAL-1');
    expect(upd.data.tracking_source).toBe('Google Ads');
  });

  it('matches nothing: stashes for a late phone-system row and warns (the caller-ID-changed signal), no number in the log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    const outcome = await processTrackedCallEvent(prisma, ORG_ID, POST);

    expect(outcome).toBe('stashed');
    expect(p.pendingCallAttribution.upsert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched no call row'));
    expect(warn.mock.calls[0][0]).not.toContain('6095550123');
    warn.mockRestore();
  });

  it("a CallRail pre-call always stashes (it fires before the phone system rings) and never warns", async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);
    const outcome = await processTrackedCallEvent(prisma, ORG_ID, { ...POST, phase: 'pre', durationSec: null, recordingUrl: null });
    expect(outcome).toBe('stashed');
    expect(p.callSession.findFirst).toHaveBeenCalledTimes(1); // vendor-id lookup only
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a WhatConverts event (single phase) enriches when a row already exists, else stashes', async () => {
    const wc: TrackedCallEvent = { ...POST, provider: 'whatconverts', phase: 'pre', vendorCallId: '4471023' };
    p.callSession.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'cs-3', attribution: null, tracking_source: null });
    expect(await processTrackedCallEvent(prisma, ORG_ID, wc)).toBe('enriched_by_caller');

    vi.clearAllMocks();
    p.callSession.findFirst.mockResolvedValue(null);
    p.pendingCallAttribution.upsert.mockResolvedValue({});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);
    expect(await processTrackedCallEvent(prisma, ORG_ID, wc)).toBe('stashed');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
