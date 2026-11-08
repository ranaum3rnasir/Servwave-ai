import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import { parsePagination, parseSortParams, buildPaginationMeta, respondInvalidSort } from '../lib/pagination';
import { ASSET_SORT_FIELDS } from '../lib/sortFields';

// ─── Constants ───────────────────────────────────────────

// Asset photos are tenant entity data → the same private bucket + signed-URL
// conventions as the Attachment pattern (NOT the public org-assets branding
// bucket, and never data-URIs).
const STORAGE_BUCKET = 'attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — short-lived per-read URLs
const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'];
// Exported so inv-assets.routes.ts builds its too-large message from this same number.
export const MAX_PHOTO_SIZE = 25 * 1024 * 1024; // 25MB (multer caps too; explicit check kept)

// ─── Zod Schemas ─────────────────────────────────────────

export const createAssetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  serial: z.string().max(120).nullable().optional(),
  price_book_item_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// status + assigned_user_id are NOT patchable — they move only through the action verbs.
export const updateAssetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  serial: z.string().max(120).nullable().optional(),
  price_book_item_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const assignAssetSchema = z.object({ user_id: z.string().uuid(), note: z.string().max(2000).optional() });
export const returnAssetSchema = z.object({ note: z.string().max(2000).optional() });
export const transferAssetSchema = z.object({ user_id: z.string().uuid(), note: z.string().max(2000).optional() });
export const retireAssetSchema = z.object({ note: z.string().max(2000).optional() });
export const noteAssetSchema = z.object({ note: z.string().min(1).max(2000) });

// ─── Serializers ─────────────────────────────────────────

const assetInclude = {
  assigned_user: { select: { id: true, first_name: true, last_name: true } },
  price_book_item: { select: { id: true, name: true } },
};

/**
 * Mint a fresh short-lived signed URL from the canonical storage path.
 * The DB never stores signed/public URLs — only the path.
 */
async function buildPhotoUrl(storagePath: string | null): Promise<string | null> {
  if (!storagePath) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    logger.warn(`Failed to mint signed URL for asset photo ${storagePath}`);
    return null;
  }
  return data.signedUrl;
}

