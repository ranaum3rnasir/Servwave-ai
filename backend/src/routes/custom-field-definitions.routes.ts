import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as customFieldDefinitionsController from '../controllers/custom-field-definitions.controller';

const router = Router();

router.use(authenticate, attachAbility);

// SRVW-114 slice 1 - custom field definitions are org settings, same population as every other
// Organization Settings surface (org-tax-rate.routes.ts precedent), so this reuses the existing
// Organization read/update grants rather than a new Action/Subject pair.
router.get('/', canDo('read', 'Organization'), customFieldDefinitionsController.list);
router.post(
  '/',
  canDo('update', 'Organization'),
  validate(customFieldDefinitionsController.createCustomFieldDefinitionSchema),
  customFieldDefinitionsController.create,
);
// SRVW-114 slice 3 - relabel, or change which entities the field applies to. There is no
// DELETE by design (archive-only, slice 6), so this is the only way to correct a definition.
router.patch(
  '/:id',
  canDo('update', 'Organization'),
  validate(customFieldDefinitionsController.updateCustomFieldDefinitionSchema),
  customFieldDefinitionsController.update,
);

export default router;
