import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireAdminTo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as c from '../controllers/jobType.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Every route reuses `update Organization` (no new switch), reads included. The literal /reorder goes BEFORE /:id.
router.get('/', requireAdminTo('change company settings'), c.list);
router.post('/', requireAdminTo('change company settings'), validate(c.createSchema), c.create);
router.post('/reorder', requireAdminTo('change company settings'), validate(c.reorderSchema), c.reorder);
router.patch('/:id', requireAdminTo('change company settings'), validate(c.renameSchema), c.rename);
router.post('/:id/archive', requireAdminTo('change company settings'), c.archive);
router.post('/:id/unarchive', requireAdminTo('change company settings'), c.unarchive);
// Only at used_count 0; it exists for Undo of Create. Removing a used name is archive.
router.delete('/:id', requireAdminTo('change company settings'), c.remove);

export default router;
