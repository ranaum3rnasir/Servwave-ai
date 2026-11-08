/**
 * The chunked, resumable half of the direct-to-storage path (PRD slice 2).
 *
 * WHY THIS IS NOT INSIDE `uploadAttachment.ts`
 *
 * `uploadAttachment` is the seam: one entry point, one signature, no transport types in its
 * public API. Everything here is transport detail — an endpoint, a chunk size, a retry budget,
 * a record in browser storage — and none of it is anyone else's business. It lives beside the
 * seam so the seam stays readable, and it is imported by exactly one module.
 *
 * WHAT REPLACED WHAT
 *
 * S1 pushed a video at storage in ONE request. A technician on cell signal losing the
 * connection at 90% got nothing: no partial credit, no resume, and no progress bar on the way
 * because a single `fetch` of a `File` reports none. This module chunks the transfer, reports
 * every chunk, and remembers where it got to.
 *
 * MEASURED / TAKEN ON TRUST, so the next reader does not have to re-derive it:
 *
 *  - 6MB chunks: the storage service documents this as FIXED for now ("it must be set to 6MB
 *    (for now) do not change it"). Not independently measured — we have no way to observe the
 *    server-side constraint without a live large upload. Treat a change here as needing a real
 *    end-to-end test, not a docs re-read.
 *  - The direct storage hostname resolves and serves the SIGNED resumable route. That it
 *    serves a SUCCESSFUL presigned upload (201 / 204 / 200) is the REVIEWER's measurement,
 *    not this work's — everything probed here was rejected, and a rejection cannot establish
 *    that anything works. The claim that this host is FASTER than the API host for large
 *    uploads is the vendor's and remains unmeasured by anyone.
 *
 *  - 6 MiB chunks are now MEASURED to work end to end, and the docs' claim that the size is
 *    FIXED is measured to be wrong: 5 MiB, 7 MiB and 6,000,000 decimal are all accepted on a
 *    non-final PATCH, and a full transfer at 5 MiB completes. See RESUMABLE_CHUNK_BYTES.
 *  - The signature is REQUIRED and is checked before anything else. Measured on staging
 *    against the signed route: POST and PATCH without the header both answer
 *    `400 Missing x-signature header`, and with a malformed one `400 Invalid Compact JWS` —
 *    including for an upload id that never existed, so the check precedes resolving the
 *    upload. This also settles an earlier probe matrix that concluded the service "never
 *    reads x-signature": those requests carried no `Upload-Metadata`, which is mandatory
 *    (`400 Metadata header is required`), so they could not have been accepted either way.
 *
 *  - TELLING THE TWO ROUTES APART FROM AN ERROR ALONE, since that cost a whole
 *    investigation: the signed route answers PLAIN TEXT, the unsigned one answers a JSON
 *    `{"statusCode":"403","code":"AccessDenied", ... "Invalid Compact JWS"}` envelope. A JSON
 *    body means the request went to the wrong route, not that the token is wrong.
 *
 *  - 24 hours of upload-URL validity is the vendor's documented figure and remains UNTESTED —
 *    it cannot be observed inside a session, and it is not the binding constraint for us
 *    anyway: see RESUME_RECORD_MAX_AGE_MS.
 *
 *  - The documented `409` on two clients writing one upload URL is UNTESTED; probing it needs
 *    a real created upload and would leave partial uploads behind. Where it could bite us is
 *    two TABS resuming the same record — same fingerprint, same stored URL. The loser's 409
 *    arrives through `onError` as `UPLOAD_INTERRUPTED_MESSAGE`, and retrying re-reads the
 *    offset, so the design survives it; that is reasoning, not a measurement.
 */
import { Upload } from 'tus-js-client';

import { RESUME_RECORD_KEY_PREFIX } from '@/lib/attachments/resumeRecordStore';

