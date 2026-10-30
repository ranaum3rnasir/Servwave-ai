import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/comm-number-assignments.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// Managing who may send from which number (and the defaults) is org configuration,
// so these carry the ADMIN idiom canDo('update','Organization') — same rationale
// as comm-numbers.routes §A.2 (a Communication grant would let DISPATCHER manage it).
const ADMIN = canDo('update', 'Organization');

// A malformed id (non-uuid) answers the same 404 as a missing row, before Prisma runs (P2023 screen).
const numberId = requireUuidParam('id', 'Phone number not found');
const userId = requireUuidParam('userId', 'User not found');

router.get('/number-assignments', ADMIN, ctrl.listNumberAssignments);
router.put('/numbers/:id/assignments', ADMIN, numberId, validate(ctrl.setAssignmentsSchema), ctrl.setNumberAssignments);
router.put('/numbers/:id/org-default', ADMIN, numberId, validate(ctrl.setOrgDefaultSchema), ctrl.setOrgDefaultNumber);
router.put('/users/:userId/default-number', ADMIN, userId, validate(ctrl.setUserDefaultSchema), ctrl.setUserDefaultNumber);

export default router;
