import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* =============================================================================
   Textarea - phase 8a `size`.
   -----------------------------------------------------------------------------
   43 call sites across 33 files (grepped every `<Textarea` JSX usage outside
   components/ui, pages/prototype, pages/design-system and test files). Of
   those, 8 carried a real (non-no-op) size-shaped className override, split
   into two repeated signatures:

     LARGER (3 sites, workflow-composer message bodies):
       NotifyTeamForm.tsx:112, SendTextForm.tsx:77   -> min-h-28 (112px)
       SendEmailForm.tsx:149                          -> min-h-32 (128px)
     SMALLER (5 sites, compact inline-note/description fields):
       ActivityPanel.tsx:152                          -> text-sm only
       ScopeOfWorkCard.tsx:159,283                    -> min-h-[60px] text-sm
       AddLineDialog.tsx:622,826                      -> min-h-[64px] text-sm

   `size="md"` is today's default geometry (min-h-[80px], text-base/md:text-sm)
   and MUST NOT MOVE - every propless call site renders through it.

   `lg` covers the larger signature. Two of the three sites use min-h-28, one
   uses min-h-32 - min-h-28 is the majority repeated value, so that is what
   the rung renders; the one min-h-32 site is not, on its own, evidence for a
   fourth rung. Height only, no font-size override - none of the three sites
   touched text size.

   `sm` covers the smaller signature: 4 of the 5 sites pair a shorter height
   with a forced text-sm; the outlier (min-h-[60px], an arbitrary bracket
   value not on the standard scale) converges to the same standard min-h-16
   (64px) the other two sites already use. text-sm is unprefixed so it wins
   over the base string's unprefixed text-base, while the base's own
   md:text-sm (a different conflict group) survives untouched - net effect is
   text-sm at every breakpoint, the same construction Input's `xs` rung uses.

   No evidence for a `tone` prop (zero colour-shaped overrides on any
   Textarea call site) and no evidence for an `xs` rung (nothing below the
   `sm` signature above), so neither is added.

   For `size="md"` (the default) the variant class is an EMPTY string, so
   cva's own `cx` (clsx) call drops it entirely and the emitted class list is
   byte-identical to what this file rendered before this change - verified in
   __tests__/textarea.test.tsx.

   ---------------------------------------------------------------------------
   VOCAB_V3 SIX-RUNG LADDER vs THIS FILE - SETTLED 2026-07-30
   ---------------------------------------------------------------------------
   VOCAB_V3 rule 2 states the size ladder is absolute and unconditional
   (3xs=24 / 2xs=28 / xs=32 / sm=36 / md=40 / lg=44px) and that a primitive's
   default must be pinned to whichever named rung equals its current
   rendered height. VOCAB_V3's own Textarea row says its `size` instead
   "means a MIN-HEIGHT scale (base is min-h-[80px], not a fixed height) -
   do not give it a fixed-height rung like Button's".

   Those two statements cannot both be satisfied literally at once: the
   ladder's own maximum rung (lg = 44px) is smaller than Textarea's frozen
   default (min-h-[80px] - MUST NOT MOVE, all 43 existing call sites render
   through it today). Reusing the ladder's rung names with their canonical
   px values here forces one of two bad outcomes: either move the 80px
   default down onto a rung (breaks every existing call site the moment it
   renders, violating "must not move"), or ship a named `lg` rung that
   renders SMALLER (44px) than the unnamed default (80px) - a
   self-contradictory "larger" option.

   Owner call (Ran, 2026-07-30): keep the separate sub-scale permanently.
   Both alternatives break something real (43 call sites, or the ladder's
   own ordering); the sub-scale breaks nothing and the "do not give it a
   fixed-height rung like Button's" carve-out already licenses it. This
   file keeps its existing, evidence-based min-height values (sm=64px/
   min-h-16, default/md=80px/min-h-[80px], lg=112px/min-h-28) as Textarea's
   OWN min-height sub-scale, height only, via `min-h-*` not `h-*` - not the
   shared ladder's 36/40/44 numbers, which would mean something different
   on Textarea than on every other primitive.
   ============================================================================= */

const textareaVariants = cva(
  "flex min-h-[80px] w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base transition-colors duration-300 placeholder:text-text-soft hover:border-primary focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
  {
    variants: {
      size: {
        // Today's default geometry, already carried by the base string above.
        // Empty on purpose - see the header note on why this keeps `md`
        // byte-identical to the pre-8a render.
        md: "",
        // 64px rung. Height only - no call site pairing min-h-16/[60px]/[64px]
        // also forces a taller/shorter font beyond the text-sm below.
        sm: "min-h-16 text-sm",
        // 112px rung. Height only - neither min-h-28 site touched font size.
        lg: "min-h-28",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
)

export interface TextareaProps
  extends React.ComponentProps<"textarea">,
    VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, size, ...props }, ref) => {
    return (
      <textarea
        className={cn(textareaVariants({ size }), className)}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea, textareaVariants }
