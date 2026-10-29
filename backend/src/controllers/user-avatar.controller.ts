/**
 * Staff profile photo upload/remove (2026-08-04 plan,
 * md_files/plans/frontend/2026-08-04-user-avatars-initials-and-upload.md, phase 2).
 *
 * Mirrors estimate-photos.controller.ts's upload flow (Supabase Storage `attachments` bucket,
 * magic-byte sniff, Storage upload BEFORE the DB write and OUTSIDE any `$transaction`,
 * best-effort Storage `remove` on delete/replace) with two differences: every upload is
 * re-encoded through sharp into a fixed 256x256 JPEG (this is a small avatar tile, not a stored
 * document — and re-encoding strips EXIF, including GPS, as a side effect), and HEIC gets its own
 * rejection message since a picker misconfiguration is the likeliest way one arrives here.
 *
 * `setAvatar`/`deleteAvatar` back BOTH route pairs — `/api/users/me/avatar` (no capability
 * check; any authenticated user manages their own) and `/api/users/:id/avatar`
 * (`canDo('update', 'User')`, admin-on-behalf-of) — resolveTargetUser is the only branch point.
 */
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import { signAvatarPaths, removeAvatarObject } from '../lib/avatar';
import { loadSharp } from '../lib/load-sharp';

const STORAGE_BUCKET = 'attachments';
const AVATAR_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
// Exported so user.routes.ts builds its too-large message from this same number.
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const AVATAR_DIMENSION = 256;

async function resolveTargetUser(req: Request, res: Response): Promise<{ id: string; avatar_path: string | null } | null> {
  const targetId = (req.params.id as string | undefined) ?? req.user!.id;
  const user = await prisma.user.findFirst({
    where: { id: targetId, ...tenantWhere(req) },
    select: { id: true, avatar_path: true },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return user;
}

// POST /api/users/me/avatar, POST /api/users/:id/avatar
export async function setAvatar(req: Request, res: Response) {
  try {
    const target = await resolveTargetUser(req, res);
    if (!target) return;

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    if (file.mimetype === 'image/heic' || file.mimetype === 'image/heif') {
      res.status(400).json({ error: 'HEIC photos are not supported. Please upload a JPG, PNG, or WEBP.' });
      return;
    }
    if (!AVATAR_MIMES.includes(file.mimetype)) {
      res.status(400).json({ error: 'File type not allowed. Accepted: JPG, PNG, WEBP' });
      return;
    }

    // Magic-byte sniff — never trust the client-supplied Content-Type alone (F-35).
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, AVATAR_MIMES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }

    if (file.size > MAX_AVATAR_BYTES) {
      res.status(400).json({ error: 'File too large. Maximum: 8MB' });
      return;
    }

    // Loaded outside the try below: a failure to load the image library is a
    // server fault (500 from the outer catch), not a bad photo from the user.
    const sharp = await loadSharp();
    let normalized: Buffer;
    try {
      // limitInputPixels + failOn guard against a decompression-bomb upload (F-38, same
      // guard organization.controller.ts's logo upload uses). .rotate() honours EXIF
      // orientation and then, along with the re-encode itself, discards the rest of the
      // EXIF block — including GPS coordinates of wherever the photo was taken.
      normalized = await sharp(file.buffer, { limitInputPixels: 24_000_000, failOn: 'error' })
        .rotate()
        .resize(AVATAR_DIMENSION, AVATAR_DIMENSION, { fit: 'cover' })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch (err) {
      logger.warn('Failed to process avatar image:', err);
      res.status(400).json({ error: 'Could not process this image. Please try a different photo.' });
      return;
    }

    const storagePath = `${req.user!.organization_id}/user_profile_photo/${target.id}/${Date.now()}-avatar.jpg`;

    // Storage upload BEFORE the DB write, OUTSIDE any $transaction — an orphaned Storage
    // object on a later DB failure is acceptable; a DB row without its object is not.
    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, normalized, { contentType: 'image/jpeg', upsert: false });
    if (uploadError) {
      logger.error('Supabase storage upload error (avatar):', uploadError);
      res.status(500).json({ error: 'Failed to upload photo' });
      return;
    }

    await prisma.user.update({ where: { id: target.id }, data: { avatar_path: storagePath } });

    if (target.avatar_path) await removeAvatarObject(target.avatar_path);

    void logAudit({ req, action: 'user.avatar_set', resourceType: 'User', resourceId: target.id });

    const signed = await signAvatarPaths([storagePath]);
    res.json({ avatar_url: signed.get(storagePath) ?? null });
  } catch (err) {
    logger.error('Failed to set avatar:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/users/me/avatar, DELETE /api/users/:id/avatar
export async function deleteAvatar(req: Request, res: Response) {
  try {
    const target = await resolveTargetUser(req, res);
    if (!target) return;

    if (!target.avatar_path) {
      res.json({ avatar_url: null }); // idempotent — nothing to clear
      return;
    }

    await prisma.user.update({ where: { id: target.id }, data: { avatar_path: null } });
    await removeAvatarObject(target.avatar_path);

    void logAudit({ req, action: 'user.avatar_removed', resourceType: 'User', resourceId: target.id });

    res.json({ avatar_url: null });
  } catch (err) {
    logger.error('Failed to delete avatar:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
