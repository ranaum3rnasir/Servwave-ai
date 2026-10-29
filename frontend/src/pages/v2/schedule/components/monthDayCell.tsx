import * as React from 'react';
import { createContext, useContext } from 'react';

import { Button } from '@/ui-kit/components/ui/button';

import { dayKey, monthCellLabel } from '../monthDayCounts';

/**
 * Mobile slice 42 - a Month day cell at phone width.
 *
 * react-big-calendar renders the date number inside each cell as `components.month.dateHeader`.
 * Below `md` the board swaps that for this: one button that fills the cell (so the whole cell is
 * the tap target, 44 px or more - schedule-dark.css sizes it), carries the day's event count
 * instead of unreadable chips, and is named with its full date and count for a screen reader.
 * Activating it runs the library's own drill-down, which the page maps to "open that day".
 */
export const MonthDayCountsContext = createContext<ReadonlyMap<string, number>>(new Map());

interface MonthDayCellProps {
  label: React.ReactNode;
  date: Date;
  onDrillDown?: React.MouseEventHandler<HTMLElement>;
  isOffRange?: boolean;
}

export function MonthDayCell({ label, date, onDrillDown, isOffRange }: MonthDayCellProps) {
  const counts = useContext(MonthDayCountsContext);
  const count = counts.get(dayKey(date)) ?? 0;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-month-day-cell
      data-off-range={isOffRange ? 'true' : undefined}
      aria-label={monthCellLabel(date, count)}
      onClick={onDrillDown}
      className="h-full min-h-11 w-full min-w-0 flex-col gap-0.5 rounded-none p-0 font-normal"
    >
      <span className="month-day-num text-[13px] leading-none">{label}</span>
      {count > 0 && (
        <span
          aria-hidden="true"
          className="month-day-count rounded-full bg-brand px-1.5 text-[10px] font-semibold leading-4 text-brand-foreground"
        >
          {count}
        </span>
      )}
    </Button>
  );
}
