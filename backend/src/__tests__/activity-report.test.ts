import { describe, it, expect } from 'vitest';
import {
  buildActivityReport,
  fmtClock,
  type ActivityEventRow,
} from '../services/activity-report';

function row(over: Partial<ActivityEventRow>): ActivityEventRow {
  return {
    eventType: 'lead.created',
    createdAt: new Date('2026-06-19T15:00:00.000Z'),
    actorId: 'u-1',
    actorFirstName: 'Oved',
    actorLastName: 'Adani',
    actorRole: 'Sales',
    ...over,
  };
}

describe('fmtClock', () => {
  it('formats morning/afternoon with am/pm and 12-hour clock', () => {
    expect(fmtClock(new Date('2026-06-19T08:05:00.000Z'))).toBe('8:05a');
    expect(fmtClock(new Date('2026-06-19T12:41:00.000Z'))).toBe('12:41p');
    expect(fmtClock(new Date('2026-06-19T00:00:00.000Z'))).toBe('12:00a');
    expect(fmtClock(new Date('2026-06-19T18:09:00.000Z'))).toBe('6:09p');
  });
});

describe('buildActivityReport', () => {
  it('groups events by actor and counts total actions', () => {
    const users = buildActivityReport([
      row({ actorId: 'a' }),
      row({ actorId: 'a' }),
      row({ actorId: 'b' }),
    ]);
    expect(users).toHaveLength(2);
    expect(users.find((u) => u.id === 'a')?.actions).toBe(2);
    expect(users.find((u) => u.id === 'b')?.actions).toBe(1);
  });

  it('builds a per-event-type breakdown sorted by count desc', () => {
    const users = buildActivityReport([
      row({ actorId: 'a', eventType: 'sms.sent' }),
      row({ actorId: 'a', eventType: 'sms.sent' }),
      row({ actorId: 'a', eventType: 'sms.sent' }),
      row({ actorId: 'a', eventType: 'lead.created' }),
    ]);
    expect(users[0]?.breakdown).toEqual([
      { label: 'sms.sent', count: 3 },
      { label: 'lead.created', count: 1 },
    ]);
  });

  it('carries actor name and role through', () => {
    const users = buildActivityReport([
      row({ actorFirstName: 'Emanuel', actorLastName: 'Dahan', actorRole: 'Dispatcher' }),
    ]);
    expect(users[0]?.name).toBe('Emanuel Dahan');
    expect(users[0]?.role).toBe('Dispatcher');
  });

  it('falls back to Unknown name/role when actor fields are null', () => {
    const users = buildActivityReport([
      row({ actorFirstName: null, actorLastName: null, actorRole: null }),
    ]);
    expect(users[0]?.name).toBe('Unknown');
    expect(users[0]?.role).toBe('Unknown');
  });

  it('skips events with no actor (system/public events)', () => {
    const users = buildActivityReport([
      row({ actorId: null }),
      row({ actorId: 'a' }),
    ]);
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe('a');
  });

  it('derives active window (first/last action + active minutes) from timestamps', () => {
    const users = buildActivityReport([
      row({ actorId: 'a', createdAt: new Date('2026-06-19T17:00:00.000Z') }),
      row({ actorId: 'a', createdAt: new Date('2026-06-19T08:05:00.000Z') }),
      row({ actorId: 'a', createdAt: new Date('2026-06-19T12:30:00.000Z') }),
    ]);
    const u = users[0]!;
    expect(u.firstActionAt).toBe('8:05a');
    expect(u.lastActionAt).toBe('5:00p');
    expect(u.activeMinutes).toBe((17 - 8) * 60 - 5); // 17:00 - 08:05 = 8h55m = 535m
  });

  it('sorts actors by action count descending (busiest first)', () => {
    const users = buildActivityReport([
      row({ actorId: 'quiet' }),
      row({ actorId: 'busy' }),
      row({ actorId: 'busy' }),
      row({ actorId: 'busy' }),
    ]);
    expect(users.map((u) => u.id)).toEqual(['busy', 'quiet']);
  });

  it('returns honest zeros for non-derivable money/speed metrics (no fabrication)', () => {
    const u = buildActivityReport([row({ actorId: 'a' })])[0]!;
    expect(u.revenueTouched).toBe(0);
    expect(u.conversions).toBe(0);
    expect(u.slaMetPct).toBe(0);
    expect(u.responseSec).toBe(0);
  });

  it('does NOT expose any division grouping/field', () => {
    const u = buildActivityReport([row({ actorId: 'a' })])[0]!;
    expect(u).not.toHaveProperty('divisionId');
    expect(u).not.toHaveProperty('division');
  });
});
