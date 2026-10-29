# Dashboard - Behaviour Map (UI Kit Migration, Module 1)

Status: mapping complete 2026-07-29. Documentation only - no code was changed.
Scope: route `/` (HomeRoute -> DashboardPage) plus the entire widget system under
`frontend/src/pages/dashboard/`.

Every statement below was read from the files named. Nothing is inferred from naming.
Anything genuinely ambiguous is in section 13 (Open questions), not guessed at.

---

## 0. File inventory (the contract surface)

| File | Lines | Role |
|---|---|---|
| `frontend/src/App.tsx` | (route block ~109-113) | mounts `/` -> `HomeRoute` inside `ProtectedRoute` + `AppLayout` |
| `frontend/src/components/layout/HomeRoute.tsx` | 42 | ability-aware landing resolver |
| `frontend/src/components/layout/nav-registry.ts` | 114 | `NAV_REGISTRY`, `DEFAULT_LAYOUT_KEYS`, `getDestination` |
| `frontend/src/pages/DashboardPage.tsx` | 110 | page shell, grid, edit mode, drag orchestration |
| `frontend/src/pages/dashboard/NewMenu.tsx` | 63 | "New" quick-create dropdown |
| `frontend/src/pages/dashboard/layout/types.ts` | 36 | `LayoutItem`, `WidgetDef`, `SIZE_SPAN` |
| `frontend/src/pages/dashboard/layout/defaultLayout.ts` | 25 | `DEFAULT_LAYOUT` (19 entries) |
| `frontend/src/pages/dashboard/layout/useDashboardLayout.ts` | 72 | localStorage persistence hook |
| `frontend/src/pages/dashboard/layout/widgetRegistry.tsx` | 172 | `WIDGETS` map - 24 widget defs |
| `frontend/src/pages/dashboard/layout/EditableWidget.tsx` | 62 | edit-mode chrome + HTML5 drag |
| `frontend/src/pages/dashboard/layout/CatalogDrawer.tsx` | 65 | add-widget side drawer |
| `frontend/src/pages/dashboard/widgets/_shared.tsx` | 42 | `WidgetCard`, `money0`, `compactCurrency` |
| `frontend/src/pages/dashboard/widgets/KpiCard.tsx` | 51 | generic KPI cell |
| `frontend/src/pages/dashboard/widgets/SmartInsights.tsx` | 34 | insight band |
| `frontend/src/pages/dashboard/widgets/NeedsAttention.tsx` | 66 | attention list |
| `frontend/src/pages/dashboard/widgets/TodaySchedule.tsx` | 91 | per-tech lanes |
| `frontend/src/pages/dashboard/widgets/RevenueChart.tsx` | 59 | recharts ComposedChart |
| `frontend/src/pages/dashboard/widgets/PipelineFunnel.tsx` | 38 | CSS bar funnel (NOT recharts) |
| `frontend/src/pages/dashboard/widgets/Scoreboards.tsx` | 73 | `RankedBarList` + `LeadSourcesWidget` |
| `frontend/src/pages/dashboard/widgets/Catalog.tsx` | 122 | `JobsByStatus`, `RevenueByJobType`, `ComingUp`, `RecentActivity`, `ComingSoon` |

Shared imports the v2 build MUST reuse rather than fork:
`@/lib/api/dashboard` (`useDashboard`), `@/lib/dashboard/insightRules` (`computeInsights`),
`@/lib/api/_mock/dashboard` (types, via the seam only), `@/stores/auth.store`,
`@/components/ui/TrendDelta`, `@/components/common/SelectField`,
`@/components/charts` (`SegmentedDonut`), `@/design-system` (`token`, `chartPalette`),
`@/components/schedule/scheduleModel` (`IN_FLIGHT_STATUSES`),
`@/lib/utils` (`formatCurrency`, `formatCurrencyWhole`).

---

## 1. Route and guards

### 1.1 Route chain

```
/  ->  <ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']}>
         <AppLayout>                       // sidebar + <main className="... p-4">
           <Route path="/" element={<HomeRoute />} />
```
`HomeRoute` is `React.lazy`-imported in `App.tsx:20`; the whole `<SentryRoutes>` tree
sits inside one `<Suspense fallback={<PageLoader />}>` (`App.tsx:98`).
`DashboardPage` is itself lazy-imported inside `HomeRoute.tsx:6`, so landing on `/`
costs two lazy chunk loads, both covered by that single Suspense boundary.

### 1.2 HomeRoute resolution (exact)

```ts
if (ability.can('read', 'Dashboard')) return <DashboardPage />;

const firstAllowed = DEFAULT_LAYOUT_KEYS
  .map(getDestination)
  .find(dest => dest && dest.key !== 'dashboard' && !dest.comingSoon
                && ability.can(dest.action, dest.subject));

return <Navigate replace to={firstAllowed?.href ?? '/leads'} />;
```

`DEFAULT_LAYOUT_KEYS` order (nav-registry.ts:93):
`dashboard, schedule, tasks, leads, jobs, clients, estimates, invoices, service-plans,
pricebook, billing, reports, inventory, communication, marketing`.
`communication` and its children carry `comingSoon: true`, so they can never be the
landing target. `marketing` is `demoOnly` but NOT `comingSoon`, so it *is* eligible.

### 1.3 Per-role landing (grants read from `backend/src/lib/permissions/defaultGrants.ts`)

| Role | `read Dashboard`? | Lands on |
|---|---|---|
| **ADMIN** | yes - `defineAbility.ts:59` short-circuits ADMIN to `manage all` | **DashboardPage** |
| **DISPATCHER** | yes - explicit grant `defaultGrants.ts:71` | **DashboardPage** |
| **SALES** | **no** - deliberately withheld (comment at `defaultGrants.ts:20-22`: org-wide financials are admin/dispatcher only) | first allowed nav item. SALES has no `read Job` -> skips `schedule`; has `read Task` -> **`/tasks`** |
| **TECHNICIAN** | **no** grant | has `read Task` (`defaultGrants.ts:151`) and `read Job` scoped to OWN_JOB (`:157`). `schedule` (`read Job`) precedes `tasks` in `DEFAULT_LAYOUT_KEYS`, and CASL `can('read','Job')` with only a *conditioned* rule still returns true for a bare subject type -> **`/schedule`** |

Fallback `/leads` fires only when the ability grants nothing at all.

The frontend ability comes from `buildAbility(rules)` in `stores/auth.store.ts`
(lines 88/120/181/208) and is published through `AbilityProvider` in `App.tsx:199`.
It mirrors the backend rules, so the frontend gate and the API gate agree.

### 1.4 API-side guard

`backend/src/routes/dashboard.routes.ts`:
```
router.use(authenticate, attachAbility);
router.get('/', canDo('read','Dashboard'), dashboardController.getDashboard);
```
So a SALES/TECHNICIAN who reaches `/` by any other path would 403 - which is exactly
the bug HomeRoute exists to prevent (see its own docblock).

**v2 requirement:** `/v2/` must go through the same `HomeRoute` logic. Rendering
`pages/v2/DashboardPage` directly at `/v2` would reintroduce the 403 landing for
SALES and TECHNICIAN.

