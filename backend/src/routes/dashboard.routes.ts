import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { validate } from '../middleware/validate';
import { carryOverLayoutSchema, saveLayoutSchema } from '../services/dashboard/layout';
import * as dashboardController from '../controllers/dashboard.controller';

const router = Router();

router.use(authenticate, attachAbility);
// The dashboard is every signed-in person's home page, so it has no switch: the route asks only who is signed in.
// Which tiles and figures a person gets back follow their own switches and Data Scope inside the controller.
router.get('/', dashboardController.getDashboard);
// The person's own saved layout. No address or body names a person: it is always the one signed in.
router.get('/layout', dashboardController.getMyLayout);
router.put('/layout', validate(saveLayoutSchema), dashboardController.putMyLayout);
// Puts the default of the person's based-on role back as their saved layout (replaces the row, never deletes it).
router.post('/layout/reset', dashboardController.postResetLayout);
// The browser layout a person kept before layouts lived on the server, moved over once (only if none is saved).
router.post('/layout/carry-over', validate(carryOverLayoutSchema), dashboardController.postCarryOverLayout);

export default router;
