import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';

import { cn } from '@/lib/utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * shadcn-style Calendar over react-day-picker v9, styled with the design
 * tokens (Deep Ocean primary, primary-subtle today ring).
 *
 * SIZE - phase 8g (program plan
 * md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md:973,
 * "Calendar, Separator, Checkbox, Switch, Badge -> size where demand
 * exists") checked this primitive for `size` demand and found none. The
 * program plan's measured-demand table 1b lists 14 sites / 10 files for
 * "Calendar" with size=13, colour=6, but that count is a measurement
 * artifact: it conflates this DayPicker-based primitive with the unrelated
 * lucide-react `Calendar` icon, which is imported and sized with `h-X w-X`
 * at roughly that many call sites across pages like JobDetailPage.tsx,
 * LeadDetailPage.tsx and InvoiceDetailPage.tsx. This component
 * (`components/ui/calendar.tsx`) has two real importers as of the
 * DatePicker/DateTimePicker date-format rework (2026-08-04) -
 * components/form/DatePicker.tsx (DateTimePicker composes it too, via
 * DatePicker) - and neither passes a `className` or size override. No rung
 * minted; `size` is not added.
 */
function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-1', className)}
      classNames={{
        months: 'relative flex flex-col gap-4',
        month: 'w-full space-y-3',
        month_caption: 'flex h-8 items-center justify-center',
        caption_label: 'text-sm font-medium text-text-primary',
        nav: 'absolute inset-x-0 top-0 flex h-8 w-full items-center justify-between',
        button_previous:
          'inline-flex size-8 items-center justify-center rounded-lg text-text-secondary hover:bg-primary-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-40',
        button_next:
          'inline-flex size-8 items-center justify-center rounded-lg text-text-secondary hover:bg-primary-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-40',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-8 text-[11px] font-medium text-text-secondary',
        week: 'mt-1 flex w-full',
        day: 'p-0 text-center text-sm',
        day_button:
          'inline-flex size-8 items-center justify-center rounded-lg hover:bg-primary-subtle aria-selected:hover:bg-primary',
        selected: 'rounded-lg bg-primary text-on-fill',
        today: 'rounded-lg bg-primary-subtle',
        outside: 'text-text-secondary opacity-50',
        disabled: 'text-text-secondary opacity-40',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClassName }) =>
          orientation === 'left' ? (
            <ChevronLeft className={cn('size-4', chevronClassName)} />
          ) : (
            <ChevronRight className={cn('size-4', chevronClassName)} />
          ),
      }}
      {...props}
    />
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
