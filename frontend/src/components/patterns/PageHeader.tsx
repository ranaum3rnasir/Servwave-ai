import * as React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Breadcrumb, type BreadcrumbItem } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';

/* =============================================================================
   PageHeader - phase 7e. The first component in the composition layer
   (`components/patterns/`, program plan section 2), which did not exist before
   this file.

   WHAT IT IS FOR, MEASURED
   Re-derived 2026-07-28 with the phase-6 guard exports (`targetFiles`,
   `findComponentTags`, `classNameTokens`, `classifyToken`, `stripComments`)
   over the 408 in-scope files. Section 1f's three headline numbers all
   reproduce exactly:

     112 page files in scope (targetFiles minus pages/design-system)
      35 of them carry their own <h1>            (36 <h1> tags - LeadFormPage
                                                  has two, one per branch)
      13 distinct <h1> class signatures

   And the slots below are each real, measured demand across those 36 sites:

       leading icon inside the <h1>                       12
       a text-text-secondary <p> right after the </h1>    15
       an actions row (justify-between container)         15
       none of the three                                   5
       <Breadcrumb> above the header      6 pages, 7 tags
       hand-rolled page-level back nav                     8 pages, 10 sites

   WHAT IT OWNS
   Title, optional leading icon, optional description, optional breadcrumb
   trail, optional back navigation, and an actions slot. It composes `Heading`,
   `Text`, `Stack`, `Button` and `Breadcrumb` and owns no feature copy and no
   data fetching, per the layering table in program plan section 2.

   IT AUTHORS NO APPEARANCE CLASS AT ALL
   `description` renders through the `Text` primitive, at the measured
   signature: of the 15 descriptions adjacent to an <h1>, 14 are
   `text-sm text-text-secondary` (the 15th is `text-[13px]`,
   MarketingAnalyticsPage.tsx:155) and only the top margin varies (mt-0.5 x5,
   mt-1 x4, none x2, mt-2 x1, mb-6 x1). `<Text as="p" size="sm"
   tone="secondary">` emits those two classes and nothing else, so the rendered
   <p> is byte-identical to the hand-rolled one 7e shipped - the assertion in
   PageHeader.test.tsx pins the exact string. Every class this file writes is
   now layout, on its own elements only, so the patterns layer carries zero
   appearance tokens.

   THE 13 <h1> SIGNATURES, AND WHICH ONES THIS COVERS
   Counts are <h1> tags, 36 in total. "Covered" means PageHeader renders that
   signature with no rendered delta.

   COVERED - 2 signatures, 18 of 36 sites (50%):
     x10  text-xl font-semibold text-text-primary
          -> <PageHeader title>. Byte-identical to Heading's default.
             CustomerFormPage, DashboardPage, InvoiceDetailPage, JobFormPage,
             LeadDetailPage, LeadFormPage (x2), reports/ReportStubPage,
             service-plans/ServicePlansPage, tasks/TasksHubPage
     x8   flex items-center gap-2 + the same three
          -> <PageHeader title icon>. The icon moves from inside the <h1> to a
             sibling inside the same `flex items-center gap-2` row; identical
             box model, and an <svg> with no accessible name contributed
             nothing to the heading's name either way.
             CustomersPage, EstimatesPage, InvoicesPage, JobsPage, LeadsPage,
             MarketingAnalyticsPage, StandaloneInvoiceFormPage, StatementPage

   NOT COVERED, DELIBERATELY - 11 signatures, 18 of 36 sites. Two reasons, and
   they do not overlap much:

   (a) `tracking-tight`, 4 signatures / 8 sites. Everything else in these
       matches the covered default exactly.
         x3  mt-1 tracking-tight + default   inventory/{Inventory,PurchaseOrders,Vendors}Page
         x2  flex items-center gap-2 + tracking-tight + default
                                             communication/{Inbox,WhatsApp}Page
         x2  tracking-tight + default        communication/{Phone,Text}Page
         x1  flex items-center gap-2 + mt-1 + tracking-tight + default
                                             inventory/PriceBookPage
       `Heading` has no letter-spacing axis: heading.tsx states it, with the
       measured eyebrow signature behind it, and defers it to W2. Adding a
       `tracking` className here would be a governed-component appearance
       override from outside the shared dirs - exactly what layering-guard
       counts. **If W2 gives Heading a `tracking` axis, coverage goes from
       18/36 to 26/36 (72%) and from 2/13 to 6/13 signatures with no change to
       this file's API.** That is the single highest-value follow-up.

   (b) not a standard page header at all, 7 signatures / 10 sites. Each is an
       entity hero, a nested app shell or a public document, and each wants a
       different type scale, weight or colour than a page title:
         x2  text-2xl font-semibold          CustomerDetailPage (entity hero),
                                             reports/ReportShell (report hero)
         x2  text-lg font-semibold           NotAuthorizedPage (error page),
                                             settings/SettingsLayout (nested shell)
         x2  text-2xl font-bold tracking-tight
                                             PublicInvoicePage (public document),
                                             workflows/WorkflowsHome (hero)
         x1  flex gap-x-2 items-baseline leading-tight min-w-0 text-2xl
                                             JobDetailPage (entity hero; no
                                             colour and no weight at all)
         x1  flex items-center gap-2 text-2xl font-semibold   ReportsPage
         x1  mb-2 text-xl font-bold text-primary              UpgradePage
         x1  text-base font-semibold         v2/communication/PhoneTabPage (separate app shell)

   WHY THERE IS NO `scale` / `weight` / `tone` PASSTHROUGH
   Forwarding Heading's three axes would "cover" 9 more sites by reproducing
   the drift in prop form, which is the defect section 1f is reporting, not a
   fix. 13 signatures exist precisely because no component owned the decision.
   The 10 sites in (b) are a second pattern - an entity/document hero - and
   phase 10 should mint it against its own measurement rather than have this
   one grow a size ladder. Mint a cell only where measured demand exists
   (program plan section 2a, rule 5).

   THREE SMALL DELTAS, STATED SO NOBODY FINDS THEM IN A DIFF AT 7f/11
   1. The back button renders `<ArrowLeft />` with no className. The three
      measured sites write `<ArrowLeft className="mr-1.5 h-4 w-4" />`; `h-4 w-4`
      is already Button's own `[&_svg]:size-4`, and `mr-1.5` stacks on top of
      Button's `gap-2`, so those sites render a 14px icon-to-label gap and this
      renders Button's own 8px. Converting them tightens that seam by 6px.
   2. The title/description seam is `gap={1}` (4px). Measured: mt-0.5 x5 (2px),
      mt-1 x4 (4px), none x2, mt-2 x1. 4px is the grid step and matches the
      second-largest group exactly; adopting it moves 5 sites by +2px and 1
      site by -4px, all at phase 11.
   3. The outer row uses `wrap`, not the responsive `flex-col sm:flex-row`
      that 2 measured sites use (workflows/WorkflowsHome, communication pages).
      `Stack` has no responsive props by design; a responsive axis is phase 9's
      `Box`/grid work.

   NOTHING HERE CHANGES AN EXISTING PIXEL. No page imports this yet.
   ============================================================================= */

