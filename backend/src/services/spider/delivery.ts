/**
 * Spider's email and text channels (#2619, ADR 0005 addendum). Both are staff-only and both send
 * to exactly the people Spider's one recipient rule returned (recipients.ts).
 *
 * Every outcome is written in plain words for the History tab - never a provider error string,
 * never a vendor name. Logs carry ids only: no email address and no phone number is ever logged
 * from here.
 */
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { formatSenderIdentity, isRateLimited, RATE_LIMIT_BACKOFF_MS, resend, wrapHtml } from '../../lib/email';
import { isTransactionalSendSuppressed, normalizeSuppressionAddress, transactionalSuppressedAmong } from '../../lib/email-suppression';
import { normalizeNAPhone } from '../../lib/comms-identity';
import { sendStaffAlertSms, staffTextCompany, type CtmSmsFailureReason, type StaffTextCompany } from '../../lib/ctm/sendSms';
import type { SpiderRecipient } from './recipients';

/**
 * What an email or a text needs of a person: who they are and where to reach them. A starting summary's delivery reads its
 * people back from the database after the claims are saved (summary.ts), so it has no more of a SpiderRecipient than this.
 */
export type SpiderContact = Pick<SpiderRecipient, 'id' | 'first_name' | 'last_name' | 'email' | 'phone'>;
import {
  spiderAlertEmailHtml,
  spiderAlertHeader,
  spiderFullTextMessage,
  type SpiderMessageContent,
} from './messages';

/** The one fixed sender every Spider email goes out as. No caller can choose another. */
export const SPIDER_EMAIL_SENDER = { name: 'ServWave Spider Alerts', address: 'alerts@spider.servwave.com' } as const;

export interface RecipientOutcome {
  user_id: string;
  outcome: string;
  /**
   * The email provider's id for the email this person was sent (#2997), so its later delivery events
   * (a bounce, a failure) can update this record (emailEvents.ts). Only on an email that went out.
   * Stored, never rendered: no API answer carries the raw delivery record.
   */
  message_id?: string;
}

export interface ChannelDelivery {
  outcome: string;
  recipients?: RecipientOutcome[];
}

// ─── The History tab's per-channel record (S3, the contractor's alert-log shape) ─────────────

export type DeliveryResult = 'sent' | 'failed' | 'skipped';

/** One recipient's result on one channel, with the reason for a skip or a failure. */
export interface RecipientResult {
  user_id: string;
  result: DeliveryResult;
  reason: string | null;
}

/**
 * One person's answer on one channel, as both records hold it: the per-person sentence and the per-channel result. A send
 * reports each the moment it is known (`onPerson`), so a stop that no longer waits for the rest keeps it (tick.ts).
 */
export interface PersonDelivery {
  outcome: RecipientOutcome;
  result: RecipientResult;
}

export type ChannelStatus = 'SENT' | 'FAILED' | 'SKIPPED';

/**
 * What the contractor's alert log stored per channel (his spiderDispatch.service.ts at 3bb6606):
 * whether it was on, SENT / FAILED / SKIPPED, and how many sends went out, were skipped or failed.
 * `error` is the first failure in his wording; `skip_reason` (ours) is the first skip's reason, so the
 * History tab never names a reason that did not happen.
 */
export interface ChannelRecord {
  enabled: boolean;
  status: ChannelStatus;
  sent: number;
  skipped: number;
  failed: number;
  error: string | null;
  skip_reason: string | null;
  from?: string;
}

/** His status rule: off or nothing went out and nothing failed = SKIPPED; any send = SENT; else FAILED. */
export function channelRecord(enabled: boolean, results: readonly RecipientResult[]): ChannelRecord {
  const count = (r: DeliveryResult) => (enabled ? results.filter((x) => x.result === r).length : 0);
  const sent = count('sent');
  const skipped = count('skipped');
  const failed = count('failed');
  const firstReason = (r: DeliveryResult) => (enabled ? results.find((x) => x.result === r)?.reason ?? null : null);
  return {
    enabled,
    status: !enabled ? 'SKIPPED' : sent > 0 ? 'SENT' : failed > 0 ? 'FAILED' : 'SKIPPED',
    sent,
    skipped,
    failed,
    error: firstReason('failed'),
    skip_reason: firstReason('skipped'),
  };
}

