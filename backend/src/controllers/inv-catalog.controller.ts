import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { INV_CATALOG_ITEM_SORT_FIELDS } from '../lib/sortFields';
import { canSeeCosts, canSeeVendors } from '../lib/permissions/enforce';
import { applyStockMovement, ShortageError, shortageResponse, orgBlocksNegativeStock } from './inv-stock.controller';
import { resolveItemImage, resolveItemSellPrice, valueOrNull } from '../lib/catalog/item-resolution';
import { LONG_TEXT_MAX } from '../lib/text-limits';

// ─── Helpers ────────────────────────────────────────────

function dec(value: unknown): number {
  // Prisma Decimal → number. Decimal has a toNumber(); plain values coerce.
  if (value == null) return 0;
  const anyVal = value as { toNumber?: () => number };
  if (typeof anyVal.toNumber === 'function') return anyVal.toNumber();
  return Number(value);
}

function decOrUndef(value: unknown): number | undefined {
  if (value == null) return undefined;
  return dec(value);
}

function strArr(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return undefined;
}

// ─── Mappers (Prisma snake_case row → mock camelCase shape) ──────────────

function mapItem(row: any) {
  const stock = (row.stock_balances ?? []).map((sb: any) => ({
    locationId: sb.location_id as string,
    onHand: dec(sb.on_hand),
    reserved: dec(sb.reserved),
    ...(sb.min != null ? { min: sb.min as number } : {}),
    ...(sb.max != null ? { max: sb.max as number } : {}),
  }));

  return {
    id: row.id as string,
    sku: (row.sku ?? '') as string,
    mpn: row.mpn ?? undefined,
    modelNumber: row.model_number ?? undefined,
    upc: row.upc ?? undefined,
    name: row.name as string,
    category: (row.category?.name ?? '') as string,
    trade: (row.trade ?? 'locksmith') as string,
    // SRVW-90: a kind-less row (AddLineDialog's "also save to price book" sends
    // type and no kind) must report the kind its type implies - otherwise the
    // next save from the inventory dialog would derive MATERIAL back onto it.
    kind: (row.kind ?? (row.type === 'MATERIAL' ? 'material' : 'service')) as string,
    uom: (row.uom ?? 'EA') as string,
    unitCost: dec(row.unit_cost),
    // Resolution lives in lib/catalog/item-resolution - the ONE place that decides
    // which of the two price columns to read. This mapper keeps its own long-standing
    // contract of collapsing an unpriced item to 0; the picker's endpoints carry the
    // explicit null instead, so a consumer of theirs can still tell an absence from a
    // genuine zero. No consumer renders that distinction as words any more: "No price"
    // was deleted (Ran, 2026-09-18) because the NOT NULL invariant below makes the
    // absent arm unreachable, and every surface now prints $0.00 for a zero.
    //
    // INVARIANT the `?? 0` rests on: `PriceBookItem.unit_price` is `Decimal(12,2)` NOT NULL
    // with no default, and both create paths mirror whichever side the client sent into it
    // (see price-book.controller's createItem/updateItem). So resolution ALWAYS finds a
    // price on a real row and the fallback is unreachable in production - it exists only to
    // satisfy the type and to keep a projected/partial row from throwing.
    //
    // If that column is ever made nullable - the catalog reconciliation in slice 07 is the
    // change that would do it - this `?? 0` stops being unreachable and silently becomes the
    // original defect ($0.00 for an unpriced item) on every inventory surface that renders
    // this mapper's output, with no existing test to catch it. Revisit here first.
    sellPrice: valueOrNull(resolveItemSellPrice(row)) ?? 0,
    trackInventory: !!row.track_inventory,
    // SRVW-90: the edit dialog needs both - `type` read-only (it is a projection
    // of `kind`), `taxable` as a real settable control.
    type: (row.type ?? 'SERVICE') as string,
    taxable: row.taxable ?? true,
    serialized: !!row.serialized,
    hazmat: !!row.hazmat,
    // Show-archived toggle (Task 3) needs this to tell active/archived rows
    // apart once include_archived=true returns both in one payload.
    isActive: row.is_active ?? true,
    status: (row.status ?? 'active') as string,
    vendor: (row.vendor?.name ?? '') as string,
    stock,
    serials: strArr(row.serials),
    photoUrl: valueOrNull(resolveItemImage(row)) ?? undefined,
    updatedAt: (row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at) as string,
    brandId: row.brand_id ?? undefined,
    finishId: row.finish_id ?? undefined,
    visibility: row.visibility ?? undefined,
    customerName: row.customer_name ?? undefined,
    customerDescription: row.customer_description ?? undefined,
    keyFeatures: strArr(row.key_features),
    listPrice: decOrUndef(row.list_price),
  };
}

