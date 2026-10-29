import { useMemo, useState } from 'react';
import { CheckCheck, SearchX } from 'lucide-react';

import {
  selectCompletionLog,
  type CompletionRange,
  type CompletionScope,
} from '@/lib/tasks/tasks-logic';
import { TASK_VIEW_FILTER_OPTIONS, useFilteredTasks, useSelectedTaskCategoryIds } from '@/lib/tasks/useFilteredTasks';
import { useAuthStore } from '@/stores/auth.store';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { taskAssignees } from '@/lib/tasks/assignees';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { useTaskFilterStore } from '@/stores/taskFilterStore';
import { useTaskViewStore } from '@/stores/taskViewStore';

import { cn } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { PriorityDot, TaskStatusChip } from '../components/atoms';

const RANGES: { value: CompletionRange; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

const SCOPES: { value: CompletionScope; label: string }[] = [
  { value: 'mine', label: 'Mine' },
  { value: 'everyone', label: 'Everyone' },
];

/** How many rows the table reveals at a time. */
const PAGE_SIZE = 50;

/** Full date and time, in the viewer's own zone - see `tasks-logic`. */
const CLOSED_AT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

/**
 * History - the tasks that were closed, as a plain table.
 *
 * WHAT WENT AND WHY. This tab used to render the same rows as a timeline: a day
 * heading over every group, a hairline rail down a fixed gutter, and a green
 * check node per entry. It read as a story about the week. What people come
 * here for is the ticket they closed on Tuesday, and for that the ceremony was
 * pure cost - the day headings pushed roughly a third of the rows below the
 * fold, the rail's gutter took width off the title column, and nothing in any
 * of it could be scanned down a single line or sorted.
 *
 * So: one row per closed task, newest first, with the closing time spelled out
 * in full on every row rather than implied by the heading above it. Same
 * selector, same scope / range / search toolbar, same drawer on click. No stat
 * cards either - the Dashboard tab owns aggregates, and a "top closer" tile
 * here answered a question nobody had come to this tab to ask.
 *
 * BOTH ways a task can close land in this table (issue 03), which makes telling
 * them apart the table's job. An Outcome column carries the distinction in
 * words for anyone reading a row or a screen reader announcing it, and the
 * chip's own colour - `danger` red against DONE's `success` green - carries it
 * at a glance while scanning. The cancelled row's title is struck through as
 * well, so the two are separable without relying on colour at all.
 *
 * The hub's Member / Department / Category filter still applies underneath:
 * `useFilteredTasks` runs first and this view layers its own toolbar on the
 * result. `applyCategory: false` keeps the Dashboard's KPI drill-down from
 * scoping this tab, which is a task-list concern.
 */
export default function HistoryView() {
  const tasks = useFilteredTasks(TASK_VIEW_FILTER_OPTIONS.history);
  const viewerId = useAuthStore((s) => s.user?.id) ?? '';
  const openTask = useTaskDetailStore((s) => s.open);

  // Read to tell "the hub filtered everything out" apart from "there is
  // genuinely nothing", and to offer the reset when it is the former.
  const memberId = useTaskFilterStore((s) => s.memberId);
  const departmentId = useTaskFilterStore((s) => s.departmentId);
  const categoryIds = useSelectedTaskCategoryIds();
  const resetHubFilter = useTaskFilterStore((s) => s.reset);
  const hubFilterNarrowed = memberId !== 'all' || departmentId !== 'all' || categoryIds.length > 0;

  // The toolbar lives in the shared view store, not local state: the Filter popover's
  // per-category counts are taken over this same `selectCompletionLog` with these same values.
  const search = useTaskViewStore((s) => s.historySearch);
  const setSearch = useTaskViewStore((s) => s.setHistorySearch);
  const range = useTaskViewStore((s) => s.historyRange);
  const setRange = useTaskViewStore((s) => s.setHistoryRange);
  const scope = useTaskViewStore((s) => s.historyScope);
  const setScope = useTaskViewStore((s) => s.setHistoryScope);

  const now = useMemo(() => new Date(), []);

  const entries = useMemo(
    () => selectCompletionLog(tasks, { scope, viewerId, range, search }, now),
    [tasks, scope, viewerId, range, search, now],
  );

  // Is the table empty because of THIS toolbar, or because nothing was ever
  // closed in scope? The two need different empty states, and the same
  // selector answers it with the toolbar wound all the way open.
  const anyClosedInScope = useMemo(
    () => selectCompletionLog(tasks, { scope, viewerId, range: 'all', search: '' }, now).length > 0,
    [tasks, scope, viewerId, now],
  );

  /**
   * Incremental reveal without an effect. The visible count is keyed to the
   * toolbar's signature, so changing search / range / scope collapses the table
   * back to one page during the same render that recomputes it - no flash of a
   * 300-row table, and no `useEffect` reset firing a beat late.
   */
  const signature = `${search}|${range}|${scope}`;
  const [reveal, setReveal] = useState({ signature, count: PAGE_SIZE });
  const visibleCount = reveal.signature === signature ? reveal.count : PAGE_SIZE;

  const visible = entries.slice(0, visibleCount);
  const remaining = entries.length - visible.length;

  return (
    <Card className="overflow-hidden">
      <header className="border-input flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search closed tasks by title, number, or assignee..."
          className="lg:max-w-md"
        />

        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          {/* Two segmented groups rather than selects: four and two options,
              all of them one word, and the current choice has to stay readable
              at a glance while scanning. `aria-pressed` carries the state a
              colour change alone would not. */}
          <div role="group" aria-label="Time range" className="border-input inline-flex overflow-hidden rounded-md border">
            {RANGES.map((r) => (
              <Button
                key={r.value}
                type="button"
                variant={range === r.value ? 'default' : 'ghost'}
                size="sm"
                aria-pressed={range === r.value}
                onClick={() => setRange(r.value)}
                className="rounded-none"
              >
                {r.label}
              </Button>
            ))}
          </div>

          <div role="group" aria-label="Whose completions" className="border-input inline-flex overflow-hidden rounded-md border">
            {SCOPES.map((s) => (
              <Button
                key={s.value}
                type="button"
                variant={scope === s.value ? 'default' : 'ghost'}
                size="sm"
                aria-pressed={scope === s.value}
                onClick={() => setScope(s.value)}
                className="rounded-none"
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </header>

      {entries.length === 0 ? (
        anyClosedInScope ? (
          <EmptyState
            icon={<SearchX />}
            title="Nothing closed in this window"
            description="Closed tasks exist outside this window. Widen the time range or clear the search."
            action={
              <Button variant="outline" size="sm" onClick={() => { setSearch(''); setRange('all'); }}>
                Clear search and show all time
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<CheckCheck />}
            title={scope === 'mine' ? 'You have not closed anything yet' : 'Nothing has been closed yet'}
            description="Tasks land here the moment they are closed, whether they were completed or cancelled, newest first."
            action={
              scope === 'mine' ? (
                <Button variant="outline" size="sm" onClick={() => setScope('everyone')}>
                  See the whole team
                </Button>
              ) : hubFilterNarrowed ? (
                <Button variant="outline" size="sm" onClick={resetHubFilter}>
                  Clear the page filters
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-kit-card">
                <TableHead className="w-[92px]">Task</TableHead>
                <TableHead>Title</TableHead>
                {scope === 'everyone' && <TableHead className="w-[160px]">Closed by</TableHead>}
                <TableHead className="w-[110px]">Outcome</TableHead>
                <TableHead className="w-[200px]">Closed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => (
                <TableRow
                  key={entry.task.id}
                  className="cursor-pointer"
                  onClick={() => openTask(entry.task.id)}
                >
                  {/* Typography and colour go on a span INSIDE each cell, not
                      on TableCell's className. Appearance is the component's
                      business - the design-system ratchet counts every
                      appearance class that reaches past a kit component from a
                      call site, and it is at its floor for TableCell. */}
                  <TableCell>
                    <span className="text-subtle-foreground font-mono text-[12px]">
                      {entry.task.task_number}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      <PriorityDot priority={entry.task.priority} />
                      <span
                        className={cn(
                          'min-w-0 text-[13px] font-medium',
                          entry.outcome === 'CANCELLED' && 'text-muted-foreground line-through',
                        )}
                      >
                        {entry.task.title}
                      </span>
                    </div>
                  </TableCell>
                  {scope === 'everyone' && (
                    <TableCell>
                      <AssigneeStack assignees={taskAssignees(entry.task)} />
                    </TableCell>
                  )}
                  <TableCell>
                    <TaskStatusChip status={entry.outcome} />
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground text-[12.5px] tabular-nums">
                      {CLOSED_AT.format(entry.completedAt)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {remaining > 0 && (
            <div className="border-input border-t p-4 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReveal({ signature, count: visibleCount + PAGE_SIZE })}
              >
                Show {Math.min(PAGE_SIZE, remaining)} more
              </Button>
              <p className="text-subtle-foreground mt-2 text-[12px] tabular-nums">
                {remaining} older {remaining === 1 ? 'entry' : 'entries'} hidden
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
