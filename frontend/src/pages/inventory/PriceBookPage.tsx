import { useEffect, useMemo, useState } from "react";
import { safeHref } from "@/lib/safe-href";
import { UploadedImage } from "@/components/ui/uploaded-image";
import {
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers,
  List,
  Package,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
} from "lucide-react";
import {
  adoptServerId,
  useInventoryItems,
  useBrands,
  useFinishes,
  useItemGroups,
  useCategories,
  useVendors,
  useUpsertItem,
  useUpsertBrand,
  useUpsertItemGroup,
  useUpsertCategory,
  useUpsertVendor,
  useDeleteBrand,
  useDeleteItemGroup,
  useDeleteCategory,
  useSetThresholds,
  startingThresholdsFor,
  type Brand,
  type Category,
  type ItemGroup,
  type Item,
  type ItemGroupLine,
  type ItemVisibility,
  type Vendor,
} from "@/lib/api/inventory";
import { formatCurrency } from "@/lib/utils";
import { TabStrip, type TabStripTab } from "@/components/patterns/TabStrip";
import { Toolbar } from "@/components/patterns/Toolbar";
import { ResizableTable } from "@/components/data/ResizableTable";
import { EmptyState } from '@/components/ui/empty-state';
import { SelectField } from "@/components/form/SelectField";
import { AddBrandDialog } from "@/components/inventory/AddBrandDialog";
import { AddCategoryDialog } from "@/components/inventory/AddCategoryDialog";
import { AddGroupDialog } from "@/components/inventory/AddGroupDialog";
import { AddItemDialog } from "@/components/inventory/AddItemDialog";
import { ItemIdentifiers } from "@/components/inventory/ItemIdentifiers";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { useConfirm } from "@/hooks/useConfirm";
import { toast } from "@/components/ui/use-toast";

/**
 * PriceBookPage (Inventory) — Phase A (PRD §6.A, rev 2026-05-28).
 *
 * NOTE: This is the INVENTORY price book (route /inventory/price-book), distinct
 * from ALPHA's live backend-wired pages/PriceBookPage.tsx (route /price-book).
 *
 * Tabs:
 *   1. Items      — flat list of every catalog item, filterable by Brand/Category/Visibility
 *   2. Brands     — manage Brand entities (CRUD)
 *   3. Groups     — preset bundles of line items for fast estimate / invoice
 *                   creation (CRUD). Each bundle is either "flat rate" (one
 *                   lump-sum line on the estimate) or "individual items"
 *                   (itemized). Lines reference Price Book items or are free-form
 *                   one-off charges. (Redesigned 2026-05-28 — see §6.11.)
 *   4. Categories — full CRUD for the cross-brand category vocabulary
 *   5. Catalog    — empty state; the customer-facing product-photo grid is not built yet
 *
 * Base lists come from the data seam (lib/api/inventory). CRUD persists
 * through the /api/price-book/* write hooks (P0 §D single write path); the
 * local mirror state gives instant feedback and re-seeds from the
 * ['inventory'] invalidation refetch.
 */

type Tab = "items" | "brands" | "groups" | "categories" | "catalog";

const TAB_DEFS: { id: Tab; label: string; icon: typeof Package }[] = [
  { id: "items", label: "Items", icon: Package },
  { id: "brands", label: "Brands", icon: Tag },
  { id: "groups", label: "Groups", icon: Layers },
  { id: "categories", label: "Categories", icon: List },
  { id: "catalog", label: "Catalog", icon: ImageIcon },
];

const PRICE_BOOK_TABS: TabStripTab[] = TAB_DEFS.map((t) => ({
  value: t.id,
  label: (
    <>
      <t.icon className="h-3.5 w-3.5" />
      {t.label}
    </>
  ),
}));

