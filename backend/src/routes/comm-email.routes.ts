import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as commController from '../controllers/comm-whatsapp-email.controller';
import * as commAgentsController from '../controllers/comm-agents.controller';

const router = Router();

// POST /emails is multipart/form-data (email slice 7 - the Resend send path):
// compose fields ride as regular text fields, files ride under `files`. Same
// per-file cap as attachment.routes.ts; `withOrgContext` MUST come immediately
// after multer - multer's stream consumption drops the AsyncLocalStorage tenant
// scope (same ordering as attachment.routes.ts / inv-stages.routes.ts).
const MAX_EMAIL_ATTACHMENTS = 10;
const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
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
const EMAIL_PREFIXES = ['/emails', '/email-groups', '/forward-rules', '/sending-identity'];

router.use(EMAIL_PREFIXES, authenticate, requireFeature('email'), attachAbility);

// ─── Sending identity ───────────────────────────────────
// The From a send would carry, resolved without sending, so the compose window
// can name it. Its own prefix rather than a path under '/emails' - '/emails' as
// a `use` prefix would cover it, but GET '/emails/:id' would then swallow the
// route itself (the same ordering trap '/emails/thread-read' already has a
// regression test for).
// #2046 R2: this is also the compose window's From resolver (CustomerDetailPage, EmailSenderPage)
// - stays on `read Communication` alone.
router.get('/sending-identity', canDo('read', 'Communication'), commController.getSendingIdentity);

// ─── Email groups ───────────────────────────────────────
// #2046: section-only config, no record-tab consumer.
router.get('/email-groups', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listEmailGroups);

// ─── Forward rules ──────────────────────────────────────
router.get('/forward-rules', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commAgentsController.listForwardRules);

// ─── Emails ─────────────────────────────────────────────
// #2046: the inbox list is the org-wide section surface.
router.get('/emails', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listEmails);
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
// marker (commVisibilityWhere-filtered, already exactly the caller's own visible
// rows) - `update`+`access_inbox` was the wrong gate (SALES 403'd on any thread_id
// despite holding `read Communication`, the issue's headline defect). Read-side
// rights only, mirroring the new SMS thread-read route. #2046's thread-level
// WORKFLOW routes (assign/archive/snooze) keep `update`+`access_inbox` - unchanged.
router.patch('/emails/thread-read', canDo('read', 'Communication'), validate(commController.markThreadReadSchema), commController.markThreadRead);
// #2049 - the persisted half of "Mark as unread" (deletes this caller's
// EmailReadState rows for the visible emails of the thread). MUST also stay
// above '/emails/:id' for the same swallowing reason. Same gate as thread-read.
router.patch('/emails/thread-unread', canDo('read', 'Communication'), validate(commController.markThreadUnreadSchema), commController.markThreadUnread);
// Email slice 8b - conversation assignment + shared archive/snooze. These have
// MORE path segments than '/emails/:id' (which matches exactly one segment
// after '/emails/'), so they never collide with it regardless of registration
// order - kept up here anyway, beside thread-read, since they are the other
// thread-level (not per-message) mutations.
router.patch('/emails/threads/:id/assign', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.assignEmailThreadSchema), commController.assignEmailThread);
router.patch('/emails/threads/:id/archive', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.archiveEmailThreadSchema), commController.archiveEmailThread);
router.patch('/emails/threads/:id/snooze', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.snoozeEmailThreadSchema), commController.snoozeEmailThread);
// "Attach from this record" (email slice 7) - MUST also stay above '/emails/:id'
// for the same reason as thread-read above: a literal path is swallowed by a
// param route registered before it.
// #2046 R2: useAttachSources -> ComposeWindow.tsx, rendered by CustomerDetailPage - not gated.
router.get('/emails/attach-source', canDo('read', 'Communication'), commController.listAttachSources);
// Email slice 6 - the unmatched inbound queue. Literal path, so it MUST stay
// above '/emails/:id' for the same reason as thread-read and attach-source:
// registered after the param route, 'unmatched' is swallowed as an id.
// #2046: the unmatched queue is section-only triage.
router.get('/emails/unmatched', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.listUnmatchedEmails);
// One-click reassign of an email's job attribution (job_id: null clears) - the
// email mirror of PATCH /sms/:id/job.
// #2046 R3: useReassignEmailJob -> components/communication/shared/CommRowJobControl.tsx, which
// renders inside all three record tabs - not gated.
router.patch('/emails/:id/job', canDo('update', 'Communication'), validate(commController.reassignEmailJobSchema), commController.reassignEmailJob);
// Email slice 6 - manually attach an unmatched inbound message to a thread. A
// deeper path than '/emails/:id', so it never collides with the param route.
// #2046: the unmatched-triage editor, section-only.
router.patch('/emails/:id/link', canDo('update', 'Communication'), canDo('access_inbox', 'Communication'), validate(commController.linkInboundEmailSchema), commController.linkInboundEmail);
// #2046: no record-tab consumer of the by-id read (grep of `/emails/${` finds only section code
// paths), so gating it closes the by-id door on the section's own rows at no cost.
router.get('/emails/:id', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.getEmail);
// Mint a fresh signed URL for one attachment (email slice 7) - a deeper path
// than '/emails/:id' so it never collides with the param route above.
router.get('/emails/:id/attachments/:index', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commController.getEmailAttachmentUrl);

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
router.all([...EMAIL_PREFIXES, '/emails/*', '/email-groups/*', '/forward-rules/*'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default router;
