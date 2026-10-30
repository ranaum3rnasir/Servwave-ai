import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as loController from '../controllers/logistic-order.controller';

const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── CRUD ───────────────────────────────────────────────
router.get('/', canDo('read', 'LogisticOrder'), loController.listLogisticOrders);
router.post(
  '/',
  canDo('create', 'LogisticOrder'),
  validate(loController.createLogisticOrderSchema),
  loController.createLogisticOrder,
);
router.get('/:id', canDo('read', 'LogisticOrder'), loController.getLogisticOrder);
router.patch(
  '/:id',
  canDo('update', 'LogisticOrder'),
  validate(loController.updateLogisticOrderSchema),
  loController.updateLogisticOrder,
);

// ─── Lifecycle ──────────────────────────────────────────
// DRAFT → PENDING_APPROVAL → APPROVED → PROCESSED, cancel from any pre-processed state.
// Submit rides Create logistic orders (there is no separate submit switch); `approve` is the Approve logistic
// orders switch, for any role; `process` fast-forwards the whole chain when the caller also holds approve (E20).
router.post('/:id/submit', canDo('submit', 'LogisticOrder'), loController.submitLogisticOrder);
router.post('/:id/approve', canDo('approve', 'LogisticOrder'), loController.approveLogisticOrder);
router.post('/:id/process', canDo('process', 'LogisticOrder'), loController.processLogisticOrder);
router.post(
  '/:id/cancel',
  canDo('cancel', 'LogisticOrder'),
  validate(loController.cancelLogisticOrderSchema),
  loController.cancelLogisticOrder,
);

// ─── Pickup (after Processed) ───────────────────────────
// The pickup mark on a Processed order: "Taken by me" needs Pick up staged items, "Taken by..." (and its picker) needs
// Record pickup for someone else. Each also needs View logistic orders and the order's reach (the handler applies the
// reach), and none of the order write switches. It moves no stock.
router.post('/:id/taken-by-me', canDo('read', 'LogisticOrder'), canDo('pick_up_staged', 'Inventory'), loController.takenByMe);
router.get('/:id/pickup-people', canDo('read', 'LogisticOrder'), canDo('record_pickup_for_other', 'Inventory'), loController.listPickupPeople);
router.post(
  '/:id/taken-by',
  canDo('read', 'LogisticOrder'),
  canDo('record_pickup_for_other', 'Inventory'),
  validate(loController.takenBySchema),
  loController.takenBy,
);

// ─── Delete (PROCESSED → returnProcessedLo first, then delete, one tx — E13) ──
router.delete('/:id', canDo('delete', 'LogisticOrder'), loController.deleteLogisticOrder);

export default router;
