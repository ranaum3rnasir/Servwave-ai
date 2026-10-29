# SERV10X-70 - Automation Center: connect SMS/text actions to CTM

**Status:** implemented on `ran/serv10x-70-automation-center-connect-smstext-actions-to-ctm`, all 5 slices, backend + frontend suites green. PR pending; staging live-check pending merge + deploy.

**Linear:** SERV10X-70 (High, milestone "6. Automation Center (Octopus)")
**Branch:** `ran/serv10x-70-automation-center-connect-smstext-actions-to-ctm` off `origin/staging`
**Related:** SERV10X-49 (done), SERV10X-25, SERV10X-30, GitHub #907 / #743, ADR 0001, PR #1070

## Starting state (measured, not assumed)

The card's premise is partly stale. CTM delivery is **already wired**:

- `smsRecord.ts:85` fires `deliverViaCtm` -> `sendCtmSms` after the Message row is written.
- `lib/ctm/sendSms.ts` is the ONE shared outbound path, already running the full compliance
  chain: connected -> `ctm_sms_ready` (A2P) -> from-number -> outbound allowlist -> fresh
  opt-out -> double-fire. It never throws; failures mark the row `failed` and return a typed reason.

What actually blocks launch is a deliberately-paired set of launch flags plus two real gaps.

| Item | Location | State |
|---|---|---|
| Backend launch gate | `backend/src/lib/featureFlags.ts:26` `isAutomationSmsLaunched()` | hard `return false` |
| Frontend authoring lock | `frontend/src/lib/workflows/featureFlags.ts:23` `SMS_STEP_LOCKED` | `true` |
| `phone` entitlement on automation SMS | nowhere | **MISSING** (gap 1) |
| SEND_SMS step-run honesty | `executors.ts:313-317` | **hardcoded `SENT`** (gap 2) |
| Org-level SMS kill switch | n/a (email has `email_sending_enabled`) | **MISSING** (gap 3) |

### Gap 1 - no `phone` entitlement check at the point of effect

`comm-threads.routes.ts:11` gates the Communication module's own send with
`requireFeature('phone')`. The automation path is reached from the minute poller and
`dispatchAutomationEvent` - never from a request - so no route gate applies. This is
exactly ADR 0001's class, one feature over. CLAUDE.md: `phone` is OFF by default for
**every** new org regardless of plan, so flipping the launch flag without this gate would
text real customers on behalf of orgs that never enabled the Communication module.

### Gap 2 - SEND_SMS step runs lie

`sendSmsAction` returns `{ status: 'SENT', detail: 'Recorded in the customer conversation -
delivery to their phone activates when an SMS provider is connected' }` unconditionally,
because delivery is fire-and-forget and the executor never sees the outcome. Same defect
class as #1068, which PR #1070 fixed for email.

### Gap 3 - no SMS kill switch

Email has `organizations.email_sending_enabled`. SMS's only org-level lever is
`ctm_sms_ready` (A2P approval, not a panic switch) or revoking `phone` (kills the whole
Communication module).

## Decisions (Ran, this session)

1. **Per-org capability**, not a global flag flip: `/api/workflows/catalog` serves
   `capabilities.sms_available`; the builder lights up "Send text" only for orgs that can
   actually text. This is the graduation path the frontend flag's own comment names.
2. **Add `organizations.sms_sending_enabled`** mirroring `email_sending_enabled`.

## Plan

