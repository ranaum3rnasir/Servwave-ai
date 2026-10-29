import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TaskFileCountProps {
  count: number | undefined;
  className?: string;
}

/**
 * How many files are on a task, as a paperclip and a number (slice 12).
 *
 * Shared by both task cards - the Tasks page board and the job/lead/customer/estimate task tabs -
 * so a task reads the same wherever it is shown. Renders nothing when the task has no files.
 */
export function TaskFileCount({ count, className }: TaskFileCountProps) {
  if (!count) return null;
  const label = `${count} ${count === 1 ? 'file' : 'files'}`;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn('text-muted-foreground inline-flex items-center gap-0.5 text-[11px] tabular-nums', className)}
    >
      <Paperclip className="size-3" aria-hidden />
      {count}
    </span>
  );
}
