import { useState } from 'react';
import type { LinkedEntity } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';
import { Button } from '@/components/ui/button';
import { LinkedEntityChip } from './LinkedEntityChip';
import { cn } from '@/lib/utils';

interface SuggestedTasksPanelProps {
  embedded?: boolean;
  /** Optional current-page entity to pre-wire accepted suggestions (e.g. when panel is on a Job/Lead page). */
  pageEntity?: LinkedEntity | null;
}

interface SuggestedItem {
  id: string;
  text: string;
  entity: LinkedEntity | null;
}

// Seed suggestions have no linked entity — they will be wired via pageEntity if provided,
// or left entity-less until the comms pipeline is live (see MEMORY #231).
const SEED_SUGGESTIONS: SuggestedItem[] = [
  {
    id: 'sug_1',
    text: 'Customer asked to reschedule install to Tuesday',
    entity: null,
  },
  {
    id: 'sug_2',
    text: 'Send updated quote — customer wants extra camera',
    entity: null,
  },
  {
    id: 'sug_3',
    text: 'Call back: missed call from Gail re: alarm beeping',
    entity: null,
  },
];

export function SuggestedTasksPanel({ embedded = false, pageEntity = null }: SuggestedTasksPanelProps) {
  const addTask = useTasksStore((s) => s.addTask);
  const [items, setItems] = useState<SuggestedItem[]>(SEED_SUGGESTIONS);

  function handleAccept(item: SuggestedItem) {
    // Use the item's entity if present; fall back to the current page entity.
    const entity = item.entity ?? pageEntity;
    addTask({
      title: item.text,
      linked_entity: entity ? { type: entity.type, id: entity.id } : null,
    });
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  function handleDismiss(itemId: string) {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  }

  return (
    <div
      data-testid="suggested-tasks-panel"
      className={cn(
        'space-y-3',
        !embedded && 'rounded-xl border border-border bg-surface-light p-4 shadow-card',
      )}
    >
      {/* Header */}
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold text-text-primary">Suggested tasks</p>
        <p className="text-xs text-text-secondary">
          Demo — will read live calls, notes &amp; inbox when comms wiring lands.
        </p>
      </div>

      {/* Items */}
      {items.length === 0 ? (
        <p className="text-sm text-text-secondary opacity-60">No more suggestions.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                'flex flex-col gap-2 rounded-lg border border-border bg-surface-light p-3 sm:flex-row sm:items-center sm:justify-between',
                embedded && 'bg-background-light/50',
              )}
            >
              <div className="min-w-0 space-y-2">
                <p className="text-sm text-text-primary leading-snug">{item.text}</p>
                {item.entity && <LinkedEntityChip entity={item.entity} />}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 sm:ml-auto">
                <Button size="sm" onClick={() => handleAccept(item)}>
                  Accept
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleDismiss(item.id)}>
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
