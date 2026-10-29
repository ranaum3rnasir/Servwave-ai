/**
 * The Schedule's shared board holds a FIXED set of bookings, booked at a FIXED hour.
 *
 * Mobile slice 75 follow-up 2: the gate shares one throwaway org and one technician. A spec that books
 * a walkthrough or a job for itself on the days the Schedule specs look at adds one more double-booked
 * card per device, retry and repeat; at about 26 cards a 360 px phone's last 20 px wide card sticks past
 * the screen and the double-booked self-check (which rightly does not excuse overflow) goes red. These
 * tests hold the rule from the outside, on the sources: a record a spec builds for itself is booked
 * 'apart' (a day of its own, far ahead), and only `seedGateFixtures` books on the 'board'.
 *
 * Mobile slice 85: the board used to be booked "24 hours from now", so the hour the gate RAN decided
 * where the cards sat (at 03:00 they sat above the 06:00 the grid opens at, under the toolbar). The
 * board is now booked at a fixed hour of the org's day, whatever hour the run starts at; these tests
 * hold that for every hour of the day, across a clock change and a date-line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APART_DAYS,
  BOARD_JOB_SLOT,
  BOARD_TIMEZONE_FALLBACK,
  BOARD_WALKTHROUGH_SLOT,
  FOUR_AT_ONCE,
  JOB_LENGTH_HOURS,
  MAX_CARDS_ON_SCREEN,
  bookedAt,
  instantAtWallClock,
  jobEnd,
} from '../../e2e/mobile/schedule-booking';

const MOBILE_DIR = path.resolve(__dirname, '..', '..', 'e2e', 'mobile');
const files = fs.readdirSync(MOBILE_DIR).filter((f) => f.endsWith('.ts'));
const read = (f: string) => fs.readFileSync(path.join(MOBILE_DIR, f), 'utf8');
/** Code only: a comment that talks about a call is not a call. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The wall clock of an instant in a zone, as 'YYYY-MM-DD HH:mm'. */
const wall = (d: Date, timeZone: string) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
};

