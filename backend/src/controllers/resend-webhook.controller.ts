import { Request, Response } from 'express';
import { Resend } from 'resend';
import type { WebhookEventPayload } from 'resend';
import { EmailDeliveryStatus, EmailBounceKind } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import {
  normalizeSuppressionAddress,
  TRANSACTIONAL_SUPPRESSION_CATEGORY,
} from '../lib/email-suppression';
import { fetchReceivedEmail, persistInboundEmail } from '../lib/inbound-email';
import { emit } from '../services/notifications/notificationService';
import { publishEmailsChanged } from '../services/notifications/realtimePublish';

/**
 * Tell the office a customer wrote back (post-commit; see the call site).
 *
 * TWO signals, deliberately distinct, on the same private per-user channel:
 *
 *   1. `emit` writes the bell entry and pushes `notifications.changed`. It
 *      resolves recipients itself and returns them, so the thread's owner is
 *      decided in ONE place (resolveRecipients) rather than re-derived here.
 *   2. `publishEmailsChanged` nudges the open Inbox to refetch its message
 *      list. Separate from `notifications.changed` so the Inbox does not
 *      refetch every message on every unrelated notification.
 *
 * Only the same people get both: a signal is a "refetch now" with no content,
 * and the refetch goes back through the API where `commVisibilityWhere` still
 * applies, so this can never leak a message the recipient could not read.
 *
 * Dedup-keyed on the provider message id: Resend retries webhooks for hours,
 * and a redelivery that slips past the event ledger must not ring the bell
 * twice for one reply.
 */
async function announceInboundEmail(inbound: {
  organizationId: string;
  threadId: string;
  providerMessageId: string;
  senderLabel: string;
  subject: string;
}): Promise<void> {
  const thread = await prisma.emailThread.findUnique({
    where: { id: inbound.threadId },
    select: { assigned_to_user_id: true },
  });

  const notified = await emit({
    verb: 'communication.email_inbound',
    organizationId: inbound.organizationId,
    // A customer is not a user of ours, so there is no actor to drop - and an
    // actor here would wrongly suppress the notification for whoever it matched.
    actorId: null,
    object: { type: 'EMAIL_THREAD', id: inbound.threadId, label: inbound.senderLabel },
    entity: { thread_assignee_id: thread?.assigned_to_user_id ?? undefined },
    data: { subject: inbound.subject },
    dedupKey: `email_inbound:${inbound.providerMessageId}`,
  });

  // Nothing to refresh if nobody was notified, and an empty publish is a
  // pointless round trip on every inbound message.
  if (notified.length > 0) {
    await publishEmailsChanged(notified, inbound.organizationId);
  }
}

/**
 * Resend delivery webhook — POST /api/webhooks/resend (email slice 4)
 *
 * Mounted beside the CTM/Stripe webhooks under /api/webhooks (app.ts), so it
 * inherits `unscopedRequest` — the org-less RLS-bypass context those routes
 * already run under. That matters here too: the owning org is resolved per
 * event via emails.provider_message_id, never from a request-scoped org.
 *
 * PRECEDENT: modeled on ctm-webhook.controller.ts (claim-first idempotency via
 * a dedicated ledger table, tolerant "unknown correlation -> record + 200"
 * handling), NOT on webhook.controller.ts's Stripe handler, which skips
 * signature verification when NODE_ENV==='test' - that would ship zero real
 * signature-verification coverage.
 *
 * AUTH — fail CLOSED, single gate (resend@6's own svix-based verification):
 *  1. RESEND_WEBHOOK_SECRET unset -> 401 for EVERY request (Phase-0 posture
 *     shared with CTM_WEBHOOK_TOKEN/CTM_WEBHOOK_SIGNING_SECRET).
 *  2. Any of the three svix-* headers missing -> 401.
 *  3. resend.webhooks.verify() throws (bad signature) -> 401.
 *
 * `resendWebhooks` exists ONLY to reach `.webhooks.verify()`, which is pure
 * local HMAC/svix verification - no network call, no API key touched at
 * runtime - so it is safe to construct even when RESEND_API_KEY is unset. This
 * is a separate instance from lib/email.ts's own `resend` (the send path);
 * the two are unrelated despite the shared constructor.
 */
const resendWebhooks = new Resend(env.RESEND_API_KEY || 'unused-for-webhook-verify');

class DuplicateResendEventError extends Error {
  constructor() {
    super('Resend webhook event already processed (concurrent duplicate)');
    this.name = 'DuplicateResendEventError';
  }
}

