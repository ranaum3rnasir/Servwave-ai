# Inventory - components with no kit equivalent

Module 10, branch `refactor/ui-kit-10-inventory`. Four legacy pages
(`InventoryPage`, `PriceBookPage`, `PurchaseOrdersPage`, `VendorsPage`),
45 distinct `@/components/...` imports between them, rebuilt as
`frontend/src/pages/v2/inventory/`.

## Map vs code

The behaviour map (`md_files/specs/ui-redesign/inventory-behavior-map.md`, dated
2026-07-29) and the task brief are both stale. Verified against the code:

| The map / brief says | The code says |
|---|---|
| Six routes | TEN. `/inventory/assets`, `/inventory/low-stock`, `/inventory/activity` and `/inventory/logistic-orders` all postdate the map |
| `/inventory/approvals` is an `InventoryPage` view | It is `<Navigate to="/inventory" replace />` - stock-approvals is feature-parked (P0 SS C / QA-901). `ApprovalsView`, `ApprovalDetailDialog`, `NewApprovalRequestDialog` and `ApprovalEmailDialog` are all still on disk but unreachable from any route |
| Brief lists NINE routes and omits `/inventory/vendors` | `/inventory/vendors` is a real page in `App.tsx` |
| "No route guard, no feature gate on any inventory route" | Every inventory route is inside `<RequireFeature feature="inventory">` (`App.tsx:219`) |
| Three view tabs (Items / Staging / Approvals) | Six (Items / Staging / Assets / Low stock / Activity / Logistic Orders) |
| "Every page copies query results into local `useState` and fires zero writes" | `InventoryPage` now fires eleven real mutations (upsertItem, upsertLocation, deleteItem, restoreItem, importItemsCSV, transferStock, setThresholds, upsertCategory, upsertVendor, upsertBranch, deleteCategory, setQuantity) |
| Five KPI tiles on the Items view, incl. "Needs Approval" | Four. The approvals tile went with the parking |
| `InventoryPage.tsx` is 1,805 lines | 2,046 |
| Items table has a Reserved column | It does not - SKU / Item / Category / On Hand / Available / Unit Cost / Locations |
| `useCreateStage`, `useCreateApproval`, `useDecideApproval` fire twice | Not reachable from any route any more (approvals), and `StagingView` is untouched by this branch either way |

The v2 build follows the CODE in every case.

## Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| `inventory/AddItemDialog` | component | InventoryPage, PriceBookPage | 1,026-line create+edit item form: photo upload, inline vendor/category create, starting stock rows | `ui/dialog` | The dialog shell exists; the form, its validation and its two nested create paths do not | - | KEEP |
| `inventory/TransferDialog` | component | InventoryPage | 1,205-line location-to-location and bulk-stage transfer with its own shortage handling | `ui/dialog` | same | - | KEEP |
| `inventory/RestockDialog` | component | InventoryPage | receive-into-location form with a per-source reference rule | `ui/dialog` | same | - | KEEP |
| `inventory/SetQuantityDialog` | component | InventoryPage | cycle-count form; posts one signed `adjust` movement | `ui/dialog` | same | - | KEEP |
| `inventory/SetThresholdsDialog` | component | InventoryPage | min/max reserve levels per location | `ui/dialog` | same | - | KEEP |
| `inventory/AddLocationDialog` | component | InventoryPage | location form with inline branch create and van/tech binding | `ui/dialog` | same | - | KEEP |
| `inventory/AddCategoryDialog` | component | InventoryPage, PriceBookPage | category create/rename with hero photo | `ui/dialog` | same | - | KEEP |
| `inventory/AddBrandDialog` | component | PriceBookPage | brand form incl. logo + default markup | `ui/dialog` | same | - | KEEP |
| `inventory/AddGroupDialog` | component | PriceBookPage | 784-line bundle builder (lines, overrides, flat-rate) | `ui/dialog` | same | - | KEEP |
| `inventory/AddVendorDialog` | component | VendorsPage | vendor create form | `ui/dialog` | same | - | KEEP |
| `inventory/DeleteItemDialog` | component | InventoryPage | hybrid-delete confirm | `ui/confirmDialog` | the kit dialog takes a title+description, but the copy here explains soft-delete + audit retention and the caller drives the mutation; not worth forcing | - | KEEP |
| `inventory/DeleteVendorDialog` | component | VendorsPage | delete-or-archive decision tree, reads items + POs to decide | `ui/confirmDialog` | it is a branching flow, not a confirm | - | KEEP |
| `inventory/ImportCSVDialog` | component | InventoryPage | drop-zone CSV parse, size guards, column mapping | none | no file-drop primitive in the kit | - | KEEP |
| `inventory/GeneratePODialog` | component | InventoryPage | low-stock proposal, one draft PO per vendor | none | - | - | KEEP |
| `inventory/LowStockActionDialog` | component | InventoryPage | bell-alert pop-out with Restock / Generate-PO CTAs | none | - | - | KEEP |
| `inventory/POPreviewDialog` | component | InventoryPage, PurchaseOrdersPage | printable PO document | none | no document/print primitive | - | KEEP |
| `inventory/POEmailDialog` | component | PurchaseOrdersPage | PO email composer | none | - | - | KEEP |
| `inventory/PODetailDialog` | component | PurchaseOrdersPage | PO detail + receive mode, drives the receive mutation | none | - | - | KEEP |
| `inventory/PrePODetailDialog` | component | PurchaseOrdersPage | estimate-reservation detail, convert/dismiss | none | - | - | KEEP |
| `inventory/NewPODialog` | component | PurchaseOrdersPage | 1,217-line PO builder with inline item/vendor/category create | none | - | - | KEEP |
| `inventory/VendorDetailDialog` | component | VendorsPage | vendor detail, edit, archive/reactivate, delete request | none | - | - | KEEP |
| `inventory/LocationSelector` | component | InventoryPage | location dropdown with per-location counts, add/edit gated on `canManage` | `ui/select` | Select renders values; this renders a managed list with inline create/edit affordances and permission gating | - | KEEP |
| `inventory/CategorySelector` | component | InventoryPage | same shape for categories, plus a guarded delete | `ui/select` | same | - | KEEP |
| `inventory/CategoryManagerDropdown` | component | VendorsPage | vendor-category picker with inline add + rename | `ui/select` | same | - | KEEP |
| `inventory/LocationStockHealth` | component | InventoryPage | per-location low-stock severity grid with a restock CTA per card | `data/statCard` | StatCard is one metric; this is a severity-ranked grid with its own maths | - | KEEP |
| `inventory/VendorCard` | component | VendorsPage | vendor tile carrying spend, share and MoM | `crm/recordCard` | recordCard has no metric block; the spend maths lives in the card | - | KEEP |
| `inventory/StagingView` | component | InventoryPage (`/inventory/staging`) | 970-line sub-view: stage cards, PO picker, receive-one, notify-tech | none | a whole page, not a component | - | ~~KEEP~~ **REBUILT** (slice 2) - `pages/v2/inventory/components/stagingView.tsx` |
| `inventory/assets/AssetsView` | component | InventoryPage (`/inventory/assets`) | asset register sub-view | none | same | - | ~~KEEP~~ **REBUILT** (slice 2) - `components/assetsView.tsx` + `components/assetHistoryPanel.tsx` |
| `inventory/LowStockView` | component | InventoryPage (`/inventory/low-stock`) | server-paged low-stock list | none | same | - | ~~KEEP~~ **REBUILT** (slice 2) - `components/lowStockView.tsx`; `toProposalItems` still imported from the legacy module |
| `inventory/ActionLogView` | component | InventoryPage (`/inventory/activity`) | movement ledger | none | same | - | ~~KEEP~~ **REBUILT** (slice 2) - `components/actionLogView.tsx` |
| `inventory/lo/LOList` | component | InventoryPage (`/inventory/logistic-orders`) | logistic-order list; also reused by the jobs and service-plans v2 modules | none | same, and its props are load-bearing for two other modules | Jobs, Service Plans | ~~KEEP~~ **REBUILT** (slice 2) - same `LOListProps`. ~~The LEGACY component stays the one the jobs v2 module mounts - module isolation forbids it importing this copy~~ **PROMOTED** to `pages/v2/_shared/loList.tsx`, which is the sanctioned exception; the v2 jobs detail page now mounts the rebuilt component |
| `data/dataTable` row virtualization | kit API | InventoryPage | the legacy `ResizableTable` virtualizes past 40 rows | the prop does not exist | deliberately scoped out of the kit - the kit table grows to its content and the PAGE scrolls, so there is no measurable viewport for a virtualizer | Customers, Jobs | KEEP (scoped out by decision) |
| `ui-kit` Heading primitive | kit API | all four pages | a scale/level-aware heading | none | the kit ships `PageHeader`'s own `<h1>` and nothing else, so every in-page section heading is a `<span role="heading" aria-level>` - which the raw-tag ratchet forces anyway | Leads, Estimates, Invoices, Jobs | BUILD |
| `ui-kit` Tabs primitive | kit API | InventoryPage, PriceBookPage, PurchaseOrdersPage, VendorsPage | tab strip | none | already filed by every prior module; this branch reuses `pages/v2/leads/components/tabs.tsx` rather than writing a tenth copy | Leads, Jobs, Estimates, Invoices, Customers, Tasks, Service Plans, Dashboard | BUILD |
| `ui-kit` anchor primitive | kit API | PriceBookPage (brand website) | an external link | `ui/button variant="link"` | Button renders a `<button>`; a raw `<a>` is on the component-api ratchet's floor, so the brand website opens via `window.open` instead of being a real link (loses middle-click, open-in-new-tab and the URL on hover) | - | BUILD |
| `ui-kit` image primitive | kit API | InventoryPage, PriceBookPage | product photos, brand logos, 2:1 hero banners | `ui/avatar` | Avatar covers the 34-46px chip case (used for item thumbs and brand logos). It cannot do a 2:1 banner, so the Groups/Categories hero photos ride as a CSS `background-image` on the box the card already needed | - | BUILD |
| `ui-kit` file-drop primitive | kit API | InventoryPage (CSV import) | drag-and-drop file intake | none | - | - | BUILD |

