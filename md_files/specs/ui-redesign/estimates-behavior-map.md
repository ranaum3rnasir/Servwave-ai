# Estimates module - behaviour map (UI-kit migration, Phase 1)

Status: DRAFT for review - written 2026-07-29 against `main` @ `7dfa18e9`.
Scope: module 4 of `md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`.
Method: every claim below was read from the file cited. Nothing here is inferred from
naming. Genuine unknowns are parked in section 12 (Open questions), not guessed.

Routes covered:

| Route | Component | File |
|---|---|---|
| `/estimates` | `EstimatesPage` | `frontend/src/pages/EstimatesPage.tsx` (513 lines) |
| `/estimates/new` | `EstimateFormPage` | `frontend/src/pages/EstimateFormPage.tsx` (758 lines) |
| `/estimates/:id` | `EstimateDetailPage` | `frontend/src/pages/EstimateDetailPage.tsx` (1142 lines) |
| `/estimates/:id/edit` | `EstimateFormPage` | same file, `isEdit = Boolean(useParams().id)` |

Explicitly OUT of scope: `/p/estimates/:id` (`PublicEstimatePage.tsx`) - module 13. Shared
surface between the two is catalogued in section 11.

---

## 0. Vocabulary: EstimateStatus after the v13 rename

Verified against the LIVE schema, `backend/prisma/schema.prisma:1117-1125`:

```
enum EstimateStatus { DRAFT SENT PENDING WON DECLINED EXPIRED ARCHIVED }
```

