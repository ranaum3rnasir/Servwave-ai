"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Radix Select rather than a native <select>.
 *
 * The tradeoff is real: native gets platform pickers on mobile for free. But a
 * CRM needs status swatches, two-line options and grouped headers inside the
 * list, and native gives you none of that - options can only hold text.
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "default" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input bg-kit-card flex w-full items-center justify-between gap-2 rounded-md border px-3 shadow-xs",
        "text-sm whitespace-nowrap transition-[border-color,box-shadow] outline-none",
        "data-[size=default]:h-10 data-[size=sm]:h-8.5",
        "data-[placeholder]:text-subtle-foreground",
        "[&:hover:not(:focus)]:border-input-hover",
        "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/25",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle-foreground",
        "aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/25",
        "*:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        // The value Radix renders is the trigger's one direct <span>: let it
        // shrink and truncate, so a long value ends in an ellipsis before the
        // chevron instead of running under it on a narrow screen.
        "[&>span]:min-w-0 [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="text-subtle-foreground size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          "bg-kit-popover text-kit-popover-foreground relative z-floating min-w-[8rem] overflow-hidden rounded-lg border shadow-popover",
          // Cap to measured space and scroll inside - a 24-item list must never
          // run past the bottom of the viewport.
          "max-h-[var(--radix-select-content-available-height)] overscroll-contain",
          "origin-[var(--radix-select-content-transform-origin)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          // Popper sizes the list to its widest row; cap it to the width Radix
          // measures as available on screen so a long label wraps instead of
          // running past a phone's edge. `break-words` is not for item text
          // (SelectItem sets its own, stronger rule): it is for the rest of the
          // list - a group heading (SelectLabel) or a call site's own children -
          // so an unbroken word there breaks at the cap instead of overflowing.
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1 w-full min-w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-content-available-width)] break-words",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-2.5 rounded-md py-2 pr-8 pl-2.5",
        "text-[13px] font-medium outline-none select-none transition-colors",
        "focus:bg-muted data-[highlighted]:bg-muted",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        // An unbroken label (an email address) has a min-content width as wide
        // as itself, and a flex item never shrinks below that, so the item's
        // text span needs min-w-0 + `anywhere` (`break-word` does not lower
        // min-content) to wrap inside the capped list. It is styled from here,
        // as the item's direct <span>, because Radix drops a className passed
        // to ItemText. The indicator's span is absolutely placed, so it is
        // unaffected. The app's other SelectItem (components/ui/select.tsx)
        // points back here.
        "[&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2.5 grid size-4 place-items-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="text-brand size-3.5 stroke-[3]" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        "text-subtle-foreground px-2.5 pt-1.5 pb-1 text-[10.5px] font-bold tracking-[0.07em] uppercase",
        className,
      )}
      {...props}
    />
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border -mx-0.5 my-1.5 h-px", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUp className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDown className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select, SelectGroup, SelectValue, SelectTrigger, SelectContent,
  SelectItem, SelectLabel, SelectSeparator,
};
