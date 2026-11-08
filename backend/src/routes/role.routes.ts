import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/role.controller';

const router = Router();

router.use(authenticate, attachAbility);
router.get('/', canDo('read', 'Role'), ctrl.listRoles);
router.post('/', canDo('update', 'Role'), validate(ctrl.createRoleSchema), ctrl.createRole);
router.get('/:role/permissions', canDo('read', 'Role'), ctrl.getRolePermissions);
router.put('/:role/permissions', canDo('update', 'Role'), validate(ctrl.putRolePermissionsSchema), ctrl.putRolePermissions);
router.post('/:role/reset', canDo('update', 'Role'), ctrl.resetRole);
router.patch('/:role', canDo('update', 'Role'), validate(ctrl.patchRoleSchema), ctrl.patchRole);
router.post('/:role/archive', canDo('update', 'Role'), ctrl.archiveRole);

export default router;
