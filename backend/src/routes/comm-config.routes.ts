import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as commConfigController from '../controllers/comm-config.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// #2046: every route in this file is section-only config (call-flow/call-group/training) - no
// record-tab consumer anywhere in it.

// ─── Call flows ─────────────────────────────────────────
router.get('/call-flows', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.listCallFlows);
router.post('/call-flows', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), validate(commConfigController.createCallFlowSchema), commConfigController.createCallFlow);
router.get('/call-flows/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.getCallFlow);
router.patch('/call-flows/:id', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commConfigController.updateCallFlowSchema), commConfigController.updateCallFlow);
router.delete('/call-flows/:id', canDo('delete', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.deleteCallFlow);

// ─── Call groups ────────────────────────────────────────
router.get('/call-groups', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.listCallGroups);
router.post('/call-groups', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), validate(commConfigController.createCallGroupSchema), commConfigController.createCallGroup);
router.get('/call-groups/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.getCallGroup);
router.patch('/call-groups/:id', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commConfigController.updateCallGroupSchema), commConfigController.updateCallGroup);
router.delete('/call-groups/:id', canDo('delete', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.deleteCallGroup);

// ─── Training scenarios (read-only) ─────────────────────
router.get('/training/scenarios', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.listTrainingScenarios);
router.get('/training/scenarios/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.getTrainingScenario);

// ─── Training sessions (read-only) ──────────────────────
router.get('/training/sessions', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.listTrainingSessions);
router.get('/training/sessions/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commConfigController.getTrainingSession);

export default router;
