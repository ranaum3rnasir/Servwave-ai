// The ONE scheduling field set. Every surface that schedules something - the board
// popover, the drop modal, the job dialog, the job form, the lead's walkthrough tab -
// renders THIS, so "when does it start, when does it end" reads the same everywhere:
// start date, start time, end date, end time. Four fields, no duration control - a
// duration is arithmetic the surfaces that store one do for themselves (see
// scheduleTimeValue.ts).
//
// Controlled and computation-free at the edges: it renders `value`, emits the next
// `value`, and never fetches or posts.
import { FormField } from '@/components/patterns/FormField';
import { DatePicker } from '@/components/form/DatePicker';
import { TimeCombobox } from '@/components/form/TimeCombobox';
import { cn } from '@/lib/utils';
import {
  isInvertedRange,
  withEndDate,
  withEndTime,
  withStartDate,
  withStartTime,
  type ScheduleTimeValue,
} from './scheduleTimeValue';

export interface ScheduleTimeFieldsProps {
  value: ScheduleTimeValue;
  onChange: (next: ScheduleTimeValue) => void;
  disabled?: boolean;
  /** Ring/highlight for the drop modal's auto-filled fields. */
  dateClassName?: string;
  startTimeClassName?: string;
  className?: string;
}

export function ScheduleTimeFields({
  value,
  onChange,
  disabled = false,
  dateClassName,
  startTimeClassName,
  className,
}: ScheduleTimeFieldsProps) {
  // Only ever shown for an end DATE before the start; an end TIME before the start on
  // the same day rolls the end date forward instead, which is visible in the field.
  const inverted = isInvertedRange(value);

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      <FormField label="Start date">
        <DatePicker
          value={value.date}
          onChange={(v) => onChange(withStartDate(value, v))}
          disabled={disabled}
          className={dateClassName}
        />
      </FormField>
      <FormField label="Start time">
        <TimeCombobox
          value={value.startTime}
          onChange={(v) => onChange(withStartTime(value, v))}
          disabled={disabled}
          className={startTimeClassName}
        />
      </FormField>
      <FormField label="End date" error={inverted ? 'Ends before it starts' : undefined}>
        <DatePicker
          value={value.endDate}
          onChange={(v) => onChange(withEndDate(value, v))}
          disabled={disabled}
        />
      </FormField>
      <FormField label="End time">
        <TimeCombobox
          value={value.endTime}
          onChange={(v) => onChange(withEndTime(value, v))}
          disabled={disabled}
        />
      </FormField>
    </div>
  );
}
