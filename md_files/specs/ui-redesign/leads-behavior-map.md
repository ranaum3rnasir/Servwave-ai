# Leads module - behaviour map (UI-kit migration, Phase 1)

Status: draft for review - produced 2026-07-29
Module: **Leads** (`refactor/ui-kit-02-leads`)
Routes covered: `/leads`, `/leads/new`, `/leads/:id`, `/leads/:id/edit`
Companion: `md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`

This document is a behaviour contract. It is written so an engineer can rebuild these four
pages with different presentation components and reproduce every behaviour without opening the
originals. Everything below was read from source; anything uncertain is in **Open questions**
at the end rather than guessed.

---

## 0. File inventory (what the build phase must import, never fork)

| Concern | File |
|---|---|
| List page | `frontend/src/pages/LeadsPage.tsx` |
| Create + Edit page (one file, two inner components) | `frontend/src/pages/LeadFormPage.tsx` |
| Detail page | `frontend/src/pages/LeadDetailPage.tsx` |
| Routes | `frontend/src/App.tsx` (lines 119-122) |
| Route guard | `frontend/src/components/ProtectedRoute.tsx` |
| Nav entry | `frontend/src/components/layout/nav-registry.ts` (`key: 'leads'`) |
| Ability | `frontend/src/lib/ability.ts`, `frontend/src/contexts/AbilityContext.tsx` |
| Lead API helpers | `frontend/src/lib/api/leads.ts` |
| Filter registry | `frontend/src/lib/filters/registries/leads.ts` |
| Filter plumbing | `frontend/src/lib/filters/useFilterState.ts`, `urlCodec.ts`, `types.ts` |
| Filter UI | `frontend/src/components/filters/FilterBar.tsx`, `AppliedChips.tsx` |
| Table | `frontend/src/components/ui/data-table.tsx` |
| KPI strip | `frontend/src/components/ui/KpiStrip.tsx` |
| Status badge | `frontend/src/components/ui/status-badge.tsx` |
| Phone/email cell | `frontend/src/components/ui/ContactCell.tsx` |
| Lead dialogs/popovers | `frontend/src/components/leads/` (8 files) |
| Customer picker | `frontend/src/components/shared/PickOrCreateCustomer.tsx` |
| Location picker | `frontend/src/components/shared/PickOrAccreteLocation.tsx` |
| Duplicate guard dialog | `frontend/src/components/customers/DuplicateCustomerDialog.tsx` |
| Address autocomplete | `frontend/src/components/ui/address-autocomplete.tsx` |
| Right rail + panels | `frontend/src/components/shared/IconRail.tsx`, `ActivityPanel.tsx`, `AttachmentsPanel.tsx` |
| Attachments (in-tab) | `frontend/src/components/shared/AttachmentSection.tsx` |
| Assign popover | `frontend/src/components/leads/AssignLeadPopover.tsx` -> `frontend/src/components/common/AssignTeamPopover.tsx` |
| Multi-performer picker | `frontend/src/components/common/MultiAssigneeSelect.tsx` |
| Time picker | `frontend/src/components/common/TimeSelect.tsx` |
| Tasks tab | `frontend/src/components/tasks/JobLeadTasksTab.tsx` |
| Saved column view | `frontend/src/hooks/useTableView.ts` |

---

## 1. Routes and guards

### 1.1 Route table

All four routes live inside ONE guard block in `frontend/src/App.tsx`:

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
  <Route element={<AppLayout />}>
    ...
    <Route path="/leads"          element={<LeadsPage />} />        // line 119
    <Route path="/leads/new"      element={<LeadFormPage />} />     // line 120
    <Route path="/leads/:id/edit" element={<LeadFormPage />} />     // line 121
    <Route path="/leads/:id"      element={<LeadDetailPage />} />   // line 122
```

Note the ORDER: `/leads/:id/edit` is declared BEFORE `/leads/:id`. All four page components
are `React.lazy` imports wrapped in a `<Suspense fallback={<PageLoader />}>`; `PageLoader`
renders a centered `Loading...` text block (`App.tsx` lines 85-90). Routes are wrapped by
`Sentry.withSentryReactRouterV7Routing(Routes)` so transactions are named by pattern.

### 1.2 ProtectedRoute semantics (`frontend/src/components/ProtectedRoute.tsx`)

- `isLoading` -> full-screen centered `Loading...`.
- `!isAuthenticated` -> `<Navigate to="/login" replace />`.
- Authenticated but role not in `allowedRoles` -> `<Navigate to="/" replace />` (the `fallback`
  prop that would render `NotAuthorizedPage` is NOT passed for the leads block).
- Since all four app roles are allowed, **no role is bounced off any leads route.** Access is
  shaped entirely by CASL ability and by what the API returns.

### 1.3 Feature / entitlement gates

**None.** `backend/src/routes/lead.routes.ts` contains no `requireFeature` call, and the leads
nav entry in `nav-registry.ts` has no feature key. Leads is not plan-gated. (Contrast with the
Communication module's `phone` master switch.)

### 1.4 Nav visibility

`frontend/src/components/layout/nav-registry.ts`:
```
{ key: 'leads', label: 'Leads', icon: Filter, href: '/leads', action: 'read', subject: 'Lead', home: 'Page' }
```
The sidebar row renders only when `ability.can('read', 'Lead')`. `/leads` is also the hard
fallback landing in `frontend/src/components/layout/HomeRoute.tsx`
(`const FALLBACK_HREF = '/leads'`) when no nav destination is permitted - so a permission-less
user still lands on `/leads`. Quick-create menu carries
`{ label: 'New Lead', href: '/leads/new', action: 'create', subject: 'Lead' }`
(`nav-config.ts`), gated the same way.

### 1.5 The "Sales owns own leads only" rule - where it actually lives

**It is not implemented in the frontend at all.** There is no client-side owner filter, no
`canOnLead` helper, and no `mine=true` list param anywhere in `LeadsPage.tsx`.

- `frontend/src/lib/ability.ts` exports `canOnJob(...)` for row-scoped JOB checks and explains
  why an instance-level `ability.can(verb, subject('Job', job))` returns false for conditional
  rules (the backend ships `@casl/prisma` rules whose `some` operator the Mongo matcher cannot
  evaluate). **There is no Lead equivalent.** Every lead check in the pages is a bare
  class-level `ability.can(action, 'Lead')`.
- `LeadFormPage.tsx` line 360 documents this explicitly: after create it uses a
  "Class-level read check (no instance) - avoids fail-closed on the row-scoped OWN_LEAD
  condition so a SALES owner still lands on their new lead".

So: **ownership scoping is enforced server-side only.** `GET /api/leads` returns the scoped
set; the frontend renders whatever comes back. A rebuild must NOT add client-side owner
filtering - that would be a logic change.

See §11 for the server-side condition as confirmed against the backend.

---

## 2. `/leads` - LeadsPage

### 2.1 Component tree

```
<div class="space-y-6">
├─ Page heading row
│  ├─ <h1> [<Filter> icon] "Leads"
│  └─ count pill  -- renders only when data?.pagination?.total !== undefined
├─ <KpiStrip loading={isLoading} items={[5 tiles]} />
└─ <DataTable
     tableKey="leads"
     columns={columns}                 // 13 columns, module-level const
     data={data?.leads ?? []}
     pagination={data?.pagination}
     isLoading={isLoading}
     searchValue / onSearchChange
     searchPlaceholder="Search leads..."
     sorting / onSortingChange
     onRowClick -> navigate(`/leads/${lead.id}`)
     filters={<FilterBar .../>}         // slot: left of the toolbar, after search
     activeFilters={<AppliedChips .../>}// slot: below the toolbar
     headerActions={
       <Export DropdownMenu/>
       + <Button variant="business">New Lead</Button>   // only if can('create','Lead')
     }
   />
```

`DataTable` itself renders (in order): toolbar (search input + `filters` slot | `Columns`
popover + `headerActions` slot), the `activeFilters` slot, then EITHER the desktop table OR
the mobile card list (never both - `useIsMobile()` picks one; breakpoint `max-width: 767.98px`),
then pagination.

### 2.2 Column definitions (`columns`, LeadsPage.tsx lines 86-291)

| # | `id` | header | size | sortable | meta | cell |
|---|------|--------|------|----------|------|------|
| 1 | `schedule_action` | `''` | 32 | no | `pinned, fixed, minWidth:32`, `enableHiding:false`, `enableResizing:false` | `<CalendarPlus>` link if status in allow-list, else a `w-4` spacer span |
| 2 | `lead_number` | `Lead #` | 90 | **yes** | `pinned, fixed, minWidth:80` | mono xs text |
| 3 | `customer` | `Customer` | 170 | no | `locked, pinned, growWeight:1.5, minWidth:140`, `enableHiding:false` | `<Link to=/customers/:id>` (stopPropagation) + customer_number line |
| 4 | `phone` | `Phone` | 140 | no | `fixed, minWidth:80` | `<ContactCell type="phone">` |
| 5 | `source` | `Source` | 120 | no | `fixed, minWidth:80` | `<Badge variant="outline">` of `customer.ad_source`, else em-dash |
| 6 | `service_request` | `Service Request` | 200 | no | `growWeight:2, minWidth:100` | truncated span with `title` |
| 7 | `location` | `Location` | 140 | no | `growWeight:1.5, minWidth:80` | `city, state` |
| 8 | `type` | `Type` | 100 | no | `fixed` | Badge of `job_type` |
| 9 | `status` | `Status` | 110 | **yes** | `fixed` | `<StatusBadge>` |
| 10 | `estimates` | `Est.` | 64 | no | `fixed, minWidth:50` | count, dimmed at 0 |
| 11 | `assignee` | `Assignee` | 120 | no | `fixed` | `commission_owner` full name or `Unassigned` |
| 12 | `walkthrough` | `Walkthrough` | 120 | no | `fixed` | `getWalkthroughDisplay()` output |
| 13 | `created` | `Created` | 110 | **yes** | `fixed, minWidth:90` | `formatExactDate(created_at)` |

Only 3 columns are sortable (`lead_number`, `status`, `created`) because `enableSorting: false` is
set on the rest. Sorting is server-side (`manualSorting` defaults to `true` in DataTable) and the
column `id` is sent verbatim as `sortBy`. **The backend's `sortBy` allow-list is
`['created_at','status']`**, so `sortBy=lead_number` and `sortBy=created` both silently fall back
to `created_at` (see §11.2). Reproduce the current behaviour; do not "fix" the column ids here.

`getWalkthroughDisplay(lead)` precedence (lines 79-84):
1. `walkthrough_completed_at` set -> `"✓ Done"`, emerald.
2. `walkthrough_scheduled_at` set -> `new Date(...).toLocaleDateString()`, primary color.
3. `status === 'NEW'` OR `walkthrough_needed === false` -> em-dash, muted.
4. otherwise -> `"Needs Sched."`, amber.

`WALKTHROUGH_SCHEDULABLE_STATUSES = ['CONTACTED','WALKTHROUGH_COMPLETED','WALKTHROUGH_SCHEDULED']`
(line 77) - the comment states this mirrors the backend `scheduleWalkthrough` gate exactly.
The `schedule_action` cell renders the calendar link only for those three statuses.

`location` cell falls back from `lead.service_city/service_state` to
`customer.service_locations[0].city/state`; if both are empty it renders an em-dash.

### 2.3 Every interactive element on `/leads`

| Element | Action | Opens / target |
|---|---|---|
| KPI tile "Total Leads" | `handleKpiClick('total')` | no overlay - resets filters (`setValue({})`) or, if already active, `clearAllFilters()` |
| KPI "New This Week" | `applyKpi('new_this_week')` | sets `created` dateRange `{from: startOfWeekDay(), to: ''}` |
| KPI "Unassigned" | `applyKpi('unassigned')` | sets `assigned_to` multi `['UNASSIGNED']` |
| KPI "Won" | `applyKpi('won')` | sets `status` multi `['WON']` |
| KPI "Lost" | `applyKpi('lost')` | sets `status` multi `['LOST']` |
| Search input (inside DataTable toolbar) | debounced 300 ms -> `handleSearchChange` -> `setSearch` + `setPage(1)` | none |
| `Filter` button | opens `<FilterBar>` popover | Radix Popover, 640px, two-pane (rail + control) |
| Applied chip `x` | removes that one value/facet | none |
| `Columns` button | column-visibility popover | Radix Popover with checkbox list, `Save current view`, `Reset to default columns`, `Reset column widths` |
| Header right-click | `HeaderContextMenu` | fixed-position menu: `Reset this column width`, `Reset all widths` |
| Header click (sortable cols only) | toggles sorting; `onSortingChange` also does `setPage(1)` | none |
| Header resize handle drag | column resize (`columnResizeMode: 'onChange'`), clamped to `meta.minWidth` on mouseup | none |
| Header resize handle double-click | auto-fit to widest visible cell, capped at 600px | none |
| `Export` button | dropdown | `DropdownMenu` with label `Export as CSV`, separator, two items |
| Export -> `Current page (N rows)` | `handleExportCurrentPage` | downloads CSV client-side; toast on empty/failure |
| Export -> `All (N)` | `handleExportAll` | `GET /api/leads/export` then CSV download; toast on empty/failure |
| `New Lead` button | `navigate('/leads/new')` | route change. **Rendered only when `ability.can('create','Lead')`** |
| Row click (desktop + mobile card) | `navigate('/leads/:id')` | route change. Suppressed while `wasResizing.current` is true |
| Cell: customer link | `Link to /customers/:id`, `e.stopPropagation()` so the row click does not fire | route change |
| Cell: `schedule_action` calendar icon | `Link to /leads/:id?tab=walkthrough`, `stopPropagation`, `title`/`aria-label` = `Schedule walkthrough` | detail page with Walkthrough tab preselected |
| Cell: phone (`ContactCell`) | anchor `tel:` (stopPropagation) + hover copy button (`aria-label="Copy phone number"`, shows `Copied!` for 2 s) | none |
| Pagination `Previous` / `Next` | `onPageChange(page±1)` | none |
| Page-size `SelectField` (25/50/100) | `setPageSize(size); setPage(1)` | Radix Select |

No keyboard shortcuts and no drag-and-drop on this page beyond column resizing.

### 2.4 API interactions

**List query** (`LeadsPage.tsx` lines 379-388):
```
useQuery({
  queryKey: ['leads', { page, pageSize, search, sortBy, sortDir, value }],
  queryFn: () => api.get('/api/leads', { params: { page, limit: pageSize, ...listParams } }),
  placeholderData: keepPreviousData,
})
```
`listParams` (lines 363-377) is deliberately built with EXPLICIT `undefined` placeholders for
every facet param before spreading `filterParams`:
```
search, status, ad_source, job_type, assigned_to, walkthrough_status,
estimates_min, estimates_max, created_after, created_before, sortBy, sortDir, ...filterParams
```
The in-file comment says this preserves the pre-refactor key set for
`list-status-defaults.test.tsx`, which asserts `status` is present (even as `undefined`) on an
unfiltered mount. Axios drops `undefined` params, so the wire request is unchanged.
**A rebuild must keep this exact object shape, not just the effective params.**

`sortDir` is only sent when `sortBy` is set: `sortDir: sortBy ? sortDir : undefined`.

Response shape consumed: `data.leads`, `data.pagination` (`{page, limit, total, totalPages}`),
`data.stats` (`{total, new_this_week, unassigned, won, lost}`).

Server-side defaults that shape what the UI sees: `page` defaults to 1, `limit` to 25 and is
**hard-capped at 100** (so the 100 page-size option is the ceiling), and there is **no
"open pipeline" default** - an unfiltered list includes WON/LOST/CANCELLED leads. `stats` is
computed over the tenant + row scope only and **ignores the request's filters and search**, so the
KPI numbers do not move when a filter is applied, while the heading count pill
(`pagination.total`) does. That asymmetry is existing behaviour - keep it.

**Export-all** (line 481): `api.get('/api/leads/export', { params: listParams })` -> `ex.leads`.
Note it passes `listParams` WITHOUT `page`/`limit`.

