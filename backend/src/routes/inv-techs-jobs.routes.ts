import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import * as invTechsJobsController from '../controllers/inv-techs-jobs.controller';

const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── Techs (read-only: active users mapped to the Tech shape) ─
router.get('/techs', canDo('read', 'Inventory'), invTechsJobsController.listTechs);

// ─── Jobs (read-only: jobs mapped to the InventoryJob shape) ─
router.get('/jobs', canDo('read', 'Inventory'), invTechsJobsController.listInventoryJobs);
router.get('/jobs/:id', canDo('read', 'Inventory'), invTechsJobsController.getInventoryJob);

export default router;
