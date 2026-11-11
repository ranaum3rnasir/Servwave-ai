import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Tag } from 'lucide-react';

import { useTasksStore } from '@/stores/tasksStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { TaskCategoriesDialog } from '@/components/tasks/TaskCategoriesDialog';
import type { TaskViewKey } from '@/lib/tasks/taskViewRows';

import { Button } from '@/ui-kit/components/ui/button';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabPanel, TabStrip, type TabItem } from '../_shared/tabs';

import { CreateTaskDialog } from './components/createTaskDialog';
import { TaskDetailDrawer } from './components/taskDetailDrawer';
import { TaskFilterChips, TaskFilterTrigger } from './components/taskFilterBar';
import BoardView from './views/boardView';
import CalendarView from './views/calendarView';
import DashboardView from './views/dashboardView';
import HistoryView from './views/historyView';
import ListView from './views/listView';
import MyDayView from './views/myDayView';

type TabKey = TaskViewKey;

/**
 * /v2/tasks - the Tasks hub on the CRM UI kit.
 *
 * Three facts about state that the rebuild had to preserve exactly:
 *
 *  1. The ACTIVE TAB is component-local `useState`, not the URL, not a store,
 *     not localStorage. It resets to `my-day` on every remount and reload, and
 *     there is no `?tab=` param. Lifting it to the URL would change the Back
 *     button, deep links and reload behaviour, so it stays local.
 *  2. The task list lives in a ZUSTAND store, not TanStack Query. There are no
 *     query keys to invalidate anywhere in this module and every mutation
 *     writes the server row back by hand. `fetchTasks()` early-returns when
 *     `loading || loaded`, so it hydrates once per page-load lifetime.
 *  3. Filter state (`taskFilterStore`) and drawer state (`taskDetailStore`) are
 *     module-level, so both survive a tab switch.
 *
 * TAB ORDER opens on the work rather than on the reporting: My Day first and as
 * the landing tab for every role, then the ways of looking at the same list
 * (Board, List, Calendar), then History. DASHBOARD IS LAST and MANAGER-ONLY -
 * its KPIs aggregate the whole org, which is not a technician's or a sales
 * rep's view of their own day. HISTORY IS OPEN TO EVERYONE: it shows the
 * viewer's own completed tasks, so there is nothing there to gate on.
 *
 * Two permission conditionals. The "Categories" header button (slice 09)
 * shows only to whoever may `create TaskCategory` - ADMIN alone, via
 * manage-all - and opens the shared category manage panel. The other is
 * `isManager`, a raw role-string check and NOT CASL (carried over from the
 * History gate it replaces), and it gates the Dashboard trigger AND its panel. Gating the panel
 * as well as the trigger is what makes it impossible for a non-manager to land
 * on `'dashboard'`: the initial tab is `'my-day'` for everyone, nothing sets
 * `'dashboard'` except its own trigger, and `DashboardView`'s KPI drill-down
 * only ever sets `'list'`.
 *
 * Panels are unmounted when inactive (TabPanel returns null), which matches the
 * legacy Radix `TabsContent` default - no `forceMount` was ever passed - so a
 * view's local state (the calendar's anchor, My Day's plan nonce) resets on a
 * tab switch here too.
 */