**Org options**: `useOrganization()` -> `useQuery({ queryKey: ['organization'] })` ->
`GET /api/organization`. Used for `org.source_options` and `org.job_type_options`.

**Assignable users**: `useAssignableUsers({ includeReferencedIn: 'leads' })` ->
`queryKey: ['users','assignable', null, null, 'leads']` ->
`GET /api/users?assignable=true&include_referenced_in=leads`, `staleTime: 30_000`,
`placeholderData: keepPreviousData`.

**Saved table view** (via `DataTable tableKey="leads"`): `useTableView('leads')` ->
`queryKey: ['table-views','leads']`, `GET`/`PUT /api/table-views/leads` (see
`frontend/src/lib/api/table-views.ts`), `staleTime: 5 min`, `retry: false`. Saving invalidates
`['table-views','leads']` and toasts `Saved to your account`.

**No mutations and no cache invalidation happen on this page.** No optimistic updates.

### 2.5 Filters, KPIs and URL state

The facet registry is `leadsRegistry` (`frontend/src/lib/filters/registries/leads.ts`), 7 facets:

| key | kind | URL param(s) | options |
|---|---|---|---|
| `status` | multi | `status` (comma-joined) | static `LEAD_STATUSES` (8 values, see §7) |
| `ad_source` | multi | `ad_source` | dynamic `optionSource: 'org.sourceOptions'` |
| `job_type` | multi | `job_type` | dynamic `optionSource: 'org.jobTypeOptions'` |
| `assigned_to` | multi | `assigned_to` | dynamic `optionSource: 'assignableUsers'`, MUST include `{value:'UNASSIGNED'}` |
| `walkthrough_status` | multi | `walkthrough_status` | static 4: `needs_scheduling`, `scheduled`, `completed`, `not_needed` |
| `estimates` | range | `estimates_min` / `estimates_max` | `min: 0`, `maxSource: 'leads.maxEstimates'` -> page returns the constant **20** |
| `created` | dateRange | `created_after` / `created_before` (`YYYY-MM-DD`) | - |

`resolveOptions(sourceId)` (lines 339-347) maps the three dynamic ids; anything else returns
`[]`. `resolveMax` returns 20 only for `'leads.maxEstimates'`, else 0.

`assignedToOptions` = `[{value:'UNASSIGNED', label:'Unassigned'}, ...assignableUsers]`.

**URL sync** (`useFilterState`): filters live in `useSearchParams`, written with
`{ replace: true }` (no back-stack spam). `setValue` deletes only the keys the registry owns
(`param`, `param_min`, `param_max`, `param_after`, `param_before`) and preserves any other
search param. Empty facet values are omitted from the URL entirely - "not in params" means
"no filter".

**Not URL-synced:** `page`, `pageSize`, `search`, `sorting` are plain `useState`, lost on
reload. Only the 7 facets are shareable.

**Every filter change resets page to 1**, via `handleFilterChange` (facet edit, chip removal,
Clear all) and via the search / sort / page-size handlers.

**KPI active-state detection** (lines 406-425). `activeKpi` is derived, not stored. Preconditions
(`noManual`): no `ad_source`, no `job_type`, no `walkthrough_status` values selected, and no
active `search`. Then, in order:
1. `new_this_week` - no status, `created.from === startOfWeekDay()`, no `created.to`, no assignee.
2. `won` - exactly one status `WON`, no assignee, no created bounds.
3. `lost` - exactly one status `LOST`, same.
4. `unassigned` - exactly one assignee `UNASSIGNED`, no status, no created bounds.
5. `total` - nothing set at all.
Otherwise `null`.

Clicking the already-active KPI calls `clearAllFilters()` (`setValue({}); setSearch(''); setPage(1)`)
- i.e. it toggles back to the default view. Clicking a different KPI calls `applyKpi(preset)`,
which first clears `search` and resets page, then REPLACES the whole filter state with the preset
(not merge).

`startOfWeekDay()` (`frontend/src/lib/date-range.ts` line 26) = local Sunday of the current week,
`YYYY-MM-DD`; the comment says it matches the backend `new_this_week` stat. It is memoized once
per mount (`useMemo(..., [])`).

### 2.6 CSV export detail

`toExportRow(lead)` (lines 448-461) produces exactly these headers, in order:
```
Customer, Company, Phone, Source, Service Request, Location, Type, Status,
Estimates, Est. Value, Assigned To, Created
```
- `Customer` = `customerDisplayName(l.customer, '')` (empty-string fallback, not `'Customer'`).
- `Phone` = `formatPhone(...)`.
- `Location` = `[service_city, service_state].filter(Boolean).join(', ')` - note this uses the
  LEAD's fields only, with NO customer-location fallback, unlike the table cell.
- `Est. Value` = sum of `Number(e.total_amount)` over `estimates`.
- `Created` = `new Date(created_at).toLocaleDateString()` - NOT `formatExactDate`.

Filenames: `leads-page{page}-{YYYY-MM-DD}.csv` and `leads-all-{YYYY-MM-DD}.csv`, where the date
is `new Date().toISOString().split('T')[0]`.

Empty result -> `toast({ title: 'Nothing to export', description: 'No leads match the current filters.' })`
(default variant). Thrown error -> `toast({ title: 'Export failed', description: 'Failed to export leads. Please try again.', variant: 'destructive' })`.
`handleExportCurrentPage` wraps in try/catch; `handleExportAll` is `async` and catches the request too.

### 2.7 States

| State | Behaviour |
|---|---|
| Loading | `KpiStrip loading` -> every tile's value becomes a `h-[26px] w-16` pulse block; `DataTable isLoading` -> desktop renders `pagination?.limit ?? 5` skeleton rows with `h-4 w-3/4 animate-pulse` cells, mobile renders 5 skeleton cards. Headers still render. |
| First load, no pagination yet | The heading count pill is hidden (`data?.pagination?.total !== undefined` guard). |
| Empty - nothing exists | Table body renders ONE row: `colSpan={columns.length}`, `h-24 text-center`, text `No results found.` Mobile: a bordered card with the same text. |
| Empty - nothing matches filters | **Identical.** There is no filter-aware empty state; the copy is the same `No results found.` in both cases. Reproduce as-is. |
| Error | **Not handled.** `useQuery` destructures only `{ data, isLoading }`; an error leaves `data` undefined, so the page renders the empty state with zeroed KPIs. No error banner, no retry button. |
| Refetch (page/filter change) | `placeholderData: keepPreviousData` keeps the previous rows on screen; `isLoading` is false during a background refetch, so **no skeleton flash between pages**. |
| Virtualization | `@tanstack/react-virtual` kicks in only when `rows.length > 40` (`estimateSize: 41`, `overscan: 10`). With the default 25 page size it is off; at 50/100 it engages. |
| Pagination bar | Renders only when `pagination && (totalPages > 1 || onPageSizeChange)`. Prev/Next block itself only when `totalPages > 1`. Text: `Showing {start}-{end} of {total}` and `Page {n} of {m}`. |

---

## 3. `/leads/new` - CreateLeadForm

`LeadFormPage` is one file. `isEdit = Boolean(useParams().id)`. When `id` is absent it renders
`<CreateLeadForm>` with:
- `returnTo` = `location.state?.returnTo`
- `preselectedCustomerId` = `new URLSearchParams(location.search).get('customer_id')`

### 3.1 Component tree

```
<div class="space-y-4">
├─ header row: [ghost Button "<- Back" -> navigate(-1)]  <h1>New Lead</h1>
└─ card
   └─ <form onSubmit={handleSubmit(d => mutation.mutate({ data: d }))}>
      ├─ grid lg:grid-cols-2
      │  ├─ LEFT
      │  │  ├─ label "Client Details"
      │  │  ├─ <PickOrCreateCustomer required ... />   // 5 inputs + search dropdowns + dup dialog
      │  │  ├─ divider + label "Service Location"
      │  │  └─ <PickOrAccreteLocation showPicker={Boolean(selectedCustomer)} ... />
      │  └─ RIGHT
      │     ├─ label "Lead Details"
      │     ├─ Textarea "Service Request *" (rows 3)
      │     ├─ Textarea "Notes" (rows 2)
      │     ├─ grid sm:grid-cols-2
      │     │  ├─ Select "Job Type"  (+ inline add-new row when addingJobType !== null)
      │     │  ├─ Select "Source"
      │     │  └─ Select "Assign to" -- only if ability.can('assign','Lead')
      │     ├─ divider "Schedule" + <Switch checked={showSchedule} />
      │     └─ if showSchedule: Start Date(<input type=date>) + Start Time(<TimeSelect>)
      │                        End Date + End Time
      ├─ inline error <p> (suppressed when the error is the duplicate 409)
      └─ actions: [outline "Cancel" -> navigate(-1)] [business "Create Lead" / "Creating..."]
```

### 3.2 `createSchema` (zod) - `LeadFormPage.tsx` lines 42-73

| field | type | rules | default |
|---|---|---|---|
| `first_name` | string | `.min(1, 'First name is required')` | `''` |
| `last_name` | string | optional | `''` |
| `company_name` | string | optional | `''` |
| `phone` | string | optional (see superRefine) | `''` |
| `email` | string | `.email('Invalid email').optional().or(z.literal(''))` | `''` |
| `service_location_id` | string | optional | `''` |
| `service_address_line1` | string | optional | `''` |
| `service_address_line2` | string | optional | `''` |
| `service_city` | string | optional | `''` |
| `service_state` | string | `.max(2)` optional | `''` |
| `service_zip` | string | optional | `''` |
| `service_request` | string | `.min(1, 'Service request is required')` | `''` |
| `notes` | string | optional | `''` |
| `job_type` | string | optional | `''` |
| `ad_source` | string | optional | `''` |
| `assigned_to` | string | optional | `''` |
| `scheduled_date` / `scheduled_time` / `scheduled_end_date` / `scheduled_end_time` | string | optional | `''` |

`superRefine` (lines 65-73):
- neither trimmed `phone` nor trimmed `email` present -> issue on path `['phone']`,
  message `Enter a phone number or an email`.
- else if `phone` present and `phone.length < 7` -> issue on `['phone']`,
  message `Enter a valid phone number`. Note this counts the FORMATTED string length
  (the input is masked to `(555) 123-4567`), not digits.

Resolver: `zodResolver(createSchema)`. Default RHF validation mode (onSubmit).

Error surfaces: `errors.first_name/last_name/phone/email` are forwarded into
`PickOrCreateCustomer`'s `errors` prop (rendered as `text-xs text-danger` under each input);
`errors.service_request` renders inline under the textarea;
`errors.service_address_line1/city/state/zip` are forwarded into `PickOrAccreteLocation`.
`last_name` has no schema rule but its error slot is still wired.

### 3.3 `PickOrCreateCustomer` behaviour (shared control)

Fields rendered, in DOM order: `First Name{*}`, `Last Name`, `Phone` (`id="phone"`),
`Email` (`id="email"`), then a required-hint line `Provide a phone number or an email above.`,
then `Company Name`. All five inputs use `placeholder="Search..."` and `autoComplete="off"`.
Only First Name gets the asterisk when `required`.

- **Typeahead**: typing in ANY of the five fields sets `activeSearchField` and opens the
  dropdown. Query: `useQuery({ queryKey: ['customers-search', activeFieldValue], enabled: value.length >= 2 && showDropdown })`
  -> `GET /api/customers?search=<value>&limit=6`.
- Dropdown is an absolutely-positioned panel under the active field; each row shows
  `First Last (Company)` and `formattedPhone · email`. Empty result -> `No customers found`.
- Outside `mousedown` closes the dropdown (document listener).
- Picking a row -> `onSelectCustomer(c)` -> the page's `selectCustomer` (see below).
- Phone input is masked live through `formatPhoneInput` (caps at 10 digits, renders
  `(555) 123-4567`).
- **First-name blur split** (`handleFirstNameBlur`): on blur only, when no customer is selected,
  the first name contains a space, and Last Name is empty -> `splitFullName` on the LAST space
  and emit both fields.
- **Additional Contacts** read-only block renders when a customer is selected and it has
  `phone_ext`, `secondary_phone`, or `extra_emails`.
- Hosts `<DuplicateCustomerDialog>` (open when `duplicate != null`).

`selectCustomer(c)` in the page (lines 267-294) sets `selectedCustomerId`/`selectedCustomer` and
force-sets `first_name, last_name, company_name, phone (masked), email, ad_source`. It then picks
`c.service_locations.find(is_primary) || [0]`; if found it sets `service_location_id` plus the five
address fields; if the customer has NO locations it BLANKS all six (comment: leave blank, do not
force the add-new sub-form).

Editing any contact field afterwards (`onFieldChange`) clears `selectedCustomerId` and
`selectedCustomer` back to new-customer mode (lines 479-485).

### 3.4 `PickOrAccreteLocation` behaviour

- `showPicker={Boolean(selectedCustomer)}` on create - so with NO customer selected, only the
  raw new-address sub-form shows (`(addingNew || !showPicker)`).
- Picker is a Radix `Select`, placeholder `Select a service location`; options are the
  customer's locations labelled `"{line1, line2} — {city}, {state} {zip}"` plus a final
  `+ Add new location` item whose value is the sentinel `'__add_new__'` (`ADD_NEW_LOCATION`).
- Choosing `__add_new__` clears all five address fields and reveals the sub-form.
- Choosing a real location copies its address into the five fields.
- Sub-form fields (ids prefixed `pal-` by default): `Address` (`AddressAutocomplete`,
  `id="pal-address-line1"`), `Unit` (`pal-address-line2`), `City` (`pal-city`),
  `State` (`pal-state`, `maxLength={2}`), `ZIP` (`pal-zip`). Labels get `*` only when
  `required` - the lead create form does NOT pass `required`, so no asterisks here.
- The page's `onChange` writes `service_location_id` plus the five address fields, with
  `{ shouldValidate: true }` on line1/city/state/zip and not on line2.

`AddressAutocomplete`: Google Places v1. Falls back to a plain `<Input>` when
`VITE_GOOGLE_MAPS_API_KEY` is unset. Debounce 300 ms, min 3 chars, in-flight `AbortController`,
keyboard nav ArrowUp/ArrowDown/Enter/Escape, blur closes after 120 ms. On select it sets the
input text immediately, then fetches place details and emits a parsed
`{address_line1, address_line2, city, state, zip}`. All failures are silent.

### 3.5 Job Type / Source selects and the inline "+ Add new type"

Both selects build their option list the same way (lines 563-604):
```
base = org?.job_type_options ?? []            // or org?.source_options
options = current && !base.includes(current) ? [current, ...base] : base
```
so a value not in the org list stays selectable. Empty list -> a single DISABLED
`SelectItem value="__none__"` whose label is:
- Job Type: `No options — add below` when `ability.can('update','Organization')`,
  else `No options — add in Settings`.
- Source: always `No options — add in Settings`.

Job Type additionally appends `<SelectItem value="__add_new__">+ Add new type…</SelectItem>`
**only when `ability.can('update','Organization')`**. Selecting it does NOT set the field; it
sets `addingJobType = ''`, which reveals an inline row: an autofocused `<Input maxLength={50}>`
(placeholder `New job type (press Enter or Add)`) plus an `Add` button disabled while blank.
`commitJobType()` trims, sets `job_type`, and if the value is new fires
`updateOrg.mutate({ job_type_options: [...existing, trimmed] })`
(`PATCH /api/organization`, invalidates `['organization']`), then closes the row.
`Enter` in the input calls `preventDefault()` then `commitJobType()` - it never submits the form.

Source has NO add-new affordance.

### 3.6 Owner picker

