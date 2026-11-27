import express, { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireBee, requireBeeAdmin } from '../middleware/requireBee';
import { beeWebhookAuth } from '../middleware/beeWebhookAuth';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/bee.controller';

const router = Router();

// Middleware to parse string body if Postman sends with Content-Type: text/plain
function normalizeWebhookBody(req: Request, _res: Response, next: NextFunction) {
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      // ignore parse error and let Zod validate
    }
  }
  next();
}

// Inbound Webhook (Postman Testing / Telephony Delivery / Vapi end-of-call-report)
// Handles both Bearer JWT and direct webhook testing with tenant resolution & feature check
router.post(
  '/webhook',
  express.json({ limit: '5mb', type: ['application/json', 'text/*'] }),
  normalizeWebhookBody,
  beeWebhookAuth,
  (req: Request, res: Response, next: NextFunction) => {
    // If payload is a native Voice Engine / Vapi webhook envelope (`{ message: { type: 'end-of-call-report', ... } }`),
    // route directly to Stage 1 Voice Engine webhook handler
    if (
      req.body &&
      typeof req.body === 'object' &&
      (req.body.message || req.body.artifact)
    ) {
      return ctrl.receiveVoiceEngineWebhook(req, res);
    }
    return validate(ctrl.beeWebhookSchema)(req, res, next);
  },
  ctrl.receiveBeeWebhook
);

// Dedicated Voice Calling Engine Webhook endpoint (Vapi / Cascade / Speech-to-Speech)
router.post(
  '/webhooks/voice-engine',
  express.json({ limit: '5mb', type: ['application/json', 'text/*'] }),
  normalizeWebhookBody,
  beeWebhookAuth,
  ctrl.receiveVoiceEngineWebhook
);

// All other Bee endpoints require authenticated user session and Bee access
router.use(authenticate);
router.use(requireBee);

// 1. Home / Status / Metrics
router.get('/status', ctrl.getBeeStatus);
router.get('/activation-preview', requireBeeAdmin, ctrl.getBeeActivationPreview);
router.put('/status', requireBeeAdmin, validate(ctrl.setBeeActiveSchema), ctrl.setBeeActive);
router.get('/metrics', ctrl.getBeeMetrics);
router.post('/toggle-status', requireBeeAdmin, validate(ctrl.toggleStatusSchema), ctrl.toggleBeeStatus);

// 2. Call Logs
router.get('/calls', ctrl.getBeeCallLogs);
router.post('/calls/sync', requireBeeAdmin, ctrl.syncBeeCallLogs);
router.get('/calls/:id', ctrl.getBeeCallDetail);
router.patch('/calls/:id', requireBeeAdmin, ctrl.updateBeeCallOutcome);
router.post('/calls/:id/classify', requireBeeAdmin, ctrl.classifyBeeCallStageTwo);
router.patch('/calls/:id/task', requireBeeAdmin, ctrl.linkBeeCallTask);

// 3. Queue
router.get('/queue', ctrl.getBeeQueue);
router.post('/queue/call-now', requireBeeAdmin, ctrl.triggerCallNow);
router.post('/queue/skip', requireBeeAdmin, ctrl.skipQueueItem);
router.patch('/queue/:id/reschedule', requireBeeAdmin, ctrl.rescheduleBeeQueueItem);
router.post('/queue/reschedule', requireBeeAdmin, ctrl.rescheduleBeeQueueItem);

// 4. Agents
router.get('/agents', ctrl.getBeeAgents);
router.get('/sample-jobs', ctrl.getBeeSampleJobs);
router.post('/agents', requireBeeAdmin, validate(ctrl.createBeeAgentSchema), ctrl.createBeeAgent);
router.put('/agents/:id', requireBeeAdmin, ctrl.updateBeeAgent);
router.delete('/agents/:id', requireBeeAdmin, ctrl.deleteBeeAgent);
router.post('/agents/test-call', requireBeeAdmin, ctrl.triggerTestCall);

// 5. Warranty Plans
router.get('/plans', ctrl.getBeePlans);
router.post('/plans', requireBeeAdmin, validate(ctrl.createBeePlanSchema), ctrl.createBeePlan);
router.put('/plans/:id', requireBeeAdmin, ctrl.updateBeePlan);
router.delete('/plans/:id', requireBeeAdmin, ctrl.deleteBeePlan);
router.get('/job-type-warranties', ctrl.getJobTypeWarranties);
router.put('/job-type-warranties', requireBeeAdmin, ctrl.updateJobTypeWarranties);
router.post('/warranties/sync', requireBeeAdmin, ctrl.syncBeeWarranties);

// 6. Do Not Call (DNC)
router.get('/dnc', ctrl.getBeeDnc);
router.post('/dnc', requireBeeAdmin, validate(ctrl.createBeeDncSchema), ctrl.createBeeDnc);
router.delete('/dnc/:id', requireBeeAdmin, ctrl.deleteBeeDnc);

// 7. Setup & Settings
router.get('/settings', requireBeeAdmin, ctrl.getBeeSettings);
router.put('/settings', requireBeeAdmin, ctrl.updateBeeSettings);

// 8. Bee Phone System (Dedicated Telephony)
router.get('/phone-numbers', ctrl.getBeePhoneNumbers);
router.post('/phone-numbers/buy', requireBeeAdmin, ctrl.buyBeePhoneNumber);
router.delete('/phone-numbers/:id', requireBeeAdmin, ctrl.releaseBeePhoneNumber);

export default router;



