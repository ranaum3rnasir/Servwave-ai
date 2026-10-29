/**
 * Estimate line-item + scope-of-work CRUD (v12 unified line-items, plan §2a).
 *
 * Gating mirrors job-lines.controller.ts, not invoice-lines.controller.ts: a single `update`
 * Estimate action (no `manage_lines`-style split — Estimate has no Tech/Sales-vs-Dispatcher
 * distinction analogous to Invoice's OWN_INVOICE_VIA_JOB/OWN_INVOICE_VIA_LEAD tiers here); GET
 * (listScopes) is gated the lighter `read` Estimate. canAccessRow(Estimate) per-instance inside
 * the controller either way, same as both precedents.
 *
 * Recompute/persist mechanics, however, mirror invoice-lines.controller.ts rather than
 * job-lines.controller.ts: unlike JobLineItem's parent Job (which has no subtotal/total_amount
 * column at all — job-lines' "billing" is purely a computed-on-read preview, never persisted),
 * Estimate already carries real, persisted subtotal/tax_amount/total_amount/discount_amount
 * columns that every other surface (PDF, public page, list view, timeline) relies on. Leaving
 * those stale after a granular line/scope mutation here would be a real data-integrity bug, not
 * just an incomplete feature — so every mutating handler below recomputes via
 * estimate.controller.ts's (now scopes-aware) calculateTotals() and persists the result inside
 * the same transaction, exactly like invoice-lines.controller.ts's recomputeAndPersist. The
 * response envelope follows the SAME `{ estimate }` shape getById/create/update/duplicate/revise
 * already use, rather than job-lines' bespoke `{ line, billing }` — one contract for the whole
 * Estimate surface.
 *
 * Business-rule guard: an estimate is only line/scope-editable in the same three statuses the
 * top-level PATCH /:id already enforces (DRAFT/SENT/PENDING) — mutating a frozen WON/
 * DECLINED/ARCHIVED/EXPIRED/SUPERSEDED estimate via these granular routes would defeat the
 * "Won estimates are frozen" invariant `revise()` relies on elsewhere in this file family.
 *
 * Finding B1 (2026-07-17 review) — every mutating handler below ALSO replicates update()'s
 * additional SENT/PENDING lock (deposit-paid / org `lock_on_send`, via the shared
 * `isEstimateLocked` helper) and its material-change version-bump / modified_after_send /
 * public_token-invalidation ceremony (via the shared `materialChangeGuardrail` helper, applied
 * inside `recomputeAndPersist` whenever a mutation actually changes the recomputed totals).
 * Wave 3 routed 100% of the frontend's line/scope edits through these granular endpoints instead
 * of the whole-document PATCH, so leaving the lock/ceremony PATCH-only silently let a locked
 * estimate be edited (and its version/public_token invariants go stale) through this file. Both
 * helpers are IMPORTED from estimate.controller.ts (extracted from `update()`) rather than
 * redefined here, so the two surfaces can never drift out of sync again.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow, canSeePricing } from '../lib/permissions/enforce';
import { presentEstimateDetail } from '../lib/permissions/customerContact';
import { asScopeArray, withOptionalDefaults, stripScopeCost, type ScopeOfWork } from '../lib/scopes';
import { addScopeSchema, updateScopeSchema, reorderScopeSchema } from './invoice-lines.controller';
import { lineItemSchema, lineItemObjectSchema, recomputeEstimateTotals, normalizeLineSelection, estimateDetailSelect, stripEstimateCost, isEstimateLocked, materialChangeGuardrail, pendingRevertOnMaterialChange, resolveEstimatePhotoUrls } from './estimate.controller';
import { expireDepositCheckoutsOnMaterialEdit } from '../lib/estimates/deposit-checkout-guard';
import { customerVisibleDocumentChanged } from '../lib/estimates/public-link';
import { logAudit } from '../lib/audit';
import { areSelectionsLocked, changesSelectionFlags, optionsLockedBody, DEFAULT_SELECTION_FLAGS, type SelectionFlags } from '../lib/estimates/selectionLock';

// R5f — same Storage bucket as estimate.controller.ts's resolveEstimatePhotoUrls / estimate-
// photos.controller.ts's upload/delete endpoints.
const STORAGE_BUCKET = 'attachments';

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Zod Schemas (validate() calls schema.parse(req.body) directly — no body: wrapper) ---

// Reuses estimate.controller.ts's lineItemSchema verbatim — the SAME shape the whole-document
// create/update flow already validates a line item against (description max 500, markup_percent,
// discount_type/value, …) — rather than redefining a parallel schema that could drift out of
// sync.
export const addLineSchema = lineItemSchema;

// price_book_item_id is excluded from update — an existing line's catalog ref can't be
// repointed after creation, mirroring job-lines.controller.ts / invoice-lines.controller.ts's
// identical exclusion on their own updateLineSchema.
export const updateLineSchema = lineItemObjectSchema.omit({ price_book_item_id: true }).partial();

// "order" is the COMPLETE new top-to-bottom list of ALL of this estimate's CURRENT line-item
// ids — never a partial/group-scoped subset, exactly mirroring job-lines/invoice-lines.
export const reorderSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

// A flat-priced, non-line-item scope-of-work block (scopes.ts ScopeOfWork), imported from
// invoice-lines.controller.ts rather than redeclared here — Estimate.scopes shares the exact
// same JSONB shape as Job.scopes/Invoice.scopes, and importing guarantees the three never
// diverge. id is server-generated (crypto.randomUUID()) — never accepted from the client.
export { reorderScopeSchema };

// #2053 slice 1 — estimate-anchored extensions of the SHARED addScopeSchema/updateScopeSchema
// (NOT edited — they stay shared with Job/Invoice, whose scope routes keep parsing the
// unextended schemas, so a flag sent there is stripped exactly as today). Same `.default()` /
// `.partial()` mechanics as lineItemObjectSchema's is_optional/is_selected above.
export const addEstimateScopeSchema = addScopeSchema.extend({
  is_optional: z.boolean().default(false),
  is_selected: z.boolean().default(true),
});
export const updateEstimateScopeSchema = addEstimateScopeSchema.partial();

// --- Shared internals ---

const estimateLineSelect = {
  id: true,
  estimate_id: true,
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
  is_optional: true,
  is_selected: true,
} as const;

type EstimateLineRow = {
  id: string;
  estimate_id: string;
  sequence: number;
  description: string;
  quantity: unknown;
  unit_price: unknown;
  unit_cost: unknown;
  markup_percent: unknown;
  is_taxable: boolean;
  line_total: unknown;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value: unknown;
  discount_amount: unknown;
  item_type: string;
  price_book_item_id: string | null;
  is_optional: boolean;
  is_selected: boolean;
};

// The billing-inputs select every handler loads on the parent estimate. `scopes`/`line_items` feed
// calculateTotals(); `tax_rate`/`discount_type`/`discount_value` are the estimate-level inputs it
// also needs. `version`/`subtotal`/`tax_amount`/`total_amount`/`discount_amount` are the PRE-
// mutation snapshot recomputeAndPersist diffs the recomputed totals against (finding B1 — decides
// whether a mutation was material enough to bump version/flag modified_after_send). `organization`/
// `invoices` feed `isEstimateLocked` (finding B1's send-lock check). Ownership is enforced
// separately via canAccessRow (a scoped findFirst against prisma.estimate) — see
// loadGuardedEstimate — so, unlike estimate.controller.ts's own handlers, there's no need to also
// select the lead→lead_assignees chain here.
const estimateGuardSelect = {
  id: true,
  status: true,
  version: true,
  tax_rate: true,
  discount_type: true,
  discount_value: true,
  subtotal: true,
  tax_amount: true,
  total_amount: true,
  discount_amount: true,
  scopes: true,
  organization: { select: { lock_on_send: true } },
  // The DEPOSIT row the EDIT lock reads (`isEstimateLocked` keys off its `status`). It no longer
  // feeds the SELECTION lock: the 2026-09-18 revision took the deposit out of that predicate, so
  // `kind` here is now only the `where`'s own discriminator echoed back.
  invoices: { where: { kind: 'DEPOSIT' as const }, select: { kind: true, status: true }, take: 1 },
  line_items: { select: estimateLineSelect, orderBy: { sequence: 'asc' as const } },
} as const;

type GuardedEstimate = {
  id: string;
  status: string;
  version: number;
  tax_rate: unknown;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value: unknown;
  subtotal: unknown;
  tax_amount: unknown;
  total_amount: unknown;
  discount_amount: unknown;
  scopes: unknown;
  organization: { lock_on_send: boolean | null } | null;
  invoices: { kind: string; status: string }[];
  line_items: EstimateLineRow[];
};

/**
 * Load + guard the parent estimate for any line/scope read/mutation. Returns the loaded row on
 * success, or null after having already written the 404 / 403 error response.
 *
 * Exported (R5f) so estimate-photos.controller.ts's 4 photo upload/delete handlers reuse this
 * verbatim instead of redefining the same guard-load — same reasoning as this file importing
 * calculateTotals/estimateDetailSelect/etc. from estimate.controller.ts rather than duplicating.
 *
 * `estimateId` (#2045, R6) is an OPTIONAL third argument defaulting to `param(req, 'id')` —
 * every existing caller (this file's own handlers, estimate-photos.controller.ts) keys off the
 * route's own `:id`, unchanged. price-book-image.controller.ts's narrow "fill if empty" endpoint
 * is the one caller that supplies an explicit id: on that route `:id` is the PRICE BOOK ITEM id,
 * not an estimate id, so calling this unchanged would look the item id up as an estimate and 404
 * every request.
 */
