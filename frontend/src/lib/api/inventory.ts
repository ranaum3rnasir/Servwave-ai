import type { AxiosProgressEvent } from 'axios';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import * as mock from '@/lib/api/_mock/inventory';
import { useFeature } from '@/lib/entitlements';
import type {
  Vendor, Brand, Category, ItemGroup, Location, Branch, Movement, MovementType,
  JobStage, StageAttachment, StockApproval, InventoryJob, Tech,
} from '@/lib/api/_mock/inventory';

// Single flip-to-API flag for the whole Inventory module (Track 2 sets false).
const USE_MOCK = false;

// ─── Real server-contract types (P0) ────────────────────────────────────────
// The Item + PurchaseOrder families now mirror the live API rather than the
// prototype seeds: `reserved` is gone from stock rows (QA-904 — no v1 write
// path populates it), and `unitCost`/`listPrice` are optional because the
// server strips costs for users without pricing visibility (canSeePricing).
// Two values, deliberately. `labor`, `bundle` and `fee` were retired on
// 2026-08-12: all three already billed as SERVICE through typeForKind, and the
// Stock > Items grid filtered bundle and fee out, so an item saved as either
// was created and then invisible. The server folds the retired tokens into
// 'service' on write (normalizeKind), so no reader has to know they existed.
export type ItemKind = 'material' | 'service';
export type Trade = 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing';
export type ItemStatus = 'active' | 'on_backorder' | 'discontinued';
export type ItemVisibility = 'catalog' | 'internal_only';

export type StockAtLocation = {
  locationId: string;
  onHand: number;
  min?: number;
  max?: number;
};

export type Item = {
  id: string;
  sku: string;
  /** Manufacturer part number - shown in the UI as "Part Number". Null once
   *  the operator clears it: an ABSENT key means "leave unchanged" to the
   *  price-book PATCH, so a clear has to travel as an explicit null. */
  mpn?: string | null;
  modelNumber?: string | null;
  upc?: string;
  name: string;
  category: string;
  trade: Trade;
  kind: ItemKind;
  uom: string;
  /** Absent when the server cost-strips the response (no `read Invoice`). */
  unitCost?: number;
  sellPrice: number;
  serialized: boolean;
  hazmat: boolean;
  /** Inventory P1: deduct stock when this item is added to jobs/invoices (newly added lines only). */
  trackInventory?: boolean;
  status: ItemStatus;
  /** Hybrid delete (Task 1/3): false once an item is archived rather than
   *  hard-deleted (still referenced by history). Absent under USE_MOCK. */
  isActive?: boolean;
  vendor: string;
  stock: StockAtLocation[];
  serials?: string[];
  photoUrl?: string;
  updatedAt: string;
  /** Same clear-versus-omit contract as `mpn` above. */
  brandId?: string | null;
  /** Same clear-versus-omit contract as `mpn` above. */
  finishId?: string | null;
  visibility?: ItemVisibility;
  customerName?: string;
  customerDescription?: string;
  keyFeatures?: string[];
  /** Absent when the server cost-strips the response. */
  listPrice?: number;
  /** SRVW-90: read-only projection of `kind`, derived server-side. What
   *  estimates/invoices/jobs key on. Optional so the `_mock` seeds still fit. */
  type?: 'SERVICE' | 'MATERIAL';
  /** SRVW-90: apply sales tax on estimates and invoices. Server default true. */
  taxable?: boolean;
};

/** Per-org catalog entity, mirroring Brand. The item points at it by id. */
export type Finish = {
  id: string;
  name: string;
  /** BHMA code, e.g. "626". Optional - trades outside door hardware have none. */
  code?: string;
  isActive?: boolean;
};

/** Supplies the unit dropdown's options ONLY. `Item.uom` remains the code
 *  string, not a foreign key - see the schema comment on the model. */
export type UomOption = {
  id: string;
  code: string;
  label?: string;
  isActive?: boolean;
};

/** Purchasing Audit Verdict PR 2: the honest lifecycle. `sent` is gone (ServWave never
 *  sends a PO); `ordered` is set by hand via useMarkOrdered, `cancelled` is the exit that
 *  is not a delete. Open bucket = draft + ordered + partial; History = received + closed +
 *  cancelled. Labels/intents live in design-system/status-registry.ts (purchaseOrder). */
export type POStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'closed' | 'cancelled';
export const PO_STATUSES: readonly POStatus[] = ['draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'];
export const OPEN_PO_STATUSES: readonly POStatus[] = ['draft', 'ordered', 'partial'];
export const HISTORY_PO_STATUSES: readonly POStatus[] = ['received', 'closed', 'cancelled'];

export type POLine = {
  /** Present on server-read POs (PurchaseOrder.lines); absent on create payloads. */
  id?: string;
  itemSku: string;
  itemName: string;
  uom: string;
  qtyOrdered: number;
  qtyReceived: number;
  /** Absent when the server cost-strips the response (no `read Invoice`). */
  unitCost?: number;
  /** The linked catalog item's unit cost (S3.2 one money rule): a line is priced
   *  `unitCost ?? catalogUnitCost ?? 0` via `lib/inventory/po-money`. Null when the
   *  line is uncatalogued or the item has no cost; absent on create payloads. */
  catalogUnitCost?: number | null;
  priceBookItemId?: string;
};

export type PurchaseOrder = {
  id: string;
  poNumber: string;
  vendor: string;
  /** FK to Vendor — present once the server serializes vendor_id (P2). */
  vendorId?: string;
  status: POStatus;
  /** FK to Job when linked (S3.3: the Edit form pre-selects by id, never by number). */
  jobId?: string;
  customerId?: string;
  jobNumber?: string;
  customer?: string;
  site?: string;
  trade?: 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing' | 'multi';
  /** Null until "Mark as ordered" — a draft has no order date ("Ordered" never means "created"). */
  orderedAt: string | null;
  /** Who marked it ordered; null when unmarked (or the user is gone). */
  orderedBy: { id: string; name: string } | null;
  expectedDate?: string;
  /** Stamped on entering `received`, cleared when moved back to draft/ordered/partial. */
  receivedAt: string | null;
  /** Server-computed: receivedAt − orderedAt in whole days; null when either is missing. */
  leadTimeDays: number | null;
  /** Free text printed on the document as "Notes to the vendor". */
  notes: string | null;
  /** Buyer signature persisted from the preview (data URL + name + server time). */
  signatureData: string | null;
  signatureName: string | null;
  signatureAt: string | null;
  createdAt: string;
  lines: POLine[];
  stagedAsJobStageId?: string;
};

/** What NewPODialog / CreatePOFromJobDialog / GeneratePODialog emit — the PO
 *  number and id are server-assigned (allocateNumber, P0 §A), never generated
 *  client-side. Explicit (not an Omit of PurchaseOrder) so the create payload
 *  can carry the job FK (`jobId`) that the read shape doesn't expose. */
export type NewPOInput = {
  vendor: string;
  /** FK when picked from the vendor list (P2 backend accepts it). */
  vendorId?: string;
  status: POStatus;
  /** uuid — links PurchaseOrder.job_id (server derives jobNumber). */
  jobId?: string;
  customerId?: string;
  /** Display fallback only (existing behavior). */
  jobNumber?: string;
  customer?: string;
  site?: string;
  trade?: PurchaseOrder['trade'];
  /** Honoured by the server ONLY together with `status: 'ordered'` (imports); a draft is
   *  created unordered whatever the client sends. */
  orderedAt?: string;
  expectedDate?: string;
  notes?: string | null;
  lines: NewPOLineInput[];
};

