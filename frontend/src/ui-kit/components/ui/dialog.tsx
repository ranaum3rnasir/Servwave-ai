"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { useListClosesFirst } from "@/ui-kit/hooks/useListClosesFirst";
import { touchSafeOpenAutoFocus } from "@/ui-kit/lib/autoFocus";
import {
  OverlayPresentationContext,
  useOverlayPresentation,
  useSurroundingPresentation,
} from "@/ui-kit/hooks/useOverlayPresentation";
import type { OverlayIntent } from "@/ui-kit/lib/overlayPresentation";

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
        // Blurred on a desktop only (`pointer-fine:`, mobile slice 16): a
        // full-viewport blur is a per-frame GPU cost on a phone.
        "fixed inset-0 z-50 bg-scrim/50 pointer-fine:backdrop-blur-[3px]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The three presentations (mobile slice 26). The card is the dialog as it has always been; the
 * other two apply only to a dialog that states an `intent`, and only below md or on a short
 * landscape window (see `overlayPresentation`).
 *
 * Fullscreen and the bottom sheet use `!` on the box-model classes a caller may have passed for
 * the card (`max-w-xl`, a height cap): that width is the card's, and it must not shrink a
 * full-screen form.
 */
const DIALOG_CARD = [
  "bg-kit-card fixed left-1/2 z-50 w-[calc(100%-2.5rem)] max-w-[27.5rem]",
  // Centred in what the keyboard leaves (mobile slice 54); 50% and the full cap when none is open.
  "top-[calc((100%-var(--keyboard-inset,0px))/2)]",
  "-translate-x-1/2 -translate-y-1/2",
  // Height cap + scroll. A modal is centred on the viewport, so content past its height
  // spills off BOTH edges at once and is unreachable in either direction - no scrollbar, no
  // keyboard route, the panel just ends mid-form.
  //
  // TWO scrollers, deliberately, and only one of them ever runs:
  //  - the flex column hands all the surplus height to `DialogBody`
  //    (`min-h-0 flex-1 overflow-y-auto`), so a dialog composed the normal way scrolls its
  //    BODY and keeps the title and the buttons pinned where the reader left them;
  //  - `overflow-y-auto` here is the floor for the handful of call sites that pour content
  //    straight into the content element with no body slot. Those items will not shrink (a
  //    flex item's default min-height is its own min-content), so they overflow, and this
  //    catches them instead of letting them paint off-screen.
  // `dvh`, not `vh`: on a phone `vh` is the tallest the viewport ever gets, which is exactly
  // the state where browser chrome is covering the bottom of the panel.
  "flex max-h-[calc(100dvh-2.5rem-var(--keyboard-inset,0px))] flex-col overflow-y-auto overflow-x-hidden overscroll-contain",
  "rounded-xl border shadow-modal",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
].join(" ");

/** Edge to edge, the whole dynamic viewport. Header and footer stay put; only the body scrolls. */
const DIALOG_FULLSCREEN = [
  // Ends where the keyboard begins (mobile slice 54): 100dvh less the keyboard inset, so Save stays
  // above it on iOS, where the layout does not resize. Zero inset, the whole dynamic viewport.
  "bg-kit-card fixed inset-0 z-50 flex h-[calc(100dvh-var(--keyboard-inset,0px))] w-full flex-col",
  "!max-h-none !max-w-none overflow-hidden rounded-none border-0 shadow-none",
  // A notch held sideways (mobile slice 52); the top and bottom insets are the header's and footer's.
  "pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
].join(" ");

/** Anchored to the bottom edge, capped by the DYNAMIC viewport so browser chrome never covers it. */
const DIALOG_BOTTOM_SHEET = [
  "bg-kit-card fixed inset-x-0 bottom-[var(--keyboard-inset,0px)] z-50 flex w-full flex-col",
  "!max-w-none max-h-[min(85dvh,var(--visible-height,100dvh))] overflow-hidden rounded-t-xl border-t shadow-modal",
  "pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]",
  "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom",
  "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom",
].join(" ");

const DIALOG_PRESENTATION = {
  card: DIALOG_CARD,
  fullscreen: DIALOG_FULLSCREEN,
  "bottom-sheet": DIALOG_BOTTOM_SHEET,
} as const;

function DialogContent({
  className,
  children,
  showClose = true,
  intent,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showClose?: boolean;
  /**
   * What the dialog is for (mobile slice 26): "form" is full-screen below md, "choice" a bottom
   * sheet, "content" a full-screen reader. At md and up it is the centred card either way. Left
   * out, it is the card at every width, exactly as before.
   */
  intent?: OverlayIntent;
}) {
  // First backdrop click with a list open closes only the list - see the hook.
  const listClosesFirst = useListClosesFirst(props.onPointerDownOutside, props.ref);
  const presentation = useOverlayPresentation(intent);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-presentation={presentation}
        className={cn(
          DIALOG_PRESENTATION[presentation],
          "outline-none",
          className,
        )}
        {...props}
        // No text field takes focus on its own on touch (mobile slice 24, KB-08).
        onOpenAutoFocus={(event) => touchSafeOpenAutoFocus(event, props.onOpenAutoFocus)}
        {...listClosesFirst}
      >
        <OverlayPresentationContext.Provider value={presentation}>
          {children}
        </OverlayPresentationContext.Provider>
        {showClose && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "absolute top-3 right-3 grid size-8 place-items-center rounded-md",
              // 44 px on a coarse pointer, centred on the same point (mobile slice 25).
              "touch:top-1.5 touch:right-1.5 touch:size-11",
              // In a full-screen form it sits in the header, clear of the status bar's safe area
              // (slice 26); the touch: offset must be overridden too or it wins on phones.
              // Beside a notch held sideways it moves in with the content (slice 52).
              presentation === "fullscreen" &&
                "top-[calc(env(safe-area-inset-top)+0.375rem)] touch:top-[calc(env(safe-area-inset-top)+0.375rem)] right-[calc(env(safe-area-inset-right,0px)+0.75rem)] touch:right-[calc(env(safe-area-inset-right,0px)+0.375rem)]",
              "transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
              "disabled:pointer-events-none",
            )}
          >
            <X className="size-4" />
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
  const fullscreen = useSurroundingPresentation() === "fullscreen";

  return (
    <div
      data-slot="dialog-header"
      className={cn(
        // `touch:pr-16`: the close is 44 px on a coarse pointer, so the title makes room for it.
        "flex shrink-0 items-start gap-3.5 px-5.5 pt-5 pr-12 touch:pr-16",
        // Full-screen: a sticky bar the close sits in, clear of the status bar.
        fullscreen &&
          "min-h-[calc(env(safe-area-inset-top)+3.5rem)] items-center border-b pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3",
        className,
      )}
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
  const fullscreen = useSurroundingPresentation() === "fullscreen";
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5.5 pt-4",
        // A field scrolled into view keeps a margin from the sticky header and footer.
        "scroll-py-4",
        fullscreen && "pb-4",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  const fullscreen = useSurroundingPresentation() === "fullscreen";
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-wrap justify-end gap-2 px-5.5 pt-4.5 pb-5",
        // Above the home indicator; `max()` keeps today's 20 px where there is no inset.
        "pb-[max(1.25rem,var(--safe-bottom,0px))]",
        fullscreen && "border-t pt-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay,
  DialogContent, DialogHeader, DialogIcon, DialogTitle, DialogDescription,
  DialogBody, DialogFooter,
};
