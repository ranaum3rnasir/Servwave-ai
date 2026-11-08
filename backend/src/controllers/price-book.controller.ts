import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { PRICE_BOOK_ITEM_SORT_FIELDS } from '../lib/sortFields';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { canSeePricing } from '../lib/permissions/enforce';
import { emitBackorderIfFlipped } from '../services/notifications/inventoryEmit';
// Brand/item-group reads stay on inv-catalog; the write handlers moved here (P0 §D2)
// and reuse its row mappers so both sides keep emitting the same camelCase shape.
import { mapBrand, mapItemGroup, mapFinish, mapUomOption } from './inv-catalog.controller';

// Hybrid-delete usage gate, DERIVED not hardcoded: every table that references a
// price-book item is a *list* relation on the PriceBookItem model (belongs-to
// relations like category/vendor are isList:false and correctly excluded). Reading
// them from Prisma's schema metadata means a future feature that connects items to
// a new table is counted automatically - nothing here to update by hand.
const ITEM_REFERENCING_RELATIONS = Prisma.dmmf.datamodel.models
  .find((m) => m.name === 'PriceBookItem')!
  .fields.filter((f) => f.kind === 'object' && f.isList)
  .map((f) => f.name);

const itemCountSelect = Object.fromEntries(
  ITEM_REFERENCING_RELATIONS.map((name) => [name, true]),
) as Record<string, true>;

// ─── Zod Schemas ───────────────────────────────────────

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  parent_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  trade: z.string().max(50).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  photo_url: z.string().max(2000000).nullable().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  parent_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  trade: z.string().max(50).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  photo_url: z.string().max(2000000).nullable().optional(),
});

// Superset item fields (P0 §D1): price-book is the SINGLE catalog write path,
// absorbing the inventory item vocabulary. snake_case keys = column names.
const itemSupersetFields = {
  sku: z.string().max(100).nullable().optional(),
  mpn: z.string().max(100).nullable().optional(),
  model_number: z.string().max(100).nullable().optional(),
  upc: z.string().max(100).nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  finish_id: z.string().uuid().nullable().optional(),
  vendor_id: z.string().uuid().nullable().optional(),
  trade: z.string().max(50).nullable().optional(),
  kind: z.string().max(50).nullable().optional(),
  uom: z.string().max(50).nullable().optional(),
  sell_price: z.number().min(0).nullable().optional(),
  list_price: z.number().min(0).nullable().optional(),
  serialized: z.boolean().optional(),
  hazmat: z.boolean().optional(),
  status: z.string().max(50).nullable().optional(),
  visibility: z.string().max(50).nullable().optional(),
  customer_name: z.string().max(200).nullable().optional(),
  customer_description: z.string().max(5000).nullable().optional(),
  key_features: z.array(z.string()).nullable().optional(),
  photo_url: z.string().max(2000000).nullable().optional(), // data-URI photos — NO .url(), unlike image_url
  track_inventory: z.boolean().optional(),
};

export const createItemSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(5000).nullable().optional(),
  image_url: z.string().url().max(500).nullable().optional(),
  type: z.enum(['SERVICE', 'MATERIAL']).optional(),
  category_id: z.string().uuid().nullable().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  unit_price: z.number().min(0).optional(),
  taxable: z.boolean().optional(),
  ...itemSupersetFields,
}).refine((b) => b.unit_price != null || b.sell_price != null, {
  message: 'unit_price or sell_price is required',
  path: ['unit_price'],
});

export const updateItemSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  image_url: z.string().url().max(500).nullable().optional(),
  type: z.enum(['SERVICE', 'MATERIAL']).optional(),
  category_id: z.string().uuid().nullable().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  unit_price: z.number().min(0).optional(),
  taxable: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
  ...itemSupersetFields,
});

// ─── Shared helpers ────────────────────────────────────

// SRVW-90: `kind` is the single catalog control the inventory dialog exposes;
// `type` is its SERVICE|MATERIAL projection, the column estimates/invoices/jobs
// actually key on. Deriving it in exactly one place keeps the two columns from
// contradicting each other. Only 'material' bills as a part - everything else
// falls to SERVICE, which is the schema default today.
export function typeForKind(kind: string | null | undefined): 'SERVICE' | 'MATERIAL' {
  return normalizeKind(kind) === 'material' ? 'MATERIAL' : 'SERVICE';
}

// Item Kind is material|service and nothing else. `labor`, `bundle` and `fee`
// were offered by the dialog but bought no behaviour: typeForKind already
// billed all three as SERVICE, and the Stock > Items grid filtered bundle and
// fee out, so an item saved as either was created successfully and then never
// appeared. Retiring them is a narrowing of the WRITE side only - the retired
// tokens are folded into `service` rather than rejected, because a 400 here
// would break an old client, a saved CSV or anything already in flight, and
// `service` is the value they behaved as all along.
//
// Returns null only for a null/undefined/empty input, so a deliberate clear
// stays a clear instead of silently reclassifying the item as a service.
export function normalizeKind(kind: string | null | undefined): 'material' | 'service' | null {
  if (kind == null) return null;
  const k = kind.trim().toLowerCase();
  if (k === '') return null;
  return k === 'material' ? 'material' : 'service';
}

