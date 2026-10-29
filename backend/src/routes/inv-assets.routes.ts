import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as invAssetsController from '../controllers/inv-assets.controller';
import { MAX_PHOTO_SIZE } from '../controllers/inv-assets.controller';

const router = Router();
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_SIZE }, // 25MB — same number the handler re-checks
});

// Here the route ceiling and the handler cap are the SAME number, so the message is the
// handler's 25MB either way.
const photoMulterErrors = multerErrorHandler({
  tooLarge: `That photo is too large to upload. Asset photos can be up to ${megabytes(MAX_PHOTO_SIZE)}.`,
});

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── Assets (company tools — Inventory subject, plan D11) ──
router.get('/assets', canDo('read', 'Inventory'), invAssetsController.listAssets);
router.post('/assets', canDo('create', 'Inventory'), validate(invAssetsController.createAssetSchema), invAssetsController.createAsset);
router.get('/assets/:id', canDo('read', 'Inventory'), invAssetsController.getAsset);
router.patch('/assets/:id', canDo('update', 'Inventory'), validate(invAssetsController.updateAssetSchema), invAssetsController.updateAsset);
router.delete('/assets/:id', canDo('delete', 'Inventory'), invAssetsController.deleteAsset);

// Append-only event ledger (read-only — no update/delete endpoints ever).
router.get('/assets/:id/events', canDo('read', 'Inventory'), invAssetsController.listAssetEvents);

// ─── Lifecycle verbs (assign/return/transfer/retire/note = update Inventory) ──
router.post('/assets/:id/assign', canDo('update', 'Inventory'), validate(invAssetsController.assignAssetSchema), invAssetsController.assignAsset);
router.post('/assets/:id/return', canDo('update', 'Inventory'), validate(invAssetsController.returnAssetSchema), invAssetsController.returnAsset);
router.post('/assets/:id/transfer', canDo('update', 'Inventory'), validate(invAssetsController.transferAssetSchema), invAssetsController.transferAsset);
router.post('/assets/:id/retire', canDo('update', 'Inventory'), validate(invAssetsController.retireAssetSchema), invAssetsController.retireAsset);
router.post('/assets/:id/note', canDo('update', 'Inventory'), validate(invAssetsController.noteAssetSchema), invAssetsController.noteAsset);

// multipart — `withOrgContext` MUST come AFTER multer: multer's stream
// consumption drops the org AsyncLocalStorage scope (learning "multer drops
// the ALS tenant context"; same order as attachment.routes.ts).
router.post('/assets/:id/photo', canDo('update', 'Inventory'), photoUpload.single('file'), photoMulterErrors, withOrgContext, invAssetsController.uploadAssetPhoto);

export default router;