/** The sender line his preview showed ("ServWave Spider Alerts <alerts@spider.servwave.com>"). */
export const SPIDER_EMAIL_FROM_LINE = `${SPIDER_EMAIL_SENDER.name} <${SPIDER_EMAIL_SENDER.address}>`;

/**
 * Reasons in his stored wording where he had one (mapEmailDeliveryFailureReason /
 * mapSmsDeliveryFailureReason, and his "no email address" / "no phone number" skip tooltips), and
 * ours where he had none. Never a provider's own error text, never a vendor name.
 */
export const EMAIL_REASON = {
  failed: 'Email delivery failed',
  suppressed: 'Recipient opted out',
  companyOff: 'company email is switched off',
  notSetUp: 'email sending is not set up',
  noAddress: 'no email address',
  interrupted: 'the send was interrupted and is not repeated',
} as const;

export const TEXT_REASON = {
  noPhone: 'no phone number',
  failed: 'Text message delivery failed',
  interrupted: 'the send was interrupted and is not repeated',
} as const;

/** Why an alert's email or text did not go out when Spider was switched off while it was being raised (D4). */
export const SPIDER_OFF_REASON = 'Spider was switched off';

function textResultFor(reason: CtmSmsFailureReason): { result: DeliveryResult; reason: string } {
  switch (reason) {
    case 'NOT_CONNECTED':
      return { result: 'skipped', reason: 'SMS service is not connected' };
    case 'SMS_NOT_READY':
      return { result: 'skipped', reason: 'SMS messaging is not ready' };
    case 'ORG_SMS_DISABLED':
      return { result: 'skipped', reason: 'SMS messaging is disabled' };
    case 'NOT_ENTITLED':
      return { result: 'skipped', reason: 'SMS messaging is not entitled' };
    case 'NO_SMS_NUMBER':
      return { result: 'skipped', reason: 'No phone number configured' };
    case 'NOT_IN_TEST_ALLOWLIST':
      return { result: 'skipped', reason: 'Phone number not in allowlist' };
    case 'RECIPIENT_OPTED_OUT':
      return { result: 'skipped', reason: 'Recipient opted out' };
    case 'DUPLICATE_SEND':
      return { result: 'failed', reason: 'Duplicate notification prevented' };
    case 'CTM_ERROR':
    default:
      return { result: 'failed', reason: TEXT_REASON.failed };
  }
}

// ─── Wording ─────────────────────────────────────────────────────────────────

export const EMAIL_OUTCOME = {
  sent: 'Email sent',
  failed: 'Email could not be delivered',
  suppressed: 'Email skipped: address is suppressed',
  companyOff: 'Email skipped: company email is switched off',
  notSetUp: 'Email skipped: email sending is not set up',
  noAddress: 'Email skipped: no email address on profile',
  channelOff: 'Email alerts are switched off',
  spiderOff: 'Email skipped: Spider was switched off',
  interrupted: 'Emails were interrupted by a restart and are not sent again',
} as const;

export const TEXT_OUTCOME = {
  sent: 'Text message sent',
  failed: 'Text message could not be delivered',
  noPhone: 'Text skipped: no phone number on profile',
  companyOff: 'Text skipped: company texting is switched off',
  notInPlan: 'Text skipped: texting is not part of the company plan',
  notSetUp: 'Text skipped: the phone service is not set up',
  optedOut: 'Text skipped: this number has opted out of texts',
  testOnly: 'Text skipped: this number is not on the test list',
  channelOff: 'Text alerts are switched off',
  spiderOff: 'Text skipped: Spider was switched off',
  interrupted: 'Texts were interrupted by a restart and are not sent again',
} as const;

