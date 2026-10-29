# Customers module - behaviour map (UI-kit migration, Phase 1)

Status: mapping complete 2026-07-29. **Documentation only - no code was changed.**
Scope: `/customers`, `/customers/new`, `/customers/:id`, `/customers/:id/edit`,
`/customers/:customerId/statement`.
Method: every statement below was read out of the files cited. Anything I could not
confirm from source is in [Open questions](#12-open-questions), not asserted.

Source files (absolute):

| Concern | File |
|---|---|
| List | `C:\Users\97250\Desktop\RonT\WorkSpace\ALPHA_CRM\frontend\src\pages\CustomersPage.tsx` |
| Create/Edit form | `...\frontend\src\pages\CustomerFormPage.tsx` |
| Detail | `...\frontend\src\pages\CustomerDetailPage.tsx` |
| Statement (SHARED) | `...\frontend\src\pages\StatementPage.tsx` |
| Routes | `...\frontend\src\App.tsx` (lines 111-130) |
| Filter registry | `...\frontend\src\lib\filters\registries\customers.ts` |
| Filter URL binding | `...\frontend\src\lib\filters\useFilterState.ts`, `...\lib\filters\urlCodec.ts` |
| Filter UI | `...\frontend\src\components\filters\FilterBar.tsx`, `...\components\filters\AppliedChips.tsx` |
| Table | `...\frontend\src\components\ui\data-table.tsx`, `...\hooks\useTableView.ts` |
| KPI tiles | `...\frontend\src\components\ui\KpiStrip.tsx` |
| Contact cell | `...\frontend\src\components\ui\ContactCell.tsx` |
| Duplicate dialog | `...\frontend\src\components\customers\DuplicateCustomerDialog.tsx` |
| Location dialog | `...\frontend\src\components\customers\LocationFormDialog.tsx` |
| Comms tab | `...\frontend\src\components\communication\CustomerCommunicationsTab.tsx` |
| Tasks tab | `...\frontend\src\components\tasks\JobLeadTasksTab.tsx` |
| Service-plan dialog | `...\frontend\src\pages\service-plans\ServicePlansPage.tsx` (`PlanBuilderDialog`) |
| Lifecycle API wrappers | `...\frontend\src\lib\api\customers.ts` |
| Statement API wrappers | `...\frontend\src\lib\api\statements.ts` |
| Backend routes | `...\backend\src\routes\customer.routes.ts` |
| Backend controller | `...\backend\src\controllers\customer.controller.ts` |
| Duplicate guard | `...\backend\src\lib\customer-duplicate.ts` |

---

## 1. Routes and guards

All five routes live inside the same two wrappers in `App.tsx`:

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />}>
  <Route element={<AppLayout />}>
    /customers                        -> CustomersPage
    /customers/new                    -> CustomerFormPage
    /customers/:id/edit               -> CustomerFormPage
    /customers/:id                    -> CustomerDetailPage
    /customers/:customerId/statement  -> StatementPage
    ...
    /jobs/:jobId/statement            -> StatementPage      (SHARED - see §7)
```

- All page components are `React.lazy` imports (`App.tsx` lines 21, 46-47) - a Suspense
  fallback is whatever `App.tsx` provides around the route block.
- **No feature/entitlement gate** on any customer route (frontend) and none on
  `backend/src/routes/customer.routes.ts` - no `requireFeature`/`useFeature` anywhere in
  the module. The only entitlement-adjacent surface is the Comms tab, which is gated by the
  CASL ability `read Communication` (§6).
- There is **no route-level redirect** in this module. `/customers/new` and
  `/customers/:id/edit` render the same component; the discriminator is `useParams().id`
  (`isEdit = Boolean(id)`).
- Route ordering note: `/customers/new` is declared before `/customers/:id`, and
  `/customers/:id/edit` before `/customers/:id`.
- **Role vs API mismatch (real, keep it):** `TECHNICIAN` is allowed through
  `ProtectedRoute` but has **no `read Customer` grant** in
  `backend/src/lib/permissions/defaultGrants.ts`, so `GET /api/customers*` 403s for a bare
  technician. The pages render their loading/empty shells and the query errors; neither page
  has an error branch for the list query (see §8).

---

## 2. `/customers` - CustomersPage

### 2.1 Component tree

```
<div class="space-y-6">
  Page header
    <h1><User icon/> Customers</h1>
    total pill:  data.pagination.total !== undefined -> <span>{total}</span>
                 else if isLoading                    -> pulsing placeholder span
                 else                                 -> nothing
  <KpiStrip loading={statsLoading} items={[4 tiles]} />        // §2.3
  <DataTable
      tableKey="customers"
      columns={columns}                                        // §2.2
      data={data?.customers ?? []}
      pagination={data?.pagination}
      isLoading={isLoading}
      searchValue / onSearchChange
      onRowClick -> navigate(`/customers/${customer.id}`)
      sorting / onSortingChange
      columnVisibility / onColumnVisibilityChange
      filters={ <FilterBar/> + "Show archived" checkbox }      // §2.4
      activeFilters={ hasActiveFilters ? <AppliedChips/> + standalone chips + "Clear all" : null }
      headerActions={ Export dropdown + (canCreate && "Add Customer") }
  />
</div>
```

`DataTable` itself contributes (from `data-table.tsx`):
toolbar (search input, `filters` slot, **Columns** popover, `headerActions` slot) ->
`activeFilters` slot -> desktop table **or** mobile stacked cards (`useIsMobile`, exclusive
render, not CSS-only) -> pagination bar -> right-click header context menu.

### 2.2 Columns (`export const columns`, order fixed)

| id | header | size | sortable | meta | cell |
|---|---|---|---|---|---|
| `customer_number` | Customer # | 112 | yes | pinned, fixed, minWidth 112 | `customer_number ?? '—'`, tabular-nums |
| `name` | Customer | 170 | yes | locked (non-hideable), pinned, growWeight 1.5, minWidth 150 | Avatar with `getInitials` fallback + `customerDisplayName(c)` |
| `phone` | Phone | 140 | **no** | fixed, minWidth 80 | `<ContactCell type="phone">` |
| `email` | Email | 185 | **no** | growWeight 1.5, minWidth 120 | `<ContactCell type="email">` |
| `address` | Address | 180 | **no** | growWeight 2, minWidth 100 | `service_locations[0]` -> `"{city}, {state} {zip}"`; null when no location |
| `company` | Company | 120 | yes | fixed | `company_name \|\| null` |
| `source` | Source | 140 | **no** | fixed | `<Badge variant="outline">` tinted by `AD_SOURCE_STYLES` map; null when no `ad_source` |
| `leads` | Leads | 74 | **no** | fixed, minWidth 50 | `_count.leads` |
| `jobs` | Jobs | 74 | **no** | fixed, minWidth 50 | `_count.jobs` |
| `created_at` | Member Since | 120 | yes | fixed, minWidth 90 | `formatExactDate(created_at)` |

`getInitials`: first+last initials uppercased; else first char of `company_name`; else `?`.
`AD_SOURCE_STYLES` keys: Google / Facebook / Referral / Yelp / Instagram / Direct Mail /
Door Hanger / Other; unknown source falls back to the gray style. **These are raw Tailwind
palette classes today** - the v2 build must map them to tokens.

`ContactCell` behaviour (shared): renders nothing when value is empty **or** when
`isPlaceholderPhone/isPlaceholderEmail` matches; otherwise an `<a href="tel:|mailto:">`
(click `stopPropagation` so the row click does not fire) plus a hover-revealed copy button
(`aria-label` "Copy phone number" / "Copy email address") that writes to the clipboard and
swaps to the text "Copied!" for 2000 ms.

### 2.3 KPI tiles (`KpiStrip`, all 4 clickable, tone `primary`)

| Tile | value | sub | active condition | onClick |
|---|---|---|---|---|
| Total Customers (`Users`) | `stats.total ?? 0` | "All time" | `activeKpi === 'total'` | `handleTotalKpi` - no-op if already active, else `clearAllFilters()` |
| New This Month (`UserPlus`) | `stats.newThisMonth ?? 0` | `new Date().toLocaleDateString('en-US',{month:'short',year:'numeric'})` | `activeKpi === 'month'` | `handleMonthKpi` - if already active behaves as Total; else `setValue({created:{kind:'dateRange',from:monthStart,to:''}})`, clear search, clear openLeads/activeJobs, page=1. **Deliberately does NOT reset `include_archived`.** |
| Active Leads (`ClipboardList`) | `stats.activeLeads ?? 0` | "Open leads" | `activeLeadsKpi` | toggle: if active -> `clearAllFilters()`; else `clearAllFilters()` then `setOpenLeads(true)`, page=1 |
| Active Jobs (`Wrench`) | `stats.activeJobs ?? 0` | "In progress" | `activeJobsKpi` | same shape with `setActiveJobs(true)` |

Active-state algebra (reproduce exactly):

```
adSourceValues/paymentTypeValues/taxExemptValues/hasLeadsValues/hasJobsValues  = value[k].values or []
leadsRangeActive = leads range with from!=null or to!=null
jobsRangeActive  = jobs range with from!=null or to!=null
createdActive    = created.from || created.to

