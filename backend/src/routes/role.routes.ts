import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireAdmin } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/role.controller';

const router = Router();

// Every read and write of a role, its switches and its change log is an Admin's alone (AL-18): the Admin flag, never a switch.
router.use(authenticate, attachAbility, requireAdmin);
router.get('/', ctrl.listRoles);
router.post('/', validate(ctrl.createRoleSchema), ctrl.createRole);
router.get('/:role/permissions', ctrl.getRoleSwitches);
router.put('/:role/permissions', validate(ctrl.putRoleSwitchesSchema), ctrl.putRoleSwitches);
router.post('/:role/reset', ctrl.resetRole);
router.get('/:role/change-log', ctrl.getRoleChangeLog);
router.patch('/:role', validate(ctrl.patchRoleSchema), ctrl.patchRole);
// Deleting a role archives it (a role with people on it is refused, a built-in role is never deleted).
router.post('/:role/archive', ctrl.archiveRole);
router.delete('/:role', ctrl.archiveRole);

export default router;
