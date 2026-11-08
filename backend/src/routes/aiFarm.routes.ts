import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireDemoOrg } from '../middleware/requireDemoOrg';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/aiFarm.controller';

const router = Router();

// All AI Farm and Spider endpoints require authenticated session (SEC-1)
router.use(authenticate);

// Spider Configuration (ARCH-1, SEC-8)
router.get('/spider/config', requireDemoOrg('spider'), ctrl.getSpiderConfig);
router.put('/spider/config', requireDemoOrg('spider'), validate(ctrl.updateSpiderConfigSchema), ctrl.updateSpiderConfig);

// Spider Logs (SEC-1, SEC-6)
router.get('/spider/logs', requireDemoOrg('spider'), ctrl.getSpiderLogs);

// Booking a call for AI agent
router.post('/bookings', validate(ctrl.bookCallSchema), ctrl.bookCall);

export default router;
