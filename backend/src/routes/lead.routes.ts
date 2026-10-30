import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { requireFeature } from '../middleware/requireFeature';
import { canDo, canDoAnyOrLeadCreator, canDoOrLeadCreator } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as leadController from '../controllers/lead.controller';
import * as jobCommunicationsController from '../controllers/job-communications.controller';
import * as tagController from '../controllers/tag.controller';
import * as contactEntriesController from '../controllers/record-contact-entries.controller';
import * as recordNotesController from '../controllers/record-notes.controller';
import { refuseWhenLeadClosed } from '../lib/permissions/leadLock';

const router = Router();

router.use(authenticate, requireFeature('leads'), attachAbility, attachCustomerScope);

// Stats & lookups (before :id to avoid route conflict)
router.get('/stats', canDo('read', 'Lead'), leadController.getStats);
// Filter-aware "export all" — gated by the module's Export switch (`export Lead`), not View; reuses list row-scope.
router.get('/export', expensiveLimiter, canDo('export', 'Lead'), leadController.exportAll);
// The new-lead form's pre-filled Owner and Dispatcher: the creator rule's answer for the person asking.
router.get('/creator-prefill', canDo('create', 'Lead'), leadController.getCreatorPrefill);

// CRUD
// No `read` guard on the list: a person with View leads off gets an empty list, not a 403. The list's
// row scope (scopeWhereForReq) reaches nothing without the read grant, so it is the one thing that decides.
router.get('/', leadController.list);
router.post('/', canDo('create', 'Lead'), validate(leadController.createLeadSchema), leadController.create);
router.get('/:id', canDo('read', 'Lead'), leadController.getById);
// A person with Edit leads, or the lead's creator while they are still on it (the handler limits the creator's fields).
router.patch('/:id', canDoOrLeadCreator(), leadController.refuseCancelledLeadStatus, validate(leadController.updateLeadSchema), leadController.update);
router.delete('/:id', canDo('delete', 'Lead'), leadController.remove);

// Editable record ID (decision #7) - preview is read-only/no-lock, rename is the write.
router.post('/:id/number/preview', canDo('renumber', 'Lead'), validate(leadController.leadNumberSchema), leadController.previewNumber);
router.patch('/:id/number', canDo('renumber', 'Lead'), validate(leadController.leadNumberSchema), leadController.renameNumber);

// Notes
router.get('/:id/notes', canDo('read', 'Lead'), leadController.getNotes);
// Adding a note checks Add notes, not Edit leads (S01.11); the controller adds the per-instance canAccessRow check.
router.post('/:id/notes', canDo('add_note', 'Lead'), validate(leadController.createLeadNoteSchema), leadController.addNote);
// Deleting a note (S04.25): the author's own, or anyone's with Delete other people's notes. A closed lead's notes delete
// like any other (the closed-lead lock covers only the lead's contact entries).
router.delete('/:id/notes/:noteId', canDo('read', 'Lead'), requireUuidParam('id', 'Lead not found'), requireUuidParam('noteId', 'Note not found'), recordNotesController.deleteLeadNote);

// Communications (Communication ↔ Leads — lead_id ∪ customer_id union roll-up)
router.get('/:id/communications', canDo('read', 'Communication'), jobCommunicationsController.getLeadCommunications);
// Timeline (#585)
router.get('/:id/timeline', canDo('read', 'Lead'), leadController.getTimeline);

// Actions
router.post('/:id/assign', canDo('assign', 'Lead'), validate(leadController.assignLeadSchema), leadController.assign);
// The lead's Dispatcher (PRD 3): the same Assign people to leads gate as the Owner.
router.post('/:id/dispatcher', canDo('assign', 'Lead'), validate(leadController.setLeadDispatcherSchema), leadController.setDispatcher);
// Spec #1751 D5 - REINSTATED, re-scoped as a CORRECTION. A lead normally becomes contacted
// automatically now (outbound call / text / human-written email); this door is for outreach that
// happened outside the platform, and for fixing a stamp the automatic detection got wrong. It is
// the only writer in the spec allowed to overwrite a clock, and the only one that records who did.
// `contact` is the grant this route always used - it survived the route's removal and is still in
// the catalog and in SALES's (own-lead) and DISPATCHER's default grants.
router.post('/:id/contact', canDo('contact', 'Lead'), validate(leadController.contactLeadSchema), leadController.contactLead);
router.post('/:id/mark-lost', canDo('mark_lost', 'Lead'), validate(leadController.markLostSchema), leadController.markLost);
// Reopen a Won or Lost lead (PRD 5, S05.19): Reopen leads, whatever Change lead status by hand says.
router.post('/:id/reopen', canDo('reopen', 'Lead'), requireUuidParam('id', 'Lead not found'), validate(leadController.reopenLeadSchema), leadController.reopen);

