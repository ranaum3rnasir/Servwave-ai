import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* =============================================================================
   Button - `variant` (structure) x `tone` (colour)
   -----------------------------------------------------------------------------
   Two orthogonal axes replace the old 13-name flat `variant` list:

     variant = STRUCTURE   solid | outline | ghost | link
     tone    = COLOUR      brand | neutral | subtle | danger | ai | business

   plus one modifier, `revealOnHover` (ghost only: idle reads as `subtle`, the
   tone only appears on hover).

   Only cells with measured demand are minted. The rest are deliberately absent
   so an un-designed pair fails loudly instead of rendering an unstyled button:

     solid   brand  business  ai  danger  neutral
     outline neutral  danger
     ghost   neutral  subtle  danger  danger+revealOnHover
     link    brand

   Deferred, published in the W1 vocabulary but NOT implemented here (zero
   measured call sites on either tracer page): the `soft` structure, and the
   success / warning / info tones. Add them when a call site needs them.

   `onDark` is NOT a tone. It is a context - "this button sits on a dark
   surface" - and phase 7a leaves it exactly as it shipped (4 call sites:
   copilot/CopilotSheet, copilot/CopilotPanel, copilot/ApprovalCard,
   pages/SchedulePage). It gets decomposed when the dark-surface work lands.

   PHASE 12C - THE PRE-7A ALIASES ARE GONE. Phase 7a introduced this
   variant x tone grid alongside 13 flat pre-7a `variant` names for backward
   compatibility - 4 that survived unchanged (`outline`, `ghost`, `link`,
   `onDark`, each meaning exactly its structure at the default tone) and 9
   DEPRECATED ALIASES that resolved to a fixed variant+tone pair (`default`,
   `business`, `ai`, `destructive`, `secondary`, `destructiveOutline`,
   `ghostMuted`, `ghostDestructive`, `ghostDestructiveReveal`). Phase 11
   converted every real call site to the variant+tone form; phase 12c
   (re-measured at build time: 131 literal call sites across 75 files, plus 6
   sites computing a variant from a local value) finished the remaining ones
   and deleted the alias table - `LEGACY_VARIANT_CELLS`, the
   `DeprecatedButtonVariant` type, and the triple-call-signature type surface
   that used to carry the `@deprecated` diagnostic (see the old
   `ButtonComponent` interface, removed here) all went with it. `Button` is
   typed as a single ordinary component now - nothing computes a COMPUTED
   variant string spanning old and new names anymore, so the escape-hatch
   signature that existed for exactly that (2 real call sites,
   settings/UserPermissionsDialog.tsx and payments/StripePaymentsStatusCard.tsx
   - both re-derived to compute `tone` instead) is gone too. `Meta<typeof
   Button>` in button.stories.tsx no longer needs the `ComponentType` cast this
   change made unnecessary. The rendered class string of every surviving name
   is unchanged; only the 9 deprecated spellings stopped compiling.

   IMPLEMENTATION NOTE - why one `cell` key instead of two cva variant keys
   plus compoundVariants. cva emits classes in the order
   `base -> variants (Object.keys order) -> compoundVariants -> className`, so
   a variant+tone cell expressed as a compound variant would land AFTER the
   size classes and change the byte order of every existing call site's class
   string. Collapsing the grid into a single `cell` key declared before `size`
   keeps the emitted order at `base -> colour -> size -> className`, exactly as
   before. The grid is still one table; it is just keyed by the pair.
   ============================================================================= */

/** Structure axis. What shape the control is, independent of its colour. */
export type ButtonStructure = "solid" | "outline" | "ghost" | "link"

/** Colour axis. Semantic meaning, independent of the structure. */
export type ButtonTone = "brand" | "neutral" | "subtle" | "danger" | "ai" | "business"

/**
 * Control height.
 *
 * `default` and `md` are the SAME rung - 40px, today's geometry. `md` is the
 * W1 vocabulary's word for it ("size is absolute px; md is 40"), added so the
 * settled word exists; `default` is the cva key every propless call site
 * already resolves through and stays the `defaultVariants` value. Neither is
 * removed here.
 *
 * `3xs` is the 24px rung (step 7b). It is ADDITIVE: 5 shipped call sites spell
 * that geometry out in a className override today, and the rung emits the
 * identical token set (see the buttonCell size block for the proof).
 */
