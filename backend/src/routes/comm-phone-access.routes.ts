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
// Floor = `create` Communication, matching POST /calls (comm-calls.routes.ts): a
// softphone ORIGINATES calls, so operating one requires the same authority as
// placing a call through the API. The gate is the `create Communication` grant,
// not a role: the shared baseline (defaultGrants.ts) gives it to every role, so
// a user loses the device token only if that grant is withheld from them.
router.post('/phone-access', canDo('create', 'Communication'), commPhoneAccessController.createPhoneAccessToken);

export default router;
