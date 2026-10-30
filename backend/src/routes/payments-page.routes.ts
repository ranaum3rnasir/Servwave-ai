import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo, canDoAny } from '../middleware/canGuard';
import * as paymentsPageController from '../controllers/payments-page.controller';
import * as attentionController from '../controllers/payments-attention.controller';
import * as disputeEvidenceController from '../controllers/dispute-evidence.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Payments go-live P3: the Payments page's read API. Every route needs View payments ('view_payments' on the
// organization); the Show payments page switch is display only and is never checked here. The data is read from
// ServWave's own ledger, never from the processor.
const viewPayments = canDo('view_payments', 'Organization');

router.get('/summary', viewPayments, paymentsPageController.getSummary);
router.get('/payments', viewPayments, paymentsPageController.listPayments);
// Registered before '/payments/:id' so 'export' is never read as an id.
router.get('/payments/export', viewPayments, paymentsPageController.exportPayments);
router.get('/payments/:id', viewPayments, paymentsPageController.getPayment);
router.get('/payouts', viewPayments, paymentsPageController.listPayouts);
router.get('/payouts/:id', viewPayments, paymentsPageController.getPayout);
router.get('/payouts/:id/payments', viewPayments, paymentsPageController.listPayoutPayments);

// Payments go-live P4 - Needs attention: one list, its resolved history and its actions. Reading needs View payments;
// each action has its own switch (Refund payments, Send payment links, Manage payout account), checked again per
// kind inside the handler, and does not also need to see the page.
router.get('/attention/summary', viewPayments, attentionController.getAttentionSummary);
router.get('/attention', viewPayments, attentionController.listAttentionItems);
router.post('/attention/:key/contact-customer', canDo('send_payment_link', 'Invoice'), attentionController.contactCustomer);
router.post(
  '/attention/:key/resolve',
  canDoAny([['refund', 'Invoice'], ['manage_payout_account', 'Organization']]),
  attentionController.resolveAttention,
);

// Payments go-live P10 - answering a dispute. Reading needs View payments; saving and submitting need Refund payments
// (the outcome of a dispute moves money), and the dispute's invoice must be one the caller can open (checked inside).
router.get('/disputes/:id/evidence', viewPayments, disputeEvidenceController.getEvidence);
router.put('/disputes/:id/evidence', canDo('refund', 'Invoice'), disputeEvidenceController.stageEvidence);
router.post('/disputes/:id/evidence/submit', canDo('refund', 'Invoice'), disputeEvidenceController.submitEvidence);

export default router;
