import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import * as paymentAttentionController from '../controllers/payment-attention.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Payments go-live slice 11: money captured but not applied, listed for the people allowed to send
// money back. Both the list and the refund need the refund permission ('refund Invoice', which
// slice 22 shows as its own switch): the list exists to be acted on.
router.get('/', canDo('refund', 'Invoice'), paymentAttentionController.listPaymentsNeedingAttention);
// V7-09a: one item's drawer detail and the Attach dialog's invoice search. Reading needs View payments only (a view-only
// person opens the drawer, C-29); the actions below keep their own switch.
router.get('/:id', canDo('view_payments', 'Organization'), paymentAttentionController.getPaymentNeedingAttention);
router.get('/:id/invoices', canDo('view_payments', 'Organization'), paymentAttentionController.searchInvoicesForPaymentNeedingAttention);
router.post('/:id/attach', canDo('refund', 'Invoice'), paymentAttentionController.attachPaymentNeedingAttention);
router.post('/:id/refund', canDo('refund', 'Invoice'), paymentAttentionController.refundPaymentNeedingAttention);
router.post('/:id/resolve', canDo('refund', 'Invoice'), paymentAttentionController.resolvePaymentNeedingAttention);

export default router;