Seven values. `APPROVED` -> `WON` and `CANCELLED` -> `ARCHIVED` landed in commit `cb3422b4`
(branch `fix/estimate-status-guard-main`, merged into `main` as PR #1035 - `git log
main..origin/fix/estimate-status-guard-main` is empty, so **main already carries the rename;
there is no pending guard fix to absorb**). CI enforces it with a job named
"EstimateStatus rename guard (no bare APPROVED/CANCELLED)" (`.github/workflows/ci.yml`).

Frontend mirror: `frontend/src/constants/estimateStatus.ts` exports
`ESTIMATE_STATUS = { DRAFT, SENT, PENDING, WON, DECLINED, ARCHIVED }` (six - it deliberately
omits EXPIRED, which has no UI).

**Discrepancy to carry forward, not to fix:** that file's JSDoc claims the Prisma enum has
"eight values" including `SUPERSEDED`. Main's schema has seven and no `SUPERSEDED` - the
rename commit message states SUPERSEDED was deliberately NOT ported to main. The comment is
stale; the constant itself is correct. Do not add SUPERSEDED handling to v2 pages.

**Rule for builders:** never write a bare `'WON'` / `'ARCHIVED'` string literal in a v2 page.
Import `ESTIMATE_STATUS`. The CI guard greps for bare `APPROVED`/`CANCELLED`; the codebase
convention (and the constants file's own docstring) is to route every estimate status through
the typed constant so `'WON'` can be told apart from `LeadStatus.WON`.

**Legacy literals that legitimately survive** (they are NOT statuses and must not be renamed):
- DB columns `approved_at`, `cancelled_at`, `cancelled_reason`, `declined_at`, `expired_at`,
  `voided_at`, `voided_reason` on `model Estimate` (schema.prisma) - all still present.
- Stats payload keys `stats.approved` and `stats.cancelled` - the backend maps
  `byStatus[WON] -> stats.approved` and `byStatus[ARCHIVED] -> stats.cancelled`
  (`estimate.controller.ts:635,637`). The API shape was NOT renamed. The page reads
  `stats.approved` for the "Won" tile and `stats.cancelled` for the "Archived" tile.
- CASL action `'cancel'` on subject `Estimate` - kept as a legacy alias alongside the new
  `'archive'` action (`backend/src/lib/permissions/catalog.ts:54-60`). The detail page gates on
  `'cancel'`; both are granted to SALES by default (`defaultGrants.ts:42-43`).
- `DepositStatus` vocabulary (`REQUESTED`/`PAID`/`VOIDED`/`REFUNDED`) on the list's Deposit
  facet - the standalone Deposit model was dissolved into a `kind=DEPOSIT` Invoice, but the
  filter still speaks the legacy words and the backend maps them
  (`lib/filters/registries/estimates.ts:51-65`).

`StatusBadge` (`components/ui/status-badge.tsx`) label + tone mapping, estimate-relevant rows:
`DRAFT -> "Draft" gray`, `SENT -> "Sent" amber`, `PENDING -> "Pending" amber`,
`WON -> "Won" green` (shared with LeadStatus.WON), `DECLINED -> "Declined" danger`,
`EXPIRED -> "Expired" amber`, `ARCHIVED -> "Archived" gray`. Unknown status falls back to
`{ label: status, className: GRAY }` - never throws. Deposit statuses:
`REQUESTED -> "Requested" amber`, `PAID -> "Paid" green`, `VOIDED -> "Voided" gray`,
`REFUNDED -> "Refunded" danger`, `PARTIALLY_REFUNDED -> "Partially Refunded" amber`.

---

## 1. Route + guards (all four routes)

`frontend/src/App.tsx:111-126`. All four estimate routes sit inside ONE block:

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />}>
  <Route element={<AppLayout />}>
    ... /estimates, /estimates/new, /estimates/:id/edit, /estimates/:id ...
```

- `ProtectedRoute` (`components/ProtectedRoute.tsx`): `isLoading` -> full-screen
  `"Loading..."`; `!isAuthenticated` -> `<Navigate to="/login" replace />`; role not in
  `allowedRoles` -> `<Navigate to="/" replace />` (no `fallback` prop here, so NO
  NotAuthorizedPage for estimates).
- **Every role passes the route guard, including TECHNICIAN.** There is no per-route
  sub-gate, no `requireFeature`, no entitlement/plan gate on any estimate route. Access
  control is entirely (a) the API's CASL `canDo(...)` per endpoint and (b) in-page
  `ability.can(...)` conditionals (section 6).
- Route order matters: `/estimates/new` is declared BEFORE `/estimates/:id`, and
  `/estimates/:id/edit` before `/estimates/:id`. Preserve that ordering in the `/v2` block.
- Routes are lazy: `App.tsx` wraps everything in `<Suspense fallback={<PageLoader />}>`.
- `AppLayout` supplies the shell (sidebar/topbar). Nav visibility is CASL-filtered elsewhere;
  a technician with no `read Estimate` grant will not see the nav item but CAN deep-link to
  `/estimates` and will get an empty/errored list from the API.

---

## 2. `/estimates` - EstimatesPage

### 2.1 Component tree

```
<div class="space-y-6">
  heading row: <FileText/> "Estimates" + total pill (rendered only when
               data.pagination.total !== undefined)
  <KpiStrip loading={isLoading} items={[7 tiles]} />       components/ui/KpiStrip.tsx
  <DataTable tableKey="estimates" ...>                     components/ui/data-table.tsx
      slot filters        -> <FilterBar registry={estimatesRegistry} .../>
      slot activeFilters  -> <AppliedChips/> + "Clear all" ghost Button   (only when
                             Object.keys(value).length > 0)
      slot headerActions  -> Export <DropdownMenu> + "New Estimate" <Button variant=business>
  </DataTable>
  <NewEstimateDialog open={showNewDialog} .../>
</div>
```

`DataTable` internally renders (same file):
- toolbar: search `<Input>` (debounced 300 ms) + `{filters}` on the left; a
  `ColumnVisibilityToggle` popover ("Columns" button) + `{headerActions}` on the right.
- `{activeFilters}` strip.
- **desktop branch** (`!useIsMobile()`): a `<table class="table-fixed">` in a scroll box
  `max-h-[calc(100vh-280px)]`, sticky header, sticky/pinned columns, per-column resize
  handles (`role="separator"`), right-click header context menu ("Reset this column width" /
  "Reset all widths"), row virtualization when `rows.length > 40`.
- **mobile branch** (`useIsMobile()`): each row becomes a stacked `<dl>` card. Only one branch
  is in the DOM at a time - this matters for tests that count matches.
- pagination footer rendered only when `pagination.totalPages > 1 || onPageSizeChange`;
  shows `Showing {start}-{end} of {total}`, a page-size `SelectField` (25/50/100),
  Previous / `Page X of Y` / Next.

### 2.2 Columns (`EstimatesPage.tsx:85-170`)

| id | header | size | sortable | hideable | meta | cell |
|---|---|---|---|---|---|---|
| `estimate_number` | Estimate # | 110 | yes | yes | `pinned, fixed, minWidth 90` | mono xs, secondary text |
| `customer` | Customer | 200 | **no** | **no** (`enableHiding:false`) | `locked, pinned, growWeight 2, minWidth 140` | `customerDisplayName(lead.customer)` + `customer_number` mono line; renders an em-dash placeholder when `lead?.customer` is missing |
| `status` | Status | 110 | yes | yes | `fixed` | `<StatusBadge status={row.status}/>` |
| `deposit` | Deposit | 110 | **no** | yes | `fixed` | `<StatusBadge status={deposit.status}/>`, or `null` when no deposit |
| `total` | Total | 110 | yes | yes | `fixed, minWidth 80` | `formatCurrency(total_amount)`, tabular-nums |
| `created_by` | Created By | 160 | **no** | yes | `growWeight 1, minWidth 80` | `creator.first_name creator.last_name` |
| `date` | Date | 110 | yes | yes | `fixed, minWidth 90` | `formatExactDate(created_at)` |

The `customer` cell's fallback uses a literal em-dash character. CLAUDE.md bans em dashes in
prose/comments/commit text; this is rendered UI content. Reproduce it byte-for-byte rather
than "fixing" it - changing it is a visible behaviour change.

### 2.3 Local UI state and URL sync

| state | owner | URL-synced? | resets page? |
|---|---|---|---|
| `page` | `useState(1)` | no | - |
| `pageSize` | `useState(25)` | no | yes (`onPageSizeChange` sets page 1) |
| `search` | `useState('')` | no | yes |
| `sorting` | `useState<SortingState>([])` | no | yes |
| facet `value` | `useFilterState(estimatesRegistry)` | **yes** | yes (via `handleFilterChange`) |
| `showNewDialog`, `preSelectedCustomerId` | `useState` | seeded from URL, see below | - |

`useFilterState` (`lib/filters/useFilterState.ts`) decodes/encodes the facet state into
`useSearchParams` with `{ replace: true }` (no back-stack spam) and only touches the keys the
registry owns. `page`/`sort`/anything else on the URL passes through untouched but is NOT
written by this page. Column widths/visibility persist SERVER-side, not localStorage:
`useTableView('estimates')` -> `GET/PUT /api/table-views/estimates`, query key
`['table-views','estimates']`, saved via the Columns popover's "Save current view"
(toast: "Saved to your account"). **There is no localStorage persistence anywhere on this page.**

URL wire format (`lib/filters/urlCodec.ts`):
- `multi` -> `?status=DRAFT,SENT`
- `range` -> `?total_min=500&total_max=5000`
- `dateRange` -> `?created_after=2026-07-01&created_before=2026-07-31`
Empty values are omitted entirely, so "param absent" == "facet inactive".

Auto-open effect (`:192-205`): on mount / searchParams change,
- `?newCustomerId=<id>` -> set `preSelectedCustomerId`, open `NewEstimateDialog`, delete the
  param (`setSearchParams(..., {replace:true})`);
- else `?action=new-estimate` -> open the dialog, delete the param.

### 2.4 Filter registry (`lib/filters/registries/estimates.ts`)

Five facets, in rail order: `status` (multi, static options in workflow order Draft, Sent,
Pending, Won, Declined, Archived), `created_by` (multi, `optionSource:'assignableUsers'`),
`deposit_status` (multi, static Requested/Paid/Voided/Refunded), `total`
(range, `money:true`, `min:0`, `maxSource:'estimates.maxTotal'`), `created` (dateRange).

Page-side resolvers (`EstimatesPage.tsx:220-235`):
- `resolveOptions('assignableUsers')` -> creators from `GET /api/estimates/creators`,
  memoized; any other id -> `[]`.
- `resolveMax('estimates.maxTotal')` -> **hard-coded `100000`**; any other id -> `0`.
  There is no backend max-total stat. Carry the constant over verbatim.

Deliberately NOT facets: `customer_id` (would need an async CustomerSelect) and `lead_id`
(backend-only deep-link facet). Neither is exposed on this page today.

`FilterBar` (`components/filters/FilterBar.tsx`) is a `Popover`: trigger is an outline Button
labelled "Filter" with a count badge; content is a 640px two-pane panel - `role="tablist"`
left rail of facet buttons (`role="tab"`, `aria-selected`) with per-facet count badges, a
right pane rendering `CheckboxFacet` / `RangeFacet` / `DateFacet` by kind, a header with
"Clear all (N)" (only when N>0), and a footer "N selected across M filters" + a "Done" button
that just closes the popover. **Each control writes only its own facet slot.**

`AppliedChips` (`components/filters/AppliedChips.tsx`): one `FilterChip` per selected value,
label `"{facet.label}: {optionLabel}"`. A `multi` facet collapses past 3 values into a
`+N more` chip. Removing a value chip filters that value out and leaves
`{kind:'multi', values:[]}` in place (does NOT delete the key) - so `hasAnyFacetActive` can
stay true with zero visible chips; removing a range/dateRange/`+N more` chip deletes the key.
Range chips read `"$500-$5,000"` / `"$500+"` / `"up to $5,000"` (money formatting because
`money:true`); date chips read `"Jul 1, 2026 - Jul 31, 2026"` / `"From X"` / `"Until X"`.

### 2.5 KPI tiles - the exact activation logic

`monthStart = startOfMonthDay()`, `monthEnd = endOfMonthDay()` (`lib/date-range.ts`, local
`YYYY-MM-DD` strings, memoized once per mount).

Seven tiles, in order (`:411-431`):

| # | icon | label | value | sub | tone | active when |
|---|---|---|---|---|---|---|
| 1 | FilePen | Draft | `stats.draft.count` | `{money} this month` | neutral | `activeStatusKpi==='DRAFT'` |
| 2 | Send | Sent | `stats.sent.count` | `{money} this month` | primary | `==='SENT'` |
| 3 | Clock | Pending | `stats.pending.count` | `{money}` (no "this month") | amber | `==='PENDING'` |
| 4 | CheckCircle2 | **Won** | `stats.approved.count` | `{money} this month` | emerald | `===ESTIMATE_STATUS.WON` |
| 5 | XCircle | Declined | `stats.declined.count` | `{money} this month` | rose | `==='DECLINED'` |
| 6 | Ban | **Archived** | `stats.cancelled.count` | `{money} this month` | neutral | `===ESTIMATE_STATUS.ARCHIVED` |
| 7 | Clock | Pending Deposits | `formatCurrency(stats.pending_deposits.total)` | `({count})` | amber, `emphasize` | `activeDepositKpi` |

All seven are clickable (`KpiTile` renders a `<button type="button">` when `onClick` is set,
`<div>` otherwise) and show a ring when `active`. `KpiStrip loading={isLoading}` swaps every
tile's value for a pulse skeleton. No `activeLabel` is passed, so no active pill renders.

`activeStatusKpi` (`:314-329`) - reproduce exactly:
```
otherFiltersActive = createdBy.length>0 || deposit.length>0 || totalActive || Boolean(search)
noCreatedRange     = !created?.from && !created?.to
isMonthRange       = created?.from === monthStart && created?.to === monthEnd
soleStatus         = statusValues.length === 1 ? statusValues[0] : null
activeStatusKpi    = soleStatus && !otherFiltersActive
                       ? (MONTHLY_ESTIMATE_STATUSES.includes(soleStatus)
                            ? (isMonthRange ? soleStatus : null)
                            : (noCreatedRange ? soleStatus : null))
                       : null
```
`MONTHLY_ESTIMATE_STATUSES = [DRAFT, SENT, WON, DECLINED, ARCHIVED]`. PENDING is the one
all-time tile.

`handleStatusKpi(status)`:
- if already active -> `clearAllFilters()` (`setValue({})` + `setSearch('')` + `setPage(1)`);
- else -> `setSearch('')`, `setPage(1)`, then `setValue({status:{kind:'multi',values:[s]}})`
  plus, for a monthly status, `created:{kind:'dateRange',from:monthStart,to:monthEnd}`.
  Note it REPLACES the whole filter state, clearing every other facet.

`activeDepositKpi = depositValues.length===1 && depositValues[0]==='REQUESTED'` - deliberately
asymmetric with the status tiles (it does NOT require "no other facet active"). `handleDepositKpi`
off-path deletes only `deposit_status` and keeps everything else; on-path clears search and
replaces the whole state with `{deposit_status:{kind:'multi',values:['REQUESTED']}}`. This
asymmetry is intentional (verbatim carry-over from the pre-registry page) - keep it.

### 2.6 API interactions

| # | trigger | hook | method + endpoint | params | key / invalidation |
|---|---|---|---|---|---|
| 1 | mount | `useQuery` | `GET /api/estimates/creators` | - | key `['estimate-creators']` |
| 2 | mount + any state change | `useQuery`, `placeholderData: keepPreviousData` | `GET /api/estimates` | `{page, limit: pageSize, ...listParams}` | key `['estimates', {page,pageSize,search,sortBy,sortDir,value}]` |
| 3 | Export -> "All (N)" | raw `api.get` inside a handler (no hook) | `GET /api/estimates/export` | `listParams` (no page/limit) | none; failure -> destructive toast "Export failed" |

`listParams` (`:256-268`) is built as an explicit baseline of `undefined` placeholders -
`search, status, created_by, deposit_status, total_min, total_max, created_after,
created_before, sortBy, sortDir` - then spread over with `filterParams`. **This shape is
load-bearing**: `list-status-defaults.test.tsx` asserts the `status` key is PRESENT (even as
`undefined`) on an unfiltered mount. Axios drops `undefined` before sending. `sortDir` is only
set when `sortBy` is set. Note `total_min`/`total_max` replaced the older `min_total`/`max_total`.

Response shape consumed: `data.estimates[]`, `data.pagination {page,limit,total,totalPages}`,
`data.stats {draft,sent,pending,approved,declined,cancelled,pending_deposits{count,total}}`
(each status stat `{count, value}`).

No mutations on this page. No optimistic updates anywhere in the module.

### 2.7 Every interactive element

| element | action | opens |
|---|---|---|
| KPI tile x7 | see 2.5 | nothing (in-place filter) |
| search Input (in DataTable toolbar) | 300 ms debounce -> `handleSearchChange` -> `setSearch` + `setPage(1)` | - |
| "Filter" button | toggles the facet popover | `FilterBar` Popover |
| facet rail tab | switches right pane | - |
| facet controls | write one facet slot -> `handleFilterChange` -> `setValue` + `setPage(1)` | - |
| "Clear all (N)" (inside popover header) | `onChange({})` | - |
| "Done" (popover footer) | closes popover only | - |
| applied chip x -> | removes that value/facet | - |
| "Clear all" ghost Button (chips strip) | `clearAllFilters()` - clears facets AND search AND page | - |
| "Columns" button | column visibility | Popover with per-column checkboxes (Customer is `locked`, disabled, shows a lock emoji), "Save current view", "Reset to default columns", "Reset column widths" |
| header cell click | toggles sort (guarded by `wasResizing`) -> `setSorting` + `setPage(1)` | - |
| header right-click | - | fixed-position `HeaderContextMenu` |
| column resize handle drag / double-click | resize / auto-fit to visible rows | - |
| **row click** | `navigate('/estimates/'+id)` | navigation |
| "Export" button | - | `DropdownMenu` (align end) with label "Export as CSV", separator, "Current page (N rows)", "All (N)" |
| Export -> Current page | `toCSV` + `downloadCSV` of `data.estimates`, filename `estimates-page{page}-{YYYY-MM-DD}.csv`. No-ops silently when the array is empty. | file download |
| Export -> All | `GET /api/estimates/export` then same CSV path, filename `estimates-all-{date}.csv` | file download or destructive toast |
| "New Estimate" (variant `business`) | `setShowNewDialog(true)` | `NewEstimateDialog` |
| pagination Prev/Next, page-size select | `setPage` / `setPageSize`+`setPage(1)` | - |

CSV export row shape (`toExportRow`, `:372-380`) - column order is the file order:
`Estimate #`, `Customer` (`customerDisplayName(lead.customer,'')`), `Company`, `Status`
(raw enum value, NOT the badge label), `Total` (number), `Created By`, `Date`
(`toLocaleDateString()`). **`toExportRow` dereferences `e.lead.customer` unguarded** - a
lead-less/customer-less row would throw here even though the table cell guards for it.

### 2.8 States

- **loading**: `KpiStrip loading` skeletons + `DataTable isLoading` -> `pagination?.limit ?? 5`
  skeleton rows (desktop) or 5 skeleton cards (mobile). The heading total pill is hidden until
  `pagination.total` exists.
- **empty**: single centered cell / card reading exactly `No results found.` - **the page does
  NOT distinguish "no estimates exist" from "nothing matches the filters".** There is no
  empty-state illustration, no "clear filters" CTA. Reproduce as-is; do not invent a
  differentiated empty state (that would be a behaviour change).
- **error**: none. The list `useQuery` destructures only `{data, isLoading}` - a failed fetch
  renders the empty state silently. Only the "Export all" path surfaces an error, as a toast.

### 2.9 `NewEstimateDialog` (`components/estimates/NewEstimateDialog.tsx`)

A `Dialog` (`max-w-md p-0 gap-0`), centered FileText avatar, title "Create New Estimate",
description "Select a client to get started".

State: `search`, `debouncedSearch` (300 ms), `expandedCustomerId`. Resets all three when
`open` flips false. When opened with `preSelectedCustomerId`, auto-expands that customer and
calls `onPreSelectConsumed()`.

Queries:
- `['customers-search', debouncedSearch]` -> `GET /api/customers?search=&limit=6`,
  `enabled: debouncedSearch.length >= 2`.
- `['customer', expandedCustomerId]` -> `GET /api/customers/:id`,
  `enabled: expandedCustomerId && debouncedSearch.length < 2` (the pre-selected path).
- `['leads', {customer_id: expandedCustomerId}]` -> `GET /api/leads?customer_id=&limit=10`,
  `enabled: Boolean(expandedCustomerId)`.

`ACTIVE_STATUSES = ['NEW','CONTACTED','WALKTHROUGH_SCHEDULED','WALKTHROUGH_COMPLETED','ESTIMATED']`.
The leads request sends NO status param, so this client-side allowlist is **load-bearing** - it
is the only thing keeping terminal (WON/LOST/CANCELLED) leads out of the picker. Asserted by
`e2e/specs/redesign/05-estimate-ui-drift.spec.ts` (SEL-34).

Body branches, in order:
1. pre-selected customer (`expandedCustomerId && debouncedSearch<2 && preSelectedCustomer`) ->
   a static customer row + the leads panel;
2. `debouncedSearch.length < 2` -> `"Type at least 2 characters to search"`;
3. `customersLoading` -> centered spinner;
4. `!customers?.length` -> `"No clients found"`;
5. otherwise -> list of up to 6 customer rows, each a `<button>` toggling expansion
   (ChevronRight -> ChevronDown).

Leads panel (both branches, duplicated markup): spinner while loading; when
`actionableLeads.length === 0` -> `"No active leads"` plus two links, **"Create new lead"**
(`navigate('/leads/new?customer_id='+id)`) and **"Create estimate without a lead"**
(`navigate('/estimates/new?customer_id='+id)`); otherwise one button per lead
(`service_request || 'No description'` + `<StatusBadge>`), click -> close dialog +
`navigate('/estimates/new?lead_id='+id)`, followed by a trailing "Create new lead" row.

Footer: an "OR" divider and **"Add new client"** -> `navigate('/leads/new', {state:{returnTo:'/estimates'}})`.

**Known dead end (do not silently fix):** "Create estimate without a lead" routes to
`/estimates/new?customer_id=X`, but `createEstimateSchema` requires `lead_id`
(`estimate.controller.ts:266-267`, comment: "Estimate.lead_id is REQUIRED (reverses the
Track-2 lead-less path)"). The form's own submit payload sends `customer_id` in that branch,
which zod strips as an unknown key, leaving `lead_id` undefined -> **400 on submit**. There is
an unmerged branch `origin/fix/issue-657-remove-leadless-estimate-deadend`. The v2 page must
reproduce the current behaviour (the link exists, the submit 400s and shows the destructive
toast); removing the link is a scope change to be raised, not made.

The dialog itself has its own local `customerDisplayName(c)` helper (`:137-142`) whose output
differs from the shared `lib/customer-name.ts` used by the list column. Keep both.

---

## 3. `/estimates/new` and `/estimates/:id/edit` - EstimateFormPage

One component, two modes: `isEdit = Boolean(useParams().id)`.
Entry params: `?lead_id=` (primary), `?customer_id=` (lead-less path, see the dead end above).
`location.state.breadcrumbs` may carry an incoming trail.

### 3.1 Guard / early return

`:374-391` - when `!isEdit && !leadId && !customerId`, the whole page is replaced by a
centered empty state: amber FileQuestion avatar, `"Select a lead first"`, copy "Estimates are
always linked to a lead. Open a lead and create the estimate from its detail page.", and a
`"Browse Leads"` Button -> `navigate('/leads')`. No form renders.

There is NO permission check in this component - `create`/`update Estimate` is enforced only by
the API (`canDo('create','Estimate')` / `canDo('update','Estimate')`), and by whoever linked here.

### 3.2 Queries

| key | endpoint | enabled |
|---|---|---|
| `['state-tax-rates']` | `GET /api/state-tax-rates` -> `data.data as StateTaxRate[]` | always |
| `['settings','default_tax_state']` | `GET /api/settings/default_tax_state` -> `data.data.value`; **try/catch returns undefined on 404**, `retry:false` | always |
| `['organization']` | `GET /api/organization` -> `{state}`, `retry:false` | always |
| `['lead', leadId]` | `GET /api/leads/:id` -> `data.lead` | `Boolean(leadId) && !isEdit` |
| `['customer', customerId]` | `GET /api/customers/:id` -> `data.customer` | `Boolean(customerId) && !leadId && !isEdit` |
| `['estimate', id]` | `GET /api/estimates/:id` -> `data.estimate` | `isEdit` |
| `['price-book-categories']` (inside LineItemsEditor) | `GET /api/price-book/categories` | always |
| price-book search (inside LineItemsEditor, raw axios, not a hook) | `GET /api/price-book/items/search?q=&category_id=&type=` | on typing, >=2 chars, 300 ms debounce, AbortController-cancelled |

`fallbackTaxState` (`:124-135`): prefers the `default_tax_state` app setting; otherwise matches
`organization.state` case-insensitively against `state_code` OR `state_name` and takes
`state_code`. Applied by an effect only when `!isEdit && !form.getValues('tax_state')`.

### 3.3 Zod schema (declared inline at `EstimateFormPage.tsx:49-72`)

```
lineItemSchema = {
  name:                z.string().min(1,'Required')
  detail:              z.string().max(1000).optional().default('')
  quantity:            z.coerce.number().positive('Must be > 0')
  unit_price:          z.coerce.number().min(0,'Must be >= 0')
  is_taxable:          z.boolean()
  item_type:           z.enum(['SERVICE','MATERIAL']).default('SERVICE')
  price_book_item_id:  z.string().uuid().nullable().optional()
  unit_cost:           z.coerce.number().min(0).nullable().optional()
  discount_type:       z.enum(['PERCENTAGE','FIXED_AMOUNT']).nullable().optional()
  discount_value:      z.coerce.number().min(0).nullable().optional()
  image_url:           z.string().nullable().optional()
}
formSchema = {
  scope_notes:    z.string().max(5000).optional()
  tax_state:      z.string().min(1,'Select a state')
  line_items:     z.array(lineItemSchema).min(1,'Add at least one line item')
  discount_name:  z.string().max(200).nullable().optional()
  discount_type:  z.enum(['PERCENTAGE','FIXED_AMOUNT']).nullable().optional()
  discount_value: z.coerce.number().min(0).nullable().optional()
}
```

Not in a shared file - if the v2 page needs it, IMPORT it from the original module rather than
re-declaring, or (better) leave the schema where it is and have v2 import the page-local
export. Today it is not exported; flag this to the builder.

`defaultValues` (`:170-177`): `scope_notes:''`, `tax_state:''`, one line item
`{name:'', detail:'', quantity:1, unit_price:'' as unknown as number, is_taxable:true,
item_type:'SERVICE'}`, discount fields `null`. Note the deliberate empty-string unit price so
the input renders blank rather than `0`.

Edit-mode populate effect (`:213-247`): matches the stored `tax_rate` back to a state by
`Math.abs(rate - estimate.tax_rate) < 0.0001` (so two states sharing a rate can mismatch - see
commit `b45bae33` on the 904 branch, "name the right tax jurisdiction when two states share a
rate"; main still has the naive match). Splits each stored `description` on the first `\n` into
`name` + `detail`. Pulls `image_url` from `li.price_book_item?.image_url`.

### 3.4 Form fields and controls

| field | control | where | notes |
|---|---|---|---|
| `scope_notes` | `<Textarea>` | desktop sidebar `id="scope_notes"` rows=4 AND mobile card `id="scope_notes_mobile"` rows=3 | both registered to the SAME RHF field - two DOM nodes, one value |
| `tax_state` | shadcn `<Select>` | trigger `id="tax_state"` (sidebar) and `id="tax_state_mobile"` | options `"{state_name} ({rate*100 to 2dp}%)"`; `setValue(..., {shouldValidate:true})`; error text under the desktop one only |
| `discount_name` | `<Input>` placeholder "Discount name (optional)" | sidebar | |
| `discount_type` | `<SelectField>` w=4.5rem, options None / % / $ | sidebar | selecting None sets `discount_type=null` AND `discount_value=null` |
| `discount_value` | `<Input type=number step=0.01 min=0>` | sidebar, **only rendered when `discount_type` is truthy** | registered with `{valueAsNumber:true}` |
| `line_items` | `<LineItemsEditor>` | main column | see 3.5 |

The form is `<form id="estimate-form" noValidate>`; the submit button lives OUTSIDE the form in
the page header and targets it via `form="estimate-form"`. `noValidate` is deliberate (#277 /
#260): `handleSubmit` owns all validation so the native HTML5 bubble cannot preempt Zod.

Error surfacing:
- `form.formState.errors.tax_state.message` under the desktop Select.
- `errors.line_items.root.message` ("Add at least one line item") above the editor.
- `firstQtyError` (`:258`) - the FIRST row's quantity message found across all rows, rendered
  once above the editor. Covered by `__tests__/estimate-form-qty-validation.test.tsx`.
- per-row name errors are passed down as `itemNameErrors` (index-aligned array).
- `mutation.isError` -> `extractApiError(error,'Failed to save estimate')` under the form.
- `onError` toast (destructive) titled "Could not save estimate"; if the server message
  contains "walkthrough" (case-insensitive) the description is replaced with
  "A walkthrough must be scheduled and completed before creating an estimate."

### 3.5 `LineItemsEditor` (`components/shared/LineItemsEditor.tsx`) - SHARED with invoices

Controlled: `value: LineItem[]`, `onChange`. The page bridges it to RHF via `useWatch` +
`form.setValue('line_items', next, {shouldValidate:true, shouldDirty:true})` - RHF stays the
source of truth. This component is ALSO used by `StandaloneInvoiceFormPage` (module 6), so it
is a cross-module shared component: **do not fork or edit it.**

Card 1 - price-book picker:
- top-level category chips (`categoriesData.filter(c => !c.parent_id)`), "All" + one per
  category, single-select.
- a 3-button type segment: All / Wrench (SERVICE) / Package (MATERIAL); clicking the active
  type toggles it off.
- search `<Input placeholder="Search price book...">`, 300 ms debounce, min 2 chars,
  AbortController per request, spinner on the right while loading, absolute dropdown
  (`z-50`, max-h-72) of results with thumbnail/type pill/category/price. Closes on
  outside mousedown. Selecting appends a row seeded from the price-book item
  (`quantity:1`, `is_taxable: item.taxable`, `unit_cost`, `image_url`, `price_book_item_id`).
- "Add item" outline Button -> appends `blankLineItem()`.

Card 2 - the grid. Header row (lg only) Name/Qty/Price/Cost/Discount/Tax/Total; grid template
`48px 1fr 70px 90px 80px 140px 48px 80px 36px`, wrapped in `overflow-x-auto` + `min-w-[760px]`.
Per row:
- thumbnail (or Package/Wrench placeholder) plus a **type-toggle button** (Material/Service)
  that flips `item_type` on click (`title="Click to toggle type"`).
- `name` `<Input placeholder="Item name">`; row error under it.
- `detail` raw `<textarea placeholder="Description for customer (optional)" rows={1}>` that
  auto-grows on input and resets its height on blur when empty.
- **`quantity` is `type="text" inputMode="numeric" pattern="[0-9]*"`** and strips non-digits
  (`e.target.value.replace(/[^0-9]/g,'')`), writing `''` for an empty field. Deliberate (#391),
  asserted by `__tests__/estimate-form-qty-text-input.test.tsx`. Do not turn it back into a
  number input.
- `unit_price` `<Input type=number step=0.01 min=0 placeholder="0.00">`.
- `unit_cost` `<Input type=number step=0.01 min=0 placeholder="0.00">` plus a per-line margin
  caption `"{n}% margin"` coloured danger below 20%, green at or above. **The cost input shares
  the "0.00" placeholder with price and renders after it** - e2e specs rely on `.first()`
  meaning price.
- discount `<SelectField>` (— / % / $) + a value `<Input>` shown only when a type is set.
- `is_taxable` `<Checkbox>`.
- line total: shows `formatCurrency(gross)` when no discount; struck-through gross above the
  effective figure when discounted.
- delete `<button aria-label={"Remove " + (item.name || 'line item')} title="Remove">` with a
  Trash2 icon; **disabled when `minOneRow` (default true) and `value.length <= 1`**.

### 3.6 Money math - `totals` memo (`:262-317`)

This mirrors the backend `calculateTotals` (`estimate.controller.ts:341-396`) **exactly**.
Reproduce line for line; do not "simplify" the rounding.

```
for each item:
  qty   = Number(quantity)   || 0
  price = Number(unit_price) || 0
  gross = round2(qty * price)
  lineDiscount = 0
  if discount_type && discount_value != null && discount_value > 0:
      PERCENTAGE    -> round2(gross * value/100)
      FIXED_AMOUNT  -> min(round2(value), gross)          // clamped to the line
  effective = round2(gross - lineDiscount)
  lineItemDiscountsTotal += lineDiscount
  subtotal += effective
  if is_taxable: taxableAfterDiscounts += effective
  if !isNaN(Number(unit_cost)): totalCost += round2(qty * unit_cost)

subtotal = round2(subtotal)

estimateDiscountAmount = 0
if discount_type && value != null && value > 0:
    PERCENTAGE    -> round2(subtotal * value/100)
    FIXED_AMOUNT  -> min(round2(value), subtotal)         // clamped to subtotal

discountedSubtotal = round2(subtotal - estimateDiscountAmount)

taxableSubtotal = taxableAfterDiscounts
if estimateDiscountAmount > 0 && subtotal > 0:
    taxableSubtotal = round2(discountedSubtotal * (taxableAfterDiscounts / subtotal))
                                                          // proportional allocation

taxAmount = round2(taxableSubtotal * selectedTaxRate)
total     = round2(discountedSubtotal + taxAmount)
overallMargin = total > 0 ? ((total - totalCost) / total) * 100 : 0
```
where `round2(x) = Math.round(x*100)/100` and
`selectedTaxRate = taxRatesData.find(r => r.state_code === form.watch('tax_state'))?.tax_rate ?? 0`
(a DECIMAL fraction, e.g. `0.0625`, displayed as `(rate*100).toFixed(2)%`).

Deps: `[watchedItems, watchedDiscountType, watchedDiscountValue, selectedTaxRate]`.
`selectedTaxRate`'s own memo depends on `form.watch('tax_state')` called inside the memo body -
an eslint-suspect pattern that works only because `watch()` re-renders the component. Preserve
the behaviour, not necessarily the pattern.

Totals card (desktop sidebar, `:578-618`) renders, in order: Subtotal; "Line Discounts"
(orange, only when `lineItemDiscountsTotal > 0`); `{discount_name || 'Estimate Discount'}`
(orange, only when `estimateDiscountAmount > 0`); `Tax ({rate}%)`; a bordered Total row; then
**`Deposit: 50% = {formatCurrency(total*0.5)}`** - a HARD-CODED 50% that ignores the org's
`deposit_default_percentage`/`deposit_default_type` (which the Send dialog does honour). This
is a real inconsistency; carry it over verbatim and log it, do not fix it here.
Then a bordered block with `Total Cost` and `Margin` (`overallMargin.toFixed(1)%`, danger <20%).

The mobile totals card (`lg:hidden`, `:671-684`) shows only Subtotal / Tax / Total - no
discounts, no cost, no margin, no deposit line.

### 3.7 Submit

`mutation.mutationFn` (`:321-351`) builds:
```
{
  lead_id:     isEdit ? undefined : effectiveLeadId,
  customer_id: isEdit ? undefined : (effectiveLeadId ? undefined : customerId ?? undefined),
  scope_notes: values.scope_notes || undefined,
  tax_rate:    selectedTaxRate,
  discount_type / discount_value / discount_name,
  line_items: values.line_items.map(li => ({
      description: li.detail ? `${li.name}\n${li.detail}` : li.name,   // merge back
      quantity, unit_price, is_taxable, item_type,
      price_book_item_id: li.price_book_item_id || null,
      unit_cost:      li.unit_cost      != null ? Number(li.unit_cost)      : null,
      discount_type:  li.discount_type  || null,
      discount_value: li.discount_value != null ? Number(li.discount_value) : null,
  })),
}
```
- create -> `POST /api/estimates` (`canDo('create','Estimate')`); backend requires `lead_id`,
  min 1 line item, `tax_rate` 0..1, rejects a terminal lead (`WON/LOST/CANCELLED`) with 400,
  and validates every `price_book_item_id`. **Create is NOT gated on the walkthrough** (Bug #39
  - that gate lives on send).
- edit -> `PATCH /api/estimates/:id` (`canDo('update','Estimate')`); backend rejects any
  non-DRAFT estimate with 400 "Only draft estimates can be edited".
- `image_url` is intentionally NOT sent (it is a display-only mirror of the price-book image).

`onSuccess`: invalidate `['estimates']` and `['lead', effectiveLeadId]`, then
`navigate('/estimates/'+estimate.id, incomingBreadcrumbs ? {state:{breadcrumbs}} : undefined)`.
**It does NOT invalidate `['estimate', id]` on the edit path** - the detail page refetches
because its own query remounts, but a warm cache could show stale data. Preserve as-is.

### 3.8 Header, banners, preview

Header row: `h1` = `Edit {estimate_number || 'Estimate'}` or `New Estimate`; buttons
`Cancel` (`navigate(-1)`), `Preview` (disabled when `!watchedItems?.length`), and the submit
button (`variant="business"`, label `Save Changes` / `Create Estimate`,
`disabled={mutation.isPending || isTerminal}` with a spinner while pending).

`isTerminal = lead && ['WON','LOST','CANCELLED'].includes(lead.status)` - note it reads the
LEAD's status, not the estimate's.

Lead/customer banner (`:427-486`, rendered only when `headerCustomer` resolves, where
`headerCustomer = lead?.customer ?? customerOnly ?? estimateData?.customer`): when `isTerminal`
a danger strip `"Lead is {status lowercased} - cannot create estimate"`; then a 3-column grid -
name + company + `<StatusBadge status={lead.status}>`, `tel:`/`mailto:` links
(`formatPhone`), Service Address (lead service address, else the customer's first
`service_locations[0]`, else italic "No service address"), and Service Request (else italic
"None").

`leadError` -> a danger-bordered Card "Lead not found or you don't have access to it."

Preview button opens one of TWO different dialogs:
- `isEdit && id` -> `<PdfPreviewDialog pdfUrl={/api/estimates/:id/pdf}
  downloadFilename={estimate-<number>.pdf} title={Estimate <number>}>` - authed `fetch` with a
  Supabase bearer token, content-type guard, blob iframe, states loading spinner /
  error + "Try again" / iframe, and a Download button in the header. Error copy is
  status-specific (401/403 "Session expired...", 404 "PDF not found for this estimate.",
  `invalid-content` "PDF response was malformed...", else "Could not load PDF (code)...").
- create mode -> a plain `<Dialog max-w-2xl>` titled "Customer Preview" rendering
  `<EstimateDocumentView>` fed from the LIVE form values, with per-line discount amounts
  recomputed inline (`:715-742`) using the same round2 rules.

---

## 4. `/estimates/:id` - EstimateDetailPage

### 4.1 Queries

| key | endpoint | enabled | notes |
|---|---|---|---|
| `['estimate', id]` | `GET /api/estimates/:id` -> `data.estimate` | always | the page's spine |
| `['estimate-notes', id]` | `GET /api/estimates/:id/notes` -> `data.notes` | `Boolean(id)` | has `refetch` used directly after adding a note |
| `['attachments','LEAD', leadIdForWt]` | `GET /api/attachments/lead/:leadId`, filtered client-side to `context === 'WALKTHROUGH'` | `leadId && (lead.walkthrough_completed_at \|\| lead.walkthrough_scheduled_at)` | photo count only |

### 4.2 Mutations

| name | method + endpoint | body | onSuccess | onError |
|---|---|---|---|---|
| `sendMutation` | `POST /api/estimates/:id/send` | none | invalidate `['estimate',id]`, `['estimates']`; toast "Estimate sent" | destructive toast "Send failed", `duration: Infinity` |
| `deleteMutation` | `DELETE /api/estimates/:id` | - | invalidate `['estimates']`; `navigate('/estimates')` | none (silent) |
| `reviseMutation` | `POST /api/estimates/:id/revise` via `lib/api/estimates.ts#reviseEstimate` | - | invalidate `['estimate',id]`, `['estimates']`; `navigate('/estimates/:id/edit')` | destructive toast "Revise failed", `duration: Infinity` |
| `addNoteMutation` | `POST /api/estimates/:id/notes` | `{content: noteContent}` | clear the textarea; `refetchNotes()` (NOT an invalidate) | none |
| `createJobMutation` | `POST /api/jobs` | `{estimate_id: id}` | invalidate `['estimate',id]`, `['estimates']`, `['jobs']`, `['schedule-unassigned']`, `['schedule-jobs']`; `navigate('/jobs/:jobId')` | none - the error is rendered INLINE in the header (`:517-521`) as `<span class="text-xs text-danger">` |

`sendMutation` is declared but **never invoked** - the header Send button opens
`SendEstimateDialog` instead. Dead code; the v2 page may keep or drop it (behaviour-neutral),
but note it so a reviewer does not think a call site was lost.

No optimistic updates anywhere.

### 4.3 Derived data (`:300-341`)

```
depositInvoice = est.invoices?.find(inv => inv.kind === 'DEPOSIT')
sc             = est.send_config
depPayment     = depositInvoice?.payments?.[0]
dep = sc?.deposit_required ? {
        status:  depositInvoice?.status ?? 'DRAFT',
        amount:  Number(depositInvoice?.total_amount ?? sc.deposit_amount ?? 0),
        percentage, method, paidAt, referenceNumber, stripePaymentIntentId, refundedAt
      } : null
isDraft    = est.status === 'DRAFT'
isSent     = est.status === 'SENT'
isApproved = est.status === 'WON'
canRevise  = (isSent || est.status === 'PENDING') && ability.can('revise','Estimate')
```
The legacy `est.deposit` field is GONE from the API (`#185`); everything deposit-shaped derives
from `est.invoices[kind=DEPOSIT]` + `est.send_config`. Spec `redesign/05-estimate-ui-drift.spec.ts`
(SEL-33) asserts this surface renders.

`hasDiscount = Number(est.discount_amount) > 0`;
`hasLineDiscounts = line_items.some(li => Number(li.discount_amount) > 0)`.

Breadcrumbs (`:387-406`) - TWO trails are built:
- `activeBreadcrumbs` (rendered): incoming `location.state.breadcrumbs` + a terminal
  `{label: estimate_number}` leaf; else if `est.job` -> `Jobs > {job_number} > {estimate_number}`;
  else `Estimates > {estimate_number}`.
- `activeBreadcrumbsWithoutLeaf` (passed forward on navigation): same but the leaf carries
  `href: /estimates/:id`. Handed to every outbound `Link`/`navigate` (View Lead, View Job,
  View Walkthrough) so job context survives.

### 4.4 Component tree

```
<div class="space-y-4">
  <Breadcrumb items={activeBreadcrumbs}/>
  {isApproved && frozen banner}                       // Lock icon, success tint
  <Card>  hero
     left:  h1 estimate_number + <StatusBadge/>, customer line + "View Lead" Link
     right: action cluster (section 4.5)
     customer + service address + estimate info strip  (only when lead?.customer)
     KPI strip: Subtotal / Tax Rate / Tax Amount / Total  (+ Deposit when dep)
               grid lg:grid-cols-5 when dep else lg:grid-cols-4
  </Card>
  <Card p-0>
    <Tabs defaultValue="line-items">
      TabsList: Line Items ({n}) | Details | Notes ({n}) | [Deposit if dep] | Tasks
      ... 5 TabsContent ...
    </Tabs>
  </Card>
  <Dialog previewOpen>  Customer Preview + Download PDF + <EstimateDocumentView/>
  <CancelEstimateDialog/> <DuplicateEstimateDialog/> <SendEstimateDialog/>
  <RecordEstimatePaymentDialog/>
  {dep && <><WaiveDepositDialog/> {depositInvoice && <RefundDepositDialog/>}</>}
</div>
```

Local UI state: `cancelOpen`, `sendDialogOpen`, `recordPaymentOpen`, `previewOpen`,
`downloadingPdf`, `noteContent`, `waiveOpen`, `refundOpen`, `duplicateOpen`. Tab state is
uncontrolled (`defaultValue="line-items"`), NOT URL-synced and NOT persisted.

### 4.5 Header action cluster - the full conditional matrix

Evaluated top to bottom, in DOM order (`:445-551`):

| # | element | render condition | click |
|---|---|---|---|
| 1 | **Preview** (outline, Eye) | always | `setPreviewOpen(true)` -> Customer Preview Dialog |
| 2 | **Send** / **Resend** (business, Send) | `(isDraft \|\| isSent) && canSend` - label is "Resend" when `isSent` | opens `SendEstimateDialog` |
| 3 | **Copy Link** (outline, Link2) | `isSent && est.public_token` | `navigator.clipboard.writeText(origin + '/p/estimates/' + id + '?token=' + public_token)`. **No toast, no confirmation** |
| 4 | **Revise** (outline, Undo2/spinner) | `canRevise` = `(SENT \|\| PENDING) && ability.can('revise','Estimate')` | `reviseMutation.mutate()`; disabled while pending |
| 5 | **Record Payment** (business, DollarSign) | `['DRAFT','SENT','PENDING'].includes(status)` - **always rendered in those states**; when `!canRecordPayment` it renders DISABLED with `title="You don't have permission to record payments"` | opens `RecordEstimatePaymentDialog` |
| 6 | **Create Job** (business, Briefcase) | `status === 'WON' && !est.job && canCreateJob`. Inside that: if `depositInvoice && !['PAID','VOIDED'].includes(depositInvoice.status)` -> DISABLED with `title="Deposit must be paid or waived before creating a job"`; else enabled | `createJobMutation.mutate()`; spinner while pending |
| 7 | **View Job** (outline, Briefcase) | `est.job` | `navigate('/jobs/'+est.job.id, {state:{breadcrumbs: activeBreadcrumbsWithoutLeaf}})` |
| 8 | **Duplicate to re-quote** (outline, Copy) | `isApproved && canDuplicate` | opens `DuplicateEstimateDialog` |
| 9 | inline create-job error | `createJobMutation.error` | - |
| 10 | **overflow `MoreHorizontal`** (outline sm) | `canEditEstimate \|\| canCancelEstimate \|\| canDeleteEstimate \|\| canDuplicate` | `DropdownMenu` (align end) |

Overflow menu items:
| item | condition | action |
|---|---|---|
| Edit (Pencil) | `canEditEstimate && isDraft` | `navigate('/estimates/:id/edit')` |
| Cancel (XCircle, `text-danger`) | `canCancelEstimate && (isDraft \|\| isSent)` | opens `CancelEstimateDialog` |
| Delete (Trash2, `text-danger`) | `canDeleteEstimate && isDraft` | `deleteMutation.mutate()` **immediately - NO confirmation dialog** |
| Duplicate (Copy) | `canDuplicate` | opens `DuplicateEstimateDialog` |

**Guard divergences worth knowing (reproduce, do not fix):**
- The client Create-Job deposit allowlist is `['PAID','VOIDED']`; the SERVER's is
  `['PAID','VOIDED','PARTIALLY_REFUNDED','REFUNDED']` (`job.controller.ts:972`). So a
  refunded deposit disables the button in the UI even though the API would accept it.
- The Cancel menu item is offered for `DRAFT|SENT`; the server accepts `DRAFT|SENT|PENDING`
  (`estimate.controller.ts:1690`). A PENDING estimate cannot be archived from this UI.
- The frozen banner and "Duplicate to re-quote" key on `WON`; `DECLINED`, `EXPIRED` and
  `ARCHIVED` estimates get NO banner and no action except Preview / Duplicate / (menu).

### 4.6 Hero KPI strip

Four fixed tiles: `Subtotal` = `formatCurrency(est.subtotal)`; `Tax Rate` =
`(Number(est.tax_rate)*100).toFixed(2)%`; `Tax Amount`; `Total`. When `dep` is non-null a
fifth Deposit tile appears (Banknote icon, label + inline `<StatusBadge status={dep.status}>`,
value `formatCurrency(dep.amount)`, plus `dep.method` as a caption when set) and the grid
switches `lg:grid-cols-4` -> `lg:grid-cols-5`. This is bespoke markup, NOT the `KpiStrip`
component used on the list page.

### 4.7 Tabs

**Line Items** - one card per `est.line_items` row: thumbnail (`price_book_item.image_url`) or
a Package/Wrench placeholder, a Material/Service pill, `name` (first line of `description`),
`detail` (rest, `whitespace-pre-wrap`), a meta row `Qty: n`, `@ {unit_price}`, `Taxable` (only
when `is_taxable`), `Cost: {unit_cost}` (only when `unit_cost != null`), a discount line when
`discount_amount > 0 && discount_type`, and the right-hand total: struck gross above effective
when discounted, else `formatCurrency(li.line_total)`. Note the server stores `line_total` as
the **gross** (pre-line-discount) figure (`calculateTotals` pushes `line_total: lineTotal`), so
the discounted branch's `effective = round2(gross - discount_amount)` is the only place the
net line figure appears.
Totals block below: Subtotal; "Line Discounts" (sum of `discount_amount`, orange, only when
`hasLineDiscounts`); `{est.discount_name || 'Estimate Discount'}` (orange, only when
`hasDiscount`); `Tax ({rate}%)`; bold Total.
Empty line-items array renders an empty list with the totals block still showing - no empty state.

**Details** - two columns.
Left: a `<dl>` with Number, Status (badge), Created By, Created (`toLocaleString`), then
conditional rows Sent / Approved (`approved_at`) / Declined / Cancelled (+ Reason) and a
Discount row when `hasDiscount`. Below, when `est.signature_data && est.status === 'WON'`, the
customer signature `<img>` plus `Signed {signature_at}`.
Right: "Scope Notes" (`est.scope_notes` or italic "No scope notes"), then a Walkthrough card
(rendered only when `lead` exists) with three branches - completed (green CheckCircle2, date,
performer names, truncated notes at 100 chars, photo count from `wtAttachments`), scheduled
(amber Clock, date, performers), or `"Not recorded"` - and a "View Walkthrough" Link to
`/leads/:lead_id` carrying `activeBreadcrumbsWithoutLeaf`.

**Notes** - `<Label>Add Note</Label>`, a `<Textarea rows=3 placeholder="Add a note...">`, and
an "Add Note" Button disabled when `!noteContent.trim() || addNoteMutation.isPending` (label
becomes "Adding..."). Below, `"No notes yet."` when empty, else one block per note with
`{creator.first_name} {creator.last_name} · {created_at toLocaleString}` and the content
(`whitespace-pre-wrap`). The tab trigger shows `({notesData?.length || 0})`.

**Deposit** - the trigger and content only exist when `dep` is truthy.
- "Deposit Information" heading with an inline `<StatusBadge status={dep.status}>`; a `<dl>`
  with Amount, Percentage (when non-null), Method (when non-null).
- "Actions" section, rendered only when `canWaiveDeposit || canRefundDeposit`:
  - **Waive Deposit** (outline sm, ShieldX) when
    `canWaiveDeposit && depositInvoice && ['DRAFT','SENT'].includes(depositInvoice.status)`;
  - **Refund** (destructive sm, CreditCard) when
    `canRefundDeposit && depositInvoice && ['PAID','PARTIALLY_REFUNDED'].includes(depositInvoice.status)`.
  A comment records that "Mark Received" was removed in favour of the header Record Payment.
- "Receipt Info" `<dl>` only when `dep.status === 'PAID'`: Received on, Reference, Stripe
  Payment (mono).
- "Refund Info" only when `dep.status === 'REFUNDED'`: Refunded on.

**Tasks** - `<TabsContent value="tasks" className="p-0">` wrapping
`<JobLeadTasksTab entity={{type:'ESTIMATE', id: est.id, label: est.estimate_number}} />`.
Cross-module shared component (`components/tasks/JobLeadTasksTab.tsx`, also used by Job and
Lead detail) - import, never fork. It owns its own fetching, a `TaskDetailDrawer`, and a
"Generate tasks" flow.

### 4.8 Preview dialog + PDF download

`<Dialog open={previewOpen}>` -> `DialogContent max-w-3xl max-h-[90vh] overflow-y-auto p-0`,
header "Customer Preview" plus a **Download PDF** outline button
(`disabled={downloadingPdf}`, spinner while downloading). `handleDownloadPdf` (`:345-366`)
calls `fetchPdf('/api/estimates/:id/pdf')` (exported from `PdfPreviewDialog.tsx` - an authed
`fetch` with the Supabase bearer token, resolving relative URLs against `VITE_API_URL` and
rejecting non-`application/pdf` content), then creates an object URL, clicks a synthetic
`<a download="estimate-{number}.pdf">`, removes it and revokes the URL. Failure -> destructive
toast "Download failed / Could not download the PDF. Please try again."
Body renders `<EstimateDocumentView>` fed from the server estimate. Covered by
`__tests__/estimate-detail-preview.test.tsx` (asserts the document view, not an iframe, and
that a Download PDF affordance stays inside the dialog) - `#393`.

### 4.9 Loading / not-found / error

- `isLoading` -> a bespoke full-page skeleton (`:213-294`): breadcrumb line, hero Card
  (title/badge/subtitle/2 buttons, a 3-column strip, a 4-column KPI strip), and a tabbed Card
  with 3 tab stubs, 3 line-item rows and a totals block. Uses `<Skeleton>`, not the DataTable
  pulse. Reproduce the shape; it is what an e2e screenshot baseline sees.
- `!estimateData` -> `<div class="text-text-secondary py-12 text-center">Estimate not found</div>`.
  This catches BOTH a 404 and a query error - **there is no distinct error state**.
- Per-action errors: toasts (send/revise/download), inline text (create job), or nothing
  (delete, add note).

---

## 5. Dialog inventory (detail page)

### 5.1 `SendEstimateDialog` (`components/estimates/SendEstimateDialog.tsx`)

Props: `estimateId, estimateNumber, totalAmount, customerEmail, alreadySent, sentAt, onSuccess`.
The detail page passes `alreadySent = (status === 'SENT' || status === 'PENDING')` and an
`onSuccess` that invalidates `['estimate',id]` + `['estimates']`.

- `useOrganization()` -> `['organization']`, `GET /api/organization`. Reads
  `accepted_payment_methods`, `deposit_default_type`, `deposit_default_percentage`,
  `deposit_default_fixed_amount`.
- `depositRate` = FIXED -> `min(fixed_amount, totalAmount) / (totalAmount || 1)`;
  else `(deposit_default_percentage ?? 50) / 100`. `depositAmount = totalAmount * depositRate`.
  `CC_SURCHARGE_RATE = 0.035`; `ccTotal = depositAmount * 1.035`, `ccFee = ccTotal - depositAmount`.
- Resend warning strip when `alreadySent` (amber, AlertTriangle, includes `sentAt` date).
- Tabs: "Via Email" (active) and "Via SMS" (disabled, "Coming Soon" pill).
- Fields: **To** (`id="recipient-email"`, seeded from `customerEmail`, re-seeded by an effect
  when the prop changes; invalid -> "Enter a valid email address"; only sent as
  `recipient_override` when it differs case-insensitively from the saved email);
  **CC** (`id="cc-emails"`, chip list, max 5, added on Enter/Tab/comma/blur, Backspace on an
  empty input removes the last, per-error messages "Invalid email address" / "Email already
  added" / "Maximum 5 CC emails"; input disabled at 5); **Message** (`<Textarea rows=3>`,
  default "Thank you for your recent service inquiry with us. Click the link below to view
  your estimate."); **Require deposit** `<Switch id="deposit-toggle">` default **ON**.
- When the deposit is on: a `"{round(depositRate*100)}% = {money}"` line, then a
  "Payment methods" checkbox list built from `PAYMENT_METHOD_ORDER` filtered to
  `orgAcceptedMethods` (`id="pm-{KEY}"`). The CARD row, when checked, shows
  `"{ccTotal} (incl. {ccFee} processing fee)"`. Two error copies: "No payment methods accepted
  by your organization..." (org list empty) and "Select at least one payment method".
  Toggling the deposit OFF unmounts the whole section.
- `canSend = (!depositRequired || enabledMethods.size > 0) && recipientValid`.
- Submit: `POST /api/estimates/:id/send` with
  `{deposit_required, payment_methods: [...], message_body, cc_emails?, recipient_override?}`.
  onSuccess -> invalidate `['estimate',id]` + `['estimates']`, close, call `onSuccess`, toast
  "Estimate sent". onError -> destructive toast "Estimate not sent", `duration: Infinity`.
  Button label: `Sending...` / `Resend {number}` / `Send {number}`.
- Server side (`estimate.controller.ts:1055-1300`): rejects a non `DRAFT|SENT` status; rejects
  when the lead has `walkthrough_needed && !walkthrough_completed_at` ("Complete the
  walkthrough before sending this estimate."); email failure maps to 409 (org email disabled)
  or 502 (no API key / provider rejection) and **leaves the estimate unchanged**; on first send
  it mints `public_token` + `valid_until` (from the `estimate_validity_days` app setting,
  default 30) and, when `deposit_required`, creates ONE `kind=DEPOSIT` Invoice in SENT with its
  own public token; a resend re-syncs an unpaid DRAFT/SENT deposit invoice. The lead
  auto-advances to `ESTIMATED`.

### 5.2 `RecordEstimatePaymentDialog`

Props include `existingDepositAmount` (`depositInvoice.total_amount ?? sc.deposit_amount`) and
`existingDepositPercentage` (`sc.deposit_percentage`).
- Org defaults via `useOrganization()`; `orgDefaultPct` is FIXED-aware.
- Fields: `rp-pct` (number, min 1 max 100 step 0.5), `rp-amount` (number, min 0.01 step 0.01,
  caption `Total estimate: {money}`), `Payment method` `<SelectField aria-label="Payment method">`
  over `PAYMENT_METHOD_ORDER` (default `EXTERNAL_CARD`), `rp-date` (`type=date`, defaults to
  today), `rp-ref` (text), `rp-notes` (textarea rows 2).
- Two-way link: editing % recomputes the amount **only while `amountTouched` is false**;
  editing the amount sets `amountTouched` permanently (until reopen). An effect re-syncs every
  field when `open` flips true.
- `canSubmit = parseFloat(amount) > 0 && method && paidAt`.
- Submit `POST /api/estimates/:id/record-payment` with
  `{amount, payment_method, paid_at: ISO, deposit_percentage?, reference_number?, notes?}`;
  onSuccess invalidates `['estimate',id]` + `['estimates']` and closes. Error -> inline
  `extractApiError` text.
- Description copy states the contract: a full-deposit payment approves the estimate and moves
  the lead to Won; a partial payment is recorded against the balance; no email is sent.
- Server: rejects unless status is `DRAFT|SENT|PENDING`; rejects when the lead already has
  another WON estimate ("This lead already has an approved estimate"); when fully paid it sets
  `status = WON`, `approved_at`, and mints `public_token` if absent.

### 5.3 `CancelEstimateDialog`

`max-w-sm`, title "Cancel Estimate", description "This action cannot be undone. Please provide
a reason." One required `<Textarea>` (`Reason *`, placeholder "Why is this estimate being
cancelled?"). Buttons "Keep Open" (close) and destructive "Cancel Estimate" disabled when
`!reason.trim() || isPending` (label "Cancelling..."). `POST /api/estimates/:id/cancel`
`{cancelled_reason}`; onSuccess invalidates `['estimate',id]` + `['estimates']`, closes, clears
the reason. Server sets `status = ARCHIVED`, `cancelled_at`, `cancelled_reason` and accepts
`DRAFT|SENT|PENDING`.

### 5.4 `DuplicateEstimateDialog`

`max-w-md`. Loads `['leads',{customer_id}]` -> `GET /api/leads?customer_id=&limit=25`
(`enabled: open && Boolean(customerId)`); no status filter here. Renders a scrollable list of
selectable lead buttons (selected -> `border-primary bg-primary/5`), each showing
`service_request || 'Lead'`, a `(same lead)` marker for `currentLeadId`, the created date and a
`<StatusBadge>`. `targetLeadId` seeds from `currentLeadId` on every open. States: "Loading
leads..." / "No leads found for this customer - the duplicate will stay on the current lead."
Submit -> `duplicateEstimate(id, {target_lead_id: targetLeadId || undefined})` ->
`POST /api/estimates/:id/duplicate`; onSuccess invalidates `['estimates']` **only** (not
`['estimate', id]`), closes, and `navigate('/estimates/'+newId)`.

### 5.5 `WaiveDepositDialog`

`max-w-sm`. When `estimateStatus === 'PENDING'` it shows a radio group (`name="waive-action"`):
"Waive deposit and approve estimate" (`waive`, default) or "Cancel estimate" (`cancel`); for
`SENT` it shows only the copy "This will waive the deposit requirement for this estimate."
When `paymentMethod` is set, an amber warning about the customer's selected method. Confirm
button is `destructive` when `action === 'cancel'`, else `default`; label "Processing..." while
pending. `POST /api/estimates/:id/waive-deposit {action}`; invalidates `['estimate',id]` +
`['estimates']`. Server (`:2534-2640`): requires status `SENT|PENDING`, requires a
`DRAFT|SENT` deposit invoice ("No active deposit to waive"), voids the invoice, and for
`waive` flips the estimate to `WON` + `approved_at` and the lead to `WON` (blocked when the
lead already has another WON estimate).

### 5.6 `RefundDepositDialog` - **the only component in this module with data-testids**

`DialogContent data-testid="refund-deposit-dialog"`; submit button
`data-testid="refund-deposit-submit"`. Reason category `<SelectField aria-label="Reason
category">` over `CUSTOMER_REQUEST / ERROR / GOODWILL / OVERPAYMENT / CHARGEBACK / OTHER`
(labels: Customer request, Billing error, Goodwill, Overpayment, Chargeback, Other) plus a
required "Reason details" textarea. Info block shows the refund amount and either "The refund
will be processed automatically via Stripe." or "Please record that the refund has been
processed manually." depending on `hasStripePayment`. Submit ->
**`POST /api/invoices/{depositInvoiceId}/refund`** `{reason_category, reason}` (the unified
Invoice refund - `POST /api/estimates/:id/refund-deposit` was removed). Invalidates
`['estimate',estimateId]` + `['estimates']`. Disabled until both fields are filled.

---

## 6. Permission-conditional rendering

Frontend abilities come from `useAppAbility()` (`contexts/AbilityContext`) over
`lib/ability.ts` (`createMongoAbility`, rules shipped by the server). The estimate pages use
plain `ability.can(action, 'Estimate' | 'Job' | 'Invoice')` - **NOT** `canOnJob`, and never
`subject(...)` instance checks (which would be broken for conditional rules; see the long
comment in `ability.ts:31-45`).

| flag | check | hides / disables |
|---|---|---|
| `canSend` | `can('send','Estimate')` | Send/Resend button |
| `canEditEstimate` | `can('update','Estimate')` | Edit menu item (also needs `isDraft`); contributes to whether the overflow menu renders at all |
| `canCancelEstimate` | `can('cancel','Estimate')` | Cancel menu item (also needs DRAFT/SENT) |
| `canDeleteEstimate` | `can('delete','Estimate')` | Delete menu item (also needs DRAFT) |
| `canRecordPayment` | `can('record_payment','Estimate')` | **disables** (does not hide) Record Payment, with a title tooltip |
| `canCreateJob` | `can('create','Job')` | Create Job button |
| `canWaiveDeposit` | `can('waive_deposit','Estimate')` | Waive Deposit button + (with canRefundDeposit) the whole Deposit "Actions" section |
| `canRefundDeposit` | `can('refund','Invoice')` | Refund button |
| `canRevise` | `can('revise','Estimate')` AND status SENT/PENDING | Revise button |
| `canDuplicate` | `can('duplicate','Estimate')` | Duplicate menu item, "Duplicate to re-quote" button, and the "Duplicate it to re-quote." sentence inside the frozen banner |

`EstimatesPage` and `EstimateFormPage` contain **no ability checks at all**. The list is
row-scoped server-side; the form relies on the API.

Backend defaults (`backend/src/lib/permissions/defaultGrants.ts`, `catalog.ts`,
`userCapabilities.ts`) for context:
- ADMIN: `manage all`.
- SALES: create/update/delete/send/cancel/archive/duplicate/revise Estimate unconditionally;
  `read Estimate` scoped `OWN_ESTIMATE_VIA_LEAD` = `{lead:{lead_assignees:{some:{user_id}}}}`.
  No `record_payment`, no `waive_deposit`, no `create Job`.
- DISPATCHER: `read`, `record_payment`, `waive_deposit` on Estimate; `create Job`.
  No create/update/send/cancel/duplicate/revise Estimate.
- TECHNICIAN: nothing on Estimate by default. `create Estimate` / `update Estimate` are
  per-user grantable toggles scoped to leads they own (`userCapabilities.ts:54-70`).

Unit test `__tests__/estimate-detail-deposit.test.tsx` pins the ability-not-role rule
(#238): "shows Waive Deposit when ability grants waive_deposit" / "hides Waive Deposit when
ability lacks it (even though role is ADMIN)".

---

## 7. Estimate status + workflow (approve -> deposit -> job)

```
                         PATCH allowed only here
                                  |
 [DRAFT] --send--> [SENT] --public approve, no deposit--------------> [WON]
    |                 |  \
    |                 |   \--public approve + non-Stripe method-----> [PENDING]
    |                 |    \-public approve + CARD (org accepts CARD)-> stays SENT,
    |                 |       Stripe Checkout; webhook -> [WON]
    |                 |
    |                 +--revise--> back to [DRAFT] (public_token + valid_until nulled)
    |                 +--record-payment (full)------------------------> [WON]
    |                 +--waive-deposit (action=waive)------------------> [WON]
    |                 +--public decline-------------------------------> [DECLINED]
    |                 +--cancel---------------------------------------> [ARCHIVED]
    +--cancel / delete
 [PENDING] --record-payment(full) | waive-deposit(waive)-------------> [WON]
 [PENDING] --waive-deposit(action=cancel) | cancel-------------------> [ARCHIVED]
 [WON] = FROZEN. Only Duplicate / Create Job / View Job / Preview remain.
 [EXPIRED] exists in the enum; a cron sets it; NO UI path reaches or displays it specially.
```

Server-side guards (verified in `estimate.controller.ts` / `job.controller.ts`):

| action | allowed statuses | other guards |
|---|---|---|
| `PATCH /:id` | DRAFT only | 400 "Only draft estimates can be edited"; validates price-book ids |
| `DELETE /:id` | DRAFT only | 400 "Only draft estimates can be deleted" |
| `POST /:id/send` | DRAFT, SENT | walkthrough gate (`walkthrough_needed && !completed_at`); email failure -> 409/502, estimate untouched |
| `POST /:id/cancel` | DRAFT, SENT, PENDING | requires a reason |
| `POST /:id/revise` | SENT, PENDING | WON -> "Won estimates are frozen - add change-order lines on the invoice or duplicate to a new estimate" |
| `POST /:id/record-payment` | DRAFT, SENT, PENDING | one-WON-per-lead guard; full payment -> WON |
| `POST /:id/waive-deposit` | SENT, PENDING | deposit invoice must be DRAFT or SENT; `waive` also runs the one-WON-per-lead guard |
| `POST /:id/approve` (public) | SENT only | expiry check `valid_until`; one-WON-per-lead; `payment_method` required and must be in `send_config.payment_methods` when a deposit is required |
| `POST /api/jobs {estimate_id}` | estimate must be WON (checked upstream of the excerpt) and have no job | deposit invoice must be in `PAID / VOIDED / PARTIALLY_REFUNDED / REFUNDED`, else 400 "Deposit must be paid or waived before creating a job..." |

Invariant enforced in three places: **one WON estimate per lead**
(`assertSingleApprovedPerLead`, `estimate.controller.ts:498-505`).

Deposit lifecycle: the `kind=DEPOSIT` Invoice is the SOLE deposit document. Created SENT on
first send-with-deposit; PAID by Stripe webhook or `record-payment`; VOIDED by `waive-deposit`;
REFUNDED/PARTIALLY_REFUNDED by `POST /api/invoices/:id/refund`.

---

## 8. Selector surface

### 8.1 `data-testid` present in the module

Only two, both in `RefundDepositDialog.tsx`:
- `refund-deposit-dialog`
- `refund-deposit-submit`

**Everything else in the Estimates module is selected by role / text / placeholder / DOM id.**
The e2e specs say so explicitly (`redesign/07-estimate-form.spec.ts:15-17`: "none of these
controls carry data-testids, so role/placeholder/label locators are primary; the
`.or(getByTestId)` chains are spec-side fallbacks only and NO app component was modified").
Those aspirational ids - `line-item-unit-price`, `estimate-form-submit`,
`send-deposit-toggle` - **do not exist in the source** (grep over `frontend/src` returns
nothing). A v2 page may add them (the `.or()` chains would then start matching), but must not
REMOVE any of the anchors below.

### 8.2 Load-bearing DOM anchors (treat these as the real selector contract)

Element ids: `scope_notes`, `scope_notes_mobile`, `tax_state`, `tax_state_mobile`,
`recipient-email`, `cc-emails`, `deposit-toggle`, `pm-CARD` / `pm-EXTERNAL_CARD` /
`pm-BANK_TRANSFER` / `pm-CHECK` / `pm-CASH`, `rp-pct`, `rp-amount`, `rp-date`, `rp-ref`,
`rp-notes`, `rp-method-label`.

Placeholders: `Search estimates...`, `Name, email, phone, or company...`, `Item name`,
`Description for customer (optional)`, `0.00` (price AND cost - **order matters, `.first()`
is price**), `Search price book...`, `Add a note...`, `Add email and press Enter`,
`Discount name (optional)`, `Describe the work...`, `Check #, transaction ID, etc.`.

Accessible names / text: buttons `New Estimate`, `Export`, `Filter`, `Done`, `Columns`,
`Clear all`, `Create Estimate`, `Save Changes`, `Preview`, `Cancel`, `Send`, `Resend`,
`Copy Link`, `Revise`, `Record Payment`, `Create Job`, `View Job`, `Duplicate`,
`Duplicate to re-quote`, `Waive Deposit`, `Refund`, `Add Note`, `Browse Leads`,
`Send {estimateNumber}` / `Resend {estimateNumber}`, `Issue Refund`, `Keep Open`,
`Cancel Estimate`, `Confirm`, `Download PDF`, `Try again`.
Roles: `tab` named `line items` / `details` / `notes` / `deposit` / `tasks`; `tablist`
"Filter facets"; `switch` named "require deposit"; `option` named by state; `dialog`;
`checkbox` named by facet option label (`Sent`, `Paid`, ...); `separator` (resize handles).
Labels: `Total From` / `Total To` (RangeFacet inputs), `Payment method`, `Reason category`.
Text: `Create New Estimate`, `Select a client to get started`,
`Type at least 2 characters to search`, `No clients found`, `No active leads`,
`Create new lead`, `Create estimate without a lead`, `Add new client`, `No results found.`,
`No notes yet.`, `Estimate not found`, `Select a lead first`, `Deposit Information`,
`Payment methods`, `Customer Preview`, `Send Estimate`, `Walkthrough`, `Line Items (n)`,
`Showing X-Y of N`, `Page X of Y`, `Export as CSV`, `Current page (N rows)`, `All (N)`,
KPI labels `Draft / Sent / Pending / Won / Declined / Archived / Pending Deposits`,
`Total`, `Subtotal`, `Tax Rate`, `Tax Amount`.

### 8.3 Spec files that exercise these routes

| spec | what it depends on |
|---|---|
| `frontend/e2e/specs/wt-estimate-detail.spec.ts` | `/estimates`, `table tbody tr` first-row click -> detail URL; text `EST-`, regex `/EST-\d{4}-\d+/`; optional text `Walkthrough`; screenshots `wt-estimate-detail-*.png`. Header of `07-estimate-form` calls this spec "stale". |
| `frontend/e2e/specs/redesign/05-estimate-ui-drift.spec.ts` | SEL-33: `/estimates/:id`, estimate number text, `role=tab` "line items", text "Total" (exact), `role=tab` /deposit/i clickable, text /deposit information/i, `role=button` /waive deposit/i. SEL-34: `/estimates`, `role=button` /new estimate/i, `role=dialog`, text "Create New Estimate", placeholder "Name, email, phone, or company...", customer row button by text, lead `service_request` text, Escape to close. |
| `frontend/e2e/specs/redesign/07-estimate-form.spec.ts` | Lead detail -> `role=button` "Create Estimate"; URL `/estimates/new?lead_id=`; `role=heading` "New Estimate"; placeholders "Item name", "Description for customer (optional)", `getByTestId('line-item-unit-price').or(getByPlaceholder('0.00').first())`; `#tax_state` click + `role=option` /massachusetts/i; live total text `$1,500.00`; `getByTestId('estimate-form-submit').or(role=button "Create Estimate")`; detail URL uuid regex; text `Draft`; `role=button` name "Send" exact; `role=dialog` + text "Send Estimate"; `getByTestId('send-deposit-toggle').or(role=switch /require deposit/i)` with `aria-checked`; text "Payment methods" count 0 after toggle; `role=button` `Send {estimateNumber}`; text `Sent`. |
| `frontend/e2e/specs/redesign/00-render-safety.spec.ts`, `01-journey.spec.ts` | traverse `/estimates` en route to invoices; depend on `error-boundary-fallback` absence and on the estimate flow producing a deposit invoice. |
| `workflow/02-estimate-crud`, `03-estimate-send`, `05-deposit-non-stripe`, `06-deposit-stripe`, `07-deposit-management`, `08-decline-cancel-expire`, `09-job-creation`, `14-e2e-deposit-flows`, `17-guard-tests`, `18-read-filters-stats`, `redesign-14-estimate`, `redesign-15-deposit-invoice`, `redesign-21-duplicate-guard`, `redesign-22-rbac`, `redesign-25-probes-money`, `redesign-29-entrypoints`, `visual-screenshots` | API-tier and mixed specs referencing `/estimates` routes. |

Vitest units that pin behaviour: `__tests__/estimates-page.test.tsx` (heading, 7 KPI labels
selected as `{selector:'span'}`, customer name in table, search placeholder, mount params,
the FilterBar -> URL + request-param round trip, and all three KPI-tile click semantics),
`estimate-detail-deposit.test.tsx`, `estimate-detail-preview.test.tsx`,
`estimate-form-qty-validation.test.tsx`, `estimate-form-qty-text-input.test.tsx`, plus
`list-status-defaults.test.tsx` (the `status: undefined` key baseline).

---

## 9. Shared / cross-module components (do not fork or edit)

| component | file | also used by |
|---|---|---|
| `EstimateDocumentView` | `components/estimates/EstimateDocumentView.tsx` | **`PublicEstimatePage` (module 13)**, `EstimateFormPage` preview, `EstimateDetailPage` preview |
| `ESTIMATE_STATUS` | `constants/estimateStatus.ts` | PublicEstimatePage, list registry, reports |
| `customerDisplayName` | `lib/customer-name.ts` | PublicEstimatePage, many list pages |
| `formatCurrency`, `formatPhone`, `cn`, `extractApiError` | `lib/utils.ts` | everywhere |
| `LineItemsEditor` | `components/shared/LineItemsEditor.tsx` | `StandaloneInvoiceFormPage` (module 6) |
| `JobLeadTasksTab` | `components/tasks/JobLeadTasksTab.tsx` | Job detail, Lead detail (modules 5, 2) |
| `PdfPreviewDialog` + `fetchPdf` | `components/estimates/PdfPreviewDialog.tsx` | invoices also render PDFs |
| `DataTable`, `KpiStrip`, `StatusBadge`, `FilterBar`, `AppliedChips`, `SelectField`, `Breadcrumb` | `components/ui/*`, `components/filters/*`, `components/common/*` | every list/detail page |
| `useFilterState`, `urlCodec`, `estimatesRegistry` | `lib/filters/*` | Jobs/Leads registries share the machinery |
| `useTableView` | `hooks/useTableView.ts` | every `tableKey` table |
| `useOrganization` | `lib/api/organization.ts` | settings, invoices |
| `PAYMENT_METHOD_LABELS/ORDER` | `lib/payment-methods.ts` | invoices, settings |

**Boundary warning for the build phase:** `EstimateDocumentView` is rendered by the PUBLIC
estimate page. Any change to it - markup, tokens, props - crosses into module 13 and changes
what the customer sees. A v2 estimate detail/form page must either import it unchanged or
introduce a v2-only sibling; it must not edit the original.

---

## 10. Behaviour-parity checklist for the v2 build

1. Route order `/estimates/new` -> `/estimates/:id/edit` -> `/estimates/:id`.
2. All four routes inside the 4-role `ProtectedRoute`; no extra gate.
3. `listParams` keeps its full `undefined` key baseline including `status`.
4. `resolveMax` returns the literal `100000`.
5. KPI activation logic (monthly vs all-time, the deposit-tile asymmetry) copied verbatim.
6. `stats.approved` -> "Won" tile, `stats.cancelled` -> "Archived" tile.
7. Empty state is the single string `No results found.` with no filter-aware variant.
8. `quantity` stays a digit-stripping text input.
9. The totals memo is copied character-for-character (rounding order + proportional taxable
   allocation).
10. `Deposit: 50%` stays hard-coded on the form sidebar.
11. `description = detail ? name + "\n" + detail : name` on submit; split on the first `\n` on load.
12. Create Job disabled-title text and its `['PAID','VOIDED']` allowlist unchanged.
13. Record Payment renders disabled (not hidden) when the ability is missing, with its title.
14. Delete has no confirmation dialog.
15. Copy Link produces no toast.
16. `refund-deposit-dialog` / `refund-deposit-submit` testids preserved exactly.
17. Every accessible name / placeholder / DOM id in section 8.2 preserved.
18. Query keys and invalidation targets identical (section 2.6, 4.2, 5.x) - including the
    two known gaps (`duplicate` invalidates only `['estimates']`; the form's edit path does not
    invalidate `['estimate', id]`).

---

## 11. Public estimate page - shared surface only (NOT mapped)

`/p/estimates/:id` (`pages/PublicEstimatePage.tsx`, module 13) is unauthenticated, token-gated
(`?token=`), and hits `GET /api/estimates/:id/public`, `POST /api/estimates/:id/approve`,
`POST /api/estimates/:id/decline`, `GET /api/estimates/:id/public/pdf` - all mounted BEFORE
`authenticate` in `estimate.routes.ts:14-17` with `unscopedRequest` + rate limiters.
It imports, from this module's surface: `EstimateDocumentView`, `ESTIMATE_STATUS`,
`customerDisplayName`, `formatCurrency`, `safe-href`, and the ui primitives
Card/Button/Checkbox/Dialog. It additionally uses `react-signature-canvas`.
The authed pages link INTO it in one place: the detail page's Copy Link button
(`origin + /p/estimates/:id?token=...`). Nothing else couples the two.

---

## 12. Open questions / genuine ambiguities

1. **Lead-less create is a live dead end.** `NewEstimateDialog` offers "Create estimate without
   a lead" -> `/estimates/new?customer_id=X`, but `createEstimateSchema` requires `lead_id`, so
   submit 400s. Unmerged branch `origin/fix/issue-657-remove-leadless-estimate-deadend`
   exists. **Decision needed:** reproduce the dead end in v2 (my recommendation - it is a
   behaviour, and fixing it is out of scope for a presentation swap), or wait for that branch.
2. **The form's zod schema is declared inline and not exported.** The plan forbids forking
   shared logic, but there is nothing to import. Either export it from the original file (a
   one-line, additive edit to a non-v2 file - needs sign-off, since the plan says "no existing
   page file is edited") or accept a duplicated schema in v2 with a comment. Raise before building.
3. **`Deposit: 50%` on the form sidebar** contradicts the org's configured deposit default that
   `SendEstimateDialog` honours. I have mapped it as-is. Confirm the v2 page should keep the
   inconsistency rather than quietly aligning it.
4. **Tax-state matching by rate** (`Math.abs(diff) < 0.0001`) mis-labels two states that share a
   rate. Fixed on the 904 branch (`b45bae33`), not on main. v2 should reproduce main's behaviour.
5. **Detail page has no distinct error state** - a failed `['estimate', id]` fetch renders
   "Estimate not found". Confirm v2 should not add an error state.
6. **Cancel is not offered for PENDING** in the UI although the API accepts it. Reproduce, or
   is this a bug to file separately?
7. **`sendMutation` on the detail page is dead code.** Safe to omit from v2, but flagging so a
   reviewer does not read the omission as a lost call site.
8. **`toExportRow` dereferences `e.lead.customer` unguarded** while the table cell guards for a
   missing customer. If a lead-less/customer-less estimate can reach the list (see
   `origin/fix/estimates-list-leadless-customer`), CSV export throws. Not reproducible from
   code alone - needs a data check.
9. **No live-browser crawl was performed.** This map is source-derived only (Chrome tooling was
   out of scope for this agent). Hover/focus micro-interactions, exact toast timing and any
   runtime-only behaviour are unverified.
