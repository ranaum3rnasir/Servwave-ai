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
// on/off status (with whether it is set up), the unread-alerts list and one's own starting summary
// are open to every role.
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
router.get('/spider/history/summary', requireSpider, requireSpiderAdmin, spider.getSpiderHistorySummary);
router.get('/spider/history/filters', requireSpider, requireSpiderAdmin, spider.getSpiderHistoryFilters);
router.get('/spider/history/export', requireSpider, requireSpiderAdmin, spider.exportSpiderHistory);
// The same two reads with the toolbar in the body: a long list of ticked customers or people.
router.post('/spider/history/search', requireSpider, requireSpiderAdmin, spider.getSpiderHistory);
router.post('/spider/history/export', requireSpider, requireSpiderAdmin, spider.exportSpiderHistory);
router.get('/spider/alerts/unread', requireSpider, spider.getMyUnreadSpiderAlerts);
// The starting summary (#2794): one's own for every role, the whole company's for Admins.
router.get('/spider/summary', requireSpider, spider.getMySpiderSummary);
router.get('/spider/summary/company', requireSpider, requireSpiderAdmin, spider.getCompanySpiderSummary);

export default router;
