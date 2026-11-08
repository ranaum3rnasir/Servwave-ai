import { describe, it, expect, vi, beforeEach } from 'vitest';

import { prisma } from '../lib/prisma';
import {
  COMM_INCLUDED_MINUTES,
  COMM_INCLUDED_TEXTS,
  cycleStartFor,
  cycleLabelFor,
  billableMinutes,
  billableSecondsOf,
  getCommUsage,
} from '../lib/comm-usage';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const NY = 'America/New_York';

describe('comm usage — allowance constants', () => {
  it('is the plan-included 100 minutes / 500 texts', () => {
    expect(COMM_INCLUDED_MINUTES).toBe(100);
    expect(COMM_INCLUDED_TEXTS).toBe(500);
  });
});

describe('comm usage — cycleStartFor', () => {
  it('returns the UTC instant of local midnight on the 1st (EDT, UTC-4)', () => {
    // 2026-08-13 12:00Z is 08:00 in New York.
    const start = cycleStartFor(new Date('2026-08-13T12:00:00Z'), NY);
    expect(start.toISOString()).toBe('2026-08-01T04:00:00.000Z');
  });

  it('returns the UTC instant of local midnight on the 1st (EST, UTC-5)', () => {
    // January — New York is on standard time, so the offset is 5 hours.
    const start = cycleStartFor(new Date('2026-01-20T12:00:00Z'), NY);
    expect(start.toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });

  it('does NOT roll the cycle early when UTC has crossed the month but the org has not', () => {
    // 2026-09-01 02:00Z is still 2026-08-31 22:00 in New York. A naive UTC
    // implementation reports September here and silently zeroes the meter a
    // day early for every US org.
    const start = cycleStartFor(new Date('2026-09-01T02:00:00Z'), NY);
    expect(start.toISOString()).toBe('2026-08-01T04:00:00.000Z');
  });

  it('rolls the cycle once the org itself crosses midnight', () => {
    // 2026-09-01 05:00Z is 2026-09-01 01:00 in New York.
    const start = cycleStartFor(new Date('2026-09-01T05:00:00Z'), NY);
    expect(start.toISOString()).toBe('2026-09-01T04:00:00.000Z');
  });

  it('handles a zone ahead of UTC', () => {
    // 2026-08-31 20:00Z is already 2026-09-01 04:00 in Manila (UTC+8).
    const start = cycleStartFor(new Date('2026-08-31T20:00:00Z'), 'Asia/Manila');
    expect(start.toISOString()).toBe('2026-08-31T16:00:00.000Z');
  });
});

describe('comm usage — cycleLabelFor', () => {
  it('labels the cycle by its month in the org zone', () => {
    expect(cycleLabelFor(new Date('2026-08-13T12:00:00Z'), NY)).toBe('Aug 1 – 31');
  });

  it('uses the org month, not the UTC month, at the boundary', () => {
    expect(cycleLabelFor(new Date('2026-09-01T02:00:00Z'), NY)).toBe('Aug 1 – 31');
  });

  it('gets the length of a short month right', () => {
    expect(cycleLabelFor(new Date('2026-02-10T12:00:00Z'), NY)).toBe('Feb 1 – 28');
  });
});

describe('comm usage — billableMinutes', () => {
  it('is zero for a call that never connected', () => {
    // Missed / failed / unanswered calls carry null or 0 seconds. Rounding
    // these up would bill a full minute for a phone that merely rang.
    expect(billableMinutes([null])).toBe(0);
    expect(billableMinutes([0])).toBe(0);
    expect(billableMinutes([null, 0, null])).toBe(0);
  });

  it('rounds each call up to the next whole minute', () => {
    expect(billableMinutes([1])).toBe(1);
    expect(billableMinutes([59])).toBe(1);
    expect(billableMinutes([60])).toBe(1);
    expect(billableMinutes([61])).toBe(2);
  });

  it('rounds per call, not on the summed total', () => {
    // Three 30-second calls are 3 billable minutes, not 2 (90s summed).
    expect(billableMinutes([30, 30, 30])).toBe(3);
  });

  it('ignores negative durations rather than subtracting them', () => {
    expect(billableMinutes([-5, 60])).toBe(1);
  });
});

describe('comm usage — billableSecondsOf (which clock the allowance runs on)', () => {
  // Measured against the live CTM account on 2026-08-14, over 160 real calls.
  // CTM charges on `duration` (connected time: ring + queue + IVR + talk), and
  // our ingest stores that as connected_sec. `talk_time` — stored as
  // duration_sec and shown in the Calls list — is the conversation only, and is
  // lower on 130 of those 160 calls and never higher.
  it('bills the connected clock, not the conversation clock', () => {
    // The proof case from live data: talk=240, duration=242, CTM billed 2000
    // hundredths-of-a-cent at the 400/min inbound rate = 5 minutes.
    // ceil(242/60) = 5; ceil(240/60) = 4. Billing on talk time loses a minute.
    expect(billableSecondsOf({ connected_sec: 242, duration_sec: 240 })).toBe(242);
  });

  it('bills a call that rang and was never answered', () => {
    // 26 of 26 such calls in the live account were billed by CTM. Treating
    // "nobody spoke" as free is what made the meter under-report; the org is
    // charged for the line being up whether or not anyone said anything.
    expect(billableSecondsOf({ connected_sec: 40, duration_sec: 0 })).toBe(40);
    expect(billableSecondsOf({ connected_sec: 32, duration_sec: null })).toBe(32);
  });

  it('falls back to the conversation clock for rows ingested before connected_sec existed', () => {
    // Backfilling would mean re-fetching every historical call from CTM. The
    // fallback keeps that history counted — slightly under, never at zero,
    // which is the failure mode that matters.
    expect(billableSecondsOf({ connected_sec: null, duration_sec: 65 })).toBe(65);
    expect(billableSecondsOf({ connected_sec: undefined, duration_sec: 65 })).toBe(65);
  });

  it('is zero when neither clock recorded anything', () => {
    expect(billableSecondsOf({ connected_sec: null, duration_sec: null })).toBe(0);
    expect(billableSecondsOf({ connected_sec: 0, duration_sec: 0 })).toBe(0);
  });

  it('prefers a zero connected clock over a stale conversation clock', () => {
    // connected_sec === 0 is a real measurement (the call never connected at
    // all), not a missing value, so it must not fall through to duration_sec.
    expect(billableSecondsOf({ connected_sec: 0, duration_sec: 90 })).toBe(0);
  });
});

describe('comm usage — getCommUsage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    p.callSession = { findMany: vi.fn() };
    p.message = { count: vi.fn() };
  });

  it('counts calls and texts in BOTH directions, scoped to the org and cycle', async () => {
    p.callSession.findMany.mockResolvedValue([
      { connected_sec: 65, duration_sec: 60 },   // outbound → 2 min
      { connected_sec: 120, duration_sec: 118 }, // inbound  → 2 min
      { connected_sec: null, duration_sec: null }, // nothing recorded → 0 min
    ]);
    p.message.count.mockResolvedValue(42);

    const usage = await getCommUsage('org-1', { timeZone: NY, now: new Date('2026-08-13T12:00:00Z') });

    expect(usage.calling).toEqual({ used: 4, limit: 100, unit: 'min' });
    expect(usage.texting).toEqual({ used: 42, limit: 500, unit: 'texts' });

    // Both clocks must be selected: connected_sec is what we bill, duration_sec
    // is the fallback for rows that predate it.
    const callSelect = p.callSession.findMany.mock.calls[0][0].select;
    expect(callSelect.connected_sec).toBe(true);
    expect(callSelect.duration_sec).toBe(true);

    // Org scoping and the cycle window must both be in the query, and neither
    // query may filter on direction — inbound counts too.
    const callWhere = p.callSession.findMany.mock.calls[0][0].where;
    expect(callWhere.organization_id).toBe('org-1');
    expect(callWhere.started_at.gte.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(callWhere.direction).toBeUndefined();

    const msgWhere = p.message.count.mock.calls[0][0].where;
    expect(msgWhere.organization_id).toBe('org-1');
    expect(msgWhere.ts.gte.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(msgWhere.direction).toBeUndefined();
  });

  it('counts a cycle of rang-but-never-answered calls', async () => {
    // The regression this whole change exists for. Six callers who each waited
    // ~40 seconds and hung up cost real money; metering on talk time reported
    // the org as having used nothing at all.
    p.callSession.findMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({ connected_sec: 40, duration_sec: 0 })),
    );
    p.message.count.mockResolvedValue(0);

    const usage = await getCommUsage('org-1', { timeZone: NY, now: new Date('2026-08-13T12:00:00Z') });

    expect(usage.calling.used).toBe(6);
  });

  it('reports usage over the limit truthfully rather than clamping', async () => {
    // The meter clamps its BAR at 100%, but the underlying number must stay
    // honest — otherwise an org that blew through the allowance looks exactly
    // like one that landed on it.
    p.callSession.findMany.mockResolvedValue([{ duration_sec: 60 * 250 }]);
    p.message.count.mockResolvedValue(1500);

    const usage = await getCommUsage('org-1', { timeZone: NY, now: new Date('2026-08-13T12:00:00Z') });

    expect(usage.calling.used).toBe(250);
    expect(usage.texting.used).toBe(1500);
  });

  it('reports NO limit for an uncapped org, while still counting real usage', async () => {
    // House orgs (the demo tenant, Alpha) are exempt from the allowance. A null
    // limit is what tells the meter to drop its bar, its percentage and its
    // "approaching limit" banner - deliberately null rather than a huge number,
    // so nothing downstream can render a misleading 0.4% against a fake ceiling.
    p.callSession.findMany.mockResolvedValue([{ duration_sec: 60 * 128 }]);
    p.message.count.mockResolvedValue(22);

    const usage = await getCommUsage('org-1', {
      timeZone: NY,
      uncapped: true,
      now: new Date('2026-08-13T12:00:00Z'),
    });

    expect(usage.calling).toEqual({ used: 128, limit: null, unit: 'min' });
    expect(usage.texting).toEqual({ used: 22, limit: null, unit: 'texts' });
  });

  it('still applies the allowance when uncapped is false or omitted', async () => {
    p.callSession.findMany.mockResolvedValue([]);
    p.message.count.mockResolvedValue(0);

    const off = await getCommUsage('org-1', { timeZone: NY, uncapped: false, now: new Date('2026-08-13T12:00:00Z') });
    expect(off.calling.limit).toBe(100);
    expect(off.texting.limit).toBe(500);

    const omitted = await getCommUsage('org-1', { timeZone: NY, now: new Date('2026-08-13T12:00:00Z') });
    expect(omitted.calling.limit).toBe(100);
    expect(omitted.texting.limit).toBe(500);
  });

  // Story 22 (Spec C): the org pays for a staff text exactly as it pays for a customer
  // one. Nothing had to be built for this - the count is org-wide with NO thread, kind,
  // direction or customer narrowing - but a `kind` filter added here later would silently
  // make staff texts free, and this is the assertion that would catch it.
  it('counts a staff-thread text against the org allowance, exactly as a customer text', async () => {
    p.callSession.findMany.mockResolvedValue([]);
    // Whatever mix of customer and team threads the org's messages sit in, the count is
    // the same query.
    p.message.count.mockResolvedValue(7);

    const usage = await getCommUsage('org-1', { timeZone: NY, now: new Date('2026-08-13T12:00:00Z') });

    expect(usage.texting).toEqual({ used: 7, limit: 500, unit: 'texts' });
    const where = p.message.count.mock.calls[0][0].where;
    expect(where).toEqual({ organization_id: 'org-1', ts: { gte: new Date('2026-08-01T04:00:00.000Z') } });
    // The narrowings that would have excluded a staff row, each named so the failure
    // message says which one crept in.
    expect(where.thread).toBeUndefined();
    expect(where.kind).toBeUndefined();
    expect(where.customer_id).toBeUndefined();
    expect(where.direction).toBeUndefined();
  });

  it('reports a zeroed cycle for an org with no activity', async () => {
    p.callSession.findMany.mockResolvedValue([]);
    p.message.count.mockResolvedValue(0);

    const usage = await getCommUsage('org-1', { timeZone: NY, now: new Date('2026-08-13T12:00:00Z') });

    expect(usage.calling.used).toBe(0);
    expect(usage.texting.used).toBe(0);
    expect(usage.cycleLabel).toBe('Aug 1 – 31');
  });
});
