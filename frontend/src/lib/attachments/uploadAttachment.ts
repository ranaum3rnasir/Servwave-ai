import api from '@/lib/axios';
import { DIRECT_UPLOAD_MIME_TYPES } from '@/lib/uploadTypes';
import {
  UPLOAD_CANCELLED_MESSAGE,
  clearResumeRecord,
  readResumeRecord,
  resumeRecordKey,
  sendResumable,
  writeResumeRecord,
} from '@/lib/attachments/resumableTransport';

/**
 * One entry point for attaching a file, so no surface has to know which transport carries it.
 *
 * Video goes DIRECT: the API mints a short-lived, single-path upload URL, the browser sends
 * the bytes straight at storage in RESUMABLE CHUNKS, and a second call verifies the landed
 * object before the row exists. Everything else keeps the multipart upload it has always
 * used, unchanged.
 *
 * The split is video-only on purpose. Video is the one thing phones produce that the proxy
 * upload cannot carry — a two-minute 1080p clip is 80-120MB and every byte of it currently
 * lands in the app server's memory. `text/csv` and `text/plain` deliberately stay behind: the
 * server authenticates those by scanning the WHOLE file for NUL bytes, which the direct path's
 * head-only check cannot reproduce. Images are a later migration, not an oversight.
 *
 * NOT the only way a file reaches storage, and the others should not have to be rediscovered:
 * the inventory stage route (`/api/inventory/job-stages/:id/attachments`, driven by
 * `StageDetailDialog`, its own cap and its own table) and the two `CustomerFormPage` upload
 * sites bypass this module entirely. Neither accepts video, which is why neither was pulled in
 * here; folding them in is S6's call when the proxy path goes.
 *
 * The type list lives in `lib/uploadTypes.ts` beside the caps, because it carries the same
 * "MUST stay in step with the controller" contract and
 * `upload-limits-match-backend.test.ts` reads the backend source to pin all three. If the
 * client list gets ahead the mint call 400s and the upload fails outright rather than
 * quietly falling back.
 */

export interface UploadAttachmentArgs {
  /** Lower-case entity segment as the API route spells it: customer | lead | job | invoice. */
  entityType: string;
  entityId: string;
  /**
   * Passed through untouched. Nothing on either path re-encodes, trims or compresses it -
   * that is the point of slice 5, where Ran rejected client-side re-encoding outright.
   *
   * What actually ENFORCES it is one assertion: `expect(sent).toBe(file)` in
   * `upload-attachment-seam.test.ts` ("sends the exact File it was given"), an IDENTITY
   * check. It is the only thing in the repo holding this rope, and on the direct path it is
   * the only thing at all. Weakening that `toBe` to `toEqual` would silently permit a copy,
   * and a copy is where a re-encode would enter.
   */
  file: File;
  displayName?: string;
  description?: string;
  /**
   * Real byte progress. BOTH transports report it.
   *
   * Deliberately `(loaded, total)` and not an axios event or a chunked-upload event: this
   * module exists to hide which transport carries the bytes, so its public signature must not
   * name one. Each branch adapts internally. S1 briefly left the direct path silent — every
   * video showed an indeterminate track — and S2 closed that gap without a caller changing a
   * line, which is the property the seam was extracted to buy.
   */
  onProgress?: (loaded: number, total?: number) => void;
  /**
   * Cancels an upload in flight.
   *
   * An `AbortSignal` rather than a returned handle, for the same reason progress is two
   * numbers: it is the platform's own vocabulary and it names neither transport. Aborting
   * stops the transfer, TERMINATES the partial upload at the service so nothing is left
   * behind, and rejects with `UPLOAD_CANCELLED_MESSAGE`. No attachment row is created.
   */
  signal?: AbortSignal;
}

/**
 * Not exported. A transport-detector on the module whose whole job is to hide the transport
 * is an invitation to branch on it at a call site, which is the two-paths failure the PRD
 * names by name. Its test reaches it through `uploadAttachment`'s observable behaviour.
 */
