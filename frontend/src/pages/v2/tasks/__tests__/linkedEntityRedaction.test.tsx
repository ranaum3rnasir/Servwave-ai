/**
 * #01 - a task's linked-entity label must not hand a reader the identity of an entity they cannot
 * open (the job number and job type, the lead or estimate number, the customer's name).
 *
 * The server decides (`backend/src/lib/tasks/enrich.ts`); the frontend's job is to render the three
 * states it can send as three DIFFERENT things, and to make sure the redacted one is inert:
 *
 *   normal    redacted=false  label="J00934 · Access Control"   byte-identical to before
 *   redacted  redacted=true   label="Restricted job"            placeholder, padlock, not actionable
 *   dangling  redacted=false  label=null -> ''                  PRE-EXISTING, must NOT gain a placeholder
 *
 * The last row is the one worth guarding. A dangling link - the entity is deleted or out of the org -
 * has always rendered as a bare type chip, and collapsing it into the redacted placeholder would tell
 * every reader that a deleted job is a job they are locked out of.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';
import { canOpenLinkedEntity, REDACTED_ENTITY_HINT } from '@/lib/tasks/linkedEntity';
import type { Task } from '@/lib/tasks/types';
import { LinkedEntityChip } from '../components/atoms';
import { LinkedEntityChip as LegacyLinkedEntityChip } from '@/components/tasks/LinkedEntityChip';
import { TaskCard } from '../components/taskCard';
import { TaskDetailDrawer } from '../components/taskDetailDrawer';
import ListView from '../views/listView';
import CalendarView from '../views/calendarView';

const REAL_LABEL = 'J00934 · Access Control';
const PLACEHOLDER = 'Restricted job';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const H = vi.hoisted(() => ({ tasks: [] as unknown[], openTaskId: null as string | null }));

// Both stores are read BOTH ways in this module - `useTasksStore()` in the drawer,
// `useTasksStore((s) => s.reschedule)` in the calendar - so the stubs have to serve
// the selector and the bare call alike.
vi.mock('@/stores/tasksStore', () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  const state = () => ({
    tasks: H.tasks,
    fetchTaskDetail: noop, deleteTask: noop, addComment: noop, addSubtask: noop,
    toggleSubtask: noop, deleteSubtask: noop, setAssignees: noop, setWatchers: noop,
    nudge: noop, updateTask: noop, updateStatus: noop, reschedule: noop, addTask: noop,
  });
  return {
    useTasksStore: (sel?: (s: ReturnType<typeof state>) => unknown) =>
      (sel ? sel(state()) : state()),
  };
});

vi.mock('@/stores/taskDetailStore', () => {
  const open = vi.fn();
  const close = vi.fn();
  const state = () => ({ openTaskId: H.openTaskId, open, close });
  return {
    useTaskDetailStore: (sel?: (s: ReturnType<typeof state>) => unknown) =>
      (sel ? sel(state()) : state()),
  };
});

vi.mock('@/lib/tasks/useFilteredTasks', async (importOriginal) => ({
  // The per-view options stay real: every view names its own (TASK_VIEW_FILTER_OPTIONS[view]).
  ...(await importOriginal<typeof import('@/lib/tasks/useFilteredTasks')>()),
  useFilteredTasks: () => H.tasks,
}));

// The people widget fetches its own roster; not the subject here.
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id, value }: { id?: string; value: string[] }) => (
    <div data-testid={id ?? 'multi-assignee-select'}>{value.join(',')}</div>
  ),
}));

const ROW: TaskRow = {
  id: 't1',
  task_number: 'T00001',
  title: 'Fix the valve',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  assignee_ids: ['u1'],
  assignees: [{ id: 'u1', name: 'Oved Adani' }],
  due_at: new Date().toISOString(),
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

const REDACTED_ROW: TaskRow = { ...ROW, linked_entity_label: PLACEHOLDER, linked_entity_redacted: true };
const DANGLING_ROW: TaskRow = { ...ROW, linked_entity_label: null, linked_entity_redacted: false };

/** The drawer wants the rich arrays a detail read carries. */
function detail(row: TaskRow): Task {
  return { ...mapRowToTask(row), subtasks: [], comments: [], activity: [], watchers: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.tasks = [];
  H.openTaskId = null;
});

// ---------------------------------------------------------------------------
// Wire -> model
// ---------------------------------------------------------------------------

describe('mapRowToTask carries the redacted flag', () => {
  it('keeps the real label and redacted=false for a reader who may open the entity', () => {
    expect(mapRowToTask(ROW).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: REAL_LABEL, redacted: false,
    });
  });

  it('carries redacted=true beside the placeholder', () => {
    expect(mapRowToTask(REDACTED_ROW).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: PLACEHOLDER, redacted: true,
    });
  });

  it('leaves a DANGLING link empty and NOT redacted', () => {
    expect(mapRowToTask(DANGLING_ROW).linked_entity).toEqual({
      type: 'JOB', id: 'job-1', label: '', redacted: false,
    });
  });

  it('treats an absent flag as not redacted, so an older payload cannot fake a lockout', () => {
    const { linked_entity_redacted: _drop, ...legacy } = ROW;
    expect(mapRowToTask(legacy as TaskRow).linked_entity?.redacted).toBe(false);
  });
});

