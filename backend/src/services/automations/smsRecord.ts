/**
 * smsRecord.ts — outbound-SMS write path for automation actions.
 *
 * Mirrors the Communication module's send seam (comm-threads.controller
 * sendMessage): find-or-create the counterparty's SMS MessageThread, append an
 * outbound Message with the `automated` flag, and (customers only) surface an
 * SMS_SENT event on the customer timeline.
 *
 * TWO counterparties, discriminated (Spec C). A text step can be addressed to the
 * customer, as it always could, or to a member of STAFF. The two write genuinely
 * different rows - a staff thread is keyed on user_id, marked `kind: 'team'` so the
 * Communication module files it in the internal lane, titled with the person's name
 * (there is no customer row to derive a display name from), and carries NO job
 * attribution - so they are a union rather than a nullable customer id. Everything
 * BELOW the thread/message write is shared: same queued-never-sent invariant, same
 * gates, same settle-the-row contract.
 *
 * This is the org's built SMS layer — delivery to the handset activates when
 * an SMS provider (CTM) is connected; until then the record is the product:
 * visible in the Communication UI and in automation run history. CTM is that
 * provider now (slice 6): after the record write, delivery goes through the
 * shared `sendCtmSms` path and the caller AWAITS the outcome — automations
 * never 409 (sendCtmSms never throws) but the executor needs the real result
 * to report an honest step status (SERV10X-70, mirrors the SEND_EMAIL fix).
 *
 * The row is written `queued` and settled by the delivery path (sent / skipped
 * with a reason / failed). It must never be written `sent` up front: that is
 * the #1068 false-success shape, and it is what left 24 automated rows on
 * staging permanently claiming a send that the gates had suppressed.
 *
 * There is no separate launch flag here — sendCtmSms's own gates (connected,
 * A2P-ready, org kill switch, `phone` entitlement) are the single source of
 * truth for whether an org can text. The builder's "Send text" step unlocks
 * per-org off the same gates via GET /api/workflows/catalog capabilities.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { normalizeNAPhone } from '../../lib/comms-identity';
import { isCtmConfigured } from '../../lib/ctm/client';
import { markMessageNotDelivered, sendCtmSms, type CtmSmsSendResult } from '../../lib/ctm/sendSms';

/**
 * WHO an automated text is addressed to.
 *
 * `job` lives on the CUSTOMER arm only, and structurally so. The invariant is written at
 * comm-threads.controller.ts: internal lanes (kind team/group) NEVER carry a job id. A job
 * id on a staff message would interleave staff texts into the Job -> Communications tab
 * beside the customer conversation (getJobCommunications has no thread-kind filter), and
 * would route the whole staff thread's visibility through the requester's Job scope
 * (anchorVisibility's anchorInheritedWhere), making the thread appear and disappear per
 * viewer as messages accrue. The job context already rides in the body via {{job.number}}.
 * Giving the staff arm nowhere to put a job id is cheaper than remembering not to.
 *
 * The consequence - an unattributed staff thread falls in anchorInheritedWhere's
 * unconditional third branch and is org-wide visible - is the access decision, taken
 * deliberately, and matches how the codebase already treats an unanchored thread.
 */
export type OutboundSmsCounterparty =
  | { type: 'customer'; customerId: string; job?: { id: string; label: string | null } | null }
  /**
   * A member of staff. `toE164` is the number the CALLER already holds (it rides on the
   * resolved recipient), so this path performs no lookup of its own; `name` titles the
   * thread, because a staff thread has no customer row to derive a display name from.
   */
  | { type: 'user'; userId: string; name: string; toE164: string };

export interface RecordOutboundSmsParams {
  organizationId: string;
  to: OutboundSmsCounterparty;
  body: string;
}

