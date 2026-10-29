import { describe, it, expect } from 'vitest';
import {
  isOverdue, ageInStageMs, assessRisk, rankMyDay, computeStats,
  assigneeOpenCounts, assigneeOpenCountFor,
} from '@/lib/tasks/tasks-logic';
import type { Task } from '@/lib/tasks/types';

const NOW = new Date('2026-06-07T12:00:00.000Z');

function makeTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: 't1', task_number: 'T00001', title: 'x', description: '',
    status: 'TODO', priority: 'MEDIUM',
    assignee_ids: ['u1'], assignees: [], watcher_ids: [],
    due_at: null, linked_entity: null, tags: [], subtasks: [],
    created_by: 'u1', created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-05T12:00:00.000Z', completed_at: null,
    activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
  // A case that only states `assignee_ids` gets matching resolved names for
  // free; one that states `assignees` (e.g. a null name) keeps exactly what it
  // wrote. Both halves of the wire contract stay expressible.
  if (task.assignees.length === 0) {
    task.assignees = task.assignee_ids.map((id) => ({ id, name: id }));
  }
  return task;
}

describe('isOverdue', () => {
  it('is true when due in the past and not done', () => {
    expect(isOverdue(makeTask({ due_at: '2026-06-06T00:00:00.000Z' }), NOW)).toBe(true);
  });
  it('is false when due in the future', () => {
    expect(isOverdue(makeTask({ due_at: '2026-06-08T00:00:00.000Z' }), NOW)).toBe(false);
  });
  it('is false when done even if past due', () => {
    expect(isOverdue(makeTask({ due_at: '2026-06-06T00:00:00.000Z', status: 'DONE' }), NOW)).toBe(false);
  });
  it('is false when no due date', () => {
    expect(isOverdue(makeTask({ due_at: null }), NOW)).toBe(false);
  });
});

describe('ageInStageMs', () => {
  it('is now minus updated_at', () => {
    const t = makeTask({ updated_at: '2026-06-05T12:00:00.000Z' });
    expect(ageInStageMs(t, NOW)).toBe(2 * 24 * 60 * 60 * 1000);
  });
});

describe('assessRisk', () => {
  it('done tasks are never at risk', () => {
    const r = assessRisk(makeTask({ status: 'DONE', due_at: '2026-06-01T00:00:00.000Z' }), { now: NOW, assigneeOpenCount: 9 });
    expect(r.atRisk).toBe(false);
    expect(r.score).toBe(0);
  });
  it('overdue + high load is high risk with a reason', () => {
    const r = assessRisk(makeTask({ due_at: '2026-06-05T00:00:00.000Z', status: 'IN_PROGRESS' }), { now: NOW, assigneeOpenCount: 9 });
    expect(r.atRisk).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.reason).toMatch(/overdue/i);
  });
  it('due far out, low load, fresh stage is low risk', () => {
    const r = assessRisk(makeTask({ due_at: '2026-06-30T00:00:00.000Z', updated_at: NOW.toISOString() }), { now: NOW, assigneeOpenCount: 1 });
    expect(r.atRisk).toBe(false);
    expect(r.score).toBeLessThan(50);
  });
  it('blocked tasks carry extra risk', () => {
    const open = assessRisk(makeTask({ status: 'IN_PROGRESS', due_at: '2026-06-09T00:00:00.000Z' }), { now: NOW, assigneeOpenCount: 3 });
    const blocked = assessRisk(makeTask({ status: 'BLOCKED', due_at: '2026-06-09T00:00:00.000Z' }), { now: NOW, assigneeOpenCount: 3 });
    expect(blocked.score).toBeGreaterThan(open.score);
  });
});

describe('assigneeOpenCountFor', () => {
  it('reports the BUSIEST assignee, so one drowning holder is not masked by idle helpers', () => {
    const tasks: Task[] = [
      makeTask({ id: '1', assignee_ids: ['busy'] }),
      makeTask({ id: '2', assignee_ids: ['busy'] }),
      makeTask({ id: '3', assignee_ids: ['busy'] }),
      makeTask({ id: 'shared', assignee_ids: ['busy', 'idle'] }),
      makeTask({ id: 'closed', assignee_ids: ['busy'], status: 'DONE' }),
    ];
    const counts = assigneeOpenCounts(tasks);
    expect(counts.get('busy')).toBe(4);   // DONE is not open
    expect(counts.get('idle')).toBe(1);
    const shared = tasks.find((t) => t.id === 'shared')!;
    expect(assigneeOpenCountFor(shared, counts)).toBe(4);
  });

  it('is 0 for a task whose assignees hold nothing else open', () => {
    expect(assigneeOpenCountFor(makeTask({ assignee_ids: ['nobody'] }), new Map())).toBe(0);
  });
});

