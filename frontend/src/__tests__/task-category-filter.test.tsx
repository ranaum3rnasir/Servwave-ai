/**
 * The Tasks Filter popover's Category facet (visits-and-task-categories slice 10).
 *
 * Category replaces Tag in the one Filter window on the Tasks page: multi-select, a count per
 * category, and a "No category" option. It is held in the module-level filter store, so it
 * scopes every tab and survives switching between them. The Dashboard's KPI drill-down - the
 * store's older `category` field - is a different thing and keeps working alongside it.
 *
 * Rendered through the real hub, the real filter store and the real task store; only the HTTP
 * layer is faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { taskCategoryKeys, type TaskCategoryRow } from '@/lib/api/taskCategories';
import type { TaskCategoryRef } from '@/lib/tasks/types';

vi.mock('@/pages/v2/tasks/views/dashboardView', () => ({ default: () => <div data-testid="dashboard-view" /> }));

import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';

/** The signed-in user in the harness (src/__tests__/setup.ts mocks auth.store). */
const ME = '00000000-0000-0000-0000-000000000001';

const FOLLOW_UP: TaskCategoryRef = { id: '11111111-1111-4111-8111-111111111111', name: 'Follow-up', color: '#22C55E' };
const PART_ORDER: TaskCategoryRef = { id: '22222222-2222-4222-8222-222222222222', name: 'Part order', color: '#F97316' };
const INTERNAL: TaskCategoryRef = { id: '33333333-3333-4333-8333-333333333333', name: 'Internal', color: '#6B7280' };
let categoryList: TaskCategoryRow[] = [];

// Due "today" the way My Day and the Calendar read it: the local calendar day as that day's UTC
// midnight, the form a due date is stored in. Every task is due today and assigned to the viewer,
// so all four views (the Board scopes to the viewer's own tasks) would show every one of them.
const todayIso = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString();
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromToday = (n: number) => new Date(new Date(todayIso()).getTime() + n * DAY_MS).toISOString();

interface RowOverrides { assignee?: string; due_at?: string | null; completed_at?: string | null }

function row(id: string, title: string, category: TaskCategoryRef | null, status = 'TODO', o: RowOverrides = {}) {
  const assignee = o.assignee ?? ME;
  return {
    id, task_number: `T-${id}`, title, description: '', status, priority: 'MEDIUM',
    assignee_ids: [assignee], assignees: [{ id: assignee, name: assignee === ME ? 'Test Admin' : 'Sam Other' }],
    watcher_ids: [],
    due_at: o.due_at === undefined ? todayIso() : o.due_at, linked_entity_type: null, linked_entity_id: null,
    // Left on the payload on purpose: the column stays in the database, and nothing may filter on it.
    tags: ['urgent'],
    category,
    created_by: ME, created_at: daysFromToday(-60), updated_at: daysFromToday(-1),
    completed_at: o.completed_at ?? null,
  };
}

const ROWS = [
  row('fu1', 'Call back about the quote', FOLLOW_UP),
  row('fu2', 'Chase the signed estimate', FOLLOW_UP, 'BLOCKED'),
  row('po1', 'Order the hinge kit', PART_ORDER),
  row('in1', 'Restock the van', INTERNAL),
  row('no1', 'Sweep the shop', null),
];
const ALL_TITLES = ROWS.map((r) => r.title);
let taskRows: ReturnType<typeof row>[] = ROWS;

beforeEach(() => {
  vi.clearAllMocks();
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  useTaskFilterStore.getState().reset();
  useTaskViewStore.getState().reset();
  taskRows = ROWS;
  categoryList = [FOLLOW_UP, PART_ORDER, INTERNAL].map((c, i) => ({ ...c, sort_order: i }));
  vi.mocked(api).get.mockImplementation((url: string) => {
    if (url === '/api/tasks') return Promise.resolve({ data: { tasks: taskRows } }) as ReturnType<typeof api.get>;
    if (url === '/api/task-categories') {
      return Promise.resolve({ data: { categories: categoryList } }) as ReturnType<typeof api.get>;
    }
    return Promise.resolve({ data: { users: [], tasks: [], departments: [] } }) as ReturnType<typeof api.get>;
  });
});

