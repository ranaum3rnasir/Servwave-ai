import { describe, expect, it } from 'vitest';

import { MAX_RANGE_DAYS, periodFromParams, periodLabel, resolvePreset, validateRange } from '../periods';

// 2026-10-13 03:30 UTC is still Oct 12 in Los Angeles but already Oct 13 in Manila.
const INSTANT = new Date('2026-10-13T03:30:00Z');

describe('presets are computed in the org timezone', () => {
  it('Last 7 days ends today in the org zone, whatever the browser zone is', () => {
    expect(resolvePreset('7', 'America/Los_Angeles', INSTANT)).toEqual({ from: '2026-10-06', to: '2026-10-12' });
    expect(resolvePreset('7', 'Asia/Manila', INSTANT)).toEqual({ from: '2026-10-07', to: '2026-10-13' });
  });

  it('Last N days covers exactly N calendar days, today included', () => {
    for (const n of [7, 30, 90] as const) {
      const r = resolvePreset(String(n) as '7' | '30' | '90', 'UTC', INSTANT);
      expect((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000 + 1).toBe(n);
    }
  });

  it('Last 30 and Last 90 days', () => {
    expect(resolvePreset('30', 'America/Los_Angeles', INSTANT)).toEqual({ from: '2026-09-13', to: '2026-10-12' });
    expect(resolvePreset('90', 'Asia/Manila', INSTANT)).toEqual({ from: '2026-07-16', to: '2026-10-13' });
  });

  it('This month runs from the 1st to today in the org zone', () => {
    expect(resolvePreset('month', 'America/Los_Angeles', INSTANT)).toEqual({ from: '2026-10-01', to: '2026-10-12' });
    // At the month boundary the org's month differs from the browser's.
    const edge = new Date('2026-11-01T02:00:00Z');
    expect(resolvePreset('month', 'America/Los_Angeles', edge)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolvePreset('month', 'Asia/Manila', edge)).toEqual({ from: '2026-11-01', to: '2026-11-01' });
  });
});

describe('the period in the URL', () => {
  const tz = 'America/Los_Angeles';
  const read = (qs: string) => periodFromParams(new URLSearchParams(qs), tz, INSTANT);

  it('defaults to Last 30 days', () => {
    expect(read('')).toEqual({ key: '30', from: '2026-09-13', to: '2026-10-12' });
  });

  it('reads a preset', () => {
    expect(read('period=90')).toMatchObject({ key: '90', from: '2026-07-15', to: '2026-10-12' });
  });

  it('reads a custom range', () => {
    expect(read('period=custom&from=2026-08-01&to=2026-08-01')).toEqual({ key: 'custom', from: '2026-08-01', to: '2026-08-01' });
  });

  it('falls back to Last 30 days for an unknown period or a bad custom range', () => {
    expect(read('period=bogus').key).toBe('30');
    expect(read('period=custom').key).toBe('30');
    expect(read('period=custom&from=2026-08-05&to=2026-08-01').key).toBe('30');
    expect(read('period=custom&from=2025-01-01&to=2026-12-31').key).toBe('30');
  });
});

describe('validateRange', () => {
  it('needs both dates, naming the first one missing', () => {
    expect(validateRange('', '2026-08-01')).toEqual({ field: 'from', message: 'Choose a start date' });
    expect(validateRange('2026-08-01', '')).toEqual({ field: 'to', message: 'Choose an end date' });
  });

  it('rejects an end before the start, on the end field', () => {
    expect(validateRange('2026-08-02', '2026-08-01')).toEqual({ field: 'to', message: 'End date can’t be before the start date' });
  });

  it('accepts a one-day range', () => {
    expect(validateRange('2026-08-01', '2026-08-01')).toBeNull();
  });

  it('accepts 366 days and rejects 367', () => {
    expect(MAX_RANGE_DAYS).toBe(366);
    expect(validateRange('2025-10-13', '2026-10-13')).toBeNull(); // 366 days counting both ends
    expect(validateRange('2025-10-12', '2026-10-13')).toEqual({ field: 'to', message: 'Choose a range of 366 days or less' });
  });
});

describe('periodLabel', () => {
  it('names a preset, and gives a custom range its own dates', () => {
    expect(periodLabel({ key: '7', from: '', to: '' })).toBe('Last 7 days');
    expect(periodLabel({ key: 'month', from: '', to: '' })).toBe('This month');
    expect(periodLabel({ key: 'custom', from: '2026-08-01', to: '2026-08-14' })).toBe('Aug 1 - Aug 14, 2026');
    expect(periodLabel({ key: 'custom', from: '2025-12-20', to: '2026-01-03' })).toBe('Dec 20, 2025 - Jan 3, 2026');
  });
});
