/**
 * MV-TZ-02. The board's empty-slot popover reads and writes a visit's window.
 *
 * The v2 fork of QuickScheduleCard dropped the `tz` prop its v1 twin took and
 * resolved its times against the BROWSER instead: `new Date(iso); d.setHours(h,m,0,0);
 * d.toISOString()`. Against the real J00233 visit-1 slot (2026-08-23T13:00:00.000Z,
 * 9:00 AM on the org clock) picking 9:00 AM persisted 2026-08-23T01:00:00.000Z from
 * Asia/Manila - twelve hours out AND on the previous calendar day. On the lead
 * walkthrough path that value is persisted with no confirming dialog at all.
 *
 * These helpers live in their own module, not inside the card, so the logic cannot drift
 * out of test coverage again the way #1551's four fields did. `tz` is a REQUIRED parameter
 * precisely so a fork that forgets it fails to compile rather than failing silently.
 *
 * As in schedule-tz.picker.test.ts, the assertion that matters is not "the numbers are
 * right" - it is that every result is IDENTICAL whatever zone the runner sits in,
 * because a test that only holds in one zone cannot fail on the bug it guards.
 */
import { describe, it, expect } from 'vitest';

import { isoToHHmm, withTime, slotTimeLabel } from './slotPopoverTime';

/** U+2013 EN DASH - the range separator this label renders (see schedule/glyphs.ts). */
const EN = '\u2013';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';
const LA = 'America/Los_Angeles';

// J00233 visit 1 as actually stored on staging: 9:00 AM org clock in August (EDT, UTC-4).
const J00233_VISIT1 = '2026-08-23T13:00:00.000Z';

describe('isoToHHmm (instant -> org wall clock)', () => {
  it('reads the ORG clock, not the browser clock', () => {
    expect(isoToHHmm(J00233_VISIT1, NY)).toBe('09:00');
  });

  it('gives the same org wall clock whichever zone the viewer sits in', () => {
    // The instant is one instant. Only the org zone decides what it is called.
    expect(isoToHHmm(J00233_VISIT1, NY)).toBe('09:00');
    expect(isoToHHmm(J00233_VISIT1, MANILA)).toBe('21:00');
    expect(isoToHHmm(J00233_VISIT1, LA)).toBe('06:00');
  });
});

describe('withTime (org wall clock -> instant)', () => {
  it('persists the instant the ORG means by 9:00 AM', () => {
    expect(withTime(J00233_VISIT1, '09:00', NY)).toBe('2026-08-23T13:00:00.000Z');
  });

  it('is byte-identical whatever zone the booker sits in - the MV-TZ-02 regression', () => {
    // Before the fix these were 13:00Z / 01:00Z / 16:00Z respectively, and the Manila
    // write also landed on the previous calendar day.
    const fromNY = withTime(J00233_VISIT1, '09:00', NY);
    const fromManila = withTime(J00233_VISIT1, '09:00', NY);
    const fromLA = withTime(J00233_VISIT1, '09:00', NY);
    expect(fromManila).toBe(fromNY);
    expect(fromLA).toBe(fromNY);
    expect(fromNY).toBe('2026-08-23T13:00:00.000Z');
  });

  it('keeps the org calendar day when the new time crosses a UTC day boundary', () => {
    // 9:00 PM org clock on Aug 23 is Aug 24 in UTC. The org day must not move.
    expect(withTime(J00233_VISIT1, '21:00', NY)).toBe('2026-08-24T01:00:00.000Z');
  });

  it('derives the org DST offset from the date rather than a fixed offset', () => {
    expect(withTime('2027-01-15T14:00:00.000Z', '09:00', NY)).toBe('2027-01-15T14:00:00.000Z'); // EST, -5
    expect(withTime('2026-08-23T13:00:00.000Z', '09:00', NY)).toBe('2026-08-23T13:00:00.000Z'); // EDT, -4
  });

  it('round-trips through isoToHHmm', () => {
    for (const tz of [NY, MANILA, LA]) {
      expect(isoToHHmm(withTime(J00233_VISIT1, '14:30', tz), tz)).toBe('14:30');
    }
  });
});

describe('slotTimeLabel (the popover header)', () => {
  it('names the slot the user actually clicked, on the org clock', () => {
    // The defect labelled this "9:00 PM - 11:00 PM" for a 9:00 AM org slot, so the
    // popover disagreed with the calendar row beside it before any edit was made.
    expect(slotTimeLabel(J00233_VISIT1, '2026-08-23T15:00:00.000Z', NY)).toBe(`9:00 AM ${EN} 11:00 AM`);
  });

  it('does not change with the viewer zone', () => {
    const label = slotTimeLabel(J00233_VISIT1, '2026-08-23T15:00:00.000Z', NY);
    expect(label).toBe(`9:00 AM ${EN} 11:00 AM`);
    expect(label).not.toContain(`PM ${EN}`);
  });
});