/**
 * The catalog-side view of an item for the Price Book reads: mapItem without the stock side. Quantities,
 * locations and serial numbers belong to View stock, so none of them travels here. The vendor's name is
 * the supplier side of the row and goes only to a caller who may read vendors.
 */
export function mapCatalogItem(row: any, req: Request) {
  const { stock: _stock, serials: _serials, vendor, ...catalog } = mapItem(row);
  const withVendor = canSeeVendors(req) ? { ...catalog, vendor } : catalog;
  return stripMappedItemCost(withVendor, req);
}

function mapCategory(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    trade: row.trade ?? undefined,
    description: row.description ?? undefined,
    photoUrl: row.photo_url ?? undefined,
  };
}

// Exported: price-book.controller reuses these for the moved brand/item-group
// write handlers (P0 §D2) — the read side (list*) stays here.
// The default markup is margin data: it rides on the answer only for a requester who can see costs
// (canSeeCosts, "See financial data"), and is left out otherwise - the key absent, never 0 or null.
// The default vendor id follows View vendors the same way.
export function mapBrand(row: any, req: Request) {
  const brand = {
    id: row.id as string,
    name: row.name as string,
    logoUrl: row.logo_url ?? undefined,
    website: row.website ?? undefined,
    description: row.description ?? undefined,
    defaultMarkupPct: decOrUndef(row.default_markup_pct),
    defaultVendorId: row.default_vendor_id ?? undefined,
    isActive: row.is_active ?? undefined,
  };
  // The default vendor is supplier data: it rides on the answer only with View vendors (canSeeVendors).
  const { defaultVendorId: _defaultVendorId, ...withoutVendor } = brand;
  const shown = canSeeVendors(req) ? brand : withoutVendor;
  if (canSeeCosts(req)) return shown;
  const { defaultMarkupPct: _defaultMarkupPct, ...withoutMarkup } = shown;
  return withoutMarkup;
}

export function mapFinish(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    code: row.code ?? undefined,
    isActive: row.is_active ?? undefined,
  };
}

export function mapUomOption(row: any) {
  return {
    id: row.id as string,
    code: row.code as string,
    label: row.label ?? undefined,
    isActive: row.is_active ?? undefined,
  };
}

// A line's cost is cost data like an item's: it rides on the answer only with See financial data
// (canSeeCosts), and the key is left out otherwise. priceOverride is a price and is never stripped.
function mapItemGroupLine(row: any, req: Request) {
  const line = {
    id: row.id as string,
    itemId: row.item_id ?? undefined,
    name: row.name as string,
    quantity: dec(row.quantity),
    priceOverride: decOrUndef(row.price_override),
    costOverride: decOrUndef(row.cost_override),
    notes: row.notes ?? undefined,
  };
  if (canSeeCosts(req)) return line;
  const { costOverride: _costOverride, ...withoutCost } = line;
  return withoutCost;
}

export function mapItemGroup(row: any, req: Request) {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description ?? undefined,
    photoUrl: row.photo_url ?? undefined,
    groupType: row.group_type as string,
    flatRatePriceOverride: decOrUndef(row.flat_rate_price_override),
    isActive: !!row.is_active,
    lines: (row.lines ?? []).map((line: any) => mapItemGroupLine(line, req)),
  };
}

// ─── Cost stripping (P0 §D7, S01.15) ────────────────────
// unitCost is internal cost/margin data — visible only to a requester who can see costs
// (canSeeCosts, "See financial data"). sellPrice and listPrice are prices and are NEVER stripped.
function stripMappedItemCost<T extends Record<string, unknown>>(item: T, req: Request): T {
  if (canSeeCosts(req)) return item;
  const out: Record<string, unknown> = { ...item };
  delete out.unitCost;
  return out as T;
}

// The vendor's name is supplier data: it rides on a stock item only for a requester who holds View vendors
// (canSeeVendors). Without it the key is gone, never an empty string.
function stripMappedItemVendor<T extends Record<string, unknown>>(item: T, req: Request): T {
  if (canSeeVendors(req)) return item;
  const out: Record<string, unknown> = { ...item };
  delete out.vendor;
  return out as T;
}