/** A create-payload line: the read shape, except `unitCost` may be an explicit `null`
 *  ("no cost known" — the Create PO dialog's blank money input). The server stores null
 *  either way; sending it explicitly keeps the payload honest about a cleared field. */
export type NewPOLineInput = Omit<POLine, 'unitCost'> & { unitCost?: number | null };

export type ImportItemsResult = {
  created: number;
  updated: number;
  /** Rows that were NOT imported. */
  errors: { index: number; message: string }[];
  /**
   * Rows that WERE imported but lost something on the way - today, a Vendor cell
   * naming a vendor the org does not own. Optional because a backend one deploy
   * behind omits the key entirely; read it as `?? []`.
   */
  warnings?: { index: number; message: string }[];
  /**
   * Categories the import CREATED, in first-seen order. Unmatched category names
   * are created rather than warned about (the same `create PriceBook` ability
   * gates this route and POST /categories), so this is the operator's receipt -
   * and their cue to fix a typo that just became a real row. Same
   * one-deploy-behind caveat as `warnings`.
   */
  createdCategories?: string[];
};

/** buildPaginationMeta envelope — mirrors backend/src/lib/pagination.ts. */
export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

/** One server-computed low-stock row: a (item, location) pair where
 *  on_hand < min (P5 §1 — GET /api/inventory/low-stock, mapLowStockRow). */
export type LowStockRow = {
  itemId: string;
  sku: string;
  name: string;
  kind?: string;
  status?: string;
  /** Deactivated items stay visible on stock surfaces (QA-105) — badge them. */
  isActive: boolean;
  trackInventory: boolean;
  vendorId: string | null;
  /** Vendor NAME — what the P2 proposal builder groups on. */
  vendorName: string | null;
  locationId: string;
  locationName: string;
  locationType?: string;
  onHand: number;
  min: number;
  max: number | null;
};

/** camelCase filters for the P5 Action log — mapped to the movements
 *  endpoint's snake_case query params inside useMovements. */
export type MovementFilters = {
  type?: MovementType;
  itemId?: string;
  locationId?: string;
  jobId?: string;
  /** Drill-through: show only the movements a single Logistic Order posted. */
  logisticOrderId?: string;
  actorUserId?: string;
  /** ISO date (yyyy-mm-dd) bounds on occurred_at. */
  occurredFrom?: string;
  occurredTo?: string;
  page?: number;
  limit?: number;
};

/** camelCase item write payload — mapped to the price-book snake_case body. */
export type ItemWritePayload = {
  id?: string;
  name: string;
  sku?: string;
  /** An explicit null CLEARS the column; omitting the key leaves it alone. */
  mpn?: string | null;
  modelNumber?: string | null;
  upc?: string;
  brandId?: string | null;
  finishId?: string | null;
  vendorId?: string | null;
  categoryId?: string;
  trade?: string;
  kind?: string;
  uom?: string;
  unitCost?: number;
  sellPrice?: number;
  listPrice?: number;
  serialized?: boolean;
  hazmat?: boolean;
  status?: string;
  visibility?: string;
  customerName?: string;
  customerDescription?: string;
  keyFeatures?: string[];
  photoUrl?: string;
  trackInventory?: boolean;
  /** SRVW-90. `type` is deliberately absent - the server derives it from `kind`,
   *  so there is no second copy of that rule to drift. */
  taxable?: boolean;
};

/** A dialog-synthesized placeholder FK (e.g. `brd_new_1753...`) reaching the
 *  server 400s on `z.string().uuid()` today - loudly. Silently stripping it
 *  would trade that loud failure for a quiet one: a success toast with the
 *  brand/vendor/category never actually saved. Throw instead. */
function assertServerFk(field: string, v?: string | null) {
  if (v && PLACEHOLDER_ID_RE.test(v)) {
    throw new Error(`${field} is still a local placeholder id (${v}) - the parent entity was not saved.`);
  }
  return v;
}

/** camelCase → price-book snake_case body. Undefined keys drop out of the
 *  JSON payload, so untouched fields are simply not sent; an explicit null
 *  survives and is what clears a column. Exported for tests. */
export function toPriceBookBody(p: ItemWritePayload) {
  return {
    name: p.name,
    sku: p.sku,
    mpn: p.mpn,
    model_number: p.modelNumber,
    upc: p.upc,
    brand_id: assertServerFk('brand_id', p.brandId),
    finish_id: assertServerFk('finish_id', p.finishId),
    vendor_id: assertServerFk('vendor_id', p.vendorId),
    category_id: assertServerFk('category_id', p.categoryId),
    trade: p.trade,
    kind: p.kind,
    uom: p.uom,
    unit_cost: p.unitCost,
    sell_price: p.sellPrice,
    list_price: p.listPrice,
    serialized: p.serialized,
    hazmat: p.hazmat,
    status: p.status,
    visibility: p.visibility,
    customer_name: p.customerName,
    customer_description: p.customerDescription,
    key_features: p.keyFeatures,
    photo_url: p.photoUrl,
    track_inventory: p.trackInventory,
    taxable: p.taxable,
  };
}

// Dialogs synthesize ids like `cat_new_<ts>` for freshly-created rows; only a
// UUID is a real server id, and only real ids route to the update path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isServerId(id: string | undefined): id is string {
  return !!id && UUID_RE.test(id);
}

// The same dialog-synthesized placeholder convention, matched narrowly (not
// "anything that is not a UUID") so legitimate non-UUID ids never trip it.
const PLACEHOLDER_ID_RE = /^[a-z]+_new_\d+$/;

/** SRVW-93 - a nested create dialog resolves with `unknown`: a real page awaits
 *  the mutation and gets the persisted row back, but a caller that only wants
 *  today's behaviour (NewPODialog's void handler, a `vi.fn()` test stub
 *  resolving undefined) still compiles and still works. Adopts the server id
 *  only when `result` is genuinely a server-backed row; otherwise falls back
 *  to the locally-synthesized row untouched. */
export function adoptServerId<T extends { id: string }>(local: T, result: unknown): T {
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === 'string' && isServerId(id)) return { ...local, id };
  }
  return local;
}

// Re-export the shared types the P0 API does not reshape so components import
// them from the seam, never `_mock`. (The Pre-PO / RFQ / estimate-reservation
// types left with the Pre-PO queue - Purchasing Audit Verdict PR 2, R10.)
export type {
  Vendor, VendorContact, Brand, Category, ItemGroup, ItemGroupLine, Movement,
  MovementType, Location, Branch,
  JobStage, StagedItem, StageAttachment, StageAuditEntry,
  StockApproval, ApprovalModification, ApprovalActionType, InventoryJob, Tech,
} from '@/lib/api/_mock/inventory';

// Re-export the pure value helpers/labels as plain values (NOT hooks).
export {
  tradeColor, defaultVisibilityForKind, approvalTypeLabel, approvalTypeTint,
  TECH_ROLE_LABEL,
} from '@/lib/api/_mock/inventory';

