# Creation confers control + org-wide creator tracking

Status: DRAFT - awaiting Ran's approval. No code written.
Date: 2026-08-04
Decided with: Ran (this session)

## The rule

Two statements, both from Ran, that are independent and compatible:

1. **Creation confers control.** If a role can create entity X, that user has full control over the X's they created - read, edit, delete, reassign, remove themselves from it. This is a system-wide rule, not a technician rule: it holds for any role now or added later. Higher-tier roles (admin, dispatcher) reach the same entities through their own org-wide grants; this rule only ever adds access, never removes it.
2. **Every creatable entity records its creator, permanently, for audit.** So that "who created this estimate / job / lead / invoice" is answerable months later. Without the column that question has no answer at all.

Origin: live QA on staging 2026-08-04 found a technician could add a line item, type a price, and have it silently discarded.

## Why these do not contradict (correcting an earlier draft)

An earlier draft of this spec asserted "`created_by` is never consulted for authorization." **That sentence was imported from Workiz, not from Ran, and it is now removed.** Workiz deliberately separates audit from authorization; Ran is not asking for that, and there is no reason to inherit it.

Ran's point is that `created_by` is not an *ownership feature* - no transfer UI, no "owner" concept, no responsibility semantics, no extra capability derived from it. It is an immutable record of fact.

Reading that immutable fact to answer "did you create this?" is not a feature. It is the plainest implementation of rule 1, and it is why the column is immutable in the first place. The two statements describe the same column from different angles: rule 2 says why it exists on every entity, rule 1 says what one particular check does with it.

**The codebase already agrees.** `OWN_ESTIMATE_VIA_LEAD_OR_CREATOR` (SERV10X-61 §8, `defaultGrants.ts:21`) is a live, shipped CASL condition that reads `created_by` to decide access:

```ts
const OWN_ESTIMATE_VIA_LEAD_OR_CREATOR = {
  OR: [
    { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    { AND: [{ lead_id: null }, { created_by: '{{userId}}' }] },
  ],
};
```

Creator-as-authorization-input is not a new idea being introduced here. It is existing precedent, and this spec generalises it.

Consequence, and it is intended rather than a cost: **the grant is permanent.** A technician who creates a job controls it forever, even after a dispatcher reassigns the work. There is no transfer story because Ran does not want one.

## Part A - creator tracking

### Already built (correction to earlier draft)

Six models already carry a creator, so this is smaller than the earlier draft assumed:

| Model | Column | Nullable |
|---|---|---|
| `Estimate` | `created_by` | NOT NULL, hard FK |
| `Task` | `created_by` | NOT NULL |
| `Note` | `created_by` | NOT NULL |
| `LogisticOrder` | `created_by` | NOT NULL |
| `Credit` | `created_by` | NOT NULL |
| `TimelineEvent` | `created_by` | nullable |
| `AutomationRule` | `created_by_id` | nullable |

### Missing, to add

`Job`, `Lead`, `Invoice`, `Customer`, `Payment`, `Attachment`.

```
created_by_id      uuid  NULL  REFERENCES users(id) ON DELETE SET NULL
created_by_source  enum  NOT NULL  DEFAULT 'UNKNOWN'
```

`CreatedBySource`: `USER` | `CLIENT` | `SYSTEM` | `IMPORT` | `UNKNOWN`

Two columns because a bare nullable FK cannot distinguish "the client did this" from "we do not know", and Ran's Payment requirement - who *collected* it, labelled `CLIENT` when the customer paid themselves - makes that distinction load-bearing.

**Naming:** existing models use `created_by`, the two newest use `created_by_id`. New columns use `created_by_id`; the six existing columns stay as they are rather than running a rename migration across live data. Decided, not open.

### Open: `ON DELETE SET NULL` destroys the audit answer

`DELETE /api/users/:id/permanent` exists (`user.routes.ts:30`) alongside the soft `deactivate`. With `ON DELETE SET NULL`, permanently deleting a user blanks `created_by_id` on everything they made - and rule 2's whole purpose, answering "who created this" months later, is gone precisely when it matters most (a departed employee).

