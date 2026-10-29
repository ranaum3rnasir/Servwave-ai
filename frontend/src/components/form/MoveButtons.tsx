import { ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * Move up / Move down for one row of a reorderable list (mobile slice 48): the way to reorder
 * that does not need a drag, which a finger cannot do on these lists. It sits beside the drag
 * handle; the handle still works wherever a pointer can drag.
 *
 * Each button is a named icon button (`Move <name> up`), a 44 px target on a touch screen (the
 * kit's `icon-sm` size grows there), and disabled at the end of the list it cannot go past.
 * `busy` holds both while a save is in flight so two quick taps cannot send two orders computed
 * from the same list.
 */
export function MoveButtons({
  name,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  busy = false,
  compact = false,
  className,
}: {
  /** What the row is called, for the buttons' accessible names. */
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  busy?: boolean;
  /** 24 px buttons on a pointer screen (the smallest a target may be), for a row that is itself small (a chip). Still 44 px on touch. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={className ?? 'flex shrink-0 items-center'} data-slot="move-buttons">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} up`}
        disabled={busy || !canMoveUp}
        onClick={onMoveUp}
        className={cn('text-muted-foreground shrink-0', compact && 'size-6')}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} down`}
        disabled={busy || !canMoveDown}
        onClick={onMoveDown}
        className={cn('text-muted-foreground shrink-0', compact && 'size-6')}
      >
        <ChevronDown />
      </Button>
    </span>
  );
}
