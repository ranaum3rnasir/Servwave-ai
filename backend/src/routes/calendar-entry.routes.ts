import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/calendar-entry.controller';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/',    canDo('read',   'CalendarEntry'),                                              ctrl.list);
router.post('/',   canDo('create', 'CalendarEntry'), validate(ctrl.createCalendarEntrySchema),     ctrl.create);
router.get('/:id', canDo('read',   'CalendarEntry'),                                               ctrl.getOne);
router.patch('/:id', canDo('update', 'CalendarEntry'), validate(ctrl.updateCalendarEntrySchema),   ctrl.update);
// Slice 08 - the drag/resize non-blocking "notify participants of the new time?" toast's confirm
// action. Gated on the SAME grant as the drag itself (spec §4): update, not a bespoke one.
router.post('/:id/notify-moved', canDo('update', 'CalendarEntry'),                                 ctrl.notifyMoved);
router.delete('/:id', canDo('delete', 'CalendarEntry'),                                            ctrl.remove);

export default router;
