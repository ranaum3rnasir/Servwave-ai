import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as commController from '../controllers/comm-whatsapp-email.controller';
import * as commAgentsController from '../controllers/comm-agents.controller';
import * as myMailboxController from '../controllers/my-mailbox.controller';
import * as mailboxListController from '../controllers/mailbox-list.controller';
import { MAX_EMAIL_ATTACHMENTS, MAX_EMAIL_ATTACHMENT_BYTES } from '../lib/email-attachment-limits';
import { markRouteCheck } from '../middleware/routeCheck';

const router = Router();

// Email.id is a Postgres `uuid`: a malformed :id would reach Prisma and throw P2023, which the handler's catch turns into a 500.
// It answers the same 404 'Email not found' as a message that is not there, before Prisma runs. Per route, not router-wide:
// the literal '/emails/thread-read' style siblings share this prefix and their segment is not an id.
const emailId = requireUuidParam('id', 'Email not found');

// POST /emails is multipart/form-data (email slice 7 - the Resend send path):
// compose fields ride as regular text fields, files ride under `files`. Same
// per-file cap as attachment.routes.ts; `withOrgContext` MUST come immediately
// after multer - multer's stream consumption drops the AsyncLocalStorage tenant
// scope (same ordering as attachment.routes.ts / inv-stages.routes.ts).
const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_EMAIL_ATTACHMENT_BYTES, // 25MB per file
    // `files` is what actually makes an over-count reportable AS an over-count. multer only
    // raises LIMIT_FILE_COUNT from busboy's `filesLimit` event, and busboy only emits that
    // when this key is set (make-middleware.js: `busboy.on('filesLimit', ...)`). The count
    // in `.array('files', MAX_EMAIL_ATTACHMENTS)` below does NOT reach busboy — it is
    // multer's own per-field tally, and exceeding it raises LIMIT_UNEXPECTED_FILE, so an
    // 11th attachment used to be reported as a malformed upload rather than as one file
    // over the limit. Both numbers are the same ceiling and must stay in step.
    files: MAX_EMAIL_ATTACHMENTS,
  },
});

// The only multipart route that takes MORE than one file, so the only one where
// LIMIT_FILE_COUNT is reachable at all — hence `maxFiles`, which lets that branch name the
// real ceiling instead of a vague "too many". A file arriving under an unexpected FIELD
// name still raises LIMIT_UNEXPECTED_FILE and answers 400; the two cases are distinct now
// that `limits.files` is set. There is no second size check behind multer on this path, so
// the 25MB it aborts at IS the per-file limit the sender is subject to.
const emailMulterErrors = multerErrorHandler({
  tooLarge: `That file is too large to attach. Email attachments can be up to ${megabytes(MAX_EMAIL_ATTACHMENT_BYTES)} each.`,
  maxFiles: MAX_EMAIL_ATTACHMENTS,
});

/**
 * Email is its own entitlement (STARTER, on by default for every org) - it used
 * to ride on PRO `phone` along with the rest of the Communication module.
 *
 * The gate is PATH-SCOPED, not a bare `router.use(...)`. Every comm-* router is
 * mounted on the same /api/communication base, so a bare router-level gate runs
 * for EVERY request under that prefix, including paths this router owns no route
 * for - which would then be answered 402 here instead of falling through to the
 * router that does own them. That was invisible while all eight routers gated on
 * the same key; it stops being invisible the moment two keys coexist.
 *
 * '/emails' as a `use` prefix also covers '/emails/:id' and
 * '/emails/thread-read'; it does NOT cover '/email-groups' (segment boundary),
 * hence both entries.
 *
 * '/forward-rules' lives here rather than beside the phone agents because
 * listForwardRules reads the email_forward_rules table - it is email data that
 * happened to be declared next to the telephony routes.
 */
const EMAIL_PREFIXES = ['/emails', '/email-groups', '/forward-rules', '/sending-identity', '/my-mailbox', '/mailboxes'];

router.use(EMAIL_PREFIXES, authenticate, requireFeature('email'), attachAbility);

