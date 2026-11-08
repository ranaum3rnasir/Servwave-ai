import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { featureDisabled } from '../middleware/featureDisabled';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as jobController from '../controllers/job.controller';
import * as jobCommunicationsController from '../controllers/job-communications.controller';
import * as jobLinesController from '../controllers/job-lines.controller';
import * as estimateController from '../controllers/estimate.controller';
import * as tagController from '../controllers/tag.controller';

const router = Router();

router.use(authenticate, attachAbility, attachCustomerScope);

// Stats (before :id to avoid route conflict)
router.get('/stats', canDo('read', 'Job'), jobController.getStats);

// Filter-aware "export all" — gated `read` (no `export` action for Job); reuses list row-scope.
router.get('/export', expensiveLimiter, canDo('read', 'Job'), jobController.exportAll);

// CRUD
router.get('/', canDo('read', 'Job'), jobController.list);
router.post('/', canDo('create', 'Job'), validate(jobController.createJobSchema), jobController.create);
// SRVW-104 - list-level bulk actions. bulk-status is route-gated `read Job` (coarse) because the
// authoritative verb gate varies per request body and is applied in the controller; a fixed route
// gate would falsely 403 a role granted one verb but not the gate's action. bulk-assign's gate is
// byte-identical to POST /:id/assignees below. Both carry expensiveLimiter: at the 100-id cap a
// single bulk-cancel is 500+ sequential queries plus 100 transactions in one HTTP request.
router.post('/bulk-status', expensiveLimiter, canDo('read', 'Job'), validate(jobController.bulkStatusJobsSchema), jobController.bulkStatus);
router.post('/bulk-assign', expensiveLimiter, canDo('assign', 'Job'), validate(jobController.bulkAssignJobsSchema), jobController.bulkAssign);
router.get('/:id', canDo('read', 'Job'), jobController.getById);
router.patch('/:id', canDo('update', 'Job'), validate(jobController.updateJobSchema), jobController.update);
router.delete('/:id', canDo('delete', 'Job'), jobController.remove);

// Editable record IDs (plan decision #7) - preview is read-only (no lock); rename is the real
// write, gated identically. Both route-gated `renumber Job` (DISPATCHER by default, ADMIN via
// manage-all); the controller adds the per-instance canActOnRow check on top.
router.post('/:id/number/preview', canDo('renumber', 'Job'), validate(jobController.jobNumberSchema), jobController.previewNumber);
router.patch('/:id/number', canDo('renumber', 'Job'), validate(jobController.jobNumberSchema), jobController.renumber);

// Status actions
router.post('/:id/assign', canDo('assign', 'Job'), validate(jobController.assignJobSchema), jobController.assign);
// Crew-only REPLACE (no schedule/status side effects)
router.post('/:id/assignees', canDo('assign', 'Job'), validate(jobController.setAssigneesSchema), jobController.setAssignees);
// Dispatcher set/clear (#291 — JCC Team card); same 'assign' Job gate as the crew routes.
router.post('/:id/dispatcher', canDo('assign', 'Job'), validate(jobController.setDispatcherSchema), jobController.setDispatcher);
// SRVW-112 - set/clear the org-defined sub-status. Gated `update Job`, matching the
// POST /:id/notes precedent below; the controller adds the per-instance canAccessRow check.
router.post('/:id/sub-status', canDo('update', 'Job'), validate(jobController.setSubStatusSchema), jobController.setSubStatus);
// S7: validated now that the body carries the D23 notify object. The schema is all-optional, so
// the bodyless callers this route has always had are unaffected - but a malformed recipient or
// an over-long message is rejected here rather than at the provider.
router.post('/:id/unassign', canDo('unassign', 'Job'), validate(jobController.unassignJobSchema), jobController.unassign);
router.post('/:id/en-route', canDo('en_route', 'Job'), jobController.enRoute);
router.post('/:id/arrive', canDo('arrive', 'Job'), jobController.arrive);
router.post('/:id/start', canDo('start', 'Job'), jobController.start);
router.post('/:id/complete', canDo('complete', 'Job'), validate(jobController.completeJobSchema), jobController.complete);
router.post('/:id/cancel', canDo('cancel', 'Job'), validate(jobController.cancelJobSchema), jobController.cancel);
router.post('/:id/reopen', canDo('reopen', 'Job'), jobController.reopen);
// SRVW-87 - one door for "set this job's status", dispatching into the verb handlers above.
// The outer gate is the coarse `read Job` on purpose: every role default and every per-user
// capability that grants a Job verb also implies read, so a stricter outer gate (e.g. `update`)
// would falsely 403 a holder of a verb without update. The REAL authorization is the per-verb
// can() inside setStatus, so this is not a way around the sibling routes' guards.
router.post('/:id/status', canDo('read', 'Job'), validate(jobController.setStatusSchema), jobController.setStatus);
router.post('/:id/duplicate', canDo('create', 'Job'), jobController.duplicate);