// Stock helpers, retyped against the live Item shape. `reserved`-based
// helpers (totalReserved/totalAvailable) are gone with the phantom column.
export function totalOnHand(item: Item) {
  return item.stock.reduce((sum, s) => sum + s.onHand, 0);
}
export function isLowStock(item: Item) {
  return item.stock.some((s) => s.min != null && s.onHand < s.min);
}
export function inventoryValue(item: Item) {
  return totalOnHand(item) * (item.unitCost ?? 0);
}

/** `includeArchived` surfaces items the hybrid delete archived instead of
 *  hard-deleting (Task 2's `include_archived` query flag) - the Items grid's
 *  "Show archived" toggle threads it through. */
// parsePagination caps `limit` at 100 on every paginated endpoint, so one
// request can never carry a whole catalog. The 17 consumers of this hook all
// want the full item list (search, item pickers, KPI roll-ups), so we walk the
// {data,meta} envelope (P0 §D5) here and keep handing them a plain Item[].
const ITEMS_PAGE_SIZE = 100;
// Belt-and-braces stop: 100 pages is 10k items, far past any real catalog, and
// bounds the loop even if `meta` ever comes back malformed.
const ITEMS_MAX_PAGES = 100;

async function fetchAllItems(includeArchived: boolean): Promise<Item[]> {
  const archived = includeArchived ? '&include_archived=true' : '';
  const getPage = (page: number) =>
    api.get(`/api/inventory/items?limit=${ITEMS_PAGE_SIZE}&page=${page}${archived}`);

  const first = await getPage(1);
  const all: Item[] = [...(first.data.data ?? [])];
  // Trust meta for the bound; fall back to "stop" when it is absent so a
  // server that drops the envelope degrades to today's single-page result.
  const totalPages = Math.min(Number(first.data.meta?.totalPages) || 1, ITEMS_MAX_PAGES);

  for (let page = 2; page <= totalPages; page += 1) {
    const { data } = await getPage(page);
    all.push(...(data.data ?? []));
  }

  return all;
}

export function useInventoryItems(includeArchived = false) {
  return useQuery<Item[]>({
    queryKey: ['inventory', 'items', { includeArchived }],
    queryFn: USE_MOCK
      ? () => Promise.resolve(mock.items)
      : () => fetchAllItems(includeArchived),
  });
}
export function useVendors() {
  return useQuery<Vendor[]>({ queryKey: ['inventory', 'vendors'], queryFn: USE_MOCK ? () => Promise.resolve(mock.vendors) : () => api.get('/api/inventory/vendors').then((r) => r.data.vendors) });
}
export function useBrands() {
  return useQuery<Brand[]>({ queryKey: ['inventory', 'brands'], queryFn: USE_MOCK ? () => Promise.resolve(mock.brands) : () => api.get('/api/inventory/brands').then((r) => r.data.brands) });
}
// Finish and UomOption post-date the mock seed layer, so they have no
// `mock.*` fallback - USE_MOCK is false module-wide and these are server-only.
export function useFinishes() {
  return useQuery<Finish[]>({ queryKey: ['inventory', 'finishes'], queryFn: () => api.get('/api/inventory/finishes').then((r) => r.data.finishes) });
}
export function useUomOptions() {
  return useQuery<UomOption[]>({ queryKey: ['inventory', 'uom-options'], queryFn: () => api.get('/api/inventory/uom-options').then((r) => r.data.uomOptions) });
}
export function useCategories() {
  return useQuery<Category[]>({ queryKey: ['inventory', 'categories'], queryFn: USE_MOCK ? () => Promise.resolve(mock.categories) : () => api.get('/api/inventory/categories').then((r) => r.data.categories) });
}
export function useItemGroups() {
  return useQuery<ItemGroup[]>({ queryKey: ['inventory', 'item-groups'], queryFn: USE_MOCK ? () => Promise.resolve(mock.itemGroups) : () => api.get('/api/inventory/item-groups').then((r) => r.data.itemGroups) });
}
export function useLocations() {
  return useQuery<Location[]>({ queryKey: ['inventory', 'locations'], queryFn: USE_MOCK ? () => Promise.resolve(mock.locations) : () => api.get('/api/inventory/locations').then((r) => r.data.locations) });
}
export function useBranches() {
  return useQuery<Branch[]>({ queryKey: ['inventory', 'branches'], queryFn: USE_MOCK ? () => Promise.resolve(mock.branches) : () => api.get('/api/inventory/branches').then((r) => r.data.branches) });
}
/** P5 Action log: `{data,meta}` envelope with server-side filters + joins.
 *  Filters are camelCase here and mapped to the endpoint's snake_case params;
 *  undefined values drop out of the querystring (axios skips them). */
export function useMovements(filters: MovementFilters = {}) {
  return useQuery({
    queryKey: ['inventory', 'movements', filters],
    queryFn: () =>
      api
        .get('/api/inventory/movements', {
          params: {
            type: filters.type,
            item_id: filters.itemId,
            location_id: filters.locationId,
            job_id: filters.jobId,
            logistic_order_id: filters.logisticOrderId,
            actor_user_id: filters.actorUserId,
            occurred_from: filters.occurredFrom,
            occurred_to: filters.occurredTo,
            page: filters.page,
            limit: filters.limit,
          },
        })
        .then((r) => r.data as { data: Movement[]; meta: PaginationMeta }),
  });
}

/** P5 §1 — server-computed low stock, unbounded and authoritative (the
 *  client-side header/KPI detection stays capped at the 100-item window).
 *  Lives under the ['inventory'] key prefix so every stock mutation's
 *  invalidation refreshes it for free. */
export function useLowStock(params: { locationId?: string; page?: number; limit?: number } = {}) {
  return useQuery({
    queryKey: ['inventory', 'low-stock', params],
    queryFn: () =>
      api
        .get('/api/inventory/low-stock', {
          params: {
            location_id: params.locationId,
            page: params.page,
            limit: params.limit ?? 100,
          },
        })
        .then((r) => r.data as { data: LowStockRow[]; meta: PaginationMeta }),
  });
}
// `enabled` on this hook and useTechs below, but not on the rest of this module:
// these two are the only ones consumed from OUTSIDE the inventory module (the phone
// Dialer and CallMaskingView), where the host page belongs to a different plan tier
// and nothing else stops them firing. Every other hook here is reached only through
// /inventory/* routes, which <RequireFeature feature="inventory"> already guards.
// Orgs that DO have inventory are unaffected; orgs that do not skip a call that
// could only ever 402.
export function usePurchaseOrders() {
  const hasInventory = useFeature('inventory');
  // No mock branch: the prototype seed predates the PR 2 lifecycle shape (orderedBy,
  // receivedAt, signature…) and is not a PurchaseOrder any more.
  return useQuery<PurchaseOrder[]>({ queryKey: ['inventory', 'purchase-orders'], queryFn: USE_MOCK ? () => Promise.resolve([] as PurchaseOrder[]) : () => api.get('/api/inventory/purchase-orders').then((r) => r.data.purchaseOrders), enabled: USE_MOCK || hasInventory });
}

/** One entry in a PO's real activity timeline (D7) — merged server-side from the
 *  audit log (created/updated/received + actor) and the outbound send history
 *  (subject + recipients). Replaces the fully-synthesized ActivityTabStub. */
export type POActivityEvent = {
  id: string;
  at: string; // ISO 8601
  kind: 'created' | 'updated' | 'received' | 'email_sent' | 'event';
  summary: string;
  actor: string | null;
  detail?: string;
};

