# Jobs module - behaviour map (UI kit migration, Phase 1)

Status: mapping complete 2026-07-29. Documentation only - no code was changed.
Scope: `/jobs`, `/jobs/new`, `/jobs/:id`, `/jobs/:jobId/statement`.
Method: every claim below was read out of the file cited. Anything I could not resolve
from the code is in section 12 (Open questions), not guessed.

Notation note: several UI strings in this codebase contain a literal em-dash glyph
(U+2014) or the ellipsis glyph (U+2026). Where that glyph is load-bearing for a
selector or a rendered label I write `[EMDASH]` / `[ELLIPSIS]` rather than pasting it,
per the repo's plain-hyphen output rule. Reproduce the original glyph in code.

---

## 0. File inventory

| Concern | Path |
|---|---|
| List page | `frontend/src/pages/JobsPage.tsx` (501 lines) |
| Create page | `frontend/src/pages/JobFormPage.tsx` (673 lines) |
| Detail page | `frontend/src/pages/JobDetailPage.tsx` (1523 lines) |
| Statement page | `frontend/src/pages/StatementPage.tsx` (242 lines, shared with `/customers/:customerId/statement`) |
| Routes | `frontend/src/App.tsx` lines 111-130 |
| Route guard | `frontend/src/components/ProtectedRoute.tsx` |
| Ability helper | `frontend/src/lib/ability.ts` (`canOnJob`) |
| Per-user grants (server) | `backend/src/lib/permissions/userCapabilities.ts` |
| Filter registry | `frontend/src/lib/filters/registries/jobs.ts` |
| URL filter binding | `frontend/src/lib/filters/useFilterState.ts` |
| Job API helpers | `frontend/src/lib/api/jobs.ts` |
| Statement API helpers | `frontend/src/lib/api/statements.ts` |
| Create-payload builder | `frontend/src/lib/job-create-payload.ts` |
| Lifecycle computation | `frontend/src/lib/jobs/lifecycle.ts` |
| AI insight rules | `frontend/src/lib/jobs/insights.ts` |

Shared components pulled in by these pages (all must be reused, never forked):
`components/ui/data-table.tsx`, `components/ui/KpiStrip.tsx`, `components/ui/status-badge`,
`components/filters/FilterBar.tsx`, `components/filters/AppliedChips.tsx`,
`components/filters/controls/{CheckboxFacet,DateFacet,RangeFacet}.tsx`,
`components/jobs/*` (11 files), `components/jobs/overview/*` (5 files),
`components/jobs/items/*` (6 files), `components/invoices/CreateJobInvoiceDialog.tsx`,
`components/shared/IconRail.tsx`, `components/leads/TagInput.tsx`,
`components/tasks/{CreateTaskModal,JobLeadTasksTab}.tsx`,
`components/communication/JobCommunicationsTab.tsx`,
`components/common/{AssignTeamPopover,MultiAssigneeSelect,AssigneeSelect,SelectField,DateRangeField}.tsx`,
`components/customers/DuplicateCustomerDialog.tsx`, `components/ui/address-autocomplete.tsx`.

---

## 1. Routes and guards (all four routes)

All four job routes sit inside ONE guard block in `App.tsx`:

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />}>
  <Route element={<AppLayout />}>
    ...
    <Route path="/jobs"                  element={<JobsPage />} />          // line 127
    <Route path="/jobs/new"              element={<JobFormPage />} />       // line 128
    <Route path="/jobs/:id"              element={<JobDetailPage />} />     // line 129
    <Route path="/jobs/:jobId/statement" element={<StatementPage />} />     // line 130
```

`ProtectedRoute` behaviour (`components/ProtectedRoute.tsx`):
- `isLoading` -> full-screen centered `Loading...` text (`min-h-screen`, `text-text-secondary`).
- `!isAuthenticated` -> `<Navigate to="/login" replace />`.
- role not in `allowedRoles` -> `fallback` prop is NOT set on this block, so it is
  `<Navigate to="/" replace />` (silent bounce). Since all four roles are allowed,
  this branch is unreachable for jobs.
- otherwise `<Outlet />`.

There is NO feature/entitlement gate (`requireFeature` / `useFeature`) on any jobs route.
No plan gate. No `DemoOnlyRoute`.

Page-level guards beyond the route:
- `/jobs/new`: `JobFormPage` returns `<Navigate to="/jobs" replace />` when
  `ability.can('create','Job')` is false (JobFormPage.tsx:144-146). This is an EARLY
  RETURN BEFORE hooks in the child, done in the outer component; the actual form lives in
  a separate `CreateJobForm` component so the hook order stays legal.
- `/jobs/:id`: no ability redirect. If the GET 404s / 403s, `job` is undefined and the
  page renders the "Job not found" text block (see section 5.9).
- `/jobs/:jobId/statement`: no ability check client-side. A 403 lands in the error state.

All page components are lazy-loaded (`React.lazy`) with a `<Suspense fallback={<PageLoader />}>`
wrapper around the whole `SentryRoutes` tree.

Routing is wrapped by `Sentry.withSentryReactRouterV7Routing(Routes)` so transactions are
named by pattern (`/jobs/:id`).

---

## 2. `/jobs` - JobsPage

### 2.1 Component tree

```
<div class="space-y-6">
  <div>                                   // page heading row
    <h1><Briefcase/> Jobs</h1>
    {data?.pagination?.total !== undefined && <span>{total}</span>}   // rounded count pill
  </div>

  <KpiStrip loading={isLoading} items={[6 tiles]} />

  <DataTable
      columns={7 defs}
      data={data?.jobs ?? []}
      pagination={data?.pagination}
      onPageChange / onPageSizeChange
      isLoading
      searchValue / onSearchChange / searchPlaceholder="Search jobs..."
      sorting / onSortingChange
      onRowClick -> navigate(`/jobs/${job.id}`)
      tableKey="jobs"
      filters={<FilterBar .../>}                       // toolbar left, after search box
      activeFilters={ hasAnyFacetActive ? <AppliedChips/> + "Clear all" Button : null }
      headerActions={ [Export dropdown when role !== SALES] + [New Job button when canManage] }
  />
</div>
```

`DataTable` internally renders (see `components/ui/data-table.tsx`):
- Toolbar: search `<Input>` with `<Search>` icon (debounced 300 ms before calling
  `onSearchChange`), then `filters` slot; right cluster = `ColumnVisibilityToggle`
  ("Columns" button + count badge of hidden columns) then `headerActions`.
- `activeFilters` slot rendered directly under the toolbar.
- Desktop (>= md, via `useIsMobile`): a `table-fixed` table inside an
  `overflow-auto max-h-[calc(100vh-280px)]` scroll box, sticky header row, sticky pinned
  columns, per-column resize handles, right-click header context menu, virtualization
  when `rows.length > 40` (row height estimate 41 px, overscan 10).
- Mobile (< md): one stacked card per row (`<dl>` of header/value pairs); the whole card
  is the click target.
- Pagination bar rendered only when `pagination && (totalPages > 1 || onPageSizeChange)`:
  "Showing {start}-{end} of {total}", a page-size `SelectField` (25 / 50 / 100), and
  Previous / "Page N of M" / Next buttons.

### 2.2 Columns (JobsPage.tsx:84-171)

| id | accessor | header | size | meta | sortable | cell |
|---|---|---|---|---|---|---|
| `job_number` | `job_number` | `Job #` | 90 | `pinned, fixed, minWidth 80` | yes | mono xs secondary text |
| `customer` | (none) | `Customer` | 170 | `locked, pinned, growWeight 1.5, minWidth 140` | **no** (`enableSorting:false`), **non-hideable** (`enableHiding:false`) | `customerDisplayName(c)` bold + `customer_number` in mono when present |
| `status` | `status` | `Status` | 110 | `fixed` | yes | `<StatusBadge status/>` |
| `location` | `service_location` | `Location` | 180 | `growWeight 2, minWidth 80` | no | `formatJobLocation()` or nothing |
| `assigned_to` | `assignees` | `Assigned To` | 140 | `growWeight 1, minWidth 80` | no | comma-joined `First Last`, else italic "Unassigned" |
| `scheduled` | `scheduled_start` | `Scheduled` | 110 | `fixed, minWidth 90` | yes | `formatExactDate()` or nothing |
| `created` | `created_at` | `Created` | 110 | `fixed, minWidth 90` | yes | `formatExactDate()` |

`formatJobLocation` (JobsPage.tsx:72-80) rules, in order:
1. no location -> `''`
2. `address_line1` contains (case-insensitive) `historical import` -> `''` (sentinel for
   imported placeholder addresses)
3. no `address_line1` -> `"City, ST"` if both, else `city`, else `''`
4. `city` present -> `"{address_line1}, {city}"`
5. else `address_line1`

### 2.3 KPI strip (6 tiles)

| # | icon | label | value | sub | tone | emphasize | active predicate | onClick |
|---|---|---|---|---|---|---|---|---|
| 1 | `AlertCircle` | Unscheduled | `stats.unassigned` | - | amber | `> 0` | `activeStatusKpi === 'UNASSIGNED'` | `handleStatusKpi('UNASSIGNED')` |
| 2 | `CalendarDays` | Scheduled | `stats.scheduled` | - | primary | no | `=== 'SCHEDULED'` | `handleStatusKpi('SCHEDULED')` |
| 3 | `Play` | In Progress | `stats.in_progress` | - | emerald | no | `=== 'IN_PROGRESS'` | `handleStatusKpi('IN_PROGRESS')` |
| 4 | `CheckCircle2` | Completed | `stats.completed` | `This month` | emerald | no | `=== 'COMPLETED'` | `handleStatusKpi('COMPLETED')` |
| 5 | `Ban` | Cancelled | `stats.cancelled` | `This month` | neutral | no | `=== 'CANCELLED'` | `handleStatusKpi('CANCELLED')` |
| 6 | `Receipt` | Need Invoices | `stats.need_invoices` | `Completed, unbilled` | amber | no | `activeNeedInvoicesKpi` | `handleNeedInvoicesKpi()` |

All values fall back to `0` when `stats` is undefined. `KpiStrip loading={isLoading}`
replaces every tile value with a pulsing skeleton block (`h-[26px] w-16`).

Every tile is a `<button type="button">` because `onClick` is supplied
(`KpiTile` picks `Wrapper = 'button'` when interactive). `active` adds
`border-primary/40 ring-2 ring-primary/15`. No `activeLabel` is passed, so no "active" pill.

Tile activation logic (JobsPage.tsx:304-364) - reproduce exactly:

```
statusValues       = value.status?.kind==='multi' ? values : []
assignedValues     = value.assigned_to  (same shape)
departmentValues   = value.department_id
scheduledValue     = value.scheduled  when kind==='dateRange'
createdValue       = value.created    when kind==='dateRange'
needsInvoiceValues = value.needs_invoice
needsInvoiceActive = needsInvoiceValues.includes('true')

otherFiltersActive = assignedValues.length>0 || departmentValues.length>0
                     || Boolean(createdValue?.from) || Boolean(createdValue?.to)
                     || Boolean(search)

noScheduledRange = !scheduledValue?.from && !scheduledValue?.to
isMonthRange     = scheduledValue?.from === monthStart && scheduledValue?.to === monthEnd
soleStatus       = statusValues.length===1 ? statusValues[0] : null

activeStatusKpi =
  soleStatus && !otherFiltersActive && !needsInvoiceActive
    ? (MONTHLY_JOB_STATUSES.includes(soleStatus)      // ['COMPLETED','CANCELLED']
        ? (isMonthRange ? soleStatus : null)
        : (noScheduledRange ? soleStatus : null))
    : null

activeNeedInvoicesKpi =
  needsInvoiceActive && statusValues.length===0 && noScheduledRange && !otherFiltersActive
```

`handleStatusKpi(status)`:
- if that tile is already active -> `clearAllFilters()` (setValue({}), setSearch(''), setPage(1))
- else: `setSearch('')`, `setPage(1)`, then
  - monthly status -> `setValue({ status:{multi,[status]}, scheduled:{dateRange, from:monthStart, to:monthEnd} })`
  - otherwise -> `setValue({ status:{multi,[status]} })`
  (`setValue` FULL-REPLACES every registry facet, so this also clears assigned_to /
  department_id / created / needs_invoice.)

`handleNeedInvoicesKpi()`: toggle off -> `clearAllFilters()`; toggle on ->
`setValue({ needs_invoice:{multi,['true']} })` + `setSearch('')` + `setPage(1)`.

`monthStart = startOfMonthDay()` and `monthEnd = endOfMonthDay()` from
`lib/date-range.ts`, both memoized once on mount with `useMemo(..., [])`. They are
LOCAL `YYYY-MM-DD` strings (first day of month / last day of month).

### 2.4 Filters (FilterBar + registry)

Registry: `jobsRegistry` (`lib/filters/registries/jobs.ts`), a module-level const - the
stability contract of `useFilterState` requires it never be an inline literal.

| key | kind | url param | label | options |
|---|---|---|---|---|
| `status` | multi | `status` | Status | static: `UNASSIGNED->Unscheduled`, `SCHEDULED->Scheduled`, `EN_ROUTE->En Route`, `ON_SITE->On Site`, `IN_PROGRESS->In Progress`, `COMPLETED->Completed`, `CANCELLED->Cancelled` |
| `assigned_to` | multi | `assigned_to` | Assigned To | dynamic `optionSource: 'assignableUsers'` |
| `department_id` | multi | `department_id` | Department | dynamic `optionSource: 'departments'` |
| `scheduled` | dateRange | `scheduled` (-> `scheduled_after` / `scheduled_before`) | Scheduled | - |
| `created` | dateRange | `created` (-> `created_after` / `created_before`) | Created | - |
| `needs_invoice` | multi | `needs_invoice` | Needs Invoice | static, ONE option `{value:'true', label:'Needs Invoice'}` |

Deliberately NOT in the registry: `customer_id` (the customer picker was removed
outright) and `exclude_plan_visits` (always `'true'`, not user-controllable).

`resolveOptions(sourceId)` in the page:
- `'assignableUsers'` -> `techs.map(t => ({value: t.id, label: `${first} ${last}`.trim()}))`,
  memoized on `techs`