// M7 (ticket 36): Show Email is a permission, not a hidden button. It closes the Email page's mailbox the way Access Communication
// does: every route below that asks for `access_inbox` asks for `show_email` too, so a person with the switch off gets a 403 on
// the list, a message, filing and assigning a conversation, the attachments, the mailbox list and their own address. The routes
// the job, lead and customer tabs also use (the sender line, a send, the attach list, filing one email under a job or lead) ask
// for neither: they stay with Contact customers and Attach conversations, as for a person with no section. A reply, or a send
// that names no record, is the Email page's, and sendEmail refuses it to a person with the switch off (see its first lines).
// permission-show-email-guard.test.ts fails on a route here that asks for the section and not the switch, and on a route that
// asks for neither without being declared a record-tab route.

// ─── Sending identity ───────────────────────────────────
// The From a send would carry, resolved without sending, so the compose window
// can name it. Its own prefix rather than a path under '/emails' - '/emails' as
// a `use` prefix would cover it, but GET '/emails/:id' would then swallow the
// route itself (the same ordering trap '/emails/thread-read' already has a
// regression test for).
// #2046 R2: this is also the compose window's From resolver (CustomerDetailPage, EmailSenderPage)
// - stays on `read Communication` alone.
router.get('/sending-identity', canDo('read', 'Communication'), commController.getSendingIdentity);

// ─── The person's own mailbox ───────────────────────────
// PRD 10 (S10.3): the address shown at the top of the Email page and on the person's profile. Their own, and it reads no
// mail, but it is part of the Communication section: a person who cannot open the section has no use for an address
// there, and the section gate closes every endpoint of it.
router.get('/my-mailbox', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), myMailboxController.getMyMailbox);

// ─── The mailbox list ───────────────────────────────────
// PRD 10 (S10.7): the Email page's rail. It counts mail, so it is closed by the section gate like every mailbox endpoint.
router.get('/mailboxes', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), mailboxListController.listMailboxes);

// ─── Email groups ───────────────────────────────────────
// #2046: section-only config, no record-tab consumer.
router.get('/email-groups', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listEmailGroups);

// ─── Forward rules ──────────────────────────────────────
// Roles & Permissions S08.16: not a phone tab. These are the email forward-rules table, so no phone tab switch gates
// the read (PRD 08 lists only call flows, call groups, training and blocked callers as tab endpoints).
router.get('/forward-rules', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commAgentsController.listForwardRules);

