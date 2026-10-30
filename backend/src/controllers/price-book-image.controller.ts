/**
 * price-book-image.controller.ts — #2045, the narrow "fill if empty" endpoint.
 *
 * `POST /api/price-book/items/:id/image` lets a requester who holds `update Estimate` (SALES)
 * but not `update PriceBook` set an IMAGE-LESS catalog item's picture from an estimate line,
 * without handing them the general catalog write. Once an item has an image (`image_url` OR
 * `photo_url`), this route refuses every caller — including ADMIN — and replacing an existing
 * image stays an `update PriceBook`-only action (`PATCH /api/price-book/items/:id`).
 *
 * Gate order (never reorder past a refusal — spec.md R5):
 *   1. Tenant-scoped item lookup -> 404 "Item not found" — missing and cross-org are
 *      byte-identical, so the route is never an existence oracle for another org's catalog.
 *   2. Item already has an image -> 403 "This item already has an image." — no storage/DB write.
 *      Both columns are checked: the ADMIN dialog writes the data-URI into `photo_url`, while the
 *      estimate line only reads `image_url`, so an item can look image-less on the estimate row
 *      while the catalog already holds one.
 *   3. Estimate row scope (R6): `estimate_id` is optional and, when supplied, must be a canonical id
 *      of an estimate in the requester's reach (anything else is the one 404 a missing estimate gets,
 *      re-audit P2-4), then routed through the SAME `loadGuardedEstimate` + `isMutationBlocked` guard every
 *      other line/scope mutation uses, plus a linkage check (the estimate must carry a line
 *      pointed at this item). When absent, a scoped fallback only asks "does the requester have
 *      ANY estimate inside their own row scope" — the linkage adds no real restriction on top of
 *      that (an `update Estimate` holder can already attach any org item to their own estimate in
 *      one call), so the fallback is not a weakening.
 *   4. File validation (no file / MIME / sniff / size) — all BEFORE any storage call.
 *   5. Upload to the PUBLIC `org-assets` bucket, then a CONDITIONAL persist — `update()` with
 *      extra `where` filters (`{ id, ...tenantWhere, image_url: null, photo_url: null }`, Prisma's
 *      filtered-update feature) re-checks the item is still image-less at write time, closing the
 *      TOCTOU window the awaited upload holds open (round-3 security fix). A row that no longer
 *      matches throws `P2025`, caught explicitly -> best-effort remove the just-uploaded object,
 *      403 the same "This item already has an image." body, no audit. A match -> audit, 201.
 *
 * No role-name check anywhere: the gate is a property of the ITEM (image empty) and of the
 * requester's estimate row scope, never of a role or of a second grant. An ADMIN — who holds
 * `update Estimate` too — is accepted by this route on the same terms as SALES.
 */
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import { canAccessRow, scopeWhereForReq } from '../lib/permissions/enforce';
import { isCanonicalId } from '../lib/ids/canonicalId';
import { ESTIMATE_PHOTO_MIMES, MAX_ESTIMATE_PHOTO_BYTES, safeFileName } from './estimate-photos.controller';
import { loadGuardedEstimate, isMutationBlocked } from './estimate-lines.controller';

// Public bucket — `image_url` is read by the unauthenticated public estimate page and the PDF
// layer, whose fetch allowlist is exactly the Supabase public host. `attachments` (the per-line
// photo bucket) is private and signs a 1h URL on every read, which would both expire and blow the
// column's 500-char cap. Mirrors `organization.controller.ts`'s `uploadLogo` exactly.
const STORAGE_BUCKET = 'org-assets';

