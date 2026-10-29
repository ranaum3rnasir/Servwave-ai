# Dashboard - components with no kit equivalent

Module 1. Branch `refactor/ui-kit-01-dashboard`, built against
`md_files/specs/ui-redesign/dashboard-behavior-map.md`.

Scope: one route, `/` -> `/v2/`. Legacy `pages/DashboardPage.tsx` and everything
under `pages/dashboard/` is untouched, and `components/layout/HomeRoute.tsx`
still resolves `/` exactly as it does today.

## What was imported rather than rebuilt

The customisation system is business logic, not chrome, and every piece of it is
used as it stands. A fork would be a second definition of what a user's saved
layout MEANS, and the failure mode is silent - a drifted widget id is a widget
that stops rendering for everyone who has already customised their page.

| Imported | From | Why it may not be forked |
|---|---|---|
| `useDashboardLayout` | `pages/dashboard/layout/useDashboardLayout` | Owns the localStorage key `alpha:dashboard-layout:v1:<userId>`, the merge-forward restore, and `reorder`'s splice arithmetic (remove-then-insert over the FULL array including hidden items, so a downward drag lands after the target and an upward drag before it). |
| `DEFAULT_LAYOUT` | `pages/dashboard/layout/defaultLayout` | Reached through the hook. The 19 ordered entries are what a fresh user sees. |
| `SIZE_SPAN`, `TimeRange`, `WidgetDef`, `LayoutItem` | `pages/dashboard/layout/types` | The four grid spans and the layout item shape. |
| `WIDGETS` | `pages/dashboard/layout/widgetRegistry` | Ids, titles, categories and `defaultSize` for all 24 widgets. `pages/v2/dashboard/widgetRegistry.tsx` DERIVES from this object and overrides only `render`; it never restates an id. |
| `EditableWidget` | `pages/dashboard/layout/EditableWidget` | Edit chrome plus the native HTML5 drag source. See the gap row. |
| `CatalogDrawer` | `pages/dashboard/layout/CatalogDrawer` | The add-widget rail. See the gap row. |
| `KpiCard` | `pages/dashboard/widgets/KpiCard` | See the gap row - the kit's `statCard` cannot carry its meta line. |
| `computeInsights` | `lib/dashboard/insightRules` | The whole Smart Insights rule set: which insight fires, its weight, tone, copy and link. |
| `useDashboard` | `lib/api/dashboard` | The single query, its `['dashboard', {}]` key, its 60s staleTime and 120s poll, and the mock seam. |
| `IN_FLIGHT_STATUSES` | `components/schedule/scheduleModel` | Branch 3 of `pillStyle`. |
| `SegmentedDonut` | `components/charts` | See the gap row. |
| `token`, `chartPalette` | `design-system` | Chart colour. See the gap row. |
| `formatCurrency`, `formatCurrencyWhole`, `getInitials` | `lib/utils` | Org-aware money and initials. |
| `NewEstimateDialog` | `components/estimates/NewEstimateDialog` | The New Estimate item opens a chooser, it does not navigate. |
| `DEFAULT_LAYOUT_KEYS`, `getDestination` | `components/layout/nav-registry` | The landing resolution in `V2HomeRoute`. |

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `pages/dashboard/widgets/KpiCard` | all ten `kpi.*` widgets | clickable KPI tile: icon chip + label, a 26px value, an optional `TrendDelta`, and a META LINE under it (`"42% of $80,000 goal"`, `"3 jobs done"`, `"12 won · 4 lost · 30d"`) | `ui-kit/components/data/statCard` | Three misses, one of them fatal. (1) NO META SLOT: `StatCard` renders label, value and a delta badge and nothing else - it spreads `...props` onto the host but then supplies its own JSX children, so a `children` passed in is discarded. All ten tiles have a meta line, so adopting it would delete a line of real information from every one. (2) NO ICON SLOT, by explicit design ("Deliberately no icon tile"). (3) The delta badge variant is keyed off `direction`, so sign and sentiment cannot disagree; `KpiCard` separates them (`good`) precisely so a falling cost can read as good. Today all three delta-bearing KPIs happen to agree, so this one is a latent loss, not a live one. Tiles reused unchanged. | BUILD - `statCard` needs a footnote/meta slot; it is generic and every list page would use it |
| `pages/dashboard/layout/EditableWidget` | the grid, in edit mode | wraps each cell with a drag source, a per-widget time-range select and a hide button; renders a BARE FRAGMENT when not editing | `ui-kit/components/ui/select` + `ui-kit/components/ui/button` | The kit has the two controls but nothing for what this component actually is. Reused whole on instruction, and the reasoning holds: the zero-DOM path when `edit === false` is a layout contract (any wrapper at all would change every widget's spacing on the normal page), the drag source is the native HTML5 API with no library behind it, and the `aria-label="Widget time range"` / `aria-label="Hide widget"` names are the only handles the edit surface has. | KEEP |
| `pages/dashboard/layout/CatalogDrawer` | edit mode, right rail | search + category sections over `Object.values(WIDGETS)`, `＋`/`✓` per row, a sticky non-modal `<aside>` | `ui-kit/components/ui/sheet` | `Sheet` is a modal overlay; this is a sticky rail INSIDE the page flex row, and the page's grid narrows to make space for it. Making it a Sheet would change the layout, not the styling. Reused whole. It also reads `WIDGETS` directly, which is the same object the v2 registry derives from, so the drawer and the grid cannot disagree about what exists. Its unit test (`layout/__tests__/CatalogDrawer.test.tsx`) pins `truncate min-w-0`, `title={w.title}` and the `Add ${title}` aria-label; reusing it keeps all three true by construction. | KEEP |
| `components/charts` (`SegmentedDonut`, 10 files) | `jobs_by_status`, `revenue_by_job_type` | hand-written SVG arc donut with a track, gap degrees and rounded caps | nothing | The kit ships no chart component of any kind. Reused as-is, with `chartPalette` for the segment colours. | KEEP |
| `recharts` + `design-system/tokens` (`token`, `chartPalette`) | `revenue_chart` | `ComposedChart`: invoiced bars on a neutral track, collected bars in success green with only the current month saturated, and a dashed target reference line | nothing | No chart component, and colour INSIDE a chart carries meaning, so substituting a kit token in a chart prop would be a behaviour change. The whole subtree from `<ResponsiveContainer>` down, plus the three legend swatches that have to match it, is carried over unchanged. | KEEP |
| `components/estimates/NewEstimateDialog` | the New menu, "New Estimate" | chooser for the anchor (lead / customer / job) an estimate must be created against | nothing | It is a feature, not chrome, and it belongs to the Estimates module. Reused unchanged. | KEEP |

## Replaced (the audit trail)

Every `@/components/...` import across `pages/DashboardPage.tsx`,
`pages/dashboard/NewMenu.tsx`, `pages/dashboard/layout/*` and
`pages/dashboard/widgets/*`.

### `pages/DashboardPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `components/ui/heading` (`Heading`) | `ui-kit/components/layout/pageHeader` (`PageHeader`) | The greeting is the header title and the date line its `description`, so the block is one primitive instead of a heading plus a hand-styled paragraph. `PageHeader` supplies its own `h1`. |
| raw `<button>` edit toggle | `ui-kit/components/ui/button` | Two fill states, `bg-primary` idle and `bg-ocean-700` while editing, which the legacy file documented as having no matching tone cell. On the kit they are `variant="default"` and `variant="secondary"` - the same "this control is currently engaged" signal, said with a variant instead of a colour class. Icon and label unchanged. |
| `components/ui/button` (`Reset to default`) | `ui-kit/components/ui/button` | Still `variant="link"`, still no confirmation step. |
| `pages/dashboard/NewMenu` | `pages/v2/dashboard/components/newMenu` | See below. |
| `pages/dashboard/layout/{EditableWidget,CatalogDrawer,useDashboardLayout,types}` | themselves (imported) | gap rows above |
| `pages/dashboard/layout/widgetRegistry` (`WIDGETS`) | `pages/v2/dashboard/widgetRegistry` (`V2_WIDGETS`) | Derived from `WIDGETS`, `render` overridden per id. Metadata never restated. |
| edit-mode toolbar, hand-built `div` | plain `div`, kit tokens | `bg-primary-subtle` -> `bg-brand-subtle`, `text-primary` -> `text-brand-emphasis`. Not a `Card`: the toolbar is a tinted strip, and tinting a `Card` means an appearance class at the call site, which the component-API ratchet holds at its floor of 2. |

### `pages/dashboard/NewMenu.tsx` -> `components/newMenu.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| hand-rolled `role="menu"` div + document `mousedown`/`Escape` listeners | `ui-kit/components/ui/dropdownMenu` | Radix owns dismissal, focus return, typeahead and roving focus. The SELECTOR SURFACE is unchanged, which is what the e2e suite reads: the trigger is still `role="button"` named `New`, each item still `role="menuitem"` with its exact label. |
| `components/ui/button` (trigger) | `ui-kit/components/ui/button` | `variant="solid" tone="brand"` -> the kit's default. `size={null}` + manual padding -> `size="sm"`. |
| six raw `<button>` items | `DropdownMenuItem` | Same six labels, same order, same destinations, including `Request Payment` -> `/invoices` (the list, not a payment form) and `New Estimate` -> the dialog. Still NO permission gating, deliberately: the gate is on the destination route. |

### `pages/dashboard/widgets/_shared.tsx` -> `components/widgetCard.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `components/ui/heading` (`Heading level={2}`) | `ui-kit/components/ui/card` (`CardTitle`) | Same four-slot API (`title` / `icon` / `right` / children), so a widget body ports by changing one import. The hand-built surface and header rule are now `Card` + `CardHeader`, and the right slot is `CardAction`. |
| `money0` / `compactCurrency` | `lib/utils` `formatCurrencyWhole` | Both were already one-line aliases of it; the v2 widgets call the shared formatter directly rather than re-export an alias. Identical output. |

### `pages/dashboard/widgets/*` -> `widgets/*`

| Old component | Replaced by | Notes |
|---|---|---|
| `KpiCard` | itself (reused) | gap row above |
| `_shared` (`WidgetCard`) | `components/widgetCard` (`WidgetCard`) | 9 widgets. |
| `components/ui/empty-state` (`EmptyState`) | `ui-kit/components/data/emptyState` | Three sites: `Nothing scheduled`, `No recent activity`, and the two `ComingSoon` stubs (whose two-line copy is now `title` + `description` instead of two hand-styled paragraphs). `All clear - nothing needs attention` was a bare centred div and is now an `EmptyState` too. No `className` at any site - that ratchet is at its floor of 5. |
| `components/ui/button` (`Full calendar`, `View all` x2, `Report`) | `ui-kit/components/ui/button` | `variant="link" tone="brand" size={null}` -> `variant="link" size={null}`. |
| raw `<button>` list rows (Needs Attention, Today's Schedule, Pipeline, both scoreboards, Lead Sources, Coming Up, Smart Insights) | `ui-kit/components/ui/button` | The legacy files left these raw with a comment ("not a Button-shaped control"). They render through the kit Button here carrying LAYOUT only, so the element, focus ring and press affordance are the kit's. `variant="ghost"` where the row has no colour of its own; `variant={null}` for the two that do - a Today's Schedule row, whose fill IS the status signal, and a Smart Insights tile, which carries the AI tint. Zero raw `<button>` added: that ratchet is at its floor of 664. |
| `components/data/TrendDelta` | itself, via the reused `KpiCard` | Not imported directly by any v2 file. |
| severity / status colour classes (`bg-danger/10`, `bg-info/10`, `bg-warning/20`, `bg-sage-50`) | kit status subtles (`bg-status-red-subtle`, `bg-status-blue-subtle`, `bg-status-amber-subtle`, `bg-status-green-subtle`) | Needs Attention's icon chips and Smart Insights' tone chips. One namespace to another, meaning for meaning - danger stays red, info blue, warning amber, success green. |
| Needs Attention severity badges, hand-built spans | `ui-kit/components/ui/badge` | `variant="softRed" / "softAmber" / "softBlue"`, plus `variant="red" size="pill"` for the header count. No `className` - that ratchet is at its floor of 10. |
| `text-text-primary` / `text-text-secondary` / `bg-surface-light` / `bg-border-soft` | `text-foreground` / `text-muted-foreground` / `bg-kit-card` (via `Card`) / `bg-muted` | Applied to the widget CHROME only. Chart-adjacent colour - the pipeline bar gradient, the scoreboard bar fill, the donut palette, the revenue-chart legend swatches - is left on the app ramp, because it has to match a value the chart itself computes. |
| `TodaySchedule` `pillStyle` (5 branches) | itself, copied class for class | NOT retoned. The row wash, left accent and inset tag are one composite treatment across two axes (walkthrough vs job, then status), and `status-registry.ts` deliberately withholds a left-accent role - resolving only the tag through it would wash the row in one hue and its tag in another. The branch ORDER is a behaviour contract asserted by the legacy unit test. |
| `TodaySchedule` avatar `GRADIENTS` | itself, copied | Decorative per-tech identity keyed off a hash of `user_id`, not a status signal. |

### Non-component imports carried over unchanged

`react-router-dom` (`useNavigate`, `Navigate`), `@/stores/auth.store`,
`@/contexts/AbilityContext`, `lucide-react`, `recharts`.

## Deliberate presentation changes

Not behaviour changes, but visible ones, listed so a reviewer does not have to
find them in the diff.

| What | Was | Now | Why |
|---|---|---|---|
| Em dashes in copy | five legacy strings separated their clauses with an em dash: the header subline, the Needs Attention empty state, the edit-toolbar copy, `formatTime(null)`, and the Unassigned lane's placeholder initials | plain hyphen `-` in all five | CLAUDE.md: plain hyphens only, never em or en dashes, in prose or code. The legacy strings predate that rule. No test reads any of them. |
| Widget card heading | `Heading level={2}` -> an `h2` | `CardTitle` -> a `div` | The kit's `CardTitle` is a div by design. This is the one accessibility difference from the legacy shell: widget titles leave the heading outline. Flagged rather than worked around, because overriding it means reaching past the primitive. |
| Breadcrumb trail | n/a | still none | Every other v2 page renders `PageBreadcrumbs`. This page is the trail's own Home crumb, so a `Home > Workspace > Dashboard` row whose first link points at the page you are on would be chrome saying nothing. |
| `ComingSoon` stub body | two hand-styled paragraphs | kit `EmptyState` `title` + `description` | Same two strings. |
| `NewMenu` panel | 176px hand-positioned div, `top-11 right-0` | Radix popper, `align="end"` | Same width (`w-44`), now collision-aware. |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| `/v2` in the shared `V2Routes.tsx` is still `<Navigate to="/v2/leads" replace />`, a placeholder added because this module did not exist. It now OVERLAPS this module's `/v2/` route. Route ranking resolves it in the dashboard's favour (`/v2/` scores 15, `/v2` scores 13) and `dashboard/__tests__/dashboardRoute.test.ts` pins that, but the placeholder should be pointed at the dashboard or deleted. | `pages/v2/V2Routes.tsx:55` | `V2Routes.tsx` is a shared file that fourteen branches read. ESCALATED to the integrator as a one-line change. |
| Closing the catalog drawer while still in edit mode leaves NO affordance to reopen it - the close button only sets `catalogOpen=false`, and the only control that sets it true is the edit toggle. The way back is `Done` then `Customize home page`. | `pages/dashboard/layout/CatalogDrawer` + the page's `toggleEdit` | Reproduced as-is. Adding a reopen control is a new affordance, not a restyle. |
| `Reset to default` overwrites the saved layout immediately, with no confirmation. | edit toolbar | Same reason. The kit ships a `confirmDialog`, so this is a cheap follow-up. |
| The per-widget time-range control PERSISTS but is INERT: `EditableWidget` writes `range` through `update(id, {range})` and the page passes it into `render({data, range, navigate})`, and not one render function in either registry reads `ctx.range`. The toolbar copy still advertises it. | `widgetRegistry.tsx` (both), `EditableWidget` | Wiring it up would change what every widget shows. The map calls this out too; it needs a product decision, not a presentation swap. |
| `LayoutItem.size` is honoured on read but NO control ever writes it. There is no resize UI. | `types.ts`, the render loop | Reproduced. Either a resize control was planned or the field is dead; not this branch's call. |
| `defaultVisible` is read by nothing at runtime - `DEFAULT_LAYOUT` alone decides the fresh-user page. `revenue_by_job_type` sits under the registry's "hidden by default" comment while shipping `defaultVisible: true` AND being in `DEFAULT_LAYOUT`. | `widgetRegistry.tsx`, `defaultLayout.ts` | Dead field plus a stale comment in a legacy file. |
| Both scoreboards caption `14 days`. The server aggregates ALL completed jobs with no date window. | `Scoreboards.tsx` | A copy bug. Reproduced exactly; fixing it is a content decision. |
| Every `Coming Up` row navigates to `/schedule`, not to the job it names. | `Catalog.tsx` `ComingUp` | Reproduced. Changing where a row goes is a behaviour change. |
| Smart Insights' past-due insight links to `/invoices`, while the `kpi.ar` tile links to `/reports/ar-aging`. Two controls about the same number go to two places. | `lib/dashboard/insightRules.ts`, `widgetRegistry.tsx` | Shared rules file. Reproduced. |
| `LeadSourcesWidget` navigates to `/leads?source=${s.source}` with the raw source key, NOT URL-encoded. A source containing `&` or `#` would break the query. | `Scoreboards.tsx` | Reproduced character for character - the leads list filter reads that exact param. Encoding it is a correctness fix with a matching change needed at the reader. |
| No loading, error or skeleton state anywhere. The page destructures only `data`; `isLoading`, `isError` and `error` are discarded, and every KPI reads through `?? 0`. A first paint, an empty org and a 403 are indistinguishable - all three render zeros forever, with no toast and no retry. | `DashboardPage` (both) | The map is explicit that adding skeletons here is a behaviour change, not a presentation swap. Raised as a scoped follow-up. |
| `onDragStart` never calls `e.dataTransfer.setData(...)`. Chrome tolerates the omission; Firefox historically will not start a drag without it. Unverified either way. | `EditableWidget` | Reproduced by reusing the component. A `setData` call is a non-visual fix but still a behaviour change, and it needs a browser to verify. |
| Widget reordering has NO keyboard path at all. The grip is a `<span>`, there is no `tabIndex`, no key handler and no ARIA drag-and-drop; drag is mouse-only. It does not use dnd-kit - it is the native HTML5 API - so there is no library keyboard sensor to preserve either. | `EditableWidget` + the page's `dragId` ref | Building a keyboard reorder path is a new feature. Flagged as the module's largest accessibility gap. |
| `RevenueChart` resolves three of its four colours with `token()` at MODULE scope, i.e. once per session, so a live theme change would not reach them. | `RevenueChart.tsx` (both) | Harmless with one theme. Carried over unchanged rather than "fixed" inside a chart boundary. |
| `useDashboard` supports `period`, `date` and `department_id`; the page calls `useDashboard({})` and no UI exposes any of them. The revenue chart is therefore always 6 months and the schedule always today. | `DashboardPage` (both) | Adding a period switcher is a feature. |
| Nothing anywhere invalidates the `['dashboard']` query key. Freshness comes only from `staleTime` plus the 120s poll, so an action taken elsewhere in the app never refreshes the home page. | repo-wide | Cross-module concern. |
