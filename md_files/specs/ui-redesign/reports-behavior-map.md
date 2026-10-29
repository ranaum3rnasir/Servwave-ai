# Reports module - behaviour map (UI-kit migration, Phase 1)

Module 9 of `md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`. Branch
`refactor/ui-kit-09-reports`. Routes `/reports`, `/reports/:slug`, `/marketing`.
Read from `main` @ `7dfa18e9`.

> Persisted by the orchestrator: the mapping agent was blocked from writing this
> file directly, so the content below is its verbatim output.

Scope read: `App.tsx`, `components/DemoOnlyRoute.tsx`, `pages/ReportsPage.tsx`,
`pages/MarketingAnalyticsPage.tsx`, all 36 files under `pages/reports/` (incl.
`comm-tracking/`), `design-system/tokens.ts`, `components/charts/`,
`components/ui/{KpiStrip,ResizableTable}.tsx`,
`lib/{useIsDemoOrg,ability,api/timeclock,api/service-plans}`,
`backend/src/routes/report.routes.ts`, plus `origin/fix/starter-basic-reports-set`
and `origin/fix/1021-advanced-reports-unbuilt`.

Largest module by file count but **not** by behavioural surface: ~30 report pages
share one shell, one card, one table, one KPI strip, one chart wrapper. Migration
leverage is in those ~8 shared pieces.

## 1. Routes and guards

### 1.1 `/reports` and `/reports/:slug` - `App.tsx:142-147`

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
  <Route path="/reports"       element={<ReportsPage />} />
  <Route path="/reports/:slug" element={<ReportRoute />} />
</Route>
```

- Sits inside the outer authed block (`allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']}`
  + `<AppLayout />`, `App.tsx:111-112`); auth + layout enforced upstream.
- Inner guard narrows to **ADMIN + DISPATCHER** with `fallback` set. In-code reason:
  the backend 403s Sales on `/api/reports/*`.
- Both pages are `React.lazy` (`App.tsx:30-31`).
- Backing authority: `backend/src/lib/permissions/defaultGrants.ts:119` grants
  `read Report` to `DISPATCHER`; ADMIN via manage-all. Sales and Technician have no
  grant, so nav + cards + API all deny.
- The exact `fallback` render was not opened - see Q1.

### 1.2 `/marketing` - `App.tsx:148-152`

```
<Route element={<DemoOnlyRoute />}>
  <Route path="/marketing" element={<MarketingAnalyticsPage />} />
</Route>
```

`DemoOnlyRoute.tsx` is 19 lines: `useIsDemoOrg()` -> if false,
`<Navigate to="/" replace />`; else `<Outlet />`. **No role narrowing** - any authed
role in a demo org reaches it. Pairs with `nav-registry.ts:83` (`demoOnly: true`,
greyed "coming soon").

### 1.3 Nav entry points (`components/layout/nav-registry.ts`)

| key | label | href | gate |
|---|---|---|---|
| `reports` | Reports | `/reports` | `read Report` |
| `billing` | Billing | `/reports/ar-aging` | `read Report` |
| `marketing` | Marketing | `/marketing` | `read Report` + `demoOnly: true` |
| `rpt-job-profit` | Job Profitability | `/reports/job-profitability` | `read Report`, pinnable only |
| `rpt-rep-board` | Salesperson Leaderboard | `/reports/rep-leaderboard` | `read Report`, pinnable only |
| `rpt-revenue` | Revenue | `/reports/revenue` | `read Report`, pinnable only |
| `rpt-payments` | Payments Collected | `/reports/payments` | `read Report`, pinnable only |
| `rpt-tech-perf` | Technician Performance | `/reports/tech-performance` | `read Report`, pinnable only |

`rpt-*` rows are not in the default sidebar (Add-shortcut only). v2 must not change
these hrefs.

## 2. The shared shell architecture (the core)

### 2.1 Landing - `pages/ReportsPage.tsx` (127 lines)

One `useState<ReportTab>('main')`; `ReportTab = 'main' | ReportGroup | 'custom'`.

1. **Heading row** - `LineChart` icon + "Reports"; two **inert placeholder** actions:
   violet text button "Create report with AI" (`Sparkles`) and primary `Button`
   "Create report" (`Plus`). Both `title="Coming soon"`, **no `onClick`**. Keep inert in v2.
2. **Tab bar** - local `TabButton` (`-mb-px border-b-2` underline). Order: `Main`, then
   `reportGroupOrder` = `['Sales','Finance','Operations','Marketing']`, then
   `Custom reports`. Container `border-b border-border`.
3. **Body**, three branches:
   - `main` -> grid `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` of `mainCards`
   - `custom` -> dashed panel "No custom reports yet" / "Build your own report with the
     "Create report" button. Coming soon."
   - group tab -> same grid of `activeReports`, or dashed panel "No {tab} reports
     available for your role."

Card-set derivation (two rules, ANDed):

```ts
visibleReports = reportCatalog.filter(r =>
  ability.can('read', r.subject) && canShowReport(r, isDemoOrg))

mainCards = mainReports.map(m => { const report = findReport(m.slug);
  return report && ability.can('read', report.subject) && canShowReport(report, isDemoOrg)
    ? { ...report, label: m.label, code: undefined }   // Workiz wording, badge stripped
    : null }).filter(Boolean)

activeReports = visibleReports.filter(r => r.group === tab && !r.mainOnly)
```

Two consequences: Main-tab cards **override label** and **drop `code`** (no S1/F4 badge
on Main); `mainOnly: true` reports are hidden from their category tab to avoid duplication.

### 2.2 The catalog - `pages/reports/report-catalog.ts` (217 lines)

Two layers under four tabs: the 33-report strategic suite (`S1..S9`, `F1..F8`, `O1..O8`,
`M1..M8`) and legacy entity reports (no `code`).

```ts
export interface ReportDef {
  code?: string;          // 'S1' | 'F4' | 'M8' ... absent on entity reports
  slug: string;           // URL segment: /reports/<slug>
  label: string;
  icon: LucideIcon;
  group: 'Sales' | 'Finance' | 'Operations' | 'Marketing';
  subject: AppSubject;    // CASL subject the user must be able to `read`
  deferred?: boolean;     // M8 only - muted card + "Deferred" badge
  live?: boolean;         // has a real DB-backed data path
  mainOnly?: boolean;     // show only on the Main tab
}
```

Exports: `reportCatalog` (49 entries), `reportGroupOrder`, `mainReports` (16 curated
Main-tab entries, Workiz labels + order), `findReport(slug)`,
`canShowReport(report, isDemoOrg)`.

```ts
export function canShowReport(report, isDemoOrg) {
  return !!report && (isDemoOrg || !!report.live);   // fails closed on undefined
}
```

`live: true` on `main` (11 slugs): `estimate-conversion`, `leads`, `estimates`,
`revenue`, `ar-aging`, `payments`, `invoices`, `payments-list`, `jobs`, `activity`,
`timesheets`. Only `M8 geo-heatmap` is `deferred: true`.

### 2.3 Slug dispatch - `pages/reports/ReportRoute.tsx` (41 lines)

