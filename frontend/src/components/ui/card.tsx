import * as React from "react"

import { cn } from "@/lib/utils"
import type { StatusIntent } from "@/design-system/status-registry"

/**
 * What this card means, not which classes paint it. Background + border
 * only - unlike Badge's `intent`, a tinted callout card's own text keeps
 * its normal colours; only the surface reads as success/warning/etc.
 * Twelve public-facing callout cards (PublicEstimatePage, PublicInvoicePage)
 * hand-rolled these from raw Tailwind palette classes instead of the tokens
 * this map already resolves to.
 */
const CARD_TONE: Record<StatusIntent, string> = {
  success: "bg-success-surface border-success-border",
  warning: "bg-warning-surface border-warning-border",
  danger: "bg-danger-surface border-danger-border",
  info: "bg-info-surface border-info-border",
  neutral: "bg-neutral-surface border-neutral-border",
  brand: "bg-primary-subtle border-primary/20",
}

/**
 * Spacing scale - the 4px-grid STEP number, not a size word (program plan
 * section 2a.8). `pad={6}` is 24px, exactly what `padding="md"` already
 * renders. Numbers rather than words is what dissolves the collision with
 * the `padding` prop below: while both props are live, a designer typing
 * `pad="sm"` from muscle memory cannot silently get a different pixel value,
 * because `pad` does not accept words at all.
 *
 * Why this enum and not a shorter one. Measured 2026-07-28 with the phase-6
 * guard exports (targetFiles/findComponentTags/classNameTokens/stripComments)
 * over the 408 in-scope files: 312 hand-rolled Card-shaped surfaces (a
 * container tag carrying a neutral background + a radius + a border or a
 * shadow) across 163 files. Their padding demand, and therefore the demand
 * this scale has to reach:
 *
 *   step 3    x94    step 2.5  x21    step 3.5  x5   <- NOT on the scale
 *   step 2    x36    step 1    x19    step 10   x2   <- NOT on the scale
 *   step 4    x33    step 5    x19
 *   step 6    x26    step 0.5  x9
 *                    step 8    x9
 *                    step 1.5  x8
 *                    step 0    x1
 *
 * 277 of the 284 step occurrences (97.5%) land on the twelve values below.
 * The stated leftover, not swept up silently: `p-3.5` x5 and `p-10` x2.
 *
 * By padding SHAPE the same 312 sites are: no padding 89, `p-3` 56, `p-6` 23,
 * `px-3 py-2` 22, `p-4` 20, `p-5` 16, then a tail of 25 further shapes. Today's
 * four-value `padding` word scale (p-0/p-4/p-6/p-8) reaches 137 of the 312;
 * this scale plus padX/padY reaches 305.
 */
const PAD_STEPS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12] as const
export type PadStep = (typeof PAD_STEPS)[number]

/**
 * Written out rather than templated: Tailwind's scanner reads source text, so
 * a class name assembled at runtime from a prefix and a step would generate
 * no CSS at all.
 */
const PAD: Record<PadStep, string> = {
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

const PAD_X: Record<PadStep, string> = {
  0: "px-0",
  0.5: "px-0.5",
  1: "px-1",
  1.5: "px-1.5",
  2: "px-2",
  2.5: "px-2.5",
  3: "px-3",
  4: "px-4",
  5: "px-5",
  6: "px-6",
  8: "px-8",
  12: "px-12",
}

const PAD_Y: Record<PadStep, string> = {
  0: "py-0",
  0.5: "py-0.5",
  1: "py-1",
  1.5: "py-1.5",
  2: "py-2",
  2.5: "py-2.5",
  3: "py-3",
  4: "py-4",
  5: "py-5",
  6: "py-6",
  8: "py-8",
  12: "py-12",
}

/**
 * The 6a word scale, kept as a deprecated alias so none of the 55 explicit
 * call sites (`none` x9, `sm` x39, `lg` x7, measured 2026-07-28) has to move
 * this session. Each maps to the step that renders the identical pixels.
 * Retired in phase 12c along with the rest of the deprecated names.
 */
const LEGACY_PADDING: Record<"none" | "sm" | "md" | "lg", PadStep> = {
  none: 0,
  sm: 4,
  md: 6,
  lg: 8,
}

/**
 * One deterministic padding class string.
 *
 * The axis branch matters: `cn('p-6', 'px-3')` keeps BOTH classes
 * (tailwind-merge 3.6 does not treat a later `px` as overriding an earlier
 * `p`), so which side wins would be decided by utility order inside the
 * compiled stylesheet rather than by this component. Emitting `px-A py-B`
 * instead of `p-N px-A` makes the outcome a property of the code.
 *
 * The no-axis branch emits the bare `p-N`, which is what keeps the default
 * byte-identical to what the 42 implicit-`md` call sites render today.
 */
function padClasses(pad: PadStep, padX?: PadStep, padY?: PadStep): string {
  if (padX === undefined && padY === undefined) return PAD[pad]
  return `${PAD_X[padX ?? pad]} ${PAD_Y[padY ?? pad]}`
}

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    tone?: StatusIntent
    flat?: boolean
    /**
     * Uniform padding, as a 4px-grid step. Defaults to 6 (24px), which is
     * what `padding="md"` renders and what the 42 call sites that pass no
     * padding at all already get.
     */
    pad?: PadStep
    /** Horizontal padding. Overrides `pad` on this axis only. */
    padX?: PadStep
    /** Vertical padding. Overrides `pad` on this axis only. */
    padY?: PadStep
    /**
     * @deprecated Use `pad`: none -> 0, sm -> 4, md -> 6, lg -> 8. Same
     * pixels, retired in phase 12c. Ignored when `pad` is also passed.
     */
    padding?: keyof typeof LEGACY_PADDING
  }
>(({ className, tone, flat, pad, padX, padY, padding, ...props }, ref) => {
  const step: PadStep = pad ?? (padding !== undefined ? LEGACY_PADDING[padding] : 6)
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-card border border-border bg-surface-light text-text-primary shadow-card",
        padClasses(step, padX, padY),
        // A card nested inside another card/panel that already provides its
        // own elevation - two call sites re-declared `shadow-none` for this.
        //
        // Load-bearing for the compact clusters above, not an edge case: of
        // the 56 `p-3` Card-shaped surfaces 50 carry NO shadow, and of the 22
        // `px-3 py-2` ones 19 carry none, while 17 of the 23 `p-6` ones do
        // carry `shadow-card`. So a compact hand-rolled surface converts as
        // `pad={3} flat`, never `pad={3}` alone. Verified against compiled
        // output: `.shadow-none` is emitted after `.shadow-card`, so it wins
        // even though tailwind-merge keeps both classes.
        flat && "shadow-none",
        tone && CARD_TONE[tone],
        className
      )}
      {...props}
    />
  )
})
Card.displayName = "Card"

export { Card, PAD_STEPS }
