/**
 * Files on a task (visits-and-task-categories slice 12).
 *
 * Both task drawers - the Tasks page (v2) and the legacy one the job/lead/customer/estimate task
 * tabs mount - carry a Files section over the task's OWN attachment list
 * (`/api/attachments/task/:id`). Rename and remove follow the server's rule: the grant, or a file
 * you uploaded yourself on a task. A board card shows the file count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { TaskDetailDrawer as V2Drawer } from '@/pages/v2/tasks/components/taskDetailDrawer';
import { TaskDetailDrawer as LegacyDrawer } from '@/components/tasks/TaskDetailDrawer';
import { TaskCard as V2Card } from '@/pages/v2/tasks/components/taskCard';
import { TaskCard as LegacyCard } from '@/components/tasks/TaskCard';
import { mapRowToTask, type TaskRow } from '@/lib/api/tasks';
import type { Task } from '@/lib/tasks/types';

/** The signed-in user in the harness (src/__tests__/setup.ts mocks auth.store). */
const ME = '00000000-0000-0000-0000-000000000001';
const SOMEONE = '00000000-0000-0000-0000-0000000000f9';

const mockSetAttachmentCount = vi.fn();
const noop = vi.fn().mockResolvedValue(undefined);

const TASK: Task = {
  id: 't1',
  task_number: 'T00001',
  title: 'Photograph the gate',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  assignee_ids: [ME],
  assignees: [{ id: ME, name: 'Test Admin' }],
  watcher_ids: [],
  watchers: [],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [],
  comments: [],
  activity: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
  created_by: ME,
  created_at: '2026-09-27T12:00:00Z',
  updated_at: '2026-09-27T12:00:00Z',
  completed_at: null,
};

let mockTasks: Task[] = [TASK];

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: () => ({
    tasks: mockTasks,
    fetchTaskDetail: noop,
    deleteTask: noop,
    addComment: noop,
    addSubtask: noop,
    toggleSubtask: noop,
    deleteSubtask: noop,
    setAssignees: noop,
    setWatchers: noop,
    nudge: noop,
    updateTask: noop,
    updateStatus: noop,
    setAttachmentCount: mockSetAttachmentCount,
  }),
}));

vi.mock('@/stores/taskDetailStore', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id }: { id?: string }) => <div data-testid={id ?? 'multi-assignee-select'} />,
}));

function file(id: string, displayName: string, uploaderId: string) {
  return {
    id,
    file_name: `${id}.pdf`,
    file_url: `https://files.test/${id}.pdf`,
    file_type: 'application/pdf',
    file_size: 1024,
    display_name: displayName,
    description: '',
    created_at: '2026-09-27T12:00:00Z',
    uploader: { id: uploaderId, first_name: 'A', last_name: 'B' },
  };
}

const MINE = file('att-mine', 'Gate photo', ME);
const THEIRS = file('att-theirs', 'Permit', SOMEONE);

