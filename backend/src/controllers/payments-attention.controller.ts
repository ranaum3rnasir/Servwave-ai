/**
 * Payments go-live P4 - the Needs attention list and its actions (backend).
 *
 * One list merges every kind of item a person must deal with, open and resolved, from ServWave's own rows (see
 * services/payment-attention). Reading needs View payments; each action has its own switch. Nothing here asks the
 * processor and no processor id or name leaves it. Every query is scoped to the caller's company.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
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
import { UNAPPLIED_TYPES, unappliedDetail } from '../services/payment-attention/unapplied-detail';
import { LONG_TEXT_MAX } from '../lib/text-limits';
import { CHOOSE_A_REASON, RESOLVE_REASONS_FAILED_REFUND, RESOLVE_REASONS_OTHER, resolveReasonSchema } from '../lib/resolve-reasons';
import { plainBody } from '../lib/request-body';
import { claimContact, releaseContactClaim } from '../lib/payment-attention-contact';

const MAX_NOTE = LONG_TEXT_MAX;

/** The resolve body: an optional note (text up to the long-text limit) and an optional reason from the kind's own set. */
const resolveBodySchema = (reasons: readonly [string, ...string[]]) =>
  z.object({ note: z.string().max(MAX_NOTE).nullish(), reason: resolveReasonSchema(reasons) });

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

/** The kinds the read-by-key endpoint opens. The unapplied kinds answer with their own drawer detail (V7-09a); the rest in the list-row shape. */
const READABLE_BY_KEY: readonly AttentionType[] = ['failed_payment', 'failed_refund', 'failed_payout', 'unmatched_payment', 'unmatched_refund'];

// GET /api/payments-page/attention/:key
// One item in the list-row shape (same present() path), open or resolved. An unknown key, another company's, or a kind
// this endpoint does not open answers 404; an item on an invoice the caller cannot open comes back restricted.
export async function getAttentionItem(req: Request, res: Response) {
  try {
    const key = parseItemKey(String(req.params.key));
    if (!key || !READABLE_BY_KEY.includes(key.type)) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    if (UNAPPLIED_TYPES.includes(key.type)) {
      const row = await findAttention(req, key.type, key.id);
      if (!row) {
        res.status(404).json({ error: NOT_FOUND });
        return;
      }
      res.json(await unappliedDetail(req, row));
      return;
    }
    const item = await itemOf(req, key.type, key.id);
    if (!item) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(item);
  } catch (error) {
    logger.error('payments-page attention item failed', error);
    res.status(500).json({ error: 'Could not load this item' });
  }
}

// POST /api/payments-page/attention/:key/resolve   { reason?: string, note?: string }
// `reason` is one of the allowed words for the kind (400 "Choose a reason." otherwise); a missing one is accepted for older
// clients, and the old free-text `note` still works. If both arrive, `reason` wins.
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
    const parsed = resolveBodySchema(key.type === 'failed_refund' ? RESOLVE_REASONS_FAILED_REFUND : RESOLVE_REASONS_OTHER).safeParse(plainBody(req));
    if (!parsed.success) {
      // The note is checked first, as it always was.
      if (parsed.error.issues.some((issue) => issue.path[0] === 'note')) {
        res.status(400).json({ error: `Note must be ${MAX_NOTE.toLocaleString('en-US')} characters or fewer`, field: 'note' });
      } else {
        res.status(400).json({ error: CHOOSE_A_REASON, field: 'reason' });
      }
      return;
    }
    const { note: rawNote } = parsed.data;
    const reason = parsed.data.reason ?? null;
    const note = reason ?? (typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null);

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
    // The throttle check and the history row are one short step under a lock on the item (lib/payment-attention-contact, shared
    // with the automatic emails): two quick clicks claim the item once, and only the winner sends. The email goes out AFTER the
    // claim's transaction has ended. A send that did not go out gives the claim back, so only a real send stays throttled.
    const claimId = await claimContact({ organizationId: orgId, invoiceId: invoice.id, itemKey: row.key, createdBy: req.user!.id });
    let sent: boolean | { status: string; reason?: string } = false;
    if (claimId !== null) {
      const giveClaimBack = () => releaseContactClaim(orgId, claimId, invoice.id);
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