export default function TasksHubPage() {
  useRecordVisit('tasks');
  const [activeTab, setActiveTab] = useState<TabKey>('my-day');
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const canManageCategories = useAppAbility().can('create', 'TaskCategory');
  const [searchParams, setSearchParams] = useSearchParams();
  const role = useAuthStore((s) => s.user?.role);
  const isManager = role === 'ADMIN' || role === 'DISPATCHER';

  const tabs: TabItem[] = [
    { value: 'my-day', label: 'My Day' },
    { value: 'board', label: 'Board' },
    { value: 'list', label: 'List' },
    { value: 'calendar', label: 'Calendar' },
    { value: 'history', label: 'History' },
    ...(isManager ? [{ value: 'dashboard', label: 'Dashboard' }] : []),
  ];

  // Hydrate the shared task store when the hub mounts. Without this the store
  // only ever holds session-local adds, so every tab shows nothing after a
  // reload or for tasks created elsewhere (e.g. on a lead). fetchTasks de-dups
  // concurrent and already-loaded calls.
  const fetchTasks = useTasksStore((s) => s.fetchTasks);
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Quick-create handshake: `?action=new-task` (the sidebar "Create New" entry)
  // opens the blank dialog once and strips the param with replace:true, so Back
  // does not re-open it.
  useEffect(() => {
    if (searchParams.get('action') === 'new-task') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-shot URL handshake, not derived state: the param is consumed and stripped in the same pass so the dialog opens exactly once, and the user must then be able to close it even though `?action=new-task` was the entry URL
      setNewTaskOpen(true);
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Notification deep-link handshake: `?task=<uuid>`, the path the five task.*
  // notification verbs deep-link to (see `notificationDeepLink`'s TASK case for
  // why it is a param and not `/tasks/:id`). Same one-shot shape as the
  // quick-create handshake above - consume, then strip with replace:true so Back
  // does not re-open the drawer and closing it sticks.
  //
  // THE ROW IS RESOLVED BEFORE THE DRAWER IS OPENED. `TaskDetailDrawer` renders
  // `Sheet open={!!task}` off `tasks.find(openTaskId)` and re-fetches on every id
  // change, and `fetchTaskDetail` APPENDS a row the store has never seen - so a
  // cold arrival (clicked from another page, or a pasted URL, with the list fetch
  // still in flight) would eventually resolve either way. Doing it HERE buys the
  // two things the drawer cannot:
  //   - the dead end. `fetchTaskDetail` neither catches nor reports, so a 404 on
  //     a `task.deleted` row raised inside the drawer's effect is an UNHANDLED
  //     REJECTION that leaves `openTaskId` pinned to a task that will never
  //     arrive and tells the user nothing. Rejection here is the one place it can
  //     be caught, and `openTaskId` is never set for a row that is gone.
  //   - no closed-sheet frame: the store already holds the task when the id
  //     flips, so the drawer paints filled on its first render.
  // The drawer's own effect then re-fetches the same id. That is a refresh of an
  // already-rendered row, not what makes it appear.
  //
  // No cleanup function and a ref guard rather than a `cancelled` closure: the
  // strip below re-runs this effect with a new `searchParams`, and a cleanup
  // would cancel the in-flight open before it ever happened. The ref also makes
  // StrictMode's double-invoke a no-op on the second pass.
  const fetchTaskDetail = useTasksStore((s) => s.fetchTaskDetail);
  const openTaskDetail = useTaskDetailStore((s) => s.open);
  const handledTaskDeepLink = useRef<string | null>(null);

  useEffect(() => {
    const deepLinkedTaskId = searchParams.get('task');
    if (!deepLinkedTaskId) {
      handledTaskDeepLink.current = null;
      return;
    }
    if (handledTaskDeepLink.current === deepLinkedTaskId) return;
    handledTaskDeepLink.current = deepLinkedTaskId;

    searchParams.delete('task');
    setSearchParams(searchParams, { replace: true });

    void fetchTaskDetail(deepLinkedTaskId).then(
      () => openTaskDetail(deepLinkedTaskId),
      () => {
        toast.error('This task no longer exists', {
          description: 'It may have been deleted since you were notified.',
        });
      },
    );
  }, [searchParams, setSearchParams, fetchTaskDetail, openTaskDetail]);

  return (
    <div data-testid="tasks-workspace">
      <PageHeader
        title="Tasks"
        description="Plan, assign, and close the operational follow-up loop."
        actions={
          <>
            {canManageCategories && (
              <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
                <Tag />
                Categories
              </Button>
            )}
            <Button onClick={() => setNewTaskOpen(true)}>
              <Plus />
              New Task
            </Button>
          </>
        }
      />

      <CreateTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />
      {canManageCategories && <TaskCategoriesDialog open={categoriesOpen} onOpenChange={setCategoriesOpen} />}

      {/* The Filter trigger rides the tab line. It used to own a full row above
          the strip - a bordered panel, then a bare toolbar row - which spent a
          band of the page on one button and started every view that much lower.
          The testid moves with the button: it is the handle the hub's specs use
          to find the filter chrome. */}
      <div data-testid="tasks-tab-rail">
        <TabStrip
          tabs={tabs}
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as TabKey)}
          right={
            <div data-testid="tasks-command-filter-panel">
              <TaskFilterTrigger view={activeTab} />
            </div>
          }
        />
      </div>

      {/* The chips stay OUT of the strip - they wrap, and a wrapping right slot
          would lift the tabs off their own underline. Renders nothing at all
          when no filter is active. */}
      <TaskFilterChips />

      <div className="mt-4">
        <TabPanel value="my-day" activeValue={activeTab}><MyDayView /></TabPanel>
        <TabPanel value="board" activeValue={activeTab}><BoardView /></TabPanel>
        <TabPanel value="list" activeValue={activeTab}><ListView /></TabPanel>
        <TabPanel value="calendar" activeValue={activeTab}><CalendarView /></TabPanel>
        <TabPanel value="history" activeValue={activeTab}><HistoryView /></TabPanel>
        {isManager && (
          <TabPanel value="dashboard" activeValue={activeTab}>
            {/* The KPI cards write `taskFilterStore.category` and drill through
                to the List tab, which is why this is a setter and not a link. */}
            <DashboardView onDrillDown={() => setActiveTab('list')} />
          </TabPanel>
        )}
      </div>

      {/* Shared across every tab, mounted once. */}
      <TaskDetailDrawer />
    </div>
  );
}
