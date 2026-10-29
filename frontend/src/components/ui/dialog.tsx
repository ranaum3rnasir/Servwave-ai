import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { useListClosesFirst } from "@/ui-kit/hooks/useListClosesFirst"
import { touchSafeOpenAutoFocus } from "@/ui-kit/lib/autoFocus"
import {
  OverlayPresentationContext,
  useOverlayPresentation,
  useSurroundingPresentation,
} from "@/ui-kit/hooks/useOverlayPresentation"
import type { OverlayIntent } from "@/ui-kit/lib/overlayPresentation"

/**
 * The app's dialog primitive, painted with the v2 kit's modal surface.
 *
 * WHY THIS FILE AND NOT SIXTY OTHERS. The v2 pages compose the kit's own
 * `ui-kit/components/ui/dialog`, but they also mount around sixty dialogs that
 * predate it - every inventory Add/Edit form, the estimate action dialogs, the
 * invoice credit and refund dialogs, the job dialogs - and each of those
 * renders through THIS primitive. So a v2 page would open a modal in the new
 * design one click and a modal in the old one the next: a lighter scrim, a
 * different corner radius, a different shadow, a different title weight. That
 * is not sixty bugs, it is one, and it is here.
 *
 * The surface below is therefore the kit's, token for token - scrim, blur,
 * radius, elevation, close affordance, title and description type. What is NOT
 * touched is the box model: `width`, `pad` and `gap` still mean exactly what
 * they meant, still default to `max-w-lg` / `p-6` / `gap-4`, and every call
 * site keeps its own spacing. Repainting a shared surface is safe; re-laying it
 * out under sixty callers is not.
 *
 * The kit's dialog splits its padding across header/body/footer slots and pins
 * the first and last while the middle scrolls. This one cannot: its callers
 * pour arbitrary grid rows straight into the content element, so there is no
 * body slot to hand the surplus height to. It scrolls as a whole panel
 * instead - which is what `ui/modal.tsx` has always done, and it is the same
 * guarantee that matters: nothing ends up off-screen and unreachable.
 */
