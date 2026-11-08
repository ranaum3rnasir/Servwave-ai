/**
 * Job line-item CRUD (SERV10X-38 Task 3 — job-owned items, pre-invoice).
 *
 * A `JobLineItem` is a running tally of billable work/materials tracked directly on the
 * JOB — BEFORE any invoice exists (Items tab, Task 6). Adding / editing / deleting a line
 * here NEVER creates, mutates, or otherwise touches an Invoice, and NEVER writes back to
 * PriceBookItem (a `price_book_item_id` is a reference-only snapshot, exactly like
 * InvoiceLineItem — see invoice-lines.controller.ts). Invoice creation FROM a job's items
 * is a separate, later task (Task 5); this controller's `billing` is a computed-on-read
 * preview (via `computeJobBilling`), never a persisted total.
 *
 * CASL note: these routes originally reused `update Job`, because no `manage_lines Job` action
 * existed - the write-up in task-3-report.md records that choice. The technician-ownership spec
 * undid it: `update Job` was one gate over job fields, line items, scopes, notes AND tags, and the
 * spec needs notes/tags to follow ASSIGNMENT while the money surface follows CREATION. PR 2 added
 * `manage_lines Job` and moved these eight writes onto it; PR 3 re-pointed the technician's copy of
 * it at `created_by_id`. GET (list) is still gated the lighter `read Job`.
 *
 * Gate: canDo('manage_lines','Job') [canDo('read','Job') for list] at the route +
 * canActOnRow(Job) per-instance inside the controller, under the route's own action.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canActOnRow, canSeePricing } from '../lib/permissions/enforce';
import { computeJobBilling } from '../lib/jobBilling';
import { asScopeArray, toScopeForTotals, stripScopeCost, stripScopeMoney, type ScopeOfWork } from '../lib/scopes';
import { addScopeSchema, updateScopeSchema, reorderScopeSchema } from './invoice-lines.controller';
import {
  applyStockMovement,
  ShortageError,
  shortageResponse,
  VanRestrictedError,
  vanRestrictedResponse,
  resolveRestrictedVan,
  resolveTrackedItem,
  orgBlocksNegativeStock,
  returnSyncedLines,
  legacyStockLineResponse,
  type TrackedItemInfo,
} from './inv-stock.controller';
import { logAudit } from '../lib/audit';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const NOT_BILLABLE_MSG =
  'This job is a service plan visit and cannot be billed with items — the plan was already paid upfront.';

/**
 * Internal sentinel: the line was present in the guarded snapshot but its row was already gone by
 * the time the delete ran (concurrent delete). Thrown INSIDE the transaction so the auto-return
 * rolls back with the no-op delete — otherwise two racing deletes would each return the same
 * units. Never escapes this module; deleteLine maps it to the same 404 as a missing line.
 */
class LineAlreadyGoneError extends Error {}

// --- Zod Schemas (validate() calls schema.parse(req.body) directly — no body: wrapper) ---

export const addLineSchema = z.object({
  description: z.string().min(1).max(LINE_DESCRIPTION_MAX),
  quantity: z.number().positive().max(100000),
  // Required for a price-visible requester (enforced in addLine — Zod alone can't see req.ability).
  // OPTIONAL here for a price-blind requester (D13c): the server resolves it from the price book
  // item's catalog price, defaulting to 0 when there is no price_book_item_id to resolve from.
  unit_price: z.number().min(0).optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  markup_percent: z.number().min(0).max(100000).nullable().optional(),
  is_taxable: z.boolean().default(true),
  item_type: z.enum(['SERVICE', 'MATERIAL']).default('SERVICE'),
  // Reference ONLY — copied into an independent snapshot; never written back to the catalog.
  price_book_item_id: z.string().uuid().optional(),
});

export const updateLineSchema = z.object({
  description: z.string().min(1).max(LINE_DESCRIPTION_MAX).optional(),
  quantity: z.number().positive().max(100000).optional(),
  unit_price: z.number().min(0).optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  markup_percent: z.number().min(0).max(100000).nullable().optional(),
  is_taxable: z.boolean().optional(),
  item_type: z.enum(['SERVICE', 'MATERIAL']).optional(),
});

// "order" is the COMPLETE new top-to-bottom list of ALL of this job's CURRENT line-item ids —
// never a partial/group-scoped subset. The frontend is responsible for splicing a within-group
// drag back into the full flat order before calling reorderLines; item_type grouping is a
// frontend display concept only, the backend just persists sequence 1..N as given.
export const reorderSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

// A flat-priced, non-line-item scope-of-work block (scopes.ts ScopeOfWork), imported from
// invoice-lines.controller.ts rather than redeclared here — Job.scopes and Invoice.scopes share
// the exact same JSONB shape, and importing guarantees the two never diverge. id is server-
// generated (crypto.randomUUID()) — never accepted from the client.
export { addScopeSchema, updateScopeSchema, reorderScopeSchema };

// --- Shared internals ---

