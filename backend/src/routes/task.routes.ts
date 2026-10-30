import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/task.controller';
import { answerOutOfReachAsMissing, reachableTask } from '../lib/permissions/outOfReachIsMissing';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/',    canDo('read',   'Task'),                                        ctrl.list);
router.post('/',   canDo('create', 'Task'), validate(ctrl.createTaskSchema),       ctrl.create);
router.get('/summary', canDo('read', 'Task'),                                       ctrl.summary);
// #05 - advisory only, and BEFORE '/:id' so the literal path is not read as a task id.
router.get('/entity-access', canDo('read', 'Task'),                                 ctrl.entityAccess);
router.get('/:id', canDo('read',   'Task'),                                        ctrl.getOne);
router.patch('/:id', canDo('update', 'Task'), validate(ctrl.updateTaskSchema),     ctrl.update);
// `delete` is enforced INSIDE ctrl.remove, not here: design §3 lets a creator who is the sole
// assignee delete their own to-do without the grant, and a route guard fires before the row
// exists to test that against. The guard here is the read floor; the controller does the rest.
router.delete('/:id', canDo('read', 'Task'),                                       ctrl.remove);
router.post('/:id/nudge', canDo('update', 'Task'),                                  ctrl.nudge);
router.post('/:id/comments', canDo('update', 'Task'), validate(ctrl.commentSchema), ctrl.addComment);
router.post('/:id/subtasks', canDo('update', 'Task'), validate(ctrl.subtaskCreateSchema), ctrl.addSubtask);
router.patch('/:id/subtasks/:subtaskId', canDo('update', 'Task'), validate(ctrl.subtaskUpdateSchema), ctrl.updateSubtask);
router.delete('/:id/subtasks/:subtaskId', canDo('update', 'Task'), ctrl.deleteSubtask);

// Ticket 33: a record out of the person's reach answers exactly like a missing one on every route above that names its id
// (lib/permissions/outOfReachIsMissing.ts). Keep this after the last route.
answerOutOfReachAsMissing(router, { param: 'id', notFound: 'Task not found', reaches: reachableTask });

export default router;
