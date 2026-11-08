import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { logAudit } from '../lib/audit';
import { canAccessRow, scopeWhereForReq, canSeePricing } from '../lib/permissions/enforce';
import { applyStockMovement } from './inv-stock.controller';
import { emitPoPartial } from '../services/notifications/inventoryEmit';
import { env } from '../config/env';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Org-validated FK guard (closes the P1 cross-org injection gap) ──────────
// Before persisting an inbound job_id/customer_id, confirm the referenced row
// belongs to the requesting org. Returns an error message string (→ 400) or null.
async function validateJobAndCustomer(req: Request, jobId?: string | null, customerId?: string | null): Promise<string | null> {
  if (jobId) {
    const job = await prisma.job.findFirst({ where: { id: jobId, ...tenantWhere(req) }, select: { id: true } });
    if (!job) return 'Invalid job_id';
  }
  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...tenantWhere(req) }, select: { id: true } });
    if (!customer) return 'Invalid customer_id';
  }
  return null;
}

// ─── Org-validated vendor FK guard (P2 item 1b) ──────────────────────────────
// Mirrors validateJobAndCustomer: a supplied vendorId must resolve inside the
// requesting org. Returns the vendor row (for display-string resolution) or an
// error message string (→ 400).
async function validateVendor(
  req: Request,
  vendorId?: string | null,
): Promise<{ error: string | null; vendor: { id: string; name: string } | null }> {
  if (!vendorId) return { error: null, vendor: null };
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, ...tenantWhere(req) },
    select: { id: true, name: true },
  });
  if (!vendor) return { error: 'Invalid vendor_id', vendor: null };
  return { error: null, vendor };
}

