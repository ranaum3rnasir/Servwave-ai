import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import * as stateTaxRateController from '../controllers/state-tax-rate.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Reference data: the tax picker on every estimate, invoice and job form fills from this list, so every signed-in
// person reads it with no switch.
router.get('/', stateTaxRateController.list);

export default router;
