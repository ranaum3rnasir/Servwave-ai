# Reports - components with no kit equivalent

Module 9. Built under `frontend/src/pages/v2/reports/`: 4 top-level pages
(`ReportsPage`, `ReportRoute`, `ReportStubPage`, `MarketingAnalyticsPage`),
9 shared components, a v2 `reports-registry.ts`, and 24 report components
(23 registry slugs + `GenericReport`, the fallback `ReportRoute` renders
directly for any known catalog slug with no bespoke page - it is not a
registry entry in either layer).

Routes: `/reports`, `/reports/:slug`, `/marketing`, registered by
`routes/reports.paths.ts` + `routes/reports.routes.tsx`.

---

## Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| `components/charts` (all 10) | component | 17 imports across GenericReport, Revenue, InventoryUsage, ItemsServices, ArAging, Estimates, JobProfitability, Payments, TechPerformance, Expenses, CampaignRoi, JobStatistics, EstimateConversion, Sales, Marketing, comm-tracking/QaTab | the app's chart family | **none - the kit ships no chart component of any kind** | Reused verbatim, by instruction. Colour inside a chart carries meaning | Dashboard | **KEEP** |
| `components/charts/chartTheme` (`chartLabelStyle`) | component | 7 reports | shared chart label typography | none | same boundary as above | Dashboard | **KEEP** |
| `design-system/tokens` (`token()`, `chartPalette`, `severityRamp`) | component | every charting report | the token accessors chart props read | none | a kit token substituted inside a chart prop is a behaviour change | Dashboard | **KEEP** |
| `components/ui/collapse` | component | ArAgingReport | animated height disclosure | none - the kit has no accordion, disclosure or collapse | there is nothing to swap to | - | **KEEP** |
| `components/timeclock/GeofenceSettingsDialog` | component | TimesheetsReport | the geofence settings dialog, owns its own mutations | none | domain component, not a primitive | - | **KEEP** |
| `components/timeclock/EmployeePayrollCard` | component | TimesheetsReport | the payroll card, owns the OT approve/reject flow | none | domain component with real behaviour | - | **KEEP** |
| `components/communication/phone/CallsTable` | component | CallTrackingReport | the Phone module's call list | `data/dataTable` | rebuilding it is exactly the drift the reuse exists to prevent - this report and the Phone Calls tab must stay identical | - | **KEEP** |
| `components/communication/phone/CallsView` (`CallDetailDrawer`) | component | CallTrackingReport | the per-call detail drawer | `ui/sheet` | the kit Sheet is a shell; the drawer is the Phone module's own content | - | **KEEP** |
| `components/data/status-badge` (`StatusBadge`) | component | EstimateConversionReport | renders a REAL backend enum through the status registry | `ui/badge` | Badge has a closed variant vocabulary and no registry lookup; this is the one place Reports shows a real EstimateStatus rather than a synthetic report taxonomy | Invoices, Estimates | **KEEP** |
| `components/ui/use-toast` | component | CallTrackingReport | the app toast | `ui/sonner` | CallDetailDrawer's onToast callback is fed by the app toast; swapping only the caller would split toasts across two systems on one page | - | **KEEP** |
| `data/dataTable` **footer / tfoot** | kit API | ArAging, Commissions x2, Expenses, Invoices, JobProfitability, Payments, Sales, TechPerformance, Timesheets | a totals row aligned under its columns | the prop does not exist | DataTable renders header, body and pagination only; `children` renders ABOVE the body, so there is no slot below it either. Totals now render as a labelled ReportTableTotals strip beneath the table | - | **BUILD** |
| `data/dataTable` **rowClassName** | kit API | ItemsServices, Expenses, CampaignRoi, JobStatistics | per-row tint driven by row data | the prop does not exist | four row tints dropped; in each case the same signal already exists in a cell | - | **BUILD** |
| `data/dataTable` **stickyHeader / flat** | kit API | JobStatistics, EstimateConversion | a scrolling table with a pinned header, and a borderless variant for a table already inside a card | neither prop exists | the kit table always draws its own card frame and never scrolls its own body | - | **BUILD** |
| `ui/progress` **tone** | kit API | comm-tracking/CadenceTab | a bar whose fill is the severity band | the indicator is hard-coded `bg-brand` | the band (under/healthy/over) IS the reading of that column, so the bar stays hand-built out of kit status tokens | - | **BUILD** |
| **Heading** | component | 20 of 24 report files | a section/card title | none - `layout/pageHeader` titles a PAGE only | `components/heading.tsx` renders role=heading + aria-level on a div, the same answer four earlier modules reached | Leads, Customers, Estimates, Invoices | **BUILD** |
| **Tabs** | component | ReportsPage, Timesheets, CommunicationTracking, JobStatistics | a tab strip | none | imports `pages/v2/leads/components/tabs.tsx` rather than writing a tenth copy | Leads, Customers, Estimates, Invoices, Service Plans, Jobs | **BUILD** |
| **Toggle group / segmented control** | component | 11 reports | a 2-4 state exclusive control | none | every one is now a role=radiogroup of kit Buttons switching variant, with aria-checked the raw controls never had | Customers, Service Plans (as RadioGroup) | **BUILD** |
| `data/KpiStrip` **icon + sub caption** | kit API | 22 reports | an icon per tile and a muted caption under the value | `data/statCard` has neither | the icon is dropped by design (StatCard documents why); sub maps onto the delta chip, following the Leads precedent. `components/kpi.tsx` still accepts icon/tone/emphasize so call sites port unchanged, and ignores them | Leads, Jobs, Customers, Invoices, Estimates, Service Plans, Tasks | **BUILD** |