/**
 * 6 MiB — BINARY, 6,291,456 bytes, which is what goes on the wire. The vendor writes "6MB",
 * which is ambiguous between this and 6,000,000 decimal; someone re-deriving the value from
 * the docs could pick the other one, so it is worth saying which this is.
 *
 * WHAT IS ACTUALLY MEASURED, because the previous version of this comment overstated it.
 * The docs call the size fixed ("it must be set to 6MB (for now) do not change it"), and
 * this comment used to repeat that as fact and add that any other size would be rejected
 * outright. That was not tested and is NOT WHAT THE SERVICE DOES. Measured live: non-final
 * PATCHes at 5 MiB, 7 MiB and 6,000,000 decimal were all accepted (204), and a complete
 * transfer at a 5 MiB chunk size finished and verified. The real constraint is most likely
 * the S3 multipart minimum of 5 MiB rather than a fixed 6.
 *
 * So: this value is known to work end to end, and it is not a cliff edge. Changing it is
 * still not a thing to do casually — nothing here has probed the lower bound, the upper
 * bound, or what a sub-5 MiB non-final chunk does — but the failure mode is not the one this
 * comment used to claim.
 *
 * Also measured about the transfer shape: the creation POST carries the first chunk, the
 * final chunk is a smaller remainder (2 MiB on a 20 MiB file), and the bodies sum to exactly
 * the file size with no padding and no overlap.
 *
 * Transcripts: `md_files/probes/2026-09-19-resumable-upload-endpoint.md`.
 */
export const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * The retry budget, in milliseconds between attempts.
 *
 * Five attempts spread over ~38 seconds. Long enough to ride out a lift, a dead spot or a
 * handover between cells; short enough that a genuinely dead connection reaches the user with
 * a sentence instead of a spinner that never resolves. When it runs out the transfer stops and
 * `UPLOAD_INTERRUPTED_MESSAGE` is thrown — the one thing it must never do is stall silently.
 */
export const RESUMABLE_RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];

/**
 * How long a resume record is honoured. 90 minutes.
 *
 * NOT the vendor's 24-hour upload-URL lifetime, and the difference is the whole point. The
 * binding constraint is the credential, not the URL: the signed upload token minted in S1 —
 * the one that goes in `x-signature` — is documented as valid for two hours, and the server's
 * own `DIRECT_UPLOAD_TTL_SECONDS` ticket was set to match it. Resuming on a record older than
 * the ticket means pushing a whole video at a signature that is no longer accepted, or landing
 * the bytes and then failing the verify step with a ticket the server refuses. Either way the
 * user pays for the upload twice.
 *
 * 90 minutes leaves half an hour of headroom under the two hours — but note what that headroom
 * actually covers. It bounds when a resume may START, not when it finishes. A record accepted
 * at minute 89 with a 150MB clip still to push on a slow uplink can run past the two-hour
 * ticket: the bytes land, and `complete` then answers that the upload expired. It self-heals
 * — the next attempt mints fresh and succeeds — but the user has paid for the upload twice,
 * which is the outcome this window exists to avoid.
 *
 * Shortening the window shrinks that band without closing it. Closing it takes either a
 * server that can re-mint a ticket for an object already in flight, or a client that refuses
 * to begin a resume it cannot finish — remaining bytes against observed throughput, which is
 * a client-side fix for the common case and was not attempted here. The band scales with the
 * file, so `lib/uploadTypes.ts` carries a pointer to this for whoever raises the caps in S4.
 *
 * The clock starts at the MINT and is carried across resumes unchanged. Restarting it on each
 * resume would let a record be honoured indefinitely, which is exactly the failure above with
 * no bound at all. Pinned by "does not restart the 90-minute window every time it resumes".
 *
 * `upload-resumable-transport.test.ts` reads the backend constant and fails if this ever
 * climbs past it.
 *
 * Consequence for S3's sweep, stated because getting it wrong deletes live uploads: our upload
 * window is now bounded by the 2-hour ticket, which is WELL inside the 24 hours
 * `RESUMABLE_UPLOAD_WINDOW_HOURS` already assumes. S2 therefore does not raise that constant,
 * and the 48-hour grace floor derived from it stays a large over-estimate rather than becoming
 * a tight one.
 */
export const RESUME_RECORD_MAX_AGE_MS = 90 * 60 * 1000;

/**
 * What the user reads when the retry budget is gone.
 *
 * An OFFER, not a guarantee, and the difference is deliberate. This used to read "Try again
 * AND IT WILL pick up where it left off", which the code cannot always honour: there is no
 * record to resume from when browser storage is blocked (a private window), when the failure
 * lands before the service has issued an upload URL, or when the credential itself was
 * refused — a 403 is not retried at all, so it fails fast while promising resumption. "Try
 * again to pick up where it left off" is true in every one of those cases: retrying is the
 * way to resume where resuming is possible, and is still the right next step where it is not.
 *
 * It names no vendor, no bucket and no protocol, and it blames neither the connection nor the
 * person holding the phone.
 */
