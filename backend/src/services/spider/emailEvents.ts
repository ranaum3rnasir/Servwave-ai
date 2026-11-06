/**
 * The email provider's delivery events for Spider's own emails (#2997).
 *
 * Every Spider email is sent with a tag naming the one record it belongs to (a lead's alert or a
 * starting summary, delivery.ts), and that record keeps the provider's id for each person's email
 * in its delivery record. When the provider later reports on an email, the delivery webhook
 * (resend-webhook.controller.ts) hands the event here, after its own signature check and only when
 * the id is not one of the business emails it tracks.
 *
 * Which record an event may change: only the record that holds the event's email id. The tag only
 * says where to look; a tag naming a record that does not hold that id changes nothing and is
 * treated as not Spider's (the webhook's own handling of an unknown id applies). The company is the
 * record's own, never anything the event says.
 *
 * What each event does to the person's outcome, given the outcome the send recorded:
 *   - bounced, failed or suppressed: "sent" becomes "could not be delivered" (the History tab's
 *     existing failed outcome, with our own fixed wording, never the provider's text). Final: no
 *     later event turns it back into "sent", so a late or repeated "delivered" never claims success
 *     for an email that bounced.
 *   - sent, delivered, delayed, complained, opened, clicked or anything else: no change. The send
 *     already recorded "sent"; a complaint means the email arrived.
 *   - a failure for a person whose email is already recorded as not sent: no change.
 *
 * The record is locked while it is read and rewritten, so two events for the same record never
 * overwrite each other's change.
 *
 * A record that exists but has not recorded its email delivery yet (the sweep writes it after all
 * of a record's emails and texts have gone out): a failure event is refused with an error, so the
 * webhook answers 500 and the provider sends it again later; any other event is acknowledged with
 * no change.
 *
 * Logs carry ids only.
 */
