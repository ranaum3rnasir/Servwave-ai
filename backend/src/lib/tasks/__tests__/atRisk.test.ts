import { describe, it, expect } from 'vitest';
import { atRiskScore, atRiskIds, assigneeOpenCounts, type AtRiskRow } from '../atRisk';

/**
 * The "At risk" rule moved server-side with the paged Tasks list (mobile slice 72). Its
 * browser original is `assessRisk` in frontend/src/lib/tasks/tasks-logic.ts; every expectation
 * below is worked by hand from that rule (overdue 45, due in 24h 30, due in 48h 18, five days in
 * a stage 20, three days 10, assignee load 8+ 20, 5+ 10, blocked 15; at risk at 50 or more), so
 * a drift between the two copies shows up as a wrong number here and in the frontend suite.
 */

const NOW = new Date('2026-07-10T12:00:00.000Z');
const H = 3_600_000;
const DAY = 24 * H;

const row = (over: Partial<AtRiskRow> & { id: string }): AtRiskRow => ({
  status: 'TODO',
  due_at: null,
  updated_at: NOW,
  assignee_ids: ['u1'],
  ...over,
});

describe('atRiskScore', () => {
  it('scores overdue 45 and five days in a stage 20', () => {
    const r = row({ id: 'a', due_at: new Date(NOW.getTime() - DAY), updated_at: new Date(NOW.getTime() - 5 * DAY) });
    expect(atRiskScore(r, NOW, 0)).toBe(65);
  });

  it('due within 24h is 30, within 48h is 18, later is 0', () => {
    expect(atRiskScore(row({ id: 'a', due_at: new Date(NOW.getTime() + 12 * H) }), NOW, 0)).toBe(30);
    expect(atRiskScore(row({ id: 'a', due_at: new Date(NOW.getTime() + 36 * H) }), NOW, 0)).toBe(18);
    expect(atRiskScore(row({ id: 'a', due_at: new Date(NOW.getTime() + 72 * H) }), NOW, 0)).toBe(0);
  });

  it('three days in a stage is 10 and an assignee carrying 5 open tasks is 10 more: 30 + 10 + 10 = 50, at the line', () => {
    const r = row({ id: 'a', due_at: new Date(NOW.getTime() + 12 * H), updated_at: new Date(NOW.getTime() - 3 * DAY) });
    expect(atRiskScore(r, NOW, 5)).toBe(50);
    expect(atRiskScore(r, NOW, 4)).toBe(40);
  });

  it('an overloaded assignee (8+) adds 20 and a blocked task adds 15', () => {
    expect(atRiskScore(row({ id: 'a' }), NOW, 8)).toBe(20);
    expect(atRiskScore(row({ id: 'a', status: 'BLOCKED' }), NOW, 0)).toBe(15);
  });

  it('a finished task carries no risk, however overdue, either way it finished', () => {
    const old = new Date(NOW.getTime() - 9 * DAY);
    expect(atRiskScore(row({ id: 'a', status: 'DONE', due_at: old, updated_at: old }), NOW, 9)).toBe(0);
    expect(atRiskScore(row({ id: 'a', status: 'CANCELLED', due_at: old, updated_at: old }), NOW, 9)).toBe(0);
  });

  it('caps at 100', () => {
    const old = new Date(NOW.getTime() - 9 * DAY);
    expect(atRiskScore(row({ id: 'a', status: 'BLOCKED', due_at: old, updated_at: old }), NOW, 9)).toBe(100);
  });
});

describe('assigneeOpenCounts', () => {
  it('counts a shared task once for EACH assignee and never counts a finished one', () => {
    const counts = assigneeOpenCounts([
      row({ id: '1', assignee_ids: ['u1', 'u2'] }),
      row({ id: '2', assignee_ids: ['u1'] }),
      row({ id: '3', assignee_ids: ['u1'], status: 'DONE' }),
    ]);
    expect(counts.get('u1')).toBe(2);
    expect(counts.get('u2')).toBe(1);
  });
});

describe('atRiskIds', () => {
  it('sizes the busiest assignee over the load basis, not over the candidates', () => {
    // The candidate alone (due in 12h, 3 days in stage) is 40; with u1 carrying 5 open tasks in
    // the basis it is 50.
    const candidate = row({ id: 'c', due_at: new Date(NOW.getTime() + 12 * H), updated_at: new Date(NOW.getTime() - 3 * DAY) });
    const others = ['1', '2', '3', '4'].map((id) => row({ id }));
    expect(atRiskIds([candidate], [candidate], NOW)).toEqual([]);
    expect(atRiskIds([candidate], [candidate, ...others], NOW)).toEqual(['c']);
  });

  it('takes the BUSIEST of several assignees, not their sum', () => {
    const candidate = row({
      id: 'c', assignee_ids: ['u1', 'u2'],
      due_at: new Date(NOW.getTime() + 12 * H), updated_at: new Date(NOW.getTime() - 3 * DAY),
    });
    const basis = [
      candidate,
      ...['1', '2', '3'].map((id) => row({ id, assignee_ids: ['u1'] })),
      ...['4', '5', '6'].map((id) => row({ id, assignee_ids: ['u2'] })),
    ];
    // u1 carries 4 and u2 carries 4: busiest 4 (adds nothing), not 8.
    expect(atRiskIds([candidate], basis, NOW)).toEqual([]);
  });
});
