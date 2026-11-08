import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/* =============================================================================
   ActionLink - phase 9 (program plan section 3, Phase 9 table: "`Link` (via
   `asChild`/Slot) | 44 raw `<a>` | must render as router Link, `<a>` or
   `<button>`").

   NAMED ActionLink, NOT Link - RECORDED RATHER THAN SILENTLY DECIDED.
   The program plan's phase-9 table calls this primitive "Link". `link.tsx`
   already exists (phase 7, TextLink) and cannot hold a second, differently
   shaped component under the same filename - and more to the point, `Link`
   is react-router-dom's own bare export, imported unaliased at 20+ call
   sites across this tree (pages/CustomerDetailPage.tsx,
   components/layout/AppLayout.tsx, components/patterns/PageHeader.tsx,
   components/jobs/overview/CustomerContactCard.tsx, ...). Every real call
   site of THIS primitive wraps a router `<Link>` via `asChild`
   (`<X asChild><Link to="...">`), so naming this component `Link` too would
   force every one of those call sites to alias one import or the other on
   day one. That is exactly the cost TextLink's own author avoided by not
   calling it `Link` (see link.tsx's header, "WHY A SEPARATE FILE...") - the
   same reasoning applies here, one layer further into the polymorphism, so
   it is applied here too rather than re-litigated. Flag for Ran: if a bare
   `Link` name is preferred despite the aliasing cost, this is a one-file
   rename plus a search-and-replace of the import path.

   WHAT THIS IS, AND HOW IT DIFFERS FROM TextLink (link.tsx).
   TextLink is running INLINE TEXT that happens to navigate - a customer name
   inside a `<p>`, a job number in a table cell. Its base string is
   deliberately empty (link.tsx's header) because it must not restate a
   control's geometry inside a line box.

   ActionLink is the opposite shape: a CONTROL that happens to render as an
   anchor - a self-contained CTA that is visually indistinguishable from a
   button but has to carry a real `href` (a mailto:, a tel:, a route) and the
   ARIA/keyboard semantics that come with it. Rather than mint a second
   definition of "what a link looks like", the `link` variant below reuses
   Button's own `link/brand` cell string byte for byte
   (components/ui/button.tsx, BUTTON_CELL_CLASSES) - that visual concept is
   Button's, already proven and frozen at 52 combinations in
   button.test.tsx. ActionLink's whole job is giving it correct anchor
   semantics and full polymorphism, not a second colour grid.

   MEASURED DEMAND. 43 raw `<a>` sites carrying a className across the
   408-file in-scope tree (phase-6 guard exports: targetFiles /
   findComponentTags / classNameTokens / stripComments, re-run against this
   branch tip rather than copied from the plan's rev-2 figure of 44 per "the
   rules of engagement" - the ~1-site drift is other work landing on staging
   since that measurement, not a scope change), 31 distinct signatures. Two
   real, repeated shapes stand out from the residue and are minted below; the
   rest are either TextLink's own running-text domain (out of scope for a
   control-shaped primitive) or too thin/blocked to mint yet (see "NOT
   MINTED" below).

     variant="link"     text-primary combined with underline / hover:underline
                         and font-medium - components/payments/
                         StripeOnboardingDrawer.tsx:176,182 (`underline`, the
                         external ToS / fee-schedule links), plus close
                         relatives at
                         features/estimate-workspace/components/CustomerHeader.tsx:97,102,136
                         (`block text-primary hover:underline`,
                         `text-sm font-semibold text-primary hover:underline`)
                         and pages/inventory/PriceBookPage.tsx:979
                         (`inline-flex items-center gap-1 text-primary
                         hover:underline`). CORRECTION: an earlier pass of
                         this header cited components/inventory/VendorCard.tsx
                         and pages/PublicEstimatePage.tsx for the latter two -
                         neither file contains a matching class string; the
                         real sites are the two above. None of these three are
                         byte-identical to the cell below (each carries one or
                         two extra tokens - `block`, `text-sm font-semibold`,
                         `inline-flex items-center gap-1` - that this variant
                         does not mint, since no clean per-variant sizing/
                         layout signal exists across them, see "NOT MINTED"
                         below). The `link` default itself is justified
                         primarily by reuse, not by these sites: it is
                         byte-identical to Button's own frozen `link/brand`
                         cell - see BUTTON_CELL_CLASSES - so ActionLink adds
                         anchor/polymorphism semantics to an already-proven
                         colour concept rather than measuring a fourth,
                         near-duplicate one.

     variant="outline"  components/inventory/VendorDetailDialog.tsx:302-308,
                         the "Email Vendor" `mailto:` CTA -
                         `inline-flex items-center gap-1.5 rounded-md border
                         border-primary-subtle bg-surface-light px-3 py-1.5
                         text-sm font-semibold text-primary
                         hover:bg-primary-subtle`. One measured site, minted
                         the same way Card's `flat` prop (2 sites) and
                         TextLink's `size="xs"` (1 site, the chip) came from
                         thin-but-real evidence rather than staying a
                         className override forever.

   NOT MINTED THIS SESSION, RECORDED RATHER THAN SWEPT UP:
   - `tone`. Every measured site above resolves to the same idle/hover colour
     (brand / text-primary). A `tone` prop with exactly one legal value
     nothing ever varies is a prop nobody asked for - the same call
     thumbnail.tsx's header makes for its own missing tone axis. Add it the
     day a second tone (e.g. a `danger` "leave this org" mailto: link) has a
     real site.
   - `size`. No clean per-variant sizing signal: the `outline` cell's
     `text-sm` is baked into its one measured geometry (no second recorded
     size for a bordered CTA pill), and `link`'s few sizing hints
     (`text-xs` on components/data/ContactCell.tsx) sit on running text,
     which is TextLink's domain, not this control-shaped one.
   - The icon-tile contact-action cluster
     (components/inventory/VendorDetailDialog.tsx,
     components/jobs/overview/CustomerContactCard.tsx - 6 sites, the
     `flex flex-col items-center gap-1 rounded-lg border ... text-[11px]
     font-medium text-text-secondary hover:text-primary
     hover:border-primary/40 transition-colors` signature). Blocked on an
     unregistered 11px font key - heading.tsx's own header marks the same
     key "not planned, phase 11e once [program-plan decision] D2 lands",
     which is a tokens.css decision this session does not own. Left as a
     call-site override rather than swept into a prop with an arbitrary
     bracket value (forbidden this session).
   - `gap` / `pad`. The one minted multi-token cell (`outline`) bakes its
     internal spacing into one atomic geometry, matching Chip's and
     Avatar's own precedent ("height + padding + gap move together, not
     three separate props" - chip.tsx) - it has no second recorded spacing
     value to justify splitting one out.

   POLYMORPHISM AND REF FORWARDING - THE HIGH-RISK PART.
   `asChild` swaps the rendered element for whatever child is passed, via
   Radix `Slot` - exactly Button's and TextLink's own mechanism, so no new
   dependency and no new pattern. What IS new here is that the child is not
   always an anchor: the phase-9 evidence explicitly requires this primitive
   to render as a router `<Link>`, a plain `<a>`, OR a `<button>` (a "link"
   with no real destination that performs a JS action instead - the same
   category TextLink's bucket H names for a single site, generalised here).
   `Slot` forwards both the merged className and the ref to whichever real
   DOM node the child renders, regardless of its tag - that is Slot's whole
   contract, not custom code in this file - but it is exactly the kind of
   contract that fails silently if a future edit swaps `Slot` for a
   hand-rolled clone, or if a consumer nests two `asChild` boundaries and the
   ref quietly stops at the outer wrapper. __tests__/action-link.test.tsx
   asserts it directly for all three render targets (a plain `<a>`, a router
   `<Link>`, and a bare `<button>`), reading `ref.current.tagName` off the
   real rendered node rather than trusting the wrapper.
   ============================================================================= */

