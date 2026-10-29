import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/* =============================================================================
   Heading - phase 7d.

   Replaces the 206 raw `<h1>/<h2>/<h3>` sites (43 + 66 + 97, plus 4 `<h4>`;
   0 `<h5>`, 0 `<h6>`), measured over the 408 in-scope files with the phase-6
   guard exports (`targetFiles`, `findComponentTags`, `classNameTokens`,
   `classifyToken`, `stripComments`). Every one of the 210 sites carries a
   className; there is no typography primitive at all today.

   WHY LEVEL AND SCALE ARE SEPARATE PROPS
   The two diverge in real pages, which is why one prop cannot serve both.
   Measured, per rendered tag:

     <h1>  text-xl 31 | text-2xl 7 | text-lg 4 | text-base 1
     <h2>  text-sm 35 | text-lg 16 | text-xs 5 | text-xl 3 | text-base 2 | text-2xl 1
     <h3>  text-sm 53 | text-xs 17 | text-base 10 | text-lg 1  (+ 15 bracket, below)
     <h4>  text-sm 2  | text-xs 2

   An `<h2>` is 14px in 53% of its sites and 18px in 24% of them. Document
   outline (what a screen reader announces) and visual weight (what the page
   looks like) are genuinely independent here, so they are two props.

   WHY THE VISUAL PROP IS `scale` AND NOT `size`
   The settled vocabulary (program plan section 2a, rule 3) reserves `size` for
   control height on an absolute px ladder - six rungs, 24-44px (section 2a.6),
   `size="sm"` is 36px tall on every control that has the prop - and requires a
   primitive whose scale is NOT a control height to name the dimension it
   actually moves. That is why Modal's max-width scale is `width`, Card's is
   `pad` and EmptyState's is `padY`. A heading has no control height, so its
   type-ramp prop is `scale`. Reusing `size` would put a 40px control height
   and a 14px type size behind the same word, which is the exact collision
   rule 3 exists to prevent.

   The values are Tailwind's own font-size keys rather than invented words, so
   `scale="lg"` is `text-lg` with no translation table to look up, and the six
   keys cover 190 of the 210 measured sites (90.5%).

   NOT COVERED, DELIBERATELY - stated rather than swept up:
   - 19 sites carry a bracket font size no stock key can express: `text-[15px]`
     x7 (all `<h3>`), `text-[10px]` x10, `text-[11px]` x2. Program-plan decision
     D2 registers a 10px and an 11px font key as permanent; 15px has no planned
     key. Adding a bracket value here is forbidden, so these route to phase 11e
     once D2's keys land.
   - A letter-spacing / letter-casing axis. `uppercase` appears on 36 heading sites
     and `tracking-wide` on 30, overwhelmingly together as an eyebrow style
     (`text-xs font-semibold uppercase tracking-wide text-text-secondary`, 16
     `<h3>` sites plus close relatives). That is a real, measured signature and
     it wants a `variant="eyebrow"`, but NEITHER tracer page contains a single
     `<h2>` or `<h3>`, so W1 cannot validate it. Recorded for W2.
   - `font-extrabold` x5, one signature (`font-extrabold text-[15px]
     tracking-tight`). Outside the vocabulary's weight list, and it needs the
     15px key it is paired with anyway.
   - `tone` values with a single site each: `text-ai-600` x1 and `text-on-fill`
     x1. The ai one needs a colour ruling first (`--ai-600` is the raw ramp
     step, `--ai-text` is the AA-verified text role, and they are different
     values), and `text-on-fill` is the dark-surface context phase 9's
     `Surface` owns, not a tone.
   ============================================================================= */

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const headingVariants = cva('', {
  variants: {
    /**
     * Visual size, independent of `level`. Tailwind's stock font-size keys,
     * used verbatim so the prop value and the rendered px are the same fact.
     * Site counts across all 210 measured headings: sm 92, xl 34, lg 21,
     * xs 24, base 13, 2xl 8.
     */
    scale: {
      '2xl': 'text-2xl',
      xl: 'text-xl',
      lg: 'text-lg',
      base: 'text-base',
      sm: 'text-sm',
      xs: 'text-xs',
    },
    /** semibold 184 sites, bold 20. `normal` and `medium` have zero demand. */
    weight: {
      semibold: 'font-semibold',
      bold: 'font-bold',
    },
    /**
     * Semantic colour. `neutral` is the heading colour (166 of the 209
     * colour-carrying sites), `subtle` steps it back (36 sites), `brand` is
     * the one site that paints a heading in the interactive colour.
     *
     * Note `neutral` here is `--text-primary`, the chrome text role, NOT the
     * `--neutral-text` status role - they are different values (#10202B vs
     * #5E707B). Program plan section 2a records that `tone="neutral"` resolves
     * per primitive; on a text primitive it is the chrome family, matching
     * what `Label`'s existing `tone="strong"` already renders.
     */
    tone: {
      neutral: 'text-text-primary',
      subtle: 'text-text-secondary',
      brand: 'text-primary',
    },
  },
  // `scale`'s real default is derived from `level` (see DEFAULT_SCALE below);
  // `xl` is listed here because it is what level 1, the default level,
  // resolves to, so reading this block alone is not misleading.
  defaultVariants: { scale: 'xl', weight: 'semibold', tone: 'neutral' },
});

/**
 * What each heading level looks like when the call site does not say. This map
 * IS the app's type ramp: change one line here and every heading at that level
 * moves, which is the whole point of the primitive.
 *
 * It is MEASURED, not designed. Levels 2 to 6 default to `sm` because 14px is
 * the dominant size at those levels today (h2 35 of 66, h3 53 of 97, h4 2 of 4)
 * - section headings inside cards, not a descending display ramp. Encoding a
 * prettier ramp (xl / lg / base) would silently restyle ~90 sites the moment
 * phase 11e converts them, which the hard constraint forbids. A designer who
 * wants a real ramp changes these six values in one place, on purpose.
 */
const DEFAULT_SCALE: Record<HeadingLevel, NonNullable<VariantProps<typeof headingVariants>['scale']>> = {
  1: 'xl',
  2: 'sm',
  3: 'sm',
  4: 'sm',
  5: 'sm',
  6: 'sm',
};

export interface HeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement>,
    Omit<VariantProps<typeof headingVariants>, 'scale'> {
  /**
   * Document outline position - which `<hN>` element is rendered, and what a
   * screen reader announces. Never changes how the heading looks on its own.
   */
  level?: HeadingLevel;
  /**
   * Visual size. Omit it to take `level`'s ramp entry; pass it when the
   * outline and the visual weight disagree, which they do at 47% of `<h2>`
   * sites.
   */
  scale?: NonNullable<VariantProps<typeof headingVariants>['scale']>;
}

/**
 * `<Heading>` with no props renders exactly
 * `<h1 class="text-xl font-semibold text-text-primary">` - byte for byte the
 * signature both tracer pages already use (`InvoicesPage.tsx:481` modulo its
 * layout classes, `InvoiceDetailPage.tsx:666`) and the most common `<h1>`
 * signature in the tree (31 of 43 sites carry `text-xl`). No existing pixel
 * moves.
 */
const Heading = React.forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ className, level = 1, scale, tone, weight, ...props }, ref) => {
    const Tag = `h${level}` as const;
    return (
      <Tag
        ref={ref}
        className={cn(headingVariants({ scale: scale ?? DEFAULT_SCALE[level], weight, tone }), className)}
        {...props}
      />
    );
  }
);
Heading.displayName = 'Heading';

export { Heading, headingVariants, DEFAULT_SCALE };
