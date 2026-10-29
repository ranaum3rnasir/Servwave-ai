# Inventory module - behaviour map

Phase 1 mapping artefact for `refactor/ui-kit-10-inventory` (module 10 of
`md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`).
Documentation only. Every statement was read from the files cited; anything not
verified is in "Open questions".

Mapped on 2026-07-29 against `main` @ 7dfa18e9.

---

## 0. Headline findings (read these before planning any build)

1. **Six routes, four page files, ~5,400 page lines plus ~40 dialog components.**
   This is the largest module in the migration by component count.
2. **Almost nothing persists.** Every page reads through TanStack Query and then
   copies the result into local `useState` arrays. `PriceBookPage` fires **zero**
   write requests. `InventoryPage`'s **Items** view fires **zero** write requests.
   Writes exist only in `PurchaseOrdersPage` (`useCreatePO`, `useReceivePO`),
   `VendorsPage` (`useUpsertVendor`, `useDeleteVendor`) and the two sub-views
   `StagingView` / `ApprovalsView` - and all of them *also* mutate local state,
   which the re-seed effect then overwrites on the invalidation refetch. Three of
   the sub-view write paths fire the same POST **twice**. Reproduce all of this
   exactly; do not "fix" it during a presentation swap.
3. **There are no `data-testid` attributes anywhere in this module** - not in
   `frontend/src/pages/inventory/` and not in `frontend/src/components/inventory/`
   (verified by grep). The only stable selectors are `aria-label`, `aria-pressed`,
   `role`, `title` and literal text. Section 8 enumerates them.
4. **There is no zod schema anywhere in the module.** No `react-hook-form`, no
   `zodResolver`. Every dialog is a single `useState` form object plus an
   imperative `submit()` that sets a local `error` string. The zod that does exist
   is server-side, in `backend/src/controllers/inv-*.controller.ts`.
5. **No loading and no error UI on any of the four pages.** Every query is
   destructured with a `= []` default and `isLoading`/`isError` are never read.
   A failed `GET` and an empty result set are visually identical.
6. **No Playwright spec covers inventory** (`frontend/e2e/specs` has no inventory
   file, and grepping `e2e/` for "inventory" returns nothing). Vitest coverage is
   three files - see section 9.

---

## 1. Routes and guards

`frontend/src/App.tsx:155-160`, all lazily loaded:

```tsx
{/* Inventory module (Emanuel port) */}
<Route path="/inventory"                 element={<InventoryPage />} />
<Route path="/inventory/staging"         element={<InventoryPage />} />
<Route path="/inventory/approvals"       element={<InventoryPage />} />
<Route path="/inventory/price-book"      element={<InventoryPriceBookPage />} />
<Route path="/inventory/purchase-orders" element={<PurchaseOrdersPage />} />
<Route path="/inventory/vendors"         element={<VendorsPage />} />
```

| Guard layer | Value |
|---|---|
| Route guard | Only the module-wide `<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />` at `App.tsx:111`. **None of the six inventory routes has its own `ProtectedRoute`**, unlike `/invoices/new`, `/reports` and `/users`. Any authenticated user can reach every inventory URL directly. |
| Feature gate | none - no `requireFeature`/`useFeature` on any inventory route or page |
| Nav visibility | CASL `read Inventory` on the `inventory` parent and all four children, plus a top-level `pricebook` shortcut (`nav-registry.ts:66` and `:68-73`) |

Nav registry entries (`frontend/src/components/layout/nav-registry.ts`):

```ts
{ key: 'pricebook', label: 'Price Book', href: '/inventory/price-book', action: 'read', subject: 'Inventory', home: 'Inventory' },
{ key: 'inventory', label: 'Inventory',  href: '/inventory',            action: 'read', subject: 'Inventory', home: 'Page',
  children: [
    { key: 'inv-stock',     label: 'Stock',           href: '/inventory' },
    { key: 'inv-pricebook', label: 'Price Book',      href: '/inventory/price-book' },
    { key: 'inv-pos',       label: 'Purchase Orders', href: '/inventory/purchase-orders' },
    { key: 'inv-vendors',   label: 'Vendors',         href: '/inventory/vendors' },
  ] }   // every child: action 'read', subject 'Inventory'
```

Note `/inventory/staging` and `/inventory/approvals` are **not** in the nav
registry - they are reachable only via the in-page tab strip or an alert intent.

### Backend guards (what actually 403s)

`backend/src/app.ts:162-168` mounts seven routers on `/api/inventory`:
`inv-catalog`, `inv-vendors`, `inv-locations`, `inv-stock`, `inv-po`,
`inv-stages`, `inv-techs-jobs`. All use `authenticate, attachAbility` then
`canDo(action, 'Inventory')` per route, e.g. (`inv-catalog.routes.ts`):

```
GET  /items          canDo('read','Inventory')
POST /items          canDo('create','Inventory') + validate(upsertItemSchema)
POST /items/import   canDo('create','Inventory') + validate(importItemsSchema)
POST /items/delete   canDo('delete','Inventory') + validate(deleteItemSchema)
GET  /items/:id      canDo('read','Inventory')
GET/POST /categories canDo('read'|'create','Inventory') + validate(upsertCategorySchema)
GET/POST /brands     canDo('read'|'create','Inventory') + validate(upsertBrandSchema)
GET/POST /item-groups canDo('read'|'create','Inventory') + validate(upsertItemGroupSchema)
POST /restock        canDo('update','Inventory') + validate(restockSchema)
POST /bulk-restock   canDo('update','Inventory') + validate(bulkRestockSchema)
POST /transfer       canDo('update','Inventory') + validate(transferSchema)
```

**The subject is `Inventory`, not `PriceBook`** - even for
`/api/inventory/items`, which is what `PriceBookPage` reads.

### Correction on the technician claim (verified, contradicts CLAUDE.md)

CLAUDE.md states technicians hold "org-wide `read PriceBook`" by default. Read
against `backend/src/lib/permissions/defaultGrants.ts:142-176`, the TECHNICIAN
default grant list is:

```
read/create/update Task · read+perform_walkthrough Lead (OWN_WALKTHROUGH)
read/complete/update/start/arrive Job (OWN_JOB)
read Department · read AppSetting · read Organization · read User
create/read Attachment · own-row Notification read/update/delete
```

There is **no `read PriceBook` and no `read Inventory` grant for TECHNICIAN** in
that file. `read PriceBook` is granted to SALES (`:49`) and DISPATCHER (`:115`);
`read Inventory` to SALES (`:63`) and DISPATCHER (`:128`, plus create/update/delete
at `:129-131`). Consequence for a bare technician today: the Inventory nav item is
hidden (CASL), the route is still directly reachable, and every
`GET /api/inventory/*` returns 403 - which the pages render as an empty catalog,
because they have no error state. Flagged in Open questions; this contradiction is
not something the v2 build should try to resolve.

### Per-page in-code permission gating (exhaustive)

| Location | Condition | What it controls |
|---|---|---|
| `InventoryPage.tsx:120` | `const isLocationAdmin = ability.can("manage","Inventory")` | passed as `canManage` to `LocationSelector` (add/edit location) and `CategorySelector` (add/edit/delete category) |
| `ApprovalsView.tsx:115` | `const canApprove = ability.can("manage","Inventory")` | approve/deny affordances |
| `ScanDialog.tsx:55` | `const canAddStock = ability.can("manage","Inventory")` | direct add-stock actions; when false shows `Your role ({user?.role}) can only request stock-out actions; a manager or logistics user must approve.` |
| `ApprovalDetailDialog.tsx:160` | `const editable = ability.can("manage","Inventory")` | edit affordances in the approval detail |
| `VendorDetailDialog.tsx:207` | `const editable = ability.can("manage","Inventory")` | header Edit action, Archive/Reactivate, Delete |
| `VendorsPage.tsx:77` | `const editable = ability.can("manage","Inventory")` | **only** the "Add Vendor" header button |

**`PriceBookPage.tsx` and `PurchaseOrdersPage.tsx` have no permission check at
all** - no `useAppAbility`, no role read, no feature gate. Every create/edit/
delete/receive affordance on those two pages renders for any authenticated user.

---

## 2. The shared data seam

`frontend/src/lib/api/inventory.ts`. `const USE_MOCK = false;` (line 11), so all
reads hit the real backend through `@/lib/axios`.

### Every query key in the module (verbatim)

| Hook | queryKey | Endpoint | Unwrap |
|---|---|---|---|
| `useInventoryItems` | `['inventory','items']` | `GET /api/inventory/items` | `r.data.items` |
| `useVendors` | `['inventory','vendors']` | `GET /api/inventory/vendors` | `r.data.vendors` |
| `useBrands` | `['inventory','brands']` | `GET /api/inventory/brands` | `r.data.brands` |
| `useCategories` | `['inventory','categories']` | `GET /api/inventory/categories` | `r.data.categories` |
| `useItemGroups` | `['inventory','item-groups']` | `GET /api/inventory/item-groups` | `r.data.itemGroups` |
| `useLocations` | `['inventory','locations']` | `GET /api/inventory/locations` | `r.data.locations` |
| `useBranches` | `['inventory','branches']` | `GET /api/inventory/branches` | `r.data.branches` |
| `useMovements` | `['inventory','movements']` | `GET /api/inventory/movements` | `r.data.movements` |
| `usePurchaseOrders` | `['inventory','purchase-orders']` | `GET /api/inventory/purchase-orders` | `r.data.purchaseOrders` |
| `useRFQs` | `['inventory','rfqs']` | `GET /api/inventory/rfqs` | `r.data.rfqs` |
| `useEstimateReservations` | `['inventory','estimate-reservations']` | `GET /api/inventory/estimate-reservations` | `r.data.estimateReservations` |
| `useJobStages` | `['inventory','job-stages']` | `GET /api/inventory/job-stages` | `r.data.jobStages` |
| `useStockApprovals` | `['inventory','stock-approvals']` | `GET /api/inventory/stock-approvals` | `r.data.stockApprovals` |
| `useInventoryJobs` | `['inventory','jobs']` | `GET /api/inventory/jobs` | `r.data.jobs` |
| `useTechs` | `['inventory','techs']` | `GET /api/inventory/techs` | `r.data.techs` |

No `staleTime`, no `enabled`, no `select`, no `placeholderData` on any of them.

### Mutations

One factory (`inventory.ts:80-87`):

```ts
function useInventoryMutation<TArgs>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args) => api.post(path, args).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}
```

**Every mutation invalidates the whole `['inventory']` prefix** - all fifteen
queries above. Mutations that exist:

| Hook | POST path | Used by |
|---|---|---|
| `useCreatePO` | `/api/inventory/purchase-orders` | `PurchaseOrdersPage.handleCreatePO` |
| `useReceivePO` | `/api/inventory/purchase-orders/receive` | `PurchaseOrdersPage.handleReceive` |
| `useUpsertVendor` | `/api/inventory/vendors` | `VendorsPage` add / save / archive |
| `useDeleteVendor` | `/api/inventory/vendors/delete` | `VendorsPage.handleDelete` |
| `useCreateStage` | `/api/inventory/job-stages` | `StagingView.onCreate` **and** `CreateStageDialog.submit()` - **fires twice per create** |
| `useReceiveStageLine` | `/api/inventory/job-stages/receive` | `StagingView.receiveOne` |
| `useNotifyTechReady` | `/api/inventory/job-stages/notify` | `StagingView.markReady` |
| `useCreateApproval` | `/api/inventory/stock-approvals` | `ApprovalsView.onSubmit` **and** `NewApprovalRequestDialog.persist()` - **fires twice, with different ids** |
| `useDecideApproval` | `/api/inventory/stock-approvals/decide` | `ApprovalsView.decide` **and** `ApprovalDetailDialog.handleApprove/handleReject` - **fires twice** |
| `useUpsertItem` | `/api/inventory/items` | **not wired to any page** |
| `useDeleteItem` | `/api/inventory/items/delete` | **not wired** |
| `useUpsertCategory` | `/api/inventory/categories` | **not wired** |
| `useUpsertBrand` | `/api/inventory/brands` | **not wired** |
| `useUpsertItemGroup` | `/api/inventory/item-groups` | **not wired** |

So the four **page** files write almost nothing, but the two **sub-views** of
`/inventory/staging` and `/inventory/approvals` do write - and three of their five
write paths fire the same mutation twice because both the dialog and its parent
call `.mutate()`. That double-POST is existing behaviour; a v2 build must not
"tidy" it away without a decision (section 11, question 6).

### The local-mirror pattern (the single most important behaviour to preserve)

Every page does:

```ts
const { data: seedX = [] } = useX();
const [x, setX] = useState<X[]>([]);
useEffect(() => { if (seedX) setX(seedX); }, [seedX]);
```

Consequences that must be reproduced byte for byte:

- All create/edit/delete feels instant because it is a local `setState`.
- Any refetch of `['inventory', ...]` produces a new array identity, the effect
  re-fires, and **all in-session edits are silently discarded**.
- On `PurchaseOrdersPage` and `VendorsPage` the mutation's own
  `invalidateQueries(['inventory'])` triggers exactly that overwrite.
- Locally-created ids follow fixed shapes: `itm_new_${Date.now()}`,
  `itm_imp_${Date.now()}_${idx}`, `brd_new_`, `grp_new_`, `cat_new_`, `vnd_new_`,
  `po_new_`, and line ids `ln_${Date.now()}_${random}`.

### Shared helpers

`totalOnHand`, `totalReserved`, `totalAvailable`, `isLowStock`, `inventoryValue`
(all from `lib/api/inventory.ts`); `toCSV` / `downloadCSV` from
`lib/inventory/csv`; `nextPONumber` / `reservationToDraftPO` from
`lib/inventory/reservation-to-po`; `safeHref` from `lib/safe-href`.

---

## 3. `/inventory`, `/inventory/staging`, `/inventory/approvals` - `InventoryPage.tsx` (1,805 lines)

### 3.1 How one file serves three routes

```ts
type InventoryView = "items" | "staging" | "approvals";
function viewFromPath(pathname: string): InventoryView {
  if (pathname.startsWith("/inventory/staging"))   return "staging";
  if (pathname.startsWith("/inventory/approvals")) return "approvals";
  return "items";
}
const view = viewFromPath(useLocation().pathname);
```

**The active tab is derived from the URL, never from state** (the file's own
comment says so at `:89-92`). The three tabs are deep-linkable so the alert bus
can jump straight to a view.

Render shape:

```
<div class="flex flex-1 flex-col overflow-hidden">
  <div>  {/* the 3-tab strip - ALWAYS rendered, all three routes */}
    <ViewTab active={view==='items'}     onClick={navigate('/inventory')}           label="Items"     count={allItems.filter(kind==='material').length} icon={Boxes} />
    <ViewTab active={view==='staging'}   onClick={navigate('/inventory/staging')}   label="Staging"   count={jobStages.length}  icon={PackagePlus} highlight={jobStages.filter(status==='ready_for_pickup').length} />
    <ViewTab active={view==='approvals'} onClick={navigate('/inventory/approvals')} label="Approvals" count={pendingApprovals} icon={ShieldAlert} highlight={pendingApprovals} highlightLabel="pending" />
  </div>

  {view === 'staging'   ? <StagingView   locations={allLocations} onToast={showToast} pendingIntent={pendingStageIntent} />
 : view === 'approvals' ? <ApprovalsView onToast={showToast} locations={allLocations} pendingIntent={pendingApprovalIntent} />
 : <> ...the entire Items view + 9 dialogs... </>}

  {toast && <div class="fixed bottom-6 right-6 z-[60] ...">{toast}</div>}   {/* shared by all 3 */}
  <POPreviewDialog open={!!alertPreviewPONumber} lockEscape />              {/* shared by all 3 */}
  <LowStockActionDialog open={!!lowStockAction} />                          {/* shared by all 3 */}
</div>
```

So navigating between the three routes **remounts the whole content region** but
keeps the tab strip, the toast layer, and the two alert-driven dialogs. Every
piece of Items-view state (`search`, `activeLoc`, `filters`, `selectedId`,
`activeDialog`, `openKebabId`) is lost on a tab switch, because it lives in the
`InventoryPage` component and the JSX branch unmounts its consumers - the state
itself survives, but the Items UI is not rendered, and `StagingView`/`ApprovalsView`
mount fresh.

All nine queries run on all three routes (they are called unconditionally at the
top of the component), so Staging and Approvals pay for the full item/vendor/
category/branch/brand fetch too.

### 3.2 The alert bus (`stores/inventory-alert.store.ts`)

