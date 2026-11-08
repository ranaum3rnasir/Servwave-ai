/**
 * Invoice line-item + billing endpoints (job-items editor, B6 + B7).
 *
 * Kept separate from the 2000+ line invoice.controller.ts for simplicity. These four handlers
 * back the Job → Items tab editor (and, later, the Invoice detail page) — the rows they mutate
 * ARE the invoice's owned `InvoiceLineItem` rows (entity-redesign §6; JobCharge is retired).
 *
 *   B6 — gated `manage_lines` Invoice (Dispatcher uncond; Tech OWN_INVOICE_VIA_JOB; Sales
 *        OWN_INVOICE_VIA_LEAD), per-instance via canAccessRow:
 *     addLine    POST   /api/invoices/:id/line-items
 *     deleteLine DELETE /api/invoices/:id/line-items/:lineId
 *
 *   B7 — gated `update` Invoice ONLY (Admin via `manage all`; Dispatcher via its update grant;
 *        Tech & Sales carry manage_lines but NOT update → 403 at the route guard):
 *     updateLine    PATCH /api/invoices/:id/line-items/:lineId
 *     updateBilling PATCH /api/invoices/:id/billing
 *
 * INVARIANT (no guard code needed — there is NO Prisma write-back path): adding a line from a
 * `price_book_item_id`, or editing any line, NEVER mutates PriceBookItem / inventory. The
 * catalog item is copied into an INDEPENDENT InvoiceLineItem snapshot; only the ref id is stored.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow, canSeePricing } from '../lib/permissions/enforce';
import { presentInvoiceDetail } from '../lib/permissions/customerContact';
import { recomputeInvoiceTotals, type LineForTotals } from '../lib/invoice-totals';
import { asScopeArray, toScopeForTotals, type ScopeOfWork } from '../lib/scopes';
import { invoiceDetailSelect, stripInvoiceCost } from './invoice.controller';
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
  LegacyStockLineError,
  legacyStockLineResponse,
  type TrackedItemInfo,
} from './inv-stock.controller';
import { logAudit } from '../lib/audit';
import { isInvoiceEditable, amountPaidOf, creditsTotalOf, isSentInvoice } from '../lib/invoice-editable';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Zod Schemas (validate() calls schema.parse(req.body) directly — no body: wrapper) ---

export const addLineSchema = z.object({
  description: z.string().min(1).max(LINE_DESCRIPTION_MAX),
  quantity: z.number().positive(),
  unit_price: z.number().min(0),
  is_taxable: z.boolean().optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  item_type: z.enum(['SERVICE', 'MATERIAL']).optional(),
  // Reference ONLY — copied into an independent snapshot; never written back to the catalog.
  price_book_item_id: z.string().uuid().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  markup_percent: z.number().min(0).max(100000).nullable().optional(),
});

export const updateLineSchema = z.object({
  description: z.string().max(LINE_DESCRIPTION_MAX).optional(),
  quantity: z.number().positive().optional(),
  unit_price: z.number().min(0).optional(),
  is_taxable: z.boolean().optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  markup_percent: z.number().min(0).max(100000).nullable().optional(),
  // #2012 (L1) — mirrors job-lines.controller.ts's updateLineSchema so the shared edit dialog's
  // Type select behaves the same on Job/Estimate/Invoice; without this zod's non-strict z.object
  // silently strips a submitted item_type (200, nothing changed).
  item_type: z.enum(['SERVICE', 'MATERIAL']).optional(),
});

export const updateBillingSchema = z.object({
  tip: z.number().min(0).optional(),
  discount_amount: z.number().min(0).optional(),
  // Sales-tax rate as a FRACTION (e.g. 0.0663 for 6.63%), mirroring Estimate.tax_rate. The
  // jurisdiction dropdown derives this from the chosen state's StateTaxRate. 0 = No tax.
  tax_rate: z.number().min(0).max(1).optional(),
});

// "order" is the COMPLETE new top-to-bottom list of ALL of this invoice's CURRENT line-item
// ids — never a partial/group-scoped subset. The frontend is responsible for splicing a
// within-group drag back into the full flat order before calling reorderLines; item_type
// grouping is a frontend display concept only, the backend just persists sequence 1..N as given.
export const reorderSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

// A flat-priced, non-line-item scope-of-work block (scopes.ts ScopeOfWork). id is server-
// generated (crypto.randomUUID()) — never accepted from the client.
export const addScopeSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(5000).optional().default(''),
  flat_price: z.number().min(0).nullable().optional(),
  is_taxable: z.boolean().optional().default(true),
  internal_cost: z.number().min(0).nullable().optional(),
});

export const updateScopeSchema = addScopeSchema.partial();

// A scope-of-work reorder ("Move up/down") — the FULL top-to-bottom list of this invoice's
// CURRENT scope ids (never a partial subset), exactly mirroring reorderSchema/reorderLines
// above. Needed because a "Move up/down" UI action that instead fired two concurrent
// index-addressed PATCH /scopes/:idx calls (swapping two blocks by diffing-and-PATCHing their
// content) would race: each is a non-atomic whole-column read-modify-write with no locking, so
// whichever commits last silently overwrites the other's change from a stale snapshot — losing
// one block's content entirely. A single all-or-nothing reorder, applied inside ONE transaction
// against a freshly re-read scopes array, replaces the two racing requests with one and closes
// that race the same way /line-items/reorder already does for lines.
export const reorderScopeSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

// --- Shared internals ---

// The owner-chain + money-field select the four handlers load on the parent invoice. Carries the
// ownership joins canAccessRow's CASL conditions reference (job.assignees, job.estimate.lead.…),
// plus the scalar tax/discount/tip/deposit fields the recompute + amount_due need.
const invoiceGuardSelect = {
  id: true,
  invoice_number: true,
  status: true,
  sent_at: true,
  kind: true,
  job_id: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  tax_rate: true,
  discount_amount: true,
  tip: true,
  scopes: true,
  // SRVW-84 - the recompute nets credit notes out of the derived cash figure, so it needs them
  // here. Rides the existing tenant-scoped findUnique below; no separate Credit query.
  credits: { select: { amount: true } },
  customer: { select: { tax_exempt: true } },
  job: {
    select: {
      visits: { select: { assignees: { select: { user_id: true } } } },
      customer: { select: { tax_exempt: true } },
      estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } },
    },
  },
} as const;

type GuardedInvoice = {
  id: string;
  invoice_number: string;
  status: string;
  sent_at: Date | null;
  job_id: string | null;
  deposit_credit: unknown;
  total_amount: unknown;
  amount_due: unknown;
  tax_rate: unknown;
  discount_amount: unknown;
  tip: unknown;
  scopes: unknown;
  // Optional: the double cast below means a caller/mock may hand over a row without the relation.
  credits?: Array<{ amount: unknown }>;
  customer: { tax_exempt: boolean } | null;
  job: { customer: { tax_exempt: boolean } | null } | null;
};

/**
 * Load + guard the parent invoice for any line/billing mutation. Returns the loaded row on success,
 * or null after having already written the appropriate error response (404 / 403 / 400). The
 * order mirrors invoice.controller update(): 404 → per-instance owner check → DRAFT-only guard.
 * opts.lockedStatus lets a caller reshape the non-editable refusal (the P1 sync endpoints answer
 * 409 there — a conflict with the document's state, not a bad request); existing callers are
 * unchanged (default 400).
 */
