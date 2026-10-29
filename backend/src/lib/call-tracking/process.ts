import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { attributionOfEvent, type TrackedCallEvent } from './types';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * How far apart the vendor's pre-call event and the phone system's own
 * inbound webhook may be and still be the SAME call. Vendor ring-to-our-ring
 * is a few seconds; 90 s covers a long ring with margin and keeps two calls
 * from one person in an afternoon from cross-joining. Measured on the call's
 * start time, not the wall clock, so a late `end` webhook after a long call
 * still claims a stash written when the call began.
 */
export const INBOUND_CLAIM_WINDOW_MS = 90_000;

/**
 * Post-call fallback: when the row was never joined on pre-call (the stash
 * missed, or the vendor only sends one event), match the call row by caller
 * within this window of the vendor's start time. The vendor's post-call can
 * lag up to 20 minutes, so 30 is the margin.
 */
export const POST_CALL_FALLBACK_WINDOW_MS = 30 * 60_000;

export type ProcessOutcome = 'stashed' | 'enriched' | 'enriched_by_caller';

function mergeAttribution(existing: unknown, incoming: Record<string, unknown>): Prisma.InputJsonObject {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  return { ...base, ...incoming } as Prisma.InputJsonObject;
}

async function stash(db: Db, orgId: string, e: TrackedCallEvent): Promise<void> {
  // A second event for the same vendor call (a re-delivered pre, or a post
  // whose call row has not arrived yet) MERGES over what the stash already
  // holds: the pre-call carries the gclid / medium / landing page and the
  // post-call carries the duration / recording, and a late-claiming call row
  // must receive both. Surfaced by the first live test on staging, where a
  // no-match post wiped the pre's gclid.
  const prior = await db.pendingCallAttribution.findFirst({
    where: { provider: e.provider, vendor_call_id: e.vendorCallId },
    select: { attribution: true, tracking_source: true },
  });
  const attribution = mergeAttribution(prior?.attribution, attributionOfEvent(e));
  const trackingSource = e.source ?? prior?.tracking_source ?? null;
  await db.pendingCallAttribution.upsert({
    where: { provider_vendor_call_id: { provider: e.provider, vendor_call_id: e.vendorCallId } },
    create: {
      organization_id: orgId,
      provider: e.provider,
      vendor_call_id: e.vendorCallId,
      from_number: e.callerNumber,
      to_number: e.trackingNumber ?? '',
      tracking_source: trackingSource,
      attribution,
    },
    update: {
      from_number: e.callerNumber,
      to_number: e.trackingNumber ?? '',
      tracking_source: trackingSource,
      attribution,
    },
  });
}

async function enrich(
  db: Db,
  row: { id: string; attribution: unknown; tracking_source: string | null },
  e: TrackedCallEvent,
): Promise<void> {
  // The phone system's own duration_sec / recording stay authoritative: they
  // drive billing and playback. The vendor's figures ride along in the
  // attribution block only.
  await db.callSession.update({
    where: { id: row.id },
    data: {
      call_tracking_provider: e.provider,
      vendor_call_id: e.vendorCallId,
      tracking_source: e.source ?? row.tracking_source,
      attribution: mergeAttribution(row.attribution, attributionOfEvent(e)),
    },
  });
}

/**
 * Apply one vendor event for an org. Runs AFTER the webhook has been acked.
 *
 *  - `pre`  → stash by caller; the inbound ingest claims it (lib/ctm/ingest.ts).
 *  - `post` → find the row by (provider, vendor id) and merge; else match by
 *             caller within the fallback window; else stash it so a very late
 *             phone-system row can still claim it, and warn: a post-call that
 *             matches nothing is the signal that the vendor's caller-ID setting
 *             changed (plan §3).
 *
 * WhatConverts sends one event per lead with no pre/post split, so it arrives
 * as `pre` and takes the `post` path when a row already exists.
 */
export async function processTrackedCallEvent(
  db: Db,
  orgId: string,
  e: TrackedCallEvent,
): Promise<ProcessOutcome> {
  const select = { id: true, attribution: true, tracking_source: true } as const;

  const byVendorId = await db.callSession.findFirst({
    where: { organization_id: orgId, call_tracking_provider: e.provider, vendor_call_id: e.vendorCallId },
    select,
  });
  if (byVendorId) {
    await enrich(db, byVendorId, e);
    return 'enriched';
  }

  if (e.phase === 'pre' && e.provider === 'callrail') {
    await stash(db, orgId, e);
    return 'stashed';
  }

  const byCaller = await db.callSession.findFirst({
    where: {
      organization_id: orgId,
      direction: 'in',
      from_number: e.callerNumber,
      call_tracking_provider: null,
      started_at: {
        gte: new Date(e.startedAt.getTime() - POST_CALL_FALLBACK_WINDOW_MS),
        lte: new Date(e.startedAt.getTime() + POST_CALL_FALLBACK_WINDOW_MS),
      },
    },
    orderBy: { started_at: 'desc' },
    select,
  });
  if (byCaller) {
    await enrich(db, byCaller, e);
    return 'enriched_by_caller';
  }

  await stash(db, orgId, e);
  if (e.phase === 'post') {
    // Deliberately no phone number in the log line.
    logger.warn(
      `[call-tracking] post-call event matched no call row (provider=${e.provider}, vendor_call_id=${e.vendorCallId}); ` +
        'if this repeats, the vendor may be forwarding with the tracking number as caller ID instead of the caller',
    );
  }
  return 'stashed';
}
