import * as React from 'react';
import { createContext, useContext } from 'react';
import { format, getDay } from 'date-fns';
import { FoldHorizontal, UnfoldHorizontal } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';

/**
 * Mobile slice 60 - the tap alternative to "double-click a day to widen its column".
 *
 * In the week view a day column can be made wider (about 40% of the row) so a crowded day is
 * readable. That used to be reachable only by double-clicking the column or its header, which a
 * finger cannot do. Each week-view day header now carries this one button that does the same.
 *
 * Shown on touch screens (`touch:` is a coarse primary pointer), where it is a full-height tap
 * target under the date. On a mouse screen it stays out of the way, visually hidden but still in
 * the page for a keyboard or a screen reader (its own box is 1 px there, so it is not a stray
 * undersized target), and it shows itself when it takes focus. The
 * double-click shortcut is unchanged. On a short window (a phone held sideways) the button sits
 * beside the date instead of under it, so the header stays one row tall and the time grid keeps its
 * 200 px (rule in styles/schedule-dark.css, under the same 500 px condition as slice 42's).
 *
 * The header around it navigates on click (to that day), so this button owns its click and its
 * double-click: neither reaches the header or the calendar's own double-click handler.
 */
interface DayWidenButtonProps {
  date: Date;
  /** Flips this day's widening (the page's own `toggleDayFocus`, by the day's index). */
  onToggle: () => void;
}

/**
 * Which weekday column (0 = Sunday) is widened right now, or null.
 *
 * It travels by context, NOT as a prop of the header component, on purpose: the library mounts
 * `components.header` by identity, so a header function that closed over this value would be a
 * new component on every toggle, the seven headers would be rebuilt, and the button just pressed
 * would be replaced by a new one, dropping focus to the page.
 */
export const WidenedDayContext = createContext<number | null>(null);

export function DayWidenButton({ date, onToggle }: DayWidenButtonProps) {
  const widened = useContext(WidenedDayContext) === getDay(date);
  const Icon = widened ? FoldHorizontal : UnfoldHorizontal;
  return (
    // The wrapper carries the show/hide rule: visually hidden (but still in the page) on a mouse
    // screen, a full-width row under the date on touch, and shown again while the button has focus.
    <span className="schedule-day-widen-wrap sr-only flex touch:not-sr-only touch:w-full focus-within:not-sr-only">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="schedule-day-widen"
        aria-pressed={widened}
        aria-label={`Widen ${format(date, 'EEEE, MMMM d')}`}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onToggle();
        }}
        onDoubleClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="h-6 w-6 max-h-px max-w-px touch:max-h-none touch:max-w-none focus:max-h-none focus:max-w-none touch:h-11 touch:w-full touch:min-w-0 p-0 text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
      >
        <Icon aria-hidden="true" />
      </Button>
    </span>
  );
}
