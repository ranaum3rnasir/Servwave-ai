/**
 * The RENDER boundary: instant -> user-facing string.
 *
 * Phase 1 (#1374) fixed the write paths, so a picked time is now stored as the instant the
 * ORG meant. This is the other half: whoever is looking, the string on screen must be the
 * ORG's clock. Prod job 698675 stores 2026-08-06T01:00Z — New York renders that as Aug 5
 * 9:00 PM and Manila as Aug 6 9:00 AM, which is exactly the pair of screenshots that opened
 * this whole thread.
 *
 * As in schedule-tz.picker.test.ts, the assertion that matters is not "the numbers are
 * right" but that the result is IDENTICAL regardless of the viewer's own timezone. The
 * process TZ is pinned per-case via a helper rather than trusted, because a test that only
 * ever runs in one zone cannot fail on the bug it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { formatInstant, orgDayDiff } from './schedule-tz';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

/** The instant behind prod job 698675. */
const JOB_698675 = '2026-08-06T01:00:00.000Z';

describe('formatInstant (instant -> org-clock string)', () => {
  it('renders the ORG clock, not the viewer clock', () => {
    // 01:00Z is Aug 5 21:00 in New York. A Manila viewer must see the same string.
    expect(formatInstant(JOB_698675, NY)).toBe('Aug 5, 9:00 PM');
  });

  it('renders a different string only when the ORG zone differs', () => {
    expect(formatInstant(JOB_698675, MANILA)).toBe('Aug 6, 9:00 AM');
  });

  it('honours the org zone DST offset for the date in question', () => {
    expect(formatInstant('2026-01-15T14:00:00.000Z', NY)).toBe('Jan 15, 9:00 AM'); // EST
    expect(formatInstant('2026-07-15T13:00:00.000Z', NY)).toBe('Jul 15, 9:00 AM'); // EDT
  });

  it('accepts custom Intl options but still forces the org zone', () => {
    expect(formatInstant(JOB_698675, NY, { hour: 'numeric', minute: '2-digit' })).toBe('9:00 PM');
    expect(
      formatInstant(JOB_698675, NY, { year: 'numeric', month: 'short', day: 'numeric' }),
    ).toBe('Aug 5, 2026');
  });

  it('cannot be overridden into the viewer zone by a stray timeZone option', () => {
    // Guards the ordering inside the helper: the org zone is applied last on purpose, so a
    // call site that copy-pastes an old `timeZone` option cannot silently reintroduce the bug.
    expect(
      formatInstant(JOB_698675, NY, { hour: 'numeric', minute: '2-digit', timeZone: MANILA }),
    ).toBe('9:00 PM');
  });

  it('returns empty string for missing input rather than "Invalid Date"', () => {
    expect(formatInstant(null, NY)).toBe('');
    expect(formatInstant(undefined, NY)).toBe('');
    expect(formatInstant('', NY)).toBe('');
  });
});

describe('orgDayDiff (calendar days, measured in the org zone)', () => {
  it('counts CALENDAR days, not elapsed 24h blocks', () => {
    // 23:00 NY on the 5th to 01:00 NY on the 6th is two hours, but one calendar day.
    const late = '2026-08-06T03:00:00.000Z'; // Aug 5 23:00 NY
    const early = '2026-08-06T05:00:00.000Z'; // Aug 6 01:00 NY
    expect(orgDayDiff(early, NY, late)).toBe(1);
  });

  it('is 0 for a different time on the same org day', () => {
    expect(orgDayDiff('2026-08-06T23:00:00.000Z', NY, '2026-08-06T13:00:00.000Z')).toBe(0);
  });

  it('is negative for a past day', () => {
    expect(orgDayDiff('2026-08-01T13:00:00.000Z', NY, '2026-08-06T13:00:00.000Z')).toBe(-5);
  });

  it('stays whole across a DST transition', () => {
    // 2026-03-08 is spring-forward in New York: that calendar day is only 23 hours long, so
    // an elapsed-hours implementation returns 6.96 -> floors to 6. It is 7 calendar days.
    expect(orgDayDiff('2026-03-12T13:00:00.000Z', NY, '2026-03-05T13:00:00.000Z')).toBe(7);
    // And fall-back, where the day is 25 hours long.
    expect(orgDayDiff('2026-11-05T13:00:00.000Z', NY, '2026-10-29T13:00:00.000Z')).toBe(7);
  });

  it('measures BOTH ends in the org zone, so the org zone alone decides the answer', () => {
    // One instant, one "now", two orgs. 12:00Z is Aug 5 in both zones, but the job's own
    // instant (Aug 6 01:00Z) is still Aug 5 in New York and already Aug 6 in Manila — so the
    // same job reads "Today" to a New York org and "Tomorrow" to a Manila one. That is the
    // org's clock deciding, which is the point; the viewer's zone never enters into it.
    const now = '2026-08-05T12:00:00.000Z';
    expect(orgDayDiff(JOB_698675, NY, now)).toBe(0);
    expect(orgDayDiff(JOB_698675, MANILA, now)).toBe(1);
  });
});