export type ButtonSize = "default" | "md" | "3xs" | "sm" | "lg" | "icon"

/**
 * Everything `variant` accepts: the four structures plus the `onDark`
 * context. Kept as one flat union (rather than a discriminated variant/tone
 * union) so a computed variant - e.g. inventory/lo/LODetailSheet.tsx:427,
 * jobs/items/AddLineDialog.tsx:619 - keeps type-checking without a cast.
 * Pair-level type safety is a follow-up, not a 12c change.
 */
export type ButtonVariant = ButtonStructure | "onDark"

/** A minted variant x tone cell. `#reveal` marks the revealOnHover modifier. */
export type ButtonCell = keyof typeof BUTTON_CELL_CLASSES

/**
 * THE GRID. Keys are `${structure}/${tone}`, with `#reveal` appended for the
 * revealOnHover modifier. Every class string here is byte-identical to the one
 * the corresponding pre-7a variant carried - do not "tidy" them.
 */
const BUTTON_CELL_CLASSES = {
  // solid - a filled control. Ocean = the everyday interactive anchor.
  "solid/brand": "bg-primary text-on-fill hover:bg-primary-dark",
  // Sage = "business is moving" - the one primary business CTA per page.
  // NOTE: `bg-sage-700` is a Tier-1 primitive, not a semantic token. The W1
  // vocabulary mints a `--business` token (identical RGB to --sage-700) and
  // respells this cell onto it, fill and hover alike. That edit belongs to
  // tokens.css + tailwind.config.js, which 7a does not own, so the primitive
  // spelling stays here for now and the respelling lands with the token.
  // (The respelled class names are described rather than written out: this
  // file is scanned as raw text by check-unresolved-classes.mjs, which cannot
  // tell a comment from a className and would read them as dead classes.)
  "solid/business": "bg-sage-700 text-on-fill hover:bg-sage-700/90",
  // Lavender -> indigo gradient = AI moments (reserved).
  "solid/ai": "bg-gradient-to-br from-ai-600 to-ai-500 text-on-fill hover:opacity-90",
  "solid/danger": "bg-danger text-on-fill hover:bg-danger/90",
  "solid/neutral": "bg-border-soft text-text-primary hover:bg-border",

  // outline - a bordered control. TRAP: outline/neutral carries a real white
  // `bg-surface-light` and sets NO idle text colour. 202 call sites depend on
  // both of those, so it is not derivable from a uniform outline recipe.
  "outline/neutral":
    "border border-border bg-surface-light hover:bg-background-light hover:text-text-primary",
  // Same shape as solid/danger, but bordered instead of filled - a serious
  // top-level destructive action (a "danger zone" delete), not an inline row
  // action. 4 sites hand-rolled this, 3 of them via raw `text-red-600` instead
  // of the `danger` token.
  "outline/danger": "border border-danger/40 text-danger hover:bg-danger/10 hover:text-danger",

  // ghost - no fill, no border. TRAP: ghost/neutral sets NO idle colour at all
  // and inherits from its parent. 50 call sites rely on that inheritance, so
  // it is not "ghost with grey text".
  "ghost/neutral": "hover:bg-background-light hover:text-text-primary",
  // ghost with its idle colour filled in - 8 sites needed this exact pairing
  // (back buttons, "clear filters") and had to restate the idle half
  // themselves since ghost/neutral only styles hover.
  "ghost/subtle": "text-text-secondary hover:bg-background-light hover:text-text-primary",
  // An inline destructive action that reads as dangerous at rest (delete /
  // void / revoke rows) - always red, red-tinted on hover so hovering can't
  // fade it back to the neutral ghost grey.
  "ghost/danger": "text-danger hover:bg-danger/10 hover:text-danger",
  // The same action, quiet until the row is hovered (purchase orders'
  // delete/cancel). revealOnHover is a MODIFIER, not a tenth tone: idle is
  // `subtle`, hover is the tone.
  "ghost/danger#reveal": "text-text-secondary hover:bg-danger/10 hover:text-danger",

  // link - text that behaves like a control.
  "link/brand": "text-primary underline-offset-4 hover:underline",

  // Context, not a variant x tone cell. See the header note.
  onDark: "text-on-fill/70 hover:bg-on-fill/10 hover:text-on-fill",
} as const

/** Each structure's tone when the call site does not name one. */
const DEFAULT_TONE: Record<ButtonStructure, ButtonTone> = {
  solid: "brand",
  outline: "neutral",
  ghost: "neutral",
  link: "brand",
}