// req.body arrives as a Buffer (route-level express.raw). Under supertest the
// Buffer may be serialised to {"type":"Buffer","data":[...]} — rehydrate it
// exactly like the CTM/Stripe handlers do.
function rawBodyString(req: Request): string {
  const raw = req.body;
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) {
    const text = raw.toString('utf8');
    try {
      const intermediate = JSON.parse(text);
      if (intermediate && intermediate.type === 'Buffer' && Array.isArray(intermediate.data)) {
        return Buffer.from(intermediate.data).toString('utf8');
      }
    } catch {
      // plain (non-JSON) body — fall through with the utf8 text
    }
    return text;
  }
  return raw ? JSON.stringify(raw) : '';
}

/**
 * Ordinal rank for the OUT-OF-ORDER guard. Resend/svix do not guarantee
 * delivery order, so a late `sent` or `delivered` retry arriving after a
 * further-along status must never regress the row.
 *
 * COMPLAINED is ranked highest, but that is a MODELING CHOICE forced by the
 * schema (delivery_status is a single column — there is no separate
 * "complained" flag alongside it), not a claim that a complaint is a "later"
 * delivery stage than a bounce. The actual invariant this buys: once a
 * complaint is recorded, no later/duplicate sent-delivered-bounced webhook can
 * silently erase it, and an incoming complaint always wins over whatever the
 * row currently says (a real complaint can only ever follow a genuine
 * delivery, so it should always be recordable).
 *
 * BOUNCED here means a HARD bounce (dead address — a real DELIVERED can never
 * legitimately follow it). A SOFT bounce ranks lower — see SOFT_BOUNCE_RANK
 * and effectiveRank() below — because the schema's own EmailBounceKind
 * comment says SOFT is "a transient condition ... that may clear", i.e. a
 * later genuine `email.delivered` for the same message is real forward
 * progress, not a duplicate/retry, and must not be discarded here.
 */
const STATUS_RANK: Record<EmailDeliveryStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  DEFERRED: 2,
  DELIVERED: 4,
  BOUNCED: 5,
  FAILED: 5,
  COMPLAINED: 6,
};

/** Rank for a SOFT bounce specifically — between DEFERRED and DELIVERED, so
 * a subsequent DELIVERED still applies, but a subsequent SENT/DEFERRED retry
 * does not regress it. See STATUS_RANK's doc comment for the full rationale. */
const SOFT_BOUNCE_RANK = 3;

/** Out-of-order rank for a stored/incoming (status, bounceKind) pair. Always
 * go through this instead of indexing STATUS_RANK directly once bounceKind is
 * available — it is the only place SOFT's lower rank is applied. */
function effectiveRank(status: EmailDeliveryStatus, bounceKind: EmailBounceKind | null | undefined): number {
  if (status === 'BOUNCED' && bounceKind === 'SOFT') return SOFT_BOUNCE_RANK;
  return STATUS_RANK[status];
}

interface StatusUpdate {
  status: EmailDeliveryStatus;
  reason: string | null;
  bounceKind: EmailBounceKind | null;
}

/** Maps a handled Resend event type onto our own delivery-status vocabulary.
 * Returns null for any event type we don't track a status for (email.opened,
 * email.clicked, contact.*, …) — those are still recorded in the idempotency
 * ledger and acknowledged, just with no Email row side effect. */
function mapEventToUpdate(event: WebhookEventPayload): StatusUpdate | null {
  switch (event.type) {
    case 'email.sent':
      return { status: 'SENT', reason: null, bounceKind: null };
    case 'email.delivery_delayed':
      return { status: 'DEFERRED', reason: null, bounceKind: null };
    case 'email.delivered':
      return { status: 'DELIVERED', reason: null, bounceKind: null };
    case 'email.bounced': {
      // Resend reports bounce.type as its own Permanent/Temporary vocabulary;
      // we map that onto our HARD/SOFT (see EmailBounceKind's schema comment).
      const bounceKind: EmailBounceKind = event.data.bounce.type === 'Permanent' ? 'HARD' : 'SOFT';
      return { status: 'BOUNCED', reason: event.data.bounce.message ?? null, bounceKind };
    }
    case 'email.failed':
      return { status: 'FAILED', reason: event.data.failed.reason ?? null, bounceKind: null };
    case 'email.complained':
      return { status: 'COMPLAINED', reason: null, bounceKind: null };
    default:
      return null;
  }
}

/** BaseEmailEventData.email_id — the correlation key every handled event type
 * carries, matching emails.provider_message_id's unique index. Absent on the
 * event types mapEventToUpdate returns null for (the contact- and domain-
 * shaped events carry no such field at all). */
