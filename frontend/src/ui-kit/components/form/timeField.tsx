"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { Clock, X } from "lucide-react";

import { formatTimeForInput, parseTimeInputText, timeOptionMatchesQuery } from "@/lib/date-input";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import { Input } from "@/ui-kit/components/ui/input";
import {
  Popover, PopoverAnchor, PopoverContent, PopoverTrigger,
} from "@/ui-kit/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui-kit/components/ui/select";

type CollisionPadding = number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;

export interface TimeFieldProps {
  /** '' or 'HH:MM' (24-hour) - the same string contract every prior time control used. */
  value: string;
  onChange: (v: string) => void;
  /**
   * 'input' (default): typeable text field with a popover list, replacing
   * `components/form/TimeCombobox` / `pages/v2/_shared/timeCombobox`.
   * 'select': compact choose-only kit Select, replacing
   * `components/form/TimeSelect` / `pages/v2/_shared/timeSelect`.
   *
   * A VARIANT of this one component, not a second component - both read and
   * write the same 'HH:MM' contract and share the same off-grid handling.
   */
  variant?: "input" | "select";
  stepMinutes?: number;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  /**
   * Overrides the text field's own geometry (height/padding/font) for compact
   * call sites, independently of `className` (outer layout - width/margin
   * relative to siblings) - see the originals' identical prop
   * (`components/form/TimeCombobox` / `pages/v2/_shared/timeCombobox`).
   * `variant="input"` only: `variant="select"` has no separate inner input,
   * only the Select trigger itself, so this is a no-op there.
   */
  inputClassName?: string;
  /**
   * Keep-out margin for the open list, in px, passed straight to Radix. A
   * trigger sitting ON a page whose top is its own chrome - a schedule
   * toolbar, a day header - wants that chrome named as the boundary, so a
   * list that flips upward stops beneath it instead of painting over it.
   */
  collisionPadding?: CollisionPadding;
  /** Whether a clear affordance is offered for a set value. Default true. */
  clearable?: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The option the list opens ON: the field's own value when it has one,
 * otherwise the current time floored to the step grid (9:48 -> 9:45, 9:15 ->
 * 9:15). Opening a start-time list at midnight makes every user scroll past a
 * working day's worth of options they will never pick; the grid floor rather
 * than the ceiling keeps "right now" itself reachable without scrolling back
 * up.
 *
 * Floored, not snapped to the nearest option, so an off-grid saved value (say
 * 9:07, typed directly) still anchors on the 9:00 row rather than silently
 * drifting the highlight forward past it.
 */
export function anchorTimeValue(value: string, stepMinutes: number, now: Date = new Date()): string {
  if (value) return value;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const floored = Math.floor(minutes / stepMinutes) * stepMinutes;
  return `${pad2(Math.floor(floored / 60))}:${pad2(floored % 60)}`;
}

/** Position of `anchorTimeValue` in the UNFILTERED full-day grid, which is
 *  what `options` holds whenever the query is empty. An off-grid anchor
 *  floors onto the row below it rather than falling back to midnight. */
function anchorOptionIndex(value: string, stepMinutes: number): number {
  const [h, m] = anchorTimeValue(value, stepMinutes).split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.floor((h * 60 + m) / stepMinutes);
}

interface VariantProps {
  value: string;
  onChange: (v: string) => void;
  stepMinutes: number;
  disabled?: boolean;
  placeholder: string;
  id?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  className?: string;
  /** Input-variant only - see `TimeFieldProps.inputClassName`. Ignored by `TimeFieldSelect`. */
  inputClassName?: string;
  collisionPadding?: CollisionPadding;
  clearable: boolean;
}

/**
 * Typeable time field. Type "3p" / "3:00pm" / "15:00" directly, or pick from
 * the filtered dropdown. Off-grid typed times (e.g. "3:07 PM") are accepted,
 * not snapped to the nearest step. Parsing/formatting are delegated to
 * `@/lib/date-input`, the same module every prior time control used.
 */
function TimeFieldInput({
  value, onChange, stepMinutes, disabled, placeholder, id,
  ariaLabel, ariaInvalid, className, inputClassName, collisionPadding, clearable,
}: VariantProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatTimeForInput(value));
  // Decoupled from `text`: filters the list as the user TYPES, but starts
  // blank on focus even when `text` already holds a formatted value -
  // otherwise opening the list on an already-filled field filters it down to
  // that one exact match instead of showing the full set of nearby times to
  // pick from.
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Captured once per open so the render-time highlight reset below and the
  // list's scroll position agree on one row, and so neither re-reads the
  // clock mid-session (a list open across a step boundary must not renumber
  // itself under the user).
  const anchorIndexRef = useRef(0);

