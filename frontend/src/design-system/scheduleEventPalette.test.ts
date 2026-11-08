import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCHEDULE_EVENT_PALETTE, isScheduleEventPaletteToken } from './scheduleEventPalette';

const sheets = ['tokens.css', 'tokens-v2.css'].map((f) =>
  readFileSync(join(__dirname, f), 'utf8'),
);

/** True when some token sheet defines `--<token>: r g b` on a line of its own. */
function definedAsTriple(token: string): boolean {
  return sheets.some((css) =>
    css
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith(`--${token}:`) && /:\s*\d+ \d+ \d+/.test(line)),
  );
}

describe('SCHEDULE_EVENT_PALETTE - the org picks from what the design system ships', () => {
  // The whole point of storing a token NAME is that it resolves. A name with no definition
  // renders `rgb(var(--nothing))`, which is invalid, and the card silently loses its colour.
  it('every token is defined as a channel triple in a token sheet', () => {
    for (const { token } of SCHEDULE_EVENT_PALETTE) {
      expect(
        definedAsTriple(token),
        `--${token} is not defined as "r g b" in tokens.css or tokens-v2.css`,
      ).toBe(true);
    }
  });

  it('never offers the reserved reds', () => {
    const tokens = SCHEDULE_EVENT_PALETTE.map((e) => e.token);
    expect(tokens).not.toContain('terracotta'); // --danger / the needs-crew notch
    expect(tokens).not.toContain('danger');
    expect(tokens).not.toContain('understaffed');
    expect(tokens).not.toContain('notify-rose'); // notification badges only
    expect(tokens).not.toContain('status-red');
  });

  it('has no duplicate tokens and every entry is labelled', () => {
    const tokens = SCHEDULE_EVENT_PALETTE.map((e) => e.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const { label } of SCHEDULE_EVENT_PALETTE) expect(label.length).toBeGreaterThan(0);
  });

  it('isScheduleEventPaletteToken accepts the palette and nothing else', () => {
    expect(isScheduleEventPaletteToken('sage-700')).toBe(true);
    expect(isScheduleEventPaletteToken('terracotta')).toBe(false);
    expect(isScheduleEventPaletteToken('#2563EB')).toBe(false);
    expect(isScheduleEventPaletteToken(undefined)).toBe(false);
    expect(isScheduleEventPaletteToken(42)).toBe(false);
  });

  // The API validates with its own copy of this list. Pin the exact contents here so a change on
  // either side has to be made deliberately on both - see SCHEDULE_EVENT_COLOR_TOKENS in
  // backend/src/controllers/organization.controller.ts.
  it('matches the API enum entry for entry', () => {
    expect(SCHEDULE_EVENT_PALETTE.map((e) => e.token)).toEqual([
      'info', 'status-blue', 'ocean-700',
      'sage-700', 'status-green', 'sage-500',
      'amber-700', 'status-amber',
      'indigo-600', 'status-purple',
      'olive-700', 'status-slate',
    ]);
  });
});
