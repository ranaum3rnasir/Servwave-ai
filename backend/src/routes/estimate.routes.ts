import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { publicReadLimiter, publicActionLimiter, publicSelectionLimiter, expensiveLimiter } from '../middleware/rate-limit';
import { unscopedRequest } from '../middleware/unscopedRequest';
import { withOrgContext } from '../middleware/withOrgContext';
import * as estimateController from '../controllers/estimate.controller';
import * as estimateLinesController from '../controllers/estimate-lines.controller';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as estimatePhotosController from '../controllers/estimate-photos.controller';
import { MAX_ESTIMATE_PHOTO_BYTES } from '../controllers/estimate-photos.controller';
import * as tagController from '../controllers/tag.controller';

const router = Router();

// R5f — line-item/scope photos: memoryStorage, image-only. The route-level limit is a generous
// ceiling ABOVE the handler's real 8MB cap (mirrors inv-stages.routes.ts's 100MB video ceiling
// sitting above its own 8MB image cap) — so an oversized image 400s with the handler's precise
// message instead of multer's own LIMIT_FILE_SIZE error surfacing as a raw 500.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// The 8MB the handler enforces, not the 10MB ceiling multer aborts at.
const photoMulterErrors = multerErrorHandler({
  tooLarge: `That photo is too large to upload. Photos can be up to ${megabytes(MAX_ESTIMATE_PHOTO_BYTES)}.`,
});

// ─── Public routes (no auth) — unscopedRequest marks them cross-tenant for RLS ──
router.get('/:id/public/pdf', unscopedRequest, publicReadLimiter, estimateController.getPublicPdf);
router.get('/:id/public', unscopedRequest, publicReadLimiter, estimateController.getPublic);
// #2090 - the customer's own option ticks, written on change and before the lock. Its own
// limiter, NOT publicActionLimiter: approve and decline happen once, a decision session does not.
router.patch('/:id/public/selections', unscopedRequest, publicSelectionLimiter, validate(estimateController.publicSelectionsSchema), estimateController.updatePublicSelections);
router.post('/:id/approve', unscopedRequest, publicActionLimiter, estimateController.approvePublic);
// Slice C / D6 — the words the decline dialog offers, fetched when it opens. A READ limiter,
// not the action one: opening the dialog is a read, and it must not spend the budget the
// decline itself needs a moment later.
router.get('/:id/decline-reasons', unscopedRequest, publicReadLimiter, estimateController.getPublicDeclineReasons);
router.post('/:id/decline', unscopedRequest, publicActionLimiter, validate(estimateController.declinePublicSchema), estimateController.declinePublic);

// ─── Auth-gated routes ────────────────────────────────
router.use(authenticate, attachAbility, attachCustomerScope);

// Stats & lookups (before :id to avoid route conflict)
router.get('/stats', canDo('read', 'Estimate'), estimateController.getStats);
router.get('/creators', canDo('read', 'Estimate'), estimateController.listCreators);
// Filter-aware "export all" — gated `read` (no `export` action for Estimate); reuses list row-scope.
router.get('/export', expensiveLimiter, canDo('read', 'Estimate'), estimateController.exportAll);
// List-level bulk delete (Estimates list page) — POST not DELETE (mirrors POST
// /api/inventory/bulk-restock's ids/lines-array-in-body precedent for HTTP-client/proxy
// compatibility). Static path, so before :id to avoid route conflict.
router.post('/bulk-delete', canDo('delete', 'Estimate'), validate(estimateController.bulkDeleteEstimatesSchema), estimateController.bulkRemove);
// List-level bulk status change - same `update Estimate` grant as PATCH /:id/status below.
router.post('/bulk-status', canDo('update', 'Estimate'), validate(estimateController.bulkSetEstimateStatusSchema), estimateController.bulkSetStatus);
// List-level bulk send reminder - same `send Estimate` grant as POST /:id/send below, rate-
// limited like it renders a PDF per row (estimate sends do; see the schema's cap comment).
router.post('/bulk-send-reminder', expensiveLimiter, canDo('send', 'Estimate'), validate(estimateController.bulkSendEstimateRemindersSchema), estimateController.bulkSendReminders);

// CRUD
router.get('/', canDo('read', 'Estimate'), estimateController.list);
router.post('/', canDo('create', 'Estimate'), validate(estimateController.createEstimateSchema), estimateController.create);
router.get('/:id', canDo('read', 'Estimate'), estimateController.getById);
router.patch('/:id', canDo('update', 'Estimate'), validate(estimateController.updateEstimateSchema), estimateController.update);
router.delete('/:id', canDo('delete', 'Estimate'), estimateController.remove);

