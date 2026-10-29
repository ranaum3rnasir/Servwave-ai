import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  hasPaymentInSubtree,
  paymentSummaryForSubtree,
  purgeCustomerSubtree,
  purgeLeadSubtree,
} from '../lib/purge';
import { ALPHA_ORG_ID } from './helpers';
import { matchesWhere } from './whereMatcher';

const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const LEAD_ID = 'e0000000-0000-0000-0000-0000000000aa';
const ESTIMATE_ID = 'f0000000-0000-0000-0000-0000000000aa';
const JOB_ID = 'j0000000-0000-0000-0000-0000000000aa';
const INVOICE_ID = 'i0000000-0000-0000-0000-0000000000aa';

const m = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// A transaction client that proxies to the same mocked prisma model methods,
// so each model.deleteMany/delete records its calls.
function txClient() {
  return prisma;
}

describe('hasPaymentInSubtree', () => {
  it('returns true when a payment exists anywhere in the subtree (org-scoped)', async () => {
    m.payment.count.mockResolvedValue(1);
    const result = await hasPaymentInSubtree(CUSTOMER_ID, ALPHA_ORG_ID);
    expect(result).toBe(true);
    const args = m.payment.count.mock.calls[0][0];
    // tenant-scoped via invoice.organization_id
    expect(args.where.invoice.organization_id).toBe(ALPHA_ORG_ID);
    // reaches all three anchors
    const or = args.where.invoice.OR;
    expect(or.some((c: any) => c.customer_id === CUSTOMER_ID)).toBe(true);
    expect(or.some((c: any) => c.job?.customer_id === CUSTOMER_ID)).toBe(true);
    expect(or.some((c: any) => c.estimate?.customer_id === CUSTOMER_ID)).toBe(true);
  });

  it('returns false when no payment exists', async () => {
    m.payment.count.mockResolvedValue(0);
    expect(await hasPaymentInSubtree(CUSTOMER_ID, ALPHA_ORG_ID)).toBe(false);
  });
});

describe('paymentSummaryForSubtree', () => {
  it('reports total and stripe-charge presence', async () => {
    m.payment.findMany.mockResolvedValue([
      { amount: 100, stripe_payment_intent_id: null },
      { amount: 250, stripe_payment_intent_id: 'pi_123' },
    ]);
    const summary = await paymentSummaryForSubtree(CUSTOMER_ID, ALPHA_ORG_ID);
    expect(summary.hasPayment).toBe(true);
    expect(summary.paymentTotal).toBe(350);
    expect(summary.hasStripeCharge).toBe(true);
  });

  it('reports no stripe charge and zero total when empty', async () => {
    m.payment.findMany.mockResolvedValue([]);
    const summary = await paymentSummaryForSubtree(CUSTOMER_ID, ALPHA_ORG_ID);
    expect(summary.hasPayment).toBe(false);
    expect(summary.paymentTotal).toBe(0);
    expect(summary.hasStripeCharge).toBe(false);
  });
});