function usesDirectUpload(file: File): boolean {
  return DIRECT_UPLOAD_MIME_TYPES.includes(file.type);
}

/**
 * Every caller derived this identically - strip the extension from the file name - so it is
 * the default rather than a line repeated at four call sites.
 */
function defaultDisplayName(file: File): string {
  return file.name.replace(/\.[^/.]+$/, '');
}

interface MintedUpload {
  bucket: string;
  path: string;
  token: string;
  ticket: string;
}

/**
 * Bytes straight to storage, in resumable chunks.
 *
 * Nothing here decides WHERE the object goes: the bucket, the path and the token all come back
 * from the mint call, and the token is scoped by the server to that one path. A client that
 * wanted to write somewhere else has nothing here to change.
 *
 * THE ORDER IS LOAD-BEARING and is the reason the ticket is stored with the resume record.
 * The server stamps a fresh storage path on every mint, so minting again on a resume would
 * produce a ticket naming an object the resumed transfer never writes: the bytes would land
 * at the old path and the verify step would look at the new one and find nothing. So: resume
 * the old transfer with the OLD ticket, or mint a new one and start over. Never a mix.
 *
 * And the verify-and-record call is unconditional. Whether the bytes arrived in one attempt
 * or five, the row does not exist until the server has read the landed object's real head
 * bytes and its real size. Resumability adds no path around it.
 *
 * NOT SKIPPING A SECURITY GATE, and this was checked rather than assumed. A resume skips the
 * MINT, which is a pre-flight convenience, not a control: `completeDirectUpload` re-runs all
 * of it against the object that actually landed — ticket signature and expiry, org before
 * touching storage, entity type and id, the minting user, entity existence, entity access,
 * the replay guard, real size from storage metadata against the cap, the F-35 sniff on real
 * head bytes, and the per-entity total with the real size — discarding the object on every
 * failure that occurs after it exists. Revoked access answers 403 and discards; a deleted
 * entity 404s; an over-cap object 400s and discards. The mime allowlist is bound into the
 * ticket, so it cannot drift either.
 *
 * The real cost of skipping the mint is a COURTESY one, and it is worth knowing: the
 * pre-flight is what normally refuses an upload cheaply. On a resume the user pushes the
 * whole clip before learning that their access was revoked halfway through. Rare, not a
 * security problem, and the alternative — minting again — breaks the path/ticket pairing
 * above, which is worse. The other cost of the resume window is argued once, at
 * RESUME_RECORD_MAX_AGE_MS.
 */
