import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as commController from '../controllers/comm-threads.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// A malformed :id (non-uuid) answers the SAME 404 as a missing/invisible
// thread, before Prisma ever runs (P2023 screen, R8) - one body, no
// enumeration oracle.
const threadId = requireUuidParam('id', 'Thread not found');
// The same screen for the other rows these routes name: a message, a template, a text automation. Each answers the 404 its handler
// gives a row that is not there.
const messageId = requireUuidParam('id', 'Message not found');
const templateId = requireUuidParam('id', 'Template not found');
const automationId = requireUuidParam('id', 'Automation not found');

// ─── Threads ────────────────────────────────────────────
// #2046: the list is the org-wide section surface, so it also requires access_inbox.
router.get('/threads', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listThreads);
// #2046 R1: by-id stays on `read Communication` alone - anchor-filtered exactly like
// GET /calls/:id (smsVisibility), and it is the record tabs' SMS drawer source (EntitySmsDrawer).
router.get('/threads/:id', canDo('read', 'Communication'), threadId, commController.getThread);
// #2049 - per-user read markers. Read-side rights only (`read Communication`
// alone, never `update`) + the anchor-filtered lookup getThread uses -
// mirrors the email thread-read re-gate. Two explicit paths rather than one
// body flag, matching the email sibling's own literal-path shape.
router.patch('/threads/:id/read', canDo('read', 'Communication'), threadId, commController.markThreadRead);
router.patch('/threads/:id/unread', canDo('read', 'Communication'), threadId, commController.markThreadUnread);
router.post('/threads', canDo('create', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.createThreadSchema), commController.createThread);
// Send SMS = append a Message to a thread. Record tab's composer - route-level gate stays
// `create Communication` alone. #2046 security round 1: the toNumber branch ALSO checks
// `access_inbox` inside the controller, but only when it would ORIGINATE a brand-new,
// unanchored thread (no existing thread for the number, no lead/job on the request) - the
// same org-wide-inbox action GET/POST /threads already gate. A reply into a thread the caller
// can already see, or a lead/job-anchored compose, is unaffected.
router.post('/sms', canDo('create', 'Communication'), validate(commController.sendMessageSchema), commController.sendMessage);
// One-click reassign of a message's job attribution (job_id: null clears → Unrouted tray).
router.patch('/sms/:id/job', canDo('attach', 'Communication'), messageId, validate(commController.reassignSmsJobSchema), commController.reassignMessageJob);
// Lead mirror of the job attach (full job-parity ruling, 2026-07-22; lead_id: null clears).
router.patch('/sms/:id/lead', canDo('attach', 'Communication'), messageId, validate(commController.reassignMessageLeadSchema), commController.reassignMessageLead);

// ─── Templates ──────────────────────────────────────────
// #2046 R2: GET /templates is also the compose window's signature source (ComposeWindow.tsx) -
// stays on `read Communication` alone (S08.16: no phone tab owns template reads, they stay with View communication).
// POST/PATCH/DELETE and the by-id read are the section's own
// editors (TextingView), so those get the second gate.
// Roles & Permissions S08.20: creating, changing and deleting a template is Edit communication records
// (`update Communication`), never Contact customers (`create`) or Delete communication records.
router.get('/templates', canDo('read', 'Communication'), commController.listTemplates);
router.post('/templates', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.createTemplateSchema), commController.createTemplate);
router.get('/templates/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), templateId, commController.getTemplate);
router.patch('/templates/:id', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), templateId, validate(commController.updateTemplateSchema), commController.updateTemplate);
router.delete('/templates/:id', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), templateId, commController.deleteTemplate);

// ─── Automations ────────────────────────────────────────
// #2046: automations are section-only config - no record-tab consumer exists.
// Roles & Permissions S01.10: text automations follow the Automations switches (View, Create, Edit, Delete
// automations) like every other automation, never Contact customers or the Communication record switches.
// The section gate stays: they are managed from the Communication section.
router.get('/automations', canDo('read', 'Automation'), canDo('access_inbox', 'Communication'), commController.listAutomations);
router.post('/automations', canDo('create', 'Automation'), canDo('access_inbox', 'Communication'), validate(commController.createAutomationSchema), commController.createAutomation);
router.get('/automations/:id', canDo('read', 'Automation'), canDo('access_inbox', 'Communication'), automationId, commController.getAutomation);
router.patch('/automations/:id', canDo('update', 'Automation'), canDo('access_inbox', 'Communication'), automationId, validate(commController.updateAutomationSchema), commController.updateAutomation);
router.delete('/automations/:id', canDo('delete', 'Automation'), canDo('access_inbox', 'Communication'), automationId, commController.deleteAutomation);

export default router;
