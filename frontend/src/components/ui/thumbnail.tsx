import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/* =============================================================================
   Thumbnail - phase 9 (program plan section 3, Phase 9 table: "Thumbnail |
   38 raw <img> | 32 size, 20 radius").

   MEASURED DEMAND. 38 raw `<img>` sites across the tree, outside
   `components/ui/`. Two distinct shapes live inside that count:

     1. FIXED-SQUARE LIST/ROW ICONS - a small product/item/attachment photo
        next to a name, always sized directly on the `<img>` itself
        (LineItemsEditor.tsx x3, AttachmentsPanel.tsx x2, PriceBookPage.tsx x2,
        AddGroupDialog.tsx x2, ApprovalDetailDialog.tsx, AssetDialog.tsx,
        LowStockActionDialog.tsx, EstimateDocumentView.tsx,
        EstimateLineItemsEditor.tsx, TechnicianGridView.tsx). 15 sites.
     2. FILL-MODE HERO/GALLERY IMAGES - `h-full w-full object-cover` inside a
        separately-sized, separately-radiused WRAPPER
        (AddItemDialog.tsx, AddCategoryDialog.tsx, AddBrandDialog.tsx,
        StageDetailDialog.tsx x2, PriceBookPage.tsx x2, JobFilesCard.tsx,
        PhotoAttachmentStrip.tsx, BrandingPage.tsx, AiImagePanel.tsx).

   This primitive targets shape 1 - the self-contained sized tile - which is
   what "32 size, 20 radius" describes: a call site naming both a dimension
   and a corner on the `<img>` element itself. Shape 2's radius lives on a
   wrapper `<div>` this component does not render (a `<Card>`/`overflow-hidden`
   concern, not an `<img>` concern) and is out of scope here.

   WHY RADIUS IS BAKED INTO THE BASE STRING, NOT A PROP.
   Every one of the 15 shape-1 sites carries a radius class on the `<img>`
   itself - 15 of 15, no exceptions - and every spelling used
   (`rounded` x11, `rounded-md` x2, `rounded-lg` x2) resolves to the same
   `--radius-control` / `--radius-card` value (both 6px in tailwind.config.js
   today). That is a constant, not a variable: nobody is choosing between two
   different radii, they are choosing between three synonyms for one radius.
   The closed vocabulary's five prop names (variant/tone/size/gap/pad) have no
   word for "corner radius" - `variant` is reserved for solid/outline/ghost/
   link - so a radius prop would mean inventing a sixth name, which this
   session's rules forbid. Baking `rounded` (the plurality spelling, 11 of 15)
   as a fixed base class is the same move card.tsx makes for `rounded-card`:
   evidence-backed, additive, and not worth a prop when there is no real
   choice to expose.

   `object-cover` is likewise baked in, with one measured exception: 14 of
   the 15 shape-1 sites use it. The one holdout is TechnicianGridView.tsx
   (the "connected device" tile, `h-10 w-10 object-contain shrink-0
   rounded`), which deliberately avoids cropping a device photo. Migrating
   that call site to `<Thumbnail>` needs an explicit `className="object-contain"`
   override (tailwind-merge lets it win over the baked-in `object-cover`,
   the same escape hatch the singleton diameters below rely on) - it is not
   evidence against baking `object-cover` in as the base, only a named
   exception to remember at migration time. Two further `object-contain`
   raw `<img>` sites in the tree - a customer signature
   (SignatureCard.tsx / PublicEstimatePage.tsx, same pattern) and
   an org logo (BrandingPage.tsx) - are fill mode shape-2 sites, not photo
   tiles, and are not this primitive's evidence either way.

   THE `size` SCALE. `size` is an ABSOLUTE ladder shared across every
   primitive that carries the prop (closed vocabulary rule 2) - Thumbnail
   does not get to pick its own pixel values, it can only mint the rungs of
   the one shared six-rung table it has measured demand for:

     3xs  24px   2xs  28px   xs  32px   sm  36px   md  40px   lg  44px

   Real diameters observed on shape-1 sites, in order of frequency: 40px
   (`h-10 w-10`) x6, 56px (`h-14 w-14`) x4, then five singletons - 24px,
   28px, 32px, 36px, 48px - one site each. Three of those land on ladder
   rungs with real demand behind them:

     3xs  24px  h-6 w-6   (AddGroupDialog.tsx:492 - a referenced-item row)
     xs   32px  h-8 w-8   (EstimateLineItemsEditor.tsx:119)
     md   40px  h-10 w-10 (LineItemsEditor.tsx x3, AttachmentsPanel.tsx x2,
                           TechnicianGridView.tsx - the dominant rung, DEFAULT)

   `md` keeps both its old name and its old pixel value (40px) - it was
   already the correct absolute rung under the four-rung relative draft this
   file first shipped with this session, so the default needed no migration
   (rule 2: the default is pinned to whichever named rung matches the
   primitive's current rendered height, and 40px already was that height).

   56px (`h-14 w-14`, 4 sites: EstimateDocumentView.tsx,
   LowStockActionDialog.tsx, AssetDialog.tsx, PriceBookPage.tsx:908) was the
   second-most-common measured signature - real repeat-cluster demand, not a
   one-off - but the six-rung ladder tops out at `lg` = 44px and has no rung
   for 56px anywhere in the table. A value with demand but no matching rung
   has exactly two honest resolutions: snap it to the nearest real rung
   (44px, a genuine geometry change that would move all 4 real call sites
   off their measured diameter - not done here), or drop it from the named
   `size` vocabulary and let those sites carry a bespoke className override
   at migration time, the same mechanism the true singletons below already
   use. This file takes the second path. Critically, 56px also cannot be
   kept alive under the old name `lg` as a deprecated alias, the way a
   renamed prop's old values normally stay live - rule 2 makes `size` an
   ABSOLUTE ladder, so `size="lg"` must mean 44px on every primitive that has
   the prop, full stop; a `lg` that rendered 56px here would itself be a
   fresh instance of the exact violation this fix exists to close. In
   practice this is not a breaking change: Thumbnail is a brand-new
   primitive, authored and corrected within this same session, with zero
   call sites anywhere in the tree migrated to it yet (see MEASURED DEMAND
   above - all 15 shape-1 sites are still raw `<img>`), so there is no real
   caller anywhere relying on `size="lg"` meaning 56px. The same reasoning
   forecloses keeping the old names `xs` (previously 24px) and `sm`
   (previously 32px) as dual-meaning aliases - the ladder now claims those
   exact strings for 32px and 36px respectively, so a `size="xs"` that still
   rendered 24px would violate the same invariant.

   The remaining three true singletons (28px `h-7 w-7` AddGroupDialog.tsx:568,
   36px `h-9 w-9` PriceBookPage.tsx:758, 48px `h-12 w-12`
   ApprovalDetailDialog.tsx:466) still do not get a named rung of their own -
   each is a one-off with no repeat, matching Avatar's own precedent for its
   own singleton diameters (avatar.tsx). 28px and 36px now have exact
   name matches on the ladder (`2xs`, `sm`), but a single call site each is
   the same evidence the original four-rung draft already weighed and
   rejected for these two pixel values (rule 5: mint only where measured
   demand exists) - the vocabulary rewrite renames rungs, it does not
   manufacture new demand, so `2xs` and `sm` stay unminted here too. All four
   out-of-ladder diameters (28px, 36px, 48px, and now 56px) keep a bespoke
   className override, which `cn`'s tailwind-merge still lets win over
   `size`'s h-w classes.

   `variant="outline"`. Of the 15 shape-1 sites, 9 carry some border treatment
   and 6 carry none. Of the 9, `ring-1 ring-border` (6 sites: AddGroupDialog.tsx
   x2, PriceBookPage.tsx:758, ApprovalDetailDialog.tsx, AssetDialog.tsx,
   PriceBookPage.tsx:908) outnumbers `border border-border` (3 sites:
   AttachmentsPanel.tsx x2, LowStockActionDialog.tsx). A ring is also the
   better fit mechanically - it paints via box-shadow, so it never changes the
   element's own box the way a `border` would on a fixed h-N w-N tile. Only
   `outline` is minted; `solid`/`ghost`/`link` have no meaning on an image tile
   and no measured demand. No default - a bare `<Thumbnail>` renders no ring
   class, matching Stack/Inline/Text/Box's shared anti-goal: a primitive that
   says nothing paints nothing extra.

   NOT COVERED, DELIBERATELY:
   - `tone`. No shape-1 site carries a semantic-colour class; a Thumbnail
     always renders the image it is given, never a placeholder colour of its
     own. The empty/no-photo state at every one of these call sites is a
     sibling `<div>`, not this component.
   - `gap` / `pad`. A single self-closing `<img>` has no children to space and
     no measured internal-padding demand.
   - Shape 2 (fill mode hero/gallery images). No single fixed geometry to
     scale against - each site's wrapper picks its own aspect ratio
     (`aspect-square`, `aspect-[2/1]`, `aspect-[4/3]`, `h-24`/`h-28`/`h-40`
     w-full). Forcing that population through a four-rung `size` scale would
     be inventing a shape nothing measured asked for.
   ============================================================================= */