function textOutcomeFor(reason: CtmSmsFailureReason): string {
  switch (reason) {
    case 'ORG_SMS_DISABLED':
      return TEXT_OUTCOME.companyOff;
    case 'NOT_ENTITLED':
      return TEXT_OUTCOME.notInPlan;
    case 'NOT_CONNECTED':
    case 'SMS_NOT_READY':
    case 'NO_SMS_NUMBER':
      return TEXT_OUTCOME.notSetUp;
    case 'RECIPIENT_OPTED_OUT':
      return TEXT_OUTCOME.optedOut;
    case 'NOT_IN_TEST_ALLOWLIST':
      return TEXT_OUTCOME.testOnly;
    case 'DUPLICATE_SEND':
    case 'CTM_ERROR':
    default:
      return TEXT_OUTCOME.failed;
  }
}

/** One line for the History row: "Email sent (2 of 3)", or the single outcome everyone shared. */
function summarise(outcomes: RecipientOutcome[], sentWord: string): string {
  if (outcomes.length === 0) return 'No one to alert';
  const distinct = [...new Set(outcomes.map((o) => o.outcome))];
  if (distinct.length === 1) return distinct[0];
  const sent = outcomes.filter((o) => o.outcome === sentWord).length;
  return sent > 0 ? `${sentWord} (${sent} of ${outcomes.length})` : distinct.join('; ');
}

// ─── Email ───────────────────────────────────────────────────────────────────

type EmailResult = 'sent' | 'failed' | 'suppressed' | 'org_disabled' | 'no_api_key';

/** Each email result as the History tab records it: the per-person sentence and the per-channel result. */
const EMAIL_RESULT_RECORD: Record<EmailResult, { outcome: string; result: DeliveryResult; reason: string | null }> = {
  sent: { outcome: EMAIL_OUTCOME.sent, result: 'sent', reason: null },
  failed: { outcome: EMAIL_OUTCOME.failed, result: 'failed', reason: EMAIL_REASON.failed },
  suppressed: { outcome: EMAIL_OUTCOME.suppressed, result: 'skipped', reason: EMAIL_REASON.suppressed },
  org_disabled: { outcome: EMAIL_OUTCOME.companyOff, result: 'skipped', reason: EMAIL_REASON.companyOff },
  no_api_key: { outcome: EMAIL_OUTCOME.notSetUp, result: 'skipped', reason: EMAIL_REASON.notSetUp },
};

/**
 * The Spider record an email belongs to: one lead's alert or one starting summary. It names the
 * email in the logs (ids only) and in the tags the send carries, which the provider's delivery
 * events carry back so the webhook can find the record (emailEvents.ts).
 */
export type SpiderEmailRecordKey = { alertId: string } | { summaryId: string };

/** The tag names on a Spider email (letters and underscores, as the provider requires). */
export const SPIDER_EMAIL_TAG = { alert: 'spider_alert_id', summary: 'spider_summary_id' } as const;

/** The tags a Spider email is sent with: the one record it belongs to. */
export function spiderEmailTags(key: SpiderEmailRecordKey): { name: string; value: string }[] {
  return 'alertId' in key
    ? [{ name: SPIDER_EMAIL_TAG.alert, value: key.alertId }]
    : [{ name: SPIDER_EMAIL_TAG.summary, value: key.summaryId }];
}

/** The company details a Spider email is built with. */
export interface SpiderEmailOrg {
  name: string;
  logo_url: string | null;
  brand_color: string | null;
  timezone: string | null;
}

/** The company row a Spider email reads: its email switch and what the email is branded with. */
const EMAIL_ORG_SELECT = { email_sending_enabled: true, name: true, logo_url: true, brand_color: true, timezone: true } as const;
type EmailOrgRow = { email_sending_enabled: boolean } & SpiderEmailOrg;

function readEmailOrg(organizationId: string): Promise<EmailOrgRow | null> {
  return prisma.organization.findUnique({ where: { id: organizationId }, select: EMAIL_ORG_SELECT });
}

/**
 * What every email and text of one company's run of per-lead alerts shares, read at most once for the run (#2992),
 * never once per email or text: the company row (its email switch and branding; its texting switches and plan), the
 * outbound number, and which of the run's people are on the suppression list (one read for all of them). The same reads
 * a send makes on its own, made by the first send that reaches each, and kept for the run; a failed read is not kept,
 * so the next send reads again as it would have. A change to these during the run is seen from the next run (at most
 * one run's alerts later). The per-lead alerts pass the run's; a send that passes none (the starting summary's) reads its own once, for that send.
 */
