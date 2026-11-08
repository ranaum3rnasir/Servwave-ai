"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { cn } from "@/ui-kit/lib/utils";
import { buttonVariants } from "@/ui-kit/components/ui/button";

/**
 * react-day-picker, restyled to our tokens.
 *
 * Not hand-rolled because a correct month grid is more work than it looks:
 * locale-aware week starts, DST-safe day arithmetic, range selection, disabled
 * ranges, and full arrow-key navigation across month boundaries.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      data-slot="calendar"
      /**
       * BUG FIX - month navigation used to work only intermittently.
       *
       * Without this prop, react-day-picker renders `Nav` as a SIBLING of the month
       * blocks (a child of `Months`), not inside `month_caption`. The old styling
       * absolutely positioned that nav with `inset-x-0` while the only `relative` was on
       * `month_caption` - which is not the nav's ancestor. So the nav resolved against
       * whatever positioned box was above it (the popover), and `month_caption`, being a
       * LATER sibling, painted on top of it. Only the few pixels of arrow overhanging the
       * calendar's own `p-3` padding were still clickable, so a click near the outer edge
       * advanced the month and a click anywhere else silently did nothing.
       *
       * `navLayout="around"` makes the library render the two buttons INSIDE the caption,
       * flanking the label. No absolute positioning, nothing painting over them, and the
       * arrows end up in the tight cluster the design asks for rather than pinned to the
       * far corners.
       */
      navLayout="around"
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-4",
        /**
         * `navLayout="around"` renders the two buttons as SIBLINGS of the caption inside
         * `month` - the DOM order is [prev, caption, next, grid] - so a flex COLUMN here
         * stacks them vertically. A three-column grid puts the nav row back on one line:
         * prev · label · next sized to content and centred as a cluster, with the grid
         * spanning all three columns beneath it.
         */
        month: "grid grid-cols-[auto_auto_auto] justify-center items-center gap-x-1 gap-y-3",
        month_caption: "flex items-center justify-center h-8",
        // A fixed floor so the arrows do not shuffle as the month name changes width.
        caption_label: "text-[13.5px] font-bold tracking-tight px-1 min-w-[8.5rem] text-center",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-foreground",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground hover:text-foreground",
        ),
        month_grid: "col-span-3 w-full border-collapse",
        weekdays: "flex",
        weekday: "text-subtle-foreground w-9 text-[11px] font-semibold uppercase tracking-wide",
        week: "flex w-full mt-1.5",
        day: cn(
          "relative size-9 p-0 text-center",
          // Range fills bleed to the cell edges so selected weeks read as one bar.
          "[&:has([aria-selected])]:bg-brand-subtle",
          "[&:has(>.day-range-start)]:rounded-l-md [&:has(>.day-range-end)]:rounded-r-md",
          "first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md",
        ),
        day_button: cn(
          "size-9 rounded-md text-[13px] font-medium transition-colors cursor-pointer",
          "hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        ),
        selected:
          "[&>button]:bg-brand [&>button]:text-brand-foreground [&>button]:hover:bg-brand [&>button]:font-bold",
        range_start: "day-range-start",
        range_end: "day-range-end",
        range_middle: "[&>button]:bg-transparent [&>button]:text-foreground",
        // A ring, not a fill - today should be findable without looking selected.
        today: "[&>button]:ring-1 [&>button]:ring-brand [&>button]:font-bold",
        outside:
          "[&>button]:text-subtle-foreground [&>button]:aria-disabled:text-disabled-foreground",
        disabled: "[&>button]:text-disabled-foreground [&>button]:cursor-not-allowed",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === "left"
            ? <ChevronLeft className="size-4" {...rest} />
            : <ChevronRight className="size-4" {...rest} />,
      }}
      {...props}
    />
  );
}

export { Calendar };