// ─── Emails ─────────────────────────────────────────────
// #2046: the inbox list is the org-wide section surface.
router.get('/emails', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listEmails);
// #2046 R2: the record tabs' send path (useSendJobEmail/useSendEmail, JobCommunicationsTab +
// CustomerDetailPage) and the lead contact-clock flow (lead-contact-clock.test.ts) - stays on
// `create Communication` alone.
router.post(
  '/emails',
  canDo('create', 'Communication'),
  emailUpload.array('files', MAX_EMAIL_ATTACHMENTS),
  emailMulterErrors,
  withOrgContext,
  validate(commController.sendEmailSchema),
  commController.sendEmail,
);
// MUST stay above '/emails/:id' - a literal path registered after a param route
// on the same method+prefix is swallowed by the param route.
// #2049 re-gate: `markThreadRead`'s controller only ever creates a per-user read
// marker (filtered by the Communication scope read rule, already exactly the rows the
// caller can read) - `update`+`access_inbox` was the wrong gate (SALES 403'd on any thread_id
// despite holding `read Communication`, the issue's headline defect). Read-side
// rights only, mirroring the new SMS thread-read route. #2046's thread-level
// WORKFLOW routes (assign/archive/snooze) keep `update`+`access_inbox` - unchanged.
// PRD 10 (S10.7): a mailbox endpoint like the list, so the section gate closes it too (only the Email page calls it).
router.patch('/emails/thread-read', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.markThreadReadSchema), commController.markThreadRead);
// #2049 - the persisted half of "Mark as unread" (deletes this caller's
// EmailReadState rows for the visible emails of the thread). MUST also stay
// above '/emails/:id' for the same swallowing reason. Same gate as thread-read.
router.patch('/emails/thread-unread', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.markThreadUnreadSchema), commController.markThreadUnread);
// Email slice 8b - conversation assignment + shared archive/snooze. These have
// MORE path segments than '/emails/:id' (which matches exactly one segment
// after '/emails/'), so they never collide with it regardless of registration
// order - kept up here anyway, beside thread-read, since they are the other
// thread-level (not per-message) mutations.
router.patch('/emails/threads/:id/assign', canDo('show_email', 'Communication'), canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.assignEmailThreadSchema), commController.assignEmailThread);
router.patch('/emails/threads/:id/archive', canDo('show_email', 'Communication'), canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.archiveEmailThreadSchema), commController.archiveEmailThread);
router.patch('/emails/threads/:id/snooze', canDo('show_email', 'Communication'), canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.snoozeEmailThreadSchema), commController.snoozeEmailThread);
// "Attach from this record" (email slice 7) - MUST also stay above '/emails/:id'
// for the same reason as thread-read above: a literal path is swallowed by a
// param route registered before it.
// #2046 R2: useAttachSources -> ComposeWindow.tsx, rendered by CustomerDetailPage - not gated.
router.get('/emails/attach-source', canDo('read', 'Communication'), commController.listAttachSources);
// Email slice 6 - the unmatched inbound queue. Literal path, so it MUST stay
// above '/emails/:id' for the same reason as thread-read and attach-source:
// registered after the param route, 'unmatched' is swallowed as an id.
// #2046: the unmatched queue is section-only triage.
router.get('/emails/unmatched', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listUnmatchedEmails);
// One held message by id: what the bell of a reply from an address we did not send to opens (PRD 10, S10.19). Two segments after
// '/emails/', so it never meets '/emails/:id', whatever the order.
router.get('/emails/unmatched/:id', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), emailId, commController.getUnmatchedEmail);
// One-click reassign of an email's job attribution (job_id: null clears) - the
// email mirror of PATCH /sms/:id/job.
// #2046 R3: useReassignEmailJob -> components/communication/shared/CommRowJobControl.tsx, which
// renders inside all three record tabs - not gated.
router.patch('/emails/:id/job', canDo('attach', 'Communication'), emailId, validate(commController.reassignEmailJobSchema), commController.reassignEmailJob);
// The lead mirror of the job attach (lead_id: null clears). Same record-tab consumer, so not gated either.
router.patch('/emails/:id/lead', canDo('attach', 'Communication'), emailId, validate(commController.reassignEmailLeadSchema), commController.reassignEmailLead);
// PRD 10 (S10.20): pick which of several customers that share a sender's address a received message belongs to. Two segments after
// '/emails/:id', so they never meet the param route. Both need the attach switch (PRD 8's rule) and are the Email page's own.
router.get('/emails/:id/customer-candidates', canDo('show_email', 'Communication'), canDo('attach', 'Communication'), canDo('access_inbox', 'Communication'), emailId, commController.listCustomerMatches);
router.patch('/emails/:id/customer', canDo('show_email', 'Communication'), canDo('attach', 'Communication'), canDo('access_inbox', 'Communication'), emailId, validate(commController.pickEmailCustomerSchema), commController.pickEmailCustomer);
// Email slice 6 - manually attach an unmatched inbound message to a thread. A
// deeper path than '/emails/:id', so it never collides with the param route.
// #2046: the unmatched-triage editor, section-only.
router.patch('/emails/:id/link', canDo('show_email', 'Communication'), canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), emailId, validate(commController.linkInboundEmailSchema), commController.linkInboundEmail);
// #2046: no record-tab consumer of the by-id read (grep of `/emails/${` finds only section code
// paths), so gating it closes the by-id door on the section's own rows at no cost.
router.get('/emails/:id', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), emailId, commController.getEmail);
// Mint a fresh signed URL for one attachment (email slice 7) - a deeper path
// than '/emails/:id' so it never collides with the param route above.
router.get('/emails/:id/attachments/:index', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), emailId, commController.getEmailAttachmentUrl);

/**
 * Terminate this router's own prefixes.
 *
 * Without this, a request to a path under /emails that matches no route above
 * (a wrong method, a typo, a retired endpoint) exits this router and keeps
 * walking the mount chain until it reaches a comm-* router whose bare
 * router.use() gate answers 402 FEATURE_NOT_IN_PLAN for `phone`. An email-only
 * org would then get a Pro upsell for a telephony module it never touched.
 * These prefixes belong to this router, so an unmatched path under them is a
 * 404, not somebody else's entitlement problem.
 */
router.all([...EMAIL_PREFIXES, '/emails/*', '/email-groups/*', '/forward-rules/*'], markRouteCheck('closed', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
}));

export default router;