export async function loadGuardedEstimate(
  req: Request,
  res: Response,
  estimateId: string = param(req, 'id'),
): Promise<GuardedEstimate | null> {
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId, ...tenantWhere(req) },
    select: estimateGuardSelect,
  });
  if (!estimate) {
    res.status(404).json({ error: 'Estimate not found' });
    return null;
  }
  // Per-instance owner check (grant-driven SQL scope) — the route's canDo is subject-level only.
  if (!(await canAccessRow(req, 'Estimate', prisma.estimate, estimateId))) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return estimate as unknown as GuardedEstimate;
}

const EDITABLE_STATUSES = new Set(['DRAFT', 'SENT', 'PENDING']);
const NOT_EDITABLE_MSG = 'Only draft or sent estimates can be edited';
const LOCKED_MSG = 'This estimate is locked. Use Revise to make changes.';

function isEditableStatus(status: string): boolean {
  return EDITABLE_STATUSES.has(status);
}

/**
 * Combined edit-guard for every MUTATING line/scope handler (finding B1): status must be
 * DRAFT/SENT/PENDING (isEditableStatus) AND, for a SENT/PENDING estimate, it must not be LOCKED
 * (deposit already PAID, or the org's lock_on_send toggle ON) — mirrors update()'s guard
 * (estimate.controller.ts's `isEstimateLocked`) so a locked estimate can no longer be edited
 * through these granular routes instead of only the whole-document PATCH. Returns true (having
 * already written the 400) when the caller must stop.
 *
 * Exported (R5f) — same reasoning as loadGuardedEstimate above: estimate-photos.controller.ts's
 * photo upload/delete handlers apply the IDENTICAL frozen-estimate gate every other line/scope
 * mutation route uses.
 */
