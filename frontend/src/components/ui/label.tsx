import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* =============================================================================
   Label - closed-vocabulary `tone` remap (190 call sites across 53 files).

   The file already shipped a non-vocabulary `tone` prop (#909/#1017) with
   values `default` (implicit, ~178 sites) and `strong` (12 sites). Neither
   name is in the closed vocabulary (variant/tone/size/gap/pad, with tone
   the settled 9-value list: brand/neutral/subtle/danger/success/warning/
   info/ai/business - program plan section 2a.2, rev 3).

   `subtle` is a lossless rename of the old `default`: both resolve to
   `text-text-secondary`. The value is named `subtle`, not `muted` (rev 2's
   name, now superseded): section 2a.2 renames `muted` to `subtle` because
   `--muted` is a Tier-1 primitive token (tokens.css:23, aliased to
   --text-secondary at :152) and tokens.css:12 forbids a component from
   consuming a Tier-1 primitive directly - `tone="muted"` would read as
   exactly that forbidden reference. Judge finding G8 (program plan section
   2b) names this file as the motivating case for the rename: `muted` was
   unguessable next to `neutral`, which behaves the opposite way (`ghost` +
   `neutral` sets no idle colour and inherits, `ghost` + the old `muted` sets
   a real grey - button.tsx:36,40). `neutral` is a lossless rename of the old
   `strong` (`text-text-primary`). `default` and `strong` stay as deprecated
   aliases resolving to the exact same class strings, so all 190 existing
   call sites - 12 of which pass `tone="strong"` today - keep rendering
   byte-for-byte identical output. No call site passes `tone="muted"`
   literally today, so the `subtle` rename needed no alias of its own.

   `SIZE` AND `WEIGHT` - ADDED IN THIS REPAIR PASS, NAMING SETTLED 2026-07-30.

   The per-primitive scope table (program plan section 2a.11, Label row)
   reads verbatim: "tone=\"subtle\" for the old \"default\"-adjacent quiet
   case, tone=\"neutral\" otherwise, plus size + weight." The prior pass of
   this file shipped only the tone half and reasoned, in this comment, that
   `size` should wait because it collides with the control-height meaning
   `size` carries on every other primitive (rule 3: "size never appears on a
   primitive where it would not mean control height... A max-width or
   max-height scale is never called size"). That tension is real - Label has
   no control height - but the per-primitive table lists `size` for Label
   anyway, and quietly dropping a table-mandated axis over an unresolved
   naming question is not this file's call (CLAUDE.md: "never self-authorize
   a deviation, however reasonable it looks - surface the conflict... and
   wait for the call").

   The same tension was already hit, and already resolved, by the two
   sibling text primitives in this same tree: components/ui/text.tsx and
   components/ui/link.tsx (commit 0770be7c1, merged - predates this session,
   out of scope to alter, treated here as settled precedent). Both name their
   font-size axis `size` and both record the conflict rather than quietly
   renaming around it - link.tsx's header, verbatim: "the settled
   vocabulary's rule 3 says size never means anything but control height...
   It is size here because the phase-7 work-list specifies size for both
   text primitives, and Text... is being built in parallel against the same
   spec. Renaming one without the other would leave two sibling text
   primitives disagreeing." A `<label>` is inline text exactly like
   TextLink's anchor and Text's span/p/div, so it follows that same accepted
   resolution rather than inventing a fourth convention: `size` below is a
   FONT-SIZE scale, using Tailwind's own font-size key names (`sm`, `xs`),
   not the six-rung control-height ladder (3xs..lg / 24..44px) that
   Button/Input/SelectTrigger use for their own `size` prop.

   Owner call (Ran, 2026-07-30): keep `size` as named. Renaming it on Label
   alone while Text and TextLink keep `size` for the identical font-size
   meaning would leave three sibling text primitives disagreeing over one
   concept - worse than the rule-3 tension it would "solve." This is the
   same resolution Text and TextLink already shipped, applied consistently
   rather than re-litigated per file.

   `sm` is the default: `text-sm` is what the base string already hard-coded
   before this pass, so a propless Label keeps rendering the same 14px type
   (rule 2 - default is whichever rung matches the primitive's current
   rendered geometry). `xs` is added because the prior pass's own comment
   measured 20 `text-xs` call-site sites wanting to override it. No other
   font-size key is added - rule 5, only measured demand.

   `weight` is unambiguous: it is a named global axis (`normal | medium |
   semibold | bold`), already shipped with exactly this meaning on
   text.tsx's Text and link.tsx's TextLink. `bold` is the default: `font-bold`
   is what the base string already hard-coded, so a propless Label is
   unchanged. `semibold` is added because the prior pass's own comment
   measured 13 `font-semibold` call sites. `normal`/`medium` are not added -
   no measured demand yet, the same rule-5 discipline TextLink (ships only
   `medium`) and Text (ships `medium`/`semibold`/`bold`, no `normal`) both
   apply.

   WHY `size` IS A PLAIN Record LOOKUP AND `weight` IS A cva VARIANT - THIS
   IS NOT A STYLE CHOICE, IT IS A REAL RENDERED-OUTPUT BUG FOUND WHILE
   IMPLEMENTING THIS PASS.

   The first draft of this pass put both new axes in cva's `variants` map,
   same as `tone`. That silently DELETED `leading-none` from the propless
   default render - not a byte-order cosmetic difference, an actual missing
   class. Root cause, verified directly against this project's installed
   `tailwind-merge` (`node -e "require('tailwind-merge').twMerge(...)"`):
   `twMerge('leading-none text-sm')` => `'text-sm'` (leading-none dropped);
   `twMerge('text-sm leading-none')` => `'text-sm leading-none'` (both kept).
   tailwind-merge treats a font-size utility as implicitly setting
   line-height (Tailwind's own theme ties them together) and lets a LATER
   font-size class silently override an EARLIER `leading-*` class - but not
   the reverse: `font-bold`/`font-semibold` (a `weight` value) has no such
   entanglement (`twMerge('leading-none font-bold')` keeps both, either
   order). cva's `variants` map always appends a variant's resolved class
   AFTER the base string - so once `text-sm`/`text-xs` (font size) became a
   cva variant, it always landed AFTER the base string's `leading-none`,
   and got silently eaten on every render, sm or xs alike.

   This is the exact hazard dialog.tsx's `DIALOG_WIDTH`/`DIALOG_PAD`/
   `DIALOG_GAP` and sheet.tsx's equivalents already carry a header comment
   about (both files predate this session, already-shipped precedent - see
   dialog.tsx: "cva's variants map always appends a variant's class AFTER
   the base string, which would change the byte order of the DEFAULT-value
   render even though the class SET stayed identical"). Here it is a strictly
   worse version of that same hazard - not a byte-order difference but a
   rendered-class-SET difference - so `size` follows their fix, not cva:
   `LABEL_SIZE` is a plain `Record<LabelSize, string>`, spliced into `cn()`
   as the FIRST argument, so `text-sm`/`text-xs` lands at the exact position
   `text-sm` held in the pre-repair base string - before `leading-none`,
   never after it. `weight` has no such hazard (verified above) and stays a
   normal cva variant, appended after base like `tone`.

   The rendered TOKEN SET for a propless Label is fully unchanged from
   before this pass (same 11 classes - confirmed by rebuilding the merge by
   hand and diffing against the pre-repair render); only the literal class
   STRING's byte order differs (`text-sm` now leads instead of `text-sm
   font-bold` leading). __tests__/label.test.tsx checks the token set, not
   exact string order, for exactly this reason - order was never a rendered-
   behaviour guarantee, only the SET was, and the set is what is verified.
   ============================================================================= */

/**
 * Font size - see "WHY size IS A PLAIN Record LOOKUP" above for why this is
 * a `Record` rather than a cva variant, and why it is named `size` despite
 * Label having no control height. `sm` is the default, matching the
 * pre-existing hard-coded `text-sm`. `xs` is measured demand (20 call
 * sites).
 */
export type LabelSize = "sm" | "xs"

const LABEL_SIZE: Record<LabelSize, string> = {
  sm: "text-sm",
  xs: "text-xs",
}

const labelVariants = cva(
  "leading-none transition-colors duration-300 hover:text-text-primary has-[+input:is(:hover,:focus)]:text-text-primary has-[+textarea:is(:hover,:focus)]:text-text-primary peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
  {
    variants: {
      // How prominent the label is, not what colour it is. `subtle` and
      // `neutral` are the closed-vocabulary tone values (`subtle` is the
      // settled rename of rev 2's `muted`, section 2a.2). `default` and
      // `strong` are deprecated aliases for the same two values, kept only
      // so the existing call sites that already pass them keep rendering
      // byte-for-byte identical output - do not remove them without
      // migrating every call site.
      tone: {
        subtle: "text-text-secondary",
        neutral: "text-text-primary",
        default: "text-text-secondary",
        strong: "text-text-primary",
      },
      // Font weight, the closed-vocabulary `weight` axis (normal | medium |
      // semibold | bold - only the values with measured demand are minted,
      // rule 5). `bold` is the default, matching the pre-existing
      // hard-coded `font-bold`. `semibold` is measured demand (13 call
      // sites). Safe as a cva variant (appended after the base string) -
      // unlike `size`, a weight class does not silently evict
      // `leading-none` in either order - see the header note above.
      weight: {
        bold: "font-bold",
        semibold: "font-semibold",
      },
    },
    defaultVariants: { tone: "subtle", weight: "bold" },
  }
)

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants> & {
      /** Font size. Defaults to `sm` (`text-sm`), today's unstyled geometry - unmoved. */
      size?: LabelSize
    }
>(({ className, tone, size = "sm", weight, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(LABEL_SIZE[size], labelVariants({ tone, weight }), className)}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label, labelVariants }
