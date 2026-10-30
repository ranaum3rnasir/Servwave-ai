import type { Request } from 'express';
import type { Subject } from './catalog';
import { invoiceActionsFor } from './documentActions';

/**
 * What the job page's Payment Received step offers this person (Roles & Permissions, PRD 6, S06.22, M9). The step opens
 * the record-payment dialog on the job's final invoice, so it is offered only when the person holds Record payments AND
 * can open that invoice (Invoices View and scope, or the creator rule); otherwise the step is drawn greyed with the one
 * reason that applies. The browser draws what this says and never tests a switch, a role or an invoice's creator itself.
 *
 * The creator rule opens the invoice but never grants Record payments (it is a switch of its own), and the route that
 * takes the payment asks the same two questions, so a listed step is one the route lets in. The server stays the check:
 * a payment posted to an invoice the person cannot open is refused whatever the screen shows.
 */
export interface PaymentReceivedStep {
  /** True when Record payment may be pressed. */
  offered: boolean;
  /** The words beside the greyed control; null when it is offered, and when the step offers nothing and says nothing. */
  reason: string | null;
}

export const PAYMENT_STEP_CANNOT_OPEN = "You can't open this job's invoice.";
export const PAYMENT_STEP_NO_RECORD = "You don't have permission to record payments.";
export const PAYMENT_STEP_NO_CREATE = "You don't have permission to create invoices.";

const OFFERED: PaymentReceivedStep = { offered: true, reason: null };
const refused = (reason: string | null): PaymentReceivedStep => ({ offered: false, reason });

/**
 * `finalInvoiceId` is the job's final invoice (the one the progress bar reads), or null when the job has none;
 * `openable` the ids among the job's invoices this person can open, already worked out by the caller for the same
 * request; `servicePlanJob` a visit of a service plan, whose invoice the plan covered upfront.
 *
 * Asks nothing of the database for a person who lacks Record payments or the invoice, and at most one query otherwise.
 */
export async function paymentReceivedStepFor(
  req: Request,
  job: { finalInvoiceId: string | null; openable: ReadonlySet<string>; servicePlanJob: boolean },
): Promise<PaymentReceivedStep> {
  const holdsRecordPayments = req.ability!.can('record_payment', 'Invoice' as Subject);
  // Said first, ahead of the invoice: it is a fact about the person, so it names nothing about the job's invoices.
  if (!holdsRecordPayments) return refused(PAYMENT_STEP_NO_RECORD);

  if (job.finalInvoiceId) {
    if (!job.openable.has(job.finalInvoiceId)) return refused(PAYMENT_STEP_CANNOT_OPEN);
    // The invoice page's own per-record list: Record payments within the scope the switch reaches on this invoice.
    const listed = await invoiceActionsFor(req, job.finalInvoiceId, ['record_payment']);
    return listed.includes('record_payment') ? OFFERED : refused(PAYMENT_STEP_NO_RECORD);
  }

  // No invoice yet: the dialog creates one for the amount, sends it and pays it, so it takes Create invoices as well.
  // A service plan's visit is not invoiced from here (the plan was paid upfront), so its step offers nothing.
  if (job.servicePlanJob) return refused(null);
  return req.ability!.can('create', 'Invoice' as Subject) ? OFFERED : refused(PAYMENT_STEP_NO_CREATE);
}
