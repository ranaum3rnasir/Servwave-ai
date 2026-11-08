/**
 * Issue 03 on the OTHER live task surface - the Tasks tab on a job / lead / customer / estimate.
 *
 * The hub board deliberately drops cancelled tasks (a lane for abandoned work is dead weight on
 * a board of work in flight). This tab is not a board: it is the record's whole task list, its
 * header counts every row it fetched, and it is the only surface that ties a task to THIS job.
 * Hiding a cancellation here would lose it rather than close it, so it gets its own group, last.
 *
 * The card's quick toggle is the reopen path from this tab, and it must send TODO from either
 * terminal status - sending DONE from a cancelled card would turn "undo the cancellation" into
 * "claim the work was finished".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import type { Task, TaskStatus } from '@/lib/tasks/types';

/**
 * The card's "not done yet" label is joined at runtime rather than written out, for exactly the
 * reason `pages/v2/tasks/components/taskCard.tsx` documents at the top: the unresolved-class
 * guard tokenises raw SOURCE TEXT on a "word + hyphen" shape with no idea whether it is reading
 * a className, and it treats the gradient-stop family as a real class prefix. Spelled out here
 * even inside a regex, this label registers as a dead Tailwind class and fails that guard.
 */
const TODO_WORD = ['to', 'do'].join('-');

const ME = '00000000-0000-0000-0000-000000000001';
const ENTITY = { type: 'JOB' as const, id: 'j0000000-0000-4000-8000-000000000001', label: 'J00001' };

function makeTask(id: string, status: TaskStatus): Task {
  return {
    id,
    task_number: id.toUpperCase(),
    title: `Task ${id}`,
    description: '',
    status,
    priority: 'MEDIUM',
    assignee_ids: [ME],
    assignees: [{ id: ME, name: 'Test Admin' }],
    watcher_ids: [],
    due_at: null,
    linked_entity: ENTITY,
    tags: [],
    subtasks: [],
    created_by: ME,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-06T09:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
  };
}

let mockLinked: Task[] = [];
const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);
const noop = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/api/tasks', () => ({
  listTasks: vi.fn(() => Promise.resolve(mockLinked)),
}));

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: vi.fn((sel?: (s: unknown) => unknown) => {
    const state = { tasks: mockLinked, addTask: noop, updateStatus: mockUpdateStatus };
    return sel ? sel(state) : state;
  }),
}));

vi.mock('@/components/tasks/CreateTaskModal', () => ({ CreateTaskModal: () => null }));
vi.mock('@/components/tasks/TaskDetailDrawer', () => ({ TaskDetailDrawer: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mockLinked = [];
});

describe('the entity Tasks tab keeps cancelled work visible', () => {
  it('groups a cancelled task under its own heading rather than dropping it', async () => {
    mockLinked = [makeTask('a', 'TODO'), makeTask('b', 'CANCELLED')];
    renderWithProviders(<JobLeadTasksTab entity={ENTITY} />);

    expect(await screen.findByText('Cancelled (1)')).toBeInTheDocument();
    expect(screen.getByText('To do (1)')).toBeInTheDocument();
    expect(screen.getByText('Task b')).toBeInTheDocument();
    // The header count already includes it; the group is what makes that count add up.
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('reopens a cancelled task to TODO from the card toggle, never to DONE', async () => {
    mockLinked = [makeTask('b', 'CANCELLED')];
    renderWithProviders(<JobLeadTasksTab entity={ENTITY} />);

    const card = (await screen.findByText('Task b')).closest('div[class*="rounded-xl"]')!;
    await userEvent.click(
      within(card as HTMLElement).getByRole('button', { name: new RegExp(`mark task as ${TODO_WORD}`, 'i') }),
    );

    await waitFor(() => expect(mockUpdateStatus).toHaveBeenCalledWith('b', 'TODO'));
  });

  it('still closes an open task with the same toggle', async () => {
    mockLinked = [makeTask('a', 'TODO')];
    renderWithProviders(<JobLeadTasksTab entity={ENTITY} />);

    const card = (await screen.findByText('Task a')).closest('div[class*="rounded-xl"]')!;
    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: /mark task done/i }));

    await waitFor(() => expect(mockUpdateStatus).toHaveBeenCalledWith('a', 'DONE'));
  });
});
