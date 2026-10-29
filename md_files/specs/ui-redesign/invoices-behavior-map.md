# Invoices module - behaviour map (UI kit migration, Phase 1)

Status: mapping complete, 2026-07-29. Read-only documentation. No code was modified.
Scope: `/invoices`, `/invoices/new`, `/invoices/:id`.
Method: every statement below was read from the named file at the named line range. Where two
sources disagree, or where behaviour could not be determined from source alone, it is listed in
section 12 (Open questions) rather than guessed.

Notation: a literal `U+2014 em dash glyph` means the source renders the character `&mdash;` as a
placeholder. Prose in this document uses plain hyphens per CLAUDE.md.

---

## 0. File inventory

### Pages (module-owned)

| File | Lines | Role |
|---|---|---|
| `frontend/src/pages/InvoicesPage.tsx` | 557 | list |
| `frontend/src/pages/StandaloneInvoiceFormPage.tsx` | 567 | create |
| `frontend/src/pages/InvoiceDetailPage.tsx` | 1155 | detail |

### Module-owned components

| File | Used by |
|---|---|
| `frontend/src/components/invoices/SendInvoiceDialog.tsx` | detail (twice: send + resend) |
| `frontend/src/components/invoices/RecordPaymentDialog.tsx` | detail |
| `frontend/src/components/invoices/VoidInvoiceDialog.tsx` | detail |
| `frontend/src/components/invoices/RefundInvoiceDialog.tsx` | detail |
| `frontend/src/components/invoices/CreditInvoiceDialog.tsx` | detail |
| `frontend/src/components/invoices/VoidPaymentDialog.tsx` | detail |
| `frontend/src/components/invoices/InvoiceLineItemsEditor.tsx` | detail (Line Items tab) |
| `frontend/src/components/invoices/CreateJobInvoiceDialog.tsx` | **JobDetailPage only** (cross-module) |
| `frontend/src/lib/api/invoices.ts` | detail + editor + AddLineDialog |
| `frontend/src/lib/invoiceEditable.ts` | editor |
| `frontend/src/lib/filters/registries/invoices.ts` | list |

### Shared components that cross module boundaries (changing these affects other modules)

| Component | Path | Also used by |
|---|---|---|
| `LineItemsTable` | `components/jobs/items/LineItemsTable.tsx` | Jobs (`components/jobs/items/LineItemsEditor.tsx`), **`pages/PublicInvoicePage.tsx`** (module 13) |
| `LineItemRow` | `components/jobs/items/LineItemRow.tsx` | via LineItemsTable |
| `TotalsFooter` | `components/jobs/items/TotalsFooter.tsx` | via LineItemsTable |
| `AddLineDialog` | `components/jobs/items/AddLineDialog.tsx` | via LineItemsTable |
| `ProductThumb`, `ClampedDescription` | `components/jobs/items/` | via LineItemRow |
| `LineItemsEditor` (shared, different from the jobs one) | `components/shared/LineItemsEditor.tsx` | `StandaloneInvoiceFormPage`, `CreateJobInvoiceDialog`, `EstimateFormPage` |
| `PickOrCreateCustomer` | `components/shared/PickOrCreateCustomer.tsx` | `LeadFormPage`, `CustomerPickerWithCreate` |
| `PickOrAccreteLocation` | `components/shared/PickOrAccreteLocation.tsx` | `LeadFormPage`, `ServicePlansPage`, `CustomerPickerWithCreate` |
| `DataTable` | `components/ui/data-table.tsx` | every list page |
| `KpiStrip` / `KpiTile` | `components/ui/KpiStrip.tsx` | every list page |
| `FilterBar` / `AppliedChips` | `components/filters/` | every migrated list page |
| `StatusBadge` | `components/ui/status-badge.tsx` | app-wide |
| `Breadcrumb` | `components/ui/breadcrumb.tsx` | app-wide |

`PublicInvoicePage.tsx` (`/p/invoices/:id`) is NOT mapped here per brief, but it imports
`LineItemsTable`. Any prop or markup change to `LineItemsTable` is a module-13 change.
`StatementPage.tsx` (reachable from `/customers/:customerId/statement` and
`/jobs/:jobId/statement`) shares only generic primitives (`Card`, `Button`, `Skeleton`,
`Breadcrumb`) plus `lib/api/statements`. It shares NO invoice-specific component.

---

## 1. Routes and guards

All three routes live inside two nested wrappers in `frontend/src/App.tsx`:

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />}>   // line 110
  <Route element={<AppLayout />}>                                                                 // line 111
    <Route path="/invoices"     element={<InvoicesPage />} />                                     // line 133
    <Route element={<ProtectedRoute allowedRoles={['ADMIN','DISPATCHER']} fallback />}>            // line 137
      <Route path="/invoices/new" element={<StandaloneInvoiceFormPage />} />                       // line 138
    </Route>
    <Route path="/invoices/:id" element={<InvoiceDetailPage />} />                                 // line 140
```

- All three pages are `React.lazy` imports (App.tsx:28, 53, 54) inside a `<Suspense fallback={<PageLoader />}>`
  (App.tsx:98). `PageLoader` renders a centred `Loading...` string.
- `ProtectedRoute` (`frontend/src/components/ProtectedRoute.tsx`):
  - `isLoading` -> full-screen centred `Loading...`.
  - `!isAuthenticated` -> `<Navigate to="/login" replace />`.
  - role not in `allowedRoles` -> `fallback ? <NotAuthorizedPage /> : <Navigate to="/" replace />`.
  - `/invoices/new` passes `fallback`, so a SALES or TECHNICIAN user deep-linking there renders
    `NotAuthorizedPage`, it does **not** redirect. (See open question OQ-1: the e2e spec asserts a
    redirect to `/`.)
- Route order matters: `/invoices/new` is declared BEFORE `/invoices/:id` (App.tsx comment at 136),
  otherwise `new` would be captured as an id.
- There is **no** `/invoices/:id/edit` route. The detail page's overflow-menu "Edit" item calls
  `navigate('/invoices/:id/edit')` (InvoiceDetailPage.tsx:681), which falls through to the catch-all
  `<Route path="*" element={<Navigate to="/" replace />} />` (App.tsx:190) and bounces to the
  dashboard. This is a live defect that the v2 build must reproduce or explicitly fix (OQ-2).
- No entitlement / feature gate applies to Invoices. `requireFeature` / `useFeature` are used only
  by the Communication module.
- Query client defaults (App.tsx:74-82): `retry: 1`, `staleTime: 5 * 60 * 1000`,
  `refetchOnWindowFocus: false`. No invoice query overrides these except the tax-rate query in the
  line-items editor (`staleTime: 60 * 60 * 1000`).

### Entry points into the module

| From | Element | Target |
|---|---|---|
| Sidebar "Create New" menu | `components/layout/nav-config.ts:35` `{ label: 'New Invoice', href: '/invoices/new', action: 'create', subject: 'Invoice' }`, ability-filtered | `/invoices/new` |
| Dashboard "New" menu | `pages/dashboard/NewMenu.tsx:10` | `/invoices/new` |
| Invoices list header | "New Invoice" button (gated on `can('create','Invoice')`) | `/invoices/new` |
| Job detail | "Create Invoice" button; estimate-backed job = one-click POST, estimate-less job = `CreateJobInvoiceDialog` | `/invoices/:id` |
| Invoices list row click | any cell except the Job cell | `/invoices/:id` |
| Invoices list Job cell | stops propagation, sets `window.location.href` | `/jobs/:jobId` (full page load) |
| Invoices list "To Be Invoiced" KPI | `navigate('/jobs?needs_invoice=true')` | Jobs list |

---

## 2. `/invoices` - InvoicesPage

### 2.1 Component tree

```
<div className="space-y-6">
  <div>                                    // page heading row
    <h1><Receipt/> Invoices</h1>
    {data?.pagination?.total !== undefined && <span pill>{total}</span>}    // count pill
  </div>

  <KpiStrip loading={isLoading} items={[Due, Overdue, Unsent Drafts, To Be Invoiced]} />

  <DataTable
    columns={columns}                       // 11 columns, module constant
    data={data?.invoices ?? []}
    pagination={data?.pagination}
    onPageChange / onPageSizeChange
    isLoading
    searchValue / onSearchChange / searchPlaceholder="Search invoices..."
    sorting / onSortingChange
    columnVisibility / onColumnVisibilityChange
    tableKey="invoices"
    onRowClick -> navigate(`/invoices/${invoice.id}`)
    filters={<FilterBar registry={invoicesRegistry} .../>}
    activeFilters={ hasAnyFacetActive ? <AppliedChips/> + "Clear all" ghost button : null }
    headerActions={ <DropdownMenu Export/> + (canCreateInvoice && <Button "New Invoice"/>) }
  />
</div>
```

There is no page-level error branch. A failed list query leaves `data` undefined, so the KPI values
fall back to 0 and the table renders its `No results found.` empty row.

### 2.2 Columns (`InvoicesPage.tsx:97-261`)

| accessorKey | Header | size / minSize | sortable | cell rendering |
|---|---|---|---|---|
| `invoice_number` | Invoice # | 120 / 100 | yes | `font-medium text-primary` span |
| `customer` | Customer | 180 / 140 | **no** (`enableSorting:false`) | `customerDisplayName(c, '')`; second line with `company_name` only when `company_name && (first_name || last_name)` |
| `job` | Job | 100 / 80 | **no** | null job -> em dash glyph in `text-text-secondary`. Non-null -> clickable span; `onClick` calls `e.stopPropagation()` then `window.location.href = /jobs/{id}` (hard navigation, not react-router) |
| `status` | Status | 110 / 90 | yes | `<StatusBadge status={isOverdue(row) ? 'OVERDUE' : row.status} />` |
| `subtotal` | Subtotal | 100 / 80 | no | `formatCurrency(Number(...))`, tabular-nums right |
| `discount_amount` | Discount | 90 / 70 | no | `0` renders the literal `-`, else currency |
| `tax_amount` | Tax | 80 / 70 | no | currency |
| `deposit_credit` | Deposit Credit | 100 / 80 | no | `0` renders `-`, else currency |
| `total_amount` | Total | 110 / 90 | yes | currency, font-medium |
| `amount_due` | Amount Due | 120 / 100 | yes | currency; `font-bold` added when value > 0 |
| `due_date` | Due Date | 120 / 100 | yes | null -> em dash glyph; else `toLocaleDateString()`, wrapped in `text-red-600` when overdue |
| `created_at` | Created | 110 / 90 | yes | `toLocaleDateString()` |

`DEFAULT_COLUMN_VISIBILITY` (line 265) hides `subtotal`, `discount_amount`, `tax_amount`,
`deposit_credit` on first render. This is page-owned React state, not persisted.

`isOverdue(invoice)` (line 89): `false` when `due_date` is null; `false` unless status is `SENT` or
`PARTIAL`; otherwise `new Date(due_date) < new Date()`.

Backend allows sorting only on `created_at`, `invoice_number`, `status`, `amount_due`, `due_date`,
`total_amount` (`invoice.controller.ts:870`). Columns marked `enableSorting:false` in the UI match
that list; `customer` and `job` are deliberately not sortable.

### 2.3 Local UI state

| State | Initial | Reset triggers | Persisted? |
|---|---|---|---|
| `page` | 1 | any filter change, search change, sort change, page-size change | no |
| `pageSize` | 25 | - | no (options 25/50/100 from DataTable) |
| `search` | `''` | KPI clicks, "Clear all" | no; debounced 300 ms inside DataTable |
| `sorting` (`SortingState`) | `[]` | - | no |
| `columnVisibility` | `DEFAULT_COLUMN_VISIBILITY` | - | server-backed, see below |
| facet `value` (`FilterState`) | decoded from URL | - | **URL search params** |

- Facet state is URL-driven via `useFilterState(invoicesRegistry)` (`lib/filters/useFilterState.ts`).
  `setValue` deletes only the registry's own params (`param`, `param_min`, `param_max`,
  `param_after`, `param_before`) and re-sets from the encoding, preserving unrelated params, using
  `setSearchParams(merged, { replace: true })` so filter changes do not push history entries.
- Column widths / visibility are ALSO server-persisted through `DataTable`'s `tableKey="invoices"`:
  `useTableView('invoices')` (`hooks/useTableView.ts`) does `GET`/`PUT /api/table-views/invoices`
  under query key `['table-views','invoices']`, `staleTime: 5min`, `retry:false`. A saved view is
  applied exactly once after the fetch settles (run-once ref guard), and it drives
  `table.setColumnVisibility` plus `onColumnVisibilityChange`, which will overwrite the page's
  `DEFAULT_COLUMN_VISIBILITY`. Saving fires a `Saved to your account` toast. **No localStorage
  anywhere in this module.**

### 2.4 Query and request shape

```ts
useQuery({
  queryKey: ['invoices', { page, pageSize, search, sortBy, sortDir, value }],
  queryFn: () => api.get('/api/invoices', { params: { page, limit: pageSize, ...listParams } })
})
```

`listParams` (line 333-348) always contains this exact key set, with explicit `undefined`
placeholders so an unfiltered mount still carries the keys (a unit test asserts `status` is present
even when undefined). Axios drops undefined-valued params before sending.

```
search, status, total_min, total_max, balance_min, balance_max,
created_after, created_before, due_after, due_before, overdue,
sortBy, sortDir            // sortDir only sent when sortBy is set
...filterParams            // encoded ACTIVE facets, overwrite the placeholders
```

Response (`invoice.controller.list`, 854-935):

```
{ invoices: InvoiceListItem[],
  pagination: { page, limit, total, totalPages, ... },
  stats: { due:{total,count}, overdue:{total,count},
           collected_this_month:{total,count}, unsent:number, need_invoices:number } }
