import { cn } from '@/lib/utils';
import type { TaskPriority } from '@/lib/tasks/types';
import {
  STATUS_REGISTRY,
  STATUS_INTENT_FILL,
  STATUS_INTENT_TEXT,
  type StatusEntry,
} from '@/design-system/status-registry';

export function PriorityDot({ priority }: { priority: TaskPriority }) {
  // Unmapped values cannot occur through the TaskPriority type, but the wire can still
  // carry one. Route the fallback through the same StatusEntry shape so no class string
  // is ever spelled out in this file.
  const entry: StatusEntry = STATUS_REGISTRY.taskPriority[priority] ?? { label: priority, intent: 'neutral' };
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', STATUS_INTENT_TEXT[entry.intent])}>
      <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_INTENT_FILL[entry.intent])} />
      {entry.label}
    </span>
  );
}