import type { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import {
  EMAIL_OUTCOME,
  EMAIL_REASON,
  SPIDER_EMAIL_TAG,
  summariseEmail,
  type RecipientOutcome,
} from './delivery';

/** The events that mean the email did not reach the person. */
const NOT_DELIVERED_EVENTS: ReadonlySet<string> = new Set(['email.bounced', 'email.failed', 'email.suppressed']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A failure event that arrived before its record wrote its email delivery: the provider retries it. */
export class SpiderDeliveryNotRecordedYet extends Error {
  constructor() {
    super('a Spider email delivery is not recorded yet; retry later');
    this.name = 'SpiderDeliveryNotRecordedYet';
  }
}

export interface ProviderEmailEvent {
  type: string;
  data: unknown;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A tag's value from the event, as an object ({name: value}) or a list ([{name, value}]). */
function tagOf(data: unknown, name: string): string | null {
  const tags = obj(data)?.tags;
  const value = Array.isArray(tags)
    ? obj(tags.find((t) => obj(t)?.name === name))?.value
    : obj(tags)?.[name];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** The record's email channel, once written: its one line and its per-person outcomes. */
function emailChannelOf(delivery: unknown): { outcome: string; recipients: RecipientOutcome[] } | null {
  const email = obj(obj(delivery)?.email);
  if (!email || typeof email.outcome !== 'string') return null;
  const recipients = Array.isArray(email.recipients) ? (email.recipients as RecipientOutcome[]) : [];
  return { outcome: email.outcome, recipients };
}

/** One more person not reached in a History channel record: one fewer sent, one more failed. */
function oneMoreNotDelivered(channel: unknown): unknown {
  const c = obj(channel);
  if (!c || c.enabled !== true) return channel;
  const sent = Math.max(0, num(c.sent) - 1);
  const failed = num(c.failed) + 1;
  return {
    ...c,
    sent,
    failed,
    // The contractor's rule (delivery.ts channelRecord): any send = SENT, else FAILED.
    status: sent > 0 ? 'SENT' : 'FAILED',
    error: typeof c.error === 'string' && c.error ? c.error : EMAIL_REASON.failed,
  };
}

type Decision =
  | { kind: 'not_spider' }
  | { kind: 'no_change' }
  | { kind: 'not_delivered'; delivery: Record<string, unknown>; userId: string };

/** What the event does to a record's delivery, by the rules above. */
function decide(delivery: unknown, emailId: string, eventType: string): Decision {
  const failure = NOT_DELIVERED_EVENTS.has(eventType);
  const email = emailChannelOf(delivery);
  if (!email) {
    if (failure) throw new SpiderDeliveryNotRecordedYet();
    return { kind: 'no_change' };
  }
  const person = email.recipients.find((r) => r?.message_id === emailId);
  if (!person) return { kind: 'not_spider' };
  if (!failure || person.outcome !== EMAIL_OUTCOME.sent) return { kind: 'no_change' };
  const recipients = email.recipients.map((r) => (r === person ? { ...r, outcome: EMAIL_OUTCOME.failed } : r));
  return {
    kind: 'not_delivered',
    delivery: { ...(obj(delivery) ?? {}), email: { ...obj(obj(delivery)?.email), outcome: summariseEmail(recipients), recipients } },
    userId: person.user_id,
  };
}

async function applyToAlert(tx: Prisma.TransactionClient, alertId: string, emailId: string, eventType: string): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM spider_alerts WHERE id = ${alertId}::uuid FOR UPDATE`;
  if (locked.length === 0) return false;
  const alert = await tx.spiderAlert.findUniqueOrThrow({
    where: { id: alertId },
    select: { organization_id: true, delivery: true, channels: true },
  });
  const decision = decide(alert.delivery, emailId, eventType);
  if (decision.kind === 'not_spider') return false;
  if (decision.kind === 'no_change') return true;
  const channels = obj(alert.channels);
  await tx.spiderAlert.update({
    where: { id: alertId },
    data: {
      delivery: decision.delivery as Prisma.InputJsonValue,
      ...(channels ? { channels: { ...channels, email: oneMoreNotDelivered(channels.email) } as Prisma.InputJsonValue } : {}),
    },
  });
  logger.info('[spider] an alert email was not delivered', { orgId: alert.organization_id, alertId, userId: decision.userId });
  return true;
}

async function applyToSummary(tx: Prisma.TransactionClient, summaryId: string, emailId: string, eventType: string): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM spider_summaries WHERE id = ${summaryId}::uuid FOR UPDATE`;
  if (locked.length === 0) return false;
  const summary = await tx.spiderSummary.findUniqueOrThrow({
    where: { id: summaryId },
    select: { organization_id: true, delivery: true },
  });
  const decision = decide(summary.delivery, emailId, eventType);
  if (decision.kind === 'not_spider') return false;
  if (decision.kind === 'no_change') return true;
  await tx.spiderSummary.update({ where: { id: summaryId }, data: { delivery: decision.delivery as Prisma.InputJsonValue } });
  // Each summarized lead's History row that this person's summary told them about.
  const rows = await tx.spiderAlert.findMany({
    where: { organization_id: summary.organization_id, summary_id: summaryId, recipient_ids: { has: decision.userId } },
    select: { id: true, channels: true },
  });
  for (const row of rows) {
    const channels = obj(row.channels);
    if (!channels) continue;
    await tx.spiderAlert.update({
      where: { id: row.id },
      data: { channels: { ...channels, email: oneMoreNotDelivered(channels.email) } as Prisma.InputJsonValue },
    });
  }
  logger.info('[spider] a summary email was not delivered', { orgId: summary.organization_id, summaryId, userId: decision.userId });
  return true;
}

/**
 * Applies a provider event to the Spider record its email belongs to. True when the email is
 * Spider's (whether or not the event changed anything), false when it is not, so the caller keeps
 * its own handling of an unknown id. Throws SpiderDeliveryNotRecordedYet for a failure that arrived
 * before the record wrote its email delivery.
 */
export async function applySpiderEmailEvent(
  tx: Prisma.TransactionClient,
  emailId: string,
  event: ProviderEmailEvent,
): Promise<boolean> {
  const alertId = tagOf(event.data, SPIDER_EMAIL_TAG.alert);
  if (alertId) return applyToAlert(tx, alertId, emailId, event.type);
  const summaryId = tagOf(event.data, SPIDER_EMAIL_TAG.summary);
  if (summaryId) return applyToSummary(tx, summaryId, emailId, event.type);
  return false;
}
