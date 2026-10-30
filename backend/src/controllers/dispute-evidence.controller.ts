/**
 * Payments go-live P10 - answering a dispute inside ServWave (backend).
 *
 * An office user attaches files that already sit on the dispute's invoice, writes an explanation, stages it at the card
 * network's side and submits it. Everything is judged here: the files on their stored bytes, the limits across every slot,
 * the deadline and the state of the dispute. The browser never sees a processor id or a processor message; a refusal
 * from the processor is mapped to ServWave's own words (lib/dispute-evidence.ts) and the original goes to the log only,
 * with every id in it masked.
 *
 * No processor call ever runs inside a database transaction (the hosted pool allows one connection).
 */
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { invoiceOpenerFor } from '../lib/permissions/invoiceAccess';
import { customerNameOf } from '../services/payments-page';
import {
  uploadDisputeEvidenceFile, stageDisputeEvidence, submitDisputeEvidence, retrieveDisputeSubmissionCount,
} from '../lib/stripe';
import {
  FILE_FIELDS, TEXT_FIELDS, TEXT_FIELD_MAX, FIELD_LABELS, LIMITS, isFileField, isTextField, inspectEvidenceBytes, checkTotals,
  recommendedFields, describeReason, describeProcessorFailure, redactProcessorText, textTotal, type EvidenceSlot,
} from '../lib/dispute-evidence';
import { readStoredObject, storedObjectSize } from '../lib/dispute-evidence-storage';

const NOT_FOUND = 'Dispute not found';
const FILE_NOT_FOUND = 'File not found';
const STALE = 'Someone changed this evidence. Reload and try again.';
const ALREADY_SUBMITTED = 'Evidence was already submitted';
const NOT_SAVED = 'Save the evidence before you submit it';
const NOTHING_TO_SUBMIT = 'Add at least one file or write an explanation before you submit.';
const TIMELINE_SUBMITTED = 'DISPUTE_EVIDENCE_SUBMITTED';
const DAY_MS = 86_400_000;

const UUID = z.string().uuid();
const stageBody = z.object({
  version: z.number().int().min(0),
  files: z.record(z.string(), UUID.nullable()).default({}),
  text: z.record(z.string(), z.string()).default({}),
});
const submitBody = z.object({ version: z.number().int().min(0) });

class Refusal extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

const disputeInclude = {
  payment: { select: { card_brand: true, stripe_account_id: true } },
  evidence_items: true,
  invoice: {
    select: {
      id: true,
      invoice_number: true,
      customer: { select: { first_name: true, last_name: true, company_name: true, email: true } },
      job: { select: { last_visit_completed_at: true, completed_at: true, started_at: true } },
    },
  },
} satisfies Prisma.DisputeInclude;
type Loaded = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;
type Item = Loaded['evidence_items'][number];

/** The dispute for this caller, or null (another company's, not an id, or on an invoice the caller cannot open). */
async function load(req: Request, id: string): Promise<Loaded | null> {
  if (!UUID.safeParse(id).success) return null;
  const d = await prisma.dispute.findFirst({ where: { id, ...tenantWhere(req) }, include: disputeInclude });
  if (!d) return null;
  if (!(await (await invoiceOpenerFor(req))([d.invoice_id])).has(d.invoice_id)) return null;
  return d;
}

/** Why this dispute takes no more evidence, in ServWave's words; null while it is open for it. */
function closedReason(d: Loaded): string | null {
  if (d.evidence_submission_count > 0 || d.status === 'UNDER_REVIEW') return ALREADY_SUBMITTED;
  if (d.status !== 'NEEDS_RESPONSE') return 'This dispute is closed.';
  if (d.is_bank_return) return 'A returned bank payment takes no evidence.';
  if (d.evidence_due_by && d.evidence_due_by.getTime() <= Date.now()) return 'The deadline has passed';
  return null;
}