export interface SpiderSendCompany {
  readonly orgId: string;
  emailOrg(): Promise<EmailOrgRow | null>;
  isSuppressed(to: string): Promise<boolean>;
  text: StaffTextCompany;
}

/** The run's shared reads for one company; `addresses` are every email address the run may send to. */
export function spiderSendCompany(orgId: string, addresses: readonly string[]): SpiderSendCompany {
  const known = new Set(addresses.map(normalizeSuppressionAddress).filter(Boolean));
  const suppressed = onceForTheRun(() => transactionalSuppressedAmong([...known]));
  return {
    orgId,
    emailOrg: onceForTheRun(() => readEmailOrg(orgId)),
    // An address the run did not list is checked on its own, so the answer is always the list's own answer.
    isSuppressed: async (to) => {
      const address = normalizeSuppressionAddress(to);
      if (!known.has(address)) return isTransactionalSendSuppressed(to);
      return (await suppressed()).has(address);
    },
    text: staffTextCompany(prisma, orgId),
  };
}

/** The first call's answer for every later call; a failure is not kept. */
function onceForTheRun<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | null = null;
  return () => {
    kept ??= read().catch((err: unknown) => {
      kept = null;
      throw err;
    });
    return kept;
  };
}

/** One built email: subject, plain-text body and HTML document. */
export interface SpiderEmailMessage {
  subject: string;
  text: string;
  html: string;
}

/** Most emails in one batch request to the provider (its own limit). A longer list goes in further requests. */
export const SPIDER_EMAIL_BATCH_SIZE = 100;

/** Most texts in flight at once for one alert or summary (#3470). */
export const SPIDER_TEXTS_IN_FLIGHT = 5;

/**
 * How long one email batch request may go unanswered before it is given up on (#3469). Without it a request that never
 * answers waits about 300 s (the runtime's own limit, measured). The provider answers a batch in well under a second, so
 * 10 s is far above any normal answer and the same limit a staff text has (lib/ctm/sendSms.ts STAFF_ALERT_SMS_LIMITS).
 * A request given up on is sent once more under the SAME idempotency key (spiderBatchIdempotencyKey), so the provider
 * treats the retry as the first request and it can never send twice; one that again gets no answer is recorded as not
 * delivered. So a stalled provider costs an alert's emails at most 2 x 10 s per batch of SPIDER_EMAIL_BATCH_SIZE.
 */
export const SPIDER_EMAIL_REQUEST_LIMIT_MS = 10_000;
/** Requests given up on that are sent once more (under the same idempotency key) before the batch is recorded not delivered. */
export const SPIDER_EMAIL_UNANSWERED_RETRIES = 1;

let emailRequestLimitMs: number = SPIDER_EMAIL_REQUEST_LIMIT_MS;

/** Tests: a shorter limit on one email batch request, so a stalled provider can be shown in seconds; no argument restores it. */
export function _setSpiderEmailRequestLimit(ms?: number): void {
  emailRequestLimitMs = ms ?? SPIDER_EMAIL_REQUEST_LIMIT_MS;
}

/**
 * The provider refuses a request that repeats an idempotency key while the FIRST request with that key is still being
 * processed: 409 `concurrent_idempotent_requests` (#3471, #3469's r4 L1). Not a failure: the first request may still deliver, so
 * the batch must never be recorded "could not be delivered" for it. It is the same family of answer as the rate limit
 * (a refusal that was not accepted, repeated under the SAME key), so it backs off and repeats the way the rate-limit brake
 * does. The waits add up to about the request limit, so the first request, which was given up on after that long, has had its
 * time. A 409 `invalid_idempotent_request` (the key was used with other content) is a real refusal and is not repeated.
 */
export const CONCURRENT_IDEMPOTENT_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 4_000] as const;

export function isConcurrentIdempotent(error: { name?: string; statusCode?: number | null } | null | undefined): boolean {
  return !!error && error.name === 'concurrent_idempotent_requests';
}

