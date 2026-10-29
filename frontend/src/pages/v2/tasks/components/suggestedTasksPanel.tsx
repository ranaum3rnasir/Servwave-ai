import { useState } from 'react';

import type { LinkedEntity } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';
import { cn } from '@/ui-kit/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';

import { LinkedEntityChip } from './atoms';
import { EM_DASH } from './glyphs';

interface SuggestedTasksPanelProps {
  embedded?: boolean;
  /** Optional current-page entity to pre-wire accepted suggestions. */
  pageEntity?: LinkedEntity | null;
}

interface SuggestedItem {
  id: string;
  text: string;
  entity: LinkedEntity | null;
}

/**
 * DEMO DATA, deliberately. These three strings are literals in the legacy
 * component and the subtitle says so on screen. Nothing here reads a call, a
 * note or an inbox; wiring it to anything would be inventing a feature, so it
 * is carried across exactly as it stands.
 */
const SEED_SUGGESTIONS: SuggestedItem[] = [
  { id: 'sug_1', text: 'Customer asked to reschedule install to Tuesday', entity: null },
  { id: 'sug_2', text: `Send updated quote ${EM_DASH} customer wants extra camera`, entity: null },
  { id: 'sug_3', text: 'Call back: missed call from Gail re: alarm beeping', entity: null },
];

/**
 * `Accept` creates a real task (the item's entity, else the page entity);
 * `Dismiss` drops it locally. Both are `useState` only, so a remount restores
 * all three - the legacy behaviour, preserved.
 */
export function SuggestedTasksPanel({ embedded = false, pageEntity = null }: SuggestedTasksPanelProps) {
  const addTask = useTasksStore((s) => s.addTask);
  const [items, setItems] = useState<SuggestedItem[]>(SEED_SUGGESTIONS);

  function handleAccept(item: SuggestedItem) {
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

  const body = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-[13.5px] font-bold">Suggested tasks</p>
        <p className="text-muted-foreground text-[12px]">
          Demo {EM_DASH} will read live calls, notes &amp; inbox when comms wiring lands.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-subtle-foreground text-[13px]">No more suggestions.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                'border-input flex flex-col gap-2 rounded-md border p-3',
                'sm:flex-row sm:items-center sm:justify-between',
                embedded ? 'bg-kit-card' : 'bg-muted',
              )}
            >
              <div className="flex min-w-0 flex-col gap-2">
                <p className="text-[13px] leading-snug">{item.text}</p>
                {item.entity && <LinkedEntityChip entity={item.entity} />}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 sm:ms-auto">
                <Button size="sm" onClick={() => handleAccept(item)}>Accept</Button>
                <Button size="sm" variant="outline" onClick={() => handleDismiss(item.id)}>Dismiss</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div data-testid="suggested-tasks-panel">
      {embedded ? body : <Card><CardContent className="pt-4">{body}</CardContent></Card>}
    </div>
  );
}
