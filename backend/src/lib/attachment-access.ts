import { logger } from './logger';
import { supabaseAdmin } from './supabase';

// Shared Supabase Storage bucket every generic entity Attachment (customer/lead/
// estimate/job/invoice) lives in. Extracted out of attachment.controller.ts
// (email slice 7) so a second storage consumer - the Communication module's
// email attachments - mints signed URLs from the exact same bucket/TTL instead
// of a driftable second copy of the same few lines.
export const ATTACHMENTS_BUCKET = 'attachments';

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour - short-lived per-read URLs

/**
 * Mint a fresh short-lived signed URL for a stored attachment. Falls back to
 * `legacyUrl` when there is no storage_path (pre-migration rows that only ever
 * had a public URL persisted).
 */
export async function buildAccessUrl(storagePath: string | null, legacyUrl: string): Promise<string> {
  if (!storagePath) return legacyUrl;
  const { data, error } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    logger.warn(`Failed to mint signed URL for ${storagePath}, falling back to legacy URL`);
    return legacyUrl;
  }
  return data.signedUrl;
}

/**
 * Recover a bucket path from a legacy row's public `file_url`.
 *
 * Pre-migration `Attachment` rows have `storage_path = NULL` and carry only the public URL
 * persisted at upload time. The path is the tail after the bucket's public prefix, and it is
 * percent-encoded in the URL, so it has to be decoded back to the key storage actually holds.
 *
 * ONE parser. This used to live inline in `deleteAttachment`, which was fine while deleting was
 * the only caller. The orphan sweep needs the identical answer for the opposite reason — to
 * know an object is NOT an orphan — and a second hand-copy that decoded differently would mean
 * the sweep deleting files `deleteAttachment` could still find. Same anti-drift argument that
 * put `buildAttachmentStoragePath` in this module.
 *
 * Returns null when the URL is absent, unparseable, or not a public object URL for `bucket`.
 * A caller must treat null as "unknown", never as "there is no object".
 */
export function parseLegacyPublicUrlPath(fileUrl: string, bucket: string): string | null {
  if (!fileUrl) return null;
  try {
    const url = new URL(fileUrl);
    const parts = url.pathname.split(`/storage/v1/object/public/${bucket}/`);
    return parts[1] ? decodeURIComponent(parts[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The storage object behind an attachment row: the canonical `storage_path`, else the path
 * parsed out of a legacy public `file_url`. Null means "unknown", never "there is no object".
 *
 * `||`, not `??`: an EMPTY storage_path falls through to the URL parser, exactly as
 * `deleteAttachment` always has - `??` would keep the empty string and leak the object. Shared
 * by that handler and the task-deletion purge so the two cannot disagree about which object a
 * row owns.
 */
export function attachmentObjectPath(row: { storage_path: string | null; file_url: string }): string | null {
  return row.storage_path || parseLegacyPublicUrlPath(row.file_url, ATTACHMENTS_BUCKET);
}

/**
 * Best-effort removal of stored attachment objects, for a caller whose rows are ALREADY gone
 * (committed). Never throws: a failure is logged, and the object is left for the orphan sweep,
 * which owns every `AttachmentEntity` path segment. `context` names the caller in that log line.
 */
export async function removeStoredAttachmentObjects(paths: string[], context: string): Promise<void> {
  if (!paths.length) return;
  try {
    const { error } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove(paths);
    if (error) logger.warn(`${context}: failed to remove ${paths.length} stored object(s) (left for the orphan sweep): ${error.message}`);
  } catch (err) {
    logger.warn(`${context}: failed to remove ${paths.length} stored object(s) (left for the orphan sweep)`, err);
  }
}

/**
 * Sanitize a client-supplied filename before it becomes part of a storage
 * path: strip path components, allow only [A-Za-z0-9._-], cap length.
 * Prevents path-traversal-looking bucket keys even though Supabase already
 * normalizes them.
 *
 * Shared (email slice 7) so attachment.controller.ts's generic uploader and
 * the Communication module's email-attachment uploader can never drift into
 * two hand-copied regex chains that quietly diverge.
 */
export function sanitizeAttachmentFilename(originalName: string): string {
  return (
    originalName
      .replace(/^.*[\\/]/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'file'
  );
}

/**
 * The storage path for an attachment, built entirely server-side.
 *
 * ONE builder for both upload paths. It used to be this template spelled out in the multipart
 * handler and again in the direct-upload lib, with a comment claiming the two could not land
 * objects in different places — an assertion, not a mechanism, and precisely the shape of the
 * two drift scars this module was extracted to prevent in the first place.
 *
 * The org id prefixes every key, so an object can never be written outside its own org's
 * prefix: for the direct path the minted URL is scoped to exactly this string, and nothing the
 * client sends contributes to it except the file's NAME, which is sanitised first.
 */
export function buildAttachmentStoragePath(
  orgId: string,
  entityType: string,
  entityId: string,
  originalName: string,
): string {
  return `${orgId}/${entityType.toLowerCase()}/${entityId}/${Date.now()}-${sanitizeAttachmentFilename(originalName)}`;
}
