import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { ingestCall, ingestSms, ingestSmsStatus, isOutboundTextActivity, unwrapActivity } from '../lib/ctm/ingest';
import { ingestRecording } from '../lib/ctm/recordings';
import { warmReceivingNumbers } from '../lib/ctm/receivingNumbers';
import { syncIfUnknownNumber } from '../lib/ctm/unknownNumberSync';
import { rawBodyString, timingSafeEqualStr } from '../lib/webhooks/shared';

/**
 * CTM webhook endpoint — POST /api/webhooks/ctm/:position?token=<CTM_WEBHOOK_TOKEN>
 *
 * Mounted beside the Stripe webhook under /api/webhooks, so it inherits
 * `unscopedRequest` (app.ts) — that per-transaction RLS bypass is what
 * authorizes cross-org writes here; the owning org is resolved from the
 * payload's account_id against organizations.ctm_account_id.
 *
 * AUTH — three gates, strongest-available wins:
 *  1. Query token (primary): timing-safe compare against CTM_WEBHOOK_TOKEN.
 *     FAIL-CLOSED: token unset/empty → 401 for EVERY request. (Deliberately the
 *     opposite of originVerify's fail-open — this token is the only auth on an
 *     originVerify-exempt, rate-limiter-exempt route.)
 *  2. X-CTM-Signature (optional second gate): base64(HMAC-SHA1(signing_secret,
 *     X-CTM-Time + raw_body)) per CTM's KB. Enforced only when the headers are
 *     present AND CTM_WEBHOOK_SIGNING_SECRET is configured — a DEDICATED secret,
 *     NOT the CTM_SECRET_KEY API secret. CTM signs sub-account webhooks with a
 *     different secret than the API key, so reusing the API secret here rejects
 *     every real webhook (401 storm, Northwind Services 500001, 2026-07-13). Unset by
 *     default → gate skipped, token (gate 1) is the sole auth (Phase-0 posture).
 *  3. Basic auth (defense-in-depth): we provision hooks with
 *     username 'servwave' / password = webhook token; verified when present.
 */

// Positions we ACCEPT (see the master plan §1 + v3.1 addendum §A.3). This is a
// superset of what organization-ctm.controller provisions: accepting a position
// costs nothing, so a hook CTM starts firing later is ingested rather than 404'd.
// `start_outbound` is tolerated as an alias of `starts` — CTM's documented
// trigger list has only `starts` for both directions; P4b settles which fires.
//
// `outbound_text` is kept here but NO LONGER PROVISIONED: measured live
// 2026-08-01, it was registered on both connected accounts and fired zero times
// in 21 days, while `status_change` delivered every outbound text instead.
const CALL_POSITIONS = new Set(['starts', 'start_outbound', 'end']);
const SMS_POSITIONS = new Set(['inbound_text', 'outbound_text']);
const STATUS_POSITIONS = new Set(['sms_status', 'status_change']);

function isKnownPosition(position: string): boolean {
  return CALL_POSITIONS.has(position) || SMS_POSITIONS.has(position) || STATUS_POSITIONS.has(position);
}

class DuplicateCtmEventError extends Error {
  constructor() {
    super('Phone system webhook event already processed (concurrent duplicate)');
    this.name = 'DuplicateCtmEventError';
  }
}