const storedText = (d: Loaded): Record<string, string> => {
  const raw = d.evidence_text;
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const f of TEXT_FIELDS) {
      const v = (raw as Record<string, unknown>)[f];
      if (typeof v === 'string') out[f] = v;
    }
  }
  return out;
};

const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

/** What the form may prefill where nothing is stored: the customer's name, email and the service date. Never counted, never sent unless the form sends it. */
function formDefaults(d: Loaded): Record<string, string> {
  const job = d.invoice.job;
  const defaults: Record<string, string> = {
    customer_name: customerNameOf(d.invoice.customer),
    customer_email_address: d.invoice.customer.email?.trim() ?? '',
    service_date: isoDay(job?.last_visit_completed_at ?? job?.completed_at ?? job?.started_at),
  };
  const out: Record<string, string> = {};
  for (const f of TEXT_FIELDS) out[f] = defaults[f] ?? '';
  return out;
}

/** The stored text for every text field ('' where nothing is stored). */
function formText(d: Loaded): Record<string, string> {
  const typed = storedText(d);
  const out: Record<string, string> = {};
  for (const f of TEXT_FIELDS) out[f] = typed[f] ?? '';
  return out;
}

const slotsOf = (items: Item[]): EvidenceSlot[] => items.map((i) => ({ field: i.evidence_field, size_bytes: i.size_bytes, page_count: i.page_count }));
const hasContent = (d: Loaded) => d.evidence_items.length > 0 || (storedText(d).uncategorized_text ?? '').trim().length > 0;
const namesOf = (items: Item[]) => FILE_FIELDS.filter((f) => items.some((i) => i.evidence_field === f));

function stateOf(req: Request, d: Loaded, refusedField: string | null = null) {
  const reason = closedReason(d);
  const canEdit = Boolean(req.ability?.can('refund', 'Invoice')) && reason === null;
  const items = d.evidence_items;
  const text = formText(d);
  const files: Record<string, unknown> = {};
  for (const f of FILE_FIELDS) {
    const i = items.find((x) => x.evidence_field === f);
    files[f] = i
      ? { attachment_id: i.attachment_id, file_name: i.file_name, mime: i.mime, size_bytes: i.size_bytes, page_count: i.page_count, ...(f === refusedField ? { refused: true } : {}) }
      : null;
  }
  const due = d.evidence_due_by;
  const outcome = d.status === 'WON' ? 'won' : d.status === 'LOST' ? 'lost' : d.status === 'CLOSED' ? 'closed' : null;
  return {
    dispute: {
      id: d.id,
      status: d.status,
      reason_text: describeReason(d.reason),
      amount: Number(d.amount),
      respond_by: due ? due.toISOString() : null,
      days_left: due ? Math.max(0, Math.ceil((due.getTime() - Date.now()) / DAY_MS)) : null,
      is_bank_return: d.is_bank_return,
      closed_at: d.closed_at ? d.closed_at.toISOString() : null,
      outcome,
      // Who and what it is about: the form shows them, and the invoice id is what files attach to.
      customer_name: customerNameOf(d.invoice.customer),
      invoice: { id: d.invoice_id, number: d.invoice.invoice_number },
    },
    form: { files, text, defaults: formDefaults(d), version: d.evidence_version },
    totals: {
      bytes: items.reduce((n, i) => n + i.size_bytes, 0),
      pages: items.reduce((n, i) => n + i.page_count, 0),
      chars: textTotal(text),
    },
    limits: { max_bytes: LIMITS.max_bytes, max_pages: LIMITS.max_pages, max_chars: LIMITS.max_chars, types: [...LIMITS.types] },
    submitted: d.evidence_submission_count > 0
      ? {
          at: d.evidence_submitted_at ? d.evidence_submitted_at.toISOString() : null,
          by_name: d.evidence_submitted_by_name,
          count: d.evidence_submission_count,
          files: FILE_FIELDS.flatMap((f) => items.filter((i) => i.evidence_field === f).map((i) => ({ field: f, file_name: i.file_name }))),
        }
      : null,
    can_edit: canEdit,
    can_submit: canEdit && d.evidence_staged_at !== null && hasContent(d),
    recommended: recommendedFields(d.reason),
  };
}