async function loadGuardedInvoice(
  req: Request,
  res: Response,
  opts: { lockedStatus?: number } = {},
): Promise<GuardedInvoice | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: param(req, 'id'), ...tenantWhere(req) },
    select: invoiceGuardSelect,
  });
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return null;
  }
  // Per-instance owner check (grant-driven SQL scope) — the route's canDo is subject-level only.
  if (!(await canAccessRow(req, 'Invoice', prisma.invoice, param(req, 'id')))) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  // Editable until settled (P2): DRAFT/SENT/PARTIAL are editable; PAID/VOIDED/REFUNDED/
  // PARTIALLY_REFUNDED/DISPUTED are locked. A partial payment does NOT lock the invoice.
  if (!isInvoiceEditable(invoice.status)) {
    res.status(opts.lockedStatus ?? 400).json({ error: 'This invoice is locked and can no longer be edited (it is paid or closed)' });
    return null;
  }
  return invoice as unknown as GuardedInvoice;
}

function taxExemptOf(invoice: GuardedInvoice): boolean {
  return Boolean(invoice.customer?.tax_exempt ?? invoice.job?.customer?.tax_exempt ?? false);
}

/**
 * SERV10X-59 — writes an INVOICE_EDITED timeline event when a material edit lands on an
 * already-sent invoice (SENT/PARTIAL). needsResend() (invoice-editable.ts) derives the resend
 * reminder by comparing this event's created_at against invoice.sent_at — both stamped by the
 * Node process clock (new Date()), not the DB's now() default, so the comparison never crosses
 * the transaction-start-timestamp hazard. metadata carries field NAMES only, never values, so no
 * money-redaction pass is needed for a price-blind requester reading the timeline.
 */
async function emitInvoiceEditedIfMaterial(
  tx: any,
  req: Request,
  invoice: GuardedInvoice,
  fields: string[],
): Promise<void> {
  if (!isSentInvoice(invoice.status, invoice.sent_at)) return;
  await tx.timelineEvent.create({
    data: {
      organization_id: req.user!.organization_id,
      entity_type: 'INVOICE',
      entity_id: invoice.id,
      event_type: 'INVOICE_EDITED',
      description: 'Invoice edited after it was sent',
      metadata: { fields },
      created_by: req.user!.id,
      created_at: new Date(),
    },
  });
}

