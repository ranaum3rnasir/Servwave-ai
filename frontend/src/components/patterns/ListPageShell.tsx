import * as React from 'react';

import { PageHeader, type PageHeaderProps } from '@/components/patterns/PageHeader';
import { Stack, type StackGap } from '@/components/ui/stack';

/* =============================================================================
   ListPageShell - phase 7e. The second component in the composition layer,
   composed from PageHeader (7e) and Stack (7d).

   WHAT IT IS FOR, MEASURED
   Re-derived 2026-07-28 with the phase-6 guard exports (`targetFiles`,
   `stripComments`) over the in-scope tree - 412 files today, up from the plan's
   408 because sibling agents are adding files to this same branch. Page scope
   is `targetFiles` restricted to `pages/`, minus `pages/design-system` and
   `pages/prototype`: 112 files, which reproduces section 1f exactly, 35 of them
   carrying their own <h1>.

   The list page has ONE shape in this tree, and it is unanimous. All five pages
   that pair an <h1> with a <DataTable> - CustomersPage, EstimatesPage,
   InvoicesPage, JobsPage, LeadsPage - render exactly this:

       <div className="space-y-6">
         <h1 ...>                 the page title
         <KpiStrip ... />         a strip between the title and the content
         <DataTable ... />        the content
         <Dialog ... />           overlays, trailing siblings, portalled
       </div>

   Five of five, same root class, same three bands, same order. That is what
   this component owns.

   THE ROOT SPACING, AND WHY THE DEFAULT IS gap={6}
   Root container of each of the 112 page files, taken from the default-exported
   component's own top-level `return (`:

       space-y-6                    9   including all 5 list pages above,
                                        plus ReportsPage, reports/ReportShell,
                                        reports/ReportStubPage,
                                        workflows/WorkflowsHome
       space-y-4                    7   CustomerDetailPage, DashboardPage,
                                        InvoiceDetailPage, JobFormPage,
                                        LeadFormPage, StandaloneInvoiceFormPage,
                                        StatementPage - detail and form pages
       p-4 space-y-4                2   MarketingAnalyticsPage, tasks/TasksHubPage
       p-6 space-y-6                1   service-plans/ServicePlansPage
       flex ... overflow-hidden     9   the inventory (4) and communication (4)
                                        full-height shells, plus CustomerFormPage

   `gap={6}` is therefore the measured list-page rhythm, and `gap` is a prop so
   the seven detail/form pages can adopt the same shell at `gap={4}` without a
   second component. Step list and the number-not-word decision are Stack's,
   settled in program plan section 2a.8.

   CONVERSION CAVEAT, restated from stack.tsx so nobody finds it in a 7f diff:
   `space-y-6` is `> * + *` margin on a BLOCK container; `gap-6` is a FLEX
   column. Identical for full-width block children, which is every child of all
   five list pages. It is not identical where the old container leaned on block
   layout - `margin: auto` centring, collapsing margins, floats, percentage
   heights. None of the five do.

   THE `band` SLOT, AND WHY IT IS NOT CALLED `toolbar`
   Measured occupant of the strip between the header and the content:
   `<KpiStrip>`, on 28 page files and on 5 of the 5 list pages. The only other
   thing measured in that position is EstimatesPage's conditional
   bulk-selection toolbar. `<FilterBar>` appears on exactly the same 5 list
   pages but is NEVER in this position - all 5 pass it into DataTable's own
   `filters` prop, so it is DataTable's business, not the shell's.

   Naming the slot `toolbar` would therefore describe 1 of its 6 measured
   occupants. `band` names the POSITION, which is what a pattern owns
   (program plan, layer table: patterns own "how recurring layouts assemble").
   Phase 10's `Toolbar` / `FilterBar` land in this same slot without a rename.

   The band is deliberately OUTSIDE the loading/empty router below: InvoicesPage
   passes `loading={isLoading}` straight into KpiStrip, which stays mounted and
   renders its own placeholders. A router that swapped the band away during load
   would delete that behaviour.

   THE `loading` / `empty` ROUTER - READ THIS BEFORE USING IT
   State it plainly: **page-level demand for this is 1 file in 112.** The
   measurement, over the whole in-scope tree:

       files with a loading gate that renders a placeholder      42  (50 sites)
         of which the placeholder is `animate-spin`              32
                                     <Skeleton>                   9
                                     "Loading..." text            4
                                     <EmptyState> as a loader     5
       files with an <EmptyState> behind a length check          60  (68 sites)
       files with BOTH, in the same file                          9
       page files with both                                       1  (SchedulePage)

   And for the five tracer list pages the answer is already written: DataTable
   owns it. `data-table.tsx:862` and `:992` are literally
   `isLoading ? <rows of placeholders> : rows.length === 0 ?
   <EmptyState title="No results found." /> : <rows>`, so InvoicesPage will
   convert at 7f WITHOUT touching these four props.

   Two consequences, both deliberate:

   1. There is NO default placeholder and NO default empty state. `loadingState`
      and `emptyState` are slots the call site fills, typically with the shipped
      `<Skeleton>` and `<EmptyState>` primitives. A default would have to invent
      a row height and a row count: the 109 `<Skeleton>` tags in the tree have
      no mode worth adopting (the most common className, `h-16 w-full`, is 6 of
      109), and Skeleton has no size axis until phase 8f. Minting geometry with
      no measured demand behind it is the drift this program exists to remove
      (program plan section 2a, rule 5).

   2. What the shell DOES own is the precedence, and that is worth owning.
      `loading` beats `empty` beats `children`, always. The inverse order is the
      classic flash of "No invoices yet" over a list that is still arriving, and
      the tree is exposed to it: 51 of the 60 files that render an EmptyState
      behind a length check have no loading gate in the same file at all. Where
      a flag is set but its slot was not filled, the router falls through to
      `children` rather than blanking the region - a missing slot can degrade to
      today's behaviour, never to an empty page.

      Recommendation for phase 10, recorded rather than assumed: re-measure
      these four props against real conversions. If 11a adopts the shell across
      ~33 pages and nothing fills `loadingState`, delete it.

   WHY `header` IS `PageHeaderProps` AND NOT A ReactNode SLOT
   Typing the slot as PageHeader's own props means this file cannot drift from
   PageHeader: there is no second copy of `title` / `icon` / `description` /
   `breadcrumbs` / `back` / `actions` to fall out of sync, which is precisely
   the 13-signature defect section 1f reports. It also makes "a list page has
   exactly one <h1>" structural rather than conventional.

   `header` is OPTIONAL, and that is measured too: 12 of the 13 `pages/settings/`
   files and 32 of the 34 `pages/reports/` files render no <h1> of their own
   because a shell above them already owns it (`settings/SettingsLayout.tsx:194`,
   `reports/ReportShell.tsx`). Requiring a header would lock 44 measured pages
   out of this shell or, worse, push them into emitting a second <h1>.

   WHAT IT DOES NOT DO
   - No `Toolbar`, no `DetailPageShell`. Both are phase 10, session W3.
   - No responsive axis. `Stack` has none by design; that is phase 9's Box/grid
     work.
   - No content wrapper element. The router's output is rendered as a direct
     child of the outer Stack, so a call site that passes several content
     siblings gets the same `gap` between them that `space-y-6` gives today.
     A wrapper would silently collapse that seam to zero.

   THIS FILE AUTHORS NO APPEARANCE AT ALL. It emits no className of its own -
   every class in its output comes from Stack, PageHeader or the caller's
   children - so it cannot move either guard. `className` is forwarded to the
   outer Stack for LAYOUT only, same contract as PageHeader.

   NOTHING HERE CHANGES AN EXISTING PIXEL. No page imports this yet.
   ============================================================================= */