const auditMeta = (items: Pick<Item, 'evidence_field' | 'size_bytes' | 'page_count'>[], text: Record<string, string | undefined>) => ({
  files: namesOf(items as Item[]),
  bytes: items.reduce((n, i) => n + i.size_bytes, 0),
  pages: items.reduce((n, i) => n + i.page_count, 0),
  chars: textTotal(text),
  text_fields: TEXT_FIELDS.filter((f) => (text[f] ?? '').length > 0),
});

/** The processor said no and did not act: a card or invalid-request answer in the 4xx range (not a timeout or a retryable one). */
function isDefiniteRefusal(err: unknown): boolean {
  const e = (err ?? {}) as { type?: unknown; statusCode?: unknown };
  const type = typeof e.type === 'string' ? e.type : '';
  const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
  if (type === 'StripeCardError' || type === 'StripeInvalidRequestError') return status === 0 || (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429);
  return false;
}

/** The evidence field a processor error points at (its `param` reads like "evidence[receipt]"), or null. */
function fieldNamedBy(err: unknown): string | null {
  const param = (err as { param?: unknown } | null)?.param;
  const m = typeof param === 'string' ? /^evidence\W+(\w+)/.exec(param) : null;
  return m && (isFileField(m[1]) || isTextField(m[1])) ? m[1] : null;
}

function refuse(res: Response, e: unknown, what: string): boolean {
  if (e instanceof Refusal) {
    res.status(e.status).json(e.body);
    return true;
  }
  logger.error(`dispute evidence ${what} failed`, e);
  res.status(500).json({ error: 'Could not save the dispute evidence' });
  return false;
}

// GET /api/payments-page/disputes/:id/evidence
export async function getEvidence(req: Request, res: Response) {
  try {
    const d = await load(req, String(req.params.id));
    if (!d) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(stateOf(req, d));
  } catch (e) {
    refuse(res, e, 'read');
  }
}

interface Changed { field: string; attachmentId: string; name: string; path: string; bytes: Buffer; mime: string; pages: number }

