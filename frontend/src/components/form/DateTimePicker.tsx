import { X } from 'lucide-react';

import { DatePicker } from '@/components/form/DatePicker';
import { TimeCombobox } from '@/components/form/TimeCombobox';
import { localDateToIsoDay } from '@/lib/date-input';
import { cn } from '@/lib/utils';

interface DateTimePickerProps {
  /** '' or 'YYYY-MM-DDTHH:MM' (local) — same contract as <input type="datetime-local">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  disabled?: boolean;
  className?: string;
  /** Overrides both sub-fields' own geometry (height/padding/font) for compact call
   *  sites - see DatePicker's identical prop for why this can't just be `className`. */
  inputClassName?: string;
  /** Set false where the field is REQUIRED - a form that gates its submit on the date, or
   *  seeds it and never accepts empty - because there the X has no destination except an
   *  invalid form the user must re-fill, so the only thing it can do is undo work.
   *  Defaults true: on an optional date - a task's Due Date, an inventory stage's
   *  Scheduled For, both of which persist as null - emptying it is a real user intent that
   *  nothing else in the control can express (both sub-fields re-derive the other half
   *  rather than blanking the pair). Do not read the default as an endorsement of every
   *  call site that currently takes it. */
  clearable?: boolean;
}

/**
 * In-DOM date+time picker for use INSIDE modal Radix dialogs (#430).
 *
 * Native datetime-local popups render in the BROWSER's locale (often DD/MM/YYYY) and are
 * OS-level widgets that a modal Radix Dialog's dismissable-layer regime cannot close — the
 * picker gets orphaned on screen. Composes two typeable fields (DatePicker + TimeCombobox),
 * each a portaled Radix Popover that participates in the dialog's layer stack instead, so
 * outside-click / Escape dismiss deterministically while the dialog stays open. Time
 * choices are generated every `stepMinutes` (default 15 — #416), but typed off-grid times
 * are accepted too.
 *
 * The two sub-fields are sized by flex-BASIS, not by a grow ratio. A ratio splits the row
 * in proportions that have nothing to do with what each field must render: the old
 * flex-[3]/flex-[2] handed the date input 94px of content box for a 77px date and left the
 * time input 38px for a 57px "12:45 PM", so inside a max-w-sm dialog the meridiem was clipped
 * off ("9:00 A") - unreadable as AM or PM, which is the one thing that field exists to say.
 * Each basis below is the field's measured worst-case text plus its own padding, border,
 * gap and icon button; `grow` then splits whatever slack the container has left. The inputs
 * also drop to px-2.5 here (the standalone DatePicker/TimeCombobox keep their own padding),
 * which is what buys the composed row enough headroom to hold both fields uncut.
 */
export function DateTimePicker({
  value,
  onChange,
  stepMinutes = 15,
  disabled,
  className,
  inputClassName,
  clearable = true,
}: DateTimePickerProps) {
  const datePart = value ? value.slice(0, 10) : '';
  const timePart = value ? value.slice(11, 16) : '';

  function handleDateChange(d: string) {
    onChange(d ? `${d}T${timePart || '09:00'}` : '');
  }

  function handleTimeChange(t: string) {
    if (!t) {
      onChange('');
      return;
    }
    onChange(`${datePart || localDateToIsoDay(new Date())}T${t}`);
  }

  return (
    <div className={cn('flex flex-wrap items-stretch gap-2', className)}>
      <DatePicker
        value={datePart}
        onChange={handleDateChange}
        disabled={disabled}
        className="min-w-[8.75rem] grow basis-[8.75rem]"
        inputClassName={cn('px-2.5', inputClassName)}
      />
      {/* Time and Clear share one wrap group so a container too narrow for all three
          drops them together, rather than orphaning a lone X on its own row. The basis
          below is the GROUP's, not the time field's - the time field just grows into
          whatever the group has left after the X - so a `clearable={false}` group, which
          holds the time field alone, occupies exactly the same width as one that has the
          button in it. Suppressing the button changes what is in the row, never its
          geometry. */}
      <div className="flex min-w-[10rem] grow basis-[10rem] items-stretch gap-2">
        <TimeCombobox
          value={timePart}
          onChange={handleTimeChange}
          stepMinutes={stepMinutes}
          disabled={disabled}
          className="min-w-0 grow"
          inputClassName={cn('px-2.5', inputClassName)}
        />
        {clearable && value && (
          <button
            type="button"
            disabled={disabled}
            aria-label="Clear date and time"
            onClick={() => onChange('')}
            className="flex shrink-0 items-center justify-center self-stretch rounded-lg border border-border px-2 text-text-secondary hover:bg-primary-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
