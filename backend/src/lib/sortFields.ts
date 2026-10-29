/**
 * SRVW-89 - the single source of truth for "which TanStack column id maps to which Prisma
 * orderBy field(s)" on every list endpoint that calls parseSortParams. Two vocabularies
 * (frontend column ids, backend Prisma field names) used to drift with nothing forcing them
 * together, which is how Customers `company` (not a Prisma field - the real column is
 * `company_name`) and price-book `item_type` (the real field is `type`) both allowlisted a
 * field that does not exist and 500'd.
 *
 * Deliberately ZERO imports: a frontend vitest test (list-sort-lockstep.test.ts) imports this
 * file by relative path to check every sortable column has a map entry, and a backend test
 * (sort-field-map-schema-validity.test.ts) checks every value names a real field via the Prisma
 * DMMF. Keeping this file pure data lets both sides load it without dragging in prisma/express.
 *
 * Keys are TanStack column ids (what the frontend sends as `sortBy`). Values are Prisma field
 * names in `orderBy` precedence order - most maps have exactly one, Customers "Customer" has
 * two ([first_name, last_name]) because no single field expresses the display name.
 */

export type SortFieldMap = Readonly<Record<string, readonly string[]>>;

export const CUSTOMER_SORT_FIELDS: SortFieldMap = {
  customer_number: ['customer_number'],
  name: ['first_name', 'last_name'],
  company: ['company_name'],
  created_at: ['created_at'],
};

export const JOB_SORT_FIELDS: SortFieldMap = {
  job_number: ['job_number'],
  status: ['status'],
  // A1 (RATIFIED, multi-visit S8 §4) - NOT scheduled_start. That column is the FORWARD-looking
  // mirror and goes null the moment a job's last live visit is worked; staging measures 7,492
  // jobs (7,349 Talon Septic + 141 ServWave Test + 2 Alpha Doors) with scheduled_start set but no
  // live visit, so sorting on it would blank the Scheduled column for every completed job in the
  // biggest org. first_visit_start is the BACKWARD-looking span start (A2+): it equals
  // scheduled_start's value for every single-visit job, never reverts to null once a visit has
  // ever existed, and is stable as trips complete.
  scheduled: ['first_visit_start'],
  created: ['created_at'],
};

export const ESTIMATE_SORT_FIELDS: SortFieldMap = {
  estimate_number: ['estimate_number'],
  status: ['status'],
  total: ['total_amount'],
  date: ['created_at'],
};

export const LEAD_SORT_FIELDS: SortFieldMap = {
  lead_number: ['lead_number'],
  status: ['status'],
  created: ['created_at'],
};

export const INVOICE_SORT_FIELDS: SortFieldMap = {
  invoice_number: ['invoice_number'],
  status: ['status'],
  total_amount: ['total_amount'],
  amount_due: ['amount_due'],
  due_date: ['due_date'],
  created_at: ['created_at'],
};

export const PRICE_BOOK_ITEM_SORT_FIELDS: SortFieldMap = {
  name: ['name'],
  unit_price: ['unit_price'],
  type: ['type'],
  sort_order: ['sort_order'],
};

// Same underlying Prisma model as PRICE_BOOK_ITEM_SORT_FIELDS (there is no separate
// InventoryItem/InvCatalogItem model - inv-catalog.controller.ts queries
// prisma.priceBookItem.findMany). Two surfaces legitimately accept different sort sets because
// /api/price-book/items is the pricing grid and /api/inventory/items is the catalog grid.
export const INV_CATALOG_ITEM_SORT_FIELDS: SortFieldMap = {
  name: ['name'],
  sort_order: ['sort_order'],
  updated_at: ['updated_at'],
};

export const ASSET_SORT_FIELDS: SortFieldMap = {
  name: ['name'],
  status: ['status'],
  created_at: ['created_at'],
  updated_at: ['updated_at'],
};

export const STOCK_MOVEMENT_SORT_FIELDS: SortFieldMap = {
  occurred_at: ['occurred_at'],
};

// Registry for the DMMF schema-validity guard: pairs each map with its Prisma model name.
export const SORT_FIELD_MAPS: ReadonlyArray<{ model: string; map: SortFieldMap }> = [
  { model: 'Customer', map: CUSTOMER_SORT_FIELDS },
  { model: 'Job', map: JOB_SORT_FIELDS },
  { model: 'Estimate', map: ESTIMATE_SORT_FIELDS },
  { model: 'Lead', map: LEAD_SORT_FIELDS },
  { model: 'Invoice', map: INVOICE_SORT_FIELDS },
  { model: 'PriceBookItem', map: PRICE_BOOK_ITEM_SORT_FIELDS },
  { model: 'PriceBookItem', map: INV_CATALOG_ITEM_SORT_FIELDS },
  { model: 'Asset', map: ASSET_SORT_FIELDS },
  { model: 'StockMovement', map: STOCK_MOVEMENT_SORT_FIELDS },
];
