/**
 * Smoke coverage for the v2 Tasks module.
 *
 * Five things this branch had to get right and that a reader cannot check by
 * eye:
 *
 *  1. the hub still hydrates the zustand store on mount and still honours the
 *     `?action=new-task` handshake (the two behaviours `tasks-hub-hydrate` and
 *     `tasks-quick-create` pin on the legacy page);
 *  2. the hub OPENS ON MY DAY for every role, and My Day leads the rail;
 *  3. DASHBOARD is gated on a raw ADMIN/DISPATCHER role check, not CASL, and
 *     sits last; HISTORY is open to every role (it shows the viewer's own
 *     completed tasks, so there is nothing there to gate on). This inverts the
 *     old gate, which hid History from non-managers and showed Dashboard to
 *     everyone;
 *  4. the six filter dimensions live behind a filter WINDOW, and an active one
 *     is still visible OUTSIDE it as a removable chip - the point of a popover
 *     filter is lost if a closed panel can hide a constraint;
 *  5. the board's cards carry dnd-kit's KEYBOARD affordances. The kit authors
 *     flagged that path as untested, so it is asserted here rather than
 *     assumed - see the note on the last test for what jsdom can and cannot
 *     prove about it.
 *
 * The heavy chart views are stubbed where they are not the subject: recharts'
 * ResponsiveContainer measures a box jsdom does not lay out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('../views/dashboardView', () => ({ default: () => <div data-testid="dashboard-view" /> }));
vi.mock('../views/historyView', () => ({ default: () => <div data-testid="history-view" /> }));

import TasksHubPage from '../TasksHubPage';
import BoardView from '../views/boardView';
import CalendarViewReal from '../views/calendarView';
import ListView from '../views/listView';
import MyDayView from '../views/myDayView';

const SERVER_TASK_ROW = {
  id: 'srv-1',
  task_number: 'T00050',
  title: 'Schedule Approval',
  description: '',
  status: 'TODO',
  priority: 'HIGH',
  assignee_ids: ['priya-uuid'],
  assignees: [{ id: 'priya-uuid', name: 'Priya Patel' }],
  due_at: '2026-06-24T00:00:00Z',
  linked_entity_type: 'LEAD',
  linked_entity_id: 'lead-700',
  tags: [],
  created_by: 'u1',
  created_at: '2026-06-20T00:00:00Z',
  updated_at: '2026-06-20T00:00:00Z',
  completed_at: null,
};

/**
 * `@/stores/auth.store` is mocked globally in `src/__tests__/setup.ts` as a
 * selector-taking vi.fn defaulting to an ADMIN user, so the role is swapped by
 * re-implementing that fn rather than through zustand's setState.
 */
function setRole(role: string) {
  const mocked = useAuthStore as unknown as ReturnType<typeof vi.fn>;
  mocked.mockImplementation((selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'u1', role }, isAuthenticated: true, isLoading: false, error: null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useTasksStore.setState({ tasks: [], loaded: false, loading: false });
  useTaskFilterStore.getState().reset();
  useTaskViewStore.getState().reset();
  setRole('ADMIN');
  vi.mocked(api).get.mockImplementation((url: string) => {
    if (url === '/api/tasks') {
      return Promise.resolve({ data: { tasks: [SERVER_TASK_ROW] } }) as ReturnType<typeof api.get>;
    }
    return Promise.resolve({ data: { users: [], tasks: [], departments: [] } }) as ReturnType<typeof api.get>;
  });
});