/**
 * Back navigation. `to` renders a real link (right-click, middle-click and
 * open-in-new-tab keep working); `onClick` renders a button, for the
 * `navigate(-1)` shape. Both measured: 5 of the 10 hand-rolled sites are links
 * to a fixed parent route, 4 are `navigate(-1)`, 1 is `navigate('/estimates')`.
 */
export interface PageHeaderBack {
  /** Link target. Takes precedence over `onClick` when both are given. */
  to?: string;
  /** Click handler, for the `navigate(-1)` shape. */
  onClick?: () => void;
  /** Defaults to "Back". Measured labels: "Back" x4, "Back to Reports" x2, "Automations" x2, "Back to ServWave" x1. */
  label?: string;
}

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The page title. Rendered as the page's only `<h1>`. */
  title: React.ReactNode;
  /**
   * Leading icon, rendered as a sibling of the `<h1>` inside the same
   * `flex items-center gap-2` row the 12 measured icon sites use. Pass the
   * icon element, sized by the call site as it is today
   * (`<Receipt className="h-5 w-5 shrink-0 text-primary" />`); PageHeader does
   * not decide how big an icon is.
   */
  icon?: React.ReactNode;
  /** One line of supporting copy under the title. */
  description?: React.ReactNode;
  /**
   * Crumb trail above the header. Rendered through the shipped `Breadcrumb`
   * primitive with `showBack={false}`, so the back affordance stays in exactly
   * one place - the `back` prop - instead of two components both offering one.
   * Breadcrumb's own `mb-4` is the seam to the header below it, which is why
   * the outer Stack takes `gap={0}`.
   */
  breadcrumbs?: BreadcrumbItem[];
  /** Back navigation, rendered inline before the title. */
  back?: PageHeaderBack;
  /** Right-aligned actions. Anything - Buttons, a menu, a filter control. */
  actions?: React.ReactNode;
  /** LAYOUT only. Where the header sits, never what it looks like. */
  className?: string;
}

