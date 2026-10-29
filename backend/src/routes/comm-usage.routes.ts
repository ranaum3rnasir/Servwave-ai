import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import * as controller from '../controllers/comm-usage.controller';

const router = Router();

// Path-scoped rather than a bare router.use: every comm router shares the
// /api/communication base, so an unscoped gate here would also fire on
// fall-through traffic destined for a sibling router (CLAUDE.md — a stray
// phone gate 402s an org that owns the feature it was actually asking for).
router.use('/usage', authenticate, requireFeature('phone'), attachAbility);

// #2046: the usage meter is a section-only surface (the Phone header inside /communication),
// so it also requires access_inbox.
router.get('/usage', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), controller.getUsage);

export default router;