export function PriceBookPage() {
  const { confirm, confirmDialog } = useConfirm();
  const [tab, setTab] = useState<Tab>("items");

  // Base data from the seam.
  const { data: seedBrands = [] } = useBrands();
  const { data: finishes = [] } = useFinishes();
  // Finish is a foreign key - resolve id -> name once, not per rendered row.
  const finishNameById = useMemo(
    () => new Map(finishes.map((f) => [f.id, f.name])),
    [finishes],
  );
  const { data: seedGroups = [] } = useItemGroups();
  const { data: seedItems = [] } = useInventoryItems();
  const { data: seedVendors = [] } = useVendors();
  const { data: seedCategories = [] } = useCategories();

  // Persistence — catalog writes go through /api/price-book/* (P0 §D).
  const upsertItem = useUpsertItem();
  const upsertBrand = useUpsertBrand();
  const upsertItemGroup = useUpsertItemGroup();
  const upsertCategory = useUpsertCategory();
  // SRVW-93 - the nested vendor/category/brand creates below used to fabricate a local
  // id and push it straight into state, so the following item save 400ed on a
  // non-uuid FK. Same fix as the Stock page.
  const upsertVendor = useUpsertVendor();
  const deleteBrandMut = useDeleteBrand();
  const deleteItemGroupMut = useDeleteItemGroup();
  const deleteCategoryMut = useDeleteCategory();
  // SRVW-91 - reserve levels are a StockBalance column, so a newly created item needs a
  // follow-up write; the dialog's Min/Max used to be dropped here too.
  const setThresholds = useSetThresholds();

  // Local working copies so in-session CRUD (adds/edits/deletes/visibility
  // toggles) reflects immediately without persisting — same prototype pattern
  // as InventoryPage. Mirrored from the seam data when the query resolves.
  const [brands, setBrands] = useState<Brand[]>([]);
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);

  useEffect(() => setBrands(seedBrands), [seedBrands]);
  useEffect(() => setGroups(seedGroups), [seedGroups]);
  useEffect(() => setItems(seedItems), [seedItems]);
  useEffect(() => setAllVendors(seedVendors), [seedVendors]);
  useEffect(() => setAllCategories(seedCategories), [seedCategories]);

  // The item currently being edited via row click (rev 2026-05-27). Drives
  // the AddItemDialog mount at the bottom of the page in edit mode.
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  // Add-Item dialog (create mode) — the row-click flow above is edit-only.
  const [showAddItem, setShowAddItem] = useState(false);

  // Add-Brand / Add-Group / Add-Category dialog state
  const [showAddBrand, setShowAddBrand] = useState(false);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ItemGroup | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);

  // Items-tab filter state
  const [itemSearch, setItemSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterVisibility, setFilterVisibility] = useState<"all" | ItemVisibility>(
    "all",
  );
  // KPI-tile-driven filter dimensions (no dropdown counterpart in the filter row).
  // "with"   → only items that have a photoUrl
  // "missing" → only items with no sellPrice and no listPrice
  // The tiles themselves toggle these on/off (click active tile = clear).
  // (PRD §6.A KPI tile row — clickable filter triggers, rev 2026-05-28.)
  const [filterPhoto, setFilterPhoto] = useState<"all" | "with">("all");
  const [filterPrice, setFilterPrice] = useState<"all" | "missing">("all");

  // Groups-tab filter (bundle search)
  const [groupSearch, setGroupSearch] = useState("");
  const [groupTypeFilter, setGroupTypeFilter] = useState<"all" | "individual" | "flat_rate">("all");

  const itemsByBrand = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => {
      if (i.brandId) map.set(i.brandId, (map.get(i.brandId) ?? 0) + 1);
    });
    return map;
  }, [items]);

  // Item count keyed by category *name* (items carry category as a name string,
  // not an id) — drives the count chip on each category card and the
  // "X items still reference this" guard on delete.
  const itemsByCategoryName = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => {
      if (i.category) map.set(i.category, (map.get(i.category) ?? 0) + 1);
    });
    return map;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (filterBrand && it.brandId !== filterBrand) return false;
      if (filterCategory && it.category !== filterCategory) return false;
      if (filterVisibility !== "all" && (it.visibility ?? "catalog") !== filterVisibility)
        return false;
      if (filterPhoto === "with" && !it.photoUrl) return false;
      if (filterPrice === "missing" && (it.sellPrice || it.listPrice)) return false;
      if (q) {
        const hay = `${it.name} ${it.customerName ?? ""} ${it.sku}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    items,
    itemSearch,
    filterBrand,
    filterCategory,
    filterVisibility,
    filterPhoto,
    filterPrice,
  ]);

  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    return groups.filter((g) => {
      if (groupTypeFilter !== "all" && g.groupType !== groupTypeFilter) return false;
      if (q) {
        const hay = `${g.name} ${g.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [groups, groupSearch, groupTypeFilter]);

  // KPI numbers
  const catalogCount = items.filter((i) => (i.visibility ?? "catalog") === "catalog").length;
  const internalCount = items.filter((i) => i.visibility === "internal_only").length;
  const withPhoto = items.filter((i) => !!i.photoUrl).length;
  const withoutPrice = items.filter((i) => !i.sellPrice && !i.listPrice).length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border bg-surface-light px-6 py-4">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span>Operations</span>
          <ChevronRight className="h-3 w-3" />
          <span>Inventory</span>
          <ChevronRight className="h-3 w-3" />
          <span className="font-medium text-text-primary">Price Book</span>
        </div>
        {/* tracking-tight dropped: Heading has no letter-spacing axis (heading.tsx
            header comment, "NOT COVERED, DELIBERATELY"). flex/items-center/gap-2/mt-1
            kept, they're layout. */}
        <Heading className="flex items-center gap-2 mt-1">
          <Tag className="h-5 w-5 shrink-0 text-primary" />
          Price Book
        </Heading>
        <p className="mt-0.5 text-sm text-text-secondary">
          Customer-facing pricing catalog · brands · groups · categories. Items
          auto-mirror from Inventory; the customer never sees stock numbers or
          vendor cost.
        </p>

        {/* Tab strip. TabStrip's own `<Tabs>` root carries no className slot
            (phase 11.6 - see TabStrip.tsx header comment), so the old
            `<Tabs className="mt-4">`'s top margin moves to this wrapping div
            instead - byte-identical 16px gap either way, nothing collapses
            differently since the inner Tabs root itself renders `class=""`.
            This page has no `<TabsContent>` - the tab body below lives in a
            fully separate sibling div outside the tab strip entirely, exactly
            as before - so TabStrip gets no children.
            One disclosed, unreproduced diff: the old TabsList's own
            `gap-1` (4px between triggers) has no home on TabStrip's prop
            surface (no `listClassName`/gap override), so this reverts to
            TabsList's baked-in `gap-[26px]` default - the same category of
            loss already accepted for CustomerDetailPage's `gap-0` override,
            see TabStrip.tsx's own header comment. `justify-start`/`h-auto`/
            `p-0` on the old TabsList were all no-ops (equivalent to the
            unstyled default either way) and are not missed. */}
        <div className="mt-4">
          <TabStrip
            tabs={PRICE_BOOK_TABS}
            active={tab}
            onChange={(v) => setTab(v as Tab)}
            triggerVariant="underline"
            triggerClassName="gap-1.5 px-3 py-2"
          >
            {null}
          </TabStrip>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto bg-background-light px-6 py-5">
        {tab === "items" && (
          <ItemsTab
            items={filteredItems}
            totalCount={items.length}
            brands={brands}
            finishNameById={finishNameById}
            onAdd={() => setShowAddItem(true)}
            categories={allCategories}
            catalogCount={catalogCount}
            internalCount={internalCount}
            withPhoto={withPhoto}
            withoutPrice={withoutPrice}
            itemSearch={itemSearch}
            setItemSearch={setItemSearch}
            filterBrand={filterBrand}
            setFilterBrand={setFilterBrand}
            filterCategory={filterCategory}
            setFilterCategory={setFilterCategory}
            filterVisibility={filterVisibility}
            setFilterVisibility={(v) => {
              // Visibility dropdown is the dropdown counterpart of the In Catalog /
              // Hidden tiles, so picking ANY value here clears the photo + price
              // tile filters to keep the "only one tile active at a time" invariant.
              // (PRD §6.A.2.a rev 2026-05-28 — mutual exclusion.)
              if (v !== "all") {
                setFilterPhoto("all");
                setFilterPrice("all");
              }
              setFilterVisibility(v);
            }}
            filterPhoto={filterPhoto}
            filterPrice={filterPrice}
            onToggleCatalogTile={() => {
              if (filterVisibility === "catalog") {
                setFilterVisibility("all");
              } else {
                setFilterVisibility("catalog");
                setFilterPhoto("all");
                setFilterPrice("all");
              }
            }}
            onToggleHiddenTile={() => {
              if (filterVisibility === "internal_only") {
                setFilterVisibility("all");
              } else {
                setFilterVisibility("internal_only");
                setFilterPhoto("all");
                setFilterPrice("all");
              }
            }}
            onTogglePhotoTile={() => {
              if (filterPhoto === "with") {
                setFilterPhoto("all");
              } else {
                setFilterPhoto("with");
                setFilterVisibility("all");
                setFilterPrice("all");
              }
            }}
            onTogglePriceTile={() => {
              if (filterPrice === "missing") {
                setFilterPrice("all");
              } else {
                setFilterPrice("missing");
                setFilterVisibility("all");
                setFilterPhoto("all");
              }
            }}
            onToggleVisibility={(itemId) => {
              setItems((prev) =>
                prev.map((it) =>
                  it.id === itemId
                    ? {
                        ...it,
                        visibility:
                          (it.visibility ?? "catalog") === "catalog"
                            ? "internal_only"
                            : "catalog",
                      }
                    : it,
                ),
              );
            }}
            onEditItem={(it) => setEditingItem(it)}
          />
        )}

        {tab === "brands" && (
          <BrandsTab
            brands={brands}
            itemsByBrand={itemsByBrand}
            onAdd={() => {
              setEditingBrand(null);
              setShowAddBrand(true);
            }}
            onEdit={(b) => {
              setEditingBrand(b);
              setShowAddBrand(true);
            }}
            onDelete={async (id) => {
              const count = itemsByBrand.get(id) ?? 0;
              if (count > 0) {
                toast({
                  title: "Can't delete this brand",
                  description: `${count} item${count > 1 ? "s" : ""} still reference it. Re-assign them first.`,
                  tone: "danger",
                });
                return;
              }
              if (
                await confirm({
                  title: "Delete this brand?",
                  description: "This can't be undone.",
                  confirmLabel: "Delete",
                  tone: "danger",
                })
              ) {
                deleteBrandMut.mutate({ id });
                setBrands((prev) => prev.filter((b) => b.id !== id));
              }
            }}
          />
        )}

        {tab === "groups" && (
          <GroupsTab
            groups={filteredGroups}
            allItems={items}
            totalCount={groups.length}
            groupSearch={groupSearch}
            setGroupSearch={setGroupSearch}
            groupTypeFilter={groupTypeFilter}
            setGroupTypeFilter={setGroupTypeFilter}
            onAdd={() => {
              setEditingGroup(null);
              setShowAddGroup(true);
            }}
            onEdit={(g) => {
              setEditingGroup(g);
              setShowAddGroup(true);
            }}
            onDelete={async (g) => {
              if (
                await confirm({
                  title: `Delete bundle "${g.name}"?`,
                  description: 'Estimates already saved with this bundle are unaffected.',
                  confirmLabel: 'Delete',
                  tone: 'danger',
                })
              ) {
                deleteItemGroupMut.mutate({ id: g.id });
                setGroups((prev) => prev.filter((x) => x.id !== g.id));
              }
            }}
          />
        )}

        {tab === "categories" && (
          <CategoriesTab
            categories={allCategories}
            itemsByCategoryName={itemsByCategoryName}
            onAdd={() => {
              setEditingCategory(null);
              setShowAddCategory(true);
            }}
            onEdit={(c) => {
              setEditingCategory(c);
              setShowAddCategory(true);
            }}
            onDelete={async (c) => {
              const count = itemsByCategoryName.get(c.name) ?? 0;
              if (count > 0) {
                toast({
                  title: `Can't delete "${c.name}"`,
                  description: `${count} item${count === 1 ? " is" : "s are"} still in this category. Re-categorize them first.`,
                  tone: "danger",
                });
                return;
              }
              if (
                await confirm({
                  title: `Delete category "${c.name}"?`,
                  description: "This can't be undone.",
                  confirmLabel: "Delete",
                  tone: "danger",
                })
              ) {
                deleteCategoryMut.mutate({ id: c.id });
                setAllCategories((prev) => prev.filter((x) => x.id !== c.id));
              }
            }}
          />
        )}

        {tab === "catalog" && <CatalogEmptyState />}
      </div>

      {/* Dialogs */}
      <AddBrandDialog
        open={showAddBrand}
        vendors={allVendors}
        onClose={() => {
          setShowAddBrand(false);
          setEditingBrand(null);
        }}
        editBrand={editingBrand}
        onCreate={async (b) => {
          const saved = adoptServerId(b, await upsertBrand.mutateAsync(b));
          setBrands((prev) => [saved, ...prev]);
          return saved;
        }}
        onUpdate={(b) => {
          upsertBrand.mutate(b);
          setBrands((prev) => prev.map((x) => (x.id === b.id ? b : x)));
        }}
      />
      <AddGroupDialog
        open={showAddGroup}
        onClose={() => {
          setShowAddGroup(false);
          setEditingGroup(null);
        }}
        editGroup={editingGroup}
        items={items}
        onCreate={(g) => {
          upsertItemGroup.mutate(g);
          setGroups((prev) => [g, ...prev]);
        }}
        onUpdate={(g) => {
          upsertItemGroup.mutate(g);
          setGroups((prev) => prev.map((x) => (x.id === g.id ? g : x)));
        }}
      />
      <AddCategoryDialog
        open={showAddCategory}
        onClose={() => {
          setShowAddCategory(false);
          setEditingCategory(null);
        }}
        editCategory={editingCategory}
        onCreate={async (c) => {
          const saved = adoptServerId(c, await upsertCategory.mutateAsync(c));
          setAllCategories((prev) => [saved, ...prev]);
          return saved;
        }}
        onUpdate={(updated) => {
          upsertCategory.mutate(updated);
          const oldName = editingCategory?.name;
          setAllCategories((prev) =>
            prev.map((x) => (x.id === updated.id ? updated : x)),
          );
          // If the name changed, propagate the rename to every item still
          // tagged with the old category string so they don't suddenly look
          // uncategorized.
          if (oldName && oldName !== updated.name) {
            setItems((prev) =>
              prev.map((it) =>
                it.category === oldName ? { ...it, category: updated.name } : it,
              ),
            );
          }
        }}
      />

      {/* Edit-item dialog — opens when an Items-table row is clicked
          (rev 2026-05-27). Reuses AddItemDialog's existing edit mode so all
          fields (SKU, brand, group, category, price, photo, vendor) are
          available; on save we patch the local items[] in place. */}
      <AddItemDialog
        open={showAddItem || !!editingItem}
        onClose={() => {
          setShowAddItem(false);
          setEditingItem(null);
        }}
        editItem={editingItem}
        brands={brands}
        vendors={allVendors}
        onAddVendor={async (v) => {
          const saved = adoptServerId(v, await upsertVendor.mutateAsync(v));
          setAllVendors((prev) => [...prev, saved]);
          return saved;
        }}
        categories={allCategories}
        onAddCategory={async (c) => {
          const saved = adoptServerId(c, await upsertCategory.mutateAsync(c));
          setAllCategories((prev) => [...prev, saved]);
          return saved;
        }}
        onSave={async (payload, editId) => {
          // Persist through the price-book single write path (P0 §D). The
          // ['inventory'] invalidation re-seeds the local mirror with the
          // server row; the edit branch also patches the mirror in place for
          // instant feedback.
          let created: { id: string } | undefined;
          try {
            created = await upsertItem.mutateAsync({
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
            });
          } catch {
            toast({
              title: "Could not save the item",
              description: "Check the fields and try again.",
              tone: "danger",
            });
            return;
          }
          if (editId) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === editId
                  ? {
                      ...i,
                      sku: payload.sku,
                      mpn: payload.mpn,
                      modelNumber: payload.modelNumber,
                      name: payload.name,
                      category: payload.category,
                      trade: payload.trade as Item["trade"],
                      kind: payload.kind as Item["kind"],
                      uom: payload.uom,
                      unitCost: payload.unitCost,
                      sellPrice: payload.sellPrice,
                      serialized: payload.serialized,
                      hazmat: payload.hazmat,
                      trackInventory: payload.trackInventory,
                      // SRVW-90: `type` is deliberately NOT mirrored here - it is
                      // server-derived and the ['inventory'] invalidation re-seeds it.
                      taxable: payload.taxable,
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
            setEditingItem(null);
            return;
          }
          // Create mode — the refetch supplies the real server row.
          // SRVW-91 - reserve levels ride a separate write against the SERVER id.
          const thresholds = startingThresholdsFor(payload.startingStock);
          if (thresholds && created?.id) {
            try {
              await setThresholds.mutateAsync({
                itemId: created.id,
                locationId: thresholds.locationId,
                min: thresholds.min,
                max: thresholds.max,
              });
            } catch {
              // Default tone, not danger: the item itself saved fine - only the
              // optional reserve levels failed, and the user has a stated way out.
              toast({
                title: "Item saved, but the reserve levels were not",
                description: "Set them from the item panel.",
              });
            }
          }
          setShowAddItem(false);
        }}
      />
      {confirmDialog}
    </div>
  );
}