const openFilters = () => fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
const openCategoryPane = async () => {
  openFilters();
  fireEvent.click(await screen.findByRole('tab', { name: /^Category/ }));
};
const goTo = (tab: string) =>
  fireEvent.click(within(screen.getByTestId('tasks-tab-rail')).getByRole('tab', { name: tab }));

async function renderHub(tab = 'List') {
  const view = renderWithProviders(<TasksHubPage />);
  await waitFor(() => expect(useTasksStore.getState().tasks).toHaveLength(taskRows.length));
  goTo(tab);
  return view;
}

/** The Category chip under the tab strip ("Category: Follow-up, Part order"), or null. */
function categoryChipText(): string | null {
  const remove = screen.queryByRole('button', { name: 'Remove Category filter' });
  return remove?.parentElement?.textContent ?? null;
}

/** Which of the fixture's tasks the active view shows, by title. */
function visibleTitles(titles = ALL_TITLES): string[] {
  return titles.filter((t) => screen.queryAllByText(t).length > 0);
}

describe('the Filter window offers Category, not Tag', () => {
  it('lists every category with its task count, and "No category"', async () => {
    await renderHub();
    openFilters();

    expect(screen.queryByRole('tab', { name: /^Tag/ })).not.toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist', { name: 'Filter facets' })).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Member', 'Department', 'Category', 'Due', 'Created', 'Only show']);

    fireEvent.click(screen.getByRole('tab', { name: 'Category' }));
    expect(await screen.findByRole('checkbox', { name: 'Follow-up, 2 tasks' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Part order, 1 task' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Internal, 1 task' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'No category, 1 task' })).toBeInTheDocument();
  });

  it('counts only the tasks the current view holds: the other facets narrow them', async () => {
    // Blocked + Follow-up is one task; the KPI drill-down narrows the List it counts over.
    useTaskFilterStore.setState({ category: 'blocked' });
    await renderHub();
    await openCategoryPane();

    expect(await screen.findByRole('checkbox', { name: 'Follow-up, 1 task' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Part order, 0 tasks' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'No category, 0 tasks' })).toBeInTheDocument();
  });
});

describe('selecting categories narrows the view', () => {
  it('with nothing selected, every task shows', async () => {
    await renderHub();
    expect(visibleTitles()).toEqual(ALL_TITLES);
  });

  it('Follow-up and Part order show the tasks in either category', async () => {
    await renderHub();
    await openCategoryPane();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Follow-up/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Part order/ }));

    expect(useTaskFilterStore.getState().categoryIds).toEqual([FOLLOW_UP.id, PART_ORDER.id]);
    expect(visibleTitles()).toEqual([
      'Call back about the quote', 'Chase the signed estimate', 'Order the hinge kit',
    ]);
    // Two ticks, one facet: the trigger counts both, and one chip names them.
    expect(within(screen.getByRole('button', { name: /^filter/i })).getByText('2')).toBeInTheDocument();
    expect(categoryChipText()).toBe('Category:Follow-up, Part order');
  });

  it('"No category" shows the uncategorised tasks, and combines with a named category', async () => {
    await renderHub();
    await openCategoryPane();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^No category/ }));
    expect(visibleTitles()).toEqual(['Sweep the shop']);

    fireEvent.click(screen.getByRole('checkbox', { name: /^Internal/ }));
    expect(visibleTitles()).toEqual(['Restock the van', 'Sweep the shop']);
  });

  it('unticking the last one shows every task again', async () => {
    useTaskFilterStore.setState({ categoryIds: [INTERNAL.id] });
    await renderHub();
    await openCategoryPane();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Internal/ }));
    expect(visibleTitles()).toEqual(ALL_TITLES);
  });

  it('the chip drops the whole facet', async () => {
    useTaskFilterStore.setState({ categoryIds: [FOLLOW_UP.id, INTERNAL.id] });
    await renderHub();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Category filter' }));
    expect(useTaskFilterStore.getState().categoryIds).toEqual([]);
    expect(visibleTitles()).toEqual(ALL_TITLES);
  });
});

