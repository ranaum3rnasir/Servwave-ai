/**
 * Signed-URL cache for staff profile photos (2026-08-04 plan, decision 7).
 *
 * The `attachments` bucket is private (decision 1 — a profile photo must never be reachable
 * unauthenticated), so every response has to mint a signed URL rather than store one. Signing on
 * every request would mint a DIFFERENT url string each time, which re-downloads the whole
 * roster's avatars on every refetch and flickers every tile through the initials fallback while
 * the new image loads. Caching each path's signed URL — reused until ~80% of its TTL has
 * elapsed — avoids that churn while still rotating the URL well before Supabase expires it.
 */
import { supabaseAdmin } from './supabase';
import { logger } from './logger';

const AVATAR_BUCKET = 'attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h — same TTL as the other attachments-bucket callers
const CACHE_REUSE_FRACTION = 0.8;

interface CacheEntry {
  url: string;
  signedAtMs: number;
}

const cache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.signedAtMs < SIGNED_URL_TTL_SECONDS * 1000 * CACHE_REUSE_FRACTION;
}

/** Batch-sign avatar storage paths in ONE createSignedUrls call, reusing any still-fresh cached
 *  URL. Never throws — a signing failure just means the affected avatars fall back to the
 *  initials tile for this response, not a 500. */
export async function signAvatarPaths(
  paths: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(paths.filter((p): p is string => !!p)));
  const result = new Map<string, string>();
  const toSign: string[] = [];

  for (const path of unique) {
    const cached = cache.get(path);
    if (cached && isFresh(cached)) {
      result.set(path, cached.url);
    } else {
      toSign.push(path);
    }
  }

  if (toSign.length === 0) return result;

  try {
    const { data, error } = await supabaseAdmin.storage
      .from(AVATAR_BUCKET)
      .createSignedUrls(toSign, SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      logger.warn('Failed to sign avatar URL(s); affected avatars fall back to initials this response', error ?? '');
      return result;
    }
    const signedAtMs = Date.now();
    for (const row of data) {
      if (row?.path && row?.signedUrl) {
        cache.set(row.path, { url: row.signedUrl, signedAtMs });
        result.set(row.path, row.signedUrl);
      }
    }
  } catch (err) {
    logger.warn('Failed to sign avatar URL(s); affected avatars fall back to initials this response', err);
  }

  return result;
}

/** Evict a path from the signed-URL cache. Call on delete/replace so a stale signed URL for a
 *  since-removed object is never served from cache. */
export function evictAvatarUrlCache(path: string): void {
  cache.delete(path);
}

/** Look up one path in a signAvatarPaths() result — the single-path counterpart to the batch
 *  signer, for callers that already batch-signed a whole graph and just need one entry. A null
 *  path or a signing miss both resolve to null; never throws. */
export function resolveAvatarUrl(path: string | null | undefined, signed: Map<string, string>): string | null {
  return path ? (signed.get(path) ?? null) : null;
}

/** Best-effort Storage remove for a superseded/cleared avatar object, plus the matching cache
 *  eviction — the sanctioned Storage-delete path (never SQL DELETE on storage.objects). A
 *  failure leaves an orphaned object, not a broken row; the caller has already committed the DB
 *  change by the time this runs. */
export async function removeAvatarObject(path: string): Promise<void> {
  evictAvatarUrlCache(path);
  try {
    const { error } = await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([path]);
    if (error) logger.warn(`Failed to remove avatar object ${path}:`, error);
  } catch (err) {
    logger.warn(`Failed to remove avatar object ${path}:`, err);
  }
}