export async function handleCtmWebhook(req: Request, res: Response) {
  // Gate 1 — query token, fail closed.
  const expected = env.CTM_WEBHOOK_TOKEN;
  if (!expected) {
    logger.warn('[ctm-webhook] CTM_WEBHOOK_TOKEN is not set — rejecting all webhook traffic (fail closed)');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const provided = typeof req.query.token === 'string' ? req.query.token : '';
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const position = String(req.params.position ?? '');
  if (!isKnownPosition(position)) {
    res.status(404).json({ error: 'Unknown webhook position' });
    return;
  }

  const rawBody = rawBodyString(req);

  // Gate 2 — HMAC signature, enforced only when CTM sends the headers.
  const signature = req.header('X-CTM-Signature');
  const signedTime = req.header('X-CTM-Time');
  if (signature && signedTime && env.CTM_WEBHOOK_SIGNING_SECRET) {
    const computed = crypto
      .createHmac('sha1', env.CTM_WEBHOOK_SIGNING_SECRET)
      .update(signedTime + rawBody)
      .digest('base64');
    if (!timingSafeEqualStr(signature.trim(), computed.trim())) {
      logger.warn('[ctm-webhook] X-CTM-Signature mismatch — rejected');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  // Gate 3 — Basic auth we set at hook-provision time, verified when present.
  const basic = req.header('authorization');
  if (basic?.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
    const [, password = ''] = decoded.split(':');
    if (!timingSafeEqualStr(password, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }

  await processCtmEvent(position, payload, res);
}

export async function resolveOrgFromCtmAccount(
  payload: Record<string, unknown>,
): Promise<{ id: string; ctm_account_id: string | null } | null> {
  const activity = unwrapActivity(payload as Record<string, any>);
  const accountId = activity.account_id ?? (payload as Record<string, any>).account_id;
  if (accountId === undefined || accountId === null || accountId === '') return null;
  // ctm_account_id is selected back out for the post-response recording fetch
  // (getRecordingResponse needs the sub-account id, never payload data).
  return prisma.organization.findFirst({
    where: { ctm_account_id: String(accountId) },
    select: { id: true, ctm_account_id: true },
  });
}

/**
 * Post-auth processing — idempotency + org resolution + ingest dispatch.
 * Mirrors processStripeEvent: pre-check → claim-first transaction (P2002 =
 * concurrent duplicate) → 200 fast. DB failures surface as 500 so CTM's retry
 * and the backfill script re-deliver.
 *
 * `options.syncUnknownNumbers` (default true) controls the post-response
 * number sync for a call or text on a number the org does not have. The
 * unauthenticated E2E test door passes false: a test event must never make the
 * server read or write the phone system.
 */
export async function processCtmEvent(
  position: string,
  payload: Record<string, unknown>,
  res: Response,
  options: { syncUnknownNumbers?: boolean } = {},
) {
  const activity = unwrapActivity(payload as Record<string, any>);
  const sid = String(activity.sid ?? activity.message_id ?? activity.id ?? '');
  if (!sid) {
    // Unidentifiable payload: acknowledge (nothing to dedupe or ingest).
    logger.warn(`[ctm-webhook] ${position} payload without sid/id — acknowledged, not stored`);
    res.json({ received: true, ignored: 'no_sid' });
    return;
  }
  const dedupeKey = `${sid}:${position === 'start_outbound' ? 'starts' : position}`;

  // Idempotency pre-check (fast path for CTM redeliveries).
  const existingEvent = await prisma.ctmEvent.findUnique({ where: { ctm_event_id: dedupeKey } });
  if (existingEvent) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    const owningOrg = await resolveOrgFromCtmAccount(payload);
    if (!owningOrg) {
      // Unknown/unconnected account: record + 200 so CTM stops retrying.
      logger.warn(`[ctm-webhook] event for unknown CTM account (position=${position}) — recorded, ignored`);
      await prisma.ctmEvent.create({
        data: { ctm_event_id: dedupeKey, event_type: position, payload: payload as object },
      });
      res.json({ received: true });
      return;
    }

    // A forwarded call names nobody in its payload - only a receiving_number_id
    // that CTM's roster can resolve. Warm that roster HERE, before the
    // transaction opens: doing it inside would hold a database transaction open
    // across an HTTP call, and Prisma's 5s interactive-transaction timeout would
    // turn one slow CTM response into a lost call record. Cached with a TTL and
    // fail-open, so this is at most a handful of requests an hour and never
    // throws. Skipped when the payload already names its agent (nothing to
    // resolve) or carries no receiving number at all.
    if (
      CALL_POSITIONS.has(position) &&
      owningOrg.ctm_account_id &&
      !activity.agent &&
      activity.receiving_number_id !== undefined &&
      activity.receiving_number_id !== null
    ) {
      await warmReceivingNumbers(owningOrg.ctm_account_id);
    }

    // The transaction returns the call-ingest result (null on SMS/status paths)
    // so the post-response recording fetch can be scheduled outside of it.
    const callResult = await prisma.$transaction(async (tx) => {
      // FIRST — atomic idempotency claim; P2002 = concurrent duplicate.
      try {
        await tx.ctmEvent.create({
          data: { ctm_event_id: dedupeKey, event_type: position, payload: payload as object },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') throw new DuplicateCtmEventError();
        throw err;
      }

      if (CALL_POSITIONS.has(position)) {
        const normalized = position === 'start_outbound' ? 'starts' : position;
        return ingestCall(tx, owningOrg.id, payload as Record<string, any>, normalized, {
          ctmAccountId: owningOrg.ctm_account_id ?? undefined,
        });
      }
      // A text-shaped `status_change` IS an outbound-text event and must run the
      // full SMS ingest, not the lean delta path. Live evidence (staging,
      // 2026-08-01): all 12 stored `status_change` events are
      // `direction: msg_outbound` carrying message_id + message_body + a
      // sent|delivered state, while `outbound_text` - the hook this was supposed
      // to arrive on - has never fired. Only ingestSms can create the row or
      // reconcile the sid onto a sid-less local one, which matters because 42 of
      // 58 message rows hold no sid for ingestSmsStatus to key on.
      if (SMS_POSITIONS.has(position) || isOutboundTextActivity(activity)) {
        await ingestSms(tx, owningOrg.id, payload as Record<string, any>);
      } else {
        // status_change carries no transcript data for calls (SMS delivery
        // status only — message_body/sms_error_code) — it is never a signal
        // that async transcription finished, confirmed via a live ctm_events
        // probe (t4, 2026-07-22). Transcripts are hydrated on demand instead
        // (getCallTranscript).
        await ingestSmsStatus(tx, owningOrg.id, payload as Record<string, any>);
      }
      return null;
    });

    res.json({ received: true });

    // Recording fetch AFTER the 200 — never delays CTM's webhook response.
    // ingestRecording never throws (terminal failures warn + leave the key
    // null), and the account id comes from OUR org row, not the payload.
    if (callResult?.hasRecording && owningOrg.ctm_account_id) {
      const recordingArgs = {
        orgId: owningOrg.id,
        callSessionId: callResult.callSessionId,
        ctmAccountId: owningOrg.ctm_account_id,
        callSid: callResult.sid,
      };
      setImmediate(() => {
        void ingestRecording(recordingArgs);
      });
    }

    // A call or inbound text on a number the org does not have stored yet: the
    // phone system sends no "number added" event, so this is how a number moved
    // onto the account reaches ServWave without anyone pressing Sync. AFTER the
    // 200 and outside the ingest transaction, like the recording fetch above:
    // a sync reads the whole number list and can switch texting on, which is
    // far too slow for CTM's webhook timeout or a database transaction.
    // syncIfUnknownNumber never rejects and goes through the per-org throttle,
    // so a burst of calls on a new number reads the phone system once.
    if (
      options.syncUnknownNumbers !== false &&
      (CALL_POSITIONS.has(position) || position === 'inbound_text') &&
      owningOrg.ctm_account_id
    ) {
      const unknownNumberArgs = {
        orgId: owningOrg.id,
        accountId: owningOrg.ctm_account_id,
        trackingNumber: activity.tracking_number,
      };
      setImmediate(() => {
        void syncIfUnknownNumber(unknownNumberArgs);
      });
    }
  } catch (err) {
    if (err instanceof DuplicateCtmEventError) {
      res.json({ received: true, duplicate: true });
      return;
    }
    // Log the position + sid + error MESSAGE only — payloads hold phone
    // numbers and SMS bodies, and Prisma errors can embed query args.
    logger.error(
      `[ctm-webhook] processing failed (position=${position}, sid=${sid}): ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
