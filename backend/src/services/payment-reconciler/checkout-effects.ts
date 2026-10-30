/**
 * Payments go-live slice 08 - what follows a completed card checkout once its ledger changes have
 * committed: the owner's alert for money not applied, and for a booked payment the fee capture,
 * the first-payment nudge, audit, automation, the customer's emails and the in-app notification.
 *
 * Moved from the webhook controller's checkout branch unchanged in substance. Everything here is
 * post-commit on purpose: an alert, an email or an automation must never point at money that
 * rolled back. Copy that reaches people names no processor.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { logAudit } from '../../lib/audit';
import { env } from '../../config/env';
import { captureStripeFees } from '../../lib/reconcile-stripe-fees';
import { alertUnappliedCapture } from '../../lib/unapplied-capture';
import { afterPaymentSettled } from '../../lib/payment-ledger';
import { bankPaymentDisplay, cardPaymentDisplay } from '../../lib/payment-method-display';
import { closeOpenCheckoutLinks } from '../../lib/invoice-checkout-expiry';
import {
  sendDepositPaymentConfirmation, sendDepositPaidAlert, sendPaymentReceivedEmail, sendEstimateApprovedNotification,
  sendBankPaymentProcessingEmail, sendBankPaymentFailedEmail,
} from '../../lib/email';
import { loadOptionSummary, optionSummaryData } from '../../lib/estimates/optionSummary';
import { alertSwitchHolders } from '../notifications/noRecordAlerts';
import { alertEstimate } from '../notifications/leadEstimateAlerts';
import { alertInvoice } from '../notifications/invoiceBillingAlerts';
import { notifyOwners } from '../../lib/owner-payment-notices';
import { dispatchAutomationEvent } from '../automations/dispatch';
import type { AppliedEffects, BookedPayment } from './apply';

/** The invoice details the post-commit effects need (customer, job, estimate). Read before the transaction. */
export const CHECKOUT_INVOICE_SELECT = {
  id: true,
  invoice_number: true,
  status: true,
  kind: true,
  amount_due: true,
  total_amount: true,
  organization_id: true,
  // The page the customer pays from; a failed bank payment sends them back to it (slice 31).
  public_token: true,
  // Top-level customer (job-less invoices) with job.customer fallback for legacy rows.
  customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } },
  job: {
    select: {
      id: true,
      job_number: true,
      customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } },
    },
  },
  // The org's deposit defaults, so a deposit's hold reason can be resolved.
  organization: {
    select: { deposit_default_type: true, deposit_default_percentage: true, deposit_default_fixed_amount: true },
  },
  estimate: {
    select: {
      id: true, lead_id: true, estimate_number: true, total_amount: true, status: true, public_token: true,
      modified_after_send: true, deposit_type: true, deposit_value: true,
      creator: { select: { email: true } },
      organization: { select: { name: true, logo_url: true, brand_color: true } },
      customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
      lead: { select: { commission_owner_id: true, customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } } } },
    },
  },
} satisfies Prisma.InvoiceSelect;

export type CheckoutInvoice = Prisma.InvoiceGetPayload<{ select: typeof CHECKOUT_INVOICE_SELECT }>;

export interface CheckoutEffectsContext {
  organization: { id: string; name: string | null; stripe_payouts_enabled: boolean };
  /** The connected account the event arrived on; undefined = a legacy platform-account charge. */
  account: string | undefined;
  paymentIntentId: string | null;
  invoice: CheckoutInvoice | null;
}

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

export async function runCheckoutEffects(effects: AppliedEffects, ctx: CheckoutEffectsContext): Promise<void> {
  for (const capture of effects.unappliedCaptures) await alertUnappliedCapture(capture);
  for (const settled of effects.settledPayments) await afterPaymentSettled(settled, ctx.organization.id);
  // Slice 14: a payment was booked (a card paid, a bank debit started or cleared), so every other
  // link still open for the invoice is closed: the customer cannot pay the same balance twice. One
  // that is paid anyway is written down by the reconciler (it no longer matches payable-now).
  if (effects.expireCheckouts.length > 0) {
    await closeOpenCheckoutLinks(ctx.organization.id, effects.expireCheckouts.map((id) => ({ id })), 'online_payment');
  }
  for (const booked of effects.bookedPayments) {
    if (!ctx.invoice || ctx.invoice.id !== booked.invoiceId) continue;
    if (booked.method === 'ACH') await afterBankPaymentBooked(booked, ctx.invoice);
    else await afterPaymentBooked(booked, ctx.invoice, ctx);
  }
  // Slice 31 tells the customer; slice 32 tells the owner.
  for (const notice of effects.bankNotices) {
    logger.info(`Bank payment ${notice.kind} on invoice ${notice.invoiceId} (org ${ctx.organization.id}): ${notice.amountCents} cents`
      + `${notice.deposit ? ', deposit' : ''}${notice.payAgain ? ', customer to be sent a pay-again link' : ''}`);
  }
  await notifyOwnersOfBankPayments(effects, ctx);
  await emailBankNoticesToCustomer(effects, ctx);
}

