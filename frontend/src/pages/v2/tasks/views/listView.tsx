import { useMemo } from 'react';

import { TASK_VIEW_FILTER_OPTIONS, useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { isOverdue } from '@/lib/tasks/tasks-logic';
import { formatExactInstant } from '@/lib/format-date';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { listRows } from '@/lib/tasks/taskViewRows';
import { taskAssignees } from '@/lib/tasks/assignees';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { TaskCategoryChip } from '@/components/tasks/TaskCategoryChip';

import { cn } from '@/ui-kit/lib/utils';
import { Card } from '@/ui-kit/components/ui/card';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { LinkedEntityChip, PriorityDot, TaskStatusChip } from '../components/atoms';
import { EM_DASH } from '../components/glyphs';

const COLUMNS = ['Task #', 'Title', 'Category', 'Assignees', 'Status', 'Priority', 'Linked', 'Due', 'Created'];

/**
 * The flat list.
 *
 * Deliberately the kit's `ui/table` primitives, NOT its `data/dataTable`. The
 * legacy list is a plain table with fixed columns, no sorting, no column menu
 * and no pagination; driving it through the TanStack-backed DataTable would add
 * three controls the page has never had, which is a behaviour change, not a
 * restyle. What DataTable would have brought - a search box in a toolbar - the
 * legacy toolbar already has, and it moves onto the kit's `SearchInput`.
 *
 * The search filters client-side over title, ANY assignee and linked-entity label, on
 * top of `useFilteredTasks()`, exactly as before. The whole row opens the
 * drawer.
 */
export default function ListView() {
  const tasks = useFilteredTasks(TASK_VIEW_FILTER_OPTIONS.list);
  // In the shared view store, not local state: the Filter popover counts over what this search leaves.
  const query = useTaskViewStore((s) => s.listSearch);
  const setQuery = useTaskViewStore((s) => s.setListSearch);
  const open = useTaskDetailStore((s) => s.open);

  const filtered = useMemo(() => listRows(tasks, query), [tasks, query]);

  return (
    <Card className="overflow-hidden">
      <div
        data-testid="tasks-list-toolbar"
        className="border-input flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search by title, assignee, or linked entity..."
          className="sm:max-w-md"
        />
        <span className="text-muted-foreground text-[12px] font-medium tabular-nums">
          {filtered.length} task{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((h) => <TableHead key={h}>{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((t) => {
              const overdue = isOverdue(t, new Date());
              return (
                // Every font/colour class below sits on a span INSIDE the cell,
                // never on TableCell itself: TableCell's appearance-override
                // ratchet is at its floor with no slack.
                <TableRow key={t.id} className="cursor-pointer" onClick={() => open(t.id)}>
                  <TableCell className="whitespace-nowrap"><span className="font-mono">{t.task_number}</span></TableCell>
                  <TableCell className="max-w-[220px]">
                    <span className="line-clamp-2 font-medium">{t.title}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t.category
                      ? <TaskCategoryChip category={t.category} />
                      : <span className="text-subtle-foreground">{EM_DASH}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <AssigneeStack assignees={taskAssignees(t)} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap"><TaskStatusChip status={t.status} /></TableCell>
                  <TableCell className="whitespace-nowrap"><PriorityDot priority={t.priority} /></TableCell>
                  <TableCell className="whitespace-nowrap"><LinkedEntityChip entity={t.linked_entity} /></TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span
                      className={cn(
                        t.due_at
                          ? overdue ? 'text-status-red-emphasis font-medium' : 'text-muted-foreground'
                          : 'text-subtle-foreground',
                      )}
                    >
                      {t.due_at ? formatExactInstant(t.due_at) : EM_DASH}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatExactInstant(t.created_at)}</TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length}>
                  <EmptyState title="No tasks match your search." />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
