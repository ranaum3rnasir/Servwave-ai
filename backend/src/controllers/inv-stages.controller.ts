import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import { applyStockMovement } from './inv-stock.controller';
import { recomputePoStatus } from './inv-po.controller';
import { emitStagingReady, emitStagingNoAreaIfNeeded, emitPoPartial } from '../services/notifications/inventoryEmit';
import { sendStagePickupEmail, dispatchFailureStatus } from '../lib/email';
import { getOrgTimezone } from '../lib/timezone';

// ─── Stage attachments → Supabase Storage (P5 §5) ───────────────────────────
// Reuses the existing `attachments` bucket (RLS policies already in place).
// storage_path is canonical for new rows (data_url:''); legacy emanuel-era rows
// keep their base64 data-URI in data_url and flow through the read path unchanged.

const STORAGE_BUCKET = 'attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h — same TTL as attachment.controller.ts

// The dialog rasterizes PDFs to PNGs client-side, so the server only ever sees
// images/videos — application/pdf is deliberately NOT allowed here.
const STAGE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
const STAGE_VIDEO_MIMES = ['video/mp4', 'video/quicktime'];
const STAGE_ALLOWED_MIMES = [...STAGE_IMAGE_MIMES, ...STAGE_VIDEO_MIMES];
// Per-kind caps matching StageDetailDialog's client caps. The 100MB video cap is
// double-guarded: multer's route-level fileSize limit AND this handler check.
// Exported so inv-stages.routes.ts builds its too-large message from these same numbers.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * Batch-mint short-lived signed URLs for every Storage-backed photo across the
 * given stages: ONE createSignedUrls call per response (never per-row). Returns
 * a storage_path → signedUrl map; on ANY failure it log-warns and returns an
 * empty map so rows degrade to '' instead of 500ing the whole stage list.
 * Zero-cost when no photo carries a storage_path (the common legacy case).
 */
async function signStagePhotoUrls(stages: any[]): Promise<Map<string, string>> {
  const paths: string[] = [];
  for (const stage of stages) {
    for (const photo of stage?.photos ?? []) {
      if (photo?.storage_path) paths.push(photo.storage_path);
    }
  }
  if (paths.length === 0) return new Map();
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      logger.warn('Failed to sign stage photo URLs; photos will render empty this response', error ?? '');
      return new Map();
    }
    const map = new Map<string, string>();
    for (const row of data) {
      if (row?.path && row?.signedUrl) map.set(row.path, row.signedUrl);
    }
    return map;
  } catch (err) {
    logger.warn('Failed to sign stage photo URLs; photos will render empty this response', err);
    return new Map();
  }
}

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

