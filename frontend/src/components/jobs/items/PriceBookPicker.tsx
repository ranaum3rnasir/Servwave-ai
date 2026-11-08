/**
 * PriceBookPicker — shared browse/bulk-add modal (v12 SECTION 03), CREATE Wave 2.
 *
 * Complements `AddLineDialog` (v12 SECTION 04) rather than replacing it — this is the
 * "shop the whole catalog, multi-select, one Add" surface; a single precise/one-off line
 * still goes through `AddLineDialog`. Per the DDR's "one door" rule, this picker's own
 * "Add new item" card does NOT open a second, different creation form — it hands the typed
 * query back to the parent via `onCreateAdhoc`, and the parent opens the SAME AddLineDialog
 * (in create mode) that the surface's own "+ Add item" button already opens. This file does
 * NOT import AddLineDialog — wiring that handoff is a later stage's job.
 *
 * SRVW-221: `onCreateAdhoc` still closes this picker (the caller's AddLineDialog needs the
 * screen), but the picker's tab/category/search/qtys survive the round trip - the reset-on-open
 * effect skips itself for the one reopen right after a hand-off (see `pendingReturnRef` below),
 * rather than the pre-fix behavior of wiping everything on every open. AddLineDialog's own
 * `onBackToPicker` is what reopens this picker on Cancel/Back/Escape/an overlay dismissal - a
 * successful create closes both dialogs instead (Ran's ruling: the back affordance available
 * while the create form is open already satisfies the round-trip requirement on its own). Scroll
 * position is NOT preserved - this Dialog's content unmounts while closed like any other
 * close/reopen, and an approach that kept it mounted the whole time (to also save scroll) proved
 * unreliable: see `handleCreateAdhoc`'s comment for why that was tried and reverted.
 *
 * Three top-level tabs (v12): Items (the catalog grid) / Groups (bundles — one click adds
 * every line in the bundle) / Categories (browse by category, tapping one jumps back into
 * Items pre-filtered). Per this program's "no fake/non-functional buttons" rule, the Groups
 * tab only renders when a caller actually supplies `onAddGroup` — a surface that hasn't wired
 * bundle-adding yet simply doesn't get a Groups tab, rather than showing inert cards.
 *
 * Deferred (in the v12 mock but NOT in this wave's prop surface — flagging, not silently
 * dropping): each item card also has a "Details ▾" link in the mock that drills into the same
 * per-line editor (qty/price/markup/cost/description/taxable) pre-filled from that catalog
 * item, before it's added. That needs its own callback (shaped like `onCreateAdhoc`, e.g.
 * `onViewDetails(item)`) wired to AddLineDialog's edit form — left for a follow-up so this
 * wave's scope stays exactly what was asked for.
 *
 * Presentational + callback-driven throughout: this component owns browsing/searching/
 * selecting only. What happens on Add (building line-item payloads, calling create-line
 * endpoints, closing itself) is entirely the caller's decision — see the props doc below.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Check, Package, Layers, Tag, Plus, Minus, X, Loader2 } from 'lucide-react';
import api from '@/lib/axios';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn, extractApiError, formatCurrency } from '@/lib/utils';
import { ProductThumb } from './ProductThumb';
import { searchPriceBookItems, listPriceBookItems } from '@/lib/api/invoices';
import { useFeature } from '@/lib/entitlements';

/**
 * Runtime shape of an item as `/api/price-book/items` and `/api/price-book/items/search`
 * actually return it (price-book.controller.ts's `select`/`include`) — a locally-accurate
 * supplement to `PriceBookItem` from `@/lib/api/invoices`, whose `category` field is typed
 * as a bare `string` even though the live backend returns `{ id, name }`. That's a pre-
 * existing type gap in that file, out of this component's file-scope to fix; this local type
 * (and the cast where the two API functions are called) just reads the real shape so the
 * Categories tab can filter by `category.id`. Field names otherwise deliberately match
 * `@/lib/api/invoices`'s `PriceBookItem` 1:1 (`type`, `taxable`, not `item_type`/`is_taxable`)
 * so the wiring stage's translation into `AddLineItemPayload` (already established in
 * `AddLineDialog.tsx`'s `selected.type` / `selected.taxable`) needs no field renaming here.
 */