noManualFilters   = all five multi arrays empty && !leadsRangeActive && !jobsRangeActive
                    && !openLeads && !activeJobs && !search
noFilters         = noManualFilters && !createdActive
activeKpi         = (created.from === monthStart && !created.to && noManualFilters) ? 'month'
                  : noFilters ? 'total' : null

noOtherManualFilters = five multi arrays empty && !leadsRangeActive && !jobsRangeActive && !search
activeLeadsKpi    = openLeads && !activeJobs && noOtherManualFilters && !createdActive
activeJobsKpi     = activeJobs && !openLeads && noOtherManualFilters && !createdActive
```

`include_archived` is excluded from every KPI-active computation.
`KpiTile` renders as a `<button type="button">` when `onClick` is present; `active` adds
`border-primary/40 ring-2 ring-primary/15`; no active pill is rendered (no `activeLabel`).
`loading` (strip-level `statsLoading`) swaps the value for a pulsing block.

### 2.4 Filters

**Registry-driven facets** (`customersRegistry`, 8 facets, ALL static options, no dynamic
`optionSource`). Rendered by `FilterBar` as a two-pane popover:
trigger = outline `Button` "Filter" + count badge (`totalSelected`); popover = header
("Filters" + "Clear all (N)" when N>0), left `role="tablist"` rail (one `role="tab"` per
facet with count badge), right pane control, footer ("N selected across M filters" + "Done"
button which just closes the popover).

| key | kind | param(s) sent | label | options |
|---|---|---|---|---|
| `ad_source` | multi | `ad_source=a,b` | Source | Google, Facebook, Referral, Yelp, Instagram, Direct Mail, Door Hanger, Other |
| `payment_type` | multi | `payment_type=` | Payment Type | COD, EOM, NET 15, NET 30, NET 60 |
| `tax_exempt` | multi | `tax_exempt=` | Tax Exempt | `true`->"Tax Exempt", `false`->"Not Tax Exempt" |
| `has_leads` | multi | `has_leads=` | Leads | `true`->"Has Leads", `false`->"No Leads" |
| `has_jobs` | multi | `has_jobs=` | Jobs | `true`->"Has Jobs", `false`->"No Jobs" |
| `leads` | range | `leads_min`,`leads_max` | # of Leads | min 0, max via `resolveMax('customers.maxLeads')` = **50** |
| `jobs` | range | `jobs_min`,`jobs_max` | # of Jobs | min 0, max via `resolveMax('customers.maxJobs')` = **50** |
| `created` | dateRange | `created_after`,`created_before` | Created | - |

Wire format (`urlCodec.ts`): multi -> comma-joined single param; range -> `_min`/`_max`;
dateRange -> `_after`/`_before`. Empty values are omitted entirely. Selecting **both**
options of a 2-option multi yields e.g. `has_leads=true,false`, which the backend treats as
no filter (guarded by a unit test).

**Standalone (NOT registry) state**, deliberately excluded from the registry:
`open_leads`, `active_jobs` (KPI-only booleans), `include_archived` (a plain checkbox),
`search`, pagination, sort, column visibility. A **State** facet is intentionally absent and
is guarded by `customers-filter-no-state.test.tsx`.

"Show archived" checkbox lives in the `filters` slot next to the FilterBar: `onChange` sets
`includeArchived` and resets page to 1. Label text: `Show archived`.

**Applied-filters strip** renders only when
`hasActiveFilters = Object.keys(value).length > 0 || openLeads || activeJobs || includeArchived`
(search is deliberately not part of it). Contents in order: `<AppliedChips>` (one removable
chip per facet value, `"{facet.label}: {value}"`, collapsing past 3 values per multi facet
into a `+N more` chip that clears the whole facet), then `FilterChip` "Has open leads",
"Has active jobs", "Including archived" (each removes its own flag and resets page 1), then
a ghost `Button` "Clear all" -> `clearAllFilters()`.

`clearAllFilters()` = `setValue({})` + openLeads false + activeJobs false + includeArchived
false + search '' + page 1.

Any facet change routes through `handleFilterChange` -> `setValue(next)` + `setPage(1)`.

### 2.5 API interactions

| # | Hook | Query key | Method + endpoint | Params | Notes |
|---|---|---|---|---|---|
| 1 | `useQuery<CustomerStats>` | `['customer-stats']` | `GET /api/customers/stats` | - | `staleTime: 30_000`. Shape `{total, newThisMonth, activeLeads, activeJobs}` |
| 2 | `useQuery` | `['customers', {page,pageSize,search,value,openLeads,activeJobs,includeArchived,sortBy,sortDir}]` | `GET /api/customers` | `{page, limit: pageSize, ...listParams}` | `staleTime: 30_000`, `placeholderData: keepPreviousData`. Response `{customers, pagination:{page,limit,total,totalPages}}` |
| 3 | imperative `api.get` | none (not a query) | `GET /api/customers/export` | `listParams` (no page/limit) | "All customers" export |
| 4 | `useTableView('customers')` | `['table-views','customers']` | `GET /api/table-views/customers` (via `lib/api/table-views`) | - | `staleTime` 5 min, `retry:false` |
| 5 | `useTableView` save | invalidates `['table-views','customers']` | `PUT` | `{version:1, columns:{...}}` | fires a toast "Saved to your account" |

`listParams` is built with **explicit `undefined` placeholders** for every facet-owned key
(`ad_source, payment_type, tax_exempt, has_leads, has_jobs, leads_min, leads_max, jobs_min,
jobs_max, created_after, created_before`) plus `search`, `open_leads: 'true'|undefined`,
`active_jobs: 'true'|undefined`, `include_archived: true|undefined`, `sortBy`,
`sortDir: sortBy ? dir : undefined`, then `...filterParams` spread last (facet values win).
Axios drops `undefined` params. **Reproduce the key set** - a unit test asserts
`expect.objectContaining({ page:1, limit:25, ad_source: undefined })`.

No mutations, no optimistic updates, no cache invalidation on this page.

### 2.6 Interactive elements (exhaustive)

| Element | Where | Action |
|---|---|---|
| Search input | DataTable toolbar, placeholder `Search customers...` | local state, **300 ms debounce** -> `onSearchChange` -> `setSearch` + page 1 |
| **Columns** button | DataTable toolbar | opens a `Popover`: one checkbox per column (locked `name` column disabled with a lock glyph), separator, "Save current view" (server PUT + toast), "Reset to default columns", "Reset column widths" |
| **Filter** button | `filters` slot | opens the FilterBar popover (§2.4) |
| Show archived checkbox | `filters` slot | toggles `include_archived`, page 1 |
| **Export** dropdown (outline Button + `Download` icon) | `headerActions` | `DropdownMenu` with label "Export as CSV", separator, item **"Current page (N rows)"** -> `handleExportCurrentPage`, item **"All customers (total)"** -> `handleExportAll` |
| **Add Customer** (`variant="business"`, `Plus` icon) | `headerActions` | `navigate('/customers/new')`. Rendered only when `canCreate` (§6) |
| Column header click | table head | toggles sort (guarded so a resize-drag does not sort); `aria-sort` set; `onSortingChange` -> `setSorting` + page 1 |
| Column header right-click | table head | fixed-position context menu: "Reset this column width" / "Reset all widths" |
| Column resize handle | header + body cells | drag to resize (`columnResizeMode: 'onChange'`), double-click = auto-fit to visible rows clamped to `[minWidth, 600]`; both mark the column "manually sized" |
| **Row click** | table row / mobile card | `navigate('/customers/{id}')` (suppressed while `wasResizing`) |
| Phone / email link in a cell | `ContactCell` | `tel:` / `mailto:`, `stopPropagation` |
| Copy button in a cell | `ContactCell` | clipboard write, "Copied!" for 2 s |
| Prev / Next / page-size select | pagination bar | `setPage`, `setPageSize` (+ page 1). Bar renders only when `totalPages > 1 || onPageSizeChange` |
| KPI tiles x4 | KpiStrip | §2.3 |
| Chips "x" + "Clear all" | activeFilters | §2.4 |

**No keyboard shortcuts** are bound on this page.

CSV export details (`toExportRow`): columns are exactly
`First Name, Last Name, Email, Additional Emails, Phone, Address, City, State, ZIP, Company,
Ad Source, Leads, Jobs, Created At`. Additional emails are joined with `'; '` as
`email (label)` when labelled. Phone runs through `formatPhone`. `Created At` uses
`toLocaleDateString()`. Filenames: `customers-page{page}-{YYYY-MM-DD}.csv` and
`customers-all-{YYYY-MM-DD}.csv`. Current-page export returns early (silently) when there
are zero rows. `handleExportAll` failure -> `toast({title:'Export failed', description:
'Failed to export customers. Please try again.', variant:'destructive'})`.

### 2.7 Local UI state and URL sync

| State | Owner | URL-synced? | Persisted? |
|---|---|---|---|
| `value` (8 facets) | `useFilterState(customersRegistry)` | **yes** - `setSearchParams(..., {replace:true})`, preserves unrelated params | no |
| `search` | `useState('')` | no | no |
| `page`, `pageSize` (25 default) | `useState` | no | no |
| `sorting` | `useState(DEFAULT_CUSTOMERS_SORTING)` = `[{id:'created_at', desc:true}]` | no | no |
| `columnVisibility` | `useState({})`, controlled into DataTable | no | **server-side** saved view (`table-views/customers`), applied once when the query settles |
| column widths / manually-sized set | inside DataTable | no | same server saved view |
| `openLeads`, `activeJobs`, `includeArchived` | `useState(false)` | no | no |

There is **no `localStorage` usage anywhere in this module** - saved views are server-backed.

---

## 3. `/customers/new` and `/customers/:id/edit` - CustomerFormPage

Single component. `isEdit = Boolean(useParams().id)`.
`returnTo = location.state?.returnTo` (nothing in the app currently navigates here with
that state - see Open questions).

### 3.1 Data loads

| Hook | Key | Endpoint | Enabled |
|---|---|---|---|
| `useQuery` | `['customer-form', id]` | `GET /api/customers/:id` -> `data.customer` | `isEdit`, `staleTime: 0` |
| `useOrganization()` | `['organization']` | `GET /api/organization` | always. Supplies `source_options[]` and `billing_terms_options[]` |
| `useQuery<ParentCustomerOption[]>` | `['customers-parent-candidates', debouncedFranchiseQuery]` | `GET /api/customers?is_parent=true&search=<q>&limit=100` | only when `account_type === 'under'` |
| `useQuery<ParentCustomerOption\|null>` | `['customer-parent', parentId]` | `GET /api/customers/:parentId` -> `data.customer` | `isEdit && Boolean(parentId)` |

Franchise search is debounced **250 ms** (`franchiseQuery` -> `debouncedFranchiseQuery`).

### 3.2 Zod schema

Exported as `customerSchema` from `CustomerFormPage.tsx` (imported by
`customer-form-schema-optional-fields.test.ts` - **must stay exported from wherever v2
imports it; do not fork it**). `type CustomerFormData = z.infer<typeof customerSchema>`.

Object fields:

| Field | Type | Rules |
|---|---|---|
| `kind` | enum PERSON \| COMPANY | default `'PERSON'` |
| `segment` | enum RESIDENTIAL \| COMMERCIAL | optional |
| `first_name`, `last_name` | string | max 100, optional |
| `company_name` | string | max 200, optional |
| `email` | string | `.email('Enter a valid email address')`, optional, `.or(z.literal(''))` |
| `phone` | string | max 20, optional |
| `phone_ext` | string | max 10, optional |
| `extra_emails[]` | `{email?: string, label?: string(max 50)}` | optional array |
| `phones[]` | `{phone?, label?(50), extension?(10), is_primary?}` | optional array |
| `ad_source`, `source` | string | optional |
| `allow_billing`, `tax_exempt` | boolean | optional |
| `account_type` | enum individual \| under | default `'individual'` (UI-only) |
| `is_franchise` | boolean | optional (UI-only) |
| `parent_id` | string | optional (UI-only) |
| `billing_terms` | string | optional |
| `address_line1`/`address_line2` | string | max 200, optional |
| `city` | string | max 100, optional |
| `state` | string | max 2, optional |
| `zip` | string | max 10, optional |
| `billing_same_as_service_location` | boolean | optional (UI-only) |
| `billing_address_line1/2` | string | max 200, optional |
| `billing_city` | string | max 100, optional |
| `billing_state` | string | max 2 + refine "Use the 2-letter state code" when non-empty |
| `billing_zip` | string | max 10, optional |
| `notes` | string | max 5000, optional |
| `created_at` | string | optional (admin-only field) |

`superRefine` rules (messages are load-bearing; e2e/unit tests read them):

1. `kind === 'COMPANY'` -> `company_name` required ("Company name is required" on
   `company_name`); otherwise `first_name` required ("First name is required"). **Last name
   is never required.**
2. Contact: `digitsOf(phone).length === 0 && !email.trim()` -> issue on `phone`
   `"Enter a phone number or an email"`. If phone has digits but not exactly 10 ->
   `"Enter a 10-digit phone number"` on `phone`.
3. Service address is optional but **all-or-nothing**: if any of
   `address_line1|city|state|zip` is non-blank then
   - missing `address_line1` -> "Street address is required to save an address"
   - missing `city` -> "City is required to save an address"
   - `state.trim().length !== 2` -> "Use the 2-letter state code"
   - missing `zip` -> "ZIP is required to save an address"
4. Each non-empty `phones[i].phone` must be exactly 10 digits -> issue at
   `['phones', i, 'phone']`.
5. Each non-empty `extra_emails[i].email` must match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` ->
   issue at `['extra_emails', i, 'email']`.