let concurrentBackoffMs: readonly number[] = CONCURRENT_IDEMPOTENT_BACKOFF_MS;

/** Tests: shorter waits after a 409 for a concurrent idempotent request; no argument restores them. */
export function _setConcurrentIdempotentBackoff(ms?: readonly number[]): void {
  concurrentBackoffMs = ms ?? CONCURRENT_IDEMPOTENT_BACKOFF_MS;
}

const UNANSWERED = Symbol('unanswered');

/** The request's answer, or UNANSWERED once `ms` has passed without one. The request is left to settle on its own. */
function answerWithin<T>(request: Promise<T>, ms: number): Promise<T | typeof UNANSWERED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof UNANSWERED>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED), ms);
  });
  // A request given up on may still fail later; nothing waits for it then.
  request.catch(() => undefined);
  return Promise.race([request, limit]).finally(() => clearTimeout(timer));
}

/**
 * The idempotency key of one batch request: the alert or summary and the chunk. The provider treats a second request with
 * the same key as the first, so a request that is repeated (a retry after a refusal, a restart) never sends twice.
 */
export function spiderBatchIdempotencyKey(record: SpiderEmailRecordKey, chunkIndex: number): string {
  return 'alertId' in record ? `spider-alert:${record.alertId}:${chunkIndex}` : `spider-summary:${record.summaryId}:${chunkIndex}`;
}

type BatchEmail = { from: string; to: string; subject: string; text: string; html: string; tags: { name: string; value: string }[] };

/**
 * One batch request, with the same brake on "too many requests" as every other send (lib/email.ts): a refused request was not
 * accepted, and its repeat carries the same idempotency key, so waiting and trying again cannot send twice. Each request is
 * given up on after SPIDER_EMAIL_REQUEST_LIMIT_MS without an answer and sent once more, under the same key; a second request
 * without an answer fails the batch (recorded as not delivered).
 * Permissive validation: one refused address fails that email alone, never the other 99.
 */
async function sendBatch(
  client: NonNullable<typeof resend>,
  emails: BatchEmail[],
  idempotencyKey: string,
  orgId: string,
  record: SpiderEmailRecordKey,
): Promise<{ failed: true } | { failed: false; ids: (string | null)[]; refused: Set<number> }> {
  const options = { idempotencyKey, batchValidation: 'permissive' } as const;
  let attempt = 0;
  let concurrent = 0;
  let unanswered = 0;
  let answer;
  for (;;) {
    const reply = await answerWithin(client.batch.send(emails, options), emailRequestLimitMs);
    if (reply === UNANSWERED) {
      unanswered += 1;
      const retry = unanswered <= SPIDER_EMAIL_UNANSWERED_RETRIES;
      logger.warn('[spider] an email batch request got no answer in time', { orgId, ...record, limitMs: emailRequestLimitMs, retry });
      if (!retry) return { failed: true };
      continue;
    }
    answer = reply;
    // The first request with this key is still being processed: wait and repeat under the same key (see above). The two brakes
    // count their own waits.
    if (isConcurrentIdempotent(answer.error) && concurrent < concurrentBackoffMs.length) {
      concurrent += 1;
      logger.warn('[spider] an email batch request met its own earlier request still in progress: waiting', { orgId, ...record, wait: concurrent });
      await new Promise((resolve) => setTimeout(resolve, concurrentBackoffMs[concurrent - 1]));
      continue;
    }
    attempt += 1;
    if (!isRateLimited(answer.error) || attempt > RATE_LIMIT_BACKOFF_MS.length) break;
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS[attempt - 1]));
  }
  const { data, error } = answer;
  if (error || !data) return { failed: true };
  const body = data as { data?: { id?: string }[]; errors?: { index: number }[] };
  const refused = new Set((body.errors ?? []).map((e) => e.index));
  const accepted = emails.length - refused.size;
  const ids = body.data ?? [];
  // The accepted emails' ids come back in order. If the count is not what it should be, no id can be trusted to belong to a person:
  // the emails are still recorded as sent (the provider accepted the request), without an id.
  if (ids.length !== accepted) {
    logger.warn('[spider] a batch answer did not match the emails sent', { orgId, ...record, sent: emails.length, refused: refused.size, ids: ids.length });
    return { failed: false, ids: emails.map(() => null), refused };
  }
  let next = 0;
  return { failed: false, ids: emails.map((_, i) => (refused.has(i) ? null : ids[next++]?.id ?? null)), refused };
}

