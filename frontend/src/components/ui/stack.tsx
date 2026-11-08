import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/* =============================================================================
   Stack - phase 7d. The spacing primitive (program plan corollary 4).

   "Give this page more breathing room" is the single most common design
   request, and today it is unanswerable without grep: spacing is authored as
   `mt-6` / `space-y-4` / `gap-2` at 3,543 measured occurrences across the 408
   in-scope files (`gap-*` 2,318, `space-y-*` 632, uniform `p-*` 593). Stack
   makes the vertical and horizontal rhythm of a layout a prop, so retuning it
   is an edit to this file plus the call sites that name a step - never a hunt
   through pages.

   WHY `gap` IS A NUMBER AND NOT A SIZE WORD
   Settled in the program plan, section 2a.8, and NOT re-opened here. Three
   mechanical reasons, all measured: a word ramp collides destructively with
   `Card padding="sm"` (16px) and `EmptyState density` (whose `default` is
   48px and `roomy` is 96px, inexpressible in a six-word ramp); and word ramps
   strand real modes - `gap-0.5` (61 sites), `gap-2.5` (46) and `space-y-5`
   (19) have no word. The 4px-grid step list below is a NAMING OF THE MEASURED
   MODES, not an invented ramp: it covers 2,285 of 2,318 `gap-*` occurrences
   (98.6%) and 610 of 632 `space-y-*` (96.5%). `gap={6}` is 24px.

   WHY FLEX + `gap-*` AND NOT `space-y-*`
   `gap-*` is already the dominant authoring mode by 3.7 to 1, it works in both
   axes with one prop, and it does not break when children wrap. Conversion
   caveat for phase 9 / 11, stated so nobody discovers it in a diff: replacing
   a `<div class="space-y-4">` with `<Stack gap={4}>` swaps a block container
   for a flex column. That is geometrically identical for ordinary
   full-width children (a flex column stretches them, same as block flow), but
   it is NOT identical where the old container relied on block layout -
   `margin: auto` centring, collapsing margins between children, floats, or a
   percentage height. Those sites need a look, not a sed.

   NOT COVERED, DELIBERATELY:
   - Axis-specific gaps (`gap-x-*` / `gap-y-*`, roughly 70 occurrences). One
     prop, one rhythm; a two-axis grid is phase 9's `Box`/grid work.
   - `pad` / `padX` / `padY`. Stack is spacing BETWEEN children; padding around
     children belongs to the surface primitive (`Card pad`, also phase 7d).
   - `as` / polymorphism. Every measured target is a `<div>`. Phase 10's shells
     can add it if a `<section>` or `<ul>` turns up.
   ============================================================================= */

/**
 * 4px-grid step. `gap={6}` is 24px. Program plan section 2a.8; the same step
 * list `pad` / `padX` / `padY` take.
 */
export type StackGap = 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12;

const stackVariants = cva('flex', {
  variants: {
    /** Which way children flow. `vertical` is a column, `horizontal` is a row. */
    direction: {
      vertical: 'flex-col',
      horizontal: 'flex-row',
    },
    /**
     * Let a horizontal stack wrap onto more lines. Real sites with this exact
     * shape (`flex items-center gap-2 flex-wrap`): `EstimatesPage.tsx:539`,
     * `JobsPage.tsx:442` and `CustomersPage.tsx:549` (applied-filter chip
     * rows), plus `JobDetailPage.tsx:1042` (an action toolbar, `justify-end`
     * variant). Both tracer pages (Invoices/InvoiceDetail) have since been
     * converted to `<Stack ... wrap>` themselves and are no longer raw
     * markup, so they are evidence of adoption rather than of the original
     * demand.
     */
    wrap: {
      true: 'flex-wrap',
      false: '',
    },
    /**
     * Space between children, in 4px-grid steps. Measured modes this covers:
     * gap-2 728, gap-1 441, gap-3 433, gap-1.5 431, gap-4 122, gap-0.5 61,
     * gap-2.5 46, gap-6 31, gap-0 14, plus the space-y equivalents.
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
  // `align` and `justify` have NO default on purpose: a Stack that says nothing
  // about alignment must emit no alignment class, so wrapping existing markup
  // in a Stack cannot move it. `gap={0}` is likewise a rendered no-op.
  defaultVariants: { direction: 'vertical', wrap: false, gap: 0 },
});

export interface StackProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>,
    VariantProps<typeof stackVariants> {}

/**
 * `<Stack>` with no props renders exactly `<div class="flex flex-col gap-0">` -
 * a plain full-width column with no spacing, so it is geometrically inert.
 * There is no existing default to preserve (no layout primitive exists today),
 * and this one is chosen so that adopting Stack can never move a pixel until a
 * call site names a step.
 */
const Stack = React.forwardRef<HTMLDivElement, StackProps>(
  ({ className, direction, wrap, gap, align, justify, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(stackVariants({ direction, wrap, gap, align, justify }), className)}
      {...props}
    />
  )
);
Stack.displayName = 'Stack';

export { Stack, stackVariants };
