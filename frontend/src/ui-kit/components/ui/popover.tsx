"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { RemoveScroll } from "react-remove-scroll";

import { cn } from "@/ui-kit/lib/utils";
import { touchSafeOpenAutoFocus } from "@/ui-kit/lib/autoFocus";

/**
 * Non-modal floating panel. Unlike Dialog and Sheet it does not trap focus or
 * lock scroll - reach for it when the surface is a helper (a filter set, a date
 * picker, a column toggle) rather than a decision that must be resolved.
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

/**
 * Decides ONCE, when the panel mounts, whether it needs its own scroll shard. Deciding on every render let a lock
 * that cleared mid-life (a select closing as this opened) swap the wrapper for the bare children, which remounts
 * everything inside and drops focus.
 */
function ScrollShard({ children }: { children: React.ReactNode }) {
  const [nested] = React.useState(
    () => typeof document !== "undefined" && document.body.hasAttribute("data-scroll-locked"),
  );
  return nested ? (
    <RemoveScroll removeScrollBar={false} allowPinchZoom>
      {children}
    </RemoveScroll>
  ) : (
    <>{children}</>
  );
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // A Dialog/Sheet locks page scroll by tracking only its own content node as a
  // react-remove-scroll "shard" (see @radix-ui/react-dialog's DialogContentModal).
  // This Portal renders straight to document.body, outside that shard, so when a
  // Popover opens on top of an open Dialog its wheel events get swallowed by the
  // lock before they ever reach this panel's own scroll container - dragging the
  // scrollbar thumb still works (that's a pointer gesture, not a wheel event),
  // only the wheel path is blocked. Wrapping our own content in a nested
  // RemoveScroll registers it as its own lock, which the shared listener always
  // treats as scrollable, restoring wheel-scroll here without touching the
  // Dialog's lock itself. Only done when a lock is actually active (checked via
  // react-remove-scroll-bar's own `body[data-scroll-locked]` marker) so a
  // standalone Popover - the common case - keeps today's "doesn't lock
  // background scroll" behavior untouched.
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn(
          "bg-kit-popover text-kit-popover-foreground z-floating w-72 rounded-lg border p-3.5 shadow-popover outline-none",
          // Never wider than the screen minus the two 10 px collision gutters (mobile slice 44).
          "max-w-[calc(100vw-1.25rem)]",
          // Cap to the space Radix measured, and scroll inside rather than
          // letting a long panel run off the bottom of the viewport.
          "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain",
          "origin-[var(--radix-popover-content-transform-origin)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
        // No text field takes focus on its own on touch (mobile slice 24, KB-08).
        onOpenAutoFocus={(event) => touchSafeOpenAutoFocus(event, props.onOpenAutoFocus)}
      >
        <ScrollShard>{children}</ScrollShard>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
