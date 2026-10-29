/** Mobile slice 42 - the per-day counts behind a phone-width Month cell. */
import { describe, it, expect } from 'vitest';

import { dayKey, eventsPerDay, monthCellLabel } from '../monthDayCounts';

const at = (d: string, h = 0, m = 0) => {
  const [y = 0, mo = 1, da = 1] = d.split('-').map(Number);
  return new Date(y, mo - 1, da, h, m);
};

describe('eventsPerDay', () => {
  it('counts each event on the day it falls on', () => {
    const counts = eventsPerDay([
      { start: at('2026-10-07', 9), end: at('2026-10-07', 10) },
      { start: at('2026-10-07', 13), end: at('2026-10-07', 14) },
      { start: at('2026-10-08', 9), end: at('2026-10-08', 10) },
    ]);
    expect(counts.get('2026-10-07')).toBe(2);
    expect(counts.get('2026-10-08')).toBe(1);
    expect(counts.get('2026-10-09')).toBeUndefined();
  });

  it('counts a multi-day event on every day it touches', () => {
    const counts = eventsPerDay([{ start: at('2026-10-07', 9), end: at('2026-10-09', 17) }]);
    expect([...counts.keys()].sort()).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
  });

  it('treats an end at midnight as exclusive', () => {
    const counts = eventsPerDay([{ start: at('2026-10-07'), end: at('2026-10-08') }]);
    expect([...counts.keys()]).toEqual(['2026-10-07']);
  });

  it('counts an instant event on its own day', () => {
    const counts = eventsPerDay([{ start: at('2026-10-07', 9), end: at('2026-10-07', 9) }]);
    expect(counts.get('2026-10-07')).toBe(1);
  });
});

describe('monthCellLabel', () => {
  it('names the date and the count for a screen reader', () => {
    expect(monthCellLabel(at('2026-10-07'), 3)).toBe('Wednesday, October 7, 3 events');
    expect(monthCellLabel(at('2026-10-07'), 1)).toBe('Wednesday, October 7, 1 event');
    expect(monthCellLabel(at('2026-10-07'), 0)).toBe('Wednesday, October 7, no events');
  });

  it('keys a day the same way the counter does', () => {
    expect(dayKey(at('2026-10-07', 23, 59))).toBe('2026-10-07');
  });
});