const PageHeader = React.forwardRef<HTMLDivElement, PageHeaderProps>(
  ({ title, icon, description, breadcrumbs, back, actions, className, ...props }, ref) => {
    // Only wrap the heading in a row when there is something to sit beside it.
    // A lone <h1> inside a flex row becomes a flex item and stops filling its
    // column, which changes where a long title wraps - so do not do it for
    // free.
    const heading = icon ? (
      <Stack direction="horizontal" align="center" gap={2}>
        {icon}
        <Heading>{title}</Heading>
      </Stack>
    ) : (
      <Heading>{title}</Heading>
    );

    const titleBlock = (
      <Stack gap={1} className="min-w-0">
        {heading}
        {description ? (
          <Text as="p" size="sm" tone="secondary">
            {description}
          </Text>
        ) : null}
      </Stack>
    );

    // `-ml-1` reproduces the optical alignment the three measured sites use, so
    // the ghost button's label lines up with the content below it. It is a
    // margin, which both guards classify as layout.
    const backLabel = back?.label ?? 'Back';
    const backControl = back ? (
      back.to ? (
        <Button variant="ghost" tone="subtle" size="sm" className="-ml-1" asChild>
          <Link to={back.to}>
            <ArrowLeft aria-hidden />
            {backLabel}
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          tone="subtle"
          size="sm"
          className="-ml-1"
          onClick={back.onClick}
        >
          <ArrowLeft aria-hidden />
          {backLabel}
        </Button>
      )
    ) : null;

    // Back sits inline before the title, centred against it - the shape all
    // three measured sites use (`flex items-center gap-3`). None of them also
    // carries a description, so back-plus-description is unmeasured; it renders
    // the button centred against the whole two-line block.
    const lead = backControl ? (
      <Stack direction="horizontal" align="center" gap={3} className="min-w-0">
        {backControl}
        {titleBlock}
      </Stack>
    ) : (
      titleBlock
    );

    // `items-start` once there is a description, `items-center` without one -
    // which is what the measured containers do (DashboardPage.tsx:45
    // `flex items-start justify-between gap-3` has one, ServicePlansPage.tsx:616
    // `flex items-center justify-between` does not).
    const body = actions ? (
      <Stack
        direction="horizontal"
        wrap
        gap={3}
        align={description ? 'start' : 'center'}
        justify="between"
      >
        {lead}
        <Stack direction="horizontal" wrap align="center" gap={2} className="shrink-0">
          {actions}
        </Stack>
      </Stack>
    ) : (
      lead
    );

    return (
      <Stack ref={ref} gap={0} className={className} {...props}>
        {breadcrumbs?.length ? <Breadcrumb items={breadcrumbs} showBack={false} /> : null}
        {body}
      </Stack>
    );
  }
);
PageHeader.displayName = 'PageHeader';

export { PageHeader };
