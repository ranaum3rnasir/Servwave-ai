import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { runUnscoped } from '../lib/tenant-context';
import { rawBodyString, timingSafeEqualStr } from '../lib/webhooks/shared';
import { isCallTrackingProvider, parseTrackedCallEvent } from '../lib/call-tracking/adapters';
import { processTrackedCallEvent } from '../lib/call-tracking/process';

/**
 * External call-tracking receiver —
 *   POST /api/webhooks/call-tracking/:provider/:urlToken/:phase?
 *
 * A customer whose tracking numbers stay with an outside vendor (CallRail today,
 * WhatConverts next) has the vendor push each call's marketing session here.
 * Plan: md_files/plans/communication/2026-09-10-external-call-tracking-webhook-receiver.md.
 *
 * Mounted beside the phone-system webhook under /api/webhooks, so it inherits
 * `unscopedRequest`; the owning org is resolved from the URL token.
 *
 * Gates, in order, each fail-closed:
 *  1. `:provider` is a known provider              → else 404
 *  2. `:urlToken` resolves an ENABLED row for it   → else 404 (identical for
 *     unknown and disabled, so the token space cannot be probed)
 *  3. CallRail only: `Signature` header equals base64(HMAC-SHA1(signing_key,
 *     raw body)). A CallRail row with no key rejects everything: the key is
 *     mandatory for that provider. WhatConverts signs nothing; its 32-byte
 *     token is the only gate, and is revocable per org.
 *  4. Body parses and the adapter recognises it    → else 202 + warn. Never a
 *     4xx here: CallRail auto-disables the integration after repeated non-2xx
 *     and does not retry, so a malformed body must not cost us the hook.
 *
 * The 200 goes out BEFORE any processing; the work runs fire-and-forget with
 * its own try/catch, the same posture as the phone-system receiver's post-ack
 * recording fetch.
 */

const PHASES = new Set(['pre', 'post']);

export async function handleCallTrackingWebhook(req: Request, res: Response) {
  const provider = String(req.params.provider ?? '');
  if (!isCallTrackingProvider(provider)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const urlToken = String(req.params.urlToken ?? '');
  if (!urlToken || urlToken.length > 128) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const integration = await prisma.callTrackingIntegration.findFirst({
    where: { url_token: urlToken, provider, enabled: true },
    select: { id: true, organization_id: true, signing_key: true },
  });
  if (!integration) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const rawBody = rawBodyString(req);

  if (provider === 'callrail') {
    if (!integration.signing_key) {
      logger.warn('[call-tracking] integration has no signing key — rejecting (fail closed)');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const provided = req.get('Signature') ?? '';
    const expected = crypto.createHmac('sha1', integration.signing_key).update(rawBody).digest('base64');
    if (!provided || !timingSafeEqualStr(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    logger.warn(`[call-tracking] malformed body (provider=${provider}) — acked, ignored`);
    res.status(202).json({ received: true, ignored: 'malformed' });
    return;
  }

  const phaseParam = String(req.params.phase ?? '');
  const phase = PHASES.has(phaseParam) ? (phaseParam as 'pre' | 'post') : undefined;
  const event = parseTrackedCallEvent(provider, body, phase);
  if (!event) {
    logger.warn(`[call-tracking] unrecognised payload (provider=${provider}) — acked, ignored`);
    res.status(202).json({ received: true, ignored: 'unrecognised' });
    return;
  }

  res.json({ received: true });

  // Everything below runs after the ack. Log the vendor call id + error message
  // only — payloads hold phone numbers.
  const orgId = integration.organization_id;
  const integrationId = integration.id;
  setImmediate(() => {
    void runUnscoped(async () => {
      try {
        await prisma.callTrackingIntegration.update({
          where: { id: integrationId },
          data: { last_event_at: new Date() },
        });
        await processTrackedCallEvent(prisma, orgId, event);
      } catch (err) {
        logger.error(
          `[call-tracking] processing failed (provider=${provider}, phase=${event.phase}, vendor_call_id=${event.vendorCallId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  });
}