// ============================================================================
// Items tab
// ============================================================================

function ItemsTab({
  items,
  totalCount,
  brands,
  finishNameById,
  categories,
  catalogCount,
  internalCount,
  withPhoto,
  withoutPrice,
  itemSearch,
  setItemSearch,
  filterBrand,
  setFilterBrand,
  filterCategory,
  setFilterCategory,
  filterVisibility,
  setFilterVisibility,
  filterPhoto,
  filterPrice,
  onToggleCatalogTile,
  onToggleHiddenTile,
  onTogglePhotoTile,
  onTogglePriceTile,
  onToggleVisibility,
  onEditItem,
  onAdd,
}: {
  items: Item[];
  totalCount: number;
  brands: Brand[];
  /** finishId -> name, resolved by the page so this table stays prop-driven. */
  finishNameById: Map<string, string>;
  categories: { id: string; name: string }[];
  catalogCount: number;
  internalCount: number;
  withPhoto: number;
  withoutPrice: number;
  itemSearch: string;
  setItemSearch: (v: string) => void;
  filterBrand: string;
  setFilterBrand: (v: string) => void;
  filterCategory: string;
  setFilterCategory: (v: string) => void;
  filterVisibility: "all" | ItemVisibility;
  setFilterVisibility: (v: "all" | ItemVisibility) => void;
  filterPhoto: "all" | "with";
  filterPrice: "all" | "missing";
  onToggleCatalogTile: () => void;
  onToggleHiddenTile: () => void;
  onTogglePhotoTile: () => void;
  onTogglePriceTile: () => void;
  onToggleVisibility: (itemId: string) => void;
  onEditItem: (item: Item) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* KPI tiles — each tile is a one-click filter trigger.
          Click toggles the matching filter on; clicking the active tile clears it
          back to "all". Same locked pattern as Staging (§7.4.A.2) and Vendors
          (§7.6.A) KPI rows. (PRD §6.A rev 2026-05-28.) */}
      <div className="grid grid-cols-4 gap-3">
        <KPITile
          label="In Catalog"
          value={catalogCount}
          hint={`of ${totalCount} total items`}
          tone="primary"
          onClick={onToggleCatalogTile}
          active={filterVisibility === "catalog"}
          ariaLabel="Show only items currently in the customer-facing catalog"
        />
        <KPITile
          label="Hidden from Catalog"
          value={internalCount}
          hint="Labor, fees, internal SKUs"
          tone="neutral"
          onClick={onToggleHiddenTile}
          active={filterVisibility === "internal_only"}
          ariaLabel="Show only items hidden from the customer-facing catalog"
        />
        <KPITile
          label="With Photo"
          value={withPhoto}
          hint={`of ${totalCount} · ${Math.round((withPhoto / Math.max(totalCount, 1)) * 100)}% complete`}
          tone="emerald"
          onClick={onTogglePhotoTile}
          active={filterPhoto === "with"}
          ariaLabel="Show only items that already have a product photo"
        />
        <KPITile
          label="No Price Set"
          value={withoutPrice}
          hint="Resolves via markup engine"
          tone="amber"
          onClick={onTogglePriceTile}
          active={filterPrice === "missing"}
          ariaLabel="Show only items missing both list price and sell price"
        />
      </div>

      {/* Filter row */}
      <Toolbar
        className="rounded-card border border-border bg-surface-light p-3"
        searchValue={itemSearch}
        onSearchChange={setItemSearch}
        searchPlaceholder="Search price book…"
        searchIcon={<Search className="h-3.5 w-3.5 text-text-secondary" />}
        searchInputProps={{ size: "xs", className: "pl-8" }}
        filters={
          <>
            <FilterSelect
              ariaLabel="Brand"
              value={filterBrand || "all"}
              onChange={(v) => setFilterBrand(v === "all" ? "" : v)}
              options={[
                { value: "all", label: "All Brands" },
                ...brands.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />

            <FilterSelect
              ariaLabel="Category"
              value={filterCategory || "all"}
              onChange={(v) => setFilterCategory(v === "all" ? "" : v)}
              options={[
                { value: "all", label: "All Categories" },
                ...categories.map((c) => ({ value: c.name, label: c.name })),
              ]}
            />

            <FilterSelect
              ariaLabel="Visibility"
              value={filterVisibility}
              onChange={(v) => setFilterVisibility(v as "all" | ItemVisibility)}
              options={[
                { value: "all", label: "All visibility" },
                { value: "catalog", label: "🌐 Catalog only" },
                { value: "internal_only", label: "🔒 Internal only" },
              ]}
            />
          </>
        }
        actions={
          <>
            <span className="text-xs text-text-secondary">
              {items.length} of {totalCount} items
            </span>
            <Button size="sm"
              type="button"
              onClick={onAdd}
            >
              <Plus className="h-3.5 w-3.5" />
              Add Item
            </Button>
          </>
        }
      />

      {/* Items table */}
      <ResizableTable
        rows={items}
        getRowKey={(it) => it.id}
        onRowClick={(it) => onEditItem(it)}
        empty={<EmptyState title="No items match the active filters." />}
        columns={[
          {
            id: "photo",
            header: "",
            width: 64,
            min: 56,
            grow: 0,
            cell: (it) =>
              it.photoUrl ? (
                <UploadedImage src={it.photoUrl} radius="sm" edge="ring" className="h-9 w-9" />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded bg-background-light ring-1 ring-border">
                  <ImageIcon className="h-3.5 w-3.5 text-text-secondary" />
                </div>
              ),
          },
          {
            id: "item",
            header: "Item",
            width: 240,
            min: 160,
            grow: 3,
            cell: (it) => (
              <div>
                <div className="font-medium text-text-primary">{it.customerName ?? it.name}</div>
                <div className="text-[11px] text-text-secondary">{it.sku}</div>
                <ItemIdentifiers item={it} finishName={finishNameById.get(it.finishId ?? "")} />
              </div>
            ),
          },
          {
            id: "brand",
            header: "Brand",
            width: 140,
            min: 100,
            cell: (it) => {
              const brand = brands.find((b) => b.id === it.brandId);
              return brand ? (
                <span className="text-sm text-text-primary">{brand.name}</span>
              ) : (
                <span className="text-xs text-text-secondary">—</span>
              );
            },
          },
          {
            id: "category",
            header: "Category",
            width: 140,
            min: 100,
            cellClassName: "text-text-primary",
            cell: (it) => it.category,
          },
          {
            // SRVW-90: the billing type, read-only here - it is a projection of
            // the item's Kind. Labels match AddLineDialog's.
            id: "type",
            header: "Type",
            width: 110,
            min: 90,
            cellClassName: "text-text-primary",
            cell: (it) => (it.type === "MATERIAL" ? "Material" : "Service"),
          },
          {
            id: "price",
            header: "Price",
            align: "right",
            width: 120,
            min: 90,
            cellClassName: "tabular-nums text-text-primary",
            cell: (it) =>
              it.listPrice != null ? (
                <>{formatCurrency(it.listPrice)}</>
              ) : it.sellPrice ? (
                <>{formatCurrency(it.sellPrice)}</>
              ) : (
                <span className="text-xs text-warning">No price</span>
              ),
          },
          {
            // SRVW-90: settable in the Add/Edit Item dialog.
            id: "taxable",
            header: "Taxable",
            align: "center",
            width: 100,
            min: 80,
            grow: 0,
            cell: (it) =>
              it.taxable === false ? (
                <span className="text-xs text-text-secondary">Not taxable</span>
              ) : (
                <span className="text-sm text-text-primary">Taxable</span>
              ),
          },
          {
            id: "visibility",
            header: "Visibility",
            align: "center",
            width: 130,
            min: 110,
            grow: 0,
            cell: (it) => {
              const visibility = it.visibility ?? "catalog";
              return (
                // Raw, deferred: a two-state visibility toggle pill (Catalog /
                // Internal), not a Button - no matching variant/tone cell.
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility(it.id);
                  }}
                  className={[
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition",
                    visibility === "catalog"
                      ? "bg-primary/10 text-primary hover:bg-primary/20"
                      : "bg-background-light text-text-secondary hover:bg-border",
                  ].join(" ")}
                  title={
                    visibility === "catalog"
                      ? "Visible to customers — click to hide"
                      : "Internal only — click to publish to catalog"
                  }
                >
                  {visibility === "catalog" ? (
                    <>
                      <Eye className="h-3 w-3" />
                      Catalog
                    </>
                  ) : (
                    <>
                      <EyeOff className="h-3 w-3" />
                      Internal
                    </>
                  )}
                </button>
              );
            },
          },
        ]}
      />
    </div>
  );
}

