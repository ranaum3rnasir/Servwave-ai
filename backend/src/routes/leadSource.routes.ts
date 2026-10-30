import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as c from '../controllers/leadSource.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Same set as the job types, with NO reorder route: sources are kept in creation order.
router.get('/', canDo('update', 'Organization'), c.list);
router.post('/', canDo('update', 'Organization'), validate(c.createSchema), c.create);
router.patch('/:id', canDo('update', 'Organization'), validate(c.renameSchema), c.rename);
router.post('/:id/archive', canDo('update', 'Organization'), c.archive);
router.post('/:id/unarchive', canDo('update', 'Organization'), c.unarchive);
router.delete('/:id', canDo('update', 'Organization'), c.remove);

export default router;
