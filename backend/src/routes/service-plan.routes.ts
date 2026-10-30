import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import * as customerController from '../controllers/customer.controller';
import * as ctrl from '../controllers/service-plan.controller';

const router = Router();

router.use(authenticate, requireFeature('service_plans'), attachAbility);

// Static routes before the `/:id` catch-all.
// The schedule's own feed (the plan visits waiting to be booked), so it also needs Access Schedule.
router.get('/scheduler-bucket', canDo('access', 'Schedule'), canDo('read', 'ServicePlan'), ctrl.schedulerBucket);

// The plan builder's quick customer create (name, company, phone, email and the plan's service address).
// Accepted on Create service plans instead of Create customers, which gates only the standalone New
// Customer - the way a lead's new customer is accepted on Create leads. Same handler, same duplicate check.
router.post('/customers', canDo('create', 'ServicePlan'), attachCustomerScope, validate(customerController.createCustomerSchema), customerController.create);

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
