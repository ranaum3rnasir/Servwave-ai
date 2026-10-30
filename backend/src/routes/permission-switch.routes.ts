import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import * as ctrl from '../controllers/permission-switch.controller';

const router = Router();

// Any signed-in person may read the catalog; it carries no company or person data.
router.get('/catalog', authenticate, ctrl.getCatalog);
// The company's own effective accepted payment methods, for the Allowed payment methods editor and the payment dialogs.
router.get('/accepted-payment-methods', authenticate, ctrl.getAcceptedPaymentMethods);

// The signed-in person's own resolved values and compiled rules, for menus and buttons.
router.get('/me', authenticate, attachAbility, ctrl.getMe);

export default router;