const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // The kit's scrim: lighter, and blurred rather than merely dark. 80%
      // black erases the page underneath, so a dialog read as a new screen you
      // had navigated to; at 50% with a 3px blur the record you were looking at
      // is still legible behind it and the dialog reads as sitting ON it.
      // The blur is desktop-only (`pointer-fine:`, mobile slice 16): over a
      // whole phone screen it is a per-frame GPU cost for a look a finger hides.
      "fixed inset-0 z-50 bg-scrim/50 pointer-fine:backdrop-blur-[3px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * Max width. Measured over 66 real `DialogContent` call sites (component-api
 * -guard's own findComponentTags/classNameTokens algorithm, phase 8):
 * xs=max-w-sm (15 sites), sm=max-w-md (21), md=max-w-lg (17, today's
 * unstyled default - unmoved), lg=max-w-2xl (6). `md` is the default so a
 * call site naming no width keeps rendering exactly what it renders today.
 *
 * Named `width`, not `size`. Program plan section 2a rule 3: `size` is
 * reserved for control height (the 24-44px ladder Button/Input/SelectTrigger
 * share) and never means anything else on a primitive. A max-width scale is
 * a different axis wearing the same word - the exact mistake `modal.tsx`'s
 * own pre-vocabulary `size` prop made; `Modal` now exposes `width` too,
 * keeping `size` live only as a deprecated alias (see `modal.tsx`'s header).
 */
export type DialogWidth = "xs" | "sm" | "md" | "lg"

const DIALOG_WIDTH: Record<DialogWidth, string> = {
  xs: "max-w-sm",
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
}

/**
 * 4px-grid step - the same numeric scale Stack's `gap` and Card's `pad` /
 * `padX` / `padY` already ship (program-plan section 2a.8; see stack.tsx's
 * header note for why it is a number and not a size word). `pad={6}` is
 * 24px, `gap={4}` is 16px - both of those are DialogContent's own unstyled
 * defaults today.
 */
export type DialogSpacingStep = 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12

const DIALOG_PAD: Record<DialogSpacingStep, string> = {
  0: "p-0",
  0.5: "p-0.5",
  1: "p-1",
  1.5: "p-1.5",
  2: "p-2",
  2.5: "p-2.5",
  3: "p-3",
  4: "p-4",
  5: "p-5",
  6: "p-6",
  8: "p-8",
  12: "p-12",
}

const DIALOG_GAP: Record<DialogSpacingStep, string> = {
  0: "gap-0",
  0.5: "gap-0.5",
  1: "gap-1",
  1.5: "gap-1.5",
  2: "gap-2",
  2.5: "gap-2.5",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
  12: "gap-12",
}

/**
 * Splits what a caller poured into a dialog into the three slots the phone presentations draw:
 * the header and the footer (pinned) and one body (the only scroller). Fragments are flattened, and
 * a lone `<form>` is kept as the column the body scrolls in, so a form that wraps its rows and its
 * footer still submits and still has a pinned footer.
 */
function slotChildren(children: React.ReactNode): {
  header: React.ReactNode[]
  body: React.ReactNode[]
  footer: React.ReactNode[]
} {
  const header: React.ReactNode[] = []
  const body: React.ReactNode[] = []
  const footer: React.ReactNode[] = []
  const visit = (nodes: React.ReactNode, prefix: string) => {
    for (const child of React.Children.toArray(nodes)) {
      if (!React.isValidElement(child)) {
        body.push(child)
        continue
      }
      const key = `${prefix}${String(child.key)}`
      if (child.type === React.Fragment) {
        visit((child.props as { children?: React.ReactNode }).children, `${key}/`)
      } else if (child.type === DialogHeader) {
        header.push(React.cloneElement(child, { key }))
      } else if (child.type === DialogFooter) {
        footer.push(React.cloneElement(child, { key }))
      } else {
        body.push(React.cloneElement(child, { key }))
      }
    }
  }
  visit(children, "")
  return { header, body, footer }
}

function SlottedChildren({ gap, children }: { gap: DialogSpacingStep; children: React.ReactNode }) {
  const { header, body, footer } = slotChildren(children)
  const only = body.length === 1 ? body[0] : null
  const form =
    React.isValidElement(only) && only.type === "form"
      ? (only as React.ReactElement<React.FormHTMLAttributes<HTMLFormElement>>)
      : null
  if (form) {
    // The form is the column: its own header and footer stay pinned inside it, the rest scrolls.
    const inner = slotChildren(form.props.children)
    return (
      <>
        {header}
        {React.cloneElement(
          form,
          { className: cn(form.props.className, "flex min-h-0 flex-1 flex-col") },
          inner.header,
          <DialogBodySlot key="body" gap={gap}>{inner.body}</DialogBodySlot>,
          inner.footer,
        )}
        {footer}
      </>
    )
  }
  return (
    <>
      {header}
      <DialogBodySlot gap={gap}>{body}</DialogBodySlot>
      {footer}
    </>
  )
}

/** The one scroller of a full-screen dialog or a sheet. Same rhythm as the card's grid. */
function DialogBodySlot({ gap, children }: { gap: DialogSpacingStep; children: React.ReactNode }) {
  if (React.Children.count(children) === 0) return null
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start scroll-py-4 overflow-y-auto overscroll-contain px-6 py-4",
        DIALOG_GAP[gap],
      )}
    >
      {children}
    </div>
  )
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Override the overlay scrim — e.g. a lighter overlay for stacked/nested dialogs. */
    overlayClassName?: string
    /** Max width. Defaults to `md` (max-w-lg), today's unstyled geometry - unmoved. */
    width?: DialogWidth
    /** Uniform padding, 4px-grid step. Defaults to 6 (24px), today's unstyled `p-6`. */
    pad?: DialogSpacingStep
    /** Gap between direct children, 4px-grid step. Defaults to 4 (16px), today's unstyled `gap-4`. */
    gap?: DialogSpacingStep
    /**
     * What the dialog is for (mobile slice 26): "form" and "content" fill the screen below md (and
     * on a short landscape window); "choice" is a bottom sheet. Left out, it is today's card at
     * every width. Every dialog in the app states one now (slices 53 and 65).
     */
    intent?: OverlayIntent
    /**
     * Who draws the body when the dialog is full-screen or a sheet (mobile slice 65).
     *   - "slotted" (default): the dialog does. A `DialogHeader` and a `DialogFooter` among the
     *     children are pinned at the top and the bottom; everything else, whatever shape the caller
     *     poured in, goes into ONE body that is the only scroller. A `<form>` that wraps the rows
     *     and the footer keeps working: it becomes the column the body scrolls in.
     *   - "own": the caller lays out its own header, body and footer (the picker dialogs with an
     *     inner list, `Modal`), and the dialog supplies only the frame and the close.
     * At md and up neither does anything: the children go straight into the card, as they always did.
     */
    layout?: "slotted" | "own"
  }