const BANK_NOTICE_VERBS = {
  started: 'billing.bank_payment_started',
  cleared: 'billing.bank_payment_cleared',
  failed: 'billing.bank_payment_failed',
} as const;

/** The name staff know the invoice's customer by, whether or not they have an email address. */
function customerLabel(invoice: CheckoutInvoice): string {
  const est = invoice.estimate;
  const customer = invoice.customer ?? invoice.job?.customer ?? est?.lead?.customer ?? est?.customer ?? null;
  if (!customer) return '';
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || '';
}

/**
 * Slice 32: the owner hears when a bank payment starts, clears and fails, in-app and by email. Each
 * notice is keyed on the ledger event that caused it, so a replay sends nothing; a notice this event
 * did not cause never reaches here (applyActions drops it).
 */
async function notifyOwnersOfBankPayments(effects: AppliedEffects, ctx: CheckoutEffectsContext): Promise<void> {
  const invoice = ctx.invoice;
  if (!invoice) return;
  const customerName = customerLabel(invoice);
  for (const notice of effects.bankNotices) {
    if (notice.invoiceId !== invoice.id) continue;
    const verb = BANK_NOTICE_VERBS[notice.kind];
    await notifyOwners({
      verb,
      organizationId: invoice.organization_id,
      object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
      data: {
        amount: (notice.amountCents / 100).toFixed(2),
        ...(customerName ? { customer_name: customerName } : {}),
        ...(notice.payAgain ? { pay_again: 'yes' } : {}),
      },
      dedupKey: `${verb}:${notice.eventId}`,
      actionLabel: 'Open the invoice',
    });
  }
}

/** The customer a bank payment's emails go to: the invoice's, else its job's, else its estimate's. */
function noticeCustomer(invoice: CheckoutInvoice) {
  const est = invoice.estimate;
  const customer = invoice.customer ?? invoice.job?.customer ?? est?.lead?.customer ?? est?.customer ?? null;
  if (!customer?.email) return null;
  return {
    id: customer.id,
    email: customer.email,
    name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Customer',
  };
}

/**
 * The page a customer pays from: the estimate's for a deposit that has a live link, else the
 * invoice's. Null when neither has a link to send them back to.
 */
export function payAgainUrl(invoice: { id: string; kind: string; public_token: string | null; estimate: { id: string; public_token: string | null } | null }): string | null {
  const base = env.FRONTEND_URL || '';
  const est = invoice.estimate;
  if (invoice.kind === 'DEPOSIT' && est?.public_token) return `${base}/p/estimates/${est.id}?token=${est.public_token}`;
  if (invoice.public_token) return `${base}/p/invoices/${invoice.id}?token=${invoice.public_token}`;
  return null;
}

/**
 * Slice 31: the customer who pays by bank hears when the debit starts (processing), clears (the
 * receipt) and fails (a link to pay again). Post-commit and never throws: the senders swallow their
 * own errors, and an email problem must not fail the event that settled the money. Each ledger
 * event is applied once, so each notice is sent once.
 */
