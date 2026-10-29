# Customers - components with no kit equivalent

Module 3. Branch `refactor/ui-kit-03-customers`. Built under
`frontend/src/pages/v2/customers/`, registered by
`frontend/src/pages/v2/routes/customers.{paths.ts,routes.tsx}`.

Legacy pages rebuilt: `CustomersPage.tsx`, `CustomerDetailPage.tsx`,
`CustomerFormPage.tsx`, `StatementPage.tsx`.
Legacy components rebuilt: `components/customers/DuplicateCustomerDialog.tsx`,
`components/customers/LocationFormDialog.tsx`.

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `crm/address-autocomplete` | CustomerFormPage (x2: service + billing), LocationFormDialog | Google Places v1 autocomplete: 3-char minimum, 300 ms debounce, parses a place into line1/line2/city/state/zip, needs `VITE_GOOGLE_MAPS_API_KEY` | `form/combobox` | Combobox filters a client-side option list. This one fetches a remote suggestion API and parses an address payload; the behaviour is the component, not the popover | KEEP |
| `crm/service-location-map` | CustomerFormPage | Static Maps API `<img>` preview of the typed address, with a failure fallback | none | The kit ships no map. Chart/map surfaces are an explicit no-touch boundary | KEEP |
| `data/TagChips` (`TagChips`) | customersColumns Tags cell | Renders up to N org tags; each tag's colour is a runtime hex on the Tag row, applied as an inline style | `ui/badge` | Badge's colours are a fixed variant vocabulary. A tag colour is user data, so it cannot become a variant without dropping the feature | KEEP |
| `leads/TagInput` | CustomerDetailPage hero | Inline tag add/remove against `/api/tags` with its own popover and mutations | `crm/tagInput` | The kit component is presentational only - no query, no mutation, no org vocabulary. Swapping it would fork the tag write path | BUILD (kit tagInput needs a data-bound wrapper before any page can use it) |
| `customers/BulkTagPopover` | CustomersPage bulk bar | Bulk-applies tags to the selected customer ids; owns its own `useTags` query and mutation | none | Same reason as TagInput - it is a data component wearing a popover | KEEP |
| `communication/CustomerCommunicationsTab` | CustomerDetailPage Comms tab | The whole cross-channel roll-up: query, skeleton, error, empty, per-channel row rendering | none | Owned by the Communication module's own migration; rebuilding it here would fork it | KEEP |
| `communication/inbox/ComposeWindow` | CustomerDetailPage | The floating email composer (draft state, send, discard) | none | Same - Communication module surface | KEEP |
| `tasks/JobLeadTasksTab` | CustomerDetailPage Tasks tab | Grouped task board with its own create modal, detail drawer and AI generate flow | none | Owned by the Tasks module's own migration | KEEP |
| `pages/service-plans/ServicePlansPage` (`PlanBuilderDialog`) | CustomerDetailPage | Service-plan builder, opened with this customer preset | none | Owned by the service-plans branch. Explicitly out of bounds for this branch - imported and reused as-is | KEEP |
| `ui/heading` (`Heading`) | all four pages | Semantic heading with a size scale | `layout/pageHeader` (title only) | The kit has no standalone Heading, and the design-system raw-tag ratchet is at its floor for `h1`-`h6`, so a v2 page may not add one. Section headings are `role="heading" aria-level={n}` on a `<p>`, the same device the leads module uses | BUILD |
| `ui/tabs` / `patterns/TabStrip` | CustomerDetailPage | Radix tabs | none | The kit ships no Tabs primitive. Reused the leads module's `pages/v2/leads/components/tabs.tsx`, which builds the ARIA contract from kit primitives | BUILD |
| `patterns/FormField` | CustomerFormPage, LocationFormDialog | Label + control + error in one call | `form/formField` | The kit's version requires a `FormProvider` and a `Controller` per field; this form registers most fields directly and would have to be rewritten around RHF context to use it. A local 12-line `Field` assembles the same three parts from kit `Label` | BUILD (a context-free variant) |
| `ui/breadcrumb` (`BreadcrumbItem` **type**) | CustomerDetailPage, StatementPage | The `location.state.breadcrumbs` contract passed between pages | `layout/nav/breadcrumbs` | The kit's breadcrumbs are rendered; the legacy module also uses a `BreadcrumbItem[]` as a cross-page state payload. The kit components do the rendering; the legacy TYPE is still imported so the state contract cannot drift | KEEP (type only) |

