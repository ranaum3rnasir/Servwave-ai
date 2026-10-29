import { Request, Response, Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as invCatalog from '../controllers/inv-catalog.controller';

const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// Catalog writes moved to /api/price-book/* (P0 §D4) — single write path. The
// old routes stay mounted but answer 410 Gone so a stale client fails loudly
// instead of silently writing through a dead, unaudited path.
const gone = (_req: Request, res: Response) =>
  res.status(410).json({ error: 'GONE', message: 'Catalog writes moved to /api/price-book/*' });

// ─── Items ──────────────────────────────────────────────
// Reads stay here (stock-enriched camelCase mapItem + stock_balances):
//   GET /api/inventory/items      → { data: Item[], meta } (P0 §D5)
//   GET /api/inventory/items/:id  → { item }
router.get('/items', canDo('read', 'Inventory'), invCatalog.listItems);
router.post('/items', gone);            // → POST/PATCH /api/price-book/items
router.post('/items/import', gone);     // → POST /api/price-book/items/import
router.post('/items/delete', gone);     // → DELETE /api/price-book/items/:id
router.get('/items/:id', canDo('read', 'Inventory'), invCatalog.getItem);
router.delete('/items/:id', gone);      // → DELETE /api/price-book/items/:id

// ─── Categories / Brands / Item Groups ──────────────────
// Pure-catalog vocabulary reads — re-gated to the PriceBook subject (P0 §D4).
router.get('/categories', canDo('read', 'PriceBook'), invCatalog.listCategories);
router.post('/categories', gone);       // → POST/PATCH /api/price-book/categories
router.get('/brands', canDo('read', 'PriceBook'), invCatalog.listBrands);
router.post('/brands', gone);           // → POST /api/price-book/brands
router.get('/finishes', canDo('read', 'PriceBook'), invCatalog.listFinishes);
router.get('/uom-options', canDo('read', 'PriceBook'), invCatalog.listUomOptions);
router.get('/item-groups', canDo('read', 'PriceBook'), invCatalog.listItemGroups);
router.post('/item-groups', gone);      // → POST /api/price-book/item-groups

// ─── Stock writes (B2, V5) — stay live on the Inventory subject ──────────────
//   POST /api/inventory/restock        ← { itemId, locationId, qty, unitCost?, source?, reference?, notes? }
//   POST /api/inventory/bulk-restock   ← { lines: { itemId, locationId, qty, unitCost? }[] }
//   POST /api/inventory/transfer       ← { itemId, fromId, toId, qty, reason? }
router.post('/restock', canDo('update', 'Inventory'), validate(invCatalog.restockSchema), invCatalog.restock);
router.post('/bulk-restock', canDo('update', 'Inventory'), validate(invCatalog.bulkRestockSchema), invCatalog.bulkRestock);
router.post('/transfer', canDo('update', 'Inventory'), validate(invCatalog.transferSchema), invCatalog.transferStock);

export default router;