export const UPLOAD_INTERRUPTED_MESSAGE =
  'The upload stopped before it finished. Try again to pick up where it left off.';

/** What a deliberate cancel reads as. Not a failure, just an ending. */
export const UPLOAD_CANCELLED_MESSAGE = 'Upload cancelled.';

/**
 * The SIGNED resumable route. One path segment, and getting it wrong broke every video upload
 * in production.
 *
 * There are two routes. `/storage/v1/upload/resumable` authenticates the CALLER and expects a
 * session bearer token. `/storage/v1/upload/resumable/sign` authenticates the REQUEST: it
 * validates the `x-signature` token server-side against the exact object path the token was
 * minted for. We hold a path-scoped token and deliberately no session credential on this
 * path, so the signed route is the only one that can work — and it is the reason no RLS
 * policy is involved, because the signature is checked instead.
 *
 * IF A VIDEO UPLOAD 400s, CHECK THIS CONSTANT BEFORE THE TOKEN. Both routes answer `400` and
 * both say `Invalid Compact JWS`, so the TEXT looks like a credential fault either way. Only
 * the body FORMAT tells them apart:
 *
 *     signed route    ->  plain text        `Invalid Compact JWS`
 *     unsigned route  ->  JSON envelope     {"statusCode":"403","code":"AccessDenied",
 *                                            "error":"Unauthorized",
 *                                            "message":"Invalid Compact JWS"}
 *
 * A JSON body means the request went to the WRONG ROUTE; it does not mean the token is wrong.
 * That is what the first shipped version hit, and reading it the other way sent the
 * investigation after the token, the header name and the hostname, all of which were correct.
 * Raw transcript: `md_files/probes/2026-09-19-resumable-upload-endpoint.md`.
 *
 * The vendor's own wording is the trap: the docs say to put the token "in the `x-signature`
 * header of the resumable upload", two paragraphs after showing the UNSIGNED endpoint.
 *
 * That a well-formed presigned upload SUCCEEDS here (201 creation, 204 PATCH with the offset
 * advancing, 200 HEAD reporting it back, no `Authorization` and no `apikey` on any request)
 * was measured by the reviewer with a token minted by our own API. It is second-hand and
 * labelled as such: every probe this work ran itself was rejected, and a rejection can prove
 * a request unacceptable but never prove one acceptable.
 */
export const RESUMABLE_UPLOAD_PATH = '/storage/v1/upload/resumable/sign';

/**
 * The resumable endpoint, on the direct storage hostname.
 *
 * `https://<ref>.supabase.co` -> `https://<ref>.storage.supabase.co/...`, which the service's
 * own guidance says is the host to use for large uploads.
 *
 * Any other shape — a self-hosted gateway, a custom domain, a local stack — is left ALONE and
 * only has the path appended. There is no `.storage.` twin to rewrite to in those deployments,
 * and inventing one points every video upload at a name that does not resolve. Silently
 * wrong-by-default is worse here than merely un-optimised.
 */
export function resumableUploadEndpoint(baseUrl: string): string {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  const direct = trimmed.replace(
    /^(https?:\/\/)([a-z0-9-]+)\.supabase\.co$/i,
    '$1$2.storage.supabase.co',
  );
  return `${direct}${RESUMABLE_UPLOAD_PATH}`;
}

/**
 * One in-flight transfer, remembered across attempts.
 *
 * The ticket is in here deliberately. The server builds a fresh storage path on every mint
 * (`buildAttachmentStoragePath` stamps it with `Date.now()`), so a resumed transfer and a
 * freshly-minted ticket name DIFFERENT objects — the bytes would land at the old path and the
 * verify step would look at the new one and find nothing. Resuming therefore means reusing the
 * original ticket, not minting a second one.
 */
