"use client";

import { lazy, Suspense, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { CalendarDays, X } from "lucide-react";
import type { DateRange } from "react-day-picker";

import {
  formatDateForInput,
  parseDateInputText,
  isoDayToLocalDate,
  localDateToIsoDay,
  getDateInputPattern,
  type DateInputPattern,
} from "@/lib/date-input";
import {
  todayDay, daysAgoDay, startOfWeekDay, startOfMonthDay, endOfMonthDay, startOfYearDay,
} from "@/lib/date-range";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import type { Calendar as CalendarImpl } from "@/ui-kit/components/ui/calendar";
import { Input } from "@/ui-kit/components/ui/input";
import {
  Popover, PopoverAnchor, PopoverContent, PopoverTrigger,
} from "@/ui-kit/components/ui/popover";
import { TimeField } from "@/ui-kit/components/form/timeField";
import {
  Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle,
} from "@/ui-kit/components/ui/sheet";
import { useOverlayPresentation } from "@/ui-kit/hooks/useOverlayPresentation";
import { canAutoFocus } from "@/ui-kit/lib/autoFocus";

// The calendar (react-day-picker and its locale data) is a lazy chunk (mobile slice 47). Every page
// with a date field would otherwise carry it in its own first download, and the staff layout's phone
// widget has date fields of its own, which put it in the entry script. It is fetched once the first
// date field has mounted and the page is idle, so it is nearly always there before anyone opens a
// picker; if not, the panel shows an empty box of the same size for the moment it takes.
const loadCalendar = () => import("@/ui-kit/components/ui/calendar");
const LazyCalendar = lazy(() => loadCalendar().then((m) => ({ default: m.Calendar })));

function Calendar(props: ComponentProps<typeof CalendarImpl>) {
  // The empty box matches the calendar that replaces it: the touch layout is taller and wider.
  const box = props.touch ? "mx-auto h-[21.75rem] w-[19rem]" : "h-[19.5rem] w-[17.5rem]";
  return (
    <Suspense fallback={<div aria-busy="true" className={box} />}>
      <LazyCalendar {...props} />
    </Suspense>
  );
}

let calendarWarmed = false;
function useWarmCalendar() {
  useEffect(() => {
    if (calendarWarmed) return;
    calendarWarmed = true;
    const warm = () => void loadCalendar().catch(() => {});
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(warm, { timeout: 5000 });
    else setTimeout(warm, 2000);
  }, []);
}

type CollisionPadding = number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ─── The picker surface: a popover on a desktop, a bottom sheet on a phone ──────────────────────

/**
 * Below md (and on a phone held sideways, a short window) the calendar opens in a bottom sheet with
 * 40 px day cells instead of the popover hanging off the field (mobile slice 45, story 44): a
 * popover under a thumb sits wherever the field happens to be, is capped to half the screen, and
 * its 36 px days are easy to mis-hit. The decision is the one overlay presentation rule shared by
 * every overlay, asked with the "form" intent (anything but the desktop card). Exactly one of the
 * two surfaces mounts; the Popover root stays in both layouts because it owns the trigger.
 */
function useDateSheet(): boolean {
  return useOverlayPresentation("form") !== "card";
}

function DateSheet({
  open, onOpenChange, title, children, footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        data-picker="date-sheet"
        // A date field often lives inside a popover (the list filters); the sheet must outrank the popover
        // that spawned it, which sits on the floating layer.
        layer="floating"
        // 92dvh, not the sheet's default 80: the calendar, a header and a footer must fit a 568 px phone
        // without scrolling, and the body still scrolls where they cannot (a landscape phone).
        className="max-h-[92dvh] gap-0 rounded-t-xl"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <SheetBody className="p-0">{children}</SheetBody>
        <SheetFooter className="items-center justify-between gap-2 px-3">{footer}</SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** A footer action: 44 px tall in the sheet (the popover's own are the small ones). */
const SHEET_ACTION = "h-11 min-w-11 px-4";

// ─── Shared props ──────────────────────────────────────────────────────────

interface SharedProps {
  /** ISO 'YYYY-MM-DD' lower bound, INCLUSIVE. Produces disabled calendar days -
   *  never forwarded to react-day-picker's own `min`/`max`, which count
   *  selectable days in range mode, not date bounds. */
  min?: string;
  /** ISO 'YYYY-MM-DD' upper bound, INCLUSIVE. See `min`. */
  max?: string;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  /** Outer layout - width/margin relative to siblings. */
  className?: string;
  /** Overrides the text field's own geometry (height/padding), reaching past
   *  `className`, which lands on the wrapper around the field + its buttons. */
  inputClassName?: string;
  /** Whether a clear affordance is offered for a set value. Default true. */
  clearable?: boolean;
  /** Blocks dates before today - scheduling a job for last Tuesday is always a typo. */
  disablePast?: boolean;
  collisionPadding?: CollisionPadding;
}

export interface DateFieldDateProps extends SharedProps {
  mode?: "date";
  /** '' or 'YYYY-MM-DD'. */
  value: string;
  onChange: (v: string) => void;
}

export interface DateFieldDateTimeProps extends SharedProps {
  mode: "datetime";
  /** '' or 'YYYY-MM-DDTHH:MM' (local). */
  value: string;
  onChange: (v: string) => void;
  /** Forwarded to the composed `TimeField`. Default 15. */
  stepMinutes?: number;
}

export interface DateRangePreset {
  key: string;
  label: string;
  /**
   * Optional `tz` mirrors `lib/date-range.ts`'s `Preset.range`: omitted means
   * the browser clock (the pre-existing behaviour of every call site that
   * does not pass one), given means the ORG's day boundaries.
   */
  range: (tz?: string) => { from: string; to: string };
}

export interface DateFieldRangeProps extends SharedProps {
  mode: "range";
  value: { from: string; to: string };
  onChange: (next: { from: string; to: string }) => void;
  /** Rail of quick-pick presets. Defaults to `DEFAULT_DATE_RANGE_PRESETS`. */
  presets?: DateRangePreset[];
  /**
   * IANA zone the presets resolve their day boundaries in (#1634). Omitted
   * keeps the browser clock, which is what every facet except `scheduled`
   * wants - a "when was this row made" fact is viewer-local by design.
   */
  tz?: string;
}

/**
 * Discriminated on `mode` so a `range` value/onChange can never be handed to a
 * `date`/`datetime` field or vice versa - TypeScript rejects it at the call
 * site, not at runtime.
 */
export type DateFieldProps = DateFieldDateProps | DateFieldDateTimeProps | DateFieldRangeProps;

/**
 * Default range presets (matches `lib/date-range.ts`'s day-math, so a preset's
 * computed range is always identical to what the reports/list-page filters
 * that share those helpers would compute for "today"/"this week"/etc).
 */
export const DEFAULT_DATE_RANGE_PRESETS: DateRangePreset[] = [
  { key: "any", label: "Any time", range: () => ({ from: "", to: "" }) },
  { key: "today", label: "Today", range: (tz) => ({ from: todayDay(tz), to: todayDay(tz) }) },
  { key: "week", label: "This week", range: (tz) => ({ from: startOfWeekDay(tz), to: todayDay(tz) }) },
  { key: "month", label: "This month", range: (tz) => ({ from: startOfMonthDay(tz), to: endOfMonthDay(tz) }) },
  { key: "last7", label: "Last 7 days", range: (tz) => ({ from: daysAgoDay(6, tz), to: todayDay(tz) }) },
  { key: "last30", label: "Last 30 days", range: (tz) => ({ from: daysAgoDay(29, tz), to: todayDay(tz) }) },
  { key: "last90", label: "Last 90 days", range: (tz) => ({ from: daysAgoDay(89, tz), to: todayDay(tz) }) },
  { key: "year", label: "This year", range: (tz) => ({ from: startOfYearDay(tz), to: todayDay(tz) }) },
];

/**
 * How tall the popover is allowed to get.
 *
 * Two requirements pull against each other here. The panel must not resize
 * while the page scrolls, which rules out Radix's own
 * `--radix-popover-content-available-height` - that variable is recomputed as
 * the trigger moves through the viewport, so the calendar visibly grew and
 * shrank under the cursor. But it also must never be clipped by a screen edge.
 *
 * `50dvh` is the bound that satisfies both. Radix puts the panel on whichever
 * side of the trigger has more room, and that side always has at least
 * `(viewport - trigger height - 2 * collisionPadding) / 2`. Subtracting 3rem
 * covers the trigger (~40px), the padding (10px each side) and the 6px
 * sideOffset, so a panel within this bound always fits the chosen side. It
 * depends only on viewport height, which does not change on scroll.
 *
 * On a tall window the calendar's natural ~395px is well under the cap and it
 * renders at its constant full size. On a short one it caps and scrolls
 * internally, which beats both covering the field and running off screen.
 *
 * Regression guard: reproduced at 1280x720 on the Schedule event editor, where
 * the unbounded panel rendered at top:-19px.
 */
const POPOVER_MAX_HEIGHT = "max-h-[calc(50dvh-3rem)]";

// ─── Shared helpers ─────────────────────────────────────────────────────────

type DayMatcher = { before: Date } | { after: Date };

/**
 * `min`/`max`/`disablePast` -> a react-day-picker `disabled` matcher array.
 * Matchers OR together (a day is disabled if ANY matches), so `{before: min}`
 * plus `{before: startOfToday}` correctly composes to "before whichever bound
 * is later" without extra merge logic - never react-day-picker's own
 * `min`/`max`, which count selectable days in range mode, not date bounds.
 */
function buildDisabledMatchers(min?: string, max?: string, disablePast?: boolean): DayMatcher[] {
  const matchers: (DayMatcher | false | undefined)[] = [
    min ? { before: isoDayToLocalDate(min)! } : undefined,
    max ? { after: isoDayToLocalDate(max)! } : undefined,
  ];
  if (disablePast) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    matchers.push({ before: startOfToday });
  }
  return matchers.filter((m): m is DayMatcher => Boolean(m));
}

/**
 * Typeable-date text state, shared by date mode and datetime mode's date
 * sub-field. Delegates ALL parsing/formatting to `@/lib/date-input` (ability
 * 1); on parse failure it reverts the display to the last valid value with no
 * error state or callback (ability 2).
 */
function useDateText(value: string, pattern: DateInputPattern, onCommit: (iso: string) => void) {
  const [text, setText] = useState(() => formatDateForInput(value, pattern));
  // Adjusts `text` when `value` changes externally - computed during render
  // rather than in an effect, per https://react.dev/learn/you-might-not-need-an-effect.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(formatDateForInput(value, pattern));
  }

  function commit() {
    if (!text.trim()) {
      if (value) onCommit("");
      return;
    }
    const parsed = parseDateInputText(text, pattern);
    if (parsed) {
      onCommit(parsed);
      setText(formatDateForInput(parsed, pattern));
    } else {
      setText(formatDateForInput(value, pattern));
    }
  }

  return { text, setText, commit };
}

// ─── mode="date" ────────────────────────────────────────────────────────────

function DateFieldDate({
  value, onChange, min, max, disabled, placeholder, id, className, inputClassName,
  clearable = true, disablePast, collisionPadding, ...rest
}: DateFieldDateProps) {
  const pattern = getDateInputPattern();
  const [open, setOpen] = useState(false);
  const sheet = useDateSheet();
  const { text, setText, commit } = useDateText(value, pattern, onChange);

  function handleDaySelect(day: Date | undefined) {
    if (!day) return;
    const iso = localDateToIsoDay(day);
    onChange(iso);
    setText(formatDateForInput(iso, pattern));
    setOpen(false);
  }

  function handleToday() {
    handleDaySelect(new Date());
  }

  function handleClear() {
    onChange("");
    setText("");
    setOpen(false);
  }

  const disabledMatchers = buildDisabledMatchers(min, max, disablePast);
  const calendar = (
    <Calendar
      touch={sheet}
      mode="single"
      weekStartsOn={0}
      selected={isoDayToLocalDate(value)}
      defaultMonth={isoDayToLocalDate(value) ?? new Date()}
      onSelect={handleDaySelect}
      disabled={disabledMatchers.length ? disabledMatchers : undefined}
      autoFocus={canAutoFocus()}
    />
  );

  return (
    // Commits on blur, on Enter (below) AND here, when the popover closes by
    // any means - outside click, Escape, or the trigger toggling it shut
    // (ability 3).
    <Popover open={open} onOpenChange={(next) => { if (!next) commit(); setOpen(next); }}>
      <PopoverAnchor asChild>
        <div className={cn("flex items-stretch gap-1", className)}>
          <Input
            id={id}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            placeholder={placeholder ?? pattern}
            disabled={disabled}
            aria-label={rest["aria-label"]}
            aria-invalid={rest["aria-invalid"]}
            className={cn("min-w-0 flex-1", inputClassName)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
          />
          {clearable && value && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              aria-label="Clear date"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
              className="h-auto w-9 shrink-0 self-stretch"
            >
              <X />
            </Button>
          )}
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              aria-label="Open calendar"
              className="h-auto w-9 shrink-0 self-stretch"
            >
              <CalendarDays />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      {sheet ? (
        <DateSheet
          open={open}
          onOpenChange={(next) => { if (!next) commit(); setOpen(next); }}
          title="Choose a date"
          footer={
            <>
              <Button type="button" variant="ghost" disabled={disabled} onClick={handleToday} className={SHEET_ACTION}>
                Today
              </Button>
              {clearable && (
                <Button type="button" variant="ghost" disabled={disabled} onClick={handleClear} className={SHEET_ACTION}>
                  Clear
                </Button>
              )}
            </>
          }
        >
          {calendar}
        </DateSheet>
      ) : (
        <PopoverContent align="start" collisionPadding={collisionPadding ?? 10} className={cn(POPOVER_MAX_HEIGHT, "w-auto p-0")}>
          {calendar}
          <div className="flex items-center justify-between border-t p-2">
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={handleToday}>
              Today
            </Button>
            {clearable && (
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={handleClear}>
                Clear
              </Button>
            )}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}

// ─── mode="datetime" ────────────────────────────────────────────────────────

/**
 * Superset of the date field: a typeable date sub-field composed with a
 * typeable `TimeField` (variant="input") - ability 6. Off-grid times like
 * "3:07" and shorthand like "3p" work because they are TimeField's own
 * parsing, not reimplemented here.
 */
function DateFieldDateTime({
  value, onChange, min, max, disabled, placeholder, id, className, inputClassName,
  clearable = true, disablePast, collisionPadding, stepMinutes = 15, ...rest
}: DateFieldDateTimeProps) {
  const pattern = getDateInputPattern();
  const [open, setOpen] = useState(false);
  const sheet = useDateSheet();

  const datePart = value ? value.slice(0, 10) : "";
  const timePart = value ? value.slice(11, 16) : "";

  // Datetime edge cases (ability 7): a date set with no time defaults the
  // time to 09:00; a time set with no date defaults the date to today;
  // clearing the time clears the whole value.
  function handleDateChange(d: string) {
    onChange(d ? `${d}T${timePart || "09:00"}` : "");
  }

  function handleTimeChange(t: string) {
    if (!t) {
      onChange("");
      return;
    }
    onChange(`${datePart || localDateToIsoDay(new Date())}T${t}`);
  }

  const { text, setText, commit } = useDateText(datePart, pattern, handleDateChange);

  function handleDaySelect(day: Date | undefined) {
    if (!day) return;
    const iso = localDateToIsoDay(day);
    handleDateChange(iso);
    setText(formatDateForInput(iso, pattern));
    setOpen(false);
  }

  function handleNow() {
    const now = new Date();
    onChange(`${localDateToIsoDay(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
    setOpen(false);
  }

  function handleClear() {
    onChange("");
    setText("");
    setOpen(false);
  }

  const disabledMatchers = buildDisabledMatchers(min, max, disablePast);
  // Both sub-fields squeeze into one composed row - `px-2.5` is the same
  // fallback legacy `components/form/DateTimePicker` applied to stop the
  // meridiem clipping to "9:00 A" in a narrow dialog. It is only a default:
  // an explicit `inputClassName` from the caller still wins via twMerge.
  const composedInputClassName = cn("px-2.5", inputClassName);
  const calendar = (
    <Calendar
      touch={sheet}
      mode="single"
      weekStartsOn={0}
      selected={isoDayToLocalDate(datePart)}
      defaultMonth={isoDayToLocalDate(datePart) ?? new Date()}
      onSelect={handleDaySelect}
      disabled={disabledMatchers.length ? disabledMatchers : undefined}
      autoFocus={canAutoFocus()}
    />
  );

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) commit(); setOpen(next); }}>
      <PopoverAnchor asChild>
        <div className={cn("flex flex-wrap items-stretch gap-2", className)}>
          <div className="flex min-w-[8.75rem] grow basis-[8.75rem] items-stretch gap-1">
            <Input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={text}
              placeholder={placeholder ?? pattern}
              disabled={disabled}
              aria-label={rest["aria-label"] ? `${rest["aria-label"]} date` : undefined}
              aria-invalid={rest["aria-invalid"]}
              className={cn("min-w-0 flex-1", composedInputClassName)}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
              }}
            />
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={disabled}
                aria-label="Open calendar"
                className="h-auto w-9 shrink-0 self-stretch"
              >
                <CalendarDays />
              </Button>
            </PopoverTrigger>
          </div>
          {/* Time and Clear share one wrap group so a narrow container drops
              them together, rather than orphaning a lone X on its own row -
              carried over from the legacy composed layout. */}
          <div className="flex min-w-[10rem] grow basis-[10rem] items-stretch gap-1">
            <TimeField
              value={timePart}
              onChange={handleTimeChange}
              stepMinutes={stepMinutes}
              disabled={disabled}
              clearable={clearable}
              collisionPadding={collisionPadding}
              aria-label={rest["aria-label"] ? `${rest["aria-label"]} time` : undefined}
              aria-invalid={rest["aria-invalid"]}
              className="min-w-0 grow"
              inputClassName={composedInputClassName}
            />
            {clearable && value && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={disabled}
                aria-label="Clear date and time"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleClear}
                className="h-auto w-9 shrink-0 self-stretch"
              >
                <X />
              </Button>
            )}
          </div>
        </div>
      </PopoverAnchor>
      {sheet ? (
        <DateSheet
          open={open}
          onOpenChange={(next) => { if (!next) commit(); setOpen(next); }}
          title="Choose a date and time"
          footer={
            <>
              <Button type="button" variant="ghost" disabled={disabled} onClick={handleNow} className={SHEET_ACTION}>
                Now
              </Button>
              {clearable && (
                <Button type="button" variant="ghost" disabled={disabled} onClick={handleClear} className={SHEET_ACTION}>
                  Clear
                </Button>
              )}
            </>
          }
        >
          {calendar}
        </DateSheet>
      ) : (
        <PopoverContent align="start" collisionPadding={collisionPadding ?? 10} className={cn(POPOVER_MAX_HEIGHT, "w-auto p-0")}>
          {calendar}
          <div className="flex items-center justify-between border-t p-2">
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={handleNow}>
              Now
            </Button>
            {clearable && (
              <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={handleClear}>
                Clear
              </Button>
            )}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}

// ─── mode="range" ───────────────────────────────────────────────────────────

/** Which preset (if any) the current {from,to} exactly matches. */
function matchPresetKey(from: string, to: string, presets: DateRangePreset[], tz?: string): string | null {
  for (const p of presets) {
    const r = p.range(tz);
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}

function DateFieldRange({
  value, onChange, min, max, disabled, placeholder, id, className, inputClassName,
  clearable = true, disablePast, collisionPadding, presets = DEFAULT_DATE_RANGE_PRESETS, tz, ...rest
}: DateFieldRangeProps) {
  const pattern = getDateInputPattern();
  const [open, setOpen] = useState(false);
  const sheet = useDateSheet();
  const { from, to } = value;

  // Sticky custom mode (ability 10): picking a preset clears it; typing or
  // dragging a range sets it, even when the result happens to equal a
  // preset's own computed range. It resets ONLY when both bounds clear -
  // read as a render-time sync rather than an effect, matching the rest of
  // this file.
  const [customMode, setCustomMode] = useState(() => matchPresetKey(from, to, presets, tz) === null && Boolean(from || to));
  const [prevFrom, setPrevFrom] = useState(from);
  const [prevTo, setPrevTo] = useState(to);
  if (from !== prevFrom || to !== prevTo) {
    setPrevFrom(from);
    setPrevTo(to);
    if (!from && !to) setCustomMode(false);
  }
  const activePresetKey = customMode ? null : matchPresetKey(from, to, presets, tz);

  const [fromText, setFromText] = useState(() => formatDateForInput(from, pattern));
  const [prevFromValue, setPrevFromValue] = useState(from);
  if (from !== prevFromValue) {
    setPrevFromValue(from);
    setFromText(formatDateForInput(from, pattern));
  }

  const [toText, setToText] = useState(() => formatDateForInput(to, pattern));
  const [prevToValue, setPrevToValue] = useState(to);
  if (to !== prevToValue) {
    setPrevToValue(to);
    setToText(formatDateForInput(to, pattern));
  }

  // Resolves ONE typed bound in isolation: '' -> '', an unparseable or
  // cross-bound-inverting text -> `ownCurrent` (revert), else the parsed ISO
  // day. Cross-field bounding (ability 11): a `from` typed later than
  // `otherBound` (max mode) or a `to` typed earlier than it (min mode) is
  // rejected the same way an unparseable date is - the range never inverts.
  function resolveBound(text: string, ownCurrent: string, otherBound: string, boundIsMax: boolean): string {
    if (!text.trim()) return "";
    const parsed = parseDateInputText(text, pattern);
    if (!parsed) return ownCurrent;
    if (otherBound && boundIsMax && parsed > otherBound) return ownCurrent;
    if (otherBound && !boundIsMax && parsed < otherBound) return ownCurrent;
    return parsed;
  }

  // Single-field commits (blur / Enter on just that input) resolve only the
  // field that fired, bounded against the OTHER field's already-committed
  // value, and skip onChange/setCustomMode entirely when nothing actually
  // changed - a blur that reverts, or re-commits the same text, must not
  // un-highlight an active preset or hand a filter popover a fresh object.
  function commitFrom() {
    const nextFrom = resolveBound(fromText, from, to, true);
    setFromText(formatDateForInput(nextFrom, pattern));
    if (nextFrom !== from) {
      onChange({ from: nextFrom, to });
      setCustomMode(true);
    }
  }

  function commitTo() {
    const nextTo = resolveBound(toText, to, from, false);
    setToText(formatDateForInput(nextTo, pattern));
    if (nextTo !== to) {
      onChange({ from, to: nextTo });
      setCustomMode(true);
    }
  }

  // Popover-close commit (outside click, Escape, trigger toggle - ability 3).
  // Resolves BOTH fields into ONE object and emits at most once. Calling
  // commitFrom() then commitTo() back to back is the bug this replaces: React
  // does not re-render between the two calls, so the second one closes over
  // the first render's pre-edit value and overwrites it - a just-typed
  // `from` gets silently discarded. Also skips the emit/setCustomMode
  // entirely when neither bound actually changed, so merely opening and
  // closing the popover does not un-highlight an active preset or fire a
  // spurious onChange with fresh object identity.
  function commitRangeOnClose() {
    const nextFrom = resolveBound(fromText, from, to, true);
    const nextTo = resolveBound(toText, to, from, false);
    setFromText(formatDateForInput(nextFrom, pattern));
    setToText(formatDateForInput(nextTo, pattern));
    if (nextFrom !== from || nextTo !== to) {
      onChange({ from: nextFrom, to: nextTo });
      setCustomMode(true);
    }
  }

  function selectPreset(preset: DateRangePreset) {
    setCustomMode(false);
    onChange(preset.range(tz));
    // Deliberately does not close - lets the grid light up while the popover
    // stays open (ability 9).
  }

  function handleRangeSelect(range: DateRange | undefined, triggerDate: Date) {
    if (!range) {
      // react-day-picker's own range-add algorithm can return undefined from
      // a starting `selected` shape it does not model - a `to`-only range
      // (`from` empty), which `dateChipLabel` treats as a legitimate
      // open-ended "<= to" filter. Falling through to `{from:'',to:''}` here
      // would silently wipe that value on the very next click; start a fresh
      // range at the clicked day instead; the same recovery DayPicker itself
      // uses when nothing was selected.
      setCustomMode(true);
      onChange({ from: localDateToIsoDay(triggerDate), to: "" });
      return;
    }
    setCustomMode(true);
    onChange({
      from: range.from ? localDateToIsoDay(range.from) : "",
      to: range.to ? localDateToIsoDay(range.to) : "",
    });
  }

  function handleClear() {
    onChange({ from: "", to: "" });
    setCustomMode(false);
    setOpen(false);
  }

  const disabledMatchers = buildDisabledMatchers(min, max, disablePast);
  const ariaLabel = rest["aria-label"];
  const rangeCalendar = (
    <Calendar
      touch={sheet}
      mode="range"
      weekStartsOn={0}
      numberOfMonths={sheet ? 1 : 2}
      selected={{ from: isoDayToLocalDate(from), to: isoDayToLocalDate(to) }}
      defaultMonth={isoDayToLocalDate(from) ?? new Date()}
      onSelect={handleRangeSelect}
      disabled={disabledMatchers.length ? disabledMatchers : undefined}
      autoFocus={canAutoFocus()}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) commitRangeOnClose();
        setOpen(next);
      }}
    >
      <PopoverAnchor asChild>
        <div className={cn("flex items-stretch gap-1", className)}>
          <Input
            id={id}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={fromText}
            placeholder={placeholder ?? pattern}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} from` : "From"}
            aria-invalid={rest["aria-invalid"]}
            className={cn("min-w-0 flex-1", inputClassName)}
            onChange={(e) => setFromText(e.target.value)}
            onBlur={commitFrom}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitFrom(); } }}
          />
          <span className="text-subtle-foreground self-center">-</span>
          <Input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={toText}
            placeholder={placeholder ?? pattern}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} to` : "To"}
            aria-invalid={rest["aria-invalid"]}
            className={cn("min-w-0 flex-1", inputClassName)}
            onChange={(e) => setToText(e.target.value)}
            onBlur={commitTo}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitTo(); } }}
          />
          {clearable && (from || to) && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              aria-label="Clear date range"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
              className="h-auto w-9 shrink-0 self-stretch"
            >
              <X />
            </Button>
          )}
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              aria-label="Open calendar"
              className="h-auto w-9 shrink-0 self-stretch"
            >
              <CalendarDays />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      {sheet ? (
        <DateSheet
          open={open}
          onOpenChange={(next) => {
            if (!next) commitRangeOnClose();
            setOpen(next);
          }}
          title="Choose a date range"
          footer={
            <>
              {clearable ? (
                <Button type="button" variant="ghost" disabled={disabled} onClick={handleClear} className={SHEET_ACTION}>
                  Clear
                </Button>
              ) : <span />}
              {/* A range is two taps and the sheet does not close on its own (the grid lights up as
                  presets and days are tried), so it needs a way out that is not the corner X. */}
              <Button type="button" onClick={() => { commitRangeOnClose(); setOpen(false); }} className={SHEET_ACTION}>
                Done
              </Button>
            </>
          }
        >
          {/* The rail wraps above the grid (a 144 px rail beside two months is wider than a phone). */}
          <div className="flex flex-wrap gap-2 border-b px-3 py-3">
            {presets.map((p) => (
              <Button
                key={p.key}
                type="button"
                variant="outline"
                disabled={disabled}
                aria-pressed={activePresetKey === p.key}
                onClick={() => selectPreset(p)}
                className={cn(
                  "min-h-11 px-3 text-[13.5px] font-medium",
                  activePresetKey === p.key && "border-brand bg-brand-subtle text-brand font-semibold",
                )}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {rangeCalendar}
        </DateSheet>
      ) : (
        <PopoverContent align="start" collisionPadding={collisionPadding ?? 10} className={cn("flex w-auto gap-2 p-2", POPOVER_MAX_HEIGHT)}>
          {/* Rail, not a dropdown (ability 9) - DATA-driven from `presets`, not
              hardcoded. */}
          <div className="flex w-36 shrink-0 flex-col gap-0.5 border-r pr-2">
            {presets.map((p) => (
              <Button
                key={p.key}
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                // The active preset is a toggle state, not just a tint - without
                // this a screen reader hears eight identical buttons with no way
                // to tell which range is currently applied.
                aria-pressed={activePresetKey === p.key}
                onClick={() => selectPreset(p)}
                className={cn(
                  "h-auto justify-start px-2 py-1.5 text-sm font-normal",
                  activePresetKey === p.key && "bg-brand-subtle text-brand font-semibold",
                )}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {/* Two months side by side - a range that crosses a month boundary is
              one drag, not four clicks (ability 8, harvested from the dead
              kit-only DateRangePicker). */}
          {rangeCalendar}
        </PopoverContent>
      )}
    </Popover>
  );
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Unified date/time field (SRVW-247 step 2), replacing `components/form/DatePicker`,
 * `pages/v2/_shared/datePicker`, `components/form/DateTimePicker`,
 * `pages/v2/_shared/dateTimePicker`, `components/form/DateRangeField` and the dead
 * `ui-kit/components/form/datePicker`.
 *
 * Three modes, one component, discriminated by `mode` (default "date"):
 *   - "date":     value '' | 'YYYY-MM-DD',            onChange(v: string)
 *   - "datetime": value '' | 'YYYY-MM-DDTHH:MM',       onChange(v: string)
 *   - "range":    value {from,to} 'YYYY-MM-DD' | '',   onChange({from,to})
 *
 * Empty is always '' (never null/undefined) in every mode. Every mode is
 * typeable - type in the org's date pattern (default MM/DD/YYYY) or paste an
 * ISO 'YYYY-MM-DD'; a native `<input type="date">` renders in the BROWSER's
 * locale, which is why this exists (`__tests__/no-native-time-inputs.test.ts`).
 * Parsing/formatting are delegated entirely to `@/lib/date-input` - nothing
 * about dates is re-derived here.
 */
function DateField(props: DateFieldProps) {
  useWarmCalendar();
  if (props.mode === "datetime") return <DateFieldDateTime {...props} />;
  if (props.mode === "range") return <DateFieldRange {...props} />;
  return <DateFieldDate {...props} />;
}

export { DateField };
