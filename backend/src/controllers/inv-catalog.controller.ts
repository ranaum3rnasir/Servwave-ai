import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { INV_CATALOG_ITEM_SORT_FIELDS } from '../lib/sortFields';
import { canSeePricing } from '../lib/permissions/enforce';
import { applyStockMovement, ShortageError, shortageResponse, orgBlocksNegativeStock } from './inv-stock.controller';

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
    sellPrice: dec(row.sell_price ?? row.unit_price),
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
    photoUrl: row.photo_url ?? row.image_url ?? undefined,
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
export function mapBrand(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    logoUrl: row.logo_url ?? undefined,
    website: row.website ?? undefined,
    description: row.description ?? undefined,
    defaultMarkupPct: decOrUndef(row.default_markup_pct),
    defaultVendorId: row.default_vendor_id ?? undefined,
    isActive: row.is_active ?? undefined,
  };
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

function mapItemGroupLine(row: any) {
  return {
    id: row.id as string,
    itemId: row.item_id ?? undefined,
    name: row.name as string,
    quantity: dec(row.quantity),
    priceOverride: decOrUndef(row.price_override),
    costOverride: decOrUndef(row.cost_override),
    notes: row.notes ?? undefined,
  };
}

export function mapItemGroup(row: any) {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description ?? undefined,
    photoUrl: row.photo_url ?? undefined,
    groupType: row.group_type as string,
    flatRatePriceOverride: decOrUndef(row.flat_rate_price_override),
    isActive: !!row.is_active,
    lines: (row.lines ?? []).map(mapItemGroupLine),
  };
}

// ─── Cost stripping (P0 §D7) ────────────────────────────
// unitCost/listPrice are internal cost/margin data — visible only to a requester
// who can `read Invoice` (same canSeePricing predicate as job-lines). sellPrice
// is the customer-facing selling price and is NEVER stripped.
function stripMappedItemCost<T extends Record<string, unknown>>(item: T, req: Request): T {
  if (canSeePricing(req)) return item;
  const out: Record<string, unknown> = { ...item };
  delete out.unitCost;
  delete out.listPrice;
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
          vendor: { select: { id: true, name: true } },
          stock_balances: true,
        },
      }),
      prisma.priceBookItem.count({ where }),
    ]);

    res.json({
      data: items.map((i) => stripMappedItemCost(mapItem(i), req)),
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
        vendor: { select: { id: true, name: true } },
        stock_balances: true,
      },
    });

    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    res.json({ item: stripMappedItemCost(mapItem(item), req) });
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

    res.json({ brands: brands.map(mapBrand) });
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

    res.json({ itemGroups: groups.map(mapItemGroup) });
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
  notes: z.string().max(2000).nullable().optional(),
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
  reason: z.string().max(2000).nullable().optional(),
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
