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
import { isTransactionalSendSuppressed } from '../../lib/email-suppression';
import { normalizeNAPhone } from '../../lib/comms-identity';
import { sendStaffAlertSms, type CtmSmsFailureReason } from '../../lib/ctm/sendSms';
import type { SpiderRecipient } from './recipients';
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
} as const;

export const TEXT_REASON = {
  noPhone: 'no phone number',
  failed: 'Text message delivery failed',
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

/** The company details a Spider email is built with. */
export interface SpiderEmailOrg {
  name: string;
  logo_url: string | null;
  brand_color: string | null;
  timezone: string | null;
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
 * that helper is unchanged and so nothing here logs an address.
 */
async function sendSpiderEmail(
  organizationId: string,
  to: string,
  build: (org: SpiderEmailOrg) => SpiderEmailMessage,
): Promise<EmailResult> {
  if (!resend) return 'no_api_key';
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { email_sending_enabled: true, name: true, logo_url: true, brand_color: true, timezone: true },
  });
  if (!org?.email_sending_enabled) return 'org_disabled';
  if (await isTransactionalSendSuppressed(to)) return 'suppressed';
  const message = build(org);
  const { error } = await resend.emails.send({
    from: formatSenderIdentity(SPIDER_EMAIL_SENDER.name, SPIDER_EMAIL_SENDER.address),
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return error ? 'failed' : 'sent';
}

/**
 * Emails each recipient the message built for them, through sendSpiderEmail's brakes, and records
 * every outcome in plain words. `logKey` names the alert or summary in the logs (ids only).
 */
export async function deliverSpiderEmailsTo(args: {
  orgId: string;
  logKey: Record<string, string>;
  recipients: SpiderRecipient[];
  messageFor: (recipient: SpiderRecipient, org: SpiderEmailOrg) => SpiderEmailMessage;
}): Promise<ChannelDelivery & { results: RecipientResult[] }> {
  const outcomes: RecipientOutcome[] = [];
  const results: RecipientResult[] = [];
  for (const r of args.recipients) {
    if (!r.email?.trim()) {
      outcomes.push({ user_id: r.id, outcome: EMAIL_OUTCOME.noAddress });
      results.push({ user_id: r.id, result: 'skipped', reason: EMAIL_REASON.noAddress });
      continue;
    }
    let result: EmailResult;
    try {
      result = await sendSpiderEmail(args.orgId, r.email.trim(), (org) => args.messageFor(r, org));
    } catch {
      result = 'failed';
    }
    if (result === 'failed') {
      logger.warn('[spider] email was not delivered', { orgId: args.orgId, ...args.logKey, userId: r.id });
    }
    outcomes.push({
      user_id: r.id,
      outcome: {
        sent: EMAIL_OUTCOME.sent,
        failed: EMAIL_OUTCOME.failed,
        suppressed: EMAIL_OUTCOME.suppressed,
        org_disabled: EMAIL_OUTCOME.companyOff,
        no_api_key: EMAIL_OUTCOME.notSetUp,
      }[result],
    });
    results.push({
      user_id: r.id,
      ...({
        sent: { result: 'sent', reason: null },
        failed: { result: 'failed', reason: EMAIL_REASON.failed },
        suppressed: { result: 'skipped', reason: EMAIL_REASON.suppressed },
        org_disabled: { result: 'skipped', reason: EMAIL_REASON.companyOff },
        no_api_key: { result: 'skipped', reason: EMAIL_REASON.notSetUp },
      } as const)[result],
    });
  }
  return { outcome: summarise(outcomes, EMAIL_OUTCOME.sent), recipients: outcomes, results };
}

/** One lead's alert email: the contractor's subject, plain-text body and HTML body (messages.ts). */
export async function deliverSpiderEmails(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderMessageContent;
}): Promise<ChannelDelivery & { results: RecipientResult[] }> {
  return deliverSpiderEmailsTo({
    orgId: args.orgId,
    logKey: { alertId: args.alertId },
    recipients: args.recipients,
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
  recipients: SpiderRecipient[];
  bodyFor: (recipient: SpiderRecipient) => string;
  onSent: (recipient: SpiderRecipient) => Promise<void>;
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

/** One lead's alert text: the contractor's full alert text, the same as the email's plain-text body. */
export async function deliverSpiderTexts(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderMessageContent;
}): Promise<ChannelDelivery & { sent: number; results: RecipientResult[] }> {
  const body = spiderFullTextMessage(args.content);
  return deliverSpiderTextsTo({
    orgId: args.orgId,
    sendKey: args.alertId,
    logKey: { alertId: args.alertId },
    recipients: args.recipients,
    bodyFor: () => body,
    // Counted the moment it went out, so a later failure to record the delivery cannot leave a
    // sent text outside the company's texting usage (comm-usage.ts reads this column).
    onSent: () =>
      prisma.spiderAlert
        .update({ where: { id: args.alertId }, data: { texts_sent: { increment: 1 } } })
        .then(
          () => undefined,
          () => {
            logger.error(`[spider] could not count a sent text for alert ${args.alertId}`);
          },
        ),
  });
}
