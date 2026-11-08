import { useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { CalendarDays } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  formatDateForInput,
  parseDateInputText,
  isoDayToLocalDate,
  localDateToIsoDay,
  getDateInputPattern,
} from '@/lib/date-input';

interface DatePickerProps {
  /** '' or 'YYYY-MM-DD'. */
  value: string;
  onChange: (v: string) => void;
  /** 'YYYY-MM-DD' bounds - matches the native input min/max this replaces. */
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Outer layout - width/margin relative to siblings (e.g. 'mt-1', 'w-full'). */
  className?: string;
  /** Overrides the text field's own geometry (height/padding/font) for compact call
   *  sites - a plain `className` can't reach it, since it lands on the wrapper that
   *  positions the field next to its calendar-icon button, not the field itself. */
  inputClassName?: string;
  id?: string;
  'aria-label'?: string;
}

/**
 * Typeable date field replacing native <input type="date"> (which renders in the
 * BROWSER's locale - often DD/MM/YYYY - regardless of the org's own date format).
 * Type directly in the org's pattern (default US MM/DD/YYYY) or use the calendar.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder,
  disabled,
  className,
  inputClassName,
  id,
  ...rest
}: DatePickerProps) {
  const pattern = getDateInputPattern();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatDateForInput(value, pattern));
  // Adjusts `text` when `value` changes externally (e.g. a form reset) - computed
  // during render rather than in an effect, per https://react.dev/learn/you-might-not-need-an-effect.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(formatDateForInput(value, pattern));
  }

  function commit() {
    if (!text.trim()) {
      if (value) onChange('');
      return;
    }
    const parsed = parseDateInputText(text, pattern);
    if (parsed) {
      onChange(parsed);
      setText(formatDateForInput(parsed, pattern));
    } else {
      setText(formatDateForInput(value, pattern));
    }
  }

  function handleDaySelect(day: Date | undefined) {
    if (!day) return;
    const iso = localDateToIsoDay(day);
    onChange(iso);
    setText(formatDateForInput(iso, pattern));
    setOpen(false);
  }

  const minDate = min ? isoDayToLocalDate(min) : undefined;
  const maxDate = max ? isoDayToLocalDate(max) : undefined;
  const disabledMatchers = [minDate && { before: minDate }, maxDate && { after: maxDate }].filter(
    (m): m is { before: Date } | { after: Date } => Boolean(m),
  );

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) commit(); setOpen(next); }}>
      <PopoverPrimitive.Anchor asChild>
        <div className={cn('flex items-stretch gap-1', className)}>
          <Input
            id={id}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            placeholder={placeholder ?? pattern}
            disabled={disabled}
            aria-label={rest['aria-label']}
            className={cn('min-w-0 flex-1', inputClassName)}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
          />
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Open calendar"
              className="flex shrink-0 items-center justify-center self-stretch rounded-lg border border-border px-2.5 text-text-secondary hover:bg-primary-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
            >
              <CalendarDays className="size-4" />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverContent align="start" className="w-auto p-3">
        <Calendar
          mode="single"
          selected={isoDayToLocalDate(value)}
          defaultMonth={isoDayToLocalDate(value)}
          onSelect={handleDaySelect}
          disabled={disabledMatchers.length ? disabledMatchers : undefined}
        />
        <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <button
            type="button"
            onClick={() => handleDaySelect(new Date())}
            className="rounded-lg px-2 py-1.5 text-sm text-text-secondary hover:bg-primary-subtle hover:text-text-primary"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => {
              onChange('');
              setText('');
              setOpen(false);
            }}
            className="rounded-lg px-2 py-1.5 text-sm text-text-secondary hover:bg-primary-subtle hover:text-text-primary"
          >
            Clear
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
