import { describe, it, expect } from 'vitest';
import { buildSessions, isLate, minutesOfDay } from './aggregate';
import type { Punch } from './types';

function punch(p: Partial<Punch> & Pick<Punch, 'userId' | 'type' | 'ts'>): Punch {
  return {
    id: `${p.userId}-${p.type}-${p.ts}`,
    userName: 'Tester',
    lat: 0, lng: 0,
    matchedZoneId: 'store', matchedZoneLabel: 'Main office',
    matchedZoneKind: 'store', matchedJobNumber: null,
    distanceM: 0, status: 'in_zone', review: 'none',
    ...p,
  } as Punch;
}

const HOUR = 3600000;

describe('buildSessions', () => {
  it('pairs each IN with the next OUT', () => {
    const sessions = buildSessions([
      punch({ userId: 'a', type: 'IN', ts: 1000 }),
      punch({ userId: 'a', type: 'OUT', ts: 1000 + 8 * HOUR }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.minutes).toBe(480);
    expect(sessions[0]!.outTs).toBe(1000 + 8 * HOUR);
  });

  it('leaves a trailing IN with no OUT as an open session (still clocked in)', () => {
    const sessions = buildSessions([punch({ userId: 'a', type: 'IN', ts: 1000 })]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.outTs).toBeNull();
    expect(sessions[0]!.minutes).toBe(0);
  });

  it('carries job attribution from the IN punch', () => {
    const sessions = buildSessions([
      punch({ userId: 'a', type: 'IN', ts: 1000, matchedZoneKind: 'job', matchedJobNumber: 'J00123' }),
      punch({ userId: 'a', type: 'OUT', ts: 1000 + HOUR }),
    ]);
    expect(sessions[0]!.zoneKind).toBe('job');
    expect(sessions[0]!.jobNumber).toBe('J00123');
  });

  it('keeps users separate', () => {
    const sessions = buildSessions([
      punch({ userId: 'a', type: 'IN', ts: 1000 }),
      punch({ userId: 'b', type: 'IN', ts: 2000 }),
      punch({ userId: 'a', type: 'OUT', ts: 1000 + HOUR }),
    ]);
    const a = sessions.find((s) => s.userId === 'a')!;
    const b = sessions.find((s) => s.userId === 'b')!;
    expect(a.minutes).toBe(60);
    expect(b.outTs).toBeNull();
  });

  it('ignores an OUT that has no open IN', () => {
    const sessions = buildSessions([
      punch({ userId: 'a', type: 'OUT', ts: 500 }),
      punch({ userId: 'a', type: 'IN', ts: 1000 }),
      punch({ userId: 'a', type: 'OUT', ts: 1000 + HOUR }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.minutes).toBe(60);
  });

  it('auto-closes a prior IN when a second IN arrives before any OUT', () => {
    const sessions = buildSessions([
      punch({ userId: 'a', type: 'IN', ts: 1000 }),
      punch({ userId: 'a', type: 'IN', ts: 2000 }),
      punch({ userId: 'a', type: 'OUT', ts: 2000 + HOUR }),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.inTs).toBe(1000);
    expect(sessions[0]!.outTs).toBeNull();
    expect(sessions[1]!.inTs).toBe(2000);
    expect(sessions[1]!.minutes).toBe(60);
  });
});

describe('isLate', () => {
  it('is false at 07:59 and true at 08:10 (5-min grace)', () => {
    const at = (h: number, m: number) => { const d = new Date(2026, 5, 1, h, m, 0, 0); return d.getTime(); };
    expect(isLate(at(7, 59))).toBe(false);
    expect(isLate(at(8, 4))).toBe(false);
    expect(isLate(at(8, 10))).toBe(true);
  });

  it('treats exactly 08:05 as on time and 08:06 as late', () => {
    const at = (h: number, m: number) => new Date(2026, 5, 1, h, m, 0, 0).getTime();
    expect(isLate(at(8, 5))).toBe(false);
    expect(isLate(at(8, 6))).toBe(true);
  });
});

describe('minutesOfDay', () => {
  it('returns minutes since local midnight', () => {
    const d = new Date(2026, 5, 1, 8, 30, 0, 0).getTime();
    expect(minutesOfDay(d)).toBe(510);
  });
});