/**
 * #2090 (slice 3a) - THE selection lock, enforced server-side. Distinct from `isMutationBlocked`
 * below in both its predicate and its scope:
 *
 *  - the predicate is `areSelectionsLocked` (lib/estimates/selectionLock.ts, the transcribed
 *    frontend twin), never `isEstimateLocked` - the edit lock also fires on the org's
 *    `lock_on_send` toggle, which has nothing to do with what the customer chose;
 *  - it refuses only a request that would CHANGE `is_optional`/`is_selected` away from what is
 *    stored. Description, quantity and price stay editable, and a request that re-sends a flag at
 *    its current value is a no-op, not a refusal. Turning this into a second blanket edit lock is
 *    exactly what it must not do.
 *
 * Runs BEFORE `isMutationBlocked` at every call site: a WON estimate is already refused there
 * with a generic 400, and the customer-facing reason for THIS refusal is the thing worth saying.
 * Returns true (having written the 409) when the caller must stop.
 */
export function isSelectionLockBlocked(
  estimate: GuardedEstimate,
  res: Response,
  requested: SelectionFlags,
  stored: SelectionFlags,
): boolean {
  if (!areSelectionsLocked(estimate)) return false;
  if (!changesSelectionFlags(requested, stored)) return false;
  res.status(409).json(optionsLockedBody(estimate));
  return true;
}

/**
 * #2090 slice A3 - route a STAFF selection write to the column that means what the writer means.
 * The one rule, shared by `addLine`, `updateLine`, `addScope` and `updateScope` so the four cannot
 * drift apart.
 *
 * WHICH COLUMN MEANS WHAT (the full account is on `publishRepRecommendation`,
 * estimate.controller.ts). `is_selected` is the LIVE answer on the document: it is what the
 * customer's public page renders, what their own tick writes, and what `countsTowardTotals`
 * filters the money on. `rep_selected` is the SALESPERSON's recommendation - what they are
 * offering - and every send publishes it onto `is_selected`.
 *
 * So the routing follows the send:
 *
 *  - while DRAFT the two ARE the same thing (PRD §5): nothing has been offered yet, so the rep's
 *    recommendation and the document's answer cannot disagree, and the write lands on BOTH;
 *  - once the estimate has left DRAFT the customer owns `is_selected`, and a staff tick is a
 *    recommendation for the NEXT send. It lands on `rep_selected` alone and the customer's answer
 *    is left exactly where it is.
 *
 * WHAT THAT BUYS, and it is the reason this slice exists (Ran, decision 12): a tick after send no
 * longer moves the totals, so it no longer trips `materialChangeGuardrail` in
 * `recomputeAndPersist` below - which nulls `public_token` and 404s the customer mid-decision.
 * The accepted consequence, which this slice deliberately does NOT paper over: the rep sees the
 * estimate total stay put when they tick. PRD §5 records that and declines to solve it.
 *
 * `requested` absent means the caller never mentioned the flag (a `.partial()` PATCH that only
 * changed the description), and then `rep_selected` is not written at all - an absent
 * recommendation is a real state, and a send leaves those rows alone.
 *
 * A CREATE has no stored customer answer to protect, so it passes its own value as `stored` and
 * both columns take it. That is not an exception to the rule: it is the same value the next send
 * would publish anyway, and there is nothing of the customer's there to overwrite.
 */
function routeSelectionWrite(
  status: string,
  isOptional: boolean,
  requested: boolean | undefined,
  stored: boolean,
): { is_selected: boolean; rep_selected?: boolean } {
  // Non-optional implies selected, on whichever column is being written (frozen case 4).
  const normalise = (v: boolean) => normalizeLineSelection({ is_optional: isOptional, is_selected: v }).is_selected;
  if (status === 'DRAFT') {
    const value = normalise(requested !== undefined ? requested : stored);
    return { is_selected: value, rep_selected: value };
  }
  return {
    is_selected: normalise(stored),
    ...(requested !== undefined ? { rep_selected: normalise(requested) } : {}),
  };
}

