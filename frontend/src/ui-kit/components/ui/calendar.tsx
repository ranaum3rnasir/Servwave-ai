"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { DayPicker, useDayPicker } from "react-day-picker";

import { cn } from "@/ui-kit/lib/utils";
import { buttonVariants } from "@/ui-kit/components/ui/button";

/**
 * react-day-picker, restyled to our tokens in the shape of MUI's date picker.
 *
 * Not hand-rolled because a correct month grid is more work than it looks:
 * locale-aware week starts, DST-safe day arithmetic, range selection, disabled
 * ranges, and full arrow-key navigation across month boundaries.
 *
 * What "MUI-shaped" means here, concretely:
 *  - the caption sits LEFT and doubles as the year-view toggle; both nav arrows
 *    sit together on the RIGHT, rather than one arrow on either side
 *  - day cells are circles; the selection is a filled circle, today an outlined one
 *  - the panel never changes size - six week rows are always rendered, and the
 *    year view is height-matched to the day grid (see CALENDAR_BODY_HEIGHT)
 */

/** MUI's own bounds. Wide enough that no real date-of-birth or warranty date falls outside. */
const FIRST_YEAR = 1900;
const LAST_YEAR = 2100;

/**
 * The day grid's height, held constant so toggling to the year view (and back)
 * does not resize the popover. Six 36px rows, each with a 6px top margin, under
 * an 18.26px weekday header row - measured at 267.01px in the browser, rounded
 * up so the year view is never the shorter of the two.
 */
const CALENDAR_BODY_HEIGHT = "16.9375rem"; // 271px

/**
 * The touch layout (mobile slice 45, TOUCH-01): 40 px day cells instead of 36, a 44 px header, and
 * tighter row gaps, so six weeks still fit above a Today/Clear footer in a bottom sheet on a
 * 568 px-tall phone. Seven 40 px columns plus the 12 px gutters are 304 px, inside a 320 px screen.
 * It is chosen by the caller (the date field, below md), never by a pointer query: a narrow desktop
 * window is a phone-width layout too.
 */
const CALENDAR_BODY_HEIGHT_TOUCH = "17.25rem"; // 276px: 18px weekdays + six 40px rows + 2px gaps

/** MUI labels weekdays with a single letter - S M T W T F S. */
function formatWeekdayName(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "narrow" });
}

interface HeaderProps {
  label: React.ReactNode;
  /** 44 px header controls and a roomier label (the touch layout). */
  touch?: boolean;
  /** Absent on multi-month calendars, where a single year view would be ambiguous. */
  onToggleView?: () => void;
  yearViewOpen: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}

/**
 * One header for both views, so the chrome cannot drift between them. The day
 * view renders it through DayPicker's MonthCaption slot; the year view renders
 * it directly, since DayPicker is not mounted there.
 */
function CalendarHeader({ label, touch, onToggleView, yearViewOpen, onPrev, onNext }: HeaderProps) {
  return (
    <div className={cn("flex w-full items-center justify-between", touch ? "h-11" : "h-9")}>
      {onToggleView ? (
        <button
          type="button"
          onClick={onToggleView}
          aria-expanded={yearViewOpen}
          aria-label={yearViewOpen ? "Close year selection" : "Select a year"}
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-1 text-[13.5px] font-bold tracking-tight",
            touch && "min-h-11 px-2 text-[15px]",
            "cursor-pointer transition-colors hover:bg-muted",
            "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
          )}
        >
          {label}
          <ChevronDown
            className={cn("size-4 transition-transform", yearViewOpen && "rotate-180")}
          />
        </button>
      ) : (
        <span className="px-1.5 text-[13.5px] font-bold tracking-tight">{label}</span>
      )}

      {/* Both arrows together on the right, MUI-style. Hidden in the year view,
          where paging a month the user cannot see would be meaningless. */}
      <div className={cn("flex items-center gap-1", yearViewOpen && "invisible")}>
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev}
          aria-label="Go to the previous month"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "text-muted-foreground hover:text-foreground",
            touch && "size-11",
          )}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Go to the next month"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "text-muted-foreground hover:text-foreground",
            touch && "size-11",
          )}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Reads the nav handlers out of DayPicker's own context rather than duplicating
 * month arithmetic - `previousMonth`/`nextMonth` are already undefined when a
 * `startMonth`/`endMonth` bound blocks the step, which is what disables the button.
 */
function DayViewHeader({
  label,
  touch,
  onToggleView,
}: {
  label: React.ReactNode;
  touch?: boolean;
  onToggleView?: () => void;
}) {
  const { goToMonth, previousMonth, nextMonth } = useDayPicker();
  return (
    <CalendarHeader
      label={label}
      touch={touch}
      yearViewOpen={false}
      onToggleView={onToggleView}
      onPrev={previousMonth ? () => goToMonth(previousMonth) : undefined}
      onNext={nextMonth ? () => goToMonth(nextMonth) : undefined}
    />
  );
}