export async function recordOutboundSms(
  params: RecordOutboundSmsParams,
): Promise<{ threadId: string; messageId: string; delivery: CtmSmsSendResult }> {
  const thread = await findOrCreateThread(params.organizationId, params.to);

  const message = await prisma.message.create({
    data: {
      thread_id: thread.id,
      direction: 'out',
      body: params.body,
      ts: new Date(),
      // `queued`, never `sent` - at this point nothing has attempted delivery.
      // sendCtmSms settles it below: sent / skipped(reason) / failed(reason).
      // Writing 'sent' here is what put 24 automated rows on staging into a
      // permanent false-success state (see #1068 / PR #1070 for the same bug in
      // the email executor).
      status: 'queued',
      automated: true,
      ...(params.to.type === 'customer' && params.to.job
        ? { job_id: params.to.job.id, job_label: params.to.job.label }
        : {}),
      organization_id: params.organizationId,
    },
  });

  // Customer timeline only. `entity_type` is free text, but every reader of this table is
  // customer-side and there is no per-user timeline anywhere in the product - a 'USER' row
  // here would be written and never read.
  if (params.to.type === 'customer') {
    await prisma.timelineEvent.create({
      data: {
        organization_id: params.organizationId,
        entity_type: 'CUSTOMER',
        entity_id: params.to.customerId,
        event_type: 'SMS_SENT',
        description: 'Automated SMS recorded',
        metadata: { thread_id: thread.id, message_id: message.id, automated: true },
        created_by: null,
      },
    });
  }

  // CTM delivery — awaited (no precheck: automations never 409, and
  // deliverViaCtm never throws, so awaiting it cannot break the run).
  const delivery = await deliverViaCtm({
    organizationId: params.organizationId,
    to: params.to,
    threadId: thread.id,
    messageId: message.id,
    body: params.body,
  });

  return { threadId: thread.id, messageId: message.id, delivery };
}

async function findOrCreateThread(
  organizationId: string,
  to: OutboundSmsCounterparty,
): Promise<{ id: string }> {
  if (to.type === 'customer') {
    const existing = await prisma.messageThread.findFirst({
      where: {
        customer_id: to.customerId,
        channel: 'sms',
        organization_id: organizationId,
      },
    });
    if (existing) return existing;
    return prisma.messageThread.create({
      data: {
        channel: 'sms',
        campaign_type: 'customer_care',
        customer_id: to.customerId,
        organization_id: organizationId,
      },
    });
  }

  const existing = await prisma.messageThread.findFirst({
    where: { user_id: to.userId, channel: 'sms', organization_id: organizationId },
  });
  if (existing) return existing;
  return prisma.messageThread.create({
    data: {
      channel: 'sms',
      // BOTH stamps, and `kind` is the load-bearing one: the Communication module derives a
      // thread's bucket from `kind` and reads an absent kind as `customer`, so campaign_type
      // alone would leave a staff thread sitting in the customer conversations lane.
      // `tech_ops` already exists in the frontend union and its label map, written by nothing
      // until now - so no migration and nothing to invent.
      kind: 'team',
      campaign_type: 'tech_ops',
      title: to.name,
      user_id: to.userId,
      organization_id: organizationId,
    },
  });
}

async function deliverViaCtm(p: {
  organizationId: string;
  to: OutboundSmsCounterparty;
  threadId: string;
  messageId: string;
  body: string;
}): Promise<CtmSmsSendResult> {
  // The two bail-outs below never reach sendCtmSms, so they must settle the
  // row themselves - otherwise it sits at `queued` forever, which reads as
  // "still going out" for a send that will never be attempted.
  try {
    if (!isCtmConfigured()) {
      await markMessageNotDelivered(prisma, p.messageId, 'skipped', 'NOT_CONNECTED');
      return { delivered: false, reason: 'NOT_CONNECTED' };
    }
    const toE164 = await resolveDestination(p.organizationId, p.to);
    if (!toE164) {
      await markMessageNotDelivered(prisma, p.messageId, 'skipped', 'NO_SMS_NUMBER');
      return { delivered: false, reason: 'NO_SMS_NUMBER' };
    }
    return await sendCtmSms(prisma, {
      orgId: p.organizationId,
      toE164,
      body: p.body,
      threadId: p.threadId,
      messageId: p.messageId,
      // No `userId`: an automation has no sending user, so the from-number resolves to
      // the ORG default rather than anyone's personal caller ID. Deliberate, both arms.
    });
  } catch (err) {
    logger.warn('[ctm] automation SMS delivery failed (record kept):', err);
    await markMessageNotDelivered(prisma, p.messageId, 'failed', 'CTM_ERROR');
    return { delivered: false, reason: 'CTM_ERROR' };
  }
}

/**
 * The destination, normalized the SAME way on both arms.
 *
 * Normalizing at capture protects only NEW writes; both `customers.phone` and `users.phone`
 * still hold display-formatted values on live rows, so a number that is not put through
 * normalizeNAPhone here reaches the provider as "(555) 123-4567" and never lands. The staff
 * arm takes the number the caller already resolved rather than re-querying it - that is the
 * whole point of carrying `phone` on RecipientUser.
 */
async function resolveDestination(organizationId: string, to: OutboundSmsCounterparty): Promise<string | null> {
  if (to.type === 'user') return normalizeNAPhone(to.toE164) ?? to.toE164;
  const customer = await prisma.customer.findFirst({
    where: { id: to.customerId, organization_id: organizationId },
    select: { phone: true },
  });
  return customer?.phone ? (normalizeNAPhone(customer.phone) ?? customer.phone) : null;
}
