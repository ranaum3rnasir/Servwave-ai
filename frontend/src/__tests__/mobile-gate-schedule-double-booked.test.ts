/**
 * Mobile slice 75 follow-up: the Schedule is enforced on every device, with the double-booked cards
 * as ONE narrow, documented exception (Ran, 2026-10-08, Option A).
 *
 * The three Schedule route/check pairs used to sit in report mode, which switched the whole check
 * off for the whole route: any new small control, or any other unreachable element, would have
 * passed unnoticed. They are enforced now; `e2e/mobile/schedule-double-booked.ts` excuses only a
 * target-size or covered-last-control finding that is a calendar event card overlapping another
 * card in time. Every case is tried both ways here: what is excused, and what must still fail.
 */
import { describe, expect, it } from 'vitest';
import {
  exemptLine,
  isDoubleBooked,
  overlapInTime,
  splitA11yNodes,
  splitScrollReachOffenders,
  splitTargetOffenders,
  type CardFact,
} from '../../e2e/mobile/schedule-double-booked';

/** A card in `column`, from `top` to `bottom`, `width` px wide. */
const card = (column: number, top: number, bottom: number, width = 22): CardFact => ({ column, top, bottom, width, height: bottom - top });

// Four jobs at the same time in Monday's column (the 20 to 26 px wide cards of Ran's ruling), one job
// alone in Tuesday's column, one job that starts when the first four end.
const CARDS: CardFact[] = [
  card(1, 200, 260), // 0  double-booked
  card(1, 200, 260), // 1  double-booked
  card(1, 200, 260), // 2  double-booked
  card(1, 200, 260), // 3  double-booked
  card(2, 200, 260), // 4  Tuesday, alone
  card(1, 260, 320), // 5  Monday, starts as the others end
];

const small = (name: string) => `under 24px and crowded: div[role=button] "${name}" 22x60`;

describe('what makes a card double-booked', () => {
  it('two cards in one day column that share a stretch of time overlap', () => {
    expect(overlapInTime(CARDS, 0, 1)).toBe(true);
    expect(isDoubleBooked(CARDS, 0)).toBe(true);
    expect(isDoubleBooked(CARDS, 3)).toBe(true);
  });

  it('a partial overlap counts', () => {
    const cards = [card(0, 100, 200), card(0, 150, 250)];
    expect(isDoubleBooked(cards, 0)).toBe(true);
    expect(isDoubleBooked(cards, 1)).toBe(true);
  });

  it('a lone card does not overlap', () => {
    expect(isDoubleBooked(CARDS, 4)).toBe(false);
  });

  it('a card at the same time in ANOTHER day column does not overlap', () => {
    expect(overlapInTime(CARDS, 0, 4)).toBe(false);
  });

  it('a card that starts where the other ends (touching, not sharing time) does not overlap', () => {
    expect(overlapInTime(CARDS, 0, 5)).toBe(false);
    expect(isDoubleBooked(CARDS, 5)).toBe(false);
  });

  it('a card with no size on screen overlaps nothing, and a card never overlaps itself', () => {
    const cards = [card(0, 100, 200), { column: 0, top: 100, bottom: 200, width: 0, height: 0 }];
    expect(isDoubleBooked(cards, 0)).toBe(false);
    expect(overlapInTime(cards, 0, 0)).toBe(false);
  });

  it('an index that is not a card overlaps nothing', () => {
    expect(isDoubleBooked(CARDS, -1)).toBe(false);
    expect(overlapInTime(CARDS, 0, -1)).toBe(false);
  });
});

describe('targets: only a sub-24 px finding on a double-booked card is excused', () => {
  it('an overlapping-card offender is exempt', () => {
    const offenders = [small('Job A'), small('Job B')];
    const r = splitTargetOffenders(offenders, [0, 1], CARDS);
    expect(r.exempt).toEqual(offenders);
    expect(r.offenders).toEqual([]);
  });

  it('a control INSIDE a double-booked card is exempt too (the offender points at its card)', () => {
    expect(splitTargetOffenders([small('Needs crew')], [2], CARDS).exempt).toHaveLength(1);
  });

  it('a lone small card still fails', () => {
    const r = splitTargetOffenders([small('Lone job')], [4], CARDS);
    expect(r.exempt).toEqual([]);
    expect(r.offenders).toEqual([small('Lone job')]);
  });

  it('a card that only touches another card still fails', () => {
    expect(splitTargetOffenders([small('Later job')], [5], CARDS).exempt).toEqual([]);
  });

  it('a small toolbar control (not in any card) still fails', () => {
    const toolbar = 'under 24px and crowded: button "Week" 22x22';
    const r = splitTargetOffenders([toolbar], [-1], CARDS);
    expect(r.exempt).toEqual([]);
    expect(r.offenders).toEqual([toolbar]);
  });

  it('a control with no card information still fails (the probe is missing)', () => {
    expect(splitTargetOffenders([small('x')], undefined, CARDS).exempt).toEqual([]);
    expect(splitTargetOffenders([small('x')], [], CARDS).exempt).toEqual([]);
  });

  it('the 44 px primary-control rule is never excused, even on a double-booked card', () => {
    const primary = 'primary touch control under 44px: div[role=button] "Job A" 22x60';
    const r = splitTargetOffenders([primary], [0], CARDS);
    expect(r.exempt).toEqual([]);
    expect(r.offenders).toEqual([primary]);
  });

  it('a mixed list is split offender by offender, in order', () => {
    const toolbar = 'under 24px and crowded: button "Today" 20x20';
    const r = splitTargetOffenders([small('A'), toolbar, small('Lone')], [0, -1, 4], CARDS);
    expect(r.exempt).toEqual([small('A')]);
    expect(r.offenders).toEqual([toolbar, small('Lone')]);
  });
});

