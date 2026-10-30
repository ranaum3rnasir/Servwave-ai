import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as c from '../controllers/jobType.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Every route reuses `update Organization` (no new switch), reads included. The literal /reorder goes BEFORE /:id.
router.get('/', canDo('update', 'Organization'), c.list);
router.post('/', canDo('update', 'Organization'), validate(c.createSchema), c.create);
router.post('/reorder', canDo('update', 'Organization'), validate(c.reorderSchema), c.reorder);
router.patch('/:id', canDo('update', 'Organization'), validate(c.renameSchema), c.rename);
router.post('/:id/archive', canDo('update', 'Organization'), c.archive);
router.post('/:id/unarchive', canDo('update', 'Organization'), c.unarchive);
// Only at used_count 0; it exists for Undo of Create. Removing a used name is archive.
router.delete('/:id', canDo('update', 'Organization'), c.remove);

export default router;
