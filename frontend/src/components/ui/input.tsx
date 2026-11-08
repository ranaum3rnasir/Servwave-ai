import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* =============================================================================
   Input - phase 8a `size`.
   -----------------------------------------------------------------------------
   236 call sites across 63 files (walked every .tsx/.ts outside components/ui,
   pages/prototype and pages/design-system, tag-scanned every <Input> open tag).
   Three real height rungs showed up in call-site `className` overrides:

     h-8  (32px) x27  - almost always paired with an explicit `text-sm`
                        override (forces the small font at every breakpoint,
                        not just lg+)
     h-9  (36px) x14  - mostly height-only, no font-size override
     h-11 (44px) x7   - byte-identical to today's default geometry; these
                        sites are restating the current default, not asking
                        for a new rung

   `size` is the vocabulary's absolute px ladder (§2a.1 rule 2 of the program
   plan): xs=32, sm=36, md=40, lg=44. A primitive's default is pinned to the
   rung that equals its CURRENT rendered geometry, not to the word `md` -
   Button's default is 40px so it is `md`, Input's default is 44px so it is
   `lg`. `size="lg"` is that default and MUST NOT MOVE - 236 call sites render
   through it today. `sm` and `xs` are additive rungs for the two real
   below-default heights. No `md` rung: no call site asked for 40px on Input,
   so there is no evidence for that rung on this primitive - it is left
   unminted rather than added "for consistency" (a cell is minted only where
   measured demand exists).
   Padding is untouched on every rung - none of the h-8/h-9 override sites
   touched px-/py-, so `xs`/`sm` only change height (and, for `xs`, force the
   small font unconditionally instead of only at lg+).

   `size` is declared in a cva() block so the geometry lives in one place
   instead of being hand-spliced into the base string. For `size="lg"` (the
   default, and what every propless call site resolves through) the variant
   class is an EMPTY string, so `cva`'s own `cx` (clsx) call drops it entirely
   and the emitted class list is byte-identical to what this file rendered
   before this change - verified in __tests__/input.test.tsx.
   ============================================================================= */

const inputVariants = cva(
  "flex h-11 w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base transition-colors duration-300 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-primary placeholder:text-text-soft hover:border-primary focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
  {
    variants: {
      size: {
        // Today's default geometry (44px, h-11), already carried by the base
        // string above. Empty on purpose - see the header note on why this
        // keeps `lg` byte-identical to the pre-8a render.
        lg: "",
        // 36px rung. Height only - no call site pairs h-9 with a font-size
        // override, so `sm` leaves text-base/md:text-sm alone.
        sm: "h-9",
        // 32px rung. Call sites overriding to h-8 almost always force
        // text-sm too, so this rung does the same: text-sm here is
        // unprefixed and wins over the base string's unprefixed text-base,
        // while the base's own `md:text-sm` (a Tailwind breakpoint prefix,
        // unrelated to the `size` vocabulary word - same value, different
        // conflict group) survives untouched - net effect is text-sm at
        // every breakpoint, matching what those call sites were doing by
        // hand.
        xs: "h-8 text-sm",
      },
    },
    defaultVariants: {
      size: "lg",
    },
  }
)

/**
 * `tone` values. W2/8's rename schedule (program plan section 2a.11)
 * explicitly points this axis at "`sage` -> `business`" - the closed
 * vocabulary's semantic colour word for the same deposit-box tint. `business`
 * emits the identical `border-sage-200 hover:border-sage-500
 * focus-visible:border-sage-500` string `sage` always has: `--business`
 * (button.tsx's own header note names it as the eventual `--sage-700`-
 * identical token) is not minted in tokens.css yet, so the primitive Tailwind
 * classes stay unchanged for now, the same "stays here for now" deferral
 * button.tsx's own `solid/business` cell documents for its own fill - only
 * the PROP NAME moves. `sage` stays as a deprecated alias for the exact same
 * class string so the 3 real call sites that already pass it
 * (components/jobs/items/ReceiptCard.tsx:386,594 on Input,
 * components/jobs/items/ReceiptCard.tsx:610 on SelectTrigger) keep rendering
 * byte-for-byte identical output.
 */
export type InputTone = "default" | "sage" | "business"

/**
 * Chrome axis (email slice 7). `boxed` is today's only rendered shape and
 * stays the default - the bordered/background box every one of Input's 236
 * existing call sites already gets, byte-identical to before this axis
 * existed. `ghost` strips the box entirely (no border, no background, no
 * fixed height/padding) for an inline field that reads as plain text until
 * focused - added for the Gmail-style Cc/Bcc row (ComposeWindow.tsx), which
 * needs the SAME chromeless look its sibling To/Subject rows already hand-roll
 * as a raw `<input className="bg-transparent ...">`. Authored here, inside
 * the primitive, rather than as a call-site className override, is the
 * point: this repo's layering-guard test forbids a call site from deciding a
 * shared component's appearance, and its raw-tag ratchet forbids a NEW raw
 * `<input>` anywhere outside components/ui - a third axis is the only way to
 * add this shape without regressing either.
 */
export type InputVariant = "boxed" | "ghost"

export interface InputProps
  // The native `size` HTML attribute (visible width in characters, a number)
  // collides with the vocabulary's `size` (control height, a scale word) -
  // Omit the native one so ours wins. No call site in this codebase used the
  // native attribute (it would have been reported as demand for the same
  // reason `invalid` and `tone` were), so nothing loses access to it.
  extends Omit<React.ComponentProps<"input">, "size">,
    VariantProps<typeof inputVariants> {
  /** Whether the current value failed validation. The call site says WHAT is
   * wrong (via its own error message), never how the input should look
   * because of it - 9 sites used to hand-roll `border-danger` themselves. */
  invalid?: boolean
  /**
   * The sage-tinted deposit box treatment (ReceiptCard). `business` is the
   * closed-vocabulary value; `sage` is a deprecated alias for the exact same
   * class string - see the `InputTone` doc comment above.
   */
  tone?: InputTone
  /** See the `InputVariant` doc comment above. Defaults to `boxed` (today's
   *  only shape, unchanged for every existing call site). */
  variant?: InputVariant
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, tone = "default", variant = "boxed", size, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          inputVariants({ size }),
          (tone === "sage" || tone === "business") &&
            "border-sage-200 hover:border-sage-500 focus-visible:border-sage-500",
          invalid && "border-danger hover:border-danger focus-visible:border-danger",
          variant === "ghost" &&
            "h-auto rounded-none border-0 bg-transparent p-0 text-sm text-text-primary outline-none placeholder:text-text-secondary",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input, inputVariants }
