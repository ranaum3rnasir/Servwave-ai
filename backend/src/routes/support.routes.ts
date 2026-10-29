import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import * as supportController from '../controllers/support.controller';

const router = Router();

// Authentication only - no feature gate and no role check. Reaching sales is
// how an org asks for the plan it does not have yet, so gating it behind a
// feature or an admin role would lock out exactly the people who need it.
router.post(
  '/sales-request',
  authenticate,
  validate(supportController.salesRequestSchema),
  supportController.createSalesRequest,
);

export default router;
