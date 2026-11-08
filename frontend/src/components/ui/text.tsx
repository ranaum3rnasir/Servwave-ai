import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/* =============================================================================
   Text - phase 7. The inline / block copy primitive.

   Heading owns the document outline; Text owns everything else that paints
   type. Today nothing does: copy is authored as a bare element plus a class
   list, at the largest appearance population in the tree.

   THE ONE RULE THAT MATTERS: `size="base"` EMITS NO CLASS.
   Twelve of the residue sites on the two tracer pages carry no font size at
   all - they inherit one from an ancestor (the payment ledger's rows inherit
   the 14px key set on the table root, the banner bodies inherit from their
   container). If `base` emitted the stock 16px key, every one of those sites
   would jump from 14px to 16px the moment it was wrapped. It is a one-word
   mistake, no type error catches it, and once the app-wide conversion runs it
   would silently restyle thousands of sites rather than twelve. `base` is the
   ABSENCE of a font size, not the 16px rung. A call site that genuinely wants
   16px passes nothing here and says so in its own class list, or waits for a
   measured rung.

   `tone` follows the same logic and has NO default: copy that inherits its
   colour must keep inheriting it.

   MEASURED DEMAND - the two tracer pages, `<span>` + `<p>` + `<div>` only,
   taken with the phase-6 guard exports (`targetFiles`, `findComponentTags`,
   `classNameTokens`, `classifyToken`, `stripComments`) against the branch tip
   before conversion. 123 appearance tokens sit on those three tags. This API
   retires 82 of them; 2 more are the hand-rolled link at InvoicesPage's
   customer cell and belong to TextLink; the remaining 39 are fill, border,
   radius and container padding, which are a surface, not copy.

     colour     text-text-secondary 19 | text-danger-text 7 | text-text-primary 3
                text-primary 2 | text-success-text 2 | text-neutral-text 1
     size       text-xs 10 | text-sm 9 | text-3xl 1 | one 10px bracket value 1
     weight     font-medium 12 | font-bold 1
     alignment  right 8 | center 2
     casing     uppercase 2 | tracking-wide 2

   THREE NOTES ON THAT TABLE, because two of them contradict the plan:
   - `font-semibold` has ZERO demand on these three tags. The one the phase-7
     work-list attributed to a weight axis sits on a table cell, which the
     table cluster owns, not Text. It is kept here anyway: it is additive, it
     costs nothing, and the app-wide population below makes it the second most
     common weight on copy in the tree. It is listed as unmeasured on purpose.
   - The 10px bracket value resolves through the newly registered font key
     rather than staying a bracket value. That key is a bare string in the
     Tailwind config, so it emits a font size and nothing else, exactly as the
     bracket value did.
   - `align` IS REQUIRED, and it is not layout. The guard's alignment carve-out
     is scoped to Card by a deliberate owner decision, so an alignment utility
     on a bare span classifies as APPEARANCE for every other component. Without
     this axis those 10 tokens survive and the zero-appearance exit criterion
     fails on both pages.

   WHY THERE IS NO LINE-HEIGHT AXIS, AND WHY ADDING ONE WOULD BE A BUG.
   A stock font-size key ships a line height as an absolute LENGTH, and an
   unsized element inherits its ancestor's line box as that same length. So a
   line-height prop is not additive: handing one to a site that inherits today
   changes its line box. Nothing on either tracer page asked for one. Do not
   add it on the strength of it looking symmetrical with the other axes.

   `tone="primary"` IS THE CHROME TEXT ROLE, NOT THE NEUTRAL STATUS ROLE.
   Same note Heading carries. They are different values (#10202B against
   #5E707B), which is exactly why `neutral` is a separate key here rather than
   an alias. A site that means "this is the muted status colour" and a site
   that means "this is body copy" must not resolve to the same token.

   WHAT THIS PRIMITIVE IS FOR, AND IS NOT CONVERTING THIS SESSION.
   Measured across the guard's 413 target files, appearance authored on bare
   inline copy:

     <span>  6,262 appearance tokens over 2,370 sites carrying a class list
             text-text-secondary 860 (214 files), font-medium 420,
             font-semibold 402, text-text-primary 351, text-xs 272,
             the 10px bracket value 227, uppercase 194,
             the 11px bracket value 184, text-sm 164
     <p>     3,736 appearance tokens over 1,329 sites
             text-text-secondary 783 (240 files), text-xs 408, text-sm 378,
             font-semibold 257, text-text-primary 217, uppercase 166
     <label>   372 appearance tokens over 156 sites

   BUILDING the primitive is additive; CONVERTING those ten thousand tokens is
   W3, and no call site outside the two tracer pages moves in this session. The
   API above is deliberately the shape the residue asked for and nothing more,
   so that W3 inherits an API validated against real pages rather than a
   speculative one.

   NOT COVERED, DELIBERATELY - recorded rather than swept up:
   - The 11px bracket value (184 span sites, 163 p sites). It needs the same
     per-site ancestor line-box audit the 10px key needed before it can be
     registered, and neither tracer page contains one. W4.
   - A `truncate` / line-clamp axis. Both classify as layout under the phase-6
     classifier, so they neither block the exit criterion nor belong to a
     colour-and-type primitive.
   - `italic`, `lowercase`, `capitalize`. Real appearance prefixes, zero demand
     on either page.
   - `as="label"`. 372 appearance tokens say the demand is real, but a label
     needs `htmlFor` and there is already a Label primitive to extend instead.
   ============================================================================= */