// Visits (multi-visit S2) - the nested collection, alongside the status actions above.
// Gated `reschedule Job` (DISPATCHER-only by default), matching what PATCH /:id already enforces
// through changesSchedule: a visits route gated any looser would be a route around that gate for
// every technician. Note the deliberate asymmetry with POST /:id/assign, which first-books under
// `assign Job` - stricter is the safe direction and /assign is untouched by S2.
router.get('/:id/visits', canDo('read', 'Job'), jobController.listVisits);
router.post('/:id/visits', canDo('reschedule', 'Job'), validate(jobController.createJobVisitSchema), jobController.createVisit);
router.patch('/:id/visits/:visitId', canDo('reschedule', 'Job'), validate(jobController.rescheduleJobVisitSchema), jobController.rescheduleVisit);
// Crew-only REPLACE on ONE trip (visits-and-task-categories slice 02) - the per-visit twin of
// POST /:id/assignees, served by the same handler. Gated `assign Job` like that door, NOT
// `reschedule Job` like its siblings here: naming crew is an `assign` fact, and routing the board's
// crew swap through PATCH above would have refused every `assign`-only holder (a technician on a
// job they created, a salesperson on one from their estimate) who can re-crew through /assignees
// today - and would have sent the customer a "rescheduled" notice for a trip that did not move.
router.post('/:id/visits/:visitId/assignees', canDo('assign', 'Job'), requireUuidParam('visitId', 'Visit not found'), validate(jobController.setAssigneesSchema), jobController.setAssignees);

// Visit lifecycle (multi-visit S4, D7/D7a). Gated the same subject-level `start Job` the job-level
// /:id/start route uses - technicians hold it by default and keep it under D15 - with the finer
// "is this principal crew on THIS visit" check inside the handler, because canDo is subject-level
// and the stored OWN_JOB row scope, though it now points at the visits path (S8), is a JOB-level
// question - "are you on any of this job's trips" - not the per-visit one these four routes ask.
router.post('/:id/visits/:visitId/start', canDo('start', 'Job'), jobController.startVisit);
router.post('/:id/visits/:visitId/en-route', canDo('en_route', 'Job'), jobController.enRouteVisit);
router.post('/:id/visits/:visitId/arrive', canDo('arrive', 'Job'), jobController.arriveVisit);
router.post('/:id/visits/:visitId/complete', canDo('start', 'Job'), jobController.completeVisit);
// Cancelling a booking is dispatch work, so this one rides `reschedule Job` like its sibling
// visits routes rather than the crew gate the three milestone verbs use.
router.post('/:id/visits/:visitId/cancel', canDo('reschedule', 'Job'), validate(jobController.cancelVisitSchema), jobController.cancelVisit);

// Charges — REMOVED (entity-redesign §5 / Phase D). The invoice owns its lines (InvoiceLineItem);
// the JobCharge model is dropped. No /:id/charges routes remain.

// Line items (SERV10X-38 — job-owned items; a running pre-invoice tally, Items tab, Task 6).
// add/edit/delete gated `manage_lines` Job; list is the lighter `read` Job. canAccessRow(Job)
// per-instance inside the controller either way.
//
// These reused `update Job` until the technician-ownership spec (Part C): one action gated job
// fields, line items, scopes, notes AND tags, and the spec needs notes/tags to stay with the
// assignee while the money surface follows creation. `manage_lines Job` mirrors the
// `manage_lines Invoice` that already existed. The split itself is behaviour-neutral - every
// principal holding `update Job` was granted `manage_lines Job` under the same condition
// (defaultGrants.ts for new orgs, 20260805130000_job_manage_lines_grant_backfill for existing).
router.get('/:id/line-items', canDo('read', 'Job'), jobLinesController.list);
router.post('/:id/line-items', canDo('manage_lines', 'Job'), validate(jobLinesController.addLineSchema), jobLinesController.addLine);
// Sync-with-inventory (Inventory P1 §3.2 / D1): PARKED (LO-4). Logistic Orders now own all stock
// deduction, so these routes answer 404 FEATURE_DISABLED. The handlers stay dormant in the
// controller (bulkSyncStock/syncStockLine) so un-parking is a one-line revert. Auth still runs
// first (router-level authenticate/attachAbility). Registration stays ABOVE the ":lineId" param
// routes for the literal-segment shadowing reason below.
router.post('/:id/line-items/sync-stock', featureDisabled('line_stock_sync'));
router.post('/:id/line-items/:lineId/sync-stock', featureDisabled('line_stock_sync'));
// MUST come BEFORE the ":lineId" PATCH route below — Express matches routes in registration
// order, and ":lineId" is just a param placeholder that would otherwise capture the literal
// path segment "reorder" (routing to updateLine with lineId="reorder" instead of reorderLines).
router.patch('/:id/line-items/reorder', canDo('manage_lines', 'Job'), validate(jobLinesController.reorderSchema), jobLinesController.reorderLines);
router.patch('/:id/line-items/:lineId', canDo('manage_lines', 'Job'), validate(jobLinesController.updateLineSchema), jobLinesController.updateLine);
router.delete('/:id/line-items/:lineId', canDo('manage_lines', 'Job'), jobLinesController.deleteLine);

