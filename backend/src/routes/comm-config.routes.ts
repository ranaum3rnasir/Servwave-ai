import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { validate } from '../middleware/validate';
import { requirePhoneSetupOrg } from '../middleware/requirePhoneSetupOrg';
import * as commConfigController from '../controllers/comm-config.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// #2046: every route in this file is section-only config (call-flow/call-group/training) - no
// record-tab consumer anywhere in it.
// S08.16: each route also follows its tab's switch (Call flows, Call groups, Training), read and write, ON TOP of the
// grants it needed before, and then the pilot-or-demo org gate (after the switches, so a missing switch is a 403 in any org).

// A malformed :id (non-uuid) answers the same 404 as a missing row, before Prisma runs (P2023 screen). The training scenario read is
// left out: a scenario is also found by its slug, so a non-uuid is a valid id there.
const callFlowId = requireUuidParam('id', 'Call flow not found');
const callGroupId = requireUuidParam('id', 'Call group not found');
const trainingSessionId = requireUuidParam('id', 'Training session not found');

// ─── Call flows ─────────────────────────────────────────
router.get('/call-flows', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_flows_tab', 'Communication'), requirePhoneSetupOrg(), commConfigController.listCallFlows);
router.post('/call-flows', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_flows_tab', 'Communication'), requirePhoneSetupOrg(), validate(commConfigController.createCallFlowSchema), commConfigController.createCallFlow);
router.get('/call-flows/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_flows_tab', 'Communication'), requirePhoneSetupOrg(), callFlowId, commConfigController.getCallFlow);
router.patch('/call-flows/:id', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_flows_tab', 'Communication'), requirePhoneSetupOrg(), callFlowId, validate(commConfigController.updateCallFlowSchema), commConfigController.updateCallFlow);
router.delete('/call-flows/:id', canDo('delete', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_flows_tab', 'Communication'), requirePhoneSetupOrg(), callFlowId, commConfigController.deleteCallFlow);

// ─── Call groups ────────────────────────────────────────
router.get('/call-groups', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_groups_tab', 'Communication'), requirePhoneSetupOrg(), commConfigController.listCallGroups);
router.post('/call-groups', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_groups_tab', 'Communication'), requirePhoneSetupOrg(), validate(commConfigController.createCallGroupSchema), commConfigController.createCallGroup);
router.get('/call-groups/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_groups_tab', 'Communication'), requirePhoneSetupOrg(), callGroupId, commConfigController.getCallGroup);
router.patch('/call-groups/:id', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_groups_tab', 'Communication'), requirePhoneSetupOrg(), callGroupId, validate(commConfigController.updateCallGroupSchema), commConfigController.updateCallGroup);
router.delete('/call-groups/:id', canDo('delete', 'Communication'), canDo('access_inbox', 'Communication'), canDo('call_groups_tab', 'Communication'), requirePhoneSetupOrg(), callGroupId, commConfigController.deleteCallGroup);

// ─── Training scenarios (read-only) ─────────────────────
router.get('/training/scenarios', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('training_tab', 'Communication'), requirePhoneSetupOrg(), commConfigController.listTrainingScenarios);
router.get('/training/scenarios/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('training_tab', 'Communication'), requirePhoneSetupOrg(), commConfigController.getTrainingScenario);

// ─── Training sessions (read-only) ──────────────────────
router.get('/training/sessions', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('training_tab', 'Communication'), requirePhoneSetupOrg(), commConfigController.listTrainingSessions);
router.get('/training/sessions/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('training_tab', 'Communication'), requirePhoneSetupOrg(), trainingSessionId, commConfigController.getTrainingSession);

export default router;