---

## 2. The widget system architecture

### 2.1 Three-part model

```
DEFAULT_LAYOUT      (ordered list of {id, visible})  - what a fresh user sees
useDashboardLayout  (localStorage, per user)         - the user's mutated copy
WIDGETS registry    (id -> WidgetDef)                - what an id means / renders
```
The layout array is the ordering and visibility authority. The registry is a pure
lookup. A layout entry whose id is missing from `WIDGETS` is silently skipped
(`DashboardPage.tsx:82-83`) - forward-compatible with removed widgets.

### 2.2 Types (`layout/types.ts`)

```ts
type WidgetSize = 'kpi' | 'third' | 'half' | 'full';
type TimeRange  = 'today' | '7d' | '30d' | 'month' | 'all';

interface LayoutItem { id: string; visible: boolean; size?: WidgetSize; range?: TimeRange }
type DashboardLayout = LayoutItem[];

interface WidgetRenderCtx { data: DashboardResponse | undefined; range: TimeRange; navigate: (to:string)=>void }

interface WidgetDef {
  id: string;
  title: string;
  category: 'KPI'|'Operations'|'Financial'|'Sales'|'Pipeline'|'Team';
  defaultSize: WidgetSize;
  defaultVisible: boolean;
  defaultRange?: TimeRange;
  render: (ctx: WidgetRenderCtx) => ReactNode;
}

const SIZE_SPAN = {
  kpi:   'col-span-6 sm:col-span-3 lg:col-span-2',
  third: 'col-span-12 lg:col-span-4',
  half:  'col-span-12 lg:col-span-6',
  full:  'col-span-12',
};
```
Grid container: `grid grid-cols-12 gap-3.5 flex-1 auto-rows-min`
(`DashboardPage.tsx:78`). Responsive: KPI cards are 2-up on mobile, 4-up at `sm`,
6-up at `lg`; band widgets are full-width below `lg`.

### 2.3 Render loop (`DashboardPage.tsx:79-103`) - reproduce exactly

```
layout.filter(item => item.visible).map(item => {
  const def = WIDGETS[item.id];        if (!def) return null;
  const size  = item.size  ?? def.defaultSize;
  const range = item.range ?? def.defaultRange ?? '30d';
  const el    = def.render({ data, range, navigate });
  if (!el) return null;                // a widget may veto its own cell
  return <div className={SIZE_SPAN[size]}>
           <EditableWidget id={item.id} edit={edit} range={range}
             onHide={() => update(item.id, {visible:false})}
             onRange={r => update(item.id, {range:r})}
             onDragStart={id => dragId.current = id}
             onDrop={id => { if (dragId.current) reorder(dragId.current, id); dragId.current = null; }}>
             {el}
           </EditableWidget>
         </div>;
})
```
Two non-obvious behaviours to preserve:
- **Self-vetoing widgets.** `def.render(...)` returning `null` removes the grid cell
  entirely (no empty box). Only `kpi.recurring` does this today (when
  `data.kpis.recurring` is null, i.e. no active service plans) - and, incidentally,
  during the whole loading window, because `data` is `undefined` then.
- **`size` is never written by the UI.** No control sets `LayoutItem.size`; it exists
  in the type and is honoured on read, but every widget renders at `def.defaultSize`
  unless someone hand-edits localStorage.

### 2.4 Layout persistence (`useDashboardLayout.ts`)

- **Store:** `localStorage`. **Not** the backend. Key:
  `` `alpha:dashboard-layout:v1:${userId}` `` where `userId = useAuthStore(s => s.user?.id) ?? 'anon'`.
- **Shape:** `JSON.stringify(LayoutItem[])`, e.g.
  `[{"id":"kpi.revenue_mtd","visible":true},{"id":"pipeline","visible":false,"range":"7d"}]`.
- **Restore (effect keyed on `userId`):** parse; if absent/invalid fall back to
  `DEFAULT_LAYOUT`. Then **merge-forward**:
  ```ts
  const savedIds = new Set(saved.map(i => i.id));
  const merged = [...saved, ...DEFAULT_LAYOUT.filter(i => !savedIds.has(i.id))];
  ```
  New default widgets are appended at the end; the user's order and their hidden
  choices are preserved. Any parse throw resets to `DEFAULT_LAYOUT` (state only -
  it does not clear the bad key).
- **Initial render** is `DEFAULT_LAYOUT` (useState initial value); the merged layout
  lands one effect tick later. Expect one frame of default ordering on mount.
- **Mutators** (all call `persist`, which does `setLayout` + `localStorage.setItem`
  inside try/catch that swallows quota/disabled-storage errors):
  - `update(id, patch)` - map-replace one item. Used for `visible:false` and `range`.
  - `reorder(fromId, toId)` - see 4.2.
  - `add(id)` - if the id already exists in the array, set `visible:true` in place
    (keeps its original position); otherwise **append** `{id, visible:true}` at the end.
  - `reset()` - persist `DEFAULT_LAYOUT` verbatim.
- No cross-tab sync, no `storage` event listener, no server write, no versioning
  beyond the `:v1:` key segment.

### 2.5 The registry (`widgetRegistry.tsx`) - all 24 ids

| id | title | category | defaultSize | defaultVisible | in DEFAULT_LAYOUT |
|---|---|---|---|---|---|
| `kpi.revenue_mtd` | Revenue MTD | KPI | kpi | true | yes (1) |
| `kpi.collected_today` | Collected Today | KPI | kpi | true | yes (2) |
| `kpi.recurring` | Recurring (Plans) | KPI | kpi | true | yes (3) |
| `kpi.ar` | Outstanding AR | KPI | kpi | true | yes (4) |
| `kpi.close_rate` | Close Rate | KPI | kpi | true | yes (5) |
| `kpi.jobs_today` | Jobs Today | KPI | kpi | true | yes (6) |
| `kpi.open_leads` | Open Leads | KPI | kpi | true | yes (7) |
| `kpi.avg_ticket` | Avg Ticket | KPI | kpi | true | yes (8) |
| `kpi.jobs_week` | Jobs This Week | KPI | kpi | true | yes (9) |
| `kpi.deposits` | Deposits Awaiting | KPI | kpi | true | yes (10) |
| `smart_insights` | Smart Insights | Sales | full | true | yes (11) |
| `needs_attention` | Needs Attention | Operations | half | true | yes (12) |
| `schedule_today` | Today's Schedule | Operations | half | true | yes (13) |
| `revenue_chart` | Monthly Revenue | Financial | half | true | yes (14) |
| `pipeline` | Revenue Pipeline | Pipeline | half | true | yes (15) |
| `tech_scoreboard` | Tech Scoreboard | Team | third | true | yes (16) |
| `dispatch_scoreboard` | Dispatch Scoreboard | Team | third | true | yes (17) |
| `lead_sources` | Top Lead Sources | Sales | third | true | yes (18) |
| `revenue_by_job_type` | Revenue by Job Type | Sales | third | true | yes (19) |
| `jobs_by_status` | Jobs by Status | Operations | third | **false** | no |
| `coming_up` | Coming Up | Operations | third | **false** | no |
| `recent_activity` | Recent Activity | Operations | third | **false** | no |
| `service_areas` | Service Areas | Operations | third | **false** | no (stub) |
| `recent_calls` | Recent Calls | Operations | third | **false** | no (stub) |

