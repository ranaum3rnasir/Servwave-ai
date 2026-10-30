/**
 * Payments go-live P4 - the Needs attention list and its actions (backend).
 *
 * One list merges every kind of item a person must deal with, open and resolved, from ServWave's own rows (see
 * services/payment-attention). Reading needs View payments; each action has its own switch. Nothing here asks the
 * processor and no processor id or name leaves it. Every query is scoped to the caller's company.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { parseArrayParam } from '../lib/query/parseArrayParam';
import { parsePagination } from '../lib/pagination';
import { invoiceOpenerFor } from '../lib/permissions/invoiceAccess';
import { sendBankPaymentFailedEmail } from '../lib/email';
import { payAgainUrl } from '../services/payment-reconciler/checkout-effects';
import { customerNameOf } from '../services/payments-page';
import {
  countOpenAttention, findAttention, listAttention, MAX_LIMIT, MAX_OFFSET, present, TOO_DEEP,
} from '../services/payment-attention';
import { ATTENTION_TYPES, parseItemKey, type AttentionType } from '../services/payment-attention/rules';
import { LONG_TEXT_MAX } from '../lib/text-limits';

const MAX_NOTE = LONG_TEXT_MAX;
/** A second "ask the customer to pay again" for the same payment inside this window is refused. */
const CONTACT_THROTTLE_MS = 10 * 60 * 1000;
const TIMELINE_ASKED_AGAIN = 'PAYMENT_CUSTOMER_ASKED_TO_PAY_AGAIN';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'Item not found';
const NOT_ALLOWED = 'Insufficient permissions';

// GET /api/payments-page/attention/summary
export async function getAttentionSummary(req: Request, res: Response) {
  try {
    res.json(await countOpenAttention(req));
  } catch (error) {
    logger.error('payments-page attention summary failed', error);
    res.status(500).json({ error: 'Could not load what needs attention' });
  }
}