```ts
useInventoryAlertStore = create({ pending: InventoryAlert|null, nonce: 0,
  emit: alert => set(s => ({ pending: alert, nonce: s.nonce + 1 })),
  clear: () => set({ pending: null }) });
```

The TopBar bell (`NotificationsDropdown`) calls `emit`. `InventoryPage` has an
effect keyed **only on `alertNonce`** (`:193-273`, with an
`eslint-disable react-hooks/exhaustive-deps`) that reduces the intent:

| `alert.kind` | Effect |
|---|---|
| `low_stock` | `navigate('/inventory')`; set `filters.stockStates` to the low_stock-only variant (strips `in_stock`/`out_of_stock`/`backorder`); if `alert.ref.itemSku` matches an item -> `setSelectedId(hit.id)` + `setLowStockAction({itemId, kind:'low_stock'})` |
| `backorder` | same but with `backorder` in `stockStates` and `kind:'backorder'` |
| `po_partial` | `setAlertPreviewPONumber(alert.ref.poNumber)` -> opens `POPreviewDialog` on top of whatever view is showing |
| `pending_approval` | `navigate('/inventory/approvals')` + `setPendingApprovalIntent({id, nonce: Date.now()})` |
| `staging_no_area`, `staging_ready` | `navigate('/inventory/staging')` + `setPendingStageIntent({id, nonce: Date.now()})` |

then `clearAlert()`. The `{id, nonce}` intent shape exists because
`StagingView`/`ApprovalsView` mount **after** the emit, so a pub/sub subscription
would miss it; the `nonce` makes the child effect re-fire on a repeat click of the
same alert row. Preserve this contract - it is load-bearing.

The low_stock lookup reads `itemsQuery.data`, **not** the local `allItems`
mirror.

### 3.3 Items view - component tree

```
Page header (border-b, bg-white, px-6 py-4)
  breadcrumb "Operations" > "Inventory"
  h1 "Inventory"
  p  "Track stock across warehouse, counter, and {N} vans · Org -> Branch -> Warehouse -> Bin"   (N = locations of type 'truck')
  action row: [Scan QR / Barcode] [Restock] [Transfer] [Import CSV] [Export] [Add Item]
  5 x <StatTile>  (thin wrapper over the shared <KpiTile> from components/ui/KpiStrip)

"Showing" row (border-b, bg-white, px-6 py-3)
  <LocationSelector locations items activeId={activeLoc} onChange onAddNew canManage={isLocationAdmin} onEditLocation />
  <CategorySelector categories items activeName={filters.categories[0] ?? 'all'} onChange onAddNew canManage onEditCategory onDeleteCategory />
  [Clear filter]                      (only when activeLoc !== 'all' || filters.categories.length > 0)
  [Restock All Low Stock · by Location]  (ml-auto, ONLY when filters.stockStates includes 'low_stock')

<LocationStockHealth ... />           (ONLY when filters.stockStates includes 'low_stock')

Search + filters row
  search input "Search inventory…"
  <FiltersPopover filters onChange vendors resultCount totalCount />
  result counter with a prefix that changes per active stock state
  <ActiveFilterChips filters onChange />

Main split (flex flex-1 overflow-hidden)
  items <table> (10 columns)   +   <DetailPanel /> aside (w-96, only when selectedItem)

9 dialogs, always mounted, `open` prop driven
```

### 3.4 Every interactive element in the Items view

**Header actions**

| Control | Effect |
|---|---|
| `Scan QR / Barcode` (ScanLine) | `setActiveDialog("scan")` |
| `Restock` (PackagePlus, success tint) | `setActiveDialog("restock")` |
| `Transfer` (ArrowRightLeft) | `setActiveDialog("transfer")` |
| `Import CSV` (Upload) | `setActiveDialog("import_csv")` |
| `Export` (Download), `title={\`Export ${filteredItems.length} items as CSV\`}` | `handleExport()` - builds 18 columns (SKU, Name, Category, Kind, UoM, Unit Cost, Sell Price, Total On Hand/Reserved/Available, Vendor, MPN, UPC, Serialized, Hazmat, Status, Locations Breakdown, Updated At) from **`filteredItems`**, `toCSV` + `downloadCSV` as `inventory-{locSuffix}-{YYYY-MM-DD}.csv`. Zero rows -> toast `No items to export with current filters` and no download. |
| `Add Item` (primary) | `setActiveDialog("add")` |

**Stat tiles** (all five are clickable; single-active stock-state semantics)

| Tile | Value | Click |
|---|---|---|
| `Active SKUs` (Boxes) | `stats.totalSkus` | `setFilters(f => ({...f, stockStates: [], kinds: []}))`. `active` when both are empty. `sub` flips to `"click to show all"` when a stock state is set. |
| `Low Stock` (TrendingDown, warning) | `stats.lowStock` | toggles `low_stock`, stripping `in_stock`/`out_of_stock`/`backorder` |
| `Backorder` (ShoppingCart, danger) | `stats.backorder` | toggles `backorder`, stripping the other three |
| `Inventory Value` (DollarSign, success) | `$${stats.value.toLocaleString(maximumFractionDigits:0)}` | toggles `in_stock`, stripping the other three |
| `Needs Approval` (ShieldAlert, warning) | pending approvals count | `navigate('/inventory/approvals')` - **no filter, no `active` prop** |

`sub` copy when a tile is lit: `"filtered — click to clear"` (`Low Stock`,
`Backorder`), `"filtered — only in-stock items"` (`Inventory Value`).

**"Showing" row**

- `LocationSelector` - dropdown over `allLocations`; `onChange -> setActiveLoc`;
  `onAddNew -> setActiveDialog("add_location")`; `onEditLocation(loc) ->
  setEditingLocation(loc)`. Add/edit affordances gated by `canManage={isLocationAdmin}`.
- `CategorySelector` - single-select by **name**; `onChange(name) ->
  setFilters({categories: name==='all' ? [] : [name]})`;
  `onAddNew -> setActiveDialog("add_category")`;
  `onEditCategory(c) -> setEditingCategory(c)`;
  `onDeleteCategory(c)` -> if `allItems.filter(i => i.category === c.name).length > 0`
  shows toast ``⚠ "{name}" can't be deleted — {n} item(s) still in this category. Re-categorize them first.``
  and returns; otherwise a **native `confirm(\`Delete category "${c.name}"? This can't be undone.\`)`**,
  then removes it, resets the filter if it was active, toast ``🗑 Category "{name}" deleted``.
- `Clear filter` - `setActiveLoc("all")` + clears `filters.categories`.
- `Restock All Low Stock · by Location` -
  `title="Generate Purchase Orders for every below-min item, grouped by location → vendor"`,
  `-> setActiveDialog("bulk_restock")` with `bulkRestockLocId` unset (all locations).

**`LocationStockHealth`** (`components/inventory/LocationStockHealth.tsx`, 237 lines)

Rendered only when `low_stock` is an active stock state. Per location it counts
material items with a `min > 0` stock row at that location where `onHand < min`;
`ratio = onHand/min`; `criticalCount` counts `ratio < 0.5`; `worstRatio` picks the
`lowestItem`. Severity: `red` if any critical, else `yellow` if any low, else
`green`.

- Heading `Low-Stock Health by Location`, sub `Click a location card to scope the items list to that location.`
- Legend: `{n} healthy` / `{n} watching` / `{n} critical`.
- Grid `grid-cols-2 sm:3 lg:5 xl:6`; each card is a `<button>` -> `onSelectLocation(id)` -> `setActiveLoc(id)`;
  active card gets `ring-2 ring-primary ring-offset-1`.
- Corner `Restock` pill, rendered only when `lowCount > 0 && onRestockLocation`,
  `title={\`Create Purchase Order(s) to restock ${loc.name}\`}`, `stopPropagation`,
  -> `setBulkRestockLocId(id)` + `setActiveDialog("bulk_restock")`.
  When the pill shows, the severity icon is hidden.
- Card body: location-type icon (Warehouse/Truck/Boxes/MapPin), name, big
  `{lowCount}` + `item(s) below min`, optional `{n} critical (< 50% of min)`,
  then `Worst: {sku truncated to 18} {onHand}/{min}` or, when nothing is low,
  `All items at or above reserve`.

**Search + filters**

- Search input `Search inventory…` -> `setSearch`.
- `FiltersPopover` (`components/inventory/FiltersPopover.tsx`) - Radix Popover,
  `w-[560px]`. Trigger is a `Filters` button that lights primary and shows a count
  badge when `activeFilterCount(filters) > 0`. Header shows
  `Showing {resultCount} of {totalCount} items` plus `Clear all ({count})`.
  Four chip sections:
  - **Item Kind**: Material / Labor / Service / Bundle / Fee
  - **Stock Status**: In stock / Low stock / Out of stock / On backorder (tinted)
  - **Vendor**: one chip per `allVendors` entry, toggled **by `v.name`**
  - **Flags**: Serialized / Hazmat (AND semantics - the item must have all selected flags)
  Footer has a single `Apply` button which only does `setOpen(false)` - **the
  filters are already applied live on every chip click**.
  `Filters` type: `{ trades, kinds, stockStates, vendors, flags, categories }`;
  `emptyFilters` is all-empty. `trades` is in the type and used by the filter
  chain but **no UI writes it**.
- `ActiveFilterChips` - a strip of removable pills for kinds / stockStates /
  vendors / flags (**not** categories, and **not** trades), each with
  `aria-label={\`Remove ${label}\`}`, plus a trailing `Clear all` that resets to
  `emptyFilters`. Returns `null` when there are no chips.
- Result counter text: `{n} {prefix}item(s)` where prefix is `low-stock ` /
  `backordered ` / `out-of-stock ` / `""`, then either ` at {activeLocation.name}`
  or ` · of {allItems.length} total`.

**Items table** (plain `<table>`, not `ResizableTable`, not TanStack Table)

Columns: `[checkbox] | SKU | Item | Category | On Hand | Reserved | Available |
Unit Cost | Locations | [kebab]`.

- The `On Hand` header appends a small `here` chip when a location is active.
- The `Locations` header becomes `Also at` when a location is active.
- Header checkbox and per-row checkboxes are **decorative** - they have no
  `checked`, no `onChange`, and there is no bulk-action bar. The row checkbox only
  has `onClick={e => e.stopPropagation()}`.
- Row click -> `setSelectedId(item.id)` -> opens the right `DetailPanel`.
  Selected row gets `bg-primary/10 hover:bg-primary/20`.
- Per-location scoping: when `activeLocation` is set, On Hand / Reserved /
  Available read from that location's stock row and `low` is
  `stockHere.min != null && stockHere.onHand < stockHere.min`; otherwise they use
  `totalOnHand/totalReserved/totalAvailable` and `isLowStock(item)`.
- `low` renders an `AlertTriangle` with `aria-label="below min"` before the number.
- Item cell: `<ItemThumb size={36}>` (photo or an `ImageIcon` placeholder with
  `title="No photo yet"`) + name + badges `serialized` / `hazmat` / `backorder`.
- `LocationBreakdown` - one chip per stock row with `onHand > 0`, excluding the
  active location; `title={\`${loc.name}: ${onHand} on hand, ${reserved} reserved[, below min]\`}`;
  name truncated by stripping a trailing `'s Van` then `slice(0,14)`. Empty -> `—`.
- **Kebab menu** (`MoreHorizontal`, `stopPropagation`, absolutely positioned
  `w-48` panel, single-open via `openKebabId`; **there is no outside-click or Esc
  handler - it closes only when an item is chosen or the same kebab is clicked
  again**):

| Item | Icon | Effect |
|---|---|---|
| `Edit item` | Pencil | `setEditingItem(item)` |
| `Restock` | PackagePlus | `setSelectedId(item.id)` + `setActiveDialog("restock")` |
| `Transfer stock` | ArrowRightLeft | `setSelectedId(item.id)` + `setActiveDialog("transfer")` |
| `Create PO` | ShoppingCart | **no-op** - only `setOpenKebabId(null)` |
| `Cycle count` | Boxes | **no-op** - only `setOpenKebabId(null)` |
| `Delete item` (danger) | Trash2 | `setSelectedId(item.id)` + `setActiveDialog("delete")` |

Empty table: one row, `colSpan={10}`, `No items match your filters.`

**`DetailPanel`** (right `<aside w-96>`, `animate-panel-in`)

Header: `<ItemThumb size={56}>`, SKU (mono), name, category pill, `X` close ->
`setSelectedId(null)`. Then a 3-stat grid (On Hand / Reserved / Avail) and a
2-stat grid (Unit Cost / Sell Price). `By Location` list with per-location icon,
name, low-stock `AlertTriangle`, `res {reserved}`, `{onHand}`, `min {min}`.
`Serial Numbers` block only when `item.serialized && item.serials?.length`.
`Recent Stock Movements` from `useMovements()` filtered by `m.itemSku === item.sku`,
each with a coloured dot (receive=success, consume=danger, transfer=info, else
warning), `{type} · {+qty} {uom}`, `m.reference`, `{m.actor} · {localised date}`.
Empty: `No movements recorded yet.` Footer buttons: `Restock`, `Transfer`, `Edit`,
and a trash icon with `aria-label="Delete item"` / `title="Delete item"`.

### 3.5 Items-view mutation handlers (all local, all toast)

`showToast(msg)` sets `toast` and clears it after **3500 ms** via `setTimeout`.
The toast is a fixed `bottom-6 right-6 z-[60]` success-tinted div. There is no
error variant and no toast queue - a second toast replaces the first.

| Handler | Behaviour | Toast |
|---|---|---|
| `handleSave(payload, editId?)` | edit -> patch the item in place (`sku,name,category,trade,kind,uom,unitCost,sellPrice,serialized,hazmat,vendor,photoUrl ?? existing,brandId,visibility,updatedAt`); create -> unshift a new `Item` with `status:'active'` and `stock` mapped from `payload.startingStock` (`onHand: s.qty, reserved: 0, min, max`) | `✓ {sku} updated · audit log entry written` / `✓ {sku} added to the catalog` |
| `handleDelete()` | filters `selectedItem` out, `setSelectedId(null)` | `✓ {sku} soft-deleted · audit log entry written` |
| `handleTransfer({item,fromId,toId,qty,reason})` | decrements the source row, increments the dest row, **pushes a new dest row when missing**. Note: the source is decremented without a floor, so it can go negative. | `✓ Transferred {qty} × {sku} from {from} → {to}` |
| `handleRestock({item,locationId,qty,unitCost,source,referenceNo,notes,fromLocationId})` | adds to the destination (creating the row if absent); when `fromLocationId` is set (truck return) decrements it with `Math.max(0, ...)`; sets `unitCost: payload.unitCost \|\| i.unitCost`; flips `status` from `on_backorder` to `active` | `✓ Received {qty} × {sku} into {loc} · {srcLabel}` where srcLabel is `PO {ref}` / `Manual receive` / `Customer return` / `Cycle count` / `Truck return · {from}` |
| `handleImport(payloads)` | prepends all rows with ids `itm_imp_{ts}_{idx}` and `stock: []`; detects SKU collisions against `allItems` | `✓ Imported {n} items · {k} SKU collisions flagged in review queue` or `✓ Imported {n} items · AI categorize running` |
| `handleBulkCreatePOs(pos)` | **does nothing but toast** - no state change, no API call | `✓ {n} purchase order(s) created · {lines} line(s) · ${total} · pending approval. {per-location breakdown}` |
| `handleScanMatch(item)` | `setSelectedId(item.id)` | none |

### 3.6 The nine Items-view dialogs

All are always mounted; `open` is prop-driven from `activeDialog` (or an
`editingX` state). All use `components/inventory/InventoryModal` (`Modal`), a thin
shadcn `Dialog` adapter with `size: sm|md|lg|xl -> max-w-md|lg|2xl|4xl`,
`max-h-[90vh] overflow-y-auto`, and `lockEscape`.

