import { useMemo, useState } from 'react';
import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { isOverdue } from '@/lib/tasks/tasks-logic';

import { formatExactInstant } from '@/lib/format-date';
import { cn } from '@/lib/utils';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { matchesAssignee, taskAssignees } from '@/lib/tasks/assignees';
import { AssigneeStack } from '@/components/tasks/AssigneeStack';
import { StatusBadge } from '@/components/data/status-badge';
import { PriorityDot } from '@/components/tasks/PriorityDot';
import { LinkedEntityChip } from '@/components/tasks/LinkedEntityChip';
import { EmptyState } from '@/components/ui/empty-state';

export default function ListView() {
  const tasks = useFilteredTasks();
  const [query, setQuery] = useState('');
  const open = useTaskDetailStore((s) => s.open);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        matchesAssignee(t, q) ||
        (t.linked_entity?.label ?? '').toLowerCase().includes(q),
    );
  }, [tasks, query]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-light shadow-card">
      {/* Search */}
      <div
        data-testid="tasks-list-toolbar"
        className="flex flex-col gap-3 border-b border-border bg-surface-light p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, assignee, or linked entity..."
          className="h-9 w-full rounded-lg border border-border bg-surface-light px-3 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary sm:max-w-md"
        />
        <span className="text-xs font-medium text-text-secondary tabular-nums">
          {filtered.length} task{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full caption-bottom text-sm">
          <thead className="border-b border-border bg-background-light">
            <tr>
              {['Task #', 'Title', 'Assignees', 'Status', 'Priority', 'Linked', 'Due', 'Created'].map(
                (h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary whitespace-nowrap"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {filtered.map((t) => {
              const overdue = isOverdue(t, new Date());
              return (
                <tr
                  key={t.id}
                  className="border-b border-border hover:bg-background-light transition-colors cursor-pointer"
                  onClick={() => open(t.id)}
                >
                  <td className="px-4 py-3 text-xs font-mono text-text-secondary whitespace-nowrap">
                    {t.task_number}
                  </td>
                  <td className="px-4 py-3 font-medium text-text-primary max-w-[220px]">
                    <span className="line-clamp-2">{t.title}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">
                    <AssigneeStack assignees={taskAssignees(t)} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusBadge domain="task" status={t.status} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <PriorityDot priority={t.priority} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <LinkedEntityChip entity={t.linked_entity} />
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-xs whitespace-nowrap',
                      t.due_at
                        ? overdue
                          ? 'font-medium text-danger-text'
                          : 'text-text-secondary'
                        : 'text-text-secondary opacity-40',
                    )}
                  >
                    {t.due_at ? formatExactInstant(t.due_at) : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">
                    {formatExactInstant(t.created_at)}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-text-secondary opacity-60"
                >
                  <EmptyState title="No tasks match your search." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
