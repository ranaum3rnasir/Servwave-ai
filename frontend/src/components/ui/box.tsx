import * as React from "react"

import { cn } from "@/lib/utils"
import { padClasses, type PadProps } from "@/design-system/spacing"

/* =============================================================================
   Box - phase 9. The generic spacing/layout wrapper.

   Corollary 4 (program plan section 1c) measured no layout primitives in the
   tree at all: padding around a block of content is authored as raw `p-*` /
   `px-*` / `py-*` at the call site, with no shared vocabulary and no way to
   retune it from one place. Box is that place - a plain `<div>` whose only
   job is to turn `pad` into a prop instead of a className.

   WHY THIS FILE HAS NO cva() BLOCK, UNLIKE MOST OF ITS NEIGHBOURS.
   Box's whole surface is the seven-prop padding API (`pad` / `padX` / `padY` /
   `padTop` / `padRight` / `padBottom` / `padLeft`) that design-system/spacing.ts
   already owns, precedence rule and all: side beats axis beats uniform, and the
   shorthand `p-N` is never emitted alongside an axis or side override, because
   tailwind-merge 3.6 does not treat a later `px-*` as overriding an earlier
   `p-*` (see spacing.ts's own header for the measured proof). A cva `variants`
   map cannot express that precedence - each key resolves independently, so a
   naive `cva` block would happily emit `p-6 px-3` together and reintroduce the
   exact bug spacing.ts exists to close. card.tsx hit this first and hand-rolled
   the fix before spacing.ts centralised it; tabs.tsx and data/table.tsx both
   already consume the shared module the same way Box does here. Matching that
   real, repeated precedent is "the established pattern" this session asks for
   more than a cva block would be.

   WHAT THIS PRIMITIVE DOES NOT DO, DELIBERATELY.
   - No `variant` / `tone` / `size` / `gap`. The evidence for this session's
     Box is padding only ("pad comes from the scale instead of p-* at call
     sites"); a primitive with no measured demand for an axis is left without
     it rather than minted speculatively.
   - No `gap`. `Stack` already owns flex-with-gap; a bare Box has no declared
     display mode, so a gap prop on it would be inert on every call site until
     something also asked for `display`. Nothing measured this session did.
   - No `as` / polymorphism. Every one of Box's siblings that considered this
     (Stack, Table) restricted themselves to their one real element for the
     same reason: nothing measured asked for another tag.
   ============================================================================= */

export interface BoxProps extends React.HTMLAttributes<HTMLDivElement>, PadProps {}

/**
 * `<Box>` with no props renders exactly `<div class="">` - the padding half
 * of padClasses' contract is "nothing set emits nothing", so wrapping
 * existing markup in a bare Box cannot move a pixel. Same anti-goal Stack,
 * Text and Card's own pad axis all state.
 */
const Box = React.forwardRef<HTMLDivElement, BoxProps>(
  ({ className, pad, padX, padY, padTop, padRight, padBottom, padLeft, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        padClasses({ pad, padX, padY, padTop, padRight, padBottom, padLeft }),
        className
      )}
      {...props}
    />
  )
)
Box.displayName = "Box"

export { Box }