```
slug = useParams().slug ; isDemoOrg = useIsDemoOrg()
report = findReport(slug)
1. report exists AND !canShowReport(report, isDemoOrg)  -> <ReportStubPage />
2. reportComponents[slug] exists                        -> <Suspense fallback="Loading report…"><Built /></Suspense>
3. report exists (no bespoke component)                 -> <GenericReport report={report} />
4. otherwise                                            -> <ReportStubPage />
```

Step 1 is the org gate defending direct navigation: a real org typing a not-yet-backed
URL gets "coming soon" instead of fabricated numbers. Subtlety: a **known non-live** slug
can never reach its registered component for a real org even if one exists. Suspense
fallback: `<div className="p-6 text-sm text-text-secondary">Loading report…</div>`.

### 2.4 Registry - `pages/reports/reports-registry.ts` (33 lines)

`Record<string, LazyExoticComponent<ComponentType>>`, 23 entries, all
`lazy(() => import(...))`. **`payments` and `payments-list` both map to `PaymentsReport`**
- two slugs, one page (it reads `useParams().slug` and falls back to
`findReport('payments')`). Contract for adding a report: register the slug here; nothing
else changes.

### 2.5 The shell - `pages/reports/ReportShell.tsx` (54 lines)

**Every built report renders through this.**

```ts
{ report: ReportDef; actions?: ReactNode; subtitle?: ReactNode; children: ReactNode }
```

Inside `<div className="space-y-6">`: (1) `<Link to="/reports">` + `ArrowLeft`
"Back to Reports"; (2) header row - 40px circular `bg-background-light` icon chip;
optional `code` pill (`rounded-md bg-background-light ... tabular-nums`);
`<h1 className="text-2xl font-semibold">{report.label}</h1>`; optional muted `subtitle`;
`actions` pushed right by `ml-auto`; (3) `{children}`.

**Highest-leverage component in the module.** Re-skinning it updates all ~23 built
reports plus `GenericReport` at once. The `actions` layout contract
(`ml-auto flex items-center gap-2`) must survive - every report hangs its date control,
export button, view toggle and filters there.

### 2.6 The card - `ReportCard.tsx` (36 lines)

`<Link to={'/reports/' + slug}>` as a tile: `rounded-xl border border-border bg-white
shadow-card`, 3px left accent bar -> `text-primary` on hover,
`hover:-translate-y-0.5 hover:shadow-md`, `focus-visible:ring-2`. Contents: optional
`code` pill, truncated label, optional "Deferred" pill, icon right. `deferred` adds
`opacity-60` but the card **still routes**.

### 2.7 The stub - `ReportStubPage.tsx` (41 lines)

Back-link + centred `rounded-xl border bg-white p-10 shadow-card` panel. Known slug ->
icon chip + "`{label}` report" + "This report is coming soon - we'll build it out next."
Unknown slug -> no icon + "Report not found" + "No report matches this address. Head back
to the Reports list." Takes **no props**; re-derives from `useParams()`.

### 2.8 The generic report - `GenericReport.tsx` (312 lines)

Any catalog slug without a bespoke component renders here, so no card dead-ends. Data is
**deterministic fabricated sample data** seeded from the slug
(`mulberry32(hashStr(report.slug))`), shaped by a per-group `GroupConfig`:

| group | entityLabel | primary | rate | secondary (agg) |
|---|---|---|---|---|
| Sales | Rep | Revenue ($150k base) | Win rate (55%) | Deal size (avg) |
| Finance | Business unit | Revenue ($220k) | Gross margin (42%) | Collected (sum) |
| Operations | Technician | Completed jobs (120) | First-time fix (78%) | Utilization (avg) |
| Marketing | Channel | Attributed revenue ($90k) | ROAS (4) | Leads (sum) |

Renders: amber "Sample data" pill + `MultiSelectFilter` in shell `actions`; optional amber
deferred banner; 5-tile `KpiStrip` (Total primary / Avg rate / Total-or-Avg secondary /
entity count / Top entity); two side-by-side `ChartCard`s - horizontal recharts `BarChart`
with per-row `Cell` colouring (green up / red down vs last month) + `LabelList`, and a
multi-series `LineChart` of 8 weekly points; a `ResizableTable` leaderboard (`#`, entity,
primary+Delta, rate+Delta, secondary, inline SVG `Sparkline`); closing "Sample data for
layout review" paragraph.

### 2.9 `_shared.tsx` (238 lines)

| Export | Kind | Used by |
|---|---|---|
| `hashStr`, `mulberry32`, `rangeRnd` | deterministic PRNG helpers | GenericReport, CampaignRoi, Commissions, JobStatistics, Jobs, Leads, Sales |
| `Delta` | up/down pill, `text-emerald-600`/`text-rose-600`, `flipColor` inverts good/bad, `suffix` `%`/`pp` | GenericReport, Expenses, Payments |
| `Sparkline` | inline SVG polyline 88x26, caller supplies colour | GenericReport, Estimates, Payments |
| `MultiSelectFilter` | custom dropdown, empty = "all", closes on outside `mousedown` | GenericReport, Estimates, Expenses, Invoices, ItemsServices, TechPerformance |
| `FacetFilter` + `FacetGroup` | Workiz-style "Filter results" input with removable chips over a multi-column picker | Expenses only |

`MultiSelectFilter` and `FacetFilter` each own a `useRef` +
`document.addEventListener('mousedown')` outside-click effect - prime candidates for the
kit's popover primitives, but the "empty = all" summary text (`pluralLower()`:
"All statuses", "2 reps") is **behaviour**, not styling. `Delta` uses raw Tailwind palette
classes - an existing CLAUDE.md token violation on `main`; flagged, not fixed here.

### 2.10 `DateRangeControl.tsx` (143 lines)

A single bordered `w-72` card, two stacked rows: **top** - active preset (bold) over the
resolved range with ordinals (`fmtOrdinal`: "Jun 1st, 2026 - Jun 6th, 2026", or
"All dates" when a bound is null), opens a preset menu; **bottom** - "By: `<date field>`",
opens a date-field menu. When `preset === 'custom'`, a third row of two native
`<input type="date">` bound with `max`/`min` to each other. Menus are custom
(`absolute left-0 right-0 top-full z-30`) with a `Check` on the current option. Fully
controlled - parent owns `preset`, `field`, `from`, `to`, `customFrom`, `customTo`. Shared
`Opt = { key, label }`.

Consumers (8): `ArAgingReport`, `CallTrackingReport`, `ExpensesReport`,
`JobStatisticsReport`, `JobsReport`, `LeadsReport`, `PaymentsReport`, `SalesReport`. Each
defines its **own** `Preset` union, `PRESET_LABEL` and `presetRange()` - there is no shared
preset vocabulary. `frontend/src/lib/date-range.ts` exists but **no report imports it**.

### 2.11 `ActivityFilterBar.tsx` (190 lines) - Activity only

`rounded-xl border bg-white p-3 shadow-card` bar: a "Filters" label with an active-count
badge (`activeFilterCount`); three `MultiFacet` dropdowns (shadcn `DropdownMenu` +
`DropdownMenuCheckboxItem`, `onSelect={e => e.preventDefault()}` to keep the menu open) -
**Division**, **Person**, **Role**; a **Date range** `DropdownMenuRadioGroup` over
`['Today','Last 7 days','Last 30 days','This month','Last month','Year to date']`; a
"Clear all" (only when `count > 0`); a chip row under a top border with `FilterChip` +
`onRemove` per selection.

