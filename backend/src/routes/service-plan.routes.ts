import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/service-plan.controller';

const router = Router();

router.use(authenticate, requireFeature('service_plans'), attachAbility);

// Static routes before the `/:id` catch-all.
router.get('/scheduler-bucket', canDo('read', 'ServicePlan'), ctrl.schedulerBucket);

router.get('/', canDo('read', 'ServicePlan'), ctrl.listPlans);
router.post('/', canDo('create', 'ServicePlan'), validate(ctrl.createPlanSchema), ctrl.createPlan);
router.get('/:id', canDo('read', 'ServicePlan'), ctrl.getPlan);
router.patch('/:id', canDo('update', 'ServicePlan'), validate(ctrl.updatePlanSchema), ctrl.updatePlan);
router.delete('/:id', canDo('delete', 'ServicePlan'), ctrl.deletePlan);

router.post('/:id/activate', canDo('update', 'ServicePlan'), ctrl.activatePlan);
router.post('/:id/renew', canDo('update', 'ServicePlan'), ctrl.renewPlan);
router.post('/:id/cancel', canDo('update', 'ServicePlan'), ctrl.cancelPlan);
router.post('/:id/schedule-visit', canDo('update', 'ServicePlan'), validate(ctrl.scheduleVisitSchema), ctrl.scheduleVisit);
router.post('/:id/skip-visit', canDo('update', 'ServicePlan'), ctrl.skipVisit);

export default router;