Note: `revenue_by_job_type` sits under the file's "Catalog (hidden by default)"
comment but is `defaultVisible: true` and *is* in `DEFAULT_LAYOUT` - the comment is
stale, the data is authoritative.

`defaultVisible` is **not read anywhere at runtime** - `DEFAULT_LAYOUT` is the only
thing that decides the fresh-user page. It is effectively documentation.
`defaultRange` is never set on any def.

The registry also defines a local helper used only by `kpi.ar`:
```tsx
const pill = (text, cls) => <span className={`inline-block px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold ${cls}`}>{text}</span>;
```

### 2.6 EditableWidget (`layout/EditableWidget.tsx`)

- **`edit === false` -> renders `<>{children}</>`, nothing else.** Zero wrapper DOM
  outside edit mode. Any v2 rewrite that always wraps will change layout/spacing.
- **`edit === true`** wraps the child in
  `relative rounded-xl ring-2 ring-dashed ring-border group` with `draggable`,
  `onDragStart`, `onDragOver={e => e.preventDefault()}`, `onDrop`, plus:
  - top-left: a `GripVertical` chip (`bg-ocean-800 text-white`, `cursor-grab
    active:cursor-grabbing`) - **decorative only**; the whole wrapper is the drag source.
  - top-right: `SelectField` (shadcn Select) with `aria-label="Widget time range"`,
    options `today | 7d | 30d | month | all` labelled `Today | 7d | 30d | Month | All`.
    Wrapped in a `div` with `onClick={e => e.stopPropagation()}`.
  - top-right: a hide button, `aria-label="Hide widget"`, `<X>` icon,
    `onClick` does `stopPropagation()` then `onHide()`.
  - the child is rendered inside `pointer-events-none select-none opacity-95` -
    **all widget interactions are dead while editing.** Deliberate: it prevents a
    drag from firing a navigation.

### 2.7 CatalogDrawer (`layout/CatalogDrawer.tsx`)

- Props: `{ open, layout, onAdd, onClose }`. Returns `null` when `!open`
  (state hook `useState('')` runs before the early return, so hook order is safe).
- Container: `<aside class="w-64 shrink-0 bg-white border border-border rounded-xl
  overflow-y-auto max-h-[82vh] sticky top-4 self-start">` - a sticky right rail
  inside the page flex row, **not** a modal/overlay/portal.
- Header: `＋ Add to home page` + close `<X>` button (no aria-label).
- Search input, placeholder `Search widgets & reports…`, filters
  `Object.values(WIDGETS)` by `w.title.toLowerCase().includes(q.toLowerCase())`.
- Sections in fixed order `CATS = ['Operations','Financial','Sales','Pipeline','Team','KPI']`.
  Empty sections are omitted. Within a section, order is `Object.values(WIDGETS)`
  insertion order (i.e. registry declaration order).
- Per row: title `<span class="min-w-0 flex-1 truncate font-semibold" title={w.title}>`,
  then either
  - `✓` (`<span title="Already on your page">`) when the id is in
    `new Set(layout.filter(i => i.visible).map(i => i.id))`, or
  - an add button `＋` with `aria-label={`Add ${w.title}`}` calling `onAdd(w.id)`.
  A hidden-but-present widget shows `＋`, and adding it flips `visible` back to true
  **in its original position** (not appended).
- Footer: a non-interactive dashed tile "➕ Add a custom graph / coming soon"
  (`cursor-not-allowed`, `title="Coming soon"`). No handler.
- The drawer stays open after adding (no auto-close), so multiple adds are possible.

---

## 3. Every widget

Data always comes from the single `useDashboard({})` call in `DashboardPage`;
individual widgets receive slices as props. **No widget fetches on its own.**
`money0 = formatCurrencyWhole` (org-currency-aware, 0 decimals).

### 3.1 The 10 KPI widgets (all via `KpiCard`)

`KpiCard` renders a `<button type="button">` card:
icon chip + label, a 26px bold `tabular-nums` value, an optional `<TrendDelta>` chip,
and an optional meta line. `showDelta = delta && delta.value !== 0` - a zero delta
renders no chip. `TrendDelta` direction is `value > 0 ? 'up' : 'down'`; the colour is
overridden by `good` (`text-success bg-success/10` vs `text-danger bg-danger/10`) so
sign and sentiment are independent.

| id | value | delta | meta | onClick -> |
|---|---|---|---|---|
| `kpi.revenue_mtd` | `money0(kpis.revenue_mtd.collected)` | `vs_last_month_pct`, suffix `%`, good if `>= 0` | `` `${pct_of_goal}% of ${money0(target)} goal` `` | `/invoices` |
| `kpi.collected_today` | `money0(kpis.collected_today.amount)` | none | `` `${jobs_done} jobs done` `` | `/reports/payments` |
| `kpi.recurring` | `` `${money0(r.mrr)}/mo` ``, `valueClass="text-sage-700"` | none | `` `${r.active_plans} active plans` `` | `/service-plans` |
| `kpi.ar` | `money0(kpis.ar.total)`, `valueClass="text-warning"` | none | `pill(money0(over_30+over_60) + ' past due')` in `bg-danger/10 text-danger`, **only when > 0** | `/reports/ar-aging` |
| `kpi.close_rate` | `` `${rate}%` `` | `vs_last_period_pp`, suffix `pp`, good if `>= 0` | `` `${won} won · ${lost} lost · 30d` `` | `/reports/estimate-conversion` |
| `kpi.jobs_today` | `String(total)` | `vs_yesterday`, no suffix, good if `>= 0` | `` `${scheduled} scheduled · ${completed} completed` `` | `/schedule` |
| `kpi.open_leads` | `String(leads_open.count)` | none | `` `${need_followup_today} need follow-up` `` | `/leads` |
| `kpi.avg_ticket` | `money0(avg_ticket.amount)` | none | `` `completed jobs · ${period_days ?? 30}d` `` | `/reports` |
| `kpi.jobs_week` | `String(jobs_week.completed)` | none | `` `of ${scheduled} scheduled` `` | `/jobs` |
| `kpi.deposits` | `money0(deposits_awaiting.amount)`, `valueClass="text-warning"` | none | `` `${count} requested, unpaid` `` | `/estimates` |

Icons/tints (lucide): DollarSign+`bg-sage-50`, CircleDollarSign+`bg-sage-50`,
Repeat+`bg-sage-50`, AlertTriangle(`text-warning`)+`bg-warning/10`,
TrendingUp+`bg-sage-50`, Briefcase(`text-primary`)+`bg-primary-subtle`,
Filter(`text-primary`)+`bg-primary-subtle`, Receipt(`text-text-secondary`)+`bg-border-soft`,
CalendarDays(`text-primary`)+`bg-primary-subtle`, Layers(`text-warning`)+`bg-warning/10`.