---

## Replaced (the audit trail)

Every `@/components/...` import found across `pages/ReportsPage.tsx`,
`pages/MarketingAnalyticsPage.tsx` and the 35 files in `pages/reports/`,
with what it became.

| Old component | Replaced by | Notes |
|---|---|---|
| `components/data/KpiStrip` (KpiStrip, KpiTile) | `ui-kit/components/data/statCard` via `v2/reports/components/kpi.tsx` | 22 call sites; same item shape, icon/tone/emphasize accepted and ignored |
| `components/data/ResizableTable` | `ui-kit/components/data/dataTable` via `v2/reports/components/reportTable.tsx` | 20 call sites; the id/header/cell/width/min/grow/align/sortValue column model is mapped, not restated. enableColumnResizing + mobileCards on |
| `components/ui/empty-state` | `ui-kit/components/data/emptyState` | 26 call sites; variant="card" becomes an EmptyState inside a kit Card, density="compact" dropped |
| `components/ui/heading` | `v2/reports/components/heading.tsx` (ReportHeading) | 23 call sites; gap row above |
| `components/ui/button` | `ui-kit/components/ui/button` | 14 call sites |
| `components/form/SelectField` | `ui-kit/components/ui/select` | 16 call sites |
| `components/ui/modal` (Modal) | `ui-kit/components/ui/dialog` | Jobs/Leads/Sales Fields modal, now one shared `components/fieldsPicker.tsx` |
| `components/ui/sheet` | `ui-kit/components/ui/sheet` | EstimateDetailPanel, EstimateConversion drill panel; body moves to SheetBody |
| `components/ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | ActivityFilterBar facets |
| `components/data/filter-chip` (FilterChip) | `ui-kit/components/ui/badge` + a Button close | ActivityFilterBar applied chips |
| `components/jobs/overview/SectionCard` | `ui-kit/components/ui/card` + ReportHeading | Commissions three summary panels |
| `design-system/status-registry` (STATUS_INTENT_CLASSES) | `ui-kit/components/ui/badge` soft variants | Jobs/Leads/Invoices/Commissions synthetic report taxonomies only - all local maps, not real backend enums. STATUS_REGISTRY itself is still imported by Timesheets for the punch-review intent |
| `lib/utils` cn | `ui-kit/lib/utils` cn | 22 call sites |
| `pages/reports/_shared` MultiSelectFilter, FacetFilter, ReportToolbar, ReportPager, ReportSelectTrigger | `v2/reports/components/shared.tsx` | rebuilt on kit Button/Input/Select/DropdownMenu |
| `pages/reports/_shared` hashStr, mulberry32, rangeRnd, Delta, Sparkline | **re-exported from the legacy module** | pure arithmetic and two token-only renderers; a copy would be a second definition |
| `pages/reports/DateRangeControl` | `v2/reports/components/dateRangeControl.tsx` | kit Card + DropdownMenu + Input; the Opt type is imported from the legacy module |
| `pages/reports/ReportShell` | `v2/reports/components/reportShell.tsx` | kit PageHeader; icon medallion dropped |
| `pages/reports/ReportCard` | `v2/reports/components/reportCard.tsx` | kit Card; left accent bar dropped |
| `pages/reports/ActivityFilterBar` | `v2/reports/components/activityFilterBar.tsx` | kit DropdownMenu + Badge |
| `pages/reports/MetricDetailPanel` | `v2/reports/components/metricDetailPanel.tsx` | kit Card; bar fills stay inline |
| `pages/reports/PersonMetricPanel` | `v2/reports/components/personMetricPanel.tsx` | kit Card |
| `pages/reports/EstimateDetailPanel` | `v2/reports/components/estimateDetailPanel.tsx` | kit Sheet |
| `lib/csv`, `lib/axios`, `lib/date-range`, `lib/format-date`, `lib/entitlements`, `lib/entitlements/catalog`, `lib/useIsDemoOrg`, `lib/ability`, `lib/api/*`, `lib/timeclock/*`, `contexts/AbilityContext`, `stores/auth.store`, `constants/estimateStatus` | **unchanged, imported** | business logic - never forked |
| every `pages/reports/*-data.ts` and `*-logic.ts` (24 modules) | **unchanged, imported** | including report-catalog, arAging.data, payments-report-logic, estimates-report-logic, activity-logic, expenses-logic, items-services-logic, communication-tracking-logic, call-tracking-logic, estimate-conversion-logic |
| `pages/reports/LeadsReport` (LEADS, Lead), `pages/reports/JobsReport` (buildMockJobs, Job, Status) | **unchanged, imported through their data modules** | those fixtures are shared with the live DTO rehydration; a copy would drift |

---

## Shape differences forced by the kit

- **tabs.tsx is imported, not copied.** ReportsPage, TimesheetsReport,
  CommunicationTrackingReport and JobStatisticsReport all import
  `pages/v2/leads/components/tabs.tsx`. No tenth copy was made.
- **fieldsPicker.tsx is a deliberate de-duplication.** Jobs, Leads and Sales
  each shipped a byte-identical FilterPanel and FieldsModal; the v2 module has
  one copy at `pages/v2/reports/components/fieldsPicker.tsx`. That is within
  this module, so it does not need the consolidation pass.
- **reportTable.tsx is an adapter, not a second table.** It maps the legacy
  ResizableColumn model onto TanStack ColumnDef and renders the kit DataTable;
  no table behaviour is reimplemented.
- **Every segmented control gained aria-checked** (and every two-state pill
  aria-pressed) that the raw buttons did not have.
- **Td wraps the kit TableCell** (`components/td.tsx`). The kit's TableCell has
  no alignment, weight or tone prop, so 60 call sites were setting those classes
  on the primitive - exactly what the component-API ratchet forbids. They now go
  on a block wrapper inside the cell; TableCell itself carries nothing.
- **No appearance class is passed to Card, EmptyState, Badge or TableCell**
  anywhere in this module. All four ratchets sit at their exact floors (2 / 5 /
  10 / 3) with zero contribution from Reports. Card padding overrides were
  dropped for the kit default, the two detail panels lost their brand border,
  and ReportCard moved its padding, hover and deferred state onto the Link that
  fills it.
- **The Fields dialog export is `FieldsPicker`, not `FieldsDialog`.** The
  shadow-component guard flags any export whose name contains `Dialog` unless
  the file imports the LEGACY `@/components/ui/dialog`; a kit-based dialog can
  only satisfy it by not claiming the name.
- **Delta and Sparkline were defined twice in the legacy module** - once in
  `_shared.tsx` and once inside `TechPerformanceBoard.tsx`, byte-identical.
  v2 imports the shared pair once.

---

## Behaviour not reproduced

| What the legacy page did | What v2 does instead | Why it could not be carried over |
|---|---|---|
| 9 tables rendered a tfoot totals row aligned under its columns | totals render as a labelled ReportTableTotals strip immediately beneath the table, each entry keeping its column header as its label | the kit DataTable has no footer slot and no below-body slot at all |
| ItemsServices tinted a row when over expected by more than 15% | no tint; the vs-Exp cell is already red past +5% | DataTable has no rowClassName |
| Expenses tinted the expanded row | no tint; the row chevron rotates and the drill-down chart opens below | same |
| CampaignRoi tinted the most-profitable row | no tint; that row carries a "Most profitable" badge | same |
| JobStatistics tinted the selected tech row | no tint; the trend heading and the history table both name the selected tech, and a "Show all techs" link clears it | same |
| JobStatistics call-back history table was stickyHeader + flat inside a card, capped at max-h-96 | a normal table, page-scrolled | the kit table has neither prop |
| EstimateConversion drill table was flat (borderless, inside a card) | draws its own card frame | same |
| Per-user saved column WIDTHS via ResizableTable internal state | column widths are per-session | pre-existing: ResizableTable never persisted them either. The Fields visibility list still persists - each report keeps its own localStorage key (jobsReport.visibleFields.v1, leadsReport..., salesReport...) |
| KPI tiles carried a lucide icon | no icon | StatCard has no icon slot, by design |
| ReportCard drew a 3px left accent bar, and lifted on hover | a hover fill on the link, no lift | the accent bar hover class is one of the 54 the unresolved-class guard reports as producing no CSS, so it never drew; the lift went with the Card appearance overrides the ratchet forbids |
| ReportShell drew a round icon medallion beside the title | no medallion | PageHeader has no icon slot; the icon is still on the card the reader clicked to get here |
| EmptyState density="compact" on two panels | default density | the kit EmptyState has no density axis |

---

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| The pager reports totalItems from `filtered` while it pages `scoped`, so the "showing X of N" count disagrees with the list whenever a KPI card is active | `pages/reports/JobsReport.tsx` (reproduced verbatim in v2) | a real off-by-scope bug; fixing it inside a restyle would hide a behaviour change in a presentation diff |
| ReportPager default variant renders "Showing 1-0 of 0" rather than an empty label when there are no rows; only the compact variant has emptyLabel | `pages/reports/_shared.tsx` ReportPager | pre-existing asymmetry between the two variants |
| CommissionsReport hard-codes the start index of its "Showing 1 to N of M" line, so it never reflects a page offset | `pages/reports/CommissionsReport.tsx` | the report has no pager at all, only a "show N entries" cap, so the sentence is misleading rather than wrong |
| MarketingAnalyticsPage is entirely mock data with no /api/marketing behind it | `pages/MarketingAnalyticsPage.tsx` | known and deliberate; the route is DemoOnlyRoute-gated in both layers |
| JobStatisticsReport declares both money2 and money0 as the same formatCurrencyWhole call | `pages/reports/JobStatisticsReport.tsx` | harmless duplication; renaming would churn about 20 call sites for no behaviour change |
| CampaignRoiReport added sources are session-only and silently lost on reload | `pages/reports/CampaignRoiReport.tsx` | stated in the page own footnote; it is mock-phase behaviour |
| reports-registry.ts exists twice (legacy + v2) with the same 23 slugs and no test tying them together | `pages/reports/reports-registry.ts`, `pages/v2/reports/reports-registry.ts` | the v2 file own comment names the risk. A parity test is a sensible follow-up but adding one now would be new scope |
