"use client"

import * as React from "react"
import * as SeparatorPrimitive from "@radix-ui/react-separator"

import { cn } from "@/lib/utils"

/* =============================================================================
   Separator - phase 7. A rule, drawn either as a fill or as a border.

   THE SHIPPED DEFAULT DOES NOT MOVE. Before this change Separator emitted
   exactly two strings, one per orientation: a 1px-tall filled box, or a
   1px-wide one. Seven call sites depend on those two strings today. The solid
   branch below reproduces them character for character, and
   __tests__/separator.test.tsx asserts the literal strings for every
   orientation x decorative x tone combination, plus all seven live call sites
   verbatim. That block was written and run GREEN against the untouched
   component before any of the code below existed, so it is a real frozen
   baseline rather than a description of whatever the file happens to do now.
   If it ever fails, the change is wrong, not the assertion.

   WHY A SECOND DRAWING MODE AT ALL. The payment ledger's "Refunds" divider
   (InvoiceDetailPage, one rule either side of the label) is DASHED. A dash
   pattern is a property of a border, not of a background fill, so it is not
   expressible at all through the shipped path: no combination of props on a
   box whose colour comes from a background can produce it. Both sites are
   hand-rolled as bare divs today for exactly that reason. This is the one
   shape the primitive genuinely could not draw.

   THE TRAP, stated so the next reader does not re-introduce it. The solid
   horizontal rule gets its 1px of height from a height utility, because a
   background-filled box has no intrinsic size. A border drawn rule gets its
   1px from the border itself and has ZERO content height. Emitting both would
   stack them and render a 2px rule, one solid pixel plus one dashed pixel. So
   the dashed branch drops the height utility entirely, and on the vertical
   axis drops the width utility, while the solid branch never carries a border
   at all. The two branches share nothing but the shrink guard and the
   cross-axis span, and they are written out as four separate literal strings
   below rather than composed from shared fragments, so the mistake cannot be
   made by editing one fragment. Both halves are asserted.

   NAMING - a deviation from the task text, forced by the DOM.
   This axis was specified as a prop called `style`. That name is not available
   here: SeparatorPrimitive.Root's props already declare a `style` accepting a
   CSS property object, and an interface extending them cannot narrow it to a
   string union. tsc rejects it outright with TS2430, "Types of property
   'style' are incompatible". The only way to force the name is to Omit the
   real one, which would strip inline-style pass-through from a shipped Radix
   primitive permanently in order to spell one prop a particular way. The
   settled vocabulary already covers this case: its rule 1 assigns STRUCTURE
   to `variant`, and solid-versus-dashed is structure, it is how the rule is
   drawn. So the prop is `variant`. Consumers convert with variant="dashed".

   TONE applies on the dashed branch only. On the solid branch the colour
   arrives as a background fill, and there is no measured demand for a second
   fill colour; adding one would mean a second token family and a second pair
   of strings for zero call sites. A tone passed alongside variant="solid" is
   therefore inert by design, and the test block asserts the solid string is
   byte-identical with tone set and with tone omitted.

   MEASURED DEMAND - two sites, both InvoiceDetailPage, both the same rule
   either side of the ledger's "Refunds" label. Each is a bare div carrying
   flex-1 plus a top border, a dashed border style and the danger border
   token. flex-1 is layout and stays at the call site; the three appearance
   classes are what this branch retires. The tone value is transcribed from
   those sites, not invented.

   SIZE - phase 8g (program plan
   md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md:973,
   "Calendar, Separator, Checkbox, Switch, Badge -> size where demand
   exists") was checked for Separator and left unminted. Of Separator's 3
   real call sites (components/layout/Header.tsx:143,220,224 - the only
   `className` overrides on any `<Separator` in the tree), every one is the
   same `h-6` on a vertical rule flanking a header control, cutting its
   default cross-axis span (h-full) down to a fixed 24px between two icon
   buttons. That is a real, repeated value, but it is one value at one call
   site pattern, not a spread the way Input's or Avatar's size demand is -
   there is nothing to distinguish a second rung from. Left as a documented,
   weak signal rather than minted into a `size` prop on hope of a second
   value; convert to a rung the day a second, different override shows up.

   ARIA is unchanged. `decorative` still defaults to true, which is right for
   both new sites: the Refunds rule is a visual flourish either side of a text
   label that already carries the meaning, so it must stay out of the
   accessibility tree. Nothing here touches the role or the orientation
   attribute Radix derives from it.
   ========================================================================== */

export type SeparatorVariant = "solid" | "dashed"
export type SeparatorTone = "default" | "danger"

/**
 * The shipped strings, unchanged. Written as complete literals rather than
 * assembled from parts so that a diff against git history is a one-line read
 * and so that the frozen baseline has something to be identical TO.
 */
const SOLID_RULE = {
  horizontal: "shrink-0 bg-border h-[1px] w-full",
  vertical: "shrink-0 bg-border h-full w-[1px]",
} as const

/**
 * The border drawn strings. Note what is absent: no background fill, and no
 * 1px sizing utility on the axis the border already occupies. The cross-axis
 * span survives so that a bare dashed Separator with no call-site layout still
 * spans its container; it is inert at the two measured sites because their
 * flex basis wins over a width in a flex row.
 */
const DASHED_RULE = {
  horizontal: {
    default: "shrink-0 border-t border-dashed border-border w-full",
    danger: "shrink-0 border-t border-dashed border-danger-border w-full",
  },
  vertical: {
    default: "shrink-0 border-l border-dashed border-border h-full",
    danger: "shrink-0 border-l border-dashed border-danger-border h-full",
  },
} as const

export interface SeparatorProps
  extends React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> {
  /** How the rule is drawn. Solid is a background fill, and is the default. */
  variant?: SeparatorVariant
  /** Rule colour. Applies on variant="dashed" only; inert on solid. */
  tone?: SeparatorTone
}

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  SeparatorProps
>(
  (
    {
      className,
      orientation = "horizontal",
      decorative = true,
      variant = "solid",
      tone = "default",
      ...props
    },
    ref
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        variant === "dashed"
          ? DASHED_RULE[orientation][tone]
          : SOLID_RULE[orientation],
        className
      )}
      {...props}
    />
  )
)
Separator.displayName = SeparatorPrimitive.Root.displayName

export { Separator }