export interface ListPageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * The page header, as PageHeader's own props. Rendered through `PageHeader`,
   * so the page gets exactly one `<h1>`.
   *
   * Omit it when a shell above this page already owns the `<h1>` - every page
   * under `pages/settings/` and `pages/reports/` is in that position today.
   */
  header?: PageHeaderProps;
  /**
   * The strip between the header and the content: a `KpiStrip` on all five
   * measured list pages, a bulk-selection toolbar on EstimatesPage, and phase
   * 10's `Toolbar` / `FilterBar` later.
   *
   * Stays mounted through the loading and empty states, because a KpiStrip
   * renders its own placeholders and must not be swapped out from under them.
   */
  band?: React.ReactNode;
  /**
   * True while the list is loading. Beats `empty`, always - that ordering is
   * the whole point of routing this here rather than at 60 call sites.
   */
  loading?: boolean;
  /**
   * What the content region shows while `loading`. Usually `<Skeleton>` rows.
   * There is no default: no measured placeholder shape exists to adopt. If this
   * is omitted while `loading` is true, the content region falls through to
   * `children` rather than blanking.
   */
  loadingState?: React.ReactNode;
  /** True when the list has loaded and has nothing in it. */
  empty?: boolean;
  /**
   * What the content region shows when `empty`. Usually `<EmptyState>`. Same
   * fall-through rule as `loadingState` when omitted.
   */
  emptyState?: React.ReactNode;
  /**
   * Vertical rhythm between header, band and content, in Stack's 4px-grid
   * steps. Defaults to 6 (24px), the `space-y-6` all five measured list pages
   * use. Detail and form pages measure at 4.
   */
  gap?: StackGap;
  /** LAYOUT only. Where the page sits, never what it looks like. */
  className?: string;
  /** The content region: the table, the grid, the list. */
  children?: React.ReactNode;
}

const ListPageShell = React.forwardRef<HTMLDivElement, ListPageShellProps>(
  (
    {
      header,
      band,
      loading = false,
      loadingState,
      empty = false,
      emptyState,
      gap = 6,
      className,
      children,
      ...props
    },
    ref
  ) => {
    // loading -> empty -> children. A flag with no slot behind it degrades to
    // children, so a half-wired call site renders today's list rather than a
    // blank region.
    let content = children;
    if (loading) {
      content = loadingState ?? children;
    } else if (empty) {
      content = emptyState ?? children;
    }

    return (
      <Stack ref={ref} gap={gap} className={className} {...props}>
        {header ? <PageHeader {...header} /> : null}
        {band}
        {content}
      </Stack>
    );
  }
);
ListPageShell.displayName = 'ListPageShell';

export { ListPageShell };