describe('canOpenLinkedEntity', () => {
  it('is the single gate, and only redaction closes it', () => {
    expect(canOpenLinkedEntity(mapRowToTask(ROW).linked_entity)).toBe(true);
    expect(canOpenLinkedEntity(mapRowToTask(DANGLING_ROW).linked_entity)).toBe(true);
    expect(canOpenLinkedEntity(mapRowToTask(REDACTED_ROW).linked_entity)).toBe(false);
    expect(canOpenLinkedEntity(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The chip itself - both live implementations
// ---------------------------------------------------------------------------

describe.each([
  ['/tasks hub chip', LinkedEntityChip],
  ['entity-page chip', LegacyLinkedEntityChip],
])('%s', (_name, Chip) => {
  it('renders a non-redacted label exactly as before: no padlock, no marker, label in the tooltip', () => {
    const { container } = renderWithProviders(<Chip entity={mapRowToTask(ROW).linked_entity} />);
    expect(screen.getByText(REAL_LABEL)).toBeInTheDocument();
    expect(screen.getByText(REAL_LABEL)).toHaveAttribute('title', REAL_LABEL);
    expect(container.querySelector('[data-redacted]')).toBeNull();
    expect(container.querySelector('[aria-disabled]')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the placeholder, a padlock and the reason when redacted', () => {
    const { container } = renderWithProviders(<Chip entity={mapRowToTask(REDACTED_ROW).linked_entity} />);
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByText(PLACEHOLDER)).toHaveAttribute('title', REDACTED_ENTITY_HINT);
    expect(container.querySelector('[data-redacted="true"]')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    // The identity never reaches the DOM at all - not as text, not as a tooltip.
    expect(container.innerHTML).not.toContain('J00934');
    expect(container.innerHTML).not.toContain('Access Control');
  });

  it('is NOT navigable when redacted: no link, no button, nothing focusable', () => {
    const { container } = renderWithProviders(<Chip entity={mapRowToTask(REDACTED_ROW).linked_entity} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('a,button,[href],[role="link"],[role="button"],[tabindex]')).toBeNull();
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });

  it('leaves a DANGLING link as the bare type chip it has always been, with no placeholder', () => {
    const { container } = renderWithProviders(<Chip entity={mapRowToTask(DANGLING_ROW).linked_entity} />);
    expect(screen.getByText('JOB')).toBeInTheDocument();
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
    expect(container.querySelector('[data-redacted]')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing at all when there is no link', () => {
    const { container } = renderWithProviders(<Chip entity={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// Every surface the issue names
// ---------------------------------------------------------------------------

describe('the card', () => {
  it('shows the placeholder and never the entity identity', () => {
    renderWithProviders(<TaskCard task={mapRowToTask(REDACTED_ROW)} />);
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.queryByText(REAL_LABEL)).toBeNull();
  });

  it('shows the real label when the reader may open the entity', () => {
    renderWithProviders(<TaskCard task={mapRowToTask(ROW)} />);
    expect(screen.getByText(REAL_LABEL)).toBeInTheDocument();
  });
});

describe('the list', () => {
  it('shows the placeholder in the Linked column and never the entity identity', () => {
    H.tasks = [mapRowToTask(REDACTED_ROW)];
    const { container } = renderWithProviders(<ListView />);
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('J00934');
  });

  it('shows the real label when the reader may open the entity', () => {
    H.tasks = [mapRowToTask(ROW)];
    renderWithProviders(<ListView />);
    expect(screen.getByText(REAL_LABEL)).toBeInTheDocument();
  });
});

describe('the detail drawer', () => {
  it('shows the placeholder against Linked and never the entity identity', () => {
    H.tasks = [detail(REDACTED_ROW)];
    H.openTaskId = 't1';
    const { container } = renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('J00934');
  });

  it('shows the real label when the reader may open the entity', () => {
    H.tasks = [detail(ROW)];
    H.openTaskId = 't1';
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByText(REAL_LABEL)).toBeInTheDocument();
  });
});

describe('the calendar chip', () => {
  // The calendar chip is the one named surface that never carried the label: it renders the task
  // TITLE and nothing else, so there is no identity on it to redact. Pinned rather than assumed,
  // because "add the linked entity to the calendar chip" is exactly the kind of later tweak that
  // would reopen this issue silently.
  it('carries the task title only, so neither the identity nor the placeholder appears', () => {
    H.tasks = [mapRowToTask(REDACTED_ROW)];
    const { container } = renderWithProviders(<CalendarView />);
    expect(screen.getAllByText('Fix the valve').length).toBeGreaterThan(0);
    expect(container.innerHTML).not.toContain('J00934');
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it('does not carry the real label either, for a reader who CAN open the entity', () => {
    H.tasks = [mapRowToTask(ROW)];
    const { container } = renderWithProviders(<CalendarView />);
    expect(container.innerHTML).not.toContain('J00934');
  });
});
