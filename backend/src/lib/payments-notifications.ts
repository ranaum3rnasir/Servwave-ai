import { alertSwitchHolders, isNoRecordAlertVerb } from '../services/notifications/noRecordAlerts';
import { stepHolderEmails } from '../services/notifications/stepHolderEmails';
import { WHY_KEY } from '../services/notifications/alertChain';
import { prisma } from './prisma';
import { env } from '../config/env';
import { sendPaymentsActionNeededEmail } from './email';
import { logger } from './logger';
import { PAYOUT_ACCOUNT_PATH } from './owner-payment-notices';

/**
 * Payments account notifications. Both writers of the account status (the account events through
 * the payment event reconciler, and the status refresh) decide them in one place
 * (services/payment-reconciler/decide.ts, decideAccountStatusSync) and send them here, after the
 * status they describe has committed. Every notice carries a dedup key per account, so the two
 * writers seeing the same change send one notification.
 *
 * Who is told (Roles & Permissions, S06.29): the active holders of Company settings, else the holders of Manage roles and
 * permissions (noRecordAlerts.ts), in the bell and in the email alike. Nobody comes from a role name.
 */

export function paymentsNotifDedupKey(verb: string, dedup: string): string {
  return `${verb}:${dedup}`;
}

export async function emitPaymentsNotif(
  verb: string, orgId: string, orgName: string | null, dedup: string, data: Record<string, string> = {},
): Promise<void> {
  if (!isNoRecordAlertVerb(verb)) throw new Error(`"${verb}" is not a payments account alert`);
  await alertSwitchHolders({
    verb, organizationId: orgId, actorId: null,
    object: { type: 'ORGANIZATION', id: orgId, label: orgName ?? 'ServWave Payments' },
    // Slice 33b: every account notice opens the ServWave Payments settings page (payout account card), where the owner acts on it.
    data: { link_path: PAYOUT_ACCOUNT_PATH, ...data }, dedupKey: paymentsNotifDedupKey(verb, dedup),
  });
}

/**
 * What the owner does about the requirements the account reports, in ServWave's words (never the
 * processor's own codes, which mean nothing to an owner).
 */
export function whatToDoAbout(requirements: readonly string[]): string {
  const identity = requirements.some((r) => /^(individual|person|representative|company\.(owners|directors|executives))\b/.test(r) || /verification/.test(r));
  const bank = requirements.includes('external_account');
  const steps = [
    identity ? 'confirm the identity details ServWave Payments asks for, such as the owner\'s ID document' : '',
    bank ? 'check your bank account details' : '',
  ].filter(Boolean);
  if (steps.length === 0) return 'Open Settings > ServWave Payments and finish the missing details.';
  return `Open Settings > ServWave Payments and ${steps.join(', then ')}.`;
}

export interface AccountNoticeToSend {
  verb: string;
  organizationId: string;
  dedup: string;
  /** The occurrence also emails the people it reaches (the Company settings holders, else the managers), the first time it is notified. */
  emailAdmins: boolean;
  /** Action-needed: the requirements it is about; the notice says what to do about them. */
  requirements?: readonly string[];
}

/**
 * Send payments-account notices. Guarded like every other notification dispatch: the status is
 * already stored (and the event recorded, so the processor will not deliver it again), so a failed
 * emit or email is logged, never thrown.
 */
export async function sendAccountNotices(notices: readonly AccountNoticeToSend[], orgName: string | null): Promise<void> {
  // The action-needed and paused notices share one email: an answer that carries both sends each
  // admin that email once, not once per notice.
  const emailed = new Set<string>();
  for (const notice of notices) {
    // Checked BEFORE the emit, which would itself insert the row: a re-delivered event with the
    // same requirements must not email again.
    const alreadyNotified = notice.emailAdmins
      ? await notificationAlreadyExists(notice.organizationId, paymentsNotifDedupKey(notice.verb, notice.dedup))
        .catch((err) => { logger.error(`Failed to check ${notice.verb} notification:`, err); return true; })
      : true;
    await emitPaymentsNotif(
      notice.verb, notice.organizationId, orgName, notice.dedup,
      notice.requirements && notice.requirements.length > 0 ? { what_to_do: whatToDoAbout(notice.requirements) } : {},
    )
      .catch((err) => logger.error(`Failed to emit ${notice.verb} notification:`, err));
    if (!alreadyNotified && !emailed.has(notice.organizationId)) {
      emailed.add(notice.organizationId);
      await emailActionNeededToHolders(notice.organizationId, orgName)
        .catch((err) => logger.error('Failed to send payments action-needed email:', err));
    }
  }
}

async function notificationAlreadyExists(orgId: string, dedupKey: string): Promise<boolean> {
  // The alert keeps its key for the people who hold Company settings and suffixes it for the managers who cover when nobody does.
  const existing = await prisma.notification.findFirst({ where: { organization_id: orgId, dedup_key: { in: [dedupKey, dedupKey + WHY_KEY] } } });
  return !!existing;
}

/** The co-branded action-needed email to the people the alert reaches: the holders of Company settings, else of Manage roles and permissions. */
async function emailActionNeededToHolders(orgId: string, orgName: string | null): Promise<void> {
  const recipients = await stepHolderEmails({
    organizationId: orgId,
    stepSwitch: 'company_settings',
    record: null,
    words: { record: 'company', step: 'change company settings', alert: 'payments action needed email' },
  });
  const fixUrl = `${env.FRONTEND_URL}${PAYOUT_ACCOUNT_PATH}`;
  for (const email of recipients) {
    sendPaymentsActionNeededEmail({
      organizationId: orgId,
      to: email,
      orgName: orgName ?? 'your organization',
      fixUrl,
    }).catch(() => {});
  }
}
