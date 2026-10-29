import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { logger } from './logger';
import { supabaseAdmin } from './supabase';
import { ATTACHMENTS_BUCKET } from './attachment-access';

/**
 * Direct-to-storage attachment uploads — the server half.
 *
 * The bytes go browser -> object storage without passing through this process, so everything
 * the proxy handler used to learn by holding the file has to be learned another way:
 *
 *   - the destination is built HERE, from the org id, and handed to storage as the only path
 *     the minted URL may write (`buildAttachmentStoragePath` + `createScopedUploadUrl`);
 *   - the real size is read back off the stored object's metadata (`statStoredObject`), never
 *     taken from the client's declaration, which is free for an attacker to lie about;
 *   - the F-35 content sniff runs against the LANDED bytes via a ranged read of the head
 *     (`readStoredObjectHead`). `sniffMime()` reads at most 12 bytes (the deepest offsets are
 *     the ISO-BMFF brand and the WEBP fourCC at 8-11), so 8KB is generous headroom.
 *
 * Between the two requests the server keeps no state. `signUploadTicket` / `verifyUploadTicket`
 * carry the whole context — org, entity, path, declared type — in an HMAC-signed blob, so the
 * second request re-derives what it is verifying instead of believing a request body. That is
 * what stops a caller pointing the verify step at an object in somebody else's prefix.
 */

/** The head slice fed to `sniffMatchesDeclared`. See the 12-byte note above. */
export const DIRECT_UPLOAD_HEAD_BYTES = 8192;

/**
 * How long a minted upload URL and its ticket stay usable.
 *
 * COUPLING, deliberately written down: `createSignedUploadUrl` takes no `expiresIn`, so the
 * URL's own lifetime is whatever the storage service defaults to — currently two hours, which
 * is where this number came from. The two are matched by ASSUMPTION, not by configuration. If
 * that default ever shortens, tickets outlive the URLs they were minted beside and a client
 * gets a ticket it can no longer upload against; the failure is a rejected upload, not a
 * security hole, but it would be baffling to debug. Anyone changing this should check the
 * service's current default rather than trusting the comment.
 */
export const DIRECT_UPLOAD_TTL_SECONDS = 2 * 60 * 60; // 2 hours

/** TTL of the throwaway read URL used for the head range-read. Seconds, not hours. */
const HEAD_READ_URL_TTL_SECONDS = 60;

const TICKET_VERSION = 1;

/**
 * A purpose-separated subkey, not the raw secret.
 *
 * The base follows invite-token.ts exactly: production env validation REQUIRES
 * INVITE_TOKEN_SECRET (>=32 chars), and dev/test falls back to the service-role key so the app
 * boots with zero extra config. Deriving through one HMAC with a fixed label means an upload
 * ticket and an invite token can never be swapped for one another, and a leaked ticket says
 * nothing about the base secret — without adding a new required production env var for a
 * two-hour-lived token.
 */
const TICKET_KEY = createHmac(
  'sha256',
  env.INVITE_TOKEN_SECRET || (env.NODE_ENV === 'production' ? '' : env.SUPABASE_SERVICE_ROLE_KEY),
)
  .update('servwave:attachment-direct-upload:v1')
  .digest();

export interface UploadTicket {
  v: number;
  /** Organization the upload belongs to. Re-checked against the caller at verify time. */
  org: string;
  /** Entity type, upper-case, as the Attachment row stores it. */
  et: string;
  /** Entity id. */
  eid: string;
  /** The server-built storage path. The ONLY path the verify step will look at. */
  path: string;
  /** Declared MIME, already checked against the allowlist at mint time. */
  mime: string;
  /** Original (unsanitised) file name, for the row's `file_name`. */
  name: string;
  /** Minting user. */
  uid: string;
  /** Unix seconds. */
  exp: number;
}

function sign(body: string): string {
  return createHmac('sha256', TICKET_KEY).update(body).digest('base64url');
}

/** Build a signed, self-contained upload ticket: `<base64url(payload)>.<hmac>`. */
export function signUploadTicket(
  payload: Omit<UploadTicket, 'v' | 'exp'>,
  ttlSeconds = DIRECT_UPLOAD_TTL_SECONDS,
): string {
  const full: UploadTicket = {
    ...payload,
    v: TICKET_VERSION,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify signature, version and expiry. Returns the payload, or null if invalid/expired/tampered. */
export function verifyUploadTicket(ticket: string): UploadTicket | null {
  if (typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [body, providedSig] = parts;

  const a = Buffer.from(providedSig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: UploadTicket;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadTicket;
  } catch {
    return null;
  }
  if (!payload || payload.v !== TICKET_VERSION) return null;
  if (!payload.org || !payload.et || !payload.eid || !payload.path || !payload.mime || !payload.uid) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Mint the single-path upload URL the browser PUTs to. */
export async function createScopedUploadUrl(storagePath: string) {
  return supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
}

/** Read the stored object's real size. `null` when the object is not there. */
export async function statStoredObject(storagePath: string): Promise<{ size: number } | null> {
  const { data, error } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).info(storagePath);
  if (error) {
    // "Genuinely absent" and "the metadata API is broken" both end as one 404 to the user, so
    // the difference has to survive somewhere. If this ever starts 403ing in production, every
    // direct upload answers "could not be found" and this is the only line that says why.
    logger.warn(`Direct upload: could not stat ${storagePath}: ${error.message}`);
    return null;
  }
  if (!data || typeof data.size !== 'number') {
    logger.warn(`Direct upload: stat of ${storagePath} returned no size`);
    return null;
  }
  return { size: data.size };
}

/**
 * Range-read the first `byteCount` bytes of a stored object.
 *
 * Fails CLOSED. If storage ignores the Range header and answers 200 with the whole object, this
 * refuses the body rather than buffering it — the entire point of the direct path is that a
 * 512MB video never lands in this process's heap, and a silent full read would give that back
 * while still looking like it worked.
 *
 * `null` means OUR side failed, never "the file is wrong": no read URL, fetch threw, a non-OK
 * response, or the range being ignored. The caller depends on that distinction — it answers
 * 502 and keeps the object, rather than telling the user their file is malformed and deleting
 * it because our own read broke.
 */
export async function readStoredObjectHead(
  storagePath: string,
  byteCount = DIRECT_UPLOAD_HEAD_BYTES,
): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUrl(storagePath, HEAD_READ_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    logger.warn(`Direct upload: could not mint a read URL for ${storagePath}`);
    return null;
  }

  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(data.signedUrl, {
      headers: { Range: `bytes=0-${byteCount - 1}` },
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn(`Direct upload: head read failed for ${storagePath}: ${String(err)}`);
    return null;
  }

  if (!res.ok) {
    // The only branch in this function that used to return null without saying anything.
    logger.warn(`Direct upload: head read for ${storagePath} answered ${res.status}`);
    return null;
  }

  // 206 means the range was honoured. A 200 has to prove it is small before we read it.
  if (res.status !== 206) {
    const length = Number(res.headers.get('content-length') ?? NaN);
    if (!Number.isFinite(length) || length > byteCount) {
      controller.abort();
      logger.warn(`Direct upload: storage ignored the range request for ${storagePath}`);
      return null;
    }
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, byteCount);
}

/** Best-effort removal of an object that failed verification. Never throws. */
export async function discardStoredObject(storagePath: string): Promise<void> {
  const { error } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove([storagePath]);
  if (error) {
    logger.warn(`Direct upload: failed to remove rejected object ${storagePath}: ${error.message}`);
  }
}
