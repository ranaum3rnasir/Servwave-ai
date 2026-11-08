// The ONE v2 scheduling field set. Every v2 surface that schedules something - the board
// popover, the drop modal, the job form, the lead's walkthrough tab - renders THIS, so
// "when does it start, when does it end" reads the same everywhere: start date, start
// time, end date, end time. Four fields, no duration control; a duration is arithmetic
// the surfaces that STORE one do for themselves at their own seam.
//
// This is the v2 chrome for the same contract `components/schedule/ScheduleTimeFields`
// paints in the legacy token vocabulary. The two share their brain and not their body:
// all the field-moves-field behaviour lives in `scheduleTimeValue`, a pure wall-clock
// arithmetic module with no React and no design system in it, so the DST handling and
// the end-rolls-forward rule cannot drift between v1 and v2. Copying that module here
// is the thing to avoid; importing it is not a cross-module reach (it is app-wide logic,
// like `@/lib/filters`, and this file lives in `_shared`, not in a module folder).
//
// Controlled and computation-free at the edges: it renders `value`, emits the next
// `value`, and never fetches or posts.
import { useRef, type ReactNode } from 'react';
import { Label } from '@/ui-kit/components/ui/label';
import { cn } from '@/lib/utils';
import {
  allDayRange,
  isInvertedRange,
  lastDayOf,
  withDurationMinutes,
  withEndDate,
  withEndTime,
  withStartDate,
  withStartTime,
  type ScheduleTimeValue,
} from '@/components/schedule/scheduleTimeValue';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { DatePicker } from './datePicker';
import { TimeCombobox } from './timeCombobox';

export interface ScheduleTimeFieldsProps {
  value: ScheduleTimeValue;
  onChange: (next: ScheduleTimeValue) => void;
  disabled?: boolean;
  /** Ring/highlight for the drop modal's auto-filled fields. */
  dateClassName?: string;
  startTimeClassName?: string;
  className?: string;
  /** Prefix for the generated field ids, so two sets can co-exist on one page. */
  idPrefix?: string;
  /**
   * All-day mode: two DATE fields, no times. Both read INCLUSIVE ("Aug 17 to Aug 19" runs through
   * the end of the 19th) - `value` itself keeps the usual exclusive-midnight end underneath,
   * converted at this component's own edge via `allDayRange`/`lastDayOf`, so every other consumer
   * of `value` (the save mutation, isInvertedRange) never has to know all-day mode exists.
   */
  allDay?: boolean;
  /**
   * OPTIONAL, and the built-in "All day" checkbox only renders when a surface passes it.
   * Three kinds of caller, all served by the one prop pair:
   *  - passes both halves (the board editor, the drop modal): gets the checkbox here, and the
   *    inclusive/exclusive conversion of `value` comes with it;
   *  - passes `allDay` alone (the entry dialog, the visit dialog, AssignJobDialog): owns the
   *    checkbox it already renders, and does its own conversion through the same `allDayRange`;
   *  - passes neither: no all-day mode at all. Walkthroughs are exactly that today - `leads` has
   *    no all-day column, so the lead's walkthrough tab keeps its times until that migration lands.
   */
  onAllDayChange?: (next: boolean) => void;
  /**
   * Drops the four visible field labels, keeping them as accessible names only.
   *
   * OPT-IN, default off - every existing caller renders exactly what it rendered before.
   * For a surface that already says what the block is by other means: the scheduler's
   * creation popover puts these fields in a clock-icon gutter row, where "Start date" over
   * a date field is the third time the same thing has been said. The labels do not vanish
   * from the a11y tree - `Field` keeps rendering one, visually hidden, so the `htmlFor`
   * pairing and the screen-reader name are untouched.
   */
  hideLabels?: boolean;
}

/** Label + control + error text, the a11y contract the kit ships no primitive for. */
function Field({
  label, htmlFor, error, children, hideLabel = false,
}: {
  label: ReactNode;
  htmlFor: string;
  error?: string;
  children: ReactNode;
  hideLabel?: boolean;
}) {
  return (
    <div className={cn('flex flex-col', hideLabel ? 'gap-0' : 'gap-1.5')}>
      <Label htmlFor={htmlFor} className={hideLabel ? 'sr-only' : undefined}>{label}</Label>
      {children}
      {error && <p className="text-destructive text-[12px] font-medium">{error}</p>}
    </div>
  );
}

