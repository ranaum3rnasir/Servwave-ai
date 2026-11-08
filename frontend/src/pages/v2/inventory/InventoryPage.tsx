import { useEffect, useId, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRightLeft, Boxes, ClipboardList, Download, History,
  PackagePlus, ShoppingCart, Upload, Wrench,
} from 'lucide-react';

import {
  adoptServerId, startingThresholdsFor, totalOnHand,
  useAssets, useBranches, useBrands, useCategories, useDeleteCategory, useDeleteItem,
  useDeleteLocation,
  useFinishes, useImportItemsCSV, useInventoryItems, useJobStages, useLocations, useLowStock,
  useMovements, useRestoreItem, useSetQuantity, useSetThresholds, useTransferStock,
  useUpsertBranch, useUpsertCategory, useUpsertItem, useUpsertLocation, useUpsertVendor,
  useVendors,
} from '@/lib/api/inventory';
import type { Branch, Category, Item, Location, Vendor } from '@/lib/api/inventory';
import { useLogisticOrders } from '@/lib/api/logisticOrders';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useConfirm } from '@/hooks/useConfirm';
import { extractApiError, formatCurrencyWhole } from '@/lib/utils';
import { useInventoryAlertStore } from '@/stores/inventory-alert.store';
import { downloadCSV, toCSV } from '@/lib/inventory/csv';
import { importSummary } from '@/lib/inventory/import-summary';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';

// Legacy sub-views and dialogs, reused unchanged. Every one of them owns real
// behaviour - queries, mutations, validation, the alert-intent contract - and
// the migration brief forbids forking business logic to restyle it. Each is a
// row in the module's gap ledger.
import { AddCategoryDialog } from '@/components/inventory/AddCategoryDialog';
import { AddItemDialog, type NewItem } from '@/components/inventory/AddItemDialog';
import { AddLocationDialog } from '@/components/inventory/AddLocationDialog';
import { CategorySelector } from '@/components/inventory/CategorySelector';
import { DeleteItemDialog } from '@/components/inventory/DeleteItemDialog';
import { DeleteLocationDialog } from '@/components/inventory/DeleteLocationDialog';
import { GeneratePODialog } from '@/components/inventory/GeneratePODialog';
import { ImportCSVDialog } from '@/components/inventory/ImportCSVDialog';
import { LocationSelector } from '@/components/inventory/LocationSelector';
import { LocationStockHealth } from '@/components/inventory/LocationStockHealth';
import { LowStockActionDialog } from '@/components/inventory/LowStockActionDialog';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';
import { RestockDialog } from '@/components/inventory/RestockDialog';
import { SetQuantityDialog } from '@/components/inventory/SetQuantityDialog';
import { SetThresholdsDialog } from '@/components/inventory/SetThresholdsDialog';
import { TransferDialog } from '@/components/inventory/TransferDialog';
import { emptyFilters, type Filters } from '@/components/inventory/FiltersPopover';
import { useInventoryFilters, useInventoryStats } from '@/components/inventory/useInventoryFilters';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { DataTableToolbar } from '@/ui-kit/components/data/dataTable/dataTableToolbar';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { MasterDetail } from '@/ui-kit/components/layout/masterDetail';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabStrip } from '../_shared/tabs';
import { ActionLogView } from './components/actionLogView';
import { AddItemSplitButton } from './components/addItemSplitButton';
import { AssetsView } from './components/assetsView';
import { BulkRestockDialog } from './components/bulkRestockDialog';
import { StockBulkBar } from './components/stockBulkBar';
import { InventoryFilterChips, InventoryFilterPopover } from './components/filterPopover';
import { ItemDetailPanel } from './components/itemDetailPanel';
import { LOList } from '../_shared/loList';
import { LowStockView } from './components/lowStockView';
import { StagingView } from './components/stagingView';
import { buildItemColumns } from './itemsColumns';

type ActiveDialog =
  | null
  | 'add'
  | 'delete'
  | 'transfer'
  | 'restock'
  | 'bulk_restock'
  | 'set_quantity'
  | 'set_thresholds'
  | 'add_location'
  | 'add_category'
  | 'import_csv'
  | 'generate_po';

/**
 * Route -> internal view.
 *
 * The tabs are deep-linkable routes so the alert store can jump straight to a
 * view; the active tab is derived from the URL, never from state. Carried over
 * verbatim. (`/inventory/approvals` is a redirect, handled in the route file.)
 */
type InventoryView = 'items' | 'staging' | 'assets' | 'low_stock' | 'activity' | 'logistic_orders';

function viewFromPath(path: string): InventoryView {
  if (path.startsWith('/inventory/staging')) return 'staging';
  if (path.startsWith('/inventory/assets')) return 'assets';
  if (path.startsWith('/inventory/low-stock')) return 'low_stock';
  if (path.startsWith('/inventory/activity')) return 'activity';
  if (path.startsWith('/inventory/logistic-orders')) return 'logistic_orders';
  return 'items';
}

const VIEW_PATHS: Record<InventoryView, string> = {
  items: '/inventory',
  staging: '/inventory/staging',
  assets: '/inventory/assets',
  low_stock: '/inventory/low-stock',
  activity: '/inventory/activity',
  logistic_orders: '/inventory/logistic-orders',
};