```

Stats are computed with the requester's row-scope but WITHOUT the list filters:
- `due` = aggregate `_sum.amount_due`, `_count` over status in `SENT|PARTIAL`.
- `overdue` = same, plus `due_date < now`.
- `collected_this_month` = `payment.aggregate` over `paid_at` within the current calendar month,
  parent invoice scoped. **This stat is returned but never rendered by the UI.**
- `unsent` = `invoice.count` where status `DRAFT`.
- `need_invoices` = `job.count` where status `COMPLETED` and `NOT { invoices: { some: { status: { not: 'VOIDED' } } } }`,
  scoped by the requester's **Job** read scope (not the Invoice scope).

### 2.5 KPI tiles (clickable filters)

`KpiStrip` renders each item as a `<button>` when `onClick` is present. `active` adds
`border-primary/40 ring-2 ring-primary/15`.

| Tile | icon | value | sub | tone | emphasize | active predicate | onClick |
|---|---|---|---|---|---|---|---|
| Due | `DollarSign` | `formatCurrency(stats.due.total ?? 0)` | `{count} invoice(s)` | primary | - | `noOtherFilters && sameSet(statusValues, ['SENT','PARTIAL'])` | `handleStatusKpi(['SENT','PARTIAL'], dueKpiActive)` |
| Overdue | `AlertTriangle` | `formatCurrency(stats.overdue.total ?? 0)` | `{count} invoice(s)` | rose | always | `overdueActive && statusValues.length===0 && noOtherFacetsOrStandalone` | `handleOverdueKpi()` |
| Unsent Drafts | `FileText` | `stats.unsent ?? 0` | - | amber | `unsent > 0` | `noOtherFilters && sameSet(statusValues, ['DRAFT'])` | `handleStatusKpi(['DRAFT'], unsentKpiActive)` |
| To Be Invoiced | `Receipt` | `stats.need_invoices ?? 0` | `Completed, unbilled` | amber | `need_invoices > 0` | never (no `active` prop) | `navigate('/jobs?needs_invoice=true')` |

Pluralisation: `invoice${count !== 1 ? 's' : ''}`.

Active-state helpers (lines 379-401):
```
noOtherFacetsOrStandalone = !totalActive && !balanceActive && !createdActive && !dueRangeActive && !search
noOtherFilters            = !overdueActive && noOtherFacetsOrStandalone
```
`sameSet(a,b)` = same length and every element of `b` is in `a`.

Click behaviour (lines 403-416): both handlers clear `search`, reset `page` to 1, and call
`setValue` with either `{}` (when the tile was already active, i.e. toggle off) or an object
containing ONLY that tile's facet. Because `setValue` replaces the whole registry-owned facet set,
one call both applies the tile's filter and clears every other facet. This is deliberate: the stats
are global, so a KPI click must produce a list whose count matches the tile.

### 2.6 Filters (`lib/filters/registries/invoices.ts`)

Six facets, in rail order:

| key | kind | param(s) | label | options / bounds |
|---|---|---|---|---|
| `status` | multi | `status` | Status | 7 static options: DRAFT/Draft, SENT/Sent, PARTIAL/Partial, PAID/Paid, VOIDED/Voided, REFUNDED/Refunded, PARTIALLY_REFUNDED/Partially Refunded |
| `total` | range, `money:true` | `total_min`, `total_max` | Total | `min: 0`, `maxSource:'invoices.maxTotal'` -> page returns 100000 |
| `balance` | range, `money:true` | `balance_min`, `balance_max` | Balance Due | `min: 0`, `maxSource:'invoices.maxBalance'` -> 100000 |
| `created` | dateRange | `created_after`, `created_before` | Created | - |
| `due` | dateRange | `due_after`, `due_before` | Due | - |
| `overdue` | multi | `overdue` | Overdue | single option `{ value:'true', label:'Overdue' }` |

- `resolveOptions` is a stable `() => []` (no dynamic option source exists), `resolveMax` returns
  100000 for both money sources and 0 otherwise.
- `FilterBar` (`components/filters/FilterBar.tsx`) is a Radix `Popover` with a trigger button
  labelled "Filter", a left rail of facet rows with active-count badges, a right pane rendering
  `CheckboxFacet` / `RangeFacet` / `DateFacet` by kind, and a "Done" button. Range facets carry
  aria-labels `Total From` / `Total To` / `Balance Due From` / `Balance Due To`. Only the selected
  rail tab's control is mounted, so the two money ranges never coexist in the DOM.
- `AppliedChips` renders one removable chip per active facet value; removing a chip calls the same
  `handleFilterChange`, which resets `page` to 1.
- The "Clear all" ghost button next to the chips calls `clearAllFilters()`: `setValue({})`,
  `setSearch('')`, `setPage(1)`.
- `hasAnyFacetActive = Object.keys(value).length > 0` gates the whole `activeFilters` slot. Search is
  never represented as a chip.
- Backend composition note (`buildInvoiceListWhere`, controller 807-852): `overdue=true` runs AFTER
  the facet filters. It MERGES `{ lt: now }` onto whatever `due` set on `due_date`, and it
  OVERWRITES `status` with `{ in: ['SENT','PARTIAL'] }`. So overdue always wins over an explicit
  status selection. `search` is applied with `addOrFilter` (AND-merged, never clobbering an existing
  row-scope OR) across `invoice_number`, `job.job_number`, `customer.first_name`,
  `customer.last_name`, all `contains`, `mode: 'insensitive'`.

### 2.7 Export dropdown

`DropdownMenu` in `headerActions`; trigger is an outline `Button` with a `Download` icon labelled
"Export". Content aligned `end`, with `DropdownMenuLabel "Export as CSV"`, a separator, and two items:

1. `Current page ({data?.invoices?.length ?? 0} rows)` -> `handleExportCurrentPage()`:
   `exportRows(data?.invoices ?? [], 'invoices-page{page}-{YYYY-MM-DD}.csv')`. No network call.
2. `All ({data?.pagination?.total ?? '...'})` -> `handleExportAll()`:
   `GET /api/invoices/export` with the SAME `listParams` (no page/limit), then
   `exportRows(ex.invoices ?? [], 'invoices-all-{YYYY-MM-DD}.csv')`. On any throw it fires
   `toast({ title:'Export failed', description:'Failed to export invoices. Please try again.', variant:'destructive' })`.

`exportRows` no-ops on an empty array (no file, no toast). `toExportRow` (line 423) produces exactly
these 13 columns: `Invoice #, Customer, Company, Job, Status, Subtotal, Discount, Tax, Deposit
Credit, Total, Amount Due, Due Date, Created`. `Status` writes `OVERDUE` when `isOverdue(inv)`,
otherwise the raw enum. Money columns are raw `Number(...)`, not formatted. Dates use
`toLocaleDateString()`. CSV assembly is `toCSV` + `downloadCSV` from `lib/inventory/csv`.

Backend `exportAll` (controller 944-968) reuses the list `where`, `select` and default
`orderBy: { created_at:'desc' }`, caps at 50 000 rows, is rate-limited by `expensiveLimiter`, and is
gated `canDo('read','Invoice')` (there is no `export Invoice` action).

### 2.8 Permission-conditional rendering

Exactly one gate on this page:

```ts
const canCreateInvoice = ability.can('create', 'Invoice');   // line 279
...
{canCreateInvoice && <Button variant="business" onClick={() => navigate('/invoices/new')}>New Invoice</Button>}
```

Who holds `create Invoice` (`backend/src/lib/permissions/defaultGrants.ts`):
- ADMIN via manage-all.
- DISPATCHER: explicit unconditional row (line 108).
- SALES: **no** create grant (only `read Invoice` and `manage_lines Invoice`, both conditioned on
  `OWN_INVOICE_VIA_LEAD`). Button hidden.
- TECHNICIAN: not a role default. It is a per-user capability
  (`backend/src/lib/permissions/userCapabilities.ts:131-138`, `create Invoice`, own condition
  `OWN_INVOICE_VIA_JOB`, `impliesRead: true`). A granted technician therefore SEES the button on
  the list page, but `/invoices/new` is role-gated to ADMIN+DISPATCHER, so clicking it renders
  `NotAuthorizedPage`. Even bypassing the route, `createStandaloneInvoice`
  (`invoice.controller.ts:692-696`) hard-rejects any role other than ADMIN/DISPATCHER with a 403.
  This dead-end is existing behaviour and must be preserved by the v2 page unless deliberately fixed
  (OQ-3).

Row-level visibility (which invoices appear at all) is enforced server-side by
`scopeWhereForReq(req,'Invoice')`, not by the UI.

### 2.9 States

| State | Rendering |
|---|---|
| Loading | `KpiStrip loading` -> every tile shows a `h-[26px] w-16` pulse block in place of the value. `DataTable isLoading` -> desktop renders `pagination?.limit ?? 5` skeleton rows of pulsing bars, one per column; mobile renders 5 skeleton cards. |
| Empty | Desktop: one full-width row `No results found.` in `text-text-secondary`, `h-24`. Mobile: a card with the same string. **There is no distinction between "no invoices exist" and "no invoices match the filters"** - the same string renders for both. |
| Error | No dedicated branch. `useQuery` failure (after `retry: 1`) leaves `data` undefined: the count pill is hidden, KPIs show `$0.00` / `0`, and the table shows `No results found.` Only the export-all path surfaces an error, as a toast. |
| Pagination | Rendered when `pagination && (totalPages > 1 || onPageSizeChange)`: `Showing {start}-{end} of {total}`, a page-size `SelectField` (25/50/100 per page), and Previous / `Page X of Y` / Next buttons. |

### 2.10 Selector surface (list)

No `data-testid` on this page. Tests target it by role and text:
- `screen.getByPlaceholderText('Search invoices...')`
- `getByRole('button', { name: /^filter$/i })`, then `getByRole('tab', { name: /^status|total|balance due|created|due|overdue$/i })`
- `getByRole('checkbox', { name: 'Sent' | 'Draft' | 'Overdue' })`
- `getByLabelText('Total From' | 'Total To' | 'Balance Due From' | 'Balance Due To')`
- `getByRole('button', { name: /^done$/i })`
- `getByRole('button', { name: 'New Invoice' })` (e2e `standalone/standalone-form.spec.ts:125,226`)
- Spec files: `frontend/src/__tests__/invoices-page.test.tsx`,
  `frontend/src/__tests__/to-be-invoiced.test.tsx`,
  `frontend/e2e/specs/standalone/standalone-form.spec.ts`,
  `frontend/e2e/specs/redesign/00-render-safety.spec.ts` (renders `/invoices` in a route sweep).

---

## 3. `/invoices/new` - StandaloneInvoiceFormPage

Route guard: ADMIN + DISPATCHER, `fallback` -> `NotAuthorizedPage` for SALES/TECHNICIAN.
Backend mirror: `createStandaloneInvoice` 403s any other role.

### 3.1 Component tree

```
<div className="space-y-4">
  <Breadcrumb items={[{label:'Invoices', href:'/invoices'}, {label:'New Invoice'}]} />
  <div>  // title row
    <h1><Receipt/> New Invoice</h1>
    <Button variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
    <Button variant="business" type="submit" form="standalone-invoice-form" disabled={submitting}>
      {submitting && <Loader2 spin/>}{selectedCustomerId ? 'Create Invoice' : 'Continue'}
    </Button>
  </div>

  <form id="standalone-invoice-form" noValidate onSubmit={preventDefault -> handleSubmit()}>
    <div className="flex gap-4 items-start">
      {!isBelowLg && (
        <aside className="w-[300px] sticky top-4">
          <Card>Customer -> <PickOrCreateCustomer/></Card>
          {selectedCustomer && <Card>Service Location -> <PickOrAccreteLocation showPicker/></Card>}
          <Card>Totals: Subtotal / Tax / Total (+ hint)</Card>
        </aside>
      )}
      <main className="flex-1">
        {isBelowLg && <Card> Customer + (selectedCustomer && Service Location) </Card>}
        {!selectedCustomer
          ? <Card>Select or create a customer to start adding line items.</Card>
          : <>{lineErrors.some(Boolean) && <p className="text-xs text-danger">{firstError}</p>}
             <LineItemsEditor value={lineItems} onChange={setLineItems} itemNameErrors={lineErrors}/></>}
        {isBelowLg && <Card>Totals (duplicate, no hint)</Card>}
      </main>
    </div>
    {(createInvoice.isError || createCustomer.isError) && !dupExisting &&
      <p className="text-sm text-danger">{extractApiError(...)}</p>}
  </form>
