import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as invStagesController from '../controllers/inv-stages.controller';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../controllers/inv-stages.controller';

const router = Router();

// P5 stage attachments: memoryStorage; the 100MB route limit is the video
// ceiling — the handler applies the tighter 8MB per-kind cap for images.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES }, // 100MB — the video cap; images are checked tighter in the handler
});

// Past the ceiling multer aborts and uploadStageAttachment never runs, so its own size
// check never runs either. Names both caps: multer's abort carries no mimetype, and the
// declared one is a client header this codebase already declines to trust.
const stageUploadMulterErrors = multerErrorHandler({
  tooLarge:
    `That file is too large to upload. Videos can be up to ${megabytes(MAX_VIDEO_BYTES)} `
    + `and images up to ${megabytes(MAX_IMAGE_BYTES)}.`,
});

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── Job Stages ─────────────────────────────────────────
router.get('/job-stages', canDo('read', 'Inventory'), invStagesController.listJobStages);
router.post('/job-stages', canDo('create', 'Inventory'), validate(invStagesController.createStageSchema), invStagesController.createJobStage);
router.get('/job-stages/:id', canDo('read', 'Inventory'), invStagesController.getJobStage);
router.patch('/job-stages/:id', canDo('update', 'Inventory'), validate(invStagesController.updateStageSchema), invStagesController.updateJobStage);
router.post('/job-stages/receive', canDo('update', 'Inventory'), validate(invStagesController.receiveStageSchema), invStagesController.receiveStageLine);
router.post('/job-stages/notify', canDo('update', 'Inventory'), validate(invStagesController.notifyStageSchema), invStagesController.notifyTechReady);
router.post('/job-stages/email', canDo('update', 'Inventory'), validate(invStagesController.emailStageSchema), invStagesController.emailJobStage);

// ─── Stage attachments (P5 §5.2) — multipart: file + caption/source/… text parts ───
// `withOrgContext` MUST sit AFTER multer: multer's stream consumption drops the
// AsyncLocalStorage tenant scope (see attachment.routes.ts / the ALS-drop learning).
router.post('/job-stages/:id/attachments', canDo('update', 'Inventory'), upload.single('file'), stageUploadMulterErrors, withOrgContext, invStagesController.uploadStageAttachment);
router.delete('/job-stages/:id/attachments/:attachmentId', canDo('update', 'Inventory'), invStagesController.deleteStageAttachment);

export default router;
