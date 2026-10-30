import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { validate } from '../middleware/validate';
import { requirePhoneSetupOrg } from '../middleware/requirePhoneSetupOrg';
import * as commAgentsController from '../controllers/comm-agents.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// #2046: phone agents + blocked numbers are section-only config, no record-tab consumer.

// A malformed :id (non-uuid) answers the same 404 as a missing row, before Prisma runs (P2023 screen).
const agentId = requireUuidParam('id', 'Agent not found');
const blockedId = requireUuidParam('id', 'Blocked number not found');

// ─── Phone Agents ───────────────────────────────────────
router.get('/agents', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commAgentsController.listPhoneAgents);
router.get('/agents/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), agentId, commAgentsController.getPhoneAgent);

// ─── Blocked Numbers ────────────────────────────────────
// S08.16: the Blocked callers tab's switch and then the pilot-or-demo org gate, on top of the grants each route needed before.
router.get('/blocked', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('blocked_callers_tab', 'Communication'), requirePhoneSetupOrg(), commAgentsController.listBlockedNumbers);
router.post('/blocked', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), canDo('blocked_callers_tab', 'Communication'), requirePhoneSetupOrg(), validate(commAgentsController.blockNumberSchema), commAgentsController.blockNumber);
router.post('/blocked/unblock', canDo('delete', 'Communication'), canDo('access_inbox', 'Communication'), canDo('blocked_callers_tab', 'Communication'), requirePhoneSetupOrg(), validate(commAgentsController.unblockNumberSchema), commAgentsController.unblockNumber);
router.get('/blocked/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), canDo('blocked_callers_tab', 'Communication'), requirePhoneSetupOrg(), blockedId, commAgentsController.getBlockedNumber);

// '/forward-rules' moved to comm-email.routes.ts - it reads the email forward
// rules table, so it belongs to `email`, not to PRO `phone`.
// '/team-members' moved to comm-shared.routes.ts - both the email composer and
// the phone call-groups screen read it, so it belongs to neither key alone.
// Their handlers still live in comm-agents.controller.ts.

export default router;