// Editable record ids (Workiz dual-run, SERV10X record-renumber). Preview is read-only/advisory
// (no lock); PATCH is the real rename, transactional. Both gated by the dedicated `renumber`
// grant (distinct from `update`) - canAccessRow inside the controller does the per-instance
// ownership check.
router.post('/:id/number/preview', canDo('renumber', 'Estimate'), validate(estimateController.estimateNumberSchema), estimateController.previewNumber);
router.patch('/:id/number', canDo('renumber', 'Estimate'), validate(estimateController.estimateNumberSchema), estimateController.renameNumber);

// Actions
router.post('/:id/send', canDo('send', 'Estimate'), validate(estimateController.sendEstimateSchema), estimateController.send);
// R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3, D13). mark-sent reuses the `send`
// grant (same population, same "deliver the document" intent, just no email). status/approve/
// decline/void-approval each get their own action — see catalog.ts + defaultGrants.ts.
router.post('/:id/mark-sent', canDo('send', 'Estimate'), validate(estimateController.markSentEstimateSchema), estimateController.markSent);
router.patch('/:id/status', canDo('update', 'Estimate'), validate(estimateController.setEstimateStatusSchema), estimateController.setStatus);
router.post('/:id/approve-internal', canDo('approve', 'Estimate'), validate(estimateController.approveInternalSchema), estimateController.approveInternal);
router.post('/:id/decline-internal', canDo('decline', 'Estimate'), validate(estimateController.declineInternalSchema), estimateController.declineInternal);
router.post('/:id/void-approval', canDo('void_approval', 'Estimate'), estimateController.voidApproval);
router.post('/:id/cancel', canDo('cancel', 'Estimate'), validate(estimateController.cancelEstimateSchema), estimateController.cancel);
router.post('/:id/duplicate', canDo('duplicate', 'Estimate'), validate(estimateController.duplicateEstimateSchema), estimateController.duplicate);
router.post('/:id/revise', canDo('revise', 'Estimate'), estimateController.revise);
// Transition 16 (continuity map §4.6) / job-items-estimate-parity Part C - attach an EXISTING
// estimate to an EXISTING job from the job's Estimate tab. `update` (not `create`): this mutates
// an already-existing Estimate row, same gate the generic PATCH /:id uses.
router.post('/:id/attach-to-job', canDo('update', 'Estimate'), validate(estimateController.attachToJobSchema), estimateController.attachToJob);
router.post('/:id/ai/draft-scope', expensiveLimiter, canDo('update', 'Estimate'), estimateController.draftScope);
router.post('/:id/record-payment', canDo('record_payment', 'Estimate'), validate(estimateController.recordEstimatePaymentSchema), estimateController.recordEstimatePayment);
router.post('/:id/waive-deposit', canDo('waive_deposit', 'Estimate'), validate(estimateController.waiveDepositSchema), estimateController.waiveDeposit);
// refund-deposit + reactivate-deposit removed (Phase 5 fold): the deposit refund is now the
// unified Invoice refund — POST /api/invoices/:id/refund on the kind=DEPOSIT invoice.
// R5e (2026-07-22) — copy an estimate directly into a standalone Invoice, independent of the Job
// pipeline. Gated `create Invoice` (not `Estimate`) — mirrors createStandaloneInvoice's exact
// route-level gate (invoice.routes.ts); the controller applies the same 2nd-layer hardcoded
// ADMIN/DISPATCHER check. No request body — everything derives from the estimate itself.
router.post('/:id/copy-to-invoice', canDo('create', 'Invoice'), estimateController.copyToInvoice);

// Line items (v12 unified line-items, plan §2a). add/edit/delete/reorder gated `update` Estimate
// — Estimate has no manage_lines/update split (same precedent as Job's job-lines.controller.ts);
// canAccessRow(Estimate) per-instance inside the controller. No GET here — estimateDetailSelect
// (GET /:id above) already embeds line_items.
router.post('/:id/line-items', canDo('update', 'Estimate'), validate(estimateLinesController.addLineSchema), estimateLinesController.addLine);
// MUST come BEFORE the ":lineId" PATCH route below — Express matches routes in registration
// order, and ":lineId" is just a param placeholder that would otherwise capture the literal path
// segment "reorder" (routing to updateLine with lineId="reorder" instead of reorderLines).
router.patch('/:id/line-items/reorder', canDo('update', 'Estimate'), validate(estimateLinesController.reorderSchema), estimateLinesController.reorderLines);
router.patch('/:id/line-items/:lineId', canDo('update', 'Estimate'), validate(estimateLinesController.updateLineSchema), estimateLinesController.updateLine);
router.delete('/:id/line-items/:lineId', canDo('update', 'Estimate'), estimateLinesController.deleteLine);

