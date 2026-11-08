import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { logAudit } from '../audit';
import { CtmApiError, isCtmConfigured, isOptedOut, isOutboundAllowed, sendSms } from './client';
import { resolveOutboundNumber } from '../communication/resolveOutboundNumber';
import { hasFeature } from '../entitlements/resolve';

/**
 * The ONE shared outbound-SMS delivery path (master plan §4, slice 6).
 *
 * Both send seams — comm-threads.controller `sendMessage` (user sends) and
 * services/automations/smsRecord (automation sends) — call `sendCtmSms` after
 * their Message row exists. The gates run in compliance order:
 *
 *   connected → sms_ready (A2P) → from-number → fresh opt-out → double-fire
 *
 * NOT_CONNECTED is a silent no-op as far as CTM is concerned: until CTM is
 * wired, the record IS the product (smsRecord.ts's documented seam).
 * `sendCtmSms` NEVER throws.
 *
 * STATUS HONESTY (SERV10X-77 prerequisite). Every exit from this function
 * settles the Message row, because a row that still reads `sent` is a claim
 * nobody made:
 *
 *   gate failure  -> status 'skipped', status_reason = the typed reason
 *   send error    -> status 'failed',  status_reason = 'CTM_ERROR'
 *   CTM accepted  -> status 'sent',    status_reason cleared
 *
 * `sent` here means only "CTM accepted the POST". The carrier's own
 * confirmation arrives later as a `status_change` webhook and promotes the row
 * to `delivered` (lib/ctm/ingest.ts). Callers create their row `queued`.
 *
 * `precheckCtmSms` runs the same gates WITHOUT sending, arming the double-fire
 * guard, or touching any row, so `sendMessage` can 409 a blocked user send
 * BEFORE creating the local row (automations skip it - they never 409).
 */

type Db = Prisma.TransactionClient | PrismaClient;

export type CtmSmsFailureReason =
  | 'NOT_CONNECTED'
  | 'SMS_NOT_READY'
  | 'ORG_SMS_DISABLED'
  | 'NOT_ENTITLED'
  | 'NO_SMS_NUMBER'
  | 'NOT_IN_TEST_ALLOWLIST'
  | 'RECIPIENT_OPTED_OUT'
  | 'DUPLICATE_SEND'
  | 'CTM_ERROR';

export type CtmSmsSendResult =
  | { delivered: true }
  | { delivered: false; reason: CtmSmsFailureReason };

export type CtmSmsPrecheckResult = { ok: true } | { ok: false; reason: CtmSmsFailureReason };

export interface CtmSmsPrecheckParams {
  orgId: string;
  /** Destination in E.164 where resolvable; null → NO_SMS_NUMBER. */
  toE164: string | null;
  threadId: string;
  body: string;
  /** The sending user, for per-user caller-ID resolution. Omitted for system
   *  sends (automations) → resolution starts at the org default. */
  userId?: string;
}

export interface CtmSmsSendParams extends CtmSmsPrecheckParams {
  toE164: string;
  /** The already-created Message row this delivery belongs to. */
  messageId: string;
}

// ─── In-process double-fire guard ────────────────────────────────────────────
// An identical (orgId, threadId, body) within 15s is a duplicate (double-click,
// double-fired automation). Best-effort per process — plan §10 accepts this at
// current scale.

const DOUBLE_FIRE_WINDOW_MS = 15_000;
const recentSends = new Map<string, number>();

function doubleFireKey(orgId: string, threadId: string, body: string): string {
  return `${orgId}\u0000${threadId}\u0000${body}`;
}

function isDoubleFire(key: string): boolean {
  const now = Date.now();
  for (const [k, ts] of recentSends) {
    if (now - ts > DOUBLE_FIRE_WINDOW_MS) recentSends.delete(k);
  }
  const last = recentSends.get(key);
  return last !== undefined && now - last <= DOUBLE_FIRE_WINDOW_MS;
}

