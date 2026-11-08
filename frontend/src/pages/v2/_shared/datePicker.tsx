import { useState } from 'react';
import { CalendarDays } from 'lucide-react';

import {
  formatDateForInput,
  parseDateInputText,
  isoDayToLocalDate,
  localDateToIsoDay,
  getDateInputPattern,
} from '@/lib/date-input';

import { Button } from '@/ui-kit/components/ui/button';
import { Calendar } from '@/ui-kit/components/ui/calendar';
import { Input } from '@/ui-kit/components/ui/input';
import {
  Popover, PopoverAnchor, PopoverContent, PopoverTrigger,
} from '@/ui-kit/components/ui/popover';
import { cn } from '@/ui-kit/lib/utils';

export interface DatePickerProps {
  /** '' or 'YYYY-MM-DD' - the same string contract as <input type="date">. */
  value: string;
  onChange: (v: string) => void;
  /** 'YYYY-MM-DD' bounds - matches the native input min/max this replaces. */
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Outer layout - width/margin relative to siblings (e.g. 'w-[180px]'). */
  className?: string;
  /** Overrides the text field's own geometry (height/padding) for compact call
   *  sites - a plain `className` can't reach it, since it lands on the wrapper
   *  that positions the field next to its calendar-icon button. */
  inputClassName?: string;
  id?: string;
  'aria-label'?: string;
}

/**
 * v2 port of `components/form/DatePicker`: a typeable date field replacing
 * native `<input type="date">`, whose clock and field ORDER come from the
 * BROWSER locale, so a non-US browser showed an ambiguous 04/08/2026 in a
 * product sold only to US contractors (see `__tests__/no-native-time-inputs`).
 * Type in the org's pattern (default US MM/DD/YYYY) or use the calendar.
 *
 * Value contract unchanged: '' or 'YYYY-MM-DD', in and out. All parsing and
 * formatting is delegated to `@/lib/date-input`, the same module the legacy
 * control uses - nothing about dates is re-derived here, and `isoDayToLocalDate`
 * is what keeps a date-only value off `new Date(string)`'s UTC shift.
 *
 * SHARED, not module-local: fourteen v2 files across ten modules had a native
 * date input. The kit's own `form/datePicker` cannot stand in for any of them -
 * it emits a `Date` and is not typeable, so every call site would need a
 * conversion at its boundary, which is exactly the per-site date arithmetic this
 * component exists to avoid.
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
  // during render rather than in an effect, per
  // https://react.dev/learn/you-might-not-need-an-effect.
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
      <PopoverAnchor asChild>
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
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={isoDayToLocalDate(value)}
          defaultMonth={isoDayToLocalDate(value)}
          onSelect={handleDaySelect}
          disabled={disabledMatchers.length ? disabledMatchers : undefined}
        />
        <div className="flex items-center justify-between border-t p-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => handleDaySelect(new Date())}>
            Today
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange('');
              setText('');
              setOpen(false);
            }}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