- `'departments'` -> `departments.map(d => ({value: d.id, label: d.name}))`
- anything else -> `[]`

`resolveMax` is a required prop with no range facet in this registry, so the page passes
`useCallback(() => 0, [])`.

`FilterBar` UI (`components/filters/FilterBar.tsx`):
- Trigger: `<Button variant="outline" size="sm" aria-expanded>` with `<ListFilter/>` icon,
  text `Filter`, plus a primary pill with the TOTAL selected count when `> 0`.
- Opens a Radix `Popover` (`align="start"`, `w-[640px] max-w-[94vw]`).
- Header row: "Filters" + a `Clear all ({n})` text button when `totalSelected > 0`.
- Body: `grid-cols-[200px_1fr]`. Left rail is `role="tablist"` with one
  `role="tab" aria-selected` button per facet (label + per-facet count badge).
  Right pane renders the control for the selected facet. Selected facet defaults to
  `registry[0]` (Status).
- Footer: `"{totalSelected} selected across {activeFacetCount} filters"` and a
  primary `Done` button which only closes the popover.
- Selection count rule: `multi` counts each value; `range`/`dateRange` count as 1 when
  any bound is set.

`CheckboxFacet` (used by status / assigned_to / department_id / needs_invoice):
- search `<Input>` shown ONLY when `allOptions.length > 6` (placeholder
  `Search {label lowercased}...`, `aria-label="Search {label}"`)
- a `Select all` / `Deselect all` toggle that acts on the SEARCH-FILTERED visible set only
- checkbox list, each `<label>` wrapping a `<Checkbox aria-label={option.label}>`
- `Clear {facet.label}` button when anything is selected
- Unchecking the last value leaves `{kind:'multi', values: []}` in state (not deleted)

`DateFacet` wraps `components/common/DateRangeField` (presets plus custom range; the
vitest suite exercises a preset option named `Today`).

`AppliedChips` (`components/filters/AppliedChips.tsx`), rendered in the `activeFilters`
slot only when `Object.keys(value).length > 0`:
- one `FilterChip` per selected multi value, labelled `"{facet.label}: {optionLabel}"`,
  collapsing beyond 3 values per facet into a `+N more` chip
- date range chips labelled `"{facet.label}: {Jan 1 [ENDASH] Feb 1}"` via `formatDayLabel`,
  or `From X` / `Until X` for one-sided ranges
- removing an individual multi chip filters just that value; removing `+N more` or a
  range chip deletes the whole facet key
- a trailing ghost `Clear all` `<Button size="sm">` from the page itself, calling
  `clearAllFilters()`

Any filter change goes through `handleFilterChange` -> `setValue(next)` + `setPage(1)`.

### 2.5 URL sync and local state

`useFilterState(jobsRegistry)` binds facet state to `useSearchParams`:
- decode on every render from the URL (so deep links work on mount, e.g.
  `?status=UNASSIGNED&status=SCHEDULED`, `?needs_invoice=true`)
- `setValue` deletes only the registry's own keys (`param`, `param_min`, `param_max`,
  `param_after`, `param_before`) then re-sets the encoded ones, preserving unrelated
  params, and calls `setSearchParams(merged, { replace: true })` - filter edits never
  push history entries
- `listParams` is the encoded object ready to spread into the request

NOT in the URL (page-local `useState` only, lost on reload):
- `page` (default 1)
- `pageSize` (default 25)
- `search` (default `''`)
- `sorting` (default `[]`, a TanStack `SortingState`)

Persisted elsewhere: DataTable column widths / visibility / "manually sized" flags via
`useTableView('jobs')` - a SERVER-side saved view keyed by `tableKey="jobs"`, applied once
when `savedConfig` resolves. There is no localStorage/sessionStorage use anywhere in this
module.

Known deep-link entry points into this page (documented in the source comments):
Customers "Active Jobs" KPI, Invoices "To Be Invoiced" KPI (`?needs_invoice=true`).

### 2.6 API interactions

| # | Hook | Query key | Endpoint | Method | Notes |
|---|---|---|---|---|---|
| 1 | `useAssignableUsers({ includeReferencedIn: 'jobs' })` | `['users','assignable',null,null,'jobs']` | `GET /api/users?assignable=true&include_referenced_in=jobs` | GET | `staleTime 30s`, `placeholderData: keepPreviousData` |
| 2 | `useQuery` inline | `['departments']` | `GET /api/departments` | GET | returns `data.departments` |
| 3 | `useQuery` inline | `['jobs', { page, pageSize, search, sortBy, sortDir, value }]` | `GET /api/jobs` | GET | params = `{ page, limit: pageSize, ...listParams }` |
| 4 | `api.get` in `handleExportAll` | none (imperative) | `GET /api/jobs/export` | GET | params = `listParams` (no page/limit) |

`listParams` construction (JobsPage.tsx:262-278) - the explicit `undefined` placeholders
are load-bearing (`list-status-defaults.test.tsx` asserts `status` is a present key even
when unset; axios drops `undefined` before sending):

```
{
  search: search || undefined,
  status: undefined, assigned_to: undefined, department_id: undefined,
  scheduled_after: undefined, scheduled_before: undefined,
  created_after: undefined, created_before: undefined,
  needs_invoice: undefined,
  sortBy,
  sortDir: sortBy ? sortDir : undefined,
  exclude_plan_visits: 'true',
  ...filterParams          // only ACTIVE facets appear here
}
```
`sortBy = sorting[0]?.id`, `sortDir = sorting[0]?.desc ? 'desc' : 'asc'`.

Response shape consumed: `{ jobs: JobListItem[], pagination: {page,limit,total,totalPages},
stats: { unassigned, scheduled, in_progress, completed, cancelled, need_invoices } }`.

No mutations on this page. No cache invalidation. No optimistic updates.

### 2.7 Interactive elements

| Element | Action | Opens / result |
|---|---|---|
| Search input (in DataTable toolbar) | debounced 300 ms -> `handleSearchChange` | `setSearch(v)`, `setPage(1)`, refetch |
| `Filter` button | toggles popover | `FilterBar` Radix Popover |
| Facet rail tab | selects facet | swaps the right pane control |
| Facet checkbox | toggles a value | `setValue` -> URL replace, `setPage(1)` |
| `Select all` / `Deselect all` | bulk toggle of visible options | same |
| `Clear {label}` | empties that facet's values | same |
| `Clear all ({n})` (in popover header) | `onChange({})` | clears all facets |
| `Done` (popover footer) | closes popover | no data change |
| Applied chip `x` | removes that value/facet | `setValue` |
| `Clear all` (chip strip) | `clearAllFilters()` | clears facets + search + page |
| KPI tile (any of 6) | see 2.3 | filter apply / toggle-off |
| `Columns` button | opens Popover | per-column visibility checkboxes (`customer` is `locked`, shown disabled with a lock glyph), `Save current view` (persists via `useTableView('jobs')`), `Reset to default columns`, `Reset column widths` |
| Column header click | toggles sort | `onSortingChange` -> `setSorting(s)` + `setPage(1)`; suppressed if a resize just happened |
| Column header right-click | opens `HeaderContextMenu` (fixed-position div at cursor) | `Reset this column width` / `Reset all widths` |
| Column resize handle drag | `role="separator" aria-orientation="vertical"` | resizes; on mouseup clamps to `meta.minWidth` and marks the column manually sized |
| Resize handle double-click | auto-fit | measures visible `[data-col-id]` cells, clamps to `[minWidth, 600]` |
| Row click | `onRowClick` | `navigate('/jobs/'+job.id)`; suppressed while `wasResizing` |
| `Export` button (dropdown trigger) | opens `DropdownMenu` | label `Export as CSV`, separator, two items |
| `Current page ({n} rows)` | `handleExportCurrentPage` | client-side CSV of `data.jobs`, filename `jobs-page{page}-{YYYY-MM-DD}.csv`; no-ops on empty |
| `All ({total})` | `handleExportAll` | `GET /api/jobs/export` then CSV `jobs-all-{date}.csv`; on failure fires a destructive toast `Export failed` / `Failed to export jobs. Please try again.` |
| `New Job` button (`variant="business"`, `<Plus/>`) | `navigate('/jobs/new')` | navigation |
| Previous / Next | `onPageChange` | `setPage` |
| Page-size select | `onPageSizeChange` | `setPageSize(size)` + `setPage(1)` |

CSV export row shape (`toExportRow`, JobsPage.tsx:371-380), column order is the CSV header:
`Job #`, `Customer` (`customerDisplayName(j.customer,'')`), `Company`, `Status`,
`Location` (`formatJobLocation`), `Assigned To` (semicolon-joined), `Scheduled`, `Created`.
`toCSV` / `downloadCSV` are re-exported from `@/lib/csv` via `@/lib/inventory/csv`.

### 2.8 Permission-conditional rendering

Only two gates on this page:
1. `canManage = ability.can('create','Job')` -> shows/hides the `New Job` button.
   This is a CLASS-level CASL check, not `canOnJob`. Note that `create Job` is a
   per-user grantable capability (see section 6), so a technician WITH the grant sees
   the button and a bare technician does not.
2. `user?.role !== 'SALES'` -> shows/hides the whole `Export` dropdown. This is the only
   raw ROLE check on the page (`useAuthStore(s => s.user)`).

There is no gating of columns, KPI tiles, or filters.

### 2.9 States

- Loading: `isLoading` drives BOTH `KpiStrip loading` (skeleton values) and
  `DataTable isLoading` (skeleton rows: `pagination?.limit ?? 5` rows x one pulsing bar
  per column on desktop; 5 skeleton cards on mobile). The heading count pill is absent
  because `data` is undefined.
- Empty: DataTable renders a single full-width row `No results found.`
  (`h-24 text-center text-text-secondary`), or the same string in a card on mobile.
  **There is NO distinction between "no jobs exist" and "no jobs match the filters".**
  Both render the identical `No results found.` string. Section 12 flags this.
- Error: the list query has no `isError` handling - a failed fetch leaves `data`
  undefined, so the page renders exactly like the empty state (no error banner, no retry).
  The only error surface is the export toast.

---

## 3. `/jobs/new` - JobFormPage

Create-only. There is no edit route for jobs.

### 3.1 Guard and shell

```
JobFormPage()
  ability = useAppAbility()
  if (!ability.can('create','Job')) return <Navigate to="/jobs" replace/>
  customerIdParam = new URLSearchParams(location.search).get('customer_id')
  return <CreateJobForm navigate queryClient ability preselectedCustomerId={customerIdParam}/>
```

`?customer_id=<uuid>` is the only accepted query param and prefills the customer.

### 3.2 Component tree

```
<div class="space-y-4">
  <div>  <Button variant="ghost" onClick={navigate(-1)}><ArrowLeft/> Back</Button>
         <h1>New Job</h1> </div>

  <div class="rounded-xl bg-white shadow-card border p-6">
    <form onSubmit={form.handleSubmit(d => mutation.mutate({data:d}))}>
      <div class="grid lg:grid-cols-2">

        LEFT COLUMN (ref=dropdownRef)  "Client Details"
          [First Name*] [Last Name]        each with a CustomerDropdown overlay
          [Phone*]      [Email]            "
          [Company Name]                   "
          {selectedCustomer && has secondary contacts} -> "Additional Contacts" panel
          --- "Service Location" ---
          {selectedCustomer} -> Location <Select> (existing locations + "+ Add new location")
          {(!selectedCustomer || addingNewLocation)} ->
              [Address* (AddressAutocomplete)] [Unit]
              [City*] [State* maxLength 2] [ZIP*]

        RIGHT COLUMN  "Job Details"
          [Service Request* (Textarea rows=3)]
          [Job Type <Select>] [Source <Select>]
          --- "Schedule" + <Switch checked={showSchedule}> ---
          {showSchedule} -> [Start Date][Start Time] / [End Date][End Time]
      </div>

      {inlineError && <p class="text-danger">...</p>}
      <div>  <Button variant="outline" onClick={navigate(-1)}>Cancel</Button>
             <Button variant="business" type="submit" disabled={mutation.isPending}>
               {isPending ? 'Creating...' : 'Create Job'}</Button> </div>
    </form>
  </div>

  <DuplicateCustomerDialog open={Boolean(dupExisting)} ... />
</div>
```

### 3.3 Zod schema

Location: inline in `JobFormPage.tsx:64-92` (`createSchema`), resolver `zodResolver`.

| field | type | rule | default | control |
|---|---|---|---|---|
| `first_name` | string | `.min(1,'First name is required')` | `''` | `Input` via `register`, `onChange -> handleFieldChange` |
| `last_name` | string? | optional | `''` | `Input` via `register` |
| `company_name` | string? | optional | `''` | `Input` via `register` |
| `phone` | string? | optional at field level; see superRefine | `''` | `Controller` + `Input id="phone" inputMode="tel"`, value passed through `formatPhoneInput` on every change |
| `email` | string? | `.email('Invalid email').optional().or(z.literal(''))` | `''` | `Input id="email"` via `register` |
| `service_location_id` | string? | optional | `''` | `Select` (only when a customer is selected) |
| `service_address_line1` | string | `.min(1,'Address is required')` | `''` | `AddressAutocomplete` (controlled via `form.watch` + `setValue`) |
| `service_address_line2` | string? | optional | `''` | `Input` (label "Unit") |
| `service_city` | string | `.min(1,'City is required')` | `''` | `Input` |
| `service_state` | string | `.min(2,'State is required').max(2)` | `''` | `Input maxLength={2}` |
| `service_zip` | string | `.min(5,'ZIP is required')` | `''` | `Input` |
| `service_request` | string | `.min(1,'Service request is required')` | `''` | `Textarea rows=3`, placeholder `Describe the work needed...` |
| `job_type` | string? | optional | `''` | `Select` from `org.job_type_options` |
| `ad_source` | string? | optional | `''` | `Select` from `org.source_options` |
| `scheduled_date` | string? | optional | `''` | `Input type="date"` |
| `scheduled_time` | string? | optional | `''` | `Input type="time"` |
| `scheduled_end_date` | string? | optional | `''` | `Input type="date"` |
| `scheduled_end_time` | string? | optional | `''` | `Input type="time"` |

