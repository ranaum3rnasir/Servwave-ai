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
import { formatSenderIdentity, resend, wrapHtml } from '../../lib/email';
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
 * one run's alerts later). Only the per-lead alerts use it: every other send passes none and reads as it always has.
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

/**
 * One Spider email. The same brakes as every other business send - the company's email switch
 * and the suppression list - with a fixed sender. Kept separate from the shared dispatcher so
 * that helper is unchanged and so nothing here logs an address. A sent email returns the
 * provider's id for it.
 */
async function sendSpiderEmail(
  organizationId: string,
  to: string,
  record: SpiderEmailRecordKey,
  build: (org: SpiderEmailOrg) => SpiderEmailMessage,
  company?: SpiderSendCompany,
): Promise<{ result: EmailResult; messageId?: string }> {
  if (!resend) return { result: 'no_api_key' };
  // The run's shared reads (spiderSendCompany), when the caller has them; else this email's own, as always.
  const shared = company?.orgId === organizationId ? company : null;
  const org = shared ? await shared.emailOrg() : await readEmailOrg(organizationId);
  if (!org?.email_sending_enabled) return { result: 'org_disabled' };
  if (shared ? await shared.isSuppressed(to) : await isTransactionalSendSuppressed(to)) return { result: 'suppressed' };
  const message = build(org);
  const { data, error } = await resend.emails.send({
    from: formatSenderIdentity(SPIDER_EMAIL_SENDER.name, SPIDER_EMAIL_SENDER.address),
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    tags: spiderEmailTags(record),
  });
  if (error) return { result: 'failed' };
  return data?.id ? { result: 'sent', messageId: data.id } : { result: 'sent' };
}

/**
 * Emails each recipient the message built for them, through sendSpiderEmail's brakes, and records
 * every outcome in plain words, with the provider's id for each email that went out (one id per
 * person). `logKey` names the alert or summary in the logs (ids only) and on the send.
 */
export async function deliverSpiderEmailsTo(args: {
  orgId: string;
  logKey: SpiderEmailRecordKey;
  recipients: SpiderContact[];
  messageFor: (recipient: SpiderContact, org: SpiderEmailOrg) => SpiderEmailMessage;
  /** The run's shared company reads (spiderSendCompany); omitted, each email reads its own. */
  company?: SpiderSendCompany;
}): Promise<ChannelDelivery & { results: RecipientResult[] }> {
  const outcomes: RecipientOutcome[] = [];
  const results: RecipientResult[] = [];
  for (const r of args.recipients) {
    if (!r.email?.trim()) {
      outcomes.push({ user_id: r.id, outcome: EMAIL_OUTCOME.noAddress });
      results.push({ user_id: r.id, result: 'skipped', reason: EMAIL_REASON.noAddress });
      continue;
    }
    let sent: { result: EmailResult; messageId?: string };
    try {
      sent = await sendSpiderEmail(args.orgId, r.email.trim(), args.logKey, (org) => args.messageFor(r, org), args.company);
    } catch {
      sent = { result: 'failed' };
    }
    if (sent.result === 'failed') {
      logger.warn('[spider] email was not delivered', { orgId: args.orgId, ...args.logKey, userId: r.id });
    }
    const record = EMAIL_RESULT_RECORD[sent.result];
    outcomes.push({ user_id: r.id, outcome: record.outcome, ...(sent.messageId ? { message_id: sent.messageId } : {}) });
    results.push({ user_id: r.id, result: record.result, reason: record.reason });
  }
  return { outcome: summarise(outcomes, EMAIL_OUTCOME.sent), recipients: outcomes, results };
}

/**
 * The History tab's one line for an email channel, from its per-person sentences, as a send
 * writes it (exported for emailEvents.ts, which rewrites it when a later event changes a person's).
 */
export function summariseEmail(outcomes: RecipientOutcome[]): string {
  return summarise(outcomes, EMAIL_OUTCOME.sent);
}

/** One lead's alert email: the contractor's subject, plain-text body and HTML body (messages.ts). */
export async function deliverSpiderEmails(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderMessageContent;
  /** The run's shared company reads (spiderSendCompany). */
  company?: SpiderSendCompany;
}): Promise<ChannelDelivery & { results: RecipientResult[] }> {
  return deliverSpiderEmailsTo({
    orgId: args.orgId,
    logKey: { alertId: args.alertId },
    recipients: args.recipients,
    company: args.company,
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
  bodyFor: (recipient: SpiderContact) => string;
  onSent: (recipient: SpiderContact) => Promise<void>;
  /** The run's shared company reads (spiderSendCompany); omitted, each text reads its own. */
  company?: SpiderSendCompany;
}): Promise<ChannelDelivery & { sent: number; results: RecipientResult[] }> {
  const outcomes: RecipientOutcome[] = [];
  const results: RecipientResult[] = [];
  let sent = 0;
  for (const r of args.recipients) {
    // Staff phones only: the number on the recipient's own user profile. A customer or lead
    // number never reaches this function.
    const toE164 = r.phone ? normalizeNAPhone(r.phone) : null;
    if (!toE164) {
      outcomes.push({ user_id: r.id, outcome: TEXT_OUTCOME.noPhone });
      results.push({ user_id: r.id, result: 'skipped', reason: TEXT_REASON.noPhone });
      continue;
    }
    const result = await sendStaffAlertSms(prisma, {
      orgId: args.orgId,
      toE164,
      body: args.bodyFor(r),
      alertKey: `${args.sendKey}:${r.id}`,
      ...(args.company?.orgId === args.orgId ? { company: args.company.text } : {}),
    });
    if (result.delivered) {
      sent += 1;
      outcomes.push({ user_id: r.id, outcome: TEXT_OUTCOME.sent });
      results.push({ user_id: r.id, result: 'sent', reason: null });
      await args.onSent(r);
    } else {
      if (result.reason === 'CTM_ERROR') {
        logger.warn('[spider] text was not delivered', { orgId: args.orgId, ...args.logKey, userId: r.id });
      }
      outcomes.push({ user_id: r.id, outcome: textOutcomeFor(result.reason) });
      results.push({ user_id: r.id, ...textResultFor(result.reason) });
    }
  }
  return { outcome: summarise(outcomes, TEXT_OUTCOME.sent), recipients: outcomes, sent, results };
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
  });
}
