import { describe, it, expect } from 'vitest';
import {
  isBareOrgDay, addOrgDays, orgDayStart, orgDayRange, orgDayOf, orgDayDiff, daysBetweenOrgDays,
  orgTodayStart,
} from '../lib/orgDayRange';

// America/New_York is the org zone the bug was found in (UTC-4 in August, so a UTC-anchored
// boundary lands at 8:00 PM the PREVIOUS evening). Asia/Manila is the discriminating fixture
// the frontend's date suites already use — UTC+8, i.e. the offset points the OTHER way, so a
// test that passes in both cannot be accidentally satisfied by a fixed-direction offset.
const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

describe('isBareOrgDay', () => {
  it('accepts a zoneless calendar day', () => {
    expect(isBareOrgDay('2026-08-24')).toBe(true);
  });

  it('rejects a full ISO instant — this is what keeps the schedule board on its old path', () => {
    expect(isBareOrgDay('2026-08-24T21:00:00.000Z')).toBe(false);
    expect(isBareOrgDay('2026-08-24T00:00:00')).toBe(false);
  });

  it('rejects non-strings and empties', () => {
    expect(isBareOrgDay(undefined)).toBe(false);
    expect(isBareOrgDay('')).toBe(false);
    expect(isBareOrgDay(20260824)).toBe(false);
  });
});