/**
 * Recompute the invoice totals from the CURRENT line set (re-fetched inside the tx) and persist
 * subtotal / tax_amount / total_amount / amount_due / tip / discount_amount on the invoice.
 * amount_due = max(total - deposit_credit - amount_paid - credits, 0): a DRAFT invoice carries no
 * real payments (the only Payment that can exist is the synthetic DEPOSIT-CREDIT row, already
 * captured in deposit_credit) and no credits, so amount_paid and credits are both 0 there.
 * Returns the invoiceDetailSelect-shaped invoice for the response.
 *
 * opts.material (default true) gates the SERV10X-59 INVOICE_EDITED write — every line/scope
 * mutation in this file is inherently material, so only updateBilling (tip-only is NOT material)
 * passes it explicitly.
 */
async function recomputeAndPersist(
  tx: any,
  req: Request,
  invoice: GuardedInvoice,
  overrides: { tip?: number; invoiceDiscountAmount?: number; taxRate?: number } = {},
  opts: { material?: boolean; fields?: string[] } = {},
) {
  const lines = (await tx.invoiceLineItem.findMany({
    where: { invoice_id: invoice.id },
    orderBy: { sequence: 'asc' },
  })) as Array<{
    quantity: unknown;
    unit_price: unknown;
    is_taxable: boolean;
    discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
    discount_value: unknown;
  }>;

  const forTotals: LineForTotals[] = lines.map((l) => ({
    quantity: Number(l.quantity),
    unit_price: Number(l.unit_price),
    is_taxable: l.is_taxable,
    discount_type: l.discount_type ?? null,
    discount_value: l.discount_value == null ? null : Number(l.discount_value),
  }));

  // Re-read the CURRENT scopes column fresh (same rationale as the lines re-fetch above): this
  // single change is what makes every one of this file's four handlers automatically fold
  // scopes-of-work into their totals too, not just the dedicated scope handlers below.
  const current = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { scopes: true } });

  const tip = overrides.tip ?? Number(invoice.tip ?? 0);
  const invoiceDiscountAmount = overrides.invoiceDiscountAmount ?? Number(invoice.discount_amount ?? 0);
  const taxRate = overrides.taxRate ?? Number(invoice.tax_rate ?? 0);

  const totals = recomputeInvoiceTotals({
    lines: forTotals,
    scopes: toScopeForTotals(asScopeArray(current?.scopes)),
    taxRate,
    taxExempt: taxExemptOf(invoice),
    invoiceDiscountAmount,
    tip,
  });

  const depositCredit = Number(invoice.deposit_credit ?? 0);
  // SRVW-84 - a credit note lowers amount_due with no Payment row, so it must come out of BOTH
  // halves: out of the derived cash figure (or the write-off reads as a phantom payment) and out
  // of the new amount_due (or the next edit silently reverses the write-off).
  const creditsTotal = creditsTotalOf(invoice.credits);
  // Preserve money already applied: amount_due = new total - deposit credit - cash - credits.
  // amount_paid is derived from the invoice's own pre-edit fields (robust to how payments are
  // stored), so a SENT/PARTIAL edit keeps recorded payments; a DRAFT yields amount_paid 0 ->
  // unchanged behaviour. See amountPaidOf's JSDoc for the known clamp loss across two edits.
  const amountPaid = amountPaidOf(
    Number(invoice.total_amount ?? 0),
    depositCredit,
    Number(invoice.amount_due ?? 0),
    creditsTotal,
  );
  const amountDue = round2(Math.max(totals.total_amount - depositCredit - amountPaid - creditsTotal, 0));
  // Status tracks the CASH position only, never the credited one: PAID with a paid_at is a claim
  // that money was collected, so a write-off must never settle and lock the document. cashBalance
  // is identical to amountDue whenever creditsTotal is 0, which is every uncredited invoice.
  const cashBalance = round2(Math.max(totals.total_amount - depositCredit - amountPaid, 0));
  // When real money is on the invoice, keep status coherent with the new balance: an edit that
  // covers the balance settles (and locks) it; otherwise it stays PARTIAL. Invoices without
  // payments (DRAFT/SENT) keep their status.
  const settledStatus = amountPaid > 0 ? (cashBalance <= 0 ? 'PAID' : 'PARTIAL') : null;

  const updated = await tx.invoice.update({
    where: { id: invoice.id, ...tenantWhere(req) },
    data: {
      subtotal: totals.subtotal,
      discount_amount: invoiceDiscountAmount,
      tax_amount: totals.tax_amount,
      total_amount: totals.total_amount,
      tip: totals.tip,
      amount_due: amountDue,
      ...(settledStatus ? { status: settledStatus } : {}),
      ...(settledStatus === 'PAID' ? { paid_at: new Date() } : {}),
      // Persist the new rate only when the caller changed it (jurisdiction dropdown).
      ...(overrides.taxRate !== undefined ? { tax_rate: overrides.taxRate } : {}),
    },
    select: invoiceDetailSelect,
  });

  if (opts.material !== false) {
    await emitInvoiceEditedIfMaterial(tx, req, invoice, opts.fields ?? []);
  }

  return updated;
}