/** Lazy — fetched only when the Activity tab mounts with a real PO id. */
export function usePOActivity(poId: string | null | undefined) {
  return useQuery<POActivityEvent[]>({
    queryKey: ['inventory', 'po-activity', poId],
    enabled: !!poId,
    queryFn: USE_MOCK
      ? () => Promise.resolve([] as POActivityEvent[])
      : () => api.get(`/api/inventory/purchase-orders/${poId}/activity`).then((r) => r.data.activity),
  });
}
// useRFQs was removed with the RFQ feature-parking (P0 §C) — the endpoint 404s.
// useEstimateReservations was removed with the Pre-PO queue (Purchasing Audit Verdict PR 2,
// R10) — every /estimate-reservations verb 404s.
export function useJobStages() {
  return useQuery<JobStage[]>({ queryKey: ['inventory', 'job-stages'], queryFn: USE_MOCK ? () => Promise.resolve(mock.jobStages) : () => api.get('/api/inventory/job-stages').then((r) => r.data.jobStages) });
}
// Dormant (stock-approvals endpoint is feature-parked, P0 §C): kept for the
// unrouted ApprovalsView/approval dialogs — must have ZERO mounted callers.
export function useStockApprovals() {
  return useQuery<StockApproval[]>({ queryKey: ['inventory', 'stock-approvals'], queryFn: USE_MOCK ? () => Promise.resolve(mock.stockApprovals) : () => api.get('/api/inventory/stock-approvals').then((r) => r.data.stockApprovals) });
}
export function useInventoryJobs() {
  return useQuery<InventoryJob[]>({ queryKey: ['inventory', 'jobs'], queryFn: USE_MOCK ? () => Promise.resolve(mock.jobs) : () => api.get('/api/inventory/jobs').then((r) => r.data.jobs) });
}
// See the note on usePurchaseOrders - same cross-module consumers, same reasoning.
export function useTechs() {
  const hasInventory = useFeature('inventory');
  return useQuery<Tech[]>({ queryKey: ['inventory', 'techs'], queryFn: USE_MOCK ? () => Promise.resolve(mock.techs) : () => api.get('/api/inventory/techs').then((r) => r.data.techs), enabled: USE_MOCK || hasInventory });
}

// ─── My-van (Inventory P3 — the requester's own truck stock) ────────────────
// GET /api/inventory/my-van is own-scope by construction (primary_tech_id = requester)
// and cost-stripped by projection — `unit_price` is the customer-facing selling price.
// `restricted` is the server-computed D10/D13 lock signal (role TECHNICIAN + the
// `location_restricted` override) — the FE never re-derives it.

export interface MyVan {
  location: { id: string; name: string; type: string; vehicle?: string };
  restricted: boolean;
  balances: {
    item: {
      id: string;
      sku?: string;
      name: string;
      type: string;
      uom?: string;
      unit_price: number;
      track_inventory: boolean;
      is_active: boolean;
      image_url?: string;
    };
    on_hand: number;
    min?: number;
    max?: number;
  }[];
}

export function useMyVan(enabled = true) {
  return useQuery<MyVan | null>({
    queryKey: ['inventory', 'my-van'],
    queryFn: () =>
      api
        .get('/api/inventory/my-van')
        .then((r) => r.data as MyVan)
        // 404 NO_VAN_ASSIGNED ⇒ null (a normal state for van-less users), not an error state.
        .catch((e) => {
          if (e?.response?.status === 404) return null;
          throw e;
        }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * A mutation's `onSuccess`, refreshing `queryKey` without holding the mutation
 * open while it refreshes.
 *
 * The braces are the whole point. Every mutation below used to write
 * `onSuccess: () => qc.invalidateQueries(...)`, and an arrow with no braces
 * RETURNS that promise - which TanStack Query then awaits before it settles
 * `mutateAsync`. `invalidateQueries` settles only once every matching ACTIVE
 * query has finished refetching, and a retry-paused fetch never settles at all,
 * so one stalled inventory query left the mutation pending forever.
 *
 * The dialogs are what made that visible. AddBrandDialog - and the vendor,
 * category and finish dialogs beside it - set `saving = true` on click, disable
 * the save button on it, and clear it only after awaiting the mutation. So a
 * brand the server had already created (201) left its dialog open with the save
 * button permanently disabled and nothing on screen saying why.
 *
 * A caller waits on the WRITE. The refresh that follows is this module's
 * business, not the caller's.
 */
function invalidating(qc: QueryClient, ...queryKeys: readonly (readonly unknown[])[]) {
  return () => {
    for (const queryKey of queryKeys) void qc.invalidateQueries({ queryKey });
  };
}

/**
 * Every query key prefix under ['inventory'], named once so each mutation can
 * declare the blast radius of its own write beside the write itself.
 *
 * Why this exists: every mutation below used to end in
 * `invalidating(qc, ['inventory'])`, and there are 22 query hooks under that
 * prefix. One catalog delete therefore refetched every inventory query mounted
 * on the page. The general API limiter allows 100 requests per 60 seconds per
 * user across all of /api, so a person clicking at normal speed can exhaust it -
 * and when the refused request is the one that would have refreshed a list, the
 * row the server already deleted stays on screen indefinitely. The limit is not
 * the defect; the request volume is.
 */
const KEYS = {
  items: ['inventory', 'items'],
  vendors: ['inventory', 'vendors'],
  vendorCategories: ['inventory', 'vendor-categories'],
  brands: ['inventory', 'brands'],
  finishes: ['inventory', 'finishes'],
  uomOptions: ['inventory', 'uom-options'],
  categories: ['inventory', 'categories'],
  itemGroups: ['inventory', 'item-groups'],
  locations: ['inventory', 'locations'],
  branches: ['inventory', 'branches'],
  movements: ['inventory', 'movements'],
  lowStock: ['inventory', 'low-stock'],
  purchaseOrders: ['inventory', 'purchase-orders'],
  poActivity: ['inventory', 'po-activity'],
  jobStages: ['inventory', 'job-stages'],
  stockApprovals: ['inventory', 'stock-approvals'],
  jobs: ['inventory', 'jobs'],
  techs: ['inventory', 'techs'],
  myVan: ['inventory', 'my-van'],
  assets: ['inventory', 'assets'],
  jobMaterialCost: ['inventory', 'job-material-cost'],
  /** The whole prefix - only for a write whose blast radius really is that wide. */
  everything: ['inventory'],
} as const;

/** An item write. The item list obviously; item groups list their member items,
 *  and both the low-stock rows and the movement log are joined server-side
 *  against the live item name/sku, so a rename must refresh those too. */
const ITEM_VIEWS = [KEYS.items, KEYS.itemGroups, KEYS.lowStock, KEYS.movements];
/** A stock write. On-hand lives on the item rows, every write records a
 *  movement, any write can cross a reserve level, and a van is a location. */
const STOCK_VIEWS = [KEYS.items, KEYS.movements, KEYS.lowStock, KEYS.myVan];
/** A location write. Locations appear on every item's stock rows and on the
 *  low-stock rows, and one of them may be the requester's own van. */
const LOCATION_VIEWS = [KEYS.locations, KEYS.items, KEYS.lowStock, KEYS.myVan];
/** A purchase-order write that does not move stock: the PO and its timeline. */
const PO_VIEWS = [KEYS.purchaseOrders, KEYS.poActivity];
/** A vendor write - the name is displayed on items and on purchase orders. */
const VENDOR_VIEWS = [KEYS.vendors, KEYS.items, KEYS.purchaseOrders];

function useInventoryMutation<TArgs>(path: string, ...queryKeys: readonly (readonly unknown[])[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) =>
      USE_MOCK ? Promise.resolve(args) : api.post(path, args).then((r) => r.data),
    onSuccess: invalidating(qc, ...queryKeys),
  });
}

// ─── Assets (P4 — company tools assigned to technicians) ────────────────────
// New feature ⇒ real-API only (no USE_MOCK branch). Server contract:
// GET list → {data, meta}; single/verbs → {asset}; events → {events}.

export type AssetStatus = 'ACTIVE' | 'RETIRED';
export type AssetEventType = 'ASSIGNED' | 'RETURNED' | 'TRANSFERRED' | 'RETIRED' | 'NOTE';
export type AssetUserRef = { id: string; first_name: string; last_name: string };
export type Asset = {
  id: string;
  name: string;
  serial: string | null;
  status: AssetStatus;
  notes: string | null;
  /** Short-lived signed URL minted per response (or null) — never a storage path. */
  photo_url: string | null;
  price_book_item: { id: string; name: string } | null;
  assigned_user: AssetUserRef | null;
  created_at: string;
  updated_at: string;
};
export type AssetEvent = {
  id: string;
  type: AssetEventType;
  note: string | null;
  at: string;
  /** Counterparty tech (new holder / releasing holder); null for NOTE. */
  user: AssetUserRef | null;
  /** Actor — null only after a user hard-delete (SetNull). */
  by_user: AssetUserRef | null;
};
export type AssetFilters = { status?: AssetStatus; assigned_user_id?: string; search?: string };
export type AssetWriteBody = {
  name: string;
  serial: string | null;
  price_book_item_id: string | null;
  notes: string | null;
};
export type AssetActionInput = {
  id: string;
  action: 'assign' | 'return' | 'transfer' | 'retire' | 'note';
  user_id?: string;
  note?: string;
};

export function useAssets(filters: AssetFilters, page = 1) {
  return useQuery<{ data: Asset[]; meta: { total: number } }>({
    queryKey: ['inventory', 'assets', filters, page],
    queryFn: () =>
      api
        .get('/api/inventory/assets', { params: { ...filters, page, limit: 100 } })
        .then((r) => r.data),
  });
}

export function useAssetEvents(assetId: string | null) {
  return useQuery<AssetEvent[]>({
    queryKey: ['inventory', 'assets', assetId, 'events'],
    queryFn: () => api.get(`/api/inventory/assets/${assetId}/events`).then((r) => r.data.events),
    enabled: !!assetId,
  });
}

export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AssetWriteBody) =>
      api.post('/api/inventory/assets', body).then((r) => r.data.asset as Asset),
    onSuccess: invalidating(qc, KEYS.assets),
  });
}

