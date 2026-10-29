/**
 * "Bell verbs unchanged" (visits-and-task-categories PRD): the build adds triggers, categories and
 * per-visit crew doors, and none of that may change what an existing bell SAYS. These are the task
 * and dispatch verbs the build's code paths emit (task done, task cancelled, task deleted through a
 * category delete, crew added to / removed from a job), pinned to their pre-build rendering as
 * literals - so a change here is a decision someone has to make on purpose, not a side effect.
 *
 * The one ruled exception (slice 02): `dispatch.job_unassigned` WITH a `visit_label` names the trip
 * a person came off while they stay on another trip of the job. Without it the verb renders exactly
 * as before.
 */
import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../services/notifications/templates';

const TASK = { object_label: 'Order the hinge kit', task_number: 'T00042' };
const JOB = { object_label: 'J00178', customer_name: 'Pat Sample', scheduled_start: '2026-09-30T13:00:00.000Z' };

const taskBell = (title: string, extra: Record<string, unknown> = {}) => ({
  category: 'TASK', object_type: 'TASK', priority: 'FEED', action_type: null, needs_action: false, title, ...extra,
});
const dispatchBell = (title: string) => ({
  category: 'DISPATCH', object_type: 'JOB', priority: 'INTERRUPT', action_type: null, needs_action: false, title,
});

describe('bell verbs the build emits render exactly as before it', () => {
  it.each([
    ['task.completed', TASK, taskBell('Task completed: Order the hinge kit')],
    ['task.completed', {}, taskBell('Task completed: a task')],
    ['task.cancelled', TASK, taskBell('Task cancelled: Order the hinge kit')],
    ['task.cancelled', {}, taskBell('Task cancelled: a task')],
    ['task.deleted', TASK, taskBell('Task deleted: Order the hinge kit', { body: 'This task no longer exists (T00042).' })],
    ['task.deleted', {}, taskBell('Task deleted: a task', { body: 'This task no longer exists.' })],
    ['dispatch.job_assigned', JOB, dispatchBell('J00178 assigned to you — Pat Sample')],
    ['dispatch.job_assigned', {}, dispatchBell('Job assigned to you')],
    ['dispatch.job_unassigned', JOB, dispatchBell('J00178 unassigned from you')],
    ['dispatch.job_unassigned', {}, dispatchBell('Job unassigned from you')],
  ])('%s %j', (verb, data, expected) => {
    expect(renderTemplate(verb, data)).toEqual(expected);
  });

  it('the one ruled addition: a per-visit removal names the trip (slice 02)', () => {
    expect(renderTemplate('dispatch.job_unassigned', { ...JOB, visit_label: 'Visit 2 on Wed, Sep 30' })).toEqual(
      dispatchBell('J00178 Visit 2 on Wed, Sep 30 — you were removed from this visit'),
    );
  });
});
