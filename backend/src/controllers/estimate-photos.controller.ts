/**
 * Estimate line-item + scope-of-work photos (R5f, 2026-07-22).
 *
 * Mirrors inv-stages.controller.ts's stage-attachment upload/delete flow exactly (Supabase
 * Storage `attachments` bucket, magic-byte sniff, Storage upload BEFORE the DB insert and OUTSIDE
 * any `$transaction`, one batched `createSignedUrls` call per response, best-effort Storage
 * `remove` on delete) — this file is the estimate-scoped analogue for a plain image-only
 * allowlist (no video kind here).
 *
 * Gating reuses estimate-lines.controller.ts's `loadGuardedEstimate` / `isMutationBlocked`
 * verbatim: the SAME 404 (missing/cross-org estimate) + 403 (per-instance ownership) + 400
 * (frozen/locked estimate) gate every other line/scope mutation route already applies. Photos are
 * NOT part of calculateTotals() — unlike a line item or scope's flat_price, a photo carries no
 * price — so unlike estimate-lines.controller.ts's handlers, these never recompute/persist
 * totals and never run inside a `$transaction`.
 *
 * `EstimateScopePhoto` lookups are ALWAYS keyed on the COMPOUND (estimate_id, scope_id) — never
 * scope_id alone. Estimate.scopes is a raw JSONB array with no relational row per scope block, and
 * duplicate()/revise() copy `scopes` verbatim INCLUDING each block's id, so the same scope id can
 * legitimately exist in two different estimates' scopes[] at once (scopes.ts / schema.prisma
 * header comments). Scope routes resolve `:scopeId` against the estimate's CURRENT scopes[] by id
 * (never array index — unlike the existing PATCH/DELETE .../scopes/:idx routes, whose index-based
 * identity is not stable enough for a photo sub-resource).
 */
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import { asScopeArray } from '../lib/scopes';
import { loadGuardedEstimate, isMutationBlocked } from './estimate-lines.controller';

const STORAGE_BUCKET = 'attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h — same TTL as inv-stages.controller.ts / attachment.controller.ts

// Image-only allowlist — mirrors JobStageAttachment's STAGE_IMAGE_MIMES/MAX_IMAGE_BYTES exactly
// (inv-stages.controller.ts). Duplicated rather than imported to avoid a cross-controller
// coupling — same rationale as that file's own resolveSkuMap/resolveReceiveLocationId comments.
// #2029 — JPEG and PNG only. The client converts every pick (including HEIC) to JPEG before it
// uploads, and the server's image library cannot decode HEIC pixels at all: sharp's prebuilt
// binary is compiled without the HEVC codec. A HEIC that reached storage would therefore be a
// photo no PDF could ever render, so the endpoint refuses one — the invariant holds even if a
// client bypasses conversion.
//
// Exported (#2045): price-book-image.controller.ts's narrow "fill if empty" endpoint reuses this
// EXACT list rather than declaring a parallel one that could drift — same convention as
// attachment.controller.ts's own exported allowlist (see that file's header comment). Sharing the
// list is what keeps that endpoint inside the invariant above: #2029 puts the price-book item's
// image on the PDF as well (estimate-document.ts selects `price_book_item.image_url`), and pdfmake
// throws on anything that is not JPEG or PNG — so a HEIC filled in through THAT route would break
// the whole document, not merely its own thumbnail.
export const ESTIMATE_PHOTO_MIMES = ['image/jpeg', 'image/png'];

/**
 * The hard cap on photos per ESTIMATE, across all its scope blocks, so a document cannot become
 * unusable to send or open. Counted per estimate rather than per scope so deleting a photo from
 * any block frees a slot. A starting value, not a deep principle.
 */
export const ESTIMATE_PHOTO_CAP = 24;

/**
 * Where the client starts warning. Well before the cap, so a salesperson mid-walkthrough finds
 * out with room to act rather than at the moment an upload is refused.
 */
export const ESTIMATE_PHOTO_WARN_AT = 16;
export const MAX_ESTIMATE_PHOTO_BYTES = 8 * 1024 * 1024;

export function safeFileName(name: string | undefined): string {
  return (name ?? 'file').replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}

/** Batch-sign a list of storage_paths in ONE createSignedUrls call — never one call per photo. */
async function signPaths(paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      logger.warn('Failed to sign estimate photo URL(s); photo will render with an empty url this response', error ?? '');
      return new Map();
    }
    const map = new Map<string, string>();
    for (const row of data) {
      if (row?.path && row?.signedUrl) map.set(row.path, row.signedUrl);
    }
    return map;
  } catch (err) {
    logger.warn('Failed to sign estimate photo URL(s); photo will render with an empty url this response', err);
    return new Map();
  }
}

function mapPhotoResponse(photo: {
  id: string;
  storage_path: string;
  mime_type: string;
  caption: string | null;
  uploaded_at: Date;
  uploaded_by: string;
  size_bytes: number | null;
}, signed: Map<string, string>) {
  return {
    id: photo.id,
    url: signed.get(photo.storage_path) ?? '',
    mime_type: photo.mime_type,
    caption: photo.caption ?? undefined,
    uploaded_at: photo.uploaded_at.toISOString(),
    uploaded_by: photo.uploaded_by,
    size_bytes: photo.size_bytes ?? undefined,
  };
}

