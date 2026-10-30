/**
 * Payments go-live slice 32 - the owner's payment notifications.
 *
 * One call per payment event that needs the owner: an in-app notification (the bell and, for the
 * ones that interrupt, a toast) and an email to the people who handle it, both worded from the same
 * template so they cannot disagree. Deduplicated per event: the notification's dedup key is the
 * guard, and the email goes out only when this call is the one that created the notification, so a
 * replayed event neither notifies nor emails twice. Best-effort and post-commit by contract: it
 * never throws, and an alert must never point at money that rolled back. Copy names no vendor.
 */
import { env } from '../config/env';
import { logger } from './logger';
import { sendOwnerPaymentNoticeEmail } from './email';
import { alertInvoice, isBillingAlertVerb } from '../services/notifications/invoiceBillingAlerts';
import { stepHolderEmails } from '../services/notifications/stepHolderEmails';
import { renderTemplate } from '../services/notifications/templates';

/** Where the owner acts on a payment event that is not about one invoice: the Payments page, on its attention view. */
export const PAYMENTS_ATTENTION_PATH = '/payments?tab=payments&chip=attention';

/** Slice 33b: where the owner acts on the payout account (the "account action needed" notices). */
export const PAYOUT_ACCOUNT_PATH = '/settings/payout-account';
/** Slice 33b: the Payments page on its disputed view, where a dispute is answered. */
export const DISPUTES_PATH = '/payments?tab=payments&chip=disputed';
const DISPUTE_VERBS = new Set(['billing.disputed', 'billing.chargeback', 'billing.dispute_closed']);

export interface OwnerPaymentNotice {
  verb: string;
  organizationId: string;
  object: { type: 'INVOICE' | 'ORGANIZATION'; id: string; label: string };
  /** Template data. `link_path`, when set, is also where the bell and the email send the owner. */
  data: Record<string, string>;
  /** One notification (and one email) per key. */
  dedupKey: string;
  /** The email button. */
  actionLabel: string;
}

/** The app path a notice points at: its own link, else the invoice, else the Payments page. */
export function noticePath(notice: Pick<OwnerPaymentNotice, 'object' | 'data'>): string {
  if (notice.data.link_path) return notice.data.link_path;
  return notice.object.type === 'INVOICE' ? `/invoices/${notice.object.id}` : PAYMENTS_ATTENTION_PATH;
}

export async function notifyOwners(notice: OwnerPaymentNotice): Promise<void> {
  try {
    const { verb, organizationId, object, dedupKey } = notice;
    if (!isBillingAlertVerb(verb)) throw new Error(`"${verb}" is not a billing alert`);
    // A dispute notice opens the disputes tab, in the bell and in the email alike.
    const data = DISPUTE_VERBS.has(verb) && !notice.data.link_path ? { ...notice.data, link_path: DISPUTES_PATH } : notice.data;
    // Told through M6's two lanes (S06.28): the invoice's people and whoever handles billing, who can open the invoice. Money that no
    // invoice of the company carries (object type ORGANIZATION) has no people and goes to the billing holders.
    const notified = await alertInvoice({ verb, organizationId, actorId: null, object, data, dedupKey });
    // Nobody was notified: a replay (the key exists) or no one to tell. No email either way.
    if (notified.length === 0) return;
    const template = renderTemplate(verb, { ...data, object_label: object.label });
    // Ruled (Ran): a money alert is not optional for the people who handle it. The email goes to the active holders of Access Billing
    // who can open the invoice (the payments-account and unplaced-money notices have no invoice to open), else the holders of Manage
    // roles and permissions: the people the bell's step 2 and step 3 reach, no role name and no copy holders (S06.29).
    const recipients = await stepHolderEmails({
      organizationId,
      stepSwitch: 'access_billing',
      record: object.type === 'INVOICE' ? { type: 'INVOICE', id: object.id } : null,
      words: { record: 'invoice', step: 'access billing', alert: 'owner payment email' },
    });
    const actionUrl = `${env.FRONTEND_URL}${noticePath({ object, data })}`;
    // One at a time: a burst to a large team would trip the mail service's per-second limit.
    // A refused send is retried by the shared sender; a send that still fails is logged there and
    // never stops the next person's email or the caller.
    for (const email of recipients) {
      await sendOwnerPaymentNoticeEmail({
        organizationId,
        to: email,
        subject: template.title,
        heading: template.title,
        lines: template.body ? [template.body] : [],
        actionUrl,
        actionLabel: notice.actionLabel,
      });
    }
  } catch (err) {
    logger.error(`Failed to notify the owners of org ${notice.organizationId} (${notice.verb}):`, err);
  }
}
