import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireAdminTo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as jobCancelReasonController from '../controllers/jobCancelReason.controller';

const router = Router();

router.use(authenticate, attachAbility);

/**
 * Gating mirrors jobSubStatus.routes.ts: the WRITES are Company settings (`update Organization`, the same switch that
 * edits the estimate decline reasons); the READ is reference data with no switch, because the cancel dialogs of anyone
 * who may cancel a job fill their picker from it. The list is the org's own vocabulary and carries nothing personal or
 * financial.
 */
router.get('/', jobCancelReasonController.list);
router.post('/', requireAdminTo('change company settings'), validate(jobCancelReasonController.createJobCancelReasonSchema), jobCancelReasonController.create);
// Literal path segment BEFORE the ":code" route, the house ordering rule.
router.post('/reorder', requireAdminTo('change company settings'), validate(jobCancelReasonController.reorderJobCancelReasonsSchema), jobCancelReasonController.reorder);
router.patch('/:code', requireAdminTo('change company settings'), validate(jobCancelReasonController.updateJobCancelReasonSchema), jobCancelReasonController.update);

// No DELETE. A reason is turned off, never deleted: a cancelled job holds the code.

export default router;
