import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { requireSpider, requireSpiderAdmin } from '../middleware/requireSpider';
import * as ctrl from '../controllers/aiFarm.controller';
import * as spider from '../controllers/spider.controller';

const router = Router();

// Any authenticated org member can book a call — the AI Agentic Farm catalog is
// visible to every role, so booking isn't gated by a CASL subject.
router.use(authenticate);

router.post('/bookings', validate(ctrl.bookCallSchema), ctrl.bookCall);

// Spider lead watcher (#2619). Every path is behind the Spider gate (the `spider` feature and,
// while the launch is demo-only, a demo company): 404 otherwise. Settings, History and switching
// Spider on or off (the AI Agentic Farm's switch, PUT /spider/status) are Admin-only; reading the
// on/off status (with whether it is set up) and the unread-alerts list are open to every role.
router.get('/spider/status', requireSpider, spider.getSpiderStatus);
router.put(
  '/spider/status',
  requireSpider,
  requireSpiderAdmin,
  validate(spider.setSpiderActiveSchema),
  spider.setSpiderActive,
);
router.get('/spider/settings', requireSpider, requireSpiderAdmin, spider.getSpiderSettings);
router.put(
  '/spider/settings',
  requireSpider,
  requireSpiderAdmin,
  validate(spider.updateSpiderSettingsSchema),
  spider.updateSpiderSettings,
);
router.get('/spider/history', requireSpider, requireSpiderAdmin, spider.getSpiderHistory);
router.get('/spider/alerts/unread', requireSpider, spider.getMyUnreadSpiderAlerts);

export default router;
