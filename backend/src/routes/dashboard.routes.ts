import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import * as dashboardController from '../controllers/dashboard.controller';

const router = Router();

router.use(authenticate, attachAbility);
router.get('/', canDo('read', 'Dashboard'), dashboardController.getDashboard);

export default router;
