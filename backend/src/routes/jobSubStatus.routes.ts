import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as jobSubStatusController from '../controllers/jobSubStatus.controller';

const router = Router();

router.use(authenticate, attachAbility);

// SRVW-112 - gating mirrors org-tax-rate.routes.ts: the WRITES reuse the existing
// `update Organization` grant (this is an org-settings catalog, the same population that already
// edits job_type_options on the Payments & Lists page) rather than minting a new CASL Subject.
// The READ is the coarser `read Job` instead, because every job viewer needs these labels to
// render a job, not just the settings population.
router.get('/', canDo('read', 'Job'), jobSubStatusController.list);
router.post('/', canDo('update', 'Organization'), validate(jobSubStatusController.createJobSubStatusSchema), jobSubStatusController.create);
// Literal path segment BEFORE any ":id" route. Safe today either way (the only /:id routes are
// PATCH and DELETE, and Express matches on method as well as path), but the ordering is the house
// rule here and keeps a future POST /:id/... from shadowing it.
router.post('/reorder', canDo('update', 'Organization'), validate(jobSubStatusController.reorderJobSubStatusSchema), jobSubStatusController.reorder);
router.patch('/:id', canDo('update', 'Organization'), validate(jobSubStatusController.updateJobSubStatusSchema), jobSubStatusController.update);
router.delete('/:id', canDo('update', 'Organization'), jobSubStatusController.remove);

export default router;