export interface ResumeRecord {
  /** The service-issued URL the remaining chunks are PATCHed to. */
  uploadUrl: string;
  /** The signed ticket from the mint that created this transfer. */
  ticket: string;
  /** Storage bucket and object path, so the resumed transfer targets the same object. */
  bucket: string;
  path: string;
  /** The `x-signature` credential minted beside the ticket. */
  token: string;
  /**
   * Epoch millis, set at the MINT and carried across resumes unchanged.
   *
   * Restarting it on each resume would let a record be honoured indefinitely — see
   * RESUME_RECORD_MAX_AGE_MS. There is deliberately no `size` field beside it: the file's
   * size is already part of the key (`resumeRecordKey`), so a record for a changed file is
   * a record that cannot be found, and a second copy of the number would only be a second
   * thing to validate and keep true.
   */
  mintedAt: number;
}



/**
 * The fingerprint.
 *
 * Includes the ENTITY as well as the file, because the same clip attached to two jobs is two
 * uploads to two objects. Keying on the file alone would resume one job's transfer into the
 * other's record — the sort of cross-record leak that is invisible until it is a support call.
 */
export function resumeRecordKey(entityType: string, entityId: string, file: File): string {
  // UNVERIFIED ON iOS, and it is the one input here that might not be stable. When Safari
  // hands a video out of the camera roll it re-exports the asset, and `lastModified` can be
  // the EXPORT time rather than the asset's. If it is, re-picking the same clip produces a
  // different key, no record is found, and resume silently never fires on the client that
  // needs it most — while the failure copy still offers it. First thing to check on a real
  // device; if it is unstable, drop `lastModified` from the key and rely on name + size.
  return [
    RESUME_RECORD_KEY_PREFIX + entityType,
    entityId,
    file.name,
    String(file.size),
    String(file.lastModified),
    file.type,
  ].join('|');
}

/**
 * Browser storage is best-effort here, never load-bearing.
 *
 * Private windows, cleared site data and blocked storage all make these throw or come back
 * empty. Every failure mode collapses to "no record", which costs a restart and nothing else,
 * so nothing in this module may treat a read as authoritative or a write as guaranteed.
 */
export function readResumeRecord(key: string): ResumeRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let record: ResumeRecord;
  try {
    record = JSON.parse(raw) as ResumeRecord;
  } catch {
    clearResumeRecord(key);
    return null;
  }

  // Every field on `ResumeRecord`, and the list is checked against the interface by
  // "throws away a record missing any field the resumed transfer needs". Not a formality:
  // a record missing `bucket` does not fail loudly, it resumes with
  // `metadata.bucketName === undefined`, which is a transfer aimed at nowhere. Anything
  // absent means a record that cannot be used, so it is dropped rather than left as a trap
  // for the next read.
  if (
    !record ||
    typeof record.uploadUrl !== 'string' ||
    typeof record.ticket !== 'string' ||
    typeof record.bucket !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.mintedAt !== 'number'
  ) {
    clearResumeRecord(key);
    return null;
  }

  if (Date.now() - record.mintedAt > RESUME_RECORD_MAX_AGE_MS) {
    clearResumeRecord(key);
    return null;
  }

  return record;
}

export function writeResumeRecord(key: string, record: ResumeRecord): void {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Out of quota, or storage refused. The upload still works; it just cannot be resumed.
  }
}

export function clearResumeRecord(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do, and nothing depends on it */
  }
}



// ───────────────────────────────────────────────────────────────────────────
// The transport itself
// ───────────────────────────────────────────────────────────────────────────

export interface SendResumableOptions {
  file: File;
  bucket: string;
  path: string;
  token: string;
  /** Present only on a resume: the URL the earlier attempt was already writing to. */
  uploadUrl?: string;
  onProgress?: (loaded: number, total?: number) => void;
  signal?: AbortSignal;
  /** Fires once the service has issued a URL — the first moment a resume is possible. */
  onUploadUrl: (url: string) => void;
  /**
   * Fires on cancel, with whether the partial was actually removed.
   *
   * `terminated: false` means the DELETE failed and the partial is still at the service. The
   * caller MUST keep its resume record in that case: the record holds the upload URL, which
   * is the only handle that could ever remove it, and an abandoned chunked transfer is not a
   * stored object, so the orphan sweep cannot find it either.
   */
  onCancelled: (outcome: { terminated: boolean }) => void;
}

/**
 * Push the chunks, resolving when the whole object has landed.
 *
 * Wraps a callback-driven client in a promise. Everything it decides — endpoint, credential,
 * chunk size, retry budget — comes from the constants above, each carrying its own reasoning.
 *
 * The two rejections are DIFFERENT and callers depend on it: a cancel is a thing the user
 * did, an interruption is a thing that happened to them.
 */