describe('addOrgDays', () => {
  it('steps whole calendar days', () => {
    expect(addOrgDays('2026-08-24', 1)).toBe('2026-08-25');
    expect(addOrgDays('2026-08-24', -1)).toBe('2026-08-23');
  });

  it('rolls over month and year ends', () => {
    expect(addOrgDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addOrgDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('crosses a DST boundary as a CALENDAR step, not a 24h step', () => {
    // 2026-03-08 is spring-forward in the US: that org day is only 23 hours long. Counting
    // in days rather than milliseconds is what keeps this exact.
    expect(addOrgDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addOrgDays('2026-03-08', 1)).toBe('2026-03-09');
  });
});

describe('orgDayStart', () => {
  it('anchors on the ORG midnight, not UTC midnight', () => {
    // New York in August is UTC-4, so the day begins at 04:00Z.
    expect(orgDayStart('2026-08-24', NY).toISOString()).toBe('2026-08-24T04:00:00.000Z');
    // Manila is UTC+8, so its day begins the PREVIOUS UTC day at 16:00Z — the opposite sign.
    expect(orgDayStart('2026-08-24', MANILA).toISOString()).toBe('2026-08-23T16:00:00.000Z');
  });

  it('tracks the offset change across DST rather than assuming a fixed one', () => {
    // EST (UTC-5) before spring-forward, EDT (UTC-4) after.
    expect(orgDayStart('2026-03-07', NY).toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(orgDayStart('2026-03-09', NY).toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});

describe('orgDayRange: the "to" day is INCLUSIVE', () => {
  it('a single-day range is a real 24h window, not the zero-width one that made "Today" empty', () => {
    const range = orgDayRange('2026-08-24', '2026-08-24', NY);
    expect(range).toEqual({
      gte: new Date('2026-08-24T04:00:00.000Z'),
      lt: new Date('2026-08-25T04:00:00.000Z'),
    });
  });

  it('MATCHES the reported repro: a 5:00 PM org-time visit on the "to" day is inside the window', () => {
    // J00312's visit — 2026-08-24T21:00:00Z is 5:00 PM in New York on Aug 24.
    const visit = new Date('2026-08-24T21:00:00.000Z');
    const range = orgDayRange('2026-08-24', '2026-08-24', NY)!;
    expect(visit >= range.gte!).toBe(true);
    expect(visit < range.lt!).toBe(true);
  });

  it('EXCLUDES an instant that is already the next ORG day though it is the same UTC day', () => {
    // 2026-08-25T02:00:00Z is 10:00 PM Aug 24 in New York — still inside.
    expect(new Date('2026-08-25T02:00:00.000Z') < orgDayRange('2026-08-24', '2026-08-24', NY)!.lt!).toBe(true);
    // 2026-08-25T05:00:00Z is 1:00 AM Aug 25 in New York — outside.
    expect(new Date('2026-08-25T05:00:00.000Z') < orgDayRange('2026-08-24', '2026-08-24', NY)!.lt!).toBe(false);
  });

  it('EXCLUDES the evening BEFORE the _after edge, which the UTC cut used to let in', () => {
    // 21:00 New York on Aug 23 is 2026-08-24T01:00:00Z — the next UTC day, so a UTC-anchored
    // `gte` admitted it. On the org clock it is the day before the range starts.
    const range = orgDayRange('2026-08-24', '2026-08-24', NY)!;
    expect(new Date('2026-08-24T01:00:00.000Z') >= range.gte!).toBe(false);
  });

  it('keeps the last day of a MULTI-day range, which the old bound dropped', () => {
    const range = orgDayRange('2026-08-23', '2026-08-24', NY)!;
    // A visit at 5:00 PM on Aug 24 (the "to" day) must be in the window.
    expect(new Date('2026-08-24T21:00:00.000Z') < range.lt!).toBe(true);
  });

  it('is inclusive in a UTC+ zone too', () => {
    const range = orgDayRange('2026-08-24', '2026-08-24', MANILA);
    expect(range).toEqual({
      gte: new Date('2026-08-23T16:00:00.000Z'),
      lt: new Date('2026-08-24T16:00:00.000Z'),
    });
  });

  it('spans the extra hour on a fall-back day rather than a flat 24h', () => {
    // 2026-11-01 is fall-back in the US: that org day is 25 hours long.
    const range = orgDayRange('2026-11-01', '2026-11-01', NY)!;
    expect(range.lt!.getTime() - range.gte!.getTime()).toBe(25 * 3_600_000);
  });
});

describe('orgDayRange: full ISO instants are left exactly as they were', () => {
  it('keeps gte/lte semantics for the schedule board, byte-for-byte', () => {
    // What useScheduleData.ts sends: toInstant(...).toISOString() on both ends.
    const after = '2026-08-24T04:00:00.000Z';
    const before = '2026-08-25T03:59:59.999Z';
    expect(orgDayRange(after, before, NY)).toEqual({
      gte: new Date(after),
      lte: new Date(before),
    });
  });

  it('does not resolve an instant through the org zone', () => {
    // The same instant in two different org zones must produce the same bound.
    const iso = '2026-08-24T21:00:00.000Z';
    expect(orgDayRange(iso, undefined, NY)).toEqual(orgDayRange(iso, undefined, MANILA));
  });
});

describe('orgDayRange: partial and empty input', () => {
  it('sets only the bound that is present', () => {
    expect(orgDayRange('2026-08-24', undefined, NY)).toEqual({
      gte: new Date('2026-08-24T04:00:00.000Z'),
    });
    expect(orgDayRange(undefined, '2026-08-24', NY)).toEqual({
      lt: new Date('2026-08-25T04:00:00.000Z'),
    });
  });

  it('resolves each bound independently when the shapes are MIXED', () => {
    const range = orgDayRange('2026-08-24T21:00:00.000Z', '2026-08-25', NY);
    expect(range).toEqual({
      gte: new Date('2026-08-24T21:00:00.000Z'),
      lt: new Date('2026-08-26T04:00:00.000Z'),
    });
  });

  it('returns null when there is nothing to filter on, so `where` is left untouched', () => {
    expect(orgDayRange(undefined, undefined, NY)).toBeNull();
    expect(orgDayRange('', '', NY)).toBeNull();
  });
});


describe('orgDayOf', () => {
  it('names the ORG calendar day an instant falls on, not the UTC one', () => {
    // 02:35 UTC is the previous EVENING in New York and the same AFTERNOON in Manila, so this
    // one instant sits on three different calendar days depending on whose calendar you ask.
    const at = new Date('2026-07-11T02:35:09.368Z');
    expect(orgDayOf(at, 'UTC')).toBe('2026-07-11');
    expect(orgDayOf(at, NY)).toBe('2026-07-10');
    expect(orgDayOf(at, MANILA)).toBe('2026-07-11');
  });

  it('is exact at both edges of an org day', () => {
    expect(orgDayOf(new Date('2026-08-25T04:00:00.000Z'), NY)).toBe('2026-08-25'); // 00:00 EDT
    expect(orgDayOf(new Date('2026-08-25T03:59:59.999Z'), NY)).toBe('2026-08-24'); // 23:59 EDT
  });

  it('round-trips with orgDayStart', () => {
    for (const day of ['2026-01-15', '2026-03-08', '2026-11-01']) {
      expect(orgDayOf(orgDayStart(day, NY), NY)).toBe(day);
    }
  });
});

describe('daysBetweenOrgDays', () => {
  it('counts calendar days, month and year boundaries included', () => {
    expect(daysBetweenOrgDays('2026-07-10', '2026-08-25')).toBe(46);
    expect(daysBetweenOrgDays('2026-08-25', '2026-08-25')).toBe(0);
    expect(daysBetweenOrgDays('2026-08-25', '2026-07-10')).toBe(-46);
    expect(daysBetweenOrgDays('2025-12-31', '2026-01-01')).toBe(1);
  });
});

describe('orgDayDiff', () => {
  const DUE = new Date('2026-07-11T02:35:09.368Z'); // staging invoice I00118

  it('answers in whole days, not elapsed 24-hour periods', () => {
    // The elapsed gap here is 45 days and ~15 hours. Flooring that gives 45 - which is the
    // off-by-one the invoice detail page shipped. On the org calendar it is 46 days.
    const now = new Date('2026-08-25T18:00:00.000Z');
    expect(Math.floor((now.getTime() - DUE.getTime()) / 86_400_000)).toBe(45);
    expect(orgDayDiff(DUE, now, NY)).toBe(46);
  });

  it('does not move as the clock walks across a single org day', () => {
    const sameDay = [
      '2026-08-25T04:00:00.000Z', // 00:00 New York
      '2026-08-25T18:22:37.913Z', // a ragged instant mid-afternoon
      '2026-08-26T03:59:59.999Z', // 23:59 New York
    ].map((iso) => orgDayDiff(DUE, new Date(iso), NY));
    expect(sameDay).toEqual([46, 46, 46]);
  });

  it('counts a DST day as one day in both directions', () => {
    // Spring forward 2026-03-08: 12:00 -> 12:00 is 23 hours but one calendar day.
    expect(orgDayDiff(
      new Date('2026-03-07T17:00:00.000Z'), new Date('2026-03-08T16:00:00.000Z'), NY,
    )).toBe(1);
    // Fall back 2026-11-01: 25 hours, still one calendar day.
    expect(orgDayDiff(
      new Date('2026-10-31T16:00:00.000Z'), new Date('2026-11-01T17:00:00.000Z'), NY,
    )).toBe(1);
  });

  it('is symmetric under negation', () => {
    const a = new Date('2026-07-11T02:35:09.368Z');
    const b = new Date('2026-08-25T18:00:00.000Z');
    expect(orgDayDiff(b, a, NY)).toBe(-orgDayDiff(a, b, NY));
  });
});

// ─── orgTodayStart — the OVERDUE boundary (Defect A) ───────────────────────────────────────
//
// `due_date: { lt: orgTodayStart(tz) }` is the Prisma expression of the frontend's
// `orgDayDiff(due_date, tz) < 0`. The three constants below are deliberately the three
// answers the three WRONG clocks give for one instant, so no test here can be satisfied by
// the server instant or by UTC midnight.
describe('orgTodayStart', () => {
  const DENVER = 'America/Denver';

  it('names the instant the ORG day began, not UTC midnight', () => {
    // 02:30Z on Aug 25 is still 22:30 EDT on Aug 24, so the org day that is CURRENTLY running
    // began at 04:00Z on Aug 24. A UTC-day reading answers 2026-08-25T00:00:00Z; the raw
    // server instant answers 02:30Z. Both are a different day from the one the user is in.
    expect(orgTodayStart(NY, new Date('2026-08-25T02:30:00.000Z')).toISOString())
      .toBe('2026-08-24T04:00:00.000Z');
    expect(orgTodayStart('UTC', new Date('2026-08-25T02:30:00.000Z')).toISOString())
      .toBe('2026-08-25T00:00:00.000Z');
  });

  it('differs between two US zones on the same instant', () => {
    // The boundary tracks the ORG's zone, not the server's and not a single hardcoded one.
    const at = new Date('2026-08-25T18:00:00.000Z');
    expect(orgTodayStart(NY, at).toISOString()).toBe('2026-08-25T04:00:00.000Z');
    expect(orgTodayStart(DENVER, at).toISOString()).toBe('2026-08-25T06:00:00.000Z');
  });

  it('tracks the DST offset rather than assuming a fixed one', () => {
    // MST (UTC-7) in January, MDT (UTC-6) in August — the same zone, two offsets.
    expect(orgTodayStart(DENVER, new Date('2026-01-15T18:00:00.000Z')).toISOString())
      .toBe('2026-01-15T07:00:00.000Z');
    expect(orgTodayStart(DENVER, new Date('2026-08-15T18:00:00.000Z')).toISOString())
      .toBe('2026-08-15T06:00:00.000Z');
  });

  it('is exactly orgDayStart(orgDayOf(...)) — the whole org day sits at or after it', () => {
    const at = new Date('2026-08-25T18:00:00.000Z');
    const boundary = orgTodayStart(NY, at);
    expect(boundary).toEqual(orgDayStart(orgDayOf(at, NY), NY));
    // Both edges of today are NOT before the boundary: an invoice due any time today is not
    // yet overdue, at 00:00:00 org-local and at 23:59:59.999 org-local alike.
    expect(new Date('2026-08-25T04:00:00.000Z') < boundary).toBe(false);
    expect(new Date('2026-08-26T03:59:59.999Z') < boundary).toBe(false);
    // Yesterday still is.
    expect(new Date('2026-08-25T03:59:59.999Z') < boundary).toBe(true);
  });

  it('defaults `at` to now', () => {
    expect(orgTodayStart(NY).toISOString()).toBe(orgTodayStart(NY, new Date()).toISOString());
  });
});
