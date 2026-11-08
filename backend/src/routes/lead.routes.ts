import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as leadController from '../controllers/lead.controller';
import * as jobCommunicationsController from '../controllers/job-communications.controller';
import * as tagController from '../controllers/tag.controller';

const router = Router();

router.use(authenticate, requireFeature('leads'), attachAbility, attachCustomerScope);

// Stats & lookups (before :id to avoid route conflict)
router.get('/stats', canDo('read', 'Lead'), leadController.getStats);
// Filter-aware "export all" — gated `read` (no `export` action for Lead); reuses list row-scope.
router.get('/export', expensiveLimiter, canDo('read', 'Lead'), leadController.exportAll);

// CRUD
router.get('/', canDo('read', 'Lead'), leadController.list);
router.post('/', canDo('create', 'Lead'), validate(leadController.createLeadSchema), leadController.create);
router.get('/:id', canDo('read', 'Lead'), leadController.getById);
router.patch('/:id', canDo('update', 'Lead'), validate(leadController.updateLeadSchema), leadController.update);
router.delete('/:id', canDo('delete', 'Lead'), leadController.remove);

// Editable record ID (decision #7) - preview is read-only/no-lock, rename is the write.
router.post('/:id/number/preview', canDo('renumber', 'Lead'), validate(leadController.leadNumberSchema), leadController.previewNumber);
router.patch('/:id/number', canDo('renumber', 'Lead'), validate(leadController.leadNumberSchema), leadController.renameNumber);

// Notes
router.get('/:id/notes', canDo('read', 'Lead'), leadController.getNotes);
router.post('/:id/notes', canDo('update', 'Lead'), validate(leadController.createLeadNoteSchema), leadController.addNote);

// Communications (Communication ↔ Leads — lead_id ∪ customer_id union roll-up)
router.get('/:id/communications', canDo('read', 'Communication'), jobCommunicationsController.getLeadCommunications);
// Timeline (#585)
router.get('/:id/timeline', canDo('read', 'Lead'), leadController.getTimeline);

// Actions
router.post('/:id/assign', canDo('assign', 'Lead'), validate(leadController.assignLeadSchema), leadController.assign);
// Spec #1751 D5 - REINSTATED, re-scoped as a CORRECTION. A lead normally becomes contacted
// automatically now (outbound call / text / human-written email); this door is for outreach that
// happened outside the platform, and for fixing a stamp the automatic detection got wrong. It is
// the only writer in the spec allowed to overwrite a clock, and the only one that records who did.
// `contact` is the grant this route always used - it survived the route's removal and is still in
// the catalog and in SALES's (own-lead) and DISPATCHER's default grants.
router.post('/:id/contact', canDo('contact', 'Lead'), validate(leadController.contactLeadSchema), leadController.contactLead);
router.post('/:id/mark-lost', canDo('mark_lost', 'Lead'), validate(leadController.markLostSchema), leadController.markLost);
router.post('/:id/cancel', canDo('cancel', 'Lead'), validate(leadController.cancelLeadSchema), leadController.cancelLead);

// Walkthrough actions
router.post('/:id/walkthrough', canDo('perform_walkthrough', 'Lead'), validate(leadController.walkthroughSchema), leadController.updateWalkthrough);
router.post('/:id/walkthrough/schedule', canDo('schedule_walkthrough', 'Lead'), validate(leadController.scheduleWalkthroughSchema), leadController.scheduleWalkthrough);
// Performer-only REPLACE (no schedule/status side effects)
router.post('/:id/walkthrough/performers', canDo('schedule_walkthrough', 'Lead'), validate(leadController.setPerformersSchema), leadController.setPerformers);
// Clear the schedule but keep the performers
router.post('/:id/walkthrough/unschedule', canDo('schedule_walkthrough', 'Lead'), leadController.unscheduleWalkthrough);
router.post('/:id/walkthrough/complete', canDo('perform_walkthrough', 'Lead'), leadController.completeWalkthrough);
router.post('/:id/walkthrough/cancel', canDo('cancel', 'Lead'), validate(leadController.cancelWalkthroughSchema), leadController.cancelWalkthrough);

// Visits (multi-visit S1) - the nested collection, alongside the single-visit actions above.
// POST /visits books an ADDITIONAL visit; /walkthrough/schedule reschedules the active one.
router.get('/:id/visits', canDo('read', 'Lead'), leadController.listVisits);
router.post('/:id/visits', canDo('schedule_walkthrough', 'Lead'), validate(leadController.createVisitSchema), leadController.createVisit);
// Per-visit twins of the three /walkthrough/* doors above (visits-and-task-categories slice 03):
// the SAME handlers, gates and bodies, acting on the NAMED trip instead of the lead's current one,
// so the scheduler's one-card-per-walkthrough board moves, re-crews and unschedules the card that
// was touched. The uuid guard answers a malformed visit id with the handler's own 404 rather than
// letting Postgres' uuid cast 500 it; it sits after canDo so a caller without the grant still gets 403.
router.patch('/:id/visits/:visitId', canDo('schedule_walkthrough', 'Lead'), requireUuidParam('visitId', 'Visit not found'), validate(leadController.scheduleWalkthroughSchema), leadController.scheduleWalkthrough);
router.post('/:id/visits/:visitId/performers', canDo('schedule_walkthrough', 'Lead'), requireUuidParam('visitId', 'Visit not found'), validate(leadController.setPerformersSchema), leadController.setPerformers);
router.post('/:id/visits/:visitId/unschedule', canDo('schedule_walkthrough', 'Lead'), requireUuidParam('visitId', 'Visit not found'), leadController.unscheduleWalkthrough);

// Tags on leads
// Tag routes take BOTH ids straight from the path into `where` clauses over Postgres
// `uuid` columns, so without these guards a stray segment makes the driver throw P2023
// and the controller's catch reports a 500 for what is only a bad URL. They sit AFTER
// canDo so a caller without the grant still gets 403 rather than learning whether the
// id was well-formed, and they return the SAME 404 text the handler gives for a row
// that genuinely is not there.
router.post('/:id/tags', canDo('update', 'Lead'), requireUuidParam('id', 'lead not found'), validate(tagController.addTagToLeadSchema), tagController.addTagToLead);
router.delete('/:id/tags/:tagId', canDo('update', 'Lead'), requireUuidParam('id', 'lead not found'), requireUuidParam('tagId', 'Tag not attached to this lead'), tagController.removeTagFromLead);

export default router;