/**
 * Which element is rendered. All three are measured on the tracer pages: the
 * span is the default and the overwhelming majority, `p` is body copy, and
 * `div` appears where the copy wraps block content and cannot be a paragraph.
 */
export type TextElement = 'span' | 'p' | 'div';

const textVariants = cva('', {
  variants: {
    /**
     * Font size. `base` IS AN EMPTY STRING ON PURPOSE - see the header. It
     * means "inherit", which is what 12 of the measured residue sites do.
     * Keys are Tailwind's own font-size keys so the prop value and the
     * rendered class are the same fact, with `3xs` being the 10px key phase 7
     * registered.
     */
    size: {
      '3xl': 'text-3xl',
      base: '',
      sm: 'text-sm',
      xs: 'text-xs',
      '3xs': 'text-3xs',
    },
    /**
     * Semantic colour. NO default: copy that inherits its colour keeps
     * inheriting it. `primary` is the chrome body role and `neutral` is the
     * muted status role; they are different values and must stay separate
     * keys.
     */
    tone: {
      primary: 'text-text-primary',
      secondary: 'text-text-secondary',
      brand: 'text-primary',
      danger: 'text-danger-text',
      success: 'text-success-text',
      neutral: 'text-neutral-text',
    },
    /**
     * Font weight. `medium` is the measured mode (12 sites); `bold` has one
     * site, the invoice balance figure. `semibold` has no demand on either
     * tracer page and is carried for the app-wide population only.
     */
    weight: {
      medium: 'font-medium',
      semibold: 'font-semibold',
      bold: 'font-bold',
    },
    /**
     * Horizontal alignment. Appearance, not layout, everywhere except Card -
     * see the header. `left` has no measured demand on either page but is
     * included so a site can positively override an aligned ancestor.
     */
    align: {
      left: 'text-left',
      center: 'text-center',
      right: 'text-right',
    },
    /** Letter casing. Two measured sites, both eyebrow labels. */
    transform: {
      uppercase: 'uppercase',
    },
    /** Letter spacing. Two measured sites, the same two eyebrow labels. */
    tracking: {
      wide: 'tracking-wide',
    },
  },
  // NO defaultVariants, on any axis. Every one of them would paint something,
  // and a Text that says nothing must paint nothing.
});

export interface TextProps
  extends Omit<React.HTMLAttributes<HTMLElement>, 'color'>,
    VariantProps<typeof textVariants> {
  /** Rendered element. Defaults to `span`; never changes how the text looks. */
  as?: TextElement;
}

/**
 * `<Text>` with no props renders exactly `<span class="">` - zero classes,
 * zero painted properties. Wrapping any existing inline copy in a bare Text
 * cannot move a pixel, which is the property the whole conversion depends on:
 * a call site can adopt the primitive first and name its axes second, and the
 * intermediate state is provably identical to what shipped. Same anti-goal
 * Stack and Heading state - an element that paints nothing stays bare.
 */
const Text = React.forwardRef<HTMLElement, TextProps>(function Text(
  { as = 'span', className, size, tone, weight, align, transform, tracking, ...props },
  ref
) {
  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={ref}
      className={cn(textVariants({ size, tone, weight, align, transform, tracking }), className)}
      {...props}
    />
  );
});
Text.displayName = 'Text';

export { Text, textVariants };
