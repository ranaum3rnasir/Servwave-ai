import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireAdminTo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as orgTaxRateController from '../controllers/org-tax-rate.controller';

const router = Router();

router.use(authenticate, attachAbility);

// R5c (2026-07-22) — the writes reuse the existing Organization update grant (org tax rates are
// conceptually org settings: the "Company settings" switch) rather than a new Action/Subject pair.
// The list is reference data every form's tax picker fills from, so every signed-in person reads it.
router.get('/', orgTaxRateController.list);
router.post('/', requireAdminTo('change company settings'), validate(orgTaxRateController.createOrgTaxRateSchema), orgTaxRateController.create);
router.patch('/:id', requireAdminTo('change company settings'), validate(orgTaxRateController.updateOrgTaxRateSchema), orgTaxRateController.update);
router.delete('/:id', requireAdminTo('change company settings'), orgTaxRateController.remove);

export default router;