/** The structure axis - every value `variant` may take, other than `onDark`. */
const STRUCTURES: readonly ButtonStructure[] = ["solid", "outline", "ghost", "link"]

function isStructure(v: string): v is ButtonStructure {
  return (STRUCTURES as readonly string[]).includes(v)
}

/**
 * Own-property membership. `key in obj` also answers true for every name on
 * `Object.prototype` (`constructor`, `toString`, `valueOf`, ...), so a
 * structure/tone pair built from a name that collides with one of those
 * (`"constructor/toString"`, however unlikely) could be mistaken for a real
 * cell and resolve to a function instead of a class string. Not reachable
 * through the typed API today; this closes it anyway.
 *
 * Spelled with `hasOwnProperty.call` rather than `Object.hasOwn` because this
 * project compiles against `lib: ES2020` and `Object.hasOwn` lands in ES2022.
 * Same own-property semantics, no lib bump.
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * Dev-only diagnostic. `import.meta.env.DEV` is statically false in a
 * production build, so the bundler drops the call entirely.
 */
function warnInDev(message: string): void {
  if (!import.meta.env.DEV) return
  // eslint-disable-next-line no-console
  console.warn(message)
}

/**
 * Resolve (variant, tone, revealOnHover) to a grid cell.
 *
 * - `null` propagates as `null`, which cva reads as "emit no colour classes".
 *   That is what `<Button variant={null}>` did before 7a, so it still does.
 * - An unminted pair falls back to the structure's default tone and shouts in
 *   dev, rather than rendering a colourless control in production.
 * - `revealOnHover` on a pair with no reveal cell is dropped, and says so in
 *   dev. The button still renders correctly, so this is a warning rather than
 *   an error, but it is never silent: a prop that does nothing has to tell
 *   whoever set it.
 */
export function resolveButtonCell(
  variant?: ButtonVariant | null,
  tone?: ButtonTone | null,
  revealOnHover?: boolean
): ButtonCell | null {
  if (variant === null) return null
  if (variant === "onDark") return "onDark"

  const structure: ButtonStructure =
    variant !== undefined && isStructure(variant) ? variant : "solid"
  const resolvedTone: ButtonTone = tone ?? DEFAULT_TONE[structure]

  if (revealOnHover) {
    const revealKey = `${structure}/${resolvedTone}#reveal`
    if (hasOwn(BUTTON_CELL_CLASSES, revealKey)) return revealKey as ButtonCell
    warnInDev(
      `[Button] revealOnHover had no effect: no reveal cell is minted for ` +
        `variant="${structure}" tone="${resolvedTone}", so the plain pair is ` +
        `rendered instead. Either drop the prop, or mint ` +
        `"${revealKey}" in components/ui/button.tsx.`
    )
  }

  const key = `${structure}/${resolvedTone}`
  if (hasOwn(BUTTON_CELL_CLASSES, key)) return key as ButtonCell

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error(
      `[Button] no cell is minted for variant="${structure}" tone="${resolvedTone}"` +
        `${revealOnHover ? " revealOnHover" : ""}. ` +
        `Falling back to tone="${DEFAULT_TONE[structure]}". ` +
        `Mint the cell in components/ui/button.tsx before using this pair.`
    )
  }
  return `${structure}/${DEFAULT_TONE[structure]}` as ButtonCell
}