const jobLineSelect = {
  id: true,
  job_id: true,
  sequence: true,
  description: true,
  quantity: true,
  unit_price: true,
  unit_cost: true,
  markup_percent: true,
  is_taxable: true,
  line_total: true,
  discount_type: true,
  discount_value: true,
  discount_amount: true,
  item_type: true,
  price_book_item_id: true,
  // The catalog photo the Job → Items grid renders at the head of each row's Item cell (shared
  // LineItemRow). Matches invoice.controller.ts's identical nested select — without it a
  // catalog-backed line falls back to the no-photo placeholder forever.
  price_book_item: { select: { image_url: true, photo_url: true } },
  stock_status: true,
  stock_location_id: true,
} as const;

type JobLineRow = {
  id: string;
  job_id: string;
  sequence: number;
  description: string;
  quantity: unknown;
  unit_price: unknown;
  unit_cost: unknown;
  markup_percent: unknown;
  is_taxable: boolean;
  line_total: unknown;
  discount_type: string | null;
  discount_value: unknown;
  discount_amount: unknown;
  item_type: string;
  price_book_item_id: string | null;
  price_book_item: { image_url: string | null; photo_url: string | null } | null;
  stock_status: string;
  stock_location_id: string | null;
};

// The owner-chain + billing-inputs select the handlers load on the parent job: E1/E2
// (job-owns-tax-discount) - tax_rate/discount_* live on the job itself now, no longer resolved
// through an attached estimate - plus the current lines + non-voided invoice totals
// computeJobBilling needs.
const jobGuardSelect = {
  id: true,
  status: true,
  source_plan_id: true,
  job_number: true,
  tax_rate: true,
  discount_amount: true,
  customer: { select: { tax_exempt: true } },
  visits: { select: { assignees: { select: { user_id: true } } } },
  job_line_items: { select: jobLineSelect, orderBy: { sequence: 'asc' as const } },
  invoices: { select: { total_amount: true, voided_at: true } },
  scopes: true,
} as const;

type GuardedJob = {
  id: string;
  status: string;
  source_plan_id: string | null;
  job_number: string;
  tax_rate: unknown;
  discount_amount: unknown;
  customer: { tax_exempt: boolean } | null;
  job_line_items: JobLineRow[];
  invoices: { total_amount: unknown; voided_at: Date | null }[];
  scopes: unknown;
};

/**
 * Load + guard the parent job for any line read/mutation. Returns the loaded row on
 * success, or null after having already written the 404 / 403 error response. Does NOT
 * enforce the "not a service-plan visit" rule — mutating handlers check that themselves
 * (list/read stays available even on a plan-visit job, which just never has any lines).
 *
 * `action` names the verb being guarded, and it is NOT decoration: since the technician-ownership
 * spec (Part C) a technician's `read Job` covers a job they are assigned to OR created, while
 * `manage_lines Job` covers only one they CREATED. Passing 'read' here for a mutation would ask
 * the wrong grant and hand every assignee the creator's line-item surface.
 */
async function loadGuardedJob(
  req: Request,
  res: Response,
  action: 'read' | 'manage_lines' = 'read',
): Promise<GuardedJob | null> {
  const job = await prisma.job.findUnique({
    where: { id: param(req, 'id'), ...tenantWhere(req) },
    select: jobGuardSelect,
  });
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  // Per-instance owner check (grant-driven SQL scope) — the route's canDo is subject-level only.
  if (!(await canActOnRow(req, 'Job', prisma.job, param(req, 'id'), action))) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return job as unknown as GuardedJob;
}

// Compute the {total, invoiced, remaining} preview from a given line set - the Items tab's full
// totals section, matching everything an Estimate's own totals show. E1/E2
// (job-owns-tax-discount): the job carries its OWN tax_rate and discount_amount - no longer
// resolved through an attached estimate, so an estimate that disagrees with the job never moves
// this preview. discount_amount is passed as the already-RESOLVED dollar figure (never
// discountType/discountValue), so it is never re-derived from a rate against this preview's own
// (possibly since-changed) subtotal - the drift ServiceTitan documents as their top billing-
// support driver (see the migration's rationale). It is re-resolved only when a caller explicitly
// PATCHes the discount (job.controller.ts update()).
//
// scopesOverride defaults to the guard-load snapshot's job.scopes — but a scope-mutating
// handler passes its own POST-mutation array instead, exactly like addLine/updateLine/deleteLine
// already pass their own post-mutation `lines` array rather than always reading job.job_line_items.
function billingFor(job: GuardedJob, lines: JobLineRow[], scopesOverride?: unknown) {
  return computeJobBilling({
    lines: lines.map((l) => ({
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      is_taxable: l.is_taxable,
    })),
    scopes: toScopeForTotals(asScopeArray(scopesOverride ?? job.scopes)),
    taxRate: Number(job.tax_rate),
    taxExempt: job.customer?.tax_exempt ?? false,
    discountAmount: Number(job.discount_amount),
    invoices: job.invoices.map((i) => ({ total_amount: Number(i.total_amount), voided_at: i.voided_at })),
  });
}