## Replaced (the audit trail)

Every `@/components/...` import across the four legacy pages, and what stands in for it.

| Old component | Replaced by | Notes |
|---|---|---|
| `data/data-table` (`DataTable`) | `ui-kit/components/data/dataTable/dataTable` + `dataTableToolbar` | Server paging handed to the table (`page`/`pageCount`/`pageSize`/`rowCount`), so the page has exactly one paginator. Sorting stays server-side and is driven by the page's own state (see "Shape differences") |
| `data/KpiStrip` (`KpiStrip`) | `ui-kit/components/data/statCard` (`StatCard`, `StatCardGroup`) | Four clickable tiles, same values, same active predicates. The legacy `tone="primary"` on all four is dropped: it tinted every tile identically, so it carried no information |
| `data/ContactCell` | `pages/v2/leads/components/contactCell` | Reused, not re-forked. Same placeholder suppression, same `stopPropagation`, same "Copied!" for 2 s |
| `data/status-badge` (`StatusBadge`) | `pages/v2/leads/components/statusChip` | Still resolves through `design-system/status-registry`, so labels and meanings are unchanged; only the painting moves to kit Badge variants |
| `data/filter-chip` (`FilterChip`) | chips rendered by `ui-kit/components/crm/filterBar` | The three standalone flags (`open_leads`, `active_jobs`, `include_archived`) keep their own chips - see `components/appliedFilters.tsx` |
| `filters/FilterBar` | `pages/v2/leads/components/filterPopover` (`FilterPopover`) | Reused. Same `customersRegistry`, same `FilterState`, same `useFilterState` URL codec, same facet-tab names and option labels |
| `filters/AppliedChips` | `pages/v2/customers/components/appliedFilters` (`CustomerFilterBar`) | Own file rather than a reuse of the leads `LeadFilterBar`, because the standalone non-registry constraints are a customers-only concept and extending the leads file would edit another module |
| `data/TagChips` (`tagsColumn`) | local column def in `customersColumns.tsx` using `TagChips` | The column def is restated (it carried legacy `meta` keys the kit table does not read); the CHIP component is reused unchanged |
| `customers/DuplicateCustomerDialog` | `pages/v2/customers/components/duplicateCustomerDialog` | Rebuilt on the kit Dialog. The `ExistingCustomer` TYPE is imported from the legacy file, so the 409 payload contract cannot drift |
| `customers/LocationFormDialog` | `pages/v2/customers/components/locationFormDialog` | Rebuilt on the kit Dialog. Schema, endpoints, invalidation and copy character-for-character |
| `patterns/TabStrip`, `ui/tabs` | `pages/v2/leads/components/tabs` (`TabStrip`, `TabPanel`) | Reused |
| `patterns/FormField` | local `Field` in `CustomerFormPage.tsx` / `locationFormDialog.tsx` | See the gap row |
| `ui/avatar` | `ui-kit/components/ui/avatar` (`Avatar`) | The kit derives initials and a stable tint from `name`; the legacy pair `Avatar`+`AvatarFallback`+`getInitials` collapses to one component |
| `ui/badge` | `ui-kit/components/ui/badge` (`Badge`) | |
| `ui/breadcrumb` (`Breadcrumb`) | `ui-kit/components/layout/nav/breadcrumbs` | |
| `ui/button` | `ui-kit/components/ui/button` | `variant="solid" tone="business"` -> the kit's default (primary) variant |
| `ui/card` | `ui-kit/components/ui/card` | |
| `ui/checkbox` | `ui-kit/components/ui/checkbox` | Also replaces the raw `<input type="checkbox">` the legacy "Show archived" control used |
| `ui/dialog` | `ui-kit/components/ui/dialog` | |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | |
| `ui/heading` | `layout/pageHeader` title, or `role="heading"` on a `<p>` | See the gap row |
| `ui/input` | `ui-kit/components/ui/input` | Also replaces the legacy hidden `<input type="file">` for the tax-exempt certificate |
| `ui/label` | `ui-kit/components/ui/label` | |
| `ui/select` | `ui-kit/components/ui/select` | |
| `ui/separator` | `ui-kit/components/ui/separator` | |
| `ui/skeleton` | `ui-kit/components/ui/skeleton` | |
| `ui/switch` | `ui-kit/components/ui/switch` | |
| `ui/textarea` | `ui-kit/components/ui/textarea` | |
| `ui/use-toast` (`toast`) | `ui-kit/components/ui/sonner` (`toast`) | `variant: 'destructive'` -> `toast.error(...)` |
| `crm/address-autocomplete` | reused as-is | gap row |
| `crm/service-location-map` | reused as-is | gap row |
| `customers/BulkTagPopover` | reused as-is | gap row |
| `communication/CustomerCommunicationsTab` | reused as-is | gap row |
| `communication/inbox/ComposeWindow` | reused as-is | gap row |
| `leads/TagInput` | reused as-is | gap row |
| `tasks/JobLeadTasksTab` | reused as-is | gap row |
| `pages/service-plans/ServicePlansPage` (`PlanBuilderDialog`) | reused as-is | gap row |