  function openList() {
    anchorIndexRef.current = anchorOptionIndex(value, stepMinutes);
    setQuery("");
    setHighlight(anchorIndexRef.current);
    setOpen(true);
  }

  // Scrolls the anchor row to the top of the list on open. Set as scrollTop
  // from the rows' own offsets rather than scrollIntoView, which would also
  // scroll every scrollable ancestor - including the dialog this list
  // usually opens inside.
  const scrollToAnchor = useCallback((node: HTMLDivElement | null) => {
    const first = node?.children[0] as HTMLElement | undefined;
    const row = node?.children[anchorIndexRef.current] as HTMLElement | undefined;
    if (node && first && row) node.scrollTop = row.offsetTop - first.offsetTop;
  }, []);

  // Adjusts `text` when `value` changes externally - computed during render
  // rather than in an effect, per https://react.dev/learn/you-might-not-need-an-effect.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(formatTimeForInput(value));
  }

  const options = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let m = 0; m < 24 * 60; m += stepMinutes) {
      const hh = Math.floor(m / 60);
      const mm = m % 60;
      if (timeOptionMatchesQuery(hh, mm, query)) {
        const v = `${pad2(hh)}:${pad2(mm)}`;
        opts.push({ value: v, label: formatTimeForInput(v) });
      }
    }
    const parsed = parseTimeInputText(query);
    if (parsed && !opts.some((o) => o.value === parsed)) {
      opts.unshift({ value: parsed, label: formatTimeForInput(parsed) });
    }
    return opts;
  }, [query, stepMinutes]);

  // Resets the highlighted row whenever the option list is recomputed (query
  // or stepMinutes changed). A typed query highlights its best match at the
  // top; clearing the query hands the list back to the open-time anchor
  // rather than dropping it to midnight.
  const [prevOptions, setPrevOptions] = useState(options);
  if (options !== prevOptions) {
    setPrevOptions(options);
    setHighlight(query ? 0 : anchorIndexRef.current);
  }

  function commit(raw: string) {
    if (!raw.trim()) {
      if (value) onChange("");
      setOpen(false);
      return;
    }
    const parsed = parseTimeInputText(raw);
    if (parsed) {
      onChange(parsed);
      setText(formatTimeForInput(parsed));
    } else {
      setText(formatTimeForInput(value));
    }
    setOpen(false);
  }

  function selectOption(v: string) {
    onChange(v);
    setText(formatTimeForInput(v));
    setOpen(false);
  }

  function clear() {
    onChange("");
    setText("");
    // Closes the list rather than leaving it open on the old anchor: without
    // this a stale `anchorIndexRef`/`highlight` from before the clear would
    // make the very next ArrowDown or Enter act on the row the field used to
    // hold. Reopening (focus, ArrowDown) always goes through `openList()`,
    // which recomputes both against the now-empty value.
    setQuery("");
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openList() : setOpen(false))}>
      <PopoverAnchor asChild>
        <div className={cn("flex items-stretch gap-1", className)}>
          <Input
            id={id}
            type="text"
            autoComplete="off"
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-invalid={ariaInvalid}
            className={cn("min-w-0 flex-1", inputClassName)}
            onChange={(e) => {
              setText(e.target.value);
              setQuery(e.target.value);
            }}
            onFocus={openList}
            onBlur={() => commit(text)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                // Re-opening a closed list lands on the anchor row; ArrowDown
                // only steps once the list is already showing it.
                if (!open) openList();
                else setHighlight((h) => Math.min(h + 1, options.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (open && options[highlight]) selectOption(options[highlight].value);
                else commit(text);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {clearable && value && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              aria-label="Clear time"
              // Keeps the field's blur-commit from firing before this click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={clear}
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
              aria-label="Open time list"
              className="h-auto w-9 shrink-0 self-stretch"
            >
              <Clock />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={scrollToAnchor}
        align="start"
        collisionPadding={collisionPadding ?? 10}
        className="max-h-[min(15rem,calc(50dvh-3rem))] w-[var(--radix-popover-trigger-width)] p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // This list is portaled to document.body, so when it opens inside a
        // modal the dialog's scroll lock (react-remove-scroll, listening on
        // `document`) sees the wheel event as coming from outside the locked
        // subtree and preventDefaults it, freezing the list. Stopping it here
        // keeps it off `document` entirely, which restores native wheel
        // scrolling without touching the page lock.
        onWheel={(e) => e.stopPropagation()}
      >
        {options.length === 0 && <p className="text-subtle-foreground px-2 py-1.5 text-sm">No matches</p>}
        {options.map((o, i) => (
          <Button
            key={o.value}
            type="button"
            variant="ghost"
            size={null}
            // Keeps the field's blur-commit from firing before this click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectOption(o.value)}
            onMouseEnter={() => setHighlight(i)}
            className={cn(
              "h-auto w-full justify-start px-2 py-1.5 text-sm font-normal",
              i === highlight && "bg-muted text-foreground",
              o.value === value && "text-brand font-semibold",
            )}
          >
            {o.label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Compact choose-only rendering: a fixed step-minute grid across the day with
 * `h:mm a` labels. An off-grid saved value (e.g. '09:07') is prepended so it
 * displays correctly and stays selected instead of showing blank.
 *
 * `inputClassName` is deliberately not read here - there is no separate inner
 * input to apply it to, only the Select trigger, which already takes sizing
 * through `className`.
 */
function TimeFieldSelect({
  value, onChange, stepMinutes, disabled, placeholder, id,
  ariaLabel, ariaInvalid, className, collisionPadding, clearable,
}: VariantProps) {
  const timeOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let m = 0; m < 24 * 60; m += stepMinutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      opts.push({
        value: `${hh}:${mm}`,
        label: format(new Date(2000, 0, 1, Math.floor(m / 60), m % 60), "h:mm a"),
      });
    }
    return opts;
  }, [stepMinutes]);

  const options =
    value && !timeOptions.some((o) => o.value === value)
      ? [{ value, label: format(new Date(`2000-01-01T${value}`), "h:mm a") }, ...timeOptions]
      : timeOptions;

  return (
    <Select value={value || "NONE"} onValueChange={(v) => onChange(v === "NONE" ? "" : v)} disabled={disabled}>
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        className={cn("w-[140px]", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent collisionPadding={collisionPadding}>
        {/* Kept in the list (rather than omitted) even when not clearable so the
         *  trigger always has a matching item to render placeholder text from;
         *  `disabled` is what actually withholds the "clear" affordance. */}
        <SelectItem value="NONE" disabled={!clearable}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Unified time field replacing `components/form/TimeCombobox`,
 * `pages/v2/_shared/timeCombobox`, `components/form/TimeSelect` and
 * `pages/v2/_shared/timeSelect`. Value contract unchanged across all four:
 * '' or 'HH:MM' (24-hour), in and out.
 *
 * Step 1 of the unified date/time migration (SRVW-247) - `DateField` is built
 * on top of this, so the public API here is the contract the rest of that
 * migration depends on.
 */
function TimeField({
  value,
  onChange,
  variant = "input",
  stepMinutes = 15,
  disabled,
  placeholder,
  id,
  className,
  inputClassName,
  collisionPadding,
  clearable = true,
  ...rest
}: TimeFieldProps) {
  const ariaLabel = rest["aria-label"];
  const ariaInvalid = rest["aria-invalid"];
  const resolvedPlaceholder = placeholder ?? (variant === "select" ? "Select time…" : "Time");

  const props: VariantProps = {
    value,
    onChange,
    stepMinutes,
    disabled,
    placeholder: resolvedPlaceholder,
    id,
    ariaLabel,
    ariaInvalid,
    className,
    inputClassName,
    collisionPadding,
    clearable,
  };

  return variant === "select" ? <TimeFieldSelect {...props} /> : <TimeFieldInput {...props} />;
}

export { TimeField };