export function ScheduleTimeFields({
  value,
  onChange,
  disabled = false,
  dateClassName,
  startTimeClassName,
  className,
  idPrefix = 'schedule',
  allDay = false,
  onAllDayChange,
  hideLabels = false,
}: ScheduleTimeFieldsProps) {
  // Only ever shown for an end DATE before the start; an end TIME before the start on
  // the same day rolls the end date forward instead, which is visible in the field.
  const inverted = isInvertedRange(value);
  const ownsToggle = onAllDayChange !== undefined;

  // Remembers the timed value from just before the box was ticked, so unticking it in the
  // same session restores real times instead of the midnight-to-midnight span `allDayRange`
  // wrote. A ref, not state: nothing on screen reads it, so writing it must not re-render.
  const preToggle = useRef<ScheduleTimeValue | null>(null);
  const handleAllDayToggle = (next: boolean) => {
    onAllDayChange?.(next);
    if (next) {
      preToggle.current = value;
      if (value.date) onChange(allDayRange(value.date, lastDayOf(value)));
      return;
    }
    if (preToggle.current) {
      onChange(preToggle.current);
      preToggle.current = null;
    } else if (value.date) {
      // Nothing this session to restore to: the span underneath is the literal 00:00->00:00
      // an earlier save wrote, and piping that into the now-visible time fields would read as
      // a genuine midnight-to-midnight event. A business-hours window on the same day is the
      // honest default - same fallback the entry dialog's own toggle makes.
      onChange(withDurationMinutes({ ...value, startTime: '09:00' }, 60));
    }
  };

  const allDayCheckbox = ownsToggle && (
    <label
      htmlFor={`${idPrefix}-all-day`}
      className="flex w-fit cursor-pointer items-center gap-2 text-[13px] font-medium select-none"
    >
      <Checkbox
        id={`${idPrefix}-all-day`}
        checked={allDay}
        disabled={disabled}
        onCheckedChange={(next) => handleAllDayToggle(next === true)}
      />
      All day
    </label>
  );

  if (allDay) {
    // '' while the form is still empty - never a day derived from an end that was never set.
    const allDayLastDay = value.endDate ? lastDayOf(value) : '';
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {allDayCheckbox}
        <div className="grid grid-cols-2 gap-3">
          {/* An all-day job HAS no time of day, so the control for one is removed
              rather than disabled: a greyed-out "9:00 AM" still reads as a fact
              about the job, and it is not one. */}
          <Field hideLabel={hideLabels} label="Start date" htmlFor={`${idPrefix}-start-date`}>
            <DatePicker
              id={`${idPrefix}-start-date`}
              value={value.date}
              onChange={(v) => {
                if (!v) return;
                // Dragging the start past the end takes the end with it, rather than leaving a
                // backwards range the user has to notice and repair.
                const last = lastDayOf(value);
                onChange(allDayRange(v, last && last >= v ? last : v));
              }}
              disabled={disabled}
              className={dateClassName}
            />
          </Field>
          <Field
            hideLabel={hideLabels}
            label="End date"
            htmlFor={`${idPrefix}-end-date`}
            error={inverted ? 'Ends before it starts' : undefined}
          >
            <DatePicker
              id={`${idPrefix}-end-date`}
              value={allDayLastDay}
              onChange={(v) => { if (v) onChange(allDayRange(value.date || v, v)); }}
              disabled={disabled}
            />
          </Field>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {allDayCheckbox}

      <div className="grid grid-cols-2 gap-3">
        <Field hideLabel={hideLabels} label="Start date" htmlFor={`${idPrefix}-start-date`}>
          <DatePicker
            id={`${idPrefix}-start-date`}
            value={value.date}
            onChange={(v) => onChange(withStartDate(value, v))}
            disabled={disabled}
            className={dateClassName}
          />
        </Field>
        <Field hideLabel={hideLabels} label="Start time" htmlFor={`${idPrefix}-start-time`}>
          <TimeCombobox
            id={`${idPrefix}-start-time`}
            value={value.startTime}
            onChange={(v) => onChange(withStartTime(value, v))}
            disabled={disabled}
            className={startTimeClassName}
          />
        </Field>
        <Field
          hideLabel={hideLabels}
          label="End date"
          htmlFor={`${idPrefix}-end-date`}
          error={inverted ? 'Ends before it starts' : undefined}
        >
          <DatePicker
            id={`${idPrefix}-end-date`}
            value={value.endDate}
            onChange={(v) => onChange(withEndDate(value, v))}
            disabled={disabled}
          />
        </Field>
        <Field hideLabel={hideLabels} label="End time" htmlFor={`${idPrefix}-end-time`}>
          <TimeCombobox
            id={`${idPrefix}-end-time`}
            value={value.endTime}
            onChange={(v) => onChange(withEndTime(value, v))}
            disabled={disabled}
          />
        </Field>
      </div>
    </div>
  );
}
