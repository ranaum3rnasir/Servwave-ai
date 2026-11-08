import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutomationTriggerType } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle } from '../context';
import { TRIGGERS } from '../catalog';

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const TASK_ID = 'aa000000-0000-0000-0000-000000000001';
const JOB_ID = 'bb000000-0000-0000-0000-000000000001';
const DUE_AT = new Date('2026-09-04T02:30:00.000Z'); // 22:30 Sep 3 in America/New_York

const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };
const BOB = { id: 'u2', email: 'bob@org.com', first_name: 'Bob', last_name: 'Ray' };
const CAT = { id: 'u3', email: 'cat@org.com', first_name: 'Cat', last_name: 'Diaz' };
const CREATOR = { id: 'u9', email: 'dee@org.com', first_name: 'Dee', last_name: 'Fox' };

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    task_number: 'T00042',
    title: 'Order the replacement thermostat',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    assignee_ids: [ANN.id, BOB.id],
    watcher_ids: [CAT.id],
    due_at: DUE_AT,
    linked_entity_type: 'JOB',
    linked_entity_id: JOB_ID,
    created_by: CREATOR.id,
    creator: CREATOR,
    ...overrides,
  } as any;
}

function load(entityId = TASK_ID) {
  return loadExecutionBundle({
    entityType: 'task',
    entityId,
    organizationId: ORG,
    dedupeKey: `TASK_CREATED:${entityId}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.task.findFirst.mockResolvedValue(taskRow());
  mockPrisma.user.findMany.mockResolvedValue([ANN, BOB, CAT]);
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID, job_number: 'J00042' });
});

describe('loadExecutionBundle - task', () => {
  it('loads the org-scoped task and splits its two people lists in stored order', async () => {
    const result = await load();

    expect(mockPrisma.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: TASK_ID, organization_id: ORG }) }),
    );
    expect(result).not.toBeNull();
    expect(result!.bundle.assignees).toEqual([ANN, BOB]);
    expect(result!.bundle.watchers).toEqual([CAT]);
    expect(result!.bundle.creator).toEqual(CREATOR);
  });

  it('looks the people up ONCE, org-scoped and active-only, over the union of both arrays', async () => {
    await load();

    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [ANN.id, BOB.id, CAT.id] },
          organization_id: ORG,
          is_active: true,
        }),
      }),
    );
  });

  it('drops an id that no longer resolves rather than producing an email-less recipient', async () => {
    // The arrays are bare Postgres uuid[] with no foreign key, so a deactivated user's id can
    // sit in one until lib/tasks/deactivation.ts rewrites it - and the row a sweep missed is
    // exactly the row an automation must not choke on.
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [ANN.id, 'ghost-id', BOB.id], watcher_ids: ['ghost-id'] }),
    );
    mockPrisma.user.findMany.mockResolvedValue([ANN, BOB]);

    const result = await load();

    expect(result!.bundle.assignees).toEqual([ANN, BOB]);
    expect(result!.bundle.watchers).toEqual([]);
  });

  it('labels the enrollment with the task TITLE, not its number', async () => {
    const result = await load();
    expect(result!.bundle.entityRef).toEqual({
      type: 'task',
      id: TASK_ID,
      label: 'Order the replacement thermostat',
    });
  });

  it('renders every task merge field, with human words for status and priority', async () => {
    const result = await load();
    const ctx = result!.bundle.mergeCtx;

    expect(ctx['task.number']).toBe('T00042');
    expect(ctx['task.title']).toBe('Order the replacement thermostat');
    expect(ctx['task.status']).toBe('In progress');
    expect(ctx['task.priority']).toBe('High');
    expect(ctx['task.assignee_names']).toBe('Ann Lee, Bob Ray');
    expect(ctx['task.link']).toContain(`/tasks?task=${TASK_ID}`);
    expect(ctx['task.linked_record']).toBe('Job J00042');
    expect(ctx['org.name']).toBe('Blue Ridge Plumbing');
  });

  it('carries NO customer merge field - a task has no customer', async () => {
    const result = await load();
    expect(Object.keys(result!.bundle.mergeCtx).filter((k) => k.startsWith('customer.'))).toEqual([]);
    expect(result!.bundle.customer).toBeNull();
  });

  it('renders the due date in the ORGANIZATION timezone, not UTC', async () => {
    const result = await load();
    // 02:30Z on Sep 4 is 22:30 on Sep 3 in America/New_York, so the org clock and the UTC
    // clock name different DAYS - a fixture that could not tell the two apart would pass
    // against a UTC formatter.
    expect(result!.bundle.mergeCtx['task.due_date']).toBe('Thu, Sep 3');
  });

  it('renders an empty string for a task with no due date - never "null", never a crash', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: null }));
    const result = await load();
    expect(result!.bundle.mergeCtx['task.due_date']).toBe('');
    expect(result!.state.taskDueAt).toBeNull();
  });

  it('renders an empty linked record for a free-standing task, and issues no lookup', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ linked_entity_type: null, linked_entity_id: null }),
    );
    const result = await load();
    expect(result!.bundle.mergeCtx['task.linked_record']).toBe('');
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('leaves the linked record empty when the linked row is gone, rather than throwing', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(null);
    const result = await load();
    expect(result!.bundle.mergeCtx['task.linked_record']).toBe('');
  });

  it('snapshots the status and the due date onto EntityState for the engine', async () => {
    const result = await load();
    expect(result!.state.taskStatus).toBe('IN_PROGRESS');
    expect(result!.state.taskDueAt).toEqual(DUE_AT);
  });

  it('returns null for a task outside the organization, so the engine stops the enrollment', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);
    expect(await load()).toBeNull();
  });
});

// ── Spec B slice 4: the payload-sourced bundle for a task that is GONE ────────

/**
 * Task deletion is a hard delete, so a TASK_DELETED workflow's steps run against nothing:
 * `task.findFirst` returns null for the whole life of the enrollment. Every OTHER entity
 * treats that as fatal and must keep doing so, which is why the escape hatch below is
 * gated on the trigger and not on "a task is missing".
 */
describe('loadExecutionBundle - task deleted (payload-sourced)', () => {
  const DELETED_PAYLOAD = {
    mergeFields: { 'task.number': 'T00042', 'task.title': 'Order the replacement thermostat' },
    taskSnapshot: { assigneeIds: [ANN.id, BOB.id], watcherIds: [CAT.id], creatorId: CREATOR.id },
    actorId: CREATOR.id,
  };

  function loadDeleted(overrides: Record<string, unknown> = {}) {
    return loadExecutionBundle({
      entityType: 'task',
      entityId: TASK_ID,
      entityLabel: 'Order the replacement thermostat',
      organizationId: ORG,
      dedupeKey: `TASK_DELETED:${TASK_ID}`,
      trigger: 'TASK_DELETED',
      eventPayload: DELETED_PAYLOAD,
      ...overrides,
    } as any);
  }

  beforeEach(() => {
    // The row is GONE. Nothing below may depend on reading it.
    mockPrisma.task.findFirst.mockResolvedValue(null);
    mockPrisma.user.findMany.mockResolvedValue([ANN, BOB, CAT, CREATOR]);
  });

  it('synthesises a bundle instead of returning null', async () => {
    const result = await loadDeleted();
    expect(result).not.toBeNull();
  });

  it('resolves the audience from the SNAPSHOT roster, in stored order', async () => {
    const result = await loadDeleted();

    expect(result!.bundle.assignees).toEqual([ANN, BOB]);
    expect(result!.bundle.watchers).toEqual([CAT]);
    expect(result!.bundle.creator).toEqual(CREATOR);
  });

  it('looks those people up ONCE, org-scoped and active-only, over the union of the snapshot', async () => {
    await loadDeleted();

    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [ANN.id, BOB.id, CAT.id, CREATOR.id] },
          organization_id: ORG,
          is_active: true,
        }),
      }),
    );
  });

  it('carries the two identity fields and NOT ONE live-read field', async () => {
    const ctx = (await loadDeleted())!.bundle.mergeCtx;

    expect(ctx['task.number']).toBe('T00042');
    expect(ctx['task.title']).toBe('Order the replacement thermostat');
    expect(ctx['org.name']).toBe('Blue Ridge Plumbing');
    // Absent, not empty. An empty string renders as a blank in the middle of a sentence,
    // which reads as a broken template; an ABSENT key leaves {{task.due_date}} literal, and
    // the validator has already refused to save a body that references one.
    for (const field of ['task.due_date', 'task.status', 'task.priority', 'task.assignee_names', 'task.link', 'task.linked_record']) {
      expect(Object.prototype.hasOwnProperty.call(ctx, field), `${field} leaked into a deleted task's context`).toBe(false);
    }
  });

  it('labels the entity with the TITLE the enrollment persisted, and issues no linked-record lookup', async () => {
    const result = await loadDeleted();

    expect(result!.bundle.entityRef).toEqual({
      type: 'task',
      id: TASK_ID,
      label: 'Order the replacement thermostat',
    });
    expect(result!.bundle.customer).toBeNull();
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('reports NO entity state - a deleted task has no status and no due date to be judged on', async () => {
    const result = await loadDeleted();
    expect(result!.state.taskStatus).toBeUndefined();
    expect(result!.state.taskDueAt).toBeUndefined();
  });

  /**
   * THE CONSTRAINING TEST at this layer. If synthesis fired for any missing task rather than
   * only for the deleted trigger, EVERY task trigger would survive deletion - including the
   * due-date reminder that lands in the next slice, so a deleted task would keep chasing
   * people. Derived from the catalogue rather than hand-listed, so the trigger that slice
   * adds is constrained the day it exists.
   */
  it('returns null for every OTHER task trigger, so a deleted task stops rather than being chased', async () => {
    const otherTaskTriggers = Object.values(AutomationTriggerType).filter(
      (t) => TRIGGERS[t].entity === 'task' && t !== 'TASK_DELETED',
    );
    expect(otherTaskTriggers.length).toBeGreaterThan(0);

    for (const trigger of otherTaskTriggers) {
      expect(await loadDeleted({ trigger }), `${trigger} survived a vanished task`).toBeNull();
    }
  });

  it('returns null when no trigger is supplied at all - the hatch is opt-in, never a default', async () => {
    expect(await loadDeleted({ trigger: undefined })).toBeNull();
  });

  it('returns null when the trigger is right but the payload carries no snapshot', async () => {
    expect(await loadDeleted({ eventPayload: { mergeFields: DELETED_PAYLOAD.mergeFields } })).toBeNull();
    expect(await loadDeleted({ eventPayload: null })).toBeNull();
  });

  it('still returns null when the ORGANIZATION is the thing that is gone', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    expect(await loadDeleted()).toBeNull();
  });

  it('survives a snapshot whose people have all been deactivated - empty lists, not a throw', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    const result = await loadDeleted();

    expect(result).not.toBeNull();
    expect(result!.bundle.assignees).toEqual([]);
    expect(result!.bundle.watchers).toEqual([]);
    expect(result!.bundle.creator).toBeNull();
  });
});
