import { describe, it, expect } from 'vitest';
import { taskAI } from '@/lib/tasks/taskAI';
import { MOCK_PEOPLE, MOCK_ENTITIES, MOCK_NOW, MOCK_TASKS } from '@/lib/tasks/tasks-mock';

const ctx = { people: MOCK_PEOPLE, entities: MOCK_ENTITIES, now: MOCK_NOW };

describe('taskAI.parse', () => {
  it('extracts assignee, due date, linked job, and title', () => {
    const p = taskAI.parse('remind Priya to order glass for the Limon job by Friday', ctx);
    expect(p.assignee_id).toBe('u_priya');
    expect(p.linked_entity?.id).toBe('L00021');
    expect(p.due_at).not.toBeNull();
    expect(new Date(p.due_at!).getUTCDay()).toBe(5);
    expect(p.title.toLowerCase()).toContain('order glass');
    expect(p.title.toLowerCase()).not.toContain('priya');
  });

  it('detects urgent priority and "tomorrow"', () => {
    const p = taskAI.parse('URGENT: call supplier tomorrow', ctx);
    expect(p.priority).toBe('URGENT');
    expect(p.due_at).not.toBeNull();
  });

  it('falls back to a plain title when nothing matches', () => {
    const p = taskAI.parse('tidy the storage room', ctx);
    expect(p.assignee_id).toBeUndefined();
    expect(p.due_at).toBeNull();
    expect(p.title).toBe('tidy the storage room');
  });
});

describe('taskAI.rollup', () => {
  it('mentions closed count and at-risk count in plain words', () => {
    const text = taskAI.rollup(MOCK_TASKS, MOCK_NOW);
    expect(text).toMatch(/\d+ task/i);
    expect(text.length).toBeGreaterThan(20);
  });
});

describe('taskAI.suggestTasks', () => {
  it('returns a checklist for a known job type', () => {
    const items = taskAI.suggestTasks('Access Control System');
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]).toHaveProperty('title');
  });
  it('returns a generic checklist for an unknown type', () => {
    expect(taskAI.suggestTasks('Something Unknown').length).toBeGreaterThan(0);
  });
});

describe('taskAI.suggestAssignee', () => {
  it('picks the candidate with the fewest open tasks', () => {
    const r = taskAI.suggestAssignee(MOCK_TASKS, ['u_oved', 'u_ohad']);
    expect(r.userId).toBe('u_ohad');
    expect(r.reason).toMatch(/load|open|light/i);
  });
});