// PUT /api/payments-page/disputes/:id/evidence   { version, files: { field: attachmentId | null }, text: { field: string } }
export async function stageEvidence(req: Request, res: Response) {
  try {
    const parsed = stageBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'The evidence could not be read. Reload and try again.' });
      return;
    }
    const { version, files: wanted, text: typed } = parsed.data;
    for (const f of Object.keys(wanted)) if (!isFileField(f)) throw new Refusal(400, { error: 'That is not a place to attach a file.', field: f });
    for (const [f, v] of Object.entries(typed)) {
      if (!isTextField(f)) throw new Refusal(400, { error: 'That is not a field on this form.', field: f });
      if (v.length > TEXT_FIELD_MAX[f]) throw new Refusal(400, { error: `${FIELD_LABELS[f]} is too long.`, field: f });
    }

    const d = await load(req, String(req.params.id));
    if (!d) throw new Refusal(404, { error: NOT_FOUND });
    const closed = closedReason(d);
    if (closed) throw new Refusal(409, { error: closed });
    if (version !== d.evidence_version) throw new Refusal(409, { error: STALE });

    const existing = new Map(d.evidence_items.map((i) => [i.evidence_field, i]));
    const cleared = Object.entries(wanted).filter(([f, id]) => id === null && existing.has(f)).map(([f]) => f);
    const changing = Object.entries(wanted).filter((e): e is [string, string] => e[1] !== null && existing.get(e[0])?.attachment_id !== e[1]);

    // The same file in two places: judged on the final picture, so a file moved between fields in one save is fine.
    const finalIds = new Map<string, string>();
    for (const i of d.evidence_items) if (!cleared.includes(i.evidence_field) && !changing.some(([f]) => f === i.evidence_field)) finalIds.set(i.evidence_field, i.attachment_id);
    for (const [f, id] of changing) finalIds.set(f, id);
    const seenIds = new Set<string>();
    for (const f of FILE_FIELDS) {
      const id = finalIds.get(f);
      if (!id) continue;
      if (seenIds.has(id)) throw new Refusal(400, { error: 'That file is already attached to another field.', field: f });
      seenIds.add(id);
    }

    const rows = changing.length
      ? await prisma.attachment.findMany({
          where: { id: { in: changing.map(([, id]) => id) }, ...tenantWhere(req) },
          select: { id: true, entity_type: true, entity_id: true, storage_path: true, file_name: true },
        })
      : [];
    const changed: Changed[] = [];
    for (const [field, attachmentId] of changing) {
      const row = rows.find((r) => r.id === attachmentId);
      if (!row || row.entity_type !== 'INVOICE' || row.entity_id !== d.invoice_id || !row.storage_path) {
        throw new Refusal(404, { error: FILE_NOT_FOUND, field });
      }
      const size = await storedObjectSize(row.storage_path);
      if (size === null) throw new Refusal(404, { error: FILE_NOT_FOUND, field });
      if (size > LIMITS.max_bytes) {
        throw new Refusal(400, { ...(checkTotals({ slots: [{ field, size_bytes: size, page_count: 1 }], text: {}, cardBrand: null }) ?? { error: 'That file is too large.' }), field });
      }
      const bytes = await readStoredObject(row.storage_path);
      if (!bytes) throw new Refusal(502, { error: "We couldn't read that file. Try again in a moment.", field });
      const seen = await inspectEvidenceBytes(bytes);
      if (!seen.ok) throw new Refusal(400, { error: seen.error, field });
      changed.push({ field, attachmentId, name: row.file_name, path: row.storage_path, bytes, mime: seen.mime, pages: seen.pages });
    }

    const mergedText = { ...storedText(d), ...typed };
    const finalSlots: EvidenceSlot[] = [
      ...d.evidence_items.filter((i) => !cleared.includes(i.evidence_field) && !changing.some(([f]) => f === i.evidence_field)).map((i) => ({ field: i.evidence_field, size_bytes: i.size_bytes, page_count: i.page_count })),
      ...changed.map((c) => ({ field: c.field, size_bytes: c.bytes.length, page_count: c.pages })),
    ];
    const over = checkTotals({ slots: finalSlots, text: mergedText, cardBrand: d.payment.card_brand });
    if (over) throw new Refusal(400, { ...over });

    // One short transaction, nothing from the processor inside it.
    const touched = [...cleared, ...changed.map((c) => c.field)];
    const orgId = req.user!.organization_id;
    await prisma.$transaction(async (tx) => {
      const bumped = await tx.dispute.updateMany({
        where: { id: d.id, organization_id: orgId, evidence_version: version, evidence_submission_count: 0 },
        data: { evidence_text: mergedText as Prisma.InputJsonValue, evidence_version: { increment: 1 }, evidence_staged_at: null },
      });
      if (bumped.count !== 1) throw new Refusal(409, { error: STALE });
      if (touched.length) await tx.disputeEvidenceItem.deleteMany({ where: { dispute_id: d.id, organization_id: orgId, evidence_field: { in: touched } } });
      if (changed.length) {
        await tx.disputeEvidenceItem.createMany({
          data: changed.map((c) => ({
            organization_id: orgId, dispute_id: d.id, evidence_field: c.field, attachment_id: c.attachmentId, file_name: c.name, mime: c.mime,
            size_bytes: c.bytes.length, page_count: c.pages, sha256: createHash('sha256').update(c.bytes).digest('hex'),
          })),
        });
      }
    });

    // The processor: every slot not yet staged goes up again (a file token is single-use), then the whole text.
    const accountId = d.payment.stripe_account_id;
    const fresh = await prisma.disputeEvidenceItem.findMany({ where: { dispute_id: d.id, organization_id: orgId } });
    const tokens = new Map<string, string>();
    let uploading: string | null = null;
    try {
      for (const item of fresh.filter((i) => !i.staged_at)) {
        uploading = item.evidence_field;
        const have = changed.find((c) => c.field === item.evidence_field && c.attachmentId === item.attachment_id);
        let bytes = have?.bytes ?? null;
        if (!bytes) {
          const att = await prisma.attachment.findFirst({ where: { id: item.attachment_id, ...tenantWhere(req) }, select: { storage_path: true } });
          bytes = att?.storage_path ? await readStoredObject(att.storage_path) : null;
          if (!bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
            throw new Refusal(409, { error: 'This file changed after it was attached. Attach it again.', field: item.evidence_field });
          }
        }
        tokens.set(item.evidence_field, await uploadDisputeEvidenceFile(accountId, { data: bytes, name: item.file_name, mime: item.mime }));
      }
      uploading = null;
      const evidence: Record<string, string> = {};
      for (const f of FILE_FIELDS) {
        if (!fresh.some((i) => i.evidence_field === f)) evidence[f] = '';
        else if (tokens.has(f)) evidence[f] = tokens.get(f)!;
      }
      for (const f of TEXT_FIELDS) evidence[f] = mergedText[f] ?? '';
      await stageDisputeEvidence(accountId, d.stripe_dispute_id, evidence);
    } catch (e) {
      // The draft is stored and its version has moved on, so the answer carries the form as a 200 does: the retry
      // then sends that version instead of the stale one the browser still holds.
      const named = e instanceof Refusal ? (typeof e.body.field === 'string' ? e.body.field : null) : (fieldNamedBy(e) ?? uploading);
      const refusedField = named && isFileField(named) ? named : null;
      const stored = await load(req, d.id);
      const state = stored ? { ...stateOf(req, stored, refusedField), staged: false } : {};
      if (e instanceof Refusal) throw new Refusal(e.status, { ...state, ...e.body, sent: false, draft_saved: true });
      logger.error(`dispute evidence stage refused: ${redactProcessorText(e)}`);
      throw new Refusal(502, { ...state, error: describeProcessorFailure(e), ...(named ? { field: named } : {}), sent: false, draft_saved: true });
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const item of fresh.filter((i) => !i.staged_at)) {
        await tx.disputeEvidenceItem.update({ where: { id: item.id }, data: { staged_at: now, processor_file_id: tokens.get(item.evidence_field) ?? null } });
      }
      // Only the draft this call saved is marked staged: a newer save in between leaves its own draft unstaged.
      await tx.dispute.updateMany({ where: { id: d.id, organization_id: orgId, evidence_version: version + 1 }, data: { evidence_staged_at: now } });
    });

    await logAudit({ req, action: 'dispute.evidence_staged', resourceType: 'Dispute', resourceId: d.id, metadata: auditMeta(fresh, mergedText) });
    const after = await load(req, d.id);
    res.json({ ...stateOf(req, after!), staged: true, warnings: hasContent(after!) ? [] : ['empty'] });
  } catch (e) {
    refuse(res, e, 'stage');
  }
}

