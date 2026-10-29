import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import type { StackGap } from '@/components/ui/stack';

/* =============================================================================
   Inline - phase 9. Stack's horizontal-axis twin (program plan section 3,
   Phase 9 table: "Stack, Inline, Box - ad-hoc `flex gap-*` and `mt-*` at call
   sites - corollary 4; no layout primitives exist").

   Stack (phase 7d) already documents the full, measured case for a spacing
   primitive - 3,543 `gap-*` / `space-y-*` / uniform `p-*` occurrences across
   408 in-scope files, with `gap-*` the dominant mode at 2,318 sites - and it
   already supports a horizontal `direction`. Inline exists because a row of
   children (a chip row, a toolbar, a filter strip) is a distinct authoring
   intent from a column that happens to be told to lay out sideways.

   CORRECTION (verified against the live tree, not carried forward from
   stack.tsx unchecked): the citations this header originally copied from
   stack.tsx - `InvoicesPage.tsx:525` and `InvoiceDetailPage.tsx:778` - do not
   contain the markup described; neither file contains `flex-wrap` at all.
   The two row shapes are real, just at different sites. The filter-chip row
   (`flex items-center gap-2 flex-wrap` wrapping `<AppliedChips>`) is real at
   `EstimatesPage.tsx:539`, `JobsPage.tsx:442` and `CustomersPage.tsx:549`.
   The action-toolbar row (`flex items-center gap-2 ... flex-wrap justify-end`)
   is real at `JobDetailPage.tsx:1044` ("Right: action cluster"). `<Inline
   gap={2}>` is the row-first spelling of exactly those shapes.

   WHY THE GAP SCALE IS A NUMBER, DUPLICATED FROM Stack RATHER THAN A NEW WORD
   RAMP. Not re-litigated here - Stack's header states the full case (a word
   ramp collides with Card's `pad` scale and strands `gap-0.5` / `gap-2.5` /
   `space-y-5`, which have no word). Inline is explicitly paired with Stack for
   this axis, so its `gap` MUST be the same type and render the same class for
   the same value - `<Inline gap={2}>` and `<Stack direction="horizontal"
   gap={2}>` are two spellings of one shape, not two shapes. `StackGap` is
   imported rather than redeclared so the two scales cannot drift apart; the
   class map below is still written out in full literal strings (not derived
   from the import) because Tailwind's scanner reads source text and a
   class name assembled from a shared table at runtime would generate no CSS.

   NOT COVERED, DELIBERATELY (same boundary Stack draws, for the same reasons):
   - No `direction` prop. Inline IS the horizontal axis; a call site that wants
     the vertical one reaches for `Stack`.
   - `gap-x-*` / `gap-y-*`. One prop, one rhythm - Box/grid work is phase 9's
     `Box`, not this file.
   - `pad` / `padX` / `padY`. Inline is spacing BETWEEN children; padding
     around children belongs to the surface primitive (`Card pad`).
   - `as` / polymorphism. Every measured target is a `<div>`.
   ============================================================================= */

const inlineVariants = cva('flex flex-row', {
  variants: {
    /**
     * Let a row wrap onto more lines. No default demand cited beyond Stack's
     * own two tracer rows (both pass `wrap` explicitly), so it stays opt-in -
     * see the inert-default note below.
     */
    wrap: {
      true: 'flex-wrap',
      false: '',
    },
    /**
     * Space between children, in the same 4px-grid steps as `Stack`'s `gap`
     * (see the header note - the two scales are one scale, imported as
     * `StackGap`). `gap={6}` is 24px.
     */
    gap: {
      0: 'gap-0',
      0.5: 'gap-0.5',
      1: 'gap-1',
      1.5: 'gap-1.5',
      2: 'gap-2',
      2.5: 'gap-2.5',
      3: 'gap-3',
      4: 'gap-4',
      5: 'gap-5',
      6: 'gap-6',
      8: 'gap-8',
      12: 'gap-12',
    },
    /** Cross-axis alignment. Omit to inherit flex's own `stretch`. */
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
      baseline: 'items-baseline',
    },
    /** Main-axis distribution. Omit to inherit flex's own `flex-start`. */
    justify: {
      start: 'justify-start',
      center: 'justify-center',
      end: 'justify-end',
      between: 'justify-between',
      around: 'justify-around',
      evenly: 'justify-evenly',
    },
  },
  // `align` and `justify` have NO default, matching Stack: a row that says
  // nothing about alignment must emit no alignment class, so wrapping
  // existing markup in an Inline cannot move it. `gap={0}` is likewise a
  // rendered no-op.
  defaultVariants: { wrap: false, gap: 0 },
});

export interface InlineProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>,
    VariantProps<typeof inlineVariants> {}

/**
 * `<Inline>` with no props renders exactly `<div class="flex flex-row gap-0">` -
 * a plain row with no spacing, geometrically inert for the same reason Stack's
 * bare default is: there is no existing behaviour to preserve, and this one is
 * chosen so adopting Inline can never move a pixel until a call site names a
 * step.
 */
const Inline = React.forwardRef<HTMLDivElement, InlineProps>(
  ({ className, wrap, gap, align, justify, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(inlineVariants({ wrap, gap, align, justify }), className)}
      {...props}
    />
  )
);
Inline.displayName = 'Inline';

export { Inline, inlineVariants };
export type { StackGap as InlineGap };