describe('purgeCustomerSubtree', () => {
  function mockSubtreeIds() {
    m.lead.findMany.mockResolvedValue([{ id: LEAD_ID }]);
    m.estimate.findMany.mockResolvedValue([{ id: ESTIMATE_ID }]);
    m.job.findMany.mockResolvedValue([{ id: JOB_ID }]);
    m.invoice.findMany.mockResolvedValue([{ id: INVOICE_ID }]);
    m.messageThread.findMany.mockResolvedValue([]);
    m.whatsAppChat.findMany.mockResolvedValue([]);
    m.contact.findMany.mockResolvedValue([]);
    m.purchaseOrder.findMany.mockResolvedValue([]);
    m.rfq.findMany.mockResolvedValue([]);
    m.estimateReservation.findMany.mockResolvedValue([]);
    m.jobStage.findMany.mockResolvedValue([]);
    m.stockApproval.findMany.mockResolvedValue([]);
    // every deleteMany returns count 0; delete returns the row
    for (const model of [
      'message', 'messageThread', 'whatsAppMessage', 'whatsAppChat', 'callSession', 'email',
      'reservationLine', 'estimateReservation', 'rfqLine', 'rfqQuote', 'rfq',
      'purchaseOrderLine', 'purchaseOrder', 'jobStageLine', 'jobStageAttachment', 'stageAuditEntry', 'jobStage',
      'stockApprovalModification', 'stockApproval', 'channelIdentity', 'contact', 'leadTag', 'tagAssignment',
      'attachment', 'note', 'timelineEvent',
      'depositCreditApplication', 'refund', 'credit', 'payment', 'invoiceLineItem', 'invoice',
      'estimateLineItem', 'estimate', 'estimateSendConfig',
      'customerPhone', 'customerEmail', 'serviceLocation',
    ]) {
      m[model].deleteMany.mockResolvedValue({ count: 0 });
    }
    m.lead.deleteMany.mockResolvedValue({ count: 1 });
    m.job.deleteMany.mockResolvedValue({ count: 1 });
    m.customer.delete.mockResolvedValue({ id: CUSTOMER_ID });
  }

  it('deletes every child class without throwing, children before parents, members untouched', async () => {
    mockSubtreeIds();

    await purgeCustomerSubtree(txClient() as any, CUSTOMER_ID, ALPHA_ORG_ID);

    // financial spine ran
    expect(m.payment.deleteMany).toHaveBeenCalled();
    expect(m.invoiceLineItem.deleteMany).toHaveBeenCalled();
    expect(m.invoice.deleteMany).toHaveBeenCalled();
    expect(m.estimateLineItem.deleteMany).toHaveBeenCalled();
    expect(m.estimate.deleteMany).toHaveBeenCalled();
    expect(m.lead.deleteMany).toHaveBeenCalled();
    expect(m.job.deleteMany).toHaveBeenCalled();
    // comms / inventory / tags ran
    expect(m.messageThread.deleteMany).toHaveBeenCalled();
    expect(m.estimateReservation.deleteMany).toHaveBeenCalled();
    expect(m.purchaseOrder.deleteMany).toHaveBeenCalled();
    expect(m.stockApproval.deleteMany).toHaveBeenCalled();
    expect(m.jobStage.deleteMany).toHaveBeenCalled();
    expect(m.contact.deleteMany).toHaveBeenCalled();
    expect(m.leadTag.deleteMany).toHaveBeenCalled();
    expect(m.tagAssignment.deleteMany).toHaveBeenCalled();
    // polymorphic
    expect(m.attachment.deleteMany).toHaveBeenCalled();
    expect(m.note.deleteMany).toHaveBeenCalled();
    expect(m.timelineEvent.deleteMany).toHaveBeenCalled();
    // customer leaves + root
    expect(m.customerPhone.deleteMany).toHaveBeenCalled();
    expect(m.customerEmail.deleteMany).toHaveBeenCalled();
    expect(m.serviceLocation.deleteMany).toHaveBeenCalled();
    expect(m.customer.delete).toHaveBeenCalledWith({ where: { id: CUSTOMER_ID } });

    // members are independent — never deleted
    const memberDeleteCall = m.customer.delete.mock.calls.find(
      (c: any) => c[0]?.where?.parent_id !== undefined,
    );
    expect(memberDeleteCall).toBeUndefined();

    // FK-safety ordering: PurchaseOrder deleted before JobStage (PO FKs JobStage)
    const poOrder = m.purchaseOrder.deleteMany.mock.invocationCallOrder[0];
    const stageOrder = m.jobStage.deleteMany.mock.invocationCallOrder[0];
    expect(poOrder).toBeLessThan(stageOrder);

    // payment deleted before invoice
    const payOrder = m.payment.deleteMany.mock.invocationCallOrder[0];
    const invOrder = m.invoice.deleteMany.mock.invocationCallOrder[0];
    expect(payOrder).toBeLessThan(invOrder);
  });

  it('scopes deleteMany queries to the org where org_id exists', async () => {
    mockSubtreeIds();
    await purgeCustomerSubtree(txClient() as any, CUSTOMER_ID, ALPHA_ORG_ID);
    const invoiceArgs = m.invoice.deleteMany.mock.calls[0][0];
    expect(JSON.stringify(invoiceArgs)).toContain(ALPHA_ORG_ID);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE MANUAL COMMUNICATION LOG SURVIVES A PURGE UNLESS IT IS SWEPT BY ANCHOR.
  //
  // The existing sweep reaches entries by LEAD id and JOB id - the two anchors that existed when
  // it was written. A customer-anchored entry (#2021) hangs off neither, so it is not reached by
  // that sweep at all, and the tenant-coverage guard cannot see the gap either: that guard only
  // asks whether the MODEL is written to, and this model is.
  //
  // Asserted as SURVIVING ROWS, not as a delete call. The store below really removes what the
  // real WHERE matches, so a sweep that names the wrong column, or none, leaves rows behind here
  // exactly as it would in Postgres. Adding `expect(deleteMany).toHaveBeenCalled()` would have
  // passed against the unfixed code, because it already is.
  // ───────────────────────────────────────────────────────────────────────────

  /** Three entries on one customer, one per anchor - the whole population a purge must clear. */
  function manualLogStore() {
    const rows: any[] = [
      { id: 'log-on-lead', organization_id: ALPHA_ORG_ID, lead_id: LEAD_ID, job_id: null, customer_id: null },
      { id: 'log-on-job', organization_id: ALPHA_ORG_ID, lead_id: null, job_id: JOB_ID, customer_id: null },
      { id: 'log-on-customer', organization_id: ALPHA_ORG_ID, lead_id: null, job_id: null, customer_id: CUSTOMER_ID },
    ];
    m.manualCommunicationLog.deleteMany.mockImplementation(async ({ where }: any) => {
      const kept = rows.filter((r) => !matchesWhere(r, where));
      const count = rows.length - kept.length;
      rows.length = 0;
      rows.push(...kept);
      return { count };
    });
    return rows;
  }

  it('leaves no logged entry behind, on any of the three anchors', async () => {
    mockSubtreeIds();
    const rows = manualLogStore();

    await purgeCustomerSubtree(txClient() as any, CUSTOMER_ID, ALPHA_ORG_ID);

    expect(rows).toEqual([]);
  });
});

describe('purgeLeadSubtree', () => {
  it('purges lead → estimate → invoice → job without touching the customer', async () => {
    m.estimate.findMany.mockResolvedValue([{ id: ESTIMATE_ID }]);
    m.job.findMany.mockResolvedValue([{ id: JOB_ID }]);
    m.invoice.findMany.mockResolvedValue([{ id: INVOICE_ID }]);
    m.messageThread.findMany.mockResolvedValue([]);
    m.whatsAppChat.findMany.mockResolvedValue([]);
    m.purchaseOrder.findMany.mockResolvedValue([]);
    m.rfq.findMany.mockResolvedValue([]);
    m.estimateReservation.findMany.mockResolvedValue([]);
    m.jobStage.findMany.mockResolvedValue([]);
    m.stockApproval.findMany.mockResolvedValue([]);
    for (const model of [
      'message', 'messageThread', 'whatsAppMessage', 'whatsAppChat', 'callSession', 'email',
      'reservationLine', 'estimateReservation', 'rfqLine', 'rfqQuote', 'rfq',
      'purchaseOrderLine', 'purchaseOrder', 'jobStageLine', 'jobStageAttachment', 'stageAuditEntry', 'jobStage',
      'stockApprovalModification', 'stockApproval', 'leadTag', 'tagAssignment',
      'attachment', 'note', 'timelineEvent',
      'depositCreditApplication', 'refund', 'credit', 'payment', 'invoiceLineItem', 'invoice',
      'estimateLineItem', 'estimate', 'estimateSendConfig', 'lead', 'job',
    ]) {
      m[model].deleteMany.mockResolvedValue({ count: 0 });
    }

    await purgeLeadSubtree(txClient() as any, LEAD_ID, ALPHA_ORG_ID);

    expect(m.estimate.deleteMany).toHaveBeenCalled();
    expect(m.invoice.deleteMany).toHaveBeenCalled();
    expect(m.job.deleteMany).toHaveBeenCalled();
    expect(m.lead.deleteMany).toHaveBeenCalled();
    // customer + its owned leaves must NOT be touched by a lead purge
    expect(m.customer.delete).not.toHaveBeenCalled();
    expect(m.customerPhone.deleteMany).not.toHaveBeenCalled();
    expect(m.customerEmail.deleteMany).not.toHaveBeenCalled();
    expect(m.serviceLocation.deleteMany).not.toHaveBeenCalled();
  });
});
