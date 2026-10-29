/**
 * #01, acceptance criterion 4: the tasks tab on a job/lead/customer/estimate page is UNAFFECTED.
 *
 * Everyone who can open that page can see that entity, so the server never redacts a link resolved
 * for it. This pins the frontend half of that claim rather than assuming it: `JobLeadTasksTab` mounts
 * its cards with `hideLinkedEntity`, so the entity chip is not on that surface at all - which is why
 * nothing there can leak, and why a redaction bug in the chip cannot change how this tab reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from './helpers';
import * as tasksApi from '@/lib/api/tasks';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import type { LinkedEntity } from '@/lib/tasks/types';

vi.mock('@/lib/api/tasks', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/tasks')>('@/lib/api/tasks');
  return { ...actual, listTasks: vi.fn() };
});

vi.mock('@/components/tasks/CreateTaskModal', () => ({ CreateTaskModal: () => null }));
vi.mock('@/components/tasks/TaskDetailDrawer', () => ({ TaskDetailDrawer: () => null }));

const JOB_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ENTITY: LinkedEntity = { type: 'JOB', id: JOB_UUID, label: 'J00934 · Access Control', redacted: false };

const ROW: tasksApi.TaskRow = {
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
  linked_entity_id: JOB_UUID,
  linked_entity_label: 'J00934 · Access Control',
  linked_entity_redacted: false,
  tags: [],
  created_by: 'u1',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
  completed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the entity-page tasks tab', () => {
  it('renders no linked-entity chip at all, so there is nothing on it to redact', async () => {
    vi.mocked(tasksApi.listTasks).mockResolvedValue([tasksApi.mapRowToTask(ROW)]);
    const { container } = renderWithProviders(<JobLeadTasksTab entity={ENTITY} />);

    await waitFor(() => expect(screen.getByText('Fix the valve')).toBeInTheDocument());
    expect(container.querySelector('[data-redacted]')).toBeNull();
    // The chip is the only thing that would print the label; the tab's own copy never does.
    expect(screen.queryByText('J00934 · Access Control')).toBeNull();
  });

  it('still renders no chip if a redacted row ever reached it', async () => {
    vi.mocked(tasksApi.listTasks).mockResolvedValue([
      tasksApi.mapRowToTask({ ...ROW, linked_entity_label: 'Restricted job', linked_entity_redacted: true }),
    ]);
    const { container } = renderWithProviders(<JobLeadTasksTab entity={ENTITY} />);

    await waitFor(() => expect(screen.getByText('Fix the valve')).toBeInTheDocument());
    expect(screen.queryByText('Restricted job')).toBeNull();
    expect(container.querySelector('[data-redacted]')).toBeNull();
  });
});
