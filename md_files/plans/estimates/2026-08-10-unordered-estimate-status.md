# Unordered estimate status (Spec B1 applied to Estimate)

**Date:** 2026-08-10
**Module:** estimates
**Type:** plan (one task)
**Status:** approved to build, not started

## Goal

Make the six exposed estimate statuses freely reachable from one another, in either direction, to
match what Workiz lets users do. This is the same rule Job status already follows (Spec B1,
CLAUDE.md): the lifecycle stops being an ordered pipeline and becomes a set of states, with only
integrity rules blocking a move.

Trigger: on estimate 698715-1 (`SENT`), picking "Approved - Deposit Pending" does nothing. That is
not a data problem - there is no API transition that reaches `PENDING` at all.

## Current behaviour (verified in code, 2026-08-10)

`PATCH /api/estimates/:id/status` is a narrow whitelist, not a setter
(`backend/src/controllers/estimate.controller.ts:2634`):

```
backtodraft: SENT | PENDING -> DRAFT
backtosent:  PENDING        -> SENT
```

Both go backwards only. Forward movement is spread across single-purpose verbs, each with its own
status gate and its own CASL action:

| Route | Gate today | CASL action |
|---|---|---|
| `POST /:id/send`, `POST /:id/mark-sent` | DRAFT-ish first send, resend otherwise | `send` |
| `POST /:id/approve-internal` | `SENT`/`PENDING` -> `WON` | `approve` |
| `POST /:id/decline-internal` | `SENT`/`PENDING` -> `DECLINED` | `decline` |
| `POST /:id/cancel` | `DRAFT`/`SENT`/`PENDING` -> `ARCHIVED` | `cancel` |
| `POST /:id/void-approval` | `WON` -> `SENT` | `void_approval` (ADMIN-only) |
| `POST /:id/approve` (public) | `SENT`/`PENDING` -> `PENDING`/`WON` | none (token) |

No path reaches `PENDING` from staff-side, and there is no path out of `DECLINED` or `ARCHIVED` at
all.

### Why `PENDING` was blocked - the real hazard

`estimate.controller.ts:2626` documents it, and it is legitimate:

- `PENDING` means "customer approved AND signed, deposit outstanding" (D6).
- `approvePublic` is the only path that captures a signature.
- `approvePublic` decides "this is a payment retry, skip signature capture" from
  `existing.status === 'PENDING'` alone (`estimate.controller.ts:3869`).

So a staff-set `PENDING` would carry `signature_data = null`, and the customer's approve page would
then skip signature capture entirely - the estimate could reach `WON` with no consent record ever
captured. Fixing this is a precondition for the whole change, not an optional extra.

## Decisions (Ran, 2026-08-10)

1. **Money-trail guards stay hard blocks.** Same shape as the Job model, where only integrity
   rules block. Ordering rules go; integrity rules stay.
2. **Reasons are prompted, not dropped.** `DECLINED` prompts for `lost_reason`, `ARCHIVED` for the
   optional `cancelled_reason`. Keeps the S1 win/loss reporting signal.
3. **One `update Estimate` check for the picker.** Not per-target CASL. Consequence accepted and
   recorded below.
4. **`SENT` runs the mark-sent ceremony** when the estimate has no live public link; a re-pick on
   an already-sent estimate is a bare stamp.

### Accepted consequences

- The WON unwind is no longer ADMIN-only. Anyone with `update Estimate` can un-win a clean
  estimate; the money guard still refuses the cases that would orphan payment rows.
- A manually-set `PENDING` sits outside the expiration sweep (which deliberately skips `PENDING`),
  so it never expires until someone moves it.

## Design

### One shared engine

New file `backend/src/lib/estimates/status-transitions.ts` exporting
`applyEstimateStatusChange()`. Order of operations: **guards -> exit-unwind of the status being
left -> enter-effects of the target**, all inside the caller's `prisma.$transaction`. Every
endpoint routes through it, so there is one source of truth rather than six endpoints each holding
a private opinion about what a status means.

Signature (shape, not final):

