import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/comm-manual-log.controller';

const router = Router();

const MANUAL_LOG_PREFIXES = ['/manual-log'];

/**
 * Manual Communication Log
 * (spec: md_files/specs/communication/2026-08-27-manual-communication-log.md, slice 1).
 *
 * Mounted on the shared /api/communication base and deliberately WITHOUT
 * `requireFeature('phone')`, unlike every phone router alongside it.
 *
 * THAT ABSENCE IS THE FEATURE, not an omission. The whole point of logging past communications
 * is the organisation that never had ServWave Phone — a rep who called from a personal mobile,
 * an estimator on Outlook, an onboarding admin typing up months of history. Gating this router
 * on the phone entitlement would 402 exactly the organisations it was built for. Authentication
 * and CASL still apply; only the plan axis is absent, the same shape and the same reasoning as
 * comm-shared.routes.ts.
 *
 * Path-scoped like its sibling comm-* routers, and it terminates its own prefixes, so a request
 * it does not own can never walk the mount chain into a foreign entitlement gate (and its own
 * un-gated `router.use` can never leak onto anyone else's traffic).
 */
router.use(MANUAL_LOG_PREFIXES, authenticate, attachAbility);

// `log_past`, never `create Communication`: the latter is in SHARED_BASELINE and gates
// click-to-call, texts, WhatsApp and email, so a role that lost it would lose the ability to
// contact customers at all. See catalog.ts.
router.post(
  '/manual-log',
  canDo('log_past', 'Communication'),
  validate(ctrl.createManualCommunicationLogSchema),
  ctrl.createManualCommunicationLog,
);

/**
 * The PICKER's read (slice 4). Who this organisation may credit a conversation to — id and
 * display name only, guarded by the same capability as the write it feeds.
 *
 * DECLARED BEFORE `/manual-log/:id`, and that ordering is load-bearing: Express matches in
 * declaration order, so the id route would otherwise swallow `performers`, hand it to
 * `loadModifiableEntry`, and answer 404 for a path that exists.
 *
 * See the handler for why the picker does not simply read `GET /api/users`.
 */
router.get(
  '/manual-log/performers',
  canDo('log_past', 'Communication'),
  ctrl.listManualLogPerformers,
);

// The EDITOR's read (slice 8) - the whole stored entry, so the capture form can reopen on what is
// actually there rather than on the timeline's 160-character preview. Guarded by `log_past` and,
// in the handler, by the same logger-or-admin rule as the writes: a reader who cannot edit gains
// nothing here that the timeline does not already show them.
router.get('/manual-log/:id', canDo('log_past', 'Communication'), ctrl.getManualCommunicationLog);

/**
 * Correcting an entry (slice 8). The SAME ability guards it — writing history and correcting it
 * are one capability, and a role trusted with the first is trusted with the second.
 *
 * The extra rule slice 8 adds cannot live here. "The requester is the entry's logger, or an
 * organisation admin" is a fact about the ROW, which a route guard has not loaded; it is enforced
 * in `loadModifiableEntry`, which the handler calls before it does anything else.
 *
 * PUT, not PATCH: the body is the whole editable record, not a patch of it. See the update
 * schema's own comment for why that is the safer contract for this particular entity.
 */
router.put(
  '/manual-log/:id',
  canDo('log_past', 'Communication'),
  validate(ctrl.updateManualCommunicationLogSchema),
  ctrl.updateManualCommunicationLog,
);

// Removing an entry logged on the wrong record. Same ability, same row-level rule, no body to
// validate - so the guard and the handler are the whole of it.
router.delete('/manual-log/:id', canDo('log_past', 'Communication'), ctrl.deleteManualCommunicationLog);

// Terminate this router's own prefixes - see comm-email.routes.ts for why an unmatched path of
// ours must not fall through into a phone gate.
router.all([...MANUAL_LOG_PREFIXES, '/manual-log/*'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default router;