/**
 * The cva block. `cell` is declared before `size` so the emitted class order
 * stays `base -> colour -> size -> className` (see the implementation note
 * above).
 *
 * SIZE RUNGS. The four 7a rungs are byte-frozen: `default`, `sm`, `lg` and
 * `icon` are exactly what shipped, `default` is still the `defaultVariants`
 * value, and the 52-string baseline in __tests__/button.test.tsx pins all of
 * them. Step 7b adds two keys and changes nothing else.
 *
 *   `md`  is a SYNONYM of `default` - the same 40px geometry, spelled the way
 *         the W1 vocabulary names it. It is NOT made the `defaultVariants`
 *         value: every call site that passes no size resolves through the
 *         `default` key today, and swapping which key that is would move an
 *         emission nothing asked to move. Two keys, one rung, no behaviour
 *         change. (The two keys emit the same bytes, so the swap would be
 *         invisible in the class string - which is exactly why it is not worth
 *         the risk of being wrong about that.)
 *
 *   `3xs` is the 24px rung. Five shipped call sites already render this exact
 *         geometry by passing the smaller-height, tighter-pad, smaller-font
 *         triple as a className on top of `sm`.
 *
 * WHY `3xs` CARRIES NO RADIUS CLASS, and the trap that goes with it.
 * `sm` and `lg` each restate the radius that the base string already carries.
 * That duplication is deliberate and frozen (deleting it would be a rendered
 * no-op but not a byte-identical one), and it is why a `3xs` call site does
 * NOT produce the same class STRING its className override produces today:
 *
 *   today     base + cell + `sm` + className   -> the radius survives TWICE,
 *                                                 once from base, once from
 *                                                 the `sm` rung, because
 *                                                 tailwind-merge has no
 *                                                 conflict group for this
 *                                                 project's custom radius key
 *   with 3xs  base + cell + `3xs`              -> the radius survives once
 *
 * The deduplicated token SETS are identical (verified through the real `cn`
 * for both live call sites: symmetric difference empty, string equality
 * false). Tailwind utilities all have equal specificity and the order of the
 * class attribute is not what decides the cascade - the order of the compiled
 * stylesheet is - so the rendered CSS is identical.
 *
 * THEREFORE: any test of this rung must compare the deduplicated token SET,
 * never the raw string. If you see a red string-equality assertion here, the
 * assertion is wrong, not the rung. Do NOT "fix" it by reordering or
 * duplicating the radius class in the base string: that string is the
 * 52-combination frozen contract 504 call sites depend on.
 */
const buttonCell = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-sm font-semibold ring-offset-surface-light transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      cell: BUTTON_CELL_CLASSES,
      size: {
        default: "h-10 px-4 py-2",
        // Synonym of `default`, byte-identical. See the SIZE RUNGS note above.
        md: "h-10 px-4 py-2",
        sm: "h-9 rounded-button px-3",
        lg: "h-11 rounded-button px-8",
        icon: "h-10 w-10",
        // 24px rung. No radius class: the base string already carries it.
        "3xs": "h-6 px-2 text-xs",
      },
    },
    defaultVariants: {
      cell: "solid/brand",
      size: "default",
    },
  }
)

export interface ButtonVariantsOptions {
  variant?: ButtonVariant | null
  tone?: ButtonTone | null
  revealOnHover?: boolean
  size?: ButtonSize | null
  className?: string
}

/**
 * Class-string builder for the rare caller that needs Button's look without a
 * Button (asChild wrappers, Radix `Slot` consumers). Same call shape as before
 * 7a, plus `tone` / `revealOnHover`. Has no call sites outside this file and
 * its own test.
 *
 * THIS RETURNS THE RAW cva STRING, NOT A MERGED ONE - run it through `cn`.
 * `Button` already does (see its own render function), so the component is
 * unaffected; a
 * direct caller is not. It matters from 7b onward because the 24px rung is the
 * first size rung to carry a font size, and the base string carries one too, so
 * the raw output of `buttonVariants({ size: "3xs" })` contains BOTH and leaves
 * the winner to stylesheet order instead of resolving it. `cn` collapses the
 * pair deterministically to the rung's. Measured today: zero callers outside
 * this file and its test, which is the only reason this is a documented hazard
 * rather than a bug. Routing the return through `cn` here would be a byte-level
 * no-op on all 52 frozen combinations (verified) and would close it for good -
 * left undone because 7b's brief is two additive size keys and nothing else.
 */
export function buttonVariants(options: ButtonVariantsOptions = {}): string {
  const { variant, tone, revealOnHover, size, className } = options
  return buttonCell({
    cell: resolveButtonCell(variant, tone, revealOnHover),
    size,
    className,
  })
}

/**
 * The full prop shape. Before phase 12c this was also the escape-hatch third
 * call signature on a triple-overloaded `ButtonComponent` - with the
 * deprecated names gone, there is nothing left to overload, so `Button` is
 * typed as an ordinary component and this is simply its props type.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | null
  tone?: ButtonTone | null
  /** ghost only: idle reads as `subtle`, the tone appears on hover. */
  revealOnHover?: boolean
  size?: ButtonSize | null
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, tone, revealOnHover, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, tone, revealOnHover, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, BUTTON_CELL_CLASSES, DEFAULT_TONE }
