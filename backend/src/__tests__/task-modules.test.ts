import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeTaskRisk } from '../lib/tasks/risk';
import { taskVisibilityWhere } from '../lib/tasks/visibility';
import { diffTaskActivities } from '../lib/tasks/activity';
import {
  TASK_STATUSES, TERMINAL_TASK_STATUSES, isTerminalTaskStatus, openTaskStatusFilter,
} from '../lib/tasks/status';

const NOW = new Date('2026-06-17T12:00:00Z');

// ── Issue 03: the ONE enumeration of "finished" ───────────────────────────────
describe('task status model', () => {
  it('CANCELLED is a status, and DONE + CANCELLED are the terminal ones', () => {
    expect(TASK_STATUSES).toContain('CANCELLED');
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(['CANCELLED', 'DONE']);
  });

  it('isTerminalTaskStatus separates finished from open', () => {
    expect(isTerminalTaskStatus('DONE')).toBe(true);
    expect(isTerminalTaskStatus('CANCELLED')).toBe(true);
    for (const open of ['TODO', 'IN_PROGRESS', 'BLOCKED']) expect(isTerminalTaskStatus(open)).toBe(false);
    expect(isTerminalTaskStatus(null)).toBe(false);
    expect(isTerminalTaskStatus(undefined)).toBe(false);
  });

  it('TASK_STATUSES is the Prisma enum, label for label and in schema order', () => {
    // The promise this module makes is that the next status is a ONE-LINE change here. That
    // only holds while the list IS the enum: a label added to schema.prisma and not here is a
    // status the Zod route schemas reject, and a label here that the enum lacks is a 500 on
    // write. Neither shows up in a mocked-Prisma suite, so it is pinned against the file.
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const body = schema.slice(
      schema.indexOf('enum TaskStatus {') + 'enum TaskStatus {'.length,
      schema.indexOf('}', schema.indexOf('enum TaskStatus {')),
    );
    const labels = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    expect(labels).toEqual([...TASK_STATUSES]);
    for (const t of TERMINAL_TASK_STATUSES) expect(labels).toContain(t);
  });

  it('openTaskStatusFilter hands back a FRESH object each call', () => {
    const a = openTaskStatusFilter();
    const b = openTaskStatusFilter();
    expect(a).toEqual({ notIn: ['DONE', 'CANCELLED'] });
    expect(a).not.toBe(b);
    // A caller mutating one count's where must not corrupt the next one's.
    a.notIn.push('TODO' as never);
    expect(b.notIn).toEqual(['DONE', 'CANCELLED']);
  });
});

describe('computeTaskRisk', () => {
  it('DONE tasks are always zero-risk', () => {
    expect(computeTaskRisk({ status: 'DONE', priority: 'URGENT', due_at: '2026-06-01T00:00:00Z', completed_at: NOW }, NOW))
      .toEqual({ score: 0, reason: null });
  });
  it('CANCELLED tasks are zero-risk: abandoned work is not overdue', () => {
    // completed_at stays NULL on a cancellation (issue 03), so the status test is the only
    // thing standing between an abandoned task and a permanent "urgent, 16d overdue" score.
    expect(computeTaskRisk({ status: 'CANCELLED', priority: 'URGENT', due_at: '2026-06-01T00:00:00Z', completed_at: null }, NOW))
      .toEqual({ score: 0, reason: null });
  });
  it('overdue + urgent + blocked stacks toward high risk', () => {
    const r = computeTaskRisk({ status: 'BLOCKED', priority: 'URGENT', due_at: '2026-06-14T12:00:00Z', completed_at: null }, NOW);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.reason).toContain('overdue');
    expect(r.reason).toContain('blocked');
  });
  it('low priority, no due date → low score, null-ish reason', () => {
    expect(computeTaskRisk({ status: 'TODO', priority: 'LOW', due_at: null, completed_at: null }, NOW).score).toBe(0);
  });
});

const reqAs = (role: string, id: string) =>
  ({ user: { id, role, organization_id: 'org-1' } } as any);

describe('taskVisibilityWhere', () => {
  it('ADMIN hub → org-only, no OR scoping', () => {
    const w = taskVisibilityWhere(reqAs('ADMIN', 'u-admin'), {});
    expect(w.organization_id).toBe('org-1');
    expect(w.OR).toBeUndefined();
  });
  it('non-admin hub → assignee OR watcher, with no created_by arm', () => {
    const w = taskVisibilityWhere(reqAs('TECHNICIAN', 'u-tech'), {});
    expect(w.OR).toEqual([
      { assignee_ids: { has: 'u-tech' } },
      { watcher_ids: { has: 'u-tech' } },
    ]);
  });
  it('entity filter → entity-wide, no personal scoping even for non-admin', () => {
    const w = taskVisibilityWhere(reqAs('SALES', 'u-sales'), { linked_entity_type: 'JOB', linked_entity_id: 'job-1' });
    expect(w.linked_entity_type).toBe('JOB');
    expect(w.linked_entity_id).toBe('job-1');
    expect(w.OR).toBeUndefined();
  });
});

