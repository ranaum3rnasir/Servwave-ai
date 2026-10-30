import { Router, RequestHandler } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as statementController from '../controllers/statement.controller';
import { markReadsNoRecord } from '../lib/ids/canonicalId';

const router = Router();

router.use(authenticate, attachAbility);

// Apply the expensive limiter only for ?format=pdf requests; plain JSON reads stay on the
// general limiter (applied globally in app.ts).
const expensiveIfPdf: RequestHandler = markReadsNoRecord((req, res, next) =>
  req.query.format === 'pdf' ? expensiveLimiter(req, res, next) : next());

// Statement (entity-redesign §9) — a READ-ONLY projection of the invoice/payment ledger.
// Guarded by read:Invoice (org-level): the statement is a read-only view of invoices +
// payments, so 'read Invoice' is the precise capability. Reusing it avoids adding a new
// Statement CASL subject + the catalog/grants/parity churn. read:Invoice is already granted
// to ADMIN (manage), DISPATCHER, SALES(own). TECHNICIAN holds it only via a per-user toggle.
// PDF variant via ?format=pdf is branched inside the controller (single route per scope).
// P11: a statement is nothing but amounts and balances, so it opens only for a person who can see prices; one without them
// gets no statement rather than an empty one.
router.get('/job/:jobId', expensiveIfPdf, canDo('read', 'Invoice'), canDo('read', 'Prices'), statementController.getJobStatement);
router.get('/customer/:customerId', expensiveIfPdf, canDo('read', 'Invoice'), canDo('read', 'Prices'), statementController.getCustomerStatement);

export default router;