| Dialog | `open` when | Notes |
|---|---|---|
| `AddItemDialog` | `activeDialog === 'add' \|\| !!editingItem` | one mount serves create **and** edit. Also takes `prefilledCode` from a scan. Own query: `useLocations()` -> `['inventory','locations']`. Detailed in section 4.4. Validation: only `!form.name.trim()` -> `"Name is required."`; photo must be `image/*` and `< 10 MB`. |
| `DeleteItemDialog` | `activeDialog === 'delete'` | `size="md"`, title `Delete item?`, subtitle `This action is soft-delete + audit-logged. Stock movement history is preserved.` -> `handleDelete` |
| `AddCategoryDialog` | `activeDialog === 'add_category' \|\| !!editingCategory` | `onCreate` appends **and auto-selects** it as the single active category filter, toast ``✓ Category "{name}" added — now filtering``. `onUpdate` does a **cascading rename**: every `allItems` row with the old `category` name is rewritten, and `filters.categories` is remapped. Toast ``✓ Category renamed: "{old}" → "{new}"`` or ``✓ Category "{name}" updated``. |
| `ScanDialog` | `activeDialog === 'scan'` | `size="md"`, title `Scan QR / Barcode`, subtitle `Native VisionKit (iOS) / ML Kit (Android) · Bluetooth scanner supported`. Phases `ready` / match / `no_match`. Gated by `canAddStock = ability.can("manage","Inventory")`. Callbacks: `onMatch -> setSelectedId`; `onRestock(item) -> setSelectedId + activeDialog='restock'`; `onRequestApproval(item) -> toast \`📋 Approval request submitted · {sku} · pending manager review\` + navigate('/inventory/approvals')`; `onCreateNew(code) -> setPrefilledScanCode(code) + activeDialog='add' + toast \`🆕 Opening Add Item with scanned code "{code}" pre-filled\``. |
| `TransferDialog` | `activeDialog === 'transfer'` | `title="Transfer Stock Between Locations"`, seeded with `initialItemId={selectedId}`. Two paths: single-item location->location (`onSubmit -> handleTransfer`) and **bulk stage transfer** (`onBulkStageTransfer`) which decrements the source location per line, toasts `✓ Staged {n} lines · {units} units from {from} → Job Staging · {PO or Job ref}[ · {customer}]` and **`navigate('/inventory/staging')`**. Validation strings: `Select an item.`, `Enter a quantity > 0.`, `From and To must be different.`, `Single-item stage routing not wired by parent.`, `Pick a destination job or PO.`, `Picked job not found.`, `Bulk staging transfer not wired by parent.`, `Pick a PO to transfer from.`, `Pick a job to transfer for.`, `Select at least one line with qty > 0.` |
| `RestockDialog` | `activeDialog === 'restock'` | `size="lg"`, title `Restock Inventory`, subtitle `Posts an immutable stock_movement entry (type: receive) and adds to on-hand at the destination.` `RestockSource` union drives a per-source `needsRef` label. Validation: `No item selected.`, `Quantity must be greater than 0.`, `Unit cost can't be negative.`, `` `${needsRef} is required for this source.` ``, `Pick which van the stock is coming from.`, `Source van and destination must be different.` |
| `BulkRestockDialog` | `activeDialog === 'bulk_restock'` | `size="xl"`, `filterLocationId={bulkRestockLocId ?? undefined}`; `title="Generates POs in draft state — sent to the approval queue"` on the primary button. Emits `GeneratedPO[]` to `handleBulkCreatePOs`, which only toasts. |
| `AddLocationDialog` | `activeDialog === 'add_location' \|\| !!editingLocation` | `size="lg"`. Can create a branch inline (`onAddBranch`, `title="Add a new branch"`). `onCreate` appends **and sets `activeLoc` to the new location**, toast ``✓ "{name}" created · now showing inventory at this location``. `onUpdate` toast ``✓ "{name}" updated · audit log entry written``. Validation: `Location name is required.` |
| `ImportCSVDialog` | `activeDialog === 'import_csv'` | `size="xl"`, title `Import Items from CSV`, subtitle `Drop a CSV exported from a vendor catalog, Excel, or another FSM tool. AI categorization runs after import.` Validation: `Please drop a .csv file.`, `CSV is over 20 MB — bulk imports of that size go through the back-office importer.`, `Could not find any data rows in this CSV.`, `Failed to read the file.`, `Nothing to import.` |

Plus two dialogs mounted **outside** the view branch, so they render on all three
routes:

- `POPreviewDialog` - `open={!!alertPreviewPONumber}`, `lockEscape`, driven by a
  `po_partial` bell alert. Detailed in section 6.4.
- `LowStockActionDialog` - `open={!!lowStockAction}`, `size="md"`, item resolved
  from `allItems` by id, `kind` low_stock|backorder; the close button has
  `title="Close this pop-up — the item stays filtered in the list so you can come back to it"`;
  `onRestock` closes it and opens `RestockDialog` (which reads `initialItemId`
  from `selectedId`, already set by the alert reducer).

### 3.7 Filtering and stats (`components/inventory/useInventoryFilters.ts`)

Both memos were lifted verbatim from the page and the file says so. The
`.filter()` chain order is load-bearing and must not be reordered:

1. `kind` is `material | labor | service` (bundle and fee are dropped **before**
   anything else, so the Filters popover's Bundle/Fee chips can never match)
2. search over `sku, name, category, vendor, mpn, upc`
3. `activeLoc` presence: needs a stock row at that location; when `low_stock` or
   `out_of_stock` is an active state a zero-on-hand row still passes, otherwise
   `onHand > 0` is required
4. `filters.trades` (no UI writes this)
5. `filters.kinds`
6. `filters.vendors` (matched on `i.vendor` **string**, not id)
7. `filters.categories` (matched on `i.category` **name**)
8. `filters.flags` - AND semantics
9. `filters.stockStates` - drops any non-`material` item first, then branches:
   - location-scoped: `isLow = s.min != null && s.min > 0 && s.onHand < s.min`;
     `in_stock` = `onHand > 0 && !isLow && status !== 'on_backorder'`;
     `low_stock` = `isLow`; `out_of_stock` = `onHand === 0`;
     `backorder` = `status === 'on_backorder'`
   - cross-location: same, except `low_stock` additionally requires `onHand > 0`

`useInventoryStats(allItems)` -> `{ totalSkus, lowStock, backorder, value }`,
computed over `kind === 'material'` only, `value = sum(inventoryValue(i))`.

### 3.8 `/inventory/staging` - `StagingView` (1,027 lines)

```ts
type Props = { locations: Location[]; onToast: (msg: string) => void;
               pendingIntent?: { id: string; nonce: number } | null };
```

Queries: `useJobStages()` `['inventory','job-stages']`, `usePurchaseOrders()`
`['inventory','purchase-orders']`, `useVendors()` `['inventory','vendors']`.
Plus `useAuthStore(s => s.user)` -> `actorName = \`${first_name} ${last_name}\`.trim()`
or `"Unknown user"`.
Mutations: `useCreateStage`, `useReceiveStageLine`, `useNotifyTechReady`.

Local state: `stages` (mirror, re-seeded on `[seedStages]`), `filter` (default
`"all"`), `expandedId` (defaults to `stages[0]?.id ?? null`), `detailId`,
`showCreate`, `prefilledPO`, `showPOPicker`, `previewPONumber`.

**`pendingIntent` consumption** (`:151-154`) - keyed on `[pendingIntent?.id,
pendingIntent?.nonce]`, sets `detailId` only. It does **not** change the filter.

**Permission gating: none.** `StagingView.tsx` does not import `useAppAbility`
and has no role check. Every control below is available to any user who reaches
the route.

Tree:

```
Header: breadcrumb Operations > Inventory > Staging · h1 "Job Staging"
  sub "Track parts received for specific jobs · partial shipments + backorders + ready-for-pickup."
  [From PO ▾] [New Pickup]
5 clickable StatTiles (grid-cols-2 sm:grid-cols-5)
Filter chip row: label "Filter" + 5 chips with counts
Stage card list (flex-1 overflow-y-auto bg-background-light)
Dialogs: StageDetailDialog · CreateStageDialog · POPreviewDialog
```

| StatTile | Value | Sets filter |
|---|---|---|
| `Active Stages` | `totals.stages` | `all` |
| `Awaiting` | `counts('awaiting')` | `awaiting` |
| `Partial` | `counts('partial')` | `partial` |
| `Ready` | `counts('complete')` | `complete` |
| `Ready for pickup` | `counts('ready_for_pickup')` | `ready_for_pickup` |

Filter chips: `All Stages` / `Awaiting` / `Partial` / `Ready` / `Ready for pickup`.

**"From PO" picker** - toggles `showPOPicker`, shows `availablePOs.length` in a
pill; `availablePOs` = POs where `!po.stagedAsJobStageId &&
!stagedPONumbers.has(po.poNumber) && status !== 'received' && status !== 'closed'`.
The absolute `w-[460px]` panel closes on outside `mousedown` or Escape (document
listeners). Header `Open logistics orders` / `Pick a PO to pre-fill a new staging
pickup`. Empty: `All open POs are already staged 🎉`. Clicking a PO row ->
`setPrefilledPO(po) + setShowCreate(true) + setShowPOPicker(false)`. Each row also
has a **Preview** button (`title="Preview PO as PDF · print"`, `stopPropagation`)
-> `setPreviewPONumber`. Rows without a customer show
`No job linked · pick a job during staging`.

**`StageCard`** - the card head is `role="button" tabIndex={0}` with `onClick` and
Enter/Space keydown to expand/collapse. The job-number and customer text are
separate buttons, both `title="Open Full Transaction"` -> `StageDetailDialog`.
Status badges: `Awaiting all parts` / `Partial — items pending` / `All parts in` /
`Ready for pickup` / `Delivered to tech`. Meta line shows
`Pickup at {vendorName} · {pickupAddress.slice(0,48)}` or
`Staged at {location.name} · {stagedArea}`. Right: `{received} / {ordered}
received`, a progress bar (`bg-success` at 100%, `bg-warning` >= 50%,
`bg-warning/60` > 0, `bg-border` at 0) and `{pct}% complete`.

Expanded body:
- **Line items** - per item: SKU, `serialized` chip, name, vendor, a **PO number
  button** (`title="Preview PO as PDF · print"`, `stopPropagation`) ->
  `POPreviewDialog`, `ETA {date}` when not done; qty column
  `{qtyReceived} / {qtyOrdered} {uom}` plus `{remaining} backordered` (warning) or
  `Complete` (success); and a **`Receive +1`** button
  (`title="Receive 1 more unit (simulate partial delivery)"`) -> `receiveOne`,
  replaced by a `—` once done.
- **Staging area strip** - only when `!stage.pickupVendorId && stagedLoc`. Label
  `Staging area in {stagedLoc.name}`; a warning pill **`Tell the tech where`**
  when `!stage.stagedArea && (status === 'complete' || 'ready_for_pickup')`;
  contains `<StagingAreaPicker>`.
- **Notes + actions footer** - `📝 {notes}` or `No notes`;
  **`Notify Tech · Ready for Pickup`** (only when `status === 'complete'`) and
  **`Mark Delivered to Tech`** (only when `status === 'ready_for_pickup'`), both ->
  `markReady`; static `Awaiting remaining vendor deliveries` when awaiting/partial
  and `Held together as a single dispatch` when ready; **`Open Full Transaction`**;
  and **`Open Job →`**, which has **no onClick handler - it is a dead button**.

Handlers:

| Handler | Local | Mutation | Toast |
|---|---|---|---|
| `markReady(id)` | toggles `ready_for_pickup` <-> `delivered` | `notifyTechReady.mutate({stageId})` | `✓ {job} marked delivered` / `✓ {job} marked ready for pickup · tech notified` |
| `receiveOne(stageId, itemId)` | `qtyReceived+1` clamped to `qtyOrdered`, recomputes `complete`/`partial`/`awaiting` | `receiveStageLine.mutate({stageId,itemId})` | **none** |
| `setStagedArea(id, next)` | local only + appends a `StageAuditEntry` (`field:"stagedArea"`, comment ``Moved from "x" to "y"`` / ``Placed in "y"`` / ``Cleared (was "x")``) | **none - never reaches the server** | `📍 {job} staged in {area}` / `📍 {job} staging area cleared` |
| `StageDetailDialog.onSave(updated, audit)` | replaces the stage locally | **none** | `✓ {job} updated · {n} change(s) logged to audit trail` |
| `StageDetailDialog.onEmailSent` | - | none | `✉ Pickup ticket for {job} sent to {n} recipient(s) · {to[0]}[ +n]` |
| `CreateStageDialog.onCreate(stage)` | prepend, `setExpandedId`, `setFilter("all")` | `createStage.mutate(stage)` (**second call - the dialog already fired one**) | `✓ Staging created for {job} from {PO} · {n} line(s)` / `✓ Pickup created for {job} · {n} line item(s) ordered` |
| `POPreviewDialog.onEmailSent` | - | none | `✉ PO {poNumber} emailed to {n} recipient(s) · …` |

Loading/error: none. Empty copy: `No staged jobs match this filter.` (dashed card
with a **Create New Pickup** button that does **not** clear `prefilledPO`),
`All open POs are already staged 🎉`, `No notes`,
`No job linked · pick a job during staging`.

Selectors: `role="button"` + `tabIndex=0` on each card head; `title` values
`Open Full Transaction`, `Preview PO as PDF · print`,
`Receive 1 more unit (simulate partial delivery)`; text `From PO`, `New Pickup`,
`Create New Pickup`, `Receive +1`, `Notify Tech · Ready for Pickup`,
`Mark Delivered to Tech`, `Open Full Transaction`, `Open Job →`, `Preview`;
headings `Job Staging`, `Line items`.

### 3.9 `/inventory/approvals` - `ApprovalsView` (463 lines)

```ts
type Props = { onToast: (msg: string) => void; locations: Location[];
               pendingIntent?: { id: string; nonce: number } | null };
```

Queries: `useStockApprovals()` `['inventory','stock-approvals']`. Mutations:
`useCreateApproval`, `useDecideApproval`. Plus `useAppAbility()` and
`useAuthStore(s => s.user)` -> `reviewerName` or `"You"`.

**`pendingIntent` consumption** (`:109-113`) - `setFilter("pending")` **first**
(so the row stays visible behind the dialog), then `setOpenDetailId(id)`.

**Gating** (`:115`): `const canApprove = ability.can("manage","Inventory");`
- Header copy switch (`:183-193`): true -> success span with a `ShieldCheck` icon,
  `` You can approve or reject as {reviewerName}{user?.role ? ` (${user.role})` : ""}. ``;
  false -> warning span `Your role can view but not approve.`
- Passed down as `canApprove={canApprove}` to `ApprovalDetailDialog`.
- **Nothing else is gated** - `New Request`, the StatTiles, the filter chips and
  every card stay clickable regardless of ability.

Tree: header (breadcrumb `Operations > Inventory > Stock-Out Approvals`, h1
`Stock-Out Approvals`, sub `Field-tech scans queue here before stock leaves a van
or warehouse.` + the gating clause, and a **New Request** button) -> four
StatTiles -> a filter chip row -> a card list -> `ApprovalDetailDialog` +
`NewApprovalRequestDialog`. **No table, no columns.**

| StatTile | Value | Icon | Filter |
|---|---|---|---|
| `Pending` | `counts.pending` | Clock | `pending` |
| `Approved Today` | `counts.approved` | CheckCircle2 | `approved` |
| `Rejected` | `counts.rejected` | XCircle | `rejected` |
| `Total` | `counts.all` | ShieldCheck | `all` |

`Approved Today` is a misnomer - it counts all approved rows with no date filter.
Filter chips, in order: `Pending`, `Approved`, `Rejected`, `All`; **default filter
is `pending`**.

`ApprovalCard` - the entire card is one `<button onClick={onOpenDetail}>`. Type
chip `Consume on Job` / `Return to Warehouse` / `Write-off` / `Transfer to Van`
(primary / success / danger / info), SKU `<code>`, `{qty} {uom}`, item name, and a
status badge. Second row: requester, `From {fromLocationName}`,
`→ {toLocationName}`, `{jobNumber} · {customer}`, `{requestedAt}`, and a
hover-only `Open full transaction →`.

Handlers:

| Handler | Local | Mutation | Toast |
|---|---|---|---|
| `decide(id, decision, comment)` | patches `status`, `reviewedAt`, `reviewedByName`, `reviewComment` | `decideApproval.mutate({id,decision,comment})` - **plus a second POST from the dialog, which includes `signature`** | `✓ Approved {qty} × {itemSku} · stock movement posted` / `✗ Rejected request from {tech} · {itemSku}` |
| `applyEdit(id, patch)` | local only | **none** | `✏️ {sku} edited after decision · audit logged ({note})` when `latest.postDecision`, else `✏️ {sku} updated · {note ?? "changes saved"}` |
| `NewApprovalRequestDialog.onSubmit(req)` | mints `id: \`apr_new_${Date.now()}\``, `status:'pending'`, prepends, `setFilter("pending")` | `createApproval.mutate(...)` - **the dialog's own `persist()` already fired one with a different id** | `📋 Approval request submitted · {qty} × {sku} · {tech}` |
| both `onEmailSent` | - | none | `📧 Approval request emailed to {n} recipient(s) · {to.join(", ")}` |

Loading/error: none. Empty list (`:283`):
`No {filter === "all" ? "" : filter} approvals to show.` - note the interpolation
produces a **double space** on the `all` filter (`No  approvals to show.`).

Selectors: **ApprovalsView has no `aria-label`, no `role=` and no `title=` of its
own.** Only text: `New Request`, `Pending`, `Approved Today`, `Rejected`, `Total`,
`Filter`, `Approved`, `All`, the `Stock-Out Approvals` heading,
`Open full transaction →`, and the two gating strings.

### 3.10 Staging / Approvals dialogs

All wrap `Modal` (section 7.1). `SelectField` forwards `aria-label` onto the
`SelectTrigger`, so every `aria-label` below is queryable.

**`CreateStageDialog`** - props `{open, onClose, locations, onCreate(stage),
prefilledFromPO?}`. Queries `useInventoryItems`, `useVendors`,
`usePurchaseOrders`, `useInventoryJobs`, `useTechs`; mutation `useCreateStage`.
`size="xl"`, title `New Job Pickup` or `New Job · from {poNumber}`.
Fields: **Job** (`aria-label="Job"`, with a `+ New job (type below)…` sentinel
`__new__`; a free-text job# input uppercased when no job is picked; success hint
`Auto-filled customer · site · schedule`), **Customer\*** (readOnly when a job is
picked), **Site / Address** (same), **Scheduled For** (`datetime-local`),
**Assigned Tech** (`aria-label="Assigned tech"`), **Pickup From Vendor**
(`aria-label="Pickup from vendor"`, excludes `vnd_internal`), a vendor pickup-
address panel, **Items Ordered (n)** with per-line `aria-label="Item"` /
`aria-label="Vendor"` selects, Qty, read-only UoM, PO #, ETA and an
`aria-label="Remove line"` trash button (disabled at one row,
`title="Need at least one item"`), an `aria-label="Auto-fill from PO"` select, an
`Add item` button, and **Notes (optional)**.
Footer: `Cancel`; **`Get 3 Estimates`** (`disabled` when no line has qty > 0) ->
`EstimateComparisonDialog`; **`Preview PO`** (`disabled={!linkedPOId && !prefilledFromPO}`)
-> `POPreviewDialog`; **`Email PO to Vendor`** / **`Email {n} Vendor POs`**
(`disabled` when there is neither a current PO nor a vendor group) -> a
`POEmailDialog` queue; **`Create Pickup ({n} items)`** -> `submit()`.
Validation: `Job number is required.` · `Customer is required.` ·
`Every line needs an ordered quantity > 0.` ·
`Every line needs a PO number (or N/A for emergency).`
Ship-mode (`openVendorEmail`) builds one synthetic PO per distinct vendor
(`PO-####-A/-B/…`) and fires `createStage.mutate` + `onCreate` only after the
**final** email send; cancelling mid-queue discards the pending stage.

**`StageDetailDialog`** - props `{open, onClose, stage, locations, onSave(updated,
audit), onReceiveOne(stageId, lineId), onEmailSent?}`. Queries `useVendors`,
`useTechs`. **No mutation of its own** - all persistence is delegated to the
parent's `onSave` (which does not mutate) and `onReceiveOne`.
`isInProgress = status === 'awaiting' || 'partial'` opens in always-edit mode
(footer `Close · Preview · Email · Print / PDF · Save Changes (n)`); a finished
stage opens read-only (footer `… Edit Stage`) and switches to `Cancel` /
`Save Changes (n)` once editing.
Sections: status bar (trade chip, `aria-label="Stage status"` select when editing,
progress bar), a 3-column overview (Job / `aria-label="Assigned tech"` /
`aria-label="Staged at"` grouped select with groups *Warehouses*, *Job-site
Staging*, *Counter / Shop*, *Trucks / Vans (direct-to-van staging)*),
**Staging attachments (n)**, **Notes**, **Line items (n)** (read mode ->
`Receive +1`; edit mode -> a qty number input), and an **Activity (n)** audit feed.
Rules:
- `photoCount = form.photos?.length ?? 0`;
  `photoBlock = form.status === 'ready_for_pickup' && photoCount === 0`.
  `photoBlock` **disables Email and Save Changes**; the `ready_for_pickup` option
  is `disabled` when `photoCount === 0` and relabels to
  `Ready for pickup — photo required`. Selecting it anyway sets the error
  `Add at least one staging photo before marking this stage Ready for pickup.`
  Banner: *"This stage is marked **Ready for pickup** but has no attachments.
  Upload at least one photo, video, or PDF page before saving or emailing the tech."*
- Save is also disabled when `!isDirty` (`isDirty = pendingAudit.length > 0`),
  `title="No changes to save yet"`.
- Closing while dirty -> `confirm("Discard your unsaved changes?")`.
- Upload caps: 8 MB images, 100 MB videos, 25 MB PDFs ->
  `"{name}" is over {n} MB — skipped.`; non-media ->
  `"{name}" is not an image, video, or PDF — skipped.`; multiple PDFs ->
  `Multiple PDFs selected — only "{x}" will open the page picker. Upload the others separately.`;
  failures -> `Upload failed: {message}`. PDF rendering via pdf.js with a
  `raceTimeout` of 30 s parse / 20 s per page.
Empty copy: *"No attachments yet. Snap a photo, record a short clip, or attach a
PDF (e.g. packing slip) so the tech knows what they're picking up."* (editing) /
`No staging attachments uploaded for this stage.` (read) / `No notes.` /
*"No changes recorded yet. Edits made here are timestamped + logged to the
hash-chain audit log on save."*
Selectors: `aria-label` `Stage status` · `Assigned tech` · `Staged at` ·
`Dismiss` · `Remove attachment` · `Close preview` · `Cancel`;
`role="dialog" aria-label="Attachment preview"`;
`role="dialog" aria-label="PDF page picker"`; titles
`Preview pickup ticket · print · save as PDF`, `Email this pickup ticket`,
`Open preview · then click Save as PDF / Print`, `Preview PO as PDF · print`,
`Remove attachment`, `Take a photo with your camera…`,
`Record a video with your camera…`,
`Upload from your device: photos, videos, or PDFs…`,
`Click Edit Stage to add attachments`, `Play video` / `View full size`.
Opens `POPreviewDialog`, `StagePreviewDialog`, `EmailComposeDialog`.

**`StagePreviewDialog`** - props `{open, onClose, stage, shipToBranchId =
"br_brooklyn_hq", lockEscape?, onSendEmail?}`. Queries `useBranches`,
`useInventoryItems`, `useLocations`, `useVendors`, `useTechs`. No mutations.
Renders a printable "Pickup Ticket" (`.stage-print-root`, injects a scoped
`<style id="stage-print-style">`): branch letterhead, status chip
(`Awaiting parts` / `Partially received` / `Complete · ready to stage` /
`Ready for tech pickup` / `Delivered to job`), Job / Assigned Tech /
Staged-At-or-Pickup-From-Vendor cards, a *"Notes for the picker / driver"* block,
the attachment grid, a **9-column** line table
(`# | SKU | Description | Vendor · PO | UoM | Ordered | Received | Backorder | Status`),
a totals strip (Lines / Units received / Backorder / Est. value at cost), and two
`SignatureField`s: `role="Tech Pickup Sign-out"` and
`role="Warehouse / Counter Manager"`. Footer `Close`, `Email Ticket` (only with
`onSendEmail`), `Save as PDF`, `Print` (both `window.print()`). No validation.

**`StagingAreaPicker`** - props `{parentLocation, value?, onChange, compact?,
className?}`. No queries, no mutations. Trigger button labelled
`value || "Pick a staging area"`, `title={value ? \`Staged in: ${value} (click to
change)\` : "Pick where in the warehouse"}`. When open it renders a **portalled**
panel (`createPortal(..., document.body)`) with `role="listbox"`, `z-[100]` and
viewport-aware positioning (flips above when `spaceBelow < 240`), closing on
outside `mousedown` or Escape. Header `Staging area in {parentLocation.name}` /
`{n} preset(s) configured for this warehouse`; a fixed **Add new staging area**
button opening an inline input (`placeholder="e.g. Mezzanine Bin 4"`, Enter saves,
Escape cancels, `Save` disabled when blank, hint
`Saved areas become presets for every future stage in {name}.`); the preset list
(empty: `No areas configured yet. Use the button above to add one.`); and a pinned
**Clear staging area** action when a value is set. Without a `parentLocation` it
renders `Set a staging location first to pick an area`.
**`saveCustom()` mutates `parentLocation.stagingAreas` in place** with no API call.

**`ApprovalDetailDialog`** - props `{open, onClose, approval, canApprove,
onApprove(id, comment?), onReject(id, comment), onEdit?(id, patch), onEmailSent?}`.
Queries `useInventoryItems`, `useTechs`, `useInventoryJobs`; mutation
`useDecideApproval` (fired in both `handleApprove` and `handleReject`, **in
addition to** the parent's).
`size="xl"`, title `Stock-Out Request · {itemSku}`, subtitle
`Submitted by {tech} on {requestedAt}`, `lockEscape={showEmailDialog || isEditing}`.
Body (`.approval-print-root`, injects `<style id="approval-print-style">`):
status/type strip + `req {id}`; a 3-column grid **Item** (photo, SKU, trade and
category chips, Unit Cost, Vendor) / **Movement Request** (big qty +
`≈ $x value`, From -> To, Serial captured) / **Requested By** (initials avatar,
role, branch, vehicle, Certifications); a **Job Context** row; **Tech's Reason**;
a decision-audit block; a **Modifications** list with `post-decision` chips; the
approval note + `SignatureField role="Approver Signature"`; the rejection
textarea; and the non-approver warning.
`canApprove` consumption:
- footer branch `approval.status === 'pending' && canApprove` decides between the
  **Reject / Approve · post movement** footer and the read-only
  **Close / Email / Save as PDF / Print** footer
- the approval-note + signature block renders only when
  `!isEditing && status === 'pending' && canApprove && mode === 'view'`
- the rejection textarea only when `status === 'pending' && canApprove && mode === 'rejecting'`
- when `status === 'pending' && !canApprove`, a warning renders verbatim:
  *"Your role can view this request but cannot approve it. Ask a warehouse
  manager, inventory admin, or owner."*
`editable = ability.can("manage","Inventory")` (`:160`) gates the Modal
`editAction` **Edit** button, rendered only when
`onEdit && editable && !isEditing && mode === 'view'`.
Validation: Approve is `disabled={!approverSig}` with
`title="Sign the approval block below to enable"` (else
`"Approve and post the stock movement"`) and the hint
``Required: sign above to enable "Approve · post movement".``; the comment is
combined as `` `${note} — Signed by ${fullName} · ${fmtSignedAt(signedAt)}` ``.
Reject requires a reason - `Confirm Reject` is
`disabled={!rejectComment.trim()}`, section header
`Rejection Reason (required)`, placeholder
*"Why are you rejecting this? (the tech sees this)"*. Save Changes is
`disabled={!hasChanges || !qtyValid}` where `qtyValid = !draft || draft.qty > 0`,
titles `No changes to save` / `Quantity must be greater than zero` /
`Save changes` / `Save changes — will be logged as post-decision edit`.
Editable fields: `qty`, `reason`, `jobNumber`, `customer`, `serialCaptured`,
`toLocationName`; the diff summary (`qty 2 → 3`, `dest → X`) becomes the
`ApprovalModification.note` with `postDecision: approval.status !== 'pending'`.
Also has a dead **`Open Job →`** button when `!job && approval.jobNumber`.

**`ApprovalEmailDialog`** - props `{open, onClose, approval, zIndex? (accepted,
not forwarded), lockEscape?, onSent({to, subject, body})}`. Queries `useTechs`,
`useBranches`, `useInventoryItems`. **No mutations - "send" is local**, it calls
`onSent` then `onClose`. `size="lg"`, title
`Email Approval Request · {itemSku}`, subtitle *"Notifies approvers with full
context + a deep link to approve/reject. Prototype: send is mocked."*
Suggested recipients: warehouse leads at the requester's branch
(`{name} (Warehouse Lead · {branch})`), the branch manager,
`Approvals · {branch}` -> `approvals@fieldos.io`, and the requester as FYI;
addresses derived as `first.last@fieldos.io`. Subject
`Stock-Out Approval Needed · {sku}[ · Job {jobNumber}]`; a 14-row prefilled body
containing a deep link `https://fieldos.io/approvals/{id}`; attachment chip
`approval-request-{id}.pdf` / *"Auto-generated from the live request"*.
Validation: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` -> ``"{value}" isn't a valid email address.``;
on send `Add at least one recipient in the To field.` and `Subject is required.`
Footer `Cancel` / `Send Email ({n} recipient(s))`. Chips carry
`aria-label={\`Remove ${email}\`}`; the input placeholder is `Type email + Enter…`;
Enter / `,` / `;` commit, Backspace on empty removes the last.

**`NewApprovalRequestDialog`** - props `{open, onClose, locations,
onSubmit?(request), onEmailSent?}`. Queries `useInventoryItems`,
`useInventoryJobs`, `useTechs`; mutation `useCreateApproval` (fired inside
`persist()`). `size="xl"`, title `New Stock-Out Approval Request`, subtitle
*"Submit on behalf of a field tech — the request lands in the queue at the top,
pending sign-off."*, `lockEscape={showScan || !!pendingEmail}`.
**Action Type** 4-button grid: `Consume on Job` (Briefcase, *"Tech installs the
part at a customer site — depletes the tech's van stock."*, `needsJob`),
`Transfer to Van` (Truck, `needsTo`, default), `Return to Warehouse` (Undo2,
`needsTo`), `Write-off` (Trash2). Then **Requested By (Tech)**
(`aria-label="Requested by (tech)"`, only `field_tech`/`subcontractor`, default
`tech_carlos`), **Item** (`aria-label="Item"`, materials only) plus a **Scan**
button (`aria-label="Scan to find item"`,
`title="Scan barcode / QR / phone camera to find item"`) opening a nested
`ScanDialog pickerMode`, **Quantity ({uom})** (autoFocus), **From Location**
(`aria-label="From location"`, default `loc_wh_main`), **To Location**
(`aria-label="To location"`, default `loc_van_carlos`, only when `opt.needsTo`),
**Linked Job** (`aria-label="Linked job"`, only when `opt.needsJob`), a **Reason**
textarea with a type-dependent placeholder, and a **Preview** strip.
Validation: `Pick a requester tech.` · `Pick an item.` · `Quantity must be > 0.` ·
`Pick a destination location.` · `Pick a job for consume.` · `Reason is required.`
Footer: `Cancel`; **`Submit + Email Team`**
(`title="Submit the request AND email the approval team (logistics manager · admin · owner) with full context"`)
-> persists then opens `ApprovalEmailDialog`; **`Submit for Approval`** ->
persist + reset + close.

**`EstimateComparisonDialog`** - props `{open, onClose, lines: RFQLine[], zIndex?
(ignored), lockEscape?, onPickWinner(quote)}`. Queries `useInventoryItems`,
`useVendors`. **No mutations** - quotes are generated client-side by
`generateQuotes(lines, items, vendors)` from `@/lib/inventory/rfq-mock`.
`size="xl"`, title `Estimate Comparison · {n} vendor(s)`, subtitle
*"RFQ on {n} item(s) · ranked by composite score (60% price · 25% lead · 15%
reliability)"*. Empty: `Add at least one line item to request quotes.`
Sections: a Recommended banner (crown, total, `{n}-day lead`, star rating,
`({n} past jobs)`); a 3-up quote card grid with rank chip `#n`, total,
`Cheapest` badge or `+X% vs cheapest`, `Fastest`, `Top-rated`, notes, a 4-column
line table (`Item | Qty | Unit | Ext`) with `BO` chips for out-of-stock, and a CTA
**`Use This Vendor (Recommended)`** or **`Use {FirstWord} Anyway`** ->
`onPickWinner(q)`; a "How we ranked these" explainer
(`composite = price_score × 0.6 + lead_score × 0.25 + reliability_score × 0.15`);
and an "RFQ Sent To {n} Vendors" preview (first 4 + `+n more…`).
Footer `Cancel` / **`Use Recommended · {winner.vendor.name}`** (`disabled={!winner}`).
Reached from `CreateStageDialog`'s **Get 3 Estimates** and from
`PrePODetailDialog` - where its `onPickWinner` is a **no-op that only closes**.

### 3.11 Writes that never reach the server (Staging / Approvals)

These four look like saves but are local `useState` only. A v2 build must
reproduce the illusion exactly:

- `StagingView.setStagedArea` - the staging area **and** its audit entry
- `StagingAreaPicker.saveCustom` - mutates `parentLocation.stagingAreas` in place
- `StageDetailDialog` save - `onSave` fires no mutation
- `ApprovalsView.applyEdit` - post-decision edits

Dead controls: `StagingView`'s `Open Job →` and `ApprovalDetailDialog`'s
`Open Job →` both have no handler.

---

## 4. `/inventory/price-book` - `PriceBookPage.tsx` (1,501 lines)

Route element is `InventoryPriceBookPage` (`App.tsx:60`). There is a **second,
unrelated** `PriceBookPage` at `frontend/src/pages/PriceBookPage.tsx` on route
`/price-book` - out of scope for this module, do not confuse them.

**This page fires zero write requests.** No mutation hook is imported. Every
create/edit/delete/toggle mutates local state only.

### 4.1 Component tree

```
Header (border-b bg-white px-6 py-4)
  breadcrumb "Operations" > "Inventory" > "Price Book"
  h1 (Tag icon) "Price Book"
  p  "Customer-facing pricing catalog · brands · groups · categories…"
  <Tabs value={tab} onValueChange>
    <TabsList> 5 x TabsTrigger: items(Package) brands(Tag) groups(Layers) categories(List) catalog(ImageIcon)
  NOTE: TabsList/TabsTrigger only - there is NO <TabsContent>. The body is
  rendered outside <Tabs> via `tab === '…' &&` conditionals.
Body (flex-1 overflow-y-auto bg-background-light px-6 py-5)
  ItemsTab | BrandsTab | GroupsTab | CategoriesTab | CatalogPhaseBPlaceholder
Dialogs at page root, always mounted:
  AddBrandDialog · AddGroupDialog · AddCategoryDialog · AddItemDialog
```

Tab state is local `useState`, not in the URL. Six GETs fire on mount: the five
listed below plus `useLocations()` from the always-mounted `AddItemDialog`.

```ts
const { data: seedBrands     = [] } = useBrands();      // ['inventory','brands']
const { data: seedGroups     = [] } = useItemGroups();  // ['inventory','item-groups']
const { data: seedItems      = [] } = useInventoryItems(); // ['inventory','items']
const { data: seedVendors    = [] } = useVendors();     // ['inventory','vendors']
const { data: seedCategories = [] } = useCategories();  // ['inventory','categories']
```

`isLoading` / `isError` are never destructured.

### 4.2 Items tab

1. `grid grid-cols-4` of four **clickable** `KPITile`s (a local component, not the
   shared `KpiTile`). Each is a `<button type="button" aria-pressed={active}
   aria-label={...} title={same}>` and shows a `filtered` pill plus
   `ring-2 ring-primary` when active. The four filters are **mutually exclusive**:
   activating any one clears the other two dimensions.

| Tile | `aria-label` | Handler |
|---|---|---|
| In Catalog | `Show only items currently in the customer-facing catalog` | toggle `filterVisibility` `catalog` <-> `all`, clearing `filterPhoto` + `filterPrice` |
| Hidden from Catalog | `Show only items hidden from the customer-facing catalog` | toggle `filterVisibility` `internal_only` <-> `all`, same clearing |
| With Photo | `Show only items that already have a product photo` | toggle `filterPhoto` `with` <-> `all`, clearing visibility + price |
| No Price Set | `Show only items missing both list price and sell price` | toggle `filterPrice` `missing` <-> `all`, clearing visibility + photo |

The "With Photo" hint computes `Math.round((withPhoto / Math.max(totalCount,1)) * 100)`
`% complete` - the `Math.max(...,1)` guard is what stops a `NaN` on an empty catalog.

2. Filter row: search input `Search price book…` (matches
   `` `${name} ${customerName ?? ""} ${sku}` `` lowercased), then three
   `FilterSelect`s (a wrapper over the shared `SelectField`, which forwards
   `aria-label` to the `SelectTrigger`):
   - `aria-label="Brand"` - `all` -> `""`; options keyed by `b.id`
   - `aria-label="Category"` - options keyed by **`c.name`**, not id
   - `aria-label="Visibility"` - `all` / `catalog` ("🌐 Catalog only") /
     `internal_only` ("🔒 Internal only"); setting anything but `all` also clears
     `filterPhoto` and `filterPrice`
   Right side: `{items.length} of {totalCount} items` + an **Add Item** button ->
   `setShowAddItem(true)`.

3. `<ResizableTable>` with six columns: `photo | item | brand | category | price |
   visibility`. **No column declares `sortValue`, so nothing is sortable.** Column
   resize handles carry `role="separator" aria-orientation="vertical"`; drag to
   resize, double-click to reset.
   - Row click -> `onEditItem(it)` -> `setEditingItem(it)` -> `AddItemDialog` in
     edit mode.
   - The `visibility` cell is a pill **button** with `stopPropagation` ->
     `onToggleVisibility(it.id)`, flipping `catalog` <-> `internal_only` in local
     state. `title` is `Visible to customers — click to hide` or
     `Internal only — click to publish to catalog`.
   - Price cell falls back to `<span class="text-xs text-warning">No price</span>`
     when both `listPrice` and `sellPrice` are falsy. Brand cell falls back to `—`.
     Photo cell falls back to an `ImageIcon` tile.
   - Empty: `ResizableTable`'s `empty="No items match the active filters."` ->
     one `<td colSpan={cols.length} class="px-4 py-12 text-center …">`.

### 4.3 Brands / Groups / Categories / Catalog tabs

**BrandsTab** - toolbar `{n} brand(s) configured` + **Add Brand**; a
`sm:2 lg:3` grid of cards (logo or a 2-letter monogram, name, `Inactive` pill,
description, Items count chip, default-markup line, website link via
`safeHref` with `target="_blank" rel="noopener noreferrer"`). Edit/Delete buttons
are hover-revealed (`opacity-0 group-hover:opacity-100`) but always in the DOM and
tab order; `title="Edit brand"` / `title="Delete brand"`. Delete is guarded:
if `itemsByBrand.get(id) > 0` a **native `alert()`**
``Can't delete this brand — {n} item(s) still reference it. Re-assign first.``
and return; otherwise a native
`confirm("Delete this brand? This can't be undone.")`. **No empty state** - zero
brands renders `0 brands configured` and a blank grid.

**GroupsTab** - explanation banner, then a filter row (search `Search bundles…`
matching `` `${name} ${description ?? ""}` ``, a `FilterSelect
aria-label="Bundle format"` with `all` / `individual` ("Individual items") /
`flat_rate` ("Flat rate"), a count, and **New Bundle**). Cards show a 2:1 hero,
format chip, `Inactive` chip, hover Edit/Delete
(`aria-label={\`Edit ${g.name}\`}` / `` `Delete ${g.name}` ``,
`title="Edit bundle"` / `"Delete bundle"`), name/description, the first three
lines plus `+N more…`, and a "Customer sees" price + Margin.
Delete is a native ``confirm(`Delete bundle "${g.name}"? Estimates already saved with this bundle are unaffected.`)``
with **no reference guard**.
Empty state (dashed card, `Layers` icon, `No bundles yet`, copy
"Create your first preset bundle. Standard rekey jobs, lockout service, HVAC
capacitor swap — bundle them once and reuse on every estimate.", plus a second
**New Bundle**) is keyed on the **filtered** list, so it also fires when a search
simply matches nothing - the copy is wrong in that case. Preserve as is.

**CategoriesTab** - toolbar `{n} categor(y|ies) · cross-brand part-type axis…` +
**Add Category**; grid of cards (2:1 hero or a `List` icon, hover Edit/Delete with
`aria-label={\`Edit ${c.name}\`}` / `` `Delete ${c.name}` ``, name, trade chip via
`TRADE_TONE`, description, Items count). Delete is guarded on
`itemsByCategoryName.get(c.name)` with a native `alert()`
``Can't delete "{name}" — {n} item(s) still in this category. Re-categorize them first.``
then a native confirm. **No empty state.**

**CatalogPhaseBPlaceholder** - a static `role="status"` card:
`Catalog view ships in Phase B`, a "Coming next" list of four bullets, and two
pills (`Owner: Emanuel`, `Phase A → B transition`). **Zero interactive elements.**

**There are no toasts on this page.** All feedback is native `alert()` /
`confirm()` or an inline error banner inside a dialog.

### 4.4 Price Book dialogs (no zod, imperative validation)

All four wrap `Modal`. Errors render as one banner:
`<div class="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>`.

| Dialog | Size / title | Fields | Validation | Submit |
|---|---|---|---|---|
| `AddBrandDialog` | `md`, `Add New Brand` / `` `Edit Brand · ${name}` `` | name, logoUrl, website, description, defaultMarkupPct, defaultVendorId (`SelectField aria-label="Default vendor"`, sentinel `NONE` -> `"— none —"`), isActive | `"Brand name is required."`; markup must be a finite `>= 0` number -> `"Default markup must be a number (e.g. 1.4 = 40% markup over cost)."`; logo MIME in `png/jpeg/svg+xml/webp` -> `"Logo must be PNG, JPG, SVG, or WebP."`; `> 512 KB` -> `` `Logo is too large (${KB} KB). Max 512 KB.` ``; read failure -> `"Couldn't read the file. Try a different image."` | `onCreate({id: \`brd_new_${Date.now()}\`, …})` or `onUpdate` -> local state only |
| `AddCategoryDialog` | `md`, `Add New Category` / `` `Edit Category · ${name}` `` | name, description, trade (`SelectField aria-label="Trade"`, `""` shown as sentinel `NONE` -> `"— none —"`), photoUrl (2:1 hero, `aria-label="Upload category photo"` / `"Replace category photo"`) | `"Category name is required."`; photo MIME/512 KB -> `"Category photo must be PNG, JPG, SVG, or WebP."` | `id: \`cat_new_${Date.now()}\``. On the Price Book page `onUpdate` also **rewrites every item whose `category === oldName`** to the new name. |
| `AddGroupDialog` | `xl`, `Create Bundle` / `` `Edit Bundle · ${name}` `` | name, description, photoUrl (4:1), groupType (`individual` default / `flat_rate`), flatRatePriceOverride, isActive, `lines: ItemGroupLine[]` | in order: `"Bundle name is required."`, `"Add at least one line to the bundle."`, `"Free-form lines need a name."`, `` `Quantity must be greater than 0 (line "${name \|\| "—"}").` ``, `"Flat-rate price must be a positive number."`; photo -> `"Bundle photo must be PNG, JPG, SVG, or WebP."` | `id: editGroup?.id ?? \`grp_new_${Date.now()}\`` |
| `AddItemDialog` | `xl`, `Add Item to Price Book + Inventory` / `` `Edit Item · ${sku}` ``, `lockEscape` while a nested dialog is open | see below | only `"Name is required."`; photo must be `image/*` -> `"Photo must be an image (jpg, png, webp, heic)."`, `< 10 MB` -> `"Photo must be under 10 MB."` | `onSave(payload, editItem?.id)` |

`AddGroupDialog` specifics: an item picker (search input opening a dropdown of the
first 8 matches on `` `${name} ${customerName ?? ""} ${sku}` ``; empty ->
`No items match — try a different search or click "Free-form line"`), a
**Free-form line** button (`title="Add a one-off line that isn't a Price Book item"`),
two `GroupTypeOption` buttons (`Individual items` / `Flat rate`), a lines table
`Item | Qty | Price | Cost | Margin | Amount | (remove)` with per-row
`aria-label="Remove line"` and a `FREE-FORM` badge, empty copy
`No lines yet — search above to add Price Book items, or click "Free-form line" for one-off charges.`,
and a `<tfoot>` with Subtotal and "Customer sees (flat rate|itemized)".
Pricing math, duplicated between the dialog and `GroupsTab`:
`linePrice = priceOverride ?? item.listPrice ?? item.sellPrice ?? 0`;
`lineCost = costOverride ?? item.unitCost ?? 0`;
`lineMarginPct` returns `null` when price <= 0, `100` when cost <= 0, else
`((p-c)/p)*100`.

`AddItemDialog` specifics (shared with `InventoryPage`):

```ts
export type NewItem = { sku; name; category; trade; kind; uom; unitCost:number;
  sellPrice:number; serialized:boolean; hazmat:boolean; vendor:string; photoUrl?;
  brandId?; visibility?: ItemVisibility;
  startingStock: { locationId:string; qty:number; min?:number; max?:number }[] }
```

- `kindOpts = ["material","service","labor","bundle","fee"]`,
  `uomOpts = ["EA","FT","HR","ROLL","KIT","CYL","BX"]`.
- Photo dropzone (drag-and-drop + hidden file input) plus **Upload**, **Camera**
  (`capture="environment"`) and a remove X (`aria-label="Remove photo"`).
- **Suggest** SKU button -> `buildSuggestedSku()` -> `ITM-{first 3 words, 4 chars each}-{100..999}`.
- `SelectField aria-label="Vendor / Source"` with sentinels `NONE` ->
  `"Select vendor…"`, `__separator__` (disabled), `__add_new__` ->
  `"+ Add new vendor…"` which opens a nested `AddVendorDialog`; plus a `+` button
  `aria-label="Add new vendor"`. Same pattern for `aria-label="Category"` with
  `aria-label="Add new category"`.
- `aria-label="Item kind"` - **changing kind re-defaults `visibility` via
  `defaultVisibilityForKind(kind)`**.
- `aria-label="Brand"` (only `b.isActive !== false`) - **picking a brand
  auto-fills `vendorId` from `brand.defaultVendorId` only when `vendorId` is
  currently empty**.
- Live GM badge `{margin}% GM` - success `> 30`, warning `> 0`, else danger.
- **Starting Stock block renders only when `!isEdit`**:
  `aria-label="Starting stock location"` (from `useLocations()`), Starting Qty,
  `Min · Reserve`, `Max · Reorder Cap`.
- Coercions on submit: SKU falls back to `buildSuggestedSku()`, category to
  `"Uncategorized"`, costs via `parseFloat(x || "0")`, `startingStock` is `[]`
  unless one of qty/min/max is filled.

Price Book's own `onSave` edit branch never touches `listPrice` or
`customerName`, so an edited item's Price column (which prefers `listPrice`) will
not reflect a new `sellPrice`. It also returns without clearing `showAddItem`.

`AddVendorDialog` reached from here is passed **no** `existingCategories`, so its
`VendorCategoryPicker` gets `[]`. Full detail in section 6.6.

---

## 5. `/inventory/purchase-orders` - `PurchaseOrdersPage.tsx` (1,298 lines)

**No permission check of any kind on this page.** No `useAppAbility`, no role
read, no `useFeature`.

### 5.1 Hard-coded scaffold constants (must be carried over verbatim)

- `const TODAY = new Date("2026-05-28T00:00:00Z")` (`:91`) - "late" and "arriving
  this week" are computed against a **frozen date**, not `Date.now()`.
- `poTotal(po) = po.lines.reduce((sum, l) => sum + l.qtyOrdered * 50, 0)`
  (`:112-118`) - a flat **$50/unit placeholder** that drives the Total column on
  Open + History and the "Open spend" KPI.
- History "Received on" fakes `receivedAt` as `p.expectedDate ?? p.orderedAt` (`:1063`).
- History "Variance" is a literal `—` plus a bare `i` with
  `title="Three-way match ships in §7.4"` (`:1093-1097`).
- `UNIT_COST_FALLBACK = 50` in `PODetailDialog` (`:85`).
- `PODetailDialog` tax line: `Tax (8.875% NYC)` = `subtotal * 0.08875`.
- `handleReceive` toast says "stock bumped at the warehouse" from a hard-coded
  `const warehouseName = "the warehouse"` (`:382`).

### 5.2 Component tree

```
Header (border-b bg-white px-6 py-4)
  breadcrumb "Operations" > "Inventory" > "Purchase Orders"
  h1 "Purchase Orders"
  p  "Track every order from quote to receipt. Pre-PO quotes · open orders with vendors · received history."
  [Create PO] (Plus)
  grid-cols-2 lg:grid-cols-4 -> 4 x KPITile (local component)
Tab strip (<Tabs value={tab}>): Pre-PO(ClipboardList) · Open(PackageOpen) · History(PackageCheck), each with a count
Toolbar: search "Search purchase orders…" · FilterSelect "All vendors" · FilterSelect "All trades" · [Clear KPI filter ×]
Body: PrePOTable | OpenTable | HistoryTable
Dialogs: PODetailDialog · POPreviewDialog · POEmailDialog · PrePODetailDialog · NewPODialog
Toast: fixed bottom-6 left-1/2 z-[90]
```

### 5.3 KPI tiles and the tab/KPI interaction

`handleKPIClick(key)` (`:163-171`):
- if `activeKPI === key` -> `setActiveKPI(null)` and **return** (tab unchanged)
- else `setActiveKPI(key)`; `"prepo"` -> `setTabRaw("pre-po")`, otherwise
  `setTabRaw("open")` - deliberately using `setTabRaw`, which does **not** clear
  the KPI

| Tile | Value | Tone | Filters rows? |
|---|---|---|---|
| `Pre-PO pending` (ClipboardList) | `kpiPrePOPending` | amber | no - navigation only |
| `Open POs` (ShoppingCart), hint `` `${fmtMoney(kpiOpenSpend)} in flight · click to view` `` | `kpiOpenCount` | primary | no - navigation only |
| `Late` (AlertTriangle) | `kpiLate` | rose | **yes** - `filteredOpen.filter(isLate)` |
| `Arriving this week` (CalendarClock) | `kpiArrivingThisWeek` | sky | **yes** - `filteredOpen.filter(isArrivingThisWeek)` |

Clicking a **tab trigger** calls `setTab(next)` = `setTabRaw(next)` **plus**
`setActiveKPI(null)` - manual tab nav always clears the KPI filter.
`Clear KPI filter ×` (`title="Click the lit KPI tile again, or use this button, to clear the filter"`)
-> `setActiveKPI(null)`.

### 5.4 Derived data

- `draftPOs` = status `draft`; `openPOs` = `sent | partial`;
  `historyPOs` = `received | closed`.
- `prePORows` = RFQs ∪ draft POs ∪ estimate reservations, sorted **oldest first**
  (`prePOAge(b) - prePOAge(a)`).
- `isLate(po)` = has `expectedDate`, status not received/closed,
  `expectedDate < TODAY`.
- `isArrivingThisWeek(po)` = has `expectedDate`, status not received/closed,
  `TODAY <= expectedDate <= TODAY + 7d`.
- Vendor filter options = union of `allPOs[].vendor`, every `rfq.quotes[].vendor`
  and every `reservation.preferredVendor`, sorted.
- `trades` is hard-coded `["locksmith","door","security","hvac","plumbing","multi"]` (`:313`).
- `OpenTable` sorts late-first then `expectedDate` ASC; `HistoryTable` sorts
  `orderedAt` DESC.

### 5.5 Tables and every interactive element

`ResizableTable` again, and again **no column declares `sortValue`**, so nothing
is click-sortable; both pages pre-sort. Neither page passes `empty`, so both
short-circuit to their own `<EmptyState>` before rendering the table.

**PrePOTable** (`getRowKey = r.kind + "_" + r.data.id`) columns:
`type` (TypeChip RFQ / Draft / Est. Reservation) · `ref` · `vendor` (for an RFQ in
`awaiting_quotes`: `{n}/3 quotes received` in warning; else Crown + winner +
`+2 more quoted`) · `job` · `lines` · `total` · `age` (`{n}d ago`, danger `>7`,
warning `>3`) · `next`.
Row click -> `handlePrePOClick(r)`: `kind==='draft'` -> `setDetailPO(r.data)`
(PODetailDialog); `kind==='rfq'|'reservation'` -> `setPrePOActive(r)`
(PrePODetailDialog).
`NextActionButton` labels (`Compare quotes →` / `Send to vendor →` /
`Convert to PO →`) are **cosmetic** - all three `stopPropagation` then call the
same `onRowClick(r)`.

**OpenTable** columns: `status` (StatusPill) · `po` · `vendor` (Truck) · `job` ·
`ordered` · `expected` (late -> danger + dot; soon -> warning) · `lines` ·
`total` · `received` (progress bar + `{rec}/{ord}`, `bg-success` at 100% else
`bg-warning`) · `actions`.
Row click -> `setDetailPO(p)`. `RowActions` are three `IconBtn`s with
`stopPropagation`: `title="Preview PO"` (Eye) -> `setPreviewPO(p)`;
`title="Email PO"` (Mail) -> `setEmailPO(p)`; `title="Receive items"`
(PackageCheck) -> **`setDetailPO(p)`, the same as a row click** - it does not jump
into receive mode.

**HistoryTable** columns: `status` · `po` (the cell is a **button**,
`title="Preview PO document"`, `stopPropagation` -> `setPreviewPO(p)`) · `vendor`
· `job` · `ordered` · `received-on` · `lead` (`{n}d`) · `total` · `variance` (stub).

`StatusPill` map: `draft->Draft`, `sent->Sent`, `partial->Partial`,
`received->Received`, `closed->Closed`.

### 5.6 Handlers

| Handler | API | Local | Toast |
|---|---|---|---|
| `handleCreatePO(po)` (`:329`) | `createPO.mutate(po)` -> `POST /api/inventory/purchase-orders`, invalidates `['inventory']` | unshift into `allPOs`, `setTab("pre-po")` (also clears activeKPI) | `` `${po.poNumber} saved as draft` ``, cleared after **2500 ms** |
| `handleReceive(event)` (`:345`) | `receivePO.mutate(event)` -> `POST /api/inventory/purchase-orders/receive` | optimistic: per line `Math.max(0, Math.min(next, qtyOrdered))`, accumulate delta, re-derive status via `derivePOStatus`, `setAllPOs` + `setDetailPO(updatedPO)` | `` `✓ ${poNumber} updated · +${delta} units received · stock bumped at the warehouse` ``, cleared after **4500 ms** |
| `handleConvertReservationToPO(res)` (`:401`) | via `handleCreatePO` | `reservationToDraftPO(res, allPOs)` then `setPrePOActive(null)` | inherits the create toast |

`ReceiveSubmit = { poId: string; lines: { itemSku: string; qtyReceived: number }[] }`.

Five re-seed effects (`:204-218`) mean the optimistic `allPOs` write is
overwritten by the refetch that the mutation's own invalidation triggers.

### 5.7 Empty states

`<EmptyState tab>` (`:1163-1189`), rendered instead of the table:

| tab | heading | body |
|---|---|---|
| `pre-po` | `No quotes or drafts in flight` | `Start a 3-vendor RFQ from any job or hit "+ Create PO" to draft one manually.` |
| `open` | `No open POs` | `Everything you've sent has been received or closed. Quiet day at the dock.` |
| `history` | `No closed POs yet` | `Received and closed POs will land here for audit + lead-time analysis.` |

No loading skeleton, no error state.

---

## 6. `/inventory/vendors` - `VendorsPage.tsx` (784 lines)

`export function VendorsPage()` plus `export default VendorsPage`.

### 6.1 Permission gating (exact)

```ts
const ability = useAppAbility();            // :76
const editable = ability.can("manage", "Inventory");   // :77
```

`editable` gates **only** the "Add Vendor" header button
(`{editable && (<button onClick={() => setShowAdd(true)}>…)}`, `:210-218`).

Not gated: the search/filter row, `CategoryManagerDropdown` (add/rename
categories), all three tab views, all vendor cards, the analytics leaderboard, and
opening `VendorDetailDialog`. `VendorDetailDialog` re-derives the identical gate
at `:206-207` for its own Edit / Archive / Delete actions.

### 6.2 Component tree

```
Header: breadcrumb "Operations" > "Inventory" > "Vendors" · h1 "Vendors"
  p "Master vendor list · spend tracking · purchasing power. …ammunition for negotiation."
  {editable && [Add Vendor]}
  3 x KPITile (local <button aria-label aria-pressed title>)
<Tabs value={tab}>
  TabsList: Directory(Building2) · By Category(Layers) · Spend Analytics(BarChart3), each + TabCount
  Filter row (shared by all three tabs):
    search "Search vendors…" · <CategoryManagerDropdown> · segmented [all|active|inactive] · "{n} of {m} vendors"
  TabsContent directory  -> <DirectoryView>
  TabsContent category   -> <ByCategoryView>
  TabsContent analytics  -> <AnalyticsView>
Dialogs: AddVendorDialog · VendorDetailDialog · DeleteVendorDialog
Toast: fixed bottom-6 right-6 z-[60], cleared after 3500 ms
```

KPI tiles:

| Tile | Value | `aria-label` | Click | `active` when |
|---|---|---|---|---|
| Active Vendors (Users, primary), hint `` `of ${vendors.length} total · click to show only active` `` | `activeCount` | `Show only active vendors in the Directory` | `setTab("directory")` + `setStatusFilter("active")` | `tab==='directory' && statusFilter==='active'` |
| Total Spend YTD (DollarSign, emerald), hint `across all vendors · click for spend leaderboard` | `fmtMoneyFull(totalYTD)` | `Open the Spend Analytics view` | `setTab("analytics")` | `tab==='analytics'` |
| Categories (Layers, sky), hint `distinct vendor types · click to group by category` | `categories.length` | `Open the By Category view` | `setTab("category")` | `tab==='category'` |

### 6.3 Views and filtering

`filtered` (`:128-147`), in order:
1. `statusFilter !== 'all' && (v.status ?? 'active') !== statusFilter` -> drop
2. `categoryFilter !== 'all' && v.category !== categoryFilter` -> drop
3. lowercased search must hit `name | contactPersonName | accountNumber | contactEmail | category`

`categories` = `Set(vendors[].category) ∪ extraCategories`, sorted.
`spendIndex = computeAllVendorSpend(vendors, purchaseOrders, allItems)`,
`totalYTD = totalSpendYTD(spendIndex)`, `top = topVendorByYTD(spendIndex)`,
`topShareOfYTD = top ? top.ytd / Math.max(totalYTD, 1) : 0`.

- **DirectoryView** - `grid-cols-1 md:2 lg:3` of `VendorCard`; card click ->
  `setOpenVendorId(v.id)`. **Any vendor with no `spendIndex.get(v.name)` entry is
  silently skipped (`if (!spend) return null`)** - the index is keyed by vendor
  **name**.
- **ByCategoryView** - groups `filtered` by `v.category`, sorted
  `a[0].localeCompare(b[0])`; per group a `<section>` with the category name, a
  count pill and a right-aligned `${fmtMoney(catYTD)} YTD`, then the same card
  grid. Same skip-on-missing-spend behaviour.
- **AnalyticsView** - a single card: strip `Spend leaderboard · YTD`, then a
  `ResizableTable` over `ranked` (`filtered` joined to spend, `.filter(r => !!r.spend)`,
  sorted `b.spend.ytd - a.spend.ytd`), row click -> `onOpen(r.vendor.id)`.
  Columns: `rank` (index 0 renders an Award icon + "1") · `vendor` (name +
  `contactPersonName`) · `category` · `ytd` (`fmtMoneyFull`) · `share` (bar scaled
  to `top.spend.ytd`, `Math.max(2, …)`, + `{pct}%`) · `mom` (only when
  `spend.lastMonth > 0`; TrendingUp/Down + `|momDeltaPct*100|%`, else `—`) ·
  `pos` · `last` (`fmtRelativeDate`). Footer blurb: "Purchasing power = your share
  of total inventory spend. …". Note `ranked.indexOf(r)` inside the rank cell is
  O(n) per row.

All three views share the same empty card copy: **`No vendors match your filters.`**
(Directory adds a Truck icon.) Because the queries default to `[]`, the initial
loading frame shows these cards and `Total Spend YTD` reads `$0`.

### 6.4 Handlers

| Handler | Local | Mutation | Toast |
|---|---|---|---|
| `handleAdd(v)` `:154` | unshift | `upsertVendor.mutate(v)` | `` `🏷 Vendor "${v.name}" added` `` |
| `handleSave(id, patch)` `:160` | merge by id | `upsertVendor.mutate({id, ...patch})` | `` `✏️ ${before?.name ?? "Vendor"} updated` `` |
| `handleDelete(id)` `:167` | filter out, `setOpenVendorId(null)` | `deleteVendor.mutate({id})` | `` `🗑 Vendor "${name}" deleted` `` |
| `handleArchiveToggle(v)` `:175` | flip `status` | `upsertVendor.mutate({id, status: next})` | `` `📦 Archived ${name} · still on historical POs` `` / `` `✓ Reactivated ${name}` `` |
| `handleAddCategory(name)` `:103` | `setExtraCategories` (case-insensitive dedupe) | **none** | `` `🏷 Category "${name}" added` `` |
| `handleRenameCategory(old, new)` `:112` | cascade-renames `v.category` on every matching vendor **locally**, updates `extraCategories` | **none - no `upsertVendor.mutate`** | `` `✏️ Category renamed: "${old}" → "${new}"` `` |

The category rename is therefore purely cosmetic and is wiped by the
`useEffect([seedVendors])` resync at `:57-59`. The file's own comment (`:91-95`)
acknowledges categories live in component state in v1.

---

## 7. Cross-page dialog reference

### 7.1 `InventoryModal` (`components/inventory/InventoryModal.tsx`)

Props `{open, onClose, title, subtitle, size: 'sm'|'md'|'lg'|'xl', footer,
lockEscape, editAction, children}`. Sizes ->
`max-w-md / max-w-lg / max-w-2xl / max-w-4xl`, plus
`max-h-[90vh] overflow-y-auto`. `lockEscape` preventDefaults `onEscapeKeyDown`.
`editAction` renders an outline Button in the header. Several call sites pass a
`zIndex` prop that is **accepted and deliberately ignored**
(`POPreviewDialog:80` does `void zIndex;`; `PODetailDialog` and
`EstimateComparisonDialog` do the same).

### 7.2 `ResizableTable` (`components/ui/ResizableTable.tsx`)

Column shape `{id, header, cell, width, min, grow, align, headerClassName,
cellClassName, sortValue?, footer?}`. Built-in click-to-sort exists **only** when
`sortValue` is supplied - and no inventory page supplies it on any column.
Resize handles are `role="separator" aria-orientation="vertical"`; drag resizes,
double-click resets to the declared width. Renders the `empty` prop only if
passed.

### 7.3 `NewPODialog`

`Modal size="xl"`, title `Create Purchase Order`, subtitle `Saves as a draft on
the Pre-PO tab. Send to the vendor from PO Detail when you're ready.`
Footer: **Cancel** / **Save Draft PO**. **No API call** - the parent persists.

- Vendor `SelectField aria-label="Vendor"`, sentinel `NONE` -> `— pick a vendor —`,
  options `vendors.filter(v => v.status !== 'inactive')` sorted by name.
- Expected Delivery `<input type="date">`.
- `<fieldset>` legend **Job Link (optional)** with a typeahead
  (`Find a job by # · customer · site…`). Empty query -> jobs with
  `status === 'scheduled' || 'in_progress'` sorted by `scheduledFor` ASC,
  `.slice(0,6)`, header `Open jobs · closest first`; non-empty -> substring match
  on `` `${jobNumber} ${customer} ${site} ${trade}` ``. No match ->
  `No matching jobs. Fill in the fields below to record a custom job link.`
  Outside-click closes via a mousedown listener on `jobBoxRef`.
  `pickJob(j)` **auto-fills lines** only when `lines.length === 1 && !itemId &&
  (qty === '' || qty === '1')`, preferring a matching `reservation` over an `rfq`,
  resolving `itemSku` against non-discontinued items and silently dropping
  unmatched SKUs; it primes `vendorName` from `reservation.preferredVendor` or the
  RFQ's recommended quote when empty. Linked state shows a green pill with an
  **Unlink** button (`title="Unlink job and clear the fields below"`).
  Grid: `Job #` (`J-1870`), `Customer` (`Equinox Hudson Yards`), `Trade`
  (`SelectField aria-label="Trade"`, sentinel `NONE`), then `Site / Notes`.
- Amber existing-PO callout when the linked job already has `draft|sent|partial`
  POs: `This job already has {n} open PO(s) — review before adding lines`.
- **Line Items** table `Item | Qty | UoM | ⋯` with **Add line**, an
  `autoFillSource` banner (`Auto-filled {n} line(s) from {label}` plus a **Clear**
  with `title="Clear all auto-filled lines and start fresh"`), an `ItemPicker`
  button that opens a nested `ItemSearchModal`, `<input type="number" min="1"
  step="1">`, a read-only UoM, and a delete button `aria-label="Remove line"`
  disabled at one row (`title="At least one line is required"` /
  `"Remove this line item"`).
- `ItemSearchModal` (`Modal size="lg"`, title `Pick an item`): autofocused search
  matching `name sku mpn category`, category chips (`All · {n}` + `{name} · {count}`),
  a `Showing {x} of {y} items` strip + **Clear filters**, and a `max-h-[24rem]`
  list split into sticky `{vendorName} catalog · {n}` and `Cross-vendor · {n}`
  groups. Empty: `No items match the current filters.` Footer:
  **+ Add a new item** (only with `onRequestAddNew`) and **Cancel**.
- Validation (`:372-412`): `Pick a vendor.` · `Every line needs an item picked.` ·
  `` `Quantity for "${it.name}" must be greater than 0.` `` ·
  `Add at least one line item.` (unreachable - `lines` always has >= 1 row).
- Built object: `id: \`po_new_${Date.now()}\``,
  `poNumber: nextPONumber(existingPOs)` (scans `/PO-(\d+)/`, starts from
  `max = 2300`, returns `PO-{max+1}`), `status: 'draft'`, `orderedAt: now ISO`,
  lines with `qtyReceived: 0`.
- Full reset `useEffect` on `[open]` (`:131-145`).

### 7.4 `PODetailDialog`

`Modal size="xl"`, title `` `${po.poNumber} · ${po.vendor}` ``, subtitle = the
job/customer/site line or `No job link`. No API call of its own.
Header summary card: status pill, Truck + vendor, trade pill,
`Ordered {date}` -> ChevronRight -> `Expected {date}`.

Inner tabs: `Lines` (count) · `Activity` · `Documents` · `3-Way Match`, default
`lines`.

- **Lines**: `# | SKU | Description | UoM | Ordered | Received | Unit $ | Ext.`,
  `tfoot` Subtotal / `Tax (8.875% NYC)` / Total.
- **Receive mode**: green strip with **Reset** (RotateCcw -> all lines back to
  `qtyReceived`) and **Receive all** (-> all to `qtyOrdered`); per-row number input
  clamped `Math.max(0, Math.min(qtyOrdered, parseInt(...)||0))`; a **`+ 1`** button
  (`title="Receive one more unit of this line"`) when below full, else a `Full`
  badge (`title="Line fully received"`). Footer swaps to **Cancel** /
  **Save Receipt** -> `onReceive({poId, lines})`.
- Normal footer: left `Received {rec} of {ord} units · {pct}% complete` (only when
  `partial`); right **Close** · **Email** · **Preview / Print** · a status-adaptive
  primary:

| status | label | action |
|---|---|---|
| draft | `Send to vendor` | `alert("[scaffold] Sends PO, status → sent, opens POEmailDialog. Wires in next rev.")` |
| sent | `Receive items` | `enterReceive()` |
| partial | `Receive remaining` | `enterReceive()` |
| received | `Close PO` | `alert("[scaffold] Marks PO closed. Wires in next rev.")` |
| closed | - | no primary button |

- **Activity** tab is `ActivityTabStub` - synthesises a timeline from status
  alone, with hard-coded actors `"Emanuel Dahan"` / `"Counter staff"` and a blue
  banner referencing `purchase_order_status_history`.
- **Documents** tab is a static dashed `Documents ship in the next rev`.
- **3-Way Match** tab: `3-Way Match runs after receiving` when not
  received/closed, else `3-Way Match wiring ships with PRD §7.4`.
- Nested `POPreviewDialog` and `POEmailDialog` (both `lockEscape`); the latter's
  `onSent` sets `emailedToast = \`✉ PO emailed to ${n} recipient(s) · ${to[0]}\``,
  cleared after **3500 ms**, rendered `fixed bottom-6 left-1/2 z-[90]`.

### 7.5 `POPreviewDialog`

Props `{open, onClose, po?, poNumber?, poId?, shipToBranchId = "br_brooklyn_hq",
lockEscape?, zIndex? (ignored), onEmailSent?}`.
**Four reads**: `usePurchaseOrders`, `useVendors`, `useBranches`,
`useInventoryItems` - keys `['inventory','purchase-orders']`,
`['inventory','vendors']`, `['inventory','branches']`, `['inventory','items']`.
Plus `useAuthStore(s => s.user)` for the signer.

Resolution order `poProp -> poId -> poNumber` (case-insensitive). Unresolved and
`open` -> a `size="md"` Modal `PO not found in the local price book` with a single
**Close**.

Real price join: `enrichedLines` uses
`allItems.find(i => i.sku === l.itemSku)?.unitCost ?? 0`;
`tax = 0` ("Sales tax not modeled in prototype"); `total = subtotal`.

Renders a printable `.po-print-root` document: company block
(`FieldOS · {branch.name}`), PO number + status label
(`draft->Draft`, `sent->Sent to vendor`, `partial->Partially received`,
`received->Received in full`, `closed->Closed`), Vendor block, Ship-To + job pill,
a 4-cell meta strip, the line table
(`# SKU Description Qty UoM Unit Cost Ext. Recv'd`), totals, a
`<SignatureField role="Authorized By">`, a vendor-acknowledgement placeholder, and
a footer with a generated timestamp + "Page 1 of 1".
Print CSS is injected as `<style id="po-print-style">` on open and removed on
close; `.po-print-hide` hides the footer bar while printing.

Footer: **Close** · **Email PO** (`title="Email this PO to the vendor + buyer + AP"`)
· **Save as PDF** (`title="Save as PDF via browser print dialog"` -> `window.print()`)
· **Print** (-> `window.print()`).

### 7.6 `POEmailDialog`

Props `{open, onClose, po, shipToBranchId = "br_brooklyn_hq", zIndex? (unused),
lockEscape?, onSent({to, subject, body})}` - `onSent` is **required**.
Reads `useBranches()` and `useVendors()`. **No HTTP send** - "sending" is
`onSent(...)` + `onClose()`.

`vendorDomain(name)` takes the segment before `/ · , &`, strips non-alphanumerics
-> `{x}.com`, fallback `vendor.com`. `emailFor(name, domain="fieldos.io")` ->
dotted lowercase slug, fallback `team@fieldos.io`.
Suggested recipients (deduped): `{vendor} (Sales)` -> `sales@{dom}`,
`{vendor} (Orders)` -> `orders@{dom}`, `{branch.managerName} ({branch.name} Buyer)`,
`Accounts Payable` -> `ap@fieldos.io`, `Purchasing Team` -> `purchasing@fieldos.io`.
Chips toggle in/out of `recipients`; checked chips prefix `✓ `.

Hydration effect on `[po, open, branch]`: `To = [sales@{dom}]`,
`Cc = branch.managerName ? [emailFor(managerName)] : []`, subject
`` `Purchase Order · ${poNumber} · ${vendor}` ``, and a multi-line body with a
bulleted `• {sku} — {qty} {uom}` summary (adding `(received r/o)` where relevant).

Validation: `EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/`. `addEmail` splits on
`[,;\s]+`; any failure -> `` setError(`Invalid email: ${bad.join(", ")}`) `` and
nothing is added. `ChipInput` commits on Enter, `,`, `;`, Space and blur;
Backspace on an empty input pops the last chip; each chip has an X
(`title="Remove"`). `handleSend()` -> `At least one recipient is required.` when
empty, else `onSent({to, subject, body}); onClose();` - **`cc` is collected but
never included in the payload.** Footer: **Cancel** /
`Send Email ({n} recipients)` (disabled when empty). Attachment chip
`` `po-${po.poNumber}.pdf` `` + "Auto-generated from the live PO".
Note: `ChipInput` is declared **inside** the component body (`:173`), so it is a
new component type each render and the To/Cc inputs remount on every keystroke.

### 7.7 `PrePODetailDialog`

Props `{open, onClose, row: {kind:'rfq',data:RFQ} | {kind:'reservation',data:EstimateReservation} | null,
onConvertToPO?(reservation)}`. `Modal size="xl"`. No API call of its own.

A `meta` memo adapts everything per kind:

| field | RFQ | Reservation |
|---|---|---|
| chip | `awaiting_quotes` -> "Awaiting Quotes" (warning), else "Ready to Compare" (success) | "Estimate Approved" (info) |
| title | `{rfqNumber} · {customer ?? "Unassigned"}` | `{estimateNumber} · {customer}` |
| primaryVendor | `quotes.find(q => q.recommended)?.vendor` | `preferredVendor` |
| when | "Quotes requested" / `requestedAt` | "Customer approved" / `approvedAt` |
| due | "Vendor responses due" / `responsesDueBy` | "Ready to convert" / undefined |
| primary | ready -> `Compare quotes & pick winner`; else `Send reminder to vendors` **disabled** | `Convert to Purchase Order` |

Inner tabs `Items` · `Vendor Quotes`/`Estimate` · `Email Activity`, default `items`.
- **ItemsTab**: `# SKU Description UoM Qty` + `tfoot` `{n} items` / `Total units {sum}`.
- **QuotesTab**: awaiting/no quotes -> amber `Quotes haven't come back yet`.
  Otherwise a winner banner (Crown,
  `Best composite score · 60% price · 25% lead · 15% reliability`) and a table
  `Vendor | Total | Lead | vs Cheapest | Notes` with `Cheapest` / `Fastest`
  badges, else `+{delta}%`. Bottom-right **Open full side-by-side comparison**.
- **EstimateBreakdownTab**: info banner + table
  `# SKU Description Qty UoM Ext. Reserved` where
  `ext = reservedTotal * (qty / totalUnits)` rounded to 2dp, with a footnote
  saying it is synthesised.
- **EmailActivityTab**: empty -> `No emails yet`. Otherwise emails sorted
  `sentAt` ASC, each with a kind chip (`rfq_sent` / `vendor_quote` /
  `estimate_sent` / `customer_reply` / `follow_up`), direction (`→ Sent to` /
  `← Received from`), timestamp, subject, `<pre>` body, attachment chips.
- Footer status line: `Waiting on {3 - quotes.length} of 3 vendors` /
  `All 3 quotes received · ready to pick a winner` /
  `Reserved {money} · awaiting PO conversion`.
- Nested `EstimateComparisonDialog` (RFQ only, `zIndex={80} lockEscape`) whose
  `onPickWinner` **intentionally discards the winner** per an inline comment, so
  the "Compare quotes & pick winner" path currently cannot produce a PO.

### 7.8 `AddVendorDialog`

`Modal size="lg"`, title `Add New Vendor`, subtitle
`Creates a new vendor in your master vendor list (PRD §7.6).`
Footer **Cancel** / **Save Vendor**. **No API call.**

Fields: Vendor Name (required, autoFocus, `ADI, Ferguson, Winsupply…`) ·
Category (`VendorCategoryPicker`) · Account Number (mono) · Payment Terms
(`SelectField aria-label="Payment terms"`, `Net 15/30/45/60, COD, Prepaid`) ·
Default Lead Time (days) (`type=number min=0`) · **PO Transmit Method** multi-select
pills over `email|portal|edi|phone` where **the last selected pill is `disabled`**
(`title="At least one transmit method must stay selected"`) and `toggleTransmit`
guards programmatically, plus a `{n} channels selected · default: {label}` hint ·
Contact Person · Website · Contact Email (`type=email`) · Contact Phone ·
repeatable `additionalContacts` cards (header `Contact #{idx+2}`,
**Add contact** `title="Add another contact person for this vendor"`, remove
`aria-label="Remove this contact"`, empty copy
`No additional contacts yet. Click + Add contact to add another person (e.g. AP rep, branch manager).`)
· Pickup / Ship-from Address · Notes.

Validation: `Vendor name is required.` and `Pick at least one PO transmit method.`
Constructed `Vendor`: `id: \`vnd_new_${Date.now()}\``, `category: form.category.trim() || "General"`,
`leadTimeDays: parseInt(form.leadTimeDays || "0", 10)`,
`transmitMethod: transmitMethods[0]` (back-compat) + `transmitMethods: [...]`,
`additionalContacts` dropped to `undefined` when every card is blank,
`status: 'active'`.

### 7.9 `VendorDetailDialog`

Props `{open, onClose, vendor, spend, pos, items, existingCategories, onSave,
onDeleteRequest, onArchiveToggle}`. `Modal size="xl"`, title
`` `Vendor · ${vendor.name}` ``, subtitle `category[ · acct {accountNumber}]`,
`lockEscape={isEditing}`. Uses `useAppAbility()`; its nested `POPreviewDialog`
performs the four reads from 7.5.

Gated by `editable`: the header **Edit** `editAction` (only when
`editable && !isEditing`), **Archive/Reactivate**
(`title="Re-activate this vendor"` / `"Soft-archive — keep history, hide from active lists"`),
and **Delete**. The **Email Vendor** `mailto:` renders whenever
`vendor.contactEmail` exists and is **not** gated.

Read mode: hero strip (category pill, active/inactive pill, `vendor.id` mono,
`Last ordered {fmtRelativeDate}` or `No POs yet`) -> a 3-column grid
(Contact / Account / Pickup) -> four `SpendCard`s (`YTD Spend` +
`{ytdPoCount} POs this year`; `This Month` + `▲/▼ {pct}% vs last month` or
`no comparison`; `All-Time` + `{poCount} total POs`; `Avg PO` +
`Top: {topItemName truncated to 26}`) -> **Recent purchase orders**
(`recentPOs(vendor.name, pos, 5)`, columns `PO | Job / Customer | Ordered |
Status | Total`, each `<tr role="button" tabIndex={0}` with
`title={\`Preview ${poNumber}\`}`, click **or Enter/Space** -> preview;
total = `fmtMoney(poExtension(po, items))`). Empty:
`No purchase orders on file for this vendor yet.` Then a
`PO transmit: …` footnote joining `transmitMethods` with `" · "` and showing
`(default: {first})` when > 1.

Edit mode: `draft` built by `toDraft(vendor)` (promotes a legacy single
`transmitMethod` into a one-element array). Editable Person/Email/Phone/Website;
additional-contact cards (`title="Add another contact"`,
`aria-label="Remove contact"`); Account # / Terms
(`SelectField aria-label="Payment terms"` - **this one has an extra `n/a`
option** the Add dialog lacks) / Lead (days) / PO transmit pills
(**labels here are `Email / Portal / EDI / Phone` - a different label set from
`AddVendorDialog`**, with a `Default` badge on index 0); Pickup + Notes textareas;
and an amber **Vendor identity** banner with `Vendor Name *` (border turns danger
when blank) and Category (`VendorCategoryPicker inEdit`).

Diff-based save: `patch = diffDraft(vendor, draft)` (`:135-164`; changing any
transmit method writes both `transmitMethod` and `transmitMethods`; blank strings
become `undefined`). `hasChanges = Object.keys(patch).length > 0`,
`nameValid = !draft || !!draft.name.trim()`. Edit footer **Cancel** /
**Save Changes**, disabled when `!hasChanges || !nameValid`, `title` cycling
`Vendor name is required` / `No changes to save` / `Save vendor changes`.

The reset effect on `[open, vendor?.id]` fires **only when `!open`**, so switching
vendors while open would keep an in-flight draft - latent, not currently
reachable because the page mounts with `open={!!openVendor}`.

Nested `POPreviewDialog` resolves the PO by number from **its own**
`usePurchaseOrders()` query, not from the `pos` prop.

### 7.10 `DeleteVendorDialog`

Props `{open, onClose, vendor, items, pos, onDelete, onArchive}`. No API call, no
form.

```ts
const openPOStatuses = ["draft","sent","partial"];
const openPOs      = pos.filter(p => p.vendor === vendor.name && openPOStatuses.includes(p.status));
const linkedItems  = items.filter(i => i.vendor === vendor.name);
const isBlocked    = openPOs.length > 0 || linkedItems.length > 0;
```

`Modal size="lg"`, title `` `Delete vendor · ${vendor.name}` ``, subtitle
`This vendor is still in use — hard delete is blocked.` or
`This vendor has no open POs or linked items — safe to delete.`
Body: a red `Cannot delete — vendor is still in use` panel or a green
`No open POs and no inventory items reference this vendor. Deletion is safe.`;
a list of open POs; a list of linked items capped at 6 with `+ {n} more…`; and,
when unblocked, an amber "Heads up: hard-delete is permanent…" note.
Footer: **Cancel**, then **either** `Soft Archive Instead`
(`title="Soft-archive — keep history but hide from active lists"` ->
`onArchive(id)`) **or** `Delete Vendor` (danger -> `onDelete(id)`).
**There is no confirm-typing step and no second confirmation.**

### 7.11 `VendorCard`, `VendorCategoryPicker`, `CategoryManagerDropdown`

- **`VendorCard`** - props `{vendor, spend, shareOfYTD, topShareOfYTD, onClick}`.
  A `<button>` card: name + category + Active/Inactive pill (`opacity-70` when
  inactive); contact block (person + a `+{n}` badge for `additionalContacts`,
  `mailto:` / `tel:` / website links each with `stopPropagation`, website via
  `safeHref` + `target="_blank" rel="noopener noreferrer"`); Account # +
  Terms / `{leadTimeDays}d lead`; a green spend strip
  (`fmtMoney(spend.ytd)`, `{ytdPoCount} POs`, `last {fmtRelativeDate}` or
  `no orders`, a share bar `Math.max(2, Math.min(100, shareOfYTD/topShareOfYTD*100))`,
  `{pct}% of total inventory spend`); optional pickup address; and a
  `PO via {vendor.transmitMethod}` chip - **the singular field only, so
  multi-channel vendors show just the primary.**
- **`VendorCategoryPicker`** - Radix `Select` over `options` plus a
  `SelectSeparator` and a `+ Add new category…` row using
  `const NEW_SENTINEL = "__new__"` (Radix forbids an empty item value). Choosing
  it -> `setCreating(true); onChange("")` and swaps in an autofocused free-text
  input with an X (`title="Cancel new category"`). `creating` is *initialised*
  from `valueIsNew` and does **not** react to later prop changes. A `+` button
  (`title="Type a new category instead"`) switches to free text. `inEdit` swaps
  borders/rings to amber.
- **`CategoryManagerDropdown`** (VendorsPage filter row) - Radix `Popover`;
  trigger `<button aria-haspopup="listbox" aria-expanded={open}>`; content
  `role="listbox" w-72`. `onEscapeKeyDown` cancels an in-progress rename, else an
  in-progress add, else closes. Rows: **All categories** -> `onSelect("all")`,
  then each category (click -> `onSelect(c)` + `closeAll()`), a Check when
  selected, and a hover-revealed pencil
  (`aria-label={\`Rename ${c}\`}`, `title={\`Rename "${c}" · updates every vendor using this category\`}`)
  opening an inline rename input (Enter commits, Escape cancels) with ✓/✗.
  Bottom: **Add new category** with the same inline pattern.
  Validation strings: `Category name can't be empty.`, `` `"${next}" already exists.` ``;
  renaming to the identical name silently cancels; a successful rename that
  matches the active filter also calls `onSelect(next)`. Footnote:
  `Renaming a category updates every vendor that uses it. New categories become available everywhere in the app.`

### 7.12 `EmailComposeDialog` - not used by any of the four pages

Imported only by `StageDetailDialog.tsx` (`:45`, `:1463`). Props
`{open, onClose, stage: JobStage|null, shipToBranchId = "br_brooklyn_hq",
lockEscape?, onSent({to,subject,body})}`; reads `useBranches()` and `useTechs()`.
Validation strings: `Add at least one recipient in the To field.`,
`Subject is required.`, `` `"${value}" isn't a valid email address.` ``.
It composes a **pickup ticket**, not a PO - `POEmailDialog` is the PO analogue.

---

## 8. Selector surface

**There is not a single `data-testid` in `frontend/src/pages/inventory/` or
`frontend/src/components/inventory/`** (verified by grep on both trees). Any v2
build should treat that as a defect to fix, not a contract to copy - but it means
nothing breaks if testids are *added*, and nothing existing can be relied on.

Stable selectors that do exist:

**`InventoryPage`**
- `aria-label="below min"` on the low-stock `AlertTriangle` in the On Hand cell
- `aria-label="Delete item"` / `title="Delete item"` on the DetailPanel trash button
- `title="No photo yet"` on the `ItemThumb` placeholder
- `title={\`Export ${n} items as CSV\`}` on Export
- `title="Generate Purchase Orders for every below-min item, grouped by location → vendor"` on Restock All
- `title={\`${loc.name}: ${onHand} on hand, ${reserved} reserved[, below min]\`}` on each `LocationBreakdown` chip
- `title={\`Create Purchase Order(s) to restock ${loc.name}\`}` on the LocationStockHealth Restock pill
- `title={\`${highlight} ${highlightLabel ?? "ready"}\`}` on the Staging/Approvals tab highlight pill
- `aria-label={\`Remove ${label}\`}` on each `ActiveFilterChips` X
- Text: `Items` / `Staging` / `Approvals`, `Add Item`, `Restock`, `Transfer`,
  `Import CSV`, `Export`, `Scan QR / Barcode`, `Clear filter`,
  `No items match your filters.`, `Low-Stock Health by Location`,
  `All items at or above reserve`
- The shared `KpiTile` (`components/ui/KpiStrip.tsx`) renders a `button` when
  interactive but sets **no `aria-label` and no `aria-pressed`** - so
  `InventoryPage`'s five stat tiles are only addressable by their label text.

**`PriceBookPage`** (its `KPITile` is a *local* component and does carry ARIA)
- `aria-label` + `aria-pressed` + matching `title` on the four KPI tiles:
  `Show only items currently in the customer-facing catalog`,
  `Show only items hidden from the customer-facing catalog`,
  `Show only items that already have a product photo`,
  `Show only items missing both list price and sell price`
- `aria-label` on selects: `Brand`, `Category`, `Visibility`, `Bundle format`
- `aria-label={\`Edit ${name}\`}` / `` `Delete ${name}` `` on group and category cards
- `title`: `Edit brand` / `Delete brand` / `Edit bundle` / `Delete bundle` /
  `Edit category` / `Delete category`;
  `Visible to customers — click to hide` / `Internal only — click to publish to catalog`
- `role="status"` on the Catalog Phase-B placeholder
- Radix tabs expose `role="tab"` + `data-state` with values
  `items|brands|groups|categories|catalog`

**`PurchaseOrdersPage`**
- `aria-label="All vendors"` / `aria-label="All trades"` on the two `FilterSelect`s
- `title`: `Preview PO`, `Email PO`, `Receive items`, `Preview PO document`,
  `Click the lit KPI tile again, or use this button, to clear the filter`,
  `Three-way match ships in §7.4`
- Text: `Create PO`, `Clear KPI filter ×`, `Pre-PO` / `Open` / `History`
- **Its KPI tiles carry no `aria-label` and no `aria-pressed`** (unlike VendorsPage's)

**`VendorsPage`**
- KPI `<button aria-label aria-pressed title>` with
  `Show only active vendors in the Directory`, `Open the Spend Analytics view`,
  `Open the By Category view`; active tiles also render a `filtered` pill
- `CategoryManagerDropdown`: `aria-haspopup="listbox"`, `aria-expanded`,
  `role="listbox"`, `aria-label={\`Rename ${c}\`}`,
  `title={\`Rename "${c}" · updates every vendor using this category\`}`
- Text: `Add Vendor`, `Directory`, `By Category`, `Spend Analytics`,
  `All categories`, `Add new category`, `all` / `active` / `inactive`,
  `{n} of {m} vendors`, `Spend leaderboard · YTD`,
  `No vendors match your filters.`

**Dialogs** - `aria-label` values worth keeping:
`Upload brand logo` / `Replace brand logo`, `Upload category photo` /
`Replace category photo`, `Default vendor`, `Trade`, `Remove line`,
`Remove photo`, `Add new vendor`, `Add new category`, `Vendor / Source`,
`Category`, `Item kind`, `Unit of measure`, `Brand`, `Starting stock location`,
`Payment terms`, `Remove this contact`, `Remove contact`, `Vendor`.
Dialog **titles** are the most reliable discriminators - see the tables above.

**`ResizableTable`** resize handles: `role="separator" aria-orientation="vertical"`.

---

## 9. Existing test coverage

Three vitest files under `frontend/src/components/inventory/`, plus one hook spec.
**No Playwright spec touches inventory.**

### `__tests__/LocationStockHealth.test.tsx` - what it actually asserts

Single `describe("LocationStockHealth — render smoke test")` with one `it`:
`"renders without throwing on a one-item / one-location fixture"`.

Fixture: one `Location` `{id:'loc-1', name:'Main Warehouse', type:'warehouse',
branch:'br-1'}` and one `Item` `{id:'item-1', sku:'SKU-001', name:'Deadbolt',
category:'cat-1', trade:'locksmith', kind:'material', uom:'ea', unitCost:10,
sellPrice:20, serialized:false, hazmat:false, status:'active', vendor:'ven-1',
stock:[{locationId:'loc-1', onHand:1, reserved:0, min:10}],
updatedAt:'2026-05-28T00:00:00.000Z'}` - deliberately below `min` so the
low-stock / worst-item branches run rather than the empty path.

Renders inside a `QueryClientProvider` (`retry: false`) with props
`items=[item] locations=[location] activeLocationId="all" onSelectLocation={()=>{}}`
(**no `onRestockLocation`**, so the Restock pill branch is not exercised).

Three assertions:
1. `expect(() => renderWithProviders(...)).not.toThrow()`
2. `screen.getByText('Low-Stock Health by Location')` is in the document
3. `screen.getByText('Main Warehouse')` is in the document

That is the whole contract. It is a smoke test - it does **not** assert the
counts, the severity colour, the "Worst:" line, the legend, or any click
behaviour. A v2 `LocationStockHealth` will pass this spec as long as it renders
that heading and the location name without throwing. Do not treat it as a
regression net.

### The other two component specs

- `__tests__/PrePODetailDialog.test.tsx` - one `it`:
  `"invokes onConvertToPO with the reservation when the primary action is clicked"`.
- `__tests__/VendorCard.reskin.test.tsx` - one `it`:
  `"renders the vendor name + Active badge and uses NO raw emerald/rounded-lg classes"`.
  This is a **design-token guard** and will fail if a v2 rebuild reintroduces raw
  palette classes on `VendorCard`.

### `useInventoryFilters.test.tsx` (not under `__tests__/`)

`describe('useInventoryFilters')`:
- `excludes kinds that are not material/labor/service`
- `search matches against sku/name/category/vendor/mpn/upc`
- `per-location stock-state branch (activeLoc set) keeps low_stock items at that location`
- `cross-location stock-state branch (activeLoc all) keeps backorder items`

`describe('useInventoryStats')`:
- `computes totalSkus/lowStock/backorder/value over material items only`

Because the v2 pages must **import** this hook rather than fork it, these five
tests are the strongest existing guarantee in the module.

---

## 10. Migration risks specific to this module

1. **The local-mirror pattern is the module's defining behaviour.** A builder who
   "wires up the missing mutations" while swapping components has changed
   business logic, which the plan forbids. Every unwired mutation listed in
   section 2 must stay unwired.
2. **Zero test ids and near-zero e2e coverage.** There is no safety net. The
   Phase 3 test agent must build one, and the `VendorCard.reskin` token guard is
   the only automated check that will catch a palette regression.
3. **Native `alert()` and `confirm()`** are used for destructive guards on
   `PriceBookPage` (brands, bundles, categories) and in `InventoryPage`'s
   category delete. Replacing them with a kit dialog changes behaviour (focus
   trapping, keyboard, blocking semantics) and needs sign-off.
4. **Two different KPI tile implementations.** `InventoryPage` uses the shared
   `KpiTile` (no ARIA); `PriceBookPage`, `PurchaseOrdersPage` and `VendorsPage`
   each define a *local* `KPITile`, two of which carry `aria-label`/`aria-pressed`
   and one of which does not. Unifying them on a kit component will change the
   accessibility surface of at least three pages.
5. **`ResizableTable` is used on three pages with no `sortValue` anywhere.**
   Swapping in the kit `DataTable` would introduce sorting and probably selection
   - both are new interactions.
6. **The frozen `TODAY` constant** on `PurchaseOrdersPage` and the flat `$50/unit`
   `poTotal` must survive verbatim; "fixing" either silently changes every Late /
   Arriving / Total figure on the page.
7. **The alert-bus `{id, nonce}` intent contract** between `InventoryPage`,
   `StagingView` and `ApprovalsView` is subtle and undocumented outside the code
   comments. Any v2 restructuring that changes mount order will break bell
   navigation.
8. **`InventoryPage`'s kebab menu has no outside-click or Escape handler.** A kit
   `DropdownMenu` would add both - a behaviour change, though almost certainly a
   desirable one. Flag rather than assume.
9. **The `Filters` type carries `trades`, and the filter chain honours it, but no
   UI writes it.** Also `Bundle` and `Fee` kind chips can never match, because the
   chain drops those kinds first. Preserve both quirks or raise them explicitly.
10. **Row checkboxes on the Items table are decorative.** A kit table with real
    row selection would create a bulk-action surface that does not exist today.
11. **Three double-POST paths** (create stage, create approval, decide approval)
    fire the same mutation from both the dialog and its parent. This is existing
    behaviour and a v2 build must not silently deduplicate it - raise it instead.
12. **Four "save" paths in Staging/Approvals never reach the server** (section
    3.11), and `StagingAreaPicker.saveCustom` mutates a prop object in place. A
    builder who moves that state into a store or a query cache is changing shared
    logic.
13. **`StageDetailDialog`'s photo gate is real product logic** - no attachment
    means Email and Save Changes are disabled and the `ready_for_pickup` option is
    disabled and relabelled. It must survive the component swap intact.
14. **Two dead `Open Job →` buttons.** Preserve them as dead, or raise them; do
    not quietly wire them up.
15. **`StagingView` has no permission gating at all**, while `ApprovalsView` gates
    only its header copy and the detail dialog's footer. Do not "harmonise" this
    during a presentation swap.

---

## 11. Open questions

1. **The CLAUDE.md technician claim.** CLAUDE.md says technicians hold org-wide
   `read PriceBook` by default; `backend/src/lib/permissions/defaultGrants.ts:142-176`
   grants TECHNICIAN neither `read PriceBook` nor `read Inventory`. Which is
   authoritative - and has a prod migration diverged from `defaultGrants.ts`? This
   changes whether the inventory pages are reachable-but-403ing for technicians.
2. **The three double-POST paths** (section 2). Is the duplicate write harmless
   because the backend is idempotent, or is it creating duplicate rows today? Two
   of them (`createStage`, `createApproval`) send **different ids** on each call,
   which suggests real duplicates. Needs a backend check before anyone decides
   whether v2 preserves or fixes it.
3. **`frontend/src/lib/api/_mock/inventory/inventory.ts`** reportedly contains
   lines beginning with a stray backslash where a `//` should be (around lines
   246, 266, 596). Seen via grep context only, not a full read. If those are real
   syntax errors the module may not be compiling cleanly today - verify in
   Phase 0.
4. **Backend contract not verified.** The seven `/api/inventory/*` routers exist
   and are guarded, but I did not read the controllers, so I cannot confirm the
   POST bodies the frontend sends (a whole `PurchaseOrder`/`Vendor` object, or a
   `ReceiveSubmit`) match the server zod schemas.
5. **Model definitions** (`Vendor`, `Item`, `PurchaseOrder`, `RFQ`,
   `EstimateReservation`, `JobStage`, `StockApproval`) live in
   `frontend/src/lib/api/_mock/inventory/` and were not read. Field names cited
   above are accurate *as used at the call sites*; optionality is unconfirmed.
6. **`PODetailDialog.tsx:102-107`** has deps `[po?.id, open]` while reading
   `po.lines`, so after a receive the draft retains the pre-save numbers until the
   dialog is reopened. Intentional or a bug to preserve?
7. **`ItemVisibility` is imported directly from `@/lib/api/_mock/inventory`**
   (PriceBookPage `:34`, AddItemDialog `:16`) because the seam does not re-export
   it; the code comments call this a sanctioned exception. Should v2 pages inherit
   that import or should the seam be extended (which would be a shared-code change)?
8. **`AddItemDialog` photo cap is 10 MB while the other three dialogs cap at
   512 KB.** Intentional asymmetry or drift?
9. **`AddVendorDialog` and `VendorDetailDialog` use different transmit-method
   label sets** (`Email / Vendor Portal / EDI / Phone / Will-Call` vs
   `Email / Portal / EDI / Phone`) and different payment-terms option lists
   (the detail dialog adds `n/a`). Unify in v2 or preserve?
10. **`SignatureField`** (used by `POPreviewDialog`, `StagePreviewDialog` and
    `ApprovalDetailDialog`) was not read. It is load-bearing for the
    `ApprovalDetailDialog` approve gate (`disabled={!approverSig}`), so its
    internals must be understood before that dialog is rebuilt.
11. **`StageDetailDialog` uses pdf.js** for PDF page rendering with a 30 s parse /
    20 s per-page `raceTimeout`. That dependency and its worker setup were not
    inspected and may interact with the React 19 / Vite work in Phase 0.
12. **`ApprovalsView`'s empty-state string produces a double space** on the `all`
    filter (`No  approvals to show.`). Preserve the bug or fix it - needs a call.
