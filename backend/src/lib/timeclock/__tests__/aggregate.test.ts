import { describe, it, expect } from 'vitest';
import { aggregate } from '../aggregate';
import type { PunchLike } from '../types';

const HOUR = 3600000;
const NY = 'America/New_York';

function p(userId: string, type: 'IN' | 'OUT', ts: number): PunchLike {
  return { userId, type, ts };
}

// 14:00:00Z (= 10:00 EDT) on a given June 2026 day — same NY calendar day, unambiguous.
function utc(day: number, hour = 14): number {
  return Date.parse(`2026-06-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`);
}

describe('aggregate — shift pairing', () => {
  it('pairs a single IN→OUT into one shift with correct hours', () => {
    const start = utc(15);
    const out = aggregate([p('u1', 'IN', start), p('u1', 'OUT', start + 8 * HOUR)], NY);
    expect(out.shifts).toHaveLength(1);
    expect(out.shifts[0]!.userId).toBe('u1');
    expect(out.shifts[0]!.start).toBe(start);
    expect(out.shifts[0]!.end).toBe(start + 8 * HOUR);
    expect(out.shifts[0]!.hours).toBeCloseTo(8, 9);
  });

  it('leaves a trailing unpaired IN as an OPEN shift — never fabricates an OUT', () => {
    const start = utc(15);
    const out = aggregate([p('u1', 'IN', start)], NY);
    expect(out.shifts).toHaveLength(1);
    expect(out.shifts[0]!.end).toBeNull();
    expect(out.shifts[0]!.hours).toBe(0);
  });

  it('auto-closes a prior open IN when a second IN arrives (still no fabricated OUT)', () => {
    const out = aggregate(
      [p('u1', 'IN', utc(15)), p('u1', 'IN', utc(15, 16)), p('u1', 'OUT', utc(15, 18))],
      NY,
    );
    expect(out.shifts).toHaveLength(2);
    expect(out.shifts[0]!.end).toBeNull();
    expect(out.shifts[0]!.hours).toBe(0);
    expect(out.shifts[1]!.hours).toBeCloseTo(2, 9);
  });

  it('ignores an OUT with no open IN', () => {
    const out = aggregate(
      [p('u1', 'OUT', utc(15, 9)), p('u1', 'IN', utc(15, 14)), p('u1', 'OUT', utc(15, 15))],
      NY,
    );
    expect(out.shifts).toHaveLength(1);
    expect(out.shifts[0]!.hours).toBeCloseTo(1, 9);
  });
});

describe('aggregate — daily/weekly buckets', () => {
  it('sums two shifts on the same local day into dailyHours', () => {
    const out = aggregate(
      [
        p('u1', 'IN', utc(15, 9)),
        p('u1', 'OUT', utc(15, 12)), // 3h
        p('u1', 'IN', utc(15, 13)),
        p('u1', 'OUT', utc(15, 16)), // 3h
      ],
      NY,
    );
    expect(out.dailyHours['u1:2026-06-15']).toBeCloseTo(6, 9);
    expect(out.weeklyHours['u1:2026-W25']).toBeCloseTo(6, 9);
  });

  it('computes weekly overtime as total-40 when a week crosses 40h', () => {
    // Five 9h shifts Mon–Fri (June 15–19, all ISO week 2026-W25) = 45h.
    const punches: PunchLike[] = [];
    for (const d of [15, 16, 17, 18, 19]) {
      punches.push(p('u1', 'IN', utc(d, 13)), p('u1', 'OUT', utc(d, 22))); // 13:00→22:00Z = 9h
    }
    const out = aggregate(punches, NY);
    expect(out.weeklyHours['u1:2026-W25']).toBeCloseTo(45, 9);
    expect(out.weeklyOtHours['u1:2026-W25']).toBeCloseTo(5, 9);
  });

  it('reports zero weekly overtime under 40h', () => {
    const out = aggregate([p('u1', 'IN', utc(15, 13)), p('u1', 'OUT', utc(15, 21))], NY); // 8h
    expect(out.weeklyHours['u1:2026-W25']).toBeCloseTo(8, 9);
    expect(out.weeklyOtHours['u1:2026-W25']).toBe(0);
  });

  it('buckets a shift by its start day even when it spans local midnight', () => {
    // 23:00Z June 15 (19:00 EDT, NY = 2026-06-15) → 03:00Z June 16 (8h shift crossing midnight).
    const start = Date.parse('2026-06-15T23:00:00Z');
    const end = Date.parse('2026-06-16T03:00:00Z');
    const out = aggregate([p('u1', 'IN', start), p('u1', 'OUT', end)], NY);
    expect(out.dailyHours['u1:2026-06-15']).toBeCloseTo(4, 9);
    expect(out.dailyHours['u1:2026-06-16']).toBeUndefined();
  });
});

describe('aggregate — timezone correctness', () => {
  it('buckets a UTC instant to the correct LOCAL day (NY), not the UTC day', () => {
    // 2026-06-15T02:00:00Z is 2026-06-14 22:00 in New_York.
    const start = Date.parse('2026-06-15T02:00:00Z');
    const out = aggregate([p('u1', 'IN', start), p('u1', 'OUT', start + HOUR)], NY);
    expect(out.dailyHours['u1:2026-06-14']).toBeCloseTo(1, 9); // local day, not 06-15
    expect(out.dailyHours['u1:2026-06-15']).toBeUndefined();
    expect(out.weeklyHours['u1:2026-W24']).toBeCloseTo(1, 9); // June 14 = ISO week 24
  });
});

describe('aggregate — multi-user isolation & range', () => {
  it('keeps users separate in every bucket', () => {
    const out = aggregate(
      [
        p('u1', 'IN', utc(15, 13)),
        p('u1', 'OUT', utc(15, 21)), // 8h
        p('u2', 'IN', utc(15, 13)),
        p('u2', 'OUT', utc(15, 16)), // 3h
      ],
      NY,
    );
    expect(out.dailyHours['u1:2026-06-15']).toBeCloseTo(8, 9);
    expect(out.dailyHours['u2:2026-06-15']).toBeCloseTo(3, 9);
  });

  it('only counts shifts whose start is within the given range', () => {
    const inRange = utc(16, 14);
    const out = aggregate(
      [
        p('u1', 'IN', utc(15, 14)),
        p('u1', 'OUT', utc(15, 16)), // start 06-15, outside range
        p('u1', 'IN', inRange),
        p('u1', 'OUT', utc(16, 16)), // start 06-16, inside range
      ],
      NY,
      { from: utc(16, 0), to: utc(17, 0) },
    );
    expect(out.shifts).toHaveLength(1);
    expect(out.dailyHours['u1:2026-06-15']).toBeUndefined();
    expect(out.dailyHours['u1:2026-06-16']).toBeCloseTo(2, 9);
  });
});
