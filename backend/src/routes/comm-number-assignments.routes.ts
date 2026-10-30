import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { requireAdminTo } from '../middleware/canGuard';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/comm-number-assignments.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// Managing who may send from which number (and the defaults) is org configuration,
// so these are an Admin's alone (M8, D3: the Admin flag, not the Company settings switch) — same rationale
// as comm-numbers.routes §A.2 (a Communication grant would let DISPATCHER manage it). Written out on each
// route, not aliased, so permission-company-admin-only-guard.test.ts can see the check on every one.

// A malformed id (non-uuid) answers the same 404 as a missing row, before Prisma runs (P2023 screen).
const numberId = requireUuidParam('id', 'Phone number not found');
const userId = requireUuidParam('userId', 'User not found');

router.get('/number-assignments', requireAdminTo('change phone numbers'), ctrl.listNumberAssignments);
router.put('/numbers/:id/assignments', requireAdminTo('change phone numbers'), numberId, validate(ctrl.setAssignmentsSchema), ctrl.setNumberAssignments);
router.put('/numbers/:id/org-default', requireAdminTo('change phone numbers'), numberId, validate(ctrl.setOrgDefaultSchema), ctrl.setOrgDefaultNumber);
router.put('/users/:userId/default-number', requireAdminTo('change phone numbers'), userId, validate(ctrl.setUserDefaultSchema), ctrl.setUserDefaultNumber);

export default router;
