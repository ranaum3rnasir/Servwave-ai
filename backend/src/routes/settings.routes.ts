import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as settingsController from '../controllers/settings.controller';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/:key', canDo('read', 'AppSetting'), settingsController.getByKey);
router.patch('/:key', canDo('update', 'AppSetting'), validate(settingsController.updateSettingSchema), settingsController.updateByKey);

export default router;