Every numeric read uses `?? 0`, so all KPI cards render `$0` / `0` while loading or on
error. **Exception:** `kpi.recurring` does `const r = data?.kpis?.recurring; if (!r) return null;`
- it disappears entirely while loading and whenever the org has no active service plans
(`buildRecurring` returns `null` for `active_plans === 0`).

### 3.2 `smart_insights` (`SmartInsights.tsx`)

- Input: the whole `DashboardResponse`. `if (!data) return null`, and
  `if (insights.length === 0) return null` -> the full-width band vanishes.
- Insights are computed **client-side**, deterministically, by
  `computeInsights` in `frontend/src/lib/dashboard/insightRules.ts` (no AI, no API):
  1. `past_due_ar` - emitted when `ar.over_30 + ar.over_60 > 0`. `weight = pastDue`,
     tone `danger`, icon `💰`, text `` `${fmt(pastDue)} past due. The 60+ bucket is your biggest cash lever.` ``,
     cta `Review AR aging` -> **`/invoices`**.
  2. `top_source` - highest `lead_pct` in `lead_sources`. `weight = topSource.revenue`,
     tone `success`, icon `📈`, cta `See lead sources` -> **`/leads`**.
  3. `pipeline_nudge` - when `close_rate.rate > 0`. `weight = 1`, tone `info`, icon `📄`,
     cta `Go to estimates` -> **`/estimates`**.
  Sorted by `weight` desc, `.slice(0, 3)`.
  `fmt` is its own abbreviator: `>=1M -> $X.XM`, `>=1000 -> $Xk`, else `$X` - this
  is the one place on the dashboard that abbreviates money (everywhere else uses
  `formatCurrencyWhole`).
- Render: `grid grid-cols-1 sm:grid-cols-3 gap-3.5` of `<button>` tiles,
  `border-ai-200 bg-ai-50`, a `h-7 w-7` tone chip
  (`TONE_BG = {danger:'bg-danger/10', info:'bg-info/10', success:'bg-sage-50'}`)
  holding the emoji, the text, and a `{cta_label} →` line in `text-ai-600`.
- Click -> `navigate(i.link)`.
- No card shell (not a `WidgetCard`), no title bar.

### 3.3 `needs_attention` (`NeedsAttention.tsx`)

- Input: `data?.needs_attention ?? []` (`AttentionItem[]`).
- `WidgetCard` title "Needs Attention", `AlertTriangle` icon; right slot is a red
  count badge showing `items.length` (**full length, not the truncated 6**), rendered
  only when `items.length > 0`.
- Renders `items.slice(0, 6)`. No "show more".
- Empty state: `All clear — nothing needs attention` (centred, `py-10`, `text-xs`).
- Row: `<button>` -> `navigate(item.link)`. Icon chosen by `item.type` from
  `{overdue_invoice: DollarSign, expiring_estimate: FileText, unassigned_leads: Phone,
  job_past_start: Briefcase, walkthrough_needed: Home}`, defaulting to `AlertTriangle`.
  Colours by `item.severity` from the `STYLES` map (`danger`/`warning`/`info`).
  Layout: icon chip, title (truncate) + meta (truncate), a severity badge with
  `item.badge`, and a `ChevronRight` that is `opacity-0 group-hover:opacity-100`.
- The server builds the items and their links (`dashboard.controller.ts:605-692`):
  overdue invoices -> `/invoices/:id` (danger, badge `{n}d`, max 3);
  expiring estimates (72h window) -> `/estimates/:id` (warning, badge `{n}d`, max 3);
  one aggregate unassigned-leads row -> `/leads` (info, badge = count);
  jobs past start -> `/jobs/:id` (danger, badge `{n}m` or `{n}h`, max 3);
  walkthrough-needed leads -> `/leads/:id` (warning, badge `Req.`, max 2).
  Server sorts danger -> warning -> info.

### 3.4 `schedule_today` (`TodaySchedule.tsx`)

- Input: `data?.schedule_today ?? []` (`TechSchedule[]` lanes).
- `WidgetCard` title "Today's Schedule", `Calendar` icon; right slot is a
  **`Full calendar` text button -> `navigate('/schedule')`**.
- Scroll container `max-h-72 overflow-y-auto`.
- Empty state: `Nothing scheduled`.
- Per lane: avatar circle with initials `first[0]+last[0]` uppercased (or `—` and a
  flat `bg-border` chip when `user_id === null`, i.e. the Unassigned lane, which the
  server always emits last). Avatar gradient is a deterministic hash of `user_id`:
  `hash = (hash*31 + charCode) & 0xffff` over the id, indexed into a 5-entry
  `GRADIENTS` array; null id -> `from-text-soft to-text-secondary`.
  Right of the name: `` `${jobs.length} visit${s}` ``. A `border-t` separator is
  drawn before every lane except the first.
- Per entry: `<button>` -> `navigate(entity === 'walkthrough' ? `/leads/${id}` : `/jobs/${id}`)`.
  Shows `customer_name`, then `` `${job_number}${scope_notes ? ' · '+scope_notes : ''}` ``,
  a status pill, and `formatTime(scheduled_start)`
  (`toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true})`,
  `—` when null).
- `pillStyle(status, entity)` decision order - **this is asserted by unit tests**:
  1. `entity==='walkthrough' && status==='WALKTHROUGH_COMPLETED'` ->
     `bg-sage-50`, `border-sage-200 border-l-sage-500`, tag `bg-sage-200 text-sage-700`, label **`Walkthrough`**
  2. `entity==='walkthrough'` (pending) ->
     `bg-primary-subtle`, `border-ocean-700/30 border-l-ocean-700`, tag `bg-ocean-800/10 text-ocean-800`, label **`Walkthrough`**
  3. `IN_FLIGHT_STATUSES.has(status)` (`EN_ROUTE|ON_SITE|IN_PROGRESS`) ->
     `bg-info/10`, tag `bg-info/15 text-info`, label `In Progress`
  4. `status==='COMPLETED'` -> `bg-sage-50`, tag `bg-sage-200 text-sage-700`, label `Done`
  5. otherwise -> `bg-background-light`, tag `bg-border-soft text-text-secondary`, label `Scheduled`

### 3.5 `revenue_chart` (`RevenueChart.tsx`) - recharts

- Input: `data?.revenue_chart ?? []` (`RevenuePoint[]`) and
  `target = data?.kpis?.revenue_mtd?.target ?? 0`.
- See section 8 for the full chart spec.
- No empty state and no loading state: with `[]` the `ResponsiveContainer` renders
  empty axes inside a fixed `h-[220px]` box.
- Entirely non-interactive apart from the recharts hover tooltip. No click-through.

### 3.6 `pipeline` (`PipelineFunnel.tsx`) - **not recharts**

- Input: `data?.pipeline ?? []` (`PipelineStage[]`).
- `WidgetCard` "Revenue Pipeline" + `Filter` icon; right slot is static text
  `where $ is flowing`.
- Bar width: `maxAmt = Math.max(1, ...stages.filter(s => s.kind==='amount').map(s => s.value))`;
  per row `pct = kind==='amount' ? Math.max(8, value/maxAmt*100) : 100`.
  So the `count` row (Leads) always renders a full bar. Minimum visible width 8%.