>(
  (
    { className, overlayClassName, width = "md", pad = 6, gap = 4, intent, layout = "slotted", children, ...props },
    ref
  ) => {
    // First backdrop click with a list open closes only the list - see the hook.
    const listClosesFirst = useListClosesFirst(props.onPointerDownOutside, ref)
    const presentation = useOverlayPresentation(intent)
    return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-presentation={presentation}
        className={presentation !== "card" ? cn(
          // Full-screen / bottom sheet (mobile slice 26): the same surface, edge to edge. The
          // caller's `className` is the CARD's width, so it goes first and the geometry wins.
          className,
          "fixed z-50 flex w-full flex-col overflow-hidden border bg-kit-card p-0 shadow-modal",
          "!max-w-none !translate-x-0 !translate-y-0 gap-0",
          presentation === "fullscreen"
            ? "inset-0 left-0 top-0 h-[calc(100dvh-var(--keyboard-inset,0px))] !max-h-none rounded-none border-0 pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
            : "inset-x-0 bottom-[var(--keyboard-inset,0px)] left-0 top-auto max-h-[min(85dvh,var(--visible-height,100dvh))] rounded-t-xl border-x-0 border-b-0 pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        ) : cn(
          // `width` / `gap` / `pad` are spliced in at the exact position each
          // class held in the pre-phase-8 base string rather than routed
          // through cva's variants (which always appends a variant's class
          // AFTER the base string - see button.tsx's ordering note). That
          // would change the byte order of every call site's rendered
          // string even at the all-default values, which is the one thing
          // this change may not do.
          // `w-[calc(100%-2.5rem)]`, not `w-full`: the kit's own gutter, so a
          // dialog on a phone is a card with the page showing down both sides
          // rather than a slab welded to the screen edges.
          "fixed left-[50%] top-[50%] z-50 grid w-[calc(100%-2.5rem)]",
          DIALOG_WIDTH[width],
          // grid-cols-[minmax(0,1fr)]: an `auto` grid track is floored by its items'
          // min-content contribution and never shrinks below it, so a single nowrap child
          // (`truncate`, a long unbroken string) sizes the track past the max width and
          // paints outside the panel. minmax(0,1fr) lets the track shrink to the container
          // instead. Visually a no-op for content that already fits.
          "grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%]",
          DIALOG_GAP[gap],
          // A dialog is centred on the viewport, so content past its height
          // spills off the top AND the bottom at once - unreachable in either
          // direction, with no scrollbar and no keyboard route. The price-book
          // "add new item" form and the invoice credit / refund forms all hit
          // that on a laptop, which is how a modal ends up looking like it was
          // cropped. `dvh` rather than `vh` because on a phone `vh` measures
          // the viewport at its TALLEST, i.e. exactly when the browser chrome
          // is not covering the bottom of the panel.
          // `overflow-x-hidden` is not decoration. Naming ONLY overflow-y
          // leaves the x axis computing to `auto` (CSS: a `visible` axis paired
          // with a non-visible one becomes `auto`), so any absolutely
          // positioned descendant that overhangs the panel - a visually-hidden
          // file input, a measuring node - now hands the dialog a horizontal
          // scrollbar it never had while both axes were visible. A modal that
          // scrolls sideways is always a bug, so the axis is closed here.
          "max-h-[calc(100dvh-2.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain",
          "border bg-kit-card",
          DIALOG_PAD[pad],
          "shadow-modal duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] rounded-xl",
          className
        )}
        {...props}
        // No text field takes focus on its own on touch (mobile slice 24, KB-08).
        onOpenAutoFocus={(event) => touchSafeOpenAutoFocus(event, props.onOpenAutoFocus)}
        {...listClosesFirst}
      >
        <OverlayPresentationContext.Provider value={presentation}>
          {presentation !== "card" && layout === "slotted" ? (
            <SlottedChildren gap={gap}>{children}</SlottedChildren>
          ) : (
            children
          )}
        </OverlayPresentationContext.Provider>
        {/* The kit's close affordance: a real 32px cell that tints on hover,
            rather than a bare glyph that fades from 70% to 100% opacity. The
            old one was a 16px hit target with no visible boundary - findable
            only because you already knew where it was. */}
        {/* 44 px on a coarse pointer, centred on the same point (mobile slice 25). In a full-screen
            form the button sits in the header, clear of the status bar's safe area (slice 26). */}
        <DialogPrimitive.Close
          aria-label="Close"
          className={cn(
            "absolute right-3 top-3 grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none touch:right-1.5 touch:top-1.5 touch:size-11",
            presentation === "fullscreen" &&
              "top-[calc(env(safe-area-inset-top)+0.375rem)] touch:top-[calc(env(safe-area-inset-top)+0.375rem)] right-[calc(env(safe-area-inset-right,0px)+0.75rem)] touch:right-[calc(env(safe-area-inset-right,0px)+0.375rem)]",
          )}
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
    )
  }
)
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  cardClassName,
  divider,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** Hairline under the header, separating it from the scrollable body. */
  divider?: boolean
  /**
   * Classes for the CARD only (md and up). A caller that sets its own padding for the card puts it
   * here, so it does not override the full-screen header's safe-area padding on a phone.
   */
  cardClassName?: string
}) => {
  const presentation = useSurroundingPresentation()
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        divider && "border-b border-border",
        // Pinned at the top of a full-screen dialog or a sheet (mobile slice 65): the title with
        // room for the 44 px close, and under the status bar when full-screen.
        presentation !== "card" && "shrink-0 justify-center border-b border-border px-6 pb-3 pr-16 text-left sm:text-left",
        presentation === "fullscreen" &&
          "min-h-[calc(env(safe-area-inset-top)+3.5rem)] pt-[calc(env(safe-area-inset-top)+0.75rem)]",
        presentation === "bottom-sheet" && "min-h-14 pt-4",
        presentation === "card" && cardClassName,
        className
      )}
      {...props}
    />
  )
}
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  cardClassName,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** Classes for the CARD only (md and up); see `DialogHeader`. */
  cardClassName?: string
}) => {
  const presentation = useSurroundingPresentation()
  return (
  <div
    data-slot="dialog-footer"
    className={cn(
      // The kit's footer: one wrapping row, gap not space-x. `flex-col-reverse`
      // stacked the buttons vertically on every phone and inverted their order
      // to compensate, so the same footer had two different reading orders
      // depending on window width. Wrapping keeps one order at every size, and
      // `gap` spaces a wrapped second row too, which `space-x-2` never did.
      "flex flex-wrap justify-end gap-2",
      // Pinned at the bottom of a full-screen dialog or a sheet, above the home indicator.
      presentation !== "card" && "shrink-0 border-t border-border px-6 pt-3 pb-[max(1rem,var(--safe-bottom,0px))]",
      presentation === "card" && cardClassName,
      className
    )}
    {...props}
  />
  )
}
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      // The kit's title metrics. `leading-none` is gone with the rest: at 18px
      // it clipped descenders and jammed the title against the description
      // under it, which is most of what made these headers read as older than
      // the page around them.
      "text-[16.5px] font-bold tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-[13px] leading-relaxed text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