async function mapAsset(row: any) {
  return {
    id: row.id,
    name: row.name,
    serial: row.serial ?? null,
    status: row.status,
    notes: row.notes ?? null,
    photo_url: await buildPhotoUrl(row.photo_url ?? null),
    price_book_item: row.price_book_item
      ? { id: row.price_book_item.id, name: row.price_book_item.name }
      : null,
    assigned_user: row.assigned_user
      ? { id: row.assigned_user.id, first_name: row.assigned_user.first_name, last_name: row.assigned_user.last_name }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapEvent(row: any) {
  return {
    id: row.id,
    type: row.type,
    note: row.note ?? null,
    at: row.at,
    user: row.user ?? null,
    by_user: row.by_user ?? null,
  };
}

async function readAsset(req: Request, id: string) {
  return prisma.asset.findFirst({
    where: { id, ...tenantWhere(req) },
    include: assetInclude,
  });
}

// ─── CRUD Handlers ───────────────────────────────────────

export async function listAssets(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, ASSET_SORT_FIELDS, 'updated_at', 'desc');
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const where: any = { ...tenantWhere(req) };

    // Enum-guarded: invalid values are ignored rather than erroring.
    if (req.query.status === 'ACTIVE' || req.query.status === 'RETIRED') {
      where.status = req.query.status;
    }

    if (req.query.assigned_user_id && typeof req.query.assigned_user_id === 'string') {
      where.assigned_user_id = req.query.assigned_user_id;
    }

    if (req.query.search) {
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { serial: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.asset.findMany({ where, skip, take: limit, orderBy, include: assetInclude }),
      prisma.asset.count({ where }),
    ]);

    res.json({
      // Per-row async map: signed-URL minting is per photo path.
      data: await Promise.all(rows.map(mapAsset)),
      meta: buildPaginationMeta(total, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('Failed to list assets:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getAsset(req: Request, res: Response) {
  try {
    const asset = await readAsset(req, req.params.id as string);
    if (!asset) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }
    res.json({ asset: await mapAsset(asset) });
  } catch (err) {
    logger.error('Failed to get asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createAsset(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    if (req.body.price_book_item_id) {
      const item = await prisma.priceBookItem.findFirst({
        where: { id: req.body.price_book_item_id, ...tenantWhere(req) },
      });
      if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }
    }

    const asset = await prisma.asset.create({
      data: {
        name: req.body.name,
        serial: req.body.serial ?? null,
        price_book_item_id: req.body.price_book_item_id ?? null,
        notes: req.body.notes ?? null,
        organization_id: orgId,
      },
      include: assetInclude,
    });

    // No AssetEvent on create — the enum has no CREATED type; history begins
    // with the first lifecycle verb.
    void logAudit({
      req,
      action: 'inventory.asset_created',
      resourceType: 'Asset',
      resourceId: asset.id,
      metadata: { name: asset.name, serial: asset.serial },
    });

    res.status(201).json({ asset: await mapAsset(asset) });
  } catch (err) {
    logger.error('Failed to create asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateAsset(req: Request, res: Response) {
  try {
    if (req.body.price_book_item_id) {
      const item = await prisma.priceBookItem.findFirst({
        where: { id: req.body.price_book_item_id, ...tenantWhere(req) },
      });
      if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }
    }

    const data: Record<string, unknown> = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.serial !== undefined) data.serial = req.body.serial;
    if (req.body.price_book_item_id !== undefined) data.price_book_item_id = req.body.price_book_item_id;
    if (req.body.notes !== undefined) data.notes = req.body.notes;

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const updateResult = await prisma.asset.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }
    const asset = await readAsset(req, req.params.id as string);

    void logAudit({
      req,
      action: 'inventory.asset_updated',
      resourceType: 'Asset',
      resourceId: req.params.id as string,
      metadata: { fields: Object.keys(req.body) },
    });

    res.json({ asset: await mapAsset(asset) });
  } catch (err) {
    logger.error('Failed to update asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteAsset(req: Request, res: Response) {
  try {
    // findFirst (not just deleteMany) — we need photo_url for storage cleanup.
    const existing = await prisma.asset.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    // deleteMany with id+org filter is atomic; events cascade via FK.
    const result = await prisma.asset.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    // Best-effort storage cleanup AFTER the DB delete — warn-only on failure.
    if (existing.photo_url) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .remove([existing.photo_url]);
      if (removeError) {
        logger.warn(`Failed to delete asset photo from storage (continuing): ${removeError.message}`);
      }
    }

    void logAudit({
      req,
      action: 'inventory.asset_deleted',
      resourceType: 'Asset',
      resourceId: req.params.id as string,
      metadata: { name: existing.name, serial: existing.serial },
    });

    res.json({ message: 'Asset deleted' });
  } catch (err) {
    logger.error('Failed to delete asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function listAssetEvents(req: Request, res: Response) {
  try {
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (!asset) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    // Bounded per-tool history — no pagination needed v1; keep orderBy stable.
    const events = await prisma.assetEvent.findMany({
      where: { asset_id: asset.id, ...tenantWhere(req) },
      orderBy: { at: 'desc' },
      include: {
        user: { select: { id: true, first_name: true, last_name: true } },
        by_user: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    res.json({ events: events.map(mapEvent) });
  } catch (err) {
    logger.error('Failed to list asset events:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Lifecycle Verbs ─────────────────────────────────────
// Each verb writes its AssetEvent in the SAME transaction as the asset
// mutation, re-asserting the state guard inside the tx where-clause so a
// concurrent verb can't double-fire. logAudit only after the tx commits.

/** Raced state change inside the tx (updateMany matched 0 rows). */
class StateConflictError extends Error {}

interface VerbEvent {
  type: 'ASSIGNED' | 'RETURNED' | 'TRANSFERRED' | 'RETIRED';
  user_id: string | null;
  note: string | null;
}

async function commitVerb(
  req: Request,
  assetId: string,
  stateGuard: Record<string, unknown>,
  data: Record<string, unknown>,
  event: VerbEvent,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const result = await tx.asset.updateMany({
      where: { id: assetId, ...tenantWhere(req), ...stateGuard },
      data,
    });
    if (result.count === 0) throw new StateConflictError();
    await tx.assetEvent.create({
      data: {
        asset_id: assetId,
        type: event.type,
        user_id: event.user_id,
        by_user_id: req.user!.id,
        note: event.note,
        organization_id: req.user!.organization_id,
      },
    });
  });
}

function sendStateConflict(res: Response) {
  res.status(409).json({ error: 'Asset state changed — reload and retry', code: 'STATE_CONFLICT' });
}

/** Org-scoped target-user check shared by assign/transfer. Returns null after responding. */
async function loadTargetUser(req: Request, res: Response) {
  const target = await prisma.user.findFirst({
    where: { id: req.body.user_id, ...tenantWhere(req) },
  });
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  if (target.is_active === false) {
    res.status(400).json({ error: 'Cannot assign to an inactive user' });
    return null;
  }
  return target;
}

export async function assignAsset(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    if (!(await loadTargetUser(req, res))) return;

    if (existing.status === 'RETIRED') {
      res.status(409).json({ error: 'Asset is retired', code: 'ASSET_RETIRED' });
      return;
    }
    if (existing.assigned_user_id !== null) {
      res.status(409).json({ error: 'Asset is already assigned — use transfer', code: 'ALREADY_ASSIGNED' });
      return;
    }

    try {
      await commitVerb(
        req,
        id,
        { status: 'ACTIVE', assigned_user_id: null },
        { assigned_user_id: req.body.user_id },
        { type: 'ASSIGNED', user_id: req.body.user_id, note: req.body.note ?? null },
      );
    } catch (err) {
      if (err instanceof StateConflictError) {
        sendStateConflict(res);
        return;
      }
      throw err;
    }

    void logAudit({
      req,
      action: 'inventory.asset_assigned',
      resourceType: 'Asset',
      resourceId: id,
      metadata: { user_id: req.body.user_id },
    });

    res.json({ asset: await mapAsset(await readAsset(req, id)) });
  } catch (err) {
    logger.error('Failed to assign asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function returnAsset(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    if (existing.assigned_user_id === null) {
      res.status(409).json({ error: 'Asset is not assigned', code: 'NOT_ASSIGNED' });
      return;
    }

    try {
      await commitVerb(
        req,
        id,
        { assigned_user_id: existing.assigned_user_id },
        { assigned_user_id: null },
        // RETURNED records who gave it back.
        { type: 'RETURNED', user_id: existing.assigned_user_id, note: req.body.note ?? null },
      );
    } catch (err) {
      if (err instanceof StateConflictError) {
        sendStateConflict(res);
        return;
      }
      throw err;
    }

    void logAudit({
      req,
      action: 'inventory.asset_returned',
      resourceType: 'Asset',
      resourceId: id,
      metadata: { user_id: existing.assigned_user_id },
    });

    res.json({ asset: await mapAsset(await readAsset(req, id)) });
  } catch (err) {
    logger.error('Failed to return asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function transferAsset(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    if (!(await loadTargetUser(req, res))) return;

    if (existing.status === 'RETIRED') {
      res.status(409).json({ error: 'Asset is retired', code: 'ASSET_RETIRED' });
      return;
    }
    if (existing.assigned_user_id === null) {
      res.status(409).json({ error: 'Asset is not assigned — use assign', code: 'NOT_ASSIGNED' });
      return;
    }
    if (req.body.user_id === existing.assigned_user_id) {
      res.status(400).json({ error: 'Asset is already held by this user' });
      return;
    }

    try {
      await commitVerb(
        req,
        id,
        { assigned_user_id: existing.assigned_user_id },
        { assigned_user_id: req.body.user_id },
        // TRANSFERRED carries the NEW holder; from-holder lives in the audit metadata.
        { type: 'TRANSFERRED', user_id: req.body.user_id, note: req.body.note ?? null },
      );
    } catch (err) {
      if (err instanceof StateConflictError) {
        sendStateConflict(res);
        return;
      }
      throw err;
    }

    void logAudit({
      req,
      action: 'inventory.asset_transferred',
      resourceType: 'Asset',
      resourceId: id,
      metadata: { from_user_id: existing.assigned_user_id, to_user_id: req.body.user_id },
    });

    res.json({ asset: await mapAsset(await readAsset(req, id)) });
  } catch (err) {
    logger.error('Failed to transfer asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function retireAsset(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    if (existing.status === 'RETIRED') {
      res.status(409).json({ error: 'Asset is already retired', code: 'ALREADY_RETIRED' });
      return;
    }

    try {
      // Allowed while assigned (a tool can break in the field) — the same tx
      // clears the holder. No un-retire verb in v1.
      await commitVerb(
        req,
        id,
        { status: 'ACTIVE' },
        { status: 'RETIRED', assigned_user_id: null },
        { type: 'RETIRED', user_id: existing.assigned_user_id, note: req.body.note ?? null },
      );
    } catch (err) {
      if (err instanceof StateConflictError) {
        sendStateConflict(res);
        return;
      }
      throw err;
    }

    void logAudit({
      req,
      action: 'inventory.asset_retired',
      resourceType: 'Asset',
      resourceId: id,
      metadata: { holder_user_id: existing.assigned_user_id },
    });

    res.json({ asset: await mapAsset(await readAsset(req, id)) });
  } catch (err) {
    logger.error('Failed to retire asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function noteAsset(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    // No state change — a bare append to the ledger (allowed on RETIRED too).
    await prisma.assetEvent.create({
      data: {
        asset_id: id,
        type: 'NOTE',
        user_id: null,
        by_user_id: req.user!.id,
        note: req.body.note,
        organization_id: req.user!.organization_id,
      },
    });

    void logAudit({
      req,
      action: 'inventory.asset_note_added',
      resourceType: 'Asset',
      resourceId: id,
    });

    res.json({ asset: await mapAsset(await readAsset(req, id)) });
  } catch (err) {
    logger.error('Failed to add asset note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Photo Upload (Attachment pattern, exactly) ──────────
// All of this runs OUTSIDE any $transaction (never mix Storage upload in a DB
// transaction). Route order puts withOrgContext AFTER multer (ALS learning).

export async function uploadAssetPhoto(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    // Also fetches the old photo_url path for post-upload cleanup.
    const existing = await prisma.asset.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Images only.
    if (!PHOTO_MIME_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: 'File type not allowed. Accepted: JPG, PNG, HEIC' });
      return;
    }

    // Magic-byte content sniff — never trust the client-supplied header (F-35).
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, PHOTO_MIME_TYPES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }

    if (file.size > MAX_PHOTO_SIZE) {
      res.status(400).json({ error: 'File too large. Maximum: 25MB' });
      return;
    }

    // Org-namespaced key with the same filename sanitizer as attachments:
    // strip path components, allow only [A-Za-z0-9._-], cap length.
    const orgId = req.user!.organization_id;
    const safeName = file.originalname
      .replace(/^.*[\\/]/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'file';
    const storagePath = `${orgId}/asset/${id}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      logger.error('Supabase storage upload error (asset photo):', uploadError);
      // No DB write — never leave a dangling pointer.
      res.status(500).json({ error: 'Failed to upload file' });
      return;
    }

    // Persist the canonical PATH, never the (1h-expiring) signed URL.
    await prisma.asset.updateMany({
      where: { id, ...tenantWhere(req) },
      data: { photo_url: storagePath },
    });

    // Best-effort removal of the replaced object — warn-only.
    if (existing.photo_url && existing.photo_url !== storagePath) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .remove([existing.photo_url]);
      if (removeError) {
        logger.warn(`Failed to delete old asset photo (continuing): ${removeError.message}`);
      }
    }

    void logAudit({
      req,
      action: 'inventory.asset_photo_uploaded',
      resourceType: 'Asset',
      resourceId: id,
      metadata: { file_type: file.mimetype, file_size: file.size },
    });

    res.json({ asset: await mapAsset(await readAsset(req, id)) });
  } catch (err) {
    logger.error('Failed to upload asset photo:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