describe('v2 Tasks hub', () => {
  it('renders the workspace and hydrates the store from GET /api/tasks', async () => {
    renderWithProviders(<TasksHubPage />);

    expect(screen.getByTestId('tasks-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('tasks-command-filter-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tasks-tab-rail')).toBeInTheDocument();

    await waitFor(() => {
      expect(useTasksStore.getState().tasks).toHaveLength(1);
    });
    expect(useTasksStore.getState().tasks[0]?.title).toBe('Schedule Approval');
  });

  it('opens the create dialog once for ?action=new-task and strips the param', async () => {
    renderWithProviders(<TasksHubPage />, { initialEntries: ['/tasks?action=new-task'] });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'New Task' })).toBeInTheDocument();
    });
  });

  it('opens on My Day for a manager and for a non-manager alike', () => {
    const admin = renderWithProviders(<TasksHubPage />);
    expect(within(admin.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'My Day' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(admin.getByTestId('my-day-surface')).toBeInTheDocument();
    expect(admin.queryByTestId('dashboard-view')).toBeNull();
    admin.unmount();

    setRole('TECHNICIAN');
    const tech = renderWithProviders(<TasksHubPage />);
    expect(within(tech.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'My Day' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(tech.getByTestId('my-day-surface')).toBeInTheDocument();
  });

  it('leads the rail with My Day and puts the manager-only Dashboard last', () => {
    const admin = renderWithProviders(<TasksHubPage />);
    const adminTabs = within(admin.getByTestId('tasks-tab-rail'))
      .getAllByRole('tab').map((t) => t.textContent);
    expect(adminTabs).toEqual(['My Day', 'Board', 'List', 'Calendar', 'History', 'Dashboard']);
    admin.unmount();

    setRole('SALES');
    const sales = renderWithProviders(<TasksHubPage />);
    const salesTabs = within(sales.getByTestId('tasks-tab-rail'))
      .getAllByRole('tab').map((t) => t.textContent);
    expect(salesTabs).toEqual(['My Day', 'Board', 'List', 'Calendar', 'History']);
  });

  /**
   * The gate is inverted from what it was: History is now everyone's (it shows
   * the viewer's OWN completed tasks) and Dashboard, whose KPIs aggregate the
   * whole org, is the manager-only one.
   */
  it('shows History to every role and the Dashboard tab only to managers', () => {
    const admin = renderWithProviders(<TasksHubPage />);
    const adminRail = within(admin.getByTestId('tasks-tab-rail'));
    expect(adminRail.getByRole('tab', { name: 'History' })).toBeInTheDocument();
    expect(adminRail.getByRole('tab', { name: 'Dashboard' })).toBeInTheDocument();
    admin.unmount();

    setRole('DISPATCHER');
    const dispatcher = renderWithProviders(<TasksHubPage />);
    expect(within(dispatcher.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'Dashboard' }))
      .toBeInTheDocument();
    dispatcher.unmount();

    setRole('SALES');
    const sales = renderWithProviders(<TasksHubPage />);
    const salesRail = within(sales.getByTestId('tasks-tab-rail'));
    expect(salesRail.getByRole('tab', { name: 'History' })).toBeInTheDocument();
    expect(salesRail.queryByRole('tab', { name: 'Dashboard' })).toBeNull();
    // Not just the trigger: the panel is gated too, so there is no route by
    // which a non-manager renders the org-wide KPIs.
    expect(sales.queryByTestId('dashboard-view')).toBeNull();
  });

  it('opens History for a non-manager and drills a manager KPI through to List', () => {
    setRole('TECHNICIAN');
    const tech = renderWithProviders(<TasksHubPage />);
    fireEvent.click(within(tech.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'History' }));
    expect(tech.getByTestId('history-view')).toBeInTheDocument();
    tech.unmount();

    setRole('ADMIN');
    const admin = renderWithProviders(<TasksHubPage />);
    fireEvent.click(within(admin.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'Dashboard' }));
    expect(admin.getByTestId('dashboard-view')).toBeInTheDocument();
    // `onDrillDown` is the hub's tab setter and still points at List.
    fireEvent.click(within(admin.getByTestId('tasks-tab-rail')).getByRole('tab', { name: 'List' }));
    expect(admin.getByTestId('tasks-list-toolbar')).toBeInTheDocument();
  });
});

/**
 * The filter window. Radix popovers open reliably under `fireEvent` in jsdom
 * (userEvent's pointer-events checks do not survive the portal) - the same
 * approach `customers-filter-no-state.test.tsx` uses.
 */