// Duplicate SKU (@@unique([organization_id, sku])) → 409 instead of a 500 (QA-106).
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

function respondSkuConflict(res: Response) {
  res.status(409).json({
    error: 'SKU already exists',
    details: [{ field: 'sku', message: 'An item with this SKU already exists' }],
  });
}

// Tenant-scoped FK guards for the absorbed item fields. Returns false after
// responding 404 when a referenced row is outside the requesting org.
async function guardItemFks(req: Request, res: Response): Promise<boolean> {
  if (req.body.category_id) {
    const category = await prisma.priceBookCategory.findFirst({
      where: { id: req.body.category_id, ...tenantWhere(req) },
    });
    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return false;
    }
  }
  if (req.body.brand_id) {
    const brand = await prisma.brand.findFirst({
      where: { id: req.body.brand_id, ...tenantWhere(req) },
    });
    if (!brand) {
      res.status(404).json({ error: 'Brand not found' });
      return false;
    }
  }
  if (req.body.finish_id) {
    const finish = await prisma.finish.findFirst({
      where: { id: req.body.finish_id, ...tenantWhere(req) },
    });
    if (!finish) {
      res.status(404).json({ error: 'Finish not found' });
      return false;
    }
  }
  if (req.body.vendor_id) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.body.vendor_id, ...tenantWhere(req) },
    });
    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return false;
    }
  }
  return true;
}

// Cost stripping (P0 §D7): unit_cost/list_price are internal cost/margin data,
// gated by the same canSeePricing (`read Invoice`) predicate as job-lines.
// unit_price/sell_price are customer-facing selling prices — NEVER stripped.
function stripItemCost<T extends Record<string, unknown>>(item: T, req: Request): T {
  if (canSeePricing(req)) return item;
  const out: Record<string, unknown> = { ...item };
  delete out.unit_cost;
  delete out.list_price;
  return out as T;
}

// ─── Category Handlers ─────────────────────────────────

