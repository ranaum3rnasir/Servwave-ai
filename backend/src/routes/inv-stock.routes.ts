import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { featureDisabled } from '../middleware/featureDisabled';
import * as invStockController from '../controllers/inv-stock.controller';

const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── Movements ──────────────────────────────────────────
router.get('/movements', canDo('read', 'Inventory'), invStockController.listMovements);
router.get('/movements/:id', canDo('read', 'Inventory'), invStockController.getMovement);

// ─── Low stock (P5 §1.1): server-computed per-(item, location) shortfall ──────
router.get('/low-stock', canDo('read', 'Inventory'), invStockController.listLowStock);

// ─── Count adjustment (P1 §3.3): "Counted N" → signed adjust movement ─────────
router.post('/stock/set-quantity', canDo('update', 'Inventory'), validate(invStockController.setQuantitySchema), invStockController.setQuantity);

// ─── Reserve levels (SRVW-91): the only writer of StockBalance.min/max ────────
router.put('/stock/thresholds', canDo('update', 'Inventory'), validate(invStockController.setThresholdsSchema), invStockController.setThresholds);

// ─── Stock Approvals — PARKED (P0 §C, QA-902 / plan A-18) ─────────────────────
// Feature-disabled for everyone (incl. Admin): auth still runs first (401
// without a token), then every verb answers 404 FEATURE_DISABLED. Handlers
// stay in the controller for cheap un-parking (same pattern as the #743 SMS lock).
router.get('/stock-approvals', featureDisabled('stock_approvals'));
router.post('/stock-approvals', featureDisabled('stock_approvals'));
router.post('/stock-approvals/decide', featureDisabled('stock_approvals'));
router.get('/stock-approvals/:id', featureDisabled('stock_approvals'));

export default router;