export function useUpdateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<AssetWriteBody>) =>
      api.patch(`/api/inventory/assets/${id}`, body).then((r) => r.data.asset as Asset),
    onSuccess: invalidating(qc, KEYS.assets),
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete(`/api/inventory/assets/${id}`).then((r) => r.data),
    onSuccess: invalidating(qc, KEYS.assets),
  });
}

/** assign / return / transfer / retire / note — the only writes that move
 *  status + assigned_user_id (PATCH never does). List + per-asset events keys
 *  share the ['inventory','assets'] prefix, so one invalidation covers both. */
export function useAssetAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, ...body }: AssetActionInput) =>
      api.post(`/api/inventory/assets/${id}/${action}`, body).then((r) => r.data.asset as Asset),
    onSuccess: invalidating(qc, KEYS.assets),
  });
}

export function useUploadAssetPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return api
        .post(`/api/inventory/assets/${id}/photo`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        .then((r) => r.data.asset as Asset);
    },
    onSuccess: invalidating(qc, KEYS.assets),
  });
}

// ─── Catalog writes → /api/price-book/* (single write path, P0 §D) ──────────

export function useUpsertItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ItemWritePayload) =>
      p.id
        ? api.patch(`/api/price-book/items/${p.id}`, toPriceBookBody(p)).then((r) => r.data.data)
        : api.post('/api/price-book/items', toPriceBookBody(p)).then((r) => r.data.data),
    onSuccess: invalidating(qc, ...ITEM_VIEWS),
  });
}

export type DeleteItemResult = { mode: 'deleted' | 'archived'; message: string; referenceCount?: number };

/** Hybrid delete - DELETE /api/price-book/items/:id hard-deletes an item with
 *  no references, or archives (is_active=false) one that's still referenced
 *  by history so downstream records stay intact. */
export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete(`/api/price-book/items/${id}`).then((r) => r.data as DeleteItemResult),
    onSuccess: invalidating(qc, ...ITEM_VIEWS),
  });
}

/** Restore an item the hybrid delete archived (is_active back to true) - reuses
 *  the existing price-book update path, since is_active is already an allowed field. */
export function useRestoreItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.patch(`/api/price-book/items/${id}`, { is_active: true }).then((r) => r.data.data),
    onSuccess: invalidating(qc, ...ITEM_VIEWS),
  });
}

export function useUpsertCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Category>) => {
      const body = {
        name: p.name,
        trade: p.trade,
        description: p.description,
        photo_url: p.photoUrl,
      };
      return isServerId(p.id)
        ? api.patch(`/api/price-book/categories/${p.id}`, body).then((r) => r.data.data)
        : api.post('/api/price-book/categories', body).then((r) => r.data.data);
    },
    // Its own list, plus the item list - an item carries its category name.
    onSuccess: invalidating(qc, KEYS.categories, KEYS.items),
  });
}

export function useUpsertBrand() {
  const qc = useQueryClient();
  return useMutation({
    // A dialog-synthesized `brd_new_*` id is stripped so the handler takes its
    // create branch. Unwraps the server's `{brand}` envelope (SRVW-93) so a
    // caller adopting the returned id (adoptServerId) actually sees it.
    mutationFn: (p: Partial<Brand>) =>
      api.post('/api/price-book/brands', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.brand as Brand),
    // The item list too: renaming a brand must not leave a stale label on it.
    onSuccess: invalidating(qc, KEYS.brands, KEYS.items),
  });
}

export function useUpsertFinish() {
  const qc = useQueryClient();
  return useMutation({
    // Same envelope-unwrapping contract as useUpsertBrand: the caller adopts
    // the returned server id, so a `{finish}` wrapper would hand it undefined.
    mutationFn: (p: Partial<Finish>) =>
      api.post('/api/price-book/finishes', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.finish as Finish),
    onSuccess: invalidating(qc, KEYS.finishes, KEYS.items),
  });
}

export function useUpsertUomOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<UomOption>) =>
      api.post('/api/price-book/uom-options', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.uomOption as UomOption),
    onSuccess: invalidating(qc, KEYS.uomOptions, KEYS.items),
  });
}

export function useUpsertItemGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<ItemGroup>) =>
      api.post('/api/price-book/item-groups', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data),
    // A group is a bundle OF items; no item displays the group it belongs to.
    onSuccess: invalidating(qc, KEYS.itemGroups),
  });
}