**Cascading options is real logic:** Role options scoped to selected divisions; Person
options to selected divisions **and** roles. The file's own comment records that the
Date-range facet is interactive but **does not yet narrow the snapshot data** - wired for a
future backend aggregation.

### 2.12 Shared UI components owned outside this module

| Component | Path | Contract used |
|---|---|---|
| `KpiStrip` / `KpiTile` | `components/ui/KpiStrip.tsx` | `items: KpiTileProps[]`, `loading?`. Tile: `icon`, `label`, `value: ReactNode`, `sub?`, `tone: 'neutral'\|'primary'\|'emerald'\|'amber'\|'rose'`, `emphasize?`, `delta?`, `active?`, `onClick?`, `loading?`. `active` + `onClick` is what makes tiles pressable drill triggers (Activity, Expenses, Commissions) |
| `ResizableTable` | `components/ui/ResizableTable.tsx` | `columns: ResizableColumn<T>[]`, `rows`, `getRowKey`, `onRowClick?`, `rowClassName?`, `empty?`, `stickyHeader?`. Column: `id`, `header`, `cell(row)`, `width?`, `min?`, `grow?`, `align?`, `sortValue?(row)`, `footer?`. Drag edges to resize, click header to sort |
| `ChartCard` | `components/charts/ChartCard.tsx` | `title?`, `subtitle?`, `select?`, `action?`, `flush?`, `children` |
| `WaveAreaChart` | `components/charts/WaveAreaChart.tsx` | `RevenueReport`, `SalesReport` |
| `SelectField` | `components/common/SelectField.tsx` | every inline dropdown filter |
| `Sheet` | `components/ui/sheet.tsx` | `EstimateDetailPanel`, EstimateConversion drill panel |
| `FilterChip` | `components/ui/filter-chip.tsx` | `ActivityFilterBar` chips |

Per the plan's "import shared code, never fork it" rule, a v2 page imports these as-is or
the kit equivalents land at the shared layer in a different module. **Decide before
building - see Q4.**

## 3. Per-report table

`hook` names are in `pages/reports/*-data.ts`. "mock" = deterministic fabricated data, no
network. All live queries follow one pattern:
`useQuery({ queryKey, queryFn: api.get(...), staleTime: 60_000, enabled: !isDemo })` with an
early `if (isDemo) return <mock>`.

