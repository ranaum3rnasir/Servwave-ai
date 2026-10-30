import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo, canDoAny } from '../middleware/canGuard';
import { requireFeature } from '../middleware/requireFeature';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as reportController from '../controllers/report.controller';

const router = Router();

router.use(authenticate, attachAbility, expensiveLimiter);

// S1 — Estimate / Quote Conversion report. Reports are gated on the `read Report` capability, which is what the
// "Access Reports" switch compiles into: a person without it is refused (403) on every report endpoint here.
router.get('/estimate-conversion', canDo('read', 'Report'), reportController.getEstimateConversion);
router.get('/estimate-conversion/estimates', canDo('read', 'Report'), reportController.getEstimateConversionDrilldown);

// F4 — AR Aging & Collections: the shared unpaid-invoices report. Billing (the "Access Billing" switch, `access Billing`)
// and Reports (`read Report`) both open it, so a Billing-only role and a Reports-only role each keep the data; a person
// with neither is refused. Every other report endpoint here stays on `read Report` alone.
router.get('/ar-aging', canDoAny([['access', 'Billing'], ['read', 'Report']]), reportController.getArAging);

// Wave 2 live reports — all on the same `read Report` gate.
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