Business logic imported, never re-declared: `customerSchema` and
`DEFAULT_CUSTOMERS_SORTING` from `@/pages/CustomerFormPage` /
`@/pages/CustomersPage`, `customersRegistry`, `useFilterState`,
`useTagFacetOptions`, `useOrganization`, `useFeature`/`useModuleAccess`,
`useAppAbility`, `purgeCustomer`, `getCustomerStatement`/`getJobStatement`,
`requestCall`, `useSendEmail`/`useConnectedGmailAddress`.

## Shape differences forced by the kit

Not gaps - decisions the kit's API made for us. Listed so a reviewer does not
read them as drift.

| What | Legacy | v2 | Why |
|---|---|---|---|
| Sorting | `DataTable` lifted `onSortingChange` | Four sortable headers drive the page's own `sorting` state | The kit DataTable owns a client sorting state with no callback out. Sorting is server-side here, so the column ids and `sortBy` values are verbatim |
| Paging | a bar above the table plus the table's own | the table footer only | The kit table takes `page`/`pageCount`/`rowCount`; two paginators on one list is the state this removes |
| Filter trigger, Show archived, Export | a `filters` slot and a `headerActions` slot on the table | all inside `DataTableToolbar` beside Columns | All four act on the table |
| Ad-source colour | `AD_SOURCE_STYLES` tinted each source its own hue (list AND detail) | one soft neutral pill | The kit's locked rule is "status = solid, qualifier = soft". The v2 leads list already made this exact call for this exact field |
| Row selection | `useScopedRowSelection` hook, controlled into the table | the kit table's internal selection, reset by `components/bulkBar.tsx` on the same scope string | The kit table owns `rowSelection` and exposes only the table instance. Remounting on scope change would also throw away column widths |
| Applied "Clear all" | always shown when any filter is active | shown when 2+ chips are active (kit FilterBar rule) | `onClearAll` is wired to the same `clearAllFilters()`; only the visibility rule is the kit's |
| Form footer | pinned to the viewport bottom | closes the card it acts on | The v2 shell scrolls as one column; a floating bar over a scrolling page had no anchor |
| Detail hero KPI grid | 10 cells | 10 cells, same values | unchanged - noted only because the behaviour map still describes the older 8-cell version |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| The Jobs tab's Invoice column renders an INVOICE status under `domain="job"` | legacy `CustomerDetailPage.tsx` JobsTab, carried over to `components/detailTabs.tsx` | Wrong domain, so the registry lookup always misses and the raw enum value is shown. Both the legacy badge and the v2 chip fall back identically, so reproducing it keeps the rendered text unchanged. Changing the domain would change what the cell displays |
| Deleting a service location has no confirmation - one click destroys it | CustomerDetailPage sidebar | Adding a confirm dialog is a behaviour change, however desirable |
| The list has no error state at all: a failed list or stats query renders as "No results found." | CustomersPage | Inventing an error branch is new behaviour |
| The list cannot distinguish "no customers exist" from "no rows match the filters" | CustomersPage empty state | Same reason. The kit EmptyState is deliberately given no "clear filters" action here |
| `returnTo` on the form (`location.state.returnTo`) appears unreachable - nothing in `frontend/src` navigates to `/customers/new` with that state | CustomerFormPage | Carried over unchanged; deleting it on the strength of a grep is not a restyle |
| `extra_emails[i].label`, `phones[i].label` and `phones[i].is_primary` are in the schema, the payload and the CSV export but have no input anywhere in the form | CustomerFormPage | Reproduced as-is. `is_primary` is always submitted `false` for additional phones |
| Cancel on the location dialog closes WITHOUT resetting the form, so a half-typed address survives a reopen | LocationFormDialog | Legacy behaviour, carried over |
| `GET /api/customers/:id/summary` is never called - the detail page uses the `summary` block `getById` already returns | backend route | Unused endpoint, not a UI concern |
| The Comms tab is not behind the `phone` entitlement on the backend (`customer.routes.ts` has no `requireFeature`), even though CLAUDE.md calls `phone` the master switch for Communication | backend | Backend gating question, raised not fixed |

