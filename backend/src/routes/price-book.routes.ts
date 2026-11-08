import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { withOrgContext } from '../middleware/withOrgContext';
import * as priceBookController from '../controllers/price-book.controller';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import { MAX_ESTIMATE_PHOTO_BYTES } from '../controllers/estimate-photos.controller';
import * as priceBookImageController from '../controllers/price-book-image.controller';

const router = Router();

router.use(authenticate, attachAbility);

// #2045 — the narrow "fill if empty" endpoint's upload: memoryStorage, image-only. The route-level
// limit is a generous ceiling ABOVE the handler's real 8MB cap (mirrors estimate.routes.ts's
// photoUpload) so an oversized image 400s with the handler's precise message instead of multer's
// own LIMIT_FILE_SIZE error surfacing as a raw 500.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// fillItemImage enforces MAX_ESTIMATE_PHOTO_BYTES (it shares estimate-photos' cap), so that
// is the number quoted here — not the 10MB ceiling, which no user is entitled to.
const imageMulterErrors = multerErrorHandler({
  tooLarge: `That image is too large to upload. Item images can be up to ${megabytes(MAX_ESTIMATE_PHOTO_BYTES)}.`,
});

// ─── Categories ─────────────────────────────────────────
router.get('/categories', canDo('read', 'PriceBook'), priceBookController.listCategories);
router.post('/categories', canDo('create', 'PriceBook'), validate(priceBookController.createCategorySchema), priceBookController.createCategory);
router.patch('/categories/:id', canDo('update', 'PriceBook'), validate(priceBookController.updateCategorySchema), priceBookController.updateCategory);
router.delete('/categories/:id', canDo('delete', 'PriceBook'), priceBookController.deleteCategory);

// ─── Items ──────────────────────────────────────────────
router.get('/items/search', canDo('read', 'PriceBook'), priceBookController.searchItems);
router.get('/items', canDo('read', 'PriceBook'), priceBookController.listItems);
router.post('/items', canDo('create', 'PriceBook'), validate(priceBookController.createItemSchema), priceBookController.createItem);
router.post('/items/import', canDo('create', 'PriceBook'), validate(priceBookController.importItemsEnvelopeSchema), priceBookController.importItems);
router.get('/items/:id', canDo('read', 'PriceBook'), priceBookController.getItem);
router.patch('/items/:id', canDo('update', 'PriceBook'), validate(priceBookController.updateItemSchema), priceBookController.updateItem);
router.delete('/items/:id', canDo('delete', 'PriceBook'), priceBookController.deleteItem);
// #2045 — narrow "fill if empty" endpoint: gated `update Estimate` (NOT `update PriceBook`), never
// a role-name check. Lets a requester who may edit an estimate but not the catalog fill an
// image-less item's picture from a line; replacing an EXISTING image stays `update PriceBook`-only
// (the PATCH route above). requireUuidParam sits before multer so a malformed id 404s before any
// bytes are read; withOrgContext MUST come AFTER multer — see its own header comment.
router.post(
  '/items/:id/image',
  canDo('update', 'Estimate'),
  requireUuidParam('id', 'Item not found'),
  imageUpload.single('file'),
  imageMulterErrors,
  withOrgContext,
  priceBookImageController.fillItemImage,
);

// ─── Brands + Item Groups (single catalog write path — P0 §D2) ───────────────
router.post('/brands', canDo('create', 'PriceBook'), validate(priceBookController.upsertBrandSchema), priceBookController.upsertBrand);
router.delete('/brands/:id', canDo('delete', 'PriceBook'), priceBookController.deleteBrand);
router.post('/finishes', canDo('create', 'PriceBook'), validate(priceBookController.upsertFinishSchema), priceBookController.upsertFinish);
router.delete('/finishes/:id', canDo('delete', 'PriceBook'), priceBookController.deleteFinish);
router.post('/uom-options', canDo('create', 'PriceBook'), validate(priceBookController.upsertUomOptionSchema), priceBookController.upsertUomOption);
router.delete('/uom-options/:id', canDo('delete', 'PriceBook'), priceBookController.deleteUomOption);
router.post('/item-groups', canDo('create', 'PriceBook'), validate(priceBookController.upsertItemGroupSchema), priceBookController.upsertItemGroup);
router.delete('/item-groups/:id', canDo('delete', 'PriceBook'), priceBookController.deleteItemGroup);

export default router;