export function isMutationBlocked(estimate: GuardedEstimate, res: Response): boolean {
  if (!isEditableStatus(estimate.status)) {
    res.status(400).json({ error: NOT_EDITABLE_MSG });
    return true;
  }
  if (isEstimateLocked(estimate)) {
    res.status(400).json({ error: LOCKED_MSG });
    return true;
  }
  return false;
}

/**
 * Re-read the estimate's CURRENT line_items slice fresh INSIDE the transaction (finding B6) —
 * mirrors this file's own scope handlers' `tx.estimate.findUnique({ select: { scopes: true } })`
 * re-read convention (used 4x below) so addLine's nextSequence, updateLine's merge fallbacks, and
 * reorderLines's id-set validation are computed off the LATEST committed rows rather than the
 * pre-transaction loadGuardedEstimate snapshot, which can go stale under a concurrent edit of the
 * same estimate (duplicate `sequence` values / lost updates).
 */
async function loadFreshLines(tx: any, estimateId: string): Promise<EstimateLineRow[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const current = await tx.estimate.findUnique({
    where: { id: estimateId },
    select: { line_items: { select: estimateLineSelect, orderBy: { sequence: 'asc' as const } } },
  });
  return (current?.line_items ?? []) as EstimateLineRow[];
}

/**
 * Recompute the estimate's subtotal/tax_amount/total_amount/discount_amount from the CURRENT
 * line set + scopes (both re-fetched inside the tx) and persist them. Returns the
 * estimateDetailSelect-shaped estimate for the response — mirrors invoice-lines.controller.ts's
 * recomputeAndPersist (see this file's header for why Estimate needs this, unlike job-lines).
 *
 * Finding B1 — when the recomputed totals actually differ from the PRE-mutation snapshot
 * (`estimate`, loaded before this tx) on a SENT/PENDING estimate, this also applies the SAME
 * version-bump / modified_after_send / public_token-invalidation ceremony update()'s
 * whole-document PATCH already enforces (`materialChangeGuardrail`, estimate.controller.ts) —
 * applied ONCE here so every one of this file's 8 mutating handlers gets it for free, rather than
 * duplicating the diff/ceremony logic at each call site.
 */
async function recomputeAndPersist(tx: any, req: Request, estimate: GuardedEstimate) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const lines = (await tx.estimateLineItem.findMany({
    where: { estimate_id: estimate.id },
    orderBy: { sequence: 'asc' },
  })) as EstimateLineRow[];

  // Re-read the CURRENT scopes column fresh (never trust the guard-load snapshot, which may now
  // be stale against a concurrent scope mutation) — same convention as invoice-lines.controller.ts.
  const current = await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } });
  const scopes = asScopeArray(current?.scopes);

  // #2090 - the arithmetic moved to estimate.controller.ts's `recomputeEstimateTotals` so the
  // customer's own public selection write runs the identical calculation over identical inputs.
  // Case 3's updateLine()/addScope() assertions depend on the flags reaching it; they do, inside.
  const { subtotal, taxAmount, totalAmount, estimateDiscountAmount } = recomputeEstimateTotals(lines, estimate, scopes);

  // A5 — a mutation "actually changes what the customer was quoted" when the document they would
  // OPEN renders differently. Finding B1's predicate compared only the four persisted totals
  // columns, so a renamed line, a rewritten scope block or a 2×$50 → 1×$100 swap all left the old
  // link live on a document that had changed underneath the customer.
  //
  // `estimate` is the PRE-mutation guard-load snapshot; `lines` and `scopes` were re-read above,
  // INSIDE the tx and after the handler's own write, so this is a genuine before/after. A rep's
  // tick lands on `rep_selected`, which the projection deliberately ignores — that is A3's whole
  // point and this predicate must not put the harshness back. DRAFT estimates are never guarded
  // (no send has happened yet to protect).
  //
  // `scope_notes`, `discount_name` and the deposit pair are not passed on either side: no handler
  // in this file writes them, so they cannot move here. They are covered at update()'s call site.
  const isMaterialChange = estimate.status !== 'DRAFT' && customerVisibleDocumentChanged(
    {
      subtotal: estimate.subtotal,
      tax_amount: estimate.tax_amount,
      total_amount: estimate.total_amount,
      discount_amount: estimate.discount_amount,
      tax_rate: estimate.tax_rate,
      discount_type: estimate.discount_type,
      discount_value: estimate.discount_value,
      scopes: estimate.scopes,
      line_items: estimate.line_items,
    },
    {
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      discount_amount: estimateDiscountAmount,
      tax_rate: estimate.tax_rate,
      discount_type: estimate.discount_type,
      discount_value: estimate.discount_value,
      scopes,
      line_items: lines,
    },
  );
  const guardrailData = isMaterialChange ? materialChangeGuardrail(estimate.version) : {};
  // D12 — a material edit to a PENDING (customer-signed) estimate also voids the signature and
  // reverts to SENT, mirroring update()'s whole-document PATCH so the two surfaces can't drift.
  const pendingRevertData = pendingRevertOnMaterialChange(isMaterialChange, estimate.status);

  return tx.estimate.update({
    where: { id: estimate.id, ...tenantWhere(req) },
    data: {
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      discount_amount: estimateDiscountAmount,
      ...guardrailData,
      ...pendingRevertData,
    },
    select: estimateDetailSelect,
  });
}

