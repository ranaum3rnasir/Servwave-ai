import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as scopePresetController from '../controllers/scope-preset.controller';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/', canDo('read', 'Estimate'), scopePresetController.list);
router.post('/', canDo('update', 'Estimate'), validate(scopePresetController.createScopePresetSchema), scopePresetController.create);

export default router;