```ts
applyEstimateStatusChange(tx, {
  existing,                 // row loaded with the select below
  target: EstimateStatusValue,
  reason?: { lost_reason?: LostReason; cancelled_reason?: string },
  req,
}): Promise<{ estimate; sideEffects: { emit[]; automation[]; audit[] } }>
```

Notifications/automation/audit are returned for the caller to fire **after** the transaction
commits, matching how `approveInternal` does it today (emit + `dispatchAutomationEvent` +
`logAudit` all run post-commit).

### Exit-unwind - clear stamps that no longer apply

| Leaving | Clears |
|---|---|
| `WON` | `approved_at = null`; demote lead to `ESTIMATED` iff no job exists AND no sibling estimate on that lead is still `WON` (lifted verbatim from `voidApproval`, `estimate.controller.ts:3010`) |
| `DECLINED` | `declined_at = null`, `lost_reason = null` |
| `ARCHIVED` | `cancelled_at = null`, `cancelled_reason = null` |
| `SENT` / `PENDING` / `DRAFT` | nothing on exit - their stamps are handled by the target's enter-effects |

### Enter-effects

| Target | Applies |
|---|---|
| `DRAFT` | null `public_token`, null `signature_data`/`signature_ip`/`signature_at`, `terms_accepted = false`, `terms_accepted_at = null`, `modified_after_send = false` (exactly today's `backtodraft` block, `estimate.controller.ts:2677`) |
| `SENT` | bare stamp when `public_token` is non-null; otherwise refuse with 409 `SEND_CEREMONY_REQUIRED` so the client opens `MarkSentDialog` and calls `POST /:id/mark-sent` |
| `PENDING` | status only. Deliberately never writes `signature_data` - the whole point is that a staff-set `PENDING` is honestly unsigned |
| `WON` | `approved_at = now`, lead -> `WON` (idempotent `updateMany`, skips WON/LOST/CANCELLED), `autoCreateReservation`, then post-commit `estimate.approved` + `ESTIMATE_APPROVED` automation (lifted from `approveInternal`, `estimate.controller.ts:2758`) |
| `DECLINED` | `declined_at = now`, `lost_reason` required, post-commit `estimate.declined` + `ESTIMATE_DECLINED` |
| `ARCHIVED` | `cancelled_at = now`, `cancelled_reason` optional |

### Guards - the only things that block

1. **Leaving `WON` with money downstream.** Refuse when the estimate's job has an invoice that is
   not `DRAFT` or that carries payments, or when the `kind: 'DEPOSIT'` invoice has payments. This
   is `voidApproval`'s existing check (`estimate.controller.ts:2963`), moved into the engine - so
   it now also covers `WON -> DRAFT` and `WON -> ARCHIVED`, which today bypass it completely
   because no route exists to attempt them.
2. **Target must be one of the six exposed statuses.** `EXPIRED` and `SUPERSEDED` are legacy values
   with no UI (`frontend/src/constants/estimateStatus.ts`) and are not valid targets. A row
   currently sitting in either may still be moved out.
3. **Tenant + row access**, unchanged: `tenantWhere(req)` plus `canAccessEstimate`.

No other blocks. In particular, ordering is gone: `DECLINED -> SENT`, `ARCHIVED -> DRAFT`,
`WON -> PENDING` all become legal.

### The signature fix (precondition)

`estimate.controller.ts:3869`:

```ts
const isPaymentRetry = existing.status === 'PENDING' && existing.signature_data != null;
```

`signature_data` is already in `approvePublic`'s select (`estimate.controller.ts:3840`), so this is
a one-line change. Effect: a staff-set, unsigned `PENDING` still demands a signature on the public
approve page; a genuine customer-signed `PENDING` still skips re-capture and keeps the original
consent record immutable. This is what makes free movement into `PENDING` safe.

The comment block at `estimate.controller.ts:2620-2633` explaining why no manual `PENDING` exists
gets rewritten to explain the new rule and why the retry check is keyed on the signature.

### Endpoint changes

- **`PATCH /:id/status`** becomes a real setter: body `{ status, lost_reason?, cancelled_reason? }`,
  gated on `canDo('update', 'Estimate')` (decision 3). Emits `estimate.status_corrected` with
  `{ from, to }` metadata - the existing verb, which already routes to Admin FEED + owner FEED.
  The old `{ transition: 'backtodraft' | 'backtosent' }` body is accepted for one release as an
  alias so nothing in flight breaks, then dropped.
- **`approve-internal` / `decline-internal` / `cancel` / `void-approval`** keep their routes,
  request shapes and CASL actions, but delegate their body to the engine and **drop their status
  ordering gates**. The money guard moves out of `voidApproval` and into the engine, so it still
  fires there. This keeps the Actions menu and the new picker from diverging.
- **`approvePublic` / `send` / `mark-sent`** unchanged apart from the `isPaymentRetry` line.

### Frontend

`frontend/src/components/estimates/EstimateStatusPicker.tsx` (new) replaces the read-only
`StatusBadge` at `frontend/src/pages/EstimateWorkspacePage.tsx:444`. The badge becomes the dropdown
trigger - the UI in the screenshot that prompted this. Contents: the six statuses from
`ESTIMATE_STATUS`, current one marked "Current" and inert, each other one routing to:

| Picked | Action |
|---|---|
| `SENT` on an estimate with no `public_token` | open existing `MarkSentDialog` |
| `SENT` otherwise | `setEstimateStatus(id, 'SENT')` |
| `DECLINED` | open existing `DeclineEstimateInternalDialog` (already requires `lost_reason`) |
| `ARCHIVED` | open existing `CancelEstimateDialog` (already takes the optional reason) |
| `DRAFT` / `PENDING` / `WON` | `setEstimateStatus(id, ...)` directly |

Every dialog needed already exists in `frontend/src/pages/EstimateWorkspacePage.tsx:73-90`; none
are new. Options blocked by the money guard render **disabled with the reason in a tooltip**,
computed client-side from `estimate.job.invoices` / `estimate.invoices`, rather than failing on
click. `frontend/src/lib/api/estimates.ts:34` widens from the two-transition union to the status
setter.

The existing Actions-menu buttons (Approve, Decline, Cancel, Void approval) stay - they carry
ceremony and are the discoverable path; the picker is the fast path.

## Sequence

Backend is TDD, strict (CLAUDE.md #6): failing test first, then implement.

1. **Tests first** - `backend/src/__tests__/` (extend the existing estimate lifecycle suite):
   - each enter-effect writes its stamps; each exit-unwind clears them
   - `WON -> SENT` demotes the lead only when no job and no sibling still `WON`
   - money guard refuses `WON -> DRAFT`/`ARCHIVED`/`SENT` on an invoiced or paid job, and on a
     deposit invoice with payments
   - `SENT` with no `public_token` returns 409 `SEND_CEREMONY_REQUIRED`
   - **`approvePublic` still demands a signature on a staff-set, unsigned `PENDING`** (the
     regression test for the hazard), and still skips re-capture on a genuinely signed one
   - `DECLINED` without `lost_reason` is rejected
   - legacy `{ transition }` body still works
2. Build `status-transitions.ts`; make the tests pass.
3. Rewire `setStatus` + the four verb endpoints onto the engine; delete their ordering gates.
4. Apply the `isPaymentRetry` fix and rewrite the D6/no-manual-PENDING comment block.
5. Frontend picker + `estimates.ts` API wrapper + tooltip disabling.
6. Frontend test for the picker (guard-disabled options, dialog routing).
7. `npx tsc --noEmit` and `npm test --workspace=backend`; report real results (CLAUDE.md #7).

## Branch and shipping

Feature flow per the `ship-changes` skill, worktree under `../alpha_crm-worktrees/`. Base chosen by
the gate, not by inspection (CLAUDE.md):

```bash
git merge-base --is-ancestor origin/main origin/staging
```

Exit 0 -> branch off `main`. Non-zero -> branch off `staging`. PR into `staging`. No promotion to
`main` unless Ran asks in that session.

## Files touched

**Backend**
- `backend/src/lib/estimates/status-transitions.ts` (new)
- `backend/src/controllers/estimate.controller.ts` - `setStatus`, `approveInternal`,
  `declineInternal`, `cancel`, `voidApproval`, `approvePublic` (one line), comment block at 2620
- `backend/src/routes/estimate.routes.ts` - schema swap on `PATCH /:id/status` only
- `backend/src/__tests__/` - lifecycle suite

**Frontend**
- `frontend/src/components/estimates/EstimateStatusPicker.tsx` (new)
- `frontend/src/pages/EstimateWorkspacePage.tsx` - swap badge for picker, wire dialog opens
- `frontend/src/lib/api/estimates.ts` - `setEstimateStatus` signature
- `frontend/src/__tests__/` - picker test

**No schema migration.** Every status value and every stamp column already exists; this changes
which transitions are legal, not what is stored.

## What changed during implementation (2026-08-11)

Four things differed from the plan above. The plan was written against a stale local checkout;
`origin/staging` turned out to be further along.

1. **The status dropdown already existed.** `EstimateStatusMenu` is on `staging` and IS the control
   in the screenshot - the plan's claim that the workspace renders a read-only badge was wrong. No
   new component was built. PENDING was hard-coded `enabled: false` with the reason "Pending is set
   only when the customer signs the estimate", which is exactly the reported symptom. The work
   became rewiring the page's `targets` map, not building a picker.

2. **A second surface exists.** `POST /api/estimates/bulk-status` (Estimates list page) shares
   `setStatusInternal`, so it runs on the same engine. It still takes only the legacy
   `{transition}` body - **the list page was deliberately NOT given free movement**, since it needs
   its own reason-prompt UX. Left as follow-up work.

3. **The four lifecycle verbs were NOT rewired.** The plan called for delegating approve-internal /
   decline-internal / cancel / void-approval to the engine and dropping their status gates. Each
   emits its own distinct notification verb (`estimate.approved`, `estimate.declined`,
   `estimate.cancelled`, `estimate.approval_voided`), so delegating would have collapsed them into
   `estimate.status_corrected` - a real regression in the Admin/owner feed. They keep their routes,
   gates and verbs untouched.

   Instead the **setter** now picks the verb by target (WON -> `estimate.approved`, DECLINED ->
   `estimate.declined`, ARCHIVED -> `estimate.cancelled`, everything else ->
   `estimate.status_corrected`) and fires the matching automation trigger. That is what stops the
   two surfaces from diverging. `CancelEstimateDialog` and `DeclineEstimateInternalDialog` now call
   the setter rather than their verb endpoints, because those endpoints' gates would 400 the newly
   legal moves (archiving a won estimate, declining a won one).

4. **The money guard is only half-predicted client-side.** `estimateDetailSelect` does not carry the
   job's invoices, so the page cannot tell whether the job is billed. Only the deposit half is
   predicted (that data is present); the job half is left server-enforced and surfaces as the
   backend's own message in a destructive toast. Widening a shared select purely to grey out a row
   was not judged worth it.

### Verification

- `npm test --workspace=backend`: **8065 passed, 7 failed**. All 7 reproduce identically on pristine
  `origin/staging` (auth-google, default-grants-schema-validity, purge-tenant-coverage) - a stale
  generated Prisma client from the dev worktree's symlinked `node_modules`, not a code problem.
- Estimate suites specifically: **411/411 pass** (`estimates.test.ts` + `estimate-notifications.test.ts`).
- Frontend: **2439 passed**; 3 files fail to import `email-reply-parser`, the same symlink artifact.
- `npx tsc --noEmit`: clean on both sides for every file touched.

## Open items

- Expiration sweep and manually-set `PENDING`: accepted as-is for now (see Accepted consequences).
  If it bites, the fix is to key the sweep on `signature_at != null` rather than on status.
- `EXPIRED`/`SUPERSEDED` remain UI-invisible. If Workiz parity later demands them in the picker,
  they slot in as two more targets with no engine change.