/**
 * #2031 slice 5 (F2) — post-commit, after any line or scope mutation.
 *
 * A line edit is the ordinary way a sent estimate's total moves, and it raises
 * modified_after_send through the same shared guardrail the whole-document PATCH uses. A checkout
 * the customer already has open would otherwise go on settling at the figure that edit just
 * superseded. Called on every mutation to a non-DRAFT estimate rather than only the material ones:
 * the guard re-reads the deposit and does nothing unless the figure has actually moved, so
 * materiality is decided against the DOCUMENT, which is the thing that has to be true. Never
 * throws and never fails the edit.
 */
async function sweepDepositCheckoutsAfterLineEdit(req: Request, estimate: GuardedEstimate) {
  if (estimate.status === 'DRAFT') return;
  await expireDepositCheckoutsOnMaterialEdit(estimate.id, req.user!.organization_id);
}

// --- Handlers: line items ---
// No GET here — estimateDetailSelect (GET /api/estimates/:id) already embeds line_items, unlike
// Job (whose jobDetailSelect deliberately omits job_line_items — see job-lines.controller.ts).

// POST /api/estimates/:id/line-items
export async function addLine(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    // #2090 - a line that does not exist yet has no stored flags, so it is diffed against the
    // flag-blind default: adding an ORDINARY line to a locked estimate is not a selection change
    // (the edit lock below still refuses it), adding an OPTION is.
    if (isSelectionLockBlocked(estimate, res, req.body, DEFAULT_SELECTION_FLAGS)) return;
    if (isMutationBlocked(estimate, res)) return;

    const body = req.body as z.infer<typeof addLineSchema>;
    // Drop cost/margin fields BEFORE the write when the requester can't `read Invoice` — mirrors
    // job-lines.controller.ts's / invoice-lines.controller.ts's identical addLine guard (job-lines
    // pricing-leak follow-up, estimate half). Both the write AND the response must strip these
    // (see stripEstimateCost, applied via recomputeAndPersist's estimateDetailSelect response).
    if (!canSeePricing(req)) {
      body.unit_cost = undefined;
      body.markup_percent = undefined;
    }

    const lineTotal = round2(body.quantity * body.unit_price);
    let discountAmount = 0;
    if (body.discount_type && body.discount_value != null && body.discount_value > 0) {
      discountAmount = body.discount_type === 'PERCENTAGE'
        ? round2(lineTotal * (body.discount_value / 100))
        : Math.min(round2(body.discount_value), lineTotal);
    }

    const updated = await prisma.$transaction(async (tx) => {
      // B6 — re-read the CURRENT line set fresh inside the tx (never trust loadGuardedEstimate's
      // once-per-request snapshot, which may now be stale against a concurrent line mutation) —
      // same convention as the scope handlers below. Next sequence = max(existing) + 1 (robust to
      // a prior delete leaving a gap).
      const freshLines = await loadFreshLines(tx, estimate.id);
      const nextSequence = freshLines.reduce((m, l) => Math.max(m, l.sequence), 0) + 1;

      // INDEPENDENT snapshot — copy catalog values into the line; store only the ref id. There is
      // NO write-back to PriceBookItem / inventory.
      await tx.estimateLineItem.create({
        data: {
          estimate_id: estimate.id,
          sequence: nextSequence,
          description: body.description,
          quantity: body.quantity,
          unit_price: body.unit_price,
          is_taxable: body.is_taxable,
          line_total: lineTotal,
          discount_type: body.discount_type ?? null,
          discount_value: body.discount_value ?? null,
          discount_amount: discountAmount,
          item_type: body.item_type,
          is_optional: body.is_optional,
          // A3 — a brand-new row has no customer answer to protect, so both columns take what the
          // rep asked for; the recommendation is recorded either way. See `routeSelectionWrite`.
          ...routeSelectionWrite(estimate.status, body.is_optional, body.is_selected, body.is_selected),
          ...(body.price_book_item_id ? { price_book_item_id: body.price_book_item_id } : {}),
          ...(body.unit_cost != null ? { unit_cost: body.unit_cost } : {}),
          ...(body.markup_percent != null ? { markup_percent: body.markup_percent } : {}),
        },
      });

      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    void logAudit({ req, action: 'estimate.line_added', resourceType: 'Estimate', resourceId: estimate.id });
    res.status(201).json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error adding estimate line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/estimates/:id/line-items/reorder — persist a full drag-and-drop reorder. MUST be
// registered BEFORE PATCH /:id/line-items/:lineId in estimate.routes.ts — Express matches routes
// in registration order, and ":lineId" would otherwise capture the literal path segment "reorder"
// (routing to updateLine with lineId="reorder" instead of here) — same gotcha as job/invoice-lines.
export async function reorderLines(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    if (isMutationBlocked(estimate, res)) return;

    const { order } = req.body as z.infer<typeof reorderSchema>;

    const updated = await prisma.$transaction(async (tx) => {
      // B6 — re-read the CURRENT line id set fresh inside the tx before validating against
      // `order`, mirroring reorderScopes' identical re-read convention below. All-or-nothing: null
      // (→ 400) unless "order" is EXACTLY this estimate's current line id set (same count, no
      // duplicates, no foreign ids, nothing missing) — never partially apply a malformed reorder.
      const freshLines = await loadFreshLines(tx, estimate.id);
      const currentIds = freshLines.map((l) => l.id);
      const currentSet = new Set(currentIds);
      const orderSet = new Set(order);
      const isExactMatch =
        order.length === currentIds.length &&
        orderSet.size === order.length &&
        order.every((id) => currentSet.has(id));
      if (!isExactMatch) return null;

      for (let i = 0; i < order.length; i++) {
        await tx.estimateLineItem.update({
          where: { id: order[i], estimate_id: estimate.id },
          data: { sequence: i + 1 },
        });
      }
      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    if (!updated) {
      res.status(400).json({
        error: "The submitted order must contain exactly this estimate's current line items — no missing, extra, or duplicate ids",
      });
      return;
    }

    void logAudit({ req, action: 'estimate.lines_reordered', resourceType: 'Estimate', resourceId: estimate.id });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error reordering estimate lines:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/estimates/:id/line-items/:lineId
export async function updateLine(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    // #2090 - diffed against the guard snapshot's own copy of the row. A lineId this estimate
    // does not have is left to the 404 below rather than answered with a lock.
    const lockTarget = estimate.line_items.find((l) => l.id === param(req, 'lineId'));
    if (lockTarget && isSelectionLockBlocked(estimate, res, req.body, lockTarget)) return;
    if (isMutationBlocked(estimate, res)) return;

    const lineId = param(req, 'lineId');
    // Fast pre-check against the guard snapshot so an unknown id 404s without entering the
    // transaction. B6's race-safe merge below re-validates against the FRESH set inside the tx —
    // a concurrent delete between this check and the tx still 404s via the null return there.
    if (!estimate.line_items.some((l) => l.id === lineId)) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }

    const body = req.body as z.infer<typeof updateLineSchema>;
    // Drop cost/margin fields BEFORE the write when the requester can't `read Invoice` — see
    // addLine's identical guard for why both the write AND the response must strip these.
    if (!canSeePricing(req)) {
      body.unit_cost = undefined;
      body.markup_percent = undefined;
    }

    const updated = await prisma.$transaction(async (tx) => {
      // B6 — re-read the CURRENT line set fresh inside the tx before computing the merge
      // fallbacks, mirroring the scope handlers' re-read convention below.
      const freshLines = await loadFreshLines(tx, estimate.id);
      const existingLine = freshLines.find((l) => l.id === lineId);
      if (!existingLine) return null; // deleted concurrently since the pre-check above

      const quantity = body.quantity ?? Number(existingLine.quantity);
      const unitPrice = body.unit_price ?? Number(existingLine.unit_price);
      const isTaxable = body.is_taxable ?? existingLine.is_taxable;
      const discountType = body.discount_type !== undefined ? body.discount_type : existingLine.discount_type;
      const discountValue = body.discount_value !== undefined
        ? body.discount_value
        : (existingLine.discount_value == null ? null : Number(existingLine.discount_value));
      // #2053 — merge the two flags the same way as every other field above, then normalise
      // (non-optional implies selected, never a 400 — frozen case 4).
      const isOptional = body.is_optional !== undefined ? body.is_optional : existingLine.is_optional;
      // A3 — and route the selection to the column it belongs in: both while DRAFT, the rep's
      // `rep_selected` alone once the customer has the document. See `routeSelectionWrite`.
      const selection = routeSelectionWrite(
        estimate.status,
        isOptional,
        body.is_selected,
        existingLine.is_selected,
      );

      const lineTotal = round2(quantity * unitPrice);
      let discountAmount = 0;
      if (discountType && discountValue != null && discountValue > 0) {
        discountAmount = discountType === 'PERCENTAGE'
          ? round2(lineTotal * (discountValue / 100))
          : Math.min(round2(discountValue), lineTotal);
      }

      await tx.estimateLineItem.update({
        where: { id: lineId, estimate_id: estimate.id },
        data: {
          ...(body.description !== undefined ? { description: body.description } : {}),
          quantity,
          unit_price: unitPrice,
          is_taxable: isTaxable,
          line_total: lineTotal,
          discount_type: discountType ?? null,
          discount_value: discountValue ?? null,
          discount_amount: discountAmount,
          ...(body.item_type !== undefined ? { item_type: body.item_type } : {}),
          ...(body.unit_cost !== undefined ? { unit_cost: body.unit_cost } : {}),
          ...(body.markup_percent !== undefined ? { markup_percent: body.markup_percent } : {}),
          is_optional: isOptional,
          ...selection,
        },
      });

      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    if (!updated) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.line_updated',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { line_id: lineId },
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error updating estimate line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/estimates/:id/line-items/:lineId
export async function deleteLine(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    if (isMutationBlocked(estimate, res)) return;

    const lineId = param(req, 'lineId');

    const updated = await prisma.$transaction(async (tx) => {
      // Scoped to the line AND its parent estimate — never a cross-estimate delete.
      const result = await tx.estimateLineItem.deleteMany({ where: { id: lineId, estimate_id: estimate.id } });
      if (result.count === 0) return null;
      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    if (!updated) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.line_deleted',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { line_id: lineId },
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error deleting estimate line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Handlers: scopes of work ---
// Flat-priced, non-line-item blocks stored on Estimate.scopes (scopes.ts) — mirrors
// job-lines.controller.ts's / invoice-lines.controller.ts's scope handlers exactly (same
// re-read-fresh-inside-a-transaction race-safety convention).

// GET /api/estimates/:id/scopes
export async function listScopes(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    // #2053 — estimate-only read-time defaults (Solution §1), applied before every scope merge/
    // read in this file.
    const scopes = withOptionalDefaults(asScopeArray(estimate.scopes));
    res.json({ scopes: canSeePricing(req) ? scopes : stripScopeCost(scopes) });
  } catch (err) {
    logger.error('Error listing estimate scopes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/estimates/:id/scopes
export async function addScope(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    // #2090 - addLine's twin: a brand-new block is diffed against the flag-blind default.
    if (isSelectionLockBlocked(estimate, res, req.body, DEFAULT_SELECTION_FLAGS)) return;
    if (isMutationBlocked(estimate, res)) return;

    const body = req.body as z.infer<typeof addEstimateScopeSchema>;
    // Drop cost data BEFORE the write when the requester can't `read Invoice` — mirrors addLine's
    // identical unit_cost/markup_percent guard above. `delete`, not `= undefined` — see
    // updateScope's identical guard for why the distinction matters there; harmless either way
    // here since this is a brand-new scope with no pre-existing value to preserve.
    if (!canSeePricing(req)) {
      delete body.internal_cost;
    }
    const newScope: ScopeOfWork = {
      id: crypto.randomUUID(),
      title: body.title,
      body: body.body ?? '',
      flat_price: body.flat_price ?? null,
      is_taxable: body.is_taxable ?? true,
      internal_cost: body.internal_cost ?? null,
      // #2053 — non-optional implies selected, applied at write time (frozen case 4's scope twin).
      // A3 — addLine's twin: a brand-new block takes the rep's offer on both keys, because there
      // is no customer answer on it yet to leave alone. See `routeSelectionWrite`.
      is_optional: body.is_optional,
      ...routeSelectionWrite(estimate.status, body.is_optional, body.is_selected, body.is_selected),
    };

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust loadGuardedEstimate's
      // once-per-request snapshot, which may now be stale against a concurrent scope mutation).
      // #2053 — plain asScopeArray (not withOptionalDefaults) on purpose: this array is pushed
      // to and written straight back below, and every SIBLING element already carries explicit
      // is_optional/is_selected once it has been through this file's own write paths; the new
      // block's own defaults come from addEstimateScopeSchema (below), not from this read.
      const current = await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      // M2 — the v12 §4 lazy-backfill (EstimateLineItemsEditor.tsx's EstimateScopeOfWorkCard)
      // seeds a client-only placeholder scope from the LEGACY scope_name/scope_notes text
      // whenever scopes[] is empty; its first edit "promotes" that placeholder by calling this
      // endpoint. Detect that promotion the same way the frontend does (scopes[] was empty) and
      // null the legacy text server-side so a LATER delete-to-zero (below) can never resurrect it.
      const isPromotion = fresh.length === 0;
      fresh.push(newScope);

      await tx.estimate.update({
        where: { id: estimate.id, ...tenantWhere(req) },
        data: {
          scopes: fresh as unknown as Prisma.InputJsonValue,
          ...(isPromotion ? { scope_name: null, scope_notes: null } : {}),
        },
      });

      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    void logAudit({
      req,
      action: 'estimate.scope_added',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { scope_id: newScope.id },
    });
    res.status(201).json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error adding estimate scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/estimates/:id/scopes/:idx
export async function updateScope(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    // #2090 - updateLine's twin, read off the guard snapshot's scopes column. An out-of-range
    // index is left to the 404 the transaction returns below.
    const lockScope = asScopeArray(estimate.scopes)[parseInt(param(req, 'idx'), 10)];
    if (lockScope && isSelectionLockBlocked(estimate, res, req.body, lockScope)) return;
    if (isMutationBlocked(estimate, res)) return;

    const idx = parseInt(param(req, 'idx'), 10);
    const body = req.body as z.infer<typeof updateEstimateScopeSchema>;
    // Drop cost data BEFORE the merge when the requester can't `read Invoice` — mirrors
    // updateLine's identical unit_cost/markup_percent guard. MUST be `delete`, not
    // `body.internal_cost = undefined`: the merge below is a full-object spread over the
    // EXISTING scope, and an explicitly-undefined-valued key is still an own enumerable property
    // that spread applies — it would clobber a pre-existing internal_cost to undefined even when
    // the low-priv caller's edit never mentioned that field.
    if (!canSeePricing(req)) {
      delete body.internal_cost;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      if (!Number.isInteger(idx) || idx < 0 || idx >= fresh.length) {
        return null;
      }
      // Merge onto the existing scope — a field the client omits is left untouched; a field
      // explicitly sent as null (e.g. flat_price: null) overwrites with null (zod's .partial()
      // omits untouched keys entirely from the parsed body, so the spread never clobbers them).
      // #2053 — non-optional implies selected, applied AFTER the merge (frozen case 4's twin).
      // A3 — and the selection goes to the column that means what the rep means: both while
      // DRAFT, `rep_selected` alone once the customer holds the document. The routed pair is
      // spread LAST so it wins over the body's own `is_selected`, which the merge above copied in.
      const merged = { ...fresh[idx], ...body };
      fresh[idx] = {
        ...merged,
        ...routeSelectionWrite(
          estimate.status,
          merged.is_optional ?? false,
          body.is_selected,
          fresh[idx].is_selected ?? true,
        ),
      };

      await tx.estimate.update({
        where: { id: estimate.id, ...tenantWhere(req) },
        data: { scopes: fresh as unknown as Prisma.InputJsonValue },
      });

      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    if (!updated) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.scope_updated',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { idx },
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error updating estimate scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// PATCH /api/estimates/:id/scopes/reorder — persist a full scope-block reorder atomically. MUST
// be registered BEFORE PATCH /:id/scopes/:idx in estimate.routes.ts — same Express route-order
// gotcha as line-items/reorder above.
export async function reorderScopes(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    if (isMutationBlocked(estimate, res)) return;

    const { order } = req.body as z.infer<typeof reorderScopeSchema>;

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      const byId = new Map(fresh.map((s) => [s.id, s]));
      const currentIds = fresh.map((s) => s.id);
      const currentSet = new Set(currentIds);
      const orderSet = new Set(order);
      const isExactMatch =
        order.length === currentIds.length &&
        orderSet.size === order.length &&
        order.every((id) => currentSet.has(id));
      if (!isExactMatch) {
        return null;
      }

      const next = order.map((id) => byId.get(id)!);
      await tx.estimate.update({
        where: { id: estimate.id, ...tenantWhere(req) },
        data: { scopes: next as unknown as Prisma.InputJsonValue },
      });

      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    if (!updated) {
      res.status(400).json({
        error: "The submitted order must contain exactly this estimate's current scope ids — no missing, extra, or duplicate ids",
      });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.scopes_reordered',
      resourceType: 'Estimate',
      resourceId: estimate.id,
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error reordering estimate scopes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/estimates/:id/scopes/:idx
export async function deleteScope(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    if (isMutationBlocked(estimate, res)) return;

    const idx = parseInt(param(req, 'idx'), 10);
    // R5f — captured inside the tx below (the deleted scope's stable `id`) so the post-tx
    // best-effort Storage sweep knows which photos to remove.
    let deletedScopeId: string | null = null;
    let deletedScopePhotoPaths: string[] = [];

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } });
      const fresh = asScopeArray(current?.scopes);
      if (!Number.isInteger(idx) || idx < 0 || idx >= fresh.length) {
        return null;
      }
      deletedScopeId = fresh[idx].id;
      const next = fresh.filter((_, i) => i !== idx);

      await tx.estimate.update({
        where: { id: estimate.id, ...tenantWhere(req) },
        data: {
          scopes: next as unknown as Prisma.InputJsonValue,
          // M2 — defensive: if this delete empties scopes[] back to zero, also null
          // scope_name/scope_notes so an estimate promoted BEFORE this fix shipped (whose legacy
          // text addScope never nulled) can't resurrect stale text via the lazy-backfill once its
          // one real scope is removed. A no-op when addScope already nulled these at promotion.
          ...(next.length === 0 ? { scope_name: null, scope_notes: null } : {}),
        },
      });

      // R5f — no DB FK ties EstimateScopePhoto to a single scope block (Estimate.scopes is a raw
      // JSONB array with no row per scope), so explicitly delete this scope's photo rows here as
      // part of the SAME operation. Compound (estimate_id, scope_id) match — never scope_id
      // alone (see EstimateScopePhoto's schema comment). Fetch storage_paths first (a plain DB
      // read, safe inside the tx) — the actual Storage.remove call happens after, outside the tx.
      const scopePhotos = await tx.estimateScopePhoto.findMany({
        where: { estimate_id: estimate.id, scope_id: deletedScopeId },
        select: { storage_path: true },
      });
      deletedScopePhotoPaths = scopePhotos.map((p) => p.storage_path);
      await tx.estimateScopePhoto.deleteMany({ where: { estimate_id: estimate.id, scope_id: deletedScopeId } });

      return recomputeAndPersist(tx, req, estimate);
    });

    await sweepDepositCheckoutsAfterLineEdit(req, estimate);

    if (!updated) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }

    // Best-effort Storage cleanup — never blocks the response over a failure.
    if (deletedScopePhotoPaths.length > 0) {
      try {
        const { error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove(deletedScopePhotoPaths);
        if (error) logger.warn(`Failed to remove storage objects for deleted estimate scope ${deletedScopeId}:`, error);
      } catch (err) {
        logger.warn(`Failed to remove storage objects for deleted estimate scope ${deletedScopeId}:`, err);
      }
    }

    void logAudit({
      req,
      action: 'estimate.scope_deleted',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { idx, scope_id: deletedScopeId },
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(await resolveEstimatePhotoUrls(updated), req)) });
  } catch (err) {
    logger.error('Error deleting estimate scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
