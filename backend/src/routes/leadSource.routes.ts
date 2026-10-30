import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireAdminTo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as c from '../controllers/leadSource.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Same set as the job types, with NO reorder route: sources are kept in creation order.
router.get('/', requireAdminTo('change company settings'), c.list);
router.post('/', requireAdminTo('change company settings'), validate(c.createSchema), c.create);
router.patch('/:id', requireAdminTo('change company settings'), validate(c.renameSchema), c.rename);
router.post('/:id/archive', requireAdminTo('change company settings'), c.archive);
router.post('/:id/unarchive', requireAdminTo('change company settings'), c.unarchive);
router.delete('/:id', requireAdminTo('change company settings'), c.remove);

export default router;