/**
 * Emails each recipient the message built for them and records every outcome in plain words, with the provider's id for each
 * email that went out (one id per person). The people who can be emailed go to the provider in batch requests of up to
 * SPIDER_EMAIL_BATCH_SIZE (#3470). The same brakes as every other business send, per person: no address, the company's email
 * switch, the suppression list. A request that fails as a whole records every person in it as not delivered, as a one-by-one
 * send did. `logKey` names the alert or summary in the logs (ids only), on the send and in its idempotency keys.
 */
export async function deliverSpiderEmailsTo(args: {
  orgId: string;
  logKey: SpiderEmailRecordKey;
  recipients: SpiderContact[];
  messageFor: (recipient: SpiderContact, org: SpiderEmailOrg) => SpiderEmailMessage;
  /** The run's shared company reads (spiderSendCompany); omitted, this send reads its own once. */
  company?: SpiderSendCompany;
  /** Told each person's answer the moment it is known (a brake, or their batch request's answer). */
  onPerson?: (person: PersonDelivery) => void;
}): Promise<ChannelDelivery & { results: RecipientResult[] }> {
  const slots: EmailSlot[] = args.recipients.map(() => ({ result: 'failed' as const }));
  const settle = (i: number, slot: EmailSlot) => {
    slots[i] = slot;
    args.onPerson?.(emailPerson(args.recipients[i]!, slot));
  };
  const addressed: number[] = [];
  args.recipients.forEach((r, i) => {
    if (r.email?.trim()) addressed.push(i);
    else settle(i, { result: 'no_address' });
  });

  if (addressed.length > 0 && !resend) {
    for (const i of addressed) settle(i, { result: 'no_api_key' });
  } else if (addressed.length > 0 && resend) {
    const company = args.company?.orgId === args.orgId ? args.company : spiderSendCompany(args.orgId, addressed.map((i) => args.recipients[i]!.email!));
    // The brakes, per person, before anything goes to the provider.
    const toSend: { index: number; message: BatchEmail }[] = [];
    let org: EmailOrgRow | null = null;
    let orgRead = false;
    try {
      org = await company.emailOrg();
      orgRead = true;
    } catch {
      // The company's switch could not be read: nothing is sent (not delivered), as an email that could not read it was.
    }
    if (orgRead) {
      for (const i of addressed) {
        const r = args.recipients[i]!;
        if (!org?.email_sending_enabled) {
          settle(i, { result: 'org_disabled' });
          continue;
        }
        try {
          if (await company.isSuppressed(r.email!.trim())) {
            settle(i, { result: 'suppressed' });
            continue;
          }
          const message = args.messageFor(r, org);
          toSend.push({
            index: i,
            message: {
              from: formatSenderIdentity(SPIDER_EMAIL_SENDER.name, SPIDER_EMAIL_SENDER.address),
              to: r.email!.trim(),
              subject: message.subject,
              text: message.text,
              html: message.html,
              tags: spiderEmailTags(args.logKey),
            },
          });
        } catch {
          settle(i, { result: 'failed' });
        }
      }
    } else {
      for (const i of addressed) settle(i, { result: 'failed' });
    }
    for (let from = 0, chunk = 0; from < toSend.length; from += SPIDER_EMAIL_BATCH_SIZE, chunk += 1) {
      const part = toSend.slice(from, from + SPIDER_EMAIL_BATCH_SIZE);
      let answer: Awaited<ReturnType<typeof sendBatch>>;
      try {
        answer = await sendBatch(resend, part.map((p) => p.message), spiderBatchIdempotencyKey(args.logKey, chunk), args.orgId, args.logKey);
      } catch {
        answer = { failed: true };
      }
      part.forEach((p, k) => {
        if (answer.failed || answer.refused.has(k)) settle(p.index, { result: 'failed' });
        else settle(p.index, answer.ids[k] ? { result: 'sent', messageId: answer.ids[k]! } : { result: 'sent' });
      });
    }
  }

  const outcomes: RecipientOutcome[] = [];
  const results: RecipientResult[] = [];
  args.recipients.forEach((r, i) => {
    const slot = slots[i]!;
    if (slot.result === 'failed') {
      logger.warn('[spider] email was not delivered', { orgId: args.orgId, ...args.logKey, userId: r.id });
    }
    const person = emailPerson(r, slot);
    outcomes.push(person.outcome);
    results.push(person.result);
  });
  return { outcome: summarise(outcomes, EMAIL_OUTCOME.sent), recipients: outcomes, results };
}