describe('the board is booked at a fixed hour of the org day', () => {
  it('a known night run: 03:00 on 11 Oct (New York) books tomorrow 09:00 and the day after 09:00', () => {
    const now = new Date('2026-10-11T07:00:00Z'); // 03:00 EDT
    expect(bookedAt('board', BOARD_WALKTHROUGH_SLOT, 'America/New_York', now).toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(bookedAt('board', BOARD_JOB_SLOT, 'America/New_York', now).toISOString()).toBe('2026-10-13T13:00:00.000Z');
  });

  it.each(['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'Pacific/Auckland'])(
    'whatever hour the run starts at, %s sees the walkthroughs tomorrow at the same hour',
    (zone) => {
      for (let h = 0; h < 24; h++) {
        for (const minute of [0, 30, 59]) {
          // The run starts at h:minute on 14 Oct in THAT zone.
          const now = instantAtWallClock(2026, 10, 14, h, zone);
          now.setUTCMinutes(now.getUTCMinutes() + minute);
          const w = bookedAt('board', BOARD_WALKTHROUGH_SLOT, zone, now);
          expect(wall(w, zone), `run at ${h}:${minute} ${zone}`).toBe(`2026-10-15 ${String(BOARD_WALKTHROUGH_SLOT.hour).padStart(2, '0')}:00`);
          const j = bookedAt('board', BOARD_JOB_SLOT, zone, now);
          expect(wall(j, zone), `run at ${h}:${minute} ${zone}`).toBe(`2026-10-16 ${String(BOARD_JOB_SLOT.hour).padStart(2, '0')}:00`);
        }
      }
    },
  );

  it('the booking is by the ORG calendar: a run at 22:00 in New York is already the next day in UTC', () => {
    const now = new Date('2026-10-11T02:00:00Z'); // 22:00 EDT on 10 Oct
    expect(wall(bookedAt('board', BOARD_WALKTHROUGH_SLOT, 'America/New_York', now), 'America/New_York')).toBe('2026-10-11 09:00');
  });

  it('holds across the clocks changing (autumn and spring)', () => {
    // 1 Nov 2026: the clocks go back at 02:00 in New York. A run on 31 Oct evening books 1 Nov 09:00 EDT; a run on 1 Nov books 2 Nov 09:00 EST.
    expect(bookedAt('board', BOARD_WALKTHROUGH_SLOT, 'America/New_York', new Date('2026-11-01T05:30:00Z')).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(bookedAt('board', BOARD_WALKTHROUGH_SLOT, 'America/New_York', new Date('2026-10-31T23:00:00Z')).toISOString()).toBe('2026-11-01T14:00:00.000Z');
    // 8 Mar 2026: the clocks go forward at 02:00. A run on 7 Mar books 8 Mar 09:00 EDT.
    expect(bookedAt('board', BOARD_WALKTHROUGH_SLOT, 'America/New_York', new Date('2026-03-07T20:00:00Z')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('a job ends two hours after it starts', () => {
    const start = bookedAt('board', BOARD_JOB_SLOT, 'America/New_York', new Date('2026-10-11T07:00:00Z'));
    expect(jobEnd(start).getTime() - start.getTime()).toBe(JOB_LENGTH_HOURS * 3_600_000);
    expect(JOB_LENGTH_HOURS).toBe(2);
  });

  it('the fallback zone is the Schedule page\'s own fallback', () => {
    const tz = read('../../src/lib/schedule-tz-intl.ts').match(/DEFAULT_SCHEDULE_TIMEZONE\s*=\s*'([^']+)'/);
    expect(tz?.[1]).toBe(BOARD_TIMEZONE_FALLBACK);
  });

  it('the set sits well inside the hours the Schedule opens on, so it is on screen on every device', () => {
    // The page opens on DEFAULT_WINDOW and scrolls the grid to its first hour (SchedulePage.tsx). A card
    // above that hour is scrolled out of the grid; one after the last hour is below it. A phone shows
    // only a few hours of it, so the set sits near the top: at least one hour after the window opens,
    // and the longest job ends at least three hours before it closes.
    const page = read('../../src/pages/v2/schedule/SchedulePage.tsx').match(/const DEFAULT_WINDOW = \{ start: (\d+) \* 60, end: (\d+) \* 60 \}/);
    expect(page, 'SchedulePage.tsx DEFAULT_WINDOW not found: update this guard with it').toBeTruthy();
    const [opens, closes] = [Number(page![1]), Number(page![2])];
    for (const slot of [BOARD_WALKTHROUGH_SLOT, BOARD_JOB_SLOT]) {
      expect(slot.hour).toBeGreaterThanOrEqual(opens + 1);
      expect(slot.hour + JOB_LENGTH_HOURS).toBeLessThanOrEqual(closes - 3);
    }
    // Both on the days the self-check reaches by stepping, and not on the same day (a walkthrough day and a job day).
    expect(BOARD_WALKTHROUGH_SLOT.daysAhead).toBe(1);
    expect(BOARD_JOB_SLOT.daysAhead).toBe(2);
  });
});

describe('apart', () => {
  it('is more than a year ahead, whatever the hour of the run, past every step a Schedule spec takes', () => {
    for (const hour of [0, 3, 12, 23]) {
      const now = new Date(Date.UTC(2026, 9, 14, hour, 15));
      for (const slot of [BOARD_WALKTHROUGH_SLOT, BOARD_JOB_SLOT]) {
        expect(bookedAt('apart', slot, 'America/New_York', now).getTime() - now.getTime()).toBeGreaterThan(366 * 24 * 3_600_000);
      }
    }
    // The self-check steps at most four periods; the largest period a phone shows is a month.
    expect(APART_DAYS).toBeGreaterThan(4 * 31);
  });

  it('a walkthrough and a job apart are on different days', () => {
    const now = new Date('2026-10-11T07:00:00Z');
    expect(bookedAt('apart', BOARD_JOB_SLOT, 'America/New_York', now).getTime()).toBeGreaterThan(bookedAt('apart', BOARD_WALKTHROUGH_SLOT, 'America/New_York', now).getTime());
  });
});

describe('the on-screen promise', () => {
  it('leaves room for the four-at-once case and no more than the fixed set', () => {
    expect(FOUR_AT_ONCE).toBe(4);
    expect(MAX_CARDS_ON_SCREEN).toBeGreaterThan(FOUR_AT_ONCE);
    // Well under the 26 cards at which a 360 px screen is overrun.
    expect(MAX_CARDS_ON_SCREEN).toBeLessThan(20);
  });
});

describe('who books on the shared board', () => {
  it('sentEstimate and scheduledJob book apart unless told otherwise', () => {
    const seed = code('seed.ts');
    expect(seed).toMatch(/export async function sentEstimate\([^)]*booking: Booking = 'apart'/);
    expect(seed).toMatch(/export async function scheduledJob\([^)]*booking: Booking = 'apart'/);
  });

  it("no spec asks for the 'board' (only seed.ts, which seeds the fixed set once per run)", () => {
    const offenders = files
      .filter((f) => f !== 'seed.ts' && f !== 'schedule-booking.ts')
      .filter((f) => /\b(sentEstimate|scheduledJob)\([^)]*'board'/.test(code(f)));
    expect(offenders, 'a spec that books on the shared board adds a double-booked card per device, retry and repeat').toEqual([]);
  });

  it('no spec books a walkthrough or a job slot itself: it goes through the seed helpers', () => {
    // visual-setup.ts seeds the separate visual-baseline org with fixed 2026 dates; it is not this board.
    const offenders = files
      .filter((f) => !['seed.ts', 'visual-setup.ts', 'schedule-booking.ts'].includes(f))
      .filter((f) => /\.(scheduleWalkthrough|assignJob)\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('seed.ts books every visit through bookedAt, never a bare futureDate or a clock of its own', () => {
    const seed = code('seed.ts');
    expect(seed).not.toMatch(/futureDate\(/);
    expect(seed).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(seed).toMatch(/walkthrough_scheduled_at:\s*[^,}]*await visitStart\(api, booking, BOARD_WALKTHROUGH_SLOT\)/);
    expect(seed).toMatch(/scheduled_start:\s*[^,}]*start\.toISOString\(\)/);
    expect(seed).toMatch(/scheduled_end:\s*[^,}]*jobEnd\(start\)\.toISOString\(\)/);
    expect(seed).toMatch(/const start = await visitStart\(api, booking, BOARD_JOB_SLOT\)/);
  });

  it('the board is booked in the org\'s own zone', () => {
    const seed = code('seed.ts');
    expect(seed).toMatch(/\/api\/organization/);
    expect(seed).toMatch(/BOARD_TIMEZONE_FALLBACK/);
  });

  it("seedGateFixtures is the only place that books the 'board'", () => {
    const seed = code('seed.ts');
    // invoicedJob (the paid and the open job), the scheduled job, the open estimate: four walkthroughs, three jobs.
    expect([...seed.matchAll(/\b(?:sentEstimate|scheduledJob)\(api, techId, 'board'\)/g)]).toHaveLength(3);
  });
});
