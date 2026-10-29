import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { requireFeature } from '../middleware/requireFeature';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as reportController from '../controllers/report.controller';

const router = Router();

router.use(authenticate, attachAbility, expensiveLimiter);

// S1 — Estimate / Quote Conversion report. Reports are gated on the dedicated `read Report`
// capability (Admin + Dispatcher only). Sales/Technician have no `read Report` grant → 403.
router.get('/estimate-conversion', canDo('read', 'Report'), reportController.getEstimateConversion);
router.get('/estimate-conversion/estimates', canDo('read', 'Report'), reportController.getEstimateConversionDrilldown);

// F4 — AR Aging & Collections. Same `read Report` gate (Admin + Dispatcher).
router.get('/ar-aging', canDo('read', 'Report'), reportController.getArAging);

// Wave 2 live reports — all on the same `read Report` gate (Admin + Dispatcher).
router.get('/jobs', canDo('read', 'Report'), reportController.getJobsReport);
router.get('/leads', canDo('read', 'Report'), reportController.getLeadsReport);
router.get('/estimates', canDo('read', 'Report'), reportController.getEstimatesReport);
router.get('/revenue', canDo('read', 'Report'), reportController.getRevenueReport);
router.get('/payments', canDo('read', 'Report'), reportController.getPaymentsReport);
// Task 4.1 — payment processing fees summary (Gross/Stripe/ServWave/Net), same gate.
router.get('/payment-fees', canDo('read', 'Report'), reportController.getPaymentFeesReport);
router.get('/invoices', canDo('read', 'Report'), reportController.getInvoicesReport);
router.get('/activity', canDo('read', 'Report'), reportController.getActivityReport);

// P5 — Inventory usage (Σ consume per item; cost figures canSeePricing-gated in-controller).
// requireFeature('inventory') is per-route, not on the shared router.use above - every other
// report route stays ungated. attachAbility already ran on the shared router.use, so the ability
// is BUILT before this gate; only the canDo DECISION lands after, which is all the 402-not-403
// contract needs (SRVW-160).
router.get(
  '/inventory-usage',
  requireFeature('inventory'),
  canDo('read', 'Report'),
  reportController.getInventoryUsageReport,
);

export default router;