`superRefine` (cross-field, SERV10X-35):
- neither phone nor email (after trim) -> issue on path `['phone']`,
  message `Enter a phone number or an email`
- phone present but `phone.trim().length < 7` -> issue on `['phone']`,
  message `Enter a valid phone number`

Note the labels lie slightly vs the schema: `Phone *` is starred and `Last Name` /
`Email` are not, but the actual rule is "phone OR email" and last name is optional.
The Location `Select` is labelled `Location *` but `service_location_id` has no zod rule -
it is enforced indirectly because the address fields become required when
`__add_new__` is picked.

Error rendering: every field prints `<p class="mt-1 text-xs text-danger">{message}</p>`
under the control, except `company_name` and the four schedule fields, which render no
error node (they have no rules).

Select option fallbacks: when `org.job_type_options` (or `source_options`) is empty, a
single DISABLED `SelectItem value="__none__"` reading `No options [EMDASH] add in Settings`
is rendered. The Source select additionally prepends the CURRENT value to the option list
when it is not already in `org.source_options` (so an inherited legacy source is not lost).

### 3.4 Customer search / autofill

State: `showDropdown`, `activeSearchField` (a `keyof CreateFormData`), `selectedCustomerId`,
`selectedCustomer`, `showSchedule`, `dropdownRef`.

- `handleFieldChange(field)` (fires on every keystroke in first_name, last_name,
  company_name, phone, email): sets `activeSearchField=field`, `showDropdown=true`, and
  CLEARS `selectedCustomerId`/`selectedCustomer` if one was picked.
- `handleFieldFocus(field)`: re-opens the dropdown only when the field already holds
  `>= 2` chars.
- Query: `['customers-search', activeFieldValue]` -> `GET /api/customers?search=<v>&limit=6`,
  `enabled: activeFieldValue.length >= 2 && showDropdown`.
- `CustomerDropdown` is an absolutely-positioned panel (`z-10 mt-1 w-full ... max-h-60
  overflow-y-auto`) rendered INSIDE each field's relative wrapper, so five separate
  instances exist, gated on `activeSearchField === '<field>' && showDropdown &&
  activeFieldValue.length >= 2`. Each row is a `<button type="button">` showing
  `First Last (Company)` and `formatPhone(phone) - email`. Empty results render
  `No customers found`.
- A `mousedown` listener on `document` closes the dropdown when the click is outside
  `dropdownRef` (which wraps the ENTIRE left column, not just the inputs).
- `selectCustomer(c)` fills first/last/company/phone (through `formatPhoneInput`)/email/
  ad_source; then picks `service_locations.find(is_primary) ?? [0]`. If a location exists
  it sets `service_location_id` + all five address fields; otherwise it sets
  `service_location_id = '__add_new__'` and blanks the address fields.
- Preselect: query `['customer-prefill', preselectedCustomerId]` ->
  `GET /api/customers/:id`, `enabled: Boolean(preselectedCustomerId)`; an effect calls
  `selectCustomer(preselectedCustomer)` once when it lands and nothing is selected yet.

"Additional Contacts" panel renders only when a customer is selected AND it has any of
`secondary_phone`, `phone_ext`, or non-empty `extra_emails`. It lists `phone ext. N`,
the secondary phone (with `(secondary)` marker), and each extra email with its label.

Location `Select` `onValueChange`:
- `'__add_new__'` -> blanks all five address fields, with `shouldValidate: true` on
  line1/city/state/zip (so the required errors appear immediately)
- an existing location id -> copies that location's fields in, `shouldValidate: true`

`AddressAutocomplete` `onSelect(place)` writes `address_line1`, `city`, `state`, `zip`
(all with `shouldValidate`). Its `onChange` writes only `address_line1`.

### 3.5 Submit path

`mutation.mutationFn`:
```
body = buildCreateJobPayload(data, { selectedCustomerId, showSchedule })
url  = (!selectedCustomerId && override) ? '/api/jobs?override=true' : '/api/jobs'
POST url, body
```

`buildCreateJobPayload` (`lib/job-create-payload.ts`) - EXACT wire contract:

base (always): `{ scope_notes: service_request, job_type: job_type||undefined,
scheduled_start, scheduled_end }` where the two schedule fields are
`combineDatetime(date, time)` -> `new Date(`${date}T${time||'00:00'}:00`).toISOString()`
and are `undefined` unless `showSchedule` is true.

- existing customer (`selectedCustomerId` truthy):
  `{ customer_id, ad_source: ad_source||undefined, ...base,
     ...(pickedExisting ? { service_location_id } : { new_location: {...5 fields} }) }`
  where `pickedExisting = Boolean(service_location_id) && service_location_id !== '__add_new__'`.
- new customer: `{ new_customer: { first_name, last_name?, company_name?, phone?, email?,
  ad_source?, location: {...5 fields} }, ...base }`.
  Note `ad_source` rides on the CUSTOMER, never on the job.

`onSuccess(res)`:
- clears `dupExisting`, `pendingData`, `dupMatched`
- `queryClient.invalidateQueries(['jobs'])`
- `queryClient.invalidateQueries(['customers'])`
- `navigate(res.job?.id && ability.can('read','Job') ? '/jobs/'+res.job.id : '/jobs')`
  (class-level read check so a create-only grantee is not dropped on a 404)

`onError(err, {data})`: if `getDuplicate(err)` matches (HTTP 409 with
`data.error === 'duplicate'` and `data.existing`), store the existing customer, the
pending form data, and `computeMatchedFields` -> opens `DuplicateCustomerDialog`.
Any other error renders inline via `inlineError` ->
`extractApiError(err,'Something went wrong')` above the button row.

### 3.6 Duplicate-customer dialog

`DuplicateCustomerDialog` (`components/customers/DuplicateCustomerDialog.tsx`), open when
`dupExisting` is non-null. Props: `existing`, `matchedFields {email, phone}`,
`isOverriding`, and four callbacks:

- `onOpenExisting` -> `handleOpenExisting()`: snapshots the current ad_source and address
  draft, sets `openingExisting=true`, `GET /api/customers/:id`, then `selectCustomer(...)`.
  On fetch failure it builds a minimal fallback customer from the 409 payload, calls
  `selectCustomer(fallback)`, then RESTORES the drafted address fields
  (`service_location_id || '__add_new__'` plus the five address fields). Finally
  re-applies the drafted ad_source if non-empty, clears `openingExisting`, closes dialog.
  Guarded against re-entry by `if (!dupExisting || openingExisting) return`.
- `onEditField('email'|'phone')` -> closes dialog, `form.setFocus(field)`, then a
  `requestAnimationFrame(() => document.getElementById(field)?.focus())` belt-and-braces
  focus (this is why the phone and email inputs carry literal `id="phone"` / `id="email"`).
- `onCreateAnyway` -> re-runs the mutation with `override: true` (adds `?override=true`,
  only meaningful on the new-customer path).
- `onClose` -> `setDupExisting(null)`.

Matching helpers: `normalizeEmail` (trim + lowercase); `normalizePhone` (strip non-digits,
drop a leading `1` from an 11-digit number); `computeMatchedFields` marks a field matched
only when the submitted value is non-empty AND equal after normalisation.

`isOverriding = (mutation.isPending && Boolean(pendingData)) || openingExisting`.

### 3.7 Other API calls on this page

| Hook | Key | Endpoint |
|---|---|---|
| `useOrganization()` | (see `lib/api/organization`) | supplies `job_type_options`, `source_options` |
| inline `useQuery` | `['customers-search', activeFieldValue]` | `GET /api/customers?search&limit=6` |
| inline `useQuery` | `['customer-prefill', id]` | `GET /api/customers/:id` |
| `useMutation` | - | `POST /api/jobs` (or `?override=true`) |
| imperative | - | `GET /api/customers/:id` inside `handleOpenExisting` |
| `AddressAutocomplete` | internal | address lookup provider (see that component) |

### 3.8 States

- No page-level loading state. The form renders immediately; org options and the
  preselected customer stream in.
- No empty state (it is a create form).
- Errors: field-level zod messages; one inline API error paragraph; the duplicate dialog.
  The submit button is disabled while `mutation.isPending` and reads `Creating...`.

### 3.9 Permission-conditional rendering

Exactly one: the `create Job` route-level redirect (3.1). Nothing inside the form is
permission-gated.

---

## 4. `/jobs/:jobId/statement` - StatementPage

Shared component; `scope` is derived as `params.jobId ? 'job' : 'customer'`. For the jobs
module only the `job` branch matters, but the customer branch must not regress.

### 4.1 Tree

```
<div class="space-y-4" data-testid="statement-page">
  <Breadcrumb items={crumbs}/>
  <Card>   // hero
    <h1><Receipt/> {scope==='job' ? 'Job Statement' : 'Customer Statement'}</h1>
    <p>Running ledger of invoices, payments, credits and refunds.</p>
    {scope==='customer' && members.length>0 && <div><Users/> Billing group: {names}</div>}
    <Button variant="outline" size="sm" onClick={handleDownloadPdf}><Download/> Download PDF</Button>
  </Card>
  <Card class="p-0 overflow-hidden">
    <table>  Date | Description | Amount (right) | Running Balance (right)
       rows, or a colSpan=4 "No activity yet." row
    </table>
    <div>  // totals strip, flex + divide-x
      Billed | Paid | [Deposit credit]? | Refunded | Credited | Balance (tinted cell)
    </div>
  </Card>
</div>
```

Breadcrumbs: `location.state?.breadcrumbs` if the navigator supplied them, otherwise
`[{label:'Jobs', href:'/jobs'}]` for job scope (`[{label:'Customers', href:'/customers'}]`
for customer scope), always followed by `{label:'Statement'}`.

### 4.2 Data + interactions

| Concern | Detail |
|---|---|
| Query | `['statement', scope, entityId]` -> `getJobStatement(jobId)` -> `GET /api/statements/job/:jobId`; `enabled: Boolean(entityId)` |
| PDF button | `getJobStatement(jobId, {format:'pdf'})` -> `GET /api/statements/job/:jobId?format=pdf` with `responseType:'blob'`, then `URL.createObjectURL(blob)`, `window.open(url,'_blank','noopener')`, `setTimeout(revokeObjectURL, 60000)`. NO loading state, NO error handling - a rejected promise is unhandled. |
| Row rendering | key `${line.invoice_id ?? 'row'}-${i}`; hover `bg-background-light/40` |

Line presentation:
- `LINE_LABELS` map: `invoice->Invoice`, `credit->Credit`, `deposit_credit->Deposit credit`,
  `payment->Payment`, `refund->Refund`; unknown type -> `Adjustment`.
- `NEGATIVE_TYPES = {payment, credit, deposit_credit}` -> amount rendered with a leading
  U+2212 MINUS SIGN (not an ASCII hyphen) before the formatted currency.
- Description cell: label, then ` - {invoice_number}` when present, then
  ` - {customer_name}` when `scope==='customer'` and present.
- `formatDate(null|invalid)` -> the em-dash placeholder glyph.

Totals strip cells, in order: `Billed`, `Paid`, then `Deposit credit` ONLY when
`Number(totals.deposit_credit ?? 0) !== 0`, then `Refunded`, `Credited`, and finally the
tinted `Balance` cell carrying `data-testid="statement-running-balance"`.
Reconciliation documented in-source: `Balance = Billed - Paid - Deposit credit - Credited + Refunded`.

### 4.3 States

- Loading: breadcrumb-width skeleton, then a card with two skeleton bars, then a card with
  five full-width skeleton rows. (The breadcrumb itself is NOT rendered while loading.)
- Error OR `!statement`: breadcrumb + a centered card with a `FileText` icon and the copy
  `This statement is unavailable or you do not have access to it.` (this is the 403 surface).
- Empty ledger: a single `colSpan={4}` row reading `No activity yet.` The totals strip still
  renders with zeros.

### 4.4 Permission-conditional rendering

None client-side. Access control is entirely server-side; a 403 surfaces as the error card.

---

## 5. `/jobs/:id` - JobDetailPage

The largest surface. 1523 lines, 9 tabs, 6 dialogs, 1 popover, 1 slide-over rail.

### 5.1 Top-level structure

```
<IconRail entityType="JOB" entityId={id} panels={['activity']}>
  <div class="space-y-4">
    <Breadcrumb/>
    <Card class="p-5 space-y-4">                 // "Command Center Header"
       row 1: identity block  |  action cluster
       reopen error paragraph (conditional)
       task at-risk strip (conditional)
       info band: Zone A contact | Zone B schedule+service tiles | Zone C money
       task signal chips (conditional)
       <JobLifecycleBar/>
    </Card>
    <Tabs value={activeTab} onValueChange={setActiveTab}>
       <TabsList> 9 triggers, 4 of them ability-gated </TabsList>
       <div class="rounded-b-card bg-primary-subtle/50">   // tinted content tray
          9 <TabsContent>
       </div>
    </Tabs>
    <CreateTaskModal/> <AssignJobDialog/> <CancelJobDialog/>
    <EditJobLocationDialog/> <CreateJobInvoiceDialog/>
  </div>
</IconRail>
```

`IconRail` (`components/shared/IconRail.tsx`) with `panels={['activity']}`:
- Main content gets `marginRight: panelOpen && isXL ? '360px' : '40px'` (isXL = matchMedia
  `(min-width: 1280px)`).
- A fixed rail `right-0 top-[64px] bottom-0 w-10 z-30` with ONE icon button
  (`MessageSquare`, `title="Activity"`); the Attachments rail button is filtered out by
  the `panels` prop.
- A sliding panel `fixed right-10 top-[64px] bottom-0 w-80 z-20`, translated off-screen
  unless open, header `Activity` + an `X` close button, body = `<ActivityPanel
  entityType="JOB" entityId={id}/>`.
- Below XL, an invisible full-screen backdrop (`fixed inset-0 z-10`) closes the panel on click.
- Clicking the same icon again toggles the panel closed.