export type ThumbnailSize = '3xs' | 'xs' | 'md';

const thumbnailVariants = cva('rounded object-cover', {
  variants: {
    /**
     * Rendered diameter (square), on the closed vocabulary's absolute
     * six-rung ladder (3xs=24, 2xs=28, xs=32, sm=36, md=40, lg=44px) - only
     * the three rungs with measured demand are minted here (see header).
     * `md` is the dominant real signature (`h-10 w-10`, 6 of 15 shape-1
     * sites) and is always the default; 56px (previously named `lg` under
     * the old relative scale) has no matching rung on the shared ladder and
     * is not a `size` value at all anymore - see header for why it cannot be
     * kept as a deprecated alias.
     */
    size: {
      '3xs': 'h-6 w-6',
      xs: 'h-8 w-8',
      md: 'h-10 w-10',
    },
    /**
     * Structural appearance. Only `outline` is minted - a tile bordered by a
     * ring, the more common of the two real border treatments. No default: a
     * bare Thumbnail renders no border class at all.
     */
    variant: {
      outline: 'ring-1 ring-border',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

export interface ThumbnailProps
  extends React.ImgHTMLAttributes<HTMLImageElement>,
    VariantProps<typeof thumbnailVariants> {}

/**
 * `<Thumbnail src={...} alt={...} />` with no other props renders
 * `<img class="rounded object-cover h-10 w-10">` - the dominant real
 * shape-1 signature (see header) and the closed vocabulary's `md` rung
 * (40px). There is no pre-existing default to preserve since this
 * primitive is new; `md` is chosen because it is both the most common call
 * site and the absolute rung that already matched Thumbnail's pre-fix
 * rendered height, so no default migration was needed.
 */
const Thumbnail = React.forwardRef<HTMLImageElement, ThumbnailProps>(
  ({ className, size, variant, ...props }, ref) => (
    <img
      ref={ref}
      className={cn(thumbnailVariants({ size, variant }), className)}
      {...props}
    />
  )
);
Thumbnail.displayName = 'Thumbnail';

export { Thumbnail, thumbnailVariants };