// ─── Item Handlers (reads only — catalog writes live on /api/price-book, §D4) ─

export async function listItems(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, INV_CATALOG_ITEM_SORT_FIELDS, 'sort_order', 'asc');
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const where: Prisma.PriceBookItemWhereInput = { ...tenantWhere(req) };
    // Items grid hides archived by default; the "Show archived" toggle passes include_archived=true.
    // Scoped to THIS catalog grid only - stock/low-stock surfaces (inv-stock.controller.ts) keep
    // showing deactivated items per QA-105.
    if (req.query.include_archived !== 'true') {
      where.is_active = true;
    }
    const [items, total] = await Promise.all([
      prisma.priceBookItem.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          category: { select: { id: true, name: true } },
          ...(canSeeVendors(req) ? { vendor: { select: { id: true, name: true } } } : {}),
          stock_balances: true,
        },
      }),
      prisma.priceBookItem.count({ where }),
    ]);

    res.json({
      data: items.map((i) => stripMappedItemVendor(stripMappedItemCost(mapItem(i), req), req)),
      meta: buildPaginationMeta(total, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('Failed to list inventory items:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getItem(req: Request, res: Response) {
  try {
    const item = await prisma.priceBookItem.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        category: { select: { id: true, name: true } },
        ...(canSeeVendors(req) ? { vendor: { select: { id: true, name: true } } } : {}),
        stock_balances: true,
      },
    });

    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    res.json({ item: stripMappedItemVendor(stripMappedItemCost(mapItem(item), req), req) });
  } catch (err) {
    logger.error('Failed to get inventory item:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Category Handlers ──────────────────────────────────

export async function listCategories(req: Request, res: Response) {
  try {
    const categories = await prisma.priceBookCategory.findMany({
      where: tenantWhere(req),
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });

    res.json({ categories: categories.map(mapCategory) });
  } catch (err) {
    logger.error('Failed to list categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Brand Handlers ─────────────────────────────────────

export async function listBrands(req: Request, res: Response) {
  try {
    const brands = await prisma.brand.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
    });

    res.json({ brands: brands.map((b) => mapBrand(b, req)) });
  } catch (err) {
    logger.error('Failed to list brands:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Finish + UoM option Handlers (reads) ───────────────

export async function listFinishes(req: Request, res: Response) {
  try {
    const finishes = await prisma.finish.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
    });

    res.json({ finishes: finishes.map(mapFinish) });
  } catch (err) {
    logger.error('Failed to list finishes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function listUomOptions(req: Request, res: Response) {
  try {
    const options = await prisma.uomOption.findMany({
      where: tenantWhere(req),
      orderBy: { code: 'asc' },
    });

    res.json({ uomOptions: options.map(mapUomOption) });
  } catch (err) {
    logger.error('Failed to list uom options:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Item Group Handlers ────────────────────────────────

export async function listItemGroups(req: Request, res: Response) {
  try {
    const groups = await prisma.itemGroup.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
      },
    });

    res.json({ itemGroups: groups.map((g) => mapItemGroup(g, req)) });
  } catch (err) {
    logger.error('Failed to list item groups:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Stock Write Handlers (B2, V5) ──────────────────────
// restock/bulk-restock/transfer emit StockMovement + adjust StockBalance via
// Task 4's applyStockMovement. Catalog writes (items/categories/brands/groups/
// import) moved to /api/price-book — the old routes answer 410 Gone (P0 §D4).

export const restockSchema = z.object({
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  qty: z.number().positive(),
  source: z.string().max(50).nullable().optional(),
  unitCost: z.number().min(0).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(LONG_TEXT_MAX).nullable().optional(),
});

async function loadItemAndLocation(req: Request, itemId: string, locationId: string) {
  const [item, location] = await Promise.all([
    prisma.priceBookItem.findFirst({ where: { id: itemId, ...tenantWhere(req) }, select: { id: true, sku: true, name: true } }),
    prisma.inventoryLocation.findFirst({ where: { id: locationId, ...tenantWhere(req) }, select: { id: true } }),
  ]);
  return { item, location };
}

export async function restock(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof restockSchema>;
    const { item, location } = await loadItemAndLocation(req, body.itemId, body.locationId);
    if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
    if (!location) { res.status(404).json({ error: 'Location not found' }); return; }
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    const ledgerReference = body.reference?.trim() || body.source || 'restock';
    await prisma.$transaction(async (tx) => {
      await applyStockMovement(tx, {
        orgId, type: 'receive', itemSku: item.sku ?? '', itemName: item.name,
        qty: body.qty, itemId: item.id, toLocationId: location.id,
        unitCost: body.unitCost ?? null, actorUserId: req.user!.id,
        reference: ledgerReference, actor,
      });
    });

    void logAudit({
      req,
      action: 'inventory.stock_restocked',
      resourceType: 'PriceBookItem',
      resourceId: body.itemId,
      metadata: { location_id: body.locationId, qty: body.qty, source: body.source ?? 'restock', reference: ledgerReference, notes: body.notes ?? null },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to restock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const bulkRestockSchema = z.object({
  lines: z.array(z.object({ itemId: z.string().uuid(), locationId: z.string().uuid(), qty: z.number().positive(), unitCost: z.number().min(0).nullable().optional() })).min(1),
});

export async function bulkRestock(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof bulkRestockSchema>;
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';

    // Resolve every line BEFORE opening the transaction — same shape as `restock` above.
    // loadItemAndLocation queries the GLOBAL client; issuing it inside the tx would hold one
    // pooled connection while asking for two more (Promise.all) per line, starving the pool with
    // P2024 on a connection-limited deployment. Resolving up front also turns a bad id into a
    // clean 404 instead of a 500 thrown from inside the transaction.
    const resolved: Array<{
      qty: number;
      unitCost: number | null;
      item: { id: string; sku: string | null; name: string };
      locationId: string;
    }> = [];
    for (const line of body.lines) {
      const { item, location } = await loadItemAndLocation(req, line.itemId, line.locationId);
      if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
      if (!location) { res.status(404).json({ error: 'Location not found' }); return; }
      resolved.push({ qty: line.qty, unitCost: line.unitCost ?? null, item, locationId: location.id });
    }

    await prisma.$transaction(async (tx) => {
      for (const line of resolved) {
        await applyStockMovement(tx, {
          orgId, type: 'receive', itemSku: line.item.sku ?? '', itemName: line.item.name,
          qty: line.qty, itemId: line.item.id, toLocationId: line.locationId,
          unitCost: line.unitCost, actorUserId: req.user!.id,
          reference: 'bulk-restock', actor,
        });
      }
    });

    void logAudit({
      req,
      action: 'inventory.stock_bulk_restocked',
      resourceType: 'StockMovement',
      resourceId: null,
      metadata: { line_count: body.lines.length },
    });

    res.json({ success: true, count: body.lines.length });
  } catch (err: any) {
    if (err?.message === 'Invalid item or location') { res.status(404).json({ error: err.message }); return; }
    logger.error('Failed to bulk restock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const transferSchema = z.object({
  itemId: z.string().uuid(),
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  qty: z.number().positive(),
  reason: z.string().max(LONG_TEXT_MAX).nullable().optional(),
});

export async function transferStock(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof transferSchema>;
    const item = await prisma.priceBookItem.findFirst({ where: { id: body.itemId, ...tenantWhere(req) }, select: { id: true, sku: true, name: true } });
    if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
    const [from, to] = await Promise.all([
      prisma.inventoryLocation.findFirst({ where: { id: body.fromId, ...tenantWhere(req) }, select: { id: true } }),
      prisma.inventoryLocation.findFirst({ where: { id: body.toId, ...tenantWhere(req) }, select: { id: true } }),
    ]);
    if (!from || !to) { res.status(404).json({ error: 'Location not found' }); return; }
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    // P1 §6.3 (D7 / QA-203/204): the org negative-stock policy applies to manual transfers too —
    // block mode turns the SOURCE decrement into applyStockMovement's conditional atomic update.
    const blockNegative = await orgBlocksNegativeStock(orgId);
    await prisma.$transaction(async (tx) => {
      await applyStockMovement(tx, {
        orgId, type: 'transfer', itemSku: item.sku ?? '', itemName: item.name,
        qty: body.qty, itemId: item.id, fromLocationId: from.id, toLocationId: to.id,
        actorUserId: req.user!.id,
        reference: body.reason ?? 'transfer', actor, blockNegative,
      });
    });

    void logAudit({
      req,
      action: 'inventory.stock_transferred',
      resourceType: 'PriceBookItem',
      resourceId: body.itemId,
      metadata: { from_location_id: body.fromId, to_location_id: body.toId, qty: body.qty },
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ShortageError) {
      shortageResponse(res, err);
      return;
    }
    logger.error('Failed to transfer stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