export interface PriceBookPickerItem {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  type: 'SERVICE' | 'MATERIAL';
  unit_cost: string | number | null;
  unit_price: string | number;
  taxable: boolean;
  category: { id: string; name: string } | null;
}

/** One row inside a bundle/group — flat, no separate catalog reference resolved. */
export interface PriceBookGroupLine {
  name: string;
  description: string;
  item_type: 'SERVICE' | 'MATERIAL';
  quantity: number;
  unit_price: number;
  unit_cost: number;
  is_taxable: boolean;
}

/** A product bundle from `/api/inventory/item-groups` — added as a whole, one click. */
export interface PriceBookGroup {
  id: string;
  name: string;
  image_url: string | null;
  line_items: PriceBookGroupLine[];
}

interface PriceBookCategory {
  id: string;
  name: string;
  itemCount: number;
}

/** Raw shapes returned by the real backend (backend/src/controllers/inv-catalog.controller.ts). */
interface RawItemGroupLine {
  id: string;
  itemId?: string;
  name: string;
  quantity: number;
  priceOverride?: number;
  costOverride?: number;
  notes?: string;
}
interface RawItemGroup {
  id: string;
  name: string;
  photoUrl?: string;
  lines: RawItemGroupLine[];
}
interface RawCategory {
  id: string;
  name: string;
  _count?: { items?: number };
}

// The real ItemGroupLine has no item_type/is_taxable/description — those live on the linked
// PriceBookItem (itemId), which this picker doesn't resolve for group lines. Groups route to
// Services with a $0 fallback price when no override was set, rather than guessing.
function mapItemGroup(raw: RawItemGroup): PriceBookGroup {
  return {
    id: raw.id,
    name: raw.name,
    image_url: raw.photoUrl ?? null,
    line_items: raw.lines.map((line) => ({
      name: line.name,
      description: line.notes ?? '',
      item_type: 'SERVICE',
      quantity: line.quantity,
      unit_price: line.priceOverride ?? 0,
      unit_cost: line.costOverride ?? 0,
      is_taxable: true,
    })),
  };
}

export interface PriceBookSelection {
  item: PriceBookPickerItem;
  quantity: number;
}

export interface PriceBookPickerProps {
  /** Truthy = open (Radix Dialog convention, matching AddLineDialog's open/onOpenChange). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fires once, with every selected item at its chosen quantity, when the primary Add button
   * is pressed. Building the actual line-item payloads (and calling whatever create-line
   * endpoint applies) is entirely the caller's job — callers that add sequentially (no bulk
   * create-line endpoint exists) return the in-flight promise so this picker can await it.
   *
   * v12 review fix M3: this picker AWAITS the returned promise (if any) and keeps itself open
   * on rejection — a mid-batch failure (e.g. item 3 of 5 fails) is surfaced inline instead of
   * being swallowed by an unhandled rejection while the dialog closes as if everything added.
   * The picker only closes itself once `onAdd` resolves.
   */
  onAdd: (selections: PriceBookSelection[]) => void | Promise<void>;
  /**
   * Which surface this instance is mounted on — drives the primary button's label ("Add to
   * estimate" / "Add to job" / "Add to invoice").
   */
  targetLabel: 'estimate' | 'job' | 'invoice';
  /**
   * The Items grid's dashed "Add new item" card calls this with the current search query, right
   * before this picker closes itself (unchanged from before SRVW-221). The caller opens the
   * shared AddLineDialog in create mode, pre-filled with `query` (`initialQuery`) - the "one
   * door" rule: this picker never renders its own separate creation form. SRVW-221: the caller
   * should thread `onBackToPicker` into that AddLineDialog so Cancel/Back/Escape/an overlay
   * dismissal reopens this picker (flip its `open` back to true) - tab/category/search/qtys come
   * back exactly as the user left them; scroll position does not (see the file header). A
   * successful create does NOT reopen this picker - both dialogs close, which is the intended end
   * of the flow (Ran's ruling).
   */
  onCreateAdhoc: (query: string) => void;
  /**
   * Adds an entire item group/bundle in one action. The Groups tab renders ONLY when this is
   * provided — see the file header note on the "no fake button" rule.
   *
   * R5a (2026-07-21) — awaited the same way `onAdd` is: a caller adding sequentially (no bulk
   * create-line endpoint) may reject partway through the bundle, and that failure must surface
   * inline rather than being swallowed by an unhandled rejection while the card looks like it
   * succeeded.
   */
  onAddGroup?: (group: PriceBookGroup) => void | Promise<void>;
}

