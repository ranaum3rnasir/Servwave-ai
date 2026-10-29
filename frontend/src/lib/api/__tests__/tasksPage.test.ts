import { describe, it, expect, vi, beforeEach } from 'vitest';

import api from '@/lib/axios';
import { listTasksPage } from '@/lib/api/tasks';
import { taskListFilterParams, type TaskListFilterInput } from '@/lib/tasks/taskListQuery';

const mockApi = vi.mocked(api);

const OFF: TaskListFilterInput = {
  memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all',
  overdue: false, atRisk: false, dueFrom: '', dueTo: '', createdFrom: '', createdTo: '',
};

describe('taskListFilterParams (the Filter window and the search, as the server query)', () => {
  it('is empty when nothing is filtered, so the same state is always the same query', () => {
    expect(taskListFilterParams(OFF, '')).toEqual({});
    expect(taskListFilterParams({ ...OFF, category: undefined }, '   ')).toEqual({});
  });

  it('maps every facet the browser used to apply, and the Dashboard drill-down', () => {
    expect(taskListFilterParams({
      memberId: 'u1', departmentId: 'd1', categoryIds: ['c1', 'none'], category: 'atRisk',
      overdue: true, atRisk: true, dueFrom: '2026-07-01', dueTo: '2026-07-31',
      createdFrom: '2026-06-01', createdTo: '2026-06-30',
    }, '  hinge ')).toEqual({
      member_id: 'u1', department_id: 'd1', category_ids: ['c1', 'none'], drill: 'atRisk',
      overdue: true, at_risk: true, due_from: '2026-07-01', due_to: '2026-07-31',
      created_from: '2026-06-01', created_to: '2026-06-30', q: 'hinge',
    });
  });
});

describe('listTasksPage', () => {
  beforeEach(() => vi.clearAllMocks());

  const body = {
    tasks: [{
      id: 't1', task_number: 'T00001', title: 'One', description: '', status: 'TODO', priority: 'LOW',
      assignee_ids: [], assignees: [], due_at: null, linked_entity_type: null, linked_entity_id: null,
      tags: [], created_by: 'u', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
      completed_at: null,
    }],
    page: { limit: 25, offset: 0, total: 40, has_more: true },
    category_counts: { c1: 3, none: 37 },
  };

  it('sends only the constraints that are on, the category ids as one comma list', async () => {
    mockApi.get.mockResolvedValue({ data: body } as never);

    await listTasksPage({
      limit: 25, offset: 0, category_ids: ['c1', 'none'], overdue: true, at_risk: false, q: '', due_from: '2026-07-01',
    });

    expect(mockApi.get).toHaveBeenCalledWith('/api/tasks', {
      params: { limit: 25, offset: 0, category_ids: 'c1,none', overdue: true, due_from: '2026-07-01' },
    });
  });

  it('answers the rows as Tasks, the total, whether more follow, and the first page\'s category counts', async () => {
    mockApi.get.mockResolvedValue({ data: body } as never);

    const page = await listTasksPage({ limit: 25, offset: 0 });

    expect(page.tasks.map((t) => t.title)).toEqual(['One']);
    expect(page).toMatchObject({ total: 40, hasMore: true, offset: 0, categoryCounts: { c1: 3, none: 37 } });
  });

  it('a later page carries no category counts', async () => {
    mockApi.get.mockResolvedValue({ data: { ...body, page: { ...body.page, offset: 25 }, category_counts: undefined } } as never);

    expect((await listTasksPage({ limit: 25, offset: 25 })).categoryCounts).toBeNull();
  });
});
