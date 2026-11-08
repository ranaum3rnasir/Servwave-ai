import { useMemo, useState } from 'react';
import { useFilteredTasks } from '@/lib/tasks/useFilteredTasks';
import { isOverdue } from '@/lib/tasks/tasks-logic';
import { taskAI } from '@/lib/tasks/taskAI';
import { useAuthStore } from '@/stores/auth.store';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useToast } from '@/components/ui/use-toast';
import { PriorityDot } from '@/components/tasks/PriorityDot';
import { SuggestedTasksPanel } from '@/components/tasks/SuggestedTasksPanel';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { cn } from '@/lib/utils';

export default function MyDayView() {
  const tasks = useFilteredTasks();
  const [nonce, setNonce] = useState(0);
  const [plannedAt, setPlannedAt] = useState<number | null>(null);
  const open = useTaskDetailStore((s) => s.open);
  const { toast } = useToast();
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';

  const ranked = useMemo(
    () => taskAI.rankMyDay(tasks, currentUserId, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, nonce],
  );

  return (
    <div data-testid="my-day-surface" className="overflow-hidden rounded-xl border border-border bg-surface-light shadow-card">
      <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Heading level={2} scale="lg">Your day, planned</Heading>
          <p className="mt-1 text-sm text-text-secondary">
            Suggested follow-ups and ranked work for the current operator.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setNonce((n) => n + 1);
              const now = Date.now();
              setPlannedAt(now);
              toast({ description: `Your day has been planned · ${ranked.length} task${ranked.length === 1 ? '' : 's'}` });
            }}
            className="self-start sm:self-auto"
          >
            {plannedAt ? 'Refresh plan' : 'Plan my day'}
          </Button>
          {plannedAt && (
            <span className="text-xs text-text-secondary">
              Planned at{' '}
              {new Date(plannedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              {' · '}{ranked.length} item{ranked.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      <div className="border-b border-border bg-background-light/35 p-5">
        <SuggestedTasksPanel embedded />
      </div>

      {ranked.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-secondary opacity-60">
          Nothing on your plate today.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {ranked.map((t, idx) => {
            const overdue = isOverdue(t, new Date());
            return (
              <li
                key={t.id}
                className="flex cursor-pointer items-start gap-4 px-5 py-4 transition-colors hover:bg-background-light"
                onClick={() => open(t.id)}
              >
                {/* Rank number */}
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background-light text-xs font-bold text-text-secondary tabular-nums">
                  {idx + 1}
                </span>

                {/* Task info */}
                <div className="flex flex-1 flex-col gap-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary leading-snug">
                    {t.title}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <PriorityDot priority={t.priority} />
                    {/* Due chip */}
                    {t.due_at ? (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
                          overdue
                            ? 'border-danger-border bg-danger-surface text-danger-text'
                            : 'border-border bg-background-light text-text-secondary',
                        )}
                      >
                        {overdue ? 'Overdue · ' : 'Due · '}
                        {new Intl.DateTimeFormat('en-US', {
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        }).format(new Date(t.due_at))}
                      </span>
                    ) : (
                      <span className="text-xs text-text-secondary opacity-50">No due date</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