/**
 * One shared delete for every catalog, parameterised by the list it caches.
 *
 * On success the deleted id is pruned from that list with a direct cache write,
 * so the row leaves the screen the moment the server confirms it rather than
 * when a follow-up GET happens to come back. Every consumer of the list - the
 * manage-catalog dialog, the Price Book tabs, the Add Item dropdowns - reads the
 * same cache, so one write corrects all of them at once.
 *
 * Only on success. A refusal (a 400 with a reason, a 404, a 429) leaves the
 * cache exactly as it was: there is no optimistic pre-removal and no rollback,
 * because an optimistic removal is what makes a failed delete look like a
 * successful one. Invalidation still fires afterwards as a background reconcile,
 * so the server stays the source of truth - and, per `invalidating`, is not
 * awaited, so a caller waits on the write and never on the refresh.
 */
function useDeleteById(
  pathPrefix: string,
  listKey: readonly unknown[],
  ...reconcileKeys: readonly (readonly unknown[])[]
) {
  const qc = useQueryClient();
  const reconcile = invalidating(qc, ...reconcileKeys);
  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete(`${pathPrefix}/${id}`).then((r) => r.data),
    onSuccess: (_data, { id }) => {
      // A list that was never fetched is simply absent - leave it alone.
      qc.setQueryData<{ id: string }[]>(listKey, (list) =>
        Array.isArray(list) ? list.filter((entry) => entry.id !== id) : list,
      );
      reconcile();
    },
  });
}
// Each catalog reconciles its own list and the item list that displays its
// label - a deleted brand must not stay printed on an item row.
export const useDeleteBrand     = () => useDeleteById('/api/price-book/brands', KEYS.brands, KEYS.brands, KEYS.items);
export const useDeleteFinish    = () => useDeleteById('/api/price-book/finishes', KEYS.finishes, KEYS.finishes, KEYS.items);
export const useDeleteUomOption = () => useDeleteById('/api/price-book/uom-options', KEYS.uomOptions, KEYS.uomOptions, KEYS.items);
export const useDeleteItemGroup = () => useDeleteById('/api/price-book/item-groups', KEYS.itemGroups, KEYS.itemGroups);
export const useDeleteCategory  = () => useDeleteById('/api/price-book/categories', KEYS.categories, KEYS.categories, KEYS.items);
// The API guards both of these: a location that still holds stock or is the org
// default gets a 409, a branch with child locations a 400. Surface `error` verbatim.
export const useDeleteLocation  = () => useDeleteById('/api/inventory/locations', KEYS.locations, ...LOCATION_VIEWS);
export const useDeleteBranch    = () => useDeleteById('/api/inventory/branches', KEYS.branches, KEYS.branches, KEYS.locations);

export function useImportItemsCSV() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { items: unknown[] }) =>
      api.post('/api/price-book/items/import', payload).then((r) => r.data as ImportItemsResult),
    // DELIBERATELY WIDE. One import writes items and links them to existing
    // categories and vendors (it creates neither), and every list that prints
    // one of those labels goes stale with it. Naming keys here would be naming
    // most of them, and missing one leaves a stale screen after a bulk load -
    // the one moment a user is least able to spot it. It is also a rare,
    // single-shot action, so the fan-out costs nothing at the limiter.
    onSuccess: invalidating(qc, KEYS.everything),
  });
}

// ─── Stock / PO / staging writes (stay on /api/inventory/*) ─────────────────

/** camelCase location write payload — mapped to the inv-locations snake_case body (P3 §1b). */
export type LocationWritePayload = {
  /** Present ⇒ PATCH /locations/:id; absent ⇒ POST /locations. */
  id?: string;
  name: string;
  type: string;
  branchId?: string | null;
  /** The assigned tech's USER id; null unassigns the van. */
  primaryTechId?: string | null;
  vehicle?: string | null;
  stagingAreas?: string[] | null;
};

/**
 * Create/update an inventory location for real (P3 §1b — replaces the old POST-only,
 * call-site-less stub). Branch/tech arrive as IDs; callers map display names to ids
 * (AddLocationDialog stores the branch by NAME — InventoryPage resolves it via useBranches).
 * Resolves with the server's `{ location }` row (real id for create).
 */
export function useUpsertLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: LocationWritePayload) => {
      const body = {
        name: p.name,
        type: p.type,
        branch_id: p.branchId ?? null,
        primary_tech_id: p.primaryTechId ?? null,
        vehicle: p.vehicle ?? null,
        stagingAreas: p.stagingAreas ?? null,
      };
      return p.id
        ? api.patch(`/api/inventory/locations/${p.id}`, body).then((r) => r.data.location as Location)
        : api.post('/api/inventory/locations', body).then((r) => r.data.location as Location);
    },
    onSuccess: invalidating(qc, ...LOCATION_VIEWS),
  });
}
/** SRVW-93 - the server returns a `{branch}` envelope (inv-locations.controller.ts),
 *  not the raw body useInventoryMutation would resolve with, so this is an explicit
 *  useMutation rather than the generic helper. */
export function useUpsertBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Branch>) =>
      api.post('/api/inventory/branches', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.branch as Branch),
    // A branch owns locations and nothing else.
    onSuccess: invalidating(qc, KEYS.branches, KEYS.locations),
  });
}
// SRVW-92 - unitCost is deliberately optional-and-absent (not `number | null`) so a
// cost-stripped caller (no `read Invoice`) can omit it entirely rather than send a false 0.
export type RestockPayload = {
  itemId: string;
  locationId: string;
  qty: number;
  unitCost?: number;
  source?: string;
  reference?: string;
  notes?: string;
};
export const useRestock           = () => useInventoryMutation<RestockPayload>('/api/inventory/restock', ...STOCK_VIEWS);
/**
 * Many receipts, ONE transaction and ONE audit row - `POST /api/inventory/bulk-restock`,
 * gated `canDo('update','Inventory')`.
 *
 * The body is `bulkRestockSchema` verbatim (`backend/src/controllers/inv-catalog.controller.ts`):
 * a non-empty `lines` array of `{ itemId, locationId, qty, unitCost? }`, ids as uuids, `qty`
 * strictly positive. NOT the single restock's shape - there is no `source`, `reference` or
 * `notes` field on a line, and the server writes the ledger reference itself ('bulk-restock').
 *
 * `unitCost` is optional-and-absent rather than `number | null` for the same reason as
 * `RestockPayload` (SRVW-92): a cost-stripped caller omits the key instead of sending a false 0
 * the server would persist.
 *
 * Every id is re-resolved server-side under `tenantWhere(req)` before anything is written, so a
 * line naming another org's item or location 404s rather than posting.
 */
export type BulkRestockLine = { itemId: string; locationId: string; qty: number; unitCost?: number };
export const useBulkRestock       = () => useInventoryMutation<{ lines: BulkRestockLine[] }>('/api/inventory/bulk-restock', ...STOCK_VIEWS);
export const useTransferStock     = () => useInventoryMutation<unknown>('/api/inventory/transfer', ...STOCK_VIEWS);
/** Inventory P1 §6 — physical count: records ONE `adjust` movement of counted − on-hand.
 *  Deliberately NOT useInventoryMutation: that helper posts its camelCase args verbatim, and
 *  setQuantitySchema is snake_case (item_id/location_id/counted_qty/reason), so posting through
 *  the generic helper 400s on every submit. */
export function useSetQuantity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { itemId: string; locationId: string; countedQty: number; reason: string }) =>
      api
        .post('/api/inventory/stock/set-quantity', {
          item_id: p.itemId,
          location_id: p.locationId,
          counted_qty: p.countedQty,
          reason: p.reason,
        })
        .then((r) => r.data),
    onSuccess: invalidating(qc, ...STOCK_VIEWS),
  });
}

