/**
 * The `accept` attribute for the generic attachment surfaces (customer, lead, estimate,
 * job, invoice).
 *
 * This MUST stay in step with `ALLOWED_MIME_TYPES` in
 * `backend/src/controllers/attachment.controller.ts`. The browser filter is a courtesy -
 * the server is the gate - but when the two drift the file picker greys out a file the
 * API would happily accept, and Windows reports the mismatch as "<file> does not exist",
 * which reads as data loss rather than a filter.
 *
 * Extensions are listed alongside the MIME types on purpose: Windows does not always
 * supply a type for .csv or legacy Office files, and a MIME-only filter hides them.
 */
export const ACCEPTED_UPLOAD_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/csv', 'text/plain',
];

export const ACCEPTED_UPLOAD_TYPES = [
  ...ACCEPTED_UPLOAD_MIME_TYPES,
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt',
].join(',');

/**
 * What to say when a pick is of a type the server will refuse, or null when it is accepted.
 *
 * The server's rule is the browser-declared type against `ALLOWED_MIME_TYPES` (the extension
 * plays no part), so this checks exactly that and nothing more - `accept` above only filters
 * the picker, and a drop or an "All files" pick walks straight past it. Names the file and
 * what CAN be attached, never the codec or a vendor.
 */
export function unsupportedTypeRefusalMessage(file: { name: string; type: string }): string | null {
  if (ACCEPTED_UPLOAD_MIME_TYPES.includes(file.type)) return null;
  return (
    `"${file.name}" can't be attached. Use a photo (JPG, PNG, HEIC), a video (MP4, MOV), ` +
    'a PDF, or a Word, Excel, PowerPoint, CSV or text file.'
  );
}

/**
 * The size caps, mirrored from the server.
 *
 * These MUST stay in step with `MAX_FILE_SIZE` / `MAX_VIDEO_FILE_SIZE` in
 * `backend/src/controllers/attachment.controller.ts`, for the same reason the type list above
 * does: the server is the gate, and the client copy exists so a doomed upload is refused with
 * a sentence the user can read instead of consuming a multipart request and coming back as a
 * generic failure.
 *
 * Mirror exactly. A client cap BELOW the server's silently refuses files the API would take;
 * a client cap ABOVE it is the bug this pair was added to fix.
 *
 * THE VIDEO CAP IS NOW 512MB (Ran, 2026-09-20), matching the server's MAX_VIDEO_FILE_SIZE
 * and the storage bucket's own file_size_limit. `upload-limits-match-backend.test.ts` reads
 * the controller source and pins the pair, so this is not a number to nudge locally.
 *
 * THE RESUME WINDOW IS NOW THE BINDING CORNER, not a theoretical one. Video takes the
 * resumable path, and a resume is only honoured for 90 minutes after the ticket was minted
 * (`RESUME_RECORD_MAX_AGE_MS` in `attachments/resumableTransport.ts`), against a signed
 * credential that dies at two hours. That bounds when a resume may START, not when it
 * finishes — so a transfer accepted late in the window can outlive the credential, land every
 * byte, and then be told the upload expired. It self-heals on the next attempt and costs
 * bandwidth rather than data, but the size of the band scales with the file: at the old 50MB
 * cap it was a corner, and at 512MB it is a case a technician on a slow uplink will meet.
 * Closing it needs either a server that can re-mint a ticket for an object already in flight,
 * or a client that refuses to start a resume it cannot finish — remaining bytes against
 * observed throughput. Neither is built.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_BYTES = 512 * 1024 * 1024;

export function maxUploadBytesFor(file: { type: string }): number {
  return file.type.startsWith('video/') ? MAX_VIDEO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

/**
 * The types the direct-to-storage path carries, mirrored from the server.
 *
 * Lives beside the caps because it is the same kind of fact and carries the same contract:
 * MUST stay in step with `DIRECT_UPLOAD_MIME_TYPES` in the controller, or the mint call 400s
 * and the upload fails outright rather than quietly falling back.
 * `upload-limits-match-backend.test.ts` reads both trees and pins all three.
 */
export const DIRECT_UPLOAD_MIME_TYPES = ['video/mp4', 'video/quicktime'];

/** Whole megabytes, for copy that is talking about a limit rather than a precise size. */
function wholeMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * What to say when a pick is refused before it is sent, or null when it fits.
 *
 * Three jobs, because a refusal that only does the first two is a dead end:
 *
 *  1. WHICH file, and HOW BIG it actually is. "over the limit" reads identically for a file
 *     just past it and one several times past it, and only one of those is worth re-filming.
 *  2. What the limit is, so the gap is legible.
 *  3. What to do now. Since the cap went to 512MB the file that trips this is a long 4K
 *     walkthrough rather than an ordinary clip, so it is rarer — and correspondingly worse
 *     to leave that person with nothing, because re-filming it costs them real time.
 *     Re-filming is the in-product move; support is the way the file still gets there.
 *     CLAUDE.md forbids pointing at a vendor's dashboard and expressly allows pointing at
 *     ServWave support.
 *
 * "Record a shorter clip" is offered only for video - it is meaningless advice about a PDF.
 */
export function oversizeRefusalMessage(
  file: { name: string; type: string; size: number },
  cap: number = maxUploadBytesFor(file)
): string | null {
  if (file.size <= cap) return null;
  const nextStep = file.type.startsWith('video/')
    ? 'Record a shorter clip, or contact support to send it another way.'
    : 'Contact support to send it another way.';
  return (
    `"${file.name}" is ${wholeMb(file.size)} MB — over the ${wholeMb(cap)} MB limit, ` +
    `so it wasn't uploaded. ${nextStep}`
  );
}
