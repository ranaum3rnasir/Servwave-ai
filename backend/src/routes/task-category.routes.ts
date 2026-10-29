import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as ctrl from '../controllers/task-category.controller';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/', canDo('read', 'TaskCategory'), ctrl.list);
// Admin-only: no role but ADMIN (manage-all) holds create/update/delete TaskCategory.
router.post('/', canDo('create', 'TaskCategory'), validate(ctrl.createTaskCategorySchema), ctrl.create);
router.patch('/:id', canDo('update', 'TaskCategory'), validate(ctrl.updateTaskCategorySchema), ctrl.update);
// Slice 11 - may delete every task in the category, so it is rate-limited like the other bulk writes.
router.delete('/:id', expensiveLimiter, canDo('delete', 'TaskCategory'), validate(ctrl.deleteTaskCategorySchema), ctrl.remove);

export default router;
