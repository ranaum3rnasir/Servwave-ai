import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { featureDisabled } from '../middleware/featureDisabled';
import { publicReadLimiter, publicActionLimiter, expensiveLimiter } from '../middleware/rate-limit';
import { unscopedRequest } from '../middleware/unscopedRequest';
import * as invoiceController from '../controllers/invoice.controller';
import * as invoiceLines from '../controllers/invoice-lines.controller';
import * as tagController from '../controllers/tag.controller';

const router = Router();

// Public routes (no auth) — unscopedRequest marks them cross-tenant for RLS.
router.get('/:id/public/pdf', unscopedRequest, publicReadLimiter, invoiceController.getPublicPdf);
router.get('/:id/public', unscopedRequest, publicReadLimiter, invoiceController.getPublic);
router.post('/:id/public/checkout', unscopedRequest, publicActionLimiter, invoiceController.createPublicCheckout);

router.use(authenticate, attachAbility, attachCustomerScope);

// Filter-aware "export all" — gated `read` (no `export` action for Invoice); reuses list row-scope.
router.get('/export', expensiveLimiter, canDo('read', 'Invoice'), invoiceController.exportAll);

// List-level bulk send / bulk resend (Invoices list page) - same `send Invoice` grant as
// /:id/send and /:id/resend below. Static paths, so before the CRUD `:id` block to avoid a route
// conflict.
router.post('/bulk-send', expensiveLimiter, canDo('send', 'Invoice'), validate(invoiceController.bulkSendInvoicesSchema), invoiceController.bulkSend);
router.post('/bulk-resend', expensiveLimiter, canDo('send', 'Invoice'), validate(invoiceController.bulkSendInvoicesSchema), invoiceController.bulkResend);

// CRUD
router.get('/', canDo('read', 'Invoice'), invoiceController.list);
router.post('/', canDo('create', 'Invoice'), validate(invoiceController.createInvoiceSchema), invoiceController.create);
router.get('/:id', canDo('read', 'Invoice'), invoiceController.getById);
router.get('/:id/pdf', expensiveLimiter, canDo('read', 'Invoice'), invoiceController.getPdf);
router.patch('/:id', canDo('update', 'Invoice'), validate(invoiceController.editInvoiceSchema), invoiceController.update);
router.delete('/:id', canDo('delete', 'Invoice'), invoiceController.remove);

// Editable record ids (Workiz dual-run, SERV10X record-renumber). Preview is read-only/advisory
// (no lock); PATCH is the real rename, transactional. Both gated by the dedicated `renumber`
// grant (distinct from `update`) - canAccessRow inside the controller does the per-instance
// ownership check.
router.post('/:id/number/preview', canDo('renumber', 'Invoice'), validate(invoiceController.invoiceNumberSchema), invoiceController.previewNumber);
router.patch('/:id/number', canDo('renumber', 'Invoice'), validate(invoiceController.invoiceNumberSchema), invoiceController.renameNumber);

// Actions
router.post('/:id/send', canDo('send', 'Invoice'), validate(invoiceController.sendInvoiceSchema), invoiceController.send);
router.post('/:id/resend', canDo('send', 'Invoice'), validate(invoiceController.sendInvoiceSchema), invoiceController.resend);
// Payable link without an email - same grant as send, but NOT gated by the email toggle.
router.post('/:id/payment-link', canDo('send', 'Invoice'), invoiceController.createPaymentLink);
router.post('/:id/void', canDo('void', 'Invoice'), validate(invoiceController.voidInvoiceSchema), invoiceController.voidInvoice);
router.post('/:id/refund', canDo('refund', 'Invoice'), validate(invoiceController.refundInvoiceSchema), invoiceController.refundInvoice);
router.post('/:id/credit', canDo('credit', 'Invoice'), validate(invoiceController.creditInvoiceSchema), invoiceController.credit);
router.post('/:id/void-payment', canDo('void_payment', 'Invoice'), validate(invoiceController.voidPaymentSchema), invoiceController.voidPayment);
router.post('/:id/payments', canDo('record_payment', 'Invoice'), validate(invoiceController.recordPaymentSchema), invoiceController.recordPayment);