type EmailSlot = { result: EmailResult; messageId?: string } | { result: 'no_address' };

/** One person's email answer as both records hold it. */
function emailPerson(r: SpiderContact, slot: EmailSlot): PersonDelivery {
  if (slot.result === 'no_address') {
    return { outcome: { user_id: r.id, outcome: EMAIL_OUTCOME.noAddress }, result: { user_id: r.id, result: 'skipped', reason: EMAIL_REASON.noAddress } };
  }
  const record = EMAIL_RESULT_RECORD[slot.result];
  return {
    outcome: { user_id: r.id, outcome: record.outcome, ...('messageId' in slot && slot.messageId ? { message_id: slot.messageId } : {}) },
    result: { user_id: r.id, result: record.result, reason: record.reason },
  };
}

/**
 * The History tab's one line for an email channel, from its per-person sentences, as a send
 * writes it (exported for emailEvents.ts, which rewrites it when a later event changes a person's).
 */
export function summariseEmail(outcomes: RecipientOutcome[]): string {
  return summarise(outcomes, EMAIL_OUTCOME.sent);
}

/** The History tab's one line for a text channel, from its per-person sentences, as a send writes it. */
export function summariseText(outcomes: RecipientOutcome[]): string {
  return summarise(outcomes, TEXT_OUTCOME.sent);
}

/** One lead's alert email: the contractor's subject, plain-text body and HTML body (messages.ts). */
export async function deliverSpiderEmails(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderMessageContent;
  /** The run's shared company reads (spiderSendCompany). */
  company?: SpiderSendCompany;
  /** Told each person's answer the moment it is known. */
  onPerson?: (person: PersonDelivery) => void;
}): Promise<ChannelDelivery & { results: RecipientResult[] }> {
  return deliverSpiderEmailsTo({
    orgId: args.orgId,
    logKey: { alertId: args.alertId },
    recipients: args.recipients,
    company: args.company,
    onPerson: args.onPerson,
    // The contractor's subject, plain-text body and HTML body, in the company's branded layout with
    // his fallbacks for a company with no name or colour.
    messageFor: (r, org) => ({
      subject: spiderAlertHeader(args.content),
      text: spiderFullTextMessage(args.content),
      html: wrapHtml(spiderAlertEmailHtml(args.content, `${r.first_name ?? ''} ${r.last_name ?? ''}`), {
        name: org.name || 'ServWave Spider Alerts',
        logo_url: org.logo_url ?? null,
        brand_color: org.brand_color || '#0C2D3A',
      }),
    }),
  });
}

// ─── Text ────────────────────────────────────────────────────────────────────

/**
 * Texts each recipient the body built for them, to their own staff phone, through the same gates as
 * every other text. `onSent` runs the moment a text goes out, so the caller can count it toward the
 * company's texting usage before anything else can fail.
 */
