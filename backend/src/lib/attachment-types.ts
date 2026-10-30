/**
 * The file types an attachment may be, in ONE place and free of any request handling, so the generic uploader
 * (controllers/attachment.controller.ts), the compose window and mail we receive (lib/inbound-attachments.ts) can each reuse the
 * exact list without importing one another's controllers.
 */

// Exported (email slice 7): the compose-window multipart upload reuses this
// EXACT list rather than declaring a parallel one that could drift.
export const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime',
  'application/pdf',
  // Office documents. Field-service paperwork is not only photos and PDFs: evaluations,
  // install sheets and parts lists arrive as Word/Excel, and rejecting them sent users
  // back to their old system. Macro-enabled variants (.docm/.xlsm) are deliberately
  // absent - they are the executable-content shape of these formats.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/csv', 'text/plain',
];

/** Human-readable form of ALLOWED_MIME_TYPES for the 400 body. Exported alongside the
 *  list itself so the email compose path cannot advertise a different set than it takes. */
export const ALLOWED_TYPES_LABEL = 'JPG, PNG, HEIC, MP4, PDF, Word, Excel, PowerPoint, CSV, TXT';


/**
 * The marker a file carries when it was uploaded from the Payments page's Documents tab (V7-10a), stored in
 * `attachments.source`. The only value a caller may set; every other attachment keeps `source` null.
 */
export const PAYMENTS_DOCUMENTS_SOURCE = 'PAYMENTS_DOCUMENTS';
