import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/comm-number-assignments.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// Managing who may send from which number (and the defaults) is org configuration,
// so these carry the ADMIN idiom canDo('update','Organization') — same rationale
// as comm-numbers.routes §A.2 (a Communication grant would let DISPATCHER manage it).
const ADMIN = canDo('update', 'Organization');

router.get('/number-assignments', ADMIN, ctrl.listNumberAssignments);
router.put('/numbers/:id/assignments', ADMIN, validate(ctrl.setAssignmentsSchema), ctrl.setNumberAssignments);
router.put('/numbers/:id/org-default', ADMIN, validate(ctrl.setOrgDefaultSchema), ctrl.setOrgDefaultNumber);
router.put('/users/:userId/default-number', ADMIN, validate(ctrl.setUserDefaultSchema), ctrl.setUserDefaultNumber);

export default router;