/**
 * SRVW-221: imperative escape hatch for `pendingReturnRef` (below). A successful create resolves
 * the hand-off via `addMutation.onSuccess -> setAddOpen(false)` in the three host editors, which
 * bypasses `AddLineDialog`'s `onBackToPicker` wrapper entirely - this picker's own `open` prop
 * never changes, so its reset-on-open effect never runs and never gets a chance to consume the
 * ref. Left alone, the ref strands `true`, and the picker's NEXT, unrelated open (whenever the
 * user next clicks "Price Book") wrongly treats it as a same-session return trip and skips its
 * reset, reopening on stale tab/category/search/qtys - see this file's `handleCreateAdhoc` and the
 * host editors' `addMutation.onSuccess` for the two ends of that gap. Callers wire this into the
 * SAME success handler that closes `AddLineDialog` on a successful create, so the ref never
 * outlives the hand-off it was set for.
 */
export interface PriceBookPickerHandle {
  clearPendingReturn: () => void;
}

const ADD_LABEL: Record<PriceBookPickerProps['targetLabel'], string> = {
  estimate: 'Add to estimate',
  job: 'Add to job',
  invoice: 'Add to invoice',
};

type PickerTab = 'items' | 'groups' | 'categories';

export const PriceBookPicker = forwardRef<PriceBookPickerHandle, PriceBookPickerProps>(function PriceBookPicker({
  open,
  onOpenChange,
  onAdd,
  targetLabel,
  onCreateAdhoc,
  onAddGroup,
}, ref) {
  const [tab, setTab] = useState<PickerTab>('items');
  const [searchQ, setSearchQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [activeCategory, setActiveCategory] = useState<PriceBookCategory | null>(null);
  const [qtys, setQtys] = useState<Record<string, { item: PriceBookPickerItem; qty: number }>>({});
  // v12 review fix M3 — `onAdd` is awaited; these track that in-flight request so a mid-batch
  // failure surfaces inline instead of silently closing the dialog with items still missing.
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // R5a (2026-07-21) — mirrors submitting/addError above, scoped to the Groups tab so a bundle
  // failure doesn't stomp on (or get stomped by) an in-flight Items-tab add.
  const [addingGroupId, setAddingGroupId] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);

  // Bundles come from /api/inventory/item-groups, which sits behind
  // requireFeature('inventory') (Scale). This picker is shared by the job,
  // estimate and invoice line-item editors - all Starter core - so the entitlement
  // check belongs here, once, rather than at each of the three host surfaces.
  // Without it the tab renders on a Pro org and 402s the moment it is clicked,
  // mid-edit. The Items tab reads /api/price-book/* and is never plan-gated.
  // Called unconditionally - `&&` after the hook, never around it (rules of hooks).
  const hasInventory = useFeature('inventory');
  const groupsEnabled = !!onAddGroup && hasInventory;

  // SRVW-221: set just before this picker closes itself to hand off to the caller's AddLineDialog
  // (handleCreateAdhoc below) - tells the reset effect that the NEXT open is a return trip, not a
  // fresh browse session, so it should leave tab/category/search/qtys exactly as the user left
  // them instead of wiping them. A ref, not state: it must be readable synchronously inside the
  // effect on the very next open without itself triggering a render.
  const pendingReturnRef = useRef(false);

  // SRVW-221: the ONLY two ways `pendingReturnRef` can be cleared besides the guarded effect
  // below consuming it on a genuine return-trip open. (1) `clearPendingReturn` - the host editor's
  // `addMutation.onSuccess` calls this via `ref` right alongside the `setAddOpen(false)` that
  // closes AddLineDialog on a successful create, so a hand-off that resolves WITHOUT a return trip
  // can't strand the ref true for some later, unrelated open to misread. (2) unmount - if this
  // component's lifetime ever ends mid-hand-off (route change, etc.), the ref dies with it rather
  // than (harmlessly, since a fresh instance starts at `false` anyway, but not for free) leaking a
  // stale closure.
  useImperativeHandle(ref, () => ({
    clearPendingReturn: () => {
      pendingReturnRef.current = false;
    },
  }), []);

  useEffect(() => {
    return () => {
      pendingReturnRef.current = false;
    };
  }, []);

  // Reset all transient state whenever the dialog opens - UNLESS this open is the return leg of
  // an adhoc-create hand-off (pendingReturnRef), in which case the caller intentionally left this
  // component mounted with its state untouched while its own AddLineDialog was up, and reopening
  // should show the picker exactly as the user left it. Scroll position is the one thing this
  // does NOT preserve: Radix unmounts this Dialog's content while `open` is false, so the
  // scrollable grid is torn down and rebuilt like any other reopen - honestly not fixed here (see
  // the file header and AddLineDialog.tsx's `onBackToPicker` doc for why a fully-mounted-behind
  // approach was tried and reverted).
  useEffect(() => {
    if (!open) return;
    if (pendingReturnRef.current) {
      pendingReturnRef.current = false;
      return;
    }
    setTab('items');
    setSearchQ('');
    setDebouncedQ('');
    setActiveCategory(null);
    setQtys({});
    setSubmitting(false);
    setAddError(null);
    setAddingGroupId(null);
    setGroupError(null);
  }, [open]);

  // Debounce search input before it drives a query (mirrors AddLineDialog's 300ms debounce).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  const { data: items = [], isLoading: itemsLoading } = useQuery<PriceBookPickerItem[]>({
    queryKey: ['price-book-picker-items', debouncedQ],
    queryFn: async () => {
      // A typed search narrows via searchPriceBookItems; an empty box browses the full active
      // catalog via listPriceBookItems — the picker's job is "browse the catalog", so it
      // shouldn't open on an empty grid waiting for the first keystroke.
      const raw = debouncedQ ? await searchPriceBookItems(debouncedQ) : await listPriceBookItems();
      // Cast: see the PriceBookPickerItem doc comment re: invoices.ts's `category: string` gap.
      return raw as unknown as PriceBookPickerItem[];
    },
    enabled: open && tab === 'items',
  });

  const { data: categories = [] } = useQuery<PriceBookCategory[]>({
    queryKey: ['price-book-picker-categories'],
    queryFn: async () => {
      const res = await api.get('/api/price-book/categories');
      const raw: RawCategory[] = res.data?.data ?? [];
      return raw.map((c) => ({ id: c.id, name: c.name, itemCount: c._count?.items ?? 0 }));
    },
    enabled: open,
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery<PriceBookGroup[]>({
    queryKey: ['price-book-picker-groups'],
    queryFn: async () => {
      const res = await api.get('/api/inventory/item-groups');
      const raw: RawItemGroup[] = res.data?.itemGroups ?? [];
      return raw.map(mapItemGroup);
    },
    enabled: open && groupsEnabled && tab === 'groups',
  });

  const visibleItems = useMemo(
    () => (activeCategory ? items.filter((it) => it.category?.id === activeCategory.id) : items),
    [items, activeCategory],
  );

  const visibleGroups = useMemo(() => {
    const needle = debouncedQ.toLowerCase();
    if (!needle) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(needle) ||
        g.line_items.some((li) => li.name.toLowerCase().includes(needle)),
    );
  }, [groups, debouncedQ]);

  const visibleCategories = useMemo(() => {
    const needle = debouncedQ.toLowerCase();
    if (!needle) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(needle));
  }, [categories, debouncedQ]);

  const selectedEntries = Object.values(qtys).filter((e) => e.qty > 0);
  const selectedCount = selectedEntries.length;
  const totalUnits = selectedEntries.reduce((s, e) => s + e.qty, 0);
  const totalPrice = selectedEntries.reduce((s, e) => s + e.qty * Number(e.item.unit_price || 0), 0);

  function setQty(item: PriceBookPickerItem, qty: number) {
    const next = Math.max(0, Math.round(qty));
    setQtys((prev) => {
      const copy = { ...prev };
      if (next === 0) delete copy[item.id];
      else copy[item.id] = { item, qty: next };
      return copy;
    });
  }

  async function handleAdd() {
    if (selectedEntries.length === 0 || submitting) return;
    setSubmitting(true);
    setAddError(null);
    try {
      // Await the caller's promise (if it returns one) BEFORE closing — a caller adding
      // sequentially with no bulk create-line endpoint may reject partway through, and the
      // dialog must stay open with the error visible rather than closing as if every item added.
      await onAdd(selectedEntries.map(({ item, qty }) => ({ item, quantity: qty })));
      onOpenChange(false);
    } catch (err: unknown) {
      setAddError(extractApiError(err, 'Some items could not be added. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  // R5a (2026-07-21) — the M3 partial-failure fix `handleAdd` above already has, applied to
  // group/bundle adds: await the caller, keep the card's own busy state so a double-click can't
  // fire the same bundle twice, and surface a rejection inline instead of letting it vanish.
  async function handleAddGroupClick(group: PriceBookGroup) {
    if (!onAddGroup || addingGroupId) return;
    setAddingGroupId(group.id);
    setGroupError(null);
    try {
      await onAddGroup(group);
    } catch (err: unknown) {
      setGroupError(extractApiError(err, `Could not add "${group.name}". Please try again.`));
    } finally {
      setAddingGroupId(null);
    }
  }

  // SRVW-221: still closes itself (the caller's AddLineDialog needs the screen), but marks
  // pendingReturnRef first so the reset effect above leaves tab/category/search/qtys alone the
  // next time this reopens. An earlier version of this fix left the picker's own Dialog `open`
  // the whole time and layered the caller's AddLineDialog on top of it instead of closing -
  // mounted-behind, never touching `onOpenChange` at all. That would have preserved scroll
  // position too (the DOM never leaves the tree), but two simultaneously-open Radix Dialogs
  // proved unreliable in practice: this picker's own dismissable-layer intermittently treated a
  // click inside the OTHER (sibling, not nested) dialog as an outside click and closed itself out
  // from under the user. Closing-and-reopening like this is the boring, reliable version of the
  // fix - it costs the scroll position (this Dialog's content unmounts while closed, same as any
  // other close/reopen) in exchange for tab/category/search/qtys surviving intact and no flaky
  // cross-dialog dismissal. See AddLineDialog.tsx's `onBackToPicker` for the return trip, which is
  // expected to flip this picker's `open` back to true.
  function handleCreateAdhoc() {
    pendingReturnRef.current = true;
    onCreateAdhoc(searchQ.trim());
    onOpenChange(false);
  }

  function handlePickCategory(cat: PriceBookCategory) {
    setActiveCategory(cat);
    setTab('items');
  }

  const isItems = tab === 'items';
  const isGroups = tab === 'groups';
  const isCategories = tab === 'categories';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let Escape/overlay-click close the dialog out from under an in-flight onAdd
        // (mirrors AddLineDialog's own isLoading guard) or group add — closing mid-bundle would
        // unmount this instance before its own useEffect-on-open reset ever lets the user see a
        // partial-failure error, silently defeating the R5a fix that exists to surface it.
        if (submitting || addingGroupId) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[min(64rem,95vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader divider className="px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-ic bg-sage-50 text-sm font-extrabold text-sage-700">
              $
            </span>
            Price book
          </DialogTitle>

          <Tabs value={tab} onValueChange={(v) => setTab(v as PickerTab)} className="mt-3">
            <TabsList variant="pill" className="gap-1 p-1">
              <TabsTrigger value="items" variant="pill" className="gap-1.5 px-3 py-1.5">
                <Package className="h-3.5 w-3.5" /> Items
              </TabsTrigger>
              {groupsEnabled && (
                <TabsTrigger value="groups" variant="pill" className="gap-1.5 px-3 py-1.5">
                  <Layers className="h-3.5 w-3.5" /> Groups
                </TabsTrigger>
              )}
              <TabsTrigger value="categories" variant="pill" className="gap-1.5 px-3 py-1.5">
                <Tag className="h-3.5 w-3.5" /> Categories
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Search lives in the header (v12: one box searches items/groups/categories),
              not per-tab — matches SECTION 03's pbhead layout. */}
          <div className="mt-3 space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <Input
                autoFocus
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search items, groups or categories"
                className="h-10 pl-9"
                aria-label="Search the price book"
              />
            </div>
            {isItems && activeCategory && (
              // Left raw: an active-filter chip (border-primary + bg-primary-subtle fill
              // with a close-X) - no outline+brand cell is minted on Button.
              <button
                type="button"
                onClick={() => setActiveCategory(null)}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary-subtle px-3 py-1 text-xs font-semibold text-primary"
              >
                {activeCategory.name}
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </DialogHeader>

        {/* ── Items tab ─────────────────────────────────────────── */}
        {isItems && (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {itemsLoading ? (
              <p className="py-10 text-center text-sm text-text-secondary">Searching…</p>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {visibleItems.map((it) => (
                  <ItemCard key={it.id} item={it} qty={qtys[it.id]?.qty ?? 0} onQty={(n) => setQty(it, n)} />
                ))}
                <AdhocCard query={searchQ.trim()} onClick={handleCreateAdhoc} />
              </div>
            )}
          </div>
        )}

        {/* ── Groups tab ────────────────────────────────────────── */}
        {isGroups && groupsEnabled && (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {groupsLoading ? (
              <p className="py-10 text-center text-sm text-text-secondary">Searching…</p>
            ) : visibleGroups.length === 0 ? (
              <EmptyState title="No item groups found." />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleGroups.map((g) => (
                  <GroupCard
                    key={g.id}
                    group={g}
                    busy={addingGroupId === g.id}
                    disabled={addingGroupId !== null && addingGroupId !== g.id}
                    onClick={() => handleAddGroupClick(g)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Categories tab ────────────────────────────────────── */}
        {isCategories && (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {visibleCategories.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-secondary">
                {categories.length === 0 ? 'No categories yet.' : 'No categories match your search.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {visibleCategories.map((cat) => (
                  // Left raw: a category grid-card click target with heterogeneous
                  // content (name + item count), not Button-shaped.
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handlePickCategory(cat)}
                    className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface-light px-4 py-3 text-left transition-all hover:border-primary/40 hover:shadow-card"
                  >
                    <span className="truncate text-sm font-semibold text-text-primary">{cat.name}</span>
                    <span className="whitespace-nowrap text-xs text-text-secondary">
                      {cat.itemCount} item{cat.itemCount === 1 ? '' : 's'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Mid-batch add failure (v12 review fix M3) — shown above the footer so it's visible
            regardless of which tab is active; the dialog stays open (see handleAdd's catch). */}
        {addError && (
          <p className="border-t border-border px-6 pt-3 text-sm text-danger">{addError}</p>
        )}
        {groupError && (
          <p className="border-t border-border px-6 pt-3 text-sm text-danger">{groupError}</p>
        )}

        {/* ── Footer — always present so Cancel never depends on which tab is active ── */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-background-light/60 px-6 py-4">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting || !!addingGroupId}>
            Cancel
          </Button>
          {isItems && (
            <>
              {selectedCount > 0 ? (
                <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-light px-3 py-1.5 text-sm font-semibold text-text-secondary">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-fill">
                    {selectedCount}
                  </span>
                  {totalUnits} unit{totalUnits === 1 ? '' : 's'} · {formatCurrency(totalPrice)}
                </span>
              ) : (
                <span className="text-sm text-text-secondary">Set a quantity to add items</span>
              )}
              <Button type="button" variant="solid" tone="business" disabled={selectedCount === 0 || submitting} onClick={handleAdd}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {ADD_LABEL[targetLabel]}
                {selectedCount > 0 ? ` (${selectedCount})` : ''}
              </Button>
            </>
          )}
          {isGroups && <span className="text-sm text-text-secondary">Click a group to add its items</span>}
          {isCategories && (
            <span className="text-sm text-text-secondary">Tap a category to browse its items</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});

function QtyStepper({ qty, onQty }: { qty: number; onQty: (n: number) => void }) {
  return (
    // Left raw (both halves): a joined quantity-stepper widget - two halves sharing
    // one border, rounded on the left and right edges respectively, not standalone
    // Button-shaped controls (same class as this program's other segmented-control
    // deferrals).
    <div className="mt-2 flex items-center justify-between rounded border border-border">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onQty(qty - 1);
        }}
        disabled={qty === 0}
        aria-label="Decrease quantity"
        className="flex h-8 w-9 items-center justify-center rounded-l text-text-primary transition-colors hover:bg-primary-subtle disabled:opacity-40"
      >
        <Minus className="h-4 w-4" />
      </button>
      <span className="min-w-[2ch] text-center text-sm font-semibold tabular-nums">{qty}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onQty(qty + 1);
        }}
        aria-label="Increase quantity"
        className="flex h-8 w-9 items-center justify-center rounded-r text-text-primary transition-colors hover:bg-primary-subtle"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

function ItemCard({
  item,
  qty,
  onQty,
}: {
  item: PriceBookPickerItem;
  qty: number;
  onQty: (n: number) => void;
}) {
  const selected = qty > 0;
  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-card border bg-surface-light text-left transition-all',
        selected ? 'border-sage-700 ring-2 ring-sage-200' : 'border-border hover:border-primary/40 hover:shadow-card',
      )}
    >
      <div className="relative flex items-center justify-center bg-background-light p-3">
        <ProductThumb src={item.image_url} alt={item.name} itemType={item.type} size={72} />
        {selected && (
          <span className="absolute right-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-ic bg-sage-700 px-1.5 text-[11px] font-extrabold text-on-fill">
            ×{qty}
          </span>
        )}
      </div>
      {/* Left raw: card-body click target with heterogeneous content (name + price),
          not Button-shaped. */}
      <button
        type="button"
        onClick={() => onQty(qty === 0 ? 1 : qty)}
        className="flex flex-1 flex-col gap-1 p-3 text-left"
      >
        <p className="line-clamp-2 text-sm font-semibold text-text-primary">{item.name}</p>
        <p className="text-sm font-bold text-text-primary">{formatCurrency(item.unit_price)}</p>
      </button>
      <div className="px-3 pb-3">
        <QtyStepper qty={qty} onQty={onQty} />
      </div>
    </div>
  );
}

function AdhocCard({ query, onClick }: { query: string; onClick: () => void }) {
  return (
    // Left raw: dashed/tinted "add new" CTA card - a distinct family with no
    // matching Button cell (same shape as AddLineDialog.tsx's inline counterpart).
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[168px] flex-col items-center justify-center gap-1 rounded-card border border-dashed border-sage-200 bg-sage-50 p-4 text-center text-sage-700 transition-colors hover:bg-sage-200/40"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-sage-200">
        <Plus className="h-4 w-4" />
      </span>
      <span className="text-sm font-semibold">
        Add new item{query ? <>: <span className="font-bold">{query}</span></> : null}
      </span>
      <span className="text-[11px] font-medium text-sage-700/70">not in the book</span>
    </button>
  );
}

function GroupCard({
  group,
  busy,
  disabled,
  onClick,
}: {
  group: PriceBookGroup;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const count = group.line_items.length;
  const total = group.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  // A plain div, not a <button> — ProductThumb renders its own <button> internally when a
  // photo is present (for the zoom/lightbox), and a <button> can't nest inside a <button>.
  // role="button" + a click/keydown handler keeps the card itself keyboard-activatable.
  // R5a — busy/disabled (mirrors the L1 fix's bulk-add `busy` guard): a second click on this or
  // any other group card while one is in flight can't race the sequential add loop below.
  return (
    <div
      role="button"
      aria-disabled={disabled || busy}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled || busy ? undefined : onClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled && !busy) {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group flex flex-col gap-3 rounded-card border border-border bg-surface-light p-4 text-left transition-all ${
        disabled || busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-primary/40 hover:shadow-card'
      }`}
    >
      <div className="flex items-center gap-3">
        <ProductThumb src={group.image_url} alt={group.name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{group.name}</p>
          <p className="text-xs text-text-secondary">
            {count} line{count === 1 ? '' : 's'} · {formatCurrency(total)}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-text-secondary">
        {group.line_items.map((li) => `${li.quantity}× ${li.name}`).join(', ')}
      </p>
      <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        {busy ? 'Adding…' : 'Add all items'}
      </span>
    </div>
  );
}