Breadcrumb items: `location.state?.breadcrumbs` (when navigated from Leads / Customers /
Estimates) appended with `{label: job.job_number}`, otherwise
`[{label:'Jobs', href:'/jobs'}, {label: job.job_number}]`.

### 5.2 Queries

| # | Key | Endpoint | Enabled | Consumed by |
|---|---|---|---|---|
| 1 | `['job', id]` | `GET /api/jobs/:id` -> `data.job` | always | everything |
| 2 | `['job-financials', id]` | `GET /api/jobs/:id/financials` | `!!id` | money block, lifecycle bar, Items tab, Payments tab, AI card |
| 3 | `['job-task-summary', id]` | `GET /api/tasks/summary?linked_entity_type=JOB&linked_entity_id=:id` | `!!id` | at-risk strip, task chips, Tasks tab badge |
| 4 | `['job-attachments-wt', id]` | `GET /api/attachments/JOB/:id?include_walkthrough=true` | `!!id` | Attachments tab, RecentPhotos, DocumentsPreview, AiInsightsCard |
| 5 | `['job-notes-wt', id]` | `GET /api/jobs/:id/notes?include_walkthrough=true` | `!!id` | JobNotesPreview, Notes tab |

Child components add their own queries:
- `CustomerContactCard`: `['job-communications-preview', job.id]` ->
  `GET /api/jobs/:id/communications`, `enabled: ability.can('read','Communication')`
- `JobCommunicationsTab`: `['job-communications', jobId]` -> same endpoint (a SECOND,
  separately-keyed fetch of the same data)
- `JobStagesSection`: `['job-stages', jobId]` ->
  `GET /api/inventory/job-stages?job_id=`, `retry: false` (a 403 becomes `isError` and the
  whole section returns `null`)
- `LineItemsEditor`: `['state-tax-rates']` -> `fetchStateTaxRates`,
  `enabled: hasInvoice && canEdit`, `staleTime` 1 hour
- `TagInput`: `['tags']` -> `GET /api/tags`
- `EditJobLocationDialog`: `['customer', customerId]` -> `GET /api/customers/:id`,
  `enabled: open && Boolean(customerId)`
- `AssignTeamPopover` / `MultiAssigneeSelect` / `AssigneeSelect`: `useAssignableUsers`
- `JobLeadTasksTab`: imperative `listTasks({linked_entity_type:'JOB', linked_entity_id})`
  in a `useEffect`, into local state (NOT react-query)

### 5.3 The task-summary invalidation effect (JobDetailPage.tsx:616-641)

A subtle piece that must be reproduced exactly:

```
jobTasksFingerprint = useTasksStore(s =>
   s.tasks.filter(t => t.linked_entity?.id === id)
          .map(t => `${t.id}:${t.status}:${t.updated_at}`)
          .sort().join(','))
prevFingerprintRef = useRef<string|undefined>(undefined)
useEffect(() => {
  if (prev === undefined) { prev = fingerprint; return }      // skip first render
  if (prev !== fingerprint && id) invalidateQueries(['job-task-summary', id])
  prev = fingerprint
}, [jobTasksFingerprint, id, queryClient])
```

The string fingerprint (rather than an array) is deliberate: `.filter()` returns a new
reference every render and would loop forever. The first-render skip is asserted by
`job-task-signals.test.tsx`.

### 5.4 Mutations and cache invalidation

`invalidateJob()` - the shared invalidation set used by reopen / complete / arrive / start:
```
['job', id]
['jobs']
['job-timeline', id]
['job-task-summary', id]
servicePlanKeys.bucket        // from lib/api/service-plans
```

| Mutation | Endpoint | onSuccess | onError |
|---|---|---|---|
| `deleteMutation` | `DELETE /api/jobs/:id` | invalidate `['jobs']`, `navigate('/jobs')` | none (silent) |
| `reopenMutation` | `POST /api/jobs/:id/reopen` (via `reopenJob`) | `invalidateJob()` | none; the error is RENDERED inline under the header (`extractApiError(err,'Cannot reopen this job')`) |
| `completeMutation` | `POST /api/jobs/:id/complete` | `invalidateJob()` | destructive toast `extractApiError(err,'Failed to complete job')` |
| `arriveMutation` | `POST /api/jobs/:id/arrive` | `invalidateJob()` | destructive toast `...'Failed to mark on site'` |
| `startMutation` | `POST /api/jobs/:id/start` | `invalidateJob()` | destructive toast `...'Failed to start job'` |
| `createInvoiceMutation` | `POST /api/invoices` body `{ job_id: job.id }` | `goToInvoice(res.data.invoice.id)` | none |
| `duplicateMutation` | `POST /api/jobs/:id/duplicate` | invalidate `['jobs']`, `navigate('/jobs/'+data.job.id)` | destructive toast `...'Failed to duplicate job'` |

`goToInvoice(invoiceId)`: invalidates `['job', id]` then
`navigate('/invoices/'+invoiceId, { state: { breadcrumbs: [{label:'Jobs',href:'/jobs'},
{label: job.job_number, href:'/jobs/'+id}] } })`.

NO optimistic updates anywhere in this module. Every mutation is fire-then-invalidate.

Dialog-owned mutations (each invalidates its own set):

| Component | Endpoint | Invalidates |
|---|---|---|
| `AssignJobDialog` (assign) | `POST /api/jobs/:id/assign` body `{assignee_ids, scheduled_start?, scheduled_end?, is_all_day}` | `['job',jobId]`, `['jobs']`, `['job-timeline',jobId]`, `['schedule-unassigned']`, `['schedule-jobs']` |
| `AssignJobDialog` (force) | same + `{force:true}` (no `is_all_day`) | same |
| `AssignJobCrewPopover` | `POST /api/jobs/:id/assignees` body `{assignee_ids, notify:{in_app,email}}` | `['job',jobId]`, `['jobs']`, `['job-timeline',jobId]`, `['schedule-jobs']`, `['schedule-unassigned']` |
| `CancelJobDialog` | `POST /api/jobs/:id/cancel` body `{cancelled_reason}` | `['job',jobId]`, `['jobs']`, `['job-timeline',jobId]` |
| `EditJobLocationDialog` | `PATCH /api/jobs/:id` body `{service_location_id}` OR `{address:{...}}` | `['job',jobId]`, `['jobs']` |
| `CreateJobInvoiceDialog` | `POST /api/invoices` body `{job_id, line_items[]}` | `['invoices']` then `onCreated(id)` -> `goToInvoice` |
| `TeamCard` -> `AssignDispatcherDialog` | `POST /api/jobs/:id/dispatcher` body `{dispatcher_id}` (or `null`) | `['job',jobId]` |
| `TagInput` add | `POST /api/jobs/:id/tags` body `{tag_id}` or `{name,color}` | `['job',entityId]`, `['tags']` |
| `TagInput` remove | `DELETE /api/jobs/:id/tags/:tagId` | `['job',entityId]` |
| `NotesTabBody` / `JobNotesPreview` add note | `POST /api/jobs/:id/notes` body `{content}` | `['job-notes-wt',jobId]`, `['notes','JOB',jobId]` |
| `AttachmentsTabBody` upload | `POST /api/attachments/job/:jobId` (multipart, one request PER file) | `['job-attachments-wt',jobId]`, `['attachments','JOB',jobId]` |
| `LineItemsEditor` add | `ensureJobInvoice(jobId)` (`POST /api/jobs/:id/ensure-invoice`) when no invoice, then `addInvoiceLine(invoiceId, payload)` | `['job-financials',jobId]`, `['job',jobId]` |
| `LineItemsEditor` update / delete / billing | `updateInvoiceLine` / `deleteInvoiceLine` / `updateInvoiceBilling` | same pair |
| `JobCommunicationsTab` send sms | `POST /api/communication/sms` body `{customerId, body, jobId}` | `['job-communications',jobId]`, `['customer-communications']`, `['communication']` |
| `JobCommunicationsTab` send email | `POST /api/communication/emails` body `{to, subject, body:[body], job_id}` | same three |

### 5.5 Permission model - `getAvailableActions` (JobDetailPage.tsx:161-187)

```
const on = (verb) => canOnJob(ability, verb, job, userId)

canAssign        = on('assign')
canUnassign      = on('unassign')                                 // DEAD - never used
canArrive        = on('arrive')
canStart         = on('start')
canComplete      = on('complete')  && job.status !== 'COMPLETED'
canCancel        = on('cancel')    && job.status !== 'CANCELLED'
canDelete        = on('delete')    && job.invoices.length === 0
canReopen        = ability.can('reopen','Job') && job.status === 'COMPLETED'
canDuplicate     = ability.can('create','Job')
canAddNotes      = on('update')                                   // DEAD - never used
canCreateInvoice = ability.can('create','Invoice')
                   && job.status !== 'CANCELLED'
                   && !job.source_plan_id
```

`canOnJob` (`lib/ability.ts:46-65`) - MUST be used instead of `ability.can(verb,
subject('Job', job))`, which returns false for every technician because the server's
own-job condition uses the Prisma `some` operator that the Mongo/sift matcher cannot
evaluate:
1. `if (!ability.can(verb,'Job')) return false` - type-level check FIRST, so inverted
   (deny) rules from a per-user override win.
2. `rules = ability.rulesFor(verb,'Job')`; `if (!rules.length) return false`
3. if any rule is non-inverted AND has no conditions -> `true` (org-wide authority:
   ADMIN via manage-all, DISPATCHER via flat grants)
4. otherwise every grant is own-scoped -> `job.assignees?.some(a => a.user.id === userId) ?? false`

Additional gates computed on the page:
- `canEditLocation = user?.role === 'ADMIN' || user?.role === 'DISPATCHER'` - RAW ROLE
  check, the only one on the page. Controls the pencil next to the service address and the
  "No service address" affordance.
- `canEditServiceType` - same expression, **computed but never used** (dead).
- `canViewWorkOrder = Boolean(job.estimate) && ability.can('read','Estimate')` -
  **computed but never used** (dead). There is no "View Work Order" button in the current
  render tree.
- `remainingUnbilled` - computed, then explicitly discarded via `void remainingUnbilled`.

Tab-level CASL gates (JobDetailPage.tsx:1222-1253):
- `ability.can('read','Inventory')` -> Logistics trigger
- `ability.can('read','Estimate')` -> Estimates trigger
- `ability.can('read','Communication')` -> Communication trigger AND the matching
  `<TabsContent>` (double-gated: the content element itself is conditional)
- `ability.can('read','Invoice')` -> Payments trigger

Note the asymmetry: Logistics / Estimates / Payments hide only the TRIGGER; their
`TabsContent` elements are always mounted in the tree, so a deep link that programmatically
sets `activeTab` would still render them. Only Communication hides both.

Child-component gates:
- `TeamCard`: `ability.can('assign','Job')` (CLASS level, not `canOnJob`) gates the
  Dispatcher `Change` / `Assign` link and mounting `AssignDispatcherDialog`. The
  "Assigned Technicians" `Assign` link and the `+ Add technician` fallback are gated on the
  `onAssign` prop, which the page passes only when `actions.canAssign`.
- `CustomerContactCard`: `ability.can('read','Communication')` gates the whole
  "Communication History" block AND the preview query.
- `LineItemsEditor`: `canManage = ability.can('manage_lines','Invoice')` (the header `+`
  and the per-row trash); `canEdit = ability.can('update','Invoice')` (inline row fields,
  footer tip/discount/tax, and `canSaveToPriceBook` in the add dialog).
- `LineItemsTable` derives: `canAdd = canManage`, `canManageRows = hasInvoice && canManage`,
  `canEditRows = hasInvoice && canEdit`, `canEditBilling = hasInvoice && canEdit`.
  So on an estimate-basis (no invoice) view, rows are read-only even for an admin.

### 5.6 PER-USER grants vs role defaults (the subtle part)

`backend/src/lib/permissions/userCapabilities.ts` is the authoritative list of the ONLY
(action, subject) pairs an admin may toggle per individual user. Job-relevant entries:

| action | subject | own-condition | impliesRead |
|---|---|---|---|
| `create` | `Job` | `{assignees:{some:{user_id}}}` | yes |
| `update` | `Job` | same | yes |
| `en_route` | `Job` | same | yes |
| `arrive` | `Job` | same | yes |
| `start` | `Job` | same | yes |
| `complete` | `Job` | same | yes |
| `reschedule` | `Job` | same | yes |
| `create` | `Invoice` | `{job:{assignees:{some:{user_id}}}}` | yes |
| `update` | `Invoice` | same | yes |
| `record_payment` | `Invoice` | same | yes |

Consequences for the UI, precisely:

- **`create Job`** gates the Jobs-list `New Job` button, the `/jobs/new` route, and the
  detail page's `Duplicate Job` menu item. All three use the CLASS-level
  `ability.can('create','Job')`, so a technician who was granted `create Job` sees all
  three; a bare technician sees none of them.
- **`create Invoice`** gates `actions.canCreateInvoice` -> the header `Create Invoice`
  button. Also class-level. A bare technician never sees it; a granted one does, but
  the grant is own-scoped server-side, so the button only actually works on their own jobs.
  The page does not narrow the button by assignment, so a granted technician viewing
  someone else's job WOULD see a button that 403s. (Flagged in section 12.)
- **`record_payment`** does NOT appear anywhere in this module's render logic. The
  Payments tab's `Record Payment` control is a `<Link to={/invoices/:id}>` with no ability
  check at all - it is gated purely on invoice financial state (see 5.10). The actual
  `record_payment` gate lives on the Invoice detail page.
- **`reschedule`** likewise does NOT appear in this module. The Schedule / Reschedule
  button is gated on `canOnJob(ability,'assign',job,userId)`, not on `reschedule`.
  A user granted `reschedule` but not `assign` sees no reschedule affordance here.
- **`arrive` / `start` / `complete`** flow through `canOnJob` into the lifecycle bar's
  `can` prop and the header `Mark Complete` button.
- `update Job` (`canAddNotes`) is computed but unused; the Notes composer and the
  JobNotesPreview composer are rendered UNCONDITIONALLY. Any user who can read the job can
  see (and attempt) the Add Note control; the API is the only gate.