function YearGrid({
  activeYear,
  onSelect,
  touch,
}: {
  activeYear: number;
  onSelect: (year: number) => void;
  touch?: boolean;
}) {
  const activeRef = React.useRef<HTMLButtonElement>(null);

  // Open on the active year rather than at 1900. `block: "center"` puts it mid
  // panel, so the years either side are visible and the list reads as scrollable.
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center" });
  }, []);

  const years = React.useMemo(
    () => Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i),
    [],
  );

  return (
    <div
      role="listbox"
      aria-label="Year"
      className="grid grid-cols-3 gap-1 overflow-y-auto overscroll-contain"
      style={{ height: touch ? CALENDAR_BODY_HEIGHT_TOUCH : CALENDAR_BODY_HEIGHT }}
    >
      {years.map((year) => {
        const isActive = year === activeYear;
        return (
          <button
            key={year}
            ref={isActive ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={isActive}
            onClick={() => onSelect(year)}
            className={cn(
              touch ? "h-11 text-[15px]" : "h-9 text-[13px]",
              "rounded-full font-medium transition-colors cursor-pointer",
              "hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
              isActive && "bg-brand text-brand-foreground font-bold hover:bg-brand",
            )}
          >
            {year}
          </button>
        );
      })}
    </div>
  );
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  // Always render six week rows. A month needing five (or four, for a February
  // starting on the week start) would otherwise paint a shorter grid, so the
  // panel would change height as you page between months.
  fixedWeeks = true,
  numberOfMonths,
  month: monthProp,
  defaultMonth,
  onMonthChange,
  touch = false,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  /** The touch layout: 40 px day cells and a 44 px header (mobile slice 45). Off by default. */
  touch?: boolean;
}) {
  const [yearViewOpen, setYearViewOpen] = React.useState(false);

  // The year view has to be able to move the displayed month, which means
  // owning it. Seeded from `defaultMonth` so existing callers are unaffected;
  // a caller passing `month` stays in charge.
  const [monthState, setMonthState] = React.useState<Date>(
    () => monthProp ?? defaultMonth ?? new Date(),
  );
  const month = monthProp ?? monthState;

  const setMonth = React.useCallback(
    (next: Date) => {
      setMonthState(next);
      onMonthChange?.(next);
    },
    [onMonthChange],
  );

  // A single year view cannot speak for two side-by-side months, so range
  // calendars keep a plain caption. Paging by arrow still works there.
  const canSelectYear = (numberOfMonths ?? 1) === 1;

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  if (yearViewOpen && canSelectYear) {
    return (
      // 7 day columns at 36px plus the p-3 gutters - matches the day grid to
      // the pixel, so toggling views does not nudge the panel width either.
      <div className={cn(touch ? "mx-auto w-[19rem] p-3" : "w-[17.25rem] p-3", className)}>
        <CalendarHeader
          label={monthLabel}
          touch={touch}
          yearViewOpen
          onToggleView={() => setYearViewOpen(false)}
        />
        <div className="mt-3">
          <YearGrid
            activeYear={month.getFullYear()}
            touch={touch}
            onSelect={(year) => {
              setMonth(new Date(year, month.getMonth(), 1));
              setYearViewOpen(false);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays={showOutsideDays}
      fixedWeeks={fixedWeeks}
      numberOfMonths={numberOfMonths}
      month={month}
      onMonthChange={setMonth}
      formatters={{ formatWeekdayName, ...props.formatters }}
      className={cn("p-3", touch && "mx-auto w-fit", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-4",
        month: cn("flex flex-col", touch ? "gap-2" : "gap-3"),
        month_caption: cn("flex items-center", touch ? "h-11" : "h-9"),
        caption_label: "sr-only",
        // Our own header (CalendarHeader, rendered through the MonthCaption slot) owns
        // the arrows, so DayPicker's nav is redundant. This is also what retires the
        // staging-side `navLayout="around"` fix for the old absolutely-positioned nav
        // being painted over by the caption: that nav no longer renders at all. Do not
        // reintroduce `navLayout="around"` here - in that mode react-day-picker renders
        // the Prev/Next buttons straight into `month` with no `nav` wrapper, so this
        // `hidden` would not catch them and the panel would show two sets of arrows.
        nav: "hidden",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: cn(
          "text-subtle-foreground text-[11px] font-semibold uppercase tracking-wide",
          touch ? "w-10" : "w-9",
        ),
        week: cn("flex w-full", touch ? "mt-0.5" : "mt-1.5"),
        day: cn(
          "relative p-0 text-center",
          touch ? "size-10" : "size-9",
          // Range fills bleed to the cell edges so selected weeks read as one bar.
          "[&:has([aria-selected])]:bg-brand-subtle",
          "[&:has(>.day-range-start)]:rounded-l-full [&:has(>.day-range-end)]:rounded-r-full",
          "first:[&:has([aria-selected])]:rounded-l-full last:[&:has([aria-selected])]:rounded-r-full",
        ),
        day_button: cn(
          // Circular, MUI-style - the selection reads as a dot on the date, not
          // a block covering the cell.
          touch ? "size-10 text-[15px]" : "size-9 text-[13px]",
          "rounded-full font-medium transition-colors cursor-pointer",
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
        MonthCaption: ({ calendarMonth }) => (
          <DayViewHeader
            label={calendarMonth.date.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
            touch={touch}
            onToggleView={canSelectYear ? () => setYearViewOpen(true) : undefined}
          />
        ),
        ...props.components,
      }}
      {...props}
    />
  );
}

export { Calendar };