- Bar fill is a CSS gradient `bg-gradient-to-r from-sage-500 to-sage-700` on a
  `bg-border-soft` track - plain divs, no SVG, no chart library.
- Value column: `money0(value)` for `amount`, raw number for `count`.
- Row `<button>` -> `navigate(s.link)`. Server-provided links
  (`dashboard-metrics.ts:110-120`): `/leads`, `/estimates`, `/estimates?status=approved`,
  `/estimates`, `/jobs`, `/invoices`, `/invoices?status=paid` for stages
  `leads (count) | estimates | approved | deposit | job ("Job done") | invoiced | paid`.
- Empty array -> card with an empty body. No explicit empty state.

### 3.7 `tech_scoreboard` / `dispatch_scoreboard` (`Scoreboards.tsx` -> `RankedBarList`)

- Inputs: `data?.tech_scoreboard ?? []` / `data?.dispatch_scoreboard ?? []`
  (`ScoreboardEntry[]`, server-capped at 5, sorted by revenue desc, zero-activity rows dropped).
- Title is emoji-prefixed **text**, passed as the `WidgetCard` title string:
  `🔧 Tech Scoreboard` / `🎧 Dispatch Scoreboard`. Right slot: static `14 days`
  (**cosmetic - the server aggregates all-time completed jobs, no 14-day filter exists**).
- Row: name (74px, truncate), a `bg-sage-700` bar whose width is
  `Math.max(18, revenue/max*100)%` with `money0(revenue)` right-aligned *inside* the
  bar in 9px white bold, then `` `${jobs} job|jobs` ``. `max = Math.max(1, ...revenues)`.
- Row click -> `onRowClick(entry)`; the registry wires **both** boards to
  `navigate('/jobs')` and discards the entry.
- No empty state - an empty array yields an empty card body.
- React key is `` `${e.user_id}-${i}` `` (guards the null dispatcher id).

### 3.8 `lead_sources` (`Scoreboards.tsx` -> `LeadSourcesWidget`)

- Input: `data?.lead_sources ?? []`. Title `🌐 Top Lead Sources`, right slot
  `leads · revenue`. Server sorts by lead count desc and Title-Cases the label.
- Row `<button>` -> **`navigate(`/leads?source=${s.source}`)`** (raw source key, not
  the label, not URL-encoded).
- Row shows label, `` `${lead_pct}%` ``, and `· ${money0(revenue)}`.
- No empty state.

### 3.9 Catalog widgets (`Catalog.tsx`) - hidden by default, addable from the drawer

- **`jobs_by_status`** - `WidgetCard` "Jobs by Status" + `Briefcase`; right slot
  `View all` button -> `/jobs`. Body is the shared `Donut` using
  `SegmentedDonut size=110 thickness=20` plus a legend listing `label` / `count`.
  Colours: `chartPalette[i % 5]`. Data: `data?.jobs_by_status ?? []`
  (server: canonical status order, zero-count statuses dropped).
- **`revenue_by_job_type`** - "Revenue by Job Type" + `PieChart` icon; right slot
  `Report` button -> `/reports`. Donut is fed **`s.pct`** as the segment value while
  the legend shows **`money0(s.revenue)`**. Same palette rule. Data: `data?.revenue_by_job_type ?? []`.
- **`coming_up`** - "Coming Up" + `CalendarClock`; right slot `View all` -> `/schedule`.
  Rows show `in_label` (server-computed, e.g. "in 15 hours"), `title`, `address`.
  Every row click -> `navigate('/schedule')` (not the job). Data: `data?.coming_up ?? []`
  (server take 6). **No empty state.**
- **`recent_activity`** - "Recent Activity" + `Activity`; right slot is a pulsing
  `bg-sage-500` dot. `max-h-72 overflow-y-auto`. Empty state `No recent activity`.
  Rows are **not** clickable: a `•` chip, `e.description`, and
  `` `${relativeTime(e.created_at)}${e.creator_name ? ' · '+creator_name : ''}` ``.
  `relativeTime` is local: `just now` (<1 min) / `${n} min ago` / `${n} hr ago` / `${n} d ago`.
  Data: `data?.activity ?? []` (server take 20, org-scoped timeline events).
- **`service_areas`** and **`recent_calls`** - both render `<ComingSoon title=... />`:
  a `WidgetCard` with a `Sparkles` icon and the copy
  "Coming soon" / "Connect data to enable this widget." **They take no data and make
  no API call.** They are addable from the catalog and are then persisted in the layout.

---

## 4. Drag and resize

### 4.1 Library: none

Drag uses the **native HTML5 drag-and-drop API**, not `dnd-kit`, not
`react-beautiful-dnd`. The moving parts are exactly:

- `EditableWidget` root: `draggable` (boolean attr), `onDragStart={() => onDragStart(id)}`,
  `onDragOver={e => e.preventDefault()}`, `onDrop={() => onDrop(id)}`.
- `DashboardPage`: `const dragId = useRef<string|null>(null)`;
  `onDragStart` writes `dragId.current = id`;
  `onDrop` runs `if (dragId.current) reorder(dragId.current, id); dragId.current = null;`.

Consequences the v2 build must not "improve" away:
- No `dataTransfer` payload is set. Firefox historically needs
  `e.dataTransfer.setData(...)` for a drag to start; this code does not do it. Behaviour
  in Firefox is untested (see Open questions).
- No drop-target highlight, no placeholder/gap preview, no drag image customisation,
  no auto-scroll.
- **No keyboard path.** The grip is a `<span>`, not a button; there is no
  ARIA drag-and-drop, no `tabIndex`, no key handlers.
- Drag is available **only in edit mode**, because `EditableWidget` renders a bare
  fragment when `edit === false`.
- The grip chip is decorative: the entire widget wrapper is the drag handle.

### 4.2 `reorder(fromId, toId)` - exact semantics

```ts
if (fromId === toId) return;
const arr = [...layout];
const from = arr.findIndex(i => i.id === fromId);
const to   = arr.findIndex(i => i.id === toId);
if (from < 0 || to < 0) return;
const [moved] = arr.splice(from, 1);
arr.splice(to, 0, moved);
persist(arr);
```
Indices are computed on the **full layout array including hidden items**, then the
removal happens before the insertion. Net effect:
- dragging **downward** (`from < to`): the item lands **after** the drop target;
- dragging **upward** (`from > to`): the item lands **before** the drop target.
Reproduce this arithmetic verbatim - an "obviously equivalent" rewrite changes where
items land.

### 4.3 Resize

**There is no resize UI.** `LayoutItem.size` is read but never written. Widget sizes
are fixed by `WidgetDef.defaultSize` -> `SIZE_SPAN`.

### 4.4 Time-range pill

`EditableWidget` persists `range` per widget via `update(id,{range})`, and
`DashboardPage` passes it into `def.render({data, range, navigate})`.
**No `render` function in `widgetRegistry.tsx` reads `ctx.range`.** Every widget
destructures only `{ data }` and/or `{ navigate }`. The control is fully wired at the
persistence layer and completely inert at the data layer. The edit-mode toolbar copy
still advertises it ("the time pill sets each widget's range"). Preserve the control
and its persistence; do not "fix" it in the presentation swap.

---

