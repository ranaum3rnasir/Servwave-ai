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
 *
 * Passing `onDisabledPress` switches to SOFT disabling (the Lists page): the buttons stay focusable and tappable
 * with `aria-disabled` instead of the native `disabled`, so a person who cannot hover can still be told why. With a
 * `disabledReason` both buttons are off and a press reports that reason; without one only the ends are off and a
 * press does nothing. The default (native `disabled`) is unchanged for every other list.
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
  disabledReason,
  onDisabledPress,
  buttonClassName,
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
  /** Why reordering is off right now (soft mode only): both buttons go `aria-disabled` and show it as their title. */
  disabledReason?: string;
  /** Soft mode: called with the reason when an `aria-disabled` button is pressed and a reason was given. */
  onDisabledPress?: (reason: string) => void;
  /** Extra classes for both buttons (the Lists rows use 32 px buttons). */
  buttonClassName?: string;
}) {
  const soft = onDisabledPress !== undefined;
  const props = (can: boolean, label: 'up' | 'down', move: () => void) => {
    if (!soft) return { disabled: busy || !can, onClick: move };
    const off = busy || !can || !!disabledReason;
    return {
      'aria-disabled': off || undefined,
      title: disabledReason ?? (can ? `Move ${label}` : undefined),
      onClick: () => {
        if (off) {
          if (disabledReason) onDisabledPress(disabledReason);
          return;
        }
        move();
      },
    };
  };
  const softOff = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-[.35]';
  return (
    <span className={className ?? 'flex shrink-0 items-center'} data-slot="move-buttons">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} up`}
        {...props(canMoveUp, 'up', onMoveUp)}
        className={cn('text-muted-foreground shrink-0', compact && 'size-6', soft && softOff, buttonClassName)}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} down`}
        {...props(canMoveDown, 'down', onMoveDown)}
        className={cn('text-muted-foreground shrink-0', compact && 'size-6', soft && softOff, buttonClassName)}
      >
        <ChevronDown />
      </Button>
    </span>
  );
}