export async function listCategories(req: Request, res: Response) {
  try {
    const categories: any = await prisma.priceBookCategory.findMany({
      where: tenantWhere(req),
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { items: true } },
      },
    });

    res.json({ data: categories });
  } catch (err) {
    logger.error('Failed to list categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createCategory(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    if (req.body.parent_id) {
      const parent = await prisma.priceBookCategory.findFirst({
        where: { id: req.body.parent_id, ...tenantWhere(req) },
      });
      if (!parent) {
        res.status(404).json({ error: 'Parent category not found' });
        return;
      }
    }

    const category = await prisma.priceBookCategory.create({
      data: {
        name: req.body.name,
        parent_id: req.body.parent_id ?? null,
        sort_order: req.body.sort_order ?? 0,
        trade: req.body.trade ?? null,
        description: req.body.description ?? null,
        photo_url: req.body.photo_url ?? null,
        organization_id: orgId,
      },
    });

    void logAudit({
      req,
      action: 'pricebook.category_created',
      resourceType: 'PriceBookCategory',
      resourceId: category.id,
    });

    res.status(201).json({ data: category });
  } catch (err) {
    logger.error('Failed to create category:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateCategory(req: Request, res: Response) {
  try {
    const existing = await prisma.priceBookCategory.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    if (req.body.parent_id && req.body.parent_id === (req.params.id as string)) {
      res.status(400).json({ error: 'Category cannot be its own parent' });
      return;
    }

    if (req.body.parent_id) {
      const parent = await prisma.priceBookCategory.findFirst({
        where: { id: req.body.parent_id, ...tenantWhere(req) },
      });
      if (!parent) {
        res.status(404).json({ error: 'Parent category not found' });
        return;
      }
    }

    // updateMany with id+org filter is atomic (single query) — no TOCTOU window.
    const updateResult = await prisma.priceBookCategory.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data: req.body,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    const category = await prisma.priceBookCategory.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    void logAudit({
      req,
      action: 'pricebook.category_updated',
      resourceType: 'PriceBookCategory',
      resourceId: req.params.id as string,
      metadata: { fields: Object.keys(req.body) },
    });

    res.json({ data: category });
  } catch (err) {
    logger.error('Failed to update category:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteCategory(req: Request, res: Response) {
  try {
    const existing: any = await prisma.priceBookCategory.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: { _count: { select: { items: true, children: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    if (existing._count.items > 0) {
      res.status(400).json({ error: 'Cannot delete category with items' });
      return;
    }

    if (existing._count.children > 0) {
      res.status(400).json({ error: 'Cannot delete category with subcategories' });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window between the
    // existence/_count check and the delete.
    await prisma.priceBookCategory.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    void logAudit({
      req,
      action: 'pricebook.category_deleted',
      resourceType: 'PriceBookCategory',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Category deleted' });
  } catch (err) {
    logger.error('Failed to delete category:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Item Handlers ──────────────────────────────────────

export async function listItems(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, PRICE_BOOK_ITEM_SORT_FIELDS, 'sort_order', 'asc');
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const where: any = { ...tenantWhere(req) };

    if (req.query.type) {
      const typeStr = typeof req.query.type === 'string' ? req.query.type : '';
      const types = Array.isArray(req.query.type) ? req.query.type : [typeStr];
      const validTypes = types.filter((t: any) => typeof t === 'string' && ['SERVICE', 'MATERIAL'].includes(t));
      if (validTypes.length > 0) {
        where.type = { in: validTypes as ('SERVICE' | 'MATERIAL')[] };
      }
    }

    if (req.query.category_id) {
      where.category_id = typeof req.query.category_id === 'string' ? req.query.category_id : '';
    }

    if (req.query.brand_id) {
      where.brand_id = typeof req.query.brand_id === 'string' ? req.query.brand_id : '';
    }

    if (req.query.track_inventory !== undefined) {
      where.track_inventory = req.query.track_inventory === 'true';
    }

    if (req.query.is_active !== undefined) {
      where.is_active = req.query.is_active === 'true';
    }

    if (req.query.search) {
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.priceBookItem.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          category: { select: { id: true, name: true } },
        },
      }),
      prisma.priceBookItem.count({ where }),
    ]);

    res.json({
      data: items.map((i) => stripItemCost(i as Record<string, unknown>, req)),
      meta: buildPaginationMeta(total, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('Failed to list items:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function searchItems(req: Request, res: Response) {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q) {
      res.json({ data: [] });
      return;
    }

    const where: any = {
      ...tenantWhere(req),
      is_active: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    };

    if (req.query.type) {
      const validTypes = ['SERVICE', 'MATERIAL'];
      const typeStr = typeof req.query.type === 'string' ? req.query.type : '';
      if (validTypes.includes(typeStr)) {
        where.type = typeStr;
      }
    }

    if (req.query.category_id) {
      where.category_id = typeof req.query.category_id === 'string' ? req.query.category_id : '';
    }

    const items = await prisma.priceBookItem.findMany({
      where,
      take: 30,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        image_url: true,
        type: true,
        unit_cost: true,
        unit_price: true,
        taxable: true,
        category: { select: { id: true, name: true } },
      },
    });

    res.json({ data: items.map((i) => stripItemCost(i as Record<string, unknown>, req)) });
  } catch (err) {
    logger.error('Failed to search items:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createItem(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof createItemSchema>;

    if (!(await guardItemFks(req, res))) return;

    // Price mirror rule (P0 §D1): the catalog selling price lives in BOTH
    // unit_price (legacy NOT-NULL column, read by estimates/invoices) and
    // sell_price (inventory vocabulary). Whichever side the client sends is
    // mirrored into the other; both sent → both as-is.
    const unitPrice = body.unit_price ?? body.sell_price;
    const sellPrice = body.sell_price ?? body.unit_price;

    const item = await prisma.priceBookItem.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        image_url: body.image_url ?? null,
        type: body.type ?? typeForKind(body.kind),
        category_id: body.category_id ?? null,
        unit_cost: body.unit_cost ?? null,
        unit_price: unitPrice as number,
        sell_price: sellPrice,
        taxable: body.taxable ?? true,
        sku: body.sku ?? null,
        mpn: body.mpn ?? null,
        model_number: body.model_number ?? null,
        upc: body.upc ?? null,
        brand_id: body.brand_id ?? null,
        finish_id: body.finish_id ?? null,
        vendor_id: body.vendor_id ?? null,
        trade: body.trade ?? null,
        kind: normalizeKind(body.kind),
        uom: body.uom ?? null,
        list_price: body.list_price ?? null,
        serialized: body.serialized ?? false,
        hazmat: body.hazmat ?? false,
        status: body.status ?? null,
        visibility: body.visibility ?? null,
        customer_name: body.customer_name ?? null,
        customer_description: body.customer_description ?? null,
        key_features: body.key_features ?? undefined,
        photo_url: body.photo_url ?? null,
        track_inventory: body.track_inventory ?? false,
        organization_id: orgId,
      },
      include: {
        category: { select: { id: true, name: true } },
      },
    });

    // inventory.backorder on create — fire if created with on_backorder status.
    emitBackorderIfFlipped(orgId, req.user!.id, item.id, item.name, null, body.status ?? null);

    void logAudit({
      req,
      action: 'pricebook.item_created',
      resourceType: 'PriceBookItem',
      resourceId: item.id,
    });

    res.status(201).json({ data: item });
  } catch (err) {
    if (isUniqueViolation(err)) {
      respondSkuConflict(res);
      return;
    }
    logger.error('Failed to create item:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getItem(req: Request, res: Response) {
  try {
    const item = await prisma.priceBookItem.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        category: { select: { id: true, name: true } },
      },
    });

    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    // Single-item read must not leak what the list hides (P0 §D7).
    res.json({ data: stripItemCost(item as Record<string, unknown>, req) });
  } catch (err) {
    logger.error('Failed to get item:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateItem(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const existing = await prisma.priceBookItem.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    if (!(await guardItemFks(req, res))) return;

    const body = req.body as z.infer<typeof updateItemSchema>;

    // Explicit data build (no raw req.body passthrough) — needed for the price
    // mirror rule. Keys are already column names.
    const data: Record<string, unknown> = {};
    const passthrough = [
      'name', 'description', 'image_url', 'type', 'category_id', 'unit_cost',
      'taxable', 'is_active', 'sort_order',
      'sku', 'mpn', 'model_number', 'upc', 'brand_id', 'finish_id', 'vendor_id', 'trade', 'kind', 'uom',
      'list_price', 'serialized', 'hazmat', 'status', 'visibility',
      'customer_name', 'customer_description', 'key_features', 'photo_url',
      'track_inventory',
    ] as const;
    for (const key of passthrough) {
      if ((body as Record<string, unknown>)[key] !== undefined) {
        data[key] = (body as Record<string, unknown>)[key];
      }
    }
    // A retired kind (labor/bundle/fee) folds into `service` on the way in, so
    // the stored column only ever holds the two live values. The passthrough
    // above copied the raw string; overwrite it, but only when the caller
    // actually sent the key - a PATCH that omits kind must not add it.
    if (body.kind !== undefined) data.kind = normalizeKind(body.kind);

    // SRVW-90: repoint `type` whenever the caller moves `kind`, so correcting the
    // one control the dialog exposes also corrects the column estimates key on.
    // Guarded on a non-empty string: a PATCH that omits kind, or clears it to
    // null, must never move type. An explicit `type` in the body still wins -
    // the passthrough above already wrote it.
    let derivedType: 'SERVICE' | 'MATERIAL' | null = null;
    if (body.type === undefined && typeof body.kind === 'string' && body.kind.trim() !== '') {
      derivedType = typeForKind(body.kind);
      data.type = derivedType;
    }

    // Mirror rule: one selling price sent → write both; both sent → as-is;
    // neither → touch neither. Nulls never mirror (unit_price is NOT NULL).
    if (body.unit_price !== undefined) data.unit_price = body.unit_price;
    if (body.sell_price !== undefined) data.sell_price = body.sell_price;
    if (body.sell_price != null && body.unit_price === undefined) data.unit_price = body.sell_price;
    if (body.unit_price != null && body.sell_price === undefined) data.sell_price = body.unit_price;

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const updateResult = await prisma.priceBookItem.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    const item = await prisma.priceBookItem.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        category: { select: { id: true, name: true } },
      },
    });

    // inventory.backorder — fire only on flip INTO on_backorder; fire-and-forget.
    emitBackorderIfFlipped(
      orgId,
      req.user!.id,
      req.params.id as string,
      item?.name ?? existing.name,
      (existing as { status?: string | null }).status ?? null,
      body.status ?? null,
    );

    void logAudit({
      req,
      action: 'pricebook.item_updated',
      resourceType: 'PriceBookItem',
      resourceId: req.params.id as string,
      // `fields` lists only what the client sent, so a kind-derived `type` write
      // would otherwise be invisible in the trail (SRVW-90).
      metadata: {
        fields: Object.keys(req.body),
        ...(derivedType ? { derived: { type: derivedType } } : {}),
      },
    });

    res.json({ data: item });
  } catch (err) {
    if (isUniqueViolation(err)) {
      respondSkuConflict(res);
      return;
    }
    logger.error('Failed to update item:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteItem(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const item = await prisma.priceBookItem.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, sku: true, name: true, _count: { select: itemCountSelect } },
    });
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    const referenceCount = Object.values(item._count as Record<string, number>)
      .reduce((sum, n) => sum + n, 0);

    if (referenceCount === 0) {
      // Nothing references it - safe to truly remove. stock_balances (if any) cascade.
      await prisma.priceBookItem.deleteMany({ where: { id, ...tenantWhere(req) } });
      void logAudit({ req, action: 'pricebook.item_deleted', resourceType: 'PriceBookItem', resourceId: id });
      res.json({ mode: 'deleted', message: 'Item deleted' });
      return;
    }

    // Referenced somewhere - archive so history and item-grouped reports stay intact.
    await prisma.priceBookItem.updateMany({ where: { id, ...tenantWhere(req) }, data: { is_active: false } });
    void logAudit({ req, action: 'pricebook.item_deactivated', resourceType: 'PriceBookItem', resourceId: id, metadata: { reference_count: referenceCount } });
    res.json({ mode: 'archived', message: 'Item archived', referenceCount });
  } catch (err) {
    logger.error('Failed to delete item:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Brand Handlers (moved from inv-catalog — P0 §D2; camelCase upsert bodies,
// {brand} envelope preserved so the inventory dialogs keep their payloads) ────

export const upsertBrandSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, 'Name is required').max(200),
  logoUrl: z.string().max(2000000).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  defaultMarkupPct: z.number().min(0).nullable().optional(),
  defaultVendorId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function upsertBrand(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof upsertBrandSchema>;
    if (body.defaultVendorId) {
      const vendor = await prisma.vendor.findFirst({ where: { id: body.defaultVendorId, ...tenantWhere(req) } });
      if (!vendor) { res.status(404).json({ error: 'Vendor not found' }); return; }
    }
    const data: any = {
      name: body.name, logo_url: body.logoUrl ?? null, website: body.website ?? null,
      description: body.description ?? null, default_markup_pct: body.defaultMarkupPct ?? null,
      default_vendor_id: body.defaultVendorId ?? null, is_active: body.isActive ?? true,
    };
    if (body.id) {
      const result = await prisma.brand.updateMany({ where: { id: body.id, ...tenantWhere(req) }, data });
      if (result.count === 0) { res.status(404).json({ error: 'Brand not found' }); return; }
      const brand = await prisma.brand.findFirst({ where: { id: body.id, ...tenantWhere(req) } });

      void logAudit({
        req,
        action: 'pricebook.brand_updated',
        resourceType: 'Brand',
        resourceId: body.id,
        metadata: { fields: Object.keys(req.body) },
      });

      res.json({ brand: mapBrand(brand) });
      return;
    }
    const brand = await prisma.brand.create({ data: { ...data, organization_id: orgId } });

    void logAudit({
      req,
      action: 'pricebook.brand_created',
      resourceType: 'Brand',
      resourceId: brand.id,
    });

    res.status(201).json({ brand: mapBrand(brand) });
  } catch (err) {
    logger.error('Failed to upsert brand:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteBrand(req: Request, res: Response) {
  try {
    const existing: any = await prisma.brand.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: { _count: { select: { items: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Brand not found' });
      return;
    }

    if (existing._count.items > 0) {
      res.status(400).json({ error: 'Cannot delete brand with items' });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window.
    await prisma.brand.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    void logAudit({
      req,
      action: 'pricebook.brand_deleted',
      resourceType: 'Brand',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Brand deleted' });
  } catch (err) {
    logger.error('Failed to delete brand:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Finish Handlers ─────────────────────────────────────────────────────────
// Mirrors the Brand handlers above. The one shape difference is the 409 on a
// duplicate name: Finish carries @@unique([organization_id, name]) so the
// dialog's inline "add new" cannot quietly create a second "Satin Chrome".

export const upsertFinishSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(200),
  code: z.string().max(50).nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function upsertFinish(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof upsertFinishSchema>;
    const data = {
      name: body.name.trim(),
      code: body.code?.trim() || null,
      is_active: body.isActive ?? true,
    };

    if (body.id) {
      const result = await prisma.finish.updateMany({ where: { id: body.id, ...tenantWhere(req) }, data });
      if (result.count === 0) { res.status(404).json({ error: 'Finish not found' }); return; }
      const finish = await prisma.finish.findFirst({ where: { id: body.id, ...tenantWhere(req) } });

      void logAudit({
        req,
        action: 'pricebook.finish_updated',
        resourceType: 'Finish',
        resourceId: body.id,
        metadata: { fields: Object.keys(req.body) },
      });

      res.json({ finish: mapFinish(finish) });
      return;
    }

    const finish = await prisma.finish.create({ data: { ...data, organization_id: orgId } });

    void logAudit({
      req,
      action: 'pricebook.finish_created',
      resourceType: 'Finish',
      resourceId: finish.id,
    });

    res.status(201).json({ finish: mapFinish(finish) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A finish with that name already exists' });
      return;
    }
    logger.error('Failed to upsert finish:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteFinish(req: Request, res: Response) {
  try {
    const existing: any = await prisma.finish.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: { _count: { select: { items: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Finish not found' });
      return;
    }
    if (existing._count.items > 0) {
      res.status(400).json({ error: 'Cannot delete finish with items' });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window.
    await prisma.finish.deleteMany({ where: { id: req.params.id as string, ...tenantWhere(req) } });

    void logAudit({
      req,
      action: 'pricebook.finish_deleted',
      resourceType: 'Finish',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Finish deleted' });
  } catch (err) {
    logger.error('Failed to delete finish:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── UoM Option Handlers ─────────────────────────────────────────────────────
// These supply the unit dropdown's options. Items still store the CODE STRING,
// not a foreign key, so deleting an option cannot orphan an item — there is no
// items relation to count, and any item already carrying the code keeps it.

export const upsertUomOptionSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(1, 'Code is required').max(50),
  label: z.string().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function upsertUomOption(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof upsertUomOptionSchema>;
    // Codes are compared and stored upper-case so "pail" and "PAIL" collide on
    // the unique key instead of becoming two entries in the same dropdown.
    const data = {
      code: body.code.trim().toUpperCase(),
      label: body.label?.trim() || null,
      is_active: body.isActive ?? true,
    };

    if (body.id) {
      const result = await prisma.uomOption.updateMany({ where: { id: body.id, ...tenantWhere(req) }, data });
      if (result.count === 0) { res.status(404).json({ error: 'Unit not found' }); return; }
      const option = await prisma.uomOption.findFirst({ where: { id: body.id, ...tenantWhere(req) } });

      void logAudit({
        req,
        action: 'pricebook.uom_option_updated',
        resourceType: 'UomOption',
        resourceId: body.id,
      });

      res.json({ uomOption: mapUomOption(option) });
      return;
    }

    const option = await prisma.uomOption.create({ data: { ...data, organization_id: orgId } });

    void logAudit({
      req,
      action: 'pricebook.uom_option_created',
      resourceType: 'UomOption',
      resourceId: option.id,
    });

    res.status(201).json({ uomOption: mapUomOption(option) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'That unit already exists' });
      return;
    }
    logger.error('Failed to upsert uom option:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteUomOption(req: Request, res: Response) {
  try {
    const result = await prisma.uomOption.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Unit not found' });
      return;
    }

    void logAudit({
      req,
      action: 'pricebook.uom_option_deleted',
      resourceType: 'UomOption',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Unit deleted' });
  } catch (err) {
    logger.error('Failed to delete uom option:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Item Group Handlers (moved from inv-catalog — P0 §D2) ───────────────────

export const upsertItemGroupSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().max(2000).nullable().optional(),
  photoUrl: z.string().max(2000000).nullable().optional(),
  groupType: z.string().min(1).max(50),
  flatRatePriceOverride: z.number().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(300),
    quantity: z.number().min(0),
    priceOverride: z.number().min(0).nullable().optional(),
    costOverride: z.number().min(0).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })).optional(),
});

export async function upsertItemGroup(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof upsertItemGroupSchema>;
    const baseData: any = {
      name: body.name, description: body.description ?? null, photo_url: body.photoUrl ?? null,
      group_type: body.groupType, flat_rate_price_override: body.flatRatePriceOverride ?? null,
      is_active: body.isActive ?? true,
    };
    const linesCreate = (body.lines ?? []).map((l) => ({
      item_id: l.itemId ?? null, name: l.name, quantity: l.quantity,
      price_override: l.priceOverride ?? null, cost_override: l.costOverride ?? null,
      notes: l.notes ?? null, organization_id: orgId,
    }));
    const include = { lines: { orderBy: { created_at: 'asc' as const } } };

    if (body.id) {
      const exists = await prisma.itemGroup.findFirst({ where: { id: body.id, ...tenantWhere(req) }, select: { id: true } });
      if (!exists) { res.status(404).json({ error: 'Item group not found' }); return; }
      if (body.lines !== undefined) {
        await prisma.itemGroupLine.deleteMany({ where: { group_id: body.id, ...tenantWhere(req) } });
      }
      const group = await prisma.itemGroup.update({
        where: { id: body.id },
        data: { ...baseData, ...(body.lines !== undefined ? { lines: { create: linesCreate } } : {}) },
        include,
      });

      void logAudit({
        req,
        action: 'pricebook.item_group_updated',
        resourceType: 'ItemGroup',
        resourceId: body.id,
        metadata: { fields: Object.keys(req.body) },
      });

      res.json({ itemGroup: mapItemGroup(group) });
      return;
    }
    const group = await prisma.itemGroup.create({
      data: { ...baseData, organization_id: orgId, lines: { create: linesCreate } },
      include,
    });

    void logAudit({
      req,
      action: 'pricebook.item_group_created',
      resourceType: 'ItemGroup',
      resourceId: group.id,
    });

    res.status(201).json({ itemGroup: mapItemGroup(group) });
  } catch (err) {
    logger.error('Failed to upsert item group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteItemGroup(req: Request, res: Response) {
  try {
    // Lines cascade via the FK; groups are compositions, so no in-use guard.
    const result = await prisma.itemGroup.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Item group not found' });
      return;
    }

    void logAudit({
      req,
      action: 'pricebook.item_group_deleted',
      resourceType: 'ItemGroup',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Item group deleted' });
  } catch (err) {
    logger.error('Failed to delete item group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── CSV Import (P0 §D3, QA-107/A-16) — per-row upsert-by-(org, sku) ─────────

// Envelope only: rows are validated individually inside the handler so one
// malformed row 400s ITS row, never the whole request.
export const importItemsEnvelopeSchema = z.object({
  items: z.array(z.unknown()).min(1),
});

const importRowSchema = z.object({
  sku: z.string().max(100).nullable().optional(),
  name: z.string().min(1, 'Name is required').max(200),
  category: z.string().max(100).nullable().optional(),
  kind: z.string().max(50).nullable().optional(),
  uom: z.string().max(50).nullable().optional(),
  unitCost: z.number().min(0).nullable().optional(),
  sellPrice: z.number().min(0),
  vendor: z.string().max(200).nullable().optional(),
});

/**
 * Import field -> the COLUMN HEADING the operator sees, matching
 * docs/inventory/catalog-import-template.csv. Every message we hand back names
 * the column, because the operator's next move is to open a spreadsheet and
 * find it - "Required" tells them nothing about where to look.
 */
const IMPORT_FIELD_LABELS: Record<string, string> = {
  sku: 'SKU',
  name: 'Name',
  category: 'Category',
  kind: 'Kind',
  uom: 'UoM',
  unitCost: 'Unit Cost',
  sellPrice: 'Sell Price',
  vendor: 'Vendor',
};

/**
 * Turn the first Zod issue into something a human can act on.
 *
 * Zod's own text is written for developers - a missing `sellPrice` reads
 * "Required", a mistyped one "Expected number, received string" - and neither
 * names the column, because the field lives in `issue.path`. The operator's
 * next move is to open a spreadsheet and find the cell, so every message here
 * leads with the COLUMN HEADING and says what that column wants.
 *
 * Branches on `expected`/`received` rather than the message text: reading
 * "number" out of the prose would label `Name: 123` "Name must be a number".
 */
function importIssueMessage(issue: {
  path: PropertyKey[];
  code: string;
  message: string;
  expected?: unknown;
  received?: unknown;
  type?: unknown;
}): string {
  const field = String(issue.path[0] ?? '');
  const label = IMPORT_FIELD_LABELS[field];
  if (!label) return 'This row could not be read';

  switch (issue.code) {
    case 'invalid_type':
      // Zod 3 reports a missing key and an explicit null the same way, and for
      // this importer they mean the same thing to the operator: fill the cell.
      if (issue.received === 'undefined' || issue.received === 'null') return `${label} is required`;
      return issue.expected === 'number' ? `${label} must be a number` : `${label} must be text`;
    case 'too_small':
      return issue.type === 'string' ? `${label} is required` : `${label} cannot be negative`;
    case 'too_big':
      return `${label} is too long`;
    default:
      return `${label}: ${issue.message}`;
  }
}

/** A CSV name cell, trimmed; blank and non-string cells read as "not supplied". */
function csvName(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/**
 * name -> id index for CSV name matching, keyed case-insensitively.
 *
 * Two passes, active first: an archived record claims a name only when no live
 * record carries it, and within a pass the first row wins. Callers pass the
 * records already ordered oldest-first, so a duplicated name always resolves to
 * the same record from one import to the next.
 */
function indexByName<T extends { id: string; name: string }>(
  records: T[],
  isActive: (record: T) => boolean,
): Map<string, string> {
  const byName = new Map<string, string>();
  const key = (name: string) => name.trim().toLowerCase();
  for (const r of records) if (isActive(r) && !byName.has(key(r.name))) byName.set(key(r.name), r.id);
  for (const r of records) if (!byName.has(key(r.name))) byName.set(key(r.name), r.id);
  return byName;
}

export async function importItems(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const rows = (req.body as { items: unknown[] }).items;

    let created = 0;
    let updated = 0;
    const errors: Array<{ index: number; message: string }> = [];
    // Separate from `errors` on purpose: a warned row IS imported, just without
    // the link it asked for. Folding the two together would make the caller's
    // "N rows skipped" count lie.
    const warnings: Array<{ index: number; message: string }> = [];

    // Only pay for a lookup table when the batch actually names something. A CSV
    // with no Category/Vendor column - the common case - issues no extra query.
    const named = (field: 'category' | 'vendor') =>
      rows.some((r) => csvName((r as Record<string, unknown> | null)?.[field]) !== null);

    const categoryByName = named('category')
      ? indexByName(
          await prisma.priceBookCategory.findMany({
            where: tenantWhere(req),
            select: { id: true, name: true, is_active: true },
            orderBy: { created_at: 'asc' },
          }),
          (c) => c.is_active,
        )
      : new Map<string, string>();

    const vendorByName = named('vendor')
      ? indexByName(
          await prisma.vendor.findMany({
            where: tenantWhere(req),
            select: { id: true, name: true, status: true },
            orderBy: { created_at: 'asc' },
          }),
          // Mirrors the Vendors page: a null status is active. An archived vendor
          // still matches - archiving means "no new POs", not "deleted", and its
          // historical items must keep pointing at it.
          (v) => v.status !== 'inactive',
        )
      : new Map<string, string>();

    // VENDORS ARE MATCH-ONLY. Creating one here would widen `create PriceBook`
    // (which gates this route) into `create Vendor`, and inv-vendors.routes.ts
    // splits those two subjects on purpose - a role can hold one without the
    // other. A vendor is also a business entity with POs, contacts and message
    // threads hanging off it; a CSV cell is not enough to mint one.
    const resolveVendor = (cell: string | null | undefined, index: number): string | undefined => {
      const name = csvName(cell);
      if (!name) return undefined;
      const id = vendorByName.get(name.toLowerCase());
      if (id) return id;
      warnings.push({ index, message: `Vendor "${name}" not found - left blank` });
      return undefined;
    };

    // CATEGORIES ARE CREATED ON MISS. Same ability gates both this route and
    // POST /categories, so this grants the caller nothing they could not do in
    // one more click - and requiring 40 categories to exist before a 2,000-row
    // supplier export can be loaded is the whole reason bulk import exists.
    // The names created are returned so the dialog can show them BEFORE the
    // import (its preview reads the same list) and the toast after it.
    const createdCategories: string[] = [];
    const createCategory = async (name: string): Promise<string> => {
      const row = await prisma.priceBookCategory.create({
        data: { name, organization_id: orgId },
        select: { id: true },
      });
      // Seed the index so the other 300 rows naming this category reuse the row
      // instead of minting a duplicate per row.
      categoryByName.set(name.toLowerCase(), row.id);
      createdCategories.push(name);
      return row.id;
    };

    const resolveCategory = async (
      cell: string | null | undefined,
    ): Promise<string | undefined> => {
      const name = csvName(cell);
      if (!name) return undefined;
      return categoryByName.get(name.toLowerCase()) ?? (await createCategory(name));
    };

    // Deliberately NO wrapping transaction and no Promise.all: rows are
    // independent, processed in order, and one failure never aborts the batch.
    for (let index = 0; index < rows.length; index++) {
      const parsed = importRowSchema.safeParse(rows[index]);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        errors.push({
          index,
          message: issue ? importIssueMessage(issue) : 'This row could not be read',
        });
        continue;
      }
      const row = parsed.data;
      const vendorId = resolveVendor(row.vendor, index);
      let categoryId: string | undefined;
      try {
        categoryId = await resolveCategory(row.category);
        const existing = row.sku
          ? await prisma.priceBookItem.findFirst({
              where: { sku: row.sku, ...tenantWhere(req) },
              select: { id: true },
            })
          : null;
        if (existing) {
          await prisma.priceBookItem.update({
            where: { id: existing.id },
            data: {
              name: row.name,
              kind: normalizeKind(row.kind),
              // SRVW-90: only repoint type when the CSV actually carried a kind,
              // so a re-import with no kind column cannot flip MATERIAL to SERVICE.
              ...(row.kind ? { type: typeForKind(row.kind) } : {}),
              // Same guard, same reason: a blank cell - or a vendor name that
              // matched nothing - leaves the existing link alone. An import can
              // set or repoint a link, never clear one; unlinking is a job for
              // the item form.
              ...(categoryId ? { category_id: categoryId } : {}),
              ...(vendorId ? { vendor_id: vendorId } : {}),
              uom: row.uom ?? null,
              unit_cost: row.unitCost ?? null,
              unit_price: row.sellPrice,
              sell_price: row.sellPrice,
            },
          });
          updated++;
        } else {
          await prisma.priceBookItem.create({
            data: {
              name: row.name,
              sku: row.sku ?? null,
              kind: normalizeKind(row.kind),
              // SRVW-90: same projection as the UI door. Unconditional is safe -
              // a kind-less row yields SERVICE, today's schema default.
              type: typeForKind(row.kind),
              category_id: categoryId ?? null,
              vendor_id: vendorId ?? null,
              uom: row.uom ?? null,
              unit_cost: row.unitCost ?? null,
              unit_price: row.sellPrice,
              sell_price: row.sellPrice,
              organization_id: orgId,
            },
          });
          created++;
        }
      } catch (rowErr) {
        // A raw Prisma message ("Invalid `prisma.priceBookItem.create()` invocation
        // ... Unique constraint failed on the fields: (`sku`)") is not something an
        // operator can act on, and it leaks our schema. Log it, hand back plain
        // English, and keep the row's own identity in the reply so the row is
        // findable in the spreadsheet.
        if (!isUniqueViolation(rowErr)) logger.error('Import row failed:', rowErr);
        errors.push({
          index,
          message: isUniqueViolation(rowErr)
            ? 'An item with this SKU already exists'
            : 'This row could not be saved - check its values and try again',
        });
      }
    }

    void logAudit({
      req,
      action: 'pricebook.items_imported',
      resourceType: 'PriceBookItem',
      resourceId: null,
      metadata: {
        created,
        updated,
        error_count: errors.length,
        warning_count: warnings.length,
        categories_created: createdCategories.length,
      },
    });

    res.json({ created, updated, errors, warnings, createdCategories });
  } catch (err) {
    logger.error('Failed to import items:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
