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
import { esc, formatSenderIdentity, resend } from '../../lib/email';
import { isTransactionalSendSuppressed } from '../../lib/email-suppression';
import { normalizeNAPhone } from '../../lib/comms-identity';
import { sendStaffAlertSms, type CtmSmsFailureReason } from '../../lib/ctm/sendSms';
import type { SpiderRecipient } from './recipients';

/** The one fixed sender every Spider email goes out as. No caller can choose another. */
export const SPIDER_EMAIL_SENDER = { name: 'ServWave Spider Alerts', address: 'alerts@spider.servwave.com' } as const;

export interface SpiderAlertContent {
  leadNumber: string;
  customerName: string;
  statusLabel: string;
  timeInStatus: string;
  address: string | null;
  ownerName: string | null;
  leadUrl: string;
}

export interface RecipientOutcome {
  user_id: string;
  outcome: string;
}

export interface ChannelDelivery {
  outcome: string;
  recipients?: RecipientOutcome[];
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

// ─── Message text ────────────────────────────────────────────────────────────

export function alertHeadline(c: SpiderAlertContent): string {
  return `${c.leadNumber} has been in ${c.statusLabel} for ${c.timeInStatus}`;
}

export function alertText(c: SpiderAlertContent): string {
  return [
    `Spider alert: ${alertHeadline(c)}.`,
    `Customer: ${c.customerName}`,
    c.address ? `Address: ${c.address}` : null,
    `Owner: ${c.ownerName ?? 'No owner'}`,
    `Open the lead: ${c.leadUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function alertHtml(c: SpiderAlertContent): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;color:#64748b;">${esc(label)}</td><td style="padding:6px 12px;">${esc(value)}</td></tr>`;
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
<p style="font-size:16px;font-weight:bold;">${esc(alertHeadline(c))}</p>
<table style="border-collapse:collapse;font-size:14px;">
${row('Customer', c.customerName)}
${row('Lead', c.leadNumber)}
${row('Status', c.statusLabel)}
${row('Time in status', c.timeInStatus)}
${c.address ? row('Address', c.address) : ''}
${row('Owner', c.ownerName ?? 'No owner')}
</table>
<p><a href="${esc(c.leadUrl)}">Open the lead</a></p>
<p style="font-size:12px;color:#64748b;">You are receiving this because your company set up Spider, ServWave's lead watcher, to alert you.</p>
</body></html>`;
}

// ─── Email ───────────────────────────────────────────────────────────────────

type EmailResult = 'sent' | 'failed' | 'suppressed' | 'org_disabled' | 'no_api_key';

/**
 * One Spider email. The same brakes as every other business send - the company's email switch
 * and the suppression list - with a fixed sender. Kept separate from the shared dispatcher so
 * that helper is unchanged and so nothing here logs an address.
 */
async function sendSpiderEmail(organizationId: string, to: string, c: SpiderAlertContent): Promise<EmailResult> {
  if (!resend) return 'no_api_key';
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { email_sending_enabled: true },
  });
  if (!org?.email_sending_enabled) return 'org_disabled';
  if (await isTransactionalSendSuppressed(to)) return 'suppressed';
  const { error } = await resend.emails.send({
    from: formatSenderIdentity(SPIDER_EMAIL_SENDER.name, SPIDER_EMAIL_SENDER.address),
    to,
    subject: `Spider alert: ${alertHeadline(c)}`,
    text: alertText(c),
    html: alertHtml(c),
  });
  return error ? 'failed' : 'sent';
}

export async function deliverSpiderEmails(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderAlertContent;
}): Promise<ChannelDelivery> {
  const outcomes: RecipientOutcome[] = [];
  for (const r of args.recipients) {
    if (!r.email?.trim()) {
      outcomes.push({ user_id: r.id, outcome: EMAIL_OUTCOME.noAddress });
      continue;
    }
    let result: EmailResult;
    try {
      result = await sendSpiderEmail(args.orgId, r.email.trim(), args.content);
    } catch {
      result = 'failed';
    }
    if (result === 'failed') {
      logger.warn('[spider] alert email was not delivered', { orgId: args.orgId, alertId: args.alertId, userId: r.id });
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
  }
  return { outcome: summarise(outcomes, EMAIL_OUTCOME.sent), recipients: outcomes };
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** Texts are short: the headline and the link. */
export function alertSms(c: SpiderAlertContent): string {
  return `Spider alert: ${alertHeadline(c)} (${c.customerName}). ${c.leadUrl}`;
}

export async function deliverSpiderTexts(args: {
  orgId: string;
  alertId: string;
  recipients: SpiderRecipient[];
  content: SpiderAlertContent;
}): Promise<ChannelDelivery & { sent: number }> {
  const outcomes: RecipientOutcome[] = [];
  let sent = 0;
  const body = alertSms(args.content);
  for (const r of args.recipients) {
    // Staff phones only: the number on the recipient's own user profile. A customer or lead
    // number never reaches this function.
    const toE164 = r.phone ? normalizeNAPhone(r.phone) : null;
    if (!toE164) {
      outcomes.push({ user_id: r.id, outcome: TEXT_OUTCOME.noPhone });
      continue;
    }
    const result = await sendStaffAlertSms(prisma, {
      orgId: args.orgId,
      toE164,
      body,
      alertKey: `${args.alertId}:${r.id}`,
    });
    if (result.delivered) {
      sent += 1;
      outcomes.push({ user_id: r.id, outcome: TEXT_OUTCOME.sent });
      // Counted the moment it went out, so a later failure to record the delivery cannot leave a
      // sent text outside the company's texting usage (comm-usage.ts reads this column).
      await prisma.spiderAlert
        .update({ where: { id: args.alertId }, data: { texts_sent: { increment: 1 } } })
        .catch(() => logger.error(`[spider] could not count a sent text for alert ${args.alertId}`));
    } else {
      if (result.reason === 'CTM_ERROR') {
        logger.warn('[spider] alert text was not delivered', { orgId: args.orgId, alertId: args.alertId, userId: r.id });
      }
      outcomes.push({ user_id: r.id, outcome: textOutcomeFor(result.reason) });
    }
  }
  return { outcome: summarise(outcomes, TEXT_OUTCOME.sent), recipients: outcomes, sent };
}