/** Test-only: clears the in-process double-fire guard between specs. */
export function _resetCtmSmsDoubleFireGuard(): void {
  recentSends.clear();
}

// ─── Shared gate runner ──────────────────────────────────────────────────────

interface GatePass {
  ok: true;
  accountId: string;
  fromTpnId: string;
}
type GateOutcome = GatePass | { ok: false; reason: CtmSmsFailureReason };

async function runGates(db: Db, params: CtmSmsPrecheckParams): Promise<GateOutcome> {
  // Platform keys unset = nothing is connected anywhere. Checked first so the
  // path is a pure no-op (no DB reads) on unconfigured environments.
  if (!isCtmConfigured()) return { ok: false, reason: 'NOT_CONNECTED' };

  const org = await db.organization.findUnique({
    where: { id: params.orgId },
    select: {
      ctm_account_id: true,
      ctm_sms_ready: true,
      sms_sending_enabled: true,
      plan: true,
      trial_ends_at: true,
      feature_overrides: true,
    },
  });
  if (!org?.ctm_account_id) return { ok: false, reason: 'NOT_CONNECTED' };
  if (!org.ctm_sms_ready) return { ok: false, reason: 'SMS_NOT_READY' };
  if (!org.sms_sending_enabled) return { ok: false, reason: 'ORG_SMS_DISABLED' };

  // ADR 0001's class, one feature over: this path is reached from the minute
  // poller / dispatchAutomationEvent, never a request, so requireFeature('phone')
  // on comm-threads.routes.ts never applies to it. Fail closed here — the org
  // may never have turned Communication on (off by default for every org) or
  // may have downgraded off PRO after connecting CTM.
  const entitlementSource = {
    plan: org.plan,
    trial_ends_at: org.trial_ends_at,
    feature_overrides: org.feature_overrides as Record<string, unknown> | null,
  };
  if (!hasFeature(entitlementSource, 'phone')) return { ok: false, reason: 'NOT_ENTITLED' };

  // From-number caller ID (resolveOutboundNumber, slice 2): the sender's per-user
  // default → org default → legacy oldest-active, restricted to sms_enabled
  // numbers. The thread's most recent outbound TPN would be ideal, but Message
  // rows don't store the sending TPN (not derivable today). `from` is the CTM
  // "TPN…" id.
  const resolved = await resolveOutboundNumber(db, {
    orgId: params.orgId,
    userId: params.userId,
    requireSms: true,
  });
  // No usable from-number, or no resolvable destination — either way there is
  // no number to text with/to.
  if (!resolved || !params.toE164) {
    return { ok: false, reason: 'NO_SMS_NUMBER' };
  }

  // Phase-0 test guard: refuse any destination not on CTM_OUTBOUND_ALLOWLIST
  // BEFORE hitting CTM's opt-out API — a blocked number never reaches CTM at
  // all. Inert (always allows) when the allowlist env var is unset.
  if (!isOutboundAllowed(params.toE164)) {
    return { ok: false, reason: 'NOT_IN_TEST_ALLOWLIST' };
  }

  // Fresh per-send compliance check — never cached (client.ts contract).
  if (await isOptedOut(org.ctm_account_id, params.toE164)) {
    return { ok: false, reason: 'RECIPIENT_OPTED_OUT' };
  }

  if (isDoubleFire(doubleFireKey(params.orgId, params.threadId, params.body))) {
    return { ok: false, reason: 'DUPLICATE_SEND' };
  }

  return { ok: true, accountId: org.ctm_account_id, fromTpnId: resolved.ctm_number_id };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the delivery gates without sending — never throws, never arms the
 * double-fire guard, never touches the Message row. Gate failures come back
 * as the same typed reasons `sendCtmSms` would return.
 */
export async function precheckCtmSms(
  db: Db,
  params: CtmSmsPrecheckParams,
): Promise<CtmSmsPrecheckResult> {
  try {
    const gate = await runGates(db, params);
    return gate.ok ? { ok: true } : { ok: false, reason: gate.reason };
  } catch (err) {
    logger.warn('[ctm] SMS precheck errored — treating as CTM_ERROR:', err);
    return { ok: false, reason: 'CTM_ERROR' };
  }
}

/**
 * Webhook-first race repair: an inbound CTM webhook stored a row for this
 * sid before our POST response landed. Evidence-based resolution — read the
 * conflicting row; only a DIFFERENT outbound row is a webhook duplicate. The
 * user's row wins (it holds the real messageId, job links, and thread state):
 * delete the webhook's row, then retry stamping the sid onto the user's row.
 * Runs in a transaction when `db` is the root client (the delete + retry must
 * land together); inside an existing transaction it inherits that atomicity.
 */
async function reconcileWebhookSidRace(db: Db, messageId: string, sid: string): Promise<void> {
  const run = async (tx: Db) => {
    const conflicting = await tx.message.findFirst({
      where: { ctm_sms_id: sid },
      select: { id: true, direction: true },
    });
    if (!conflicting || conflicting.id === messageId) {
      // Already reconciled (or the conflict vanished) — just finish our update.
      await tx.message.update({
        where: { id: messageId },
        data: { status: 'sent', status_reason: null, ctm_sms_id: sid },
      });
      return;
    }
    if (conflicting.direction !== 'out') {
      // Not the webhook's outbound duplicate — never delete evidence we can't
      // explain. Leave the sid on that row; our row is still a delivered send.
      logger.warn('[ctm] sid conflict with a non-outbound row — kept both, sid stays on the webhook row');
      await tx.message.update({
        where: { id: messageId },
        data: { status: 'sent', status_reason: null },
      });
      return;
    }
    await tx.message.delete({ where: { id: conflicting.id } });
    await tx.message.update({
      where: { id: messageId },
      data: { status: 'sent', status_reason: null, ctm_sms_id: sid },
    });
  };

  const root = db as PrismaClient;
  if (typeof root.$transaction === 'function') {
    await root.$transaction(async (tx) => run(tx));
  } else {
    await run(db);
  }
}

/**
 * Settle a Message row that will never be delivered. Best-effort: a row that
 * vanished (thread deleted mid-send) must not turn a gate outcome into a throw.
 *
 * Exported so the seams that bail out BEFORE reaching `sendCtmSms` (smsRecord's
 * no-phone / not-configured returns, sendMessage's not-connected path) settle
 * their row the same way instead of leaving it stuck at `queued`.
 */
export async function markMessageNotDelivered(
  db: Db,
  messageId: string,
  status: 'skipped' | 'failed',
  reason: CtmSmsFailureReason,
): Promise<void> {
  try {
    await db.message.update({
      where: { id: messageId },
      data: { status, status_reason: reason },
    });
  } catch (err) {
    logger.warn(`[ctm] could not mark Message ${status} (${reason}):`, err);
  }
}

/**
 * Deliver an already-recorded outbound Message through CTM. NEVER throws.
 * Every path settles the row - see the STATUS HONESTY block at the top of this
 * file. Success stores the returned sid (when CTM echoes one - otherwise the
 * `status_change` webhook reconciles it), sets status `sent`, and audits
 * `sms.sent`.
 */
export async function sendCtmSms(db: Db, params: CtmSmsSendParams): Promise<CtmSmsSendResult> {
  const key = doubleFireKey(params.orgId, params.threadId, params.body);
  let attempted = false;
  try {
    const gate = await runGates(db, params);
    if (!gate.ok) {
      // A blocked send is a SKIPPED message, not a sent one. Leaving the row at
      // whatever the caller wrote is exactly the #1068 false-success bug.
      await markMessageNotDelivered(db, params.messageId, 'skipped', gate.reason);
      return { delivered: false, reason: gate.reason };
    }

    recentSends.set(key, Date.now());
    attempted = true;

    const response = await sendSms(gate.accountId, {
      from: gate.fromTpnId,
      to: params.toE164,
      msg: params.body,
    });

    // Defensive sid extraction — CTM's field name drifts ('id' / 'message_id').
    const rawSid = response?.id ?? response?.message_id;
    const sid = rawSid != null && String(rawSid).length > 0 ? String(rawSid) : null;

    try {
      await db.message.update({
        where: { id: params.messageId },
        data: { status: 'sent', status_reason: null, ...(sid ? { ctm_sms_id: sid } : {}) },
      });
    } catch (err) {
      // P2002 on ctm_sms_id = the inbound webhook beat us and already
      // created its own row for this sid. The send SUCCEEDED — never mark the
      // user's row failed. Keep the user's row (it carries the real messageId /
      // job links), drop the webhook's duplicate, and retry the update.
      if (sid && (err as { code?: string }).code === 'P2002') {
        await reconcileWebhookSidRace(db, params.messageId, sid);
      } else {
        throw err;
      }
    }

    void logAudit({
      action: 'sms.sent',
      orgId: params.orgId,
      resourceType: 'Message',
      resourceId: params.messageId,
      metadata: { thread_id: params.threadId, from_tpn: gate.fromTpnId },
    });

    return { delivered: true };
  } catch (err) {
    // A failed attempt shouldn't block an intentional retry for 15s.
    if (attempted) recentSends.delete(key);

    if (err instanceof CtmApiError) {
      logger.warn(`[ctm] SMS send failed (${err.httpStatus}): ${err.reason}`);
    } else {
      logger.warn('[ctm] SMS send failed:', err);
    }

    await markMessageNotDelivered(db, params.messageId, 'failed', 'CTM_ERROR');

    return { delivered: false, reason: 'CTM_ERROR' };
  }
}

/**
 * Dispatches an internal staff notification alert SMS directly without creating
 * customer conversation threads or message records in the inbox.
 */
export async function sendStaffAlertSms(
  db: Db,
  params: {
    orgId: string;
    toE164: string;
    body: string;
  }
): Promise<{ delivered: boolean; reason?: CtmSmsFailureReason }> {
  if (!isCtmConfigured()) return { delivered: false, reason: 'NOT_CONNECTED' };

  const org = await db.organization.findUnique({
    where: { id: params.orgId },
    select: {
      ctm_account_id: true,
      ctm_sms_ready: true,
      sms_sending_enabled: true,
    },
  });

  if (!org?.ctm_account_id) return { delivered: false, reason: 'NOT_CONNECTED' };
  if (!org.ctm_sms_ready) return { delivered: false, reason: 'SMS_NOT_READY' };
  if (!org.sms_sending_enabled) return { delivered: false, reason: 'ORG_SMS_DISABLED' };

  const resolved = await resolveOutboundNumber(db, {
    orgId: params.orgId,
    requireSms: true,
  });

  if (!resolved || !params.toE164) {
    return { delivered: false, reason: 'NO_SMS_NUMBER' };
  }

  if (!isOutboundAllowed(params.toE164)) {
    return { delivered: false, reason: 'NOT_IN_TEST_ALLOWLIST' };
  }

  if (await isOptedOut(org.ctm_account_id, params.toE164)) {
    return { delivered: false, reason: 'RECIPIENT_OPTED_OUT' };
  }

  try {
    await sendSms(org.ctm_account_id, {
      from: resolved.ctm_number_id,
      to: params.toE164,
      msg: params.body,
    });

    void logAudit({
      action: 'sms.sent',
      orgId: params.orgId,
      resourceType: 'SpiderAlertLog',
      metadata: { to: params.toE164, from_tpn: resolved.ctm_number_id },
    });

    return { delivered: true };
  } catch (err) {
    if (err instanceof CtmApiError) {
      logger.warn(`[ctm] Staff alert SMS send failed (${err.httpStatus}): ${err.reason}`);
    } else {
      logger.warn('[ctm] Staff alert SMS send failed:', err);
    }
    return { delivered: false, reason: 'CTM_ERROR' };
  }
}

