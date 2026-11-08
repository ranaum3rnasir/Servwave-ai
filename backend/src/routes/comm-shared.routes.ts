import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import * as commController from '../controllers/comm-whatsapp-email.controller';
import * as commAgentsController from '../controllers/comm-agents.controller';

const router = Router();

const SHARED_PREFIXES = ['/unread-counts', '/team-members'];

/**
 * Communication endpoints that belong to no single feature, deliberately WITHOUT
 * a requireFeature gate. Authentication and CASL still apply - only the plan
 * axis is absent, because no single plan key is right for them.
 *
 * - /unread-counts returns one payload spanning three channels: sms and whatsapp
 *   belong to PRO `phone`, email to STARTER `email`. Gating the route on either
 *   key would blank the other module's badge for an org that pays for it, so the
 *   entitlement decision moves INTO the controller: it reports 0 for a channel
 *   the org lacks and skips that channel's query entirely (see getUnreadCounts).
 * - /team-members is the org's own user directory reshaped for the messaging
 *   surfaces. The email composer (emailing a teammate or a group) and the phone
 *   call-groups screen both read it, so gating it on either key breaks the other.
 *   It exposes nothing a member cannot already see - technicians hold org-wide
 *   `read User` by default.
 *
 * Path-scoped like its sibling comm-* routers so it cannot intercept traffic for
 * routes it does not own on the shared /api/communication base.
 */
router.use(SHARED_PREFIXES, authenticate, attachAbility);

// #2046: both are the section's own badge/directory surfaces (frozen: repro-2046.test.ts).
router.get('/unread-counts', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.getUnreadCounts);
router.get('/team-members', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commAgentsController.listTeamMembers);

// Terminate this router's own prefixes - see comm-email.routes.ts for why an
// unmatched path must not walk the mount chain into a foreign entitlement gate.
router.all([...SHARED_PREFIXES, '/unread-counts/*', '/team-members/*'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default router;