| # | Slug | Component | Data source | Endpoint / query key | Charts (recharts) | Filters | Drill-down | Export |
|---|---|---|---|---|---|---|---|---|
| 1 | `activity` | `ActivityReport.tsx` | `useActivityReport(isDemo)` | `GET /api/reports/activity` · `['activity-report']` | none (custom bars in `MetricDetailPanel`) | `ActivityFilterBar`: Division / Person / Role / Date presets | 3 zoom levels (Company->Division->Individual), scope **derived** from filter selection via `deriveScope`; breadcrumb switcher in shell `actions`; pressable KPI tiles open `MetricDetailPanel` (company/division) or `PersonMetricPanel` (individual); division row click -> division; person row click -> individual | none |
| 2 | `ar-aging` (F4) | `ArAgingReport.tsx` | `useArAging(isDemo)` | `GET /api/reports/ar-aging` · `['ar-aging']` | BarChart + Cell + LabelList (buckets on `severityRamp`) | `DateRangeControl` (11 presets incl. custom) + customer-type `SelectField` | customer name -> `<Link to="/customers/:id">`; per-bucket worklist with `ACTION[bucket]` next-step text | `exportCsvFile('ar-aging.csv', ...)` via `arAgingCsv` |
| 3 | `call-tracking-summary` | `CallTrackingReport.tsx` | mock (`call-tracking-data/-logic/-seed.ts`) | none | none | `DateRangeControl` (7 presets) + search | row click opens the Phone module's `CallDetailDrawer`; table is the Phone module's `CallsTable` | none |
| 4 | `campaign-roi` (M1) | `CampaignRoiReport.tsx` | mock (in-file `CAMPAIGNS`, PRNG) | none | BarChart + Legend (won vs pipeline) | Source / Month / Sort `SelectField`s | funnel cells (money generated, jobs closed, open pipeline, open leads) - display only | `exportCsvFile` |
| 5 | `commissions` | `CommissionsReport.tsx` (42 KB) | mock (in-file `JOBS`/`TECHS`, PRNG) | none | none | report-type pills (Standard / Tech Report / External Company), Technician-or-Company, Job type, Settlement (All/Settled/Unsettled), By-Time, date range, search, rows-per-page (25/50/100/All) | pressable KPI tiles toggle Settlement and scroll to table (`onKpiSettlement`, `onKpiTips`, `onKpiClear`); Tech Report vs Standard render different column sets | `exportCsvFile`; mock-only "Export By Mail" (toast), "Send Bulk" (toast), "Print" (`window.print()`) |
| 6 | `communication-tracking` | `CommunicationTrackingReport.tsx` + `comm-tracking/{CadenceTab,QaTab,TrainingImpactTab}` | `useCommunicationTrackingReport(isDemo)` | `GET /api/reports/communication-tracking` · `['communication-tracking']` | `QaTab` only: BarChart | 3 tabs (Cadence / QA / Training impact) + a **local `isDemo` toggle button** ("Sample data" <-> "Live") that is component state, **not** `useIsDemoOrg` | tables only (`ResizableTable` in all three) | per-tab `toCSV`+`downloadCSV` -> `cadence.csv` / `qa-by-rep.csv` / `training-impact.csv` |
| 7 | `estimate-conversion` (S1) | `EstimateConversionReport.tsx` (39 KB) | `useEstimateConversionReport(filters,isDemo)` + `useConversionDrilldown(filters,drill,isDemo)` | `GET /api/reports/estimate-conversion` · `['estimate-conversion', ...filterKey]` ; `GET /api/reports/estimate-conversion/estimates` · `['estimate-conversion-drill', ...filterKey, JSON.stringify(drill)]`, `enabled: !isDemo && !!drill` | ComposedChart (Bar+Line dual axis), PieChart/Pie, BarChart, LabelList, Legend | range preset `SelectField` + custom dates, Rep, Source chips, Job-type chips, conversion `model` toggle, `DateAnchor` | **richest drill in the module**: `DrillSelector = { status?, outcome?, agingBucket?, repId?, month? }`. Clicking a status card, outcome, aging bucket, rep row or month bar sets the selector and opens a right `Sheet` (`DrillPanel`->`DrillTable`); rows link to `/estimates/:id` (demo rows show a disabled "Follow up") | none |
| 8 | `estimates` | `EstimatesReport.tsx` | `useEstimatesReport(isDemo)` | `GET /api/reports/estimates` · `['estimates-report']` | BarChart, LineChart, Cell, LabelList, Legend | status cards (All/Unsent/Pending/Approved/Won/Declined/Archived), date presets (all/30/90/365), `MultiSelectFilter` "Rep" (single-select via `next.slice(-1)`), search | row click opens `EstimateDetailPanel` (right `Sheet`); view toggle `list` vs `by-rep` | none |
| 9 | `expenses` | `ExpensesReport.tsx` (29 KB) | mock (`expenses-data.ts` + `expenses-logic.ts`) | none | BarChart + Cell + Legend (12-month spend by category) | `DateRangeControl` (6 presets) driving the **whole page**; `MultiSelectFilter` Category / Cardholder / Status / Business unit; `FacetFilter`; search; rows-per-page | 7 pressable `KpiTile`s (`revenue`, `expenses`, `net`, `margin`, `thisMonth`, `lastMonth`, `receipts`) each toggle a `DrillChart` panel below the strip; inline receipt/description/status edits are **local-only** | `exportCsvFile` |
| 10 | `invoices` | `InvoicesReport.tsx` | `useInvoicesReport(isDemo)` | `GET /api/reports/invoices` · `['reports','invoices']` | none | `MultiSelectFilter` Salesperson / Technician / Status / Job type; date-preset `SelectField` (all/7d/30d/90d/month/custom); client search; rows-per-page | none (list only) | `exportCsvFile` |
| 11 | `items-and-services` | `ItemsServicesReport.tsx` | mock (`items-services-data/-logic.ts`) | none | BarChart + Cell + LabelList | view toggle Company / Technician; `MultiSelectFilter` Category; Technician `SelectField` | Company view rows expand into a per-technician breakdown table | none |
| 12 | `job-profitability` (F1) | `JobProfitabilityReport.tsx` | mock (in-file `JOBS`) | none | ScatterChart + Scatter + ZAxis + ReferenceLine + Cell (revenue vs GM%) | Business unit / Job type / Status `SelectField`s | margin-heat table rows (no navigation) | `exportCsvFile` |
| 13 | `jobs` | `JobsReport.tsx` (39 KB) | `useJobsReport(isDemo)` | `GET /api/reports/jobs` · `['jobs-report']` (ISO dates revived to `Date`) | none | multi-column filter panel (Status · Team · Created By · Tags · Job Type · Job Origin · Source), `DateRangeControl` with selectable date field, search, rows-per-page | "Fields" modal picks visible columns, **persisted to `localStorage`** (`FIELDS_KEY`) | `exportCsvFile('jobs-report.csv', ...)` over the full filtered set |
| 14 | `job-statistics` | `JobStatisticsReport.tsx` (44 KB) | mock (PRNG; shapes mirror `GET /api/jobs`) | none | BarChart, LineChart, PieChart/Pie, Cell, Legend | one `DateRangeControl` scopes **all 9 tabs**; per-tab job-type `SelectField`s; granularity toggle | 9 tabs: Jobs overview · Sources · By Job Type · Tech Performance · Call Back Rate · First-Time Fix · Avg Completion Time · Area Performance · Dispatcher Performance. Sources / By Job Type / Tech / Area / Dispatcher reuse one `StatsTable` + `groupBy()` | none |
| 15 | `leads` | `LeadsReport.tsx` (33 KB) | `useLeadsReport(isDemo)` | `GET /api/reports/leads` · `['report-leads']` | none | multi-column filter panel (Status · Assigned · Created By · Source), `DateRangeControl` with selectable date field, search, rows-per-page | "Fields" modal, `localStorage`-persisted; by-source and by-status breakdown blocks | `exportCsvFile` |
| 16 | `payments` **and** `payments-list` (F5) | `PaymentsReport.tsx` (both slugs) | `usePaymentsReport(isDemo)` | `GET /api/reports/payments` · `['payments-report']` | BarChart + Cell, LineChart, Legend | multi-column filter (method / category / status / technician), `DateRangeControl`, search, rows-per-page | category bars filter the transaction list; reads `useParams().slug` to title itself, `?? findReport('payments')` | `exportCsvFile` |
| 17 | `revenue` (F2) | `RevenueReport.tsx` | `useRevenueReport(isDemo)` | `GET /api/reports/revenue` · `['revenue-report']` | BarChart + Cell + LabelList, plus `WaveAreaChart` | business-unit `SelectField` - **demo only**. `hasBuSplit` is `true` for demo, `false` for live (no BU dimension in the schema); control hidden for real orgs | none | none |
| 18 | `sales` | `SalesReport.tsx` (32 KB) | mock (PRNG) | none | `WaveAreaChart` (profit vs sales) | multi-column filter panel (Status · Team · Created By · Tags · Job Type · Source), `DateRangeControl` with selectable date field, search, rows-per-page | "Fields" modal, `localStorage`-persisted; money table with a "Total:" summary row | `exportCsvFile` |
| 19 | `service-plans` | `ServicePlansReport.tsx` (33 lines) | `useServicePlans()` (**real app hook**) | `GET /api/service-plans` · `servicePlanKeys.all` | none | none | shell `actions` holds a primary `<Link to="/service-plans">Open Service Plans</Link>` | none |
| 20 | `tech-performance` (S3) | `TechPerformanceBoard.tsx` | mock (in-file) | none | BarChart, LineChart, Cell, ReferenceLine, LabelList, Legend | `MultiSelectFilter` Technician; Business-unit `SelectField` | table only | none |
| 21 | `timesheets` | `TimesheetsReport.tsx` | **real timeclock API** (`usePunches`, `useOtReviews`, `useUpsertOtReview`, `useApproveOverride`, `useRejectOverride`, `useOrganization`) | `GET /api/timeclock/punches` `['timeclock','punches',scope,from,to]` · `GET /api/timeclock/ot-reviews` `['timeclock','ot-reviews',scope,from,to]` · `POST /api/timeclock/ot-reviews` · `POST /api/timeclock/punches/:id/override/approve` · `POST /api/timeclock/punches/:id/override/reject` (all invalidate their key) | BarChart + Cell, PieChart/Pie + Legend | 4 tabs (Hours / Attendance / Location / Job time); team-member `SelectField`; `scope` derived from role (`ADMIN`/`DISPATCHER`->`'org'`, else `'me'`) | `GeofenceSettingsDialog` in shell `actions`; `EmployeePayrollCard`; per-punch Approve / Reject; OT week approve/reject - **the only mutations in the module** | none |
| 22 | `weekly-rep-diagnostic` (S9) | `WeeklyRepDiagnostic.tsx` | mock (in-file `REPS` + `derive`) | none | LineChart + ReferenceLine (sparkline vs prior 4-week avg) | Week / Rep / Business unit / Lead source `SelectField`s; conversion-formula toggle (HCP vs Jobber) | per-rep metric blocks | `exportCsvFile` |
| 23 | every other catalog slug (26) | `GenericReport.tsx` | fabricated, seeded by slug | none | BarChart + Cell + LabelList, LineChart + Legend | one `MultiSelectFilter` on the group entity | none | none |
| 24 | `/marketing` (not a catalog slug) | `MarketingAnalyticsPage.tsx` (407 lines) | mock (in-file `Channel[]`) | none | BarChart, PieChart/Pie, Cell | channel `SelectField`s; expandable rows (`ChevronDown`/`ChevronUp`) | hero metric is Cost Per Booked Job by channel; status badges good/watch/bad | none |

`Estimates` (row 8) and `EstimateConversion` (row 7) are two different reports, both
present. There is no `ItemsServices` data hook - it is mock.

## 4. Detail panels

Three distinct patterns; **not** interchangeable.