Existing precedent points the other way: `Estimate.created_by` is `NOT NULL` with a hard FK, so permanently deleting a user who created an estimate already fails today.

Two options, needs a decision:

- **`ON DELETE RESTRICT`.** Matches the existing Estimate behaviour. Cost: permanent user deletion becomes near-impossible for anyone who has done real work - deactivate is the only route.
- **`SET NULL` plus a `created_by_name` text snapshot** written at creation time. Audit survives the delete; the permission check falls back to "nobody is the creator" (admins still reach the row). Cost: one denormalised column per entity.

Recommend the second. It is the only one where both rules survive a permanent delete.

| Path | Source | `created_by_id` |
|---|---|---|
| Normal authed `POST` | `USER` | `req.user.id` |
| Payment taken by staff | `USER` | the collecting user |
| Stripe webhook / public deposit / public estimate approve | `CLIENT` | null |
| Automation engine, seeds, schedulers | `SYSTEM` | null |
| CSV / Workiz import | `IMPORT` | importing user |
| Existing rows at migration | `UNKNOWN` | null |

Immutable. Derived creates (estimate from job, invoice from estimate) record the acting user, never the parent's creator.

## Part B - the mechanism

A new condition template next to the existing `OWN_JOB`, usable on any subject:

```ts
const OWN_JOB       = { assignees: { some: { user_id: '{{userId}}' } } };   // existing
const CREATED_BY_ME = { created_by_id: '{{userId}}' };                       // new
```

That is the whole mechanism. It answers "any role now or in the future" without a per-role special case, and it is the same substitution machinery `OWN_JOB` already uses.

## Part C - technician application

Assigned but not creator: **read everything** (prices, cost, margin, totals), add notes / attachments / tasks / communication, and run their own job verbs. Cannot touch line items, scopes, estimates, logistic orders, payments.

Creator: **everything above, plus full control.**

### The blocker: `update Job` is one gate over five different things

Confirmed by reading `backend/src/routes/job.routes.ts`. `canDo('update', 'Job')` currently gates all of:

- `PATCH /:id` - job fields, including tax, discount, and `estimate_id`
- `POST|PATCH|DELETE /:id/line-items/*`
- `POST|PATCH|DELETE /:id/scopes/*`
- `POST /:id/notes`
- `POST|DELETE /:id/tags`

The controller header records the original choice explicitly: line items reused `update Job` "rather than adding a new `manage_lines Job`". That choice is what now has to be undone, because Ran's rule needs notes on the assignee side and line items on the creator side.

**Recommended split** - one new action, mirroring the `manage_lines Invoice` that already exists:

| Gate | Condition | Covers |
|---|---|---|
| `update Job` (keep) | `OWN_JOB` | notes, tags, sub-status, non-financial job fields |
| `manage_lines Job` (new) | `CREATED_BY_ME` | line items, scopes, and the financial fields on `PATCH /:id` |

One new row in the Roles UI, not three.

### Field-level check inside `PATCH /:id`

`tax_rate`, `discount_*` and `estimate_id` are job fields on the same PATCH as the harmless ones, so the split cannot be done at the route. They need a field-level check in the controller. **There is precedent:** the D14 note in `defaultGrants.ts` records that rescheduling already needs its own field-level check inside the same handler.

`estimate_id` matters because there is **no `POST /jobs/:id/estimates` route** - an earlier draft of this spec invented one. Estimates carry no `job_id`; the link is `Job.estimate_id`. So "create an estimate for an existing job" is a job-side PATCH, and it lands behind the same field-level check as tax and discount. That closes the loophole an earlier draft flagged as open.

### Grant changes for TECHNICIAN