/** SRVW-91 - per-(item, location) reserve levels. Deliberately NOT useInventoryMutation:
 *  that helper posts its camelCase args verbatim, and the server schema is snake_case, so
 *  the mapping is written out here (the shape useUpsertLocation already uses). */
export function useSetThresholds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { itemId: string; locationId: string; min: number | null; max: number | null }) =>
      api
        .put('/api/inventory/stock/thresholds', {
          item_id: p.itemId,
          location_id: p.locationId,
          min: p.min,
          max: p.max,
        })
        .then((r) => r.data),
    // A threshold changes what counts as low without moving any stock, so no
    // movement is written and the movement log cannot have changed.
    onSuccess: invalidating(qc, KEYS.items, KEYS.lowStock),
  });
}

/** AddItemDialog's starting-stock entry (structurally the same as NewItem['startingStock'][0];
 *  restated here so the seam does not import a component type). */
export type StartingStockEntry = { locationId: string; qty: number; min?: number; max?: number };

/** SRVW-91 - the shared create-time rule for both AddItemDialog mounts that persist the item.
 *  Returns null when there is nothing to write: no entry, no location, or neither threshold
 *  filled. ImportCSVDialog always emits `startingStock: []`, so the CSV path is a no-op. */
export function startingThresholdsFor(
  startingStock: StartingStockEntry[] | undefined,
): { locationId: string; min: number | null; max: number | null } | null {
  const entry = startingStock?.[0];
  if (!entry || !entry.locationId) return null;
  if (entry.min === undefined && entry.max === undefined) return null;
  return { locationId: entry.locationId, min: entry.min ?? null, max: entry.max ?? null };
}

export function useCreatePO() {
  const qc = useQueryClient();
  return useMutation({
    // po_number is server-assigned; callers consume the returned purchaseOrder.
    mutationFn: (input: NewPOInput) =>
      api
        .post('/api/inventory/purchase-orders', input)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    onSuccess: invalidating(qc, ...PO_VIEWS),
  });
}

/** PATCH body (PR 2). Free `status` movement — the server stamps/clears receivedAt and
 *  orderedAt as a side effect. `lines` is refused with 409 PO_LINES_FROZEN unless the PO is
 *  still a draft. Sending `signatureData: null` unsigns (name and time clear with it). */
export type UpdatePOPayload = { id: string }
  & Partial<Pick<NewPOInput, 'vendor' | 'vendorId' | 'lines'>>
  & {
    status?: POStatus;
    orderedAt?: string;
    /** null unlinks / clears (the Edit form, S3.3); undefined leaves the field alone. */
    jobId?: string | null;
    customerId?: string | null;
    customer?: string | null;
    site?: string | null;
    trade?: PurchaseOrder['trade'] | null;
    expectedDate?: string | null;
    notes?: string | null;
    signatureData?: string | null;
    signatureName?: string | null;
  };
export function useUpdatePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdatePOPayload) =>
      api
        .patch(`/api/inventory/purchase-orders/${id}`, body)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    onSuccess: invalidating(qc, ...PO_VIEWS),
  });
}

/** "Mark as ordered" (PR 2): the buyer placed the order their own way; the server records
 *  status `ordered`, the date (default now, back-datable) and the actor. 409
 *  PO_ALREADY_ORDERED when it already is. */
export type MarkOrderedPayload = { id: string; orderedAt?: string };
export function useMarkOrdered() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, orderedAt }: MarkOrderedPayload) =>
      api
        .post(`/api/inventory/purchase-orders/${id}/mark-ordered`, orderedAt ? { orderedAt } : {})
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    onSuccess: invalidating(qc, ...PO_VIEWS),
  });
}

/** Delete (PR 2): allowed for draft | ordered | cancelled with nothing received; the server
 *  answers 409 PO_HAS_RECEIPTS otherwise (the dialog then offers Cancel PO instead). */
