import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/* =============================================================================
   TextLink - phase 7, bucket E (+H).

   WHY THIS PRIMITIVE EXISTS AT ALL. Both tracer pages already document its
   absence in the source, in a comment written before this file did. Quoting
   pages/InvoicesPage.tsx verbatim (the "To Be Invoiced" dialog note, item 3):

     "The job link is `font-medium text-primary hover:underline`. There is no
      inline-link primitive: Button variant="link" is a 40px-tall inline-flex
      control, not inline text."

   That is the whole argument, and it is the reason nobody should later
   "consolidate" TextLink into Button. Button's base string is
   `inline-flex items-center justify-center ... h-10` - a CONTROL. It is 40px
   tall, it is a flex container, and it centres its content. Dropping one of
   those into a running sentence (which is exactly what every site below is:
   a customer name inside a `<p>`, a phone number after a middot, a job number
   in a table cell) breaks the line box. Button's `link` structure paints the
   right colour on the wrong box. TextLink paints the right colour on a bare
   inline anchor and nothing else.

   WHY A SEPARATE FILE AND NOT A SECOND EXPORT FROM text.tsx. An anchor has
   interaction state (hover, focus, visited) and a routing concern
   (asChild / Slot, so the same primitive can wrap a react-router `<Link to>`
   or a bare `<a href="tel:">`). Inline text has neither. Keeping them apart is
   what lets Text stay the zero-class primitive it has to be; folding an
   interaction axis and a Slot into Text would give every `<span>` in the tree
   a routing prop it can never use.

   -----------------------------------------------------------------------------
   THE BASE STRING IS EMPTY, DELIBERATELY.

   `cva('')`. TextLink adds no focus treatment, no idle colour, no offset - not
   because those would be wrong, but because the hard constraint on phase 7 is
   that every existing default renders identically. All 8 measured call sites
   are bare anchors carrying only the classes the props below emit; each one
   currently takes the browser's own focus ring. Minting a token ring in the
   base string would change how every one of them looks when focused, which is
   a rendered change to an existing default. A designed focus treatment is a
   real follow-up, and it belongs in the phase that is allowed to restyle.

   Same reasoning kills a `cursor` prop. `cursor-pointer` appears once in the
   residue (the hand-rolled span at InvoicesPage:164, bucket H below), and a
   real anchor gets `cursor: pointer` from the user-agent stylesheet. Verified
   against this project's Tailwind 3.4.19: preflight sets that property
   explicitly for `button` and leaves `a` alone, so the UA rule survives. The
   token is retired by rendering the right ELEMENT, not by minting a prop.

   -----------------------------------------------------------------------------
   BUCKET H - A DELIBERATE BEHAVIOUR CHANGE, STATED HERE AND IN THE PR BODY.

   pages/InvoicesPage.tsx:164 is a link hand-rolled as a span:

     <span className="font-medium text-primary cursor-pointer hover:underline"
           onClick={() => window.location.href = ...}>

   Converting it to a TextLink retires all 4 of its appearance tokens AND
   fixes a real accessibility defect: today that element is not reachable by
   keyboard and announces no role, so a keyboard or screen-reader user cannot
   open the job at all. As a real anchor it becomes focusable - which means it
   ADDS a focus ring where none existed.

   That is the ONE place in this session where rendered behaviour deliberately
   changes, and the visual gate cannot catch it: the gate does not screenshot a
   focused state. It is desirable and it is intended. It must be reported, not
   discovered.

   -----------------------------------------------------------------------------
   MEASURED DEMAND. Every count below comes from the phase-6 guard exports
   (`targetFiles`, `findComponentTags`, `classNameTokens`, `classifyToken`,
   `stripComments`), not a grep.

   On the two tracer pages, 8 anchor sites carry 20 tokens between them:

     InvoicesPage.tsx:649          Link  font-medium text-primary hover:underline
     InvoicesPage.tsx:164          span  font-medium text-primary hover:underline
                                         + cursor-pointer            (bucket H)
     InvoiceDetailPage.tsx:698     Link  text-primary hover:underline font-medium
     InvoiceDetailPage.tsx:739     Link  text-primary hover:underline
     InvoiceDetailPage.tsx:755     Link  text-primary hover:underline
     InvoiceDetailPage.tsx:708     a     hover:text-primary hover:underline
     InvoiceDetailPage.tsx:717     a     hover:text-primary hover:underline
     InvoiceDetailPage.tsx:1093    Link  text-xs font-medium ... no-underline

   The 708/717 pair is why `tone` and `hoverTone` are two props and not one:
   those two sites set NO idle colour and inherit from the `<p>` they sit in,
   painting the brand colour only on hover. A single `tone` prop that emitted
   both halves would give them an idle colour they do not have today.

   1093 is the chip. TextLink owns only its typography and its `no-underline`;
   its border, radius and hover fill belong to the deferred `Chip` primitive
   (phase 9). `no-underline` classifies as `other` rather than `appearance`, so
   it never blocked the zero-appearance exit criterion - but leaving a bare
   utility at a call site when the primitive can express it is the habit this
   whole program exists to break, so `underline="none"` owns it.

   APP-WIDE DEMAND, for scale (NOT converted this session - only the two tracer
   pages are touched): `<Link>` carries 180 appearance tokens and `<a>` 155,
   dominated by hover:underline 47, text-primary 37, font-medium 31.

   ONE UNRESOLVED NAMING CONFLICT, RECORDED RATHER THAN DECIDED. The font-size
   prop below is called `size`. The settled vocabulary's rule 3 says `size`
   never means anything but control height on an absolute px ladder, and that a
   primitive whose scale is NOT a control height must name the dimension it
   moves - which is exactly why `Heading` calls its type-ramp prop `scale`,
   `Modal` calls its max-width `width` and `Card` calls its padding `pad`. A
   TextLink is inline text and has no control height, so by that rule this
   prop should be `scale` too.

   It is `size` here because the phase-7 work-list specifies `size` for both
   text primitives, and `Text` (components/ui/text.tsx) is being built in
   parallel against the same spec. Renaming one without the other would leave
   two sibling text primitives disagreeing, which is worse than either name on
   its own. The rename is one line in each file plus the call sites, and it
   should be taken as a single decision across `Text` and `TextLink` together.

   ONLY MEASURED CELLS ARE MINTED. `tone` and `hoverTone` have one value each
   because `brand` is the only colour either axis takes anywhere in the
   residue; `weight` has `medium` (x3) and `size` has `xs` (x1) for the same
   reason. Adding `danger`, `subtle`, `semibold` or `sm` is a one-line edit the
   moment a real call site needs one. Minting them now would be inventing an
   API against no evidence, which is the failure mode this phase is designed to
   avoid.
   ============================================================================= */