Backend is TDD throughout (CLAUDE.md #6): failing test first, then implement.

### Slice 1 - `sms_sending_enabled` kill switch — DONE

- Migration: `organizations.sms_sending_enabled Boolean @default(true)`, portable +
  idempotent per the `writing-migrations` skill (`ADD COLUMN IF NOT EXISTS`). Never run
  `prisma migrate` from a worktree.
- New `CtmSmsFailureReason`: `ORG_SMS_DISABLED`.
- Enforce inside `runGates` (`sendSms.ts`) so it covers **both** send seams at once - the
  user send and the automation send - in one place.
- Tests: disabled org -> `{ delivered: false, reason: 'ORG_SMS_DISABLED' }`, no CTM call,
  Message row not marked sent; enabled org unaffected.

### Slice 2 - `phone` entitlement at the point of effect (ADR 0001 for SMS) — DONE

- Extend the existing single org read in `runGates` to also select `plan`,
  `trial_ends_at`, `feature_overrides`; fail closed via `hasFeature(org, 'phone')`.
- New reason: `NOT_ENTITLED`.
- Placing it in `runGates` (not `deliverViaCtm`) means the user-send path gets the same
  check as defence in depth - behaviourally a no-op there, since the route already
  requires `phone`.
- Tests: unentitled org (STARTER, and PRO with `feature_overrides: {phone: false}`) ->
  `NOT_ENTITLED`, zero CTM calls; entitled org unaffected. Gate ordering asserted so an
  unentitled org never reaches the CTM opt-out API.

### Slice 3 - honest SEND_SMS step runs (the #1070 fix, for SMS) — DONE

- `recordOutboundSms` **awaits** delivery instead of fire-and-forget and returns the
  `CtmSmsSendResult` alongside `{threadId, messageId}`. Awaiting matches what the email
  path already does; `sendCtmSms` never throws, so the run cannot be broken by it.
- `sendSmsAction` maps the result to product copy in the Activity tab:
  - `delivered: true` -> `SENT`
  - `NOT_CONNECTED` / `SMS_NOT_READY` / `NO_SMS_NUMBER` / `NOT_IN_TEST_ALLOWLIST` /
    `NOT_ENTITLED` / `ORG_SMS_DISABLED` / `RECIPIENT_OPTED_OUT` / `DUPLICATE_SEND` ->
    `SKIPPED` with a plain-English reason
  - `CTM_ERROR` -> `FAILED`
- Delete the hardcoded "delivery to their phone activates when an SMS provider is
  connected" string.
- Tests: one per reason -> asserted status + copy; opt-out reads as SKIPPED not FAILED
  (compliance outcome, not a defect).

### Slice 4 - per-org catalog capability + retire the global flag — DONE

- `getWorkflowCatalog` (previously ignored `_req` and served a purely static catalog) now
  reads the caller's org and adds:
  `capabilities: { sms_available: ctm_account_id && ctm_sms_ready && sms_sending_enabled && hasFeature(org,'phone') }`
- **Retired `isAutomationSmsLaunched()`** and deleted `backend/src/lib/featureFlags.ts` —
  its entire job was standing in for a per-org gate that now exists at the point of effect.
  Phase-0 blast-radius safety is unchanged - `CTM_OUTBOUND_ALLOWLIST` still guards every
  destination in `runGates` and is untouched by this card.
- Tests: capability true only when all four conditions hold; one test per missing condition.

### Slice 5 - frontend unlock — DONE

- `frontend/src/lib/workflows/featureFlags.ts`: replaced the `SMS_STEP_LOCKED` constant
  with `lockedStepTypesFor(catalog)`, derived from `capabilities.sms_available`; a
  missing/loading catalog fails closed (locked).
- Updated consumers: `AddStepButton` (default fallback stays locked; `BuilderSpine` now
  computes and threads real `lockedTypes` from the catalog it already holds) and
  `WorkflowsHome.tsx` (text-template gallery filter reads `capabilities.sms_available`
  directly).
- Badge/tooltip copy stopped saying "Coming soon" - an org without texting now sees
  "Not connected" + a connect-your-phone tooltip, which is true, instead of a roadmap promise.
- `AddStepButton.test.tsx` extended with two tests driving `lockedTypes` off
  `lockedStepTypesFor()` against a real catalog fixture, plus a new `featureFlags.test.ts`
  unit-testing the helper (including fail-closed on `undefined`/stale fixtures).

## Verification before claiming done (CLAUDE.md #7)

- `npm test --workspace=backend`: 6486 passed, 45 skipped (pre-existing), 0 failed.
- `npx tsc --noEmit` (backend and frontend): clean.
- `npx vitest run` (frontend): 4252 passed, 7 skipped (pre-existing), 0 failed.
- Live check on staging org "Stripe Test Plumbing" (PRO): **deferred** — needs the migration
  applied and the code deployed, which only happens once the staging PR merges. To do
  post-merge: confirm the step lights up only once texting is connected, and that a run
  with texting off records SKIPPED with the real reason rather than a false SENT.

## Out of scope

- Broader Communication-module SMS work (SERV10X-25 / SERV10X-30).
- Inbound/reply handling, per-step SMS templating beyond what exists.
- Any change to `CTM_OUTBOUND_ALLOWLIST` phase-0 policy.