export function useDeletePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/inventory/purchase-orders/${id}`).then(() => ({ id })),
    onSuccess: invalidating(qc, ...PO_VIEWS),
  });
}

export type ReceivePOPayload = {
  poId: string;
  destinationLocationId: string;                       // D14 — always sent by the dialog
  lines: { lineId: string; qtyReceived: number }[];    // identity by PO line id (D2); absolute totals
};
export function useReceivePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReceivePOPayload) =>
      api
        .post('/api/inventory/purchase-orders/receive', payload)
        .then((r) => r.data as { purchaseOrder: PurchaseOrder }),
    // DELIBERATELY WIDE. A receive lands stock in a location (items, low-stock,
    // my-van), writes a movement per line, advances the PO and its activity,
    // and re-costs the job through job-material-cost - which exists under this
    // prefix precisely because a receive refreshes it. That is most of the
    // prefix already, and a receive is rare enough that the fan-out is not what
    // spends a user's rate-limit budget.
    onSuccess: invalidating(qc, KEYS.everything),
  });
}

/** D15 actuals — received PO material spend for a job. Lives under the
 *  ['inventory'] key prefix ON PURPOSE: every PO receive / sync / return
 *  mutation already invalidates ['inventory'], so the row refreshes for free. */
export function useJobMaterialCost(jobId: string | undefined, enabled: boolean) {
  return useQuery<{ jobId: string; materialCost: number; lineCount: number }>({
    queryKey: ['inventory', 'job-material-cost', jobId],
    queryFn: () => api.get(`/api/inventory/jobs/${jobId}/material-cost`).then((r) => r.data),
    enabled: !!jobId && enabled,
    retry: false, // 403 for non-PurchaseOrder readers must not retry-loop
  });
}
// useCreateRFQ was removed with the RFQ feature-parking (P0 §C).
// Staging writes touch job_stages ONLY - inv-stages.controller.ts writes no
// stock level and no movement, so nothing else under the prefix can be stale.
export const useCreateStage       = () => useInventoryMutation<unknown>('/api/inventory/job-stages', KEYS.jobStages);
export const useReceiveStageLine  = () => useInventoryMutation<unknown>('/api/inventory/job-stages/receive', KEYS.jobStages);
export const useNotifyTechReady   = () => useInventoryMutation<unknown>('/api/inventory/job-stages/notify', KEYS.jobStages);
export const useEmailStagePickup  = () => useInventoryMutation<{ stageId: string; to: string[]; cc?: string[]; subject: string; message?: string }>('/api/inventory/job-stages/email', KEYS.jobStages);

// P5 §5 — staging attachments persist to Supabase Storage. The caller builds
// the multipart FormData (file + lenient metadata text parts); the response
// carries a freshly-signed URL in `attachment.dataUrl`.
export function useUploadStageAttachment() {
  const qc = useQueryClient();
  return useMutation({
    // `onUploadProgress` is optional and additive: a caller that does not pass it posts
    // exactly as before. It exists so the staging dialog can show real byte progress on a
    // phone-recorded video instead of an open-ended spinner (S5).
    mutationFn: ({
      stageId,
      form,
      onUploadProgress,
    }: {
      stageId: string;
      form: FormData;
      onUploadProgress?: (event: AxiosProgressEvent) => void;
    }) =>
      api
        .post(`/api/inventory/job-stages/${stageId}/attachments`, form, {
          ...(onUploadProgress ? { onUploadProgress } : {}),
        })
        .then((r) => r.data as { attachment: StageAttachment }),
    onSuccess: invalidating(qc, KEYS.jobStages),
  });
}
export function useDeleteStageAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stageId, attachmentId }: { stageId: string; attachmentId: string }) =>
      api
        .delete(`/api/inventory/job-stages/${stageId}/attachments/${attachmentId}`)
        .then((r) => r.data as { success: boolean }),
    onSuccess: invalidating(qc, KEYS.jobStages),
  });
}
// Dormant (feature-parked endpoints): exports stay for the unrouted approval
// components; no mounted callers.
export const useCreateApproval    = () => useInventoryMutation<unknown>('/api/inventory/stock-approvals', KEYS.stockApprovals);
export const useDecideApproval    = () => useInventoryMutation<unknown>('/api/inventory/stock-approvals/decide', KEYS.stockApprovals);
// A dialog-synthesized `vnd_new_<ts>` id must not reach the update branch —
// it 500ed there (looked up against the UUID `vendors.id` column). Strip it
// the same way useUpsertBrand/useUpsertItemGroup already do.
//
// The WRITE type deliberately differs from the READ type. `Vendor` declares its
// optional text fields as `?: string` because `toVendorDto` never emits null —
// it omits absent keys. On the way IN, though, `undefined` is not "clear this
// column": JSON.stringify drops the key entirely, so the server's
// `!== undefined` guard skips it and the old value survives. The seven nullable
// text columns must be able to carry an explicit `null`, which is what
// `upsertVendorSchema` already accepts (`.nullable().optional()`) and what
// `toVendorData` writes through. Widening `Vendor` itself would leak `| null`
// into ~30 read sites for no reason.
export type VendorUpsertPayload = Omit<
  Partial<Vendor>,
  // Retired with the sending workflow (S1.2): the server ignores these four,
  // so the write type refuses them outright.
  | 'paymentTerms'
  | 'leadTimeDays'
  | 'transmitMethod'
  | 'transmitMethods'
  | 'contactPersonName'
  | 'contactEmail'
  | 'contactPhone'
  | 'accountNumber'
  | 'website'
  | 'pickupAddress'
  | 'notes'
> & {
  contactPersonName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  accountNumber?: string | null;
  website?: string | null;
  pickupAddress?: string | null;
  notes?: string | null;
};

export function useUpsertVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: VendorUpsertPayload) =>
      api.post('/api/inventory/vendors', { ...p, id: isServerId(p.id) ? p.id : undefined }).then((r) => r.data.vendor as Vendor),
    onSuccess: invalidating(qc, ...VENDOR_VIEWS),
  });
}
// P2 (QA-610/A-17): canonical DELETE /vendors/:id — the old POST /vendors/delete
// answers 410 GONE server-side. 409 VENDOR_HAS_POS → archive fallback (VendorsPage).
export const useDeleteVendor      = () => useDeleteById('/api/inventory/vendors', KEYS.vendors, ...VENDOR_VIEWS);

// ─── Vendor categories (Purchasing Audit Verdict PR 4, S4.1) ────────────────
// A real per-company list behind the vendor pickers (`vendor_categories`).
// Every write is optimistic with a rollback: the picker's Manage list edits in
// place, and a 409 from the server (duplicate name, category still in use)
// puts the row back exactly as it was, so the message the picker shows sits
// next to the list it describes. Reads settle against the server afterwards.
export type VendorCategory = { id: string; name: string; vendorCount: number };

const sortCategories = (list: VendorCategory[]) =>
  [...list].sort((a, b) => a.name.localeCompare(b.name));

export function useVendorCategories() {
  return useQuery<VendorCategory[]>({
    queryKey: KEYS.vendorCategories,
    queryFn: () => api.get('/api/inventory/vendor-categories').then((r) => r.data.categories as VendorCategory[]),
  });
}

export function useCreateVendorCategory() {
  const qc = useQueryClient();
  return useMutation<VendorCategory, unknown, { name: string }, { previous: VendorCategory[]; tempId: string }>({
    mutationFn: ({ name }) =>
      api.post('/api/inventory/vendor-categories', { name }).then((r) => r.data.category as VendorCategory),
    onMutate: async ({ name }) => {
      await qc.cancelQueries({ queryKey: KEYS.vendorCategories });
      const previous = qc.getQueryData<VendorCategory[]>(KEYS.vendorCategories) ?? [];
      const tempId = `vc_new_${Date.now()}`;
      qc.setQueryData<VendorCategory[]>(KEYS.vendorCategories, sortCategories([...previous, { id: tempId, name, vendorCount: 0 }]));
      return { previous, tempId };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(KEYS.vendorCategories, ctx.previous);
    },
    onSuccess: (row, _vars, ctx) => {
      // Swap the placeholder for the server row so a pick made against it
      // (the picker selects a just-added category) resolves to a real id.
      qc.setQueryData<VendorCategory[]>(KEYS.vendorCategories, (list) =>
        sortCategories((list ?? []).map((c) => (c.id === ctx?.tempId ? row : c))),
      );
    },
    onSettled: invalidating(qc, KEYS.vendorCategories),
  });
}

export function useRenameVendorCategory() {
  const qc = useQueryClient();
  return useMutation<
    VendorCategory,
    unknown,
    { id: string; name: string },
    { previous: VendorCategory[]; previousVendors: Vendor[] | undefined }
  >({
    mutationFn: ({ id, name }) =>
      api.patch(`/api/inventory/vendor-categories/${id}`, { name }).then((r) => r.data.category as VendorCategory),
    onMutate: async ({ id, name }) => {
      await qc.cancelQueries({ queryKey: KEYS.vendorCategories });
      const previous = qc.getQueryData<VendorCategory[]>(KEYS.vendorCategories) ?? [];
      const previousVendors = qc.getQueryData<Vendor[]>(KEYS.vendors);
      qc.setQueryData<VendorCategory[]>(
        KEYS.vendorCategories,
        sortCategories(previous.map((c) => (c.id === id ? { ...c, name } : c))),
      );
      // The server carries every vendor in the category along; mirror that on
      // screen so the cards rename with the row instead of after the refetch.
      if (Array.isArray(previousVendors)) {
        qc.setQueryData<Vendor[]>(
          KEYS.vendors,
          previousVendors.map((v) => (v.categoryId === id ? { ...v, category: name } : v)),
        );
      }
      return { previous, previousVendors };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData(KEYS.vendorCategories, ctx.previous);
      if (Array.isArray(ctx.previousVendors)) qc.setQueryData(KEYS.vendors, ctx.previousVendors);
    },
    onSettled: invalidating(qc, KEYS.vendorCategories, KEYS.vendors),
  });
}

export function useDeleteVendorCategory() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, { id: string }, { previous: VendorCategory[] }>({
    mutationFn: ({ id }) => api.delete(`/api/inventory/vendor-categories/${id}`).then((r) => r.data),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: KEYS.vendorCategories });
      const previous = qc.getQueryData<VendorCategory[]>(KEYS.vendorCategories) ?? [];
      qc.setQueryData<VendorCategory[]>(KEYS.vendorCategories, previous.filter((c) => c.id !== id));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // 409 CATEGORY_IN_USE is the usual reason: the row comes straight back.
      if (ctx) qc.setQueryData(KEYS.vendorCategories, ctx.previous);
    },
    onSettled: invalidating(qc, KEYS.vendorCategories),
  });
}