// Org-validate client-supplied per-line priceBookItemIds (P2: the low-stock create
// flow sends explicit catalog FKs). Cross-org/unknown ids are dropped to null —
// same tolerance as an unmatched SKU (the line is kept, just uncatalogued).
async function resolveExplicitItemIds(req: Request, lines: Array<{ priceBookItemId?: string | null }>): Promise<Set<string>> {
  const ids = [...new Set(lines.map((l) => l.priceBookItemId).filter((v): v is string => !!v))];
  if (ids.length === 0) return new Set();
  const rows = await prisma.priceBookItem.findMany({
    where: { id: { in: ids }, ...tenantWhere(req) },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

// ─── SKU → PriceBookItem resolver (V6/D5) ───────────────────────────────────
// Map each inbound line's item_sku to a catalog PriceBookItem id within the
// requesting org. @@unique([organization_id, sku]) guarantees ≤1 match per SKU.
// Lines whose SKU has no catalog match keep price_book_item_id = null.
//
// `db` defaults to the global client for the pre-transaction call sites. A caller already inside
// an interactive transaction MUST pass its `tx` — a global query there checks out a SECOND pooled
// connection while the first is still held, which starves the pool and fails the whole
// transaction with P2024 on a connection-limited deployment (invisible locally, where spare
// connections mask it).
async function resolveSkuMap(
  req: Request,
  skus: string[],
  db: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<Map<string, string>> {
  const unique = [...new Set(skus.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const items = await db.priceBookItem.findMany({
    where: { sku: { in: unique }, ...tenantWhere(req) },
    select: { id: true, sku: true },
  });
  return new Map(items.filter((i) => i.sku).map((i) => [i.sku as string, i.id]));
}

// ─── Receive-location resolver (DEC3) ───────────────────────────────────────
// Resolve the org's configured default inventory location; fall back to the
// first 'warehouse' location only if no default is set (e.g. legacy orgs).
async function resolveReceiveLocationId(req: Request): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { default_inventory_location_id: true },
  });
  if (org?.default_inventory_location_id) return org.default_inventory_location_id;
  const fallback = await prisma.inventoryLocation.findFirst({
    where: { ...tenantWhere(req), type: 'warehouse' }, select: { id: true },
  });
  return fallback?.id ?? null;
}

// ─── Mappers (snake_case Prisma row → camelCase frontend contract) ──────────
//
// The frontend is typed against `lib/api/inventory.ts` (PurchaseOrder / POLine).
// Decimal columns are coerced to numbers; ISO timestamps to strings; legacy
// optional columns that are null are dropped to match the optional `?` fields,
// while the PR 2 lifecycle fields are ALWAYS emitted (null when unset) so a
// consumer can tell "not ordered yet" from "old server".

// #2042 security round 3 (D): cost fields ride behind `canSeePricing(req)` (`read Pricing`,
// the Roles editor's "See financial data" switch) — the same predicate `stripMappedItemCost`
// (inv-catalog.controller.ts) applies to the catalog. Both fields are simply OMITTED
// (`undefined` drops out of the JSON body) for a cost-blind caller, matching this DTO's
// existing "absent when unset" convention rather than introducing a second null-vs-absent rule.
function mapPOLine(line: any, req: Request) {
  const canCost = canSeePricing(req);
  return {
    id: line.id,
    itemSku: line.item_sku,
    itemName: line.item_name,
    uom: line.uom,
    qtyOrdered: Number(line.qty_ordered),
    qtyReceived: Number(line.qty_received),
    unitCost: canCost && line.unit_cost != null ? Number(line.unit_cost) : undefined,
    // S3.2 (one money rule): the linked catalog item's unit cost rides along so the
    // client prices a line as `unitCost ?? catalogUnitCost ?? 0` - the same rule
    // getJobMaterialCost applies - without ever joining by SKU. Null when the line
    // is uncatalogued, the item has no cost, or the query did not load the relation.
    catalogUnitCost: canCost
      ? (line.price_book_item?.unit_cost != null ? Number(line.price_book_item.unit_cost) : null)
      : undefined,
    priceBookItemId: line.price_book_item_id ?? undefined,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function actorName(u: { first_name?: string | null; last_name?: string | null; email?: string | null } | null | undefined): string {
  if (!u) return '';
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || '';
}

function mapPurchaseOrder(po: any, req: Request) {
  const orderedAt: Date | null = po.ordered_at ?? null;
  const receivedAt: Date | null = po.received_at ?? null;
  const out: any = {
    id: po.id,
    poNumber: po.po_number,
    vendor: po.vendor,
    status: po.status,
    // Null until "Mark as ordered" - a draft has no order date (verdict §2).
    orderedAt: orderedAt ? orderedAt.toISOString() : null,
    orderedBy: po.ordered_by ? { id: po.ordered_by.id, name: actorName(po.ordered_by) } : null,
    receivedAt: receivedAt ? receivedAt.toISOString() : null,
    // Lead time = received-on minus ordered date in whole elapsed days (floored, so a
    // same-day receipt is 0 and never rounds up); null when either is missing, so the
    // History column can print an honest "—" instead of a guess.
    leadTimeDays: orderedAt && receivedAt
      ? Math.max(0, Math.floor((receivedAt.getTime() - orderedAt.getTime()) / MS_PER_DAY))
      : null,
    notes: po.notes ?? null,
    signatureData: po.signature_data ?? null,
    signatureName: po.signature_name ?? null,
    signatureAt: po.signature_at ? po.signature_at.toISOString() : null,
    createdAt: po.created_at ? po.created_at.toISOString() : null,
    lines: (po.lines ?? []).map((line: any) => mapPOLine(line, req)),
  };
  if (po.job?.job_number) out.jobNumber = po.job.job_number;
  // The FK ids ride along with their display snapshots so the Edit form (PR 3, S3.3)
  // can pre-select the linked job instead of matching on a number that may repeat.
  if (po.job_id != null) out.jobId = po.job_id;
  if (po.customer_id != null) out.customerId = po.customer_id;
  if (po.customer != null) out.customer = po.customer;
  if (po.site != null) out.site = po.site;
  if (po.trade != null) out.trade = po.trade;
  if (po.expected_date != null) out.expectedDate = po.expected_date.toISOString();
  if (po.staged_as_job_stage_id != null) out.stagedAsJobStageId = po.staged_as_job_stage_id;
  if (po.vendor_id != null) out.vendorId = po.vendor_id;
  return out;
}

function mapPrePOLine(line: any) {
  return {
    itemSku: line.item_sku,
    itemName: line.item_name,
    qty: Number(line.qty),
    uom: line.uom,
    priceBookItemId: line.price_book_item_id ?? undefined,
  };
}

function mapEmail(email: any) {
  const out: any = {
    id: email.id,
    direction: email.direction,
    kind: email.kind,
    from: email.from,
    to: email.to,
    subject: email.subject,
    body: email.body,
    sentAt: email.sent_at.toISOString(),
  };
  if (email.attachments != null) out.attachments = email.attachments;
  return out;
}

function mapRfqQuote(quote: any) {
  return {
    vendor: quote.vendor,
    total: Number(quote.total),
    leadTimeDays: quote.lead_time_days,
    recommended: quote.recommended,
  };
}

function mapRfq(rfq: any) {
  const out: any = {
    id: rfq.id,
    rfqNumber: rfq.rfq_number,
    requestedAt: rfq.requested_at.toISOString(),
    responsesDueBy: rfq.responses_due_by.toISOString(),
    linesSummary: rfq.lines_summary,
    lines: (rfq.lines ?? []).map(mapPrePOLine),
    quotes: (rfq.quotes ?? []).map(mapRfqQuote),
    status: rfq.status,
    emails: (rfq.emails ?? []).map(mapEmail),
  };
  if (rfq.job_number != null) out.jobNumber = rfq.job_number;
  if (rfq.customer != null) out.customer = rfq.customer;
  if (rfq.site != null) out.site = rfq.site;
  if (rfq.trade != null) out.trade = rfq.trade;
  return out;
}

// ─── Zod Schemas ────────────────────────────────────────

const tradeEnum = z.enum(['locksmith', 'door', 'security', 'hvac', 'plumbing', 'multi']);

const poLineSchema = z.object({
  itemSku: z.string().max(100).default(''), // optional label; identity is priceBookItemId (D2)
  itemName: z.string().min(1),
  uom: z.string().min(1),
  qtyOrdered: z.number().min(0),
  qtyReceived: z.number().min(0).optional(),
  unitCost: z.number().min(0).nullable().optional(),
  // P2: an explicit catalog FK (low-stock create flow) wins over SKU re-resolution.
  priceBookItemId: z.string().uuid().nullable().optional(),
});

// po_number is server-assigned via allocateNumber('purchase_order') — never
// client-supplied (P0 §A). Old clients still sending poNumber are stripped by
// Zod's unknown-key removal, so they get no 400.
// P2 item 1b: vendorId is the org-validated FK; the vendor display string may be
// omitted when vendorId is supplied (it is then resolved from the vendor row).
// Purchasing Audit Verdict PR 2: the honest lifecycle. `sent` is gone (ServWave never
// sends a PO); `ordered` is set by hand, `cancelled` is the exit that is not a delete.
export const PO_STATUSES = ['draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
const poStatusEnum = z.enum(PO_STATUSES);

export const createPurchaseOrderSchema = z.object({
  vendor: z.string().min(1, 'Vendor is required').max(200).optional(),
  vendorId: z.string().uuid().nullable().optional(),
  status: poStatusEnum.optional(),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  // Honoured ONLY together with `status: 'ordered'` (imports); a draft is created unordered.
  orderedAt: z.string().datetime().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  lines: z.array(poLineSchema).min(1, 'At least one line is required'),
}).refine((b) => !!b.vendor || !!b.vendorId, { message: 'Vendor is required', path: ['vendor'] });

export const updatePurchaseOrderSchema = z.object({
  vendor: z.string().min(1).max(200).optional(),
  vendorId: z.string().uuid().nullable().optional(),
  status: poStatusEnum.optional(),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  orderedAt: z.string().datetime().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  // Buyer signature from the preview: a data URL plus the signer's name; the server stamps
  // the time. Sending signatureData null/'' unsigns the PO (all three fields clear together).
  // 400 KB leaves room for a dense signature-pad PNG under the 1 MB JSON body limit.
  signatureData: z.string().max(400_000).nullable().optional(),
  signatureName: z.string().max(200).nullable().optional(),
  // Refused with 409 PO_LINES_FROZEN unless the STORED status is draft (checked in the handler).
  lines: z.array(poLineSchema).min(1).optional(),
});

export const markOrderedSchema = z.object({
  orderedAt: z.string().datetime().optional(),
});

// P2 item 1c (D16 entry 2): job-anchored PO create — the FE sends only ids; SKU/name/
// uom/cost are SERVER-resolved from job line items and/or catalog rows.
export const createPurchaseOrderFromJobSchema = z.object({
  jobId: z.string().uuid(),
  vendorId: z.string().uuid().nullable().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  lines: z.array(
    z.object({
      jobLineItemId: z.string().uuid().optional(),
      priceBookItemId: z.string().uuid().optional(),
      qty: z.number().positive(),
    }).refine((l) => !!l.jobLineItemId || !!l.priceBookItemId, 'jobLineItemId or priceBookItemId required')
  ).min(1),
});

const rfqLineSchema = z.object({
  itemSku: z.string().min(1),
  itemName: z.string().min(1),
  qty: z.number().min(0),
  uom: z.string().min(1),
});

const rfqQuoteSchema = z.object({
  vendor: z.string().min(1),
  total: z.number().min(0),
  leadTimeDays: z.number().int().min(0),
  recommended: z.boolean().optional(),
});

export const createRfqSchema = z.object({
  rfqNumber: z.string().min(1, 'RFQ number is required').max(50),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  requestedAt: z.string().datetime().optional(),
  responsesDueBy: z.string().datetime(),
  linesSummary: z.object({ items: z.number().int().min(0), units: z.number().min(0) }),
  status: z.enum(['awaiting_quotes', 'ready_to_compare', 'winner_picked']).optional(),
  lines: z.array(rfqLineSchema).min(1, 'At least one line is required'),
  quotes: z.array(rfqQuoteSchema).optional(),
});

export const updateRfqSchema = z.object({
  rfqNumber: z.string().min(1).max(50).optional(),
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  site: z.string().max(500).nullable().optional(),
  trade: tradeEnum.nullable().optional(),
  requestedAt: z.string().datetime().optional(),
  responsesDueBy: z.string().datetime().optional(),
  linesSummary: z.object({ items: z.number().int().min(0), units: z.number().min(0) }).optional(),
  status: z.enum(['awaiting_quotes', 'ready_to_compare', 'winner_picked']).optional(),
  lines: z.array(rfqLineSchema).min(1).optional(),
  quotes: z.array(rfqQuoteSchema).optional(),
});

// ─── Purchase Order Handlers ────────────────────────────

// One read shape for every PO response (list / get / create / update / receive / mark-ordered).
const PO_INCLUDE = {
  lines: {
    orderBy: { created_at: 'asc' as const },
    // catalogUnitCost on the DTO (S3.2 one money rule).
    include: { price_book_item: { select: { unit_cost: true } } },
  },
  job: { select: { job_number: true } },
  customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
  ordered_by: { select: { id: true, first_name: true, last_name: true, email: true } },
};

export async function listPurchaseOrders(req: Request, res: Response) {
  try {
    // #2042: row-scope a conditioned `read PurchaseOrder` grant (job-scoped, via the caller's own
    // job) onto the tenant filter. {} for ADMIN/DISPATCHER (unconditional) - unchanged behaviour.
    // If a future search/filter needs its own `OR`, compose it with `addOrFilter`
    // (`whereCompose.ts`) - a bare `where.OR = …` here would silently drop a multi-read user's
    // scope `OR`.
    const orders = await prisma.purchaseOrder.findMany({
      where: { ...tenantWhere(req), ...(await scopeWhereForReq(req, 'PurchaseOrder')) },
      // created_at, not ordered_at: drafts have no order date (verdict §2).
      orderBy: { created_at: 'desc' },
      include: PO_INCLUDE,
    });

    res.json({ purchaseOrders: orders.map((order) => mapPurchaseOrder(order, req)) });
  } catch (err) {
    logger.error('Failed to list purchase orders:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getPurchaseOrder(req: Request, res: Response) {
  try {
    // #2042: same row-scope fragment as the list. A PO out of scope (another rep's job, or no
    // job at all) is indistinguishable from a non-existent one - the existing 404, no new body.
    const order = await prisma.purchaseOrder.findFirst({
      where: {
        id: req.params.id as string,
        ...tenantWhere(req),
        ...(await scopeWhereForReq(req, 'PurchaseOrder')),
      },
      include: PO_INCLUDE,
    });

    if (!order) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    // ServWave does not send POs (Purchasing Audit Verdict, PR 1). The detail
    // shape keeps `emails: []` for one release so no client breaks on the key;
    // the relation itself is no longer read.
    res.json({ purchaseOrder: { ...mapPurchaseOrder(order, req), emails: [] } });
  } catch (err) {
    logger.error('Failed to get purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PO Activity (D7) — real timeline, replaces the synthesized ActivityTabStub.
// Two truthful sources, merged and sorted chronologically:
//   • AuditLog       — lifecycle verbs (created / updated / received) + actor.
//   • InventoryEmail — historical rows from before sending was removed; nothing
//                      on the PO path writes them any more (Purchasing Audit
//                      Verdict, PR 1). Legacy send audit rows render generically
//                      like any other action - no special case.
interface POActivityEvent {
  id: string;
  at: string; // ISO 8601 — sorts lexically, so string compare == chronological
  kind: 'created' | 'updated' | 'received' | 'email_sent' | 'event';
  summary: string;
  actor: string | null;
  detail?: string;
}

function mapAuditToActivity(row: {
  id: string;
  action: string;
  actor_email: string | null;
  metadata: Prisma.JsonValue;
  created_at: Date;
}): POActivityEvent | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const base = { id: row.id, at: row.created_at.toISOString(), actor: row.actor_email };
  switch (row.action) {
    case 'inventory.po_created':
      return {
        ...base, kind: 'created', summary: 'Purchase order created',
        detail: typeof meta.vendor === 'string' && meta.vendor ? `Vendor: ${meta.vendor}` : undefined,
      };
    case 'inventory.po_updated': {
      const fields = Array.isArray(meta.fields) ? (meta.fields as unknown[]).filter((f) => typeof f === 'string').join(', ') : '';
      // A status move carries from/to (verdict §2: every status change is audited with both).
      const from = typeof meta.status_from === 'string' ? meta.status_from : null;
      const to = typeof meta.status_to === 'string' ? meta.status_to : null;
      return {
        ...base, kind: 'updated',
        summary: from && to ? `Status changed: ${from} → ${to}` : 'Purchase order updated',
        detail: fields ? `Changed: ${fields}` : undefined,
      };
    }
    case 'inventory.po_ordered': {
      const at = typeof meta.ordered_at === 'string' ? meta.ordered_at.slice(0, 10) : null;
      return { ...base, kind: 'updated', summary: 'Marked as ordered', detail: at ? `Ordered on ${at}` : undefined };
    }
    case 'inventory.po_received': {
      const n = typeof meta.lines_received === 'number' ? meta.lines_received : null;
      const status = typeof meta.status === 'string' ? meta.status : null;
      return {
        ...base, kind: 'received',
        summary: n != null ? `Received ${n} line${n === 1 ? '' : 's'}` : 'Items received',
        detail: status ? `Status: ${status}` : undefined,
      };
    }
    default:
      return { ...base, kind: 'event', summary: row.action };
  }
}

export async function getPurchaseOrderActivity(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const poId = req.params.id as string;

    // Prove the PO is in-org AND in the caller's PurchaseOrder scope before reading its trail
    // (#2042); a miss returns the same 404 the malformed-id guard (requireUuidParam) does.
    const po = await prisma.purchaseOrder.findFirst({
      where: {
        id: poId,
        ...tenantWhere(req),
        ...(await scopeWhereForReq(req, 'PurchaseOrder')),
      },
      select: { id: true },
    });
    if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return; }

    // AuditLog is keyed on `org_id` (not the `organization_id` tenantWhere spreads),
    // so scope it explicitly — poId is already proven in-org above.
    const [audits, emails] = await Promise.all([
      prisma.auditLog.findMany({
        where: { org_id: orgId, resource_type: 'PurchaseOrder', resource_id: poId },
        orderBy: { created_at: 'asc' },
      }),
      prisma.inventoryEmail.findMany({
        where: { purchase_order_id: poId, organization_id: orgId },
        orderBy: { sent_at: 'asc' },
      }),
    ]);

    const fromAudit = audits
      .map(mapAuditToActivity)
      .filter((e): e is POActivityEvent => e !== null);

    const fromEmail: POActivityEvent[] = emails.map((e) => {
      const recipients = Array.isArray(e.to)
        ? (e.to as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      return {
        id: e.id,
        at: e.sent_at.toISOString(),
        kind: 'email_sent',
        summary: recipients.length > 0 ? `Emailed to ${recipients.join(', ')}` : 'Emailed to vendor',
        actor: null,
        detail: e.subject || undefined,
      };
    });

    const activity = [...fromAudit, ...fromEmail].sort((a, b) => a.at.localeCompare(b.at));
    res.json({ activity });
  } catch (err) {
    logger.error('Failed to load purchase order activity:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PO persist core (P2 item 1a) ────────────────────────────────────────────
// One write path for every PO entry point (manual create, from-job). Callers are
// responsible for org-validating every FK they pass in.

interface PersistPoLine {
  itemSku: string;
  itemName: string;
  uom: string;
  qtyOrdered: number;
  qtyReceived?: number;
  unitCost?: number | null;
  priceBookItemId?: string | null; // explicit FK wins over SKU re-resolution
}

interface PersistPoInput {
  vendor: string;               // display snapshot ('' allowed at the core level — Zod guards the manual create)
  vendorId?: string | null;     // FK, already org-validated by the caller
  status?: string;              // default 'draft'
  jobId?: string | null;
  customerId?: string | null;
  customer?: string | null;
  site?: string | null;
  trade?: string | null;
  orderedAt?: string;
  expectedDate?: string | null;
  notes?: string | null;
  source: 'manual' | 'job';
  lines: PersistPoLine[];
}

async function persistPurchaseOrder(req: Request, input: PersistPoInput) {
  const orgId = req.user!.organization_id;
  const skuMap = await resolveSkuMap(req, input.lines.map((l) => l.itemSku));
  const status = input.status ?? 'draft';
  // "Ordered" never means "created" (verdict §2): a new PO carries NO order date. The one
  // exception is an import that says `status: 'ordered'` outright - it keeps its own
  // orderedAt (or now) and is attributed to the importer.
  const orderedAt = status === 'ordered' ? (input.orderedAt ? new Date(input.orderedAt) : new Date()) : null;

  // Allocate the PO number inside the create transaction: the org-row lock
  // taken by allocateNumber serializes concurrent creates, and a failed
  // create rolls the counter increment back with it (P0 §A).
  const createIn = async (tx: Prisma.TransactionClient) => {
    const poNumber = await allocateNumber(tx, 'purchase_order', orgId);
    return tx.purchaseOrder.create({
      data: {
        po_number: poNumber,
        vendor: input.vendor,
        vendor_id: input.vendorId ?? null,
        status,
        // jobNumber is a display value sourced from the related Job on read;
        // the PO links by job_id (UUID FK), not a job_number column.
        job_id: input.jobId ?? null,
        customer_id: input.customerId ?? null,
        customer: input.customer ?? null,
        site: input.site ?? null,
        trade: input.trade ?? null,
        ordered_at: orderedAt,
        ordered_by_id: orderedAt ? req.user!.id : null,
        expected_date: input.expectedDate ? new Date(input.expectedDate) : null,
        notes: input.notes ?? null,
        organization_id: orgId,
        lines: {
          create: input.lines.map((line) => ({
            item_sku: line.itemSku,
            item_name: line.itemName,
            uom: line.uom,
            qty_ordered: line.qtyOrdered,
            qty_received: line.qtyReceived ?? 0,
            unit_cost: line.unitCost ?? null,
            price_book_item_id: line.priceBookItemId ?? skuMap.get(line.itemSku) ?? null,
            organization_id: orgId,
          })),
        },
      },
      include: PO_INCLUDE,
    });
  };

  const order = await withNumberCollisionRetry(() => prisma.$transaction(createIn), { label: 'purchase_order.create' });

  void logAudit({
    req,
    action: 'inventory.po_created',
    resourceType: 'PurchaseOrder',
    resourceId: order.id,
    metadata: {
      po_number: order.po_number, vendor: order.vendor, job_id: order.job_id,
      line_count: input.lines.length, vendor_id: input.vendorId ?? null, source: input.source,
    },
  });

  return order;
}

export async function createPurchaseOrder(req: Request, res: Response) {
  try {
    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    // Client-supplied per-line catalog FKs must resolve in-org; misses fall back to SKU resolution.
    const validItemIds = await resolveExplicitItemIds(req, body.lines ?? []);

    const order = await persistPurchaseOrder(req, {
      // When both are present, both persist as given (the string stays the display
      // snapshot — same precedent as customer/customer_rel).
      vendor: body.vendor ?? vendorRow?.name ?? '',
      vendorId: body.vendorId ?? null,
      status: body.status,
      jobId: body.jobId,
      customerId: body.customerId,
      customer: body.customer,
      site: body.site,
      trade: body.trade,
      orderedAt: body.orderedAt,
      expectedDate: body.expectedDate,
      notes: body.notes,
      source: 'manual',
      lines: (body.lines ?? []).map((line: any) => ({
        itemSku: line.itemSku,
        itemName: line.itemName,
        uom: line.uom,
        qtyOrdered: line.qtyOrdered,
        qtyReceived: line.qtyReceived,
        unitCost: line.unitCost,
        priceBookItemId: line.priceBookItemId && validItemIds.has(line.priceBookItemId) ? line.priceBookItemId : null,
      })),
    });

    res.status(201).json({ purchaseOrder: mapPurchaseOrder(order, req) });
  } catch (err) {
    logger.error('Failed to create purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Create PO from a job (P2 item 1c, D16 entry 2) ──────────────────────────
export async function createPurchaseOrderFromJob(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof createPurchaseOrderFromJobSchema>;

    const job = await prisma.job.findFirst({
      where: { id: body.jobId, ...tenantWhere(req) },
      select: {
        id: true, job_number: true, status: true,
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });
    if (!job) { res.status(400).json({ error: 'Invalid job_id' }); return; }
    // Per-instance scope (QA-804 per-user-grant path makes this non-vacuous).
    if (!(await canAccessRow(req, 'Job', prisma.job, body.jobId))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    // Cancel is terminal — ordering materials for a cancelled job is always a mistake.
    if (job.status === 'CANCELLED') {
      res.status(409).json({ error: 'JOB_CANCELLED', message: 'Cannot order materials for a cancelled job' });
      return;
    }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    // Resolve requested job lines in one org-scoped query; any miss → 400.
    const jobLineIds = body.lines.map((l) => l.jobLineItemId).filter((v): v is string => !!v);
    const jobLines = jobLineIds.length > 0
      ? await prisma.jobLineItem.findMany({ where: { id: { in: jobLineIds }, job_id: job.id, ...tenantWhere(req) } })
      : [];
    const jobLineMap = new Map(jobLines.map((l: any) => [l.id, l]));
    if (jobLineIds.some((id) => !jobLineMap.has(id))) {
      res.status(400).json({ error: 'Invalid job_line_item_id' });
      return;
    }

    const resolveCatalogItem = (id: string, requireActive: boolean) =>
      prisma.priceBookItem.findFirst({
        where: { id, ...tenantWhere(req), ...(requireActive ? { is_active: true } : {}) },
        select: { id: true, sku: true, name: true, uom: true, unit_cost: true },
      });

    const lines: PersistPoLine[] = [];
    for (const reqLine of body.lines) {
      if (reqLine.jobLineItemId) {
        const jl: any = jobLineMap.get(reqLine.jobLineItemId)!;
        const catalog = jl.price_book_item_id ? await resolveCatalogItem(jl.price_book_item_id, false) : null;
        if (catalog) {
          lines.push({
            itemSku: catalog.sku ?? '', itemName: catalog.name, uom: catalog.uom ?? 'EA',
            qtyOrdered: reqLine.qty, qtyReceived: 0,
            unitCost: catalog.unit_cost != null ? Number(catalog.unit_cost) : null,
            priceBookItemId: catalog.id,
          });
        } else {
          // Free-text line — no catalog identity (the item_sku:'' convention is
          // established by autoCreateReservation).
          lines.push({
            itemSku: '', itemName: jl.description, uom: 'EA',
            qtyOrdered: reqLine.qty, qtyReceived: 0,
            unitCost: jl.unit_cost != null ? Number(jl.unit_cost) : null,
            priceBookItemId: null,
          });
        }
      } else {
        // Catalog-direct mode ("order more of X") — must be an active in-org item.
        const catalog = await resolveCatalogItem(reqLine.priceBookItemId!, true);
        if (!catalog) { res.status(400).json({ error: 'Invalid price_book_item_id' }); return; }
        lines.push({
          itemSku: catalog.sku ?? '', itemName: catalog.name, uom: catalog.uom ?? 'EA',
          qtyOrdered: reqLine.qty, qtyReceived: 0,
          unitCost: catalog.unit_cost != null ? Number(catalog.unit_cost) : null,
          priceBookItemId: catalog.id,
        });
      }
    }

    const cust = job.customer;
    const customerName = [cust?.first_name, cust?.last_name].filter(Boolean).join(' ') || cust?.company_name || 'Customer';
    const site = [job.service_location?.address_line1, job.service_location?.city, job.service_location?.state]
      .filter(Boolean).join(', ');

    const order = await persistPurchaseOrder(req, {
      vendor: vendorRow?.name ?? '', // drafts may pick a vendor later
      vendorId: body.vendorId ?? null,
      status: 'draft',
      jobId: job.id,
      customerId: cust?.id ?? null,
      customer: customerName,
      site: site || null,
      expectedDate: body.expectedDate ?? null,
      source: 'job',
      lines,
    });

    res.status(201).json({ purchaseOrder: mapPurchaseOrder(order, req) });
  } catch (err) {
    logger.error('Failed to create purchase order from job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Low-stock PO proposals (P2 item 2, D16 entry 3, QA-612) ─────────────────
// PROPOSE, don't create: a read-only computation the FE edits before submitting
// one plain POST /purchase-orders per vendor group. No writes → no audit row.
export async function listLowStockProposals(req: Request, res: Response) {
  try {
    // #2042 security round 3 (D): same predicate as mapPOLine/stripMappedItemCost.
    const canCost = canSeePricing(req);
    const { locationId } = req.query;
    if (locationId !== undefined && (typeof locationId !== 'string' || !uuidRegex.test(locationId))) {
      res.status(400).json({ error: 'locationId must be a valid UUID' });
      return;
    }
    if (locationId) {
      const loc = await prisma.inventoryLocation.findFirst({
        where: { id: locationId as string, ...tenantWhere(req) }, select: { id: true },
      });
      if (!loc) { res.status(404).json({ error: 'Stock location not found' }); return; }
    }

    const balances = await prisma.stockBalance.findMany({
      where: {
        ...tenantWhere(req),
        min: { not: null },
        ...(locationId ? { location_id: locationId as string } : {}),
        // D8 + QA-105: never propose ordering inactive/untracked SKUs.
        item: { track_inventory: true, is_active: true },
      },
      include: {
        item: { select: { id: true, sku: true, name: true, uom: true, unit_cost: true, vendor_id: true, vendor: { select: { id: true, name: true, contact_email: true } } } },
        location: { select: { id: true, name: true } },
      },
    });

    // Prisma cannot compare two columns — filter on_hand < min in JS (per-org
    // balance row counts are small). min is per-(item,location).
    const low = balances.filter((b: any) => b.min != null && Number(b.on_hand) < b.min);

    // Group by the item's vendor; the vendorId:null group is returned for a manual
    // vendor pick — proposals are NEVER auto-created into POs.
    // Non-goals (v1 is min-gap only): no dedup against open POs already covering
    // the shortfall; no max-based order-up-to logic.
    const groups = new Map<string | null, any>();
    for (const b of low as any[]) {
      const key: string | null = b.item?.vendor_id ?? null;
      if (!groups.has(key)) {
        groups.set(key, {
          vendorId: key,
          vendorName: b.item?.vendor?.name ?? null,
          vendorEmail: b.item?.vendor?.contact_email ?? null,
          lines: [],
        });
      }
      groups.get(key).lines.push({
        itemId: b.item.id,
        itemSku: b.item.sku ?? '',
        itemName: b.item.name,
        uom: b.item.uom ?? 'EA',
        locationId: b.location?.id ?? b.location_id,
        locationName: b.location?.name ?? '',
        onHand: Number(b.on_hand),
        min: b.min,
        suggestedQty: Math.ceil(b.min - Number(b.on_hand)),
        // canCost=false → omit (undefined drops out of the JSON body, #2042 round 3 D).
        // canCost=true → the pre-existing shape: null for an uncatalogued/costless item, never
        // absent — a cost-sighted caller must still be able to tell "priced at zero" apart from
        // "the server withheld this".
        unitCost: canCost ? (b.item.unit_cost != null ? Number(b.item.unit_cost) : null) : undefined,
      });
    }

    res.json({ proposals: [...groups.values()] });
  } catch (err) {
    logger.error('Failed to compute low-stock proposals:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Statuses whose receipts are gone as far as the record is concerned: moving back to one of
// these clears received_at. `closed` and `cancelled` keep it - a closed PO was still received
// on that date, and a cancelled-after-receipt PO keeps its history until the receipt is corrected.
const CLEARS_RECEIVED_AT = new Set<string>(['draft', 'ordered', 'partial']);

export async function updatePurchaseOrder(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const existing = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    const body = req.body;

    // Lines are frozen outside Draft (verdict §3): an ordered PO must not change under its
    // receipts. Judged on the STORED status before any write, so a PATCH that also carries
    // `status: 'draft'` cannot unfreeze itself in the same call.
    if (body.lines !== undefined && existing.status !== 'draft') {
      res.status(409).json({
        error: 'PO_LINES_FROZEN',
        message: 'Lines can only be edited while the PO is in Draft',
        status: existing.status,
      });
      return;
    }

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const { error: vendorError, vendor: vendorRow } = await validateVendor(req, body.vendorId);
    if (vendorError) { res.status(400).json({ error: vendorError }); return; }

    // po_number is immutable and server-owned (P0 §A) — deliberately no mapping.
    const data: any = {};
    if (body.vendor !== undefined) data.vendor = body.vendor;
    if (body.vendorId !== undefined) {
      data.vendor_id = body.vendorId ?? null;
      // A non-null vendorId without an explicit display string refreshes it from the row.
      if (body.vendorId && body.vendor === undefined && vendorRow) data.vendor = vendorRow.name;
    }
    if (body.jobId !== undefined) data.job_id = body.jobId ?? null;
    if (body.customerId !== undefined) data.customer_id = body.customerId ?? null;
    if (body.customer !== undefined) data.customer = body.customer;
    if (body.site !== undefined) data.site = body.site;
    if (body.trade !== undefined) data.trade = body.trade;
    if (body.orderedAt !== undefined) data.ordered_at = new Date(body.orderedAt);
    if (body.expectedDate !== undefined) data.expected_date = body.expectedDate ? new Date(body.expectedDate) : null;
    if (body.notes !== undefined) data.notes = body.notes ?? null;

    // Free status movement (verdict §2) with its side effects:
    //  • entering `received` stamps received_at once (kept if already set);
    //  • moving back to draft / ordered / partial clears it;
    //  • entering `ordered` on a PO that was never marked stamps ordered_at + actor, so an
    //    "Ordered" row always carries a date; moving back to `draft` clears both — a draft is,
    //    by definition, not ordered (and recomputePoStatus reads ordered_at to tell them apart).
    const statusChanged = body.status !== undefined && body.status !== existing.status;
    if (statusChanged) {
      data.status = body.status;
      if (body.status === 'received') {
        if (!existing.received_at) data.received_at = new Date();
      } else if (CLEARS_RECEIVED_AT.has(body.status)) {
        data.received_at = null;
      }
      if (body.status === 'ordered' && !existing.ordered_at) {
        data.ordered_at = data.ordered_at ?? new Date();
        data.ordered_by_id = req.user!.id;
      }
      if (body.status === 'draft') {
        data.ordered_at = null;
        data.ordered_by_id = null;
      }
    }

    // Buyer signature (verdict §6): the server owns the timestamp. Clearing the image unsigns
    // the PO — data, name and time go together, never a name with no signature behind it.
    if (body.signatureData !== undefined) {
      if (body.signatureData) {
        data.signature_data = body.signatureData;
        data.signature_name = body.signatureName ?? existing.signature_name ?? actorName(req.user) ?? null;
        data.signature_at = new Date();
      } else {
        data.signature_data = null;
        data.signature_name = null;
        data.signature_at = null;
      }
    } else if (body.signatureName !== undefined && existing.signature_data) {
      data.signature_name = body.signatureName;
    }

    // Lines are replace-all when provided (mirrors the dialog's full-form submit); only
    // reachable in draft (guard above), so no receipt is ever discarded here.
    if (body.lines !== undefined) {
      await prisma.purchaseOrderLine.deleteMany({
        where: { purchase_order_id: existing.id, ...tenantWhere(req) },
      });
      const skuMap = await resolveSkuMap(req, body.lines.map((l: any) => l.itemSku));
      const validItemIds = await resolveExplicitItemIds(req, body.lines);
      data.lines = {
        create: body.lines.map((line: any) => ({
          item_sku: line.itemSku,
          item_name: line.itemName,
          uom: line.uom,
          qty_ordered: line.qtyOrdered,
          qty_received: line.qtyReceived ?? 0,
          unit_cost: line.unitCost ?? null,
          price_book_item_id: (line.priceBookItemId && validItemIds.has(line.priceBookItemId) ? line.priceBookItemId : null)
            ?? skuMap.get(line.itemSku) ?? null,
          organization_id: orgId,
        })),
      };
    }

    const order = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data,
      include: PO_INCLUDE,
    });

    // F3: surface a received PO on the linked job's central timeline.
    if (existing.job_id && statusChanged && body.status === 'received') {
      await prisma.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB', entity_id: existing.job_id,
          event_type: 'PO_RECEIVED',
          description: `Purchase order received: ${order.po_number}`,
          metadata: { purchase_order_id: existing.id },
          created_by: req.user!.id,
        },
      });
    }

    void logAudit({
      req,
      action: 'inventory.po_updated',
      resourceType: 'PurchaseOrder',
      resourceId: existing.id,
      metadata: {
        fields: Object.keys(req.body),
        ...(body.status ? { status: body.status } : {}),
        // Every status change is audited with both ends (verdict §2).
        ...(statusChanged ? { status_from: existing.status, status_to: body.status } : {}),
      },
    });

    res.json({ purchaseOrder: mapPurchaseOrder(order, req) });
  } catch (err) {
    logger.error('Failed to update purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Mark as ordered (verdict §2) ─────────────────────────────────────────────
// The buyer placed the order their own way (phone, vendor portal, their own email client);
// ServWave records only that it happened, on which date, and by whom. Allowed from any status
// except `ordered` itself; the date defaults to now and may be back-dated by the client.
export async function markPurchaseOrderOrdered(req: Request, res: Response) {
  try {
    const existing = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) { res.status(404).json({ error: 'Purchase order not found' }); return; }
    if (existing.status === 'ordered') {
      res.status(409).json({ error: 'PO_ALREADY_ORDERED', message: 'This PO is already marked as ordered' });
      return;
    }

    const orderedAt = req.body?.orderedAt ? new Date(req.body.orderedAt) : new Date();
    const order = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data: {
        status: 'ordered',
        ordered_at: orderedAt,
        ordered_by_id: req.user!.id,
        // Same rule as the PATCH path: ordered is upstream of received.
        received_at: null,
      },
      include: PO_INCLUDE,
    });

    void logAudit({
      req,
      action: 'inventory.po_ordered',
      resourceType: 'PurchaseOrder',
      resourceId: existing.id,
      metadata: { po_number: existing.po_number, status_from: existing.status, ordered_at: orderedAt.toISOString() },
    });

    res.json({ purchaseOrder: mapPurchaseOrder(order, req) });
  } catch (err) {
    logger.error('Failed to mark purchase order ordered:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Delete (verdict §2) ──────────────────────────────────────────────────────
// Allowed while nothing has been received: draft | ordered | cancelled with every line at
// qty_received 0. Anything else is 409 PO_HAS_RECEIPTS — the client offers Cancel instead and
// tells the user to correct the receipt to zero first (stock movements reference the PO by
// number only, so a hard delete under a receipt would orphan the ledger). Lines cascade.
const RECEIPT_STATUSES = new Set<string>(['partial', 'received', 'closed']);

export async function deletePurchaseOrder(req: Request, res: Response) {
  try {
    const existing = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: { lines: { select: { qty_received: true } } },
    });
    if (!existing) { res.status(404).json({ error: 'Purchase order not found' }); return; }

    const anyReceived = (existing.lines ?? []).some((l: any) => Number(l.qty_received) > 0);
    if (RECEIPT_STATUSES.has(existing.status) || anyReceived) {
      res.status(409).json({
        error: 'PO_HAS_RECEIPTS',
        message: 'Stock has been received against this PO. Correct the receipt to zero first, or cancel the PO instead.',
        status: existing.status,
      });
      return;
    }

    await prisma.purchaseOrder.deleteMany({ where: { id: existing.id, ...tenantWhere(req) } });

    void logAudit({
      req,
      action: 'inventory.po_deleted',
      resourceType: 'PurchaseOrder',
      resourceId: existing.id,
      metadata: { po_number: existing.po_number, vendor: existing.vendor, status: existing.status },
    });

    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PO Receipt (B2/V5) — stock side-effects ONLY (DEC2: no billing) ────────

export const receivePurchaseOrderSchema = z.object({
  poId: z.string().uuid(),
  // D14: optional receive-destination picker; absent → the DEC3 org default.
  destinationLocationId: z.string().uuid().optional(),
  // Identify by the PO line's own id — SKU is a non-unique, sometimes-blank label (D2).
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    qtyReceived: z.number().min(0),
  })).min(1),
});

// PO status from line fill — shared by the PO receive path AND the staging
// write-through (P2 4e) so the status math cannot drift.
//
// All-zero is NOT "whatever it was" (the old `: currentStatus` fallback left a receipt
// corrected back to nothing stuck at "partially received"): it returns the PO to Ordered, or to
// Draft if it was never marked ordered. Entering received stamps received_at once; leaving it
// clears it, so History's "Received on" and leadTimeDays stay honest (verdict §2).
export interface PoStatusInputs {
  id: string;
  status: string;
  ordered_at?: Date | null;
  received_at?: Date | null;
}

export async function recomputePoStatus(tx: Prisma.TransactionClient, po: PoStatusInputs): Promise<string> {
  const lines = await tx.purchaseOrderLine.findMany({ where: { purchase_order_id: po.id } });
  const allReceived = lines.length > 0 && lines.every((l) => Number(l.qty_received) >= Number(l.qty_ordered));
  const anyReceived = lines.some((l) => Number(l.qty_received) > 0);
  const status = allReceived ? 'received' : anyReceived ? 'partial' : (po.ordered_at ? 'ordered' : 'draft');
  const data: { status: string; received_at?: Date | null } = { status };
  if (status === 'received') {
    if (!po.received_at) data.received_at = new Date();
  } else if (po.received_at) {
    data.received_at = null;
  }
  await tx.purchaseOrder.update({ where: { id: po.id }, data });
  return status;
}

export async function receivePurchaseOrder(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof receivePurchaseOrderSchema>;

    const po = await prisma.purchaseOrder.findFirst({
      where: { id: body.poId, ...tenantWhere(req) },
      include: { lines: true },
    });
    if (!po) { res.status(404).json({ error: 'Purchase order not found' }); return; }

    // 4a (QA-606): per-line over-receive guard — validate ALL lines before any
    // write, so a 400 leaves zero partial application. qtyReceived is an absolute
    // total (dialog semantics): the invariant is 0 ≤ qtyReceived ≤ qty_ordered.
    // Downward corrections remain signed adjust movements below — never bypassed.
    for (const recv of body.lines) {
      const poLine = po.lines.find((l) => l.id === recv.lineId);
      if (!poLine) continue; // unchanged tolerance: unknown line ids are skipped
      if (recv.qtyReceived > Number(poLine.qty_ordered)) {
        res.status(400).json({
          error: 'OVER_RECEIVE',
          item_sku: poLine.item_sku,
          qty_ordered: Number(poLine.qty_ordered),
          qty_received: recv.qtyReceived,
        });
        return;
      }
    }

    // 4d (D14/§3.6/QA-611): single-receive-path — lines staged to a JobStage must
    // be received via the Staging view (which write-throughs to the PO line).
    // Per-line so a backfilled/legacy partially-staged PO can still receive its
    // unstaged lines here.
    if (po.staged_as_job_stage_id) {
      const stagedSkus = new Set((await prisma.jobStageLine.findMany({
        where: { purchase_order_id: po.id, ...tenantWhere(req) },
        select: { item_sku: true },
      })).map((l) => l.item_sku).filter((s) => s !== ''));
      // Derive each received line's SKU from the matched PO line; the blank sentinel
      // never matches (a free-text line cannot be SKU-staged).
      const offending = body.lines
        .map((recv) => po.lines.find((l) => l.id === recv.lineId))
        .filter((l): l is NonNullable<typeof l> => !!l && l.item_sku !== '' && stagedSkus.has(l.item_sku))
        .map((l) => l.item_sku);
      if (offending.length > 0) {
        res.status(409).json({ error: 'STAGED_PO', message: 'Receive staged lines via the Staging view', staged_skus: offending });
        return;
      }
    }

    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';

    // 4b (D14): explicit org-validated destination for every movement in this
    // call; absent → the DEC3 org default (a default, not a rule).
    let destinationId: string | null;
    if (body.destinationLocationId) {
      const loc = await prisma.inventoryLocation.findFirst({
        where: { id: body.destinationLocationId, ...tenantWhere(req) }, select: { id: true },
      });
      if (!loc) { res.status(404).json({ error: 'Stock location not found' }); return; }
      destinationId = loc.id;
    } else {
      destinationId = await resolveReceiveLocationId(req);
    }

    // S4.3: an org with neither a default nor a warehouse location has nowhere
    // to put the parts. This used to fall through into the movement write and
    // surface as a 500; the staging write-through already names this case, so
    // the same code is reused here and the dialog points at Settings → Locations.
    if (!destinationId) {
      res.status(409).json({
        error: 'NO_STOCK_LOCATION',
        message: 'Add an inventory location under Settings → Locations before receiving.',
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const recv of body.lines) {
        const poLine = po.lines.find((l) => l.id === recv.lineId);
        if (!poLine) continue;
        // The dialog submits absolute totals; compute the delta against the stored qty_received.
        const prevReceived = Number(poLine.qty_received);
        const delta = recv.qtyReceived - prevReceived;
        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: { qty_received: recv.qtyReceived },
        });
        if (delta !== 0) {
          await applyStockMovement(tx, {
            orgId, type: delta > 0 ? 'receive' : 'adjust',
            itemSku: poLine.item_sku, itemName: poLine.item_name,
            // Signed: a downward correction (delta < 0) must SUBTRACT from the balance;
            // the ledger records adjust rows with negative qty (seed convention).
            // Identity is the stored FK — free-text (null) → ledger only, no balance (D2).
            qty: delta, itemId: poLine.price_book_item_id ?? null,
            jobId: po.job_id ?? null,
            unitCost: poLine.unit_cost != null ? Number(poLine.unit_cost) : null,
            actorUserId: req.user!.id,
            toLocationId: destinationId,
            reference: po.po_number, actor,
          });
        }
        // DEC2: NO billing. Material cost is the read-side roll-up (Task 6) — never a JobCharge.
      }
      await recomputePoStatus(tx, po);

      return tx.purchaseOrder.findFirst({ where: { id: po.id }, include: PO_INCLUDE });
    });

    // inventory.po_partial — fire only when status resolves to 'partial'; fire-and-forget.
    if ((updated as any)?.status === 'partial') {
      emitPoPartial(orgId, req.user!.id, po.id, po.po_number);
    }

    void logAudit({
      req,
      action: 'inventory.po_received',
      resourceType: 'PurchaseOrder',
      resourceId: po.id,
      metadata: { po_number: po.po_number, status: (updated as any)?.status, lines_received: body.lines.length },
    });

    res.json({ purchaseOrder: mapPurchaseOrder(updated, req) });
  } catch (err) {
    logger.error('Failed to receive purchase order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── RFQ Handlers ───────────────────────────────────────

export async function listRfqs(req: Request, res: Response) {
  try {
    const rfqs = await prisma.rfq.findMany({
      where: tenantWhere(req),
      orderBy: { requested_at: 'desc' },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.json({ rfqs: rfqs.map(mapRfq) });
  } catch (err) {
    logger.error('Failed to list RFQs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getRfq(req: Request, res: Response) {
  try {
    const rfq = await prisma.rfq.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    if (!rfq) {
      res.status(404).json({ error: 'RFQ not found' });
      return;
    }

    res.json({ rfq: mapRfq(rfq) });
  } catch (err) {
    logger.error('Failed to get RFQ:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createRfq(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const skuMap = await resolveSkuMap(req, (body.lines ?? []).map((l: any) => l.itemSku));

    const rfq = await prisma.rfq.create({
      data: {
        rfq_number: body.rfqNumber,
        job_id: body.jobId ?? null,
        customer_id: body.customerId ?? null,
        job_number: body.jobNumber ?? null,
        customer: body.customer ?? null,
        site: body.site ?? null,
        trade: body.trade ?? null,
        requested_at: body.requestedAt ? new Date(body.requestedAt) : new Date(),
        responses_due_by: new Date(body.responsesDueBy),
        lines_summary: body.linesSummary,
        status: body.status ?? 'awaiting_quotes',
        organization_id: orgId,
        lines: {
          create: (body.lines ?? []).map((line: any) => ({
            item_sku: line.itemSku,
            item_name: line.itemName,
            qty: line.qty,
            uom: line.uom,
            price_book_item_id: skuMap.get(line.itemSku) ?? null,
            organization_id: orgId,
          })),
        },
        quotes: {
          create: (body.quotes ?? []).map((quote: any) => ({
            vendor: quote.vendor,
            total: quote.total,
            lead_time_days: quote.leadTimeDays,
            recommended: quote.recommended ?? false,
            organization_id: orgId,
          })),
        },
      },
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.status(201).json({ rfq: mapRfq(rfq) });
  } catch (err) {
    logger.error('Failed to create RFQ:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateRfq(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const existing = await prisma.rfq.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'RFQ not found' });
      return;
    }

    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const data: any = {};
    if (body.rfqNumber !== undefined) data.rfq_number = body.rfqNumber;
    if (body.jobId !== undefined) data.job_id = body.jobId ?? null;
    if (body.customerId !== undefined) data.customer_id = body.customerId ?? null;
    if (body.jobNumber !== undefined) data.job_number = body.jobNumber;
    if (body.customer !== undefined) data.customer = body.customer;
    if (body.site !== undefined) data.site = body.site;
    if (body.trade !== undefined) data.trade = body.trade;
    if (body.requestedAt !== undefined) data.requested_at = new Date(body.requestedAt);
    if (body.responsesDueBy !== undefined) data.responses_due_by = new Date(body.responsesDueBy);
    if (body.linesSummary !== undefined) data.lines_summary = body.linesSummary;
    if (body.status !== undefined) data.status = body.status;

    if (body.lines !== undefined) {
      await prisma.rfqLine.deleteMany({ where: { rfq_id: existing.id, ...tenantWhere(req) } });
      const skuMap = await resolveSkuMap(req, body.lines.map((l: any) => l.itemSku));
      data.lines = {
        create: body.lines.map((line: any) => ({
          item_sku: line.itemSku,
          item_name: line.itemName,
          qty: line.qty,
          uom: line.uom,
          price_book_item_id: skuMap.get(line.itemSku) ?? null,
          organization_id: orgId,
        })),
      };
    }

    if (body.quotes !== undefined) {
      await prisma.rfqQuote.deleteMany({ where: { rfq_id: existing.id, ...tenantWhere(req) } });
      data.quotes = {
        create: body.quotes.map((quote: any) => ({
          vendor: quote.vendor,
          total: quote.total,
          lead_time_days: quote.leadTimeDays,
          recommended: quote.recommended ?? false,
          organization_id: orgId,
        })),
      };
    }

    const rfq = await prisma.rfq.update({
      where: { id: existing.id },
      data,
      include: {
        lines: { orderBy: { created_at: 'asc' } },
        quotes: { orderBy: { created_at: 'asc' } },
        emails: { orderBy: { sent_at: 'asc' } },
        customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      },
    });

    res.json({ rfq: mapRfq(rfq) });
  } catch (err) {
    logger.error('Failed to update RFQ:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Job material-cost roll-up (V1 re-scoped, DEC2) — read-side, ZERO billing ─
// material_cost = Σ over the job's PO lines + stage lines of
//   qty_received × (line.unit_cost ?? PriceBookItem.unit_cost via the D5 FK).
// StockMovement carries no cost/job_id and JobCharge is billing-only, so neither
// is the source: the roll-up walks the PO/JobStage→Job FK (Task 2). It NEVER
// touches the Invoice — customer billing stays explicit (line items / JobCharge).
export async function getJobMaterialCost(req: Request, res: Response) {
  try {
    const jobId = req.params.jobId as string;
    // Org-scope AND the caller's Job read scope (#2042 R3): this route gates on
    // `read PurchaseOrder`, but the parameter is a job id and it returns the aggregate of
    // exactly the per-PO costs `read PurchaseOrder`'s row-scope hides elsewhere - so it is
    // scoped by `read Job`, which SALES already holds job-scoped, not by `read PurchaseOrder`.
    const job = await prisma.job.findFirst({
      where: { id: jobId, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
      select: { id: true },
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

    // PO lines linked to this job (via PurchaseOrder.job_id), and JobStage lines linked
    // via JobStage.job_id. Pull the line cost + catalog fallback cost in one query each.
    //
    // P2 dedup (§3.6, per line, PO side wins): a stage line WITH purchase_order_id is
    // the same physical order as its PO line (the 4e write-through keeps the PO line's
    // qty_received authoritative) — excluding it here counts each order exactly once.
    // Manual stage lines (purchase_order_id IS NULL) exist nowhere else and keep
    // counting; PO lines always count, which also covers partially-staged POs.
    // Legacy stage lines the backfill couldn't link (no po_number match) can still
    // double-count only if both sides were historically received; the staged-PO 409
    // guard prevents new occurrences — no further heuristic.
    const [poLines, stageLines] = await Promise.all([
      prisma.purchaseOrderLine.findMany({
        where: { purchase_order: { job_id: jobId, ...tenantWhere(req) } },
        select: { qty_received: true, unit_cost: true, price_book_item: { select: { unit_cost: true } } },
      }),
      prisma.jobStageLine.findMany({
        where: { job_stage: { job_id: jobId, ...tenantWhere(req) }, purchase_order_id: null },
        select: { qty_received: true, unit_cost: true, price_book_item: { select: { unit_cost: true } } },
      }),
    ]);

    const costOf = (line: any): number => {
      const unit = line.unit_cost != null ? Number(line.unit_cost)
        : (line.price_book_item?.unit_cost != null ? Number(line.price_book_item.unit_cost) : 0);
      return Number(line.qty_received) * unit;
    };
    const allLines = [...poLines, ...stageLines];
    const materialCost = Math.round(allLines.reduce((sum, l) => sum + costOf(l), 0) * 100) / 100;

    // #2042 security round 3 (D): the aggregate IS cost data, same predicate as mapPOLine —
    // omit it for a cost-blind caller; jobId/lineCount are not cost and stay for every reader.
    res.json({ jobId, materialCost: canSeePricing(req) ? materialCost : undefined, lineCount: allLines.length });
  } catch (err) {
    logger.error('Failed to compute job material cost:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