## Replaced (the audit trail)

All 45 distinct `@/components/...` imports across the four legacy pages.

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/heading` | `ui-kit/components/layout/pageHeader` (page title) + `<span role="heading" aria-level>` (section headings) | the kit ships no Heading; the raw-tag ratchet counts `<h1>`-`<h6>` outside the primitives, so section headings carry the ARIA role instead of the element |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | `variant="card"` has no counterpart; the kit state is not boxed |
| `ui/button` | `ui-kit/components/ui/button` | every `variant`/`tone`/`size` triple remapped to the kit's `variant`/`size` pair |
| `patterns/Toolbar` | `ui-kit/components/data/dataTable/dataTableToolbar` where a DataTable owns the row (Stock, Price Book Items); a plain flex row with `ui-kit/components/form/searchInput` where the tab body is cards (Vendors, POs, Bundles) |  |
| `patterns/TabStrip` | `pages/v2/leads/components/tabs` (`TabStrip` + `TabPanel`) | reused rather than re-authored, per the brief |
| `data/ResizableTable` | `ui-kit/components/data/dataTable/dataTable` | column widths carried over as `size`; `grow: 0` became `meta.fixed`; `enableColumnResizing` restores the drag grip |
| `data/KpiStrip` (`KpiTile`) | `ui-kit/components/data/statCard` | `tone`/`emphasize` dropped (StatCard carries no tile colour by design); `active` + `onClick` are one-to-one |
| `data/status-badge` (`StatusBadge`) | `pages/v2/leads/components/statusChip` | imported, not copied - it already reads `design-system/status-registry`, which is the shared label/intent source, and it is generic over `StatusDomain` so `purchaseOrder` and `estimateReservation` work unchanged |
| `form/SelectField` | `ui-kit/components/ui/select` | the `aria-label` on each trigger is preserved verbatim (`All vendors`, `All trades`, `Brand`, `Category`, `Visibility`, `Bundle format`) |
| `ui/switch` | `ui-kit/components/ui/switch` | `aria-label="Show archived items"` preserved |
| `ui/tabs` (`TabsContent`) | `pages/v2/leads/components/tabs` (`TabPanel`) |  |
| `ui/use-toast` (`toast`) | `ui-kit/components/ui/sonner` (`toast`) | destructive toasts become `toast.error`; the bespoke fixed-position toast divs on `InventoryPage`, `PurchaseOrdersPage` and `VendorsPage` all collapse into it, so the 3,500 ms / 2,500 ms / 4,500 ms hand-rolled timers are gone |
| `inventory/FiltersPopover` (`FiltersPopover`) | `pages/v2/inventory/components/filterPopover` (`InventoryFilterPopover`) | the `Filters` type, `emptyFilters` and `activeFilterCount` are IMPORTED from the legacy module, not re-declared |
| `inventory/FiltersPopover` (`ActiveFilterChips`) | `pages/v2/inventory/components/filterPopover` (`InventoryFilterChips`) | same four dimensions, same `Remove {label}` accessible names |
| `inventory/useInventoryFilters` | unchanged - imported | the filter chain and the stats memo are logic; forking them was not on the table |
| `inventory/AddItemDialog` | unchanged - imported | |
| `inventory/DeleteItemDialog` | unchanged - imported | |
| `inventory/TransferDialog` | unchanged - imported | `onBulkStageTransfer` is still deliberately not passed |
| `inventory/RestockDialog` | unchanged - imported | |
| `inventory/SetQuantityDialog` | unchanged - imported | |
| `inventory/SetThresholdsDialog` | unchanged - imported | |
| `inventory/AddLocationDialog` | unchanged - imported | |
| `inventory/AddCategoryDialog` | unchanged - imported | |
| `inventory/AddBrandDialog` | unchanged - imported | |
| `inventory/AddGroupDialog` | unchanged - imported | |
| `inventory/AddVendorDialog` | unchanged - imported | |
| `inventory/ImportCSVDialog` | unchanged - imported | |
| `inventory/GeneratePODialog` | unchanged - imported | |
| `inventory/LowStockActionDialog` | unchanged - imported | |
| `inventory/POPreviewDialog` | unchanged - imported | |
| `inventory/POEmailDialog` | unchanged - imported | |
| `inventory/PODetailDialog` | unchanged - imported | |
| `inventory/PrePODetailDialog` | unchanged - imported | |
| `inventory/NewPODialog` | unchanged - imported | |
| `inventory/VendorDetailDialog` | unchanged - imported | |
| `inventory/DeleteVendorDialog` | unchanged - imported | |
| `inventory/CategoryManagerDropdown` | unchanged - imported | |
| `inventory/LocationSelector` | unchanged - imported | |
| `inventory/CategorySelector` | unchanged - imported | |
| `inventory/LocationStockHealth` | unchanged - imported | |
| `inventory/VendorCard` | unchanged - imported | |
| `inventory/StagingView` | `pages/v2/inventory/components/stagingView.tsx` | slice 2 - see the sub-view table below |
| `inventory/assets/AssetsView` | `pages/v2/inventory/components/assetsView.tsx` | slice 2 |
| `inventory/LowStockView` | `pages/v2/inventory/components/lowStockView.tsx` | slice 2; `toProposalItems` still imported from the legacy module |
| `inventory/ActionLogView` | `pages/v2/inventory/components/actionLogView.tsx` | slice 2 |
| `inventory/lo/LOList` | `pages/v2/_shared/loList.tsx` | slice 2; promoted out of the module on `refactor/ui-kit-21-inventory-tests` so the v2 jobs page can mount it too. The legacy component is untouched and is still what the LEGACY pages render |

New files with no legacy counterpart: `pages/v2/inventory/components/itemThumb.tsx`
(kit Avatar in place of the legacy `ItemThumb` local component),
`components/itemDetailPanel.tsx` (the legacy `DetailPanel` local component),
`itemsColumns.tsx`, `priceBookColumns.tsx`, `poColumns.tsx`,
`vendorSpendColumns.tsx`.

## Shape differences forced by the kit

| What | Where |
|---|---|
| Filter popover + applied chips re-authored per module (the parallel-branch rule forbids a shared location) | `pages/v2/inventory/components/filterPopover.tsx`, alongside the existing `pages/v2/{leads,jobs,estimates,invoices}/components/filterPopover.tsx`. Unlike those four, this one is NOT built on `lib/filters` - inventory's `Filters` type is its own and `useInventoryFilters` consumes it directly |
| Tab strip imported from the leads module rather than copied | `pages/v2/inventory/{InventoryPage,PriceBookPage,PurchaseOrdersPage,VendorsPage}.tsx` all import `../leads/components/tabs` |
| Status chip imported from the leads module rather than copied | `pages/v2/inventory/poColumns.tsx` imports `../leads/components/statusChip` |
| Section headings written as `<span role="heading" aria-level={n}>` | every new file with a section heading; forced by the raw-tag ratchet's `<h1>`-`<h6>` floor |

## Behaviour not reproduced

| What the legacy page did | What v2 does instead | Why it could not be carried over |
|---|---|---|
| The Stock table rendered every filtered row in one scrolling table (virtualized past 40 rows by `ResizableTable`) | The kit DataTable pages client-side at 25, with its own footer | The kit table has no virtualizer and always mounts `getPaginationRowModel`. Rendering an unpaged catalog would mount every row |
| Header checkbox and per-row checkboxes on the Stock table | Dropped | They were decorative - no `checked`, no `onChange`, no bulk bar anywhere on the page. Carrying them over would have wired the kit footer's "n of m selected" readout to a selection nothing can act on. Same call the leads module made |
| KPI tiles carried a colour tone each (`primary`/`warning`/`danger`/`success`/`emerald`/`sky`/`rose`/`amber`) and an icon | Kit StatCards, no tone, no icon | StatCard ships no icon slot by design, and the kit's rule is that a KPI carries colour only when the colour means something. Recorded rather than forced back with className overrides, which the component-api ratchet forbids |
| Tile sub-copy was a full caption line under the value ("filtered, click to clear", "of 4 total, click to show only active") | Shortened into StatCard's `delta` chip | `delta` is a short chip beside the value, not a caption line; the long hint strings do not fit |
| Breadcrumb trail `Operations > Inventory > Vendors` / `> Purchase Orders` | `Home > Operations > Vendors` / `> Purchase Orders` | `PageBreadcrumbs` derives the middle crumb from the nav registry, and `inv-vendors` / `inv-pos` are CHILD entries that `getDestination` cannot resolve (`BY_KEY` is built from top-level rows only). Adding them would mean editing `nav-registry.ts` or `navSections.ts`, both shared files. `/inventory/price-book` is unaffected - `pricebook` is a top-level key with `home: 'Inventory'`, so it still reads `Home > Inventory > Price Book` |
| Toasts were bespoke fixed-position divs with hand-rolled 2.5-4.5 s timers, one per page | One kit sonner toast | The kit toaster is already mounted app-wide (`App.tsx`) and every other v2 module reports through it. Dismissal timing is now the toaster's, not the page's |
| `PurchaseOrdersPage` "Clear KPI filter ×" chip | A kit ghost Button with an `X` icon | the literal `×` glyph in the label is gone; the icon carries it |
| `PriceBookPage` visibility dropdown options read `🌐 Catalog only` / `🔒 Internal only` | `Catalog only` / `Internal only` | the emoji were decoration on a Select option; the kit Select renders text |
| The Stock detail panel was a `w-96` aside pinned inside a full-height flex row, with `animate-panel-in` | Kit `MasterDetail`'s detail pane (24rem), with its own narrow-viewport stack + "Back to items" control | the v2 shell page-scrolls rather than owning a fixed-height flex column; the entry animation has no kit counterpart |
| `PriceBookPage` Groups/Categories hero photos were `<img>` inside an `aspect-[2/1]` box | The same box with the photo as a CSS `background-image` | a raw `<img>` outside the primitives is at the component-api ratchet's floor and the kit's only image primitive is a 46px Avatar |
| `PriceBookPage` brand "Website" was an `<a target="_blank">` | A kit link-styled Button calling `window.open(safeHref(url), '_blank', 'noopener,noreferrer')` | raw `<a>` is at the ratchet's floor. Loses middle-click, open-in-new-tab and the URL on hover |
| Per-user saved column layouts | Not wired | No legacy inventory list passed `tableKey` to `ResizableTable` (checked all six call sites), so there is no stored layout to carry into `savedView`. Left unwired rather than inventing new keys |
| The five sub-view tabs (Staging, Assets, Low stock, Activity, Logistic Orders) shared the Stock page's chrome | ~~They render the LEGACY sub-view components verbatim~~ **Closed by slice 2** - all five are rebuilt under `pages/v2/inventory/components/`. See "Slice 2" below | - |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| The Items "Available" column is not availability - the legacy cell computes `availableCell = onHandCell`, so Available and On Hand are always identical, and the Reserved column that would have made the difference visible was already removed | `pages/inventory/InventoryPage.tsx:1090`, reproduced at `pages/v2/inventory/itemsColumns.tsx` | fixing it means deciding what "available" means against reservations - a data question, not a restyle |
| The kebab's "Create PO" item is inert - it only closes the menu | `pages/inventory/InventoryPage.tsx:1238`, reproduced | wiring it is a feature |
| Four stock-approval components (`ApprovalsView`, `ApprovalDetailDialog`, `NewApprovalRequestDialog`, `ApprovalEmailDialog`, ~2,300 lines) and `EstimateComparisonDialog`, `ScanDialog`, `CreateStageDialog`'s estimate path are unreachable - no route or page mounts them | `components/inventory/` | dead code removal is a separate decision from a presentation swap |
| `PriceBookPage` toggles item visibility in local state ONLY - no mutation fires, so the toggle is lost on the next refetch | `pages/inventory/PriceBookPage.tsx:358`, reproduced | it needs a write path that does not exist |
| `PriceBookPage` and `PurchaseOrdersPage` have no permission check at all - every create/edit/delete/receive affordance renders for any authenticated user who can reach the route | both pages | changing who can do what is a behaviour change |
| Three delete guards use native `alert()`/`confirm()` (brand delete, bundle delete, category delete on both the Stock and Price Book pages) | `PriceBookPage.tsx`, `InventoryPage.tsx` | the kit ships `confirmDialog`; swapping them changes the interaction model and the e2e surface at the same time as the restyle |
| `PurchaseOrdersPage`'s History tab fakes `receivedAt` as `expectedDate` and stubs the Variance / three-way-match column | `pages/inventory/PurchaseOrdersPage.tsx:1238,1268` | the model has no `receivedAt` yet |
| `TODAY` is a module-level `new Date()` on `PurchaseOrdersPage`, so the Late / Arriving-this-week KPIs freeze at the moment the chunk loads | `pages/inventory/PurchaseOrdersPage.tsx:97`, reproduced | it is a real bug but changing it changes what the tiles count |
| `inventory-stock-page-writes.test.tsx` is flaky - the "vendor/category created inline" cases fail intermittently under load, and which of the two fails varies between runs | `src/__tests__/inventory-stock-page-writes.test.tsx` | pre-existing on the base commit; see the test section of the branch report |

---

# Slice 2 - the five sub-view tabs

Branch `refactor/ui-kit-18-inventory-views`, off the integration tip
`refactor/ui-kit-02-leads`. Closes the one row this module's first slice left
open: five of the six v2 Inventory tabs rendered the LEGACY sub-view component
verbatim below the kit tab strip, so they mixed kit chrome above it with legacy
chrome below.

All five are rebuilt. The LEGACY components are untouched and still live - they
are what the legacy `/inventory/*` routes render, and `lo/LOList` is also what
the jobs and service-plans v2 modules mount (module isolation forbids them
importing the inventory copy).

No route was added: `inventory.routes.tsx` already mounts all six tab paths on
`InventoryPage`, so the change is five import swaps inside that page.

| Tab | Legacy source | New v2 file | Lines (legacy) |
|---|---|---|---|
| `/inventory/logistic-orders` | `components/inventory/lo/LOList.tsx` | `_shared/loList.tsx` | 244 |
| `/inventory/low-stock` | `components/inventory/LowStockView.tsx` | `components/lowStockView.tsx` | 248 |
| `/inventory/activity` | `components/inventory/ActionLogView.tsx` | `components/actionLogView.tsx` | 420 |
| `/inventory/assets` | `components/inventory/assets/AssetsView.tsx` (+ `AssetHistoryDrawer.tsx`) | `components/assetsView.tsx` + `components/assetHistoryPanel.tsx` | 463 + 239 |
| `/inventory/staging` | `components/inventory/StagingView.tsx` | `components/stagingView.tsx` | 970 |

## Replaced, per view

| Old | Replaced by | Notes |
|---|---|---|
| hand-rolled header strips (all five) | `ui-kit/components/layout/pageHeader` | Staging also takes `PageBreadcrumbs navKey="inventory" label="Staging"` in place of its static `Operations > Inventory > Staging` text |
| hand-rolled `<table>` (all five) | `ui-kit/components/data/dataTable/dataTable` | Low stock and Activity use the table's SERVER-PAGING mode (`page` / `pageCount` / `onPageChange` / `rowCount`), which retires their separate prev/next control rows. Both keep the `Previous page` / `Next page` accessible names and the `Page n of m` readout, which the kit footer already renders |
| `ui/empty-state` (all five) | `ui-kit/components/data/emptyState` | |
| `data/status-badge` (`StatusBadge`) | `pages/v2/_shared/statusChip` | domains `logisticOrder`, `asset`, `stage` - the same `design-system/status-registry` entry |
| `form/SelectField` (Low stock 1, Activity 4) | `ui-kit/components/ui/select` | every `aria-label` preserved: `Filter by location`, `Filter by type`, `Filter by item`, `Filter by actor` |
| Assets' native `<select>` | `ui-kit/components/ui/select` | `Filter by assignee` preserved |
| Assets' raw search input | `ui-kit/components/form/searchInput` | `Search assets…` placeholder preserved, 300ms debounce unchanged |
| Assets' raw checkbox + wrapping label | `ui-kit/components/ui/checkbox` + `ui-kit/components/ui/label` | `Show retired` still resolves through `getByLabelText` |
| Assets' hand-rolled absolute kebab menu | `ui-kit/components/ui/dropdownMenu` | same state-dependent item set, same `More actions for <name>` label, Delete is `variant="destructive"` |
| Assets' `w-96` aside drawer | `ui-kit/components/layout/masterDetail` + rebuilt `assetHistoryPanel` | `Close asset panel` and `Retire asset` labels preserved |
| Activity's raw multiplication-sign chip close | kit ghost `Button` + lucide `X` | `Clear Logistic Order filter` preserved |
| Activity's five hand-tinted verb pills | `ui-kit/components/ui/badge` soft variants | |
| Staging's `data/KpiStrip` (five `KpiTile`s) | `ui-kit/components/data/statCard` | `active` + `onClick` one-to-one; no icon, no tone caption |
| Staging's raw two-state "From PO" trigger + absolute panel | `ui-kit/components/ui/popover` | retires the hand-rolled document mousedown / Escape listeners |
| Staging's and LOList's raw pill filter chips | kit `Button` (`aria-pressed`) inside a `role="group"` | the pills only expressed state in colour before |
| Staging's raw progress bar | `ui-kit/components/ui/progress` | |
| Staging's stage cards, LOList's card frame | `ui-kit/components/ui/card` | |

## Kept legacy (and why)

| Component | Why |
|---|---|
| `lo/LODetailSheet` (648 lines) | the LO create/submit/approve/process/cancel mutation surface |
| `lo/loStatus` (`formatLoDate`, `primaryAnchor`) | pure logic |
| `LowStockView`'s `toProposalItems` | IMPORTED, not copied. It is the bridge into P2's `buildLowStockProposal` and is covered by `src/__tests__/inventory-low-stock-view.test.tsx`; forking it would be a logic change |
| `GeneratePODialog` | the proposal / per-vendor grouping flow |
| `assets/AssetDialog`, `assets/AssetActionDialog` | create/edit plus the assign/transfer/return/note/retire mutations |
| `assets/AssetBits` (`AssetThumb`) | the kit ships no image primitive and the raw-`<img>` ratchet is at its floor (38/38), so a v2 file cannot author a thumbnail. Same reason as BUILD #8 above |
| `CreateStageDialog`, `StageDetailDialog`, `POPreviewDialog`, `StagingAreaPicker` | all four are mutation / validation surfaces |

## Behaviour not reproduced, slice 2

| What the legacy view did | What v2 does instead | Why |
|---|---|---|
| Assets dimmed the whole retired row with `opacity-60` | The dim lands on the Name cell's content only | The kit DataTable has no per-row className hook. The RETIRED status chip is still the primary signal |
| Assets' filter row sat above the table with no page title | A kit `PageHeader` titled `Assets` (the tab's own label) sits above it | No new copy - it just gives this tab the same shape as its five siblings |
| Activity's verb pill rendered the raw enum (`consume`) and capitalised it in CSS | Renders `Consume`, from the same label map the Type filter uses | Badge's appearance-override ratchet is at its ceiling (10/10), so a call-site `capitalize` is not available. Rendered text is identical; DOM text case changed |
| Staging's trade chip did the same with `locksmith` | Renders `Locksmith` | same |
| Staging's "Tell the tech where" pill was `uppercase` | Sentence case in a soft amber Badge | same |
| Staging's PO-picker `lines / units` pill was `font-mono` | The Badge's own type | same |
| Staging's empty box had a dashed border | The kit Card's solid border | Card's appearance ratchet is at its ceiling (2/2) |
| LOList's card header carried a decorative `Boxes` icon and an `h2` | PageHeader's `h1`, no icon | The kit drops decorative header icons everywhere else, and PageHeader has no icon slot. The heading level rises from 2 to 1, which is the level every other v2 Inventory tab body already uses |
| Staging's breadcrumb read `Operations > Inventory > Staging` | `Home > Operations > Staging` | `PageBreadcrumbs` derives its crumbs from the nav registry, and the `inventory` entry carries `home: 'Page'`, so the middle crumb falls back to the sidebar section. Exactly the delta this module already recorded for Vendors and Purchase Orders, which use the same navKey. (This row previously read `Home > Inventory > Staging`; corrected against the rendered output - see `pages/v2/inventory/__tests__/stagingView.test.tsx`) |
| Activity's Job / Invoice / Logistic-Order links pointed at `/jobs/:id`, `/invoices/:id`, `/inventory/activity?lo=` | The same targets through `v2Path`, so they resolve under `/v2` | The v2 convention every other module's cross-record link follows |
| Low stock's query key was `['inventory','low-stock',{locationId,page}]` | Identical on mount. A rows-per-page change adds `limit` to it | The kit table footer owns page size, and an inert control is worse than a new key. The FIRST key is byte-identical, and all invalidations are on the `['inventory']` prefix, so nothing stales |
| Low stock and LOList had no rows-per-page control | The kit footer's | Gained, not lost. LOList's is client-side over the page the server returned - its query is unchanged and still sends no `page` or `limit` |
| Staging's empty box was a bare bordered box with a paragraph; Assets' drawer used `EmptyState density="flush"` | The kit's single padded shape | Already recorded on the module's EmptyState row |

## Test coverage, slice 2

The five legacy suites (`lo-list`, `inventory-low-stock-view`,
`inventory-action-log`, `inventory-assets-view`, `inventory-lo-tab`) all target
the LEGACY components and pages by import path, so they still pass and still
guard the legacy route.

**Closed** on branch `refactor/ui-kit-21-inventory-tests`. Six suites now cover
the rebuilt views on the v2 path:

| Suite | Source | Cases |
|---|---|---|
| `pages/v2/_shared/__tests__/loList.test.tsx` | port of `lo-list` | 12 |
| `pages/v2/inventory/__tests__/loTab.test.tsx` | port of `inventory-lo-tab` | 2 |
| `pages/v2/inventory/__tests__/lowStockView.test.tsx` | port of `inventory-low-stock-view` | 8 |
| `pages/v2/inventory/__tests__/actionLogView.test.tsx` | port of `inventory-action-log` | 9 |
| `pages/v2/inventory/__tests__/assetsView.test.tsx` | port of `inventory-assets-view` | 7 |
| `pages/v2/inventory/__tests__/stagingView.test.tsx` | NET NEW | 15 |

Staging is net new because **no legacy StagingView suite exists** - nothing in
the repo imports `components/inventory/StagingView`, and the only staging
coverage (`stage-attachment-upload.test.tsx`) targets `StageDetailDialog`,
which this slice keeps legacy. That view had no test on either layer.

Two things the ports surfaced beyond the divergences recorded above:

- the kit DataTable's opt-in resize grip is a `role="separator"` inside every
  `<th>`, and its `aria-label` joins the header's accessible name, so
  `getByRole('columnheader', { name: 'Anchor' })` now needs
  `'Anchor Resize Anchor column'`. Affects any suite selecting a resizable
  header by accessible name.
- `tsconfig` excludes `src/__tests__` but not `src/pages/**/__tests__`, so a
  ported file is typechecked where its legacy original was not.

`loList.tsx` was also promoted to `pages/v2/_shared/` on that branch, so the
jobs detail page stops mounting the legacy component; `pages/v2/jobs/__tests__/
jobLogisticsLo.test.tsx` (port of `job-logistics-lo`) pins that.