## 5. Page shell and edit mode (`DashboardPage.tsx`)

- Root `<div className="space-y-4">`, inside `AppLayout`'s
  `<main className="flex-1 overflow-y-auto overflow-x-hidden bg-background-light p-4">`.
- Header row: `<h1>` `` `${getGreeting()}, ${user?.first_name ?? 'there'} 👋` ``.
  `getGreeting()` reads `new Date().getHours()`: `<12 Good morning`, `<17 Good afternoon`,
  else `Good evening`. Subline: `` `${getDayString()} — Here's what's happening today.` ``
  where `getDayString()` is
  `Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})`.
  (Note: that subline contains a literal em dash in the current source.)
- Header right: `<NewMenu />` then the edit toggle button:
  - not editing: `bg-primary`, `Pencil` icon, label **`Customize home page`**
  - editing: `bg-ocean-700 hover:bg-ocean-900`, `Check` icon, label **`Done`**
- `toggleEdit` sets `edit = !edit` **and** `catalogOpen = edit`, i.e. entering edit
  opens the drawer and leaving edit closes it.
- Edit toolbar (only while editing): a `bg-primary-subtle` bar with the copy
  `Edit mode — drag to reorder · ✕ to hide · the time pill sets each widget's range ·
  add more from the catalog →` and a **`Reset to default`** button (`RotateCcw`) ->
  `reset()`. **No confirmation dialog** - it overwrites localStorage immediately.
- Body: `<div className="flex gap-3.5 items-start">` = the 12-col grid (`flex-1`)
  plus `<CatalogDrawer open={edit && catalogOpen} .../>` as a sticky right rail.
- **Known trap:** `CatalogDrawer`'s close button only sets `catalogOpen = false`.
  There is no separate "open catalog" control, so once closed the only way back is
  `Done` then `Customize home page` again. Reproduce as-is (or flag it as a bug
  separately - it is not a presentation-layer decision).
- No unsaved-changes state: every edit persists immediately.

---

## 6. Every API interaction

The dashboard is **read-only**. One query, zero mutations, zero invalidations.

| Hook | Endpoint | Method | Params sent | Query key | Caching |
|---|---|---|---|---|---|
| `useDashboard({})` (`lib/api/dashboard.ts:24`) | `/api/dashboard` | GET | `period`, `date`, `department_id` - all `undefined` because `DashboardPage` calls `useDashboard({})` | `['dashboard', {}]` | `staleTime: 60_000`, `refetchInterval: 120_000` |

- Server defaults with no params: `period` -> `6M` (6 monthly buckets),
  `date` -> today, `department_id` -> unfiltered.
  So `RevenueChart` always shows 6 months and `TodaySchedule` always shows today,
  even though the API supports `3M/6M/12M` and an arbitrary date + department filter.
  **No UI on this page exposes those parameters.**
- Mock mode: `VITE_DASHBOARD_USE_MOCK === 'true'` swaps the queryFn for
  `Promise.resolve(dashboardSeed)` and sets `refetchInterval: false`.
  Seed lives at `frontend/src/lib/api/_mock/dashboard/{index,seed,types}.ts`.
  Components must import types through the seam `@/lib/api/dashboard`, never `_mock`.
- `grep` for `'dashboard'` as a query key across `frontend/src` returns no other
  hit - **nothing anywhere invalidates `['dashboard']`.** Freshness comes only from
  `staleTime` + the 2-minute poll.
- `NewMenu` performs no API calls; it only navigates.
- HTTP client is `@/lib/axios` (auth/tenant headers handled there).

Response contract (`_mock/dashboard/types.ts` = server response in
`dashboard.controller.ts:853-908`):
```
{ kpis: { jobs_today{total,scheduled,in_progress,completed,vs_yesterday},
          revenue_mtd{invoiced,collected,target,pct_of_goal,vs_last_month_pct},
          ar{total,current,over_30,over_60},
          leads_open{count,unassigned,need_followup_today},
          close_rate{rate,won,lost,vs_last_period_pp},
          collected_today{amount,jobs_done},
          recurring: {mrr,active_plans} | null,
          avg_ticket{amount,period_days},
          jobs_week{completed,scheduled},
          deposits_awaiting{amount,count} },
  revenue_chart: RevenuePoint[],   needs_attention: AttentionItem[],
  schedule_today: TechSchedule[],  pipeline: PipelineStage[],
  tech_scoreboard: ScoreboardEntry[], dispatch_scoreboard: ScoreboardEntry[],
  lead_sources: LeadSource[],      jobs_by_status: StatusSlice[],
  revenue_by_job_type: JobTypeSlice[], coming_up: ComingUpJob[],
  activity: ActivityEvent[],       generated_at: string }
```

---

## 7. NewMenu

`frontend/src/pages/dashboard/NewMenu.tsx` - a hand-rolled dropdown (no Radix, no popover).

- Trigger: `<button aria-haspopup="menu" aria-expanded={open}>` with a `Plus` icon,
  the text `New`, and a `ChevronDown`. Toggles `open`.
  The e2e selector is `page.getByRole('button', { name: /^New\b/ })`.
- Panel: `<div role="menu" className="absolute right-0 top-11 z-30 w-44 ...">`.
- Items (`role="menuitem"`, each a `<button>`; click sets `open=false` then navigates):

  | Label | Navigates to |
  |---|---|
  | New Lead | `/leads/new` |
  | New Estimate | `/estimates/new` |
  | New Job | `/jobs/new` |
  | New Task | `/tasks?action=new-task` |
  | New Invoice | `/invoices/new` |
  | Request Payment | `/invoices` |

- Dismissal, registered in a `useEffect` that runs only while `open`:
  `document` `mousedown` outside `ref` -> close; `document` `keydown` `Escape` -> close.
  Both listeners are removed on cleanup.
- **No permission gating whatsoever.** Every role that can see the dashboard
  (ADMIN, DISPATCHER) sees all six items. There is no CASL check, no
  `canOnJob`, no per-user-capability check for `create Job` / `create Invoice`.
  The gate is on the destination route, not here.
- No focus trap, no roving tabindex, no `aria-activedescendant`.
- The sidebar's separate `Create New` menu is a different component and is out of
  scope for this module, but `e2e/specs/redesign/08-standalone-invoice.spec.ts:171-186`
  exercises **both** in the same test, on `/`.

---

## 8. Charts

### 8.1 Inventory - what is actually a chart library

| Widget | Technology |
|---|---|
| `revenue_chart` | **recharts** `ComposedChart` |
| `pipeline` | plain divs + a Tailwind gradient (**not** recharts, despite the "funnel" name) |
| `jobs_by_status`, `revenue_by_job_type` | `SegmentedDonut` - hand-written SVG in `frontend/src/components/charts/Donut.tsx` |
| `tech_scoreboard`, `dispatch_scoreboard`, `lead_sources` | plain divs |

**Flag for the build phase:** the CRM UI kit ships no chart components. Only
`RevenueChart` genuinely depends on recharts, and it should stay on recharts - swap the
`WidgetCard` chrome and the legend markup, leave the `ComposedChart` subtree alone.
`SegmentedDonut` is first-party ServWave code and should be reused as-is.
The bar-style widgets are pure CSS and can be re-chromed freely, provided the width
maths in 3.6/3.7 is preserved exactly.

