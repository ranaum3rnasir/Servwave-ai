"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { useListClosesFirst } from "@/ui-kit/hooks/useListClosesFirst";

/**
 * Modal dialog.
 *
 * Radix owns the hard parts: focus moves in on open, Tab cycles inside, Escape
 * closes, focus returns to the trigger, the page behind is inert and scroll is
 * locked. Our useOverlay hook does the same for hand-rolled surfaces - but do
 * not use both here, they would fight over focus.
 */
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim/50 backdrop-blur-[3px]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  // First backdrop click with a list open closes only the list - see the hook.
  const listClosesFirst = useListClosesFirst(props.onPointerDownOutside, props.ref);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-kit-card fixed top-1/2 left-1/2 z-50 w-[calc(100%-2.5rem)] max-w-[27.5rem]",
          "-translate-x-1/2 -translate-y-1/2",
          // Height cap + scroll. A modal is centred on the viewport, so content
          // past its height spills off BOTH edges at once and is unreachable in
          // either direction - no scrollbar, no keyboard route, the panel just
          // ends mid-form. A create-form on a 13-inch laptop hits that at
          // ordinary sizes, not extreme ones.
          //
          // TWO scrollers, deliberately, and only one of them ever runs:
          //  - the flex column hands all the surplus height to `DialogBody`
          //    (`min-h-0 flex-1 overflow-y-auto` below), so a dialog composed
          //    the normal way scrolls its BODY and keeps the title and the
          //    buttons pinned where the reader left them;
          //  - `overflow-y-auto` here is the floor for the handful of call
          //    sites that pour content straight into the content element with
          //    no body slot. Those items will not shrink (a flex item's default
          //    min-height is its own min-content), so they overflow, and this
          //    catches them instead of letting them paint off-screen.
          // `dvh`, not `vh`: on a phone `vh` is the tallest the viewport ever
          // gets, which is exactly the state where browser chrome is covering
          // the bottom of the panel.
          "flex max-h-[calc(100dvh-2.5rem)] flex-col overflow-y-auto overflow-x-hidden overscroll-contain",
          "rounded-xl border shadow-modal outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
        {...listClosesFirst}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "absolute top-3 right-3 grid size-8 place-items-center rounded-md",
              "transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
              "disabled:pointer-events-none",
            )}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * Title block: an optional glyph tile on the left, everything else stacked
 * beside it.
 *
 * The header is a ROW because of the icon, and it used to be nothing but that
 * row - which made the wrapper element around the title and description
 * load-bearing at the CALL SITE. Twenty of the thirty-eight headers in the app
 * left it out and got a title sitting to the LEFT of its own description, as a
 * second column, instead of above it. A header that reads correctly only when
 * the caller remembers an undocumented `<div>` is the component's bug, not
 * theirs, so the split is done here: the icon takes the row, and every other
 * child goes into one stacked column whether or not the caller wrapped it.
 *
 * Call sites that DO pass a wrapper still render identically - a block element
 * inside the column lays out exactly as it did as the column.
 */
function DialogHeader({ className, children, ...props }: React.ComponentProps<"div">) {
  const items = React.Children.toArray(children);
  const icon = items.find(
    (child) => React.isValidElement(child) && child.type === DialogIcon,
  );
  const rest = icon ? items.filter((child) => child !== icon) : items;

  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 items-start gap-3.5 px-5.5 pt-5 pr-12", className)}
      {...props}
    >
      {icon}
      <div data-slot="dialog-heading" className="min-w-0 flex-1">
        {rest}
      </div>
    </div>
  );
}

/** Tinted glyph tile. Semantic, not decorative - it names the consequence. */
function DialogIcon({
  className,
  tone = "brand",
  ...props
}: React.ComponentProps<"span"> & { tone?: "brand" | "danger" | "warning" }) {
  const tones = {
    brand: "bg-brand-subtle text-brand",
    danger: "bg-status-red-subtle text-destructive",
    warning: "bg-status-amber-subtle text-status-amber",
  };
  return (
    <span
      data-slot="dialog-icon"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-[11px] [&_svg]:size-5",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-[16.5px] font-bold tracking-tight", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground mt-1.5 text-[13px] leading-relaxed", className)}
      {...props}
    />
  );
}

/**
 * The one part of a dialog that scrolls.
 *
 * `min-h-0` is the load-bearing half: a flex item's default min-height is its
 * own content, so without it the body refuses to shrink, the panel grows past
 * its cap, and `overflow-y-auto` here would never have anything to do. With it,
 * the body takes whatever height is left after the header and the footer and
 * scrolls the rest - which is why those two are `shrink-0` and stay put while
 * the fields move under them.
 *
 * `overscroll-contain` stops a flick that reaches the end of the list from
 * carrying on into the page behind the dialog.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5.5 pt-4", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex shrink-0 flex-wrap justify-end gap-2 px-5.5 pt-4.5 pb-5", className)}
      {...props}
    />
  );
}

export {
  Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay,
  DialogContent, DialogHeader, DialogIcon, DialogTitle, DialogDescription,
  DialogBody, DialogFooter,
};