**4.1 `EstimateDetailPanel.tsx` (34 lines) - a Sheet.** Opened from an `EstimatesReport`
row click. Controlled by nullability:
`<Sheet open={!!estimate} onOpenChange={o => { if (!o) onClose() }}>`,
`<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">`. A `<dl>` of
Customer / Rep / Status (`BUCKET_LABEL[bucketStatus(estimate)]`) / Created / Amount /
Deposit due, each a bordered row; footer "Sample data - detail view is read-only in this
phase." **Read-only, no actions.**

**4.2 `MetricDetailPanel.tsx` (237 lines) - an inline expanding panel.** Opened by pressing
a KPI tile on `ActivityReport` at **company or division** level. **Not a sheet or dialog** -
a `rounded-xl border border-primary/30 bg-white p-5 shadow-card ring-1 ring-primary/10`
block rendered inline below the KPI strip, with an `X` (`aria-label="Close breakdown"`).
Props `{ metric, level: 'company'|'division', users, divisions, divisionId?, onClose }`.
Builds `BreakdownSource[]` from `companyRows()` or `leaderboard()`, then
`rank(metric, sources)` projects onto `revenue` / `conversions` / `response` / `sla` /
`people`, producing sorted rows with label, sub, formatted value, optional `%` delta, a 0-1
bar magnitude and a colour, rendered as a horizontal bar list (div widths, **not**
recharts). Empty: "No data for this selection." **Inlines raw hex** `#10B981`, `#6366F1`,
`#64748B` plus `BAND_HEX` - an existing CLAUDE.md violation; record, do not silently fix.

**4.3 `PersonMetricPanel.tsx` (62 lines) - an inline expanding panel.** Opened by pressing a
KPI tile at the **individual** level. Same chrome as 4.2 (`X` with
`aria-label="Close detail"`). Reads `personDetail(user, metric)` ->
`{ title, hint, summary, rows }`, renders a scrollable `max-h-80 divide-y` record list with
an optional band dot (`BAND_HEX[r.band]`, inline style), label, sub, value, value2. Empty:
"No records for this card."

**4.4 Panel-opening rules on ActivityReport** (`ActivityReport.tsx:79-96`). `activeMetric`
holds a `MetricKey` or a `PersonMetricKey`. A `useEffect` **resets `activeMetric` to null
whenever the scope changes** (`scope.level`, `scope.divisionId`, `scope.userId`). Tiles wire
through `press(key) => ({ onClick, active: activeMetric === key, activeLabel: 'Detail' })`,
so `KpiTile.active` is the "expanded" affordance. Pressing the same tile again closes it.

**4.5 Other overlays.** `EstimateConversionReport` `DrillPanel` - right `Sheet` around
`DrillTable` (`:404-430`), header shows "Loading…" or "N estimates".
`JobsReport`/`LeadsReport`/`SalesReport` `FieldsModal` - locally-defined column picker
opened by a `SlidersHorizontal` "Fields" button, saved to `localStorage`.
`CallTrackingReport` reuses `CallDetailDrawer` from Communication. `TimesheetsReport`
renders `GeofenceSettingsDialog` from `components/timeclock/`.

## 5. Every API call

### 5.1 Reports endpoints (`backend/src/routes/report.routes.ts`)

All `GET`, authenticated, gated on `canDo('read','Report')`, behind `expensiveLimiter`.
**No mutations exist on `/api/reports/*`.**

| Hook (file) | Method + endpoint | Query key | `enabled` |
|---|---|---|---|
| `useActivityReport` (`activity-data.ts:394`) | `GET /api/reports/activity` | `['activity-report']` | `!isDemo` |
| `useArAging` (`ar-aging-data.ts:27`) | `GET /api/reports/ar-aging` | `['ar-aging']` | `!isDemo` |
| `useCommunicationTrackingReport` (`communication-tracking-data.ts:16`) | `GET /api/reports/communication-tracking` | `['communication-tracking']` | `!isDemo` |
| `useEstimateConversionReport` (`estimate-conversion-data.ts:112`) | `GET /api/reports/estimate-conversion` (params `anchor,from,to,rep,source,jobType,model`) | `['estimate-conversion', anchor, fromISO, toISO, repId, source, jobType, model]` | `!isDemo` |
| `useConversionDrilldown` (`:141`) | `GET /api/reports/estimate-conversion/estimates` (filters + drill selector) | `['estimate-conversion-drill', ...filterKey, JSON.stringify(drill)]` | `!isDemo && !!drill` |
| `useEstimatesReport` (`estimates-report-data.ts:76`) | `GET /api/reports/estimates` | `['estimates-report']` | `!isDemo` |
| `useInvoicesReport` (`invoices-data.ts:107`) | `GET /api/reports/invoices` | `['reports','invoices']` | `!isDemo` |
| `useJobsReport` (`jobs-data.ts:31`) | `GET /api/reports/jobs` | `['jobs-report']` | `!isDemo` |
| `useLeadsReport` (`leads-data.ts:45`) | `GET /api/reports/leads` | `['report-leads']` | `!isDemo` |
| `usePaymentsReport` (`payments-report-data.ts:167`) | `GET /api/reports/payments` | `['payments-report']` | `!isDemo` |
| `useRevenueReport` (`revenue-data.ts:54`) | `GET /api/reports/revenue` | `['revenue-report']` | `!isDemo` |

Query keys are inconsistent on `main` - mostly flat strings, but `invoices` uses
`['reports','invoices']`. **Do not normalise in a UI-only PR.** All use
`staleTime: 60_000`.

`GET /api/reports/communication-tracking` has **no matching backend route** on `main` (10
routes listed; this is not one). The component defaults local `isDemo` to `true`, so the
query never fires unless a user presses "Live". See Q3.

### 5.2 Non-`/api/reports` calls made by report pages

| Hook | Method + endpoint | Key / invalidation |
|---|---|---|
| `useServicePlans` (`lib/api/service-plans.ts:113`) | `GET /api/service-plans` | `servicePlanKeys.all` |
| `usePunches` (`lib/api/timeclock.ts:70`) | `GET /api/timeclock/punches` (`{scope,from,to}`) | `['timeclock','punches',scope,from,to]` |
| `useOtReviews` (`:253`) | `GET /api/timeclock/ot-reviews` | `['timeclock','ot-reviews',scope,from,to]` |
| `useUpsertOtReview` (`:264`) | `POST /api/timeclock/ot-reviews` | invalidates `['timeclock','ot-reviews']` |
| `useApproveOverride` (`:221`) | `POST /api/timeclock/punches/:id/override/approve` | invalidates `['timeclock','punches']` |
| `useRejectOverride` (`:236`) | `POST /api/timeclock/punches/:id/override/reject` | invalidates `['timeclock','punches']` |
| `useOrganization` | `GET /api/organization` (for `timezone`) | organization key |

**The five timeclock calls in `TimesheetsReport` are the only mutations in the entire
reports module.** A v2 Timesheets page must reproduce Approve/Reject/OT-review exactly,
including `scope` derivation from role and org-timezone bucketing
(`buildDays(sessions, timeZone)`).

### 5.3 No forms

**No zod schema, no react-hook-form, no create/update form anywhere in the module.** The
only writes are the timeclock mutations, button-triggered with no payload beyond ids and a
state enum.

## 6. Charts - the explicit migration boundary

### 6.1 The boundary statement

**The CRM UI kit ships no chart components.** `crm-ui-kit-complete_1/crm-ui-kit/src/` has 21
UI primitives, 6 form, 9 data (DataTable suite), 7 layout, 10 CRM domain components - none a
chart. Therefore:

> **recharts stays. Every `<ResponsiveContainer>`, `<BarChart>`, `<LineChart>`,
> `<PieChart>`, `<ComposedChart>`, `<ScatterChart>`, `<Cell>`, `<LabelList>`, `<Legend>`,
> `<Tooltip>`, `<ReferenceLine>` and axis config in this module is carried over UNCHANGED.
> Only the chrome around a chart - the `ChartCard`, the header select, the KPI strip above
> it, the filter bar beside it - is re-skinned.**

A v2 page that rewrites chart internals has exceeded its brief and should be rejected in
review. Charts are also where a colour "improvement" silently changes meaning (green = up,
red = down; severity ramp = worse as it goes) - token substitutions inside chart props are
behaviour changes, not styling.

### 6.2 recharts usage inventory (15 files)

| File | Components used |
|---|---|
| `ArAgingReport.tsx` | ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList |
| `CampaignRoiReport.tsx` | ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend |
| `EstimateConversionReport.tsx` | ResponsiveContainer, BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Cell, Tooltip, PieChart, Pie, LabelList, CartesianGrid, Legend |
| `EstimatesReport.tsx` | ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList, Legend |
| `ExpensesReport.tsx` | ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, Legend, CartesianGrid |
| `GenericReport.tsx` | ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList, Legend |
| `ItemsServicesReport.tsx` | ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList |
| `JobProfitabilityReport.tsx` | ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ReferenceLine, Cell |
| `JobStatisticsReport.tsx` | ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend |
| `PaymentsReport.tsx` | ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line, Legend |
| `RevenueReport.tsx` | ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList |
| `TechPerformanceBoard.tsx` | ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine, LabelList, Legend |
| `TimesheetsReport.tsx` | ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, PieChart, Pie, Legend |
| `WeeklyRepDiagnostic.tsx` | ResponsiveContainer, LineChart, Line, ReferenceLine, Tooltip |
| `comm-tracking/QaTab.tsx` | ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid |

Plus `pages/MarketingAnalyticsPage.tsx` (BarChart, PieChart, Pie, Cell, XAxis, YAxis,
CartesianGrid, Tooltip, ResponsiveContainer). Non-recharts visuals that also stay:
`_shared.tsx` `Sparkline` (SVG polyline), `MetricDetailPanel` bar list (div widths), and
`components/charts/` primitives (`WaveAreaChart`, `Donut`, `Funnel`, `GaugeArc`,
`HorizontalBars`, `SeverityBars`, `StackedBars`, `CapsuleBar`, `Sparkline`).

### 6.3 How colours reach a chart

`frontend/src/design-system/tokens.ts` (117 lines) is the one place JS/chart consumers read
tokens:

- **`token(name): string`** - reads the live CSS custom property from `:root` via
  `getComputedStyle`; wraps channel-format values (`"12 45 58"`) as `rgb(...)`; falls back
  to a static hex map (`FALLBACKS`) when the DOM is unavailable (jsdom, SSR, pre-`tokens.css`),
  then `#000000`. **Never returns an empty string.** Reports use it for axis ticks
  (`token('--text-secondary')`), grid strokes (`token('--border-color')`) and semantic fills
  (`--success`, `--danger`, `--warning`).
- **`chartPalette: string[]`** - 5 categorical colours in spec order: green `#2F7D5D`
  (sage-700), teal/ocean `#0C2D3A` (ocean-800), indigo `#5B6DFF` (ai-600), amber `#B45309`
  (amber-700), slate `#667985` (text-secondary). Cycled with `SERIES[i % SERIES.length]`.
- **`severityRamp: string[]`** - 6 colours green->terracotta, "worse as it goes": `#2F7D5D`,
  `#6B8F5E`, `#C99A3C`, `#C17A43`, `#BF5A4C`, `#8F3E34`. **Only `ArAgingReport` and
  `EstimateConversionReport` import it.** ArAging maps the six aging buckets (`current`,
  `1-30`, `31-60`, `61-90`, `91-120`, `121+`) onto the ramp in `BUCKET_ORDER` order,
  explicitly overriding the data layer's rainbow `BUCKET_COLOR`.

The established idiom v2 must copy verbatim:

```ts
const TREND_UP   = chartPalette[0] ?? token('--success');
const TREND_DOWN = token('--danger');
const ramp = (i: number) => severityRamp[i] ?? severityRamp[severityRamp.length-1] ?? token('--danger');
```

Tokens are imported from two paths - `@/design-system/tokens` (ArAging, CampaignRoi,
EstimateConversion, Estimates, Expenses, GenericReport) and `@/design-system` (ItemsServices,
JobProfitability, JobStatistics, Payments, Revenue, Sales, TechPerformance, Timesheets,
WeeklyRepDiagnostic, QaTab, MarketingAnalytics). Both resolve to the same symbols. Leave
as-is.

**Known raw-colour exceptions already on `main`** (record, do not fix in a UI-only PR):
`MetricDetailPanel.tsx` inlines `#10B981`/`#6366F1`/`#64748B`; `_shared.tsx` `Delta` uses
`text-emerald-600`/`text-rose-600`; `InvoicesReport.tsx` `STATUS_STYLE` uses
`bg-emerald-50`/`bg-amber-50`/`bg-rose-50`/`bg-blue-50`; `CommissionsReport` uses
`bg-emerald-50`/`bg-amber-50` for settlement badges; `activity-logic.ts` exports `BAND_HEX`.

## 7. Entitlement gating - what is actually true

**Reports are NOT plan-gated. There is no report paywall to reproduce.** Verified three
ways:

1. **`main` has no entitlements code at all.** `find backend/src -name "*entitlement*"` and
   `grep -rn "requireFeature" backend/src` both return nothing on `main`. The entitlements
   module (`backend/src/lib/entitlements/{catalog,plans,resolve,ops-sql}.ts`,
   `frontend/src/lib/entitlements/{catalog,index,useModuleAccess}.ts`) exists **only on
   `origin/staging`**. `grep -rn "useFeature\|useEntitlement" frontend/src` on `main`: zero
   hits.
2. **No report route carries a feature gate on either branch.** `report.routes.ts` on `main`
   (10 routes) and on `origin/staging` (12, adding `payment-fees` and `inventory-usage`) both
   gate every route on `canDo('read','Report')` and nothing else.
3. **The owner's own plan says so.**
   `md_files/plans/reports/2026-07-28-starter-basic-reports-set.md` on
   `origin/fix/starter-basic-reports-set`, verbatim: *"Reports are already ungated by plan.
   `backend/src/routes/report.routes.ts` carries no `requireFeature` on any route - every
   report gates on the CASL `read Report` capability (Admin + Dispatcher only). There is no
   report paywall to dismantle; #1021 was a false claim in the entitlements catalog, not a
   missing gate."*

### 7.1 What actually gates a report (three layers, all reproduced verbatim in v2)

