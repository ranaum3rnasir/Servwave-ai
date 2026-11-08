import { describe, it, expect } from 'vitest';
import { contrastRatio, compositeOver, rgbDistance, tintedChipColors } from '../contrast';
import { TAG_COLORS } from '@/lib/tag-colors';
import { token } from '../tokens';
import { eventCardColors } from '../eventCardColors';
import { EVENT_TYPE_META, type EventType } from '@/components/schedule/scheduleModel';

// The two describe blocks below this line test the HELPER FUNCTIONS with hardcoded hex
// literals - they prove contrastRatio/compositeOver/rgbDistance compute the right numbers, and
// nothing else. They do NOT move if a token in tokens.css/tokens.ts changes, so they cannot be
// the thing that catches a token regressing into an AA failure - that was exactly how the
// original --bronze-600 defect shipped (a number computed once, by hand, off to one side, never
// re-checked against a live value). The regression guards that DO read live tokens are further
// down this file, under "the LIVE design tokens".

describe('contrastRatio', () => {
  it('black vs white → 21:1 (the WCAG maximum)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });
  it('identical colors → 1:1 (no contrast)', () => {
    expect(contrastRatio('#5A5A2E', '#5A5A2E')).toBeCloseTo(1, 5);
  });
  it('is symmetric — argument order does not change the ratio', () => {
    expect(contrastRatio('#5A5A2E', '#EEF1F3')).toBeCloseTo(contrastRatio('#EEF1F3', '#5A5A2E'), 5);
  });
  it('a known WCAG-documented pair: #767676 on white is exactly 4.5:1', () => {
    // The canonical "just passes AA" grey from the WCAG spec itself.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.5, 1);
  });
});

describe('tintedChipColors', () => {
  // The task category chip: a tint of the stored color, dark text of the same hue on it. The old
  // solid chip put white on the color - 2.28:1 on #22C55E, 2.80:1 on #F97316, both failing AA.
  it.each(TAG_COLORS)('on %s: the text passes WCAG AA on the fill, and the fill is a light tint', (color) => {
    const chip = tintedChipColors(color)!;
    expect(contrastRatio(chip.text, chip.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(chip.fill, '#FFFFFF')).toBeLessThan(1.5);
    expect(chip.fill).not.toBe(color.toUpperCase());
  });

  it('keeps the hue: the text is a darker shade of the color, not black', () => {
    const { text } = tintedChipColors('#F97316')!;
    expect(text).not.toBe('#000000');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
  });

  it('answers null for a value that is not a 6-digit hex, instead of throwing', () => {
    expect(tintedChipColors('tomato')).toBeNull();
  });
});

describe('compositeOver', () => {
  it('alpha 1 → the foreground, unchanged', () => {
    expect(compositeOver('#5A5A2E', 1, '#EEF1F3')).toBe('#5a5a2e');
  });
  it('alpha 0 → the background, unchanged', () => {
    expect(compositeOver('#5A5A2E', 0, '#EEF1F3')).toBe('#eef1f3');
  });
  it('a 10% tint over a light canvas stays close to the canvas, not the foreground', () => {
    const mixed = compositeOver('#5A5A2E', 0.1, '#EEF1F3');
    // Sanity: the mixed color sits nearer the light canvas than the dark foreground.
    expect(rgbDistance(mixed, '#EEF1F3')).toBeLessThan(rgbDistance(mixed, '#5A5A2E'));
  });
});

describe('rgbDistance', () => {
  it('identical colors → 0', () => expect(rgbDistance('#5A5A2E', '#5A5A2E')).toBe(0));
  it('black vs white → the maximum, ≈441.67', () =>
    expect(rgbDistance('#000000', '#FFFFFF')).toBeCloseTo(441.67, 1));
});

/**
 * The LIVE design tokens (regression guard, calendar-entries §9 risk 4).
 *
 * `token()` resolves through tokens.ts's FALLBACKS map under vitest — frontend/vitest.config.ts
 * sets `css: false`, so no real stylesheet is ever loaded here, and FALLBACKS is kept honest by
 * the tokens-fallback-drift guard. So unlike the describes above, these tests MOVE when
 * tokens.css/tokens.ts change: proven by reverting `--event` to the original failing bronze
 * (139 111 71 / #8B6F47) and re-running this file — both tests below went red at 3.696:1 and
 * 23.6 (the exact numbers the defect shipped with), then green again on restore.
 */
describe('contrastRatio × the LIVE --event token', () => {
  const CANVAS = token('--background-light'); // the board canvas the card composites over
  const eventHex = token('--event');

  it('text-event on its own real 5% board tint (EVENT_TYPE_META\'s bg-event/5) clears WCAG AA', () => {
    expect(contrastRatio(eventHex, compositeOver(eventHex, 0.05, CANVAS))).toBeGreaterThanOrEqual(4.5);
  });
  it('text-event on its own real 10% board tint (SchedulePage.tsx\'s bg-event/10) clears WCAG AA', () => {
    expect(contrastRatio(eventHex, compositeOver(eventHex, 0.10, CANVAS))).toBeGreaterThanOrEqual(4.5);
  });
  it('the 10% tint does not collapse into the completed treatment\'s fill (neutral-surface)', () => {
    const tint10 = compositeOver(eventHex, 0.10, CANVAS);
    expect(rgbDistance(tint10, token('--neutral-surface'))).toBeGreaterThan(25);
  });
  it('stays separated from warning/amber — the near-collision (79.4/441) the old bronze shipped with', () => {
    expect(rgbDistance(eventHex, token('--warning'))).toBeGreaterThan(60);
  });
});

/**
 * Generalises the --event check across every EVENT_TYPE_META accent (§9 risk 4's real scope).
 *
 * HISTORY: this table used to measure each accent as text on a 10% tint of itself over the canvas
 * - the paint the board shipped - and pinned job/walkthrough/service-plan as `knownFailing: true`
 * at 2.92 / 3.88 / 3.26:1, with a note that a fix landing should flip them rather than "fix the
 * test" back to green. The fix landed (2026-09-30): cards no longer paint the accent on its own
 * tint, they paint the DERIVED card colours (eventCardColors.ts - an opaque fixed-lightness
 * surface and an in-hue text tone searched to clear 4.5:1). So the table now measures what the
 * card actually paints, and all four entries are `knownFailing: false`. The 10% figures are still
 * true of the raw tokens; no card uses that pairing any more. The ratchet shape stays: a type
 * whose derived pair ever drops under AA fails loud, and a type that has to be pinned failing
 * again is a visible, reviewable edit to this table.
 */
describe('EVENT_TYPE_META board accents — AA on the derived card colours they paint (table-driven)', () => {
  const cases: { type: EventType; label: string; tokenVar: string; knownFailing: boolean }[] = [
    { type: 'job', label: 'job (info)', tokenVar: '--info', knownFailing: false },
    { type: 'walkthrough', label: 'walkthrough (warning)', tokenVar: '--warning', knownFailing: false },
    { type: 'service-plan', label: 'service-plan (ai)', tokenVar: '--ai', knownFailing: false },
    { type: 'calendar-entry', label: 'calendar-entry (event)', tokenVar: '--event', knownFailing: false },
  ];

  for (const { type, label, tokenVar, knownFailing } of cases) {
    it(`${label}: EVENT_TYPE_META label "${EVENT_TYPE_META[type].label}" — AA ${knownFailing ? 'still fails (tracked)' : 'clears 4.5:1'}`, () => {
      const card = eventCardColors(token(tokenVar))!;
      const ratio = contrastRatio(card.text, card.surface);
      if (knownFailing) {
        expect(ratio).toBeLessThan(4.5);
      } else {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('the table covers every type the board paints', () => {
    expect(cases.map((c) => c.type).sort()).toEqual(Object.keys(EVENT_TYPE_META).sort());
  });
});