// ============================================================================
// Brands tab
// ============================================================================

function BrandsTab({
  brands,
  itemsByBrand,
  onAdd,
  onEdit,
  onDelete,
}: {
  brands: Brand[];
  itemsByBrand: Map<string, number>;
  onAdd: () => void;
  onEdit: (b: Brand) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-secondary">
          {brands.length} brand{brands.length === 1 ? "" : "s"} configured
        </div>
        <Button size="sm"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Brand
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {brands.map((b) => (
          <div
            key={b.id}
            className="group flex flex-col rounded-card border border-border bg-surface-light p-4 transition hover:border-primary/40 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-1 items-start gap-3">
                {/* Brand logo tile — 56px square, fills the card's visual weight
                    so customers (and ops) recognize the brand at a glance.
                    Falls back to a colored letter avatar when no logo is set.
                    (PRD §6.10 rev 2026-05-28.) */}
                {b.logoUrl ? (
                  <UploadedImage
                    src={b.logoUrl}
                    alt={`${b.name} logo`}
                    radius="lg"
                    edge="ring"
                    className="h-14 w-14 flex-shrink-0"
                  />
                ) : (
                  <div
                    aria-hidden
                    className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-base font-bold text-primary ring-1 ring-primary/20"
                  >
                    {b.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Heading level={3} scale="base">{b.name}</Heading>
                    {b.isActive === false && (
                      <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                        Inactive
                      </span>
                    )}
                  </div>
                  {b.description && (
                    <p className="mt-1 text-xs text-text-secondary">{b.description}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                {/* ghost/subtle size="icon": idle text + hover text/bg are a
                    byte-exact match. className="h-6 w-6" restores the raw's
                    ~22px box (p-1 + h-3.5 icon) over the "icon" rung's 40px
                    default - width/height is LAYOUT, not appearance. */}
                <Button
                  variant="ghost"
                  tone="subtle"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onEdit(b)}
                  title="Edit brand"
                >
                  <Tag className="h-3.5 w-3.5" />
                </Button>
                {/* ghost/danger revealOnHover size="icon": idle text-secondary,
                    hover text/bg-danger - a byte-exact match for the raw's
                    idle-grey/hover-red pair. Same h-6 w-6 layout override. */}
                <Button
                  variant="ghost"
                  tone="danger"
                  revealOnHover
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => onDelete(b.id)}
                  title="Delete brand"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="mt-3 text-[11px]">
              <div className="rounded bg-background-light px-2 py-1.5">
                <div className="text-text-secondary">Items</div>
                <div className="font-semibold text-text-primary">
                  {itemsByBrand.get(b.id) ?? 0}
                </div>
              </div>
            </div>

            {b.defaultMarkupPct != null && (
              <div className="mt-2 text-[11px] text-text-secondary">
                Default markup:{" "}
                <span className="font-medium text-text-primary">
                  {(b.defaultMarkupPct - 1) >= 0
                    ? `${Math.round((b.defaultMarkupPct - 1) * 100)}%`
                    : `${b.defaultMarkupPct}×`}
                </span>
              </div>
            )}

            {b.website && (
              <div className="mt-2 text-[11px]">
                <a
                  href={safeHref(b.website)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  Website
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Groups tab
// ============================================================================

function GroupsTab({
  groups,
  allItems,
  totalCount,
  groupSearch,
  setGroupSearch,
  groupTypeFilter,
  setGroupTypeFilter,
  onAdd,
  onEdit,
  onDelete,
}: {
  groups: ItemGroup[];
  allItems: Item[];
  totalCount: number;
  groupSearch: string;
  setGroupSearch: (v: string) => void;
  groupTypeFilter: "all" | "individual" | "flat_rate";
  setGroupTypeFilter: (v: "all" | "individual" | "flat_rate") => void;
  onAdd: () => void;
  onEdit: (g: ItemGroup) => void;
  onDelete: (g: ItemGroup) => void;
}) {
  // Effective price/cost lookup mirrors the dialog — override falls back to
  // the referenced item's listPrice/sellPrice/unitCost.
  function linePrice(line: ItemGroupLine): number {
    if (line.priceOverride != null) return line.priceOverride;
    if (line.itemId) {
      const it = allItems.find((x) => x.id === line.itemId);
      if (it) return it.listPrice ?? it.sellPrice ?? 0;
    }
    return 0;
  }
  function lineCost(line: ItemGroupLine): number {
    if (line.costOverride != null) return line.costOverride;
    if (line.itemId) {
      const it = allItems.find((x) => x.id === line.itemId);
      if (it) return it.unitCost ?? 0;
    }
    return 0;
  }
  function groupSubtotal(g: ItemGroup): number {
    return g.lines.reduce((sum, l) => sum + linePrice(l) * l.quantity, 0);
  }
  function groupCostBasis(g: ItemGroup): number {
    return g.lines.reduce((sum, l) => sum + lineCost(l) * l.quantity, 0);
  }
  function customerSeesPrice(g: ItemGroup): number {
    if (g.groupType === "individual") return groupSubtotal(g);
    return g.flatRatePriceOverride ?? groupSubtotal(g);
  }
  function marginPct(g: ItemGroup): number | null {
    const p = customerSeesPrice(g);
    const c = groupCostBasis(g);
    if (p <= 0) return null;
    if (c <= 0) return 100;
    return ((p - c) / p) * 100;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header explanation + Add button */}
      <div className="rounded-card border border-primary/20 bg-primary/5 p-3">
        <p className="text-sm text-text-primary">
          <strong>Preset bundles</strong> for fast estimate + invoice creation.
          Build a bundle once (parts + labor + dispatch fees), then drop it onto
          any estimate by name — every line populates automatically. Pick{" "}
          <em>Individual items</em> to show the breakdown to the customer, or{" "}
          <em>Flat rate</em> to charge a single lump sum.
        </p>
      </div>

      {/* Filter row + Add */}
      <Toolbar
        searchValue={groupSearch}
        onSearchChange={setGroupSearch}
        searchPlaceholder="Search bundles…"
        searchIcon={<Search className="h-3.5 w-3.5 text-text-secondary" />}
        searchInputProps={{ size: "xs", className: "pl-8" }}
        filters={
          <>
            <FilterSelect
              ariaLabel="Bundle format"
              value={groupTypeFilter}
              onChange={(v) => setGroupTypeFilter(v as "all" | "individual" | "flat_rate")}
              options={[
                { value: "all", label: "All formats" },
                { value: "individual", label: "Individual items" },
                { value: "flat_rate", label: "Flat rate" },
              ]}
            />
            <span className="text-sm text-text-secondary">
              {groups.length} of {totalCount} bundle{totalCount === 1 ? "" : "s"}
            </span>
          </>
        }
        actions={
          <Button size="sm" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
            New Bundle
          </Button>
        }
      />

      {/* Empty state */}
      {groups.length === 0 && (
        <EmptyState
          variant="card"
          icon={Layers}
          title="No bundles yet"
          description="Create your first preset bundle. Standard rekey jobs, lockout service, HVAC capacitor swap — bundle them once and reuse on every estimate."
          action={
            // solid/brand size="sm": idle fill, text colour and font-weight
            // (font-semibold) all match exactly, and sm's px-3 matches the
            // raw's own px-3. hover:bg-primary/90 becomes solid/brand's own
            // hover:bg-primary-dark - a real, disclosed hover-token delta.
            <Button variant="solid" tone="brand" size="sm" onClick={onAdd}>
              <Plus className="h-3.5 w-3.5" />
              New Bundle
            </Button>
          }
        />
      )}

      {/* Bundle cards grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => {
          const customerPrice = customerSeesPrice(g);
          const subtotal = groupSubtotal(g);
          const margin = marginPct(g);
          const isFlat = g.groupType === "flat_rate";
          return (
            <div
              key={g.id}
              className="group flex flex-col overflow-hidden rounded-card border border-border bg-surface-light transition hover:border-primary/40 hover:shadow-sm"
            >
              {/* Hero banner */}
              <div className="relative aspect-[2/1] w-full overflow-hidden bg-background-light">
                {g.photoUrl ? (
                  <UploadedImage
                    src={g.photoUrl}
                    alt={`${g.name} hero`}
                    backdrop
                    className="h-full w-full"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/5 to-background-light">
                    <Layers className="h-8 w-8 text-primary/40" />
                  </div>
                )}
                {/* Format chip — top-left */}
                <div className="absolute left-2 top-2">
                  <span
                    className={[
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur-sm",
                      isFlat
                        ? "bg-warning/10 text-warning"
                        : "bg-info/10 text-info",
                    ].join(" ")}
                  >
                    {isFlat ? "Flat rate" : "Itemized"}
                  </span>
                </div>
                {!g.isActive && (
                  <div className="absolute left-2 top-9">
                    <span className="rounded-full bg-background-light/90 px-2 py-0.5 text-[10px] font-semibold text-text-secondary backdrop-blur-sm">
                      Inactive
                    </span>
                  </div>
                )}
                {/* Edit / Delete — top-right, hover-revealed. Raw, deferred:
                    these carry their own bg-surface-light/90 backdrop-blur-sm
                    shadow-sm chip so the icon stays legible over a photo/
                    gradient hero banner - every ghost cell on Button is
                    background-less at rest, so converting would drop that
                    contrast chip entirely. No matching cell. */}
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => onEdit(g)}
                    className="rounded p-1 text-text-secondary bg-surface-light/90 backdrop-blur-sm shadow-sm hover:bg-surface-light hover:text-text-primary"
                    title="Edit bundle"
                    aria-label={`Edit ${g.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => onDelete(g)}
                    className="rounded p-1 text-text-secondary bg-surface-light/90 backdrop-blur-sm shadow-sm hover:bg-danger/10 hover:text-danger"
                    title="Delete bundle"
                    aria-label={`Delete ${g.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Heading level={3} scale="base">{g.name}</Heading>
                </div>
                {g.description && (
                  <p className="text-xs text-text-secondary">{g.description}</p>
                )}

                {/* Line summary */}
                <div className="mt-1 rounded-md bg-background-light px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-text-secondary">
                    {g.lines.length} line{g.lines.length === 1 ? "" : "s"}
                  </div>
                  <ul className="mt-0.5 space-y-0.5 text-[11px] text-text-primary">
                    {g.lines.slice(0, 3).map((l) => (
                      <li key={l.id} className="truncate">
                        <span className="tabular-nums text-text-secondary">
                          {l.quantity}×
                        </span>{" "}
                        {l.name || "—"}
                      </li>
                    ))}
                    {g.lines.length > 3 && (
                      <li className="text-[10px] text-text-secondary">
                        +{g.lines.length - 3} more…
                      </li>
                    )}
                  </ul>
                </div>

                {/* Footer — price + margin */}
                <div className="mt-auto flex items-end justify-between border-t border-border pt-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-text-secondary">
                      Customer sees
                    </div>
                    <div className="text-lg font-bold tabular-nums text-primary">
                      {formatCurrency(customerPrice)}
                    </div>
                    {isFlat && g.flatRatePriceOverride != null && subtotal !== customerPrice && (
                      <div className="text-[10px] text-text-secondary">
                        items sum: {formatCurrency(subtotal)}
                      </div>
                    )}
                  </div>
                  {margin != null && (
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-wide text-text-secondary">
                        Margin
                      </div>
                      <div
                        className={[
                          "text-sm font-semibold tabular-nums",
                          margin >= 50
                            ? "text-success"
                            : margin >= 25
                              ? "text-warning"
                              : "text-danger",
                        ].join(" ")}
                      >
                        {margin.toFixed(0)}%
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Categories tab — full CRUD with banner-style hero photos (PRD §6.A rev 2026-05-28)
// ============================================================================

const TRADE_TONE: Record<NonNullable<Category["trade"]>, string> = {
  locksmith: "bg-warning/10 text-warning",
  door: "bg-info/10 text-info",
  security: "bg-primary/10 text-primary",
  hvac: "bg-success/10 text-success",
  plumbing: "bg-info/10 text-info",
};

function CategoriesTab({
  categories,
  itemsByCategoryName,
  onAdd,
  onEdit,
  onDelete,
}: {
  categories: Category[];
  itemsByCategoryName: Map<string, number>;
  onAdd: () => void;
  onEdit: (c: Category) => void;
  onDelete: (c: Category) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-secondary">
          {categories.length} categor{categories.length === 1 ? "y" : "ies"} ·
          cross-brand part-type axis (Cylinders, Strikes, Capacitors…)
        </div>
        <Button size="sm"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Category
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => {
          const count = itemsByCategoryName.get(c.name) ?? 0;
          return (
            <div
              key={c.id}
              className="group flex flex-col overflow-hidden rounded-card border border-border bg-surface-light transition hover:border-primary/40 hover:shadow-sm"
            >
              {/* Hero banner — category photo when set, otherwise a List-icon
                  placeholder on a soft gradient. Edit/Delete float top-right
                  over the banner so they're discoverable without crowding the
                  content area (same pattern as GroupsTab). */}
              <div className="relative aspect-[2/1] w-full overflow-hidden bg-background-light">
                {c.photoUrl ? (
                  <UploadedImage
                    src={c.photoUrl}
                    alt={`${c.name} hero`}
                    backdrop
                    className="h-full w-full"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-background-light to-background-light">
                    <List className="h-8 w-8 text-text-secondary" />
                  </div>
                )}
                {/* Raw, deferred: same photo-overlay contrast-chip shape as
                    GroupsTab's Edit/Delete above - no matching Button cell. */}
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => onEdit(c)}
                    className="rounded p-1 text-text-secondary bg-surface-light/90 backdrop-blur-sm shadow-sm hover:bg-surface-light hover:text-text-primary"
                    title="Edit category"
                    aria-label={`Edit ${c.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => onDelete(c)}
                    className="rounded p-1 text-text-secondary bg-surface-light/90 backdrop-blur-sm shadow-sm hover:bg-danger/10 hover:text-danger"
                    title="Delete category"
                    aria-label={`Delete ${c.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1 p-4">
                <div className="flex items-center justify-between gap-2">
                  <Heading level={3} scale="base">{c.name}</Heading>
                  {c.trade && (
                    <span
                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize ${TRADE_TONE[c.trade]}`}
                    >
                      {c.trade}
                    </span>
                  )}
                </div>
                {c.description && (
                  <p className="text-xs text-text-secondary">{c.description}</p>
                )}
                <div className="mt-2 text-[11px] text-text-secondary">
                  Items:{" "}
                  <span className="font-semibold text-text-primary">{count}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Catalog tab
// ============================================================================

function CatalogEmptyState() {
  return (
    <div className="flex items-start justify-center">
      <div
        role="status"
        className="w-full max-w-[520px] rounded-xl border border-border bg-surface-light p-8 text-center shadow-sm"
      >
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-background-light text-text-secondary">
          <ImageIcon className="h-5 w-5" />
        </div>
        <Heading level={2} scale="lg" className="mt-4">
          Catalog
        </Heading>
        <p className="mx-auto mt-2 max-w-[420px] text-sm leading-relaxed text-text-secondary">
          A customer-facing view of your price book with photos and list
          prices. Not available yet.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Shared bits
// ============================================================================

function KPITile({
  label,
  value,
  hint,
  tone,
  onClick,
  active,
  ariaLabel,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "primary" | "neutral" | "emerald" | "amber";
  /** When provided, the tile becomes a clickable filter trigger. The active
   *  state gets a primary ring + "FILTERED" pill — same locked-tile pattern as
   *  Staging (§7.4.A.2) and Vendors (§7.6.A). Clicking the active tile clears
   *  the filter (toggle-off). */
  onClick?: () => void;
  active?: boolean;
  ariaLabel?: string;
}) {
  const TONE = {
    primary: "border-primary/20 bg-primary/10 text-primary",
    neutral: "border-border bg-surface-light text-text-primary",
    emerald: "border-success/20 bg-success/10 text-success",
    amber: "border-warning/20 bg-warning/10 text-warning",
  }[tone];
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
          {label}
        </span>
        {active && (
          <span className="rounded-full bg-primary px-1.5 py-0 text-[9px] font-bold uppercase tracking-wide text-on-fill">
            filtered
          </span>
        )}
      </div>
      <div className="text-2xl font-bold leading-tight text-text-primary">{value}</div>
      <div className="text-[10px] text-text-secondary">{hint}</div>
    </>
  );

  const baseCls = `rounded-card border ${TONE} px-3 py-2`;
  if (!onClick) {
    return <div className={baseCls}>{body}</div>;
  }
  return (
    // Raw, deferred: a KPI-tile click-filter target with heterogeneous
    // content (label + value + hint), not a Button.
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel ?? `${label} · click to filter`}
      title={ariaLabel ?? `${label} · click to filter`}
      className={[
        baseCls,
        "text-left transition hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "ring-2 ring-primary" : "",
      ].join(" ")}
    >
      {body}
    </button>
  );
}

function FilterSelect({
  value,
  onChange,
  disabled,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <SelectField
      aria-label={ariaLabel}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      className="h-9 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      options={options}
    />
  );
}

export default PriceBookPage;
