/* =============================================================================
   ServWave Design System - the spacing (padding) vocabulary.

   One home for the step-number padding scale and the single function that
   turns a set of padding props into a deterministic class string. Three
   primitives in this session need it (Tabs, Table, Surface). Without a shared
   module each of them hand-copies the same seven step maps, which is the exact
   drift this program exists to kill.

   ---------------------------------------------------------------------------
   VOCABULARY AMENDMENT 1 (the big one, decided by the owner this session)
   ---------------------------------------------------------------------------
   The settled vocabulary published `pad` / `padX` / `padY` only. This module
   adds `padTop` / `padRight` / `padBottom` / `padLeft` as a STRICT SUPERSET,
   mirroring Tailwind's own four-sided model.

   It is not a convenience. InvoiceDetailPage:905 pads a tab rail on its top
   side alone. Expressed with the published vocabulary that is `padY={2}`,
   which also adds 8px at the BOTTOM: a rendered change, which the hard
   constraint on this session forbids outright. Measured per-side demand in the
   Tabs cluster alone is 9 sites. The rejected alternative was a bespoke
   `inset` step meaning "re-inset a rail inside a padless Card", which invents
   a second word for one shape and breaks the vocabulary's own rule 1.

   ---------------------------------------------------------------------------
   VOCABULARY AMENDMENT 2 (smaller, also made this session): step 10
   ---------------------------------------------------------------------------
   The settled ladder is 0 0.5 1 1.5 2 2.5 3 4 5 6 8 12. This module publishes
   that ladder plus step 10 (40px), so the scale here is a strict superset of
   the one in components/ui/card.tsx.

   Why: InvoicesPage:633 is a centred loading paragraph whose vertical padding
   is step 10, and it is not a one-off. Raw source scan over frontend/src/
   (labelled RAW, supporting evidence only, not a guard-derived number):
   py-10 appears 22 times and p-10 4 times. Without step 10 those call sites
   cannot be converted without changing what they render, and the anti-goal
   says a token we cannot retire must be reported, never quietly restyled.

   ---------------------------------------------------------------------------
   WHY EVERY CLASS BELOW IS WRITTEN OUT IN FULL
   ---------------------------------------------------------------------------
   Tailwind's scanner reads source TEXT. A class assembled at runtime from a
   prefix and a step number is invisible to it, so no CSS is generated and the
   element silently renders with no padding at all. Tailwind does not error on
   this; it exits 0. Never build one of these strings by interpolation, however
   repetitive the maps look. spacing.test.ts asserts, per map entry, that the
   literal is physically present in this file's source.

   ---------------------------------------------------------------------------
   SCOPE NOTE
   ---------------------------------------------------------------------------
   card.tsx keeps its own private copies of the three-map version for now. They
   are the duplicate this module retires, and that migration is W2 work, not
   this session's. Nothing here changes what any shipped component renders.
   ============================================================================= */

/**
 * The 4px-grid STEP number, not a size word. `pad={6}` is 24px.
 * Numbers rather than words is what keeps this from colliding with the legacy
 * word scales still live on Card and EmptyState: a designer typing a word from
 * muscle memory cannot silently get a different pixel value, because these
 * props do not accept words at all.
 */
export type PadStep = 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 10 | 12

/** Every legal step, in ascending order. Exported for exhaustive tests. */
export const PAD_STEPS: readonly PadStep[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]

export const PAD: Record<PadStep, string> = {
  0: 'p-0',
  0.5: 'p-0.5',
  1: 'p-1',
  1.5: 'p-1.5',
  2: 'p-2',
  2.5: 'p-2.5',
  3: 'p-3',
  4: 'p-4',
  5: 'p-5',
  6: 'p-6',
  8: 'p-8',
  10: 'p-10',
  12: 'p-12',
}

export const PAD_X: Record<PadStep, string> = {
  0: 'px-0',
  0.5: 'px-0.5',
  1: 'px-1',
  1.5: 'px-1.5',
  2: 'px-2',
  2.5: 'px-2.5',
  3: 'px-3',
  4: 'px-4',
  5: 'px-5',
  6: 'px-6',
  8: 'px-8',
  10: 'px-10',
  12: 'px-12',
}

export const PAD_Y: Record<PadStep, string> = {
  0: 'py-0',
  0.5: 'py-0.5',
  1: 'py-1',
  1.5: 'py-1.5',
  2: 'py-2',
  2.5: 'py-2.5',
  3: 'py-3',
  4: 'py-4',
  5: 'py-5',
  6: 'py-6',
  8: 'py-8',
  10: 'py-10',
  12: 'py-12',
}

export const PAD_TOP: Record<PadStep, string> = {
  0: 'pt-0',
  0.5: 'pt-0.5',
  1: 'pt-1',
  1.5: 'pt-1.5',
  2: 'pt-2',
  2.5: 'pt-2.5',
  3: 'pt-3',
  4: 'pt-4',
  5: 'pt-5',
  6: 'pt-6',
  8: 'pt-8',
  10: 'pt-10',
  12: 'pt-12',
}

