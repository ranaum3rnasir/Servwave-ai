import { useCallback, useMemo, useRef, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Clock } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatTimeForInput, parseTimeInputText, timeOptionMatchesQuery } from '@/lib/date-input';

interface TimeComboboxProps {
  /** '' or 'HH:MM' (24-hour) - same string contract as <input type="time">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Outer layout - width/margin relative to siblings. */
  className?: string;
  /** Overrides the text field's own geometry (height/padding/font) for compact call
   *  sites - see DatePicker's identical prop for why this can't just be `className`. */
  inputClassName?: string;
  id?: string;
  'aria-label'?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The option the list opens ON: the field's own value when it has one, otherwise the
 * current time floored to the step grid (9:48 -> 9:45, 9:15 -> 9:15). Opening a
 * start-time list at midnight makes every user scroll past a working day's worth of
 * options they will never pick; the grid floor rather than the ceiling keeps "right
 * now" itself reachable without scrolling back up.
 *
 * Floored, not snapped to the nearest option, so an off-grid saved value (say 9:07,
 * typed directly) still anchors on the 9:00 row rather than silently drifting the
 * highlight forward past it.
 */
export function anchorTimeValue(value: string, stepMinutes: number, now: Date = new Date()): string {
  if (value) return value;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const floored = Math.floor(minutes / stepMinutes) * stepMinutes;
  return `${pad2(Math.floor(floored / 60))}:${pad2(floored % 60)}`;
}

/** Position of `anchorTimeValue` in the UNFILTERED full-day grid, which is what
 *  `options` holds whenever the query is empty. An off-grid anchor floors onto the
 *  row below it rather than falling back to midnight. */
function anchorOptionIndex(value: string, stepMinutes: number): number {
  const [h, m] = anchorTimeValue(value, stepMinutes).split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.floor((h * 60 + m) / stepMinutes);
}

/**
 * Typeable time field replacing a 96-option native scroll list. Type "3p" / "3:00pm" /
 * "15:00" directly, or pick from the filtered dropdown. Off-grid typed times (e.g.
 * "3:07 PM") are accepted, not snapped to the nearest step.
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
  // Decoupled from `text`: filters the list as the user TYPES, but starts blank on
  // focus even when `text` already holds a formatted value - otherwise opening the
  // list on an already-filled field filters it down to that one exact match instead
  // of showing the full set of nearby times to pick from.
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Captured once per open so the render-time highlight reset below and the list's
  // scroll position agree on one row, and so neither re-reads the clock mid-session
  // (a list open across a step boundary must not renumber itself under the user).
  const anchorIndexRef = useRef(0);

  function openList() {
    anchorIndexRef.current = anchorOptionIndex(value, stepMinutes);
    setQuery('');
    setHighlight(anchorIndexRef.current);
    setOpen(true);
  }

  // Scrolls the anchor row to the top of the list on open. Set as scrollTop from the
  // rows' own offsets rather than scrollIntoView, which would also scroll every
  // scrollable ancestor - including the dialog this list usually opens inside.
  const scrollToAnchor = useCallback((node: HTMLDivElement | null) => {
    const first = node?.children[0] as HTMLElement | undefined;
    const row = node?.children[anchorIndexRef.current] as HTMLElement | undefined;
    if (node && first && row) node.scrollTop = row.offsetTop - first.offsetTop;
  }, []);

  // Adjusts `text` when `value` changes externally - computed during render rather
  // than in an effect, per https://react.dev/learn/you-might-not-need-an-effect.
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

  // Resets the highlighted row whenever the option list is recomputed (query or
  // stepMinutes changed) - same trigger as the old `[options.length, query]` effect,
  // expressed as a render-time adjustment instead. A typed query highlights its best
  // match at the top; clearing the query hands the list back to the open-time anchor
  // rather than dropping it to midnight.
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
    <Popover
      open={open}
      onOpenChange={(next) => (next ? openList() : setOpen(false))}
    >
      <PopoverPrimitive.Anchor asChild>
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
                // Re-opening a closed list lands on the anchor row; ArrowDown only
                // steps once the list is already showing it.
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
            <button
              type="button"
              disabled={disabled}
              aria-label="Open time list"
              className="flex shrink-0 items-center justify-center self-stretch rounded-lg border border-border px-2.5 text-text-secondary hover:bg-primary-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
            >
              <Clock className="size-4" />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverContent
        ref={scrollToAnchor}
        align="start"
        className="max-h-60 w-[9.5rem] overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // This list is portaled to document.body, so when it opens inside a modal the
        // dialog's scroll lock (react-remove-scroll, listening on `document`) sees the
        // wheel event as coming from outside the locked subtree and preventDefaults it,
        // freezing the list. Stopping the event here keeps it off `document` entirely,
        // which restores native wheel scrolling without touching the page lock itself.
        onWheel={(e) => e.stopPropagation()}
      >
        {options.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-text-secondary">No matches</p>
        )}
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectOption(o.value)}
            onMouseEnter={() => setHighlight(i)}
            className={cn(
              'block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-primary-subtle',
              i === highlight && 'bg-primary-subtle',
              o.value === value && 'font-semibold text-primary',
            )}
          >
            {o.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
