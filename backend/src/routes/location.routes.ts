import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/location.controller';

const router = Router();

router.use(authenticate, attachAbility);
router.get('/', canDo('read', 'Location'), ctrl.listLocations);
router.post('/', canDo('create', 'Location'), validate(ctrl.createLocationSchema), ctrl.createLocation);
router.patch('/:id', canDo('update', 'Location'), validate(ctrl.updateLocationSchema), ctrl.updateLocation);
// Archive / unarchive (visit-location spec D9). Named after the one precedent in this repo,
// `POST /api/customers/:id/unarchive`, so the two archive-and-undo pairs read as one concept. The
// BUTTON above this door still says "Restore" - the spec's user-facing word, and the better one
// on a screen; the API keeps a single verb underneath it.
//
// Gated on `update Location`, and NOT on an `archive Location` mirroring the customer pair's
// `archive Customer`. That divergence is deliberate: a brand-new grantable capability would have
// to be backfilled into every organisation's role_permissions before anybody could reach the
// button, where `update Location` is a grant the same admins already hold. Archiving is a
// reversible state change on this row, and an admin who may rename a branch may reasonably close
// one.
router.post('/:id/archive', canDo('update', 'Location'), ctrl.archiveLocation);
router.post('/:id/unarchive', canDo('update', 'Location'), ctrl.unarchiveLocation);
router.delete('/:id', canDo('delete', 'Location'), ctrl.deleteLocation);

export default router;
