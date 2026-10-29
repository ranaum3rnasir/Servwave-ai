import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { featureDisabled } from '../middleware/featureDisabled';
import * as invPoController from '../controllers/inv-po.controller';

// Mounted at /api/inventory (see src/app.ts wiring step).
const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// Subject split (inventory P0, D11): everything purchasing-shaped gates on `PurchaseOrder`,
// not the coarse `Inventory` subject (which now means stock only).
// ─── Purchase Orders ────────────────────────────────────
router.get('/purchase-orders', canDo('read', 'PurchaseOrder'), invPoController.listPurchaseOrders);
router.post('/purchase-orders', canDo('create', 'PurchaseOrder'), validate(invPoController.createPurchaseOrderSchema), invPoController.createPurchaseOrder);
router.post('/purchase-orders/from-job', canDo('create', 'PurchaseOrder'), validate(invPoController.createPurchaseOrderFromJobSchema), invPoController.createPurchaseOrderFromJob);
// Registered BEFORE /purchase-orders/:id or the :id route swallows the literal path.
// Proposals carry unit_cost, hence the PurchaseOrder read gate. Org-scoped only (#2042 R3,
// AC12) - any `read PurchaseOrder` holder passes, including a job-scoped SALES rep; per Ran's
// decision SALES reads the whole inventory module. `unit_cost` (here and on every other
// purchasing read) is stripped in the controller for a caller whose role does NOT also hold
// `read Pricing` ("See financial data" off) - security round 3 finding D. `read PurchaseOrder`
// alone does not disclose cost; the gate below controls reachability, not cost visibility.
router.get('/purchase-orders/low-stock-proposals', canDo('read', 'PurchaseOrder'), invPoController.listLowStockProposals);
router.get('/purchase-orders/:id', canDo('read', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), invPoController.getPurchaseOrder);
// Real PO activity timeline (D7): audit-log lifecycle events + historical email rows.
router.get('/purchase-orders/:id/activity', canDo('read', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), invPoController.getPurchaseOrderActivity);
router.patch('/purchase-orders/:id', canDo('update', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), validate(invPoController.updatePurchaseOrderSchema), invPoController.updatePurchaseOrder);
// Lifecycle (Purchasing Audit Verdict, PR 2): the buyer placed the order their own way and
// records it here (date + actor); delete is allowed only while nothing has been received.
router.post('/purchase-orders/:id/mark-ordered', canDo('update', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), validate(invPoController.markOrderedSchema), invPoController.markPurchaseOrderOrdered);
router.delete('/purchase-orders/:id', canDo('delete', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), invPoController.deletePurchaseOrder);
router.post('/purchase-orders/receive', canDo('update', 'PurchaseOrder'), validate(invPoController.receivePurchaseOrderSchema), invPoController.receivePurchaseOrder);
// There is deliberately NO `/purchase-orders/:id/send` route: ServWave never
// sends a PO to a vendor (Purchasing Audit Verdict, PR 1). Preview/Print is the
// only way a PO leaves the system.

// ─── Job material-cost roll-up (read-side, zero invoice impact) ──────────────
router.get('/jobs/:jobId/material-cost', canDo('read', 'PurchaseOrder'), invPoController.getJobMaterialCost);

// ─── RFQs — PARKED (P0 §C, QA-902 / plan A-18) ──────────
// Feature-disabled for everyone (incl. Admin): auth still runs first (401
// without a token), then every verb answers 404 FEATURE_DISABLED. Handlers
// stay in the controller for cheap un-parking (same pattern as the #743 SMS lock).
router.get('/rfqs', featureDisabled('rfq'));
router.post('/rfqs', featureDisabled('rfq'));
router.get('/rfqs/:id', featureDisabled('rfq'));
router.patch('/rfqs/:id', featureDisabled('rfq'));

// ─── Estimate Reservations — REMOVED (Purchasing Audit Verdict, PR 2 / R10) ──
// Estimate wins no longer create reservation rows and the Pre-PO queue is gone, so
// every /estimate-reservations verb answers 404. The Prisma models and tables stay
// (historical rows are kept; dropping them is a later migration).

export default router;
