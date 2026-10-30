import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { timeLeft, useNow } from '../timeLeft';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('timeLeft', () => {
  it('is "Past due" once the deadline has passed, and at the exact instant', () => {
    expect(timeLeft(at(-HOUR), NOW)).toEqual({ text: 'Past due', urgent: false });
    expect(timeLeft(at(0), NOW)).toEqual({ text: 'Past due', urgent: false });
  });

  it('never reads below 1 hour: 59 minutes is "1 hour left" and urgent', () => {
    expect(timeLeft(at(59 * 60_000), NOW)).toEqual({ text: '1 hour left', urgent: true });
  });

  it('counts whole hours under 48 hours, urgent', () => {
    expect(timeLeft(at(5 * HOUR + 1000), NOW)).toEqual({ text: '5 hours left', urgent: true });
    expect(timeLeft(at(47 * HOUR), NOW)).toEqual({ text: '47 hours left', urgent: true });
    expect(timeLeft(at(48 * HOUR - 1000), NOW)).toEqual({ text: '47 hours left', urgent: true });
  });

  it('switches to whole days (rounded down) from 48 hours, not urgent', () => {
    expect(timeLeft(at(48 * HOUR), NOW)).toEqual({ text: '2 days left', urgent: false });
    expect(timeLeft(at(49 * HOUR), NOW)).toEqual({ text: '2 days left', urgent: false });
    expect(timeLeft(at(5 * 24 * HOUR), NOW)).toEqual({ text: '5 days left', urgent: false });
  });

  it('accepts a Date as the clock and returns nothing for a missing or unreadable deadline', () => {
    expect(timeLeft(at(48 * HOUR), new Date(NOW))).toEqual({ text: '2 days left', urgent: false });
    expect(timeLeft(null, NOW)).toBeNull();
    expect(timeLeft('not a date', NOW)).toBeNull();
  });
});

describe('useNow', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks on the interval and clears its timer on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { result, unmount } = renderHook(() => useNow(60_000));
    expect(result.current).toBe(NOW);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current).toBe(NOW + 60_000);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