| Grant | Condition | Change |
|---|---|---|
| `read Pricing` | org-wide | **ADD** - prices, totals, job cost, margin |
| `read Job` | `OWN_JOB` **or** `CREATED_BY_ME` | **WIDEN** |
| `create Job` | - | **ADD** (was a per-user toggle); creator auto-assigned |
| `update Job` | `OWN_JOB` | keep |
| `manage_lines Job` | `CREATED_BY_ME` | **NEW ACTION** |
| `assign` / `unassign Job` | `CREATED_BY_ME` | **ADD** - this is "they can take them off the job"; technicians hold neither action today |
| `delete Job` | `CREATED_BY_ME` | **ADD** - Ran, 2026-08-04: "they have full access and control over things that they created" |
| `complete` / `start` / `arrive` | `OWN_JOB` | keep |
| `create Estimate` | - | **ADD** - standalone; attaching one to a job is the `estimate_id` check above |
| `record_payment` | - | **KEEP OFF by default**, grantable per role |
| `create Lead` | - | **KEEP OFF** |
| `create Invoice` | - | **KEEP OFF** |

The existing integrity rule already blocks deleting an invoice-bearing job, so `delete` stays bounded.

## Part D - SALES: checked, nothing to file

Rule 1 is system-wide, so it was checked against every existing role. DISPATCHER is unaffected (org-wide grants already exceed it). SALES raised two apparent problems; **both were verified and both are already handled.** Recorded here so the same false alarms are not re-raised later.

**Apparent problem 1: `read Lead` is `OWN_LEAD` (assignee only), so a SALES user who creates an unassigned lead cannot read it.**

Not reachable. `lead.controller.ts:585` force-assigns SALES-created leads to the creator, ignoring the request body:

```ts
const assigned_to = req.user?.role === 'SALES' ? req.user.id : (bodyAssignee ?? undefined);
```

Rule 1 already holds for SALES leads, via auto-assignment rather than via the creator column. Worth noting only that this is a **role literal**, so a future row-scoped role would fall into the gap SALES is protected from. `CREATED_BY_ME` on `read Lead` would make it role-agnostic. Nice-to-have, not a defect.

**Apparent problem 2: `update` / `delete` / `send` / `approve` `Estimate` are unconditioned for SALES while `read Estimate` is row-scoped - write looks wider than read.**

Not reachable either. The row check is per-instance in the controller, not on the grant. Every write handler calls `canAccessEstimate`, and `deleteEstimateInternal` (shared by both `remove` and `bulkRemove`) calls **both** `canAccessRow` and `canAccessEstimate`. `canAccessEstimate` is grant-driven, not role-literal:

```ts
const scope = await scopeWhereForReq(req, 'Estimate');
if (Object.keys(scope).length > 0) return false; // any conditional read grant => own-only
```

So the unconditioned grant is a **capability** gate ("this role may edit estimates at all") and row scope is inherited from the read grant. Two deliberate layers, not a hole.

**Conclusion: no SALES work.** Parts A-C are the whole job.

## Known bug, independent of all three parts

`JobDetailPage.tsx:1703+` renders `ReceiptCard` with `jobLineItemsData?.billing?.subtotal ?? 0` (same for tax/discount/total). The backend deliberately sends `billing: null` to a price-blind requester and its own comment says the client "must render '-', not a wrong number". The `?? 0` turns unknown into `$0.00`.

Note that granting technicians `read Pricing` makes this **less** reachable, not more - it only fires in orgs that switch financial data off. Fix regardless; every platform researched hides the surface rather than zeroing it.

## Implementation plan

Four PRs into `staging`, each independently shippable and QA-able. Backend is TDD throughout: failing test first.

### PR 1 - `Job.created_by_id` (audit only, zero behaviour change)

Blocks PR 3, so it goes first.

- Migration: `created_by_id uuid NULL`, `created_by_name text NULL`, `created_by_source` enum NOT NULL DEFAULT `'UNKNOWN'` on `jobs`. New `CreatedBySource` enum. Portable + idempotent per the `writing-migrations` skill.
- `schema.prisma`: the three columns plus a `creator User?` relation, `onDelete: SetNull`.
- Populate at all **six** production creation sites (found, not assumed): `job.controller.ts` lines 862, 958, 1179, 1475, 3436, and `service-plan.controller.ts:675`. The last is the auto-generated visit job - it is the `SYSTEM` path, no user. Seeds (`seed-technician.ts`) get `SYSTEM`.
- Tests: authed create records `USER` + the acting user; service-plan generation records `SYSTEM`; existing rows read back `UNKNOWN`.

