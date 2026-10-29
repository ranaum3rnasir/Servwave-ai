import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/workflow.controller';

const router = Router();

router.use(authenticate, requireFeature('automations'), attachAbility);

// Static routes before the `/:id` catch-all.
router.get('/catalog', canDo('read', 'Automation'), ctrl.getWorkflowCatalog);

router.get('/', canDo('read', 'Automation'), ctrl.listWorkflows);
router.post('/', canDo('create', 'Automation'), validate(ctrl.createWorkflowSchema), ctrl.createWorkflow);
router.get('/:id', canDo('read', 'Automation'), ctrl.getWorkflow);
router.patch('/:id', canDo('update', 'Automation'), validate(ctrl.patchWorkflowSchema), ctrl.patchWorkflow);
router.delete('/:id', canDo('delete', 'Automation'), ctrl.deleteWorkflow);

router.post('/:id/publish', canDo('update', 'Automation'), validate(ctrl.publishWorkflowSchema), ctrl.publishWorkflow);
router.post('/:id/toggle', canDo('update', 'Automation'), validate(ctrl.toggleWorkflowSchema), ctrl.toggleWorkflow);
router.post('/:id/test', canDo('update', 'Automation'), validate(ctrl.testWorkflowSchema), ctrl.testWorkflow);
router.get('/:id/activity', canDo('read', 'Automation'), ctrl.getWorkflowActivity);

export default router;