function emailIdOf(event: WebhookEventPayload): string | undefined {
  return (event.data as { email_id?: string }).email_id;
}

/** Every address on the ORIGINAL send's `to` list, normalized. Resend's event
 * payload does not disambiguate per-recipient outcome on a multi-recipient
 * send, and ServWave's business senders are single-recipient in the
 * overwhelming majority of cases, so suppressing the whole list on a hard
 * bounce/complaint is the simplest correct behavior for this slice. */
function extractEventAddresses(event: WebhookEventPayload): string[] {
  const to = (event.data as { to?: string[] }).to;
  if (!Array.isArray(to)) return [];
  return Array.from(new Set(to.map(normalizeSuppressionAddress).filter(Boolean)));
}

export async function handleResendWebhook(req: Request, res: Response) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('[resend-webhook] RESEND_WEBHOOK_SECRET is not set — rejecting all webhook traffic (fail closed)');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const svixId = req.header('svix-id');
  const svixTimestamp = req.header('svix-timestamp');
  const svixSignature = req.header('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const rawBody = rawBodyString(req);

  let event: WebhookEventPayload;
  try {
    event = resendWebhooks.webhooks.verify({
      payload: rawBody,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      webhookSecret: secret,
    });
  } catch (err) {
    logger.warn(`[resend-webhook] signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // svix-id is Resend/svix's own stable event id — it stays the SAME across a
  // redelivery of the same logical event, so it (not something synthesized
  // here) is the idempotency dedupe key.
  await processResendEvent(svixId, event, res);
}

/**
 * Post-auth processing — idempotency + status update + suppression, all
 * inside one transaction. Mirrors processCtmEvent: pre-check → claim-first
 * transaction (P2002 = concurrent duplicate) → 200 fast. A genuine processing
 * failure (not a duplicate, not an unknown email_id) surfaces as 500 so
 * Resend's own retry re-delivers.
 */
export async function processResendEvent(
  dedupeKey: string,
  event: WebhookEventPayload,
  res: Response,
) {
  const existingEvent = await prisma.resendEvent.findUnique({ where: { resend_event_id: dedupeKey } });
  if (existingEvent) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    // ─── email.received (email slice 6) — fetch BEFORE the idempotency claim,
    //     and outside the transaction. Both placements are load-bearing:
    //
    //     - BEFORE THE CLAIM, because the claim is what makes Resend's retry a
    //       no-op. Claiming first and then failing the fetch would dedupe the
    //       redelivery and lose the customer's message for good. Failing here
    //       500s having written nothing, so the retry genuinely re-runs.
    //     - OUTSIDE THE TRANSACTION, because this is a network round-trip and
    //       holding a DB transaction open across one is how transaction
    //       timeouts happen under load.
    //
    //     The fetch is required rather than opportunistic: the webhook payload
    //     is metadata only, so the body and the Authentication-Results header
    //     that backs the sender check exist only on the far side of this call.
    const inboundMessage = event.type === 'email.received'
      ? await fetchReceivedEmail((event.data as { email_id: string }).email_id)
      : null;

    // Set inside the email.received branch below, read only after the
    // transaction commits — same deferral as justVerifiedDomain, and for the
    // same reason: announcing a message that a rollback then erases would leave
    // a notification pointing at nothing. Captured in a closure variable rather
    // than returned because the transaction's return channel already carries
    // the domain-verification result.
    let inboundToAnnounce: {
      organizationId: string;
      threadId: string;
      providerMessageId: string;
      senderLabel: string;
      subject: string;
    } | null = null;

    await prisma.$transaction(async (tx): Promise<null> => {
      // FIRST — atomic idempotency claim; P2002 = concurrent duplicate.
      try {
        await tx.resendEvent.create({
          data: { resend_event_id: dedupeKey, event_type: event.type, payload: event as unknown as object },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') throw new DuplicateResendEventError();
        throw err;
      }

      // ─── email.received (email slice 6) — inbound mail, which correlates via
      // the reply token in the envelope recipient, NOT via provider_message_id.
      // Must return before the email.* correlation below: this event carries an
      // `email_id` too, but it is the RECEIVED message's id in a different
      // namespace, and falling through would look up a sent row that cannot
      // exist and log a spurious unknown-id warning. ───
      if (event.type === 'email.received') {
        const stored = await persistInboundEmail(tx, inboundMessage!);
        if (!stored) {
          // Unattributable: no token, or one that no longer resolves. Every row
          // we could write is tenant-scoped, so there is nowhere org-less to put
          // this and picking an org would be a cross-tenant write. Recorded
          // above and acknowledged - a redelivery will not make the token
          // resolve, so a 500 would only buy a retry loop over junk addressed to
          // the catch-all domain.
          logger.warn(`[resend-webhook] email.received ${inboundMessage!.providerId} could not be attributed to an org — recorded, dropped`);
        } else if (stored.resolution.inbound_match !== 'MATCHED') {
          logger.info(`[resend-webhook] email.received ${inboundMessage!.providerId} stored as ${stored.resolution.inbound_match} (dmarc=${stored.resolution.inbound_auth})`);
        }

        // MATCHED only, and deliberately. An UNMATCHED message has no thread to
        // own it, and the unmatched queue collects whatever is addressed to the
        // catch-all reply domain — notifying on it would hand every spammer a
        // way to ring the office bell. It still lands in Needs review, which is
        // the surface built for exactly that triage.
        if (stored && stored.thread_id && stored.resolution.inbound_match === 'MATCHED') {
          inboundToAnnounce = {
            organizationId: stored.resolution.organization_id,
            threadId: stored.thread_id,
            providerMessageId: inboundMessage!.providerId,
            senderLabel: inboundMessage!.from,
            subject: inboundMessage!.subject,
          };
        }
        return null;
      }

      // domain.* events carry no email_id and correlate to nothing we store -
      // per-org sending domains were removed with the guided custom-domain
      // feature, so every org sends from the one shared platform domain. They
      // are still RECORDED in the event ledger above and acknowledged here,
      // rather than 404ing a webhook into a retry dead end.
      if (event.type.startsWith('domain.')) return null;

      const emailId = emailIdOf(event);
      if (!emailId) return null; // event type carries no correlation key — recorded, nothing more to do.

      const email = await tx.email.findUnique({ where: { provider_message_id: emailId } });
      if (!email) {
        // Unknown/race (e.g. the send row hasn't committed yet): recorded above,
        // acknowledge rather than 404/500ing a webhook into a retry dead end.
        logger.warn(`[resend-webhook] ${event.type} for unknown provider_message_id ${emailId} — recorded, ignored`);
        return null;
      }

      const update = mapEventToUpdate(event);
      if (!update) return null; // an event type we don't track a status for.

      const currentRank = email.delivery_status ? effectiveRank(email.delivery_status, email.bounce_kind) : -1;
      const newRank = effectiveRank(update.status, update.bounceKind);
      if (newRank >= currentRank) {
        await tx.email.update({
          where: { id: email.id },
          data: {
            delivery_status: update.status,
            delivery_status_reason: update.reason,
            delivery_status_at: new Date(),
            ...(update.bounceKind ? { bounce_kind: update.bounceKind } : {}),
          },
        });
      } else {
        logger.info(
          `[resend-webhook] out-of-order ${update.status} for email ${email.id} ignored (current ${email.delivery_status} outranks it)`,
        );
      }

      // Suppression (email slice 4) — a HARD bounce or a complaint stops FUTURE
      // transactional sends to this exact address, globally. Applied whenever
      // the webhook itself claims one of these two outcomes, independent of
      // whether the rank gate above actually wrote the column (the safety
      // side-effect must not depend on what the display column already says).
      const suppressionKind =
        update.status === 'BOUNCED' && update.bounceKind === 'HARD'
          ? 'HARD_BOUNCE'
          : update.status === 'COMPLAINED'
            ? 'COMPLAINT'
            : null;
      if (suppressionKind) {
        for (const address of extractEventAddresses(event)) {
          await tx.emailSuppression.upsert({
            where: { address_category: { address, category: TRANSACTIONAL_SUPPRESSION_CATEGORY } },
            create: {
              address,
              category: TRANSACTIONAL_SUPPRESSION_CATEGORY,
              kind: suppressionKind,
              organization_id: email.organization_id,
            },
            update: { kind: suppressionKind },
          });
        }
      }
      return null;
    });

    if (inboundToAnnounce) {
      // Wholly best-effort. emit() already swallows its own failures, but this
      // guard covers the wiring around it too: a throw here would 500 the
      // webhook, Resend would retry, and the retry would be deduped by the
      // idempotency claim that already committed — costing the customer's
      // message to save a bell entry. Wrong trade, so it is caught and logged.
      await announceInboundEmail(inboundToAnnounce).catch((err) =>
        logger.error(`[resend-webhook] failed to announce inbound email on thread ${inboundToAnnounce!.threadId}:`, err));
    }

    res.json({ received: true });
  } catch (err) {
    if (err instanceof DuplicateResendEventError) {
      res.json({ received: true, duplicate: true });
      return;
    }
    logger.error(
      `[resend-webhook] processing failed (event=${event.type}): ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
