"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { Badge, type BadgeProps } from "@/ui-kit/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui-kit/components/ui/select";

export interface StatusOption<T extends string = string> {
  value: T;
  label: string;
  tone: NonNullable<BadgeProps["variant"]>;
}

export interface StatusSelectProps<T extends string = string> {
  options: readonly StatusOption<T>[];
  value?: T;
  onValueChange?: (value: T) => void;
  placeholder?: string;
  size?: "sm" | "default";
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
}

/**
 * The dot that carries a status's tone in the list.
 *
 * Written out one class per tone rather than composed from the tone name,
 * because Tailwind scans source TEXT: a class assembled at runtime never
 * appears in the source, no rule is generated, and the dot renders invisible.
 */
const DOT: Record<NonNullable<BadgeProps["variant"]>, string> = {
  green: "bg-status-green",
  amber: "bg-status-amber",
  red: "bg-status-red",
  blue: "bg-status-blue",
  slate: "bg-status-slate",
  purple: "bg-status-purple",
  teal: "bg-status-teal",
  indigo: "bg-status-indigo",
  softGreen: "bg-status-green",
  softAmber: "bg-status-amber",
  softRed: "bg-status-red",
  softBlue: "bg-status-blue",
  softNeutral: "bg-subtle-foreground",
  softPurple: "bg-status-purple",
  outline: "bg-subtle-foreground",
};

/**
 * Status picker: a dot and a label per option, a check on the current one.
 *
 * THIS USED TO RENDER THE BADGE ITSELF in every row, on the reasoning that a
 * chip in the control and a chip in the table speak one visual language and
 * spare the reader a legend. That argument holds for the TRIGGER, where one
 * chip sits alone, and breaks down in the LIST: six saturated solid pills
 * stacked in a panel are six things shouting at once, none of them the one you
 * have selected, and a chip earns its colour by being the only one in view.
 * The lead detail page shipped that version and it was the first thing called
 * out in review.
 *
 * So the trigger keeps the chip - one status, in the language the table uses -
 * and the list drops to a dot plus a label, which carries the same tone at a
 * weight that lets six sit together. The CURRENT value is marked by a check,
 * which is what a picker is supposed to do and what a list of chips never did.
 *
 * `pages/v2/_shared/statusMenu.tsx` is the same design on a DropdownMenu, for
 * detail-page headers where the control is an action rather than a form field.
 * Keep the two looking alike.
 *
 * Reserve the solid treatment for status, the field that defines a record.
 * Priority, category and similar qualifiers should use the soft Badge variants
 * so half a dozen pickers on one form don't shout over each other.
 */
function StatusSelect<T extends string = string>({
  options, value, onValueChange,
  placeholder = "Select status",
  size = "default", disabled, invalid, id, className,
}: StatusSelectProps<T>) {
  const selected = options.find((option) => option.value === value);

  return (
    <Select value={value} onValueChange={(next) => onValueChange?.(next as T)} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        aria-invalid={invalid}
        // Tighter left padding: the badge carries its own inset, so the usual
        // 12px would leave the chip floating away from the edge.
        className={cn("ps-2", className)}
      >
        <SelectValue placeholder={placeholder}>
          {selected && <Badge variant={selected.tone}>{selected.label}</Badge>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          // `textValue` keeps type-ahead working - Radix matches on it rather
          // than on the rendered children.
          <SelectItem key={option.value} value={option.value} textValue={option.label} className="gap-2.5">
            <span className={cn("size-2 shrink-0 rounded-full", DOT[option.tone])} aria-hidden />
            <span className={cn("flex-1", option.value === value && "font-semibold")}>
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Job statuses for this CRM. Tones map straight to Badge variants. */
export const JOB_STATUSES = [
  { value: "unscheduled", label: "Unscheduled", tone: "purple" },
  { value: "scheduled", label: "Scheduled", tone: "blue" },
  { value: "in_progress", label: "In progress", tone: "amber" },
  { value: "completed", label: "Completed", tone: "green" },
  { value: "overdue", label: "Overdue", tone: "red" },
  { value: "cancelled", label: "Cancelled", tone: "slate" },
] as const satisfies readonly StatusOption[];

export type JobStatus = (typeof JOB_STATUSES)[number]["value"];

export { StatusSelect };