`useForm({ resolver: zodResolver(customerSchema), defaultValues: emptyDefaults, values:
editValues, mode: 'onTouched' })` - **`values` (not `reset`) drives edit hydration**, so
server data wins on every refetch.

`emptyDefaults`: all strings `''`, arrays `[]`, `kind:'PERSON'`, `segment: undefined`,
`allow_billing:false`, `tax_exempt:false`, `account_type:'individual'`,
`is_franchise:false`, **`billing_same_as_service_location: true`**.

### 3.3 Edit-mode hydration (`editValues` useMemo) - the subtle part

- Primary location = `service_locations.find(is_primary) || service_locations[0]`.
- `phone` and every `phones[i].phone` are run through `formatPhoneInput` (storage is
  digits-only canonical; the input shows the mask).
- `billingSet` = any of `billing_address_line1|city|state|zip` truthy.
- `billingMirrorsService` compares **line1, city, state, zip only - NOT line2** (backend
  `applyBillingCopy` omits line2).
- `hasDifferentBilling = billingSet && !billingMirrorsService`.
- `billing_same_as_service_location = !hasDifferentBilling`; when mirrored, all `billing_*`
  form fields hydrate as `''` (issue #438 - revealing the billing box must open **blank**,
  never pre-filled with the service address). Guarded by `customer-billing-toggle.test.tsx`.
- `account_type = customer.parent_id ? 'under' : 'individual'`;
  `is_franchise = parent_id ? false : Boolean(customer.is_parent)`.
- `source = customer.source ?? customer.ad_source ?? ''`.
- `created_at = customer.created_at.slice(0,10)` (date input format).

### 3.4 Layout and every control

Header: ghost `Button` "Back" (`ArrowLeft`) -> `navigate(-1)`; `<h1>` = "Edit Customer" |
"New Customer".

`<form id="customer-form" data-testid="customer-form" onSubmit={onSubmitForm}>` wrapping a
card:

**Kind pill** - `div[role=radiogroup][data-testid="customer-kind-select"]` with two
`button[role=radio]` "Person" / "Company"; click -> `setValue('kind', k, {shouldValidate:true})`.