</div>
```

**Critical layout rule** (lines 73-80): `useMediaQuery('(max-width: 1023.98px)')` chooses exactly ONE
of the two layouts to MOUNT. The customer/location/totals block must never be rendered twice behind
CSS `hidden lg:block`, because `PickOrCreateCustomer`'s duplicate-customer dialog portals to
`<body>` and two copies would produce duplicate `#email` / `#phone` element ids and two stacked
dialogs (issue #259). In jsdom `matchMedia` is mocked false, so tests see the desktop sidebar
variant. A v2 rebuild MUST keep the JS gate.

`noValidate` on the form (lines 389-393) is deliberate: `LineItemsEditor`'s quantity input carries a
native `min`, and without `noValidate` the browser bubble preempts `onSubmit` and hides the inline
"Quantity must be greater than 0" message (issue #260).

### 3.2 Local state

| State | Initial |
|---|---|
| `contact: CustomerContactFields` | `{ first_name:'', last_name:'', company_name:'', phone:'', email:'' }` |
| `selectedCustomer: PickCustomer \| null` | `null` |
| `dupExisting: ExistingCustomer \| null` | `null` |
| `dupMatched: {email,phone}` | `{ false, false }` |
| `openingExisting: boolean` | `false` |
| `locationValue: PickOrAccreteLocationValue` | `{ locationId:'', address:{...all empty} }` |
| `lineItems: LineItem[]` | `[blankLineItem()]` |
| `lineErrors: (string\|undefined)[]` | `[]` |

`blankLineItem()` (`components/shared/LineItemsEditor.tsx:66`) =
`{ name:'', detail:'', quantity:1, unit_price:'' (cast to number), is_taxable:true, item_type:'SERVICE',
price_book_item_id:null, unit_cost:null, discount_type:null, discount_value:null, image_url:null }`.

No URL sync, no persistence, no autosave. Everything is lost on navigate away.

### 3.3 Queries

| Hook | Key | Endpoint | enabled |
|---|---|---|---|
| tax rates | `['state-tax-rates']` | `GET /api/state-tax-rates` -> `data.data as StateTaxRate[]` | always |
| customer tax-exempt | `['customer', selectedCustomerId, 'tax_exempt']` | `GET /api/customers/:id` -> `data.customer` | `Boolean(selectedCustomerId)` |
| price-book categories | `['price-book-categories']` (inside `LineItemsEditor`) | `GET /api/price-book/categories` | always |
| price-book search | none (imperative, debounced, `AbortController`) | `GET /api/price-book/items/search?q=&category_id=&type=` | on >= 2 chars |

The tax-exempt refetch exists because the customer-search payload omits `tax_exempt`, so a picked
customer would otherwise preview as taxed. It falls back to any `tax_exempt` already on the
selected object.

### 3.4 Mutations

| Mutation | Endpoint | Body | onSuccess | onError |
|---|---|---|---|---|
| `createCustomer` | `POST /api/customers` or `POST /api/customers?override=true` | `{ first_name?, last_name?, company_name?, email, phone }` (empty strings become `undefined`) | clear dup state, `invalidateQueries(['customers'])`, `selectCustomer(created)` | `getDuplicateCustomer(err)`; on a 409 duplicate, set `dupExisting` and `dupMatched = computeMatchedCustomerFields({email,phone}, dup)` |
| `createInvoice` | `POST /api/invoices` | `buildPayload()` (see 3.6) | `invalidateQueries(['invoices'])`, `navigate('/invoices/{id}')` | falls through to the bottom error paragraph |

No optimistic updates anywhere in this module.

### 3.5 Money math (frontend preview vs backend authority)

Preview only. The server is authoritative; the header comment says so explicitly (lines 61-67).

`resolvedState` (lines 132-141):
- real `locationId` -> that location's `state` from `customer.service_locations`
- `locationId === ADD_NEW_LOCATION` -> the typed `address.state` or null
- otherwise null

`previewTaxRate` (143-150):
- `taxExempt` -> `0`
- no `resolvedState` -> `null` (unknown; server resolves on save)
- else the matching `state_tax_rates` row's `Number(tax_rate)` (a FRACTION, e.g. 0.0625), or `null`

`totals` (153-168) - deliberately mirrors backend `computeOwnedLineTotals`, which has **no discount
support**:
```
for each line: lineTotal = round2(qty * unit_price)          // qty/price coerced with Number(...)||0
subtotal        = round2(sum of lineTotal)
taxableSubtotal = round2(sum of lineTotal where is_taxable)
taxAmount       = previewTaxRate != null ? round2(taxableSubtotal * previewTaxRate) : null
total           = taxAmount != null ? round2(subtotal + taxAmount) : null
round2(n)       = Math.round(n * 100) / 100
```

Totals card rendering:
- `Subtotal` = `formatCurrency(totals.subtotal)`
- Tax label = `Tax (exempt)` when `taxExempt`, else `Tax (X.XX%)` from `(previewTaxRate*100).toFixed(2)`,
  else the bare word `Tax`
- Tax value = `formatCurrency(taxAmount)` or the em dash glyph when null
- `Total` = `formatCurrency(totals.total ?? totals.subtotal)`
- Desktop only: when `!taxExempt && previewTaxRate == null`, the hint
  `Tax is calculated from the service location on save.` The mobile totals card omits this hint.

**Known divergence:** the shared `LineItemsEditor` lets the user set a per-line discount and a unit
cost, and shows a per-line margin, but `buildPayload` drops `discount_type`, `discount_value` and
`unit_cost`, and the preview totals ignore discounts entirely. The backend
`invoiceLineItemInput` schema (`invoice.controller.ts:42-51`) accepts only
`description, quantity, unit_price, is_taxable, item_type?, price_book_item_id?` - so a discount
typed on this page is silently discarded on save. Preserve as-is; flag as OQ-4.

### 3.6 `buildPayload()` (lines 171-203)

```ts
line_items = lineItems
  .filter(li => li.name.trim() !== '' || (Number(li.unit_price)||0) > 0)   // drop fully blank rows
  .map(li => ({
     description: li.detail ? `${li.name}\n${li.detail}` : li.name,        // name + detail joined by \n
     quantity:   Number(li.quantity)   || 0,
     unit_price: Number(li.unit_price) || 0,
     is_taxable: li.is_taxable,
     item_type:  li.item_type,
     ...(li.price_book_item_id ? { price_book_item_id: li.price_book_item_id } : {}),
  }));

location = locationId && locationId !== ADD_NEW_LOCATION
             ? { service_location_id: locationId }
         : locationId === ADD_NEW_LOCATION && address.address_line1.trim()
             ? { address: { address_line1, address_line2?, city, state, zip } }
             : {};                                     // server defaults to the customer's primary

body = { customer_id: selectedCustomerId!, line_items, ...location }
```

### 3.7 Validation (`handleSubmit`, lines 338-360)

There is **no zod schema on this page**. Validation is hand-rolled:

1. If no customer is selected -> `createCustomer.mutate({})` and RETURN. The primary button therefore
   acts as a two-step wizard: label `Continue` (create the typed customer) then `Create Invoice`.
2. Per-line errors, index-aligned with `lineItems`:
   - name blank AND unit_price > 0 -> `'Required'`
   - kept row with a name and NOT `Number(quantity) > 0` -> `'Quantity must be greater than 0'`
   - otherwise `undefined`
   ("kept" mirrors `buildPayload`'s filter: name non-blank OR price > 0.)
3. `hasNamedLine = lineItems.some(li => li.name.trim() !== '')`.
4. If `!hasNamedLine || errs.some(Boolean)`: `setLineErrors(errs.map((e,i) => e ?? (!hasNamedLine && i===0 ? 'Add at least one line item' : undefined)))` and RETURN (no POST fires).
5. Else `setLineErrors([])` and `createInvoice.mutate()`.

`submitting = createInvoice.isPending || (createCustomer.isPending && !dupExisting)`.
`isOverriding = (createCustomer.isPending && Boolean(dupExisting)) || openingExisting`.

Backend validation on the same body: `createInvoiceSchema` (`invoice.controller.ts:71-98`) requires
exactly one of `job_id` / `customer_id`, and for the customer anchor requires a non-empty
`line_items` array. Each line is `description: min(1)`, `quantity: positive()`,
`unit_price: nonnegative()`, `is_taxable: boolean` (required).

### 3.8 Duplicate-customer guard

`createCustomer` 409 -> `getDuplicateCustomer(err)` yields an `ExistingCustomer`. Setting
`dupExisting` opens `DuplicateCustomerDialog` (rendered inside `PickOrCreateCustomer`), titled
`Possible Duplicate Customer`. Four exits:

| Button | Handler | Effect |
|---|---|---|
| `Open existing customer` | `handleOpenExisting` | guards on `openingExisting`; `GET /api/customers/{dup.id}` -> `selectCustomer(full record)`. On fetch failure it falls back to a minimal record built from the dup payload with `service_locations: []`, so the invoice still attaches. `finally`: `setOpeningExisting(false)`, `dismissDuplicate()` |
| `Edit email` / `Edit phone` | `handleEditField(field)` | `dismissDuplicate()` then `requestAnimationFrame(() => document.getElementById(field)?.focus())` |
| `Create anyway` | `handleCreateAnyway` | `createCustomer.mutate({ override:true })` -> `POST /api/customers?override=true` |
| `Cancel` / dismiss | `dismissDuplicate` | `setDupExisting(null)` **and `createCustomer.reset()`** - the reset is load-bearing: without it, the stale 409 would resurface in the bottom error paragraph once `dupExisting` cleared (issue #267) |

### 3.9 Customer / location helpers

- `selectCustomer(c)` (248-277): sets `selectedCustomer`, mirrors the record into `contact` (phone
  through `formatPhoneInput`), then defaults `locationValue` to `defaultLocationId(c)` = the customer's
  `is_primary` location, else the first, else `''`. If a location exists it copies the full address;
  if none exists it forces `locationId: ADD_NEW_LOCATION` with a blank address so the add-new form
  shows immediately.
- `handleFieldChange(field, value)` (293-297): updates `contact`, and **if a customer was selected it
  calls `clearSelectedCustomer()`** - editing any contact field drops back to new-customer mode,
  which also wipes `locationValue` and reverts the button label to `Continue`.
- `PickOrAccreteLocation` receives `showPicker`, `label="Location"`, and (desktop only) a
  `pickerNote` reading `Tax is calculated from this service location on save.`

### 3.10 Selector surface (form)

No `data-testid`. Spec-relied selectors, read from the spec headers:
- heading `New Invoice`; buttons `Continue`, `Create Invoice`, `Cancel`
- `getByPlaceholder('Search...')` `.first()` = the First Name input inside `PickOrCreateCustomer`
- `#phone`, `#email` element ids
- `getByPlaceholder('Item name')` `.first()`; `getByPlaceholder('1')` `.first()` = qty;
  `getByPlaceholder('0.00')` `.first()` = unit PRICE (the unit-COST input shares that placeholder and
  renders AFTER, hence `.first()`)
- totals text `Subtotal`, `Tax (6.25%)`, `Total`
- validation strings `Add at least one line item`, `Required`, `Quantity must be greater than 0`
- dup dialog: `Possible Duplicate Customer`, `Open existing customer`, `Edit email`, `Cancel`, `Create anyway`
- Spec files: `frontend/e2e/specs/redesign/08-standalone-invoice.spec.ts` (T1-T7),
  `frontend/e2e/specs/standalone/standalone-form.spec.ts` (SA-1/2/5/7/8/9),
  `frontend/src/__tests__/standalone-invoice-form.test.tsx`

---

## 4. `/invoices/:id` - InvoiceDetailPage

### 4.1 Component tree

```
<div className="space-y-4" data-testid="invoice-detail">
  <Breadcrumb items={activeBreadcrumbs} />

  <Card>                                              // hero
    left:  h1 {invoice_number} + <StatusBadge/> + kind badge (Deposit | Service Plan)
           customer line: link|span + phone (tel:) + email (mailto:)
           service address line (only when invoice.job?.service_location)
           links row: Job {job_number} and/or Estimate {estimate_number}
           dates row: Sent … · Due … (X days left|overdue|Due today) · Paid …
    right: action buttons (see 4.5) + overflow DropdownMenu + delete spinner
           hero amount: <p data-testid="invoice-amount-due">{formatCurrency(amountDue)}</p> + "Amount Due"
  </Card>

  {overdue && <div>OVERDUE banner</div>}
  {status === 'VOIDED' && <div>voided banner</div>}

  <Card>                                              // Payment Summary waterfall
    Invoice Total / [Deposit Credit] / [Additional Payments (n)] / Balance Due + progress bar
  </Card>

  <Card className="p-0">
    <Tabs defaultValue="line-items">
      TabsList: Line Items ({allItems.length}) | Payments ({ledger.length}) | Notes ({notesData?.length||0})
      TabsContent line-items: <InvoiceLineItemsEditor/> + invoice-only money tail
      TabsContent payments:   [Record Payment button] + ledger table (data-testid="invoice-ledger") or empty state
      TabsContent notes:      [Add Note form] + note list
    </Tabs>
  </Card>

  <SendInvoiceDialog open={sendOpen} .../>            // send
  <SendInvoiceDialog open={resendOpen} isResend .../> // resend (a SECOND instance, always mounted)
  <RecordPaymentDialog .../>
  <VoidInvoiceDialog .../>
  <RefundInvoiceDialog .../>
  <CreditInvoiceDialog .../>
  {voidPaymentTarget && <VoidPaymentDialog .../>}     // conditionally mounted
</div>
```

Tabs are uncontrolled (`defaultValue="line-items"`); the active tab is NOT in the URL and does not
survive a reload. `TAB_TRIGGER_CLASS` (line 312) gives the active trigger a bottom primary border and
removes the default shadow.

### 4.2 Queries

| Hook | Key | Endpoint | Notes |
|---|---|---|---|
| invoice | `['invoice', id]` | `GET /api/invoices/:id` -> `data.invoice as InvoiceDetail` | drives everything |
| notes | `['invoice-notes', id]` | `GET /api/invoices/:id/notes` -> `data.notes` | `enabled: Boolean(id)`; refetched imperatively via `refetch()` after add |
| state tax rates | `['state-tax-rates']` | inside `InvoiceLineItemsEditor`, `enabled: isEditable && canUpdate`, `staleTime: 1h` | jurisdiction dropdown |

`invalidateInvoice()` (line 359) = `invalidateQueries(['invoice', id])` + `invalidateQueries(['invoices'])`.
The second key prefix-matches the list page's `['invoices', {...}]` key, so the list refreshes too.

### 4.3 Mutations owned by the page

| Mutation | Endpoint | Body | onSuccess |
|---|---|---|---|
| `deleteMutation` | `DELETE /api/invoices/:id` | - | `invalidateQueries(['invoices'])`, `navigate('/invoices')`. Note: does NOT invalidate `['invoice', id]` |
| `addNoteMutation` | `POST /api/invoices/:id/notes` | `{ content: noteContent }` | `setNoteContent('')`, `refetchNotes()` |

Neither has an `onError`; a failed delete leaves `deleteMutation.isPending` false and shows nothing.
No optimistic updates.

### 4.4 Derived data (lines 466-516)

```
actions        = getAvailableActions(invoice, user?.role || '', ability)
overdue        = isOverdue(invoice)                  // due_date set, status SENT|PARTIAL, due < now
customer       = invoice.customer ?? invoice.job?.customer ?? {id:'',first_name:'',last_name:'',email:'',phone:''}
loc            = invoice.job?.service_location ?? null
estimate       = invoice.job?.estimate ?? null
ownLineItems   = invoice.line_items ?? []
estimateItems  = estimate?.line_items ?? []
allItems       = (ownLineItems.length > 0 ? ownLineItems : estimateItems).map(clone).sort(by sequence)
totalAmount    = Number(invoice.total_amount)
amountDue      = Number(invoice.amount_due)
depositCredit  = Number(invoice.deposit_credit)
customerPayments = invoice.payments.filter(p => p.reference_number !== 'DEPOSIT-CREDIT')
paymentsTotal    = sum of customerPayments amounts
progressPct      = totalAmount > 0 ? min(((totalAmount - amountDue)/totalAmount)*100, 100) : 0
netPaid          = Number(invoice.net_collected ?? 0) || paymentsTotal      // legacy rows carry 0
canVoidPayment   = ability.can('void_payment','Invoice')
isManualMethod(m)= m === 'CASH' || 'CHECK' || 'BANK_TRANSFER'
```

The `customer ?? job?.customer ?? {}` chain is a regression fix (2026-06-05): a job-less
(deposit / orphan) invoice has `job === null` and must not throw. Covered by
`frontend/src/__tests__/invoices-jobless-render.test.tsx` and e2e `redesign/00-render-safety.spec.ts`
R0-03.

**Breadcrumbs** (508-516), three cases in priority order:
1. `location.state?.breadcrumbs` present -> `[...incoming, { label: invoice_number }]`
2. else `invoice.job` present -> `[{Jobs,/jobs}, {job_number, /jobs/{id}}, {invoice_number}]`
3. else -> `[{Invoices,/invoices}, {invoice_number}]`

Outbound links carry state back: both the Job link and the Estimate link pass
`state={{ breadcrumbs: [{Invoices,/invoices}, {invoice_number, /invoices/{id}}] }}`.

`getDueDateLabel` (301-310): `diffDays = ceil((due - now) / 86 400 000)`; `< 0` -> `"N day(s) overdue"`;
`0` -> `"Due today"`; else `"N day(s) left"`.

### 4.5 `getAvailableActions` (lines 275-293) - the permission core

```ts
isPayable = status === 'SENT' || status === 'PARTIAL'
isDraft   = status === 'DRAFT'
canManage = role === 'ADMIN' || role === 'DISPATCHER'     // raw role check, NOT CASL

canSend          = isDraft   && canManage
canResend        = isPayable && !!public_token && canManage
canRecordPayment = (isPayable || isDraft) && ability.can('record_payment','Invoice')
canVoid          = isPayable && ability.can('void','Invoice')
canDelete        = isDraft   && canManage
canEdit          = isDraft   && canManage
canAddNotes      = ability.can('update','Invoice')
canCopyLink      = !!public_token
```

Note the deliberate mix: `canSend`/`canResend`/`canDelete`/`canEdit` use the RAW ROLE, while
`canRecordPayment`/`canVoid`/`canAddNotes` use CASL. The code comment on `canRecordPayment` (D4)
explains why: the previous `role === 'TECHNICIAN' && isOwnJob` granted by role what the per-user
toggle is supposed to gate. `record_payment Invoice` is a per-user capability
(`userCapabilities.ts:147-154`, own condition `OWN_INVOICE_VIA_JOB`) plus a DISPATCHER role default
(`defaultGrants.ts:114`) plus ADMIN manage-all. A bare technician has none of it and 403s.

Additional inline CASL gates outside `getAvailableActions`:

| Element | Condition |
|---|---|
| Refund button | `ability.can('refund','Invoice') && netPaid > 0 && ['PAID','PARTIAL','PARTIALLY_REFUNDED'].includes(status)` |
| Credit button | `ability.can('credit','Invoice') && status !== 'DRAFT' && status !== 'VOIDED'` |
| Per-payment "Void" link in the ledger | `canVoidPayment && payment !== undefined && isManualMethod(payment.method) && !payment.voided_at` |
| Overflow menu itself | `actions.canVoid \|\| canDelete \|\| canCopyLink \|\| canEdit` |
| Line-items editor internals | see 4.9 |

`void` / `refund` / `credit` / `void_payment` on Invoice appear in the permission catalog
(`backend/src/lib/permissions/catalog.ts:87-90`) marked "(admin-only)" and have NO role rows in
`defaultGrants.ts` outside ADMIN manage-all. So in practice these four buttons are ADMIN-only unless
an org grants them through Roles and Permissions.

### 4.6 Hero action buttons (in DOM order, lines 641-713)

| Button | Variant | Gate | Opens |
|---|---|---|---|
| `Send Invoice` (`Send` icon) | business | `actions.canSend` | `setSendOpen(true)` -> `SendInvoiceDialog` (Sheet, right side) |
| `Resend Invoice` (`Send` icon) | outline | `actions.canResend` | `setResendOpen(true)` -> second `SendInvoiceDialog` with `isResend` |
| `Record Payment` (`DollarSign`) | business | `actions.canRecordPayment` | `setRecordPaymentOpen(true)` -> `RecordPaymentDialog` (Dialog, `max-w-sm`) |
| `Refund` (`CreditCard`) | destructive, `size="sm"` | refund gate above | `setRefundOpen(true)` -> `RefundInvoiceDialog` (Dialog, `max-w-md`) |
| `Credit` (`Gift`) | outline, `size="sm"` | credit gate above | `setCreditOpen(true)` -> `CreditInvoiceDialog` (Dialog, `max-w-md`) |
| Overflow (`MoreHorizontal`) | outline, `size="sm"` | any of edit/copy/void/delete | Radix `DropdownMenu`, `align="end"` |
| Delete spinner | - | `deleteMutation.isPending` | `Loader2` spinning icon |

Overflow menu items (in order):

| Item | Gate | Action |
|---|---|---|
| `Edit` (`FileText`) | `actions.canEdit` | `navigate('/invoices/{id}/edit')` - **no such route**, bounces to `/` (OQ-2) |
| `Copy Public Link` / `Copied!` (`Link2`) | `actions.canCopyLink` | `handleCopyLink()`: `navigator.clipboard.writeText(`${origin}/p/invoices/${id}?token=${public_token}`)`, sets `linkCopied` true, resets after 2000 ms via `setTimeout`. No toast. |
| `Print` (`FileText`) | **always** | `window.print()` |
| `Void Invoice` (`XCircle`, `text-danger`) | `actions.canVoid` | `setVoidOpen(true)` -> `VoidInvoiceDialog` |
| `Delete` (`Trash2`, `text-danger`) | `actions.canDelete` | native `window.confirm('Are you sure you want to delete this invoice?')`; on OK `deleteMutation.mutate()` |

### 4.7 Banners

- Overdue (727-733): `border-red-200 bg-red-50 text-red-700`, `AlertTriangle`, text
  `OVERDUE - {getDueDateLabel} past due (was due {due_date.toLocaleDateString()})` (the literal
  separator in source is an em dash glyph).
- Voided (736-742): `border-gray-200 bg-gray-50 text-gray-600`, `XCircle`, text
  `This invoice was voided on {voided_at.toLocaleDateString() | 'unknown date'}{voided_reason && ': ' + reason}`.

### 4.8 Payment Summary waterfall card (744-785) - MONEY MATH

All figures come from the server; the page does no re-derivation of totals here.

```
Invoice Total                       formatCurrency(totalAmount)                      always
Deposit Credit                      -formatCurrency(depositCredit)  text-green-600   only when depositCredit > 0
Additional Payments (n)             -formatCurrency(paymentsTotal)  text-green-600   only when paymentsTotal > 0
--------------------------------------------------------------
Balance Due (bold)                  formatCurrency(amountDue)
                                    text-red-600 when overdue; text-green-600 when amountDue === 0
```

`n` = `customerPayments.length` (deposit-credit rows excluded). Progress bar below:
`width: {progressPct}%`, colour `bg-gray-300` at 0, `bg-green-500` at >= 100, else `bg-info`;
caption `{progressPct.toFixed(0)}% collected`.

**Where the money is actually computed**

Everything except the progress bar and `paymentsTotal` is a persisted server column. The pipeline:

1. **Invoice creation from a job with an estimate** (`invoice.controller.create`, 518-551):
   - `subtotal` = sum of estimate `line_total`s.
   - `discountAmount` = `estimate.discount_amount`.
   - `taxRate` = `estimate.tax_rate`.
   - `taxAmount` = 0 when the customer is `tax_exempt`; otherwise the estimate discount is PRORATED
     across the taxable estimate items:
     `discountOnTaxable = discount * taxableTotal / subtotal`;
     `taxAmount = round2((taxableTotal - discountOnTaxable) * taxRate)`.
   - Lines are SNAPSHOTTED onto the invoice (`InvoiceLineItem`), including `unit_cost` and
     `price_book_item_id`.
2. **Invoice creation from a job with NO estimate** (552-564): lines come from the request body,
   `discountAmount = 0`, `taxRate = lookupStateTaxRate(job.service_location.state)`, totals via
   `computeOwnedLineTotals` (no discounts).
3. `totalAmount = round2(subtotal - discountAmount + taxAmount)` (line 566).
4. **Deposit credit** (580-601, the subtle area):
   - Only when the job has an estimate. The deposit is a real sibling `kind='DEPOSIT'` Invoice on the
     same estimate (created at `estimate.send()`), found by
     `{ estimate_id, kind:'DEPOSIT', status:'PAID' }`.
   - `remaining = remainingDepositCredit(tx, depInv.id)` reads the `DepositCreditApplication` ledger
     inside the transaction: paid minus already-applied minus refunded.
   - `depositCredit = round2(min(max(remaining,0), totalAmount))` - it can never exceed this
     invoice's total, and the ledger caps the sum across all of a job's STANDARD invoices at the
     deposit.
   - `amountDue = round2(totalAmount - depositCredit)`.
   - After the invoice row is created, `applyDepositCredit(...)` writes the ledger row, and when
     `applied > 0` a synthetic `Payment` row is created with
     `{ amount: applied, method: 'CARD', reference_number: 'DEPOSIT-CREDIT', notes: DEPOSIT_CREDIT_NOTE, collected_by: null }`.
   - **This is why the frontend filters `reference_number === 'DEPOSIT-CREDIT'` out of
     `customerPayments` and out of the ledger.** The deposit credit is a POST-TAX payment, never a
     discount line. `isDepositCreditPayment` (line 171) and the ledger filter (line 216) both key on
     that exact string.
   - The job's `amount_invoiced` is incremented by the GROSS `totalAmount`, not `amountDue`.
   - Standalone invoices get NO deposit credit (no estimate to draw down).
5. **Line/billing edits** (`invoice-lines.controller.recomputeAndPersist`, 149-214) re-derive with
   `recomputeInvoiceTotals` (`backend/src/lib/invoice-totals.ts`):
   ```
   per line: lineTotal = round2(qty * unit_price)
             lineDiscount = PERCENTAGE ? round2(lineTotal * value/100)
                                       : min(round2(value), lineTotal)
             effective = round2(lineTotal - lineDiscount)
   subtotal              = round2(sum of effective)                       // NET of per-line discounts
   discountedSubtotal    = round2(subtotal - invoiceDiscountAmount)
   taxableSubtotal       = sum of effective where is_taxable, then, if invoiceDiscount > 0 and subtotal > 0,
                           round2(discountedSubtotal * (taxableAfterDiscounts / subtotal))   // prorated
   tax_amount            = taxExempt ? 0 : round2(taxableSubtotal * taxRate)
   total_amount          = round2(discountedSubtotal + tax_amount + round2(tip))             // TIP IS POST-TAX, NEVER TAXED
   ```
   then
   ```
   amountPaid = amountPaidOf(oldTotal, depositCredit, oldAmountDue)
   amount_due = round2(max(newTotal - depositCredit - amountPaid, 0))
   status     = amountPaid > 0 ? (amount_due <= 0 ? 'PAID' : 'PARTIAL') : unchanged
                (and paid_at is set when it flips to PAID)
   ```
   So editing a line on a SENT/PARTIAL invoice can settle it, and settling it also LOCKS it.
6. **Payments** (`recordPayment`, 1400-1436): inside a transaction the invoice is re-read;
   `newAmountDue = round2(max(currentDue - amount, 0))`, `overpaid = round2(max(amount - currentDue, 0))`,
   `status = newAmountDue <= 0 ? 'PAID' : 'PARTIAL'`, `paid_at` set when fully paid.
7. `tax_rate` on the invoice is a FRACTION (0.0663 = 6.63%). The `PATCH /billing` schema enforces
   `z.number().min(0).max(1)`. Displaying it means multiplying by 100.

### 4.9 Line Items tab

```
<InvoiceLineItemsEditor invoice={invoice} estimateLines={estimateItems} />
{allItems.length > 0 && (
  <div className="w-[340px]">                        // the invoice-only money tail, BELOW the editor
    {depositCredit > 0 && "Less deposit credit"   -formatCurrency(depositCredit)  text-sage-700}
    {paymentsTotal > 0 && "Less payments applied" -formatCurrency(paymentsTotal)  text-sage-700}
    {Number(total_refunded) > 0 && "Refunded"     +formatCurrency(total_refunded) text-danger}
    ------------------------------------------------
    Balance Due (bold)  formatCurrency(amountDue)   // text-danger when overdue, text-sage-700 when 0
  </div>
)}
```

This is called "hybrid totals": `TotalsFooter` (inside the editor) owns lines -> subtotal ->
invoice discount -> tip -> tax -> **Invoice total**; the page owns the tail below it.

`InvoiceLineItemsEditor` (`components/invoices/InvoiceLineItemsEditor.tsx`):

```
isEditable     = isInvoiceEditable(invoice.status)      // NOT in [PAID, VOIDED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED]
canUpdate      = ability.can('update','Invoice')
canManageLines = ability.can('manage_lines','Invoice')
ownLines       = invoice.line_items ?? []
usingOwnLines  = ownLines.length > 0
lines          = usingOwnLines ? ownLines : estimateLines           // read-only estimate basis fallback

canEditRows    = isEditable && canUpdate && usingOwnLines
canEditBilling = isEditable && canUpdate                            // billing stays editable at zero lines
canManageRows  = isEditable && canManageLines && usingOwnLines
canAdd         = isEditable && canManageLines
```

Header: `Line items (n)` plus, when `canAdd`, a 28 px square sage `+` button with
`aria-label="Add line item"` that sets `addOpen`.

Mutations (all invalidate `['invoice', id]` + `['invoices']`, all toast
`extractApiError(err, fallback)` with `variant:'destructive'` on error):

| Mutation | Endpoint | Payload | Extra |
|---|---|---|---|
| add | `POST /api/invoices/:id/line-items` | `AddLineItemPayload` | onSuccess also `setAddOpen(false)` |
| update | `PATCH /api/invoices/:id/line-items/:lineId` | `UpdateLineItemPayload` | - |
| delete | `DELETE /api/invoices/:id/line-items/:lineId` | - | - |
| billing | `PATCH /api/invoices/:id/billing` | `{ tip? } \| { discount_amount? } \| { tax_rate? }` (exactly one per call) | - |

`busy` = any of the four pending; passed down to disable every row input.

Backend gating differs per verb (`invoice.routes.ts:41-44`): add and delete are `manage_lines`
(so SALES own-scoped and a granted technician can add/remove), while `PATCH line-items/:lineId`
and `PATCH billing` are `update` (ADMIN/DISPATCHER only in practice). Every one of the four also
runs `loadGuardedInvoice`: 404 -> `canAccessRow` 403 -> `isInvoiceEditable` 400 with
`This invoice is locked and can no longer be edited (it is paid or closed)`.

`LineItemsTable` (shared) rendering:
- Rows grouped into `Materials` then `Services` sub-headers by `item_type` (default SERVICE); empty
  groups are dropped. Group header text is `{label} ({count})`.
- Column headers: `Item | Qty | Unit price | Taxable | Discount | Total` plus an unlabeled trash column.
- Empty state: `Package` icon, `No line items yet.`, and when `canAdd` a
  `Add line item` button with `aria-label="Add the first line item"`.
- The `TotalsFooter` still renders at zero lines when `hasInvoice && (tip > 0 || discount_amount > 0)`
  ("residual billing"), so orphaned money stays visible and editable.
- `showEstimateBasisHint` (set when `!usingOwnLines && lines.length > 0`) renders
  `Read-only estimate basis - add a line to start billing.` under the table.

`LineItemRow` interactions (`canEdit` only):
- Qty `Input type=number min=0.01 step=0.01`, `aria-label={`Quantity for ${name}`}`; commits on blur
  and on Enter, only when parseable, `> 0`, and different from the current value.
- Unit price `Input type=number min=0 step=0.01`, `aria-label={`Unit price for ${name}`}`; commits on
  blur/Enter when `>= 0` and changed.
- Taxable `Switch`, `aria-label={`Taxable for ${name}`}`; commits IMMEDIATELY.
- Discount: a `Select` (`None` / `%` / `$`) `aria-label={`Discount type for ${name}`}` plus, when a
  type is chosen, a value `Input` `aria-label={`Discount value for ${name}`}` committing on blur/Enter.
  Choosing `None` immediately sends `{ discount_type: null, discount_value: null }` (only if a
  discount existed). A non-positive value is silently ignored.
- Trash button (`canManage`) `aria-label={`Remove ${name}`}` -> delete, no confirmation dialog.
- Row display: the FIRST line of `description` is the item name, the rest is the clamped detail
  (`splitDescription`). Line total shown = `max(0, line_total - discount_amount)`.
- Read-only fallbacks: qty as a plain number, price as currency, taxable as `Yes` or the em dash
  glyph, discount as `-{currency}` or the em dash glyph.

`TotalsFooter` rows (right-aligned, 340 px):
`Total qty` (muted; integer or 2 dp) / `Item cost` (= server `subtotal` when `hasInvoice`) /
`Discount (items)` when the summed per-line discounts > 0 / `Invoice discount` (editable
`Input aria-label="Invoice-level discount"`, commits on blur, `parseFloat || 0`) / `Tip` (editable
`Input aria-label="Tip amount"`, same commit rule) / tax block / `Invoice total`.
The tax block when `hasInvoice && editable` is a bordered card with a `Select`
`aria-label="Tax jurisdiction"` listing `No tax (0%)`, an optional `Custom rate (X%)` entry when the
stored rate matches no state, and one entry per state as `{state_name} ({pct}%)`; below it
`Tax (X%)` and the server tax amount. Selecting `No tax` sends rate 0; selecting `CUSTOM` is a no-op.
Reverse mapping tolerance is `Math.abs(stateRate - taxRateVal) < 0.0001`.
**The footer never re-derives tax** - that was a fraction-vs-percent 100x bug.

`AddLineDialog` (shared) flow:
1. Debounced (300 ms) `searchPriceBookItems(q)` -> `GET /api/price-book/items/search?q=`; results render
   with thumbnails.
2. Pick an item -> confirm quantity -> Add. Payload snapshots the catalog values:
   `description = item.description ? `${name}\n${description}` : name`, `item_type = item.type`,
   `unit_price = Number(item.unit_price)`, `is_taxable = item.taxable`, `price_book_item_id = item.id`.
3. No match -> "Add '<text>' as a new item" -> a compact form (name / type MATERIAL|SERVICE / unit
   price / taxable). Payload carries NO `price_book_item_id` unless "Also save to price book" is
   ticked (offered only when `canSaveToPriceBook`, wired here to `canUpdate`), in which case
   `POST /api/price-book/items` runs first and its id is attached.
4. Client validation strings: `Quantity must be a positive number.`, `Name is required.`,
   `Unit price must be a non-negative number.`, `Search for an item, or add a new one.`,
   `Could not save to the price book.`
5. The dialog closes only on success (the parent's `onSuccess` sets `addOpen=false`); a rejection
   keeps it open and shows the extracted error. Closing resets all internal state.

### 4.10 Payments tab - the ledger

`buildLedgerEvents(invoice)` (lines 189-273) builds a merged, chronologically sorted event list:

1. **Deposit Paid** - when `invoice.job.estimate.invoices[0].payments[0]` exists with a `paid_at`.
   `source:'ESTIMATE'`, `method: depositPayment.method || 'CARD'`, `sign '+'`, `by: 'Stripe'`,
   `estimateId` / `estimateNumber` carried for the link. (Bug #45: the deposit's real Payment now
   lives on the sibling `kind=DEPOSIT` invoice; the backend selects it via `estimate.invoices`
   filtered to `kind=DEPOSIT, take 1`.)
2. **Invoice payments** - every `invoice.payments` row EXCEPT `reference_number === 'DEPOSIT-CREDIT'`.
   `label = method === 'CARD' ? 'Invoice Paid' : 'Manual Payment'`, `source:'INVOICE'`, `sign '+'`,
   `key = payment.id`, `by = collector name` else `'Stripe'` for CARD else the em dash glyph.
3. **Invoice Refunded** - when `status === 'REFUNDED' && refunded_at && total_refunded`.
   `sign '-'`, `isRefund:true`, `method 'CARD'`, `by` = em dash glyph.
4. **Deposit Refunded** - when the deposit invoice is `REFUNDED` with `refunded_at` and
   `total_refunded`. `source:'ESTIMATE'`, `sign '-'`, `by: 'Stripe'`.

Sorted ascending by `new Date(date).getTime()`. The tab badge shows `buildLedgerEvents(invoice).length`,
and the function is called AGAIN inside the tab body (twice per render total).

Rendering:
- `actions.canRecordPayment` -> a right-aligned `Record Payment` button above the table.
- `ledger.length === 0` -> centred empty state: `DollarSign` 40 px icon,
  `No payments recorded yet`, `Payments will appear here once recorded. Deposit credit is shown in
  the payment summary.`, plus the `Record Payment` button again when permitted.
- Otherwise a `<table data-testid="invoice-ledger">` with columns `Date | Event | Source | Method |
  Amount | By`. Inbound rows first; when refunds exist, a dashed `Refunds` separator row spanning 6
  columns, then the outbound rows.
- Row classes: hover tint; `bg-red-50/40` for refund rows; `opacity-60 line-through` for voided
  payments, which also render a small uppercase `voided` marker beside the label.
- Date cell: `toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })` with a
  `title` of the full `toLocaleString()`.
- Source cell: an ESTIMATE-sourced event with an `estimateId` renders a `Link` to
  `/estimates/{id}` showing the estimate number (no breadcrumb state passed); otherwise a static
  `INVOICE` chip.
- Method cell: `<Badge variant="outline">{method.replace('_',' ')}</Badge>` (single replace, so
  only the first underscore).
- Amount cell: `{sign}{formatCurrency(amount)}`, `text-red-600` for refunds else `text-green-600`.
- By cell: the `by` string, plus a ghost `Void` button when `canOfferVoid`.
- `tfoot`: `{n} event(s) · +{totalIn} collected [· -{totalOut} refunded] · Net {net}` where
  `net = totalIn - totalOut`; the Net figure is muted when `net === 0 && hasRefunds`, else green.

### 4.11 Notes tab

- When `actions.canAddNotes` (`can('update','Invoice')`): `Label "Add Note"`, a `Textarea rows={3}`
  with placeholder `Add a note...` bound to `noteContent`, and a small `Add Note` button
  `disabled={!noteContent.trim() || addNoteMutation.isPending}` showing `Adding...` while pending.
- List: `No notes yet.` when empty; otherwise per note a header line
  `{creator.first_name} {creator.last_name} · {created_at.toLocaleString()}` and the content in
  `whitespace-pre-wrap`, separated by a bottom border except the last.
- Backend: `GET notes` is `canDo('read','Invoice')`, `POST notes` is `canDo('update','Invoice')`,
  schema `{ content: z.string().min(1).max(5000) }`.

### 4.12 Dialogs on the detail page

#### SendInvoiceDialog (Sheet, `side="right"`, `w-full sm:max-w-xl overflow-y-auto`)

Mounted TWICE, once with `isResend` and once without, both always in the DOM (open state controls
visibility).

- Props: `invoiceId, invoiceNumber, customerEmail, dueDate, totalAmount, amountDue, lineItems (allItems), onSuccess=invalidateInvoice, isResend?`
- State: `recipientEmail` (seeded from `customerEmail`, re-seeded by a `useEffect` on that prop),
  `messageBody` (default `'Your invoice is ready. Click the link below to view it and make a payment.'`),
  `ccEmails: string[]`, `ccInput`, `ccError`.
- `EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/`, `MAX_CC = 5`.
- `To` field id `invoice-recipient-email`; invalid input shows `Enter a valid email address`.
- CC field id `invoice-cc-emails`, placeholder `Add email and press Enter`. `tryAddCc` triggers on
  Enter, Tab, a trailing comma typed into the field, or blur. Rejections: `Invalid email address`,
  `Email already added` (duplicate OR case-insensitive match with the To address),
  `Maximum 5 CC emails`. Backspace on an empty input removes the last chip. The input is `disabled`
  at 5 chips. Each chip has a remove `button` with `aria-label={`Remove ${email}`}`.
- Message: `Textarea rows={3}` id `invoice-message`.
- A read-only Invoice-details panel lists the line items sorted by `sequence`
  (`{description}` + `{qty} x {unit_price}` + `{line_total}`) or `No line items`, then `Total`,
  `Amount Due`, and `Due Date` formatted `'en-US', {month:'short',day:'numeric',year:'numeric'}` or
  the literal `No due date`.
- Submit: `POST /api/invoices/:id/send` or `/resend`, body
  `{ to: recipientEmail.trim(), ...(cc.length ? {cc_emails} : {}), ...(messageBody.trim() ? {message_body} : {}) }`.
  Disabled when `!recipientValid || isPending`; pending label `Sending...` with a spinner.
- onSuccess: `onSuccess()` (invalidate), close, toast
  `{ title: 'Invoice sent' | 'Invoice resent', description: '{invoiceNumber} has been emailed to {to}.' }`.
- onError: toast `{ title:'Send failed', description: err.response.data.error || 'Failed to send invoice', variant:'destructive', duration: Infinity }`
  AND an inline `extractApiError` paragraph.
- Backend `send` (1059-1146): 404 -> `canAccessRow` 403 -> `status !== 'DRAFT'` 400
  `Only DRAFT invoices can be sent` -> resolves `to = body.to || customer.email`, 400
  `No recipient email - add a recipient to send this invoice` if absent -> sets
  `status:'SENT', sent_at, public_token: crypto.randomUUID(), due_date` (existing or
  `calculateDueDate(customer.payment_type, now)`) -> fires the email asynchronously with a public URL
  `${FRONTEND_URL}/p/invoices/{id}?token={token}`.
- `calculateDueDate` (148-160): `COD` -> today, `NET 15/30/60` -> +15/30/60 days, `EOM` -> last day of
  next month via `new Date(y, m+1, 0)`, default -> +30 days.
- Send schema: `{ to?: email, cc_emails?: email[] max 5, message_body?: string max 5000 }`. Route gate
  `canDo('send','Invoice')`.

#### RecordPaymentDialog (Dialog, `max-w-sm`)

- State seeded on mount: `amount = amountDue` (a number, not a string), `method = 'CASH'`,
  `paidAt = new Date().toISOString().slice(0,16)` (local `datetime-local` format, in UTC), plus empty
  `referenceNumber` and `notes`.
- Fields: `Amount *` (`Input type=number min=0.01 max={amountDue} step=0.01`, helper
  `Max: {formatCurrency(amountDue)}`), `Payment method *` (`SelectField aria-label="Payment method"`
  with CASH/Cash, CHECK/Check, CARD/`Credit Card (Stripe)`, EXTERNAL_CARD/`External Credit Card
  Processor`, BANK_TRANSFER/`Bank Transfer`), `Date *` (`datetime-local`), `Reference number`
  (placeholder `Check #, transaction ID, etc.`), `Notes` (`Textarea rows={2}`, placeholder
  `Optional notes...`).
- Submit `POST /api/invoices/:id/payments` with
  `{ amount, method, paid_at: paidAt ? new Date(paidAt).toISOString() : undefined, reference_number: referenceNumber || undefined, notes: notes || undefined }`.
  Disabled when `!amount || !paidAt || isPending`; pending label `Processing...` with a spinner.
- onSuccess: `onSuccess()` (invalidate), close, and reset every field back to the defaults.
- Errors render inline via `extractApiError(err, 'Failed to record payment')`. No toast.
- Note the `max={amountDue}` attribute is advisory only: `parseFloat` on change does not clamp, and
  the dialog does not block an over-max submit client-side. The backend explicitly ALLOWS
  overpayment (see 4.8 item 6 and OQ-5).
- Backend `recordPayment` gate: route `canDo('record_payment','Invoice')`, then status must be
  `DRAFT | SENT | PARTIAL` (400 `Payments can only be recorded on DRAFT, SENT, or PARTIAL invoices`),
  then `canAccessRow` 403. Schema: `amount` positive number, `method` enum of the 5 above,
  `paid_at?` ISO datetime, `reference_number?` max 100, `notes?` max 2000.
- Side effect worth knowing: fully paying a `kind='DEPOSIT'` invoice through this endpoint also sets
  its estimate to `WON` with `approved_at`, and moves the lead to `WON` when it is not already
  WON/LOST/CANCELLED.

#### VoidInvoiceDialog (Dialog, `max-w-sm`)

- Amber warning block: `Voiding invoice {invoiceNumber} will preserve the record but mark it as
  cancelled. This action cannot be undone.`
- `Reason *` `Textarea rows={3}`, placeholder `Why is this invoice being voided?`.
- Submit `POST /api/invoices/:id/void` body `{ voided_reason: reason }`; destructive button disabled
  when `!reason.trim() || isPending`, pending label `Voiding...`.
- onSuccess (page-supplied): `invalidateInvoice()` then `navigate('/invoices')` - the user is
  ejected from the detail page.
- Schema `{ voided_reason: string min 1 max 1000 }`; route gate `canDo('void','Invoice')`.

#### RefundInvoiceDialog (Dialog, `max-w-md`, `data-testid="refund-invoice-dialog"`)

- Props: `invoiceId`, `netPaid`, `payments` (mapped `customerPayments` -> `{id, amount, method, paid_at}`),
  `refunds` (`invoice.refunds`).
- Optional refunds ledger table at the top (`Date | Amount | Method | Reason`), amounts prefixed with
  a minus sign in `text-red-600`, `non_taxable_concession` appending ` · non-tax`.
- Info block: `Net paid: {formatCurrency(netPaid)}` plus
  `Card refunds are processed automatically via Stripe; manual methods record the give-back.`
- Fields:
  - `Amount` (`data-testid="refund-amount-input"`, `type=number min=0.01 max={netPaid} step=0.01`,
    placeholder `Full refund ({netPaid})`). Blank means a FULL-balance refund (the field is omitted
    from the body). `amountInvalid` when parsed and (`NaN || <= 0 || > netPaid`), showing
    `Amount must be between 0 and {netPaid}.`
  - `Refund method` `SelectField aria-label="Refund method"`, first option
    `Auto (match original payment)` (sentinel `NONE`), then CARD / EXTERNAL_CARD / CASH / CHECK /
    BANK_TRANSFER.
  - `Reverse a specific payment` - rendered only when `payments.length > 0`;
    `aria-label="Reverse a specific payment"`, first option `Auto / oldest` (sentinel `NONE`), then
    one option per payment labelled `{amount} · {method with first _ replaced} · {paid_at date}`.
  - Checkbox `#refund-non-taxable` `Non-taxable concession (do not reverse tax)`.
  - `Reason category *` `SelectField aria-label="Reason category"` placeholder `Select a reason...`,
    options CUSTOMER_REQUEST/`Customer request`, ERROR/`Billing error`, GOODWILL/`Goodwill`,
    OVERPAYMENT/`Overpayment`, CHARGEBACK/`Chargeback`, OTHER/`Other`.
  - `Reason details *` `Textarea rows={3}` placeholder `Provide details about this refund...`.
- Submit `refundInvoice(id, { amount?, payment_id?, method?, non_taxable_concession?, reason_category, reason })`
  -> `POST /api/invoices/:id/refund`. Button `data-testid="refund-invoice-submit"`, label
  `Issue Refund` / `Processing...`, disabled when `!reasonCategory || !reason.trim() || amountInvalid || isPending`.
- onSuccess: invalidates `['invoice', id]` and `['invoices']` itself (it does NOT call an
  `onSuccess` prop - none is passed), closes, resets.
- Route gate `canDo('refund','Invoice')`. Refund tax is prorated server-side:
  `computeRefundTax = round2(amount * tax_amount / total_amount)`, forced to 0 when
  `non_taxable_concession` is set or `total_amount <= 0`.

#### CreditInvoiceDialog (Dialog, `max-w-md`, `data-testid="credit-invoice-dialog"`)

- Props: `invoiceId`, `balanceOwed` (= `amountDue`), `credits`.
- Optional credits ledger table (`Date | Amount | Category | Reason`), amounts in `text-green-600`,
  reason truncated at `max-w-[10rem]`.
- Blue info block: `Credits apply to the outstanding balance first[ ({balanceOwed} owed)]; any excess
  is refunded to {method lowercased with first _ replaced | 'the chosen method'}.`
- Fields:
  - `Amount *` (`data-testid="credit-amount-input"`, `type=number min=0.01 step=0.01`, placeholder `0.00`).
    `amountInvalid = Number.isNaN(parsed) || parsed <= 0`; the message `Enter a positive amount.` shows
    only once the field is non-blank. `excess = max(parsed - balanceOwed, 0)`; when `> 0` a helper line
    reads `{balanceOwed} credited · {excess} refunded as excess.`
  - `Category` free-text `Input`, placeholder `e.g. goodwill, adjustment (optional)`.
  - Checkbox `#credit-refund-instead` (`data-testid="credit-refund-instead"`)
    `Refund excess to card/cash instead of crediting balance`.
  - `Refund method` - rendered only when `showMethod = refundInstead || excess > 0`;
    `aria-label="Refund method"`, first option `Select a method...` (sentinel `NONE`), then the 5
    payment methods.
  - Checkbox `#credit-non-taxable` `Non-taxable concession (do not reverse tax)`.
  - `Reason *` `Textarea rows={3} maxLength={500}` placeholder `Provide details about this credit...`.
- Submit `creditInvoice(id, { amount, reason, category?, refund_instead?, method?, non_taxable_concession? })`
  -> `POST /api/invoices/:id/credit`. Button `data-testid="credit-invoice-submit"`, label
  `Issue Credit` / `Processing...`, disabled when `amountInvalid || !reason.trim() || isPending`.
- onSuccess: self-invalidates both keys, closes, resets. Route gate `canDo('credit','Invoice')`.

#### VoidPaymentDialog (Dialog, `max-w-sm`, `data-testid="void-payment-dialog"`)

- Rendered ONLY when `voidPaymentTarget !== null`. `onOpenChange(false)` also clears the target.
- Amber block: `Voiding {amount} · {method with first _ replaced}[ · ref {reference_number}] re-opens
  the invoice balance. This action cannot be undone.`
- `Reason category *` `SelectField aria-label="Reason category"` placeholder `Select a reason...`,
  options BOUNCED/`Bounced (NSF / returned)`, ERROR/`Entry error`, DUPLICATE/`Duplicate payment`,
  WRONG_INVOICE/`Applied to wrong invoice`. `CHARGEBACK` is deliberately excluded (reserved for the
  system chargeback path).
- `Reason details *` `Textarea rows={3}` placeholder `Why is this payment being voided?`.
- Submit `voidPayment(invoiceId, { payment_id, void_category, reason })` ->
  `POST /api/invoices/:id/void-payment` (payment id in the BODY, not the path).
  Button `data-testid="void-payment-submit"`, label `Void Payment` / `Voiding...`, disabled when
  `!voidCategory || !reason.trim() || isPending`.
- onSuccess: self-invalidates `['invoice', invoiceId]` and `['invoices']`, closes, resets.
- Route gate `canDo('void_payment','Invoice')`.

### 4.13 States (detail)

| State | Rendering |
|---|---|
| Loading | A bespoke full-page skeleton (lines 396-460): breadcrumb strip (4 blocks), hero `Card` with a 7x32 title block, a 5x16 rounded status pill, three text lines, a right-hand 9x32 amount block plus a 3x20 caption, and two action blocks; a waterfall `Card` with 4 label/value rows plus a full-width bar; a tabs `Card` with 3 tab placeholders and 4 full-width rows. |
| Not found / error | `<div className="text-text-secondary py-12 text-center">Invoice not found</div>` - the SAME branch handles a 404, a 403, and any query error, because it keys on `!invoice`. |
| Notes loading | none; `notesData` is undefined until it resolves, so the tab badge shows `(0)` and the list shows `No notes yet.` |
| Ledger empty | dedicated empty state (see 4.10) |
| Line items empty | `LineItemsTable`'s `No line items yet.` + CTA |
| Mutation pending | per-dialog button labels; plus a `Loader2` spinner next to the overflow menu while deleting |

### 4.14 Selector surface (detail)

`data-testid` present on this page and its dialogs:

| testid | Where |
|---|---|
| `invoice-detail` | page root div (`InvoiceDetailPage.tsx:519`) |
| `invoice-amount-due` | hero amount `<p>` (`:717`) |
| `invoice-ledger` | payments `<table>` (`:965`) |
| `line-item-row` | each `<tr>` in `LineItemRow.tsx:91` |
| `refund-invoice-dialog`, `refund-amount-input`, `refund-invoice-submit` | RefundInvoiceDialog |
| `credit-invoice-dialog`, `credit-amount-input`, `credit-refund-instead`, `credit-invoice-submit` | CreditInvoiceDialog |
| `void-payment-dialog`, `void-payment-submit` | VoidPaymentDialog |
| `create-job-invoice-dialog`, `create-job-invoice-submit` | CreateJobInvoiceDialog (JobDetailPage) |

Aria labels the tests rely on: `Add line item`, `Add the first line item`, `Quantity for {name}`,
`Unit price for {name}`, `Taxable for {name}`, `Discount type for {name}`, `Discount value for {name}`,
`Remove {name}`, `Tip amount`, `Invoice-level discount`, `Tax jurisdiction`, `Payment method`,
`Reason category`, `Refund method`, `Reverse a specific payment`, `Search the price book`,
`Remove {email}`.

Spec files touching the detail page:
- `frontend/src/__tests__/invoice-money-dialogs.test.tsx` (refund / credit / void-payment)
- `frontend/src/__tests__/invoice-line-items-editor.test.tsx`
- `frontend/src/__tests__/invoices-jobless-render.test.tsx`
- `frontend/src/__tests__/send-invoice-dialog.test.tsx`
- `frontend/e2e/specs/redesign/00-render-safety.spec.ts` (R0-02, R0-03: `invoice-detail` visibility,
  deposit invoice number, job-less customer name, plus screenshot baselines
  `R0-02-deposit-invoice-detail.png`, `R0-03-jobless-invoice-customer.png`)
- `frontend/e2e/specs/redesign/08-standalone-invoice.spec.ts` (T3/T5d/T6/T7 land on the detail page
  and assert the invoice number and a `Draft` badge)
- `frontend/e2e/specs/invoice-workflow.spec.ts` - **API-only**, no page interaction at all. It drives
  `ApiClient` directly. Useful as a behavioural contract for the endpoints, not as a UI selector
  source.
- Other invoice-touching e2e specs (API tier, listed for completeness):
  `workflow/05-deposit-non-stripe`, `06-deposit-stripe`, `07-deposit-management`,
  `13-e2e-standard-flows`, `14-e2e-deposit-flows`, `16-e2e-edge-cases`, `17-guard-tests`,
  `18-read-filters-stats`, `19-statement`, `day-06-invoicing-payments`,
  `redesign-15-deposit-invoice`, `redesign/02-public`, `redesign/03-public-deposit`.

---

## 5. Complete API surface for the module

| Method | Path | Route gate | Used by |
|---|---|---|---|
| GET | `/api/invoices` | `read Invoice` | list |
| GET | `/api/invoices/export` | `read Invoice` + `expensiveLimiter` | list export-all |
| POST | `/api/invoices` | `create Invoice` (+ ADMIN/DISPATCHER role check for the standalone anchor) | `/invoices/new`, `CreateJobInvoiceDialog`, JobDetailPage one-click |
| GET | `/api/invoices/:id` | `read Invoice` + `canAccessRow` | detail |
| PATCH | `/api/invoices/:id` | `update Invoice`, schema `{ due_date?: ISO }` | **not used by any page in this module** |
| DELETE | `/api/invoices/:id` | `delete Invoice`, DRAFT only | detail overflow |
| POST | `/api/invoices/:id/send` | `send Invoice` | SendInvoiceDialog |
| POST | `/api/invoices/:id/resend` | `send Invoice` | SendInvoiceDialog `isResend` |
| POST | `/api/invoices/:id/void` | `void Invoice` | VoidInvoiceDialog |
| POST | `/api/invoices/:id/refund` | `refund Invoice` | RefundInvoiceDialog |
| POST | `/api/invoices/:id/credit` | `credit Invoice` | CreditInvoiceDialog |
| POST | `/api/invoices/:id/void-payment` | `void_payment Invoice` | VoidPaymentDialog |
| POST | `/api/invoices/:id/payments` | `record_payment Invoice` | RecordPaymentDialog |
| POST | `/api/invoices/:id/line-items` | `manage_lines Invoice` | AddLineDialog |
| PATCH | `/api/invoices/:id/line-items/:lineId` | `update Invoice` | LineItemRow |
| DELETE | `/api/invoices/:id/line-items/:lineId` | `manage_lines Invoice` | LineItemRow trash |
| PATCH | `/api/invoices/:id/billing` | `update Invoice` | TotalsFooter tip / discount / tax |
| GET | `/api/invoices/:id/notes` | `read Invoice` | detail |
| POST | `/api/invoices/:id/notes` | `update Invoice` | detail |
| GET | `/api/state-tax-rates` | - | `/invoices/new`, line-items editor |
| GET | `/api/customers/:id` | - | `/invoices/new` (tax_exempt, open-existing) |
| POST | `/api/customers[?override=true]` | - | `/invoices/new` |
| GET | `/api/price-book/items/search` | - | AddLineDialog, shared LineItemsEditor |
| GET | `/api/price-book/categories` | - | shared LineItemsEditor |
| POST | `/api/price-book/items` | `create PriceBook` | AddLineDialog "also save" |
| GET/PUT | `/api/table-views/invoices` | - | DataTable saved view |
| GET | `/api/invoices/:id/public` | public, `unscopedRequest` + `publicReadLimiter` | `/p/invoices/:id` (module 13) |
| POST | `/api/invoices/:id/public/checkout` | public, `publicActionLimiter` | `/p/invoices/:id` Stripe checkout |
| POST | `/api/invoices/:id/tags`, DELETE `/api/invoices/:id/tags/:tagId` | `update Invoice` | **no UI in this module** |

Cache-invalidation matrix (every write in the module):

| Write | Invalidates |
|---|---|
| line add / update / delete / billing | `['invoice', id]`, `['invoices']` |
| refund / credit / void-payment | `['invoice', id]`, `['invoices']` |
| send / resend / record payment / void invoice | `['invoice', id]`, `['invoices']` (via the page's `invalidateInvoice`) |
| delete invoice | `['invoices']` only, then navigate away |
| add note | none; imperative `refetchNotes()` |
| create standalone invoice | `['invoices']`, then navigate to detail |
| create customer (form) | `['customers']` |
| save table view | `['table-views','invoices']` |

**No optimistic updates exist anywhere in this module.** Every mutation waits for the server and
then invalidates.

---

## 6. Payment / Stripe integration points

- **Deposit (upstream, not on these pages).** The deposit is a sibling `kind='DEPOSIT'` Invoice
  created when its estimate is sent. Paying it (Stripe checkout on the public estimate page, or a
  manual "mark deposit received") produces a real `Payment` on THAT invoice.
- **Deposit credit (on this module's invoice).** At STANDARD invoice creation the ledger is drawn
  down and a synthetic `Payment` with `reference_number = 'DEPOSIT-CREDIT'` is written on the new
  invoice. The UI must exclude it from `customerPayments`, from `paymentsTotal`, and from the ledger,
  and instead surface it as the `Deposit Credit` line in the waterfall and the `Less deposit credit`
  line in the Line Items tail. `DEPOSIT_CREDIT_REFERENCE` is exported from
  `backend/src/controllers/invoice.controller.ts:33`.
- **Customer-facing Stripe payment.** Only through the PUBLIC page: `POST /api/invoices/:id/public/checkout`
  creates the session, and a Stripe webhook marks the invoice PAID. The authed detail page has no
  Stripe call; it shows the result. `stripe_payment_intent_id` and `stripe_dispute_id` are selected
  but the detail page renders neither.
- **Manual payment.** `RecordPaymentDialog` -> `POST /:id/payments`. Method `CARD` here means
  "Credit Card (Stripe)" as a label only; no Stripe API call is made from this path.
- **Refunds.** `POST /:id/refund` processes card refunds through Stripe automatically and records
  manual-method give-backs; the dialog states this. Client cap is `netPaid`; the backend re-enforces.
- **Void payment.** Manual methods only (`CASH`, `CHECK`, `BANK_TRANSFER`), non-voided rows only.
  Voiding re-opens the invoice balance. `CHARGEBACK` is not offered in the UI - it is reserved for
  `systemVoidPaymentForChargeback` (controller 2412).

### Integrity rules that the UI must respect

| Rule | Where enforced | UI reflection |
|---|---|---|
| An invoice needs >= 1 line item to be created from a job | `create` 400 `Cannot create invoice with no line items` (both the estimate path and the authored path) | `CreateJobInvoiceDialog` / `/invoices/new` client validation `Add at least one line item` |
| A service-plan visit job cannot be invoiced | `create` 400 when `job.source_plan_id` is set: `This job is a service plan visit and cannot be invoiced - the plan was already paid upfront.` | JobDetailPage hides the action |
| One active invoice per job | `create` 409 `This job already has an invoice ({number}). Void it first or edit the existing one.` VOIDED invoices do not block | surfaced as a server error string |
| An invoice-bearing job cannot be deleted | job controller (outside this module) | - |
| Only DRAFT invoices can be deleted | `remove` 400 `Only DRAFT invoices can be deleted` | `canDelete = isDraft && canManage` |
| Only DRAFT invoices can be sent | `send` 400 `Only DRAFT invoices can be sent` | `canSend = isDraft && canManage` |
| Payments only on DRAFT / SENT / PARTIAL | `recordPayment` 400 | `canRecordPayment = (isPayable || isDraft) && can(...)` |
| An invoice is locked once settled | `isInvoiceEditable` in `backend/src/lib/invoice-editable.ts`, mirrored in `frontend/src/lib/invoiceEditable.ts` (`LOCKED = PAID, VOIDED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED`) | editor sets `canEditRows`/`canEditBilling`/`canManageRows`/`canAdd` false |
| A partial payment does NOT lock the invoice | same | PARTIAL stays editable |

---

## 7. Status vocabulary

`InvoiceStatus`: `DRAFT`, `SENT`, `PARTIAL`, `PAID`, `VOIDED`, `REFUNDED`, `PARTIALLY_REFUNDED`,
plus `DISPUTED` (in the lock list and the badge map, but NOT in the filter registry's option list).

`OVERDUE` is a **derived pseudo-status**, never persisted. Both the list and the detail page compute
it and pass it to `StatusBadge`, whose map (`components/ui/status-badge.tsx`) is:

| status | label | tone |
|---|---|---|
| DRAFT | Draft | gray |
| SENT | Sent | amber |
| PARTIAL | Partial | amber |
| PAID | Paid | green |
| OVERDUE | Overdue | danger |
| PARTIALLY_REFUNDED | Partially Refunded | amber |
| DISPUTED | Disputed | danger |
| VOIDED | Voided | gray |
| REFUNDED | Refunded | danger |

`InvoiceKind` badges on the detail hero: `DEPOSIT` -> outline badge `Deposit`
(`bg-blue-50 text-blue-700 border-blue-200`), `PLAN` -> `Service Plan`
(`bg-sage-50 text-sage-700 border-sage-200`). `STANDARD` renders no badge.

---

## 8. Formatting helpers (must be reused verbatim)

| Helper | File | Behaviour |
|---|---|---|
| `formatCurrency(n)` | `lib/utils.ts:32` | `Intl.NumberFormat('en-US', { style:'currency', currency: getOrgCurrency() })` - locale fixed, currency org-derived (#126) |
| `formatCurrencyWhole(n)` | `lib/utils.ts:43` | same, `maximumFractionDigits: 0` (not used in this module) |
| `extractApiError(err, fallback)` | `lib/utils.ts:52` | prefers `response.data.details[]` joined as `field: message`, then `response.data.error`, then `err.message`, then the fallback |
| `customerDisplayName(c, fallback)` | `lib/customer-name.ts:7` | `first last` when both; else `last`; else `first`; else `company_name`; else the fallback. Both invoice pages pass `''` (list) or the default `'Customer'` (detail) |
| `formatPhone` | `lib/utils.ts` | detail hero phone display |
| `formatPhoneInput` | `lib/utils.ts` | standalone form, on `selectCustomer` |
| `cn` | `lib/utils.ts` | class merge |
| `toCSV` / `downloadCSV` | `lib/inventory/csv.ts` | list export |

---

## 9. Rebuild checklist (behaviour that is easy to lose)

1. Job cell in the list uses `window.location.href`, not `navigate` - a FULL page reload. Row click
   uses `navigate`. Both must stay distinct (the cell also calls `stopPropagation`).
2. KPI clicks clear every other facet AND the search box. Do not "add" a filter.
3. `listParams` must keep its full key set including the `undefined` placeholders.
4. `SendInvoiceDialog` is mounted twice; the resend instance is a separate component instance with
   its own state.
5. `RefundInvoiceDialog`, `CreditInvoiceDialog` and `VoidPaymentDialog` self-invalidate; they take no
   `onSuccess` prop. Do not add one.
6. `VoidInvoiceDialog`'s success navigates away to `/invoices`.
7. Deposit-credit payments are identified only by the literal string `DEPOSIT-CREDIT` in
   `reference_number`. Three places filter on it.
8. The Line Items tab money tail is rendered by the PAGE, below the shared editor's footer. Two
   separate `Balance Due` figures exist on the detail page (waterfall card and line-items tail) and
   they must agree.
9. Tip is post-tax and never taxed. Tax rate is a fraction, always render as `rate * 100`.
10. `canEditBilling` stays true at zero lines, so tip/discount/tax remain editable on an invoice that
    owns no lines. The footer renders in that case only when tip or discount is > 0.
11. The standalone form must mount exactly one copy of the customer block (media query in JS, not CSS).
12. `noValidate` on the standalone form is required for the inline quantity error to show.
13. Editing any contact field on the standalone form deselects the customer and reverts the button to
    `Continue`.
14. `dismissDuplicate` must call `createCustomer.reset()`.
15. Carry every `data-testid` and every `aria-label` listed in sections 2.10, 3.10 and 4.14.

---

## 10. Cross-module impact summary

| Change here | Breaks |
|---|---|
| `LineItemsTable` / `LineItemRow` / `TotalsFooter` / `AddLineDialog` props or markup | Jobs -> Items tab, `PublicInvoicePage` (module 13) |
| `components/shared/LineItemsEditor` | `EstimateFormPage`, `CreateJobInvoiceDialog`, `StandaloneInvoiceFormPage` |
| `PickOrCreateCustomer` / `PickOrAccreteLocation` | `LeadFormPage`, `ServicePlansPage`, `CustomerPickerWithCreate` |
| `CreateJobInvoiceDialog` | `JobDetailPage` (module 5) |
| `invoicesRegistry` | only this module |
| `lib/api/invoices.ts` | detail, editor, AddLineDialog, and the shared `LineItemsTable` type imports |
| `StatusBadge` map | app-wide |
| `DataTable` / `KpiStrip` / `FilterBar` | every list page |

Per the migration plan, a v2 page must IMPORT these shared modules, never fork them. If a v2
presentation swap cannot be done without changing one of them, that is the escalation signal
described in plan section 3.

---

## 11. Backend reference index (for the builder)

| Concern | File:lines |
|---|---|
| Routes + gates | `backend/src/routes/invoice.routes.ts:1-54` |
| Zod schemas (create/void/edit/payment/note/send) | `invoice.controller.ts:42-125` |
| `roundMoney`, `computeRefundTax`, `calculateDueDate`, `lookupStateTaxRate`, `computeOwnedLineTotals`, `buildOwnedLineCreates` | `invoice.controller.ts:129-209` |
| `invoiceDetailSelect` | `invoice.controller.ts:213+` |
| `create` (job anchor + deposit credit) | `invoice.controller.ts:442-684` |
| `createStandaloneInvoice` | `invoice.controller.ts:692+` |
| `buildInvoiceListWhere` (+ overdue composition, search OR merge) | `invoice.controller.ts:807-852` |
| `list` (+ stats) | `invoice.controller.ts:854-935` |
| `exportAll` | `invoice.controller.ts:944-968` |
| `remove` / `send` / `resend` / `voidInvoice` | `invoice.controller.ts:1030-1331` |
| `recordPayment` (+ deposit-invoice side effects) | `invoice.controller.ts:1356-1590` |
| `refundInvoice` / `credit` / `voidPayment` schemas + handlers | `invoice.controller.ts:1814-2411` |
| Line/billing handlers + `recomputeAndPersist` | `invoice-lines.controller.ts:33-406` |
| Pure totals math | `backend/src/lib/invoice-totals.ts` |
| Edit lock | `backend/src/lib/invoice-editable.ts` (frontend mirror `frontend/src/lib/invoiceEditable.ts`) |
| Permission catalog / role defaults / per-user capabilities | `backend/src/lib/permissions/{catalog,defaultGrants,userCapabilities}.ts` |

---

## 12. Open questions

**OQ-1 - `/invoices/new` denial rendering.** `ProtectedRoute` receives `fallback` (App.tsx:137), and
its implementation renders `<NotAuthorizedPage />` for a disallowed role
(`ProtectedRoute.tsx:29`). But `frontend/e2e/specs/redesign/08-standalone-invoice.spec.ts:213-215`
asserts a SALES user is redirected to `/` and cites "ProtectedRoute.tsx:23-24". Either the spec is
stale or `fallback` was added after it was written. Confirm the live behaviour before the v2 build
copies either one.

**OQ-2 - the Edit menu item.** `InvoiceDetailPage.tsx:681` navigates to `/invoices/{id}/edit`, a
route that does not exist in `App.tsx`; the catch-all sends the user to `/`. Should v2 reproduce the
dead link, hide the item, or is an edit page planned?

**OQ-3 - technician "New Invoice" dead end.** A technician with the per-user `create Invoice` grant
sees the list-page button (CASL says yes) but is blocked at the route and again by the controller.
Reproduce as-is, or gate the button on role rather than ability?

**OQ-4 - discounts dropped in the standalone form.** The shared `LineItemsEditor` collects
`discount_type`, `discount_value` and `unit_cost`, but `buildPayload` omits all three and the backend
`invoiceLineItemInput` schema does not accept them. Values typed there are silently lost, and the
preview totals ignore them. Intentional (server-side "no discounts on owned-line creation") or a bug?

**OQ-5 - overpayment.** `RecordPaymentDialog` presents `max={amountDue}` and the helper text
`Max: {amountDue}`, but the backend comment at `invoice.controller.ts:1392-1393` says overpayment is
explicitly ALLOWED (the excess is flagged and refunded by default), while
`frontend/e2e/specs/invoice-workflow.spec.ts:280-293` asserts a 400 for `amountDue + 0.01`. Also at
line 267-278 the same spec asserts a 400 when paying a DRAFT invoice, but the current controller
allows DRAFT. Both spec assertions look stale relative to the controller. Determine which is
authoritative before v2 changes any client-side clamping.

**OQ-6 - `paidAt` timezone.** `RecordPaymentDialog` seeds the `datetime-local` input from
`new Date().toISOString().slice(0,16)`, which is UTC, while the control is interpreted as local time
and is re-parsed with `new Date(paidAt).toISOString()`. For a non-UTC user the default value is
shifted. Existing behaviour; flagged so v2 does not "fix" it silently.

**OQ-7 - `collected_this_month`.** The list endpoint computes and returns this stat but no UI renders
it. Should the v2 KPI strip surface it, or keep parity?

**OQ-8 - empty-state wording.** `DataTable` shows the same `No results found.` whether the org has no
invoices at all or the filters exclude everything. The migration brief asks for the distinction; it
does not exist today. Reproducing parity means keeping one string; improving it means changing a
shared component used by every list page.

**OQ-9 - `PATCH /api/invoices/:id`.** The `editInvoiceSchema` (`{ due_date? }`) endpoint exists and is
`update`-gated, but no page in this module calls it. There is no due-date editing UI anywhere on the
invoice pages.
