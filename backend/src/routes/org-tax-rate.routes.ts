import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as orgTaxRateController from '../controllers/org-tax-rate.controller';

const router = Router();

router.use(authenticate, attachAbility);

// R5c (2026-07-22) — reuses the existing Organization update/read grants (org tax rates are
// conceptually org settings, same population as every other Organization Settings field) rather
// than a new Action/Subject pair.
router.get('/', canDo('read', 'Organization'), orgTaxRateController.list);
router.post('/', canDo('update', 'Organization'), validate(orgTaxRateController.createOrgTaxRateSchema), orgTaxRateController.create);
router.patch('/:id', canDo('update', 'Organization'), validate(orgTaxRateController.updateOrgTaxRateSchema), orgTaxRateController.update);
router.delete('/:id', canDo('update', 'Organization'), orgTaxRateController.remove);

export default router;
