/**
 * #01 follow-up: an edit must not blank the linked-entity chip.
 *
 * Only the two READ paths resolve a label. `POST /api/tasks` and `PATCH /api/tasks/:id` answer with
 * the raw row - `{ ...task }` in task.controller.ts - which carries the `linked_entity_type` and
 * `_id` COLUMNS and no label at all. `tasksStore` replaces its task with the mapped response, so
 * before this every status drag and every field edit dropped a redacted chip's padlock and its
 * "Restricted job" placeholder, and dropped a normal chip's label, until a reload.
 *
 * The fix is a merge, not a second entity query on the write path. What makes it safe is that the
 * wire tells the two cases apart rather than the client guessing:
 *
 *   key ABSENT (undefined) - the response never resolved a label   -> keep what the store holds
 *   key present as null    - a read resolved it and found nothing  -> a DANGLING link, follow it
 *
 * and "omitted" is never confused with "cleared" or "re-pointed", both of which are followed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';
import type { Task } from '@/lib/tasks/types';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const REAL_LABEL = 'J00934 · Access Control';
const PLACEHOLDER = 'Restricted job';

/** What a READ path sends: `entityLabelFields` always emits both keys. */
const READ_ROW: TaskRow = {
  id: 't1',
  task_number: 'T00001',
  title: 'Fix the valve',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  assignee_ids: ['u1'],
  assignees: [{ id: 'u1', name: 'Oved Adani' }],
  due_at: null,
  linked_entity_type: 'JOB',
  linked_entity_id: 'job-1',
  linked_entity_label: REAL_LABEL,
  linked_entity_redacted: false,
  tags: [],
  created_by: 'u1',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
  completed_at: null,
};

/** What a WRITE path sends: the raw row, with neither label key present at all. */
const { linked_entity_label: _l, linked_entity_redacted: _r, ...WRITE_ROW_BASE } = READ_ROW;
const WRITE_ROW = WRITE_ROW_BASE as TaskRow;

const NORMAL = mapRowToTask(READ_ROW);
const REDACTED = mapRowToTask({ ...READ_ROW, linked_entity_label: PLACEHOLDER, linked_entity_redacted: true });

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The merge itself
// ---------------------------------------------------------------------------

describe('mapRowToTask keeps link fields a write response does not carry', () => {
  it('keeps the placeholder AND the redacted flag through an edit', () => {
    expect(mapRowToTask({ ...WRITE_ROW, status: 'DONE' }, REDACTED).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: PLACEHOLDER, redacted: true,
    });
  });

  it('keeps a normal label through an edit', () => {
    expect(mapRowToTask({ ...WRITE_ROW, status: 'DONE' }, NORMAL).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: REAL_LABEL, redacted: false,
    });
  });

  it('still blanks - as it always did - when there is no previous task to keep anything from', () => {
    expect(mapRowToTask(WRITE_ROW).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: '', redacted: false,
    });
  });
});

describe('an edit that genuinely changes the link is still followed', () => {
  it('follows a CLEARED link rather than resurrecting the old one', () => {
    const cleared = { ...WRITE_ROW, linked_entity_type: null, linked_entity_id: null };
    expect(mapRowToTask(cleared, REDACTED).linked_entity).toBeNull();
    expect(mapRowToTask(cleared, NORMAL).linked_entity).toBeNull();
  });

  it('follows a RE-POINTED link, and does not carry the old label onto the new entity', () => {
    const repointed = { ...WRITE_ROW, linked_entity_id: 'job-2' };
    expect(mapRowToTask(repointed, NORMAL).linked_entity).toEqual({
      type: 'JOB', id: 'job-2', label: '', redacted: false,
    });
  });

  it('follows a link re-pointed at a different TYPE with the same id', () => {
    const retyped = { ...WRITE_ROW, linked_entity_type: 'LEAD' as const };
    expect(mapRowToTask(retyped, NORMAL).linked_entity).toEqual({
      type: 'LEAD', id: 'job-1', label: '', redacted: false,
    });
  });
});

describe('a null label is a read result, not an omission', () => {
  it('follows a DANGLING read - label null, key PRESENT - instead of keeping the stale label', () => {
    const dangling = { ...READ_ROW, linked_entity_label: null, linked_entity_redacted: false };
    expect(mapRowToTask(dangling, NORMAL).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: '', redacted: false,
    });
  });

  it('lets a read UN-redact a chip: label and flag are taken as a pair, never mixed', () => {
    expect(mapRowToTask(READ_ROW, REDACTED).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: REAL_LABEL, redacted: false,
    });
  });

  it('lets a read REDACT a chip that was showing its real label', () => {
    const nowHidden = { ...READ_ROW, linked_entity_label: PLACEHOLDER, linked_entity_redacted: true };
    expect(mapRowToTask(nowHidden, NORMAL).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: PLACEHOLDER, redacted: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Both store call sites - the drag lane and the general edit
// ---------------------------------------------------------------------------

async function seed(task: Task) {
  const { useTasksStore } = await import('@/stores/tasksStore');
  useTasksStore.setState({ tasks: [task], loaded: true, loading: false });
  return useTasksStore;
}

describe('tasksStore keeps the chip through an edit', () => {
  it('updateStatus - the board drag - leaves a redacted chip fully intact', async () => {
    const store = await seed(REDACTED);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, status: 'DONE' } } });

    await store.getState().updateStatus('t1', 'DONE');

    const t = store.getState().tasks[0];
    expect(t.status).toBe('DONE');
    expect(t.linked_entity).toEqual({ type: 'JOB', id: 'job-1', label: PLACEHOLDER, redacted: true });
  });

  it('updateStatus leaves a normal chip\'s label intact', async () => {
    const store = await seed(NORMAL);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, status: 'DONE' } } });

    await store.getState().updateStatus('t1', 'DONE');

    expect(store.getState().tasks[0].linked_entity?.label).toBe(REAL_LABEL);
  });

  it('updateTask - the general edit path - leaves a redacted chip fully intact', async () => {
    const store = await seed(REDACTED);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, title: 'Renamed' } } });

    await store.getState().updateTask('t1', { title: 'Renamed' });

    const t = store.getState().tasks[0];
    expect(t.title).toBe('Renamed');
    expect(t.linked_entity).toEqual({ type: 'JOB', id: 'job-1', label: PLACEHOLDER, redacted: true });
  });

  it('updateTask leaves a normal chip\'s label intact', async () => {
    const store = await seed(NORMAL);
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, title: 'Renamed' } } });

    await store.getState().updateTask('t1', { title: 'Renamed' });

    expect(store.getState().tasks[0].linked_entity?.label).toBe(REAL_LABEL);
  });

  it('reschedule - the calendar drag - leaves a redacted chip fully intact', async () => {
    const store = await seed(REDACTED);
    const due = '2026-07-01T12:00:00.000Z';
    mockApi.patch.mockResolvedValue({ data: { task: { ...WRITE_ROW, due_at: due } } });

    await store.getState().reschedule('t1', due);

    const t = store.getState().tasks[0];
    expect(t.due_at).toBe(due);
    expect(t.linked_entity).toEqual({ type: 'JOB', id: 'job-1', label: PLACEHOLDER, redacted: true });
  });

  it('still follows the server when an edit genuinely clears the link', async () => {
    const store = await seed(REDACTED);
    mockApi.patch.mockResolvedValue({
      data: { task: { ...WRITE_ROW, status: 'DONE', linked_entity_type: null, linked_entity_id: null } },
    });

    await store.getState().updateStatus('t1', 'DONE');

    expect(store.getState().tasks[0].linked_entity).toBeNull();
  });
});