## Behaviour map corrections

`md_files/specs/ui-redesign/customers-behavior-map.md` is dated 2026-07-29 and
the code has moved since. Where they disagree the code won, and the v2 pages
follow the code. The material divergences:

- **The form has no `kind` field.** There is no Person/Company pill and no
  `customer-kind-select` testid anywhere in `frontend/src` - the schema now
  requires "a first name OR a company name" via superRefine, and `kind` is
  derived server-side from `company_name`. The map's §3.4 kind pill, its
  `kind === 'COMPANY'` branch and the `customer-kind-select` row of §9.1 are
  all stale. Note `e2e/specs/redesign/00-render-safety.spec.ts` R0-05 still
  asserts that testid, so it is already failing against the LEGACY page - a
  pre-existing e2e drift, not something this branch introduced.
- **The form gained `ServiceLocationMap`** under the address block.
- **The detail page's action cluster is different.** The map describes View
  Statement / New Lead / New Job / New Service Plan / Edit / lifecycle menu.
  The code has a single "Create New" dropdown (Lead / Estimate / Job / Invoice /
  Service Plan) plus a three-dot menu with "Edit client" and "Delete client".
  Archive and Unarchive are gone from the UI entirely; "View Statement" moved
  inside the Invoices tab.
- **The detail hero has 10 KPI cells, not 8** (Open Leads, Active Leads, Open
  Tasks and Invoices were added; Deposits was removed).
- **The detail page has an Estimates query of its own** (`/api/estimates?customer_id=`),
  not derived from the leads response, and both the Leads tab and the Estimates
  count are entitlement-aware (`effectiveTab`).
- **`AD_SOURCE_STYLES` is already tokenised** in both the list and the detail
  page - the map's risk item 8 ("raw Tailwind palette classes") no longer
  applies. The v2 change is a design decision (soft neutral pill), not a
  token cleanup.
- **There is no `useTableView` / server-saved column view** on the list; column
  visibility is plain component state.
- **The list has row selection and a bulk-tag action**, and a Tags column and a
  Tags facet, none of which the map describes.
