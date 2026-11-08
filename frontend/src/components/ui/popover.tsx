import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

/* =============================================================================
   PopoverContent - W2 primitive vocabulary: `width` (max-width) x `pad` (padding).

   Named `width`, not `size` - program plan section 2a rule 3: `size` always
   means control height (the absolute px ladder every sized primitive can
   share) and never means anything else. A max-width scale is `width`, per
   the per-primitive scope table's Popover row.

   Re-verified 25 real PopoverContent call sites across 23 files (program plan
   section 1b's PopoverContent row: 25 sites / 23 files / size 24 / colour 1;
   grep "PopoverContent" frontend/src, excluding this file, each site's
   className read by hand).

   WHY `md` / `4` EMIT NO CLASS FOR EITHER AXIS. The base string below keeps
   `w-72` and `p-4` exactly where they sat before this change. `width="md"`
   and `pad={4}` both resolve to an empty string in the variant tables, so
   the no-props render is byte-identical to what shipped before. A non-default
   value is appended AFTER the base string and wins through `cn`'s
   tailwind-merge pass (same `w-*` / `p-*` conflict group as `w-72` / `p-4`),
   not by sitting in the original position - only the DEFAULT render's exact
   byte order is a frozen contract here, not every combination's class order.

   WIDTH (today's hardcoded default is w-72 / 288px):
     w-64 x5  SettingsGearDropdown, TagInput, PaymentFeeBreakdown, NumbersView x2
     w-72 x3  explicit, matches today's default - CategoryManagerDropdown,
              CategorySelector, phone/shared
     w-80 x3  LinkedEntitySelect, AssignTeamPopover, NotificationBell
   The other 14 sites are not size-shaped and keep using a className width
   override indefinitely: 4 match trigger width
   (`w-[var(--radix-popover-trigger-width)]`), 5 are bespoke large filter/menu
   panels (each a singleton pixel width), 2 are `w-auto`, 3 are singletons
   below w-64 (w-56, w-52, w-36) with no repeated signature.

   `xs` IS DEFERRED, NOT IMPLEMENTED. The only candidates below `sm` are three
   different singleton widths (w-56, w-52, w-36) - no 3+ repeated signature -
   so no pixel value is picked yet. Same treatment button.tsx gives its
   zero-demand cells (see its header note on the `soft` structure and the
   success / warning / info tones): the rung is documented here, not minted,
   until a real call site asks for one.

   PAD, expressed as the numeric 4px-grid step (program plan section 2a.8 -
   `pad` is a number, not a size word, matching Dialog/Stack/Card; today's
   hardcoded default is p-4, i.e. step 4):
     pad={0} x12  p-0, the dominant signature - custom lists/menus with
                  their own inner spacing
     pad={1} x4   p-1
     pad={2} x5, plus the 2 p-3 sites (DateTimePicker, AssignTeamPopover)
                  rounded down to this rung - closer neighbour by both pixel
                  distance and usage pattern (both are compact single-field
                  pickers)
     pad={4} x2   p-4, explicit, matches today's default - PaymentFeeBreakdown
                  (implicit), CallsView (explicit)
   No demand above step 4 at all - deferred for the same reason `xs` is
   above, not implemented here.

   COLOUR: 1 site only (phone/shared.tsx, `ring-border`), not a repeated
   signature or a tone request. No `variant` / `tone` / `gap` demand found
   anywhere in the call sites, so none of those axes are added here.
   ============================================================================= */

/**
 * Popover width (max-width). `xs` is reserved by the closed vocabulary but
 * not implemented on this primitive - see the header note above.
 */
export type PopoverWidth = "sm" | "md" | "lg"

/**
 * 4px-grid step, not a size word - the same numeric scale Dialog's
 * `pad`/`gap`, Stack's `gap` and Card's `pad`/`padX`/`padY` already ship
 * (program plan section 2a.8; see stack.tsx's header note for why it is a
 * number and not a size word - the vocabulary's word scale is `size` alone).
 * Restricted to `0` / `1` / `2` / `4`, the four rungs the former word scale
 * (`none`/`xs`/`sm`/`md`) named - the values above `4` (`lg`/`xl` in the
 * word scale) are reserved by the vocabulary but not implemented on this
 * primitive, no demand above `md` in the real call sites - see the header
 * note above.
 */
export type PopoverPad = 0 | 1 | 2 | 4

const popoverContentVariants = cva(
  "z-floating w-72 rounded-card border border-border bg-surface-light p-4 text-text-primary shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin]",
  {
    variants: {
      // Width (max-width). `md` is empty on purpose - the base string above
      // already carries `w-72`, which is what keeps the no-props render
      // unchanged.
      width: {
        sm: "w-64",
        md: "",
        lg: "w-80",
      },
      // Padding, 4px-grid step. `4` is empty on purpose - the base string
      // above already carries `p-4`.
      pad: {
        0: "p-0",
        1: "p-1",
        2: "p-2",
        4: "",
      },
    },
    defaultVariants: {
      width: "md",
      pad: 4,
    },
  }
)

export interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  width?: PopoverWidth
  pad?: PopoverPad
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ className, align = "center", sideOffset = 4, width, pad, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(popoverContentVariants({ width, pad }), className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent, popoverContentVariants }