// --- Handlers ---

// B6: POST /api/invoices/:id/line-items
export async function addLine(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const body = req.body as z.infer<typeof addLineSchema>;
    // Drop cost/margin fields BEFORE the write when the requester can't `read Invoice` — mirrors
    // job-lines.controller.ts's identical addLine guard (job-lines pricing-leak follow-up,
    // invoice-lines half). Both the write AND the response must strip these (see stripInvoiceCost).
    if (!canSeePricing(req)) {
      body.unit_cost = undefined;
      body.markup_percent = undefined;
    }
    const quantity = body.quantity;
    const unitPrice = body.unit_price;
    const isTaxable = body.is_taxable ?? true;
    const lineTotal = round2(quantity * unitPrice);

    // Per-line discount snapshot (the same math the recompute uses) for the stored discount_amount.
    let discountAmount = 0;
    if (body.discount_type && body.discount_value != null && body.discount_value > 0) {
      discountAmount = body.discount_type === 'PERCENTAGE'
        ? round2(lineTotal * (body.discount_value / 100))
        : Math.min(round2(body.discount_value), lineTotal);
    }

    // LO-4: adding a line NEVER moves stock — Logistic Orders own all deduction. Every new line is
    // stamped NOT_TRACKED (clean-era marker; the legacy UNSYNCED/SYNCED add stamps retired with
    // the sync routes). The line is a pure independent snapshot; no catalog/inventory read.
    const updated = await prisma.$transaction(async (tx) => {
      // Next sequence = max(existing) + 1.
      const existing = await tx.invoiceLineItem.findMany({
        where: { invoice_id: invoice.id },
        select: { sequence: true },
      });
      const nextSequence = existing.reduce((m: number, l: { sequence: number }) => Math.max(m, l.sequence), 0) + 1;

      await tx.invoiceLineItem.create({
        data: {
          invoice_id: invoice.id,
          sequence: nextSequence,
          description: body.description,
          quantity,
          unit_price: unitPrice,
          is_taxable: isTaxable,
          line_total: lineTotal,
          discount_type: body.discount_type ?? null,
          discount_value: body.discount_value ?? null,
          discount_amount: discountAmount,
          item_type: body.item_type ?? 'SERVICE',
          ...(body.price_book_item_id ? { price_book_item_id: body.price_book_item_id } : {}),
          ...(body.unit_cost != null ? { unit_cost: body.unit_cost } : {}),
          ...(body.markup_percent != null ? { markup_percent: body.markup_percent } : {}),
          stock_status: 'NOT_TRACKED' as const,
          stock_location_id: null,
        },
      });

      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['line_items'] });
    });

    void logAudit({
      req,
      action: 'invoice.line_added',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { stock_status: 'NOT_TRACKED' },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error adding invoice line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B6: DELETE /api/invoices/:id/line-items/:lineId
export async function deleteLine(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const lineId = param(req, 'lineId');
    // Inventory P1 (§4.3): deleting a SYNCED line owes the same auto-return every other
    // destructive verb performs (invoice delete/void, job delete/cancel). Without it the
    // deducted units were stranded forever — reducing a line 3→0 returned 3, but DELETING
    // that same line returned nothing. The movement must be written BEFORE the row dies:
    // its invoice_line_item_id FK has to exist at insert, and SetNull then preserves the
    // ledger row. UNSYNCED / NOT_TRACKED lines never deducted, so they move nothing.
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    const updated = await prisma.$transaction(async (tx) => {
      const line = await tx.invoiceLineItem.findFirst({
        where: { id: lineId, invoice_id: invoice.id },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true, stock_status: true },
      });
      if (line?.stock_status === 'SYNCED') {
        await returnSyncedLines(tx, [line], {
          orgId: req.user!.organization_id,
          reference: `${invoice.invoice_number} line deleted`,
          actor,
          actorUserId: req.user!.id,
          lineRef: 'invoice',
        });
      }
      // Scoped to the line AND its parent invoice — never a cross-invoice delete.
      await tx.invoiceLineItem.deleteMany({
        where: { id: lineId, invoice_id: invoice.id },
      });
      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['line_items'] });
    });

    void logAudit({
      req,
      action: 'invoice.line_deleted',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { line_id: lineId },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error deleting invoice line:', err);
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

// A full InvoiceLineItem row as the sync path needs it (loaded fresh — invoiceGuardSelect does
// not embed lines).
type SyncableInvoiceLine = {
  id: string;
  quantity: unknown;
  price_book_item_id: string | null;
  stock_status: string;
  stock_location_id: string | null;
};

function syncSkipReason(line: SyncableInvoiceLine): 'already_synced' | 'not_tracked' | null {
  if (line.stock_status === 'SYNCED') return 'already_synced';
  if (line.stock_status === 'NOT_TRACKED') return 'not_tracked';
  return null;
}

// Shared guards + location/policy resolution for both sync endpoints. The non-editable refusal is
// a 409 here (lockedStatus), not the loader's default 400 — VOIDED invoices therefore refuse
// sync, the invoice twin of the cancelled-job guard (isInvoiceEditable: DRAFT/SENT/PARTIAL pass).
async function prepareInvoiceSync(req: Request, res: Response): Promise<{
  invoice: GuardedInvoice;
  location: { id: string };
  blockNegative: boolean;
  actor: string;
} | null> {
  const invoice = await loadGuardedInvoice(req, res, { lockedStatus: 409 });
  if (!invoice) return null;
  // P3 restricted-tech van forcing (D10/D13) — same up-front whole-request refusal as
  // prepareJobSync (location_id is schema-required, so the only legal value is the own van).
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
  return { invoice, location, blockNegative, actor };
}

// One SMALL tx per line: consume movement + SYNCED stamp. Movement BEFORE the stamp — a
// block-mode ShortageError aborts the tx with the line still UNSYNCED and no movement (QA-408).
async function syncOneInvoiceLine(
  req: Request,
  invoice: GuardedInvoice,
  line: SyncableInvoiceLine,
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
      jobId: invoice.job_id ?? null,
      invoiceLineItemId: line.id,
      unitCost: item.unitCost,
      actorUserId: req.user!.id,
      fromLocationId: locationId,
      reference: invoice.invoice_number,
      actor,
      blockNegative,
    });
    await tx.invoiceLineItem.update({
      where: { id: line.id, invoice_id: invoice.id },
      data: { stock_status: 'SYNCED', stock_location_id: locationId },
    });
    return result;
  });
}