**Left column - Contact** (heading "Contact"):
- `kind === 'COMPANY'`: `company_name` (required, id `company_name`, placeholder "Acme
  Restaurant Group") + optional "Contact First Name" / "Contact Last Name".
- else: `first_name` (required, placeholder "Jane") + `last_name` (optional, "Alvarez") +
  optional `company_name` (placeholder "(optional)").
- Phone block: label "Phone", helper "Provide a phone number or an email below."
  - primary row: `Controller`-wrapped `Input#phone` (`inputMode="tel"`, placeholder
    "(555) 123-4567", `w-44`) whose `onChange` applies `formatPhoneInput`; plus
    `Input` "Ext" (`phone_ext`, `inputMode="numeric"`, `w-20`); plus a 4-unit spacer.
  - repeatable rows from `useFieldArray('phones')`: masked phone (placeholder "Additional
    phone") + Ext + `X` button `aria-label="Remove phone"` -> `removePhone(index)`.
  - "**+ Add Phone**" link-button -> `appendPhone({phone:'',label:'',extension:'',is_primary:false})`.
  - Field errors render as `<p class="text-xs text-danger">` under each row and the input
    gains `border-danger`.
- Email block: label "Email"; `Input#email type=email` (placeholder "jane@example.com");
  repeatable `useFieldArray('extra_emails')` rows (placeholder "Additional email" +
  `X` `aria-label="Remove email"`); "**+ Add Email**" -> `appendEmail({email:'',label:''})`.
  Note: the `label` sub-field exists in the schema and payload but has **no input** in the UI.
- Source `Select` labelled "How Did They Hear About Us?": value = `source || '__none__'`;
  choosing a value sets **both** `source` and `ad_source`; options are
  `org.source_options`, prepended with the current value if it is not in the list; when the
  list is empty a single disabled item "No options - add some in Settings".
- **Admin-only** (`isEdit && isAdmin`): `Input#created_at type=date` labelled "Customer
  Since" with `max = today`.

**Right column**:
- "Service Address" heading + helper "Optional - add it if you have one; you can add it
  later."
- `<AddressAutocomplete id="address_line1">` (Google Places v1, 3-char minimum, 300 ms
  debounce, needs `VITE_GOOGLE_MAPS_API_KEY`). `onSelect` fills `address_line1,
  address_line2, city, state, zip`.
- Grid of `City` (col-span-3) / `State` (`maxLength={2}`, col-span-1) / `ZIP` (col-span-2),
  each flagged `border-danger` on error; a single combined error `<p>` shows the first of
  city/state/zip messages.
- Billing (inverted): when `billing_same_as_service_location` is true, a tinted row
  "Billing address is the same as the service address" (`Check` icon) with a link-button
  "**Use a different billing address**" (`Pencil`) that **blanks all five billing fields**
  then flips the flag to false. When false, a bordered box titled "Billing Address" with an
  outline `Button` "**Same as service address**" (full-size `h-9`, outline/sm - asserted by
  `customer-form-billing-same.test.tsx`) that flips the flag back to true, plus a second
  `AddressAutocomplete id="billing_address_line1"` and City/State/ZIP inputs.
- Notes `Textarea#notes` rows=6, placeholder "Internal notes...".

**"More Details (optional)"** collapsible, anchored by
`div[data-testid="customer-billing-group"]`; trigger is a button with a `ChevronDown` that
rotates 180deg when open. Body (two cards) renders only when `moreOpen`:

*Card 1*
- `Select` "Home or Business?" -> `segment` (`RESIDENTIAL` = "Home (residential)",
  `COMMERCIAL` = "Business (commercial)"; `__none__` clears to `undefined`).
- "Account Type" `div[role=radiogroup]` with two custom `RadioRow` buttons
  (`button[role=radio][aria-checked]`): "Individual Account" and "Under a Franchise"
  (the latter also forces `is_franchise=false`).
- Beside "Individual Account": a `Checkbox` "This is a franchise", **disabled unless**
  `account_type === 'individual'` (and visually 40% opacity when disabled).
- Reserved 64px slot: when `account_type === 'under'`, the franchise picker -
  - if `parent_id` set: a pill with `Building2` + resolved label + "Change" button
    (clears `parent_id`, clears the query).
  - else: a `Search`-prefixed `Input` "Search by name..."; while the query is non-empty a
    bordered result list of `franchiseMatches` (client-side `includes` filter over
    `parentOptions`); each result sets `parent_id` and clears the query; empty result ->
    "No matching accounts found."
  - `parentOptions` = candidates with `!parent_id` and `id !== id` (self excluded).
  - `pickedParent.label` = candidate match -> by-id fetch -> literal `'Selected franchise'`.

*Card 2*
- "Allow Billing" `Switch` -> `allow_billing`. When on, a `Select` "Billing Terms" from
  `org.billing_terms_options` (same current-value-prepend + empty-state item as Source).
  Reserved `min-h-[84px]`.
- "Tax Exempt" `Switch` -> `tax_exempt`. When on, an outline `Button` "**Upload
  Certificate**" (`Upload`) that clicks a hidden `input[type=file]`
  (`accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"`), plus a caption
  showing `certFile.name` or "PDF or image". The input resets `e.target.value = ''` after
  each pick. Reserved `min-h-[44px]`.

**Submit error block** (inside the card, only when `mutationError`): `extractApiError(err,
'Something went wrong')` plus, when the 400 response carries `details[]`, a `<ul>` of
`field: message`.

**Pinned footer** (outside the form, `form="customer-form"` association):
- ghost `Button` "Cancel" -> `navigate(-1)`, disabled while `pending`
- outline `Button` "Save & Create Lead" -> `onSaveAndLead`, disabled while `pending`
- `variant="business"` `Button[type=submit][form=customer-form]`
  `data-testid="customer-form-submit"`, label `pending ? 'Saving…' : isEdit ? 'Save Changes'
  : 'Create Customer'`.

### 3.5 Submit path

`buildPayload(data, isAdmin)` strips the UI-only fields and produces:

```
hasLocation = Boolean(address_line1 && city && state && zip)

account_type==='under' && parent_id  -> parent_id = parent, bill_to_customer_id = parent, is_parent=false
account_type==='individual' && is_franchise -> is_parent = true (parent_id/bill_to null)

billing_same_as_service_location ? billing_* mirror the service address (line2 included,
                                    all null when !hasLocation)
                                 : billing_* taken from the form (|| null)

payload = {
  kind, segment: segment || 'RESIDENTIAL',
  first_name/last_name/company_name: trimmed || null,
  email: trimmed || null,
  phone: <the FORMATTED string, e.g. "(555) 123-4567">,   // backend normalizes
  phone_ext: || null,
  ad_source: source || null, source: source || null,       // both sent, both from `source`
  allow_billing: ?? false, tax_exempt: ?? false,
  billing_terms: || null, notes: trimmed || null,
  is_parent, parent_id, bill_to_customer_id,
  ...billingAddress,
  extra_emails: rows with a non-blank email -> {email: trimmed, label: label || undefined},
  phones:       rows with a non-blank phone -> {phone, label?, extension?, is_primary: ?? false},
  ...(isAdmin && created_at ? { created_at } : {}),
}
```

**Storage shape note for the build phase:** the form submits the *formatted* phone string;
the backend Zod (`requiredCustomerPhone`/`optionalCustomerPhone`) normalizes to digits-only
canonical, and the UI re-masks on read via `formatPhoneInput` / `formatPhone`. Do not
"fix" this by sending digits - it would be a logic change.

`save(data, override)`:
- **edit**: `PATCH /api/customers/:id` with the payload; then if `hasLocation`,
  `PATCH /api/customers/:id/locations/:primaryLocationId` when a primary location exists,
  else `POST /api/customers/:id/locations` with `{...locData, is_primary:true}`.
  Returns `res.customer?.id ?? id`.
- **create**: `POST /api/customers` (or `POST /api/customers?override=true`) with
  `{...payload, ...(hasLocation ? {locations:[{...,is_primary:true}]} : {})}`.
  Returns `res.customer.id`.

`saveThenUploadCert` runs `save`, then `uploadCert` if a file is staged:
`POST /api/attachments/customer/:customerId` as `multipart/form-data` with
`file`, `display_name: 'Tax Exempt Certificate'`, `description: 'Tax exempt certificate'`,
`context: 'OTHER'`. A failed upload is **swallowed** (the customer is already saved) and
surfaces `toast({title:'Certificate upload failed', description:'Customer saved, but the
certificate upload failed — you can upload it later.', variant:'destructive'})`.

Two mutations, identical `mutationFn`, different `onSuccess`:

| Mutation | onSuccess |
|---|---|
| `submitMutation` | clear dup state; `invalidateQueries(['customers'])`; if edit -> `invalidateQueries(['customer', id])` + `navigate('/customers/:id')`; else if `returnTo` -> `navigate('{returnTo}?newCustomerId={id}', {replace:true})`; else `navigate('/customers/{id}')` |
| `saveAndLeadMutation` | clear dup state; `invalidateQueries(['customers'])`; if edit -> `invalidateQueries(['customer', id])`; then `navigate('/leads/new?customer_id={id}')` |

**Not invalidated:** `['customer-stats']` and `['customer-form', id]`. No optimistic updates.

`pending = submitMutation.isPending || saveAndLeadMutation.isPending`.
`mutationError = getDuplicate(rawError) ? null : rawError` - the 409 duplicate never shows in
the inline error block.

### 3.6 Duplicate-customer guard (the dedupe logic)

Backend (`customer.controller.ts` create + `lib/customer-duplicate.ts`):
`findDuplicateCustomer(prisma, orgId, {email, phone})` compares the **primary email
(trim+lowercase) OR the primary phone (digits, leading US `1` stripped)** against every
customer in the org. A hit with no `?override=true` returns
`409 { error: 'duplicate', existing: {...} }`. With `override=true` the create proceeds and a
`TimelineEvent` records `duplicate_override: true` plus the matched customer id/number.
**`extra_emails` are NOT part of duplicate detection** (they are part of list `search` only),
and there is **no duplicate check on PATCH/edit** - create only.

Frontend:
- `getDuplicate(err)` narrows the 409 to `ExistingCustomer`.
- `computeMatchedFields(submitted, existing)` recomputes which field collided using the same
  normalizers (`normalizeEmail`, `normalizePhone` with the 11-digit leading-1 strip).
- `handleSubmitError` stores `dupExisting`, `pendingData`, `dupMatched`.
- `dupSource` ref remembers whether the collision came from `'submit'` or `'lead'`.

`<DuplicateCustomerDialog>` (Radix `Dialog`, `max-w-lg`) renders `null` when `existing` is
null. Title "Possible Duplicate Customer" (`AlertTriangle`); description says "the same
email and phone" / "email" / "phone" depending on `matchedFields`. Body: a card with the
existing customer's display name, `customer_number`, an Active/Archived pill
(`archived = !is_active || archived_at`), then email / phone / primary-address rows where a
matched row gets the danger tint and a trailing "matches" tag; phone rendered via
`formatPhone`. Actions:

| Control | Handler in CustomerFormPage |
|---|---|
| primary Button "Open existing customer" (`ArrowRight`) | `handleOpenExisting` -> close + `navigate('/customers/{existing.id}')` |
| outline "Edit email" (only when `matchedFields.email`) | `handleEditField('email')` -> close, `form.setFocus('email')`, then `requestAnimationFrame(() => document.getElementById('email')?.focus())` |
| outline "Edit phone" (only when `matchedFields.phone`) | same with `'phone'` (the id fallback exists because the phone input is `Controller`-wrapped) |
| text link "Cancel" | `setDupExisting(null)` |
| text link "Create anyway" (de-emphasised, disabled + spinner while `isOverriding`) | `handleCreateAnyway` -> re-runs the originating mutation with `override: true` |

`isOverriding = (submitMutation.isPending || saveAndLeadMutation.isPending) && Boolean(pendingData)`.

### 3.7 States

- `isEdit && isLoading` -> full-page centred spinner (`h-8 w-8 animate-spin rounded-full
  border-4 border-primary border-t-transparent`). **No "not found" branch** - a 404 on the
  edit fetch leaves the form rendered with empty defaults.
- Submitting -> all three footer buttons disabled, submit label "Saving…".
- Validation errors -> inline `<p class="text-xs text-danger">` per field, `mode:'onTouched'`.
- Server error -> the inline block described in §3.4.

---

## 4. `/customers/:id` - CustomerDetailPage

### 4.1 Data loads

| Hook | Key | Endpoint | Enabled |
|---|---|---|---|
| `useQuery` | `['customer', id]` | `GET /api/customers/:id` -> `{customer, summary}` | `Boolean(id)` |
| `useQuery` | `['customer-leads', id]` | `GET /api/leads?customer_id={id}&limit=20` -> `data.leads` | `Boolean(id) && (activeTab==='leads' \|\| activeTab==='estimates')` |
| `CustomerCommunicationsTab` | `['customer-communications', customerId]` | `GET /api/customers/:id/communications` -> `data.items` | mounted only when the Comms tab is open (Radix does not force-mount) |
| `JobLeadTasksTab` | *not react-query* - `useEffect` + `listTasks({linked_entity_type:'CUSTOMER', linked_entity_id: id})` | `GET /api/tasks?...` | on mount of the tab |

Backend `getById` response shape that the page depends on:
`customer.{...scalars, service_locations[], _count:{leads,jobs}, jobs[<=20 desc, each with
assignees/service_location/estimate/invoices[].payments[]], activity_notes[], invoices[]
(customer-anchored, <=20, flattened `job_number`/`job_id`), orphan_invoices[]}` and
`summary.{financials, estimates, deposits}`.
**Note the naming trap:** polymorphic notes arrive as `activity_notes`; `customer.notes` is
the scalar free-text column the edit form owns.

### 4.2 Mutations

| Mutation | Call | Invalidates | Extra |
|---|---|---|---|
| `archiveMutation` | `archiveCustomer(id)` -> `POST /api/customers/:id/archive` | `['customer', id]`, `['customers']`, `['customer-stats']` | stays on the page |
| `unarchiveMutation` | `POST /api/customers/:id/unarchive` | same three | stays on the page |
| `purgeMutation` | `purgeCustomer(id, {confirm: confirmText})` -> `POST /api/customers/:id/purge` | `['customers']`, `['customer-stats']` | then `navigate('/customers')` |
| `deleteLocationMutation` | `DELETE /api/customers/:id/locations/:locId` | `['customer', id]` | no confirmation dialog - **one click deletes** |
| `NotesTab.addNoteMutation` | `POST /api/customers/:id/notes` `{content}` | `['customer', customerId]` | clears the textarea |
| `LocationFormDialog.mutation` | `PATCH .../locations/:locId` (edit) or `POST .../locations` (add) | `['customer', customerId]` | closes the dialog + `form.reset()` |

No optimistic updates anywhere.

### 4.3 Component tree

```
<Breadcrumb items=[{Customers -> /customers}, {displayName}] />

Hero card
  Avatar(64) with initials (first/last, else company initial, else '?')
  <h1>{customerDisplayName(customer)}</h1>
  badge row: company_name (only when a person name also exists)
           | "Archived" badge when isArchived
           | ad_source badge (tinted)
  action cluster (right):  §4.4
  <Separator/>
  KPI grid, 8 cells (grid-cols-2 / sm:4 / lg:8):
    Lifetime Revenue (success)        summary.financials.lifetime_revenue
    Past Due     >0 ? danger+currency : success "None"
    Due          >0 ? currency : success "Paid up"
    Active Jobs  jobs.filter(status in ACTIVE_JOB_STATUSES).length  (no skeleton)
    Pending Estimates  summary.estimates.pending
    Total Jobs   customer._count.jobs (no skeleton)
    Member Since new Date(created_at).toLocaleDateString('en-US',{month:'short',year:'numeric'})
    Deposits     summary.deposits.collected  + "(N pending)" in orange when >0
  (each summary-backed cell shows a pulsing bar while `summaryLoading` === isLoading)

Body card (flex-col lg:flex-row)
  Left sidebar (w-72 on lg)
    "Contact Details": primary phone (+ ext) labelled Primary;
                       secondary_phone (+ ext) labelled Secondary when present;
                       email + extra_emails (each with an optional label chip);
                       company_name row
    conditional block when (ad_source || payment_type || allow_billing || tax_exempt):
      Separator + rows: Ad Source badge, Form of Payment, Allow Billing Yes/No,
      Tax Exempt Yes/No
    divider
    "Service Locations": header + (canEdit) "Add" button;
       empty -> "No locations added."
       else one bordered row per location: address_line1[, line2], "city, ST zip",
       "Primary" star chip when is_primary; (canEdit) pencil + (canDeleteLocation) trash
  Right: <Tabs value={activeTab} onValueChange={setActiveTab}>  §4.5

Dialogs: <LocationFormDialog/>, purge <Dialog/>, <PlanBuilderDialog key={id}/>
```

`ACTIVE_JOB_STATUSES = {UNASSIGNED, SCHEDULED, EN_ROUTE, ON_SITE, IN_PROGRESS}`.
`isArchived = Boolean(customer.archived_at) || customer.is_active === false`.

`navWithBreadcrumbs(path)` = `navigate(path, { state: { breadcrumbs: [{Customers,
/customers}, {displayName, /customers/:id}] } })` - used for every navigation **out of** this
page so the child page renders customer-rooted breadcrumbs.

### 4.4 Header actions (all conditional)

| Control | Condition | Behaviour |
|---|---|---|
| `Link` -> outline Button "View Statement" (`FileText`) | `ability.can('read','Invoice')` | `Link to="/customers/:id/statement" state={{breadcrumbs}}` |
| business Button "New Lead" (`Plus`) | `canEdit` | `navWithBreadcrumbs('/leads/new?customer_id={id}')` |
| outline Button "New Job" (`Briefcase`) | `ability.can('create','Job')` | `navWithBreadcrumbs('/jobs/new?customer_id={id}')` |
| outline Button "New Service Plan" (`ClipboardList`) | `ability.can('create','ServicePlan')` | opens `PlanBuilderDialog` (`presetCustomerId={id}`, `presetCustomerLabel={displayName}`, `key={id}` so it remounts per customer) |
| outline Button "Edit" (`Pencil`) | `canEdit` | `navigate('/customers/:id/edit')` (no breadcrumb state) |
| icon Button `MoreHorizontal` -> `DropdownMenu` | `showLifecycleMenu` | see below |

Lifecycle dropdown items:
- `canArchive` -> "Archive Customer" (`Archive`) **or** "Unarchive Customer"
  (`ArchiveRestore`) depending on `isArchived`; disabled while the mutation is pending.
- `canAnonymize` -> "Anonymize (coming soon)" (`UserX`), **always `disabled`**.
- `canForcePurge` -> "Force-purge Customer" (`ShieldOff`, danger styling) -> resets
  `confirmText` and opens the purge dialog.

**Purge dialog** (`Dialog`, `max-w-md`): title "Force-purge Customer"; description "This
permanently destroys {displayName} and ALL associated financial records (leads, estimates,
jobs, invoices, payments). This cannot be undone."; body instructs typing the customer
number (rendered mono) and an `Input` bound to `confirmText`; error line via
`extractApiError(purgeMutation.error,'Failed to purge')`; footer outline "Cancel" and
destructive Button labelled "Purging..." / "Force-purge", **disabled unless
`confirmText === customer.customer_number`**. One-shot: the backend warns about financial
records and deletes in the same call.

**LocationFormDialog**: `max-w-md`, title "Add Location" / "Edit Location". Zod:
`address_line1` min 1 max 200 ("Address is required"), `address_line2` max 200 optional,
`city` min 1 max 100 ("City is required"), `state` min 2 max 2 ("State is required"),
`zip` min 5 max 10 ("ZIP is required"), `is_primary` optional. Fields: AddressAutocomplete
(`id="address_line1"`, fills all five on select), `address_line2` labelled "Unit / Suite",
City + State (`maxLength={2}`) side by side, ZIP, and a "Primary Location" `Switch`. Footer:
outline "Cancel" (just closes; **does not reset the form**), submit "Add Location" / "Save
Changes" / "Saving...". Errors surface via `extractApiError`. `useEffect` resets the form
whenever the `location` prop changes (to the location, or to defaults when null).

### 4.5 Tabs

`useState('leads')`. **No URL sync, no persistence.** `TabsList` is a full-width transparent
strip; each trigger shows an icon + label + a tiny count caption.

| Tab value | Label / caption | Data source | Content behaviour |
|---|---|---|---|
| `leads` | Leads (`Target`) / `{_count.leads} lead(s)` | `['customer-leads', id]` (lazy) | `LeadsTab` - table Status / Service Request / Estimates / Est. Value / Assigned To / Date. Service request truncated at 50 chars + "...". Estimates count as a blue pill or "—". Est. Value = sum of `estimates[].total_amount` (`formatCurrency`) or "—". Assignees joined ", " else italic "Unassigned". **Row click -> `navWithBreadcrumbs('/leads/{id}')`.** Footer note "Showing up to 20 most recent leads". Empty -> centred "No leads yet." |
| `estimates` | Estimates (`ClipboardList`) / `{sum of lead.estimates.length} estimate(s)` or `—` while `leadsData` is undefined | derived from the same leads query | `EstimatesTab` - flattens `leads[].estimates[]`, adds `lead_service_request`, sorts by `created_at` desc. Columns Estimate # / Service Request (truncate 50) / Status / Total / Created. **Row click -> `navWithBreadcrumbs('/estimates/{id}')`.** Empty -> `ClipboardList` + "No estimates yet." |
| `jobs` | Jobs (`Briefcase`) / `{_count.jobs} job(s)` | `customer.jobs` (from query 1, backend `take: 20`) | `JobsTab` - Job # / Status / Location (`line1, city`, truncated) / Technician / Scheduled / Invoice. Invoice cell = last non-`VOIDED` invoice's `StatusBadge` plus `+N` when more than one. **Row click -> `navWithBreadcrumbs('/jobs/{id}')`.** Footer "Showing up to 20 most recent jobs". Empty -> `Briefcase` + "No jobs yet." |
| `invoices` | Invoices (`Receipt`) / `{invoices.length} invoice(s)` | `customer.invoices` | `InvoicesTab` - Invoice # (a **`Link` to `/invoices/{id}`**, not a row click) / Job # / Status / Total / Amount Due (`>0` danger currency else success "Paid") / Due Date (red+bold when `due_date < now` and status is `SENT` or `PARTIAL`). Empty -> `Receipt` + "No invoices yet." |
| `payments` | Payments (`CreditCard`) / `{sum of invoice.payments.length} payment(s)` | flattened `customer.invoices[].payments[]` sorted by `paid_at` desc | `PaymentsTab` - Invoice # / Date / Amount / Method (outline badge, lowercased+capitalized) / Collected By (`collector` may be **null** -> "—"; regression-tested). Rows are **not** clickable. Empty -> `CreditCard` + "No payments yet." |
| `notes` | Notes (`StickyNote`) / `{notes.length} note(s)` | `customer.activity_notes` | `NotesTab` - a 3-row textarea ("Add a note about this customer...") + `Button` "Add Note"/"Adding..." (`Send`), disabled when blank or pending; on error "Failed to add note. Please try again."; then a list of bordered note cards with `content` (whitespace-pre-wrap) and "{creator first last} · {date}". Empty -> `StickyNote` + "No notes yet." |
| `tasks` | Tasks (`CheckSquare`), no caption | `JobLeadTasksTab entity={{type:'CUSTOMER', id, label: displayName}}` | grouped by IN_PROGRESS / TODO / BLOCKED / DONE; has its own Create-task modal, task detail drawer, and an AI "Generate tasks" flow. `TabsContent` has **no `p-6`** (the component owns its padding). |
| `communications` | Comms (`MessageSquare`) / "across channels" | `['customer-communications', id]` | `CustomerCommunicationsTab` - skeleton (4 rows) while loading; "Failed to load communications." on error; `MessageSquare` + "No communication with this customer yet." when empty; else a newest-first `<ol>` of channel rows (icon, title, optional "auto · transactional" chip, state chip, timestamp, preview, direction/who/meta, job badge). **Trigger and content both gated on `canReadComms`.** |

### 4.6 States

- `isLoading` -> a bespoke skeleton that mirrors the whole layout: breadcrumb row, hero card
  (avatar circle, two text bars, two button blocks, 8 KPI cells), body card (sidebar with 3
  contact rows + 3 key/value rows, tab strip of 5, a 6-column table header and 5 rows). Uses
  `<Skeleton>`.
- `!data` (after loading) -> centred card "Customer not found." + outline Button "Back to
  Customers" -> `navigate('/customers')`.
- No error-specific branch: a failed query falls into the `!data` case.
- Per-tab empty states are listed in the table above; `summaryLoading` drives per-KPI pulses.

---

## 5. API surface summary (module-wide)

| Method | Endpoint | Guard (backend) | Used by |
|---|---|---|---|
| GET | `/api/customers/stats` | `read Customer` | list KPIs |
| GET | `/api/customers/export` | `export Customer` + `expensiveLimiter` | list "All customers" export |
| GET | `/api/customers` | `read Customer` | list; franchise-parent picker (`is_parent=true`) |
| GET | `/api/customers/:id` | `read Customer` | detail, edit-form hydration, franchise by-id |
| POST | `/api/customers` (`?override=true`) | `create Customer` | form create (409 `duplicate` path) |
| PATCH | `/api/customers/:id` | `update Customer` | form edit |
| DELETE | `/api/customers/:id` | `delete Customer` | **not called from these pages** |
| POST | `/api/customers/:id/archive` \| `/unarchive` | `archive Customer` | detail lifecycle menu |
| POST | `/api/customers/:id/purge` | `force_purge Customer` | purge dialog |
| POST | `/api/customers/:id/anonymize` | `anonymize Customer` | wrapper exists, **UI item is disabled** |
| GET | `/api/customers/:id/summary` | `read Customer` | **not used** by these pages (`getById` already returns `summary`) |
| GET | `/api/customers/:id/communications` | `read Communication` | Comms tab |
| POST | `/api/customers/:id/notes` | `update Customer` | Notes tab |
| POST/PATCH/DELETE | `/api/customers/:id/locations[/:locId]` | `update Customer` / `delete Customer` | location dialog + trash button |
| POST | `/api/customers/:id/locations/:locId/archive` | `archive Customer` | wrapper exists, **no UI** |
| POST | `/api/attachments/customer/:id` | - | tax-exempt certificate |
| GET | `/api/statements/customer/:customerId` (`?format=pdf`) | - | StatementPage |
| GET | `/api/statements/job/:jobId` (`?format=pdf`) | - | StatementPage (job scope) |
| GET/PUT | `/api/table-views/customers` | - | DataTable saved view |
| GET | `/api/organization` | - | source / billing-terms options |
| GET | `/api/leads?customer_id=&limit=20` | - | detail Leads/Estimates tabs |
| GET | `/api/tasks?linked_entity_*` | - | detail Tasks tab |

---

## 6. Permission-conditional rendering (complete list)

Two different mechanisms are in play - **do not unify them**:

**A. Raw role checks (`useAuthStore(s => s.user).role`)**

| Constant | Definition | Hides |
|---|---|---|
| `canCreate` (list) | role is `ADMIN` or `DISPATCHER` | the "Add Customer" button |
| `canEdit` (detail) | role is `ADMIN`, `DISPATCHER` or `SALES` | "New Lead", "Edit", the Service-Locations "Add" button, and every per-location pencil |
| `canDeleteLocation` (detail) | role is `ADMIN` or `DISPATCHER` | the per-location trash button |
| `isAdmin` (form) | role is `ADMIN` | the "Customer Since" (`created_at`) field, and gates whether `created_at` is included in the payload |

**B. CASL abilities (`useAppAbility()`, rules shipped from the server)**

| Check | Hides |
|---|---|
| `ability.can('read','Invoice')` | "View Statement" button |
| `ability.can('create','Job')` | "New Job" button |
| `ability.can('create','ServicePlan')` | "New Service Plan" button |
| `canReadComms = ability.can('read','Communication')` | the Comms **tab trigger and content** |
| `canArchive = ability.can('archive','Customer')` | the Archive/Unarchive menu item |
| `canForcePurge = ability.can('force_purge','Customer')` | the Force-purge menu item |
| `canAnonymize = ability.can('anonymize','Customer')` | the (always disabled) Anonymize item |
| `showLifecycleMenu = canArchive \|\| canForcePurge \|\| canAnonymize` | the whole `MoreHorizontal` trigger |

Backend defaults for reference (`defaultGrants.ts`): SALES = read/update/export Customer;
DISPATCHER = create/read/update/delete/export/**archive** Customer; TECHNICIAN = **no
Customer grants at all**; ADMIN via manage-all (so ADMIN alone gets `force_purge` and
`anonymize`).

---

## 7. StatementPage - **SHARED, DO NOT DUPLICATE**

`frontend/src/pages/StatementPage.tsx` is mounted at **both**
`/customers/:customerId/statement` (Customers module) and `/jobs/:jobId/statement` (Jobs
module). The build phase must produce **one** v2 statement page owned by exactly one module
branch; the other module imports it. Recommendation: build it in whichever branch lands
first and have the other route point at the same file - do not create two v2 copies.

Branching logic (all of it):

```
const params = useParams<{jobId?: string; customerId?: string}>();
const scope   = params.jobId ? 'job' : 'customer';
const entityId = params.jobId ?? params.customerId ?? '';
useQuery({ queryKey: ['statement', scope, entityId],
           queryFn: () => scope === 'job' ? getJobStatement(jobId) : getCustomerStatement(customerId),
           enabled: Boolean(entityId) })
```

Scope-dependent differences - there are exactly four:
1. Hero title: `'Job Statement'` vs `'Customer Statement'`.
2. Default breadcrumb root when `location.state.breadcrumbs` is absent:
   `{label:'Jobs', href:'/jobs'}` vs `{label:'Customers', href:'/customers'}`; a trailing
   `{label:'Statement'}` is always appended. Incoming `state.breadcrumbs` (set by
   CustomerDetailPage's "View Statement" link) replaces the root entirely.
3. Billing-group block: only when `scope === 'customer' && members.length > 0` - a `Users`
   icon plus "Billing group: " and `members.map(memberName).join(', ')`, where `memberName`
   = `"first last"` trimmed, else `company_name`, else `'Customer'`.
4. Ledger description column appends ` · {line.customer_name}` only when
   `scope === 'customer'` and the line carries one.

Everything else is scope-agnostic:
- `data-testid="statement-page"` on the root.
- Hero card: title + "Running ledger of invoices, payments, credits and refunds." + an
  outline Button "Download PDF" (`Download`) -> `handleDownloadPdf`: fetches the
  `?format=pdf` blob for the current scope, `URL.createObjectURL`, `window.open(url,
  '_blank','noopener')`, and revokes after 60 s. **No error handling on this path.**
- Ledger table: Date / Description / Amount (right) / Running Balance (right).
  `LINE_LABELS = {invoice:'Invoice', credit:'Credit', deposit_credit:'Deposit credit',
  payment:'Payment', refund:'Refund'}`, unknown type -> `'Adjustment'`.
  `NEGATIVE_TYPES = {payment, credit, deposit_credit}` render the amount prefixed with a
  Unicode minus `−`. `formatDate` returns `'—'` for null/invalid. Row key is
  `${line.invoice_id ?? 'row'}-${i}`. `line.invoice_number` appends ` · {number}`.
- Totals strip: Billed, Paid, **Deposit credit only when `totals.deposit_credit !== 0`**,
  Refunded, Credited, then a tinted Balance cell carrying
  `data-testid="statement-running-balance"`.
- Empty ledger -> a single row `colSpan={4}` "No activity yet." (the totals strip still
  renders).
- Loading -> `Skeleton` breadcrumb bar + a hero card skeleton + a 5-row card skeleton.
- `error || !statement` -> breadcrumb + centred card with a `FileText` glyph and
  "This statement is unavailable or you do not have access to it." (this is the 403 path too).

---

## 8. States summary

| Page | Loading | Empty | Error |
|---|---|---|---|
| List | header count pulse; DataTable renders `pagination?.limit ?? 5` skeleton rows (desktop) / 5 skeleton cards (mobile); KPI tiles pulse while `statsLoading` | **single generic message "No results found."** - the table does NOT distinguish "no customers exist" from "no rows match the filters" | **none** - a failed list/stats query renders as empty; no error UI exists |
| Form | edit-mode spinner | n/a | inline `extractApiError` block + optional `details[]` list; duplicate 409 diverted to the dialog; cert-upload failure -> toast |
| Detail | full-layout skeleton | per-tab empty states (§4.5); "No locations added." | falls through to "Customer not found." card |
| Statement | 3-block skeleton | "No activity yet." row | shared "unavailable or you do not have access" card |

The list's single empty string is a real reimplementation risk: the kit's DataTable empty
state must not invent a "clear filters" affordance that changes behaviour - if it renders
one, wire it to the existing `clearAllFilters()`.

---

## 9. Selector surface

### 9.1 `data-testid` present in this module

| testid | Where | Consumed by |
|---|---|---|
| `customer-form` | the `<form>` on CustomerFormPage | `e2e/specs/redesign/00-render-safety.spec.ts` R0-05 |
| `customer-form-submit` | the primary submit button | (no current spec reference found; carry it over anyway) |
| `customer-kind-select` | the Person/Company radiogroup wrapper | R0-05 |
| `customer-billing-group` | the "More Details" section wrapper | R0-05 |
| `statement-page` | StatementPage root | R0-04, R0-06 |
| `statement-running-balance` | the Balance value in the totals strip | R0-04 |

`CustomersPage` and `CustomerDetailPage` carry **no `data-testid` of their own** - their
specs and unit tests select by role/text (see below), which makes them *more* fragile to a
UI swap, not less.

### 9.2 E2E specs that touch these routes

| Spec | What it asserts |
|---|---|
| `frontend\e2e\specs\redesign\00-render-safety.spec.ts` | R0-01 `/customers` renders a non-empty `<main>` with no ErrorBoundary; R0-04 statement page (`statement-page`, `statement-running-balance`, visible text "Customer Statement"); R0-05 `/customers/new` (`customer-form`, `customer-billing-group`, `customer-kind-select`, visible text "More Details"); R0-06 no `error-boundary-fallback` on those surfaces |
| `frontend\e2e\specs\redesign\01-journey.spec.ts` | J-06: an archived customer is absent from `/customers` by default and still reachable at `/customers/:id`, where the text "Archived" and the customer name are visible |
| `frontend\e2e\specs\visual-screenshots.spec.ts` | navigates to `/customers` twice for screenshots |
| `frontend\e2e\specs\workflow\redesign-21-duplicate-guard.spec.ts` | API-level duplicate/override contract (`POST /api/customers`, `?override=true`) - no UI selectors |
| `frontend\e2e\specs\workflow\redesign-11-customer-org.spec.ts`, `redesign-1B-lifecycle.spec.ts`, `redesign-12-service-location.spec.ts`, `redesign-22-rbac.spec.ts`, `redesign-24-tenancy.spec.ts`, `workflow/19-statement.spec.ts`, `workflow/redesign-1A-statement.spec.ts` | API-only (archive/purge/locations/RBAC/tenancy/statement) - unaffected by a UI swap |
| `frontend\e2e\specs\redesign\08-standalone-invoice.spec.ts` | waits on a `POST /api/customers?override=true` request from the standalone-invoice flow |

### 9.3 Vitest specs (these are the tight contract)

| File | Locks in |
|---|---|
| `customers-page.test.tsx` | heading "Customers"; four KPI labels as `span`s; search placeholder `Search customers...`; mount request `('/api/customers', {params: objectContaining({page:1, limit:25, ad_source: undefined})})`; the Filter popover flow by `button[name=/^filter$/i]`, `role=tab` names, `role=checkbox` names ("Google", "Tax Exempt", "Has Leads", "No Leads"), labelled range inputs `# of Leads From/To`, `# of Jobs From/To`, `button[name=/^done$/i]`; URL contains `ad_source=Google`, `tax_exempt=true`, `leads_min/max`, `jobs_min/max`; KPI-tile param behaviour; `checkbox[name=/show archived/i]` -> `include_archived: true`; both-selected -> `has_leads: 'true,false'` |
| `customers-default-sort.test.tsx` | `DEFAULT_CUSTOMERS_SORTING === [{id:'created_at', desc:true}]` and the `created_at` column header is exactly `Member Since` - **both are named exports of `CustomersPage.tsx` (`DEFAULT_CUSTOMERS_SORTING`, `columns`)** |
| `customers-filter-no-state.test.tsx` | the facet rail has tabs Source / Payment Type / Tax Exempt / Leads / Jobs / # of Leads / # of Jobs / Created and **no** "State" tab |
| `customer-form-schema-optional-fields.test.ts` | imports `{ customerSchema } from '@/pages/CustomerFormPage'` and exercises every superRefine rule |
| `customer-form-billing-same.test.tsx` | `button[name=/use a different billing address/i]` and `button[name=/same as service address/i]`; the restore control's classes contain `h-9` + `border`, and must NOT contain `text-xs` or `hover:text-danger`; expanded state has exactly 2 `placeholder="City"` inputs, collapsed has 1 |
| `customer-billing-toggle.test.tsx` (#438) | mirrored billing hydrates collapsed and reveals **blank**; genuinely different billing hydrates expanded and pre-filled; toggling to same-as-service then back yields blanks. Selects `#billing_address_line1` and the 2nd `placeholder="City"/"State"/"ZIP"` inputs |
| `customer-payments-tab-render.test.tsx` | detail page hero `heading` is the customer name; `role=tab` named /payments/i; the tabpanel shows "Tina Tech", a "—" for the collector-less payment, and two "I00001" cells; and Contact Details renders **both** primary and secondary phones as `(xxx) xxx-xxxx` |
| `customer-communications-tab.test.tsx` | the Comms tab component contract |
| `customer-picker-with-create.test.tsx`, `pick-or-create-customer-*.test.tsx` | shared customer pickers used by other modules - out of scope here, but they import from `components/shared/*` |

**Build-phase rule:** carry over all six `data-testid`s verbatim, keep `customerSchema`,
`columns` and `DEFAULT_CUSTOMERS_SORTING` exported with the same names and shapes, and keep
the accessible names above (`Filter`, `Done`, `Show archived`, the facet tab labels, the
option labels, `# of Leads From`/`To`, the billing button labels) - they are assertion
targets, not decoration.

---

## 10. Local UI state inventory (module-wide)

| Page | State | Default | Sync |
|---|---|---|---|
| List | see §2.7 | - | facets -> URL (replace); everything else in memory; saved view on the server |
| Form | `moreOpen` | `false` | none - the section always starts collapsed, even in edit mode with billing-group data set |
| Form | `franchiseQuery` / `debouncedFranchiseQuery` | `''` | 250 ms debounce |
| Form | `certFile` | `null` | in memory; uploaded after save |
| Form | `dupExisting` / `pendingData` / `dupMatched` | `null`/`null`/`{email:false,phone:false}` | cleared on any successful save |
| Form | `dupSource` (ref) | `'submit'` | which mutation to replay on "Create anyway" |
| Detail | `activeTab` | `'leads'` | **no URL sync, no persistence** |
| Detail | `purgeOpen`, `confirmText` | `false`, `''` | `confirmText` reset when the menu item opens the dialog |
| Detail | `locationDialogOpen`, `editingLocation` | `false`, `null` | "Add" sets `editingLocation` to null first |
| Detail | `planBuilderOpen` | `false` | dialog is keyed on `id` |
| Detail | `NotesTab.content` | `''` | cleared on successful post |
| Statement | none | - | breadcrumbs come from `location.state` |

---

## 11. Reimplementation risk list (for the builder)

1. **KPI active-state algebra** (§2.3) is fiddly and has an intentional asymmetry: "New This
   Month" does not reset `include_archived`, the other three do. Copy the predicate block
   verbatim.
2. **`listParams` undefined placeholders** must survive - a unit test asserts the key set.
3. **Billing mirror detection ignores `address_line2`** on purpose (#438). Copying line2 into
   the comparison silently regresses the bug.
4. **Phone storage vs display**: the form sends the formatted string; storage is digits-only.
   Keep `formatPhoneInput` on input and `formatPhone` on display.
5. **`activity_notes` vs `notes`**: the Notes tab reads `customer.activity_notes`;
   `customer.notes` is the scalar the edit form binds.
6. **Two permission mechanisms** (raw role vs CASL) coexist; a "cleanup" that unifies them is
   a logic change.
7. **StatementPage is shared with Jobs** - one v2 file, two routes.
8. **Raw Tailwind palette classes** live in `AD_SOURCE_STYLES` (both list and detail), the
   estimate-count pill (`bg-blue-50 text-blue-700`), the archived badge (`bg-amber-50 ...`),
   the overdue due-date (`text-red-600`), the deposits-pending caption (`text-orange-600`),
   and `ContactCell`'s "Copied!" (`text-green-600`). The CLAUDE.md tokens rule means the v2
   pages need token equivalents - that is a visual change by definition, so flag it in the PR
   rather than silently re-tinting.
9. **Location delete has no confirmation.** Reproduce as-is (adding a confirm dialog is a
   behaviour change, however desirable).
10. **The list has no error state.** Do not invent one.

---

## 12. Open questions

1. **`returnTo` on CustomerFormPage appears unreachable.** Nothing in `frontend/src`
   navigates to `/customers/new` with `state.returnTo` (only `LeadFormPage` and
   `NewEstimateDialog` use that pattern, and they target `/leads/new`). Either it is dead
   code kept for symmetry, or an entry point exists outside `pages/`. Carry it over
   unchanged; do not delete it on the strength of this grep.
2. **`extra_emails[i].label` has no input.** The schema, payload and the detail sidebar all
   support the label, and the CSV export prints `email (label)`, but the form never lets a
   user set one. Intentional or an unfinished field? Reproduce as-is.
3. **`phones[i].label` and `is_primary` likewise have no controls** - `is_primary` is always
   submitted `false` for additional phones.
4. **Duplicate detection covers primary email/phone only.** `extra_emails` participate in
   list `search` but not in `findDuplicateCustomer`, and PATCH has no duplicate guard at all.
   If the `fix/duplicate-customer-emails` work is meant to change that, it is a **backend**
   change and out of scope for the UI swap.
5. **Is the Comms tab supposed to respect the `phone` entitlement?** `customer.routes.ts`
   has no `requireFeature`, so the roll-up endpoint is reachable on any plan even though
   CLAUDE.md calls `phone` the master switch for the Communication module. Not a UI-swap
   concern, but worth raising.
6. **`GET /api/customers/:id/summary` is never called** by these pages (the detail page uses
   the `summary` block that `getById` already returns). Left unused.
7. **`archiveServiceLocation` and `anonymizeCustomer` wrappers exist with no UI** (the
   Anonymize menu item is permanently disabled). No v2 UI should be invented for them.
8. **Mobile behaviour on the detail page** was not verified against a device - the layout is
   `flex-col lg:flex-row` with a `w-full lg:w-72` sidebar, but the tab strip
   (`TabsList h-auto w-full`) has 7-8 triggers and no scroll affordance in the markup.
9. Live-page (Chrome) verification was **not** performed - browser tools were out of scope
   for this agent, so every statement here is source-derived.