// Line items (job-items editor — B6/B7). add/delete gated `manage_lines` (Tech/Sales own-scoped);
// edit-line + billing(tip/discount) gated `update` (Admin/Dispatcher only — Tech/Sales 403 here).
router.post('/:id/line-items', canDo('manage_lines', 'Invoice'), validate(invoiceLines.addLineSchema), invoiceLines.addLine);
// Sync-with-inventory (Inventory P1 §3.2 / D1): PARKED (LO-4). Logistic Orders now own all stock
// deduction, so these routes answer 404 FEATURE_DISABLED; the handlers stay dormant in the
// controller (bulkSyncStock/syncStockLine) so un-parking is a one-line revert. Auth still runs
// first (router-level authenticate/attachAbility). Registration stays ABOVE the ":lineId" param
// routes for the literal-segment shadowing reason below.
router.post('/:id/line-items/sync-stock', featureDisabled('line_stock_sync'));
router.post('/:id/line-items/:lineId/sync-stock', featureDisabled('line_stock_sync'));
// MUST come BEFORE the ":lineId" PATCH route below — Express matches routes in registration
// order, and ":lineId" is just a param placeholder that would otherwise capture the literal
// path segment "reorder" (routing to updateLine with lineId="reorder" instead of reorderLines).
router.patch('/:id/line-items/reorder', canDo('update', 'Invoice'), validate(invoiceLines.reorderSchema), invoiceLines.reorderLines);
router.patch('/:id/line-items/:lineId', canDo('update', 'Invoice'), validate(invoiceLines.updateLineSchema), invoiceLines.updateLine);
router.delete('/:id/line-items/:lineId', canDo('manage_lines', 'Invoice'), invoiceLines.deleteLine);
router.patch('/:id/billing', canDo('update', 'Invoice'), validate(invoiceLines.updateBillingSchema), invoiceLines.updateBilling);

// Scopes of work (flat-priced, non-line-item blocks — Stage 5). Same B6/B7 split as lines:
// add/delete gated `manage_lines` (Tech/Sales own-scoped); update gated `update` (Admin/
// Dispatcher only — Tech/Sales 403 here), mirroring addLine/updateLine's gating exactly.
router.post('/:id/scopes', canDo('manage_lines', 'Invoice'), validate(invoiceLines.addScopeSchema), invoiceLines.addScope);
// MUST come BEFORE the ":idx" PATCH route below — same Express route-order gotcha as
// line-items/reorder above (":idx" would otherwise capture the literal path segment "reorder").
router.patch('/:id/scopes/reorder', canDo('update', 'Invoice'), validate(invoiceLines.reorderScopeSchema), invoiceLines.reorderScopes);
router.patch('/:id/scopes/:idx', canDo('update', 'Invoice'), validate(invoiceLines.updateScopeSchema), invoiceLines.updateScope);
router.delete('/:id/scopes/:idx', canDo('manage_lines', 'Invoice'), invoiceLines.deleteScope);

// Timeline (SERV10X-59)
router.get('/:id/timeline', canDo('read', 'Invoice'), invoiceController.getTimeline);

// Notes
router.get('/:id/notes', canDo('read', 'Invoice'), invoiceController.getNotes);
router.post('/:id/notes', canDo('update', 'Invoice'), validate(invoiceController.addNoteSchema), invoiceController.addNote);

// Tags (polymorphic)
// Tag routes take BOTH ids straight from the path into `where` clauses over Postgres
// `uuid` columns, so without these guards a stray segment makes the driver throw P2023
// and the controller's catch reports a 500 for what is only a bad URL. They sit AFTER
// canDo so a caller without the grant still gets 403 rather than learning whether the
// id was well-formed, and they return the SAME 404 text the handler gives for a row
// that genuinely is not there.
router.post('/:id/tags', canDo('update', 'Invoice'), requireUuidParam('id', 'invoice not found'), validate(tagController.addTagToEntitySchema), tagController.addTagToInvoice);
router.delete('/:id/tags/:tagId', canDo('update', 'Invoice'), requireUuidParam('id', 'invoice not found'), requireUuidParam('tagId', 'Tag not attached to this invoice'), tagController.removeTagFromInvoice);

export default router;