### 5.7 Status logic (Spec B1 - UNORDERED)

Job status is NOT an ordering gate. Any milestone is reachable from any other, forward or
backward, and cancel is not terminal. The ONLY status-derived blocks in the current code are:

| Rule | Where | Effect |
|---|---|---|
| `job.status !== 'COMPLETED'` on `canComplete` | getAvailableActions | self-exclusion; re-completing would re-stamp `completed_at` and re-arm follow-up automation |
| `job.status !== 'CANCELLED'` on `canCancel` | getAvailableActions | self-exclusion; cancelling a cancelled job is a no-op |
| `job.invoices.length === 0` on `canDelete` | getAvailableActions | integrity: matches the backend delete guard, which blocks on ANY invoice regardless of status (a voided-only set still blocks) |
| `job.status === 'COMPLETED'` on `canReopen` | getAvailableActions | reopen only makes sense from completed |
| `job.status !== 'CANCELLED'` on `canCreateInvoice` | getAvailableActions | cannot invoice a cancelled job |
| `!job.source_plan_id` on `canCreateInvoice` | getAvailableActions | integrity: a service-plan visit job was billed upfront via the plan's `kind=PLAN` invoice; invoicing the visit would double-charge (backend also blocks) |
| `!stage.current` on a lifecycle node | JobLifecycleBar | clicking the CURRENT milestone is suppressed (would re-stamp for nothing) |
| `!job.completed_at && job.status !== 'IN_PROGRESS'` on `canStart` | JobLifecycleBar | the `Start` button hides once started or completed; moving back to On Site clears `started_at`/`completed_at` server-side and re-enables it automatically |
| line items >= 1 to invoice | enforced server-side; `CreateJobInvoiceDialog` mirrors it client-side with the `Add at least one line item` validation |

The header buttons' LABELS are status/data-derived but not status-BLOCKED:
`job.scheduled_start ? 'Reschedule' (CalendarDays icon) : 'Schedule Job' (CalendarPlus icon)`.

`computeLifecycle(job, financials)` (`lib/jobs/lifecycle.ts`) builds six stages in fixed order:

| key | label | `at` source |
|---|---|---|
| `created` | Job Created | `job.created_at` |
| `scheduled` | Scheduled | `job.scheduled_start` |
| `on_site` | On Site | `job.on_site_at` |
| `completed` | Completed | `job.completed_at` |
| `invoice_sent` | Invoice Sent | `financials.final_invoice.sent_at` |
| `payment_received` | Payment Received | `final_invoice.paid_at`, but only when `status==='PAID'` or `Number(amount_due)===0`; otherwise `null` |

`reached` is MONOTONIC and back-filled: iterating from the last stage backwards, a stage is
reached when its own `at` is non-null OR any LATER stage has a non-null `at`.
`current` = the last reached stage, EXCEPT when `job.cancelled_at` is set, in which case NO
stage is current (the bar freezes) and a `Cancelled` pill renders above it.

### 5.8 The header action cluster (in DOM order)

| Element | Condition | Behaviour |
|---|---|---|
| `New Task` (`variant="outline"`, `PlusCircle`) | ALWAYS (no gate) | `setNewTaskOpen(true)` -> `CreateTaskModal` with `presetEntity={type:'JOB', id: job.id, label: '{job_number} [EMDASH] {customerName}'}` |
| `Create Invoice` (`variant="business"`, `Receipt`) | `actions.canCreateInvoice` | `job.estimate ? createInvoiceMutation.mutate() : setCreateInvoiceOpen(true)`; `disabled={createInvoiceMutation.isPending}`. Estimate-backed = one-click POST (backend snapshots estimate lines) then navigate; estimate-less = opens `CreateJobInvoiceDialog` |
| `Assign` (`variant="outline"`, `User`) - popover trigger | `actions.canAssign` | `AssignJobCrewPopover` -> `AssignTeamPopover mode="multi" channels={['in_app','email']}` anchored `align="end"` |
| `Schedule Job` / `Reschedule` (default variant) | `actions.canAssign` | `setAssignOpen(true)` -> `AssignJobDialog` |
| `Mark Complete` (`variant="business"`, `CheckCircle2`) | `actions.canComplete` | `completeMutation.mutate()`; `disabled` while pending |
| `MoreHorizontal` overflow button (`variant="outline" size="sm" aria-label="More actions"`) | `canDuplicate \|\| canReopen \|\| canCancel \|\| canDelete` | `DropdownMenu` `align="end"` |
| ... `Duplicate Job` (`Copy`) | `canDuplicate` | `duplicateMutation.mutate()`, disabled while pending |
| ... `Reopen Job` (`RotateCcw`) | `canReopen` | `reopenMutation.mutate()`, disabled while pending |
| ... `Cancel` (`XCircle`, `text-danger`) | `canCancel` | `setCancelOpen(true)` -> `CancelJobDialog` |
| ... `Delete` (`Trash2`, `text-danger`) | `canDelete` | `window.confirm('Are you sure you want to delete this job?')` then `deleteMutation.mutate()` - a NATIVE confirm, not a dialog component |

Identity block (left): `{job_number}` in semibold secondary, an `aria-hidden` middot,
then a `<Link to={/customers/:id}>` with the customer display name in bold (hover underline),
then `<StatusBadge status={job.status}/>`, then a `Plan Visit` pill when `job.source_plan`
(with a `title` tooltip explaining non-billability). `job.customer.company_name` renders as
a small line beneath.

Reopen error paragraph: rendered when `reopenMutation.error` is truthy, text
`extractApiError(reopenMutation.error, 'Cannot reopen this job')` in `text-xs text-danger`.
This is the ONLY mutation on the page whose error is rendered inline rather than toasted.

Task at-risk strip: `data-testid="task-at-risk-strip"`, shown only when
`taskSummary && (overdue > 0 || at_risk > 0)`. Copy: `{n} overdue task(s) on this job`,
falling back to `{n} at-risk task(s) on this job` when `overdue === 0`.

### 5.9 Info band and money block

Zone A (contact column):
- Service address line: `[address_line1, "City, ST ZIP"]` joined with `", "`, filtered for
  falsy. Rendered with a `MapPin` icon plus, when `canEditLocation`, a pencil
  `<button aria-label="Edit service location">` opening `EditJobLocationDialog`.
- When there is NO address and `canEditLocation`: a button reading `No service address`
  with a `MapPin` and a trailing pencil, same target dialog. When there is no address and
  the user cannot edit, NOTHING renders here.
- Customer phone (when present): `<a href="tel:...">` showing `formatPhone(phone)`.
- `View Estimate ({estimate_number})` link (when `job.estimate`) -> `/estimates/:id` with
  breadcrumb state `[Jobs, {job_number}]`.
- `Service Plan ({service_plan_number})` link (when `job.source_plan`) -> `/service-plans`
  (a LIST route, not a detail route).
- `<TagInput entityType="JOB" entityId={id} tags={job.tags ?? []}/>` - chips with an `x`
  remove button plus a dashed `+ Tag` popover trigger. The popover contains: an
  `Available tags (n)` header, a sort toggle (`aria-label="Sort tags"`, ArrowDownAZ /
  ArrowUpAZ), a `Search tags...` input (Escape closes, Enter creates when no exact match),
  a wrapping chip list of unattached tags, `No tags found` when empty, and an inline
  `Create new tag "{search}"` row (random colour from a 10-colour preset palette).

Zone B: two tiles in a 2-col grid.
- Schedule tile: `CalendarDays` badge, uppercase label `Schedule`, value =
  `new Date(scheduled_start).toLocaleString(undefined,{month:'short',day:'numeric',
  hour:'numeric',minute:'2-digit'})` or the literal `Not scheduled`; a secondary line with
  `scheduleHint(scheduled_start)` when scheduled.
  `scheduleHint` (line 193): dayDiff 0 -> `Today`, 1 -> `Tomorrow`, >1 -> `in N days`,
  negative -> `d.toLocaleDateString()`.
- Service tile: `Wrench` badge, uppercase label `Service`, value `job.job_type` or the
  em-dash placeholder.

Zone C (money block, `lg:w-[260px]`), three mutually exclusive branches:
1. `isPlanVisit` (`!!job.source_plan`): label `Billing`, value `Plan visit`, caption
   `Billed upfront [EMDASH] non-billable.`
2. `contractValue != null`: label `Balance due`, a 3xl `formatCurrency(balanceDue ?? 0)`,
   a progress rail at `pctCollected%` (`bg-sage-500`), a row with
   `Contract {formatCurrency(contractValue)}` and, when `depositPaid > 0`,
   `Deposit {formatCurrency(depositPaid)}`; caption `{pctCollected}% collected`.
3. otherwise: label `Balance`, value `No contract yet`, caption
   `Add an estimate or invoice to track payment.`

Derivations (JobDetailPage.tsx:838-866):
```
financialsTotal = financials?.final_invoice != null ? Number(final_invoice.total_amount)
                : job.estimate != null              ? Number(estimate.total_amount)
                : null
contractValue   = financialsTotal
jobPayments     = financials?.payments ?? []
totalPaid       = sum(payments.amount)
depositPaid     = sum(payments where invoice_kind === 'DEPOSIT')
balanceDue      = contractValue != null ? max(contractValue - totalPaid, 0) : null
pctCollected    = contractValue > 0 ? min(round(totalPaid/contractValue*100), 100) : 0
```

Task signal chips (rendered whenever `taskSummary` exists):
- `data-testid="task-chip-open"`: `ClipboardList` + count + `Open`
- `data-testid="task-chip-overdue"`: `AlertTriangle` + count + `Overdue`; danger colours
  when `overdue > 0`, neutral otherwise
- `data-testid="task-chip-next-due"`: `CalendarDays` + `Next due:` + a
  `toLocaleDateString(undefined,{month:'short',day:'numeric'})` or the em-dash placeholder

Lifecycle bar props:
```
can = { scheduled: actions.canAssign, on_site: actions.canArrive,
        started: actions.canStart,    completed: actions.canComplete }
busy = arriveMutation.isPending || startMutation.isPending || completeMutation.isPending
onNodeClick(key):  'scheduled' -> setAssignOpen(true)
                   'on_site'   -> arriveMutation.mutate()
                   'completed' -> completeMutation.mutate()
onStartClick()  -> startMutation.mutate()
```
`JOB_NODES = ['scheduled','on_site','completed']`; `created`, `invoice_sent` and
`payment_received` are NEVER interactive. A node renders as a plain (non-button) element
when not interactive - there is no disabled affordance. The `Start` button renders UNDER
the On Site node (deliberately not a seventh node) when `canStart`.

### 5.10 Tabs

`activeTab` is CONTROLLED state (default `'overview'`) so children can switch it.
`TAB_TRIGGER_CLASS` gives every trigger a 3px bottom border that becomes `border-primary`
and semibold primary text when active. The `TabsList` is `overflow-x-auto`.

| value | trigger label | gate | content |
|---|---|---|---|
| `overview` | `Overview` | none | 4-column grid (see below) |
| `items` | `Items` | none | `<LineItemsEditor jobId financials estimateLines estimateTotal/>` |
| `logistics` | `Logistics` | `can('read','Inventory')` (trigger only) | `<JobStagesSection jobId/>` |
| `estimates` | `Estimates` | `can('read','Estimate')` (trigger only) | estimate SectionCard or empty state |
| `attachments` | `Attachments` | none | `<AttachmentsTabBody jobId attachments/>` |
| `communication` | `Communication` | `can('read','Communication')` (trigger AND content) | `<JobCommunicationsTab .../>` |
| `tasks` | `Tasks` + `({open})` when `taskSummary.open` truthy | none | `<JobLeadTasksTab entity={{type:'JOB', id: job.id, label:'{job_number} [EMDASH] {customerName}'}}/>` |
| `notes` | `Notes` | none | `<NotesTabBody jobId notes/>` |
| `payments` | `Payments` | `can('read','Invoice')` (trigger only) | `<PaymentsTab financials jobId/>` |

**Overview tab** - `grid-cols-1 xl:grid-cols-[1.15fr_1.72fr_1fr_1fr] gap-4`:

Col 1: `<CustomerContactCard job onViewAllCommunications={() => setActiveTab('communication')}/>`
then `<JobNotesPreview jobId notes={notesData}/>`.

Col 2: a `Details` SectionCard containing, each conditional:
- `Scope Notes` (when `job.scope_notes`) - `whitespace-pre-wrap`
- `Completion Notes` (when `job.completion_notes`) plus `Completed {toLocaleString}` when
  `completed_at`
- Cancellation panel (when `job.cancelled_reason`) - danger-tinted box with
  `Cancellation Reason` and `Cancelled {toLocaleString}`
- `Linked Estimate` link to `/estimates/:id` with breadcrumb state
- Invoices list (when `job.invoices.length > 0`): label is `Invoice` for exactly one and
  `Invoices ({n})` otherwise; each row is a link to `/invoices/:id` (with breadcrumb
  state) + `<StatusBadge status/>` + `formatCurrency(total_amount)`

then a 2-up row: `<DocumentsPreview attachments onAdd={() => setActiveTab('attachments')}/>`
and `<RecentPhotos attachments onAdd={() => setActiveTab('attachments')}/>`.

Col 3: `<TeamCard job onAssign={actions.canAssign ? () => setAssignOpen(true) : undefined}/>`.

Col 4: `<AiInsightsCard job attachments financials/>`.

Below the grid, full width: `<div id="ai-job-assistant">` wrapping `<AiJobAssistantBar
jobNumber customerName service={job.job_type} status={job.status}/>`.

**Estimates tab**: when `job.estimate` exists, a `SectionCard title="Estimate"` with a
`View estimate` link in the meta slot (`ArrowUpRight`), the estimate number as a bold link,
a `StatusBadge` + total, and, when `job.estimate.deposit`, a `Deposit` sub-section showing
amount, a lowercased/underscore-stripped status pill, and `paid {toLocaleDateString}`.
When there is no estimate: a centered empty state with `FileText` and `No linked estimate`.

