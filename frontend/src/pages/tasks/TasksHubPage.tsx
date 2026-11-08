import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip, type TabStripTab } from '@/components/patterns/TabStrip';
import { useTasksStore } from '@/stores/tasksStore';
import DashboardView from './views/DashboardView';
import BoardView from './views/BoardView';
import MyDayView from './views/MyDayView';
import ListView from './views/ListView';
import CalendarView from './views/CalendarView';
import HistoryView from './views/HistoryView';
import { AiCommandBar } from '@/components/tasks/AiCommandBar';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import { TaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';
import { useAuthStore } from '@/stores/auth.store';

type TabKey = 'dashboard' | 'board' | 'my-day' | 'list' | 'calendar' | 'history';

export default function TasksHubPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const role = useAuthStore((s) => s.user?.role);
  const canSeeHistory = role === 'ADMIN' || role === 'DISPATCHER';

  const tabs: TabStripTab[] = [
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'board', label: 'Board' },
    { value: 'my-day', label: 'My Day' },
    { value: 'list', label: 'List' },
    { value: 'calendar', label: 'Calendar' },
    ...(canSeeHistory ? [{ value: 'history', label: 'History' }] : []),
  ];

  // Hydrate the shared task store from the server when the hub mounts. Without
  // this the store only ever holds session-local optimistic adds, so the
  // dashboard (and every tab) shows nothing after a reload or for tasks created
  // elsewhere (e.g. on a lead). fetchTasks de-dups concurrent/loaded calls.
  const fetchTasks = useTasksStore((s) => s.fetchTasks);
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Quick-create handshake: /tasks?action=new-task (dashboard '+ New' and
  // sidebar 'Create New') opens the blank modal once and strips the param
  // (replace:true so Back does not re-open it) — same pattern as EstimatesPage.
  useEffect(() => {
    if (searchParams.get('action') === 'new-task') {
      setNewTaskOpen(true);
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <div data-testid="tasks-workspace" className="p-4 space-y-4">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-surface-light text-primary shadow-soft">
            <ClipboardList className="h-4 w-4" />
          </span>
          <div>
            <Heading>Tasks</Heading>
            <p className="mt-1 text-sm text-text-secondary">
              Plan, assign, and close the operational follow-up loop.
            </p>
          </div>
        </div>
        <Button onClick={() => setNewTaskOpen(true)} size="sm" className="self-start sm:self-auto">
          <Plus className="h-4 w-4" />
          New Task
        </Button>
      </div>

      {/* Command and filters */}
      <div
        data-testid="tasks-command-filter-panel"
        className="grid gap-3 rounded-xl border border-border bg-surface-light p-3 shadow-card xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end"
      >
        <AiCommandBar />
      </div>

      {/* Blank create modal wired to "New Task" button */}
      <CreateTaskModal open={newTaskOpen} onOpenChange={setNewTaskOpen} />

      {/*
        Tab switcher + views. Phase 11.6 retired DetailPageShell's
        `listClassName`/`railWrapperClassName`/`railWrapperTestId` - TabStrip has no
        equivalent, so this page owns its own rail markup now. Two disclosed,
        non-equivalent pieces (not silently dropped - see the plan's own
        section 11.6 and this PR's description):
          1. `data-testid="tasks-tab-rail"` now wraps the WHOLE tab strip
             (rail + all panels), not the rail alone - TabStrip fuses
             TabsList and children into one `<Tabs>` root with no seam a
             wrapper could sit between. The tab-rail's own bottom border
             still renders in the same place regardless (TabsList's default
             `variant="line"` already carries `border-b border-border`
             itself, which is what the old `railWrapperClassName` duplicated).
          2. `min-w-max`/`gap-1`/`overflow-x-auto` (the rail's own horizontal-
             scroll-on-overflow behaviour for a narrow viewport) has no home
             on TabStrip's prop surface and is not reproduced - a real,
             accepted narrowing, not a no-op. Six short single/two-word tab
             labels make this a low-severity edge case, but it is a genuine
             behaviour loss on very narrow viewports.
        The lost outer `space-y-4` (previously on DetailPageShell's own
        className, giving 16px between the rail and the visible panel) is
        NOT lost - each panel's own margin moved from `mt-0` to `mt-4` below,
        which renders the identical 16px gap per visible panel instead of via
        a shared parent's sibling-margin.
      */}
      <div data-testid="tasks-tab-rail">
      <TabStrip
        tabs={tabs}
        active={activeTab}
        onChange={(v) => setActiveTab(v as TabKey)}
        triggerVariant="underline"
        triggerClassName="px-4 py-3"
      >
        <TabsContent value="dashboard" className="mt-4"><DashboardView onDrillDown={() => setActiveTab('list')} /></TabsContent>
        <TabsContent value="board" className="mt-4"><BoardView /></TabsContent>
        <TabsContent value="my-day" className="mt-4"><MyDayView /></TabsContent>
        <TabsContent value="list" className="mt-4"><ListView /></TabsContent>
        <TabsContent value="calendar" className="mt-4"><CalendarView /></TabsContent>
        {canSeeHistory && (
          <TabsContent value="history" className="mt-4"><HistoryView /></TabsContent>
        )}
      </TabStrip>
      </div>

      {/* Task detail drawer — shared across all tabs */}
      <TaskDetailDrawer />
    </div>
  );
}
