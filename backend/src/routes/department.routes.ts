import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as departmentController from '../controllers/department.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Read: all authenticated users (needed for dropdowns in filters, user edit, etc.)
router.get('/', canDo('read', 'Department'), departmentController.list);

// Mutations: ADMIN only
router.post(
  '/',
  canDo('create', 'Department'),
  validate(departmentController.createDepartmentSchema),
  departmentController.create
);
router.patch(
  '/:id',
  canDo('update', 'Department'),
  validate(departmentController.updateDepartmentSchema),
  departmentController.update
);
router.delete('/:id', canDo('delete', 'Department'), departmentController.remove);

export default router;