**Attachments tab** (`AttachmentsTabBody`, exported from JobDetailPage so tests can mount it):
- Header meta = a hidden `<input type="file" multiple id="attachments-tab-upload">` wrapped
  in a `<label htmlFor>` around an outline `Upload` Button (which ALSO calls
  `fileInputRef.current?.click()`), disabled and relabelled `Uploading[ELLIPSIS]` while busy.
- Empty state: a full drop-zone `<label>` with its OWN hidden input
  (`id="attachments-empty-drop-zone-upload"`, implicit label association - no `htmlFor`, to
  avoid duplicate DOM ids). Handles `onDragOver` (preventDefault + `setIsDragging(true)`),
  `onDragLeave`, `onDrop` (preventDefault, clear dragging, `handleUpload(e.dataTransfer.files)`).
  Dragging swaps the border to `border-primary bg-primary-subtle`. Copy:
  `Drag & drop files here, or click to upload` + `No attachments yet` (or `Uploading[ELLIPSIS]`).
- Non-empty: buckets computed from `file_type.startsWith('image/')` and the
  `source === 'WALKTHROUGH' || context === 'WALKTHROUGH'` predicate:
  `photos`, `walkthroughPhotos`, `docs`, `walkthroughDocs`; `walkthrough = [...wtPhotos, ...wtDocs]`.
  - both photos AND docs present -> a 2-col grid, `Photos (n)` on the left in a
    `grid-cols-2 sm:grid-cols-3`, `Documents (n)` on the right in `grid-cols-1 sm:grid-cols-2`
  - otherwise each present bucket renders full width in `grid-cols-2 sm:grid-cols-3 md:grid-cols-4`
  - `From walkthrough (n)` section last when non-empty
  - NOTHING is capped; all items render
- `AttachmentTile`: an `<a target="_blank" rel="noopener noreferrer">` with `download`
  set to the file name for NON-images only. Images render an `<img>` thumb (h-28,
  object-cover, hover scale); video renders a `Film` icon; anything else a `FileText` icon.
  A `Walkthrough` badge sits at top-left when the walkthrough predicate matches.
- Upload loop: ONE `POST /api/attachments/job/:jobId` per file, `multipart/form-data`, with
  fields `file`, `display_name` (file name minus extension), `description: ''`,
  `context: 'JOB_WORK'`. On any failure a destructive toast `Upload failed` /
  `extractApiError(err,'Could not upload the file. Please try again.')` fires and the loop
  aborts. `finally` clears both file inputs' values.

**Notes tab** (`NotesTabBody`): a composer SectionCard `Add note` with a raw `<textarea>`
(rows 3, placeholder `Write a note[ELLIPSIS]`), a hint `[cmd]+[enter] to add`, and an
`Add Note` button (`variant="business" size="sm"`, disabled when empty or pending, label
`Adding[ELLIPSIS]` while pending). Cmd/Ctrl+Enter submits when non-empty and not pending.
`Failed to add note` renders on error. Below it a `Notes ({n})` SectionCard with
`bodyClassName="p-0"`, notes sorted NEWEST FIRST client-side, each row showing a circular
initials monogram (`FL`, or `?`), name, a `From Walkthrough` pill when `source==='WALKTHROUGH'`,
a right-aligned `formatDistanceToNow(..., {addSuffix:true})`, and the pre-wrapped content.
Empty state: `StickyNote` icon + `No notes yet`.

**Items tab** (`LineItemsEditor` -> `LineItemsTable`):
- Source of truth: `findActiveInvoice(financials)` = the first invoice with
  `kind === 'STANDARD' && status !== 'VOIDED'`. When it exists, `lines = invoice.line_items`;
  otherwise `lines = estimateLines` (a READ-ONLY basis).
- `estimateBasisLines` is mapped in the page from `job.estimate.line_items` into the
  `InvoiceLineItem` shape with `discount_type: null, discount_value: null,
  discount_amount: 0, price_book_item_id: null` and `item_type` coerced to
  `MATERIAL` when the estimate line said `MATERIAL`, else `SERVICE`.
- Header: `SectionCard title="Line items"` with a `(n)` suffix and, when `canManage`, a
  square sage `+` button `aria-label="Add line item"` opening `AddLineDialog`.
- Rows grouped into `Materials (n)` then `Services (n)` sub-header rows; empty groups omitted.
- `LineItemRow` (`data-testid="line-item-row"`): thumbnail (`ProductThumb`, 112px,
  placeholder `Custom` when there is no `price_book_item_id`), name = first line of
  `description`, detail = remaining lines rendered through `ClampedDescription` at 2 lines,
  a `Material`/`Service` pill. Editable cells when `canEditRows`:
  - Qty `<Input type=number min=0.01 step=0.01 aria-label="Quantity for {name}">`, commits on
    blur or Enter, only when `!isNaN && n > 0 && n !== current`
  - Unit price, same pattern with `min=0`, commits when `n >= 0 && n !== current`
  - Taxable `<Switch aria-label="Taxable for {name}">`, commits IMMEDIATELY
  - Discount: a `<Select aria-label="Discount type for {name}">` with `None` / `%` / `$`
    (values `NONE` / `PERCENTAGE` / `FIXED_AMOUNT`); selecting `NONE` clears both fields and
    patches `{discount_type:null, discount_value:null}`; a value `<Input>` appears when a
    type is set and commits on blur/Enter only when `n > 0`
  - Line total column always shows `max(0, line_total - discount_amount)`
  - Trash `<button aria-label="Remove {name}">` when `canManageRows`
  Read-only mode renders plain text for every one of those cells.
- `TotalsFooter` renders when `lines.length > 0 || (hasInvoice && (tip > 0 || discount > 0))`
  (so residual billing keeps the footer alive after the last line is deleted). Rows:
  `Total qty`, `Item cost`, `Discount (items)` when > 0, `Invoice discount`
  (editable `<Input aria-label="Invoice-level discount">` committing on blur, else a read row),
  `Tip` (same pattern, `aria-label="Tip amount"`), tax, and the bold total labelled
  `Invoice total` when `hasInvoice` else `Estimate total`.
  Tax block when `hasInvoice && editable`: a bordered box with a
  `Sales tax [EMDASH] jurisdiction` `<Select aria-label="Tax jurisdiction">` offering
  `No tax (0%)`, a synthetic `Custom rate (x%)` item when the stored rate matches no state,
  and one item per `StateTaxRate` (`{state_name} ({pct}%)`); picking `CUSTOM` is a no-op.
  Money figures are SERVER-AUTHORITATIVE when an invoice exists (the footer never
  re-derives tax - that caused a 100x fraction/percent bug historically).
- Estimate-basis hint below the footer: `Read-only estimate basis [EMDASH] add a line to start
  billing.` shown when `!hasInvoice && estimateTotal > 0 && lines === estimateLines` and there
  is at least one line.
- Empty state: `Package` icon, `No line items yet.`, plus an
  `aria-label="Add the first line item"` CTA when `canAdd`.
- `AddLineDialog` flow: a debounced (300 ms) price-book search
  (`searchPriceBookItems`, `aria-label="Search the price book"`, placeholder
  `Search the price book, or type a new item[ELLIPSIS]`); results list -> pick one -> a
  confirm-quantity panel with a `Change` link; or `Add "{query}" as a new item` -> a
  new-item form (Name, Type Material/Service, Taxable switch, Quantity, Unit price, and,
  when `canSaveToPriceBook`, an `Also save to price book for reuse` checkbox that first
  POSTs a price-book item and then references its id). Validation errors render inline:
  `Quantity must be a positive number.`, `Name is required.`,
  `Unit price must be a non-negative number.`, `Search for an item, or add a new one.`,
  `Could not save to the price book.` The dialog cannot be closed while loading; it resets
  on close and on successful add.
- First add on an invoice-less job calls `ensureJobInvoice(jobId)` and then adds the line
  to the returned invoice.

**Payments tab** (`PaymentsTab`):
- `inv = financials?.final_invoice`, `payments = financials?.payments ?? []`
- `depositInvoice = financials.invoices.find(i => i.kind === 'DEPOSIT')`
- `showRecordPayment = inv != null && !['PAID','VOIDED'].includes(inv.status) && Number(inv.amount_due) > 0`
  -> renders a `Record Payment` `<Link to={/invoices/:id}>` wrapping a business Button in
  the Invoice card's meta slot. There is NO ability check on this control.
- `showCollectDeposit = depositInvoice != null && !['PAID','VOIDED'].includes(depositInvoice.status)
  && Number(depositInvoice.amount_due) > 0` -> a `Collect deposit` link Button, rendered
  inside the deposit drawdown box when an invoice exists, or inside the "no invoice" empty
  state when it does not (with the copy `A {amount} deposit is due before this job is invoiced.`)
- Invoice card body: number, `StatusBadge`, `Total:` and `Due:`; plus a deposit drawdown box
  (`Deposit applied`, a progress rail at `pctCollected`, `{pct}% collected` and `Balance {amount_due}`)
  when a deposit invoice exists. Empty: `Receipt` icon + italic `No invoice yet`.
- Payment history table: columns Date / Method / Amount (right) / Invoice # / Type, with a
  `tfoot` row `Total paid`. `formatMethod` maps `CARD|CASH|CHECK|ACH|OTHER` to title case,
  unknown passes through. `KindBadge`: `null/undefined` -> em-dash text, `DEPOSIT` ->
  sage `Deposit` pill, anything else -> info `Final` pill. Empty: `CreditCard` icon +
  `No payments recorded`.

**Logistics tab** (`JobStagesSection`): returns `null` outright when the query errors
(a 403 is the expected inventory-RBAC case). Otherwise a `Staging & fulfillment`
SectionCard with an `Open in Inventory` link to `/inventory/staging`; loading = two
skeleton bars; empty = `Truck` icon + `No staging entries yet` +
`Materials are staged from the Inventory module.`; populated = one block per stage with a
status pill (`awaiting|partial|complete|ready_for_pickup|delivered`, unknown falls back to
the underscore-stripped raw value), optional trade, `{received}/{ordered} received`, a
progress rail, and one line per item with a `PackageCheck` tick when fully received.

**Communication tab** (`JobCommunicationsTab`): a unified chronological timeline across
call/email/sms/whatsapp plus an SMS/email composer. Email compose mode is disabled when
the customer has no email. Sends stamp the job at origin.

**Tasks tab** (`JobLeadTasksTab`): loads tasks imperatively via
`listTasks({linked_entity_type:'JOB', linked_entity_id})` into local state, groups them by
`IN_PROGRESS / TODO / BLOCKED / DONE`, offers a `Generate tasks` AI suggestion flow
(`taskAI.suggestTasks`) with checkboxes, and opens `CreateTaskModal` / `TaskDetailDrawer`.

### 5.11 Dialogs opened from this page

| State | Component | Trigger(s) | Notes |
|---|---|---|---|
| `newTaskOpen` | `CreateTaskModal` | header `New Task` | `presetEntity` = JOB + label |
| `assignOpen` | `AssignJobDialog` | header `Schedule Job`/`Reschedule`, lifecycle `scheduled` node, `TeamCard` `Assign` link, `TeamCard` `+ Add technician` | see below |
| `cancelOpen` | `CancelJobDialog` | overflow menu `Cancel` | Reason `Textarea` required (`disabled={!reason.trim()}`); buttons `Keep Open` / destructive `Cancel Job` (`Cancelling...` while pending); error via `extractApiError(...,'Failed to cancel job')`; resets reason on success |
| `editLocationOpen` | `EditJobLocationDialog` | address pencil, or the `No service address` button | see below |
| `createInvoiceOpen` | `CreateJobInvoiceDialog` | header `Create Invoice` when the job has NO estimate | see below |
| (internal to TeamCard) | `AssignDispatcherDialog` | `Dispatcher` section `Assign`/`Change` link | `AssigneeSelect eligibleFor="dispatcher"`; buttons `Clear dispatcher` (only when one is set, sends `null`), `Cancel`, `Save` (disabled without a selection); error toast `Could not set dispatcher` |
| (internal to AiJobAssistantBar) | AI Center modal | agent tiles, `Browse all AI agents`, the `AI Farm` link | `useAiCenterStore().openModal(agentId?)` |
| (internal to LineItemsEditor) | `AddLineDialog` | `+` in the Items header, or the empty-state CTA | controlled by `addOpen` in the editor |

`AssignJobDialog` detail (`components/jobs/AssignJobDialog.tsx`):
- Title/description swap on `isReassign = currentAssigneeIds?.length > 0`:
  `Reassign Technician` / `Select a different technician for this job.` vs
  `Assign Technician` / `Select a technician and optionally set schedule.`
- Fields: `Crew *` -> `MultiAssigneeSelect` (placeholder `Add member...`, `enabled={open}`);
  an `All Day` checkbox (`id="all-day-toggle"`); then EITHER a single `Date`
  `<Input type="date">` (all-day mode) or `Scheduled Start` + `Scheduled End`
  `<Input type="datetime-local">`.
- Ticking `All Day` while a start exists snaps start to local midnight and end to +24 h.
  Picking an all-day date does the same.