// POST /api/payments-page/disputes/:id/evidence/submit   { version }
export async function submitEvidence(req: Request, res: Response) {
  try {
    const parsed = submitBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'The evidence could not be read. Reload and try again.' });
      return;
    }
    const { version } = parsed.data;
    const d = await load(req, String(req.params.id));
    if (!d) throw new Refusal(404, { error: NOT_FOUND });
    // Already sent: the same answer again, and no second call to the processor.
    if (d.evidence_submission_count > 0) {
      res.json(stateOf(req, d));
      return;
    }
    const closed = closedReason(d);
    if (closed) throw new Refusal(409, { error: closed });
    if (version !== d.evidence_version) throw new Refusal(409, { error: STALE });
    if (!d.evidence_staged_at) throw new Refusal(409, { error: NOT_SAVED });
    if (!hasContent(d)) throw new Refusal(409, { error: NOTHING_TO_SUBMIT });
    const over = checkTotals({ slots: slotsOf(d.evidence_items), text: storedText(d), cardBrand: d.payment.card_brand });
    if (over) throw new Refusal(400, { ...over });

    const orgId = req.user!.organization_id;
    const who = `${req.user!.first_name} ${req.user!.last_name}`.trim();
    const claimedAt = new Date();
    // The claim: whoever flips the count from 0 makes the one processor call.
    const claim = await prisma.dispute.updateMany({
      where: { id: d.id, organization_id: orgId, evidence_submission_count: 0, evidence_version: version },
      data: { evidence_submitted_at: claimedAt, evidence_submitted_by: req.user!.id, evidence_submitted_by_name: who, evidence_submission_count: 1 },
    });
    if (claim.count !== 1) {
      const now = await load(req, d.id);
      if (now && now.evidence_submission_count > 0) {
        res.json(stateOf(req, now));
        return;
      }
      throw new Refusal(409, { error: STALE });
    }

    const accountId = d.payment.stripe_account_id;
    const rollback = () => prisma.dispute.updateMany({
      where: { id: d.id, organization_id: orgId, evidence_submitted_at: claimedAt },
      data: { evidence_submitted_at: null, evidence_submitted_by: null, evidence_submitted_by_name: null, evidence_submission_count: 0 },
    });
    try {
      await submitDisputeEvidence(accountId, d.stripe_dispute_id);
    } catch (e) {
      logger.error(`dispute evidence submit failed: ${redactProcessorText(e)}`);
      const words = describeProcessorFailure(e);
      // Submitting is final at the processor, so only a definite refusal (it said no) rolls the claim back blindly.
      // Anything else (timeout, dropped connection, 5xx, an "already submitted" answer) may have been accepted, so the
      // processor is asked what it holds before anything is un-stamped.
      if (isDefiniteRefusal(e) && words !== ALREADY_SUBMITTED) {
        await rollback();
        throw new Refusal(502, { error: words });
      }
      let held: number | null = null;
      try {
        held = await retrieveDisputeSubmissionCount(accountId, d.stripe_dispute_id);
      } catch (readErr) {
        logger.error(`dispute evidence submit read-back failed: ${redactProcessorText(readErr)}`);
      }
      if (held === null) {
        // Unknown: keep the claim (a retry then answers "already sent" without a second call) and let the dispute
        // webhook / the nightly dispute reconcile settle the real state.
        throw new Refusal(502, { error: 'Whether the evidence reached the card network is being checked. Reload in a minute to see its state.' });
      }
      if (held <= 0) {
        await rollback();
        throw new Refusal(502, { error: words });
      }
      // The processor holds it: keep the stamps and carry on as a success.
    }

    await prisma.disputeEvidenceItem.updateMany({ where: { dispute_id: d.id, organization_id: orgId }, data: { submitted_at: claimedAt } });
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId, entity_type: 'INVOICE', entity_id: d.invoice_id, event_type: TIMELINE_SUBMITTED,
        description: `Dispute evidence submitted by ${who}`, metadata: { dispute_id: d.id }, created_by: req.user!.id,
      },
    });
    await logAudit({ req, action: 'dispute.evidence_submitted', resourceType: 'Dispute', resourceId: d.id, metadata: auditMeta(d.evidence_items, storedText(d)) });
    const after = await load(req, d.id);
    res.json(stateOf(req, after!));
  } catch (e) {
    refuse(res, e, 'submit');
  }
}
