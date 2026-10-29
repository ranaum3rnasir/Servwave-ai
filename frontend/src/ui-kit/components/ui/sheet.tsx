"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { useListClosesFirst } from "@/ui-kit/hooks/useListClosesFirst";
import { touchSafeOpenAutoFocus } from "@/ui-kit/lib/autoFocus";
import { useOverlayPresentation } from "@/ui-kit/hooks/useOverlayPresentation";
import type { OverlayIntent } from "@/ui-kit/lib/overlayPresentation";

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

/*
 * Safe areas (mobile slice 52). With `viewport-fit=cover` an edge-anchored sheet runs under the
 * status bar, the notch and the home indicator, so each edge it touches reserves the inset as a
 * transparent border: the sheet's own background paints under it, a child positioned from the edge
 * (the close button) starts below it, and it is zero wherever there is no inset. A footer
 * therefore sits above the home indicator without padding for it again.
 */
const INSET_TOP = "border-t-[length:env(safe-area-inset-top,0px)] border-t-transparent";
const INSET_LEFT = "border-l-[length:env(safe-area-inset-left,0px)] border-l-transparent";
const INSET_RIGHT = "border-r-[length:env(safe-area-inset-right,0px)] border-r-transparent";
// `--safe-bottom` is the home-indicator inset, zero while the keyboard covers it (mobile slice 54).
const INSET_BOTTOM = "border-b-[length:var(--safe-bottom,0px)] border-b-transparent";

const sheetVariants = cva(
  [
    "bg-kit-card fixed flex flex-col shadow-modal",
    "transition ease-[cubic-bezier(0.32,0.72,0,1)]",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
    "data-[state=open]:duration-[260ms] data-[state=closed]:duration-200",
  ],
  {
    variants: {
      // Which rung of the stacking scale the sheet sits on (tailwind.config.js `zIndex`). `surface` is
      // every page-level sheet; `floating` is for a sheet a user opens FROM a popover, which would
      // otherwise paint under the popover that spawned it (mobile slice 45 staging finding).
      layer: {
        surface: "z-50",
        floating: "z-floating",
      },
      side: {
        right: `inset-y-0 right-0 h-[calc(100dvh-var(--keyboard-inset,0px))] w-[min(26.25rem,100vw)] border-l ${INSET_TOP} ${INSET_RIGHT} ${INSET_BOTTOM} data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right`,
        left: `inset-y-0 left-0 h-[calc(100dvh-var(--keyboard-inset,0px))] w-[min(26.25rem,100vw)] border-r ${INSET_TOP} ${INSET_LEFT} ${INSET_BOTTOM} data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left`,
        top: `inset-x-0 top-0 h-auto max-h-[80dvh] border-b ${INSET_TOP} ${INSET_LEFT} ${INSET_RIGHT} data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top`,
        bottom: `inset-x-0 bottom-[var(--keyboard-inset,0px)] h-auto max-h-[min(80dvh,var(--visible-height,100dvh))] border-t ${INSET_LEFT} ${INSET_RIGHT} ${INSET_BOTTOM} data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom`,
      },
    },
    defaultVariants: { side: "right", layer: "surface" },
  },
);

function SheetContent({
  className,
  side,
  layer,
  children,
  showClose = true,
  intent,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & {
    showClose?: boolean;
    /**
     * What the sheet is for (mobile slice 26). A left or right sheet that states one becomes a
     * full-screen form or reader below md (and on a short landscape window), or a bottom sheet
     * for a "choice"; at md and up it stays the side sheet. Left out, nothing changes.
     */
    intent?: OverlayIntent;
  }) {
  // First backdrop click with a list open closes only the list - see the hook.
  const listClosesFirst = useListClosesFirst(props.onPointerDownOutside, props.ref);
  const presentation = useOverlayPresentation(intent);
  const sideSheet = side === "left" || side === "right" || side == null;
  const reshaped = sideSheet && intent != null && presentation !== "card";
  const shape = reshaped
    ? presentation === "fullscreen"
      ? `inset-0 h-[calc(100dvh-var(--keyboard-inset,0px))] w-full max-w-none border-0 ${INSET_TOP} ${INSET_LEFT} ${INSET_RIGHT} ${INSET_BOTTOM}`
      : `inset-x-0 top-auto bottom-[var(--keyboard-inset,0px)] h-auto w-full max-w-none max-h-[min(85dvh,var(--visible-height,100dvh))] rounded-t-xl border-0 border-t ${INSET_LEFT} ${INSET_RIGHT} ${INSET_BOTTOM} data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom`
    : null;
  return (
    <SheetPortal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className={cn(
          // Blurred on a desktop only (`pointer-fine:`, mobile slice 16): a
          // full-viewport blur is a per-frame GPU cost on a phone.
          "fixed inset-0 bg-scrim/50 pointer-fine:backdrop-blur-[3px]",
          layer === "floating" ? "z-floating" : "z-50",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        )}
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-presentation={sideSheet ? (presentation === "card" ? "side-sheet" : presentation) : side === "bottom" ? "bottom-sheet" : "top-sheet"}
        className={cn(sheetVariants({ side, layer }), shape, className)}
        {...props}
        // No text field takes focus on its own on touch (mobile slice 24, KB-08).
        onOpenAutoFocus={(event) => touchSafeOpenAutoFocus(event, props.onOpenAutoFocus)}
        {...listClosesFirst}
      >
        {children}
        {showClose && (
          <SheetPrimitive.Close
            aria-label="Close"
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "absolute top-3.5 right-4 grid size-8 place-items-center rounded-md transition-colors",
              // 44 px on a coarse pointer, centred on the same point (mobile slice 25).
              "touch:top-2 touch:right-2.5 touch:size-11",
              "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
            )}
          >
            <X className="size-4" />
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
      className={cn("flex shrink-0 flex-col gap-0.5 border-b px-4.5 py-4 pr-12 touch:pr-16", className)}
      {...props}
    />
  );
}

/** The only scrolling region - header and footer stay pinned. */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-body" className={cn("flex-1 overflow-y-auto overscroll-contain px-4.5 py-4", className)} {...props} />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "flex shrink-0 flex-wrap justify-end gap-2 border-t px-4.5 py-3.5",
        // Above the home indicator: the sheet reserves the bottom inset itself (INSET_BOTTOM).
        className,
      )}
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
