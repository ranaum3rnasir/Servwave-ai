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
// The reads are open to a person attached to the job: the handlers apply the staging reach (one job's stages need
// no View stock; the company-wide list does).
router.get('/job-stages', invStagesController.listJobStages);
router.post('/job-stages', canDo('create', 'Inventory'), validate(invStagesController.createStageSchema), invStagesController.createJobStage);
router.get('/job-stages/:id', invStagesController.getJobStage);
router.patch('/job-stages/:id', canDo('update', 'Inventory'), validate(invStagesController.updateStageSchema), invStagesController.updateJobStage);
// "Taken by me" needs Pick up staged items and reach to the stage, and no Edit stock (the handler applies the reach).
router.post('/job-stages/:id/taken-by-me', canDo('pick_up_staged', 'Inventory'), invStagesController.takenByMe);
// "Taken by..." (someone else took the parts) needs Record pickup for someone else and the same reach, and neither
// Edit stock nor Pick up staged items. Its picker lists the company's active people for a stage the person reaches.
router.get('/job-stages/:id/pickup-people', canDo('record_pickup_for_other', 'Inventory'), invStagesController.listPickupPeople);
router.post('/job-stages/:id/taken-by', canDo('record_pickup_for_other', 'Inventory'), validate(invStagesController.takenBySchema), invStagesController.takenBy);
router.post('/job-stages/receive', canDo('update', 'Inventory'), validate(invStagesController.receiveStageSchema), invStagesController.receiveStageLine);
router.post('/job-stages/notify', canDo('update', 'Inventory'), validate(invStagesController.notifyStageSchema), invStagesController.notifyTechReady);
router.post('/job-stages/email', canDo('update', 'Inventory'), validate(invStagesController.emailStageSchema), invStagesController.emailJobStage);

// ─── Stage attachments (P5 §5.2) — multipart: file + caption/source/… text parts ───
// `withOrgContext` MUST sit AFTER multer: multer's stream consumption drops the
// AsyncLocalStorage tenant scope (see attachment.routes.ts / the ALS-drop learning).
router.post('/job-stages/:id/attachments', canDo('update', 'Inventory'), upload.single('file'), stageUploadMulterErrors, withOrgContext, invStagesController.uploadStageAttachment);
router.delete('/job-stages/:id/attachments/:attachmentId', canDo('update', 'Inventory'), invStagesController.deleteStageAttachment);

export default router;
