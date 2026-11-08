import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as tc from '../controllers/timeclock.controller';

const router = Router();

// Every timeclock route is authenticated + ability-loaded (admin mutations gated via CASL).
router.use(authenticate, attachAbility);

// ─── Punches ───────────────────────────────────────────
router.post('/punches', validate(tc.createPunchSchema), tc.createPunch);
router.get('/punches', tc.listPunches);

// Override decisions — approver-gated IN the controller (per-person grant, not a role).
router.post('/punches/:id/override/approve', tc.approveOverride);
router.post('/punches/:id/override/reject', tc.rejectOverride);

// ─── Config (read: any authed; write: CASL update Timeclock = ADMIN) ───
router.get('/config', tc.getConfig);
router.put('/config', canDo('update', 'Timeclock'), validate(tc.updateConfigSchema), tc.updateConfig);

// ─── Stores (CASL update Timeclock = ADMIN) ────────────
router.post('/stores', canDo('update', 'Timeclock'), validate(tc.createStoreSchema), tc.createStore);
router.patch('/stores/:id', canDo('update', 'Timeclock'), validate(tc.updateStoreSchema), tc.updateStore);
router.delete('/stores/:id', canDo('update', 'Timeclock'), tc.deleteStore);

// ─── Per-user timeclock settings (CASL update Timeclock = ADMIN) ───────
router.patch(
  '/users/:id/timeclock-settings',
  canDo('update', 'Timeclock'),
  validate(tc.updateUserSettingsSchema),
  tc.updateUserSettings,
);

// ─── Overtime reviews ──────────────────────────────────
router.get('/ot-reviews', tc.listOtReviews);
router.post('/ot-reviews', validate(tc.createOtReviewSchema), tc.createOtReview);

export default router;
