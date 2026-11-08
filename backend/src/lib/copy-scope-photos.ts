/**
 * Carrying an estimate's scope photos onto its duplicate or revision (#2029 slice 5).
 *
 * Both operations used to drop them silently, so the copy was missing evidence the original had.
 *
 * THE COPY MUST GET ITS OWN STORAGE OBJECTS. Deleting a photo removes the underlying object, so a
 * copy sharing a storage path with its source means deleting from the copy destroys the
 * ORIGINAL's image — and the original may be a document a customer is already holding a link to.
 * So the files are copied, not just the rows.
 *
 * Line items need nothing here: they carry their price-book reference through both operations, so
 * their image follows automatically.
 *
 * Runs OUTSIDE the caller's `$transaction`, deliberately — a live network call to Storage has no
 * place inside a DB transaction (the same rule resolveEstimatePhotoUrls follows), and a
 * duplicate must not be rolled back because a photo could not be copied.
 */
import { randomUUID } from 'crypto';
import { prisma } from './prisma';
import { supabaseAdmin } from './supabase';
import { logger } from './logger';

const BUCKET = 'attachments';

export interface CopyScopePhotosInput {
  sourceEstimateId: string;
  targetEstimateId: string;
  orgId: string;
}

/** Where the copy's bytes live. Anchored on the TARGET estimate, so nothing can be mistaken for
 *  the source's object, and given a fresh name so two copies never collide. */
function copyPath(orgId: string, targetEstimateId: string, scopeId: string, sourcePath: string): string {
  const filename = sourcePath.split('/').pop() ?? 'photo.jpg';
  return `${orgId}/estimate_scope/${targetEstimateId}/${scopeId}/${randomUUID()}-${filename}`;
}

/**
 * Best-effort: a photo that cannot be copied is left out, and the duplicate still happens. A ROW
 * whose object does not exist would be a broken image on a customer's document; an orphaned
 * object is merely wasted bytes. That asymmetry is the same one the upload path is built around.
 */
export async function copyScopePhotosForward({
  sourceEstimateId,
  targetEstimateId,
  orgId,
}: CopyScopePhotosInput): Promise<void> {
  try {
    const photos = await prisma.estimateScopePhoto.findMany({
      where: { estimate_id: sourceEstimateId, organization_id: orgId },
      orderBy: { uploaded_at: 'asc' },
    });
    if (photos.length === 0) return;

    const storage = supabaseAdmin.storage.from(BUCKET);

    const copied = await Promise.all(
      photos.map(async (photo) => {
        const destination = copyPath(orgId, targetEstimateId, photo.scope_id, photo.storage_path);
        const { error } = await storage.copy(photo.storage_path, destination);
        if (error) {
          logger.warn(
            `Scope photo not carried forward to estimate ${targetEstimateId} (${photo.id}): ${error.message}`,
          );
          return null;
        }
        return {
          estimate_id: targetEstimateId,
          scope_id: photo.scope_id,
          storage_path: destination,
          mime_type: photo.mime_type,
          caption: photo.caption,
          uploaded_at: photo.uploaded_at,
          uploaded_by: photo.uploaded_by,
          size_bytes: photo.size_bytes,
          organization_id: orgId,
        };
      }),
    );

    const rows = copied.filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length === 0) return;

    await prisma.estimateScopePhoto.createMany({ data: rows });
  } catch (err) {
    // Never fail the duplicate/revision over its photos: the estimate matters more than its
    // evidence, and the salesperson can re-attach.
    logger.warn(
      `Scope photos not carried forward to estimate ${targetEstimateId}: ${(err as Error).message}`,
    );
  }
}