// ─── SKU → PriceBookItem resolver (V6/D5) ───────────────────────────────────
// Map each inbound stage line's item_sku to a catalog PriceBookItem id within
// the requesting org. @@unique([organization_id, sku]) guarantees ≤1 match per
// SKU. Lines whose SKU has no catalog match keep price_book_item_id = null.
// (Duplicated from inv-po.controller to avoid a cross-controller import.)
async function resolveSkuMap(req: Request, skus: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(skus.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const items = await prisma.priceBookItem.findMany({
    where: { sku: { in: unique }, ...tenantWhere(req) },
    select: { id: true, sku: true },
  });
  return new Map(items.filter((i) => i.sku).map((i) => [i.sku as string, i.id]));
}

// ─── Receive-location resolver (DEC3) ───────────────────────────────────────
// Resolve the org's configured default inventory location; fall back to the
// first 'warehouse' location only if no default is set (e.g. legacy orgs).
// (Duplicated from inv-po.controller to avoid a cross-controller import.)
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

// ─── Mappers (snake_case Prisma row → camelCase mock contract) ──────────

function mapLine(line: any) {
  return {
    id: line.id,
    itemSku: line.item_sku,
    itemName: line.item_name,
    uom: line.uom,
    qtyOrdered: Number(line.qty_ordered),
    qtyReceived: Number(line.qty_received),
    unitCost: line.unit_cost != null ? Number(line.unit_cost) : undefined,
    vendor: line.vendor,
    poNumber: line.po_number ?? '',
    expectedDate: line.expected_date ? line.expected_date.toISOString() : undefined,
    serialized: line.serialized,
    receivedSerials: (line.received_serials as string[] | null) ?? undefined,
    priceBookItemId: line.price_book_item_id ?? undefined,
  };
}

// dataUrl is dual-generation: a short-lived signed URL for Storage rows
// (storage_path canonical), the stored base64 data-URI for legacy rows. Both
// are valid <img>/<video> src values — renderers work unchanged.
function mapAttachment(att: any, signed?: Map<string, string>) {
  return {
    id: att.id,
    kind: att.kind,
    dataUrl: att.storage_path ? (signed?.get(att.storage_path) ?? '') : att.data_url,
    mimeType: att.mime_type ?? undefined,
    caption: att.caption ?? undefined,
    uploadedAt: att.uploaded_at.toISOString(),
    uploadedBy: att.uploaded_by,
    source: att.source ?? undefined,
    pdfPageNumber: att.pdf_page_number ?? undefined,
    pdfFileName: att.pdf_file_name ?? undefined,
    durationSeconds: att.duration_seconds ?? undefined,
    sizeBytes: att.size_bytes ?? undefined,
    poNumber: att.po_number ?? undefined,
  };
}

function mapAuditEntry(entry: any) {
  return {
    id: entry.id,
    at: entry.at.toISOString(),
    actorName: entry.actor_name,
    field: entry.field,
    oldValue: entry.old_value ?? undefined,
    newValue: entry.new_value,
    comment: entry.comment ?? undefined,
  };
}

function mapJobStage(stage: any, signed?: Map<string, string>) {
  return {
    id: stage.id,
    jobNumber: stage.job_number,
    customer: stage.customer,
    site: stage.site,
    scheduledFor: stage.scheduled_for ? stage.scheduled_for.toISOString() : undefined,
    assignedTechId: stage.assigned_tech_id ?? undefined,
    assignedTech: stage.assigned_tech ?? undefined,
    trade: stage.trade,
    status: stage.status,
    pickupVendorId: stage.pickup_vendor_id ?? undefined,
    pickupAddress: stage.pickup_address ?? undefined,
    stagedLocationId: stage.staged_location_id ?? undefined,
    stagedArea: stage.staged_area ?? undefined,
    items: (stage.items ?? []).map(mapLine),
    photos: stage.photos && stage.photos.length > 0 ? stage.photos.map((p: any) => mapAttachment(p, signed)) : undefined,
    notes: stage.notes ?? undefined,
    createdAt: stage.created_at.toISOString(),
    updatedAt: stage.updated_at ? stage.updated_at.toISOString() : undefined,
    auditLog: stage.audit_log && stage.audit_log.length > 0 ? stage.audit_log.map(mapAuditEntry) : undefined,
  };
}

const stageInclude = {
  items: { orderBy: { created_at: 'asc' as const } },
  photos: { orderBy: { uploaded_at: 'asc' as const } },
  audit_log: { orderBy: { at: 'asc' as const } },
  customer_rel: { select: { id: true, first_name: true, last_name: true, company_name: true } },
};

// ─── Zod Schemas ────────────────────────────────────────

const stageLineSchema = z.object({
  itemSku: z.string().min(1).max(100),
  itemName: z.string().min(1).max(300),
  uom: z.string().min(1).max(20),
  qtyOrdered: z.number().min(0),
  qtyReceived: z.number().min(0),
  unitCost: z.number().min(0).nullable().optional(),
  vendor: z.string().max(200),
  poNumber: z.string().max(100).nullable().optional(),
  expectedDate: z.string().nullable().optional(),
  serialized: z.boolean().optional(),
  receivedSerials: z.array(z.string()).nullable().optional(),
});

export const createStageSchema = z.object({
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().min(1, 'Job number is required').max(100),
  customer: z.string().min(1, 'Customer is required').max(200),
  site: z.string().min(1, 'Site is required').max(500),
  scheduledFor: z.string().nullable().optional(),
  assignedTechId: z.string().uuid().nullable().optional(),
  assignedTech: z.string().max(200).nullable().optional(),
  trade: z.string().min(1).max(50),
  status: z.string().min(1).max(50),
  pickupVendorId: z.string().max(100).nullable().optional(),
  pickupAddress: z.string().max(500).nullable().optional(),
  stagedLocationId: z.string().uuid().nullable().optional(),
  stagedArea: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(stageLineSchema).optional(),
  // P2 4c: stage an existing PO — the server copies ALL PO lines (client items
  // are ignored on this path) and links PO ↔ stage atomically.
  stagedFromPurchaseOrderId: z.string().uuid().nullable().optional(),
  // Linkage-only alternative to the above: KEEP the client's lines (the dialog
  // prefills them from the PO and then lets the operator edit quantities, so
  // re-copying server-side would silently discard those edits) and just record
  // which PO they came from. Stamping purchase_order_id is what arms the 4e
  // receive write-through back onto the PO line.
  linkedPurchaseOrderId: z.string().uuid().nullable().optional(),
});

export const updateStageSchema = z.object({
  jobId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().min(1).max(100).optional(),
  customer: z.string().min(1).max(200).optional(),
  site: z.string().min(1).max(500).optional(),
  scheduledFor: z.string().nullable().optional(),
  assignedTechId: z.string().uuid().nullable().optional(),
  assignedTech: z.string().max(200).nullable().optional(),
  trade: z.string().min(1).max(50).optional(),
  status: z.string().min(1).max(50).optional(),
  pickupVendorId: z.string().max(100).nullable().optional(),
  pickupAddress: z.string().max(500).nullable().optional(),
  stagedLocationId: z.string().uuid().nullable().optional(),
  stagedArea: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// ─── Handlers ───────────────────────────────────────────

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listJobStages(req: Request, res: Response) {
  try {
    const { job_id } = req.query;

    // Validate job_id when provided — must be a UUID string
    if (job_id !== undefined) {
      if (typeof job_id !== 'string' || !uuidRegex.test(job_id)) {
        res.status(400).json({ error: 'job_id must be a valid UUID' });
        return;
      }
    }

    const stages = await prisma.jobStage.findMany({
      where: {
        ...tenantWhere(req),
        ...(job_id ? { job_id } : {}),
      },
      orderBy: { created_at: 'desc' },
      include: stageInclude,
    });

    const signed = await signStagePhotoUrls(stages);
    res.json({ jobStages: stages.map((s) => mapJobStage(s, signed)) });
  } catch (err) {
    logger.error('Failed to list job stages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getJobStage(req: Request, res: Response) {
  try {
    const stage = await prisma.jobStage.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: stageInclude,
    });

    if (!stage) {
      res.status(404).json({ error: 'Job stage not found' });
      return;
    }

    res.json({ jobStage: mapJobStage(stage, await signStagePhotoUrls([stage])) });
  } catch (err) {
    logger.error('Failed to get job stage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Thrown when the atomic stage-claim on a PO loses the race (P2 4c).
class PoStageClaimError extends Error {}

export async function createJobStage(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    // ─── P2 4c: stage-from-PO — server-side linkage + atomic claim ────────────
    if (body.stagedFromPurchaseOrderId) {
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: body.stagedFromPurchaseOrderId, ...tenantWhere(req) },
        include: { lines: { orderBy: { created_at: 'asc' } } },
      });
      if (!po) { res.status(400).json({ error: 'Invalid purchase_order_id' }); return; }
      if (po.staged_as_job_stage_id != null) {
        res.status(409).json({ error: 'PO_ALREADY_STAGED' });
        return;
      }
      if (po.status === 'received' || po.status === 'closed') {
        res.status(409).json({ error: 'PO_NOT_STAGEABLE' });
        return;
      }

      let stage;
      try {
        stage = await prisma.$transaction(async (tx) => {
          // Copy ALL PO lines server-side (client items are ignored on the staged
          // path so the line set cannot drift). qty_received starts in lockstep
          // with the PO line — the 4e write-through keeps it that way.
          const created = await tx.jobStage.create({
            data: {
              job_id: body.jobId ?? po.job_id ?? null,
              customer_id: body.customerId ?? po.customer_id ?? null,
              job_number: body.jobNumber,
              customer: body.customer,
              site: body.site,
              scheduled_for: body.scheduledFor ? new Date(body.scheduledFor) : null,
              assigned_tech_id: body.assignedTechId ?? null,
              assigned_tech: body.assignedTech ?? null,
              trade: body.trade,
              status: body.status,
              pickup_vendor_id: body.pickupVendorId ?? null,
              pickup_address: body.pickupAddress ?? null,
              staged_location_id: body.stagedLocationId ?? null,
              staged_area: body.stagedArea ?? null,
              notes: body.notes ?? null,
              organization_id: orgId,
              items: {
                create: po.lines.map((line: any) => ({
                  item_sku: line.item_sku,
                  item_name: line.item_name,
                  uom: line.uom,
                  qty_ordered: line.qty_ordered,
                  qty_received: line.qty_received,
                  unit_cost: line.unit_cost,
                  vendor: po.vendor,
                  po_number: po.po_number,
                  purchase_order_id: po.id,
                  expected_date: po.expected_date,
                  serialized: false,
                  price_book_item_id: line.price_book_item_id ?? null,
                  organization_id: orgId,
                })),
              },
            },
            include: stageInclude,
          });
          // Atomic claim: a concurrent staging of the same PO makes count 0 → rollback.
          const claim = await tx.purchaseOrder.updateMany({
            where: { id: po.id, staged_as_job_stage_id: null, ...tenantWhere(req) },
            data: { staged_as_job_stage_id: created.id },
          });
          if (claim.count === 0) throw new PoStageClaimError();
          return created;
        });
      } catch (err) {
        if (err instanceof PoStageClaimError) {
          res.status(409).json({ error: 'PO_ALREADY_STAGED' });
          return;
        }
        throw err;
      }

      void logAudit({
        req,
        action: 'inventory.stage_created',
        resourceType: 'JobStage',
        resourceId: stage.id,
        metadata: { job_number: body.jobNumber, item_count: po.lines.length, staged_from_po: po.po_number },
      });

      // Fresh creates carry no photos — signStagePhotoUrls short-circuits to an empty map.
      res.status(201).json({ jobStage: mapJobStage(stage, await signStagePhotoUrls([stage])) });
      return;
    }

    const skuMap = await resolveSkuMap(req, (body.items ?? []).map((l: any) => l.itemSku));

    // ─── Linkage-only PO attachment ────────────────────────────────────────
    // Unlike stagedFromPurchaseOrderId above, this keeps the operator's lines
    // exactly as submitted; only lines whose SKU is actually on the PO get
    // stamped, so an operator-added extra stays unlinked (and so never writes
    // through to a PO line that does not exist).
    let linkedPo: { id: string; po_number: string; staged_as_job_stage_id: string | null } | null = null;
    let linkedSkus = new Set<string>();
    if (body.linkedPurchaseOrderId) {
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: body.linkedPurchaseOrderId, ...tenantWhere(req) },
        select: {
          id: true, po_number: true, staged_as_job_stage_id: true,
          lines: { select: { item_sku: true } },
        },
      });
      if (!po) { res.status(400).json({ error: 'Invalid purchase order' }); return; }
      linkedPo = { id: po.id, po_number: po.po_number, staged_as_job_stage_id: po.staged_as_job_stage_id };
      linkedSkus = new Set(po.lines.map((l) => l.item_sku).filter(Boolean));
    }

    const stage = await prisma.jobStage.create({
      data: {
        job_id: body.jobId ?? null,
        customer_id: body.customerId ?? null,
        job_number: body.jobNumber,
        customer: body.customer,
        site: body.site,
        scheduled_for: body.scheduledFor ? new Date(body.scheduledFor) : null,
        assigned_tech_id: body.assignedTechId ?? null,
        assigned_tech: body.assignedTech ?? null,
        trade: body.trade,
        status: body.status,
        pickup_vendor_id: body.pickupVendorId ?? null,
        pickup_address: body.pickupAddress ?? null,
        staged_location_id: body.stagedLocationId ?? null,
        staged_area: body.stagedArea ?? null,
        notes: body.notes ?? null,
        organization_id: orgId,
        items:
          body.items && body.items.length > 0
            ? {
                create: body.items.map((line: any) => ({
                  item_sku: line.itemSku,
                  item_name: line.itemName,
                  uom: line.uom,
                  qty_ordered: line.qtyOrdered,
                  qty_received: line.qtyReceived,
                  unit_cost: line.unitCost ?? null,
                  vendor: line.vendor,
                  po_number: line.poNumber ?? (linkedSkus.has(line.itemSku) ? linkedPo!.po_number : null),
                  purchase_order_id: linkedSkus.has(line.itemSku) ? linkedPo!.id : null,
                  expected_date: line.expectedDate ? new Date(line.expectedDate) : null,
                  serialized: line.serialized ?? false,
                  received_serials: line.receivedSerials ?? undefined,
                  price_book_item_id: skuMap.get(line.itemSku) ?? null,
                  organization_id: orgId,
                })),
              }
            : undefined,
      },
      include: stageInclude,
    });

    // Point the PO back at this stage, but only when nothing has claimed it yet.
    // The null guard also settles the concurrent-create race: the loser's count
    // is 0 and it simply keeps its own line-level linkage. Unlike the
    // stagedFromPurchaseOrderId path this is NOT a dedup gate - staging the same
    // PO twice with different line edits is legitimate, so losing the claim is
    // not an error.
    if (linkedPo && linkedPo.staged_as_job_stage_id == null) {
      await prisma.purchaseOrder.updateMany({
        where: { id: linkedPo.id, staged_as_job_stage_id: null, ...tenantWhere(req) },
        data: { staged_as_job_stage_id: stage.id },
      });
    }

    void logAudit({
      req,
      action: 'inventory.stage_created',
      resourceType: 'JobStage',
      resourceId: stage.id,
      metadata: {
        job_number: body.jobNumber,
        item_count: (body.items ?? []).length,
        ...(linkedPo ? { linked_po: linkedPo.po_number } : {}),
      },
    });

    res.status(201).json({ jobStage: mapJobStage(stage, await signStagePhotoUrls([stage])) });
  } catch (err) {
    logger.error('Failed to create job stage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateJobStage(req: Request, res: Response) {
  try {
    const existing = await prisma.jobStage.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Job stage not found' });
      return;
    }

    const body = req.body;

    const fkError = await validateJobAndCustomer(req, body.jobId, body.customerId);
    if (fkError) { res.status(400).json({ error: fkError }); return; }

    const data: Record<string, unknown> = {};
    if (body.jobId !== undefined) data.job_id = body.jobId ?? null;
    if (body.customerId !== undefined) data.customer_id = body.customerId ?? null;
    if (body.jobNumber !== undefined) data.job_number = body.jobNumber;
    if (body.customer !== undefined) data.customer = body.customer;
    if (body.site !== undefined) data.site = body.site;
    if (body.scheduledFor !== undefined) data.scheduled_for = body.scheduledFor ? new Date(body.scheduledFor) : null;
    if (body.assignedTechId !== undefined) data.assigned_tech_id = body.assignedTechId ?? null;
    if (body.assignedTech !== undefined) data.assigned_tech = body.assignedTech ?? null;
    if (body.trade !== undefined) data.trade = body.trade;
    if (body.status !== undefined) data.status = body.status;
    if (body.pickupVendorId !== undefined) data.pickup_vendor_id = body.pickupVendorId ?? null;
    if (body.pickupAddress !== undefined) data.pickup_address = body.pickupAddress ?? null;
    if (body.stagedLocationId !== undefined) data.staged_location_id = body.stagedLocationId ?? null;
    if (body.stagedArea !== undefined) data.staged_area = body.stagedArea ?? null;
    if (body.notes !== undefined) data.notes = body.notes ?? null;

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const updateResult = await prisma.jobStage.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Job stage not found' });
      return;
    }

    const stage = await prisma.jobStage.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: stageInclude,
    });

    // inventory.staging_no_area — fire when status becomes complete or ready_for_pickup AND staged_area is null.
    if (stage) {
      emitStagingNoAreaIfNeeded(
        req.user!.organization_id,
        req.user!.id,
        stage.id,
        stage.job_number,
        stage.status,
        stage.staged_area ?? null,
      );
    }

    void logAudit({
      req,
      action: 'inventory.stage_updated',
      resourceType: 'JobStage',
      resourceId: req.params.id as string,
      metadata: { fields: Object.keys(req.body) },
    });

    res.json({ jobStage: mapJobStage(stage, await signStagePhotoUrls([stage])) });
  } catch (err) {
    logger.error('Failed to update job stage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Stage Receipt + Notify (B2/V5) — stock side-effects ONLY (DEC2) ────────

export const receiveStageSchema = z.object({
  stageId: z.string().uuid(),
  itemId: z.string().uuid(),     // JobStageLine.id (the dialog's "item" is the stage line)
  qty: z.number().min(0).optional(), // defaults to 1 (single-unit receive)
});

export async function receiveStageLine(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof receiveStageSchema>;
    const stage = await prisma.jobStage.findFirst({
      where: { id: body.stageId, ...tenantWhere(req) },
      include: { items: true },
    });
    if (!stage) { res.status(404).json({ error: 'Job stage not found' }); return; }
    const line = stage.items.find((l: any) => l.id === body.itemId);
    if (!line) { res.status(404).json({ error: 'Stage line not found' }); return; }

    const qty = body.qty ?? 1;
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    // §3.6: receive INTO the stage's own location; the DEC3 org default is the
    // fallback only when the stage has no staged_location.
    //
    // `staged_location_id` carries no foreign key (schema.prisma - the JobStage
    // model declares it as a bare `String? @db.Uuid`), so it can outlive the
    // location it names, and no write path validates it as this org's either.
    // Confirm it still resolves inside the tenant before crediting stock to it.
    // It deliberately does NOT fall back to the org default when it does not:
    // the operator chose a specific place for these parts, and quietly booking
    // them into a different warehouse would leave the stock record wrong with
    // nothing to show that it happened. Fail with something actionable instead.
    let destinationId: string | null;
    const stagedLocationId = (stage as any).staged_location_id as string | null;
    if (stagedLocationId) {
      const stagedLocation = await prisma.inventoryLocation.findFirst({
        where: { id: stagedLocationId, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!stagedLocation) {
        res.status(409).json({
          error: 'STAGED_LOCATION_MISSING',
          message:
            'The inventory location this stage was staged at no longer exists. Pick a staging location for the stage before receiving parts.',
        });
        return;
      }
      destinationId = stagedLocation.id;
    } else {
      destinationId = await resolveReceiveLocationId(req);
    }

    // applyStockMovement only credits a stock level when it has a destination
    // (inv-stock.controller §254), so receiving with none resolvable used to log
    // a ledger row and move no stock at all - silently, with a 200. Fail loudly:
    // an org with no inventory location configured has nowhere to put the parts.
    if (!destinationId) {
      res.status(400).json({
        error: 'NO_STOCK_LOCATION',
        message:
          'No inventory location is configured for this organization. Add a location (or set the default receiving location in Settings) before receiving parts.',
      });
      return;
    }

    // P2 4e write-through: a PO-linked stage line mirrors its receipt into the PO
    // line (match purchase_order_id + item_sku — stage lines carry no PO-line FK).
    // Over-receive is guarded against the PO line's qty_ordered BEFORE any write.
    const newAbsolute = Number(line.qty_received) + qty;
    let poLine: any = null;
    if ((line as any).purchase_order_id) {
      poLine = await prisma.purchaseOrderLine.findFirst({
        where: { purchase_order_id: (line as any).purchase_order_id, item_sku: line.item_sku, ...tenantWhere(req) },
        include: { purchase_order: { select: { id: true, status: true, po_number: true, ordered_at: true, received_at: true } } },
      });
      if (poLine && newAbsolute > Number(poLine.qty_ordered)) {
        res.status(400).json({
          error: 'OVER_RECEIVE',
          item_sku: line.item_sku,
          qty_ordered: Number(poLine.qty_ordered),
          qty_received: newAbsolute,
        });
        return;
      }
    }

    let poStatusAfter: string | null = null;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.jobStageLine.update({
        where: { id: line.id },
        data: { qty_received: { increment: qty } },
      });
      await applyStockMovement(tx, {
        orgId, type: 'receive',
        itemSku: line.item_sku, itemName: line.item_name,
        qty, itemId: (line as any).price_book_item_id ?? null,
        jobId: stage.job_id ?? null,
        unitCost: line.unit_cost != null ? Number(line.unit_cost) : null,
        actorUserId: req.user!.id,
        toLocationId: destinationId,
        // Ledger reconciliation (I-1/I-2): linked lines reference their PO, manual
        // lines keep the job reference.
        reference: (line as any).purchase_order_id
          ? ((line as any).po_number ?? stage.job_number)
          : stage.job_number,
        actor,
      });
      if (poLine) {
        // Absolute write-through (stage line and PO line stay in lockstep), then
        // the SHARED status recompute so PO/stage status math cannot drift.
        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: { qty_received: newAbsolute },
        });
        poStatusAfter = await recomputePoStatus(tx, poLine.purchase_order);
      }
      // DEC2: NO billing. Stage receipt records stock + cost roll-up only — never a JobCharge.
      return tx.jobStage.findFirst({ where: { id: stage.id }, include: stageInclude });
    });

    // inventory.po_partial — parity with the PO receive path; post-tx, fire-and-forget.
    if (poLine && poStatusAfter === 'partial') {
      emitPoPartial(orgId, req.user!.id, poLine.purchase_order.id, poLine.purchase_order.po_number);
    }

    void logAudit({
      req,
      action: 'inventory.stage_line_received',
      resourceType: 'JobStage',
      resourceId: body.stageId,
      metadata: { stage_line_id: body.itemId, qty: body.qty ?? 1 },
    });

    res.json({ jobStage: mapJobStage(updated, await signStagePhotoUrls([updated])) });
  } catch (err) {
    logger.error('Failed to receive stage line:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const notifyStageSchema = z.object({ stageId: z.string().uuid() });

export async function notifyTechReady(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof notifyStageSchema>;
    const result = await prisma.jobStage.updateMany({
      where: { id: body.stageId, ...tenantWhere(req) },
      data: { status: 'ready_for_pickup' },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Job stage not found' }); return; }
    const stage = await prisma.jobStage.findFirst({ where: { id: body.stageId, ...tenantWhere(req) }, include: stageInclude });
    logger.info(`Job stage ${body.stageId} marked ready_for_pickup (org ${orgId})`);

    // inventory.staging_ready — fire after status set to ready_for_pickup; fire-and-forget.
    // Pass the assigned tech so they get the in-app alert too (not just Admin/Dispatcher).
    emitStagingReady(orgId, req.user!.id, body.stageId, stage?.job_number ?? body.stageId, stage?.assigned_tech_id ?? null);

    // inventory.staging_no_area — fire if ready_for_pickup AND staged_area is null.
    emitStagingNoAreaIfNeeded(
      orgId,
      req.user!.id,
      body.stageId,
      stage?.job_number ?? body.stageId,
      'ready_for_pickup',
      stage?.staged_area ?? null,
    );

    void logAudit({
      req,
      action: 'inventory.stage_ready_notified',
      resourceType: 'JobStage',
      resourceId: body.stageId,
      metadata: { job_number: stage?.job_number ?? null },
    });

    res.json({ jobStage: mapJobStage(stage, await signStagePhotoUrls([stage])) });
  } catch (err) {
    logger.error('Failed to notify tech ready:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const emailStageSchema = z.object({
  stageId: z.string().uuid(),
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().min(1, 'Subject is required').max(300),
  message: z.string().max(5000).optional(),
});

// POST /api/inventory/job-stages/email — send the pickup ticket for real
// (Resend via dispatchEmail; the composer's optimistic-toast fake is retired).
// Records the send on the stage's own audit ledger so it shows in stage history.
export async function emailJobStage(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof emailStageSchema>;

    const stage = await prisma.jobStage.findFirst({
      where: { id: body.stageId, ...tenantWhere(req) },
      include: stageInclude,
    });
    if (!stage) { res.status(404).json({ error: 'Job stage not found' }); return; }

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, logo_url: true, brand_color: true },
    });

    const lines = (stage.items ?? []).map((i: any) => ({
      sku: i.item_sku,
      name: i.item_name,
      qtyReceived: Number(i.qty_received),
      qtyOrdered: Number(i.qty_ordered),
      uom: i.uom,
    }));

    const result = await sendStagePickupEmail({
      organizationId: orgId,
      org: {
        id: org?.id ?? orgId,
        name: org?.name ?? 'ServWave',
        logo_url: org?.logo_url ?? null,
        brand_color: org?.brand_color ?? '#0C2D3A',
      },
      to: body.to,
      cc: body.cc,
      subject: body.subject,
      message: body.message,
      jobNumber: stage.job_number,
      customer: stage.customer,
      site: stage.site,
      scheduledFor: stage.scheduled_for ? stage.scheduled_for.toISOString() : null,
      timezone: await getOrgTimezone(orgId),
      notes: stage.notes ?? null,
      lines,
      // Job-scoped, NOT customer-scoped: a pickup ticket goes to the tech or a
      // pickup contact, so putting it on the customer's timeline would show the
      // customer a message that was never addressed to them.
      record: {
        organizationId: orgId,
        jobId: stage.job_id,
        jobLabel: stage.job_number,
      },
    });

    if (result.status !== 'sent') {
      // A send the org's own kill switch skipped is not a gateway failure. This
      // answered 502 for it, telling the user to retry something that cannot
      // succeed until they turn email back on. The 409-vs-502 classification is
      // shared with the PO sender; only the wording is local.
      const message =
        result.status === 'failed'
          ? result.error
          : result.reason === 'org_disabled'
            ? 'Email sending is disabled for your organization. The pickup ticket was not sent.'
            : 'Email is not configured, so the pickup ticket was not sent.';
      res.status(dispatchFailureStatus(result)).json({ error: message });
      return;
    }

    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    // Record the send on the stage's own audit ledger (surfaces in stage history).
    try {
      await prisma.stageAuditEntry.create({
        data: {
          job_stage_id: stage.id,
          organization_id: orgId,
          at: new Date(),
          actor_name: actor,
          field: 'pickup_email',
          new_value: body.to.join(', '),
          comment: body.subject,
        },
      });
    } catch (e) {
      // Best-effort: the email already sent — a ledger write failure must not 500.
      logger.warn('Failed to write stage pickup-email audit entry', e);
    }

    void logAudit({
      req,
      action: 'inventory.stage_pickup_emailed',
      resourceType: 'JobStage',
      resourceId: stage.id,
      metadata: { job_number: stage.job_number, recipients: body.to.length },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to email job stage pickup ticket:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Stage attachments — upload / delete (P5 §5.2) ──────────────────────────
// First real persistence path for JobStageAttachment (the FE "upload" was
// mock-era local state). Modeled on attachment.controller.ts's uploadAttachment.

export async function uploadStageAttachment(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    // 1. Tenancy: the stage must exist in the requester's org.
    const stage = await prisma.jobStage.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!stage) {
      res.status(404).json({ error: 'Job stage not found' });
      return;
    }

    // 2. File part required.
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // 3. MIME allowlist — images/videos only (PDFs are rasterized client-side).
    if (!STAGE_ALLOWED_MIMES.includes(file.mimetype)) {
      res.status(400).json({ error: 'File type not allowed. Accepted: JPG, PNG, HEIC, MP4, MOV' });
      return;
    }

    // Magic-byte sniff — never trust the client-supplied Content-Type alone (F-35).
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, STAGE_ALLOWED_MIMES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }

    // 4. Per-kind size caps (match StageDetailDialog's client caps).
    const isVideo = file.mimetype.startsWith('video/');
    if (file.size > (isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) {
      res.status(400).json({ error: `File too large. Maximum: ${isVideo ? '100MB' : '8MB'}` });
      return;
    }

    // 5. Lenient multipart-text metadata — bad values are dropped, never 400.
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.slice(0, max) : null;
    const int = (v: unknown): number | null => {
      if (v == null || v === '') return null;
      const n = parseInt(String(v), 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const source =
      typeof b.source === 'string' && ['camera', 'upload', 'pdf-page'].includes(b.source) ? b.source : null;

    // 6. Storage upload — OUTSIDE any $transaction (5s tx timeout learning) and
    // BEFORE the row insert: an orphaned Storage object on a later DB failure is
    // acceptable; a DB row without its object is not. Filename sanitized like
    // attachment.controller.ts; keys namespaced org-first for isolation.
    const safeName =
      (file.originalname ?? 'file').replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
    const storagePath = `${orgId}/job_stage/${stage.id}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) {
      logger.error('Supabase storage upload error (stage attachment):', uploadError);
      res.status(500).json({ error: 'Failed to upload file' });
      return;
    }

    // 7. Persist — data_url:'' mirrors the Attachment pattern's file_url:'';
    // storage_path is canonical, read paths re-mint signed URLs from it.
    const actorName = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    const row = await prisma.jobStageAttachment.create({
      data: {
        job_stage_id: stage.id,
        kind: isVideo ? 'video' : 'image',
        data_url: '',
        storage_path: storagePath,
        mime_type: file.mimetype,
        caption: text(b.caption, 500),
        uploaded_at: new Date(),
        uploaded_by: actorName,
        source,
        pdf_page_number: int(b.pdfPageNumber),
        pdf_file_name: text(b.pdfFileName, 300),
        duration_seconds: int(b.durationSeconds),
        size_bytes: file.size,
        po_number: text(b.poNumber, 100),
        organization_id: orgId,
      },
    });

    void logAudit({
      req,
      action: 'inventory.stage_attachment_uploaded',
      resourceType: 'JobStage',
      resourceId: stage.id,
      metadata: { attachment_id: row.id, kind: row.kind, size_bytes: file.size },
    });

    // 8. Respond with a freshly-minted signed URL (never the raw path).
    const signed = await signStagePhotoUrls([{ photos: [row] }]);
    res.status(201).json({ attachment: mapAttachment(row, signed) });
  } catch (err) {
    logger.error('Failed to upload stage attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteStageAttachment(req: Request, res: Response) {
  try {
    const existing = await prisma.jobStageAttachment.findFirst({
      where: {
        id: req.params.attachmentId as string,
        job_stage_id: req.params.id as string,
        ...tenantWhere(req),
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    // Best-effort SDK remove — the sanctioned Storage-delete path (never SQL
    // DELETE on storage.objects). A failure leaves an orphaned object, not a
    // broken row: log-warn and continue.
    if (existing.storage_path) {
      try {
        const { error: removeError } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .remove([existing.storage_path]);
        if (removeError) logger.warn(`Failed to remove storage object ${existing.storage_path}:`, removeError);
      } catch (removeErr) {
        logger.warn(`Failed to remove storage object ${existing.storage_path}:`, removeErr);
      }
    }

    await prisma.jobStageAttachment.delete({ where: { id: existing.id } });

    void logAudit({
      req,
      action: 'inventory.stage_attachment_deleted',
      resourceType: 'JobStage',
      resourceId: req.params.id as string,
      metadata: { attachment_id: existing.id, ...(existing.storage_path ? { storage_path: existing.storage_path } : {}) },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete stage attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