describe('the selection applies on Board, List, Calendar and My Day, and persists between them', () => {
  it.each(['My Day', 'Board', 'List', 'Calendar'])('%s shows only the selected category', async (tab) => {
    await renderHub('List');
    await openCategoryPane();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Part order/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    goTo(tab);
    await waitFor(() => expect(visibleTitles()).toEqual(['Order the hinge kit']));
    expect(useTaskFilterStore.getState().categoryIds).toEqual([PART_ORDER.id]);
  });
});

describe('a category renamed or deleted while selected', () => {
  it('a rename shows the new name on the chip and keeps the selection', async () => {
    useTaskFilterStore.setState({ categoryIds: [FOLLOW_UP.id] });
    const { queryClient } = await renderHub();
    await waitFor(() => expect(categoryChipText()).toBe('Category:Follow-up'));

    // What useUpdateTaskCategory does on success.
    const renamed = { ...FOLLOW_UP, name: 'Callback' };
    act(() => {
      queryClient.setQueryData<TaskCategoryRow[]>(taskCategoryKeys.all, (prev) =>
        prev?.map((c) => (c.id === renamed.id ? { ...c, ...renamed } : c)));
      useTasksStore.getState().applyCategory(renamed);
    });

    await waitFor(() => expect(categoryChipText()).toBe('Category:Callback'));
    expect(visibleTitles()).toEqual(['Call back about the quote', 'Chase the signed estimate']);
  });

  it('a delete drops the id from the filter: the view shows every task and no chip names a bare id', async () => {
    useTaskFilterStore.setState({ categoryIds: [FOLLOW_UP.id] });
    const { queryClient } = await renderHub();
    await waitFor(() => expect(visibleTitles()).toHaveLength(2));

    // What useDeleteTaskCategory does on success with "keep the tasks".
    act(() => {
      queryClient.setQueryData<TaskCategoryRow[]>(taskCategoryKeys.all, (prev) => prev?.filter((c) => c.id !== FOLLOW_UP.id));
      useTasksStore.getState().applyCategoryDeleted({ categoryId: FOLLOW_UP.id, movedTo: null, deletedTaskIds: [] });
    });

    await waitFor(() => expect(visibleTitles()).toEqual(ALL_TITLES));
    expect(screen.queryByRole('button', { name: 'Remove Category filter' })).not.toBeInTheDocument();
    expect(screen.queryByText(FOLLOW_UP.id)).not.toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^filter/i })).queryByText('1')).not.toBeInTheDocument();

    // The pane no longer offers it, and ticking another category starts clean.
    await openCategoryPane();
    expect(screen.queryByRole('checkbox', { name: /^Follow-up/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Internal/ }));
    expect(useTaskFilterStore.getState().categoryIds).toEqual([INTERNAL.id]);
  });

  it('an id the org no longer has (deleted in another session) is ignored on load', async () => {
    useTaskFilterStore.setState({ categoryIds: ['99999999-9999-4999-8999-999999999999', PART_ORDER.id] });
    await renderHub();
    await waitFor(() => expect(visibleTitles()).toEqual(['Order the hinge kit']));
    expect(categoryChipText()).toBe('Category:Part order');
    expect(screen.queryByText(/9999/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^filter/i })).getByText('1')).toBeInTheDocument();
  });
});

describe('the Dashboard KPI drill-down still works beside it', () => {
  it('ANDs with the category selection, and has its own chip', async () => {
    useTaskFilterStore.setState({ category: 'blocked', categoryIds: [FOLLOW_UP.id] });
    await renderHub();
    await waitFor(() => expect(visibleTitles()).toEqual(['Chase the signed estimate']));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Dashboard filter' }));
    expect(useTaskFilterStore.getState().category).toBe('all');
    expect(useTaskFilterStore.getState().categoryIds).toEqual([FOLLOW_UP.id]);
    expect(visibleTitles()).toEqual(['Call back about the quote', 'Chase the signed estimate']);
  });

  it('the panel Clear all clears both', async () => {
    useTaskFilterStore.setState({ category: 'blocked', categoryIds: [FOLLOW_UP.id] });
    await renderHub();
    openFilters();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    expect(useTaskFilterStore.getState().category).toBe('all');
    expect(useTaskFilterStore.getState().categoryIds).toEqual([]);
  });
});