// Scopes of work (Stage 5/6 — flat-priced, non-line-item blocks stored on Job.scopes,
// scopes.ts). jobDetailSelect doesn't embed them either (same reason line-items gets its own
// GET above) — unlike Invoice, which folds scopes into invoiceDetailSelect, Job needs its own
// explicit GET /:id/scopes route. Same gating as line-items: list `read` Job; add/update/
// delete `manage_lines` Job (see the split note above the line-item routes).
//
// NOTE the deliberate difference from Invoice: invoice scopes split POST/DELETE (manage_lines)
// from PATCH (update), because SALES holds manage_lines Invoice without update Invoice. Job has
// no such asymmetric role, so all four job-scope writes take the same gate - a scope's flat_price
// is money whichever verb writes it.
router.get('/:id/scopes', canDo('read', 'Job'), jobLinesController.listScopes);
router.post('/:id/scopes', canDo('manage_lines', 'Job'), validate(jobLinesController.addScopeSchema), jobLinesController.addScope);
// MUST come BEFORE the ":idx" PATCH route below — same Express route-order gotcha as
// line-items/reorder above (":idx" would otherwise capture the literal path segment "reorder").
router.patch('/:id/scopes/reorder', canDo('manage_lines', 'Job'), validate(jobLinesController.reorderScopeSchema), jobLinesController.reorderScopes);
router.patch('/:id/scopes/:idx', canDo('manage_lines', 'Job'), validate(jobLinesController.updateScopeSchema), jobLinesController.updateScope);
router.delete('/:id/scopes/:idx', canDo('manage_lines', 'Job'), jobLinesController.deleteScope);

// Explicit "Create Invoice" from a job's owned items (SERV10X-38 Task 5) — flat draw or
// itemized, multiple invoices per job allowed and over-billing allowed (Spec B1 removed both
// guards). Deposit-credit draw-down plus SRVW-85's already-billed-line check on the itemized
// path live in the controller.
// Gated `create Invoice` (not `update Job` - this creates an
// Invoice, not a JobLineItem); canAccessRow(Job) per-instance inside the controller.
router.post('/:id/invoices', canDo('create', 'Invoice'), validate(jobController.createInvoiceFromJobSchema), jobController.createInvoiceFromJob);

// "Create estimate from items" (SERV10X-60 Part B, job-items-estimate-parity) - copies this
// job's own job_line_items/scopes into a NEW job-anchored estimate, numbered in the same
// `J00007-1` container the generic job-anchor estimate create() uses. Gated `create Estimate`
// (this creates an Estimate, not a JobLineItem); canAccessRow-equivalent (F-004 own-job scope)
// enforced inside the controller, mirroring estimate.controller.create()'s job-anchor branch.
router.post('/:id/estimates', canDo('create', 'Estimate'), validate(estimateController.createFromJobItemsSchema), estimateController.createFromJobItems);

// Notes
router.get('/:id/notes', canDo('read', 'Job'), jobController.getNotes);
router.post('/:id/notes', canDo('update', 'Job'), validate(jobController.noteSchema), jobController.addNote);

// Job-level walkthrough route REMOVED (scheduler redesign §5.8) — walkthroughs live on the lead.

// Timeline
router.get('/:id/timeline', canDo('read', 'Job'), jobController.getTimeline);

// Financials (Payments tab + lifecycle status-bar source)
router.get('/:id/financials', canDo('read', 'Job'), jobController.getFinancials);

// Communications (Communication ↔ Jobs — per-message job attribution)
router.get('/:id/communications', canDo('read', 'Communication'), jobCommunicationsController.getJobCommunications);

// Tags on jobs (polymorphic tag_assignments)
// Tag routes take BOTH ids straight from the path into `where` clauses over Postgres
// `uuid` columns, so without these guards a stray segment makes the driver throw P2023
// and the controller's catch reports a 500 for what is only a bad URL. They sit AFTER
// canDo so a caller without the grant still gets 403 rather than learning whether the
// id was well-formed, and they return the SAME 404 text the handler gives for a row
// that genuinely is not there.
router.post('/:id/tags', canDo('update', 'Job'), requireUuidParam('id', 'job not found'), validate(tagController.addTagToEntitySchema), tagController.addTagToJob);
router.delete('/:id/tags/:tagId', canDo('update', 'Job'), requireUuidParam('id', 'job not found'), requireUuidParam('tagId', 'Tag not attached to this job'), tagController.removeTagFromJob);

export default router;
