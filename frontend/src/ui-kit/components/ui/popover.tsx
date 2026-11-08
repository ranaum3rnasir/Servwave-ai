"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Non-modal floating panel. Unlike Dialog and Sheet it does not trap focus or
 * lock scroll - reach for it when the surface is a helper (a filter set, a date
 * picker, a column toggle) rather than a decision that must be resolved.
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn(
          "bg-kit-popover text-kit-popover-foreground z-floating w-72 rounded-lg border p-3.5 shadow-popover outline-none",
          // Cap to the space Radix measured, and scroll inside rather than
          // letting a long panel run off the bottom of the viewport.
          "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain",
          "origin-[var(--radix-popover-content-transform-origin)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
