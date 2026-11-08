import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { useListClosesFirst } from "@/ui-kit/hooks/useListClosesFirst"

const Sheet = SheetPrimitive.Root

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-scrim/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

export type SheetSide = "top" | "bottom" | "left" | "right"

/**
 * Max width, `left` / `right` sheets only - phase 8. Measured over 17 real
 * `SheetContent` call sites (component-api-guard's own findComponentTags/
 * classNameTokens algorithm, program plan section 1c): `md` is today's
 * unstyled `sm:max-w-sm` default, unmoved. `lg` is `sm:max-w-md`, an
 * exact-signature repeat at 8 sites (HistoryPanel.tsx:47, AiImagePanel.tsx:106,
 * EntityCallDrawer.tsx:47, EntitySmsDrawer.tsx:43, PerformanceView.tsx:213,
 * CallsView.tsx:1020, TrainingView.tsx:810, EstimateDetailPanel.tsx:9).
 * `top` / `bottom` sheets carry no width axis today, so `width` renders
 * nothing on them regardless of value - the one bottom-side call site
 * (NotificationBell.tsx:54) caps height instead, a different,
 * single-occurrence axis left as a className override.
 *
 * Named `width`, not `size`. Vocabulary rev 3 rule 3: `size` is reserved for
 * control height (the 24-44px ladder Button/Input/SelectTrigger share) and
 * never means anything else on a primitive. A max-width scale is a different
 * axis wearing the same word - the per-primitive scope table calls this out
 * by name for Sheet, the same rename already applied to Dialog (`DialogWidth`,
 * see dialog.tsx) and DropdownMenuContent (`DropdownMenuContentWidth`) in
 * this session. The old `size` prop is kept as a deprecated alias below
 * (`SheetContentProps.size`) - no real (non-story/non-test) call site
 * currently passes `size=` to `SheetContent`, but the vocabulary requires
 * every renamed prop to keep the old spelling working identically, not only
 * where a call site happens to exist today.
 */
export type SheetWidth = "md" | "lg"

/**
 * 4px-grid step - the same numeric scale Dialog's `pad`/`gap`, Stack's `gap`
 * and Card's `pad`/`padX`/`padY` already ship (program plan section 2a.8;
 * see stack.tsx's header note for why it is a number and not a size word).
 * Restricted to `0` and `6` - the same two rungs the former word scale
 * (`none`/`md`) named, not a new value: every real override on Sheet zeroes
 * padding fully, never a smaller-but-nonzero step (measured over the 17 real
 * SheetContent call sites). `6` is today's unstyled default (`p-6`).
 */
export type SheetPadStep = 0 | 6

/**
 * Same numeric scale as `SheetPadStep`, restricted to the two rungs Sheet's
 * `gap` has ever rendered: `0` and `4` (today's unstyled default, `gap-4`).
 */
export type SheetGapStep = 0 | 4

const SHEET_SIDE: Record<SheetSide, string> = {
  top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
  bottom:
    "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
  right:
    "inset-y-0 right-0 h-full w-3/4  border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
}

const SHEET_WIDTH: Record<SheetWidth, string> = {
  md: "sm:max-w-sm",
  lg: "sm:max-w-md",
}

const SHEET_PAD: Record<SheetPadStep, string> = {
  0: "p-0",
  6: "p-6",
}

const SHEET_GAP: Record<SheetGapStep, string> = {
  0: "gap-0",
  4: "gap-4",
}

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  side?: SheetSide
  /** Max width, `left` / `right` sheets only. Defaults to `md` (`sm:max-w-sm`), today's unstyled geometry - unmoved. */
  width?: SheetWidth
  /**
   * @deprecated Use `width` instead - same values, same pixels. Kept live so
   * any existing `size=` call site keeps rendering identically; ignored
   * when `width` is also passed. Retired in phase 12c along with the rest
   * of the deprecated names.
   */
  size?: SheetWidth
  /** Uniform padding, 4px-grid step. Defaults to 6 (24px, `p-6`), today's unstyled default - unmoved. */
  pad?: SheetPadStep
  /** Gap between direct children, 4px-grid step. Defaults to 4 (16px, `gap-4`), today's unstyled default - unmoved. */
  gap?: SheetGapStep
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(
  (
    { side = "right", width: widthProp, size, pad = 6, gap = 4, className, children, ...props },
    ref
  ) => {
    // `size` is the deprecated pre-rename spelling of `width` (same
    // SheetWidth values, same pixels) - `width` wins when a call site
    // somehow passes both, matching card.tsx's `pad`/`padding` alias
    // precedent. Resolved into a local `width` (rather than left as
    // `SHEET_WIDTH[widthProp ?? size ?? "md"]` inline) so the storybook-
    // completeness guard's `NAME[prop]` scan still finds a literal `width`
    // usage to attribute story coverage to.
    const width: SheetWidth = widthProp ?? size ?? "md"
    // First backdrop click with a list open closes only the list - see the hook.
    const listClosesFirst = useListClosesFirst(props.onPointerDownOutside, ref)
    return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        className={cn(
          // `gap` / `pad` / the `width` class are spliced in at the
          // exact position each class held in the pre-phase-8 base string
          // rather than routed through a cva `variants` object (which always
          // appends a variant's class AFTER the base string - see
          // dialog.tsx's own version of this note). That would change the
          // byte order of every call site's rendered string even at the
          // all-default values, which is the one thing this change may not
          // do. `width` only ever applies to `left` / `right` - `top` /
          // `bottom` sheets have no width axis today, so it renders nothing
          // there regardless of value.
          "fixed z-50",
          SHEET_GAP[gap],
          "bg-surface-light",
          SHEET_PAD[pad],
          "shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
          SHEET_SIDE[side],
          (side === "left" || side === "right") && SHEET_WIDTH[width],
          className
        )}
        {...props}
        {...listClosesFirst}
      >
        {children}
        <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-surface-light transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-background-light">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
    )
  }
)
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  divider,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** Hairline under the header, separating it from the scrollable body. */
  divider?: boolean
}) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      divider && "border-b border-border",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-text-primary", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-text-secondary", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
