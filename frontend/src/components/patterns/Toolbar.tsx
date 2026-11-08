import * as React from 'react';

import { Input, type InputProps } from '@/components/ui/input';
import { Inline, type InlineGap } from '@/components/ui/inline';

/* =============================================================================
   Toolbar - phase 10. The search-and-filter-row half of the composition
   layer (program plan section "Phase 10 - Complete the composition layer":
   "15 pages with a search input").

   NAMED `Toolbar`, NOT `FilterBar`. The plan's own heading writes
   "Toolbar / FilterBar" as two names for one idea, but
   `components/filters/FilterBar.tsx` already exists in this tree for a
   DIFFERENT concept - a facet-popover trigger button, not a search+filter
   row. Reusing "FilterBar" here would collide with that file's own name and
   mean two different things depending on which import a reader followed.
   `Toolbar` is unambiguous and unclaimed.

   MEASURED SHAPE (3 parallel Explore agents, 2026-07-30, re-checked against
   the live tree rather than carried from the plan's 2026-07-27 count). The
   common signature across the hand-rolled rows:
     `<div className="relative flex-1 ..."><Search className="absolute ..."
     /><input value=... onChange=... className="rounded-md border ..." /></div>`
   inside a row also carrying assorted filter controls (a Select, a
   segmented toggle, a popover trigger) and sometimes a trailing count.
   Sites AS MEASURED THEN, not a list of live call sites now - the v1
   `InventoryPage.tsx`, `PurchaseOrdersPage.tsx`, `VendorsPage.tsx` and
   `PriceBookPage.tsx` (groups tab), all then under `pages/inventory/`.
   None of those four is reachable today. `App.tsx` builds its whole route
   table from `v2Routes()`, and inventory routes to the `pages/v2/inventory/`
   fork, so the `pages/inventory/` originals went dead at that cutover.
   `InventoryPage.tsx` was deleted outright once the routed page reached
   parity with it, and `PurchaseOrdersPage.tsx` / `VendorsPage.tsx` followed
   in the purchasing clean-up (PRD-1, 2026-09); only `PriceBookPage.tsx`
   still exists, because a test file imports it directly. The list
   is kept because it records the SHAPE this component was measured against,
   annotated rather than left stale in the same spirit as
   switch.stories.tsx's own removed call site.
   The 5 `ListPageShell`-delegating pages (Customers/Estimates/
   Invoices/Jobs/Leads) and `pages/reports/_shared.tsx`'s own `ReportToolbar`
   already have an equivalent path and are not this component's job.

   WHY THIS FILE OWNS NO SEARCH-ICON COLOUR, AND WHY THAT IS NOT A
   WORKAROUND. `components/patterns` is ratcheted to a directory-wide
   appearance ceiling of 0 (component-api-guard.test.ts's `DIR_CEILINGS`) -
   every JSX tag this file authors is scanned, and any `text` colour class is
   classified APPEARANCE by that guard's own `APPEARANCE_RE`, with no carve-
   out for an icon. No Icon-tone primitive exists to delegate to either: the
   plan's own phase-7 evidence (`§7f`) records that an Icon primitive was
   built and reverted during phase 7 (name collision with the ubiquitous
   `const Icon = report.icon` pattern, reddened the layering guard repo-
   wide), and phase 9's table lists an Icon tone axis as still open. Building
   one here, inside a phase-10 composition pattern, would be exactly the kind
   of scope-widening CLAUDE.md's boundary rules ask to be surfaced rather
   than self-authorised. So `searchIcon` is a slot: the caller supplies an
   already-styled node (their own file, their own className, not scanned by
   this ceiling), and this file only wraps it in a LAYOUT-only positioning
   span (`absolute`, `left-`, `top-`, a transform - none of which match the
   guard's appearance prefixes). Same reasoning for `searchInputProps`: the
   left padding a leading icon needs (`pl-8`) is a PADDING class
   (`p[trblxy]?-` matches APPEARANCE_RE), so it cannot be hardcoded here
   either - it is the caller's to pass alongside their own icon, through a
   prop whose static value never appears in this file's own source text.

   `Input`, NOT A RAW `<input>`. Every measured site hand-styles its own
   `<input>` instead of using the shipped primitive - the exact bypass this
   whole program exists to close. Passing `searchInputProps` through lets a
   call site choose a `size` rung (VendorsPage's compact box is closest to
   `xs`, 32px) without this file inventing a new one.

   `filters` / `actions` ARE PLAIN SLOTS, NOT A CLOSED LIST. The measured
   filter controls are heterogeneous (a custom dropdown, a segmented toggle
   built from raw buttons, a Switch, a count `<span>`) and none of it is this
   component's to restyle - Toolbar owns the ROW, not what sits in it.
   Converting a segmented raw-button toggle to a real primitive is phase 11's
   job, not something this pattern should do as a side effect of adoption.

   ZERO APPEARANCE TOKENS AUTHORED HERE, CHECKED AGAINST THE GUARD, NOT
   ASSUMED. `relative`, `min-w-[240px]`, `flex-1`, `absolute`, `left-2.5`,
   `top-1/2`, `ml-auto`, `flex`, `items-center`, `gap-2` all classify as
   LAYOUT under `LAYOUT_RE`. `pointer-events-none` and `-translate-y-1/2`
   match neither list (classified `other`) and are likewise not counted.
   `components/patterns` inherits the directory ceiling of 0 on the day this
   file is added, the same way `DetailPageShell.tsx` and the two phase-7
   files already do.
   ============================================================================= */

export interface ToolbarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /**
   * Caller-styled icon rendered in a leading, absolutely-positioned slot.
   * Omit to render a plain, icon-less search box. See the header note for
   * why Toolbar does not colour an icon itself.
   */
  searchIcon?: React.ReactNode;
  /**
   * Forwarded to the internal search `Input` - e.g. `{ size: 'xs', className:
   * 'pl-8' }` to pair with `searchIcon`. Omit to render Input's own default.
   */
  searchInputProps?: Omit<InputProps, 'value' | 'onChange' | 'placeholder'>;
  /** Filter controls, rendered after the search box. */
  filters?: React.ReactNode;
  /** Right-aligned actions (a count, an export button, ...). */
  actions?: React.ReactNode;
  /** Space between the search box and each filter. Default matches Inline's own `gap={2}` (8px). */
  gap?: InlineGap;
}

/**
 * `<Toolbar>` with only `filters`/`actions` and no search props renders no
 * search box at all - the search half is opt-in via `onSearchChange`, not a
 * fixed slot every adopter must fill.
 */
const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(
  (
    {
      searchValue,
      onSearchChange,
      searchPlaceholder,
      searchIcon,
      searchInputProps,
      filters,
      actions,
      gap = 2,
      className,
      ...props
    },
    ref
  ) => (
    <Inline ref={ref} gap={gap} wrap align="center" className={className} {...props}>
      {onSearchChange && (
        <div className="relative min-w-[240px] flex-1">
          {searchIcon && (
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
              {searchIcon}
            </span>
          )}
          <Input
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            {...searchInputProps}
          />
        </div>
      )}
      {filters}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </Inline>
  )
);
Toolbar.displayName = 'Toolbar';

export { Toolbar };