describe('diffTaskActivities', () => {
  const NAMES = new Map([['u-1', 'Dana Cohen'], ['u-2', 'Sagiv Levi']]);

  it('status→DONE yields COMPLETED', () => {
    expect(diffTaskActivities({ status: 'TODO' }, { status: 'DONE' })[0].type).toBe('COMPLETED');
  });
  it('status→CANCELLED yields CANCELLED, never COMPLETED', () => {
    // The timeline is where "who cancelled this, and when" is recorded. Issue 03 keeps
    // completed_at null precisely because this event carries it instead.
    const [ev] = diffTaskActivities({ status: 'TODO' }, { status: 'CANCELLED' });
    expect(ev).toEqual({ type: 'CANCELLED', description: 'cancelled the task' });
  });
  it('reopening CANCELLED→TODO is an ordinary status change, not a completion', () => {
    expect(diffTaskActivities({ status: 'CANCELLED' }, { status: 'TODO' })[0])
      .toEqual({ type: 'STATUS_CHANGED', description: 'changed status to TODO' });
  });
  it('assignee change yields ASSIGNED; due change yields DUE_CHANGED', () => {
    const evs = diffTaskActivities(
      { assignee_ids: [], due_at: null },
      { assignee_ids: ['u-2'], due_at: '2026-07-01T00:00:00Z' },
    );
    expect(evs.map((e) => e.type).sort()).toEqual(['ASSIGNED', 'DUE_CHANGED']);
  });
  it('no changes → empty', () => {
    expect(diffTaskActivities({ status: 'TODO' }, {})).toEqual([]);
  });

  // Design §6 — one NAMED entry per person, on both lists.
  it('emits one named event per person added to / removed from either list', () => {
    const evs = diffTaskActivities(
      { assignee_ids: ['u-2'], watcher_ids: ['u-1'] },
      { assignee_ids: ['u-1'], watcher_ids: ['u-2'] },
      NAMES,
    );
    expect(evs).toEqual([
      { type: 'ASSIGNED',        description: 'assigned Dana Cohen' },
      { type: 'UNASSIGNED',      description: 'unassigned Sagiv Levi' },
      { type: 'WATCHER_ADDED',   description: 'added Sagiv Levi as watcher' },
      { type: 'WATCHER_REMOVED', description: 'removed Dana Cohen as watcher' },
    ]);
  });

  it('falls back to a placeholder label when an id no longer resolves', () => {
    const evs = diffTaskActivities({ assignee_ids: [] }, { assignee_ids: ['u-gone'] }, NAMES);
    expect(evs).toEqual([{ type: 'ASSIGNED', description: 'assigned Unknown user' }]);
  });

  // REGRESSION GUARD. `after.owner_id !== before.owner_id` was a value compare on a scalar; on an
  // array it silently becomes a REFERENCE compare, so a PATCH that merely CARRIED the same
  // assignees would log a spurious ASSIGNED on every save. Equal-but-distinct arrays, no events.
  it('emits nothing when the sets are unchanged but present in the payload', () => {
    expect(diffTaskActivities(
      { assignee_ids: ['u-1', 'u-2'], watcher_ids: ['u-1'] },
      { assignee_ids: ['u-1', 'u-2'], watcher_ids: ['u-1'] },
      NAMES,
    )).toEqual([]);
    // ...and order within the set is not a change either.
    expect(diffTaskActivities(
      { assignee_ids: ['u-1', 'u-2'] },
      { assignee_ids: ['u-2', 'u-1'] },
      NAMES,
    )).toEqual([]);
  });
});

import { userFullName, customerLabel } from '../lib/tasks/enrich';

describe('enrich formatters', () => {
  it('userFullName joins first + last', () => {
    expect(userFullName({ first_name: 'Oved', last_name: 'Adani' })).toBe('Oved Adani');
  });
  it('customerLabel prefers company_name, falls back to person, then number', () => {
    expect(customerLabel({ company_name: 'Acme', first_name: null, last_name: null, customer_number: 'C00001' })).toBe('Acme');
    expect(customerLabel({ company_name: null, first_name: 'Gail', last_name: 'Levi', customer_number: 'C00002' })).toBe('Gail Levi');
    expect(customerLabel({ company_name: null, first_name: null, last_name: null, customer_number: 'C00003' })).toBe('C00003');
  });
});