| Layer | Mechanism | Where |
|---|---|---|
| **Route role gate** | `ProtectedRoute allowedRoles={['ADMIN','DISPATCHER']} fallback` | `App.tsx:144` |
| **Per-card CASL gate** | `ability.can('read', report.subject)` - subject varies per report (`Report`, `Lead`, `Estimate`, `Invoice`, `Job`, `Customer`, `Inventory`, `Communication`, `PriceBook`, `User`) | `ReportsPage.tsx:19-32` |
| **Org data-honesty gate** | `canShowReport(report, isDemoOrg)` - demo orgs see everything, real orgs see only `live: true` | `report-catalog.ts:215`, enforced in `ReportsPage.tsx` (grid) **and** `ReportRoute.tsx:24` (direct URL) |

### 7.2 How the UI reflects a hidden / gated report

**No "upgrade your plan" state exists anywhere.** Two behaviours only:

- **Hidden** - a card the user cannot `read` (CASL), or not `live` for a real org, simply
  does not render. No placeholder, no lock icon, no badge.
- **Stub** - typing `/reports/<non-live-slug>` as a real org renders `ReportStubPage`:
  "`{label}` report" / "This report is coming soon - we'll build it out next."

The only *visible* modifier is `deferred: true` (M8 `geo-heatmap` only) -> `opacity-60` +
"Deferred" pill on the card, and an amber banner in `GenericReport`: "Deferred - not
selected for build in the current plan. Shown here for reference."

### 7.3 The two branches, for context only

Neither adds plan gating. Both are drift against `origin/staging`, not `main`, and both touch
~40 reports files - **a v2 build off `main` will conflict with both if they land.**

- `origin/fix/starter-basic-reports-set` - removes `live: true` from `leads` (the Leads
  module is `minPlan: PRO` behind `requireFeature('leads')` on staging, so the report is
  structurally empty for Starter); deletes the `payments-list` catalog entry and registry
  mapping (exact duplicate of `payments`); retargets the `mainReports` "Payments" entry from
  `payments-list` to `payments`; adds `live: true` + a registry entry for a new
  `inventory-usage` report. Net Starter set: 10.
- `origin/fix/1021-advanced-reports-unbuilt` - the same `inventory-usage` promotion and
  registry entry, without the `leads`/`payments-list` removals.

The plan file records why `inventory-usage` could not simply be flipped off: because
`live`/`canShowReport` gates `ReportRoute` **globally with no plan-tier awareness**, turning
it off 404s the report for every real org including SCALE customers. **The single most
important architectural fact about report gating: `live` is a global per-report boolean, not
a per-org or per-plan one.**

## 8. Date-range and filter state

### 8.1 There is no URL sync anywhere in the module

`grep -n "useSearchParams" frontend/src/pages/reports/*` -> **zero hits.** Every filter,
preset, tab, view mode and drill selector is plain `useState`. Consequences to preserve
exactly (behaviour, not bugs):

- Report state is **not shareable by URL** and **not restored on refresh**.
- Navigating to `/reports` and back resets every filter to its default.
- `ReportRoute` mounts a `lazy` component per slug, so switching reports unmounts state.

The only `useParams` consumers are `ReportRoute` (slug), `ReportStubPage` (slug) and
`PaymentsReport` (to title itself for `payments` vs `payments-list`).

### 8.2 The only persisted state: column visibility

| Report | Line refs |
|---|---|
| `JobsReport.tsx` | read `:624`, write `:725` (`FIELDS_KEY`) |
| `LeadsReport.tsx` | read `:508`, write `:581` (`FIELDS_KEY`) |
| `SalesReport.tsx` | read `:466`, write `:533` (`FIELDS_KEY`) |

Nothing else touches `localStorage`/`sessionStorage`.

### 8.3 Date-range defaults per report

| Report | Preset union | Default | Date fields |
|---|---|---|---|
| `ArAgingReport` | `all·today·yesterday·7d·lastWeek·month·lastMonth·30d·year·lastYear·custom` | not read line-by-line | selectable `DateField` |
| `CallTrackingReport` | `month·lastMonth·30d·90d·year·all·custom` | not read | selectable |
| `ExpensesReport` | `month·lastMonth·7d·year·all·custom` | not read; `NOW` pinned to `new Date(2026,5,6,12,0,0)` | selectable |
| `JobStatisticsReport` | local `Preset` | `preset='month'`, `dateField='jobDate'`, `gran='day'`, `customFrom`=today-30, `customTo`=today | `DateField` |
| `JobsReport` / `LeadsReport` / `SalesReport` / `PaymentsReport` | local unions | not read | selectable |

`ExpensesReport` and `ArAgingReport` (`AR_MOCK_NOW = new Date(2026,5,7,12,0,0)`) pin a fixed
"now" so their deterministic mock data resolves to stable dates. **Do not replace with
`new Date()`** - fixtures are seeded relative to them.

Non-`DateRangeControl` date idioms: `EstimatesReport` four preset buttons (all/30/90/365);
`InvoicesReport` a `SelectField` of `all·7d·30d·90d·month·custom`; `EstimateConversionReport`
a range preset `SelectField` plus a `DateAnchor` model; `ActivityFilterBar` six named presets
that (per its own comment) do not yet narrow data; `payments-report-logic.ts` exports its own
`DATE_PRESETS` + `resolveRange` + `priorRange`.

### 8.4 Filter surface summary - six coexisting idioms, map consistently but do **not** merge

1. `DateRangeControl` - the two-row card (8 reports).
2. `MultiSelectFilter` from `_shared` - the "All statuses / 2 reps" dropdown (6 reports).
3. `FacetFilter` from `_shared` - the chip-input multi-column picker (Expenses only).
4. `SelectField` - plain single-selects (most reports).
5. `ActivityFilterBar` - shadcn `DropdownMenu` facets with cascading options + chips
   (Activity only).
6. Multi-column filter **panels** - locally defined in `JobsReport`, `LeadsReport`,
   `SalesReport`, `PaymentsReport`, `InvoicesReport` (Status · Team · Created By · Tags ·
   Job Type · Job Origin · Source, varying per report).

## 9. Loading, empty and error states

### 9.1 Shell-level

| Situation | Render |
|---|---|
| Lazy chunk loading | `ReportRoute` Suspense: `<div className="p-6 text-sm text-text-secondary">Loading report…</div>` |
| Known slug, not visible for this org | `ReportStubPage` "coming soon" |
| Unknown slug | `ReportStubPage` "Report not found" |
| Catalog slug, no bespoke component | `GenericReport` (never a stub) |
| Category tab, no visible cards | dashed panel "No {tab} reports available for your role." |
| Custom tab | dashed panel "No custom reports yet" |

### 9.2 Per-report loading - only three reports show one

- `ArAgingReport` - `arLoading` drives the DSO tile: value `'—'`, sub `'Loading…'`
  (`:262-263`). `arError` is destructured (`:160`) but **its render path was not located** -
  see Q2.
- `EstimateConversionReport` - `loading={isLoading || !data}` on two KPI blocks (`:636`,
  `:651`), `loading={drillLoading}` on the drill table (`:838`), "Loading…" or "N estimates"
  in the drill header (`:420`), and a distinct no-data branch when `!hasData && !isLoading`
  (`:667`).
- `ServicePlansReport` - `<KpiStrip loading={isLoading} ...>` (`:25`).

Every other live-data report renders its empty shape while in flight, because hooks return
`live.data ?? []`. **No global skeleton, no error boundary.**

### 9.3 Empty states (`ResizableTable.empty`, all set)