async function emailBankNoticesToCustomer(effects: AppliedEffects, ctx: CheckoutEffectsContext): Promise<void> {
  const invoice = ctx.invoice;
  if (!invoice) return;
  const customer = noticeCustomer(invoice);
  if (!customer) return;
  const record = {
    organizationId: invoice.organization_id,
    customerId: customer.id,
    jobId: invoice.job?.id,
    jobLabel: invoice.job?.job_number,
    entityType: 'invoice' as const,
    entityId: invoice.id,
  };
  const common = { organizationId: invoice.organization_id, to: customer.email, customerName: customer.name, invoiceNumber: invoice.invoice_number, record };
  for (const notice of effects.bankNotices) {
    if (notice.invoiceId !== invoice.id) continue;
    const amount = notice.amountCents / 100;
    if (notice.kind === 'started') {
      await sendBankPaymentProcessingEmail({ ...common, amount });
    } else if (notice.kind === 'failed') {
      // A failure on an invoice no longer open for payment owes the customer nothing to retry.
      if (!notice.payAgain) continue;
      const payUrl = payAgainUrl(invoice);
      await sendBankPaymentFailedEmail({ ...common, amount, ...(payUrl ? { payUrl } : {}) });
    } else {
      await emailBankReceipt(effects, invoice, common);
    }
  }
}

/** The receipt for a bank payment that cleared: what was applied, the tip and the bank, as the customer knows it. */
async function emailBankReceipt(
  effects: AppliedEffects,
  invoice: CheckoutInvoice,
  common: Omit<Parameters<typeof sendPaymentReceivedEmail>[0], 'amount' | 'method' | 'newBalance'>,
): Promise<void> {
  const booked = effects.bookedPayments.find((b) => b.invoiceId === invoice.id && b.method === 'ACH' && b.state === 'SUCCEEDED');
  // A debit that cleared onto an invoice that could not take it was written down as money not
  // applied: no receipt says it was received.
  const settled = effects.settledPayments.find((p) => p.bankOutcome?.invoiceId === invoice.id && p.bankOutcome.to === 'SUCCEEDED' && !p.unapplied);
  const paymentId = booked?.paymentId ?? settled?.bankOutcome?.paymentId;
  if (!paymentId) return;
  const [payment, current] = await Promise.all([
    prisma.payment.findFirst({
      where: { id: paymentId, invoice: { organization_id: invoice.organization_id } },
      select: { amount: true, tip_amount: true, bank_last4: true },
    }),
    prisma.invoice.findFirst({ where: { id: invoice.id, organization_id: invoice.organization_id }, select: { amount_due: true } }),
  ]);
  if (!payment || !current) return;
  await sendPaymentReceivedEmail({
    ...common,
    amount: Number(payment.amount),
    method: 'ACH',
    newBalance: Number(current.amount_due),
    tip: payment.tip_amount != null ? Number(payment.tip_amount) : null,
    methodDisplay: bankPaymentDisplay(payment.bank_last4),
  });
}

/**
 * Money landed on the deposit of a declined, cancelled or expired estimate (a checkout session
 * minted before the close and paid anyway). It is booked on the deposit invoice and wins nothing;
 * this row is how staff find out it arrived.
 */
function auditPaymentOnClosedEstimate(booked: BookedPayment, invoice: CheckoutInvoice): void {
  if (!booked.closedEstimateId) return;
  void logAudit({
    action: 'estimate.deposit_paid_on_closed_estimate',
    resourceType: 'Estimate',
    resourceId: booked.closedEstimateId,
    orgId: invoice.organization_id,
    actorId: null,
    metadata: {
      estimate_id: booked.closedEstimateId, invoice_id: invoice.id, invoice_number: invoice.invoice_number,
      payment_id: booked.paymentId, amount: booked.amount, method: booked.method, state: booked.state,
    },
  });
}

/**
 * A bank payment this event booked. While it clears (PROCESSING) nothing is collected, so there is
 * no receipt, payment-received notice or INVOICE_PAID yet (the customer's emails are sent from
 * the bank notices, slice 31; the owner's are slice 32). One whose clearing arrived first (SUCCEEDED) is collected now.
 */
async function afterBankPaymentBooked(booked: BookedPayment, invoice: CheckoutInvoice): Promise<void> {
  auditPaymentOnClosedEstimate(booked, invoice);
  void logAudit({
    action: booked.state === 'SUCCEEDED' ? 'invoice.paid_via_stripe' : 'invoice.bank_payment_recorded',
    resourceType: 'Invoice',
    resourceId: invoice.id,
    orgId: invoice.organization_id,
    actorId: null,
    metadata: { invoice_number: invoice.invoice_number, amount: booked.amount, kind: invoice.kind, method: 'ACH', state: booked.state },
  });
  if (booked.state === 'SUCCEEDED' && booked.paysInFull) {
    dispatchAutomationEvent({
      type: 'INVOICE_PAID',
      organizationId: invoice.organization_id,
      entity: { type: 'invoice', id: invoice.id, label: invoice.invoice_number },
      actorId: null,
    });
  }
  // Call 3: a bank deposit approves its estimate when the debit starts. The deposit's own
  // "processing" and receipt emails go out from the bank notices (slice 31).
  const est = booked.approvedEstimateId ? invoice.estimate : null;
  if (est) await announceApproval(est, invoice, 'online_deposit_processing');
}

