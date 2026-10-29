import { useMemo } from 'react';

import { isOverdue } from '@/lib/tasks/tasks-logic';
import { formatExactInstant } from '@/lib/format-date';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useTaskViewStore } from '@/stores/taskViewStore';
import { useTaskListPage } from '@/lib/tasks/useTaskListPage';
import { taskAssignees } from '@/lib/tasks/assignees';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { TaskCategoryChip } from '@/components/tasks/TaskCategoryChip';
import type { Task } from '@/lib/tasks/types';

import { cn } from '@/ui-kit/lib/utils';
import { Card } from '@/ui-kit/components/ui/card';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { LoadError } from '../../_shared/loadError';
import { LoadMoreFooter } from '../../_shared/loadMoreFooter';
import { RecordCards, type RecordCardItem } from '../../_shared/recordCards';
import { useRecordCards } from '../../_shared/useRecordCards';
import { LinkedEntityChip, PriorityDot, TaskStatusChip } from '../components/atoms';
import { EM_DASH } from '../components/glyphs';

const COLUMNS = ['Task #', 'Title', 'Category', 'Assignees', 'Status', 'Priority', 'Linked', 'Due', 'Created'];

function DueText({ task }: { task: Task }) {
  const overdue = isOverdue(task, new Date());
  return (
    <span
      className={cn(
        task.due_at
          ? overdue ? 'text-status-red-emphasis font-medium' : 'text-muted-foreground'
          : 'text-subtle-foreground',
      )}
    >
      {task.due_at ? formatExactInstant(task.due_at) : EM_DASH}
    </span>
  );
}

/**
 * The flat list, a SERVER PAGE at a time (mobile slice 72).
 *
 * It used to filter and search a copy of every task in the organisation held in the browser; now
 * the filters and the search are sent to the server (`useTaskListPage`) and the list asks for the
 * next page as the reader scrolls to its end. The rows are the ones the browser used to show: the
 * search still reads title, ANY assignee and the linked record, over the same hub filter.
 *
 * Below lg the table becomes one card per task (`RecordCards`, the detail pages' phone layout):
 * nine columns do not fit a phone, and a sideways-scrolling table is not how a field list reads.
 * From lg up it is the table it always was.
 *
 * Deliberately the kit's `ui/table` primitives, NOT its `data/dataTable`: the list is a plain
 * table with fixed columns and no column menu, and driving it through the TanStack-backed
 * DataTable would add controls the page has never had. The whole row opens the drawer.
 */
export default function ListView() {
  const list = useTaskListPage({ watchWrites: true });
  // In the shared view store, not local state: the Filter popover counts over what this search leaves.
  const query = useTaskViewStore((s) => s.listSearch);
  const setQuery = useTaskViewStore((s) => s.setListSearch);
  const open = useTaskDetailStore((s) => s.open);
  const cards = useRecordCards();

  const cardItems = useMemo<RecordCardItem[]>(
    () => list.rows.map((t) => ({
      key: t.id,
      eyebrow: <span className="font-mono">{t.task_number}</span>,
      title: t.title,
      aside: <TaskStatusChip status={t.status} />,
      fields: [
        {
          label: 'Category',
          value: t.category ? <TaskCategoryChip category={t.category} /> : <span className="text-subtle-foreground">{EM_DASH}</span>,
        },
        { label: 'Assignees', value: <AssigneeStack assignees={taskAssignees(t)} /> },
        { label: 'Priority', value: <PriorityDot priority={t.priority} /> },
        { label: 'Linked', value: <LinkedEntityChip entity={t.linked_entity} /> },
        { label: 'Due', value: <DueText task={t} /> },
        { label: 'Created', value: formatExactInstant(t.created_at) },
      ],
      onOpen: () => open(t.id),
    })),
    [list.rows, open],
  );

  let body;
  if (list.isError) {
    body = <LoadError title="Couldn't load tasks." onRetry={list.retry} />;
  } else if (list.isLoading) {
    body = (
      <div role="status" aria-label="Loading tasks" className="space-y-3 p-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  } else if (list.rows.length === 0) {
    body = <EmptyState title="No tasks match your search." />;
  } else if (cards) {
    body = <RecordCards items={cardItems} label="Tasks" />;
  } else {
    body = (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((h) => <TableHead key={h}>{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((t) => (
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
                <TableCell className="whitespace-nowrap"><DueText task={t} /></TableCell>
                <TableCell className="whitespace-nowrap">{formatExactInstant(t.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

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
          {list.total} task{list.total !== 1 ? 's' : ''}
        </span>
      </div>

      {body}

      {!list.isError && !list.isLoading && (
        <LoadMoreFooter
          loaded={list.rows.length}
          total={list.total}
          hasMore={list.hasNextPage}
          loading={list.isFetchingNextPage}
          failed={list.nextPageFailed}
          onLoadMore={list.fetchNextPage}
          noun="tasks"
        />
      )}
    </Card>
  );
}