### 8.2 `RevenueChart` spec

Data: `RevenuePoint[] = { month: string /* 'Jan'.. */, invoiced: number, collected: number, is_current: boolean }[]`.
Server emits exactly `monthCount` (6 by default) contiguous buckets ending in the
current month, zero-filled.

Token-derived colours (all resolved at render time, no raw hex in the component):
```ts
const COLLECTED       = chartPalette[0];      // '#2F7D5D' sage-700
const COLLECTED_MUTED = token('--sage-500');
const INVOICED        = token('--border-color');
const TARGET          = token('--primary');
```
Chart composition:
- `<ResponsiveContainer>` inside a fixed `h-[220px]` box.
- `<ComposedChart data={data} barCategoryGap="30%" barGap={3}>`
- `<CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />`
- `<XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fontSize:11, fill: token('--text-secondary')}} />`
- `<YAxis axisLine={false} tickLine={false} tick={{fontSize:11, fill: token('--text-secondary')}}
   tickFormatter={formatCurrencyWhole} width={88}
   domain={[0, dataMax => Math.max(dataMax*1.15, target*1.15, 1000)]} />`
- `<Tooltip content={<TooltipContent/>} cursor={{fill: token('--border-soft'), opacity:0.5}} />`
  where `TooltipContent` is a local component rendering a white bordered card with the
  month label and each series as `` `${name}: ${formatCurrency(value)}` `` (full cents here).
- `<ReferenceLine y={target} stroke={TARGET} strokeDasharray="6 4" strokeOpacity={0.7}
   label={{value: formatCurrencyWhole(target), position:'right', fill: TARGET, fontSize:10, fontWeight:600}} />`
- `<Bar dataKey="invoiced" name="Invoiced" fill={INVOICED} radius={[3,3,0,0]} />`
- `<Bar dataKey="collected" name="Collected" radius={[3,3,0,0]}>` with a per-point
  `<Cell fill={entry.is_current ? COLLECTED : COLLECTED_MUTED} />` - the current month
  is the only fully saturated collected bar.
- A hand-built legend sits above the chart (three inline swatches: `bg-border` Invoiced,
  `bg-sage-700` Collected, a dashed `border-primary` rule for Target). Recharts'
  `<Legend>` is not used.

`token(name)` (`design-system/tokens.ts:79`) reads the live CSS custom property from
`:root`, wraps `"R G B"` channel values in `rgb(...)`, and falls back to a static hex
map then `#000000` when there is no DOM. It must be called at render time, not at
module scope, for theme changes to apply - `RevenueChart` currently resolves
`COLLECTED_MUTED`/`INVOICED`/`TARGET` at **module scope**, i.e. once per session.

### 8.3 Donut spec (`SegmentedDonut`)

`size=110`, `thickness=20`, default `gapDegrees=3`, arcs start at 12 o'clock and sweep
clockwise, `strokeLinecap="round"`, track = `trackColor()` from `charts/chartTheme`.
Segment colours come from `chartPalette[i % chartPalette.length]`:
```
['#2F7D5D' sage-700, '#0C2D3A' ocean-800, '#5B6DFF' ai-600, '#B45309' amber-700, '#667985' slate]
```
`JobsByStatus` feeds `value = count`; `RevenueByJobType` feeds `value = pct` but labels
with `money0(revenue)`. The legend dots use the same palette index via an inline
`style={{background: ...}}`.

---

## 9. States (loading / empty / error / skeleton)

**There is no page-level loading, error, or skeleton state anywhere in this module.**
`DashboardPage` destructures only `const { data } = useDashboard({})` - `isLoading`,
`isError`, `isFetching` and `error` are all discarded.

| Phase | What the user sees |
|---|---|
| First load (`data === undefined`) | The full grid renders immediately. Every KPI card shows `$0` / `0` with its meta line ("0% of $0 goal", "0 jobs done", ...). `kpi.recurring` and `smart_insights` return `null` so their cells vanish. `needs_attention` shows "All clear - nothing needs attention". `schedule_today` shows "Nothing scheduled". `recent_activity` (if added) shows "No recent activity". `revenue_chart` renders empty axes. `pipeline`, both scoreboards, `lead_sources`, the donuts and `coming_up` render empty card bodies. |
| Error (403 / 500 / network) | **Identical to the loading state, permanently.** No toast, no retry button, no message. React Query's default retries apply, then the page just sits on zeros. |
| Loaded, genuinely empty org | Same zeros/empty states - indistinguishable from an error. |
| Refetch (every 120s) | Silent; no spinner, no stale indicator. |

Per-widget empty copy (the only three that have any):
- `NeedsAttention` -> `All clear — nothing needs attention`
- `TodaySchedule` -> `Nothing scheduled`
- `RecentActivity` -> `No recent activity`

Widgets with **no** empty state (empty card body): `PipelineFunnel`, `RankedBarList` x2,
`LeadSourcesWidget`, `JobsByStatus`, `RevenueByJobType`, `ComingUp`, `RevenueChart`.

Widgets that remove their own cell: `kpi.recurring` (no active plans / no data),
`smart_insights` (no data or zero insights).

The only surrounding fallback is `App.tsx`'s `<Suspense fallback={<PageLoader />}>`
covering the two lazy chunks, and the global `<ErrorBoundary>` for render throws.

**v2 note:** adding skeletons would be a behaviour change, not a presentation swap.
If the kit's skeletons are wanted, raise it as a scoped follow-up rather than doing it
inside the migration PR.

---

## 10. Permission / entitlement conditional rendering

- **Widget level: none.** Not one widget in `widgetRegistry.tsx` consults CASL, the
  ability context, the user's role, the org plan, or a feature override. Whatever the
  API returns is rendered.
- **Route level only:** `read Dashboard` decides whether the page renders at all
  (section 1). ADMIN and DISPATCHER see the identical widget set. SALES and TECHNICIAN
  never reach the page.
- **NewMenu: no gating** (section 7).
- **Entitlements / plan gating: absent from the frontend entirely.** `grep` for
  `useFeature|feature_overrides|entitlement` across `frontend/src` returns **zero
  hits**. No `STARTER/PRO/SCALE` logic touches this module.
- **The `phone` master switch and the Communication module:** the dashboard contains
  exactly one comms-adjacent widget, `recent_calls`, and it renders
  `<ComingSoon title="Recent Calls" />` - static copy, **no comms hook, no `comm-*`
  endpoint, no data**. Therefore the `phone` feature flag (PRO minimum, written as
  `{"phone": false}` for every newly onboarded org) has **no effect on the dashboard
  today**, and no gate needs to be reproduced. If a future v2 wires `recent_calls` to
  a real comms endpoint, it must then be gated behind `phone` - flagged here so the
  requirement is not lost.
- `service_areas` is the same kind of dataless stub.
- Multi-tenancy is enforced server-side: every query in `dashboard.controller.ts`
  spreads `tenantWhere(req)`. Nothing on the frontend filters by org.

---

## 11. Selector surface

### 11.1 `data-testid`

