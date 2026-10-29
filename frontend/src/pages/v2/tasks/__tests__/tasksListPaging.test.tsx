/**
 * The Tasks List tab, paged on the server and drawn as cards on a phone (mobile slice 72).
 *
 * The list used to filter and search a copy of every task in the organisation held in the browser.
 * It now asks the server for one page at a time, with the filters and the search on the request,
 * and asks for the next page as the reader scrolls. These tests read what the browser ASKS for
 * (`api.get` calls) and what it does with the answer; the server's own filtering is pinned in
 * backend/src/__tests__/tasks-list-page.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { answerTasksRequest, isTaskListPageRequest, type ListRequestConfig } from '@/__tests__/support/taskListServer';
import { emulateDevice, PHONE_PORTRAIT } from '@/__tests__/support/deviceShape';
import api from '@/lib/axios';
import { TASK_LIST_PAGE_SIZE } from '@/lib/tasks/useTaskListPage';
import type { Task } from '@/lib/tasks/types';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskViewStore } from '@/stores/taskViewStore';

import ListView from '../views/listView';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

const mockApi = vi.mocked(api);

function makeTask(n: number, over: Partial<Task> = {}): Task {
  return {
    id: `t${n}`,
    task_number: `T${String(n).padStart(5, '0')}`,
    title: `Task number ${n}`,
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    assignee_ids: ['u1'],
    assignees: [{ id: 'u1', name: 'Dana Reyes' }],
    watcher_ids: [],
    due_at: null,
    linked_entity: null,
    tags: [],
    category: null,
    subtasks: [],
    created_by: 'u1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    completed_at: null,
    activity: [],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...over,
  };
}

const many = (count: number) => Array.from({ length: count }, (_, i) => makeTask(i + 1));

/** What the "server" holds; the mocked endpoint pages it. */
let held: Task[];
/** How many of the next task-list requests the "network" drops. */
let dropped = 0;

const listRequests = () =>
  mockApi.get.mock.calls.filter(([url, config]) => isTaskListPageRequest(url as string, config as ListRequestConfig));
const lastListParams = () => (listRequests().at(-1)![1] as { params: Record<string, unknown> }).params;

beforeEach(() => {
  vi.clearAllMocks();
  held = many(60);
  dropped = 0;
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  useTaskFilterStore.getState().reset();
  useTaskViewStore.getState().reset();
  mockApi.get.mockImplementation(((url: string, config?: ListRequestConfig) => {
    if (url === '/api/task-categories') {
      return Promise.resolve({ data: { categories: [{ id: 'c1', name: 'Follow-up', color: '#22C55E', sort_order: 0 }] } });
    }
    if (url !== '/api/tasks') return Promise.resolve({ data: {} });
    if (dropped > 0) { dropped -= 1; return Promise.reject(new Error('offline')); }
    return Promise.resolve(answerTasksRequest(held, config));
  }) as typeof api.get);
});

/** Rows the reader can see, whichever layout is drawn. */
const visibleTitles = () =>
  screen.queryAllByText(/^Task number \d+$/).map((el) => el.textContent);

describe('the List tab asks for ONE bounded page, not the organisation', () => {
  it('requests the first page with a limit, and draws only that page', async () => {
    renderWithProviders(<ListView />);

    await screen.findByText('Task number 1');
    expect(listRequests()).toHaveLength(1);
    expect(lastListParams()).toMatchObject({ limit: TASK_LIST_PAGE_SIZE, offset: 0 });
    expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE);
    // The header counts everything the filters match, not just what is drawn.
    expect(screen.getByText('60 tasks')).toBeInTheDocument();
  });

  it('never asks for the unbounded list (a request with no limit)', async () => {
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');

    const unbounded = mockApi.get.mock.calls.filter(
      ([url, config]) => url === '/api/tasks' && (config as { params?: { limit?: unknown } } | undefined)?.params?.limit === undefined,
    );
    expect(unbounded).toHaveLength(0);
  });
});

describe('loading more', () => {
  it('"Load more" asks for the next offset and appends it, until the last page', async () => {
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');
    expect(screen.getByText(`Showing ${TASK_LIST_PAGE_SIZE} of 60 tasks`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE * 2));
    expect(lastListParams()).toMatchObject({ limit: TASK_LIST_PAGE_SIZE, offset: TASK_LIST_PAGE_SIZE });
    // Page one is still there, in order, with page two after it.
    expect(visibleTitles().slice(0, 2)).toEqual(['Task number 1', 'Task number 2']);
    expect(visibleTitles()[TASK_LIST_PAGE_SIZE]).toBe('Task number 26');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(visibleTitles()).toHaveLength(60));
    // Nothing left to ask for.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  describe('as the reader scrolls to the end of the list', () => {
    type Entry = { isIntersecting: boolean };
    let watchers: Array<(entries: Entry[]) => void>;

    beforeEach(() => {
      watchers = [];
      vi.stubGlobal('IntersectionObserver', class {
        constructor(cb: (entries: Entry[]) => void) { watchers.push(cb); }
        observe() {}
        unobserve() {}
        disconnect() {}
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('asks for the next page without a tap when the end of the list comes into view', async () => {
      renderWithProviders(<ListView />);
      await screen.findByText('Task number 1');
      expect(listRequests()).toHaveLength(1);

      // The end of the list scrolls into view.
      act(() => watchers.at(-1)!([{ isIntersecting: true }]));

      await waitFor(() => expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE * 2));
      expect(lastListParams()).toMatchObject({ offset: TASK_LIST_PAGE_SIZE });
    });

    it('does nothing while the end of the list is still out of view', async () => {
      renderWithProviders(<ListView />);
      await screen.findByText('Task number 1');

      act(() => watchers.at(-1)!([{ isIntersecting: false }]));

      expect(listRequests()).toHaveLength(1);
    });
  });

  it('a failed next page keeps the rows already loaded and offers Retry', async () => {
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');

    dropped = 1;
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText("Couldn't load more tasks.")).toBeInTheDocument();
    expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE);

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE * 2));
  });

  it('a failed first page says so with a Retry, never "No tasks match"', async () => {
    dropped = 1;
    renderWithProviders(<ListView />);

    expect(await screen.findByText("Couldn't load tasks.")).toBeInTheDocument();
    expect(screen.queryByText('No tasks match your search.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Task number 1')).toBeInTheDocument();
  });
});

