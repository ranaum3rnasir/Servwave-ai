/**
 * Payments go-live slice 30: tell the customer a refund has gone out, once it has SUCCEEDED.
 *
 * The in-app refund door sends the email itself when its refund is SUCCEEDED on creation (a card
 * refund). A refund that was PENDING (a bank refund) is announced here, by the reconciler, when the
 * processor confirms it. Money sent back from "Payments needing attention" was never the invoice's
 * and a refund made outside ServWave was not ServWave's to announce, so neither is emailed.
 * Never throws: an email problem must not fail the event that settled the refund.
 */
import { prisma } from './prisma';
import { logger } from './logger';
import { sendInvoiceRefundNotification } from './email';
import { refundTimingFor } from './refund-rules';
import { OUTSIDE_REFUND_REASON } from '../services/payment-reconciler/apply';

export async function emailRefundToCustomer(organizationId: string, refundId: string): Promise<void> {
  try {
    const refund = await prisma.refund.findFirst({
      where: { id: refundId, organization_id: organizationId, state: 'SUCCEEDED', from_unapplied_capture: false },
      select: {
        amount: true,
        method: true,
        stripe_refund_id: true,
        reason: true,
        invoice: {
          select: {
            id: true,
            invoice_number: true,
            customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } },
            job: { select: { id: true, job_number: true, customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } } } },
          },
        },
      },
    });
    if (!refund || refund.reason === OUTSIDE_REFUND_REASON) return;
    const { invoice } = refund;
    const customer = invoice.customer ?? invoice.job?.customer;
    if (!customer?.email) return;
    await sendInvoiceRefundNotification({
      organizationId,
      to: customer.email,
      customerName: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Customer',
      invoiceNumber: invoice.invoice_number,
      invoiceId: invoice.id,
      refundAmount: Number(refund.amount),
      timing: refundTimingFor({ method: refund.method, processed: !!refund.stripe_refund_id }),
      record: {
        organizationId,
        customerId: customer.id,
        jobId: invoice.job?.id,
        jobLabel: invoice.job?.job_number,
        // Anchors the Reply-To on the invoice, as the receipt does.
        entityType: 'invoice',
        entityId: invoice.id,
      },
    });
  } catch (err) {
    logger.error(`Refund email for ${refundId} failed:`, err);
  }
}