async function afterPaymentBooked(booked: BookedPayment, invoice: CheckoutInvoice, ctx: CheckoutEffectsContext): Promise<void> {
  auditPaymentOnClosedEstimate(booked, invoice);
  const { organization, account, paymentIntentId } = ctx;
  const amount = booked.amount;

  // Fee/net capture for a direct charge (a legacy platform-account charge carries no fee to
  // reconcile). Fire-and-forget: failure-isolated, and the nightly sweep backfills a miss.
  if (account && paymentIntentId) void captureStripeFees(booked.paymentId, paymentIntentId, account);

  // Deferred-bank first-payment nudge: an org still without a payout bank hears once, on the first
  // card payment on THIS connected account (legacy platform-account payments do not count).
  if (account && !organization.stripe_payouts_enabled) {
    const priorCardPayments = await prisma.payment.count({
      where: { invoice: { organization_id: organization.id }, method: 'CARD', voided_at: null, stripe_account_id: account },
    });
    if (priorCardPayments === 1) {
      // Told like the other payments-account alerts: the holders of Company settings, else Manage roles and permissions (S06.29).
      await alertSwitchHolders({
        verb: 'billing.payouts_pending_first_payment',
        organizationId: organization.id,
        actorId: null,
        object: { type: 'ORGANIZATION', id: organization.id, label: organization.name ?? 'ServWave Payments' },
        data: { amount: formatCurrency(amount) },
        dedupKey: `billing.payouts_pending_first_payment:${organization.id}`,
      });
    }
  }

  void logAudit({
    action: 'invoice.paid_via_stripe',
    resourceType: 'Invoice',
    resourceId: invoice.id,
    orgId: invoice.organization_id,
    actorId: null,
    metadata: { invoice_number: invoice.invoice_number, amount, kind: invoice.kind },
  });

  if (booked.paysInFull) {
    dispatchAutomationEvent({
      type: 'INVOICE_PAID',
      organizationId: invoice.organization_id,
      entity: { type: 'invoice', id: invoice.id, label: invoice.invoice_number },
      actorId: null,
    });
  }

  // A deposit payment is announced by its own emails (deposit receipt + signed-PDF approval); it
  // must not ALSO fire the generic "payment received" email (#993). That holds for an estimate
  // approved before its deposit was paid (a bank debit that started, then failed, and the customer
  // paid by card on the pay-again link): only the approval itself is not announced again.
  const est = booked.depositEstimateId ? invoice.estimate : null;
  if (est) {
    await alertEstimate({
      verb: 'estimate.deposit_paid',
      organizationId: invoice.organization_id,
      actorId: null,
      estimateId: est.id,
      data: { lead_id: est.lead_id },
      dedupKey: `estimate.deposit_paid:${est.id}`,
    });
    void logAudit({
      action: 'estimate.deposit_paid', resourceType: 'Estimate', resourceId: est.id, orgId: invoice.organization_id,
      actorId: null, metadata: { estimate_number: est.estimate_number, via: 'stripe' },
    });
    const { customer: depCust, customerName: depCustName, record } = depositCustomer(est, invoice);
    if (depCust?.email && record) {
      sendDepositPaymentConfirmation({
        organizationId: invoice.organization_id,
        to: depCust.email,
        customerName: depCustName,
        estimateNumber: est.estimate_number,
        estimateId: est.id,
        depositAmount: amount,
        totalCharged: amount,
        paymentMethod: 'Credit Card',
        transactionId: paymentIntentId ?? undefined,
        companyName: est.organization?.name ?? 'ServWave',
        record,
      }).catch(() => {});
    }
    if (est.creator?.email) {
      sendDepositPaidAlert({
        organizationId: invoice.organization_id,
        to: est.creator.email,
        estimateNumber: est.estimate_number,
        customerName: depCustName,
        depositAmount: amount,
        paymentMethod: 'Credit Card',
      }).catch(() => {});
    }
    if (booked.approvedEstimateId) await announceApproval(est, invoice, 'stripe_deposit');
  }

  const c = invoice.customer ?? invoice.job?.customer;
  const customerName = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || 'Customer';
  if (c?.email && !est) {
    // The receipt itemises what the customer was charged: the tip and any fee ride on the payment,
    // never on the invoice, and the method is worded the way the customer knows it (slice 30).
    const charged = await prisma.payment.findFirst({
      where: { id: booked.paymentId, invoice: { organization_id: invoice.organization_id } },
      select: { tip_amount: true, service_fee_amount: true, wallet: true, card_brand: true, card_last4: true },
    });
    sendPaymentReceivedEmail({
      organizationId: invoice.organization_id,
      to: c.email,
      customerName,
      invoiceNumber: invoice.invoice_number,
      amount,
      method: 'CARD',
      newBalance: booked.newBalance,
      tip: charged?.tip_amount != null ? Number(charged.tip_amount) : null,
      serviceFee: charged?.service_fee_amount != null ? Number(charged.service_fee_amount) : null,
      methodDisplay: charged ? cardPaymentDisplay(charged) : null,
      record: {
        organizationId: invoice.organization_id,
        customerId: c.id,
        jobId: invoice.job?.id,
        jobLabel: invoice.job?.job_number,
        entityType: 'invoice',
        entityId: invoice.id,
      },
    }).catch((err) => logger.error('Webhook email error:', err));
  }

  // In-app notification, keyed on the payment intent: two genuine checkouts against one invoice
  // are two payments and notify twice; a retried event does not.
  await alertInvoice({
    verb: booked.paysInFull ? 'billing.payment_received' : 'billing.partial_payment',
    organizationId: invoice.organization_id,
    actorId: null,
    object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
    data: { object_label: invoice.invoice_number, amount: Number(amount).toFixed(2) },
    dedupKey: `${booked.paysInFull ? 'billing.payment_received' : 'billing.partial_payment'}:${paymentIntentId ?? booked.paymentId}`,
  });
}