// Scopes of work (v12 unified line-items, plan §2a) — flat-priced, non-line-item blocks stored on
// Estimate.scopes (scopes.ts). estimateDetailSelect DOES embed scopes (unlike Job), but a
// dedicated GET is kept for parity with Job/Invoice's lighter per-scopes read. Same gating as
// line-items: list `read` Estimate; add/update/delete `update` Estimate.
router.get('/:id/scopes', canDo('read', 'Estimate'), estimateLinesController.listScopes);
// #2053 slice 1 — estimate-anchored schemas (addEstimateScopeSchema/updateEstimateScopeSchema),
// not the shared addScopeSchema/updateScopeSchema Job/Invoice's own scope routes still parse —
// see estimate-lines.controller.ts's module doc.
router.post('/:id/scopes', canDo('update', 'Estimate'), validate(estimateLinesController.addEstimateScopeSchema), estimateLinesController.addScope);
// MUST come BEFORE the ":idx" PATCH route below — same Express route-order gotcha as
// line-items/reorder above (":idx" would otherwise capture the literal path segment "reorder").
router.patch('/:id/scopes/reorder', canDo('update', 'Estimate'), validate(estimateLinesController.reorderScopeSchema), estimateLinesController.reorderScopes);
router.patch('/:id/scopes/:idx', canDo('update', 'Estimate'), validate(estimateLinesController.updateEstimateScopeSchema), estimateLinesController.updateScope);
router.delete('/:id/scopes/:idx', canDo('update', 'Estimate'), estimateLinesController.deleteScope);

// Scope-of-work photos (R5f, plan §2a follow-on). Gated the SAME `update` Estimate as
// every line/scope mutation above; the controller applies the SAME loadGuardedEstimate +
// isMutationBlocked gate. `withOrgContext` MUST come AFTER multer — multer's stream consumption
// drops the AsyncLocalStorage tenant scope (same ordering as inv-stages.routes.ts /
// attachment.routes.ts). Scope photo routes key on the scope's stable `id` (:scopeId), never the
// array index the existing PATCH/DELETE .../scopes/:idx routes use — index isn't stable identity.
router.post('/:id/scopes/:scopeId/photos', canDo('update', 'Estimate'), photoUpload.single('file'), photoMulterErrors, withOrgContext, estimatePhotosController.uploadScopePhoto);
router.delete('/:id/scopes/:scopeId/photos/:photoId', canDo('update', 'Estimate'), estimatePhotosController.deleteScopePhoto);

// PDF
router.get('/:id/pdf', expensiveLimiter, canDo('read', 'Estimate'), estimateController.getPdf);

// Notes
router.get('/:id/notes', canDo('read', 'Estimate'), estimateController.getNotes);
router.get('/:id/history', canDo('read', 'Estimate'), estimateController.getHistory);

// #2030 — past versions. READ-ONLY by construction: there is no write verb on these paths at
// all, so a version cannot be edited by anyone who guesses a URL. Gated on `read Estimate` plus
// the same per-row ownership check getPdf uses, so the route is shareable with a colleague in
// the same organization and resolves for nobody else.
router.get('/:id/versions', canDo('read', 'Estimate'), estimateController.listVersions);
router.get('/:id/versions/:version', canDo('read', 'Estimate'), estimateController.getVersion);
router.post('/:id/notes', canDo('update', 'Estimate'), validate(estimateController.createEstimateNoteSchema), estimateController.addNote);

// Tags (polymorphic)
// Tag routes take BOTH ids straight from the path into `where` clauses over Postgres
// `uuid` columns, so without these guards a stray segment makes the driver throw P2023
// and the controller's catch reports a 500 for what is only a bad URL. They sit AFTER
// canDo so a caller without the grant still gets 403 rather than learning whether the
// id was well-formed, and they return the SAME 404 text the handler gives for a row
// that genuinely is not there.
router.post('/:id/tags', canDo('update', 'Estimate'), requireUuidParam('id', 'estimate not found'), validate(tagController.addTagToEntitySchema), tagController.addTagToEstimate);
router.delete('/:id/tags/:tagId', canDo('update', 'Estimate'), requireUuidParam('id', 'estimate not found'), requireUuidParam('tagId', 'Tag not attached to this estimate'), tagController.removeTagFromEstimate);

export default router;