async function uploadDirect(args: UploadAttachmentArgs): Promise<void> {
  const { entityType, entityId, file, description = '', onProgress, signal } = args;
  const displayName = args.displayName ?? defaultDisplayName(file);

  const recordKey = resumeRecordKey(entityType, entityId, file);
  const resumable = readResumeRecord(recordKey);

  // Already cancelled with NOTHING to clean up: no ticket minted, no partial at the service.
  // Refusing here is what stops a queue whose whole batch was cancelled minting tickets for
  // uploads that will never start.
  //
  // The `!resumable` half matters. With a record in hand there IS a partial at the service,
  // left by the attempt that was interrupted, and the only way to remove it is to go through
  // the transport — which terminates on an already-aborted signal. Throwing here instead
  // would be quicker and would leak it.
  if (signal?.aborted && !resumable) throw new Error(UPLOAD_CANCELLED_MESSAGE);

  let upload: MintedUpload;
  if (resumable) {
    upload = {
      bucket: resumable.bucket,
      path: resumable.path,
      token: resumable.token,
      ticket: resumable.ticket,
    };
  } else {
    const { data } = await api.post(`/api/attachments/${entityType}/${entityId}/direct-upload`, {
      file_name: file.name,
      content_type: file.type,
      file_size: file.size,
    });
    upload = (data as { upload: MintedUpload }).upload;

    // Re-checked AFTER the await, and that is the whole point of it being here.
    //
    // The mint is a network round-trip, and the queue puts the row into `uploading` — which
    // renders the Cancel control — BEFORE calling this function. So the control is live for
    // the entire hop, and on cell signal that hop is long. A cancel landing inside it used to
    // be lost entirely and the upload completed behind the user, row and all.
    //
    // Throwing is right on THIS branch specifically: we have just minted, no bytes have
    // moved, and there is nothing at the service to terminate. The already-aborted case where
    // something DOES exist is handled inside `sendResumable`, which terminates it.
    if (signal?.aborted) throw new Error(UPLOAD_CANCELLED_MESSAGE);
  }

  await sendResumable({
    file,
    bucket: upload.bucket,
    path: upload.path,
    token: upload.token,
    uploadUrl: resumable?.uploadUrl,
    onProgress,
    signal,
    onUploadUrl: (url) =>
      writeResumeRecord(recordKey, {
        uploadUrl: url,
        ticket: upload.ticket,
        bucket: upload.bucket,
        path: upload.path,
        token: upload.token,
        mintedAt: resumable?.mintedAt ?? Date.now(),
      }),
    onCancelled: ({ terminated }) => {
      // Only when the partial is really gone. A failed terminate leaves it at the service,
      // and the record is the only handle that could ever remove it — the orphan sweep
      // cannot see an incomplete transfer. Keeping a stale record costs one pointless
      // resume attempt; discarding it costs the object for ever.
      if (terminated) clearResumeRecord(recordKey);
    },
  });

  // The cancel could have landed in the gap between the last chunk and this line: the abort
  // listener comes off when the transfer resolves, so nothing else consults the signal
  // again. Without this the row vanishes from the UI and an attachment appears anyway.
  //
  // The landed object is left where it is ON PURPOSE. It is now a stored object with no row
  // pointing at it, which is exactly what S3's sweep collects — unlike an abandoned partial,
  // which it cannot see. Bytes we can sweep beat a row the user did not ask for.
  if (signal?.aborted) {
    clearResumeRecord(recordKey);
    throw new Error(UPLOAD_CANCELLED_MESSAGE);
  }

  // The row does not exist until the server has checked the object that actually landed.
  await api.post(`/api/attachments/${entityType}/${entityId}/direct-upload/complete`, {
    ticket: upload.ticket,
    display_name: displayName,
    description,
  });

  // Cleared AFTER the row exists, not before. If the verify call is the thing that failed, the
  // record is still there and the next attempt resumes an already-complete transfer: the
  // service answers with the full offset, and the verify call runs again against the same
  // ticket, which the server answers as a replay. Clearing earlier would instead re-mint and
  // push the whole video a second time.
  //
  // This is also what makes uploading the same file twice in a row work: with the record gone,
  // the second pick mints its own ticket and its own object rather than resuming a finished
  // transfer and quietly returning the FIRST attachment.
  clearResumeRecord(recordKey);
}

/** The long-standing multipart upload, byte-for-byte what every caller did before. */
async function uploadThroughServer(args: UploadAttachmentArgs): Promise<void> {
  const { entityType, entityId, file, description = '', onProgress, signal } = args;
  const displayName = args.displayName ?? defaultDisplayName(file);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('display_name', displayName);
  formData.append('description', description);

  await api.post(`/api/attachments/${entityType}/${entityId}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // The adapters live HERE, once, rather than at every call site: axios is an
    // implementation detail of this branch. Cancel is wired on this path too so a surface
    // offering the control does not have to know which files it works for - a control that
    // silently does nothing on half the files is worse than no control.
    ...(onProgress ? { onUploadProgress: (e) => onProgress(e.loaded, e.total) } : {}),
    ...(signal ? { signal } : {}),
  });
}

export async function uploadAttachment(args: UploadAttachmentArgs): Promise<void> {
  return usesDirectUpload(args.file) ? uploadDirect(args) : uploadThroughServer(args);
}
