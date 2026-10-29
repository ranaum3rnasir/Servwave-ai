import { Request, Response, Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as vendorsController from '../controllers/inv-vendors.controller';
import * as categoriesController from '../controllers/inv-vendor-categories.controller';

const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// P2 item 7a: the verb-style POST /vendors/delete is retired for the canonical
// DELETE /vendors/:id. Same precedent as the P0 catalog write-path retirement —
// 410 GONE with a pointer so a stale client fails loudly instead of silently
// deleting through a dead path.
const gone = (_req: Request, res: Response) =>
  res.status(410).json({ error: 'GONE', message: 'Use DELETE /api/inventory/vendors/:id' });

// ─── Vendors ────────────────────────────────────────────
// Subject split (inventory P0, D11): vendors gate on `Vendor`, not the coarse `Inventory`.
// Pre-existing quirk kept as-is: the upsert updates under the *create* gate — P2's contract
// normalization splits the verbs.
router.get('/vendors', canDo('read', 'Vendor'), vendorsController.listVendors);
router.post('/vendors', canDo('create', 'Vendor'), validate(vendorsController.upsertVendorSchema), vendorsController.upsertVendor);
router.post('/vendors/delete', canDo('delete', 'Vendor'), gone); // → DELETE /vendors/:id
router.get('/vendors/:id', canDo('read', 'Vendor'), vendorsController.getVendor);
router.delete('/vendors/:id', canDo('delete', 'Vendor'), vendorsController.deleteVendor);

// ─── Vendor categories (Purchasing Audit Verdict PR 4, S4.1) ────────────────
// A real per-company list behind the vendor pickers. Same subject as vendors:
// whoever may curate vendors may curate the names they are filed under.
router.get('/vendor-categories', canDo('read', 'Vendor'), categoriesController.listVendorCategories);
router.post('/vendor-categories', canDo('create', 'Vendor'), validate(categoriesController.vendorCategorySchema), categoriesController.createVendorCategory);
router.patch('/vendor-categories/:id', canDo('update', 'Vendor'), validate(categoriesController.vendorCategorySchema), categoriesController.renameVendorCategory);
router.delete('/vendor-categories/:id', canDo('delete', 'Vendor'), categoriesController.deleteVendorCategory);

export default router;