### PR 2 - `manage_lines Job` split (pure refactor, zero behaviour change)

Deliberately separated from the grant flip so that if technician behaviour regresses, the cause is unambiguous.

- Add `manage_lines Job` to the permission catalog.
- Re-gate 11 routes in `job.routes.ts` from `update Job` to `manage_lines Job`: line-items 53/64/65/66, scopes 74/77/78/79, and the financial fields inside `PATCH /:id`.
- Field-level check in `job.controller.update` for `tax_rate`, `discount_type`, `discount_value`, `discount_name`, `estimate_id`. Follows the existing D14 reschedule precedent in the same handler.
- Grant `manage_lines Job` everywhere `update Job` is granted today, so **no role's effective access changes**. Backfill migration for the 16 staging orgs plus prod.
- Tests: every existing `update Job` caller still passes; a principal with `update` but not `manage_lines` is refused on all 11 routes and on the five financial fields.

### PR 3 - technician grant flip (the only behavioural PR)

- `CREATED_BY_ME = { created_by_id: '{{userId}}' }` in `defaultGrants.ts`.
- Auto-assign the creator on `POST /api/jobs`.
- TECHNICIAN grants per the Part C table: add `read Pricing`, widen `read Job` to `OWN_JOB or CREATED_BY_ME`, add `create Job` / `assign` / `unassign` / `delete Job` / `manage_lines Job` (creator-conditioned) / `create Estimate`.
- Backfill migration for existing orgs.
- Frontend: mirror the split in `canOnJob` (`frontend/src/lib/ability.ts`) so the UI does not offer actions the API refuses. Absent-not-disabled, per house convention.
- Roles UI label for `manage_lines Job`.
- Tests: assigned non-creator can read money, add notes/tags, complete, and is refused on all 11 financial routes; creator passes all of them; creator retains access after being unassigned.
- **Live QA on staging** before merge, on a real technician account, both roles of the split.

### PR 4 - `created_by_id` on the remaining five

`Lead`, `Invoice`, `Customer`, `Payment`, `Attachment`. Pure audit, no behaviour change, no permission reads. `Payment` carries the `CLIENT` case that motivated `created_by_source`. Splittable in two if the diff gets wide.

### Not in scope

- SALES (Part D - verified, nothing to do).
- The `$0.00` `ReceiptCard` bug below - independent, four lines, its own PR.

## Open items

- **Existing orgs** - 16 staging orgs plus prod need grant backfill migrations; `defaultGrants.ts` only affects new orgs.
- **Frontend `canOnJob`** - mirror the `manage_lines Job` split in `frontend/src/lib/ability.ts` or the UI offers actions the API refuses.
- **Roles UI copy** - `manage_lines Job` needs a contractor-legible label.
- **`update Estimate`** - technicians hold none today, so an estimate attached to someone else's job is closed. It must stay closed if that grant is ever added.

## Evidence base

Live Workiz account (`app.workiz.com/root/roles`, role `tech`, 2026-08-04), full 42-permission Actions tab read from the DOM. Corroborated by a 533-article Workiz help-centre sweep and a six-platform survey (ServiceTitan, Housecall Pro, Jobber, Service Fusion, Service Autopilot, FieldEdge).

**Workiz informed the shape; it is not the target.** Three findings, and where this spec diverges:

1. **Workiz has no line-item permission at all.** A tech who can open a job can edit its items. This spec diverges deliberately - Ran wants line items gated by creation.
2. **Workiz scopes by assignment, never authorship** (`Other Users Jobs` OFF), and records authorship purely for audit. This spec diverges: authorship is the authorization input, per the rule at the top.
3. **Workiz prevents mistakes at the END of the job** - `Close Jobs` OFF, `Modify Done Jobs` OFF, with a "done pending approval" soft gate. **Not adopted**; Ran: technicians complete their own jobs. That removes the pending-approval design entirely.

Caveat on all three: this is Alpha Doors & Security's configuration, not Workiz stock defaults - the account carries custom roles. It is how a real contractor configured technicians, which is arguably the more useful reference.
