import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import * as commCallsController from '../controllers/comm-calls.controller';

const router = Router();

// Applied per-route rather than on the router: '/calls/outcome' is a literal
// sibling of '/calls/:id' whose segment is deliberately not a uuid, so a
// router-wide guard would 404 it and break the dialer's ended state.
const callId = requireUuidParam('id', 'Call not found');

router.use(authenticate, requireFeature('phone'), attachAbility, attachCustomerScope);

// ─── Calls (CallSession) ─────────────────────────────────
// #2046: the list is the org-wide call log; GET /calls/:id below (and every by-id/compose/dial
// route in this file) stays on `read`/`create Communication` alone - anchor-filtered and/or the
// record tabs' own consumers (EntityCallDrawer, click-to-call, the dialer).
router.get('/calls', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), commCallsController.listCalls);
router.post('/calls', canDo('create', 'Communication'), validate(commCallsController.createCallSchema), commCallsController.createCall);
// Softphone attribution stash: the WebRTC softphone places the call in the
// browser (bypassing the createCall bridge), so it POSTs its job/lead/customer
// context here first for ingestCall to consume. Writes a stash, never a call.
// Declared before '/calls/:id' for clarity (distinct method, so no collision).
router.post('/calls/attribution', canDo('create', 'Communication'), validate(commCallsController.stashAttributionSchema), commCallsController.createCallAttribution);
// Bridge outcome poll: "did the call I just placed land yet". MUST stay above
// '/calls/:id' - both are GETs, so the parameterised route would otherwise
// swallow 'outcome' as an id and 404 on a uuid lookup.
router.get('/calls/outcome', canDo('read', 'Communication'), commCallsController.getCallOutcome);
router.get('/calls/:id', callId, canDo('read', 'Communication'), commCallsController.getCall);
// Recording playback: mints a fresh 300s signed URL (private bucket); 404 when
// the recording is missing or not ingested yet. Every mint is audited.
router.get('/calls/:id/recording', callId, canDo('read', 'Communication'), commCallsController.getCallRecording);
// Transcript: stored text, else one lazy CTM fetch persisted on hit; a miss is
// a quiet { transcript: null }, never an error.
router.get('/calls/:id/transcript', callId, canDo('read', 'Communication'), commCallsController.getCallTranscript);
// Manual attach of a call to a job from the call log (job_id: null clears).
router.patch('/calls/:id/job', callId, canDo('update', 'Communication'), validate(commCallsController.reassignCallJobSchema), commCallsController.reassignCallJob);
// Lead mirror of the job attach (lead_id: null clears) — ingest is otherwise
// the only writer of lead_id, so missed attributions need this to be fixable.
router.patch('/calls/:id/lead', callId, canDo('update', 'Communication'), validate(commCallsController.reassignCallLeadSchema), commCallsController.reassignCallLead);

// Dialer search — canonical customers/jobs/identity lookup (#666/#357).
router.get('/dialer-search', canDo('read', 'Communication'), commCallsController.dialerSearch);

// ─── Phone customers (Customer + Contact + ChannelIdentity) ──
// Seam calls GET /api/communication/contacts for usePhoneCustomers().
router.get('/contacts', canDo('read', 'Communication'), commCallsController.listPhoneCustomers);
router.get('/contacts/:id', canDo('read', 'Communication'), commCallsController.getPhoneCustomer);

export default router;
