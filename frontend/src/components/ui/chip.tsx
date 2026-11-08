import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* =============================================================================
   Chip - phase 9. The small bordered pill.

   Evidence (program plan section 1e, the hand-rolled-surfaces table): 20
   sites hand-roll the exact signature
   `bg-surface-light border border-border px-2.5 py-1.5 rounded-md`, listed
   there as "small bordered pills -> Chip". Two of the real sites behind that
   count are genuine standalone pill controls rather than an input skin -
   components/inventory/AddGroupDialog.tsx:470 and
   components/communication/phone/Dialer.tsx:727 - both
   `inline-flex items-center gap-1 rounded-md border border-border
   bg-surface-light px-2.5 py-1.5 ...`, which is exactly this primitive's base
   string (`inline-flex items-center gap-1` included). This session does not
   convert any call site (worktree scope is components/ui/ only); Chip is
   minted so W3 has a validated target to convert onto.

   WHAT THIS FIRST PASS DOES NOT ADD, AND WHY.
   - No `variant` axis. Every one of the 20 sites is the same bordered/filled
     shape - there is no "solid chip" or "ghost chip" signature to point at.
     A structural axis with no measured demand is left out, the same call
     Box and Popover make for the axes they have no evidence for.
   - No `gap` / `pad` as independent props. The evidenced padding
     (px-2.5 py-1.5) is a single pair, not a spread of differing pairs the
     way Card's or Popover's padding demand is - so it is baked into `size`
     as one atomic geometry, the same way Button and Avatar treat their own
     `size` (height + padding + type move together, not three separate
     props). The internal `gap-1` between an optional leading icon and the
     label is likewise baked into the base string rather than exposed - both
     real multi-child sites above use exactly `gap-1`, and there is no
     second, different value on record to justify a prop.
   - No `link` structure. A static pill is never a navigational link; that
     value is reserved by the closed vocabulary but has no meaning here.

   `tone` REUSES ALREADY-ESTABLISHED TRIADS, NOT NEW ONES. Chip has no
   per-tone call-site evidence of its own (the 20 sites are one neutral
   signature), but a small labelled pill is the standard shape a status tag
   takes. For `danger`/`success`/`warning`/`ai`, the surface/border/text
   triad each resolves to (for example danger's bg-danger-surface,
   border-danger-border and text-danger-text) is the exact triad badge.tsx's
   `tone` axis already renders for the identical purpose - reusing them here
   is applying an existing grammar to a new shape, not inventing token
   values. `brand` is different: badge.tsx's own `brand` is a no-op (it is
   Badge's default, so it carries no colour classes at all), so brand's
   triad here instead reuses card.tsx's `CARD_TONE.brand` /
   avatar.tsx's `subtle` (`bg-primary-subtle`, `border-primary/20`,
   `text-primary`) - still an existing grammar, just not badge's, and it
   matches the token family the vocabulary standard assigns to `brand`
   (program plan section 2a.2: primary / primary-dark / primary-subtle).
   `neutral` (the default) resolves to nothing extra: the base string
   already carries `bg-surface-light` / `border-border` / `text-text-primary`,
   which is what keeps the propless render byte-identical to the 20-site
   evidence. `subtle`, `business` and `info` - from the closed 9-value
   vocabulary, program plan section 2a.2 rev 3, where `subtle` is the settled
   rename of rev 2's `muted` - are absent for the same reasons badge.tsx
   gives for its own tone axis: `subtle`/`business` have no surface/text/
   border triad in tokens.css, and `info` (which does have one) has no
   measured demand on this primitive either.

   `size` - SIX ABSOLUTE-PX RUNGS (3xs=24, 2xs=28, xs=32, sm=36, md=40,
   lg=44); ONLY THE RUNG THAT MATCHES CHIP'S MEASURED HEIGHT IS MINTED. The
   base string's py-1.5 (12px vertical padding) plus text-xs's 16px
   line-height - no root font-size override, no text-xs override in
   tailwind.config.js - measures 28px exactly, which is rung `2xs`, not
   `md`. `2xs` (the default, and the only rung minted) is a no-op variant -
   the base string already carries the evidenced geometry, same trick
   Popover's `md` uses for its own width/pad. `3xs`, `xs`, `sm`, `md` and
   `lg` are reserved by the closed vocabulary but not implemented: the 20
   sites are one signature, not a ladder, so there is no repeated call-site
   pair to point at for any other rung. This is the same treatment Popover
   gives its own unmeasured `xs` width rung - documented here, excluded from
   the emitted variants, not minted until a real site asks for one (program
   plan section 1e / W2 plan: "no demand, no prop").
   ============================================================================= */

const chipVariants = cva(
  "inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-xs font-medium text-text-primary",
  {
    variants: {
      /**
       * Semantic colour. `neutral` (the default) is a no-op - the base
       * string already renders it. The rest reuse badge.tsx's exact
       * surface/border/text triad; see the header note.
       */
      tone: {
        neutral: "",
        brand: "bg-primary-subtle border-primary/20 text-primary",
        danger: "bg-danger-surface border-danger-border text-danger-text",
        success: "bg-success-surface border-success-border text-success-text",
        warning: "bg-warning-surface border-warning-border text-warning-text",
        ai: "bg-ai-surface border-ai-border text-ai-text",
      },
      /**
       * Atomic padding + type rung, on the six-rung absolute-px ladder
       * (3xs=24, 2xs=28, xs=32, sm=36, md=40, lg=44). `2xs` (the default,
       * and the only rung minted) is a no-op - the base string's
       * py-1.5 + text-xs measures 28px, exactly the `2xs` rung, not `md`.
       * `3xs` / `xs` / `sm` / `md` / `lg` are reserved by the closed
       * vocabulary but not implemented, see the header note.
       */
      size: {
        "2xs": "",
      },
    },
    defaultVariants: {
      tone: "neutral",
      size: "2xs",
    },
  }
)

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {}

/**
 * `<Chip>` with no props renders exactly
 * `<span class="inline-flex items-center gap-1 rounded-md border
 * border-border bg-surface-light px-2.5 py-1.5 text-xs font-medium
 * text-text-primary">` - byte for byte the 20-site evidenced signature plus
 * the structural glue (`inline-flex items-center gap-1`) both real
 * multi-child sites in the header note already carry.
 */
const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(
  ({ className, tone, size, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(chipVariants({ tone, size }), className)}
      {...props}
    />
  )
)
Chip.displayName = "Chip"

export { Chip, chipVariants }
