import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { validate } from '../middleware/validate';
import * as tc from '../controllers/timeclock.controller';

const router = Router();

// Every timeclock route is authenticated + ability-loaded. Clock-ins are open to every signed-in person; the org
// timesheet views (punches and overtime reviews with ?scope=org) check Timesheets scope in the controller.
router.use(authenticate, attachAbility);

// ─── Punches ───────────────────────────────────────────
router.post('/punches', validate(tc.createPunchSchema), tc.createPunch);
router.get('/punches', tc.listPunches);

// ─── Overtime reviews ──────────────────────────────────
router.get('/ot-reviews', tc.listOtReviews);
router.post('/ot-reviews', validate(tc.createOtReviewSchema), tc.createOtReview);

export default router;
