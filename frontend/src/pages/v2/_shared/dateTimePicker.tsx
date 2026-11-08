import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { CalendarClock } from 'lucide-react';

import { cn } from '@/ui-kit/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Calendar } from '@/ui-kit/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { ELLIPSIS } from './glyphs';

export interface DateTimePickerProps {
  /** '' or 'YYYY-MM-DDTHH:MM' (local) - same contract as <input type="datetime-local">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** For a call site whose caption is not a labelable `<label>` - the tasks
   *  drawer's `<dt>`, for one - so the field keeps the accessible name its
   *  native predecessor carried. */
  'aria-label'?: string;
}

/**
 * In-DOM date+time picker for use INSIDE a modal Radix dialog.
 *
 * This exists for a behavioural reason, not a stylistic one (issue #430): a
 * native `datetime-local` popup is an OS-level widget that a modal Radix
 * Dialog's dismissable-layer regime cannot close, so the picker gets orphaned
 * on screen. A portaled Radix Popover joins the dialog's layer stack instead,
 * so outside-click and Escape dismiss the picker while the dialog stays open.
 *
 * The kit's own `form/datePicker` is date-ONLY - it emits a `Date` and has no
 * time axis at all - so it cannot stand in here, and swapping the trigger for a
 * bare `Input type="datetime-local"` would reintroduce #430. Kit Popover +
 * Calendar + Select carry the same guarantee, so the fix survives the restyle.
 * Time choices are generated every `stepMinutes` (default 15, issue #416).
 *
 * SHARED, not tasks-local: the service-plans detail sheet asks for a date and a
 * time in one field too, and was still doing it with a bare native
 * `datetime-local`. That control is the browser's, not the kit's - its own
 * clear affordance and calendar glyph sit outside the field's padding, so it is
 * the one input on the page whose interior is not symmetrical, and its popup is
 * the OS widget this component exists to avoid. One picker, both call sites.
 */
export function DateTimePicker({
  value,
  onChange,
  stepMinutes = 15,
  placeholder = `Set due date${ELLIPSIS}`,
  disabled,
  id,
  className,
  ...rest
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);

  const datePart = value ? value.slice(0, 10) : '';
  const timePart = value ? value.slice(11, 16) : '';

  const timeOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let m = 0; m < 24 * 60; m += stepMinutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      opts.push({
        value: `${hh}:${mm}`,
        label: format(new Date(2000, 0, 1, Math.floor(m / 60), m % 60), 'h:mm a'),
      });
    }
    return opts;
  }, [stepMinutes]);

  function handleDaySelect(day: Date | undefined) {
    if (!day) return; // re-click on the selected day keeps the current value
    onChange(`${format(day, 'yyyy-MM-dd')}T${timePart || '09:00'}`);
    setOpen(false);
  }

  function handleTimeChange(t: string) {
    if (!t) return;
    onChange(`${datePart || format(new Date(), 'yyyy-MM-dd')}T${t}`);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={rest['aria-label']}
          className={cn('w-full justify-start gap-2 px-3 font-normal', !value && 'text-subtle-foreground', className)}
        >
          <CalendarClock className="shrink-0" />
          <span className="truncate">
            {value ? format(new Date(value), 'MMM d, yyyy h:mm a') : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={value ? new Date(value) : undefined}
          defaultMonth={value ? new Date(value) : undefined}
          onSelect={handleDaySelect}
        />
        <div className="flex items-center gap-2 border-t p-2">
          <SelectField
            value={timePart}
            onValueChange={handleTimeChange}
            aria-label="Time"
            className="flex-1"
            placeholder="Time"
            searchPlaceholder="Search times…"
            emptyMessage="No times match."
            options={timeOptions}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { onChange(''); setOpen(false); }}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
