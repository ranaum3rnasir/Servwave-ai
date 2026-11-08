import { describe, it, expect } from 'vitest';
import { contrastRatio } from '../contrast';
import { token } from '../tokens';
import { eventCardColors, cssColorToHex, hexToChannels, EVENT_CARD_PAGE } from '../eventCardColors';
import { SCHEDULE_EVENT_PALETTE } from '../scheduleEventPalette';
import reference from './fixtures/event-card-palette.json';

/**
 * The card-colour rule (eventCardColors.ts) over EVERY colour an org can pick, plus the four
 * defaults the board paints when nothing is picked.
 *
 * The seeds are resolved through `token()`, so under vitest they come from tokens.ts's FALLBACKS
 * (kept honest against the CSS by tokens-fallback-drift.test.ts) - retune a palette token and
 * this table re-measures it.
 *
 * The fixture is the output of the reference implementation the rule was designed with (the
 * 2026-09-30 event-colour research, eventcolor.py / palette-json.py). Its `today` block is the
 * old paint (seed text on a 10% tint of itself) kept for the record; `aa.fg` is the 4.5 target
 * this ships, `aaa` the 7:1 alternative the owner did not pick.
 */
const PALETTE = SCHEDULE_EVENT_PALETTE.map((e) => e.token);
const DEFAULTS = ['info', 'warning', 'ai', 'event']; // job, walkthrough, service plan, calendar entry
const SEEDS = [...PALETTE, ...DEFAULTS].map((name) => {
  const hex = cssColorToHex(token(`--${name}`));
  return { name, hex: hex! };
});
const RING = token('--warning'); // the double-booked outline