describe('the filters and the search run on the server', () => {
  it('sends the Filter window to the server and draws what comes back, filtered by nobody here', async () => {
    // None of these 60 tasks is overdue or in the member's name or due in July: if the browser
    // still filtered, an empty list would be drawn. The server decides, so they are all shown.
    useTaskFilterStore.setState({
      memberId: 'u9', departmentId: 'd1', overdue: true, dueFrom: '2026-07-01', dueTo: '2026-07-31',
      createdFrom: '2026-06-01', createdTo: '2026-06-30', categoryIds: ['c1', 'none'], category: 'blocked',
    });
    // The category ids are read through the org's live list; with none loaded they are kept as is.
    renderWithProviders(<ListView />);

    await screen.findByText('Task number 1');
    expect(lastListParams()).toMatchObject({
      limit: TASK_LIST_PAGE_SIZE,
      offset: 0,
      member_id: 'u9',
      department_id: 'd1',
      overdue: true,
      due_from: '2026-07-01',
      due_to: '2026-07-31',
      created_from: '2026-06-01',
      created_to: '2026-06-30',
      category_ids: 'c1,none',
      drill: 'blocked',
    });
    expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE);
  });

  it('sends nothing for a filter that is off', async () => {
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');

    expect(Object.keys(lastListParams()).sort()).toEqual(['limit', 'offset']);
  });

  it('typing in the search asks the server for a new first page with q, once the typing pauses', async () => {
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');
    // Page two is loaded: a search must start over at the first page of ITS answer.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(visibleTitles()).toHaveLength(TASK_LIST_PAGE_SIZE * 2));
    const before = listRequests().length;

    held = [makeTask(7, { title: 'Replace the hinge kit' })];
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hinge' } });

    // Not on every keystroke: nothing yet.
    expect(listRequests()).toHaveLength(before);
    expect(await screen.findByText('Replace the hinge kit')).toBeInTheDocument();
    expect(lastListParams()).toMatchObject({ q: 'hinge', offset: 0 });
    expect(visibleTitles()).toEqual([]);
    expect(screen.getByText('1 task')).toBeInTheDocument();
  });

  it('an empty answer reads "No tasks match your search."', async () => {
    held = [];
    renderWithProviders(<ListView />);
    expect(await screen.findByText('No tasks match your search.')).toBeInTheDocument();
    expect(screen.getByText('0 tasks')).toBeInTheDocument();
  });
});

describe('cards on a phone, the table from lg up', () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it('draws one card per task at phone width, with no table and no sideways scroll box', async () => {
    restore = emulateDevice({ ...PHONE_PORTRAIT, viewportWidth: 390 });
    const { container } = renderWithProviders(<ListView />);

    const list = await screen.findByRole('list', { name: 'Tasks' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(TASK_LIST_PAGE_SIZE);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(container.querySelector('.overflow-x-auto')).toBeNull();

    // A card carries what the table's columns did, as labelled lines, and opens the task by tap.
    const first = within(list).getAllByRole('listitem')[0]!;
    for (const label of ['Category', 'Assignees', 'Priority', 'Linked', 'Due', 'Created']) {
      expect(within(first).getByText(label)).toBeInTheDocument();
    }
    expect(within(first).getByText('T00001')).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Task number 1' })).toBeInTheDocument();
  });

  it('still loads more at phone width', async () => {
    restore = emulateDevice({ ...PHONE_PORTRAIT, viewportWidth: 320 });
    renderWithProviders(<ListView />);
    await screen.findByRole('list', { name: 'Tasks' });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('listitem')).toHaveLength(TASK_LIST_PAGE_SIZE * 2));
  });

  it('keeps the table at desktop width', async () => {
    restore = emulateDevice({ coarsePointer: false, screenWidth: 1920, screenHeight: 1080, viewportWidth: 1280 });
    renderWithProviders(<ListView />);

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(TASK_LIST_PAGE_SIZE + 1);
  });
});

describe('a write elsewhere on the Tasks page reaches the list', () => {
  it('a delete asks the server again, so the row leaves and the count follows', async () => {
    mockApi.delete.mockResolvedValue({ data: {} } as never);
    useTasksStore.setState({ tasks: held, loaded: true });
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');
    const before = listRequests().length;

    held = held.filter((t) => t.id !== 't1');
    await act(async () => { await useTasksStore.getState().deleteTask('t1'); });

    await waitFor(() => expect(screen.queryByText('Task number 1')).not.toBeInTheDocument());
    expect(listRequests().length).toBeGreaterThan(before);
    expect(screen.getByText('59 tasks')).toBeInTheDocument();
  });

  it('an edit made in the drawer shows on the row at once (the store row wins over the page row)', async () => {
    useTasksStore.setState({ tasks: held, loaded: true });
    renderWithProviders(<ListView />);
    await screen.findByText('Task number 1');

    act(() => {
      useTasksStore.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === 't1' ? { ...t, title: 'Renamed in the drawer' } : t)) }));
    });

    expect(screen.getByText('Renamed in the drawer')).toBeInTheDocument();
  });
});
