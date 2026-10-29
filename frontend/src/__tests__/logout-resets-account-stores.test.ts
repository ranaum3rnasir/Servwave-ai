/**
 * Cross-account leak found on staging: a technician saw the admin's whole task board.
 *
 * The API was never at fault - `GET /api/tasks` answered the technician with their single
 * assigned row. The board was showing what the PREVIOUS account had fetched.
 *
 * `clearQueryCache()` on logout drops the TanStack Query cache, but a Zustand store is a plain
 * module singleton: created once per page load, untouched by a logout. Signing back in is a
 * client-side navigation, so the module is never re-evaluated. `tasksStore` then compounds it -
 * `fetchTasks` short-circuits on `loaded`, so the incoming account does not merely see stale
 * rows for a moment, it never re-fetches at all and keeps them until a hard reload.
 *
 * These tests drive the store directly rather than through `logout()`, because `logout()` also
 * talks to Supabase and axios. What is under test is the reset wiring: that the registry runs
 * every registered store, and that a reset store re-fetches instead of short-circuiting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { resetAccountScopedStores, registerStoreReset } from '@/lib/storeReset';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const ADMIN_ROW = {
  id: 't-admin', task_number: 'T00049', title: 'QA-4 handover', description: '',
  status: 'TODO', priority: 'MEDIUM',
  assignee_ids: ['admin-id'], assignees: [{ id: 'admin-id', name: 'System Admin' }],
  due_at: null, linked_entity_type: null, linked_entity_id: null, tags: [],
  created_by: 'admin-id', created_at: '2026-08-25T10:00:00Z',
  updated_at: '2026-08-25T10:00:00Z', completed_at: null,
};

const TECH_ROW = { ...ADMIN_ROW, id: 't-tech', task_number: 'T00046', title: 'QA-1 access split' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logout empties the task store, not just the query cache', () => {
  it('drops the previous account\'s rows', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [ADMIN_ROW as never], loaded: true, loading: false });

    resetAccountScopedStores();

    expect(useTasksStore.getState().tasks).toEqual([]);
    expect(useTasksStore.getState().loaded).toBe(false);
  });

  /**
   * The half that made this visible rather than momentary. `fetchTasks` returns early while
   * `loaded` is true, so without clearing the flag the incoming account's fetch never fires
   * and the old rows stay on the board indefinitely.
   */
  it('lets the next account actually re-fetch, instead of short-circuiting on `loaded`', async () => {
    const { useTasksStore } = await import('@/stores/tasksStore');
    useTasksStore.setState({ tasks: [ADMIN_ROW as never], loaded: true, loading: false });

    // Before the reset: hydrated, so the guard swallows the call and the admin's row survives.
    mockApi.get.mockResolvedValue({ data: { tasks: [TECH_ROW] } });
    await useTasksStore.getState().fetchTasks();
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(useTasksStore.getState().tasks[0].task_number).toBe('T00049');

    resetAccountScopedStores();

    await useTasksStore.getState().fetchTasks();
    expect(mockApi.get).toHaveBeenCalled();
    const titles = useTasksStore.getState().tasks.map((t) => t.task_number);
    expect(titles).toEqual(['T00046']);
    expect(titles).not.toContain('T00049');
  });

  it('closes a drawer left open on the previous account\'s task', async () => {
    const { useTaskDetailStore } = await import('@/stores/taskDetailStore');
    useTaskDetailStore.setState({ openTaskId: 't-admin' });

    resetAccountScopedStores();

    expect(useTaskDetailStore.getState().openTaskId).toBeNull();
  });
});

/**
 * The filter bar is the same leak with a sharper edge.
 *
 * `taskFilterStore` holds a USER ID in `memberId`. Left behind on logout it narrows the next
 * account's list to a person from the previous account's roster, and the chip meant to name
 * that person finds nobody, so the filter bar renders a bare uuid.
 *
 * Note the store's no-filter sentinel is the STRING 'all'. Resetting the field to null or ''
 * typechecks and looks like a fix, while leaving an active-looking filter in place.
 */
describe('logout clears the task filter bar', () => {
  it("drops the previous account's member filter back to the no-filter sentinel", async () => {
    const { useTaskFilterStore } = await import('@/stores/taskFilterStore');
    useTaskFilterStore.getState().setMember('a-user-id-from-the-previous-org');

    resetAccountScopedStores();

    expect(useTaskFilterStore.getState().memberId).toBe('all');
  });

  it('clears every other dimension too, not just the member', async () => {
    const { useTaskFilterStore } = await import('@/stores/taskFilterStore');
    const filters = useTaskFilterStore.getState();
    filters.setDepartment('dept-from-the-previous-org');
    filters.setCategoryIds(['category-from-the-previous-org', 'none']);
    filters.setCategory('overdue');
    filters.setOverdue(true);
    filters.setAtRisk(true);
    filters.setDueRange({ from: '2026-08-01', to: '2026-08-31' });
    filters.setCreatedRange({ from: '2026-07-01', to: '2026-07-31' });

    resetAccountScopedStores();

    expect(useTaskFilterStore.getState()).toMatchObject({
      memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all',
      overdue: false, atRisk: false,
      dueFrom: '', dueTo: '', createdFrom: '', createdTo: '',
    });
  });
});

/**
 * The Tasks tabs' own toolbars (slice 10) are account data too: a List search or a History
 * "Everyone" scope typed by one account must not greet the next one, and the Calendar must open
 * on the current month, not wherever the previous user had paged to.
 */
describe('logout clears the Tasks tabs\' toolbars', () => {
  it('puts the List search, the Calendar period and the History toolbar back to their defaults', async () => {
    const { useTaskViewStore } = await import('@/stores/taskViewStore');
    const view = useTaskViewStore.getState();
    view.setListSearch('a search from the previous account');
    view.setCalendarMode('week');
    view.setCalendarAnchor(new Date('2020-01-15T12:00:00.000Z'));
    view.setHistoryScope('everyone');
    view.setHistoryRange('all');
    view.setHistorySearch('warranty');

    resetAccountScopedStores();

    const after = useTaskViewStore.getState();
    expect(after).toMatchObject({
      listSearch: '',
      calendarMode: 'month',
      historyScope: 'mine',
      historyRange: '30d',
      historySearch: '',
    });
    // Today, not the previous account's page: same UTC day as now.
    expect(after.calendarAnchor.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('the registry itself', () => {
  it('runs every registered resetter', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerStoreReset(a);
    registerStoreReset(b);

    resetAccountScopedStores();

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('a throwing resetter does not strand the others', () => {
    const after = vi.fn();
    registerStoreReset(() => { throw new Error('boom'); });
    registerStoreReset(after);

    expect(() => resetAccountScopedStores()).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });
});
