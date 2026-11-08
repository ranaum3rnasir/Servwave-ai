import { Router } from 'express';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';
import * as webhookController from '../controllers/webhook.controller';
import * as ctmWebhookController from '../controllers/ctm-webhook.controller';
import * as resendWebhookController from '../controllers/resend-webhook.controller';
import * as callTrackingWebhookController from '../controllers/call-tracking-webhook.controller';
import * as webFormWebhookController from '../controllers/web-form-webhook.controller';

const router = Router();

// Stripe requires raw body for signature verification
router.post('/stripe', express.raw({ type: 'application/json' }), webhookController.handleStripeWebhook);
// CTM sends JSON with drifting content-types; raw body is kept for the
// X-CTM-Signature HMAC (verified over the exact bytes).
router.post('/ctm/:position', express.raw({ type: '*/*' }), ctmWebhookController.handleCtmWebhook);
// Email slice 4 — Resend delivery webhook (email.sent/delivered/bounced/…).
// Raw body kept for resend.webhooks.verify()'s svix-based signature check.
router.post('/resend', express.raw({ type: 'application/json' }), resendWebhookController.handleResendWebhook);
// External call-tracking vendors (CallRail, WhatConverts) push call sessions
// here; the org is resolved from the URL token. Raw body kept for CallRail's
// `Signature` HMAC over the exact bytes. `:phase` is optional (pre|post).
router.post(
  '/call-tracking/:provider/:urlToken/:phase?',
  express.raw({ type: '*/*' }),
  callTrackingWebhookController.handleCallTrackingWebhook,
);
/**
 * The web-form receiver's body ceiling, stated rather than inherited.
 *
 * /api/webhooks mounts at app.ts:103, TWELVE LINES BEFORE the app-level
 * `express.json({ limit: '1mb' })` at :115, so this route never saw that
 * ceiling and silently ran on body-parser's 100KB default - tighter than every
 * other route in the app, with nothing saying so. 1mb matches what the rest of
 * the app already allows an unauthenticated caller to buffer, so this is the
 * app's own ceiling written down, not a new exposure.
 */
const WEB_FORM_BODY_LIMIT = '1mb';

/**
 * Turn a body-parser failure on the WEB-FORM ROUTE ONLY into an ack.
 *
 * Four arguments, placed inside this one route's middleware chain: Express runs
 * a 4-arity layer only when an error is already in flight and skips it
 * otherwise, so the sole thing that can reach it is a failure of the raw parser
 * directly above - too large, a Content-Encoding that lies, a stream that died
 * mid-body. Everything else on this router is untouched.
 *
 * Deliberately NOT router-wide. The Stripe, phone-system and email receivers
 * share this file and their vendors all retry, so the 500 app.ts's terminal
 * handler gives them is the CORRECT answer: it makes the delivery come back.
 * This vendor has no retries, so the same 500 destroys the lead instead.
 */
function ackUnreadableWebFormBody(err: Error, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  const type = (err as { type?: string }).type ?? 'unknown';
  logger.warn(`[web-form] delivery could not be read (${type}) — acked, ignored`);
  res.status(202).json({ received: true, ignored: 'unreadable' });
}

// A customer's website form plugin posts each submission here; the org is
// resolved from the URL token, which is the ONLY gate this vendor allows (it
// signs nothing). Raw body kept for the same reason as the receivers above —
// the plugin's content-type is not ours to rely on.
router.post(
  '/web-form/:provider/:urlToken',
  express.raw({ type: '*/*', limit: WEB_FORM_BODY_LIMIT }),
  ackUnreadableWebFormBody,
  webFormWebhookController.handleWebFormWebhook,
);

export default router;
