import { useCallback, useMemo, useRef, useState } from 'react';
import { Clock } from 'lucide-react';

import { formatTimeForInput, parseTimeInputText, timeOptionMatchesQuery } from '@/lib/date-input';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import {
  Popover, PopoverAnchor, PopoverContent, PopoverTrigger,
} from '@/ui-kit/components/ui/popover';
import { cn } from '@/ui-kit/lib/utils';

export interface TimeComboboxProps {
  /** '' or 'HH:MM' (24-hour) - the same string contract as <input type="time">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Outer layout - width/margin relative to siblings (e.g. 'w-[140px]'). */
  className?: string;
  /** Overrides the text field's own geometry - see `datePicker`'s identical prop. */
  inputClassName?: string;
  id?: string;
  'aria-label'?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The option the list opens ON: the field's own value when it has one, otherwise
 * the current time floored to the step grid (9:48 -> 9:45). Opening a start-time
 * list at midnight makes every user scroll past a working day's worth of options
 * they will never pick. Floored rather than snapped to the nearest, so an
 * off-grid saved value (9:07, typed directly) anchors on the 9:00 row instead of
 * drifting the highlight past it.
 */
function anchorTimeValue(value: string, stepMinutes: number, now: Date = new Date()): string {
  if (value) return value;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const floored = Math.floor(minutes / stepMinutes) * stepMinutes;
  return `${pad2(Math.floor(floored / 60))}:${pad2(floored % 60)}`;
}

/** Position of `anchorTimeValue` in the UNFILTERED full-day grid, which is what
 *  `options` holds whenever the query is empty. */
function anchorOptionIndex(value: string, stepMinutes: number): number {
  const [h, m] = anchorTimeValue(value, stepMinutes).split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.floor((h * 60 + m) / stepMinutes);
}

/**
 * v2 port of `components/form/TimeCombobox`: a typeable time field replacing
 * native `<input type="time">`, whose clock follows the BROWSER locale and so
 * read 24-hour (21:00) outside the US in a product sold only to US contractors.
 * Type "3p" / "3:00pm" / "15:00", or pick from the filtered list. Off-grid typed
 * times are accepted, not snapped.
 *
 * Value contract unchanged: '' or 'HH:MM' (24-hour), in and out. Parsing and
 * formatting are delegated to `@/lib/date-input`, the same module the legacy
 * control uses.
 *
 * SHARED alongside `timeSelect`, not instead of it. `timeSelect` is a kit Select:
 * a fixed 15-minute grid, right where a dropdown is what the surface wants. This
 * one is a TEXT field, which is what the four converted call sites need - three of
 * them (the two schedule surfaces and the job form) sit beside a `datePicker`, so
 * both halves of one date-and-time row have to be typeable or neither is.
 */
export function TimeCombobox({
  value,
  onChange,
  stepMinutes = 15,
  placeholder = 'Time',
  disabled,
  className,
  inputClassName,
  id,
  ...rest
}: TimeComboboxProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatTimeForInput(value));
  // Decoupled from `text`: filters the list as the user TYPES, but starts blank
  // on focus even when `text` already holds a formatted value - otherwise opening
  // the list on a filled field filters it to that one exact match instead of
  // showing the nearby times to pick from.
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Captured once per open so the render-time highlight reset below and the
  // list's scroll position agree on one row, and so neither re-reads the clock
  // mid-session.
  const anchorIndexRef = useRef(0);

  function openList() {
    anchorIndexRef.current = anchorOptionIndex(value, stepMinutes);
    setQuery('');
    setHighlight(anchorIndexRef.current);
    setOpen(true);
  }

  // Scrolls the anchor row to the top on open. Set as scrollTop from the rows'
  // own offsets rather than scrollIntoView, which would also scroll every
  // scrollable ancestor - including the dialog this list usually opens inside.
  const scrollToAnchor = useCallback((node: HTMLDivElement | null) => {
    const first = node?.children[0] as HTMLElement | undefined;
    const row = node?.children[anchorIndexRef.current] as HTMLElement | undefined;
    if (node && first && row) node.scrollTop = row.offsetTop - first.offsetTop;
  }, []);

  // Adjusts `text` when `value` changes externally - computed during render
  // rather than in an effect, per
  // https://react.dev/learn/you-might-not-need-an-effect.
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

  // Resets the highlighted row whenever the option list is recomputed. A typed
  // query highlights its best match at the top; clearing the query hands the list
  // back to the open-time anchor rather than dropping it to midnight.
  const [prevOptions, setPrevOptions] = useState(options);
  if (options !== prevOptions) {
    setPrevOptions(options);
    setHighlight(query ? 0 : anchorIndexRef.current);
  }

  function commit(raw: string) {
    if (!raw.trim()) {
      if (value) onChange('');
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

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openList() : setOpen(false))}>
      <PopoverAnchor asChild>
        <div className={cn('flex items-stretch gap-1', className)}>
          <Input
            id={id}
            type="text"
            autoComplete="off"
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={rest['aria-label']}
            className={cn('min-w-0 flex-1', inputClassName)}
            onChange={(e) => {
              setText(e.target.value);
              setQuery(e.target.value);
            }}
            onFocus={openList}
            onBlur={() => commit(text)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                // Re-opening a closed list lands on the anchor row; ArrowDown
                // only steps once the list is already showing it.
                if (!open) openList();
                else setHighlight((h) => Math.min(h + 1, options.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (open && options[highlight]) selectOption(options[highlight].value);
                else commit(text);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
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
        // Matches the field it belongs to. The fixed 9.5rem list was narrower than
        // every call site's input, so the dropdown read as a detached menu rather than
        // the field opening.
        className="max-h-60 w-[var(--radix-popover-trigger-width)] p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // This list is portaled to document.body, so when it opens inside a modal
        // the dialog's scroll lock (react-remove-scroll, listening on `document`)
        // sees the wheel event as coming from outside the locked subtree and
        // preventDefaults it, freezing the list. Stopping it here keeps it off
        // `document` entirely, which restores native wheel scrolling without
        // touching the page lock.
        onWheel={(e) => e.stopPropagation()}
      >
        {options.length === 0 && (
          <p className="text-subtle-foreground px-2 py-1.5 text-[13px]">No matches</p>
        )}
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
            /**
             * Deliberately the calendar's own row language, so the two pickers read as one
             * family when they sit inches apart in the create popover: the day button's
             * 13px/medium type and `rounded-md`, its `bg-muted` hover, and its filled
             * `bg-brand` selected state. This list used to be 14px/normal, with the brand
             * carried by the label colour alone rather than a fill, which read as a control
             * borrowed from somewhere else.
             *
             * Keep utility-shaped words out of this prose: the unresolved-class guard scans
             * comments for Tailwind-shaped candidates and fails on any that the real config
             * cannot resolve.
             */
            className={cn(
              'h-auto w-full justify-start rounded-md px-2 py-1.5 text-[13px] font-medium',
              'transition-colors hover:bg-muted',
              i === highlight && 'bg-muted text-foreground',
              o.value === value && 'bg-brand text-brand-foreground font-bold hover:bg-brand',
            )}
          >
            {o.label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