function givenFiles(url: string, rows: unknown[]) {
  (api.get as ReturnType<typeof vi.fn>).mockImplementation((u: string) =>
    Promise.resolve({ data: u === url ? { attachments: rows } : {} }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [TASK];
  givenFiles('/api/attachments/task/t1', [MINE, THEIRS]);
});

describe('both task drawers have a Files section over the task\'s own files', () => {
  it.each([
    ['the Tasks page drawer', V2Drawer],
    ['the entity-tab drawer', LegacyDrawer],
  ])('%s lists the task\'s files from the task attachment route', async (_label, Drawer) => {
    renderWithProviders(<Drawer />);

    const files = await screen.findByRole('region', { name: 'Files' });
    expect(await within(files).findByText('Gate photo')).toBeInTheDocument();
    expect(within(files).getByText('Permit')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/attachments/task/t1');
  });

  it.each([
    ['the Tasks page drawer', V2Drawer],
    ['the entity-tab drawer', LegacyDrawer],
  ])('%s hands the loaded count to the store, so the board card follows', async (_label, Drawer) => {
    renderWithProviders(<Drawer />);
    await waitFor(() => expect(mockSetAttachmentCount).toHaveBeenCalledWith('t1', 2));
    // Never a premature zero while the list is still loading.
    expect(mockSetAttachmentCount).not.toHaveBeenCalledWith('t1', 0);
  });

  it.each([
    ['the Tasks page drawer', V2Drawer],
    ['the entity-tab drawer', LegacyDrawer],
  ])('%s names file events in the activity feed', async (_label, Drawer) => {
    mockTasks = [{
      ...TASK,
      activity: [{ id: 'e1', type: 'attachment_uploaded', actor_id: ME, actor_name: 'Test Admin', at: '2026-09-27T12:00:00Z' }],
    }];
    renderWithProviders(<Drawer />);
    expect(screen.getByText('File added')).toBeInTheDocument();
  });
});

describe('rename and remove on a task follow the server rule', () => {
  function renderSection(entityType: string, grants: { action: string; subject: string }[] = []) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <AbilityProvider ability={buildAbility(grants)}>
        <QueryClientProvider client={client}>
          <AttachmentSection entityType={entityType} entityId="t1" />
        </QueryClientProvider>
      </AbilityProvider>,
    );
  }

  async function menuItems(displayName: string) {
    await userEvent.click(screen.getByRole('button', { name: `Actions for ${displayName}` }));
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.trim());
    await userEvent.keyboard('{Escape}');
    return items;
  }

  it('without the grants, offers Rename and Delete only on a file I uploaded', async () => {
    renderSection('task');
    await screen.findByText('Gate photo');

    expect(await menuItems('Gate photo')).toContain('Rename');
    expect(await menuItems('Permit')).not.toContain('Rename');

    const deletes = screen.getAllByRole('button', { name: 'Delete attachment' });
    expect(deletes).toHaveLength(1);
  });

  it('with the grants, offers both on every file', async () => {
    renderSection('task', [
      { action: 'update', subject: 'Attachment' },
      { action: 'delete', subject: 'Attachment' },
    ]);
    await screen.findByText('Gate photo');

    expect(await menuItems('Permit')).toContain('Rename');
    expect(screen.getAllByRole('button', { name: 'Delete attachment' })).toHaveLength(2);
  });

  it('does not extend the uploader exception off a task', async () => {
    givenFiles('/api/attachments/lead/t1', [MINE]);
    renderSection('lead');
    await screen.findByText('Gate photo');

    expect(await menuItems('Gate photo')).not.toContain('Rename');
    expect(screen.queryByRole('button', { name: 'Delete attachment' })).not.toBeInTheDocument();
  });
});

describe('the board card shows the file count', () => {
  it.each([
    ['the Tasks page card', V2Card],
    ['the entity-tab card', LegacyCard],
  ])('%s shows the count when files are attached, and nothing when there are none', (_label, Card) => {
    const { rerender } = renderWithProviders(<Card task={{ ...TASK, attachment_count: 3 }} />);
    expect(screen.getByLabelText('3 files')).toHaveTextContent('3');

    rerender(<Card task={{ ...TASK, attachment_count: 0 }} />);
    expect(screen.queryByLabelText(/files?$/)).not.toBeInTheDocument();
  });
});

describe('the wire row carries attachment_count', () => {
  const row = {
    id: 't1', task_number: 'T00001', title: 'x', description: '', status: 'TODO', priority: 'HIGH',
    assignee_ids: [ME], assignees: [], due_at: null, linked_entity_type: null, linked_entity_id: null,
    tags: [], created_by: ME, created_at: '', updated_at: '', completed_at: null,
  } as unknown as TaskRow;

  it('reads it from a list or detail row', () => {
    expect(mapRowToTask({ ...row, attachment_count: 4 }).attachment_count).toBe(4);
  });

  it('keeps the count in hand when a write response does not carry it', () => {
    expect(mapRowToTask(row, { ...TASK, attachment_count: 4 }).attachment_count).toBe(4);
    expect(mapRowToTask(row).attachment_count).toBe(0);
  });
});
