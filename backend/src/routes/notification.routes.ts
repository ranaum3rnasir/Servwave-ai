import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/notification.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Static routes BEFORE /:id catch-all.
router.get('/unread-count', canDo('read', 'Notification'), ctrl.unreadCount);
router.patch('/seen', canDo('update', 'Notification'), validate(ctrl.seenSchema), ctrl.markSeen);
router.post('/read-all', canDo('update', 'Notification'), ctrl.readAll);

router.get('/', canDo('read', 'Notification'), ctrl.list);
router.patch('/:id/read', canDo('update', 'Notification'), ctrl.markRead);
router.patch('/:id/act', canDo('update', 'Notification'), ctrl.act);
router.patch('/:id/dismiss', canDo('delete', 'Notification'), ctrl.dismiss);

export default router;