// Fresh invoiceDetailSelect read for the sync responses (sync moves no money — NO
// recomputeAndPersist; the re-read just reflects the new line stock stamps).
async function loadDetailInvoice(req: Request, id: string) {
  return prisma.invoice.findUnique({
    where: { id, ...tenantWhere(req) },
    select: invoiceDetailSelect,
  });
}

// POST /api/invoices/:id/line-items/:lineId/sync-stock
export async function syncStockLine(req: Request, res: Response) {
  try {
    const ctx = await prepareInvoiceSync(req, res);
    if (!ctx) return;
    const { invoice, location, blockNegative, actor } = ctx;

    const lineId = param(req, 'lineId');
    // invoiceGuardSelect does not embed lines — load the target line fresh (full row carries
    // the stock fields).
    const line = (await prisma.invoiceLineItem.findFirst({
      where: { id: lineId, invoice_id: invoice.id },
    })) as SyncableInvoiceLine | null;
    if (!line) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }
    const skip = syncSkipReason(line);
    if (skip) {
      res.status(400).json({ error: 'LINE_NOT_SYNCABLE', reason: skip });
      return;
    }
    // Forward deduction re-checks the CURRENT flag (QA-104).
    const item = await resolveTrackedItem(req.user!.organization_id, line.price_book_item_id);
    if (!item || !item.tracked) {
      res.status(400).json({ error: 'LINE_NOT_SYNCABLE', reason: 'item_not_tracked' });
      return;
    }

    const result = await syncOneInvoiceLine(req, invoice, line, item, location.id, blockNegative, actor);

    const updated = await loadDetailInvoice(req, invoice.id);
    if (!updated) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    void logAudit({
      req,
      action: 'invoice.line_stock_synced',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { line_id: lineId, location_id: location.id },
    });
    res.json({
      invoice: presentInvoiceDetail(req, stripInvoiceCost(updated as any, req)),
      stock: { shortage: result.shortage, on_hand_after: result.onHandAfter, location_id: location.id },
    });
  } catch (err) {
    if (err instanceof ShortageError) {
      shortageResponse(res, err);
      return;
    }
    logger.error('Error syncing invoice line stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/invoices/:id/line-items/sync-stock
export async function bulkSyncStock(req: Request, res: Response) {
  try {
    const ctx = await prepareInvoiceSync(req, res);
    if (!ctx) return;
    const { invoice, location, blockNegative, actor } = ctx;
    const { line_ids: lineIds } = req.body as z.infer<typeof bulkSyncStockSchema>;

    const allLines = (await prisma.invoiceLineItem.findMany({
      where: { invoice_id: invoice.id },
      orderBy: { sequence: 'asc' },
    })) as unknown as SyncableInvoiceLine[];
    let candidates = allLines;
    if (lineIds) {
      const current = new Set(allLines.map((l) => l.id));
      if (!lineIds.every((id) => current.has(id))) {
        res.status(400).json({ error: 'One or more line_ids do not belong to this invoice' });
        return;
      }
      const wanted = new Set(lineIds);
      candidates = allLines.filter((l) => wanted.has(l.id));
    }

    // Sequential, one small tx per line — a shortage on line 3 must NOT roll back lines 1–2
    // (QA-404 per-line results).
    const results: Array<Record<string, unknown>> = [];
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
        const result = await syncOneInvoiceLine(req, invoice, line, item, location.id, blockNegative, actor);
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

    const updated = await loadDetailInvoice(req, invoice.id);
    if (!updated) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }
    void logAudit({
      req,
      action: 'invoice.lines_stock_synced',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: {
        location_id: location.id,
        synced: results.filter((r) => r.status === 'synced').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        shortage: results.filter((r) => r.status === 'shortage').length,
      },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated as any, req)), results });
  } catch (err) {
    logger.error('Error bulk-syncing invoice line stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B7: PATCH /api/invoices/:id/line-items/:lineId
export async function updateLine(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const lineId = param(req, 'lineId');
    const body = req.body as z.infer<typeof updateLineSchema>;
    // Drop cost/margin fields BEFORE the write when the requester can't `read Invoice` — see
    // addLine's identical guard for why both the write AND the response must strip these.
    if (!canSeePricing(req)) {
      body.unit_cost = undefined;
      body.markup_percent = undefined;
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Load the line (scoped to the invoice) to compute the new line_total / discount_amount.
      const line = await tx.invoiceLineItem.findFirst({
        where: { id: lineId, invoice_id: invoice.id },
      });
      if (!line) {
        return null;
      }

      // C2 legacy freeze (LO-4, spec §14): Logistic Orders now own all stock deduction, so a
      // QUANTITY edit on a legacy `stock_status='SYNCED'` line is refused. Thrown BEFORE the qty
      // write below so nothing persists (the throw rolls the whole tx back); mapped to 400
      // LEGACY_STOCK_LINE in the catch. Price/description/tax edits (no qty change) still pass;
      // delete-with-auto-return is untouched. No new line is ever SYNCED (all new lines stamp
      // NOT_TRACKED), so this only guards legacy inline-deducted rows.
      if (
        (line as { stock_status?: string }).stock_status === 'SYNCED' &&
        body.quantity !== undefined &&
        round2(Number(body.quantity) - Number(line.quantity)) !== 0
      ) {
        throw new LegacyStockLineError();
      }

      const quantity = body.quantity ?? Number(line.quantity);
      const unitPrice = body.unit_price ?? Number(line.unit_price);
      const isTaxable = body.is_taxable ?? line.is_taxable;
      const discountType = body.discount_type !== undefined ? body.discount_type : line.discount_type;
      const discountValue = body.discount_value !== undefined
        ? body.discount_value
        : (line.discount_value == null ? null : Number(line.discount_value));

      const lineTotal = round2(quantity * unitPrice);
      let discountAmount = 0;
      if (discountType && discountValue != null && discountValue > 0) {
        discountAmount = discountType === 'PERCENTAGE'
          ? round2(lineTotal * (discountValue / 100))
          : Math.min(round2(discountValue), lineTotal);
      }

      await tx.invoiceLineItem.update({
        where: { id: lineId, invoice_id: invoice.id },
        data: {
          ...(body.description !== undefined ? { description: body.description } : {}),
          quantity,
          unit_price: unitPrice,
          is_taxable: isTaxable,
          discount_type: discountType ?? null,
          discount_value: discountValue ?? null,
          discount_amount: discountAmount,
          line_total: lineTotal,
          ...(body.item_type !== undefined ? { item_type: body.item_type } : {}),
          ...(body.unit_cost !== undefined ? { unit_cost: body.unit_cost } : {}),
          ...(body.markup_percent !== undefined ? { markup_percent: body.markup_percent } : {}),
        },
      });

      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['line_items'] });
    });

    if (!updated) {
      res.status(404).json({ error: 'Line item not found' });
      return;
    }
    void logAudit({
      req,
      action: 'invoice.line_updated',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { line_id: lineId },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    // C2 legacy freeze: a qty edit on a SYNCED line was refused inside the tx (whole tx rolled back).
    if (err instanceof LegacyStockLineError) {
      legacyStockLineResponse(res);
      return;
    }
    logger.error('Error updating invoice line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B7: PATCH /api/invoices/:id/line-items/reorder — persist a full drag-and-drop reorder. MUST be
// registered BEFORE PATCH /:id/line-items/:lineId in invoice.routes.ts: Express matches routes in
// registration order, and ":lineId" would otherwise capture the literal path segment "reorder"
// (routing to updateLine with lineId="reorder" instead of here) — see the routing comment there.
export async function reorderLines(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const { order } = req.body as z.infer<typeof reorderSchema>;

    const result = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT line id set fresh inside the tx (never trust a stale snapshot) —
      // same "re-fetch inside the tx" convention recomputeAndPersist already uses for lines.
      const existing = (await tx.invoiceLineItem.findMany({
        where: { invoice_id: invoice.id },
        select: { id: true },
      })) as Array<{ id: string }>;
      const currentIds = existing.map((l) => l.id);
      const currentSet = new Set(currentIds);
      const orderSet = new Set(order);
      // All-or-nothing: bail out (no writes at all) unless "order" is EXACTLY this invoice's
      // current line id set (same count, no duplicates, no foreign ids, nothing missing).
      const isExactMatch =
        order.length === currentIds.length &&
        orderSet.size === order.length &&
        order.every((id) => currentSet.has(id));
      if (!isExactMatch) {
        return null;
      }

      // Single transaction — every line gets its new sequence atomically, or none do.
      for (let i = 0; i < order.length; i++) {
        await tx.invoiceLineItem.update({
          where: { id: order[i], invoice_id: invoice.id },
          data: { sequence: i + 1 },
        });
      }

      // Sequence changes don't affect totals math, but reusing recomputeAndPersist keeps the
      // response shape identical to every other mutating handler in this file (worth the small
      // overhead of a totals recompute whose numbers never actually move). `sequence` is public
      // and drives render order (SERV10X-59) — material.
      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['line_items.sequence'] });
    });

    if (!result) {
      res.status(400).json({
        error: "The submitted order must contain exactly this invoice's current line items — no missing, extra, or duplicate ids",
      });
      return;
    }

    void logAudit({
      req,
      action: 'invoice.lines_reordered',
      resourceType: 'Invoice',
      resourceId: invoice.id,
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(result, req)) });
  } catch (err) {
    logger.error('Error reordering invoice lines:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B7: PATCH /api/invoices/:id/billing
export async function updateBilling(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const body = req.body as z.infer<typeof updateBillingSchema>;
    // SERV10X-59 materiality: discount_amount/tax_rate change the public payload's totals — Yes.
    // tip does NOT (tip is not in getPublic yet — a customer paying through the public link can
    // neither see nor add one; see the plan's "Tip (deferred)" note) — so a tip-only PATCH must
    // not light the resend reminder.
    const materialFields = [
      ...(body.discount_amount !== undefined ? ['discount_amount'] : []),
      ...(body.tax_rate !== undefined ? ['tax_rate'] : []),
    ];
    const updated = await prisma.$transaction(async (tx) =>
      recomputeAndPersist(tx, req, invoice, {
        ...(body.tip !== undefined ? { tip: body.tip } : {}),
        ...(body.discount_amount !== undefined ? { invoiceDiscountAmount: body.discount_amount } : {}),
        ...(body.tax_rate !== undefined ? { taxRate: body.tax_rate } : {}),
      }, { material: materialFields.length > 0, fields: materialFields }),
    );

    void logAudit({
      req,
      action: 'invoice.billing_updated',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { fields: Object.keys(body ?? {}) },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error updating invoice billing:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// --- Scopes of work (Stage 5): flat-priced, non-line-item blocks stored on Invoice.scopes ---
// Same B6/B7 split as lines: add/delete gated `manage_lines`; update gated `update` ONLY.

// B6: POST /api/invoices/:id/scopes
export async function addScope(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const body = req.body as z.infer<typeof addScopeSchema>;
    // Drop cost data BEFORE the write when the requester can't `read Invoice` — symmetric with
    // job-lines.controller.ts's identical addScope guard (job-lines pricing-leak follow-up,
    // invoice half). `delete`, not `= undefined` — see updateScope's identical guard below for
    // why the distinction matters there; harmless either way here (brand-new scope).
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
    };

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust a stale snapshot).
      const current = await tx.invoice.findUnique({
        where: { id: invoice.id },
        select: { scopes: true },
      });
      const scopes = asScopeArray(current?.scopes);
      scopes.push(newScope);

      await tx.invoice.update({
        where: { id: invoice.id, ...tenantWhere(req) },
        data: { scopes: scopes as unknown as Prisma.InputJsonValue },
      });

      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['scopes'] });
    });

    void logAudit({
      req,
      action: 'invoice.scope_added',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { scope_id: newScope.id },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error adding invoice scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B7: PATCH /api/invoices/:id/scopes/:idx
export async function updateScope(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const idx = parseInt(param(req, 'idx'), 10);
    const body = req.body as z.infer<typeof updateScopeSchema>;
    // Drop cost data BEFORE the merge when the requester can't `read Invoice` — symmetric with
    // job-lines.controller.ts's identical updateScope guard. MUST be `delete`, not
    // `body.internal_cost = undefined`: the merge below is a full-object spread over the
    // EXISTING scope, and an explicitly-undefined-valued key is still an own enumerable
    // property that spread applies — it would clobber a pre-existing internal_cost to
    // undefined even when the low-priv caller's edit never mentioned that field. `delete`
    // makes an ignored/attempted submission behave exactly like zod's own "omitted key"
    // semantics the merge below already relies on for every other field.
    if (!canSeePricing(req)) {
      delete body.internal_cost;
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust a stale snapshot).
      const current = await tx.invoice.findUnique({
        where: { id: invoice.id },
        select: { scopes: true },
      });
      const scopes = asScopeArray(current?.scopes);
      if (!Number.isInteger(idx) || idx < 0 || idx >= scopes.length) {
        return null;
      }
      // Merge onto the existing scope — a field the client omits is left untouched; a field
      // explicitly sent as null (e.g. flat_price: null) overwrites with null (zod's .partial()
      // omits untouched keys entirely from the parsed body, so the spread never clobbers them).
      scopes[idx] = { ...scopes[idx], ...body };

      await tx.invoice.update({
        where: { id: invoice.id, ...tenantWhere(req) },
        data: { scopes: scopes as unknown as Prisma.InputJsonValue },
      });

      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['scopes'] });
    });

    if (!updated) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }
    void logAudit({
      req,
      action: 'invoice.scope_updated',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { idx },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error updating invoice scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B7: PATCH /api/invoices/:id/scopes/reorder — persist a full scope-block reorder atomically.
// MUST be registered BEFORE PATCH /:id/scopes/:idx in invoice.routes.ts — Express matches routes
// in registration order, and ":idx" is just a param placeholder that would otherwise capture the
// literal path segment "reorder" (routing to updateScope with idx="reorder" instead of here) —
// same routing gotcha as reorderLines above. See reorderScopeSchema's comment for why this
// endpoint exists (closes the Move-up/down lost-update race).
export async function reorderScopes(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const { order } = req.body as z.infer<typeof reorderScopeSchema>;

    const result = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust a stale snapshot) —
      // same convention as every other scope handler in this file.
      const current = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { scopes: true } });
      const scopes = asScopeArray(current?.scopes);
      const byId = new Map(scopes.map((s) => [s.id, s]));
      const currentIds = scopes.map((s) => s.id);
      const currentSet = new Set(currentIds);
      const orderSet = new Set(order);
      // All-or-nothing: bail out (no writes at all) unless "order" is EXACTLY this invoice's
      // current scope id set (same count, no duplicates, no foreign ids, nothing missing).
      const isExactMatch =
        order.length === currentIds.length &&
        orderSet.size === order.length &&
        order.every((id) => currentSet.has(id));
      if (!isExactMatch) {
        return null;
      }

      const reordered = order.map((id) => byId.get(id)!);
      await tx.invoice.update({
        where: { id: invoice.id, ...tenantWhere(req) },
        data: { scopes: reordered as unknown as Prisma.InputJsonValue },
      });

      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['scopes'] });
    });

    if (!result) {
      res.status(400).json({
        error: "The submitted order must contain exactly this invoice's current scope ids — no missing, extra, or duplicate ids",
      });
      return;
    }

    void logAudit({
      req,
      action: 'invoice.scopes_reordered',
      resourceType: 'Invoice',
      resourceId: invoice.id,
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(result, req)) });
  } catch (err) {
    logger.error('Error reordering invoice scopes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// B6: DELETE /api/invoices/:id/scopes/:idx
export async function deleteScope(req: Request, res: Response) {
  try {
    const invoice = await loadGuardedInvoice(req, res);
    if (!invoice) return;

    const idx = parseInt(param(req, 'idx'), 10);

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read the CURRENT scopes column fresh inside the tx (never trust a stale snapshot).
      const current = await tx.invoice.findUnique({
        where: { id: invoice.id },
        select: { scopes: true },
      });
      const scopes = asScopeArray(current?.scopes);
      if (!Number.isInteger(idx) || idx < 0 || idx >= scopes.length) {
        return null;
      }
      const next = scopes.filter((_, i) => i !== idx);

      await tx.invoice.update({
        where: { id: invoice.id, ...tenantWhere(req) },
        data: { scopes: next as unknown as Prisma.InputJsonValue },
      });

      return recomputeAndPersist(tx, req, invoice, {}, { fields: ['scopes'] });
    });

    if (!updated) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }
    void logAudit({
      req,
      action: 'invoice.scope_deleted',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { idx },
    });
    res.json({ invoice: presentInvoiceDetail(req, stripInvoiceCost(updated, req)) });
  } catch (err) {
    logger.error('Error deleting invoice scope:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
