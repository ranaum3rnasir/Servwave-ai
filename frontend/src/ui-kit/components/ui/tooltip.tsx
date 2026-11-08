"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Mount once near the app root. skipDelayDuration lets a second tooltip open
 * instantly while the user is sweeping across a toolbar - without it, every
 * icon re-pays the full delay and the row feels sluggish.
 */
function TooltipProvider({
  delayDuration = 320,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // collisionPadding keeps a long label from bleeding off a narrow
        // viewport; Radix shifts the box and the arrow tracks the trigger.
        collisionPadding={10}
        avoidCollisions
        className={cn(
          "bg-foreground text-kit-background z-floating w-fit max-w-60 rounded-md px-2.5 py-1.5",
          "text-xs font-medium text-balance shadow-popover",
          "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-foreground z-50 size-2 translate-y-[calc(-50%_-_1px)] rotate-45 rounded-[2px] fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