describe('rankMyDay', () => {
  it('returns only the user open tasks, overdue first then due-today then priority', () => {
    const overdue = makeTask({ id: 'overdue', assignee_ids: ['u1'], due_at: '2026-06-05T00:00:00.000Z' });
    const dueToday = makeTask({ id: 'today', assignee_ids: ['u1'], due_at: '2026-06-07T20:00:00.000Z' });
    const urgentFuture = makeTask({ id: 'urgent', assignee_ids: ['u1'], due_at: '2026-06-20T00:00:00.000Z', priority: 'URGENT' });
    const lowFuture = makeTask({ id: 'low', assignee_ids: ['u1'], due_at: '2026-06-20T00:00:00.000Z', priority: 'LOW' });
    const other = makeTask({ id: 'other', assignee_ids: ['u2'] });
    const done = makeTask({ id: 'done', assignee_ids: ['u1'], status: 'DONE' });

    const ranked = rankMyDay([lowFuture, urgentFuture, dueToday, overdue, other, done], 'u1', NOW);
    expect(ranked.map((t) => t.id)).toEqual(['overdue', 'today', 'urgent', 'low']);
  });

  it("includes a task the user holds alongside somebody else", () => {
    // Under the old `owner_id === userId` test, a task you were added to as a
    // second holder never reached My Day.
    const shared = makeTask({ id: 'shared', assignee_ids: ['u2', 'u1'] });
    expect(rankMyDay([shared], 'u1', NOW).map((t) => t.id)).toEqual(['shared']);
  });
});

describe('computeStats', () => {
  it('counts open, blocked, and per-assignee', () => {
    const tasks: Task[] = [
      makeTask({ id: 'a', assignee_ids: ['u1'], status: 'TODO' }),
      makeTask({ id: 'b', assignee_ids: ['u1'], status: 'BLOCKED' }),
      makeTask({ id: 'c', assignee_ids: ['u2'], status: 'IN_PROGRESS' }),
      makeTask({ id: 'd', assignee_ids: ['u2'], status: 'DONE', completed_at: '2026-06-06T00:00:00.000Z', due_at: '2026-06-07T00:00:00.000Z' }),
    ];
    const s = computeStats(tasks, NOW);
    expect(s.open).toBe(3);
    expect(s.blocked).toBe(1);
    const u1 = s.byAssignee.find((r) => r.userId === 'u1');
    expect(u1?.open).toBe(2);
  });

  it('counts a shared task once for EACH assignee, so the totals exceed the task count', () => {
    // Deliberate, not a bug: "how much is on this person's plate" is the
    // question, and three people who each owe the same deliverable each owe it.
    // Do not "fix" byAssignee to sum to `open`.
    const tasks: Task[] = [
      makeTask({ id: 'shared', assignee_ids: ['u1', 'u2', 'u3'], status: 'TODO' }),
      makeTask({ id: 'solo', assignee_ids: ['u1'], status: 'TODO' }),
    ];
    const s = computeStats(tasks, NOW);
    expect(s.open).toBe(2);
    expect(s.byAssignee.find((r) => r.userId === 'u1')?.open).toBe(2);
    expect(s.byAssignee.find((r) => r.userId === 'u2')?.open).toBe(1);
    expect(s.byAssignee.find((r) => r.userId === 'u3')?.open).toBe(1);
    // 2 + 1 + 1 = 4 credited slots across 2 tasks.
    expect(s.byAssignee.reduce((n, r) => n + r.open, 0)).toBe(4);
  });

  it('credits an overdue shared task to every assignee', () => {
    const tasks: Task[] = [
      makeTask({ id: 'late', assignee_ids: ['u1', 'u2'], due_at: '2026-06-01T00:00:00.000Z' }),
    ];
    const s = computeStats(tasks, NOW);
    expect(s.byAssignee.find((r) => r.userId === 'u1')?.overdue).toBe(1);
    expect(s.byAssignee.find((r) => r.userId === 'u2')?.overdue).toBe(1);
  });

  it('on-time % = done-before-due / done, rounded', () => {
    const tasks: Task[] = [
      makeTask({ id: 'ontime', status: 'DONE', completed_at: '2026-06-05T00:00:00.000Z', due_at: '2026-06-06T00:00:00.000Z' }),
      makeTask({ id: 'late', status: 'DONE', completed_at: '2026-06-08T00:00:00.000Z', due_at: '2026-06-06T00:00:00.000Z' }),
    ];
    expect(computeStats(tasks, NOW).onTimePct).toBe(50);
  });
});
