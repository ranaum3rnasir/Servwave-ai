import { cn } from '@/lib/utils';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { formatExactInstant } from '@/lib/format-date';
import { isCompletedTaskStatus, isTerminalTaskStatus, type Task, type TaskStatus } from '@/lib/tasks/types';
import { isOverdue, assessRisk } from '@/lib/tasks/tasks-logic';
import type { RiskResult } from '@/lib/tasks/tasks-logic';
import { taskAssignees } from '@/lib/tasks/assignees';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { AssigneeStack } from './AssigneeStack';
import { StatusBadge } from '@/components/data/status-badge';
import { PriorityDot } from './PriorityDot';
import { RiskBadge } from './RiskBadge';
import { LinkedEntityChip } from './LinkedEntityChip';
import { TaskCategoryChip } from './TaskCategoryChip';
import { TaskFileCount } from './TaskFileCount';

interface TaskCardProps {
  task: Task;
  /** When provided, a quick-complete toggle is shown that closes an open task or reopens a closed one. */
  onStatusChange?: (status: TaskStatus) => void;
  /** Busiest assignee's open-task load - see `assigneeOpenCountFor`. */
  assigneeOpenCount?: number;
  riskResult?: RiskResult;
  /** Suppress the linked-entity chip (redundant on a per-entity tab). */
  hideLinkedEntity?: boolean;
}

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
  // separates them is the glyph and the status badge, not whether the card looks closed.
  const closed = isTerminalTaskStatus(task.status);
  const assignees = taskAssignees(task);

  return (
    <div
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface-light p-4 shadow-card transition hover:shadow-md',
        closed && 'opacity-70'
      )}
      onClick={() => open(task.id)}
    >
      {/* Title row (with optional quick-complete) */}
      <div className="flex items-start gap-2">
        {onStatusChange && (
          // Bespoke idle-muted/hover-to-sage-green quick-complete toggle - no minted
          // ghost cell reproduces that hover-to-brand-tone signal, not Button-shaped.
          <button
            type="button"
            aria-label={closed ? 'Mark task as to-do' : 'Mark task done'}
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange(closed ? 'TODO' : 'DONE');
            }}
            className="mt-0.5 shrink-0 text-text-secondary/50 transition-colors hover:text-sage-700"
          >
            {done ? <CheckCircle2 className="h-4 w-4 text-sage-700" /> : cancelled ? <XCircle className="h-4 w-4 text-danger" /> : <Circle className="h-4 w-4" />}
          </button>
        )}
        <p className={cn('text-sm font-medium leading-snug', closed && 'text-text-secondary line-through')}>
          {task.title}
        </p>
      </div>

      {/* Status + Priority row */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge domain="task" status={task.status} />
        <PriorityDot priority={task.priority} />
        <TaskCategoryChip category={task.category} />
        <TaskFileCount count={task.attachment_count} className="ml-auto" />
      </div>

      {/* Assignees */}
      <AssigneeStack assignees={assignees} showSoleName />

      {/* Due date */}
      {task.due_at ? (
        <p className={cn('text-xs', overdue ? 'font-medium text-danger' : 'text-text-secondary')}>
          {overdue ? 'Overdue · ' : 'Due · '}
          {formatExactInstant(task.due_at)}
        </p>
      ) : (
        <p className="text-xs text-text-secondary opacity-50">No due date</p>
      )}

      {/* Linked entity */}
      {!hideLinkedEntity && <LinkedEntityChip entity={task.linked_entity} />}

      {/* Risk badge */}
      <RiskBadge result={risk} />
    </div>
  );
}