Rendered only when `ability.can('assign','Lead')` (comment: "hidden for SALES, who auto-self-assign
and lack the assign ability"). Options come from
`useAssignableUsers({ eligibleFor: 'owner' })` ->
`GET /api/users?assignable=true&eligible_for=owner`, key
`['users','assignable', null, 'owner', null]`. Placeholder `Unassigned`. There is NO explicit
"Unassigned" option - leaving it untouched sends `assigned_to: undefined`.

### 3.7 Schedule block

A `<Switch>` toggles `showSchedule` (local state, default `false`). When on, four controls:
`Start Date`/`End Date` are `<Input type="date" className="w-[180px]">` registered through RHF;
`Start Time`/`End Time` are `<TimeSelect>` (15-minute grid across 24 h, `h:mm a` labels, value
contract `'HH:MM'`, a first item `Select time…` with sentinel value `'NONE'`, and an off-grid
saved value is prepended so it stays selected). Time changes use `setValue(..., { shouldDirty: true })`.

`combineDatetime(date, time)` returns `undefined` if there is no date, else
`new Date(`${date}T${time || '00:00'}:00`).toISOString()` - local-time parse, UTC output.

**If `showSchedule` is false the schedule fields are not sent at all** (`undefined`), even if the
user filled them before toggling off.

### 3.8 Submit path (`mutation`, lines 296-371)

Two branches.

**A. Existing customer selected (`selectedCustomerId` truthy):**
```
POST /api/leads
{
  customer_id: selectedCustomerId,
  ad_source: data.ad_source || undefined,
  service_request, notes?, job_type?, assigned_to?, scheduled_start?, scheduled_end?,
  ...(pickedExisting ? { service_location_id } : hasAddress ? { new_location: {...} } : {})
}
```
where `pickedExisting = service_location_id && service_location_id !== '__add_new__'` and
`hasAddress = Boolean(service_address_line1?.trim())`. `new_location` =
`{address_line1, address_line2?: undefined-if-empty, city, state, zip}`.
The `override` flag is NOT applied on this branch.

**B. New customer:**
```
POST /api/leads          (or /api/leads?override=true when override is set)
{
  new_customer: {
    first_name, last_name, company_name?, phone?, email?, ad_source?,
    ...(hasAddress ? { location: { address_line1, address_line2?, city, state, zip } } : {})
  },
  service_request, notes?, job_type?, assigned_to?, scheduled_start?, scheduled_end?
}
```

`baseLeadFields` (shared): `service_request`, `notes || undefined`, `job_type || undefined`,
`assigned_to || undefined`, and the two schedule timestamps (`undefined` when `showSchedule` is off).

**onSuccess** (lines 346-362):
1. Clears duplicate state (`dupExisting`, `pendingData`, `dupMatched`) - the comment notes this
   prevents `isOverriding` being driven by stale state.
2. `queryClient.invalidateQueries({ queryKey: ['leads'] })`
3. `queryClient.invalidateQueries({ queryKey: ['customers'] })`
4. Navigation:
   - if `returnTo` AND `res.lead?.customer_id` -> `navigate(`${returnTo}?newCustomerId=${customer_id}`, { replace: true })`
   - else `navigate(res.lead?.id && ability.can('read','Lead') ? `/leads/${res.lead.id}` : '/leads')`

**No optimistic update.** The lead detail cache (`['lead', id]`) is NOT invalidated (it does not exist yet).

**onError** (lines 363-370): calls `getDuplicateCustomer(err)`, which returns the payload only when
`status === 409 && data.error === 'duplicate' && data.existing`. On a hit it stores `dupExisting`,
`pendingData` (the submitted form data), and `dupMatched = computeMatchedCustomerFields(data, dup)`
(normalized email lowercase-trim; phone digits-only with a leading `1` stripped from 11-digit values).
Any other error falls through to the inline error line.

### 3.9 Duplicate-customer dialog flow

`<DuplicateCustomerDialog>` (max-w-lg) shows: warning title `Possible Duplicate Customer`, a
description naming which of email/phone/both matched, a card with the existing customer's display
name, `customer_number`, an `Active`/`Archived` pill (archived when `!is_active || archived_at`),
matched rows highlighted in danger with a trailing `matches` label, plus the primary address row.

Actions:
| Control | Handler | Effect |
|---|---|---|
| `Open existing customer` (primary) | `handleOpenExisting` | see below |
| `Edit email` (only if email matched) | `handleEditField('email')` | closes dialog, `form.setFocus('email')`, then `requestAnimationFrame(() => document.getElementById('email')?.focus())` |
| `Edit phone` (only if phone matched) | `handleEditField('phone')` | same with `'phone'` |
| `Cancel` (small text link) | `onClose` -> `setDupExisting(null)` | dismiss only |
| `Create anyway` (small text link, disabled while `isOverriding`) | `handleCreateAnyway` | `mutation.mutate({ data: pendingData, override: true })` |

`handleOpenExisting` (lines 377-427) is the subtle one:
1. Guards on `!dupExisting || openingExisting` (double-click protection).
2. Snapshots `draftAdSource` (the Source the user set for THIS lead) and the six draft address fields.
3. Sets `openingExisting = true`.
4. **Awaits `GET /api/customers/:id` FIRST**, then `selectCustomer(fullRecord)`, then closes the
   dialog - so a failed fetch never leaves the dialog closed with nothing applied.
5. On fetch failure it builds a minimal fallback customer (`service_locations: []`), calls
   `selectCustomer(fallback)` (which blanks the address), then RESTORES the snapshotted address,
   defaulting `service_location_id` to `'__add_new__'` when it was empty.
6. `finally`: restores `ad_source` if the user had set one, clears `openingExisting`, clears
   `dupExisting`.

`isOverriding = (mutation.isPending && Boolean(pendingData)) || openingExisting`.

`inlineError = getDuplicate(mutation.error) ? null : mutation.error` - the duplicate case is
handled by the dialog, so the raw string is not also printed inline. The inline line renders
`extractApiError(inlineError, 'Something went wrong')`.

### 3.10 Preselected customer (`?customer_id=`)

```
useQuery({ queryKey: ['customer-prefill', preselectedCustomerId],
           queryFn: GET /api/customers/:id, enabled: Boolean(preselectedCustomerId) })
```
A `useEffect` on `[preselectedCustomer]` (eslint-disabled deps) runs once when it arrives and
`!selectedCustomerId`: sets selection and writes `first_name, last_name, company_name,
phone (masked), email, ad_source`, plus the primary/first location id and its five address fields.
Note this effect does NOT blank the address when the customer has no locations (unlike
`selectCustomer`).

### 3.11 States on `/leads/new`

- No loading state - the create form renders immediately (org/user queries populate the selects
  asynchronously; until then the selects show their empty-state disabled item).
- Submit button: `disabled={mutation.isPending}`, label flips `Create Lead` -> `Creating...`.
- Error: single inline `<p class="text-sm text-danger">` above the action row.
- No toasts on this page (the only toast is the org-update failure toast owned by `useUpdateOrganization`).

---

## 4. `/leads/:id/edit` - EditLeadForm

`LeadFormPage` with `id` present. Before rendering the edit form it runs:
```
useQuery({ queryKey: ['lead', id], queryFn: GET /api/leads/:id -> data.lead, enabled: isEdit })
```
- `isLoading` -> centered spinner: `h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent`, wrapper `py-12`.
- `!lead` -> a card: `Lead not found.` + an outline `Back to Leads` button -> `navigate('/leads')`.

> Note (hooks hazard for the rebuild): these early returns sit BEFORE
> `const customerIdParam = ...` and the `<CreateLeadForm>` return, inside the same component.
> The create/edit split is by component, so no hook-order violation occurs, but a rebuild that
> merges them would introduce one.

### 4.1 Component tree

```
<div class="space-y-4">
├─ header: [ghost "<- Back" -> navigate(-1)]  <h1>Edit Lead</h1>
└─ card > <form onSubmit={handleSubmit(submit)}>
   ├─ grid lg:grid-cols-2
   │  ├─ COL 1 "Lead Details"
   │  │  ├─ Textarea "Service Request *" (rows 3, no placeholder)
   │  │  ├─ Textarea "Notes" (rows 2, placeholder "Internal notes...")
   │  │  └─ grid sm:grid-cols-2: Select "Job Type" (+ add-new row) | Select "Source"
   │  └─ COL 2 "Service Location"
   │     ├─ if hasEstimates: LOCKED read-only block (Lock icon + address + note)
   │     │  else: <PickOrAccreteLocation showPicker label="Location" pickerNote={taxWarning?} />
   │     ├─ divider "Schedule" + <Switch checked={showSchedule} />
   │     └─ if showSchedule: Start/End Date + Start/End Time (same controls as create)
   ├─ error <p> if mutation.error
   └─ actions: [outline "Cancel" -> navigate(-1)] [default "Save Changes" / "Saving..."]
└─ <TaxWarningDialog ... />
```

**Edit has NO customer picker and NO "Assign to" picker.** Contact fields are not editable here.

Job Type / Source selects behave exactly as on create (placeholders differ: `Select type...` and
`Select source...`).

### 4.2 `editSchema` (zod) - lines 75-91

| field | rules | default (from `lead`) |
|---|---|---|
| `service_request` | `.min(1,'Service request is required').max(2000)` | `lead.service_request` |
| `notes` | `.max(5000)` optional | `lead.notes ?? ''` |
| `job_type` | optional | `lead.job_type ?? ''` |
| `ad_source` | optional | `lead.customer.ad_source ?? ''` |
| `scheduled_date` / `_time` / `_end_date` / `_end_time` | optional | `extractDate/extractTime(lead.scheduled_start / scheduled_end)` |
| `service_location_id` | optional | `initialLocation?.id ?? ''` |
| `service_address_line1` | `.max(200)` optional | `lead.service_address_line1 ?? ''` |
| `service_address_line2` | `.max(200)` optional | `lead.service_address_line2 ?? ''` |
| `service_city` | `.max(100)` optional | `lead.service_city ?? ''` |
| `service_state` | `.max(2)` optional | `lead.service_state ?? ''` |
| `service_zip` | `.max(10)` optional | `lead.service_zip ?? ''` |

`extractDate(iso) = iso.slice(0,10)`, `extractTime(iso) = iso.slice(11,16)` - raw ISO slicing,
so these are UTC components, not local. `showSchedule` initialises to
`Boolean(lead.scheduled_start || lead.scheduled_end)`.

`initialLocation` (lines 714-716) is a best-effort match:
`customerLocations.find(l => l.address_line1 === lead.service_address_line1 && l.zip === lead.service_zip)`
`|| customerLocations.find(l => l.is_primary) || customerLocations[0]`.

### 4.3 Location freeze

`hasEstimates = (lead.estimates?.length ?? 0) > 0`. When true:
- The picker is replaced by a read-only block: a `Lock` icon + `[line1, line2].join(', ') || '—'`,
  a second line `[city, state, zip].join(', ')`, and the note
  `Locked — revise or duplicate the estimate to change the service location.`
- The mutation sends **no location fields at all** (`locationFields = {}`), because the backend
  returns 400 otherwise.

### 4.4 Tax warning

`leadState = lead.service_state ?? ''`; `newState = form.watch('service_state')`.
`isStateChange = !hasEstimates && Boolean(newState) && newState !== leadState`.

- While true, `PickOrAccreteLocation` gets a `pickerNote`:
  `Changing to {newState} will change the tax rate for new estimates.` (`text-xs text-warning`).
- `submit(data)` INTERCEPTS: if `isStateChange`, it opens `<TaxWarningDialog>` and returns
  WITHOUT mutating. `confirmTaxWarning()` closes the dialog and calls
  `mutation.mutate(form.getValues())`.
- `TaxWarningDialog` (max-w-md): `AlertTriangle` + title `Tax Rate Change`, description naming
  old -> new state, a body paragraph, `Cancel` (closes) and a confirm button labelled
  `Save Changes` (the page passes `confirmLabel="Save Changes"`), disabled while `isPending`,
  label flips to `Saving...`.

### 4.5 Submit path

```
PATCH /api/leads/:id
{
  service_request,
  notes: data.notes || null,
  job_type: data.job_type || null,
  ad_source: data.ad_source || null,
  scheduled_start: showSchedule ? (combineDatetime(date,time) || null) : null,
  scheduled_end:   showSchedule ? (combineDatetime(endDate,endTime) || null) : null,
  ...locationFields
}
```
`locationFields`:
- `hasEstimates` -> `{}`
- else `pickedExisting` (`service_location_id` set and not `'__add_new__'`) -> `{ service_location_id }`
- else -> `{ new_location: { address_line1: ''|value, address_line2?: undefined, city, state, zip } }`
  (note: this branch always sends `new_location`, even when every address field is blank - unlike
  create, which guards on `hasAddress`).

**Edit sends `null`, not `undefined`, for cleared fields** - it is an explicit clear, unlike create.
Turning the schedule switch off explicitly NULLs both timestamps.

**onSuccess** (lines 783-787):
```
invalidateQueries(['lead', leadId])
invalidateQueries(['leads'])
navigate(`/leads/${leadId}`)
```
No optimistic update. No toast.

**Error**: `mutation.error` renders `extractApiError(mutation.error, 'Something went wrong')` as
an inline `<p class="text-sm text-danger">` above the actions.

**Note**: `TaxWarningDialog` stays mounted (it is a sibling of the card, always rendered with
`open={taxWarnOpen}`).

---

## 5. `/leads/:id` - LeadDetailPage

### 5.1 Data + shell

```
useQuery({ queryKey: ['lead', id], queryFn: GET /api/leads/:id -> data.lead, enabled: Boolean(id) })
```
- `isLoading` -> the same centered spinner as the edit page.
- `!lead` -> card with `Lead not found.` + `Back to Leads`.

Whole page is wrapped in `<IconRail entityType="LEAD" entityId={id}>` (see §5.9).

`incomingBreadcrumbs = location.state?.breadcrumbs` (a `BreadcrumbItem[]`). The rendered
breadcrumb is `incomingBreadcrumbs ? [...incoming, { label: 'Lead from {customerLabel}' }]
: [{ label: 'Leads', href: '/leads' }, { label: 'Lead from {customerLabel}' }]` - the LAST crumb
has no `href`. Separately, `leadBreadcrumbs` (WITH an href on the last crumb) is what
`navWithBreadcrumbs(path)` pushes as `state.breadcrumbs` when navigating to a child page.
`customerLabel = customerDisplayName(customer)`.

### 5.2 Full component tree

```
<IconRail entityType="LEAD" entityId={id}>
  <div class="space-y-4">
  ├─ <Breadcrumb items={...} />
  ├─ unified card
  │  ├─ HEADER (p-5)
  │  │  ├─ left
  │  │  │  ├─ <h1>Lead from {customer.first_name} {customer.last_name}</h1>   // raw names, not customerDisplayName
  │  │  │  ├─ <StatusDropdown currentStatus disabled={!canChangeStatus || statusMutation.isPending} />
  │  │  │  ├─ meta row: mono lead_number | company_name? | "Created {formatDate}"
  │  │  │  └─ <TagInput leadId={id} tags={lead.tags ?? []} />
  │  │  └─ right: action button cluster (flex-wrap, justify-end) -- see §5.4
  │  ├─ KPI STRIP (4 equal cells, divide-x): Estimated Value | Estimates | Days Open | Source
  │  ├─ <Tabs value={activeTab} onValueChange={setActiveTab}>
  │  │  ├─ TabsList: Overview | [dot] Walkthrough | Estimates (N) | [clip] Attachments | Tasks
  │  │  ├─ TabsContent "overview"     -> two-column layout, §5.5
  │  │  ├─ TabsContent "walkthrough"  -> <WalkthroughTabContent>, §5.6
  │  │  ├─ TabsContent "attachments"  -> <AttachmentSection context="OTHER">
  │  │  ├─ TabsContent "estimates"    -> table or empty state, §5.7
  │  │  └─ TabsContent "tasks"        -> <JobLeadTasksTab entity={{type:'LEAD',...}} jobType={lead.job_type} />
  └─ DIALOGS (always mounted): MarkLostDialog, CancelLeadDialog, inline Delete Dialog,
       ContactLeadDialog, CancelWalkthroughDialog, CreateJobFromLeadDialog
```

The tab ORDER in `TabsList` is Overview, Walkthrough, Estimates, Attachments, Tasks; the
`TabsContent` blocks appear in source order Overview, Walkthrough, Attachments, Estimates, Tasks
(irrelevant to rendering, but do not "fix" the visible tab order).

### 5.3 Derived flags and permission gates

```
canEdit              = ability.can('update', 'Lead')
canPerformWalkthrough= ability.can('perform_walkthrough', 'Lead')
canScheduleWalkthrough=ability.can('schedule_walkthrough', 'Lead')
canChangeStatus      = ability.can('update', 'Lead')          // same grant as canEdit, kept separate on purpose
canAssign            = ability.can('assign', 'Lead')
canContact           = ability.can('contact', 'Lead')
isNotTerminal        = lead && status not in {WON, LOST, CANCELLED}
canMarkLost          = isNotTerminal && ability.can('mark_lost', 'Lead')
canCancel            = isNotTerminal && ability.can('cancel', 'Lead')
isTerminal           = lead && ['WON','LOST','CANCELLED'].includes(status)
canCreateEstimate    = ability.can('create', 'Estimate') && !isTerminal
isNew                = status === 'NEW'
isWalkthroughScheduled = status === 'WALKTHROUGH_SCHEDULED'
approvedEstimate     = estimates.find(e => e.status === 'WON')   // COMPUTED BUT NEVER USED
canConvertToJob      = ability.can('create', 'Job')
canDelete            = ability.can('delete','Lead') && estimateCount === 0
```
The in-file comment (lines 678-690) states these are ability-based rather than role literals on
purpose (#238), and that the walkthrough capabilities are deliberately split from `update Lead`
because a strict TECHNICIAN holds `perform_walkthrough` but not `update`/`schedule` (#232/#238).

KPI values: `estimateTotal = Σ parseFloat(e.total_amount || '0')`, `estimateCount = estimates.length`,
`daysOpen = Math.floor((Date.now() - created_at) / 86_400_000)`,
`Source = lead.customer.ad_source || '—'`. `Estimated Value` shows `formatCurrency(total)` when
`> 0`, else `—`.

### 5.4 Header action buttons - exact gate -> control -> target

| Order | Button | Gate | Opens |
|---|---|---|---|
| 1 | `Mark Contacted` (outline, `PhoneCall`) | `isNew && canContact` | `<ContactLeadDialog>` |
| 2 | `Create Estimate` (default, `FileText`) | `canCreateEstimate` | `navWithBreadcrumbs('/estimates/new?lead_id=' + id)` |
| 3 | `Edit` (outline, `Pencil`) | `canEdit` | `navigate('/leads/:id/edit')` |
| 4 | `Assign` (outline, `User`) | `canAssign` | `<AssignLeadPopover>` (Radix Popover, align end) |
| 5 | `Cancel Walkthrough` (outline, danger text) | `isWalkthroughScheduled && canEdit` | `<CancelWalkthroughDialog>` |
| 6 | `Mark Lost` (outline, danger, `AlertTriangle`) | `canMarkLost` | `<MarkLostDialog>` |
| 7 | `Cancel Lead` (outline, danger, `Ban`) | `canCancel` | `<CancelLeadDialog>` |
| 8 | `Delete` (outline, danger, `Trash2`) | `canDelete` | inline `<Dialog>` (max-w-sm) |
| 9 | `Create Job` (business, `Briefcase`) | `canConvertToJob` | `<CreateJobFromLeadDialog>` |

### 5.5 Overview tab

**Left column (`flex-[65]`):**
- Section `Service Request`: `<p class="whitespace-pre-wrap">{lead.service_request}</p>`.
- `Lead Notes` block - only when `lead.notes` is truthy.
- Row 1: `Source: {customer.ad_source || '—'}` and `Lead Type: {lead.lead_type || '—'}`.
- Row 2: `Job Type: {lead.job_type || '—'}` and `Created: {formatDate(created_at)}`.
- Row 3 - only when `scheduled_start || scheduled_end`: `Scheduled Start: {toLocaleString()}`
  and `End: {toLocaleString()}` (each rendered only if its own value is set).
- Lost block - only when `status === 'LOST' && lost_reason`: a danger-tinted card with
  `Lost Reason`, the reason, and `Lost on {formatDate(lost_at)}` when `lost_at` is set.
- Walkthrough summary strip: a full-width `<button>` that calls `setActiveTab('walkthrough')`.
  Four mutually exclusive contents, in this precedence:
  1. `isWalkthroughScheduled` -> `Clock` icon + `Scheduled for {formatDateTime(walkthrough_scheduled_at)}`
     + `with {performerLabel}` when performers exist.
  2. `walkthrough_completed_at` -> `CheckCircle2` + `Completed {formatDateTime(...)}` + `by {performerLabel}`.
  3. `walkthrough_needed` -> `No walkthrough scheduled yet — click to schedule`.
  4. else -> `Walkthrough not required`.

**Right column (`flex-[35]`):**
- `Customer` block: a `<button>` (not a link) -> `navWithBreadcrumbs('/customers/:id')` showing
  `first_name last_name`; optional company line; a `tel:` anchor showing
  `formatPhone(phone)` + ` ext. {phone_ext}` when present; a `mailto:` anchor when `email` is set.
- `Assigned To` block: `commission_owner` full name or `Unassigned`, plus a `Reassign` button
  (`h-7 text-xs`) that opens the SAME `<AssignLeadPopover>`; gated on `canAssign`.
- `Service Locations` block - rendered only when `customer.service_locations.length > 0`.
  Each row: `MapPin` (primary-colored when `is_primary`), line1(+line2), `city, state zip`, and a
  `Primary` chip when `is_primary`.
- `Walkthrough Needed` block: label + sub-text (`A walkthrough is required` /
  `No walkthrough required`) and a `<Switch>` whose `disabled` is
  `!canEdit || isWalkthroughScheduled || toggleNeededMutation.isPending`. Errors render below as
  `extractApiError(err, 'Failed to update')`.

### 5.6 Walkthrough tab (`WalkthroughTabContent`)

Local state, synced from the lead by a `useEffect` on
`[walkthrough_scheduled_at, walkthrough_duration_minutes, walkthrough_performers, walkthrough_notes]`:
```
wtScheduled  = scheduled_at ? scheduled_at.slice(0,16) : ''     // datetime-local string, raw ISO slice
wtDuration   = String(duration_minutes ?? 60)
wtPerformers = performers.map(p => p.user.id)
wtNotes      = walkthrough_notes ?? ''
```

Four mutually exclusive renders, checked in this order:

**(a) Not needed** - `!walkthrough_needed && !isScheduled && !isCompleted`:
centered `Calendar` icon, text `Walkthrough not required for this lead`, and, when `canEdit`, an
outline `Enable Walkthrough` button -> `toggleNeededMutation.mutate(true)` (disabled while pending).

**(b) Completed** - `Boolean(walkthrough_completed_at)`:
green banner `Completed on {formatDateTime(completedAt)}` + `by {performerLabel}` when performers
exist; a read-only `Schedule Info` 3-col grid (`Scheduled`, `Duration` (`{n} min`), `Performer`);
a `Notes` `<Textarea rows={4} placeholder="Walkthrough notes..." disabled={!canPerformWalkthrough}>`;
a `Save Notes` button that appears ONLY when `canPerformWalkthrough && wtNotes !== (lead.walkthrough_notes || '')`
(label flips to `Saving...`); and an `Attachments` section
(`<AttachmentSection entityType="LEAD" context="WALKTHROUGH" onCountChange={...}>`).

**(c) Scheduled** - `status === 'WALKTHROUGH_SCHEDULED'`:
read-only `Schedule Info` grid (bold values); the same Notes + conditional `Save Notes`, plus
`Failed to save notes` on error; Attachments; and, when `canPerformWalkthrough`, a
`Complete Walkthrough` button (`CheckCircle2`, label -> `Completing...`) with
`extractApiError(err, 'Failed to complete walkthrough')` below on failure.

**(d) Default (needs scheduling)**:
an EDITABLE `Schedule Info` grid -
`Date & Time` `<Input type="datetime-local">`, `Duration` `<Select>` with exactly
`30 minutes / 1 hour / 1.5 hours / 2 hours / 3 hours` (values `30/60/90/120/180`), and
`Performers` `<MultiAssigneeSelect placeholder="Add performer...">` - all `disabled={!canScheduleWalkthrough}`.
Then Notes (disabled unless `canPerformWalkthrough`), Attachments, and, when
`canScheduleWalkthrough`, a `Schedule Walkthrough` button with
`disabled={!wtScheduled || wtPerformers.length === 0 || scheduleMutation.isPending}`
(label -> `Scheduling...`) and `extractApiError(err, 'Failed to schedule walkthrough')` below.

`MultiAssigneeSelect` renders selected users as removable chips (`aria-label="Remove {name}"`)
plus a Radix `Select` grouped by department (`No department` group sorted last); the trigger value
is always reset to `''` so re-picking fires again; when nothing is left it shows `No more members`
and disables itself. It queries `useAssignableUsers({ enabled: true })` (no `eligibleFor` here).

`<AttachmentSection>` behaviour (shared): drop zone (`Drag & drop files here, or Browse`,
`JPG, PNG, HEIC, MP4, PDF · 25MB max`), hidden `<input type="file" multiple>` accepting
`image/jpeg,image/png,image/heic,video/mp4,application/pdf`, 25 MB cap (oversized files are
silently skipped). Each pending file gets a `Display name *` input, a `Description *`
(`Description (optional)` for images) input, and an `Upload` button disabled until the display
name is present and - for non-images - a description. Upload = `POST /api/attachments/lead/:id`
multipart with `file`, `display_name`, `description`, `context`, with a live progress bar. Success
removes the pending row and invalidates `['attachments','LEAD',id]`. Failure shows the message and
a `Retry` button. The gallery filters `allAttachments` down to the matching `context` client-side;
it fetches `GET /api/attachments/lead/:id` (ALL contexts) under key `['attachments','LEAD',id]`.
Delete goes through `window.confirm('Delete this attachment?')` then
`DELETE /api/attachments/lead/:id/:attachmentId`. Loading -> three `h-28` skeleton tiles.
Empty -> renders NOTHING (no empty-state copy).

Note: `attachmentCount` / `onAttachmentCountChange` are threaded from the page into
`WalkthroughTabContent` and on to `AttachmentSection`, but the count is never displayed anywhere.

### 5.7 Estimates tab

- Header row: `Estimates ({estimateCount})` plus a `+ New Estimate` business button when
  `canCreateEstimate` -> `navWithBreadcrumbs('/estimates/new?lead_id=' + id)`.
- Empty -> `FileText` icon, `No estimates yet.`, `Create one to get started.`
- Otherwise a hand-rolled `<table>` (NOT `DataTable`) with columns
  `Number | Status | Deposit | Created By | Date | Total (right) | (8px hover-pencil)`.
  Each `<tr>` is clickable -> `navWithBreadcrumbs('/estimates/:id')`. Deposit renders a
  `<StatusBadge status={est.deposit.status}>` or an em-dash. Date uses `formatDateTime`.
  Total uses `formatCurrency`. The trailing `Pencil` is opacity-0 until row hover.

### 5.8 Tasks tab (`JobLeadTasksTab`)

Fetches `listTasks({ linked_entity_type: 'LEAD', linked_entity_id: lead.id })` on mount and on
entity change; stores results in local state (NOT react-query). Errors render as
`<p class="text-sm text-danger">` with `extractApiError(err, 'Failed to load tasks')`.

- `+ New task` -> `<CreateTaskModal presetEntity={entity}>`; closing it refetches.
- `Generate tasks` (ai variant, `Sparkles`) -> `taskAI.suggestTasks(jobType ?? entity.label)`
  populates a lavender `Suggested tasks` `SectionCard` with checkboxes; `Add N task(s)` creates
  each via the tasks store (failures collected into one destructive toast
  `N task(s) failed to create`), then refetches and dismisses; `Cancel` dismisses.
- Task list grouped by status in fixed order: `In progress`, `To do`, `Blocked`, `Done`
  (empty groups omitted), rendered as `<TaskCard hideLinkedEntity>` in a
  `sm:grid-cols-2 lg:grid-cols-3` grid. Status change -> `updateStatus(...)` then refetch.
- Empty -> `ClipboardList` icon + `No tasks yet for this lead.`
- `<TaskDetailDrawer />` is mounted at the bottom.
`entity.label` passed from the page is `Lead from {customerDisplayName(customer)}`.

### 5.9 IconRail (right rail)

`<IconRail entityType="LEAD" entityId={id}>` wraps the whole page content. It renders:
- a fixed 40px rail at `right-0 top-[64px] bottom-0`, `z-30`, containing two buttons:
  `title="Activity"` (`MessageSquare`) and `title="Attachments"` (`Paperclip`).
- a sliding panel at `right-10 top-[64px] bottom-0 w-80`, `z-20`, translated off-screen
  (`translate-x-full`) when closed. Header shows `Activity` / `Attachments` and an `X` close button.
- Clicking the same icon again toggles the panel closed (`prev === panel ? null : panel`).
- Content margin: `marginRight` is `360px` when a panel is open AND the viewport is >= 1280px,
  else `40px`. Below 1280px an invisible full-screen backdrop (`z-10`) closes the panel on click.

`ActivityPanel` for LEAD: `GET /api/leads/:id/notes` (key `['notes','LEAD',id]`) and a note
composer -> `POST /api/leads/:id/notes { content }`, invalidating `['notes','LEAD',id]` and
`['timeline','LEAD',id]`. **The timeline query is disabled for leads** -
`TIMELINE_ENTITY_TYPES = ['JOB','ESTIMATE']`, so `/api/leads/:id/timeline` is never called.

`AttachmentsPanel`: `GET /api/attachments/lead/:id` (same key as `AttachmentSection`,
`['attachments','LEAD',id]`), quick upload `POST` multipart, delete `DELETE .../:attachmentId`.

### 5.10 Status dropdown (`StatusDropdown`, lines 113-155)

A hand-rolled dropdown (NOT Radix): a `<button>` containing `<StatusBadge>` and, when enabled, a
`ChevronDown`. Open state renders a `fixed inset-0 z-40` click-catcher plus an absolutely
positioned `w-52 max-h-60 overflow-auto` panel of `<button>`s, one per status, each rendering a
`<StatusBadge>`. Selecting one calls `onStatusChange(status)` and closes.
`disabled` = `!canChangeStatus || statusMutation.isPending`; when disabled the button does not
open and the chevron is hidden.

The status list it offers is the page-local `LEAD_STATUSES` constant (lines 79-82):
```
NEW, CONTACTED, WALKTHROUGH_SCHEDULED, ESTIMATING, ESTIMATED, APPROVED, WON, LOST, CANCELLED
```
**This does not match the database enum** - see §7.1. `STATUS_LABELS` (lines 84-94) is declared
but never referenced in this file (the buttons render `<StatusBadge>`, which has its own label map).

### 5.11 URL query-param effects

Two `useEffect`s on `[searchParams, setSearchParams]`:

1. `?createJob=<estimateId>` -> `setPreselectEstimateId(cj)`, `setCreateJobOpen(true)`, then
   deletes `createJob` from the URL with `{ replace: true }`.
2. `?tab=walkthrough` -> `setActiveTab('walkthrough')`, then deletes `tab` with `{ replace: true }`.
   The value is whitelisted to exactly `'walkthrough'` - any other `?tab=` value is ignored
   (comment: "so an arbitrary ?tab= can't select an invalid tab").

Both params are consumed and stripped, so a reload lands on the default `overview` tab. `activeTab`
is NOT persisted to the URL.

### 5.12 Mutations on the detail page

| Mutation | Request | onSuccess | Optimistic |
|---|---|---|---|
| `statusMutation` | `PATCH /api/leads/:id { status }` | invalidate `['lead', id]` + `['leads']` | no |
| `deleteMutation` | `deleteLead(id)` -> `DELETE /api/leads/:id` | invalidate `['leads']`, `navigate('/leads')` | no |
| `createJobMutation` | `POST /api/jobs { estimate_id }` -> `data.job` | invalidate `['jobs']`, `navigate('/jobs/:id')` | no |
| `toggleNeededMutation` (page) | `PATCH /api/leads/:id { walkthrough_needed }` | `onSettled` invalidates `['lead', id]` | **YES** |
| `scheduleMutation` (tab) | `POST /api/leads/:id/walkthrough/schedule { walkthrough_scheduled_at, performer_ids, walkthrough_duration_minutes }` | invalidate `['lead', id]` | no |
| `completeMutation` (tab) | `POST /api/leads/:id/walkthrough/complete` (no body) | invalidate `['lead', id]` | no |
| `saveNotesMutation` (tab) | `POST /api/leads/:id/walkthrough { walkthrough_notes: wtNotes \|\| null }` | invalidate `['lead', id]` | no |
| `toggleNeededMutation` (tab) | same as page | `onSettled` invalidates `['lead', id]` | **YES** |

The two optimistic toggles (issue #30) follow the standard pattern:
`onMutate` -> `cancelQueries(['lead', id])`, snapshot `previous`, `setQueryData` merging
`{ ...old, walkthrough_needed: needed }`; `onError` -> restore `context.previous`;
`onSettled` -> invalidate. **The page and the walkthrough tab each declare their OWN copy of this
mutation** - duplicated code operating on the same cache key.

`createJobMutation.onError` is the only toast on this page:
```
toast({ title: 'Could not convert to job',
        description: extractApiError(err, 'Failed to create job from this estimate'),
        variant: 'destructive' })
```
with the comment that the modal deliberately stays open on error.

**Note:** `scheduleMutation` posts `new Date(wtScheduled).toISOString()` where `wtScheduled` came
from an ISO slice - i.e. a UTC instant is displayed in a local-time input and re-parsed as local.
Preserve as-is; correcting it is a logic change.

### 5.13 Detail-page dialogs (all always mounted, controlled by `open`)

| Component | Size | Fields | Submit | Disabled until | onSuccess |
|---|---|---|---|---|---|
| `MarkLostDialog` | max-w-sm | `Reason *` Textarea rows 3, placeholder `Why was this lead lost?` | `POST /api/leads/:id/mark-lost { lost_reason }` | `reason.trim()` non-empty | invalidate `['lead',id]` + `['leads']`, close, clear reason |
| `CancelLeadDialog` | max-w-sm | `Reason *` Textarea rows 3, placeholder `Why is this lead being cancelled?` | `cancelLead(id, { cancelled_reason })` -> `POST /api/leads/:id/cancel` | `reason.trim()` | same |
| Delete (inline `<Dialog>`) | max-w-sm | none | `deleteLead(id)` -> `DELETE /api/leads/:id` | - | invalidate `['leads']`, `navigate('/leads')` |
| `ContactLeadDialog` | max-w-sm | `Contact Date & Time *` datetime-local (defaults to `new Date().toISOString().slice(0,16)`), `Note (optional)` Textarea rows 3 | `POST /api/leads/:id/contact { contacted_at: ISO, contacted_note?: trimmed \|\| undefined }` | `contactedAt` truthy | invalidate `['lead',id]` + `['leads']`, close, clear note (NOT the date) |
| `CancelWalkthroughDialog` | max-w-sm | `Reason *` Textarea rows 3 | `POST /api/leads/:id/walkthrough/cancel { cancelled_reason: trimmed }` | `reason.trim()` | invalidate `['lead',id]` + `['leads']`, close, clear |
| `CreateJobFromLeadDialog` | max-w-md | radio-style estimate list | delegated to `onConvert(estimateId)` | `selectedId` set and `!isConverting` | owned by the page |

Copy details:
- Delete dialog title `Delete Lead`, description
  `Permanently delete this lead? This is only possible because it has no estimates. This cannot be undone.`
  Buttons: `Cancel` (outline) and destructive `Delete` / `Deleting...`. Error line uses
  `extractApiError(err, 'Failed to delete lead')`.
- `MarkLostDialog` description: `This action cannot be undone. Please provide a reason.`
  Buttons `Cancel` and destructive `Mark Lost` / `Marking...`.
- `CancelLeadDialog` description explains it is an administrative void for duplicates / leads
  created in error. Buttons `Close` (not `Cancel`) and destructive `Cancel Lead` / `Cancelling...`.
- `CancelWalkthroughDialog` buttons: `Back` and destructive `Cancel Walkthrough` / `Cancelling...`.
- Each dialog surfaces `extractApiError(mutation.error, '<its own fallback>')` as
  `<p class="text-sm text-danger">`.

**`CreateJobFromLeadDialog`** (`frontend/src/components/leads/CreateJobFromLeadDialog.tsx`):
- `convertible = estimates.filter(e => e.status === 'WON' && !e.job)`.
- Selection effect on `[open, preselectEstimateId, estimates]`: if the preselect id is in
  `convertible` use it; else if exactly one convertible estimate exists auto-select it; else `null`.
- Zero estimates -> `FileText` icon + `No estimates yet.`
- Otherwise a scrollable list (`max-h-72`) of ALL estimates. Convertible rows are clickable and
  show a radio dot; non-convertible rows get `opacity-70` and no click handler. Right side shows
  either a `{job_number} →` underline button (stopPropagation -> closes dialog, navigates to
  `/jobs/:id`) when the estimate already has a job, or `formatCurrency(total_amount)`.
- When `convertible.length === 0`: helper line
  `No approved estimate to convert yet. Approve an estimate first` + `, or create a new one below.`
  when `canCreateEstimate`, else `.`
- Footer: `New estimate` outline button (only when `canCreateEstimate`) -> closes and navigates to
  `/estimates/new?lead_id={leadId}`; `Cancel`; and a business `Create job` / `Creating…` button
  disabled until an estimate is selected.
- Closing it from the page clears `preselectEstimateId` so a later manual open starts clean.

### 5.14 TagInput

Rendered in the header with `leadId={id}` (deprecated prop path; internally resolves
`entityType='LEAD'`, `resourcePath='leads'`, `invalidationKey='lead'`).

- Existing tags render as colored pills with an inline `X` -> `removeTag.mutate(tag.id)` ->
  `DELETE /api/leads/:id/tags/:tagId`, invalidating `['lead', id]`.
- `+ Tag` dashed-border button opens a Radix `Popover` (`align="start"`, `w-64 p-0`) containing:
  a header `Available tags ({availableCount})` + a sort toggle button
  (`aria-label="Sort tags"`, `ArrowDownAZ`/`ArrowUpAZ`); a search `<input placeholder="Search tags...">`
  (`autoFocus`, `Escape` closes, `Enter` creates when a create is offered); a wrapped chip list of
  suggestions (already-attached tags excluded, filtered by search, sorted by `localeCompare` with
  the sort direction); `No tags found` when empty and no create is offered; and, when the search is
  non-empty and no tag name matches exactly (case-insensitive), a bottom row
  `Create new tag "{search}"`.
- Adding: `POST /api/leads/:id/tags` with `{ tag_id }` (existing) or `{ name, color }` (new, colour
  picked at random from a 10-value palette). onSuccess invalidates `['lead', id]` and `['tags']`,
  clears the search, closes the popover.
- Tag catalogue: `useQuery({ queryKey: ['tags'], queryFn: GET /api/tags })`.
- **There is no permission gate on TagInput** - it renders for every role that can view the page.

### 5.15 AssignLeadPopover

`AssignLeadPopover` -> `AssignTeamPopover mode="single" channels={['in_app']} initialSelected={[commission_owner.id]}`.
- Popover content `w-80 p-3`, `align="end"`: an autofocused `Search team members...` input; a
  `role="listbox"` list of `role="option"` buttons with avatars
  (`https://i.pravatar.cc/96?u={userId}` with initials fallback) and a
  `{department} {TitleCasedRole}` subtitle; a `Check` glyph on the selected row in single mode;
  `No team members found` when the filter empties the list.
- Users come from `useAssignableUsers({ enabled: open })` - i.e. `GET /api/users?assignable=true`
  with NO `eligible_for`, fetched lazily on open. The comment states this is deliberate: the server
  is the single source of truth for eligibility.
- Notify section: one checkbox per `channels` entry (here only `In app`), plus a permanently
  disabled `By SMS` + `Coming soon` row. All toggles reset to checked each time the popover opens.
- `Assign` button, disabled while pending or (single mode) nothing selected; label -> `Assigning...`.
- On click: `POST /api/leads/:id/assign { assigned_to: ids[0], notify: { in_app } }`, then
  invalidate `['lead', leadId]` and `['leads']`, then close. A thrown error is caught and rendered
  inside the popover as `extractApiError(err, 'Failed to assign')` - the popover stays open.

### 5.16 States on `/leads/:id`

| State | Behaviour |
|---|---|
| Loading | centered spinner (`h-8 w-8 animate-spin ... border-primary border-t-transparent`) in a `py-12` flex box. **The IconRail is not rendered during loading** (the early return precedes it). |
| Not found / error | `Lead not found.` card + `Back to Leads`. Because only `{ data, isLoading }` are destructured, a 403/500 renders the SAME not-found card - there is no distinct error state. |
| Estimates tab empty | `No estimates yet.` / `Create one to get started.` |
| Tasks tab empty | `No tasks yet for this lead.` |
| Attachments empty | nothing rendered (drop zone only) |
| Walkthrough not needed | dedicated centered empty state with an `Enable Walkthrough` CTA |
| Mutation errors | inline danger text next to the relevant control; only the create-job failure toasts |

---

## 6. Permission-conditional rendering - consolidated

| Check | Where | Hides / disables |
|---|---|---|
| `can('read','Lead')` | sidebar (`nav-registry`), post-create redirect in `CreateLeadForm` | the Leads nav row; redirect target falls back to `/leads` |
| `can('create','Lead')` | LeadsPage header, quick-create menu | the `New Lead` button / quick-create item |
| `can('update','Lead')` | LeadDetailPage `canEdit` + `canChangeStatus` | `Edit` button; `Cancel Walkthrough` button (with `isWalkthroughScheduled`); the `Walkthrough Needed` switch (disabled); the `Enable Walkthrough` button in the walkthrough tab; the `StatusDropdown` (disabled - button still renders, chevron hidden) |
| `can('delete','Lead')` **and** `estimateCount === 0` | LeadDetailPage | the `Delete` button |
| `can('assign','Lead')` | LeadFormPage create; LeadDetailPage header + Assigned-To block | the `Assign to` select on create; the `Assign` header button; the `Reassign` button |
| `can('contact','Lead')` **and** `status === 'NEW'` | LeadDetailPage header | the `Mark Contacted` button |
| `can('mark_lost','Lead')` **and** not terminal | LeadDetailPage header | the `Mark Lost` button |
| `can('cancel','Lead')` **and** not terminal | LeadDetailPage header | the `Cancel Lead` button |
| `can('schedule_walkthrough','Lead')` | walkthrough tab | disables the datetime input, duration select and performer picker; hides the `Schedule Walkthrough` button |
| `can('perform_walkthrough','Lead')` | walkthrough tab | disables the notes textarea; hides `Save Notes`; hides `Complete Walkthrough` |
| `can('create','Estimate')` **and** not terminal | LeadDetailPage header, Estimates tab, CreateJobFromLeadDialog | `Create Estimate`; `+ New Estimate`; the dialog's `New estimate` button and the trailing clause of its helper text |
| `can('create','Job')` | LeadDetailPage header | the `Create Job` button |
| `can('update','Organization')` | both lead forms | the `+ Add new type…` item in the Job Type select, and the wording of the empty-options item |

Everything is a **class-level** `ability.can(action, 'Lead')`. There is no per-instance/ownership
check anywhere in the leads UI. `canOnJob` is not used here.

Not gated at all in the UI (visible to every role that reaches the page): the Export dropdown, the
Columns picker, TagInput (add/remove), the IconRail Activity note composer, AttachmentSection
uploads and deletes, and the Tasks tab controls.

Three of those are gated server-side and will 403 silently for a read-only or technician user,
because the mutations have no error UI:
- **TagInput** - `POST/DELETE /api/leads/:id/tags` require `update Lead`.
- **Activity note composer** - `POST /api/leads/:id/notes` requires `update Lead`.
- **Export** - `GET /api/leads/export` requires `read Lead` (there is no `export Lead` action) and
  is rate-limited to 15 requests/60 s.
Reproduce the current (ungated) rendering; the missing gates are a pre-existing bug, not something
the UI swap should fix.

---

## 7. Lead lifecycle

### 7.1 Statuses - three lists that do not agree

| Source | Values |
|---|---|
| **`backend/prisma/schema.prisma` `enum LeadStatus` (lines 1106-1115) - the truth** | `NEW`, `CONTACTED`, `WALKTHROUGH_SCHEDULED`, `WALKTHROUGH_COMPLETED`, `ESTIMATED`, `WON`, `LOST`, `CANCELLED` |
| `frontend/src/lib/filters/registries/leads.ts` `LEAD_STATUSES` (filter facet) | identical to the enum - correct |
| `frontend/src/pages/LeadDetailPage.tsx` `LEAD_STATUSES` (lines 79-82, status dropdown) | `NEW`, `CONTACTED`, `WALKTHROUGH_SCHEDULED`, **`ESTIMATING`**, `ESTIMATED`, **`APPROVED`**, `WON`, `LOST`, `CANCELLED` - **adds two values that are not in the enum and omits `WALKTHROUGH_COMPLETED`** |

`ESTIMATING` and `APPROVED` are not `LeadStatus` members, so selecting either from the detail-page
dropdown will fail validation server-side. `APPROVED` also happens to be in `StatusBadge`'s map
(labelled `Approved`, green) because `PunchReview` uses it, so it renders without looking broken.
`WalkthroughDot` also treats `['ESTIMATING','ESTIMATED','APPROVED','WON']` as "walkthrough completed".

**Build-phase instruction: port `LeadDetailPage`'s list verbatim (bug parity), and file it as a
separate bug.** Do not silently fix it inside a presentation-only PR.

Labels used by `StatusBadge` (the only labels the user sees on the detail dropdown):
`New`, `Contacted`, `WT Scheduled`, `WT Completed`, `Estimate Sent` (for `ESTIMATED`), `Won`,
`Lost`, `Cancelled`. Colours: amber for all in-flight, green for `WON`, danger for `LOST`, gray
for `CANCELLED`.

The filter registry's own `STATUS_LABELS` matches those strings.

### 7.2 Numbering

Leads are numbered `L00001` per organization. The frontend never generates or edits the number - it
only displays `lead.lead_number` (mono, `text-xs`) in the list column and the detail header. The
prefix is org-configurable (`Organization.lead_prefix` in
`frontend/src/lib/api/organization.ts`). Allocation is server-side and race-safe via
`allocateNumber()` in `backend/src/lib/numbering.ts` (see §11).

### 7.3 Transition guards visible in the UI

| Guard | Where | Effect |
|---|---|---|
| terminal states (`WON`/`LOST`/`CANCELLED`) | `isNotTerminal`, `isTerminal` | hides `Mark Lost`, `Cancel Lead`, `Create Estimate`, `+ New Estimate` |
| `status === 'NEW'` | `isNew` | `Mark Contacted` shows only here |
| `status === 'WALKTHROUGH_SCHEDULED'` | `isWalkthroughScheduled` | shows `Cancel Walkthrough`; disables the `Walkthrough Needed` switch; drives the walkthrough tab's read-only "scheduled" render |
| walkthrough schedulable statuses | list `schedule_action` column | the calendar shortcut appears only for `CONTACTED`, `WALKTHROUGH_COMPLETED`, `WALKTHROUGH_SCHEDULED` (mirrors the backend gate) |
| `estimateCount === 0` | `canDelete` | delete is impossible once any estimate exists |
| `hasEstimates` | Edit page | service location is frozen and no location fields are sent |
| state change on the location | Edit page | `TaxWarningDialog` must be confirmed before the PATCH fires |
| estimate `status === 'WON' && !job` | `CreateJobFromLeadDialog` | only such estimates are selectable for conversion |

### 7.4 Conversion paths out of a lead

- **Lead -> Estimate**: navigation only. `navWithBreadcrumbs('/estimates/new?lead_id=' + id)` from
  three places (header button, Estimates-tab button, Create-Job dialog's `New estimate` button -
  that last one uses a plain `navigate`, without breadcrumbs). The lead itself is not mutated by
  the frontend.
- **Lead -> Job**: `CreateJobFromLeadDialog` picks a `WON` estimate with no job, then
  `POST /api/jobs { estimate_id }`. On success invalidate `['jobs']` and navigate to `/jobs/:id`.
  Note it does NOT invalidate `['lead', id]` or `['leads']`, so the lead's cached estimate rows
  keep a stale `job: null` until something else refetches.
- **Deep link**: `/leads/:id?createJob=<estimateId>` opens the dialog with that estimate preselected
  (used from the estimate side).

---

## 8. Local UI state and persistence - consolidated

### `/leads`
| State | Owner | Persisted? |
|---|---|---|
| `page` | `useState(1)` | no |
| `pageSize` | `useState(25)` | no |
| `search` | `useState('')` (DataTable holds a 300 ms-debounced `localSearch` mirror) | no |
| `sorting` | `useState<SortingState>([])` | no |
| 7 filter facets | `useSearchParams` via `useFilterState` | **URL** (`{ replace: true }`) |
| column visibility | `DataTable` internal (`internalVisibility`) - the page passes no controlled props | server, on explicit `Save current view` |
| column widths + `manuallySizedColumns` | `DataTable` internal | server, same |
| saved view | `useTableView('leads')` -> `GET/PUT /api/table-views/leads` | **server, per user** |
| FilterBar open + selected rail facet | `FilterBar` internal (`useState`) | no |
| Export dropdown open | Radix internal | no |

**No `localStorage` is used anywhere in the leads module.** (The nav layout uses
`servwave:nav-layout:{userId}`, but that is the sidebar, not this module.)

### `/leads/new`
`selectedCustomerId`, `selectedCustomer`, `showSchedule` (default false), `addingJobType`
(`null` = row closed), `dupExisting`, `pendingData`, `dupMatched`, `openingExisting`; RHF form
state. Nothing persisted. `?customer_id=` is read once on mount; `location.state.returnTo` drives
the post-create redirect.

### `/leads/:id/edit`
`showSchedule` (seeded from the lead), `addingJobType`, `taxWarnOpen`; RHF form state.
Nothing persisted.

### `/leads/:id`
`lostOpen`, `cancelOpen`, `deleteOpen`, `contactOpen`, `cancelWtOpen`, `createJobOpen`,
`preselectEstimateId`, `activeTab` (default `'overview'`), `attachmentCount`, plus
`useSearchParams` used transiently for `?createJob` / `?tab`. Inside the walkthrough tab:
`wtScheduled`, `wtDuration`, `wtPerformers`, `wtNotes` (all re-synced from the lead by effect).
`IconRail` owns `activePanel`. `TagInput` owns `open`, `search`, `sortAsc`.
**`activeTab` is not URL-synced and does not survive a reload.**

---

## 9. Selector surface

### 9.1 `data-testid` inventory

**There is not a single `data-testid` attribute in the entire Leads module.** Grepped
`frontend/src/pages/LeadsPage.tsx`, `LeadFormPage.tsx`, `LeadDetailPage.tsx` and all of
`frontend/src/components/leads/` - zero matches. The shared components they render
(`data-table`, `KpiStrip`, `FilterBar`, `AppliedChips`, `PickOrCreateCustomer`,
`PickOrAccreteLocation`, `IconRail`, `AttachmentSection`, `MultiAssigneeSelect`,
`AssignTeamPopover`, `TimeSelect`) are covered in §9.4 as reported by the selector audit.

Consequence for the build phase: **there are no testids to "carry over".** Every existing test
targets accessible names, literal text, placeholders, DOM structure, or CSS classes. That makes
this module's selector surface unusually brittle, and it is the single biggest reimplementation
risk. The stable anchors that MUST be preserved verbatim are listed next.

### 9.2 Must-preserve accessible names / text / placeholders

**`/leads`**
- `role=heading` name `Leads` inside `role=main`.
- `role=button` names: `New Lead`, `Export`, `Columns`, `Filter`, `Previous`, `Next`.
- Placeholder `Search leads...`.
- KPI label text (exact): `Total Leads`, `New This Week`, `Unassigned`, `Won`, `Lost`.
- Column header text: `Lead #`, `Customer`, `Phone`, `Source`, `Service Request`, `Location`,
  `Type`, `Status`, `Est.`, `Assignee`, `Walkthrough`, `Created` (the first column's header is
  the empty string).
- Table structure: a real `<table>` with `<tbody><tr>` rows - several specs use
  `table.locator('tbody tr', { hasText })` and `tbody tr td:not(.animate-pulse)`.
- Skeleton cells carry `animate-pulse`.
- Row-scoped `[title*="Contact"], [aria-label*="Contact"]` probes exist; today the only titled
  in-row control is `Schedule walkthrough`.
- Empty-state text `No results found.`
- Export menu item text: `Current page (N rows)`, `All (N)`, label `Export as CSV`.

**`/leads/new` and `/leads/:id/edit`**
- `role=heading` matching `/New Lead|Edit Lead/`; `role=button` matching
  `/Create Lead|Save Changes/`, and `Cancel`.
- Field labels used for structural lookup (`getByText(label).locator('xpath=..')`):
  `First Name *`, `Last Name`, `Phone`, `Email`, `Company Name`, `Service Request *`, `Notes`,
  `Job Type`, `Source`, `Assign to`, `Location`, `Address`, `Unit`, `City`, `State`, `ZIP`,
  `Start Date`, `Start Time`, `End Date`, `End Time`, `Schedule`.
- Placeholders: `Search...` (the five contact inputs), `Describe the service needed...`,
  `Internal notes...`, `Start typing an address...`, `New job type (press Enter or Add)`,
  `Select...` / `Select type...` / `Select source...`, `Select a service location`,
  `Select time…`.
- `input[maxlength="2"]` is used to target the State field.
- DOM ids that must survive: `phone`, `email` (focused by the duplicate dialog's Edit actions),
  and `pal-address-line1` / `pal-address-line2` / `pal-city` / `pal-state` / `pal-zip`.
- Post-create URL shape `/leads/<uuid>` (`waitForURL(/\/leads\/[a-f0-9-]+$/)`).

**`/leads/:id`**
- `role=heading level=1` = `Lead from {First} {Last}`.
- `role=tab` names: `Overview`, `Walkthrough`, `Estimates`, `Attachments`, `Tasks` (specs match
  `/Walkthrough/` and `/Estimates/` as regexes because of the dot and the count).
- `role=button` names: `Edit`, `Assign`, `Reassign`, `Mark Lost`, `Cancel Lead`, `Delete`,
  `Create Job`, `Create Estimate`, `+ New Estimate`, `Mark Contacted`, `Cancel Walkthrough`,
  `Enable Walkthrough`, `Schedule Walkthrough`, `Complete Walkthrough`, `Save Notes`.
- Dialog titles: `Mark Lead as Lost`, `Cancel Lead`, `Delete Lead`, `Mark as Contacted`,
  `Cancel Walkthrough`, `Create job from estimate`, `Possible Duplicate Customer`,
  `Tax Rate Change`.
- Dialog placeholders: `Why was this lead lost?`, `Why is this lead being cancelled?`,
  `Why is this walkthrough being cancelled?`, `Brief note about the contact...`,
  `Walkthrough notes...`, `Search tags...`, `Search team members...`, `Add performer...`.
- IconRail: `button[title="Activity"]`, `button[title="Attachments"]`, and the CSS-class
  locators `.fixed.right-0.w-10` (rail) and `.fixed.right-10.w-80` (panel) - both are used
  directly by `frontend/e2e/pages/lead-detail-v2.page.ts`, so the class strings are load-bearing.
- `.rounded-xl.bg-white` first match is the "hero card" in `lead-detail.page.ts`; the v2 page
  object uses `main .rounded-xl` first match. Status badge is located as
  `.inline-flex.items-center.rounded-full` (v1) and `.rounded-full.border` (v2).
- Tag pills are located as `span` with `.inline-flex.items-center.rounded-full.text-white`.
- `input[type="datetime-local"]` first match = the walkthrough scheduler (and the contact dialog).
- `role=combobox` is used generically for the Radix selects.

### 9.3 Spec files that touch leads

| File | Kind | Leads coupling |
|---|---|---|
| `frontend/e2e/specs/leads-list.spec.ts` | UI | heading, 3 KPI labels, search placeholder, `table`, `New Lead` -> `/leads/new` |
| `frontend/e2e/specs/leads-create.spec.ts` | UI | `LeadsListPage` + `LeadFormPage` page objects, URL `/leads/<uuid>`, `h1` in `main`, service-request text, list search + `getRowByText` |
| `frontend/e2e/specs/leads-edit.spec.ts` | UI | `Edit` button, `/leads/*/edit` URL, `Service Request *` textarea via `xpath=..`, submit, walkthrough tab + notes |
| `frontend/e2e/specs/leads-detail.spec.ts` | UI | `h1` contains `Lead from`, KPI labels, `Edit`/`Assign`, `Estimates`/`Walkthrough`/`Notes` tabs, `No estimates yet.` |
| `frontend/e2e/specs/leads-actions.spec.ts` | UI | status dropdown by CSS, tag create/remove, notes tab, assign dialog, `Mark Lead as Lost` flow |
| `frontend/e2e/specs/wt-leads-list.spec.ts` | UI | `tbody tr td:not(.animate-pulse)`, `thead th` matching `/Walkthrough/i`, `Filter` button + `role=menuitem`, row contact probes, `role=dialog` + `input[type=datetime-local]` |
| `frontend/e2e/specs/wt-lead-detail-render.spec.ts` | UI | `LeadDetailV2Page`: 3 tabs, hero card, IconRail class locators, `data-state`/`aria-selected`, panel open/close |
| `frontend/e2e/specs/wt-lead-cancel.spec.ts` | UI | `Cancel Walkthrough` button, `role=dialog` + first textarea/input, screenshot text assertions |
| `frontend/e2e/specs/wt-lead-lifecycle.spec.ts` | UI | `datetime-local`, `Schedule Walkthrough`, `select, [role=combobox]`, `WT Scheduled` / `WT Completed` text, `Completed on` banner |
| `frontend/e2e/specs/wt-status-badge.spec.ts` | UI | badge text `Contacted`, `/WT Scheduled/`, `/WT Completed/` + colour-class regexes |
| `frontend/e2e/specs/visual-screenshots.spec.ts` | UI | `/leads`, `table tbody tr` first row click |
| `frontend/e2e/specs/redesign/00-render-safety.spec.ts` | UI | nav sweep entry `{ label: 'Leads', path: '/leads' }`; `main` non-empty; `getByTestId('error-boundary-fallback')` count 0 |
| `frontend/e2e/specs/redesign/07-estimate-form.spec.ts` | UI | `/leads/:id`, `heading /lead from/i`, `WT Completed` text, `Create Estimate` button |
| `frontend/e2e/specs/workflow/01-lead-lifecycle.spec.ts` | **API only** | no DOM. Asserts `lead_number` matches `/^L\d{5}$/`, statuses, HTTP codes |
| `frontend/e2e/specs/workflow/redesign-13-lead.spec.ts` | **API only** | no DOM. Asserts error strings incl. `Location locked — lead has estimates`, `Cannot cancel a won lead`, `Lead has estimates — cancel or mark lost instead`. Two tests are `test.fixme` |
| `workflow/redesign-29-entrypoints`, `redesign-22-rbac`, `redesign-24-tenancy`, `redesign-21-duplicate-guard`, `redesign-26-probes-intake-sell`, `redesign/05-estimate-ui-drift`, `sched-feature-edge-cases` | API only | `/api/leads` REST + one network wait on a `PATCH /api/leads/` |

Because the API-only specs have zero DOM coupling, **a v2 page cannot break them** - a useful
safety net. The UI specs above are the ones the v2 work must not regress on the OLD pages
(which stay untouched) and should aim to satisfy on the new ones.

### 9.4 Stale selectors already broken against current source

The audit verified each page-object and spec selector against the live source. The following are
**already stale today** - they target text that no longer exists. Do NOT design the v2 pages to
satisfy them, and do NOT "restore" the old copy to make them pass.

`frontend/e2e/pages/lead-detail.page.ts`:
| Stale | Current source |
|---|---|
| `getByPlaceholder('Type to search...')` (L83, L98) | `TagInput.tsx:150` -> `Search tags...` |
| `button hasText 'Create "<name>"'` (L102) | `TagInput.tsx:187` -> `Create new tag "<name>"` |
| `getByPlaceholder('Add a note...')` (L136) | not on the page; only in `ActivityPanel.tsx:128` (the IconRail slide-out) |
| `clickTab('Notes')` + `getByRole('button',{name:'Add Note'})` (L132-139) | **there is no Notes tab** - tabs are Overview / Walkthrough / Estimates (N) / Attachments / Tasks |
| `getByPlaceholder('Notes from the walkthrough...')` (L171) | `LeadDetailPage.tsx:349,414,523` -> `Walkthrough notes...` |
| `getByRole('button',{name:'Save Walkthrough'})` (L177) | -> `Save Notes` (and only when `canPerformWalkthrough && notes changed`) |
| `clickTab('Details')` + `text=Assigned to:` (L185-187) | no `Details` tab; the string `Assigned to:` does not exist in `frontend/src` |
Still valid there: `.rounded-xl.bg-white` hero, `Edit` / `Assign` / `Mark Lost` buttons,
`waitForURL(/\/leads\/.*\/edit/)`, `input[type="datetime-local"]`.

`frontend/e2e/pages/lead-form.page.ts`:
| Stale | Current source |
|---|---|
| `Last Name *`, `Phone *`, `Email *` (L46, L50, L55) | `PickOrCreateCustomer` renders `Last Name`, `Phone`, `Email` with **no asterisk** - only First Name gets one |
| `City *` (L67), `ZIP *` (L69) | `PickOrAccreteLocation` only adds `*` when `required` is passed, and `LeadFormPage` does not pass it -> `City`, `ZIP` |
| `getByPlaceholder('Start typing an address...')` (L62) | the address input is `AddressAutocomplete` (default placeholder is still `Start typing an address...`, but only when the Google key is unset does it degrade to a plain Input); the label-based path around it is what changed |
Still valid: `First Name *`, `Describe the service needed...`, `input[maxlength="2"]`,
`Service Request *`, headings `New Lead` / `Edit Lead`, buttons `Create Lead` / `Save Changes`.

`frontend/e2e/specs/leads-detail.spec.ts`:
| Stale | Current |
|---|---|
| `getByText('Est. Value')` (L34) | KPI label is `Estimated Value`; `Est. Value` exists only as a CSV header |
| `getByText('Lead Information')` (L48) | string absent; the Overview heading is `Service Request` |
| `getByText('Scheduled Date/Time')` (L56) | absent; the form label is `Date & Time`, the read-only label is `Scheduled:` |
| `getByRole('tab', {name:/Notes/})` + `Add a note...` (L59-60) | no Notes tab |
| test title says "all 4 tabs" | there are 5 |
Still valid: `Lead from`, `Days Open`, `Source`, `Edit`, `Assign`, `/Estimates/` tab,
`No estimates yet.`, `Walkthrough` tab.

`frontend/e2e/specs/leads-actions.spec.ts`:
| Stale | Current |
|---|---|
| `getByText('Assign Lead')` (L87) | `AssignLeadDialog` was replaced by `AssignLeadPopover` (#361); there is no such title. The popover shows `Search team members...` and a `Notify` heading |
| `getByRole('combobox')` (L90) / `getByRole('option')` (L94) | the popover uses a plain search `input` plus `role="listbox"` / `role="option"` - `option` still resolves, `combobox` does not |
| `getByRole('button',{name:'Assign'}).nth(1)` (L100) | there is one trigger and one confirm; `.nth(1)` is fragile |
| `getByText('Assigned to:')` (L106) | string absent from `frontend/src` |
| `clickTab('Notes')` (L74) / `clickTab('Details')` (L104) | neither tab exists |
| `Type to search...` / `Create "<name>"` (L23-58) | see the TagInput rows above |
Still valid: `Mark Lead as Lost`, `Why was this lead lost?`, `Mark Lost`.

`frontend/e2e/specs/leads-list.spec.ts`:
| Stale | Current |
|---|---|
| `getKpiLabel('Won This Month')` (L15) | the five KPI labels are `Total Leads`, `New This Week`, `Unassigned`, `Won`, `Lost` |
Also note `getKpiLabel` uses `getByText(label, { exact: true })`, so `'Won'` is ambiguous in
Playwright strict mode against status text in table rows. A v2 page should give the KPI label a
more specific hook.

**Verified NOT stale** (must be preserved): the `LeadDetailV2Page` IconRail locators
`.fixed.right-0.w-10`, `.fixed.right-10.w-80`, `button[title="Activity"]`,
`button[title="Attachments"]`; `/Cancel Walkthrough/i`, `/Schedule Walkthrough/`,
`/Complete Walkthrough/`; `Search leads...`; `New Lead`; `Export`; the `<h1>Leads</h1>`;
`thead th` matching `/Walkthrough/i`; `Filter` and `Done` in `FilterBar`;
`heading{name:'New Lead'}`; and `aria-label="Schedule walkthrough"`.

### 9.5 Vitest unit tests (must stay green)

| File | Renders | Notable queries |
|---|---|---|
| `frontend/src/__tests__/leads-page.test.tsx` | `<LeadsPage>` via `renderWithProviders` + a `LocationProbe` | `getByText('Leads')`; the five KPI labels `Total Leads`/`New This Week`/`Unassigned`/`Won`/`Lost`; `John Doe`; `AC not cooling`; `New Lead`; `Export`; `getByPlaceholderText('Search leads...')`; asserts `api.get('/api/leads', { params: objectContaining({ page:1, limit:25 }) })`; `getByRole('button',{name:/^filter$/i})`; `getByRole('checkbox',{name:'Won'})`; `getByRole('tab',{name:/estimates/i})`; **`getByLabelText('# of Estimates From')` / `('# of Estimates To')`**; `getByRole('button',{name:/^done$/i})`; probes `status=WON`, `estimates_min=1`, `estimates_max=3` in the URL; `getByRole('button',{name:/won/i})` for the KPI toggle |
| `frontend/src/__tests__/leads-page-schedule-action.test.tsx` | `<LeadsPage>` at `/leads`, plus a `/leads/:id` probe route | `getByText('L00001')`, `getByText('L00002')`; **`getAllByRole('link',{name:'Schedule walkthrough'})` length 1**; `toHaveAttribute('href','/leads/lead-contacted-1?tab=walkthrough')`; clicking it navigates to that URL |
| `frontend/src/__tests__/lead-detail-page.test.tsx` | `<LeadDetailPage>` with `useParams` mocked and `JobLeadTasksTab` stubbed | tab names `Overview`/`Walkthrough`/`Attachments`/`/Estimates \(\d+\)/`/`/^Tasks$/`; KPI labels `Estimated Value`, `Days Open`, `Source`; buttons `Edit`, `Assign`, `Mark Lost`, `Create Estimate`, `Mark Contacted` (with `queryByText` null variants per ability); `No estimates yet.`; `Lead not found.`; `findByRole('button',{name:/Create Job/i})` -> `findByRole('dialog')` -> asserts `POST '/api/jobs' { estimate_id }`; `aria-selected` on the Walkthrough/Overview tabs; `Complete Walkthrough`, `Save Notes`; `getByPlaceholderText('Walkthrough notes...')` enabled/disabled by ability; asserts the URL no longer contains `tab=walkthrough` after the effect strips it. **Comment at L153-156 records that the Notes tab and its `Add a note...` textarea were removed and those tests deleted.** |
| `frontend/src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx` | the dialog directly, `react-router-dom` fully mocked | `/no estimates yet/i`; `getByRole('button',{name:/create job/i})` disabled/enabled; `/no approved estimate to convert yet/i`; `getByRole('button',{name:/J00007/i})` -> `navigate('/jobs/job-7')` + `onOpenChange(false)`; `/new estimate/i` -> `navigate('/estimates/new?lead_id=lead-1')`, and null when `canCreateEstimate={false}`; `onConvert('e1')` |
| `frontend/src/__tests__/list-status-defaults.test.tsx` | `<LeadsPage>` among four list pages | **no DOM queries** - only asserts `api.get('/api/leads', objectContaining({ params: objectContaining({ status: undefined }) }))`. This is the test that forces the `listParams` placeholder keys described in §2.4. |

The only `data-testid` any leads test uses is `location-probe`, which the tests define themselves
(`leads-page.test.tsx:39`, `leads-page-schedule-action.test.tsx:54`, `lead-detail-page.test.tsx:408`).
The only testid reachable while on a leads route is `error-boundary-fallback`
(`frontend/src/components/ErrorBoundary.tsx:25`), which wraps every route.

### 9.6 Accessible hooks that already exist in source (the closest thing to testids)

| Hook | File |
|---|---|
| `aria-label="Schedule walkthrough"` | `LeadsPage.tsx:103` - the only aria hook on the list |
| `title="Activity"` / `title="Attachments"` | `IconRail.tsx:66` |
| `role="tablist"`, `aria-label="Filter facets"`, `role="tab"` | `FilterBar.tsx:135-146` |
| `aria-label="{facet.label} From"` / `"... To"` | `filters/controls/RangeFacet.tsx:84,95` (relied on by `leads-page.test.tsx`) |
| `role="listbox"`, `role="option"`, `aria-label` per notify channel, `aria-label="By SMS"` | `AssignTeamPopover.tsx:134,145,191,198` |
| `aria-label="Sort tags"` | `TagInput.tsx:134` |
| `aria-label="Remove {name}"` | `MultiAssigneeSelect.tsx:98` |
| `aria-label="Copy phone number"` / `"Copy email address"` | `ContactCell.tsx:19` |
| `role="separator"` + `aria-orientation="vertical"` | `data-table.tsx:617` (column resizer) |
| `aria-sort` on sortable headers | `data-table.tsx:731` |
| `aria-expanded` on the Filter trigger | `FilterBar.tsx:107` |

---

## 10. Reimplementation checklist (what "no logic drift" means here)

1. Keep the `listParams` object literal's full key set on `/leads`, including the `undefined`
   placeholders.
2. Keep `placeholderData: keepPreviousData` on the list query - it is what prevents a skeleton
   flash between pages.
3. Keep every query key byte-identical: `['leads', {page,pageSize,search,sortBy,sortDir,value}]`,
   `['lead', id]`, `['customers']`, `['customer-prefill', id]`, `['customers-search', v]`,
   `['organization']`, `['users','assignable',dept,eligible,referenced]`, `['tags']`,
   `['notes','LEAD',id]`, `['attachments','LEAD',id]`, `['table-views','leads']`, `['jobs']`.
4. Keep both optimistic `walkthrough_needed` toggles, including the duplicated declaration.
5. Keep the create-form duplicate flow exactly: await-then-swap ordering, the ad_source and
   address snapshots, `openingExisting` double-click guard, and `isOverriding`'s composition.
6. Keep `LeadDetailPage`'s status list verbatim, bug and all (§7.1).
7. Keep the empty-state copy identical for "nothing exists" and "nothing matches" (`No results found.`).
8. Keep the DOM ids `phone`, `email`, and the `pal-*` address ids.
9. Keep the `title`/`aria-label` `Schedule walkthrough` on the list's first-column link and its
   `stopPropagation`.
10. Keep `?tab=` whitelisted to `walkthrough` and keep both query params being stripped with
    `{ replace: true }`.
11. Do not add client-side ownership filtering, error boundaries, or filter-aware empty states -
    all three would be behaviour changes.
12. Keep the sortable set exactly `lead_number`, `status`, `created` and keep sending the column
    `id` as `sortBy`, even though two of the three do not sort server-side (§11.2).
13. Keep `aria-label="{facet.label} From"` / `"... To"` on the range facet inputs - a vitest test
    queries `# of Estimates From` / `# of Estimates To` by label.
14. Keep `getAllByRole('link', { name: 'Schedule walkthrough' })` resolving to exactly one link on
    the schedule-action fixture, and keep the href shape `/leads/:id?tab=walkthrough`.
15. Do not assume the `L` prefix or a 5-digit width when rendering `lead_number` - both are
    per-organization columns (§11.8).
16. Keep `parseFloat(String(e.total_amount || '0'))` in the estimate-total reduce; `total_amount`
    is stripped from the payload for callers without `read Estimate` (§11.7).
17. Keep the KPI labels exactly `Total Leads`, `New This Week`, `Unassigned`, `Won`, `Lost` -
    but consider giving them a more specific selector hook, since `Won` is ambiguous under
    Playwright strict mode against status text in the rows (§9.4).

---

## 11. Backend contract (for reference - do not change)

Read from `backend/src/routes/lead.routes.ts`, `backend/src/controllers/lead.controller.ts`
(2095 lines), `backend/src/lib/query/registries/lead.filters.ts`,
`backend/src/lib/permissions/{defaultGrants,catalog,scopeWhereFor,enforce,userCapabilities}.ts`,
`backend/src/lib/numbering.ts`, `backend/prisma/schema.prisma`.

### 11.1 Route table

Router-level: `router.use(authenticate, attachAbility)`. **No `requireFeature` anywhere.**

| Method | Path | Guard `canDo(action,'Lead')` | Schema |
|---|---|---|---|
| GET | `/stats` | `read` | - |
| GET | `/export` | `read` (+ `expensiveLimiter`, 15 req/60 s) | - |
| GET | `/` | `read` | - |
| POST | `/` | `create` | `createLeadSchema` |
| GET | `/:id` | `read` | - |
| PATCH | `/:id` | `update` | `updateLeadSchema` |
| DELETE | `/:id` | `delete` | - |
| GET / POST | `/:id/notes` | `read` / `update` | `createLeadNoteSchema` |
| POST | `/:id/assign` | `assign` | `assignLeadSchema` |
| POST | `/:id/contact` | `contact` | `contactLeadSchema` |
| POST | `/:id/mark-lost` | `mark_lost` | `markLostSchema` |
| POST | `/:id/cancel` | `cancel` | `cancelLeadSchema` |
| POST | `/:id/walkthrough` | `perform_walkthrough` | `walkthroughSchema` |
| POST | `/:id/walkthrough/schedule` | `schedule_walkthrough` | `scheduleWalkthroughSchema` |
| POST | `/:id/walkthrough/performers` | `schedule_walkthrough` | `setPerformersSchema` |
| POST | `/:id/walkthrough/unschedule` | `schedule_walkthrough` | none |
| POST | `/:id/walkthrough/complete` | `perform_walkthrough` | none wired |
| POST | `/:id/walkthrough/cancel` | **`cancel`** | `cancelWalkthroughSchema` |
| POST | `/:id/tags` | `update` | `addTagToEntitySchema` |
| DELETE | `/:id/tags/:tagId` | `update` | none |

Two guard notes: there is **no `export Lead` action in the catalog**, so `/export` runs on
`read`; and `walkthrough/cancel` runs on the lead-level `cancel`, not `schedule_walkthrough`.

### 11.2 `GET /api/leads` contract

Response is exactly `{ leads, pagination, stats }`.
`pagination = { page, limit, total, totalPages }`; `stats = { total, new_this_week, unassigned, won, lost }`.

- `page` default 1; `limit` default 25 and **hard-capped at 100**.
- `sortBy` allow-list is **`['created_at','status']`**; anything else silently falls back to
  `created_at`. `sortDir` `'asc'|'desc'`, default `'desc'`.
  **Consequence for the UI:** the list marks three columns sortable - `lead_number`, `status`,
  `created` - and sends the column `id` as `sortBy`. Only `status` is in the allow-list.
  `sortBy=lead_number` and `sortBy=created` both fall back to `created_at` (the latter looks
  correct by accident; the former silently does not sort by lead number). Preserve as-is and
  file separately.
- A separate `sort=source` + `order` path exists for ordering by `customer.ad_source`, but the
  frontend only ever sends `sortBy`/`sortDir`, so that path is unreachable from the UI.
- **There is no "open pipeline" default.** With no params the list returns leads in every status,
  including WON/LOST/CANCELLED. (`OPEN_LEAD_STATUSES` exists only in `customer.controller.ts`.)
- `stats` is computed with tenant + row-scope only - **it ignores the request's filters and
  search**, so the KPI numbers are scope-wide totals while `pagination.total` is filter-aware.
  `new_this_week` uses server-local Sunday 00:00. `stats.unassigned` has no status restriction.
- `search` produces an OR over `service_request`, `customer.first_name`, `customer.last_name`,
  `customer.company_name`, and phone-normalised clauses - merged with `addOrFilter` so it can
  never clobber a row-scope `OR`.

`GET /api/leads/export` accepts the identical filter params, ignores pagination and sorting,
orders `created_at desc`, caps at 50 000 rows (silent truncation), returns **`{ leads }` only -
no `pagination`, no `stats`, and no `tags`**, and writes a `lead.exported` audit row.

> **Divergence to know about:** `GET /api/leads/stats` (a route the leads UI does NOT call)
> returns a different shape: `{ total, new_this_week, unassigned, won_this_month, lost_this_month }`,
> with `unassigned` restricted to the open-pipeline statuses. Do not confuse the two.

### 11.3 Facet -> Prisma mapping (`lead.filters.ts`)

`leadFacets(scopeWhere)` is a function of the request scope. Applied in array order.

| Facet | Produces |
|---|---|
| `status` | drops values not in the `LeadStatus` enum first (guards a Prisma 500), then `status: v` or `{ in: [...] }`; zero valid values is a no-op |
| `job_type` | `job_type: v \| { in: [...] }` |
| `ad_source` | merges into `where.customer.ad_source` |
| `walkthrough_status` | **only `'needs_scheduling'` is recognised.** Sets `walkthrough_needed: true`, `walkthrough_scheduled_at: null`, and - only when no `status` filter is already present - `status: { in: [NEW, CONTACTED, WALKTHROUGH_COMPLETED] }`. The other three UI options (`scheduled`, `completed`, `not_needed`) are complete no-ops |
| `assigned_to` | **security gate first:** `if (scopeWhere.lead_assignees !== undefined) return;` - a row-scoped user's `?assigned_to=` is entirely ignored. Then `UNASSIGNED` -> `lead_assignees: { none: {} }` (short-circuits; other ids ignored), else `lead_assignees.some.user_id` |
| `customer_id` | `customer_id: v \| { in: [...] }` (a real backend facet, intentionally absent from the UI registry - driven by page-to-page navigation) |
| `created` | merges `created_at: { gte?, lte? }` |
| `estimates` | `groupBy` on `estimate.lead_id` with a `having _count` clause; `min` -> `id: { in }`, `max` -> complement `id: { notIn }` so `max=0` correctly keeps zero-estimate leads. Merged onto `where.AND` so it never clobbers a MATCH_NOTHING `id` |

### 11.4 Ownership scoping - the exact condition

`backend/src/lib/permissions/defaultGrants.ts:6`:
```ts
const OWN_LEAD = { lead_assignees: { some: { user_id: '{{userId}}' } } } as const;
```
`backend/src/lib/permissions/defaultGrants.ts:12`:
```ts
const OWN_WALKTHROUGH = { walkthrough_performers: { some: { user_id: '{{userId}}' } } } as const;
```

`scopeWhereFor` derives the SQL scope from the **`read`** grants only:
ADMIN -> `{}`; no read grant -> `MATCH_NOTHING = { id: { in: [] } }`; any unconditional read ->
`{}`; one conditional read -> that condition with `{{userId}}` substituted; several -> `{ OR: [...] }`.

So a SALES request produces literally
`{ lead_assignees: { some: { user_id: '<sales-user-id>' } } }`, applied as the OUTERMOST spread in
`buildLeadListWhere` so no filter can overwrite it. Per-row access uses `canAccessRow(...)`, a SQL
probe rather than `ability.can()` - the comment in `enforce.ts:145-150` explains that CASL throws
`"equals does not supports comparison of arrays and objects"` on this nested condition, which is
exactly the same reason `canOnJob` exists on the frontend. **This is why the leads UI must not
attempt an instance-level Lead check.**

`canAccessRow` is called in `getById`, `update`, `remove`, `assign`, `updateWalkthrough`,
`contactLead`, `scheduleWalkthrough`, `setPerformers`, `unscheduleWalkthrough`,
`cancelWalkthrough`, `cancelLead`, `markLost`, `getNotes`, `addNote`. It is **not** called in
`completeWalkthrough` (which has its own performer check) or in the tag handlers (tenant check only).

### 11.5 Role defaults for the Lead subject

The catalog (`catalog.ts:38-47`) has exactly 10 Lead actions: `create`, `read`, `update`,
`delete`, `assign`, `contact`, `mark_lost`, `cancel`, `schedule_walkthrough`,
`perform_walkthrough`. **There is no `export Lead`.**

| Action | ADMIN | SALES | DISPATCHER | TECHNICIAN |
|---|---|---|---|---|
| `create` | yes (manage all) | yes, **unconditional** | yes | no (per-user toggle) |
| `read` | yes | `OWN_LEAD` | yes | `OWN_WALKTHROUGH` |
| `update` | yes | `OWN_LEAD` | yes | no (per-user toggle) |
| `delete` | yes | `OWN_LEAD` | yes | no |
| `assign` | yes | **no grant at all** | yes | no |
| `contact` | yes | `OWN_LEAD` | yes | no |
| `mark_lost` | yes | `OWN_LEAD` | yes | no |
| `cancel` | yes | `OWN_LEAD` | yes | no |
| `schedule_walkthrough` | yes | `OWN_LEAD` | yes | no |
| `perform_walkthrough` | yes | `OWN_LEAD` | yes | `OWN_WALKTHROUGH` |

Only `create Lead` and `update Lead` are admin-grantable per-user (both fixed to `OWN_LEAD`, with
`impliesRead: true` so the SQL scope and CASL agree).

Reconciliation with the UI gates in §6:
- SALES has no `assign Lead`, so hiding the `Assign to` select and the `Assign`/`Reassign` buttons
  behind `can('assign','Lead')` matches the API exactly.
- A strict TECHNICIAN sees the detail page only for leads where they are a walkthrough performer,
  and holds only `perform_walkthrough` - matching the split gates in the walkthrough tab.
- **TagInput has no UI gate but the API requires `update Lead`** - a read-only or technician user
  sees the `+ Tag` control and the pill `X` buttons, and every click 403s silently (the mutations
  have no error UI). Reproduce as-is; log as a bug.

### 11.6 Status transition guards (server-enforced)

| Endpoint | Guard | Error |
|---|---|---|
| `POST /:id/contact` | status must be exactly `NEW` | 400 `Can only mark NEW leads as contacted` |
| `POST /:id/walkthrough/schedule` | status in `{CONTACTED, WALKTHROUGH_COMPLETED, WALKTHROUGH_SCHEDULED}` | 400 `Walkthrough can only be scheduled from CONTACTED or WALKTHROUGH_COMPLETED status` (message omits the reschedule case) |
| `POST /:id/walkthrough/complete` | status must be `WALKTHROUGH_SCHEDULED` | 400 `Can only complete a scheduled walkthrough` |
| `POST /:id/walkthrough/cancel` | status must be `WALKTHROUGH_SCHEDULED` | 400 `Can only cancel a scheduled walkthrough` |
| `POST /:id/walkthrough/unschedule` | status must be `WALKTHROUGH_SCHEDULED` | 400 `Can only unschedule a scheduled walkthrough` |
| `POST /:id/mark-lost` | status not in `{LOST, WON, CANCELLED}` | 400 `Cannot mark a {status} lead as lost` |
| `POST /:id/cancel` | status not in `{WON, LOST, CANCELLED}` | 400 `Cannot cancel a {status} lead` |
| `PATCH /:id` | `walkthrough_needed:false` while `WALKTHROUGH_SCHEDULED` | 400 `Cannot disable walkthrough while one is scheduled. Cancel the walkthrough first.` |
| `PATCH /:id` | any location field while estimates exist | 400 `Location locked — lead has estimates` |
| `PATCH /:id` | SALES role | `data.status` is **silently deleted**, not rejected |
| `PATCH /:id` | any other role | `status` is a **free-form write** to any `LeadStatus` - no transition allow-list |
| `DELETE /:id` | any estimate | 400 `Lead has estimates — cancel or mark lost instead` |
| `DELETE /:id` | any non-voided payment | 400 `Lead has recorded payments — cannot delete` |

The list page's `WALKTHROUGH_SCHEDULABLE_STATUSES` matches the schedule allow-list exactly - keep
them in step.

`POST /:id/walkthrough/complete` uses a **different permission model** from every other handler:
```ts
if (!req.ability!.can('manage','all') && !existing.walkthrough_performers.some(p => p.user_id === req.user!.id)) {
  res.status(403).json({ error: 'Only the assigned performer, Admin, or Dispatcher can complete this walkthrough' });
```
So only ADMIN or an actual assigned performer may complete. Despite the message text, a DISPATCHER
who is not a performer is rejected, as is a SALES owner who is not a performer - **yet the UI shows
them the `Complete Walkthrough` button** (it only checks `can('perform_walkthrough','Lead')`).
Preserve the current gate; log the mismatch.

### 11.7 Payload / response details the UI depends on

- `POST /api/leads` body is `createLeadSchema` with an XOR refinement:
  `Boolean(customer_id) !== Boolean(new_customer)`, plus `hasPhoneOrEmail` on `new_customer`
  (issue path `['phone']`) - which is exactly why the frontend's `superRefine` also targets
  `['phone']`.
- **`override` is a query param, not a body field**: `POST /api/leads?override=true`. Matches the
  frontend.
- Duplicate response is exactly `409 { error: 'duplicate', existing: <customer> }` - matches
  `getDuplicateCustomer`'s narrowing (`status === 409 && data.error === 'duplicate' && data.existing`).
- **Owner resolution is a role literal, not an ability check**:
  `const assigned_to = req.user?.role === 'SALES' ? req.user.id : (body.assigned_to ?? undefined)`.
  SALES always self-assigns and its `assigned_to` is silently ignored - consistent with the UI
  hiding the picker.
- The single owner is mirrored to BOTH `commission_owner_id` and one `lead_assignees` row, which
  is why the list column reads `commission_owner` while the `assigned_to` filter queries
  `lead_assignees`.
- `PATCH /:id` may return `{ lead, tax_warning }` when the resolved location's state differs from
  the lead's current state. **The frontend ignores `tax_warning` entirely** - it does its own
  client-side state-change detection and shows `TaxWarningDialog` BEFORE submitting.
- `POST /:id/assign` body is `{ assigned_to: uuid | null, notify?: { in_app?: boolean } }` -
  `assigned_to` is required and `null` clears the owner. The UI always sends `ids[0]`, so it can
  never clear an owner through this control.
- `POST /:id/walkthrough` **accepts but ignores** `walkthrough_scheduled_at` and
  `walkthrough_completed_at`; only notes and duration are written, and `null` is a no-op rather
  than a clear.
- `POST /:id/walkthrough/schedule` can return **`409 { error: 'Schedule conflict detected', conflicts: [...] }`**
  unless `force: true` is sent. **The frontend never sends `force` and has no conflict UI** - the
  409 surfaces through `extractApiError` as the bare string `Schedule conflict detected`.
  `send_email` defaults to `true` and the frontend never sends it.
- `mark-lost` and `cancel` both cascade: they auto-cancel a scheduled walkthrough, archive
  `DRAFT/SENT/PENDING` estimates, and void unpaid `DEPOSIT` invoices. The frontend only
  invalidates `['lead', id]` and `['leads']`, so any cached estimate/invoice list elsewhere goes
  stale.
- Embedded `estimates[]` have their monetary fields (`total_amount`, `subtotal`, `tax_amount`,
  `discount_amount`, `deposit_amount`) **deleted in place** when the caller lacks
  `read Estimate`. The detail page's `estimateTotal` reduce uses
  `parseFloat(String(e.total_amount || '0'))`, so it degrades to 0 rather than NaN - keep that
  coercion.
- Every lead-mutating handler returns the full detail object under `{ lead }` (exceptions:
  `DELETE` -> 204; notes -> `{ note }` / `{ notes }`; tags -> `{ tag }` / 204; export -> `{ leads }`).
  The frontend currently ignores these bodies and refetches instead - keep it that way.
- Errors are always `{ error: <string> }`, plus `details[]` for zod, `existing` for the duplicate
  409, and `conflicts` for the schedule 409. There is no `code` field. `extractApiError` prefers
  `details[]` (rendered as `field: message; ...`) over `error`.

### 11.8 Numbering (`backend/src/lib/numbering.ts`)

`allocateNumber(tx, 'lead', orgId)` runs a single atomic `UPDATE ... RETURNING` on the
`organizations` row, which takes an exclusive row lock for the duration of the transaction, so
concurrent allocations for one org serialize. It self-heals with
`GREATEST(lead_next_number, COALESCE(MAX(numeric suffix of leads.lead_number), 0) + 1)` so a drifted
counter cannot hand back a used number. It returns
`` `${lead_prefix}${String(next_value - 1).padStart(number_padding, '0')}` ``, i.e. `L` + 5 digits ->
`L00001` by default. Both the prefix and the padding are **per-organization columns**, so
`BG-0042` is equally valid - **the UI must not assume the `L` prefix or a 5-digit width.**
Called inside the create transaction (`lead.controller.ts:795` and `:886`).

### 11.9 Lead -> Estimate -> Job

- **There is no `POST /api/leads/:id/estimates` and no convert endpoint.** Estimates are created
  by `POST /api/estimates { lead_id, line_items, ... }`, guarded by
  `canDo('create','Estimate')`, 400 `Cannot create estimate for a {status} lead` for terminal
  leads, and 403 for a row-scoped creator who does not own the parent lead. Estimate creation is
  deliberately NOT blocked on the walkthrough (bug #39) - that requirement moved to
  `POST /api/estimates/:id/send`, which 400s with
  `Complete the walkthrough before sending this estimate.` when the org AppSetting
  `require_walkthrough_before_send` is `'true'`, the lead needs a walkthrough, and it is not
  complete. First send moves the lead `NEW|CONTACTED|WALKTHROUGH_COMPLETED -> ESTIMATED`.
- **Lead -> Job** is `POST /api/jobs { estimate_id }`, with guards in order: 404
  `Estimate not found`; 403 for a row-scoped creator not owning the parent lead; 400
  `Estimate must be WON to create a job`; and 400
  `Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.`
  when a `kind: 'DEPOSIT'` invoice exists whose status is not in
  `{PAID, VOIDED, PARTIALLY_REFUNDED, REFUNDED}`. **No deposit invoice means no gate.** Creation is
  idempotent on the unique `estimate_id`. **Creating a job does not change the lead's status** - it
  is already `WON`. This deposit 400 is exactly the failure the page's `createJobMutation.onError`
  toast is written for.

---

## 12. Open questions

1. **`approvedEstimate` is dead code** (`LeadDetailPage.tsx` line 714). It is computed with a
   comment tying it to bug #12 but never read - `canConvertToJob` is `ability.can('create','Job')`
   alone, so the `Create Job` button shows even when there is nothing convertible (the dialog then
   explains why). Intentional (dialog-explains-it) or a regression? Port as-is either way.

2. **`STATUS_LABELS` in `LeadDetailPage.tsx` (lines 84-94) is unused.** Was the dropdown meant to
   render labels rather than badges? Port as-is.

3. **`attachmentCount` is threaded three levels deep and never rendered.** Presumably a tab badge
   that was dropped. Should the v2 Walkthrough tab show it? Needs a product decision; default is
   to keep the plumbing and render nothing.

4. **Detail-page walkthrough datetime handling.** `wtScheduled` is `iso.slice(0,16)` (a UTC wall
   time) fed into a `datetime-local` input, then re-parsed with `new Date(wtScheduled)` (local).
   For any non-UTC user this shifts the value. Same class of issue in
   `EditLeadForm`'s `extractDate`/`extractTime`. Fixing it is a logic change and is out of scope
   for the UI swap - flag as a bug.

5. **`EditLeadForm` always sends `new_location`** when no existing location is picked, even if every
   address field is blank (unlike create, which guards on `hasAddress`). Whether the backend
   tolerates an all-empty `new_location` needs confirming against the controller before anyone
   "tidies" this.

6. **`createJobMutation` does not invalidate `['lead', id]`.** After converting, the lead's cached
   estimates still show `job: null`. Deliberate (you navigate away) or an oversight?

7. **The `location` column falls back to the customer's first service location, but the CSV export
   does not.** Two different definitions of "Location" for the same row. Which is correct?

8. ~~`walkthrough_status` filter options are partly inert.~~ **Confirmed against
   `backend/src/lib/query/registries/lead.filters.ts`:** only `needs_scheduling` produces a where
   clause; `scheduled`, `completed` and `not_needed` are exact no-ops that filter nothing. The
   remaining question is a product one: should the v2 page keep presenting three controls that do
   nothing? Default is yes (parity), but this deserves a decision.

9. ~~`frontend/e2e/pages/lead-detail.page.ts` appears stale.~~ **Confirmed stale**, along with
   `lead-form.page.ts`, `leads-detail.spec.ts`, `leads-actions.spec.ts` and `leads-list.spec.ts`.
   The verified list is in §9.4. Those specs are failing against the CURRENT pages, so they cannot
   be a v2 acceptance criterion. Question for the owner: fix them as part of this migration, or
   leave them and track separately?

### Newly-surfaced mismatches (found while cross-checking the backend)

10. **`Complete Walkthrough` is shown to users who will get a 403.** The UI gates on
    `can('perform_walkthrough','Lead')`, but `POST /:id/walkthrough/complete` additionally requires
    the caller to be ADMIN (`manage all`) or an actual `walkthrough_performers` row - so a
    DISPATCHER or a SALES owner who is not a performer sees the button and gets
    `Only the assigned performer, Admin, or Dispatcher can complete this walkthrough`. Port the
    gate as-is; file the mismatch.

11. **The schedule-conflict 409 has no UI.** `POST /:id/walkthrough/schedule` can return
    `409 { error: 'Schedule conflict detected', conflicts: [...] }` unless `force: true` is sent.
    The frontend never sends `force` and never reads `conflicts`, so the user sees only the bare
    string `Schedule conflict detected` with no way to proceed. Should v2 surface the conflicts and
    a force option? That would be a behaviour ADDITION - out of scope unless explicitly approved.

12. **`send_email` on walkthrough scheduling is never sent** (backend default `true`), so every
    schedule sends a customer email with no UI affordance. Intentional?

13. **`tax_warning` from `PATCH /api/leads/:id` is ignored.** The edit page does its own
    client-side state-change detection and warns BEFORE submitting; the server's post-hoc
    `tax_warning` payload is discarded. Two sources of truth for the same warning - worth a
    decision, but not for this PR.

14. **Sort-by-Lead-# does nothing.** The column sends `sortBy=lead_number`, which is not in the
    backend allow-list `['created_at','status']`, so it silently sorts by `created_at`. The
    `Created` column has the same problem (`sortBy=created`) but happens to land on the right field.
    Cosmetically the header still shows an arrow. Port as-is; file separately.

15. **`stats` never reflects the applied filters** (§11.2). The KPI numbers stay constant while the
    table filters. Existing behaviour, but it makes the KPI "active" ring the only feedback that a
    preset is applied - worth knowing when redesigning the strip.
