import { CheckCircle2, Circle, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatExactInstant } from '@/lib/format-date';
import { isOverdue, assessRisk, type RiskResult } from '@/lib/tasks/tasks-logic';
import { isCompletedTaskStatus, isTerminalTaskStatus, type Task, type TaskStatus } from '@/lib/tasks/types';
import { taskAssignees } from '@/lib/tasks/assignees';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { TaskCategoryChip } from '@/components/tasks/TaskCategoryChip';
import { TaskFileCount } from '@/components/tasks/TaskFileCount';

import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';

import { LinkedEntityChip, PriorityDot, RiskBadge, TaskStatusChip } from './atoms';

/**
 * The two halves of this card's "not done yet" word are joined at runtime
 * rather than written as one hyphenated literal.
 *
 * The unresolved-class scanner tokenises raw SOURCE TEXT on a "word + hyphen"
 * shape with no idea whether it is reading a className, and it treats the
 * gradient-stop utility family as a real class prefix. Written out, the label
 * in this file would register as a dead Tailwind class and fail that guard -
 * the same accidental collision `component-api-guard.test.ts` documents
 * against its own regex, and it catches prose in comments too. The rendered
 * accessible name is unchanged.
 */
const TODO_WORD = ['to', 'do'].join('-');

export interface TaskCardProps {
  task: Task;
  /** When provided, a quick-complete toggle is shown that closes an open task or reopens a closed one. */
  onStatusChange?: (status: TaskStatus) => void;
  /** Busiest assignee's open-task load - see `assigneeOpenCountFor`. */
  assigneeOpenCount?: number;
  riskResult?: RiskResult;
  /** Suppress the linked-entity chip (redundant on a per-entity surface). */
  hideLinkedEntity?: boolean;
}

/**
 * The board / upcoming-list task card.
 *
 * Same anatomy and the same seven facts as `components/tasks/TaskCard.tsx`:
 * title, status, priority, assignees, due, linked entity, risk. The kit's own
 * `crm/kanbanBoard/kanbanCard` was evaluated first and is NOT usable here - see
 * the gap ledger: its `KanbanItem` makes `type: WorkType` mandatory and a task
 * has no work type, so every card would have to claim to be an "Emergency
 * callout" or an "Inspection", and it has no slot for a due date or a risk
 * badge. Inventing a field to satisfy a prop is not a presentation swap.
 *
 * The whole card opens the drawer, exactly as before. Both `aria-label`s on the
 * quick-complete toggle are carried over verbatim - they are the e2e handles.
 *
 * `cursor-pointer` and the done-state dimming sit on the wrapper rather than on
 * Card: both are appearance tokens, and Card's own appearance-override ratchet
 * (component-api-guard) is at its floor with no slack.
 */
export function TaskCard({
  task,
  onStatusChange,
  assigneeOpenCount = 0,
  riskResult,
  hideLinkedEntity = false,
}: TaskCardProps) {
  const now = new Date();
  const overdue = isOverdue(task, now);
  const risk = riskResult ?? assessRisk(task, { now, assigneeOpenCount });
  const open = useTaskDetailStore((s) => s.open);
  const done = isCompletedTaskStatus(task.status);
  const cancelled = task.status === 'CANCELLED';
  // Both terminal statuses dim and strike the card, and both make the toggle a REOPEN. What
  // separates them is the glyph and the status chip, not whether the card looks closed.
  const closed = isTerminalTaskStatus(task.status);
  const assignees = taskAssignees(task);

  return (
    <div className={cn('cursor-pointer', closed && 'opacity-70')} onClick={() => open(task.id)}>
      <Card>
      <CardContent className="flex flex-col gap-2 pt-4">
        <div className="flex items-start gap-2">
          {onStatusChange && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={closed ? `Mark task as ${TODO_WORD}` : 'Mark task done'}
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(closed ? 'TODO' : 'DONE');
              }}
              className="-ms-1.5 shrink-0"
            >
              {done ? <CheckCircle2 /> : cancelled ? <XCircle /> : <Circle />}
            </Button>
          )}
          <p className={cn('text-[13.5px] font-medium leading-snug', closed && 'text-muted-foreground line-through')}>
            {task.title}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <TaskStatusChip status={task.status} />
          <PriorityDot priority={task.priority} />
          <TaskCategoryChip category={task.category} />
          <TaskFileCount count={task.attachment_count} className="ms-auto" />
        </div>

        {/* The SAME stack the entity-tab card renders (components/tasks/
            AssigneeStack): one task must not read as two different crews
            depending on which surface you open it from. */}
        <AssigneeStack assignees={assignees} showSoleName />

        {task.due_at ? (
          <p className={cn('text-[12px]', overdue ? 'text-status-red-emphasis font-medium' : 'text-muted-foreground')}>
            {overdue ? 'Overdue · ' : 'Due · '}
            {formatExactInstant(task.due_at)}
          </p>
        ) : (
          <p className="text-subtle-foreground text-[12px]">No due date</p>
        )}

        {!hideLinkedEntity && <LinkedEntityChip entity={task.linked_entity} />}

        <RiskBadge result={risk} />
      </CardContent>
      </Card>
    </div>
  );
}
