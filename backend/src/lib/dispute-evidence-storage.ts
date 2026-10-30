/**
 * Payments go-live P10: reading the bytes of a stored file for dispute evidence.
 *
 * Evidence is judged on what storage holds, never on what the browser or the attachment row declared. The size comes from
 * the stored object's metadata first (so an oversize file is refused without being downloaded); only a file inside the
 * evidence limit is then read whole.
 */
import { ATTACHMENTS_BUCKET } from './attachment-access';
import { statStoredObject } from './attachment-direct-upload';
import { supabaseAdmin } from './supabase';
import { logger } from './logger';

/** The stored object's real size in bytes, or null when it is not there. */
export const storedObjectSize = async (path: string): Promise<number | null> => (await statStoredObject(path))?.size ?? null;

/** The whole stored object, or null when it cannot be read. Call only after the size is known to be inside the limit. */
export async function readStoredObject(path: string): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).download(path);
  if (error || !data) {
    logger.warn(`Dispute evidence: could not read ${path}: ${error?.message ?? 'no data'}`);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}