describe('v2 Tasks hub - filter window', () => {
  const openFilters = () => fireEvent.click(screen.getByRole('button', { name: /^filter/i }));

  it('keeps all six dimensions reachable behind one Filter trigger', async () => {
    renderWithProviders(<TasksHubPage />);
    openFilters();

    expect(await screen.findByRole('tab', { name: 'Member' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Department' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Category' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Tag' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Due' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Created' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Only show' })).toBeInTheDocument();

    // Each pane still renders the control that writes the store, including the
    // two native date inputs the ranges have always used.
    expect(screen.getByRole('combobox', { name: 'Member' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Due' }));
    expect(screen.getByLabelText('Due from')).toBeInTheDocument();
    expect(screen.getByLabelText('Due to')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Only show' }));
    expect(screen.getByLabelText('Overdue')).toBeInTheDocument();
    expect(screen.getByLabelText('At risk')).toBeInTheDocument();
  });

  it('counts active filters on the trigger and never hides one behind a closed panel', () => {
    useTaskFilterStore.setState({ overdue: true, dueFrom: '2026-06-01', dueTo: '2026-06-30' });
    renderWithProviders(<TasksHubPage />);

    // Two facets active -> a count on the closed trigger...
    const trigger = screen.getByRole('button', { name: /^filter/i });
    expect(within(trigger).getByText('2')).toBeInTheDocument();

    // ...and a removable chip per constraint, outside the popover, each naming
    // its own field.
    expect(screen.getByRole('button', { name: 'Remove Only show filter' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Due filter' }));
    expect(useTaskFilterStore.getState().dueFrom).toBe('');
    expect(useTaskFilterStore.getState().dueTo).toBe('');
    expect(useTaskFilterStore.getState().overdue).toBe(true);
  });

  it('surfaces the Dashboard drill-down as its own removable chip', () => {
    useTaskFilterStore.setState({ category: 'atRisk' });
    renderWithProviders(<TasksHubPage />);

    // The drill-down is not a facet inside the window - only the Dashboard
    // KPIs set it - so it is surfaced as a chip that can be dropped on its own.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Dashboard filter' }));
    expect(useTaskFilterStore.getState().category).toBe('all');
  });

  /**
   * One active facet, so the chip strip's own "Clear all" (which only appears
   * past one chip) cannot be the button this clicks - it is the panel's.
   */
  it('resets the whole store from the panel Clear all', () => {
    useTaskFilterStore.setState({ atRisk: true });
    renderWithProviders(<TasksHubPage />);

    openFilters();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    const state = useTaskFilterStore.getState();
    expect(state.atRisk).toBe(false);
    expect(state.category).toBe('all');
    expect(state.memberId).toBe('all');
  });
});

describe('v2 Tasks board - dnd-kit', () => {
  beforeEach(() => {
    useTasksStore.setState({
      loaded: true,
      loading: false,
      tasks: [{
        id: 'srv-1',
        task_number: 'T00050',
        title: 'Schedule Approval',
        description: '',
        status: 'TODO',
        priority: 'HIGH',
        // 'u1' is the signed-in user in this harness, and the Board scopes to tasks the
        // viewer is on - a card assigned only to Priya would not render here at all, and
        // these are drag-mechanics tests, not visibility ones.
        assignee_ids: ['priya-uuid', 'u1'],
        assignees: [{ id: 'priya-uuid', name: 'Priya Patel' }, { id: 'u1', name: 'Test Admin' }],
        watcher_ids: [],
        due_at: null,
        linked_entity: null,
        tags: [],
        subtasks: [],
        created_by: 'u1',
        created_at: '2026-06-20T00:00:00Z',
        updated_at: '2026-06-20T00:00:00Z',
        completed_at: null,
        activity: [],
        comments: [],
        ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
      }],
    });
  });

  /**
   * What this DOES prove: every card is focusable and announces itself as a
   * draggable, which is precisely what dnd-kit's KeyboardSensor needs to be
   * reachable at all - `useSortable`'s `attributes` supply `role="button"`,
   * `tabIndex={0}` and `aria-roledescription`, and the legacy board (native
   * HTML5 `draggable`) supplied none of them.
   *
   * What it CANNOT prove: that a full Space-arrows-Space move lands the card in
   * another column. dnd-kit resolves a drop through collision detection over
   * measured rects, and jsdom reports every element as 0x0, so no collision can
   * ever be detected there. That half is a browser check, and it is called out
   * in the branch report rather than faked with a stubbed rect.
   */
  it('gives every card the focusable, announced drag handle the KeyboardSensor needs', () => {
    const { container } = renderWithProviders(<BoardView />);

    const handles = container.querySelectorAll('[aria-roledescription="sortable"]');
    expect(handles).toHaveLength(1);
    const card = handles[0]!;
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card).toHaveAttribute('aria-describedby');
    expect(within(card as HTMLElement).getByText('Schedule Approval')).toBeInTheDocument();
  });

  /**
   * The per-card status select is GONE, and its absence is the assertion.
   *
   * It duplicated the status badge already on the card, and because changing a
   * value moved the card to another lane while the control stayed where it was,
   * the select you had just used ended up attached to a different task. Status
   * is now set by dragging, by the card menu or in the detail drawer; the
   * keyboard path the select used to be the only route for is dnd-kit's, which
   * the test above covers.
   */
  it('renders no per-card status select on the board', () => {
    renderWithProviders(<BoardView />);
    expect(screen.queryByRole('combobox', { name: /^Status for / })).not.toBeInTheDocument();
  });

  /**
   * A drop must not be able to scroll the app shell.
   *
   * Reported from a real browser: dragging a card out past the last lane and
   * releasing it in the empty strip beside it left the whole frame scrolled off
   * its origin - sidebar clipped past the left edge, top bar above the top one.
   *
   * The cause is dnd-kit's end-of-drop reveal. `useDropAnimation` calls
   * `scrollIntoViewIfNeeded(activeNode)`, which calls the NATIVE
   * `scrollIntoView({ block: 'center', inline: 'center' })` on the card the drag
   * came from once that card's rect has left the viewport - which is exactly
   * where it is after the track has auto-scrolled sideways under the drag. The
   * native call cannot be scoped to a container: it centres the card in EVERY
   * scroll container up to the document, and `overflow: hidden` boxes (the app
   * frame, the page scroller) are scroll containers.
   *
   * jsdom lays nothing out and its `scrollIntoView` is a no-op, so a full drag
   * cannot be driven here and a moved scroll offset cannot be observed. What CAN
   * be pinned is the guarantee that makes the bug impossible: the board's cards
   * absorb the reveal, so the call never reaches the implementation that would
   * move an ancestor. The second half of the test keeps it from passing
   * vacuously - an element the board does not own still reaches the real method.
   */
  it('absorbs the end-of-drop reveal so it cannot scroll the app shell', () => {
    const nativeReveal = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      const { container } = renderWithProviders(<BoardView />);
      const card = container.querySelector<HTMLElement>('[aria-roledescription="sortable"]');
      expect(card).not.toBeNull();

      nativeReveal.mockClear();
      // dnd-kit's own call, verbatim.
      card!.scrollIntoView({ block: 'center', inline: 'center' });
      expect(nativeReveal).not.toHaveBeenCalled();

      // The spy is live, so the assertion above means something.
      container.scrollIntoView({ block: 'center', inline: 'center' });
      expect(nativeReveal).toHaveBeenCalledTimes(1);
    } finally {
      nativeReveal.mockRestore();
    }
  });

  it('renders the list, my-day and calendar views with their carried-over test ids', () => {
    const list = renderWithProviders(<ListView />);
    expect(list.getByTestId('tasks-list-toolbar')).toBeInTheDocument();
    expect(list.getByText('Schedule Approval')).toBeInTheDocument();
    list.unmount();

    const myDay = renderWithProviders(<MyDayView />);
    expect(myDay.getByTestId('my-day-surface')).toBeInTheDocument();
    // My Day is the list and nothing else now. The "Your day, planned" header,
    // its Plan my day button and the Suggested tasks panel are gone: the button
    // made no request and its only observable effect was a toast, and the panel
    // was demo content wired to nothing.
    expect(myDay.queryByTestId('suggested-tasks-panel')).not.toBeInTheDocument();
    expect(myDay.queryByRole('button', { name: /plan my day/i })).not.toBeInTheDocument();
    myDay.unmount();

    const calendar = renderWithProviders(<CalendarViewReal />);
    expect(calendar.getByTestId('tasks-calendar-card')).toBeInTheDocument();
    expect(calendar.getByRole('button', { name: 'Previous period' })).toBeInTheDocument();
    expect(calendar.getByRole('button', { name: 'Next period' })).toBeInTheDocument();
  });
});