export async function deliverSpiderTextsTo(args: {
  orgId: string;
  /** Names the alert or summary: the double-fire guard is per key and person. */
  sendKey: string;
  logKey: Record<string, string>;
  recipients: SpiderContact[];
  /** A body may wait for something about its person (the summary's text says whether the email reached them). */
  bodyFor: (recipient: SpiderContact) => string | Promise<string>;
  onSent: (recipient: SpiderContact) => Promise<void>;
  /** The run's shared company reads (spiderSendCompany); omitted, each text reads its own. */
  company?: SpiderSendCompany;
  /** Told each person's answer the moment it is known (a text sent is told after onSent has counted it). */
  onPerson?: (person: PersonDelivery) => void;
}): Promise<ChannelDelivery & { sent: number; results: RecipientResult[] }> {
  // At most one text per person, whatever the list holds.
  const seen = new Set<string>();
  const people = args.recipients.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const outcomes: RecipientOutcome[] = new Array(people.length);
  const results: RecipientResult[] = new Array(people.length);
  let sent = 0;

  const textOne = async (r: SpiderContact, i: number): Promise<void> => {
    // Staff phones only: the number on the recipient's own user profile. A customer or lead
    // number never reaches this function.
    const toE164 = r.phone ? normalizeNAPhone(r.phone) : null;
    if (!toE164) {
      outcomes[i] = { user_id: r.id, outcome: TEXT_OUTCOME.noPhone };
      results[i] = { user_id: r.id, result: 'skipped', reason: TEXT_REASON.noPhone };
      args.onPerson?.({ outcome: outcomes[i]!, result: results[i]! });
      return;
    }
    const result = await sendStaffAlertSms(prisma, {
      orgId: args.orgId,
      toE164,
      body: await args.bodyFor(r),
      alertKey: `${args.sendKey}:${r.id}`,
      ...(args.company?.orgId === args.orgId ? { company: args.company.text } : {}),
    });
    if (result.delivered) {
      sent += 1;
      outcomes[i] = { user_id: r.id, outcome: TEXT_OUTCOME.sent };
      results[i] = { user_id: r.id, result: 'sent', reason: null };
      await args.onSent(r);
    } else {
      if (result.reason === 'CTM_ERROR') {
        logger.warn('[spider] text was not delivered', { orgId: args.orgId, ...args.logKey, userId: r.id });
      }
      outcomes[i] = { user_id: r.id, outcome: textOutcomeFor(result.reason) };
      results[i] = { user_id: r.id, ...textResultFor(result.reason) };
    }
    args.onPerson?.({ outcome: outcomes[i]!, result: results[i]! });
  };

  // Side by side, at most SPIDER_TEXTS_IN_FLIGHT at a time: each worker takes the next person when it finishes its own.
  let next = 0;
  const worker = async () => {
    while (next < people.length) {
      const i = next++;
      await textOne(people[i]!, i);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(SPIDER_TEXTS_IN_FLIGHT, people.length) }, worker));
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;
  return { outcome: summarise(outcomes, TEXT_OUTCOME.sent), recipients: outcomes, sent, results };
}

/**
 * Starts two pieces of work at the same moment and waits for both: a channel's emails and its texts (#3470). Both always
 * run to the end; if either threw, the first throw is raised after both have stopped, so nothing is left running behind a caller.
 */
export async function runTogether<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const [a, b] = await Promise.allSettled([first(), second()]);
  if (a.status === 'rejected') throw a.reason;
  if (b.status === 'rejected') throw b.reason;
  return [a.value, b.value];
}

/**
 * One lead's alert text: the contractor's full alert text, the same as the email's plain-text body.
 * `onSent` runs the moment each text goes out: the sweep counts it there toward the run's one
 * texting-usage write (#2990, alertLog.ts countSentTexts; comm-usage.ts reads the column).
 */
export async function deliverSpiderTexts(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderMessageContent;
  onSent: () => void;
  /** The run's shared company reads (spiderSendCompany). */
  company?: SpiderSendCompany;
  /** Told each person's answer the moment it is known. */
  onPerson?: (person: PersonDelivery) => void;
}): Promise<ChannelDelivery & { sent: number; results: RecipientResult[] }> {
  const body = spiderFullTextMessage(args.content);
  return deliverSpiderTextsTo({
    orgId: args.orgId,
    sendKey: args.alertId,
    logKey: { alertId: args.alertId },
    recipients: args.recipients,
    bodyFor: () => body,
    onSent: async () => args.onSent(),
    company: args.company,
    onPerson: args.onPerson,
  });
}