export function sendResumable(opts: SendResumableOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const upload = new Upload(opts.file, {
      endpoint: resumableUploadEndpoint(import.meta.env.VITE_SUPABASE_URL ?? ''),
      // Only set when resuming. `undefined` (not `null`) so a test reading the options back
      // can tell "fresh transfer" from "resumed one" without ambiguity.
      ...(opts.uploadUrl ? { uploadUrl: opts.uploadUrl } : {}),
      // The S1 signed token, carried over unchanged. It is a signature over ONE object path,
      // so it cannot be pointed anywhere else — which is why it is safe in the browser.
      headers: { 'x-signature': opts.token },
      // `Upload-Metadata` is MANDATORY on the creation request — omitting it answers
      // `400 Metadata header is required`, which is another 400 that looks like a credential
      // fault and is not one. `cacheControl` is here because the request measured working
      // against live staging carried it; it has not been shown to be individually required,
      // and matching a known-good request beats trimming one on a guess.
      metadata: {
        bucketName: opts.bucket,
        objectName: opts.path,
        contentType: opts.file.type,
        cacheControl: '3600',
      },
      chunkSize: RESUMABLE_CHUNK_BYTES,
      retryDelays: RESUMABLE_RETRY_DELAYS,
      uploadDataDuringCreation: true,
      // We keep the resume record ourselves, because ours also holds the TICKET — without
      // which a resumed transfer has nothing to verify itself with. Two stores would be two
      // things to keep in step, and the library's own knows nothing about tickets.
      storeFingerprintForResuming: false,
      onUploadUrlAvailable: () => {
        if (upload.url) opts.onUploadUrl(upload.url);
      },
      onProgress: (loaded, total) => opts.onProgress?.(loaded, total),
      onSuccess: () => finish(resolve),
      onError: () => {
        // Deliberately NOT the client's own error text. A storage rejection arrives wearing
        // the vendor's name, the bucket's, and often a raw status line, and this string
        // becomes the toast the user reads. As far as anyone using the app is concerned the
        // transport is ours.
        finish(() => reject(new Error(UPLOAD_INTERRUPTED_MESSAGE)));
      },
    });

    function onAbort() {
      // `true` is the terminate flag, and it is the point of cancelling properly: it sends a
      // DELETE for the partial. An incomplete chunked transfer is NOT a stored object, so
      // S3's orphan sweep — which lists bucket objects — would never find it.
      //
      // The service DOES honour it: measured live, the DELETE answers 204 and
      // `storage.s3_multipart_uploads` returns to the zero baseline taken beforehand. That
      // was this slice's biggest unverified assumption and it held.
      //
      // THE FAILURE PATH IS NOT THE SUCCESS PATH, and collapsing them into `.finally()` was
      // a real leak. That DELETE is a network call, and the likeliest moment for it to fail
      // is the dead connection that made the user reach for Cancel. `.finally()` ran the
      // cleanup either way — discarding the upload URL, the only handle that could ever
      // remove the partial — and re-threw the rejection into a bare `void`, so an ordinary
      // offline cancel produced an unhandled rejection as well.
      //
      // Now: cleared only when the partial is really gone, kept when it is not, and the
      // user is told the same thing either way, because our cleanup trouble is not theirs.
      upload.abort(true).then(
        () => {
          opts.onCancelled({ terminated: true });
          finish(() => reject(new Error(UPLOAD_CANCELLED_MESSAGE)));
        },
        () => {
          opts.onCancelled({ terminated: false });
          finish(() => reject(new Error(UPLOAD_CANCELLED_MESSAGE)));
        },
      );
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // THE LISTENER IS NOT ENOUGH, and this is why.
    //
    // `addEventListener('abort', …)` on a signal that has ALREADY aborted never fires: the
    // event is long gone. So every cancel landing before this point — during the mint
    // round-trip most of all, a whole network hop with the Cancel control on screen for its
    // duration — was silently dropped. The transfer started, ran to completion, and a row
    // was created for an upload the user had stopped; the promise never settled either, so
    // the row sat in flight for ever.
    //
    // Calling `onAbort` rather than throwing is deliberate. On a resume the URL from the
    // previous attempt is already set, so there is a partial at the service and the
    // terminate inside `onAbort` is the only thing that removes it.
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    upload.start();
  });
}