// Job-lines pricing strip — cost/margin (unit_cost, markup_percent) AND sell price (unit_price,
// line_total) are gated by the SAME canSeePricing (`read Invoice`) predicate that guards
// estimate/invoice money elsewhere. `update Job` (which gates every route here) is a TECHNICIAN
// role default since Spec A D3 and does NOT imply `read Invoice` — so a technician managing job
// lines sees a MATERIALS LIST: description, quantity, item type. No money. Strips the KEYS
// (mirrors job.controller's stripJobPricingForRequester convention).
function stripLinePricing<T extends Record<string, unknown>>(line: T, req: Request): T {
  if (canSeePricing(req)) return line;
  const out: Record<string, unknown> = { ...line };
  delete out.unit_cost;
  delete out.markup_percent;
  delete out.unit_price;
  delete out.line_total;
  return out as T;
}

function stripLinesPricing<T extends Record<string, unknown>>(lines: T[], req: Request): T[] {
  if (canSeePricing(req)) return lines;
  return lines.map((l) => stripLinePricing(l, req));
}

/**
 * The `billing` object is entirely money (subtotal/total/remaining preview). There is no useful
 * price-blind projection of it, so a price-blind requester gets null rather than a redacted
 * shell — the client must render "—", not a wrong number.
 */
function billingOrNull(
  job: GuardedJob,
  lines: JobLineRow[],
  req: Request,
  scopesOverride?: unknown,
): ReturnType<typeof billingFor> | null {
  return canSeePricing(req) ? billingFor(job, lines, scopesOverride) : null;
}

// --- Handlers ---