// Walkthrough actions
router.post('/:id/walkthrough', canDo('perform_walkthrough', 'Lead'), validate(leadController.walkthroughSchema), leadController.updateWalkthrough);
router.post('/:id/walkthrough/schedule', canDo('schedule_walkthrough', 'Lead'), validate(leadController.scheduleWalkthroughSchema), leadController.scheduleWalkthrough);
// Performer-only REPLACE (no schedule/status side effects)
router.post('/:id/walkthrough/performers', canDo('schedule_walkthrough', 'Lead'), validate(leadController.setPerformersSchema), leadController.setPerformers);
// Clear the schedule but keep the performers
router.post('/:id/walkthrough/unschedule', canDo('schedule_walkthrough', 'Lead'), leadController.unscheduleWalkthrough);
router.post('/:id/walkthrough/complete', canDo('perform_walkthrough', 'Lead'), leadController.completeWalkthrough);
router.post('/:id/walkthrough/cancel', canDo('schedule_walkthrough', 'Lead'), validate(leadController.cancelWalkthroughSchema), leadController.cancelWalkthrough);

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
router.post('/:id/tags', canDoOrLeadCreator(), requireUuidParam('id', 'lead not found'), validate(tagController.addTagToLeadSchema), tagController.addTagToLead);
router.delete('/:id/tags/:tagId', canDoOrLeadCreator(), requireUuidParam('id', 'lead not found'), requireUuidParam('tagId', 'Tag not attached to this lead'), tagController.removeTagFromLead);

// A lead's own phone, email, name and company, changed with the pencil (PRD 5, S05.13): the job's four endpoints, on the
// lead. Either Edit job and lead contact details or Edit leads lets a person in for a phone or email, and the lead's
// creator still on it counts as Edit leads; a name or company needs Edit leads (or that creator). The handler then asks
// whether the lead opens for them. The customer record is never written. A closed lead (Won or Lost) takes none of
// them from anyone (S05.14); the lock sits after the switch guard, so a person without the switch is told that first.
const canEditLeadContact = canDoAnyOrLeadCreator([['edit_contact_details', 'Lead'], ['update', 'Lead']]);
router.post('/:id/contact-entries', canEditLeadContact, requireUuidParam('id', 'Lead not found'), refuseWhenLeadClosed(), validate(contactEntriesController.addContactEntrySchema), contactEntriesController.leadEntries.addEntry);
router.post('/:id/contact-entries/change', canEditLeadContact, requireUuidParam('id', 'Lead not found'), refuseWhenLeadClosed(), validate(contactEntriesController.changeContactEntrySchema), contactEntriesController.leadEntries.changeEntry);
router.post('/:id/contact-entries/name', canDoOrLeadCreator(), requireUuidParam('id', 'Lead not found'), refuseWhenLeadClosed(), validate(contactEntriesController.changeNameSchema), contactEntriesController.leadEntries.changeName);
// Correcting or removing an entry: the same gate as making one of that kind, whoever added it. The handler asks the
// entry's kind too, since a name entry needs Edit leads.
router.patch('/:id/contact-entries/:entryId', canEditLeadContact, requireUuidParam('id', 'Lead not found'), requireUuidParam('entryId', 'Contact detail not found'), refuseWhenLeadClosed(), validate(contactEntriesController.correctContactEntrySchema), contactEntriesController.leadEntries.correctEntry);
router.delete('/:id/contact-entries/:entryId', canEditLeadContact, requireUuidParam('id', 'Lead not found'), requireUuidParam('entryId', 'Contact detail not found'), refuseWhenLeadClosed(), contactEntriesController.leadEntries.removeEntry);

export default router;
