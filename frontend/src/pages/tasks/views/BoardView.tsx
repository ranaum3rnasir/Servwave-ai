import { useMemo, useState, type DragEvent } from 'react';
import { useTasksStore } from '@/stores/tasksStore';
import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { assessRisk, assigneeOpenCountFor, assigneeOpenCounts } from '@/lib/tasks/tasks-logic';
import { BOARD_TASK_STATUSES, TASK_STATUSES, isCompletedTaskStatus, isTerminalTaskStatus, type TaskStatus } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';
import { STATUS_REGISTRY } from '@/design-system/status-registry';

import { TaskCard } from '@/components/tasks/TaskCard';
import { SelectField } from '@/components/form/SelectField';

export default function BoardView() {
  const tasks = useFilteredTasks();
  const updateStatus = useTasksStore((s) => s.updateStatus);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);

  function handleDrop(e: DragEvent<HTMLDivElement>, status: TaskStatus) {
    e.preventDefault();
    setDragOverStatus(null);
    const taskId = e.dataTransfer.getData('task-id');
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === status) return;
    void updateStatus(taskId, status);
  }

  // Build per-assignee open-count map for risk assessment
  const assigneeOpen = useMemo(() => assigneeOpenCounts(tasks), [tasks]);

  // Partition tasks: at-risk (unfinished) go to At Risk lane only; others go to their status
  // column. CANCELLED has no column (issue 03) and those tasks are dropped from the board.
  const { atRiskTasks, byStatus, riskByTask } = useMemo(() => {
    const atRisk: typeof tasks = [];
    const cols: Record<string, typeof tasks> = {};
    for (const s of BOARD_TASK_STATUSES) cols[s] = [];
    const riskMap = new Map<string, ReturnType<typeof assessRisk>>();
    for (const t of tasks) {
      const risk = assessRisk(t, {
        now: new Date(),
        assigneeOpenCount: assigneeOpenCountFor(t, assigneeOpen),
      });
      riskMap.set(t.id, risk);
      if (!cols[t.status]) continue;
      if (risk.atRisk && !isTerminalTaskStatus(t.status)) {
        atRisk.push(t);
      } else {
        cols[t.status]!.push(t);
      }
    }
    return { atRiskTasks: atRisk, byStatus: cols, riskByTask: riskMap };
  }, [tasks, assigneeOpen]);

  const allColumns = [
    { key: 'AT_RISK' as const, label: '⚠ At Risk', tasks: atRiskTasks },
    ...BOARD_TASK_STATUSES.map((s) => ({ key: s, label: STATUS_REGISTRY.task[s]?.label ?? s, tasks: byStatus[s] ?? [] })),
  ];

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {allColumns.map((col) => {
        const dropStatus: TaskStatus | null = col.key === 'AT_RISK' ? null : col.key;
        return (
        <div
          key={col.key}
          className={cn(
            'min-w-[260px] flex flex-col gap-3 rounded-lg transition-colors',
            dropStatus && dragOverStatus === dropStatus && 'ring-2 ring-inset ring-primary/40'
          )}
          onDragOver={dropStatus ? (e) => { e.preventDefault(); setDragOverStatus(dropStatus); } : undefined}
          onDragLeave={dropStatus ? () => setDragOverStatus(null) : undefined}
          onDrop={dropStatus ? (e) => handleDrop(e, dropStatus) : undefined}
        >
          {/* Column header */}
          <div className="flex items-center justify-between rounded-lg bg-background-light border border-border px-3 py-2">
            <span className="text-sm font-semibold text-text-primary">{col.label}</span>
            <span className="rounded-full bg-surface-light border border-border px-2 py-0.5 text-xs font-bold text-text-secondary tabular-nums">
              {col.tasks.length}
            </span>
          </div>

          {/* Cards */}
          <div className="flex flex-col gap-3">
            {col.tasks.map((t) => (
              <div key={t.id} className="flex flex-col gap-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('task-id', t.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  className="cursor-grab active:cursor-grabbing"
                >
                  <TaskCard
                    task={t}
                    riskResult={riskByTask.get(t.id)}
                  />
                </div>
                {/* Status selector - TaskCard doesn't expose a status control, so we add one here */}
                {!isCompletedTaskStatus(col.key) && (
                  <SelectField
                    value={t.status}
                    onValueChange={(v) => updateStatus(t.id, v as TaskStatus)}
                    className="w-full h-auto rounded-lg px-2 py-1 text-xs text-text-secondary focus:ring-1 focus:ring-primary"
                    options={TASK_STATUSES.map((s) => ({ value: s, label: STATUS_REGISTRY.task[s]?.label ?? s }))}
                  />
                )}
              </div>
            ))}
            {col.tasks.length === 0 && (
              <p className="text-xs text-text-secondary px-1 py-2 text-center opacity-60">
                Empty
              </p>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}