// POST /api/price-book/items/:id/image
export async function fillItemImage(req: Request, res: Response) {
  try {
    const itemId = req.params.id as string;

    const item = await prisma.priceBookItem.findUnique({
      where: { id: itemId, ...tenantWhere(req) },
      select: { id: true, image_url: true, photo_url: true, organization_id: true },
    });
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    if (item.image_url || item.photo_url) {
      res.status(403).json({ error: 'This item already has an image.' });
      return;
    }

    // Read straight off the body (a multipart field once multer has run), so the body-id source guard
    // (permission-body-id-guard.test.ts) sees it.
    const rawEstimateId: string | undefined = typeof req.body?.estimate_id === 'string' && req.body.estimate_id.length > 0
      ? req.body.estimate_id
      : undefined;

    if (rawEstimateId) {
      // One answer for an estimate that is missing, another company's, out of the person's reach, malformed or spelled any
      // way but the canonical lower-case id (re-audit P2-4, ticket 33's rule): the 404 a missing estimate gets, so the upload
      // never tells which estimates exist. Checked here because the field arrives in a multipart form, after the route's own
      // id guard has run.
      if (!isCanonicalId(rawEstimateId) || !(await canAccessRow(req, 'Estimate', prisma.estimate, rawEstimateId))) {
        res.status(404).json({ error: 'Estimate not found' });
        return;
      }
      const estimate = await loadGuardedEstimate(req, res, rawEstimateId);
      if (!estimate) return; // loadGuardedEstimate already wrote the 404 (another company's estimate).
      if (isMutationBlocked(estimate, res)) return;
      if (!estimate.line_items.some((l) => l.price_book_item_id === item.id)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    } else {
      // No estimate named — fall back to "does the requester have ANY estimate in their own row
      // scope" (R6/R7). Required by the frozen test: it posts only `file`, no `estimate_id`.
      const scoped = await prisma.estimate.findFirst({
        where: { ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Estimate')) },
        select: { id: true },
      });
      if (!scoped) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    if (!ESTIMATE_PHOTO_MIMES.includes(file.mimetype)) {
      res.status(400).json({ error: 'File type not allowed. Accepted: JPG, PNG' });
      return;
    }
    // Magic-byte sniff — never trust the client-supplied Content-Type alone (F-35).
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, ESTIMATE_PHOTO_MIMES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }
    if (file.size > MAX_ESTIMATE_PHOTO_BYTES) {
      res.status(400).json({ error: 'File too large. Maximum: 8MB' });
      return;
    }

    const safeName = safeFileName(file.originalname);
    const storagePath = `${item.organization_id}/price-book-items/${item.id}/${Date.now()}-${safeName}`;

    // Storage upload BEFORE the DB write, OUTSIDE any $transaction (same rationale as
    // estimate-photos.controller.ts: an orphaned Storage object on a later DB failure is
    // acceptable, a DB row without its object is not).
    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) {
      logger.error('Supabase storage upload error (price-book item image):', uploadError);
      res.status(500).json({ error: 'Failed to upload file' });
      return;
    }

    const { data: pub } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

    // Conditional persist (round-3 security fix) — the :63 refusal read a SNAPSHOT; the awaited
    // Storage upload above holds a window open for a concurrent write (another request for the
    // same item, or an ADMIN's PATCH /api/price-book/items/:id) to fill image_url/photo_url in
    // between. The extra `image_url: null, photo_url: null` filters on `update()`'s `where`
    // (Prisma's filtered-update feature — no preview flag needed on this client version) make the
    // write atomic and re-check both columns are STILL null at the moment it runs; a row that no
    // longer matches throws `P2025`, caught below and treated as "lost the race", never a 500.
    // `tenantWhere(req)` here is belt-and-braces: `item.id` already came from a tenant-scoped
    // lookup at :54-57.
    let count = 1;
    try {
      await prisma.priceBookItem.update({
        where: { id: item.id, ...tenantWhere(req), image_url: null, photo_url: null },
        data: { image_url: pub.publicUrl },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== 'P2025') throw err;
      count = 0;
    }

    if (count === 0) {
      // Lost the race — best-effort remove the object we just uploaded so a refused request never
      // leaves an orphan in Storage (same best-effort convention as the delete handlers in
      // estimate-photos.controller.ts).
      try {
        const { error: removeError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
        if (removeError) logger.warn(`Failed to remove storage object ${storagePath}:`, removeError);
      } catch (removeErr) {
        logger.warn(`Failed to remove storage object ${storagePath}:`, removeErr);
      }
      res.status(403).json({ error: 'This item already has an image.' });
      return;
    }

    void logAudit({
      req,
      action: 'pricebook.item_image_filled',
      resourceType: 'PriceBookItem',
      resourceId: item.id,
      metadata: { estimate_id: rawEstimateId ?? null, size_bytes: file.size, storage_path: storagePath },
    });

    res.status(201).json({ item: { id: item.id, image_url: pub.publicUrl } });
  } catch (err) {
    logger.error('Failed to fill price-book item image:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * The PUBLIC-URL shape Storage mints for `STORAGE_BUCKET`, used to recover the object path from a
 * previously-stored URL so a replacement can delete what it superseded. Anything that does not
 * match — a legacy inline data URI, a URL from another project/bucket, a hand-edited value — yields
 * null and is simply left alone: this helper only ever authorises a delete, never a render.
 */
const PUBLIC_URL_PREFIX = `/storage/v1/object/public/${STORAGE_BUCKET}/`;

export function storagePathFromPublicUrl(url: string | null | undefined, organizationId: string): string | null {
  if (!url || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const idx = parsed.pathname.indexOf(PUBLIC_URL_PREFIX);
  if (idx === -1) return null;
  const path = decodeURIComponent(parsed.pathname.slice(idx + PUBLIC_URL_PREFIX.length));
  // Org-scoped by construction: an object outside this org's prefix is never deletable through a
  // request made in this org, whatever the stored column happens to say.
  if (!path.startsWith(`${organizationId}/price-book-items/`)) return null;
  return path;
}

/** Best-effort object removal. A storage failure must never fail a request whose DB write landed. */
async function removeObject(path: string) {
  try {
    const { error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([path]);
    if (error) logger.warn(`Failed to remove storage object ${path}:`, error);
  } catch (err) {
    logger.warn(`Failed to remove storage object ${path}:`, err);
  }
}

/**
 * PUT /api/price-book/items/:id/image — the REPLACE-capable sibling of `fillItemImage`.
 *
 * Gated `update PriceBook` (the catalog permission) on the route, deliberately NOT the
 * `update Estimate` gate the fill route carries: that route exists so an estimate editor who does
 * not hold the catalog write can give an IMAGE-LESS item a picture, and merging the two gates
 * would silently hand every estimate editor the power to overwrite any catalog image. The two
 * gates stay separate on purpose.
 *
 * Everything else is the fill route's shape, reused rather than re-derived: the same tenant-scoped
 * lookup and 404 body, the same MIME allowlist + magic-byte sniff + size cap BEFORE any storage
 * call, the same public bucket and `<org>/price-book-items/<item>/<ts>-<name>` layout, the same
 * conditional `update()` closing the TOCTOU window the awaited upload holds open, and the same
 * audit. Two differences beyond the gate:
 *
 *   • The conditional `where` pins the image columns to the values READ at :lookup rather than to
 *     null, so a concurrent write (the fill route, or another replace) loses the race instead of
 *     being silently clobbered. P2025 -> 409, and the just-uploaded object is removed.
 *   • On success the SUPERSEDED object is removed, best-effort, after the row is updated. The fill
 *     route never needed this — there was never a previous object.
 *
 * `photo_url` (the legacy inline column) is cleared in the same write. It is read FIRST by the
 * shared catalog resolution, so leaving a stale data URI behind would make every reader keep
 * answering with the picture the operator just replaced.
 */
export async function replaceItemImage(req: Request, res: Response) {
  try {
    const itemId = req.params.id as string;

    const item = await prisma.priceBookItem.findUnique({
      where: { id: itemId, ...tenantWhere(req) },
      select: { id: true, image_url: true, photo_url: true, organization_id: true },
    });
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    if (!ESTIMATE_PHOTO_MIMES.includes(file.mimetype)) {
      res.status(400).json({ error: 'File type not allowed. Accepted: JPG, PNG' });
      return;
    }
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, ESTIMATE_PHOTO_MIMES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }
    if (file.size > MAX_ESTIMATE_PHOTO_BYTES) {
      res.status(400).json({ error: 'File too large. Maximum: 8MB' });
      return;
    }

    const safeName = safeFileName(file.originalname);
    const storagePath = `${item.organization_id}/price-book-items/${item.id}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) {
      logger.error('Supabase storage upload error (price-book item image replace):', uploadError);
      res.status(500).json({ error: 'Failed to upload file' });
      return;
    }

    const { data: pub } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

    let won = true;
    try {
      await prisma.priceBookItem.update({
        where: {
          id: item.id,
          ...tenantWhere(req),
          image_url: item.image_url,
          photo_url: item.photo_url,
        },
        data: { image_url: pub.publicUrl, photo_url: null },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== 'P2025') throw err;
      won = false;
    }

    if (!won) {
      await removeObject(storagePath);
      res.status(409).json({ error: "This item's image changed while yours was uploading. Try again." });
      return;
    }

    // Best-effort, AFTER the row points at the new object: a failure here leaves an orphan, which
    // is recoverable; doing it first would leave a live row pointing at a deleted object.
    const previousPath = storagePathFromPublicUrl(item.image_url, item.organization_id);
    if (previousPath && previousPath !== storagePath) await removeObject(previousPath);

    void logAudit({
      req,
      action: 'pricebook.item_image_replaced',
      resourceType: 'PriceBookItem',
      resourceId: item.id,
      metadata: {
        size_bytes: file.size,
        storage_path: storagePath,
        replaced_storage_path: previousPath,
      },
    });

    res.status(200).json({ item: { id: item.id, image_url: pub.publicUrl } });
  } catch (err) {
    logger.error('Failed to replace price-book item image:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