// GET /api/jobs/:id/line-items
export async function list(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res);
    if (!job) return;
    res.json({ lines: stripLinesPricing(job.job_line_items, req), billing: billingOrNull(job, job.job_line_items, req) });
  } catch (err) {
    logger.error('Error listing job line items:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/jobs/:id/line-items
export async function addLine(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const body = req.body as z.infer<typeof addLineSchema>;
    if (!canSeePricing(req)) {
      // D13c: a price-blind submitter's own unit_price (if any — the field is optional for this
      // path) is never trusted. Resolve BOTH sell price and cost server-side from the catalog
      // snapshot so internal job-costing stays accurate even though this requester never sees
      // either value (stripLinePricing strips both from the response below). No catalog ref →
      // a free-text line, priced 0 (the requester cannot supply a price to fall back to).
      if (body.price_book_item_id) {
        const catalogItem = await prisma.priceBookItem.findFirst({
          where: { id: body.price_book_item_id, ...tenantWhere(req), is_active: true },
          select: { unit_price: true, unit_cost: true },
        });
        if (!catalogItem) {
          res.status(404).json({ error: 'Price book item not found' });
          return;
        }
        body.unit_price = Number(catalogItem.unit_price);
        body.unit_cost = catalogItem.unit_cost != null ? Number(catalogItem.unit_cost) : undefined;
      } else {
        body.unit_price = 0;
        body.unit_cost = undefined;
      }
      body.markup_percent = undefined;
    } else if (body.unit_price === undefined) {
      res.status(400).json({ error: 'unit_price is required' });
      return;
    }
    const lineTotal = round2(body.quantity * body.unit_price);
    // Next sequence = max(existing) + 1 (robust to a prior delete leaving a gap).
    const nextSequence = job.job_line_items.reduce((m, l) => Math.max(m, l.sequence), 0) + 1;

    // LO-4: adding a line NEVER moves stock — Logistic Orders own all deduction. Every new line
    // is stamped NOT_TRACKED (clean-era marker; the legacy UNSYNCED/SYNCED add stamps retired
    // with the sync routes). The line is a pure independent snapshot; no catalog/inventory read.
    const line = await prisma.jobLineItem.create({
      data: {
        job_id: job.id,
        organization_id: req.user!.organization_id,
        sequence: nextSequence,
        description: body.description,
        quantity: body.quantity,
        unit_price: body.unit_price,
        is_taxable: body.is_taxable,
        line_total: lineTotal,
        item_type: body.item_type,
        ...(body.unit_cost != null ? { unit_cost: body.unit_cost } : {}),
        ...(body.markup_percent != null ? { markup_percent: body.markup_percent } : {}),
        ...(body.price_book_item_id ? { price_book_item_id: body.price_book_item_id } : {}),
        stock_status: 'NOT_TRACKED' as const,
        stock_location_id: null,
      },
      select: jobLineSelect,
    });

    const billing = billingOrNull(job, [...job.job_line_items, line], req);

    void logAudit({
      req,
      action: 'job.line_added',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { stock_status: 'NOT_TRACKED' },
    });
    res.status(201).json({ line: stripLinePricing(line, req), billing });
  } catch (err) {
    logger.error('Error adding job line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/jobs/:id/line-items/reorder — persist a full drag-and-drop reorder. MUST be
// registered BEFORE PATCH /:id/line-items/:lineId in job.routes.ts: Express matches routes in
// registration order, and ":lineId" would otherwise capture the literal path segment "reorder"
// (routing to updateLine with lineId="reorder" instead of here) — see the routing comment there.
export async function reorderLines(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const { order } = req.body as z.infer<typeof reorderSchema>;

    // All-or-nothing: 400 unless "order" is EXACTLY this job's current line id set (same count,
    // no duplicates, no foreign ids, nothing missing) — never partially apply a malformed reorder.
    const currentIds = job.job_line_items.map((l) => l.id);
    const currentSet = new Set(currentIds);
    const orderSet = new Set(order);
    const isExactMatch =
      order.length === currentIds.length &&
      orderSet.size === order.length &&
      order.every((id) => currentSet.has(id));
    if (!isExactMatch) {
      res.status(400).json({
        error: "The submitted order must contain exactly this job's current line items — no missing, extra, or duplicate ids",
      });
      return;
    }

    // Single transaction — every line gets its new sequence atomically, or none do.
    await prisma.$transaction(
      order.map((lineId, idx) =>
        prisma.jobLineItem.update({
          where: { id: lineId, job_id: job.id },
          data: { sequence: idx + 1 },
        }),
      ),
    );

    // Reconstruct the post-reorder line set from the guard-load snapshot (same convention as
    // updateLine's `nextLines` / deleteLine's `remainingLines` below — no extra read needed since
    // every line's new sequence is exactly its position in "order", already validated above).
    const sequenceById = new Map(order.map((id, idx) => [id, idx + 1]));
    const reordered = job.job_line_items
      .map((l) => ({ ...l, sequence: sequenceById.get(l.id)! }))
      .sort((a, b) => a.sequence - b.sequence);

    const billing = billingOrNull(job, reordered, req);

    void logAudit({ req, action: 'job.lines_reordered', resourceType: 'Job', resourceId: job.id });
    // Same {line, billing} shape updateLine returns below, so callers don't need special-casing
    // for this endpoint — but a reorder touches EVERY line (not "the" one line an edit touches),
    // so `line` holds the full resequenced array rather than a single row.
    res.json({ line: stripLinesPricing(reordered, req), billing });
  } catch (err) {
    logger.error('Error reordering job lines:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/jobs/:id/line-items/:lineId
export async function updateLine(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const lineId = param(req, 'lineId');
    const existingLine = job.job_line_items.find((l) => l.id === lineId);
    if (!existingLine) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }

    const body = req.body as z.infer<typeof updateLineSchema>;
    // Drop cost/margin fields BEFORE the write when the requester can't `read Invoice` — see
    // addLine's identical guard for why both the write AND the response must strip these.
    if (!canSeePricing(req)) {
      body.unit_cost = undefined;
      body.markup_percent = undefined;
      // Sell-price write lock (D13, Spec A). The response strip alone is not enough: without
      // this a price-blind technician could add a line at the server-resolved price, then PATCH
      // it to any number. The `??` fallback below already treats an undefined value as "keep
      // the existing value", which is exactly the semantics we want here.
      body.unit_price = undefined;
    }
    const quantity = body.quantity ?? Number(existingLine.quantity);
    const unitPrice = body.unit_price ?? Number(existingLine.unit_price);
    const isTaxable = body.is_taxable ?? existingLine.is_taxable;
    const lineTotal = round2(quantity * unitPrice);

    // C2 legacy freeze (LO-4, spec §14): Logistic Orders now own all stock deduction, so a QUANTITY
    // edit on a legacy `stock_status='SYNCED'` line is refused (400 LEGACY_STOCK_LINE) before any
    // write — it would silently desync stock. Price/description/tax/cost edits still flow;
    // UNSYNCED/NOT_TRACKED lines are unaffected; delete-with-auto-return is untouched. No new line
    // is ever SYNCED (all new lines stamp NOT_TRACKED), so this only guards legacy inline-deducted
    // rows.
    if (
      existingLine.stock_status === 'SYNCED' &&
      body.quantity !== undefined &&
      round2(quantity - Number(existingLine.quantity)) !== 0
    ) {
      legacyStockLineResponse(res);
      return;
    }

    // Scoped to the line AND its parent job (no cross-job edit). No stock movement runs here.
    const updated = await prisma.$transaction(async (tx) =>
      tx.jobLineItem.update({
        where: { id: lineId, job_id: job.id },
        data: {
          ...(body.description !== undefined ? { description: body.description } : {}),
          quantity,
          unit_price: unitPrice,
          is_taxable: isTaxable,
          line_total: lineTotal,
          ...(body.item_type !== undefined ? { item_type: body.item_type } : {}),
          ...(body.unit_cost !== undefined ? { unit_cost: body.unit_cost } : {}),
          ...(body.markup_percent !== undefined ? { markup_percent: body.markup_percent } : {}),
        },
        select: jobLineSelect,
      }),
    );

    const nextLines = job.job_line_items.map((l) => (l.id === lineId ? updated : l));
    const billing = billingOrNull(job, nextLines, req);

    void logAudit({
      req,
      action: 'job.line_updated',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { line_id: lineId },
    });
    res.json({ line: stripLinePricing(updated, req), billing });
  } catch (err) {
    logger.error('Error updating job line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/jobs/:id/line-items/:lineId
export async function deleteLine(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const lineId = param(req, 'lineId');
    const existingLine = job.job_line_items.find((l) => l.id === lineId);
    if (!existingLine) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }

    // Inventory P1 (§4.3): deleting a SYNCED line owes the same auto-return every other
    // destructive verb performs (job delete/cancel, invoice delete/void). Without it the
    // deducted units were stranded forever — reducing a line 3→0 returned 3, but DELETING
    // that same line returned nothing. The movement must be written BEFORE the row dies:
    // its job_line_item_id FK has to exist at insert, and SetNull then preserves the ledger
    // row after the delete. UNSYNCED / NOT_TRACKED lines never deducted, so they move nothing.
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    await prisma.$transaction(async (tx) => {
      if (existingLine.stock_status === 'SYNCED') {
        await returnSyncedLines(tx, [existingLine], {
          orgId: req.user!.organization_id,
          reference: `${job.job_number} line deleted`,
          actor,
          actorUserId: req.user!.id,
          jobId: job.id,
          lineRef: 'job',
        });
      }
      // Scoped to the line AND its parent job — never a cross-job delete.
      const result = await tx.jobLineItem.deleteMany({ where: { id: lineId, job_id: job.id } });
      if (result.count === 0) throw new LineAlreadyGoneError();
    });

    const remainingLines = job.job_line_items.filter((l) => l.id !== lineId);
    const billing = billingOrNull(job, remainingLines, req);

    void logAudit({
      req,
      action: 'job.line_deleted',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { line_id: lineId },
    });
    res.json({ billing });
  } catch (err) {
    // Raced with another delete: the auto-return rolled back with it, so nothing was moved.
    if (err instanceof LineAlreadyGoneError) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }
    logger.error('Error deleting job line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Sync-with-inventory (Inventory P1 §3.2 / D1): deduct stock for UNSYNCED tracked lines ---

export const syncStockSchema = z.object({ location_id: z.string().uuid() });
export const bulkSyncStockSchema = z.object({
  location_id: z.string().uuid(),
  // Absent ⇒ every line is a candidate (only UNSYNCED tracked ones actually deduct).
  line_ids: z.array(z.string().uuid()).min(1).optional(),
});

// Line-level eligibility from the line's own stamped state. Forward deduction ALSO re-checks the
// item's CURRENT track_inventory flag (QA-104) — that second check lives at the resolve step.
function syncSkipReason(line: JobLineRow): 'already_synced' | 'not_tracked' | null {
  if (line.stock_status === 'SYNCED') return 'already_synced';
  if (line.stock_status === 'NOT_TRACKED') return 'not_tracked';
  return null;
}

// Shared guards + location/policy resolution for both sync endpoints. Writes the error response
// and returns null on any refusal.
async function prepareJobSync(req: Request, res: Response): Promise<{
  job: GuardedJob;
  location: { id: string };
  blockNegative: boolean;
  actor: string;
} | null> {
  const job = await loadGuardedJob(req, res, 'manage_lines');
  if (!job) return null;
  if (job.source_plan_id) {
    res.status(400).json({ error: NOT_BILLABLE_MSG });
    return null;
  }
  // Cancel is terminal (no un-cancel verb): deducting onto a CANCELLED job would strand stock
  // with no reversal trigger left (QA-419 / A-13). Any other status (incl. COMPLETED) may sync.
  if (job.status === 'CANCELLED') {
    res.status(409).json({ error: 'JOB_CANCELLED', message: 'Cannot sync stock on a cancelled job' });
    return null;
  }
  // P3 restricted-tech van forcing (D10/D13): the sync schemas REQUIRE location_id, so a
  // restricted tech's only legal value is their own van — anything else refuses the WHOLE
  // request up-front (bulk included), keeping the per-line results contract (QA-404/QA-408).
  const { restricted, vanId } = await resolveRestrictedVan(req);
  if (restricted && (req.body as { location_id: string }).location_id !== vanId) {
    vanRestrictedResponse(res, new VanRestrictedError(vanId));
    return null;
  }
  const location = await prisma.inventoryLocation.findFirst({
    where: { id: (req.body as { location_id: string }).location_id, ...tenantWhere(req) },
    select: { id: true },
  });
  if (!location) {
    res.status(404).json({ error: 'Stock location not found' });
    return null;
  }
  const blockNegative = await orgBlocksNegativeStock(req.user!.organization_id);
  const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
  return { job, location, blockNegative, actor };
}

// One SMALL tx per line: consume movement + SYNCED stamp. Movement BEFORE the stamp — a
// block-mode ShortageError aborts the tx with the line still UNSYNCED and no movement (QA-408).
async function syncOneJobLine(
  req: Request,
  job: GuardedJob,
  line: JobLineRow,
  item: TrackedItemInfo,
  locationId: string,
  blockNegative: boolean,
  actor: string,
) {
  return prisma.$transaction(async (tx) => {
    const result = await applyStockMovement(tx, {
      orgId: req.user!.organization_id,
      type: 'consume',
      itemSku: item.sku,
      itemName: item.name,
      qty: Number(line.quantity),
      itemId: item.id,
      jobId: job.id,
      jobLineItemId: line.id,
      unitCost: item.unitCost,
      actorUserId: req.user!.id,
      fromLocationId: locationId,
      reference: job.job_number,
      actor,
      blockNegative,
    });
    await tx.jobLineItem.update({
      where: { id: line.id, job_id: job.id },
      data: { stock_status: 'SYNCED', stock_location_id: locationId },
    });
    return result;
  });
}

// POST /api/jobs/:id/line-items/:lineId/sync-stock
export async function syncStockLine(req: Request, res: Response) {
  try {
    const ctx = await prepareJobSync(req, res);
    if (!ctx) return;
    const { job, location, blockNegative, actor } = ctx;

    const lineId = param(req, 'lineId');
    const line = job.job_line_items.find((l) => l.id === lineId);
    if (!line) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }
    const skip = syncSkipReason(line);
    if (skip) {
      res.status(400).json({ error: 'LINE_NOT_SYNCABLE', reason: skip });
      return;
    }
    // Forward deduction re-checks the CURRENT flag (QA-104): flag flipped off ⇒ not syncable;
    // the line's stamped state is untouched.
    const item = await resolveTrackedItem(req.user!.organization_id, line.price_book_item_id);
    if (!item || !item.tracked) {
      res.status(400).json({ error: 'LINE_NOT_SYNCABLE', reason: 'item_not_tracked' });
      return;
    }

    const result = await syncOneJobLine(req, job, line, item, location.id, blockNegative, actor);

    // Snapshot + overlay reconstruction (reorderLines' convention) — no extra read needed.
    const synced = { ...line, stock_status: 'SYNCED', stock_location_id: location.id };
    const lines = job.job_line_items.map((l) => (l.id === lineId ? synced : l));
    void logAudit({
      req,
      action: 'job.line_stock_synced',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { line_id: lineId, location_id: location.id },
    });
    res.json({
      line: stripLinePricing(synced, req),
      billing: billingOrNull(job, lines, req),
      stock: { shortage: result.shortage, on_hand_after: result.onHandAfter, location_id: location.id },
    });
  } catch (err) {
    if (err instanceof ShortageError) {
      shortageResponse(res, err);
      return;
    }
    logger.error('Error syncing job line stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/jobs/:id/line-items/sync-stock
export async function bulkSyncStock(req: Request, res: Response) {
  try {
    const ctx = await prepareJobSync(req, res);
    if (!ctx) return;
    const { job, location, blockNegative, actor } = ctx;
    const { line_ids: lineIds } = req.body as z.infer<typeof bulkSyncStockSchema>;

    let candidates = job.job_line_items;
    if (lineIds) {
      const current = new Set(candidates.map((l) => l.id));
      if (!lineIds.every((id) => current.has(id))) {
        res.status(400).json({ error: 'One or more line_ids do not belong to this job' });
        return;
      }
      const wanted = new Set(lineIds);
      candidates = candidates.filter((l) => wanted.has(l.id));
    }

    // Sequential, one small tx per line (deterministic sequence order) — a shortage on line 3
    // must NOT roll back lines 1–2; each line gets its own per-line result (QA-404).
    const results: Array<Record<string, unknown>> = [];
    const overlay = new Map<string, { stock_status: string; stock_location_id: string | null }>();
    for (const line of candidates) {
      const skip = syncSkipReason(line);
      if (skip) {
        results.push({ line_id: line.id, status: 'skipped', reason: skip });
        continue;
      }
      const item = await resolveTrackedItem(req.user!.organization_id, line.price_book_item_id);
      if (!item || !item.tracked) {
        results.push({ line_id: line.id, status: 'skipped', reason: 'item_not_tracked' });
        continue;
      }
      try {
        const result = await syncOneJobLine(req, job, line, item, location.id, blockNegative, actor);
        overlay.set(line.id, { stock_status: 'SYNCED', stock_location_id: location.id });
        results.push({ line_id: line.id, status: 'synced', shortage: result.shortage, on_hand_after: result.onHandAfter });
      } catch (err) {
        if (err instanceof ShortageError) {
          // Block mode: that line's tx rolled back — no movement, line STAYS UNSYNCED (QA-408).
          results.push({ line_id: line.id, status: 'shortage', requested: err.requested, available: err.available });
        } else {
          throw err;
        }
      }
    }

    const lines = job.job_line_items.map((l) => (overlay.has(l.id) ? { ...l, ...overlay.get(l.id)! } : l));
    void logAudit({
      req,
      action: 'job.lines_stock_synced',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: {
        location_id: location.id,
        synced: results.filter((r) => r.status === 'synced').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        shortage: results.filter((r) => r.status === 'shortage').length,
      },
    });
    // billing is unchanged by sync — returned for shape consistency with the other line mutations.
    res.json({ results, lines: stripLinesPricing(lines, req), billing: billingOrNull(job, lines, req) });
  } catch (err) {
    logger.error('Error bulk-syncing job line stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Scopes of work (Stage 5/6): flat-priced, non-line-item blocks stored on Job.scopes ---
// Mirrors invoice-lines.controller.ts's scope handlers EXACTLY (same B6/B7-shaped guard
// sequence): each mutation wraps its read-validate-write in prisma.$transaction, re-reading
// Job.scopes FRESH via tx.job.findUnique immediately before computing the new array and
// writing via tx.job.update. This is NOT optional even though job billing itself is
// computed-on-read/never persisted — loadGuardedJob's snapshot is taken once at the top of the
// request, and two concurrent scope mutations on the same job (e.g. an addScope racing a
// reorderScopes, or two reorderScopes calls) would otherwise race: whichever job.update commits
// second would silently overwrite the other's change using its own stale in-memory copy,
// permanently losing data. Job needs its OWN GET /:id/scopes route — jobDetailSelect doesn't
// embed job_line_items either (see this file's header for why), which is why a dedicated
// GET /:id/line-items already exists; the same precedent applies to scopes.

// GET /api/jobs/:id/scopes
export async function listScopes(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res);
    if (!job) return;
    const scopes = asScopeArray(job.scopes);
    const billing = billingOrNull(job, job.job_line_items, req, scopes);
    res.json({ scopes: canSeePricing(req) ? scopes : stripScopeMoney(scopes), billing });
  } catch (err) {
    logger.error('Error listing job scopes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/jobs/:id/scopes
export async function addScope(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const body = req.body as z.infer<typeof addScopeSchema>;
    // Drop cost data BEFORE the write when the requester can't `read Invoice` — mirrors
    // addLine's identical unit_cost/markup_percent guard above (job-lines pricing-leak
    // follow-up, scopes half). `delete`, not `= undefined` — see updateScope's identical
    // guard for why the distinction matters there; harmless either way here since this is a
    // brand-new scope with no pre-existing value to preserve, but kept consistent.
    if (!canSeePricing(req)) {
      delete body.internal_cost;
      // Sell-price write lock (D13, Spec A) — mirror of the internal_cost guard above. A
      // requester who cannot see a price must not be able to SET one either, or the response
      // strip merely hides the number they just planted.
      delete body.flat_price;
    }
    const newScope: ScopeOfWork = {
      id: crypto.randomUUID(),
      title: body.title,
      body: body.body ?? '',
      flat_price: body.flat_price ?? null,
      is_taxable: body.is_taxable ?? true,
      internal_cost: body.internal_cost ?? null,
    };

    const scopes = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust loadGuardedJob's
      // once-per-request snapshot, which may now be stale against a concurrent scope mutation).
      const current = await tx.job.findUnique({ where: { id: job.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      fresh.push(newScope);

      await tx.job.update({
        where: { id: job.id, ...tenantWhere(req) },
        data: { scopes: fresh as unknown as Prisma.InputJsonValue },
      });

      return fresh;
    });

    const billing = billingOrNull(job, job.job_line_items, req, scopes);

    void logAudit({
      req,
      action: 'job.scope_added',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { scope_id: newScope.id },
    });
    res.status(201).json({ scopes: canSeePricing(req) ? scopes : stripScopeMoney(scopes), billing });
  } catch (err) {
    logger.error('Error adding job scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/jobs/:id/scopes/:idx
export async function updateScope(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const idx = parseInt(param(req, 'idx'), 10);
    const body = req.body as z.infer<typeof updateScopeSchema>;
    // Drop cost data BEFORE the merge when the requester can't `read Invoice` — mirrors
    // updateLine's identical unit_cost/markup_percent guard. MUST be `delete`, not
    // `body.internal_cost = undefined`: the merge below is a full-object spread over the
    // EXISTING scope, and an explicitly-undefined-valued key is still an own enumerable
    // property that spread applies — it would clobber a pre-existing internal_cost to
    // undefined even when the low-priv caller's edit never mentioned that field. `delete`
    // makes an ignored/attempted submission behave exactly like zod's own "omitted key"
    // semantics the comment below already relies on for every other field.
    if (!canSeePricing(req)) {
      delete body.internal_cost;
      // Sell-price write lock (D13, Spec A). MUST be `delete`, not `body.flat_price = undefined`
      // — the merge below is a full-object spread over the EXISTING scope, and an
      // explicitly-undefined-valued key is still an own enumerable property that spread applies,
      // so it would clobber a pre-existing flat_price to undefined even when the low-priv
      // caller's edit never mentioned the field. Mirrors the existing internal_cost handling.
      delete body.flat_price;
    }

    const scopes = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust loadGuardedJob's
      // once-per-request snapshot) — idx is validated against THIS fresh length, not the
      // guard-load snapshot's, so a concurrent delete/reorder that shrank/reshuffled the array
      // in between is correctly rejected rather than blindly merged onto a stale index.
      const current = await tx.job.findUnique({ where: { id: job.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      if (!Number.isInteger(idx) || idx < 0 || idx >= fresh.length) {
        return null;
      }
      // Merge onto the existing scope — a field the client omits is left untouched; a field
      // explicitly sent as null (e.g. flat_price: null) overwrites with null (zod's .partial()
      // omits untouched keys entirely from the parsed body, so the spread never clobbers them).
      fresh[idx] = { ...fresh[idx], ...body };

      await tx.job.update({
        where: { id: job.id, ...tenantWhere(req) },
        data: { scopes: fresh as unknown as Prisma.InputJsonValue },
      });

      return fresh;
    });

    if (!scopes) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }

    const billing = billingOrNull(job, job.job_line_items, req, scopes);

    void logAudit({
      req,
      action: 'job.scope_updated',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { idx },
    });
    res.json({ scopes: canSeePricing(req) ? scopes : stripScopeMoney(scopes), billing });
  } catch (err) {
    logger.error('Error updating job scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/jobs/:id/scopes/reorder — persist a full scope-block reorder atomically. MUST be
// registered BEFORE PATCH /:id/scopes/:idx in job.routes.ts — same Express route-order gotcha as
// line-items/reorder above (":idx" would otherwise capture the literal path segment "reorder").
// Closes the lost-update race a "Move up/down" UI action would otherwise hit if it fired two
// concurrent index-addressed PATCH /scopes/:idx calls to swap two blocks (each a non-atomic
// whole-column read-modify-write with no locking): a single all-or-nothing reorder call, re-
// reading Job.scopes FRESH inside a transaction (never the loadGuardedJob snapshot, which may
// now be stale) and validating the submitted order against that FRESH id set before its one
// write, replaces the two racing requests with one (mirrors invoice-lines.controller.ts's
// reorderScopes) — a stale/raced submission gets rejected with 400 rather than silently
// overwriting whatever landed in between.
export async function reorderScopes(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const { order } = req.body as z.infer<typeof reorderScopeSchema>;

    const reordered = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust loadGuardedJob's
      // once-per-request snapshot) — the exact-match validation below runs against THIS fresh
      // set, so a concurrent scope mutation that landed in between is correctly rejected.
      const current = await tx.job.findUnique({ where: { id: job.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      const byId = new Map(fresh.map((s) => [s.id, s]));
      const currentIds = fresh.map((s) => s.id);
      const currentSet = new Set(currentIds);
      const orderSet = new Set(order);
      // All-or-nothing: 400 unless "order" is EXACTLY this job's current scope id set (same count,
      // no duplicates, no foreign ids, nothing missing) — never partially apply a malformed reorder.
      const isExactMatch =
        order.length === currentIds.length &&
        orderSet.size === order.length &&
        order.every((id) => currentSet.has(id));
      if (!isExactMatch) {
        return null;
      }

      const next = order.map((id) => byId.get(id)!);
      await tx.job.update({
        where: { id: job.id, ...tenantWhere(req) },
        data: { scopes: next as unknown as Prisma.InputJsonValue },
      });

      return next;
    });

    if (!reordered) {
      res.status(400).json({
        error: "The submitted order must contain exactly this job's current scope ids — no missing, extra, or duplicate ids",
      });
      return;
    }

    const billing = billingOrNull(job, job.job_line_items, req, reordered);

    void logAudit({
      req,
      action: 'job.scopes_reordered',
      resourceType: 'Job',
      resourceId: job.id,
    });
    res.json({ scopes: canSeePricing(req) ? reordered : stripScopeMoney(reordered), billing });
  } catch (err) {
    logger.error('Error reordering job scopes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/jobs/:id/scopes/:idx
export async function deleteScope(req: Request, res: Response) {
  try {
    const job = await loadGuardedJob(req, res, 'manage_lines');
    if (!job) return;
    if (job.source_plan_id) {
      res.status(400).json({ error: NOT_BILLABLE_MSG });
      return;
    }

    const idx = parseInt(param(req, 'idx'), 10);

    const next = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust loadGuardedJob's
      // once-per-request snapshot) — idx is validated against THIS fresh length.
      const current = await tx.job.findUnique({ where: { id: job.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      if (!Number.isInteger(idx) || idx < 0 || idx >= fresh.length) {
        return null;
      }
      const filtered = fresh.filter((_, i) => i !== idx);

      await tx.job.update({
        where: { id: job.id, ...tenantWhere(req) },
        data: { scopes: filtered as unknown as Prisma.InputJsonValue },
      });

      return filtered;
    });

    if (!next) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }

    const billing = billingOrNull(job, job.job_line_items, req, next);

    void logAudit({
      req,
      action: 'job.scope_deleted',
      resourceType: 'Job',
      resourceId: job.id,
      metadata: { idx },
    });
    res.json({ billing });
  } catch (err) {
    logger.error('Error deleting job scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
