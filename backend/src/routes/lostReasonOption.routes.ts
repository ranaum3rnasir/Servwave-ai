import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as lostReasonOptionController from '../controllers/lostReasonOption.controller';

const router = Router();

router.use(authenticate, attachAbility);

/**
 * Gating mirrors jobSubStatus.routes.ts exactly, including the
 * asymmetry between the read and the writes.
 *
 * WRITES reuse the existing `update Organization` grant rather than minting a new CASL Subject.
 * This is an org-settings catalog, managed from the same Settings shell and by the same
 * population that already edits job sub-statuses. No default grant gives that
 * to SALES, DISPATCHER or TECHNICIAN (defaultGrants.ts gives all three only `read
 * Organization`), so in practice these four routes are ADMIN-only - which is the intent.
 *
 * The READ is the coarser `read Estimate`, for the same reason the job sub-status neighbour reads
 * on `read Job`: it is not only the settings population that needs these words. Slice C
 * points the STAFF decline dialog at this route, and a SALES rep declining their own estimate
 * has `read Estimate` and no `update Organization` - gating the list behind the write grant
 * would hand that rep an empty picker and make the reason unrecordable. The list carries no
 * financial or personal data; it is the org's own vocabulary.
 *
 * The PUBLIC estimate page is NOT served from here and must not be. It is unauthenticated, so it
 * gets its own token-scoped route in slice C (decision D6) returning active options only. This
 * router sits behind `authenticate`, which is what keeps the two apart.
 */
router.get('/', canDo('read', 'Estimate'), lostReasonOptionController.list);
router.post('/', canDo('update', 'Organization'), validate(lostReasonOptionController.createLostReasonOptionSchema), lostReasonOptionController.create);
// Literal path segment BEFORE any ":code" route - the house ordering rule here, and it keeps a
// future POST /:code/... from shadowing this one.
router.post('/reorder', canDo('update', 'Organization'), validate(lostReasonOptionController.reorderLostReasonOptionsSchema), lostReasonOptionController.reorder);
router.patch('/:code', canDo('update', 'Organization'), validate(lostReasonOptionController.updateLostReasonOptionSchema), lostReasonOptionController.update);

// No DELETE. A reason is deactivated, never deleted (D4) - declined estimates already hold the
// code and the conversion report groups on it - so there is nothing for a delete route to do
// that PATCH { is_active: false } does not do safely.

export default router;
