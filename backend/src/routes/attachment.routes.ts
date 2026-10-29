import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { multerErrorHandler, sizeLimitLabel } from '../middleware/multerErrors';
import * as attachmentController from '../controllers/attachment.controller';
import { MAX_FILE_SIZE, MAX_PROXY_VIDEO_FILE_SIZE } from '../controllers/attachment.controller';

const router = Router();
// The 60MB route limit is a generous ceiling ABOVE the handler's real per-kind
// caps (25MB non-video, 50MB video on THIS path — mirrors estimate.routes.ts's
// photoUpload pattern) so an oversized file 400s with the handler's precise message
// instead of multer's own LIMIT_FILE_SIZE error surfacing as a raw 500.
// That reasoning only ever held BELOW 60MB. Past the ceiling multer aborts the
// stream and the handler never runs, so `uploadMulterErrors` below answers for it.
//
// DELIBERATELY NOT RAISED alongside the 512MB direct-to-storage video cap. `memoryStorage()`
// means whatever number sits here can be buffered whole in this process, against a single
// instance documented at 512MB of memory. Video no longer arrives here at all, so raising it
// would buy nothing any user can reach while putting the process one request from an OOM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
});

// Built from the controller's own constants so the sentence cannot drift from the caps
// it quotes. When multer aborts we do not know the file's kind — its mimetype comes from
// the client's Content-Type header, which the controller already refuses to trust
// (file-sniff.ts) — so the message names BOTH caps rather than guessing at one. Never
// the 60MB ceiling: no user is entitled to 60MB here.
//
// MAX_PROXY_VIDEO_FILE_SIZE, never MAX_VIDEO_FILE_SIZE. The 512MB cap belongs to the direct
// path. Quoting it on the route that buffers would promise a size this transport cannot carry,
// and would send someone back to retry a file that can only fail harder.
const uploadMulterErrors = multerErrorHandler({
  tooLarge:
    `That file is too large to upload. Videos can be up to ${sizeLimitLabel(MAX_PROXY_VIDEO_FILE_SIZE)} `
    + `and other files up to ${sizeLimitLabel(MAX_FILE_SIZE)}.`,
});

router.use(authenticate, attachAbility);

// List attachments for an entity
router.get('/:entityType/:entityId', canDo('read', 'Attachment'), attachmentController.listAttachments);

// Upload attachment (multipart/form-data: file + display_name + description)
// `withOrgContext` re-establishes the org AsyncLocalStorage scope that multer's
// stream consumption drops — without it the controller's queries run org-less
// and RLS 404s with "Entity not found" (DB_TENANT_GUARD=on).
router.post('/:entityType/:entityId', canDo('create', 'Attachment'), upload.single('file'), uploadMulterErrors, withOrgContext, attachmentController.uploadAttachment);

// Direct-to-storage upload (video), two steps and NO multer on either.
//
// That absence is the point of the slice: nothing on these routes can buffer a file, because
// no body parser here accepts one. Step 1 takes a JSON declaration and hands back a signed URL
// scoped to a single server-built path; the browser PUTs the bytes straight at storage; step 2
// takes a JSON ticket and verifies the object that landed. Express matches on segment count,
// so these could never collide with the two-segment multipart route above.
//
// `withOrgContext` is NOT needed here for the reason it IS needed on that route: multer's
// stream consumption drops the org AsyncLocalStorage scope. Nothing here consumes a stream, so
// the scope `authenticate` established is still intact.
router.post(
  '/:entityType/:entityId/direct-upload',
  canDo('create', 'Attachment'),
  validate(attachmentController.directUploadRequestSchema),
  attachmentController.createDirectUploadUrl,
);
router.post(
  '/:entityType/:entityId/direct-upload/complete',
  canDo('create', 'Attachment'),
  validate(attachmentController.directUploadCompleteSchema),
  attachmentController.completeDirectUpload,
);

// Update attachment metadata (display_name, description) and delete. `attachmentChangeGuard` is
// `canDo('update'|'delete', 'Attachment')` everywhere except a TASK, where the handler also lets
// the file's own uploader in once the row is loaded (slice 12; no role grant is widened).
router.patch('/:entityType/:entityId/:attachmentId', attachmentController.attachmentChangeGuard('update'), validate(attachmentController.updateAttachmentSchema), attachmentController.updateAttachment);

router.delete('/:entityType/:entityId/:attachmentId', attachmentController.attachmentChangeGuard('delete'), attachmentController.deleteAttachment);

export default router;