/**
 * The verifier's finding: the counts were taken before each view's OWN narrowing, so My Day
 * offered "Part order, 1 task" and then showed "Nothing due today". The ruling: in every view,
 * a category's count is exactly the number of rows ticking it then shows in that view.
 *
 * So the fixture is deliberately uneven - done, cancelled, closed long ago, due tomorrow, due
 * outside the visible month, no due date, and somebody else's task - and every view drops a
 * different subset of it.
 */
describe('in every view, a count is exactly the rows that ticking it shows', () => {
  const OTHER = '00000000-0000-0000-0000-00000000beef';
  const MIXED = [
    row('m1', 'Follow up today', FOLLOW_UP),
    row('m2', 'Follow up tomorrow', FOLLOW_UP, 'TODO', { due_at: daysFromToday(1) }),
    row('m3', 'Follow-up closed yesterday', FOLLOW_UP, 'DONE', { due_at: daysFromToday(-1), completed_at: daysFromToday(-1) }),
    row('m4', 'Somebody else orders parts', PART_ORDER, 'TODO', { assignee: OTHER }),
    row('m5', 'Parts due next quarter', PART_ORDER, 'TODO', { due_at: daysFromToday(45) }),
    row('m6', 'Internal job cancelled', INTERNAL, 'CANCELLED', { due_at: daysFromToday(-2), completed_at: daysFromToday(-2) }),
    row('m7', 'Internal closed weeks ago', INTERNAL, 'DONE', { due_at: daysFromToday(-20), completed_at: daysFromToday(-20) }),
    row('m8', 'Uncategorised with no date', null, 'TODO', { due_at: null }),
    row('m9', 'Uncategorised in two days', null, 'IN_PROGRESS', { due_at: daysFromToday(2) }),
  ];
  const TITLES = MIXED.map((r) => r.title);
  const OPTIONS = [/^Follow-up, /, /^Part order, /, /^Internal, /, /^No category, /];

  beforeEach(() => { taskRows = MIXED; });

  /** For each option: read its count, tick it alone, count the rows the view shows, untick. */
  async function expectCountsMatchRows(): Promise<number[]> {
    await openCategoryPane();
    const seen: number[] = [];
    for (const name of OPTIONS) {
      const box = await screen.findByRole('checkbox', { name });
      const count = Number(/, (\d+) tasks?$/.exec(box.getAttribute('aria-label') ?? '')?.[1]);
      fireEvent.click(box);
      await waitFor(() => expect(visibleTitles(TITLES)).toHaveLength(count));
      seen.push(count);
      fireEvent.click(screen.getByRole('checkbox', { name }));
    }
    return seen;
  }

  it('My Day: only open tasks of mine due today or earlier', async () => {
    await renderHub('My Day');
    // Follow up today; nothing for Part order (one is not mine, one is due later); no Internal
    // (closed); nothing uncategorised (one has no date, one is due in two days).
    expect(await expectCountsMatchRows()).toEqual([1, 0, 0, 0]);
  });

  it('Board: my tasks, no cancelled lane, no Done closed before the window', async () => {
    await renderHub('Board');
    expect(await expectCountsMatchRows()).toEqual([3, 1, 0, 2]);
  });

  it('List: every task, then narrowed by its own search box', async () => {
    await renderHub('List');
    expect(await expectCountsMatchRows()).toEqual([3, 2, 2, 2]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'today' } });
    expect(await expectCountsMatchRows()).toEqual([1, 0, 0, 0]);
  });

  it('Calendar: the visible period only, in Month and in Week', async () => {
    await renderHub('Calendar');
    await expectCountsMatchRows();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    await expectCountsMatchRows();
    // The task due in 45 days is outside both periods, so Part order counts only the other one.
    expect(screen.getByRole('checkbox', { name: /^Part order, / })).toHaveAccessibleName('Part order, 1 task');
  });

  it('History: closed tasks in its range and scope, as the toolbar sets them', async () => {
    await renderHub('History');
    // Mine, last 30 days: the Follow-up closed yesterday, both Internal closures.
    expect(await expectCountsMatchRows()).toEqual([1, 0, 2, 0]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(await expectCountsMatchRows()).toEqual([1, 0, 1, 0]);
  });
});
