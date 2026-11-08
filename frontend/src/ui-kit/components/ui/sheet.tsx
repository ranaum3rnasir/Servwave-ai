"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { useListClosesFirst } from "@/ui-kit/hooks/useListClosesFirst";

/**
 * Edge-anchored panel. Built on Radix Dialog, so it inherits the same focus
 * and scroll guarantees - a drawer is a modal that happens to slide.
 *
 * Prefer this over a Dialog when the content is a record rather than a
 * decision: a job's details, a filter set, a form. Dialogs interrupt; sheets
 * sit beside the work.
 */
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const sheetVariants = cva(
  [
    "bg-kit-card fixed z-50 flex flex-col shadow-modal",
    "transition ease-[cubic-bezier(0.32,0.72,0,1)]",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
    "data-[state=open]:duration-[260ms] data-[state=closed]:duration-200",
  ],
  {
    variants: {
      side: {
        right:
          "inset-y-0 right-0 h-full w-[min(26.25rem,100vw)] border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        left:
          "inset-y-0 left-0 h-full w-[min(26.25rem,100vw)] border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        top:
          "inset-x-0 top-0 h-auto max-h-[80vh] border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
        bottom:
          "inset-x-0 bottom-0 h-auto max-h-[80vh] border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "right" },
  },
);

function SheetContent({
  className,
  side,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & { showClose?: boolean }) {
  // First backdrop click with a list open closes only the list - see the hook.
  const listClosesFirst = useListClosesFirst(props.onPointerDownOutside, props.ref);
  return (
    <SheetPortal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className={cn(
          "fixed inset-0 z-50 bg-scrim/50 backdrop-blur-[3px]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        )}
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...props}
        {...listClosesFirst}
      >
        {children}
        {showClose && (
          <SheetPrimitive.Close
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "absolute top-3.5 right-4 grid size-8 place-items-center rounded-md transition-colors",
              "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
            )}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-0.5 border-b px-4.5 py-4 pr-12", className)}
      {...props}
    />
  );
}

/** The only scrolling region - header and footer stay pinned. */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-body" className={cn("flex-1 overflow-y-auto px-4.5 py-4", className)} {...props} />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex shrink-0 flex-wrap justify-end gap-2 border-t px-4.5 py-3.5", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base font-bold tracking-tight", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-[12.5px]", className)}
      {...props}
    />
  );
}

export {
  Sheet, SheetTrigger, SheetClose, SheetPortal, SheetContent,
  SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription, sheetVariants,
};
