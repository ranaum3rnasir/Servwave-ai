import { useMemo } from 'react';

import { TASK_VIEW_FILTER_OPTIONS, useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { isOverdue } from '@/lib/tasks/tasks-logic';
import { myDayRows } from '@/lib/tasks/taskViewRows';
import { useAuthStore } from '@/stores/auth.store';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { TaskCategoryChip } from '@/components/tasks/TaskCategoryChip';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Card } from '@/ui-kit/components/ui/card';

import { PriorityDot } from '../components/atoms';

/**
 * My Day - what is actually on the plate today, and nothing else.
 *
 * WHAT THIS TAB USED TO BE: a "Your day, planned" header with a Plan my day
 * button, a Suggested tasks panel, and then the list. The button made no
 * network call and fetched nothing - it bumped a nonce so the ranking memo
 * recomputed against a fresh `new Date()` and raised a toast. Since the list
 * already recomputes whenever the task store changes, the button's whole
 * observable effect was the toast, and the panel above it was demo content
 * wired to nothing. Both are gone; the tab opens straight onto the work.
 *
 * WHAT COUNTS AS TODAY. A task due today, and a task already overdue and still
 * open. The second is the load-bearing half: an overdue task is on your plate
 * today by definition, and a "today" list that hides it is how things stay
 * overdue. Anything due later is deliberately absent - that is what the List
 * and Calendar tabs are for.
 *
 * ORDER is `rankMyDay`'s, not due date: the ranking already weighs priority,
 * age and ownership, and re-sorting the survivors by date would throw that away.
 */
export default function MyDayView() {
  const tasks = useFilteredTasks(TASK_VIEW_FILTER_OPTIONS['my-day']);
  const open = useTaskDetailStore((s) => s.open);
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';

  // The rule itself (due today or overdue, still open, mine, ranked) is `myDayRows`, shared with
  // the Filter popover's counts so a count is always the rows this tab then shows.
  const todays = useMemo(() => myDayRows(tasks, currentUserId, new Date()), [tasks, currentUserId]);

  return (
    <Card data-testid="my-day-surface" className="overflow-hidden">
      {todays.length === 0 ? (
        <p className="text-subtle-foreground py-10 text-center text-[13px]">
          Nothing due today.
        </p>
      ) : (
        <ol className="divide-input divide-y">
          {todays.map((t, idx) => {
            const overdue = isOverdue(t, new Date());
            return (
              <li
                key={t.id}
                className="hover:bg-muted flex cursor-pointer items-start gap-4 px-5 py-4 transition-colors"
                onClick={() => open(t.id)}
              >
                <span className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold tabular-nums">
                  {idx + 1}
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-[13px] font-medium leading-snug">{t.title}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityDot priority={t.priority} />
                    <TaskCategoryChip category={t.category} />
                    {t.due_at && (
                      <Badge variant={overdue ? 'softRed' : 'outline'} size="sm">
                        {overdue ? 'Overdue · ' : 'Due · '}
                        {new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        }).format(new Date(t.due_at))}
                      </Badge>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