describe('a11y: only target-size nodes on double-booked cards are excused', () => {
  it('target-size nodes that are overlapping cards are exempt', () => {
    expect(splitA11yNodes('target-size', [0, 1, 3], CARDS)).toEqual({ keep: [], exempt: [0, 1, 2] });
  });

  it('a target-size node that is a lone card, or not a card, stays a failure', () => {
    expect(splitA11yNodes('target-size', [0, 4, -1], CARDS)).toEqual({ keep: [1, 2], exempt: [0] });
  });

  it('a different axe rule on an overlapping card is NOT exempt', () => {
    for (const rule of ['color-contrast', 'aria-allowed-role', 'scrollable-region-focusable', 'label', 'button-name']) {
      expect(splitA11yNodes(rule, [0, 1, 2], CARDS), rule).toEqual({ keep: [0, 1, 2], exempt: [] });
    }
  });
});

describe('scrollReach: only a card covered by another overlapping card is excused', () => {
  const covered = (by: string) => `last control "Job B" is covered by ${by}`;

  it('the last control covered by another card that overlaps it in time is exempt', () => {
    const o = covered('div.rbc-event.bg-job');
    const r = splitScrollReachOffenders([o], { last: 0, hit: 3 }, CARDS);
    expect(r.exempt).toEqual([o]);
    expect(r.offenders).toEqual([]);
  });

  it('covered by a non-card element (the events layer, a toolbar, a popover) still fails', () => {
    const o = covered('div.rbc-events-container');
    const r = splitScrollReachOffenders([o], { last: 0, hit: -1 }, CARDS);
    expect(r.exempt).toEqual([]);
    expect(r.offenders).toEqual([o]);
  });

  it('covered by a card that does NOT overlap it in time still fails', () => {
    expect(splitScrollReachOffenders([covered('div.rbc-event')], { last: 0, hit: 4 }, CARDS).exempt).toEqual([]);
    expect(splitScrollReachOffenders([covered('div.rbc-event')], { last: 0, hit: 5 }, CARDS).exempt).toEqual([]);
  });

  it('a last control that is not a card, covered by a card, still fails', () => {
    expect(splitScrollReachOffenders([covered('div.rbc-event')], { last: -1, hit: 0 }, CARDS).exempt).toEqual([]);
  });

  it('a card covered by itself is not "another card"', () => {
    expect(splitScrollReachOffenders([covered('div.rbc-event')], { last: 1, hit: 1 }, CARDS).exempt).toEqual([]);
  });

  it('a control left off screen is never excused, even when cards overlap', () => {
    const off = 'last control "Job B" stays off screen at the bottom of the scroller (900..960 in 768)';
    const r = splitScrollReachOffenders([off], { last: 0, hit: 3 }, CARDS);
    expect(r.exempt).toEqual([]);
    expect(r.offenders).toEqual([off]);
  });

  it('with no cover information nothing is excused', () => {
    expect(splitScrollReachOffenders([covered('div.rbc-event')], undefined, CARDS).exempt).toEqual([]);
  });
});

describe('the EXEMPT line', () => {
  it('names the exception and counts the excused offenders', () => {
    const line = exemptLine('targets', [small('A'), small('B'), small('C')]);
    expect(line).toMatch(/^ {2}EXEMPT scheduleDoubleBooked: 3 targets offender\(s\) on double-booked event cards/);
    expect(line).toContain('accepted exception (allowlist.json acceptedExceptions)');
  });

  it('carries no vendor name', () => {
    expect(exemptLine('a11y', ['target-size (serious): 4 node(s)'])).not.toMatch(/ctm|calltracking|supabase|render|vercel|twilio|resend|stripe/i);
  });
});