type DepositEstimate = NonNullable<CheckoutInvoice['estimate']>;

/** The customer a deposit's emails go to, and the record they are filed against. */
function depositCustomer(est: DepositEstimate, invoice: CheckoutInvoice) {
  const customer = est.lead?.customer ?? est.customer;
  const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || customer?.company_name || 'Customer';
  const record = customer ? { organizationId: invoice.organization_id, customerId: customer.id, leadId: est.lead_id } : undefined;
  return { customer, customerName, record };
}

/**
 * The estimate was approved by its deposit (a card payment, or a bank debit that started): the
 * approval is announced as any other is, once (the notification is deduplicated per estimate).
 */
async function announceApproval(est: DepositEstimate, invoice: CheckoutInvoice, via: 'stripe_deposit' | 'online_deposit_processing'): Promise<void> {
  // #2090 - the add-ons the customer chose and turned down, named as the document names them.
  const optionSummary = await loadOptionSummary(est.id);
  await alertEstimate({
    verb: 'estimate.approved',
    organizationId: invoice.organization_id,
    actorId: null,
    estimateId: est.id,
    data: { lead_id: est.lead_id, ...optionSummaryData(optionSummary) },
    dedupKey: `estimate.approved:${est.id}`,
  });
  dispatchAutomationEvent({
    type: 'ESTIMATE_APPROVED',
    organizationId: invoice.organization_id,
    entity: { type: 'estimate', id: est.id, label: est.estimate_number },
    actorId: null,
  });
  void logAudit({
    action: 'estimate.approved', resourceType: 'Estimate', resourceId: est.id, orgId: invoice.organization_id,
    actorId: null, metadata: { estimate_number: est.estimate_number, via },
  });
  const { customer, customerName, record } = depositCustomer(est, invoice);
  if (est.organization && customer?.email && record) {
    sendEstimateApprovedNotification({
      estimateId: est.id,
      org: { id: invoice.organization_id, name: est.organization.name, logo_url: est.organization.logo_url, brand_color: est.organization.brand_color },
      to: customer.email,
      customerName,
      estimateNumber: est.estimate_number,
      total: formatCurrency(Number(est.total_amount)),
      options: optionSummary,
      record,
    }).catch((err) => logger.error('Failed to send approval notification after a deposit payment:', err));
  }
}