export const PAD_RIGHT: Record<PadStep, string> = {
  0: 'pr-0',
  0.5: 'pr-0.5',
  1: 'pr-1',
  1.5: 'pr-1.5',
  2: 'pr-2',
  2.5: 'pr-2.5',
  3: 'pr-3',
  4: 'pr-4',
  5: 'pr-5',
  6: 'pr-6',
  8: 'pr-8',
  10: 'pr-10',
  12: 'pr-12',
}

export const PAD_BOTTOM: Record<PadStep, string> = {
  0: 'pb-0',
  0.5: 'pb-0.5',
  1: 'pb-1',
  1.5: 'pb-1.5',
  2: 'pb-2',
  2.5: 'pb-2.5',
  3: 'pb-3',
  4: 'pb-4',
  5: 'pb-5',
  6: 'pb-6',
  8: 'pb-8',
  10: 'pb-10',
  12: 'pb-12',
}

export const PAD_LEFT: Record<PadStep, string> = {
  0: 'pl-0',
  0.5: 'pl-0.5',
  1: 'pl-1',
  1.5: 'pl-1.5',
  2: 'pl-2',
  2.5: 'pl-2.5',
  3: 'pl-3',
  4: 'pl-4',
  5: 'pl-5',
  6: 'pl-6',
  8: 'pl-8',
  10: 'pl-10',
  12: 'pl-12',
}

/**
 * The padding half of a primitive's public API. Spread this into a component's
 * prop type so all seven props are declared in one place and stay in step.
 */
export interface PadProps {
  /** Uniform padding on all four sides, as a 4px-grid step. */
  pad?: PadStep
  /** Horizontal padding. Overrides `pad` on the left and right sides. */
  padX?: PadStep
  /** Vertical padding. Overrides `pad` on the top and bottom sides. */
  padY?: PadStep
  /** Top padding. Overrides `padY` and `pad` on this side only. */
  padTop?: PadStep
  /** Right padding. Overrides `padX` and `pad` on this side only. */
  padRight?: PadStep
  /** Bottom padding. Overrides `padY` and `pad` on this side only. */
  padBottom?: PadStep
  /** Left padding. Overrides `padX` and `pad` on this side only. */
  padLeft?: PadStep
}

/**
 * One deterministic padding class string.
 *
 * PRECEDENCE: padTop/padRight/padBottom/padLeft > padX/padY > pad.
 *
 * THREE BRANCHES, in this order. The first two are the proven implementation
 * in card.tsx:132 reproduced exactly, so a caller that only ever uses
 * pad/padX/padY gets a byte-identical string from either module. The third
 * extends the same rule to four sides.
 *
 *   1. nothing set             -> the empty string
 *      pad only               -> the bare shorthand, e.g. `p-6`
 *   2. an axis set, no side    -> both axes named, e.g. `px-3 py-6`
 *   3. any side set            -> every resolvable side named individually
 *
 * WHY BRANCH 2 AND 3 NEVER EMIT THE SHORTHAND ALONGSIDE AN OVERRIDE. This is
 * card.tsx's finding, recorded there and load-bearing here: tailwind-merge 3.6
 * does NOT treat a later horizontal-axis padding class as overriding an
 * earlier shorthand one. Merging the shorthand with an axis class keeps BOTH,
 * so which side actually wins is decided by utility order inside the compiled
 * stylesheet rather than by the component. Expanding the shorthand instead
 * makes the outcome a property of this code. Branch 1 is what keeps a
 * primitive's default byte-identical to what it renders today.
 *
 * WHY AN UNRESOLVABLE SIDE EMITS NOTHING RATHER THAN A ZERO. If `pad` is
 * omitted and only some sides are named, only those sides are named in the
 * output. Synthesising a step-0 class for the rest is not a no-op: padding is
 * not universally zeroed by the preflight reset, so a zero on, say, a table
 * cell would remove the padding a user-agent stylesheet gives it. That is a
 * rendered change, which this session forbids. There is no shorthand in the
 * output for such a side to conflict with, so the rule above still holds.
 */
export function padClasses({
  pad,
  padX,
  padY,
  padTop,
  padRight,
  padBottom,
  padLeft,
}: PadProps): string {
  const hasSide =
    padTop !== undefined ||
    padRight !== undefined ||
    padBottom !== undefined ||
    padLeft !== undefined
  const hasAxis = padX !== undefined || padY !== undefined

  // Branch 1.
  if (!hasSide && !hasAxis) return pad === undefined ? '' : PAD[pad]

  // Branch 2. `??` and not `||`, because step 0 is a legal value.
  if (!hasSide) {
    const x = padX ?? pad
    const y = padY ?? pad
    return join([x === undefined ? '' : PAD_X[x], y === undefined ? '' : PAD_Y[y]])
  }

  // Branch 3.
  const top = padTop ?? padY ?? pad
  const right = padRight ?? padX ?? pad
  const bottom = padBottom ?? padY ?? pad
  const left = padLeft ?? padX ?? pad
  return join([
    top === undefined ? '' : PAD_TOP[top],
    right === undefined ? '' : PAD_RIGHT[right],
    bottom === undefined ? '' : PAD_BOTTOM[bottom],
    left === undefined ? '' : PAD_LEFT[left],
  ])
}

/** Drop the unresolved sides, keep the order, single-space separated. */
function join(parts: string[]): string {
  return parts.filter((p) => p !== '').join(' ')
}