/** Tab label: icon, name, total count, and the amber "n pending / ready" flag. */
function TabLabel({
  icon: Icon, label, count, highlight, highlightLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  highlight?: number;
  highlightLabel?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4" />
      {label}
      <Badge variant="softNeutral" size="pill">{count}</Badge>
      {highlight && highlight > 0 ? (
        <Badge
          variant={highlightLabel === 'pending' ? 'amber' : 'green'}
          size="pill"
          title={`${highlight} ${highlightLabel ?? 'ready'}`}
        >
          {highlight} {highlightLabel ?? 'ready'}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * /v2/inventory and its five sibling routes - the Stock page on the CRM UI kit.
 *
 * Every query, mutation, handler, toast string and alert-bus reduction below is
 * the legacy page's, copied verbatim. Only the presentation changed:
 *
 *   - the six-tab route strip becomes the kit-built TabStrip the other v2
 *     modules use (`role="tablist"`, `role="tab"`, `aria-selected`), still
 *     driven by `navigate`, so the tabs stay deep-linkable.
 *   - the five KPI tiles become kit StatCards. There are four, not five: the
 *     legacy fifth ("Needs Approval") pointed at `/inventory/approvals`, which
 *     is a REDIRECT now, so the tile is already gone from the legacy page too.
 *   - the hand-rolled `<table>` becomes the kit DataTable, and its decorative
 *     selection checkboxes are dropped (see itemsColumns.tsx).
 *   - the `w-96` aside becomes the kit MasterDetail's detail pane.
 *   - the bespoke fixed-position toast div becomes the kit's sonner toast,
 *     which is what every other v2 module reports through.
 */
export default function InventoryPage() {
  useRecordVisit('inventory');
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const archivedSwitchId = useId();
  const { confirm, confirmDialog } = useConfirm();

  // "Show archived" toggle (Items tab) - re-fetches with include_archived=true
  // so hybrid-delete-archived rows surface alongside active ones.
  const [showArchived, setShowArchived] = useState(false);
  const itemsQuery = useInventoryItems(showArchived);
  const locationsQuery = useLocations();
  const vendorsQuery = useVendors();
  const categoriesQuery = useCategories();
  const branchesQuery = useBranches();
  const brandsQuery = useBrands();
  // Finish is read-only here - it is edited from the item dialog and only
  // resolved on this page - so it needs no local mirror and no seed effect.
  const finishesQuery = useFinishes();
  const jobStagesQuery = useJobStages();
  // Assets tab count only - the same {status:'ACTIVE'} key AssetsView uses by
  // default, so TanStack dedupes this with the tab body's own query.
  const assetsQuery = useAssets({ status: 'ACTIVE' }, 1);
  // P5 tab counts - meta.total only (limit 1 keeps the payloads tiny).
  const movementsCountQuery = useMovements({ limit: 1 });
  const lowStockCountQuery = useLowStock({ limit: 1 });
  // Logistic Orders tab - total count plus the pending-approval count that
  // drives the amber flag. `retry:false` in the hook keeps a non-reader 403 quiet.
  const loCountQuery = useLogisticOrders({ limit: 1 });
  const loPendingCountQuery = useLogisticOrders({ status: 'PENDING_APPROVAL', limit: 1 });

  const ability = useAppAbility();
  // #2043 - the toolbar's four write buttons, the two "Showing" selectors and
  // the row kebab each gate on the ability(ies) the route they call actually
  // enforces (spec §A/§A.2). `isLocationAdmin`/`manage Inventory` is gone:
  // it fed BOTH selectors, but they write to two different subjects
  // (locations -> Inventory, categories -> PriceBook), and no default role
  // holds `manage Inventory` at all (defaultGrants.ts).
  const canCreateInventory = ability.can('create', 'Inventory');
  const canUpdateInventory = ability.can('update', 'Inventory');
  const canDeleteInventory = ability.can('delete', 'Inventory');
  const canCreatePriceBook = ability.can('create', 'PriceBook');
  const canUpdatePriceBook = ability.can('update', 'PriceBook');
  const canDeletePriceBook = ability.can('delete', 'PriceBook');
  // The exact ability `POST /api/inventory/bulk-restock` enforces server-side
  // (`canDo('update','Inventory')`). Gating the button on anything else would
  // either hide an action the API allows or offer one it 403s.
  const canBulkRestock = canUpdateInventory;
  // Inventory P2 (D16 entry #3) - the Generate-PO surfaces gate on create PurchaseOrder.
  const canCreatePO = ability.can('create', 'PurchaseOrder');
  const upsertItem = useUpsertItem();
  const upsertLocation = useUpsertLocation();
  const deleteLocation = useDeleteLocation();
  const deleteItem = useDeleteItem();
  const restoreItem = useRestoreItem();
  const importItemsCSV = useImportItemsCSV();
  const transferStock = useTransferStock();
  const setThresholds = useSetThresholds();
  const upsertCategory = useUpsertCategory();
  const upsertVendor = useUpsertVendor();
  const upsertBranch = useUpsertBranch();
  const deleteCategory = useDeleteCategory();
  const setQuantity = useSetQuantity();

  const jobStages = useMemo(() => jobStagesQuery.data ?? [], [jobStagesQuery.data]);
  const allBrands = useMemo(() => brandsQuery.data ?? [], [brandsQuery.data]);
  // Finish is a foreign key, so the read-back surfaces need id -> name. Built
  // once per finishes payload rather than a `.find()` inside every rendered row.
  const finishNameById = useMemo(
    () => new Map((finishesQuery.data ?? []).map((f) => [f.id, f.name])),
    [finishesQuery.data],
  );

  const [allItems, setAllItems] = useState<Item[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [allBranches, setAllBranches] = useState<Branch[]>([]);

  // Seed local mirror state from the seam queries once data arrives.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- items mirror is seeded from the query, then mutated optimistically by add / restock / transfer
  useEffect(() => { if (itemsQuery.data) setAllItems(itemsQuery.data); }, [itemsQuery.data]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- vendors mirror is seeded here, then extended by vendors created from inside the item dialog
  useEffect(() => { if (vendorsQuery.data) setAllVendors(vendorsQuery.data); }, [vendorsQuery.data]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- locations mirror is seeded here, then extended by locations added in-page
  useEffect(() => { if (locationsQuery.data) setAllLocations(locationsQuery.data); }, [locationsQuery.data]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- categories mirror is seeded here, then mutated by in-page category add / delete
  useEffect(() => { if (categoriesQuery.data) setAllCategories(categoriesQuery.data); }, [categoriesQuery.data]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- branches mirror is seeded here, then extended by in-page branch creation
  useEffect(() => { if (branchesQuery.data) setAllBranches(branchesQuery.data); }, [branchesQuery.data]);

  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  // The category filter panel is also the screen's category manager (its rows
  // carry edit/delete), so "Manage categories" in the Add Item menu opens it.
  const [categoryPanelOpen, setCategoryPanelOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [deletingLocation, setDeletingLocation] = useState<Location | null>(null);
  const [search, setSearch] = useState('');
  const [activeLoc, setActiveLoc] = useState<string>('all');
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [generatePOLocId, setGeneratePOLocId] = useState<string | null>(null);
  // Alert-bus driven PO preview (TopBar bell -> po_partial row).
  const [alertPreviewPONumber, setAlertPreviewPONumber] = useState<string | null>(null);
  const [lowStockAction, setLowStockAction] = useState<{
    itemId: string;
    kind: 'low_stock' | 'backorder';
  } | null>(null);
  // Pending intent forwarded to the staging sub-view - carries its own `nonce`
  // so the child's effect re-fires every click, even on the same id.
  const [pendingStageIntent, setPendingStageIntent] = useState<{ id: string; nonce: number } | null>(null);

  // Clear any stale shortage/transfer error whenever the Transfer dialog opens
  // or closes (and when switching to a different dialog entirely).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- dialog identity changing is the trigger to drop a stale shortage message; it is not derivable from render
  useEffect(() => { setTransferError(null); }, [activeDialog]);

  const pendingAlert = useInventoryAlertStore((s) => s.pending);
  const alertNonce = useInventoryAlertStore((s) => s.nonce);
  const clearAlert = useInventoryAlertStore((s) => s.clear);

  useEffect(() => {
    if (!pendingAlert) return;
    const alert = pendingAlert;
    switch (alert.kind) {
      case 'low_stock': {
        navigate(VIEW_PATHS.items);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- a TopBar bell click arrives through the alert store, an external event source, and rewrites the filter set once
        setFilters((f) => ({
          ...f,
          stockStates: [
            ...f.stockStates.filter((s) => s !== 'in_stock' && s !== 'out_of_stock' && s !== 'backorder'),
            'low_stock',
          ],
        }));
        if (alert.ref?.itemSku) {
          const hit = (itemsQuery.data ?? []).find((i) => i.sku === alert.ref?.itemSku);
          if (hit) {
            setSelectedId(hit.id);
            setLowStockAction({ itemId: hit.id, kind: 'low_stock' });
          }
        }
        break;
      }
      case 'backorder': {
        navigate(VIEW_PATHS.items);
        setFilters((f) => ({
          ...f,
          stockStates: [
            ...f.stockStates.filter((s) => s !== 'in_stock' && s !== 'out_of_stock' && s !== 'low_stock'),
            'backorder',
          ],
        }));
        if (alert.ref?.itemSku) {
          const hit = (itemsQuery.data ?? []).find((i) => i.sku === alert.ref?.itemSku);
          if (hit) {
            setSelectedId(hit.id);
            setLowStockAction({ itemId: hit.id, kind: 'backorder' });
          }
        }
        break;
      }
      case 'po_partial': {
        if (alert.ref?.poNumber) setAlertPreviewPONumber(alert.ref.poNumber);
        break;
      }
      case 'staging_no_area':
      case 'staging_ready': {
        navigate(VIEW_PATHS.staging);
        if (alert.ref?.stageId) {
          setPendingStageIntent({ id: alert.ref.stageId, nonce: Date.now() });
        }
        break;
      }
    }
    clearAlert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertNonce]);

  const selectedItem = useMemo(
    () => allItems.find((i) => i.id === selectedId) || null,
    [allItems, selectedId],
  );

  // Per-item recent movements for the detail panel - server-filtered (P5 SS 2.2).
  // Runs unconditionally (hooks rule); tiny page when unscoped.
  const itemMovementsQuery = useMovements({ itemId: selectedItem?.id, limit: 25 });

  // `finishNameById` is what lets the search box match the finish NAME the row
  // shows; the item itself carries only the opaque id.
  const { filteredItems } = useInventoryFilters({
    allItems, search, activeLoc, filters, finishNameById,
  });

  // A selected id only makes sense against the CURRENT filter set. This grid
  // filters CLIENT-side, so the scope is the four inputs `filteredItems` is
  // derived from plus the archived toggle - the same rule as the server-paged
  // lists, keyed on what actually narrows the rows here.
  const selectionScope = JSON.stringify([search, activeLoc, filters, showArchived]);
  const { rowSelection, setRowSelection, selectedIds } = useScopedRowSelection(selectionScope);
  const selectedItems = useMemo(
    () => filteredItems.filter((i) => selectedIds.includes(i.id)),
    [filteredItems, selectedIds],
  );

  const activeLocation = useMemo(
    () => (activeLoc === 'all' ? null : allLocations.find((l) => l.id === activeLoc)),
    [activeLoc, allLocations],
  );

  const stats = useInventoryStats(allItems);

  /** The legacy `showToast`, on the kit's toaster. Same call sites, same copy. */
  function showToast(msg: string) {
    toast(msg);
  }

  async function persistCategory(c: Category) {
    const saved = adoptServerId(c, await upsertCategory.mutateAsync(c));
    setAllCategories((prev) => [...prev, saved]);
    return saved;
  }
  async function persistVendor(v: Vendor) {
    const saved = adoptServerId(v, await upsertVendor.mutateAsync(v));
    setAllVendors((prev) => [...prev, saved]);
    return saved;
  }
  async function persistBranch(b: Branch) {
    const saved = adoptServerId(b, await upsertBranch.mutateAsync(b));
    setAllBranches((prev) => [...prev, saved]);
    return saved;
  }

  async function handleSave(payload: NewItem, editId?: string) {
    const created = await upsertItem
      .mutateAsync({
        id: editId,
        name: payload.name,
        sku: payload.sku,
        mpn: payload.mpn,
        modelNumber: payload.modelNumber,
        categoryId: payload.categoryId,
        vendorId: payload.vendorId,
        brandId: payload.brandId,
        finishId: payload.finishId,
        trade: payload.trade,
        kind: payload.kind,
        uom: payload.uom,
        unitCost: payload.unitCost,
        sellPrice: payload.sellPrice,
        serialized: payload.serialized,
        hazmat: payload.hazmat,
        visibility: payload.visibility,
        photoUrl: payload.photoUrl,
        trackInventory: payload.trackInventory,
        taxable: payload.taxable,
      })
      .catch((err) => {
        showToast('✗ Could not save the item - check the fields and try again.');
        // Rethrow so AddItemDialog's await keeps the dialog open with the typed
        // values instead of discarding them on a failed save.
        throw err;
      });
    if (editId) {
      setAllItems((prev) =>
        prev.map((i) =>
          i.id === editId
            ? {
                ...i,
                sku: payload.sku,
                mpn: payload.mpn,
                modelNumber: payload.modelNumber,
                name: payload.name,
                category: payload.category,
                trade: payload.trade as Item['trade'],
                kind: payload.kind as Item['kind'],
                uom: payload.uom,
                unitCost: payload.unitCost,
                sellPrice: payload.sellPrice,
                serialized: payload.serialized,
                hazmat: payload.hazmat,
                trackInventory: payload.trackInventory,
                vendor: payload.vendor,
                photoUrl: payload.photoUrl ?? i.photoUrl,
                brandId: payload.brandId,
                finishId: payload.finishId,
                visibility: payload.visibility,
                updatedAt: new Date().toISOString(),
              }
            : i,
        ),
      );
      showToast(`✓ ${payload.sku} updated · audit log entry written`);
      return;
    }
    const newItem: Item = {
      id: created.id,
      sku: payload.sku,
      mpn: payload.mpn,
      modelNumber: payload.modelNumber,
      name: payload.name,
      category: payload.category,
      trade: payload.trade as Item['trade'],
      kind: payload.kind as Item['kind'],
      uom: payload.uom,
      unitCost: payload.unitCost,
      sellPrice: payload.sellPrice,
      serialized: payload.serialized,
      hazmat: payload.hazmat,
      trackInventory: payload.trackInventory,
      status: 'active',
      vendor: payload.vendor,
      photoUrl: payload.photoUrl,
      brandId: payload.brandId,
      finishId: payload.finishId,
      visibility: payload.visibility,
      stock: payload.startingStock.map((s) => ({
        locationId: s.locationId,
        onHand: s.qty,
        min: s.min,
        max: s.max,
      })),
      updatedAt: new Date().toISOString(),
    };
    setAllItems((prev) => [newItem, ...prev]);
    // Min/Max are a StockBalance column, not a price-book field, so they need
    // their own follow-up write against the SERVER id.
    const thresholds = startingThresholdsFor(payload.startingStock);
    if (thresholds) {
      try {
        await setThresholds.mutateAsync({
          itemId: created.id,
          locationId: thresholds.locationId,
          min: thresholds.min,
          max: thresholds.max,
        });
      } catch {
        showToast(
          `✓ ${payload.sku} added to the catalog - reserve levels could not be saved, set them from the item panel`,
        );
        return;
      }
    }
    // Opening on-hand posts through the count endpoint (ONE signed `adjust`
    // movement) against the real server item id.
    const opening = payload.startingStock[0];
    if (opening && opening.qty > 0) {
      if (!opening.locationId) {
        showToast(
          `⚠ ${payload.sku} was created, but there is no stock location to record the starting quantity against.`,
        );
        return;
      }
      try {
        await setQuantity.mutateAsync({
          itemId: created.id,
          locationId: opening.locationId,
          countedQty: opening.qty,
          reason: 'Opening stock',
        });
      } catch {
        showToast(
          `⚠ ${payload.sku} was created, but the starting quantity could not be recorded - use Set quantity.`,
        );
        return;
      }
    }
    showToast(`✓ ${payload.sku} added to the catalog`);
  }

  // Hybrid delete: the server hard-deletes an item with no history, or archives
  // one that is still referenced. The toast reflects which.
  async function handleDelete() {
    if (!selectedItem) return;
    try {
      const result = await deleteItem.mutateAsync({ id: selectedItem.id });
      showToast(
        result.mode === 'deleted'
          ? `✓ ${selectedItem.sku} deleted`
          : `✓ ${selectedItem.sku} archived · on ${result.referenceCount} record${result.referenceCount === 1 ? '' : 's'}, kept for history`,
      );
      setSelectedId(null);
      setActiveDialog(null);
    } catch {
      showToast(`✗ Could not delete ${selectedItem.sku} - try again`);
    }
  }

  async function handleRestore(item: Item) {
    try {
      await restoreItem.mutateAsync({ id: item.id });
      showToast(`✓ ${item.sku} restored`);
    } catch {
      showToast(`✗ Could not restore ${item.sku} - try again`);
    }
  }

  async function handleTransfer(payload: {
    item: Item;
    fromId: string;
    toId: string;
    qty: number;
    reason: string;
  }) {
    setTransferError(null);
    try {
      await transferStock.mutateAsync({
        itemId: payload.item.id,
        fromId: payload.fromId,
        toId: payload.toId,
        qty: payload.qty,
        reason: payload.reason || undefined,
      });
      const fromName = allLocations.find((l) => l.id === payload.fromId)?.name;
      const toName = allLocations.find((l) => l.id === payload.toId)?.name;
      showToast(`✓ Transferred ${payload.qty} × ${payload.item.sku} from ${fromName} → ${toName}`);
      setActiveDialog(null);
    } catch (err: unknown) {
      const data = (err as { response?: { data?: { error?: string; available?: number } } })?.response?.data;
      if (data?.error === 'SHORTAGE') {
        setTransferError(`Not enough stock at the source - ${data.available ?? 0} available.`);
      } else {
        setTransferError('Transfer failed - try again.');
      }
    }
  }

  // The export's column mapping, lifted out of `handleExport` unchanged so the
  // full-set export and the bulk "Export selected" produce column-identical
  // files. The only difference between the two is which items go in.
  const toExportRow = (i: Item) => ({
    SKU: i.sku,
    Name: i.name,
    Category: i.category,
    Kind: i.kind,
    UoM: i.uom,
    'Unit Cost': (i.unitCost ?? 0).toFixed(2),
    'Sell Price': i.sellPrice.toFixed(2),
    'Total On Hand': totalOnHand(i),
    'Total Available': totalOnHand(i),
    Vendor: i.vendor,
    MPN: i.mpn ?? '',
    UPC: i.upc ?? '',
    Serialized: i.serialized ? 'Y' : '',
    Hazmat: i.hazmat ? 'Y' : '',
    Status: i.status,
    'Locations Breakdown': i.stock
      .filter((s) => s.onHand > 0)
      .map((s) => `${allLocations.find((l) => l.id === s.locationId)?.name ?? s.locationId}:${s.onHand}`)
      .join(' | '),
    'Updated At': i.updatedAt,
  });

  // The filename convention is the legacy one: `inventory-<location>-<date>`,
  // where <location> is the active scope slug. "Export selected" keeps it and
  // adds one segment, so the two files sort together and are still told apart.
  function exportItems(list: Item[], suffix: string) {
    if (list.length === 0) {
      showToast('No items to export with current filters');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const locSuffix =
      activeLoc === 'all'
        ? 'all-locations'
        : allLocations.find((l) => l.id === activeLoc)?.name.replace(/\s+/g, '-').toLowerCase() ?? activeLoc;
    downloadCSV(toCSV(list.map(toExportRow)), `inventory-${locSuffix}${suffix}-${date}.csv`);
    showToast(`✓ Exported ${list.length} items to CSV`);
  }

  function handleExport() {
    exportItems(filteredItems, '');
  }

  function handleExportSelected() {
    exportItems(selectedItems, '-selected');
  }

  async function handleImport(payloads: NewItem[]) {
    const rows = payloads.map((p) => ({
      name: p.name,
      sellPrice: p.sellPrice,
      sku: p.sku || null,
      category: p.category || null,
      kind: p.kind || null,
      uom: p.uom || null,
      unitCost: p.unitCost,
      vendor: p.vendor || null,
    }));
    // Deliberately NO try/catch and an explicit return: the dialog stays open on
    // both outcomes and is the surface that names the offending rows, so it needs
    // the result to render and the rejection to explain. The toast still fires so
    // the headline survives the dialog being dismissed.
    const result = await importItemsCSV.mutateAsync({ items: rows });
    showToast(importSummary(result));
    return result;
  }

  // Narrows allItems down to a single location's offending stock rows.
  // Filtering WHICH items are passed without also filtering their stock rows
  // would over-order for an item low at two locations.
  const poDialogItems = useMemo(() => {
    if (!generatePOLocId) return allItems;
    return allItems
      .map((i) => ({ ...i, stock: i.stock.filter((s) => s.locationId === generatePOLocId) }))
      .filter((i) => i.stock.length > 0);
  }, [allItems, generatePOLocId]);

  const columns = useMemo(
    () =>
      buildItemColumns({
        locations: allLocations,
        activeLocation,
        finishNameById,
        actions: {
          onEdit: (item) => setEditingItem(item),
          onRestock: (item) => { setSelectedId(item.id); setActiveDialog('restock'); },
          onTransfer: (item) => { setSelectedId(item.id); setActiveDialog('transfer'); },
          onSetQuantity: (item) => { setSelectedId(item.id); setActiveDialog('set_quantity'); },
          onSetThresholds: (item) => { setSelectedId(item.id); setActiveDialog('set_thresholds'); },
          onDelete: (item) => { setSelectedId(item.id); setActiveDialog('delete'); },
          onRestore: (item) => { void handleRestore(item); },
        },
        // Unconditional: the always-available bulk action is Export selected,
        // and the toolbar Export it mirrors carries no gate either. Restock is
        // the gated one, and that gate is on the button, not the checkbox.
        selectable: true,
        // #2043 R1 - the kebab's per-entry gates. `buildItemColumns` is a pure
        // function outside the React tree, so the booleans are passed in.
        canUpdatePriceBook,
        canUpdateInventory,
        canCreatePurchaseOrder: canCreatePO,
        canDeletePriceBook,
      }),
    // finishNameById is a dependency because the Item cell reads it - leaving it
    // out prints the finish only for whatever map existed on first render. The
    // four ability booleans are dependencies too - a missing one here prints
    // the first render's gates for ever (#2043 R1).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      allLocations, activeLocation, finishNameById,
      canUpdatePriceBook, canUpdateInventory, canCreatePO, canDeletePriceBook,
    ],
  );

  const resultLabel = (() => {
    const isLow = filters.stockStates.includes('low_stock');
    const isBackorder = filters.stockStates.includes('backorder');
    const isOut = filters.stockStates.includes('out_of_stock');
    const prefix = isLow ? 'low-stock ' : isBackorder ? 'backordered ' : isOut ? 'out-of-stock ' : '';
    const word = `${prefix}item${filteredItems.length === 1 ? '' : 's'}`;
    return activeLocation
      ? `${filteredItems.length} ${word} at ${activeLocation.name}`
      : `${filteredItems.length} ${word.trim()} · of ${allItems.length} total`;
  })();

  const tabs = [
    {
      value: 'items',
      label: (
        <TabLabel
          icon={Boxes}
          label="Items"
          count={allItems.filter((i) => i.kind === 'material').length}
        />
      ),
    },
    {
      value: 'staging',
      label: (
        <TabLabel
          icon={PackagePlus}
          label="Staging"
          count={jobStages.length}
          highlight={jobStages.filter((s) => s.status === 'ready_for_pickup').length}
        />
      ),
    },
    {
      value: 'assets',
      label: <TabLabel icon={Wrench} label="Assets" count={assetsQuery.data?.meta.total ?? 0} />,
    },
    {
      value: 'low_stock',
      label: (
        <TabLabel icon={AlertTriangle} label="Low stock" count={lowStockCountQuery.data?.meta?.total ?? 0} />
      ),
    },
    {
      value: 'activity',
      label: <TabLabel icon={History} label="Activity" count={movementsCountQuery.data?.meta?.total ?? 0} />,
    },
    {
      value: 'logistic_orders',
      label: (
        <TabLabel
          icon={ClipboardList}
          label="Logistic Orders"
          count={loCountQuery.data?.total ?? 0}
          highlight={loPendingCountQuery.data?.total ?? 0}
          highlightLabel="pending"
        />
      ),
    },
  ];

  return (
    <div>
      <TabStrip
        className="mb-4"
        tabs={tabs}
        value={view}
        onValueChange={(next) => navigate(VIEW_PATHS[next as InventoryView])}
      />

      {view === 'staging' ? (
        <StagingView locations={allLocations} onToast={showToast} pendingIntent={pendingStageIntent} />
      ) : view === 'assets' ? (
        <AssetsView onToast={showToast} />
      ) : view === 'low_stock' ? (
        <LowStockView />
      ) : view === 'activity' ? (
        <ActionLogView />
      ) : view === 'logistic_orders' ? (
        <LOList />
      ) : (
        <>
          <PageHeader
            title="Inventory"
            description={`Track stock across warehouse, counter, and ${allLocations.filter((l) => l.type === 'truck').length} vans · Org → Branch → Warehouse → Bin`}
            actions={
              <>
                {canUpdateInventory && (
                  <Button variant="outline" size="sm" onClick={() => setActiveDialog('restock')}>
                    <PackagePlus />
                    Restock
                  </Button>
                )}
                {canUpdateInventory && (
                  <Button variant="outline" size="sm" onClick={() => setActiveDialog('transfer')}>
                    <ArrowRightLeft />
                    Transfer
                  </Button>
                )}
                {canCreatePriceBook && (
                  <Button variant="outline" size="sm" onClick={() => setActiveDialog('import_csv')}>
                    <Upload />
                    Import CSV
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExport}
                  title={`Export ${filteredItems.length} items as CSV`}
                >
                  <Download />
                  Export
                </Button>
                {/* Propose one draft PO per vendor for every item below its
                    reorder threshold. Visible regardless of the Low-Stock tile
                    filter state - the dialog operates on ALL flagged items. */}
                {canCreatePO && stats.lowStock > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setGeneratePOLocId(null); setActiveDialog('generate_po'); }}
                  >
                    <ShoppingCart />
                    Generate PO ({stats.lowStock})
                  </Button>
                )}
                {canCreatePriceBook && (
                  <AddItemSplitButton
                    onAddItem={() => setActiveDialog('add')}
                    onAddCategory={() => setActiveDialog('add_category')}
                    onManageCategories={
                      canUpdatePriceBook || canDeletePriceBook
                        ? () => setCategoryPanelOpen(true)
                        : undefined
                    }
                  />
                )}
              </>
            }
          />

          {/* Four clickable KPIs, single-active stock-state semantics carried
              over exactly - lighting one strips the other three. */}
          <StatCardGroup className="mb-4 xl:grid-cols-4">
            <StatCard
              label="Active SKUs"
              value={stats.totalSkus.toLocaleString()}
              active={filters.stockStates.length === 0 && filters.kinds.length === 0}
              onClick={() => setFilters((f) => ({ ...f, stockStates: [], kinds: [] }))}
            />
            <StatCard
              label="Low Stock"
              value={stats.lowStock}
              active={filters.stockStates.includes('low_stock')}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  stockStates: f.stockStates.includes('low_stock')
                    ? f.stockStates.filter((s) => s !== 'low_stock')
                    : [
                        ...f.stockStates.filter(
                          (s) => s !== 'in_stock' && s !== 'out_of_stock' && s !== 'backorder',
                        ),
                        'low_stock',
                      ],
                }))
              }
            />
            <StatCard
              label="Backorder"
              value={stats.backorder}
              active={filters.stockStates.includes('backorder')}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  stockStates: f.stockStates.includes('backorder')
                    ? f.stockStates.filter((s) => s !== 'backorder')
                    : [
                        ...f.stockStates.filter(
                          (s) => s !== 'in_stock' && s !== 'out_of_stock' && s !== 'low_stock',
                        ),
                        'backorder',
                      ],
                }))
              }
            />
            <StatCard
              label="Inventory Value"
              value={formatCurrencyWhole(stats.value)}
              active={filters.stockStates.includes('in_stock')}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  stockStates: f.stockStates.includes('in_stock')
                    ? f.stockStates.filter((s) => s !== 'in_stock')
                    : [
                        ...f.stockStates.filter(
                          (s) => s !== 'low_stock' && s !== 'out_of_stock' && s !== 'backorder',
                        ),
                        'in_stock',
                      ],
                }))
              }
            />
          </StatCardGroup>

          {/* The "Showing" scope row. Both selectors are the legacy components -
              they carry the add/edit/delete affordances, each gated on its own
              subject (#2043: locations -> Inventory, categories -> PriceBook). */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground text-xs font-semibold uppercase">Showing</span>
            <LocationSelector
              locations={allLocations}
              items={allItems}
              activeId={activeLoc}
              onChange={setActiveLoc}
              onAddNew={() => setActiveDialog('add_location')}
              canAdd={canCreateInventory}
              canEdit={canUpdateInventory}
              canDelete={canDeleteInventory}
              onEditLocation={(loc) => setEditingLocation(loc)}
              onDeleteLocation={(loc) => setDeletingLocation(loc)}
            />
            <CategorySelector
              categories={allCategories}
              items={allItems}
              activeName={filters.categories[0] ?? 'all'}
              onChange={(name) =>
                setFilters((f) => ({ ...f, categories: name === 'all' ? [] : [name] }))
              }
              onAddNew={() => setActiveDialog('add_category')}
              open={categoryPanelOpen}
              onOpenChange={setCategoryPanelOpen}
              canAdd={canCreatePriceBook}
              canEdit={canUpdatePriceBook}
              canDelete={canDeletePriceBook}
              onEditCategory={(c) => setEditingCategory(c)}
              onDeleteCategory={async (c) => {
                const usedBy = allItems.filter((i) => i.category === c.name).length;
                if (usedBy > 0) {
                  showToast(
                    `⚠ "${c.name}" can't be deleted - ${usedBy} item${usedBy === 1 ? '' : 's'} still in this category. Re-categorize them first.`,
                  );
                  return;
                }
                if (
                  !(await confirm({
                    title: `Delete category "${c.name}"?`,
                    description: "This can't be undone.",
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  }))
                )
                  return;
                // The guard above counts by NAME over allItems, while the server
                // counts by category_id FK (and by subcategory) and 400s when the
                // two disagree.
                try {
                  await deleteCategory.mutateAsync({ id: c.id });
                } catch {
                  showToast(
                    `✗ Could not delete the category "${c.name}" - it may still have items or subcategories.`,
                  );
                  return;
                }
                setAllCategories((prev) => prev.filter((x) => x.id !== c.id));
                setFilters((f) => (f.categories.includes(c.name) ? { ...f, categories: [] } : f));
                showToast(`🗑 Category "${c.name}" deleted`);
              }}
            />
            {(activeLoc !== 'all' || filters.categories.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActiveLoc('all');
                  setFilters((f) => ({ ...f, categories: [] }));
                }}
              >
                Clear filter
              </Button>
            )}
          </div>

          {filters.stockStates.includes('low_stock') && (
            <LocationStockHealth
              items={allItems}
              locations={allLocations}
              activeLocationId={activeLoc}
              onSelectLocation={(id) => setActiveLoc(id)}
              onRestockLocation={
                canCreatePO
                  ? (id) => { setGeneratePOLocId(id); setActiveDialog('generate_po'); }
                  : undefined
              }
            />
          )}

          <InventoryFilterChips className="mb-3" filters={filters} onChange={setFilters} />

          <MasterDetail
            // No selection means the aside has nothing to render - no detail and
            // no placeholder - so it collapses to zero and the table takes the
            // whole row. Left at its default it holds a 24rem dead column open
            // and squeezes the grid into ~two thirds of the page. Collapsing it
            // rather than dropping the MasterDetail keeps the table MOUNTED, so
            // sorting, paging and dragged column widths survive a row click.
            className={selectedItem ? undefined : 'gap-0'}
            detailWidth={selectedItem ? undefined : '0px'}
            list={
              <DataTable
                columns={columns}
                data={filteredItems}
                getRowId={(item) => item.id}
                isLoading={itemsQuery.isLoading}
                onRowClick={(item) => setSelectedId(item.id)}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                enableColumnResizing
                mobileCards
                empty={<EmptyState title="No items match your filters." />}
              >
                {(table) => (
                  <>
                  <DataTableToolbar
                    table={table}
                    searchValue={search}
                    onSearchChange={setSearch}
                    searchPlaceholder="Search inventory…"
                    filters={
                      <>
                        <InventoryFilterPopover
                          filters={filters}
                          onChange={setFilters}
                          vendors={allVendors}
                          resultCount={filteredItems.length}
                          totalCount={allItems.length}
                        />
                        <span className="flex items-center gap-2">
                          <Switch
                            id={archivedSwitchId}
                            checked={showArchived}
                            onCheckedChange={setShowArchived}
                            aria-label="Show archived items"
                          />
                          <Label htmlFor={archivedSwitchId} className="text-muted-foreground text-xs font-medium">
                            Show archived
                          </Label>
                        </span>
                        <span className="text-muted-foreground text-xs">{resultLabel}</span>
                      </>
                    }
                  />
                  <StockBulkBar
                    count={selectedItems.length}
                    canRestock={canBulkRestock}
                    onClear={() => setRowSelection({})}
                    onExportSelected={handleExportSelected}
                    onRestock={() => setActiveDialog('bulk_restock')}
                  />
                  </>
                )}
              </DataTable>
            }
            hasSelection={!!selectedItem}
            onBack={() => setSelectedId(null)}
            backLabel="Back to items"
            detail={
              selectedItem ? (
                <ItemDetailPanel
                  item={selectedItem}
                  finishName={finishNameById.get(selectedItem.finishId ?? '')}
                  locations={allLocations}
                  movements={itemMovementsQuery.data?.data ?? []}
                  onClose={() => setSelectedId(null)}
                  onTransfer={() => setActiveDialog('transfer')}
                  onDelete={() => setActiveDialog('delete')}
                  onEdit={() => setEditingItem(selectedItem)}
                  onRestock={() => setActiveDialog('restock')}
                  onSetThresholds={() => setActiveDialog('set_thresholds')}
                />
              ) : undefined
            }
          />

          <AddItemDialog
            open={activeDialog === 'add' || !!editingItem}
            onClose={() => { setActiveDialog(null); setEditingItem(null); }}
            editItem={editingItem}
            // #2043 - the shipped #2009 expression (`PriceBookPage.tsx:952`):
            // create mode is unreachable without `create PriceBook` already
            // (the Add Item button above), so only the EDIT path needs
            // gating.
            readOnly={!!editingItem && !canUpdatePriceBook}
            onSave={handleSave}
            vendors={allVendors}
            onAddVendor={async (v) => {
              const saved = await persistVendor(v);
              showToast(`✓ Vendor "${saved.name}" added - selected for this item`);
              return saved;
            }}
            categories={allCategories}
            onAddCategory={async (c) => {
              const saved = await persistCategory(c);
              showToast(`✓ Category "${saved.name}" added - selected for this item`);
              return saved;
            }}
            brands={allBrands}
          />
          <DeleteItemDialog
            open={activeDialog === 'delete'}
            onClose={() => setActiveDialog(null)}
            item={selectedItem}
            onConfirm={handleDelete}
          />
          <AddCategoryDialog
            open={activeDialog === 'add_category' || !!editingCategory}
            onClose={() => { setActiveDialog(null); setEditingCategory(null); }}
            editCategory={editingCategory}
            onCreate={async (c) => {
              // Let a rejection propagate - the dialog's own try/catch keeps it
              // open with an error instead of this page assuming success.
              const saved = await persistCategory(c);
              setFilters((f) => ({ ...f, categories: [saved.name] }));
              setActiveDialog(null);
              showToast(`✓ Category "${saved.name}" added - now filtering`);
              return saved;
            }}
            onUpdate={async (updated) => {
              // #2043/R10 - let a rejection propagate, exactly as the sibling
              // onCreate above: the dialog's own try/catch keeps it open with
              // the server's message instead of this page assuming success.
              const oldName = editingCategory?.name;
              await upsertCategory.mutateAsync(updated);
              setAllCategories((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
              if (oldName && oldName !== updated.name) {
                setAllItems((prev) =>
                  prev.map((it) => (it.category === oldName ? { ...it, category: updated.name } : it)),
                );
                setFilters((f) =>
                  f.categories.includes(oldName)
                    ? { ...f, categories: f.categories.map((n) => (n === oldName ? updated.name : n)) }
                    : f,
                );
              }
              setEditingCategory(null);
              showToast(
                oldName && oldName !== updated.name
                  ? `✓ Category renamed: "${oldName}" → "${updated.name}"`
                  : `✓ Category "${updated.name}" updated`,
              );
            }}
          />
          <TransferDialog
            items={allItems}
            open={activeDialog === 'transfer'}
            onClose={() => setActiveDialog(null)}
            initialItemId={selectedId || undefined}
            locations={allLocations}
            onSubmit={handleTransfer}
            errorMessage={transferError ?? undefined}
            submitting={transferStock.isPending}
            // onBulkStageTransfer is deliberately NOT passed - the legacy page
            // omits it too, so the dialog falls back to its own honest
            // "not wired" guard rather than a fabricated success toast.
          />
          <BulkRestockDialog
            open={activeDialog === 'bulk_restock'}
            onClose={() => setActiveDialog(null)}
            items={selectedItems}
            locations={allLocations}
            onSubmitted={(msg) => { showToast(msg); setRowSelection({}); }}
          />
          <RestockDialog
            open={activeDialog === 'restock'}
            onClose={() => setActiveDialog(null)}
            initialItemId={selectedId || undefined}
            locations={allLocations}
            items={allItems}
            onSubmitted={(msg) => showToast(msg)}
          />
          <SetQuantityDialog
            open={activeDialog === 'set_quantity'}
            onClose={() => setActiveDialog(null)}
            item={selectedItem}
            locations={allLocations}
            onSubmitted={(msg) => showToast(msg)}
          />
          <SetThresholdsDialog
            open={activeDialog === 'set_thresholds'}
            onClose={() => setActiveDialog(null)}
            item={selectedItem}
            locations={allLocations}
            onSubmitted={(msg) => showToast(msg)}
          />
          <AddLocationDialog
            open={activeDialog === 'add_location' || !!editingLocation}
            onClose={() => { setActiveDialog(null); setEditingLocation(null); }}
            editLocation={editingLocation}
            branches={allBranches}
            onAddBranch={async (b) => {
              const saved = await persistBranch(b);
              showToast(`✓ Branch "${saved.name}" added - selected for this location`);
              return saved;
            }}
            onCreate={async (loc) => {
              // #2043/R6 - let a rejection propagate: AddLocationDialog now
              // awaits this handler inside its own submit() and renders the
              // server's message via extractApiError, so catching it here
              // would swallow it into a generic "please try again" again.
              const created = await upsertLocation.mutateAsync({
                name: loc.name,
                type: loc.type,
                branchId: allBranches.find((b) => b.name === loc.branch)?.id ?? null,
                primaryTechId: loc.primaryTechId ?? null,
                vehicle: loc.vehicle ?? null,
                stagingAreas: loc.stagingAreas ?? null,
              });
              setActiveLoc(created.id);
              showToast(`✓ "${loc.name}" created · now showing inventory at this location`);
            }}
            onUpdate={async (updated) => {
              // #2043/R6 - same treatment as onCreate above.
              await upsertLocation.mutateAsync({
                id: updated.id,
                name: updated.name,
                type: updated.type,
                branchId: allBranches.find((b) => b.name === updated.branch)?.id ?? null,
                primaryTechId: updated.primaryTechId ?? null,
                vehicle: updated.vehicle ?? null,
                stagingAreas: updated.stagingAreas ?? null,
              });
              showToast(`✓ "${updated.name}" updated · audit log entry written`);
            }}
          />
          <DeleteLocationDialog
            open={!!deletingLocation}
            onClose={() => setDeletingLocation(null)}
            location={deletingLocation}
            items={allItems}
            onDelete={async (id) => {
              const name = deletingLocation?.name ?? 'Location';
              try {
                await deleteLocation.mutateAsync({ id });
              } catch (err) {
                // The 409 reason (stock still on hand, or "this is the org default
                // location") is the whole point of the failure - a generic message
                // leaves the operator with no next step. Re-thrown so the dialog
                // stays open carrying the same sentence inline.
                //
                // YES, THE OPERATOR SEES THAT SENTENCE TWICE on a 409, and that
                // is deliberate - do not "de-duplicate" this by dropping the
                // toast. The two surfaces do not read the error the same way.
                // DeleteLocationDialog's inline box reaches for exactly one
                // field, `err.response.data.error`, and falls back to a generic
                // "please try again" for anything else. `extractApiError` here
                // is strictly broader: it prefers the API's per-field
                // `details[]` array (the 400 validation shape), then
                // `data.error`, then a plain `Error.message` - so on a network
                // failure, a timeout, or any non-Axios throw, the toast still
                // names the cause while the inline box has already degraded to
                // the generic line. Dropping the toast would silently downgrade
                // every failure shape except the one 409 where they happen to
                // agree. The duplication on that one path is the price of not
                // losing the others.
                showToast(`⚠ Could not delete "${name}" - ${extractApiError(err, 'please try again')}`);
                throw err;
              }
              // The page was filtered to a location that no longer exists.
              if (activeLoc === id) setActiveLoc('all');
              showToast(`✓ "${name}" deleted`);
            }}
          />
          <ImportCSVDialog
            open={activeDialog === 'import_csv'}
            onClose={() => setActiveDialog(null)}
            onImport={handleImport}
            existingCategories={allCategories.map((c) => c.name)}
          />
          <GeneratePODialog
            open={activeDialog === 'generate_po'}
            onClose={() => { setActiveDialog(null); setGeneratePOLocId(null); }}
            items={poDialogItems}
            locations={allLocations}
            scopeLabel={
              generatePOLocId ? allLocations.find((l) => l.id === generatePOLocId)?.name : undefined
            }
          />
        </>
      )}

      {/* Surfaced by the TopBar bell on every view tab, exactly as the legacy
          page mounts them outside the view branch. */}
      <POPreviewDialog
        open={!!alertPreviewPONumber}
        onClose={() => setAlertPreviewPONumber(null)}
        poNumber={alertPreviewPONumber}
        lockEscape
      />
      <LowStockActionDialog
        open={!!lowStockAction}
        onClose={() => setLowStockAction(null)}
        item={lowStockAction ? allItems.find((i) => i.id === lowStockAction.itemId) ?? null : null}
        locations={allLocations}
        kind={lowStockAction?.kind ?? 'low_stock'}
        // #2043/R5 - optional in the same shape as onGeneratePO below.
        onRestock={
          canUpdateInventory
            ? () => { setLowStockAction(null); setActiveDialog('restock'); }
            : undefined
        }
        onGeneratePO={
          canCreatePO
            ? () => { setLowStockAction(null); setGeneratePOLocId(null); setActiveDialog('generate_po'); }
            : undefined
        }
      />
      {confirmDialog}
    </div>
  );
}