const textLinkVariants = cva('', {
  variants: {
    /**
     * Font size. Omit it and the link inherits from its container, which is
     * what 7 of the 8 measured sites do (they sit inside a sized `<p>`, `<td>`
     * or `<div>`). `xs` is the single site that sets its own: the chip at
     * InvoiceDetailPage:1093.
     */
    size: {
      xs: 'text-xs',
    },
    /** Measured x3: InvoiceDetailPage 698 and 1093, InvoicesPage 649. */
    weight: {
      medium: 'font-medium',
    },
    /**
     * IDLE colour. Omit it for a link that inherits its colour and only shows
     * the brand colour on hover - see `hoverTone`, and the two `tel:` / `mailto:`
     * anchors at InvoiceDetailPage:708 and :717 that need exactly that.
     */
    tone: {
      brand: 'text-primary',
    },
    /**
     * HOVER colour, independent of `tone`. Two props rather than one because
     * the residue contains both shapes: 4 sites set an idle colour and no
     * hover colour, 2 sites set a hover colour and no idle colour. Neither is
     * derivable from the other without changing what one of them renders.
     */
    hoverTone: {
      brand: 'hover:text-primary',
    },
    /**
     * Underlining. `hover` is the default because all 7 running-text sites
     * carry it; `none` is the chip at InvoiceDetailPage:1093, which suppresses
     * it outright. There is no third "inherit" value: no measured site omits
     * the axis, and Tailwind's preflight already makes a bare anchor inherit,
     * so a caller who genuinely wants that gets it by not using this primitive.
     */
    underline: {
      hover: 'hover:underline',
      none: 'no-underline',
    },
  },
  defaultVariants: {
    underline: 'hover',
  },
});

export interface TextLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof textLinkVariants> {
  /**
   * Render the child element instead of an `<a>`, forwarding these classes
   * onto it. This is how one primitive serves both a react-router
   * `<Link to="/jobs/1">` and a bare `<a href="tel:...">` without TextLink
   * knowing anything about routing. Implemented with Radix `Slot`, exactly as
   * `Button` does it.
   */
  asChild?: boolean;
}

/**
 * Inline text that navigates.
 *
 * `<TextLink asChild tone="brand" weight="medium"><Link to={...}>...</Link></TextLink>`
 * renders `class="font-medium text-primary hover:underline"` on the anchor
 * react-router produces - the exact token set InvoicesPage:649 hand-rolls
 * today.
 */
const TextLink = React.forwardRef<HTMLAnchorElement, TextLinkProps>(
  ({ className, size, weight, tone, hoverTone, underline, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'a';
    return (
      <Comp
        ref={ref}
        className={cn(textLinkVariants({ size, weight, tone, hoverTone, underline }), className)}
        {...props}
      />
    );
  }
);
TextLink.displayName = 'TextLink';

export { TextLink, textLinkVariants };
