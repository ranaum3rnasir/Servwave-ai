"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarDays, X } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import { Calendar } from "@/ui-kit/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui-kit/components/ui/popover";

export interface DatePickerProps {
  value?: Date;
  onValueChange?: (date: Date | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  clearable?: boolean;
  /** Blocks past dates - scheduling a job for last Tuesday is always a typo. */
  disablePast?: boolean;
  id?: string;
  className?: string;
}

function DatePicker({
  value, onValueChange,
  placeholder = "Pick a date",
  disabled, invalid, clearable = true, disablePast, id, className,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-invalid={invalid}
          className={cn("w-full justify-start gap-2 px-3 font-normal", !value && "text-subtle-foreground", className)}
        >
          <CalendarDays className="text-subtle-foreground size-4 shrink-0" />
          {/* Spelled-out month: 03/04 is ambiguous across locales, 4 Mar is not. */}
          <span className="truncate">{value ? format(value, "EEE, d MMM yyyy") : placeholder}</span>
          {clearable && value && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear date"
              onClick={(e) => { e.stopPropagation(); onValueChange?.(undefined); }}
              className="text-subtle-foreground hover:text-foreground ml-auto grid size-5 shrink-0 place-items-center rounded-[4px]"
            >
              <X className="size-3.5" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value}
          onSelect={(date) => { onValueChange?.(date); setOpen(false); }}
          disabled={disablePast ? { before: new Date() } : undefined}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

export interface DateRangePickerProps {
  value?: DateRange;
  onValueChange?: (range: DateRange | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

function DateRangePicker({
  value, onValueChange, placeholder = "Pick a range", disabled, id, className,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);

  const label = value?.from
    ? value.to
      ? `${format(value.from, "d MMM")} - ${format(value.to, "d MMM yyyy")}`
      : format(value.from, "d MMM yyyy")
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("w-full justify-start gap-2 px-3 font-normal", !value?.from && "text-subtle-foreground", className)}
        >
          <CalendarDays className="text-subtle-foreground size-4 shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        {/* Two months: picking a range that crosses a boundary in one view is
            the difference between one click and four. */}
        <Calendar
          mode="range"
          selected={value}
          defaultMonth={value?.from}
          onSelect={onValueChange}
          numberOfMonths={2}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

export { DatePicker, DateRangePicker };
