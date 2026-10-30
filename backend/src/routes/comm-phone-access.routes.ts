import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import * as commPhoneAccessController from '../controllers/comm-phone-access.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// Mint a short-lived per-agent CTM softphone token. The embedded WebRTC device
// authenticates with this; the agency Access/Secret keys never reach the browser.
// Two checks: `create Communication` (Contact customers), because a softphone ORIGINATES calls and so needs the same
// authority as placing a call through the API (comm-calls.routes.ts), and `use_browser_phone` (the "Office phone in the
// browser" switch). Both are switches, never a role name: a person without the second keeps the field path, where the
// phone service rings their own phone first.
router.post(
  '/phone-access',
  canDo('create', 'Communication'),
  canDo('use_browser_phone', 'Communication'),
  commPhoneAccessController.createPhoneAccessToken,
);

export default router;