/** Shared validate-and-persist body for both upload handlers. Returns null (having already
 * written the error response) on any rejection, or the created row + its response payload. */
async function handlePhotoUpload(
  req: Request,
  res: Response,
  storagePathPrefix: string,
): Promise<{ storagePath: string; caption: string | null } | null> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'No file provided' });
    return null;
  }

  if (!ESTIMATE_PHOTO_MIMES.includes(file.mimetype)) {
    res.status(400).json({ error: 'File type not allowed. Accepted: JPG, PNG' });
    return null;
  }

  // Magic-byte sniff — never trust the client-supplied Content-Type alone (F-35).
  if (!sniffMatchesDeclared(file.buffer, file.mimetype, ESTIMATE_PHOTO_MIMES)) {
    res.status(400).json({ error: 'File content does not match its declared type' });
    return null;
  }

  if (file.size > MAX_ESTIMATE_PHOTO_BYTES) {
    res.status(400).json({ error: 'File too large. Maximum: 8MB' });
    return null;
  }

  const safeName = safeFileName(file.originalname);
  const storagePath = `${storagePathPrefix}/${Date.now()}-${safeName}`;

  // Storage upload BEFORE the DB insert, OUTSIDE any $transaction — an orphaned Storage object on
  // a later DB failure is acceptable; a DB row without its object is not (same rationale as
  // inv-stages.controller.ts's uploadStageAttachment).
  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
  if (uploadError) {
    logger.error('Supabase storage upload error (estimate photo):', uploadError);
    res.status(500).json({ error: 'Failed to upload file' });
    return null;
  }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const caption =
    typeof b.caption === 'string' && b.caption.trim().length > 0 ? b.caption.slice(0, 500) : null;

  return { storagePath, caption };
}

function actorName(req: Request): string {
  return `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
}

// ─── Scope-of-work photos ────────────────────────────────────────────────────

// POST /api/estimates/:id/scopes/:scopeId/photos
export async function uploadScopePhoto(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    if (isMutationBlocked(estimate, res)) return;

    const scopeId = req.params.scopeId as string;
    const scope = asScopeArray(estimate.scopes).find((s) => s.id === scopeId);
    if (!scope) {
      res.status(404).json({ error: 'Scope not found' });
      return;
    }

    // The cap is per ESTIMATE, across every scope block — checked before the Storage upload so a
    // refused photo never leaves an orphaned object behind.
    const photoCount = await prisma.estimateScopePhoto.count({ where: { estimate_id: estimate.id } });
    if (photoCount >= ESTIMATE_PHOTO_CAP) {
      res.status(400).json({
        error: `This estimate already has the maximum of ${ESTIMATE_PHOTO_CAP} photos. Delete one to add another.`,
      });
      return;
    }

    const uploaded = await handlePhotoUpload(req, res, `${orgId}/estimate_scope/${estimate.id}/${scopeId}`);
    if (!uploaded) return;

    const row = await prisma.estimateScopePhoto.create({
      data: {
        estimate_id: estimate.id,
        scope_id: scopeId,
        storage_path: uploaded.storagePath,
        mime_type: req.file!.mimetype,
        caption: uploaded.caption,
        uploaded_at: new Date(),
        uploaded_by: actorName(req),
        size_bytes: req.file!.size,
        organization_id: orgId,
      },
    });

    void logAudit({
      req,
      action: 'estimate.scope_photo_uploaded',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { scope_id: scopeId, photo_id: row.id, size_bytes: req.file!.size },
    });

    const signed = await signPaths([uploaded.storagePath]);
    // The running count and the cap travel with the response so the client can warn on approach
    // without a second round-trip, and without keeping its own tally that could drift.
    res.status(201).json({
      photo: mapPhotoResponse(row, signed),
      photo_count: photoCount + 1,
      photo_cap: ESTIMATE_PHOTO_CAP,
    });
  } catch (err) {
    logger.error('Failed to upload estimate scope photo:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/estimates/:id/scopes/:scopeId/photos/:photoId
export async function deleteScopePhoto(req: Request, res: Response) {
  try {
    const estimate = await loadGuardedEstimate(req, res);
    if (!estimate) return;
    if (isMutationBlocked(estimate, res)) return;

    const scopeId = req.params.scopeId as string;
    const photoId = req.params.photoId as string;
    const scope = asScopeArray(estimate.scopes).find((s) => s.id === scopeId);
    if (!scope) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    // Compound (estimate_id, scope_id) match — never scope_id alone (see header comment). A
    // photo attached to scope X on THIS estimate can never be found/deleted via a different
    // estimate even if that estimate also has a scope with the same id (post-duplicate/revise).
    const existing = await prisma.estimateScopePhoto.findFirst({
      where: { id: photoId, estimate_id: estimate.id, scope_id: scopeId, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    try {
      const { error: removeError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([existing.storage_path]);
      if (removeError) logger.warn(`Failed to remove storage object ${existing.storage_path}:`, removeError);
    } catch (removeErr) {
      logger.warn(`Failed to remove storage object ${existing.storage_path}:`, removeErr);
    }

    await prisma.estimateScopePhoto.delete({ where: { id: existing.id } });

    void logAudit({
      req,
      action: 'estimate.scope_photo_deleted',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { scope_id: scopeId, photo_id: existing.id },
    });

    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete estimate scope photo:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