- All state is RESET on open, seeding crew from `defaultTechId ? [defaultTechId] :
  (currentAssigneeIds ?? [])` and start/end from the optional `defaultStart`/`defaultEnd`
  ISO props (used by the Schedule page's calendar drop; the Job page passes none).
  `currentAssigneeIds` is intentionally omitted from the effect deps so it seeds only on open.
- Submit posts `{assignee_ids, scheduled_start?, scheduled_end?, is_all_day}` with the
  datetime-local strings converted through `new Date(v).toISOString()`.
- HTTP 409 -> a yellow conflict panel `Scheduling Conflict` with the server message and two
  buttons: `Cancel` (clears the conflict) and `Schedule Anyway` (a second POST with
  `force: true`, WITHOUT `is_all_day`). While a conflict is showing, the main Assign button
  is disabled.
- Main button: disabled when `techIds.length === 0 || isPending || Boolean(conflictMessage)`;
  label `Assigning...` with a spinner, else `Reassign` / `Assign`.

`EditJobLocationDialog` detail:
- Two modes, `pick` (default, reset on every open) and `new`.
- `pick`: fetches `GET /api/customers/:customerId` for `service_locations`. Loading = a
  centered spinner. Zero locations -> `This customer has no saved locations. Add a new
  address below.` Otherwise a list of `<button>` rows, each with a `MapPin`, the formatted
  address, a `Current` marker on the job's existing location, and a check glyph when
  selected. Below: an `Add new address` link switching to `new` mode.
- `new`: an RHF form with its own zod schema (`addressSchema` in the same file):
  `address_line1` min 1 max 200 (`AddressAutocomplete id="address_line1"`),
  `address_line2` max 200 optional, `city` min 1 max 100, `state` min 2 max 2
  (`maxLength={2}`), `zip` min 5 max 10. Plus a `Pick an existing address instead` link back.
- Submit: `PATCH /api/jobs/:id` with `{address: form.getValues()}` in `new` mode or
  `{service_location_id: selectedLocationId}` in `pick` mode.
  `canSubmit` in pick mode requires a selection DIFFERENT from the current location.
- If the response carries `tax_warning`, the dialog STAYS OPEN, hides both mode bodies, and
  shows an amber panel `Service location moved [from {old_state}] to {new_state}. Tax rate
  may differ [EMDASH] review the invoice.` with a single `Done` button. Otherwise it closes.

`CreateJobInvoiceDialog` detail (`data-testid="create-job-invoice-dialog"`):
- Title `Create Invoice for {jobNumber}`; description explains there is no estimate and that
  tax comes from the job's service location.
- Body: the SHARED `components/shared/LineItemsEditor` (a different component from
  `components/jobs/items/LineItemsEditor`), seeded with one `blankLineItem()`.
- Validation before submit: a row with a price but no name -> `Required`; a kept row with a
  name but `quantity <= 0` -> `Quantity must be greater than 0`; no named row at all ->
  `Add at least one line item` on row 0. The first non-empty error is also echoed above the
  editor.
- Payload mapping: drop rows with neither name nor price; `description = detail ?
  '{name}\n{detail}' : name`; coerce `quantity`/`unit_price` to numbers; include
  `price_book_item_id` only when truthy.
- Submit button `data-testid="create-job-invoice-submit"`, `variant="business"`, label
  `Creating...` with spinner while pending.
- Closing resets the editor.

### 5.12 States

- Loading (`isLoading` on the `['job', id]` query only): a bespoke skeleton tree -
  a 4-part breadcrumb skeleton row; a `Card` with a 7-high title bar, a status pill, a
  subtitle bar, two action-button blocks, and a 4-column grid of `h-[104px]` cards; then a
  second `Card` with four fake tab labels (`Overview`, `Items`, `Estimates`, `Attachments` -
  note this hard-coded list does not match the real 9 tabs) and four full-width bars.
- Not found / error: `<div class="text-text-secondary py-12 text-center">Job not found</div>`.
  This one string covers 404, 403 and network failure alike; the `IconRail`, breadcrumb and
  header are NOT rendered in this branch.
- The four secondary queries have NO loading or error surfaces on the page; their consumers
  handle `undefined` by rendering their own empty states (`No notes yet`, `No photos yet`,
  `No documents yet`, `No invoice yet`, `No payments recorded`, `No line items yet.`,
  `No staging entries yet`, `All caught up [EMDASH] no action items.`).
- Empty vs no-match: not applicable on this page (single-entity view).

### 5.13 AI surfaces (must be preserved, they are rule-based not model-backed)

`AiInsightsCard` renders `deriveJobInsights(job, attachments, financials)`
(`lib/jobs/insights.ts`), a pure function. Rules, in output order:
1. `missing_photos` (severity warning) when `status in {ON_SITE, IN_PROGRESS, COMPLETED}`
   and no attachment has `context === 'AFTER_PHOTO'`
2. `estimate_approved` when `job.estimate?.status === 'WON'`
3. `crew_assigned` when `assignees.length >= 2`
4. `documents_on_file` when there is at least one non-image attachment
5. `photos_uploaded` when there is at least one image AND rule 1 did not fire
6. `upsell_opportunity` when `job.job_type` is set

Card chrome: `SectionCard tone="ai"` with a `Sparkles` badge, title `AI Operations Insights`
plus a `BETA` pill, and a collapse chevron (`aria-label` toggles between `Expand insights` /
`Collapse insights`, `aria-expanded={!collapsed}`) shown only when there is at least one
insight. Zero insights -> `All caught up [EMDASH] no action items.`

`AiJobAssistantBar` is a launch pad only - no job data is sent anywhere. It builds five
tiles from `buildJobAgentTiles(ctx)` (agent ids `carlos`, `hannah`, `mike`, `emily`, `iris`
looked up in `lib/ai-center/agents`), each with a job-contextual prompt string; the
`carlos` prompt branches on `status === 'COMPLETED'` and the `emily` prompt branches on
whether `job_type` is set. Clicking a tile calls `useAiCenterStore().openModal(agent.id)`.
There is also a disabled "ask bar" with a `Lock` icon and a `Soon` pill.

`TeamCard` and `AssignTeamPopover` both build avatars from
`https://i.pravatar.cc/96?u={seed}` - an EXTERNAL image host seeded by user id. Worth
flagging for the rebuild since it is a third-party network call in a permissioned page.

---

## 6. Consolidated permission matrix

| Affordance | Gate expression | Kind |
|---|---|---|
| `/jobs/new` route | `ability.can('create','Job')` | class CASL (per-user grantable) |
| Jobs list `New Job` button | `ability.can('create','Job')` | class CASL |
| Jobs list `Export` dropdown | `user.role !== 'SALES'` | raw role |
| Detail `New Task` | (none) | always |
| Detail `Create Invoice` | `can('create','Invoice') && status !== 'CANCELLED' && !source_plan_id` | class CASL (per-user grantable) + status + integrity |
| Detail `Assign` popover | `canOnJob(ability,'assign',job,userId)` | instance-aware |
| Detail `Schedule Job` / `Reschedule` | `canOnJob(...,'assign',...)` | instance-aware (NOT `reschedule`) |
| Detail `Mark Complete` | `canOnJob(...,'complete',...) && status !== 'COMPLETED'` | instance-aware + self-exclusion |
| Overflow menu container | `canDuplicate \|\| canReopen \|\| canCancel \|\| canDelete` | derived |
| `Duplicate Job` | `ability.can('create','Job')` | class CASL |
| `Reopen Job` | `ability.can('reopen','Job') && status === 'COMPLETED'` | class CASL + status |
| `Cancel` | `canOnJob(...,'cancel',...) && status !== 'CANCELLED'` | instance-aware |
| `Delete` | `canOnJob(...,'delete',...) && invoices.length === 0` | instance-aware + integrity |
| Address pencil / `No service address` | `user.role === 'ADMIN' \|\| 'DISPATCHER'` | raw role |
| Lifecycle `Scheduled` node | `canAssign` and `!stage.current` | instance-aware |
| Lifecycle `On Site` node | `canOnJob(...,'arrive',...)` and `!stage.current` | instance-aware |
| Lifecycle `Start` button | `canOnJob(...,'start',...) && !completed_at && status !== 'IN_PROGRESS'` | instance-aware |
| Lifecycle `Completed` node | `canComplete` and `!stage.current` | instance-aware |
| Logistics tab trigger | `ability.can('read','Inventory')` | class CASL |
| Estimates tab trigger | `ability.can('read','Estimate')` | class CASL |
| Communication tab trigger AND content | `ability.can('read','Communication')` | class CASL |
| Payments tab trigger | `ability.can('read','Invoice')` | class CASL |
| CustomerContactCard comms history + query | `ability.can('read','Communication')` | class CASL |
| TeamCard dispatcher `Assign`/`Change` + dialog | `ability.can('assign','Job')` | class CASL |
| TeamCard technician `Assign` / `+ Add technician` | `actions.canAssign` passed as `onAssign` | instance-aware |
| Items `+` add button and per-row trash | `ability.can('manage_lines','Invoice')` (trash also needs `hasInvoice`) | class CASL |
| Items inline row fields + totals footer edits | `ability.can('update','Invoice') && hasInvoice` | class CASL |
| AddLineDialog `Also save to price book` | `canEdit` (i.e. `update Invoice`) | class CASL |
| Payments `Record Payment` / `Collect deposit` | financial state only, NO ability check | none |
| Notes composers (tab + preview) | none | always |
| Attachments upload / drop zone | none | always |
| TagInput add/remove | none | always |
| Statement page and PDF | none client-side | none |

---

## 7. Selector surface

### 7.1 `data-testid` actually present in the source

| testid | File | Notes |
|---|---|---|
| `task-at-risk-strip` | `JobDetailPage.tsx:1008` | conditional on overdue/at-risk > 0 |
| `task-chip-open` | `JobDetailPage.tsx:1154` | |
| `task-chip-overdue` | `JobDetailPage.tsx:1162` | |
| `task-chip-next-due` | `JobDetailPage.tsx:1176` | |
| `statement-page` | `StatementPage.tsx:134` | root of the success state only |
| `statement-running-balance` | `StatementPage.tsx:234` | the Balance cell |
| `create-job-invoice-dialog` | `CreateJobInvoiceDialog.tsx:112` | `DialogContent` |
| `create-job-invoice-submit` | `CreateJobInvoiceDialog.tsx:140` | |
| `line-item-row` | `items/LineItemRow.tsx:91` | one per line row |

`JobsPage.tsx` and `JobFormPage.tsx` contain ZERO `data-testid` attributes.

Correction to note: `create-task-modal` is NOT a real testid. It exists only inside vitest
MOCKS of `CreateTaskModal` (`job-task-signals.test.tsx:42`, `entity-tasks-tab.test.tsx:48`).
Do not add it to production code on the strength of a test reference.

Also present via `DataTable`: `data-col-id="{columnId}"` on every `<th>` and `<td>`
(used by the column auto-fit double-click handler). Not a testid, but load-bearing.

### 7.2 Playwright specs that RENDER these pages

Only 7 files drive these routes in a browser. Everything else under
`frontend/e2e/specs/workflow/` is API-tier (`ApiClient`/`request` against `/api/jobs`)
with no `page.goto` and no locators.

| Spec | Routes | Selectors it depends on |
|---|---|---|
| `e2e/specs/redesign/00-render-safety.spec.ts` | `/jobs`; also `/customers/:id/statement` | `page.locator('main')`, `page.locator('main > *')` count > 0, `getByTestId('error-boundary-fallback')` count 0; statement test uses `getByTestId('statement-page')` + `getByTestId('statement-running-balance')` |
| `e2e/specs/redesign/01-journey.spec.ts` | `/jobs/:id` (J-01), `/jobs` (J-05) | `main` / `main > *` / error-boundary; then `getByRole('button',{name:/new job/i})`, `getByRole('dialog')`, `dialog.getByText('Create Job')`, `dialog.getByText(/urgent/i)` asserted 0, `dialog.getByPlaceholder(/name, email, phone/i)` |
| `e2e/specs/redesign/08-standalone-invoice.spec.ts` | `/jobs/:id` x3 | `getByText(jobNumber).first()`, `getByRole('button',{name:'Create Invoice'})` (EXACT), `getByTestId('create-job-invoice-dialog')`, `getByTestId('create-job-invoice-submit')`, `dialog.getByText('Create Invoice for {jobNumber}')`, `dialog.getByText('Add at least one line item')`, `dialog.getByPlaceholder('Item name').first()`, `dialog.getByPlaceholder('0.00').first()`, `getByText('Cancelled',{exact:true}).first()` |
| `e2e/specs/wt-job-detail.spec.ts` | `/jobs/:id` | via the POM below, plus `getByText(jobNumber).first()`, `overviewTab` `data-state="active"`, `[class*="fixed"][class*="right"]` |
| `e2e/pages/job-detail-v2.page.ts` (POM) | `/jobs/:id` | `getByRole('tab',{name:'Overview'})`, `getByRole('tab',{name:/Walkthrough/})`, `getByRole('tab',{name:/Work Items/})`, `getByRole('tab',{name:/Estimates/})`, `page.locator('[class*="fixed"][class*="right-0"][class*="w-10"]')`, `getByText(/View Walkthrough/i)` |
| `e2e/specs/schedule-assign.spec.ts` | `/jobs/:id` (one test) | `getByRole('button',{name:/Reassign/i})`, `getByRole('dialog')`, `dialog.locator('input[type="datetime-local"]').nth(1)`, `dialog.getByRole('button',{name:/Reassign\|Assign/i})` |
| `e2e/specs/visual-screenshots.spec.ts` | `/jobs`, then first row click | `page.locator('table tbody tr')` (count + `.first().click()`); screenshot-only, no assertions |

**Two of these specs are already stale against the current code** and are recorded here as
findings, not as requirements:
- `wt-job-detail.spec.ts` + `job-detail-v2.page.ts` expect tabs named `Walkthrough` and
  `Work Items`. The current tab set is Overview / Items / Logistics / Estimates /
  Attachments / Communication / Tasks / Notes / Payments. Those locators cannot match today.
- `01-journey.spec.ts` header comments assert "There is NO /jobs/new route - the new-job
  form is the NewJobDialog", and J-05 expects the list `New Job` button to open a
  `role="dialog"` titled `Create Job` with a `name, email, phone` placeholder. The current
  `JobsPage` navigates to `/jobs/new` and `App.tsx:128` does register that route. Either the
  spec is stale or it runs against a different deployment. **Do not "fix" the v2 page to
  match the spec without confirming with the owner** (see section 12).

`/jobs/new` has ZERO e2e and ZERO vitest coverage. `/jobs/:jobId/statement` has zero e2e
coverage (only a vitest test).

### 7.3 Vitest / RTL suites that render these pages

| File | Page | Key selectors |
|---|---|---|
| `src/__tests__/jobs-page.test.tsx` | JobsPage | `getByText('Jobs')`; KPI labels `Unscheduled`, `In Progress`, `Completed`, `Cancelled`, `Need Invoices`; `getByPlaceholderText('Search jobs...')`; `getByRole('button',{name:/^filter$/i})`, `{name:/^done$/i}`; `getByRole('checkbox',{name:'Scheduled'})`, `{name:'Needs Invoice'}`; `getByRole('tab',{name:/^scheduled$/i})`, `{name:/^needs invoice$/i}`; `getByRole('combobox')` + `findByRole('option',{name:'Today'})`; KPI tile buttons `/unscheduled/i`, `/^completed/i`, `/need invoices/i`; `getByTestId('location-probe')` (test harness); `queryByPlaceholderText(/search customer/i)` asserted ABSENT |
| `src/__tests__/list-status-defaults.test.tsx` | JobsPage (deps mocked) | no DOM selectors; asserts mount issues `/api/jobs` with no `status` param |
| `src/__tests__/to-be-invoiced.test.tsx` | JobsPage | `getByText('To Be Invoiced')` + `.closest('button')`, `getByText('4')`; mounts at `/jobs?needs_invoice=true` |
| `src/__tests__/job-command-center.test.tsx` | JobDetailPage | `findByRole('heading',{name:/J00001/})`; `findAllByRole('tab')` compared to the exact 9-item ordered list; `getByRole('button',{name:/^activity$/i})`; `getAllByText('In Progress')`, `getByText('HVAC Installation')`, `'Schedule'`, `'Service'`, `'Balance'`; `queryByText('View Statement')` null; `queryByRole('button',{name:/start job/i})` null; `getByRole('button',{name:/mark complete/i})`, `{name:/more actions/i}`, `findByText(/duplicate job/i)`, `queryByText(/unschedule/i)` null; Team card found via `(await findByText('Team')).closest('.rounded-card')` then `getByLabelText('Call Lena Ortiz')` etc.; `findByRole('button',{name:/view all/i})` then Communication tab `data-state="active"` |
| `src/__tests__/job-detail-page.test.tsx` | JobDetailPage | `getByRole('button',{name:/Schedule Job/})`, `{name:/Reschedule/}`; `findByRole('button',{name:/Create Invoice/})`; `getByTestId('create-job-invoice-dialog')`; `findByRole('tab',{name:/Tasks/})` |
| `src/__tests__/job-payments-tab.test.tsx` | JobDetailPage | `findByRole('tab',{name:'Payments'})`, `within(getByRole('tabpanel'))`, `findByText('$500.00')`, `findByRole('link',{name:/record payment/i})`, `findByText(/no invoice yet/i)` |
| `src/__tests__/job-task-signals.test.tsx` | JobDetailPage | `getByTestId('task-chip-overdue')`, `task-chip-next-due`, `task-at-risk-strip`, mocked `create-task-modal`; `getByRole('tab',{name:/Tasks/i})` count badge; `getByRole('button',{name:/New Task/i})` |
| `src/__tests__/job-attachments-dropzone.test.tsx` | `AttachmentsTabBody` named export | `getByText(/no attachments yet/i)` + the hidden file input |
| `src/__tests__/statement-page.test.tsx` | StatementPage | `getByText('Job Statement')`, `'Invoice'`, `'Payment'`, `getAllByText('$300.00')`, `'Balance'`, `'Billed'`, `'Paid'`, `'Refunded'`, `'Download PDF'`, `getAllByText('Deposit credit')` filtered by `className.includes('uppercase')` |

### 7.4 Strings that are effectively part of the contract

Exact role/text selectors used by the suites above; changing any of these breaks a test:

`Jobs`, `New Job`, `Search jobs...`, `Filter`, `Done`, `Unscheduled`, `Scheduled`,
`In Progress`, `Completed`, `Cancelled`, `Need Invoices`, `Needs Invoice`,
`To Be Invoiced` (see the note below), `Create Invoice`, `Create Invoice for {jobNumber}`,
`Add at least one line item`, `Item name`, `0.00`, `Schedule Job`, `Reschedule`, `Reassign`,
`Assign`, `Mark Complete`, `More actions` (aria-label), `Duplicate Job`, `New Task`,
`View All`, `Record Payment`, `Team`, `Schedule`, `Service`, `Balance`,
`Customer & Contact`, `AI Operations Insights`, `Activity` (rail button title),
`Call {name}` / `Text {name}` (aria-labels), `Job Statement`, `Customer Statement`,
`Download PDF`, `Deposit credit`, `Billed`, `Paid`, `Refunded`, and the nine tab names
`Overview | Items | Logistics | Estimates | Attachments | Communication | Tasks | Notes | Payments`.

Naming drift found: `jobs-page.test.tsx` expects the sixth KPI label to be `Need Invoices`
(which is what `JobsPage.tsx:419` renders) while `to-be-invoiced.test.tsx` expects
`To Be Invoiced`. Both pass because they mock different things. Only `Need Invoices` is live
in this page; `To Be Invoiced` is the Invoices-page tile.

Fragile structural selectors the tests rely on (avoid changing these shapes):
`main > *`, `table tbody tr`, `.rounded-card` (the Team card lookup walks to it),
`[class*="fixed"][class*="right-0"][class*="w-10"]` (the IconRail),
`input[type="datetime-local"]` (AssignJobDialog), and a Status-label lookup that filters on
`classList.contains('uppercase')`.

---

## 8. Local UI state summary

### JobsPage
| State | Default | Persistence |
|---|---|---|
| `page` | 1 | none |
| `pageSize` | 25 | none |
| `search` | `''` | none (300 ms debounce lives inside DataTable) |
| `sorting` | `[]` | none |
| facet `value` | decoded from URL | URL search params, `replace: true` |
| column widths / visibility / manuallySized | from saved view | SERVER via `useTableView('jobs')` |
| `FilterBar.open`, `FilterBar.selectedKey` | closed, `registry[0].key` | none |
| `CheckboxFacet.search` | `''` | none |

### JobFormPage
`showDropdown`, `activeSearchField`, `selectedCustomerId`, `selectedCustomer`,
`showSchedule` (false), `dupExisting`, `pendingData`, `dupMatched`, `openingExisting`,
plus the whole RHF form state. Nothing is persisted or URL-synced. `?customer_id` is read
ONCE on render (not reactive to later URL changes).

### JobDetailPage
`activeTab` ('overview'), `assignOpen`, `cancelOpen`, `editLocationOpen`,
`createInvoiceOpen`, `newTaskOpen`, `prevFingerprintRef`. Child-owned:
`IconRail.activePanel`, `AiInsightsCard.collapsed`, `JobNotesPreview.composerOpen`,
`NotesTabBody.noteContent`, `AttachmentsTabBody.{uploading,isDragging}`,
`LineItemsEditor.addOpen`, per-row draft values in `LineItemRow`, `TotalsFooter` input
mirrors, `TagInput.{open,search,sortAsc}`, `AssignTeamPopover.{open,search,selected,notifyOn}`.
The active tab is NOT reflected in the URL - a deep link cannot open a specific tab, and a
reload always returns to Overview.

### StatementPage
No local state at all beyond the query. Scope is derived from route params.

---

## 9. Cross-page navigation graph

```
/jobs  --row click-->            /jobs/:id
/jobs  --New Job-->              /jobs/new
/jobs/new --Cancel/Back-->       navigate(-1)
/jobs/new --create success-->    /jobs/:id  (or /jobs when the user lacks read Job)
/jobs/:id --customer name-->     /customers/:customerId
/jobs/:id --View Estimate-->     /estimates/:id            (+breadcrumb state)
/jobs/:id --Service Plan-->      /service-plans
/jobs/:id --invoice row-->       /invoices/:id             (+breadcrumb state)
/jobs/:id --Create Invoice-->    /invoices/:newId          (+breadcrumb state)
/jobs/:id --Duplicate-->         /jobs/:newId
/jobs/:id --Delete-->            /jobs
/jobs/:id --Payments tab-->      /invoices/:id             (Record Payment / Collect deposit)
/jobs/:id --Logistics-->         /inventory/staging
/jobs/:jobId/statement           reached ONLY via a caller-supplied link; nothing in the
                                 jobs module links to it today (see section 12)
```

---

## 10. What must NOT change in the v2 build

1. Every query key string, exactly. Sibling pages (Schedule, Invoices, Service Plans,
   Customers) invalidate `['jobs']`, `['job', id]`, `['job-timeline', id]`,
   `['schedule-jobs']`, `['schedule-unassigned']` and `servicePlanKeys.bucket`. Renaming a
   key silently breaks other modules.
2. The `listParams` key set on `/api/jobs`, including the `undefined` placeholders and
   `exclude_plan_visits: 'true'`.
3. `canOnJob` usage. Never substitute `ability.can(verb, subject('Job', job))`.
4. The invalidation set of every mutation.
5. The nine tab `value` strings (`overview`, `items`, `logistics`, `estimates`,
   `attachments`, `communication`, `tasks`, `notes`, `payments`) and their gates.
6. All nine `data-testid` attributes in 7.1.
7. `buildCreateJobPayload` - import it, do not re-derive the payload.
8. `computeLifecycle` and `deriveJobInsights` - import them.
9. The duplicate-customer 409 handshake, including the `?override=true` query form and the
   `id="phone"` / `id="email"` inputs that `handleEditField` focuses by DOM id.
10. The distinction between `components/shared/LineItemsEditor` (used by
    `CreateJobInvoiceDialog`) and `components/jobs/items/LineItemsEditor` (used by the Items
    tab). They are DIFFERENT components with the same export name.

---

## 11. Reimplementation risk notes

- `JobDetailPage` mixes page-level and component-level concerns: `AttachmentsTabBody` is a
  named EXPORT from the page file and is imported directly by
  `job-attachments-dropzone.test.tsx`. A v2 page must either keep that export or the test
  must be pointed at the new location (which the plan forbids touching).
- `DataTable` carries a lot of behaviour the kit's DataTable may not: server-persisted saved
  views, weighted flex-fill layout (`computeLayout`), sticky pinned columns with a shadow on
  the last pinned column, virtualization above 40 rows, per-column resize with min-width
  clamping, a right-click header context menu, truncation tooltips, and a distinct mobile
  card layout. Any of these dropped is a behaviour regression, not a style change.
- The KPI tile "active" predicate is deliberately conservative (a tile is only active when
  NOTHING else narrows the list further). Simplifying it will make tiles appear active when
  their count no longer matches the row count.
- The money block and the Payments tab compute from `financials`, not from `job`. The header
  `amount_invoiced` field on the job is read but the derived `remainingUnbilled` is discarded.
- `pravatar.cc` avatars in `TeamCard` and `AssignTeamPopover` are external network requests.

---

## 12. Open questions (genuinely ambiguous - do not guess)

1. **`/jobs/new` vs `NewJobDialog`.** `App.tsx:128` registers `/jobs/new -> JobFormPage`,
   and `JobsPage` navigates there. But `e2e/specs/redesign/01-journey.spec.ts` documents,
   in a header comment and in test J-05, that there is NO `/jobs/new` route and that the
   `New Job` button opens a `NewJobDialog` titled `Create Job`. I could not find a
   `NewJobDialog` component in the repo. Either the spec is stale or it targets a different
   build. **Needs an owner decision before the v2 Jobs list is built**, because the two
   models are mutually exclusive.
2. **Stale `wt-job-detail.spec.ts` / `job-detail-v2.page.ts`.** They target `Walkthrough`
   and `Work Items` tabs that no longer exist. Are these specs expected to be passing today?
   If they are currently failing/skipped, the v2 page inherits no obligation from them.
3. **Empty vs no-match on `/jobs`.** `DataTable` renders `No results found.` for both. Is
   introducing a distinct "no jobs yet" empty state in v2 acceptable, or is that a
   behaviour change that must be avoided?
4. **List error state.** The `['jobs']` query has no `isError` branch, so a failed fetch is
   visually identical to an empty list. Same question: fix in v2, or preserve?
5. **Dead code in `JobDetailPage`.** `canUnassign`, `canAddNotes`, `canEditServiceType`,
   `canViewWorkOrder` and `remainingUnbilled` are computed and never used. Carry them over
   verbatim (safest, matches "no logic drift"), or drop them? My recommendation is to carry
   them and leave the comments, since `void remainingUnbilled` suggests an intentional
   placeholder.
6. **`create Invoice` on someone else's job.** `canCreateInvoice` uses the CLASS-level
   `ability.can('create','Invoice')`, so a technician holding the per-user grant sees the
   button on ANY job they can read, including jobs they are not assigned to, where the API
   will 403. Is this a known accepted gap, or should v2 narrow it to `canOnJob`? Narrowing
   would be a logic change, so I did not assume it.
7. **`record_payment` and `reschedule` grants.** Neither appears in this module's render
   logic (7.x above). Confirm this is intentional - i.e. `record_payment` is enforced only
   on the Invoice detail page and `reschedule` is intentionally folded into `assign` here.
8. **Statement route reachability.** Nothing in the Jobs module links to
   `/jobs/:jobId/statement`, and `job-command-center.test.tsx` explicitly asserts
   `queryByText('View Statement')` is null. Is the route intentionally link-less
   (deep-link / PDF-share only), and should v2 keep it that way?
9. **Loading-skeleton tab labels.** The `JobDetailPage` skeleton hard-codes
   `['Overview','Items','Estimates','Attachments']`, which no longer matches the real tab
   set. Cosmetic; keep as-is or update?
10. **Attachments upload failure semantics.** The upload loop is sequential and `await`ed
    inside a single try/catch, so a failure on file 3 of 5 leaves 1 and 2 uploaded and
    silently skips 4 and 5 with one toast. Preserve, or is partial-failure reporting in
    scope? I preserved it in the map as current behaviour.
11. **`AssignJobDialog` force retry drops `is_all_day`.** The conflict-override POST sends
    `{assignee_ids, scheduled_start, scheduled_end, force:true}` with no `is_all_day`. This
    looks like a bug (an all-day booking forced through loses the flag) but it is current
    behaviour, so I mapped it as-is rather than correcting it.
12. **Two fetches of the same communications payload.** `CustomerContactCard` uses
    `['job-communications-preview', jobId]` and `JobCommunicationsTab` uses
    `['job-communications', jobId]`, both hitting `GET /api/jobs/:id/communications`.
    Deduplicating them would change cache behaviour, so I left it documented, not resolved.