/**
 * THE GRID. Only cells with measured demand are minted (see header). `link`
 * is Button's `link/brand` cell, copied verbatim rather than imported, so
 * this file has no runtime dependency on button.tsx's internal shape - the
 * byte-for-byte match is asserted in the test file instead.
 */
const ACTION_LINK_CELL_CLASSES = {
  /** Text that behaves like a control - see header. */
  link: 'text-primary underline-offset-4 hover:underline',
  /** A bordered, padded CTA pill - see header. */
  outline:
    'inline-flex items-center gap-1.5 rounded-md border border-primary-subtle bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-subtle',
} as const;

const actionLinkVariants = cva('', {
  variants: {
    variant: ACTION_LINK_CELL_CLASSES,
  },
  defaultVariants: {
    variant: 'link',
  },
});

export interface ActionLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof actionLinkVariants> {
  /**
   * Render the child element instead of an `<a>`, forwarding these classes
   * and this ref onto it. This is how one primitive serves a router
   * `<Link to="/vendors/1">`, a bare `<a href="mailto:...">`, or a
   * `<button>` (for a "link" with no real destination) without ActionLink
   * knowing anything about routing. Implemented with Radix `Slot`, exactly
   * as Button and TextLink do it.
   */
  asChild?: boolean;
}

/**
 * A control-shaped element that navigates.
 *
 * `<ActionLink asChild variant="outline"><a href="mailto:...">Email
 * Vendor</a></ActionLink>` renders `class="inline-flex items-center gap-1.5
 * rounded-md border border-primary-subtle bg-surface-light px-3 py-1.5
 * text-sm font-semibold text-primary hover:bg-primary-subtle"` on the
 * anchor - the exact token set VendorDetailDialog.tsx:302-308 hand-rolls
 * today.
 *
 * `<ActionLink>` with no props renders `<a class="text-primary
 * underline-offset-4 hover:underline">` - Button's own `link/brand` cell on
 * a real anchor. There is no pre-existing default to preserve (this
 * primitive is new), so the default matches the more general-purpose of the
 * two minted cells rather than an arbitrary one.
 */
const ActionLink = React.forwardRef<HTMLAnchorElement, ActionLinkProps>(
  ({ className, variant, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'a';
    return (
      <Comp ref={ref} className={cn(actionLinkVariants({ variant }), className)} {...props} />
    );
  }
);
ActionLink.displayName = 'ActionLink';

export { ActionLink, actionLinkVariants, ACTION_LINK_CELL_CLASSES };