// GET /api/payments-page/attention?view=open|resolved&type[]&q&payment_id&page&limit
export async function listAttentionItems(req: Request, res: Response) {
  try {
    const view = req.query.view === undefined ? 'open' : req.query.view;
    if (view !== 'open' && view !== 'resolved') {
      res.status(400).json({ error: 'view must be open or resolved' });
      return;
    }
    const asked = parseArrayParam(req.query.type ?? req.query['type[]']);
    if (asked.some((t) => !(ATTENTION_TYPES as readonly string[]).includes(t))) {
      res.status(400).json({ error: 'Unknown type' });
      return;
    }
    const parsed = parsePagination(req.query as { page?: string; limit?: string });
    const limit = Math.min(MAX_LIMIT, parsed.limit);
    const offset = (parsed.page - 1) * limit;
    if (offset > MAX_OFFSET) {
      res.status(400).json({ error: TOO_DEEP });
      return;
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const paymentId = req.query.payment_id;
    if (paymentId !== undefined && (typeof paymentId !== 'string' || !UUID.test(paymentId))) {
      res.status(400).json({ error: 'payment_id must be an id' });
      return;
    }
    res.json(await listAttention(req, { view, types: asked.length ? (asked as AttentionType[]) : null, q, paymentId, page: parsed.page, limit }));
  } catch (error) {
    logger.error('payments-page attention list failed', error);
    res.status(500).json({ error: 'Could not load what needs attention' });
  }
}

/** The item for this key as the caller sees it, or undefined. */
async function itemOf(req: Request, type: AttentionType, id: string) {
  const row = await findAttention(req, type, id);
  return row ? (await present(req, [row]))[0] : undefined;
}

// POST /api/payments-page/attention/:key/resolve   { note?: string }
export async function resolveAttention(req: Request, res: Response) {
  try {
    const key = parseItemKey(String(req.params.key));
    if (!key) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    if (key.type !== 'failed_payment' && key.type !== 'failed_refund' && key.type !== 'failed_payout') {
      res.status(400).json({ error: 'This one is closed from its own button, not here.' });
      return;
    }
    const allowed = key.type === 'failed_payout'
      ? req.ability?.can('manage_payout_account', 'Organization')
      : req.ability?.can('refund', 'Invoice');
    if (!allowed) {
      res.status(403).json({ error: NOT_ALLOWED });
      return;
    }
    const rawNote = (req.body ?? {}).note;
    if (rawNote != null && (typeof rawNote !== 'string' || rawNote.length > MAX_NOTE)) {
      res.status(400).json({ error: `Note must be ${MAX_NOTE.toLocaleString('en-US')} characters or fewer`, field: 'note' });
      return;
    }
    const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null;

    const row = await findAttention(req, key.type, key.id);
    if (!row) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    if (row.invoice_id && !(await (await invoiceOpenerFor(req))([row.invoice_id])).has(row.invoice_id)) {
      res.status(403).json({ error: NOT_ALLOWED });
      return;
    }
    const orgId = req.user!.organization_id;
    const existing = await prisma.paymentAttentionResolution.findFirst({ where: { organization_id: orgId, item_key: row.key }, select: { id: true } });
    if (!existing) {
      if (!row.is_open) {
        res.status(409).json({ error: 'This no longer needs attention.' });
        return;
      }
      const made = await prisma.paymentAttentionResolution.createMany({
        data: [{
          organization_id: orgId, item_key: row.key, resolution: key.type === 'failed_refund' ? 'SETTLED' : 'RESOLVED', note,
          resolved_by: req.user!.id, resolved_by_name: `${req.user!.first_name} ${req.user!.last_name}`.trim(),
        }],
        skipDuplicates: true,
      });
      if (made.count === 1) {
        void logAudit({
          action: 'payments.attention_resolved',
          resourceType: row.invoice_id ? 'Invoice' : 'Organization',
          resourceId: row.invoice_id ?? orgId,
          orgId,
          actorId: req.user!.id,
          metadata: { item_key: row.key, type: key.type, amount: row.amount == null ? null : Number(row.amount), has_note: note != null },
        });
      }
    }
    res.json(await itemOf(req, key.type, key.id));
  } catch (error) {
    logger.error('payments-page attention resolve failed', error);
    res.status(500).json({ error: 'Could not mark this resolved' });
  }
}

// POST /api/payments-page/attention/:key/contact-customer
export async function contactCustomer(req: Request, res: Response) {
  try {
    const key = parseItemKey(String(req.params.key));
    if (!key) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    if (key.type !== 'failed_payment') {
      res.status(400).json({ error: 'Only a failed bank payment can be sent back to the customer to pay again.' });
      return;
    }
    const row = await findAttention(req, key.type, key.id);
    if (!row || !row.invoice_id) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    if (!(await (await invoiceOpenerFor(req))([row.invoice_id])).has(row.invoice_id)) {
      res.status(403).json({ error: NOT_ALLOWED });
      return;
    }
    if (row.invoice_status === 'PAID' || row.invoice_status === 'VOIDED') {
      res.status(409).json({ error: 'This invoice is already paid or voided, so there is nothing to ask the customer to pay.' });
      return;
    }
    if (!row.is_open) {
      res.status(409).json({ error: 'This no longer needs attention.' });
      return;
    }
    const orgId = req.user!.organization_id;
    const invoice = await prisma.invoice.findFirst({
      where: { id: row.invoice_id, ...tenantWhere(req) },
      select: {
        id: true, invoice_number: true, kind: true, public_token: true,
        estimate: { select: { id: true, public_token: true } },
        job: { select: { id: true, job_number: true } },
        customer: { select: { id: true, email: true, first_name: true, last_name: true, company_name: true } },
      },
    });
    if (!invoice) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const email = invoice.customer.email?.trim();
    if (!email) {
      res.status(409).json({ error: 'This customer has no email address on file.' });
      return;
    }
    const payUrl = payAgainUrl(invoice);
    const record = {
      organizationId: orgId, customerId: invoice.customer.id, jobId: invoice.job?.id, jobLabel: invoice.job?.job_number,
      entityType: 'invoice' as const, entityId: invoice.id,
    };
    // The throttle check and the history row are one short step under a lock on the item: two quick clicks claim the item
    // once, and only the winner sends. The email goes out AFTER the transaction has ended (the mail layer uses the app's
    // own client, which must never be awaited while a transaction holds the only pooled connection). A send that did not
    // go out gives the claim back, so only a real send stays throttled. If the claim cannot be given back, the customer
    // is not emailed for the throttle window, which is the safe direction.
    const throttleRow = { organization_id: orgId, entity_type: 'INVOICE' as const, entity_id: invoice.id, event_type: TIMELINE_ASKED_AGAIN,
      description: 'Customer asked to pay again', metadata: { item_key: row.key }, created_by: req.user!.id };
    const claimId = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attention-contact:${row.key}`}, 0))`;
      const recent = await tx.timelineEvent.findFirst({
        where: {
          organization_id: orgId, entity_type: 'INVOICE', entity_id: invoice.id, event_type: TIMELINE_ASKED_AGAIN,
          metadata: { path: ['item_key'], equals: row.key }, created_at: { gte: new Date(Date.now() - CONTACT_THROTTLE_MS) },
        },
        select: { id: true },
      });
      if (recent) return null;
      const created = await tx.timelineEvent.create({ data: throttleRow, select: { id: true } });
      return created.id;
    });
    let sent: boolean | { status: string; reason?: string } = false;
    if (claimId !== null) {
      const giveClaimBack = async () => {
        try {
          await prisma.timelineEvent.deleteMany({ where: { id: claimId, organization_id: orgId } });
        } catch (releaseError) {
          logger.error(`payments-page attention contact: could not release the throttle row after an unsent email (invoice ${invoice.id})`, releaseError);
        }
      };
      let outcome: Awaited<ReturnType<typeof sendBankPaymentFailedEmail>>;
      try {
        // The same email the customer gets when their own bank payment fails; suppression and the sending switch behave as there.
        outcome = await sendBankPaymentFailedEmail({
          organizationId: orgId, to: email, customerName: customerNameOf(invoice.customer), invoiceNumber: invoice.invoice_number,
          amount: Number(row.amount), ...(payUrl ? { payUrl } : {}), record,
        });
      } catch (sendError) {
        await giveClaimBack();
        throw sendError;
      }
      // The mail layer reports a blocked or failed send instead of throwing, so only a real send stays recorded and throttled.
      if (outcome?.status === 'sent') {
        sent = true;
      } else {
        await giveClaimBack();
        sent = outcome ?? { status: 'failed' };
      }
    }
    if (sent === false) {
      res.status(409).json({ error: 'Already sent a moment ago.' });
      return;
    }
    if (sent !== true) {
      if (sent.status === 'skipped' && sent.reason === 'suppressed') {
        res.status(409).json({ error: 'This email address cannot receive mail after an earlier bounce, so nothing was sent.' });
      } else {
        res.status(502).json({ error: 'The email could not be sent. Try again in a moment.' });
      }
      return;
    }
    void logAudit({
      action: 'payments.attention_contacted', resourceType: 'Invoice', resourceId: invoice.id, orgId, actorId: req.user!.id,
      metadata: { item_key: row.key },
    });
    res.json({ key: row.key, sent: true });
  } catch (error) {
    logger.error('payments-page attention contact failed', error);
    res.status(500).json({ error: 'Could not contact the customer' });
  }
}
