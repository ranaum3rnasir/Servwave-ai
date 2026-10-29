import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import * as stateTaxRateController from '../controllers/state-tax-rate.controller';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/', canDo('read', 'StateTaxRate'), stateTaxRateController.list);

export default router;