**There are none.** `grep -rn "data-testid" src/pages/dashboard/ src/pages/DashboardPage.tsx
src/components/layout/HomeRoute.tsx` returns nothing. All existing tests select by
role, accessible name, text, or CSS class.

That makes the class names below **load-bearing for tests**, which is unusual and
worth stating plainly to the builders.

### 11.2 Selectors the existing suites depend on

| Selector | Used by |
|---|---|
| `getByRole('button', { name: /^New\b/ })` | e2e 08-standalone-invoice T1 (the NewMenu trigger) |
| `getByRole('menuitem', { name: 'New Invoice' })` | e2e 08-standalone-invoice T1/T2 |
| `page.locator('main')` non-empty at path `/` | e2e 00-render-safety R0-01 |
| `getByRole('button', { name: 'Add Dispatch Scoreboard' })` | unit CatalogDrawer.test |
| title span classes `truncate` + `min-w-0`, attr `title="Dispatch Scoreboard"` | unit CatalogDrawer.test |
| `getAllByText('Walkthrough')` (length 2) | unit TodaySchedule.test |
| row button classes `bg-primary-subtle` / `bg-sage-50` | unit TodaySchedule.test |
| descendant `.text-ocean-800` / `.text-sage-700` inside a row | unit TodaySchedule.test |
| `getByText('Nothing scheduled')` | unit TodaySchedule.test |
| `aria-label="Widget time range"`, `aria-label="Hide widget"`, `aria-label="Add <title>"` | EditableWidget / CatalogDrawer (only the last is asserted today) |

### 11.3 Existing tests that must keep passing

**`frontend/src/pages/dashboard/layout/__tests__/CatalogDrawer.test.tsx`** (1 test, #371 hardening)
- Renders `<CatalogDrawer open layout={[]} onAdd={vi.fn()} onClose={vi.fn()} />` with
  plain `render` (no providers, no router).
- Asserts the "Dispatch Scoreboard" title span has classes `truncate` **and** `min-w-0`
  and attribute `title="Dispatch Scoreboard"`.
- Asserts `getByRole('button', { name: 'Add Dispatch Scoreboard' })` exists.
- Implicitly requires: drawer renders every registry widget when `layout` is empty,
  the aria-label format is exactly `` `Add ${title}` ``, and the component works without
  any context provider.

**`frontend/src/pages/dashboard/widgets/TodaySchedule.test.tsx`** (3 tests, issue #447)
- Uses `renderWithProviders`. Fixture: one lane with a `SCHEDULED` job, a `WALKTHROUGH`
  lead, and a `WALKTHROUGH_COMPLETED` lead.
- Test 1: exactly two elements with text `Walkthrough`; the pending row's closest
  `button` has class `bg-primary-subtle` and contains a `.text-ocean-800` node; the
  completed row's button has `bg-sage-50` and contains `.text-sage-700`.
- Test 2: clicking rows calls `navigate` with `/leads/lead-1`, `/leads/lead-2`,
  `/jobs/job-1` respectively.
- Test 3: `data={[]}` renders the text `Nothing scheduled`.
- Implicitly requires: the row is a `<button>`, the customer name is a descendant of
  that button, and the pill classes stay on those exact elements.

**`frontend/src/components/layout/__tests__/HomeRoute.test.tsx`** (4 tests) - not in the
module directory but it is the guard contract for `/`:
- `manage all` -> the dashboard renders (asserted negatively: none of the stub
  destination screens appear).
- SALES-shaped ability (`read Lead|Estimate|Invoice`) -> `/leads`.
- `read Job` + `read Lead` -> `/schedule` (display order wins).
- Empty ability -> `/leads` fallback.

**e2e:** `redesign/00-render-safety.spec.ts` R0-01 (`/` renders, `<main>` non-empty,
no ErrorBoundary, no console/network gate violations); `visual-screenshots.spec.ts`
test 02 (screenshot of `/`); `redesign/08-standalone-invoice.spec.ts` T1/T2 (NewMenu).
`workflow/redesign-21-duplicate-guard.spec.ts:177` hits `GET /api/dashboard` directly
via the API client to read the activity feed - a backend contract, unaffected by UI work.

---

## 12. Reimplementation checklist (the short version)

1. `/v2` must route through `HomeRoute`'s ability check, not straight to the page.
2. Keep `useDashboardLayout` and its localStorage key **byte-identical** - a key or
   shape change silently wipes every user's saved layout.
3. Keep `reorder`'s splice arithmetic (4.2) exactly.
4. Keep `EditableWidget` returning a bare fragment when `edit === false`.
5. Keep the `render(...) === null` veto path in the grid loop.
6. Keep the time-range control persisting but inert. Do not wire it up.
7. Keep every navigation target in sections 3, 7 - including the odd ones
   (`smart_insights` past-due -> `/invoices` not `/reports/ar-aging`; `ComingUp` rows ->
   `/schedule` not the job; both scoreboards -> `/jobs`).
8. Keep the `Add ${title}` aria-label and the `truncate min-w-0` title span in the drawer.
9. Keep `TodaySchedule`'s five-branch `pillStyle` order and its two class-name contracts.
10. Do not add skeletons/error UI - that is a behaviour change (section 9).
11. `RevenueChart` stays on recharts; donuts stay on `SegmentedDonut`; bars stay CSS.
12. No raw hex, no raw Tailwind palette classes - use `token()` / `chartPalette` /
    the semantic classes already in use (`text-sage-700`, `bg-primary-subtle`, ...).

---

## 13. Open questions

1. **Firefox drag.** `onDragStart` never calls `e.dataTransfer.setData(...)`. Chrome
   tolerates this; Firefox historically does not start a drag without it. Not verified
   (no browser tooling used for this map). Should v2 preserve the omission or is a
   `setData` call an acceptable non-visual fix?
2. **Reopening the catalog.** Closing the drawer while still in edit mode leaves no
   affordance to reopen it (section 5). Bug or accepted behaviour? The v2 build should
   mirror it unless told otherwise.
3. **`Reset to default` has no confirmation.** Intentional?
4. **The `14 days` caption on both scoreboards** is not backed by any server-side
   window (the query aggregates all completed jobs). Copy bug - keep or fix?
5. **`revenue_by_job_type`** sits under the "hidden by default" comment yet ships
   visible. Assumed intentional (`DEFAULT_LAYOUT` wins); confirm.
6. **`defaultVisible` is dead code** - nothing reads it. Keep it as documentation in
   v2 or drop it from the type?
7. **`LayoutItem.size`** is honoured on read but no UI writes it. Was a resize control
   planned? v2 should keep reading it either way.
8. **`period` / `date` / `department_id`** are supported by `useDashboard` and the
   controller but no dashboard UI sets them. Is a period switcher on the roadmap for
   `RevenueChart`, or should v2 keep hard-coding `{}`?
9. **Module-scope `token()` calls in `RevenueChart`** freeze three colours at import
   time. Harmless today (single theme). Leave as-is, or resolve inside the component?
10. **No live crawl was performed.** This map is from source only, per the
    documentation-only constraint. Any runtime-only behaviour (recharts animation
    timing, exact drag ghosting) is unverified.