| Report | `empty` string |
|---|---|
| ArAging | "No invoices match this filter." |
| CampaignRoi | "No campaigns match these filters." |
| Commissions (x2 views) | "No data available in table" |
| EstimateConversion | "No rep activity in this range." / "No estimates match." |
| Estimates | "No estimates match these filters." / "No reps match this filter." |
| Expenses | "No expenses match these filters." |
| GenericReport | "No {entity}s match this filter." |
| Invoices | "No invoices match these filters." |
| ItemsServices | "No items or services match these filters." / "No technician data for this item." / "No items on record for this technician." |
| JobProfitability | "No jobs match these filters." |
| JobStatistics | "No jobs in this range." / "No call-back data for this period." / "No call-backs in this period." / "No completed jobs in this period." (x2) |
| Jobs | "No jobs match these filters." |
| Leads | "No leads match these filters." |
| Payments | "No payments match these filters." |
| Sales | "No sales match these filters." |
| TechPerformance | "No technicians match these filters." |
| Timesheets | "No timesheet data." / "No attendance data." / "No job-attributed time yet." / "No punches recorded." |

Panels: `MetricDetailPanel` "No data for this selection."; `PersonMetricPanel` "No records
for this card."

### 9.4 Error states

**There is no error UI in the reports module.** No `isError` branch renders a message on any
page (`ArAgingReport` destructures `arError` but nothing was found consuming it). A failed
`/api/reports/*` call degrades to an empty table with the normal `empty` string. Reproduce
as-is; adding error states is a behaviour change and should be raised separately.

## 10. Selector surface, tests

### 10.1 data-testid

`grep -rn "data-testid" frontend/src/pages/reports/` -> **zero hits.**
`pages/ReportsPage.tsx` and `pages/MarketingAnalyticsPage.tsx` also have none. **The reports
module has no `data-testid` attributes at all** - the plan's "carry over every `data-testid`"
rule is vacuous here. What exists instead:

- **`aria-label`s** (most stable handles): "Customer type", "Source", "Month", "Sort",
  "Range preset", "Rep", "Business unit", "Job type", "Status", "Team member",
  "Rows per page", "Date range", "Search estimates", "Technician", "Week", "Lead source",
  "Clear rep scope", "Close", "Close detail", "Close breakdown", "Clear all filters",
  "Approve", "Reject", "Remove {label} {value}".
- **Visible text**: report labels, tab labels, KPI tile labels, the `empty` strings above,
  stub copy.
- `<h1>` = `report.label` from `ReportShell`.

### 10.2 Existing automated coverage

| Spec | Covers |
|---|---|
| `pages/reports/report-catalog.test.ts` | `canShowReport` truth table (demo/real x mock/live, fails closed on `undefined`); cross-checks `reportCatalog` against `reportComponents` |
| `pages/reports/arAging.data.test.ts` | AR bucketing / aggregation logic |
| `pages/reports/estimates-report-logic.test.ts` | estimate status bucketing |
| `pages/reports/payments-report-logic.test.ts` | payments range resolution / KPI math |
| `src/__tests__/service-plans-report.test.tsx` | **the only component-level report test** - mocks `@/lib/api/service-plans`, asserts `ServicePlansReport` reads the real API hook not the Zustand store (#156); renders via `renderWithProviders`, asserts tile values by text |
| `src/__tests__/activity-panel-reschedule.test.tsx` | **not a reports test** - covers `components/shared/ActivityPanel` (job timeline), despite the name |

**Playwright:** `grep -rln "reports" frontend/e2e/` returns three workflow specs
(`day-02-sales-pipeline`, `redesign-16-job`, `redesign-27-dispatcher-day`) but every hit is
the English word "reports" in a comment or fixture string. **No e2e spec exercises any
reports route.**

**Migration consequence:** the reports module has essentially no UI regression net. A v2 build
here is higher-risk than modules with e2e coverage. Phase 3 should add at minimum: a
`/reports` landing render per role, a `/reports/:slug` dispatch matrix (built / generic /
stub), and one drill-open assertion on EstimateConversion or Activity.

## 11. Migration risk notes

1. **`ReportShell` is the whole module's leverage point** - re-skin it and 23 pages follow.
   Its `actions` slot contract (`ml-auto flex items-center gap-2`) is depended on by every
   consumer.
2. **`GenericReport` covers 26 of 49 catalog slugs** - worth more than any single bespoke
   report.
3. **Charts do not move** - section 6.1 is the hard boundary.
4. **Seven files are 29-44 KB** (`JobStatistics` 44, `Commissions` 42, `EstimateConversion`
   39, `Jobs` 39, `Leads` 33, `Sales` 32, `Expenses` 29). Consider sub-PRs or deferring the
   largest four to a second reports PR, as the plan allows for Schedule.
5. **`TimesheetsReport` is the only page with mutations**, and the only one reading role
   (`useAuthStore`) and org timezone. Its own review unit.
6. **`CallTrackingReport` and `TimesheetsReport` import from other modules**
   (`components/communication/phone/*`, `components/timeclock/*`). If Communication
   (module 12) or a timeclock surface migrates in parallel, these two inherit whatever those
   modules do. Coordinate.
7. **Both open report branches touch ~40 of these files.** A `main`-based v2 build will not
   conflict (new files under `pages/v2/`), but any temptation to "just fix" a shared file in
   `pages/reports/` will.
8. **`_shared.tsx` and `MetricDetailPanel.tsx` already violate the raw-colour rule** - log
   separately, do not fix inside a presentation-only PR.

## Open questions

- **Q1.** What does `ProtectedRoute` render when `fallback` is set and the role check fails -
  `<Navigate to="/not-authorized">`, `NotAuthorizedPage` inline, or a redirect to `/`? Not
  opened. v2 doesn't change it, but the test agent needs the answer to assert the
  Sales/Technician path on `/reports`.
- **Q2.** `ArAgingReport.tsx:160` destructures `isError: arError`, but no consuming render
  branch was located. Either dead, or in a section not surfaced by the greps run. Confirm
  before treating "no error UI in the module" as exhaustive.
- **Q3.** `useCommunicationTrackingReport` calls `GET /api/reports/communication-tracking`,
  which does not exist in `report.routes.ts` on `main` **or** `origin/staging`. The component
  defaults local `isDemo` to `true` so it never fires by default. Is the "Live" toggle a
  known-broken dev affordance, or is the route registered elsewhere?
- **Q4.** Do v2 pages import the existing shared components (`KpiStrip`, `ResizableTable`,
  `ChartCard`, `SelectField`, `Sheet`, `FilterChip`) unchanged, or use kit equivalents (the
  kit DataTable suite in place of `ResizableTable`)? **Biggest scoping decision for the
  module, and a cross-module one** - `ResizableTable` and `KpiStrip` are used well outside
  reports. Needs an owner decision before Phase 2.
- **Q5.** `ExpensesReport` (`NOW = 2026-05-06`) and `ArAgingReport`
  (`AR_MOCK_NOW = 2026-06-07`) pin fixed clocks for their seeded fixtures. Confirm these stay
  pinned in v2 (they must, or demo data shifts) and that no reviewer flags them as a bug.
- **Q6.** Preset **unions** were recorded for all eight `DateRangeControl` consumers, but the
  **default preset** was read only for `JobStatisticsReport` (`'month'`). A builder must read
  the remaining seven defaults from source rather than assuming `'month'`.
