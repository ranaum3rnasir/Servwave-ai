import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { requireDemoOrg } from '../middleware/requireDemoOrg';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import * as commController from '../controllers/comm-whatsapp-email.controller';

const router = Router();

/**
 * WhatsApp ships LOCKED: PRO `phone` gets you the module, but only the demo org
 * may reach these routes at all. No WhatsApp Business connection model exists in
 * schema.prisma, so for a real org the surface has nothing behind it (the
 * controller's own send path already 409s WHATSAPP_NOT_CONNECTED for a non-demo
 * org - this closes the read paths too, before any query runs).
 *
 * Path-scoped for the same reason as comm-email.routes.ts: a bare router.use()
 * on a shared mount base would 404 every other comm route for a real org.
 * '/whatsapp' covers '/whatsapp/:id'; '/whatsapp-chats' is a separate segment.
 */
const WHATSAPP_PREFIXES = ['/whatsapp', '/whatsapp-chats'];

router.use(
  WHATSAPP_PREFIXES,
  authenticate,
  requireFeature('phone'),
  requireDemoOrg('whatsapp'),
  attachAbility,
);

// ─── WhatsApp ───────────────────────────────────────────
// #2046: WhatsApp ships demo-org-only and has no record-tab consumer - the whole surface is the
// section, so all four routes get the second gate.
router.get('/whatsapp', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listWhatsAppChats);
router.post('/whatsapp', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.sendWhatsAppSchema), commController.sendWhatsApp);
router.get('/whatsapp/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.getWhatsAppChat);
// #2049 slice 2 - the WhatsApp mirror of comm-threads.routes.ts's thread
// read-state routes. Read-side rights only (never `update`), but
// `access_inbox` stays on both - WhatsApp is section-only (R10), unlike SMS's
// `read`-alone gate. `requireUuidParam` answers the same non-disclosing
// `{"error":"Chat not found"}` a malformed :id would otherwise 500 on.
const chatId = requireUuidParam('id', 'Chat not found');
router.patch('/whatsapp/:id/read', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), chatId, commController.markWhatsAppChatRead);
router.patch('/whatsapp/:id/unread', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), chatId, commController.markWhatsAppChatUnread);
router.post('/whatsapp-chats', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.createWhatsAppChatSchema), commController.createWhatsAppChat);

// Terminate this router's own prefixes - see the same guard in
// comm-email.routes.ts for why an unmatched path must not walk the mount chain
// into a foreign entitlement gate.
router.all([...WHATSAPP_PREFIXES, '/whatsapp/*', '/whatsapp-chats/*'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default router;