describe('eventCardColors - every palette token and every default', () => {
  it('resolves every seed to a real colour, not the token() black fallback', () => {
    for (const { name, hex } of SEEDS) {
      expect(hex, name).toMatch(/^#[0-9A-F]{6}$/);
      expect(hex, `${name} fell through to the missing-token fallback`).not.toBe(cssColorToHex('0 0 0'));
    }
  });

  it.each(SEEDS)('$name: text clears 4.5:1 on the surface', ({ hex }) => {
    const c = eventCardColors(hex)!;
    expect(contrastRatio(c.text, c.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('$name: the left border clears 3:1 on the surface AND on the white board', ({ hex }) => {
    const c = eventCardColors(hex)!;
    expect(contrastRatio(c.border, c.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c.border, EVENT_CARD_PAGE)).toBeGreaterThanOrEqual(3);
  });

  it.each(SEEDS)('$name: the solid fill carries its text at 4.5:1', ({ hex }) => {
    const c = eventCardColors(hex)!;
    expect(contrastRatio(c.onSolid, c.solid)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('$name: the amber double-booked outline clears 3:1 on the surface', ({ hex }) => {
    const c = eventCardColors(hex)!;
    expect(contrastRatio(RING, c.surface)).toBeGreaterThanOrEqual(3);
  });

  it('the surface is a light, opaque tint - never the seed and never darker than the text', () => {
    for (const { hex } of SEEDS) {
      const c = eventCardColors(hex)!;
      expect(c.surface).not.toBe(hex);
      expect(contrastRatio(c.surface, EVENT_CARD_PAGE)).toBeLessThan(1.25);
    }
  });
});

describe('eventCardColors - matches the reference implementation', () => {
  it('covers exactly the 12-token palette', () => {
    expect(reference.map((r) => r.token)).toEqual(PALETTE);
  });

  it.each(reference)('$token ($seed): surface, text and border equal the reference output', (row) => {
    // The fixture's seed must still be the token's live value, or this compares against a stale row.
    expect(cssColorToHex(token(`--${row.token}`))).toBe(row.seed);
    const c = eventCardColors(row.seed)!;
    expect({ surface: c.surface, text: c.text, border: c.border }).toEqual({
      surface: row.surface,
      text: row.aa.fg,
      border: row.border,
    });
    expect(contrastRatio(c.text, c.surface)).toBeCloseTo(row.aa.r, 2);
    expect(contrastRatio(RING, c.surface)).toBeCloseTo(row.ring, 1);
  });

  it('the old paint really did fail: 7 of the 12 fell below 4.5 on their own 10% tint over white', () => {
    // Over the white board, the most forgiving background the card ever sits on.
    expect(reference.filter((r) => r.today.r < 4.5)).toHaveLength(7);
  });
});

describe('eventCardColors - the solid rule', () => {
  it('keeps white text on the job default by DARKENING the fill, not by switching to black', () => {
    // #3B82F6 carries white at only 3.68, and WCAG's own pick would be black (5.71) - which
    // reads worse on a mid blue. The rule darkens the fill until white clears instead.
    const c = eventCardColors(cssColorToHex(token('--info'))!)!;
    expect(c.onSolid).toBe(cssColorToHex('255 255 255'));
    expect(c.solid).not.toBe(cssColorToHex(token('--info')));
    expect(contrastRatio(c.onSolid, c.solid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.onSolid, c.solid)).toBeLessThan(4.7); // the least darkening that passes
  });

  it('keeps a seed that already carries white exactly as picked', () => {
    const c = eventCardColors(cssColorToHex(token('--ocean-700'))!)!;
    expect(c.solid).toBe(cssColorToHex(token('--ocean-700')));
  });

  it('gives a light seed (OKLCH L >= 0.70) black text on its own fill', () => {
    // A light yellow: white on it is ~1.9, and darkening it far enough for white would turn it brown.
    const c = eventCardColors('#EAB308')!;
    expect(c.solid).toBe('#EAB308');
    expect(c.onSolid).toBe('#000000');
  });
});

describe('eventCardColors - any seed, not just the palette', () => {
  // Custom colours are not offered today, but the rule must not depend on that: a 4-bit grid of
  // sRGB (4096 seeds) is the whole space at the resolution a person can tell apart on a card.
  it('every seed in a 16-level RGB grid meets all three targets', () => {
    const levels = Array.from({ length: 16 }, (_, i) => (i * 17).toString(16).padStart(2, '0'));
    const failures: string[] = [];
    for (const r of levels) for (const g of levels) for (const b of levels) {
      const seed = `#${r}${g}${b}`;
      const c = eventCardColors(seed)!;
      if (contrastRatio(c.text, c.surface) < 4.5) failures.push(`${seed} text`);
      if (contrastRatio(c.border, c.surface) < 3 || contrastRatio(c.border, EVENT_CARD_PAGE) < 3) failures.push(`${seed} border`);
      if (contrastRatio(c.onSolid, c.solid) < 4.5) failures.push(`${seed} solid`);
    }
    expect(failures).toEqual([]);
  });

  it('answers null for anything that is not a 6-digit hex', () => {
    expect(eventCardColors('tomato')).toBeNull();
    expect(eventCardColors('var(--info)')).toBeNull();
  });

  it('is memoised: the same seed returns the same object', () => {
    expect(eventCardColors('#3b82f6')).toBe(eventCardColors('#3B82F6'));
  });
});

describe('cssColorToHex / hexToChannels', () => {
  it('reads every shape token() can hand back', () => {
    expect(cssColorToHex('#3b82f6')).toBe('#3B82F6');
    expect(cssColorToHex('rgb(59 130 246)')).toBe('#3B82F6');
    expect(cssColorToHex('rgb(59, 130, 246)')).toBe('#3B82F6');
    expect(cssColorToHex('59 130 246')).toBe('#3B82F6');
    expect(cssColorToHex('rgb(59 130 246 / 0.5)')).toBe('#3B82F6');
    expect(cssColorToHex('var(--info)')).toBeNull();
  });
  it('writes the channel form the colour tokens use', () => {
    expect(hexToChannels('#3B82F6')).toBe('59 130 246');
  });
});
