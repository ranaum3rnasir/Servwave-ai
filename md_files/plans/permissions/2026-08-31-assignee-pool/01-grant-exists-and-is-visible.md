# Slice 1 — The grant exists, is held by default, and shows up in Roles

**Type:** HITL — carries a DB migration and a production backfill.
**Blocked by:** None — can start immediately.
**Covers user stories:** 20, 21, 22, 23, 24, 25.

## Parent

[00-prd.md](00-prd.md) — *Scoped assignee pool: a salesperson can schedule their own walkthrough.*
Also published as GitHub issue [ranro1/ALPHA_CRM#1938](https://github.com/ranro1/ALPHA_CRM/issues/1938).

## What to build

Introduce a single new permission — **assign crew and performers other than yourself** — into the
permission catalog, grant it by default to the roles that already behave that way, and backfill it
onto every existing org so nobody's effective permissions change on deploy.

The subject of the grant is the **people being named**, not the work. One grant spans two kinds of
work (a job's crew and a walkthrough's performers), so naming it after either would misdescribe half
of what it governs.

Nothing consumes the grant in this slice. It is inert by design: the point of shipping it alone is
that the migration and backfill land, and can be verified in production, before any behaviour hangs
off them. Model it directly on the shipped task-assign grant, which already implements this exact
self-versus-others distinction and is the prior art a reviewer should compare against.

## Acceptance criteria

- [x] The catalog carries exactly one new entry, whose description reads as one capability covering
      both job crew and walkthrough performers, filed under a category that makes sense in the Roles
      screen.
- [x] DISPATCHER and TECHNICIAN hold it by default. TECHNICIAN is not optional — a technician who
      created a job can add colleagues to its crew today, and omitting them here becomes a silent
      removal of a working capability two slices from now.
- [x] SALES deliberately does not hold it.
- [x] ADMIN reaches it through manage-all and needs no explicit row.
- [x] A migration backfills the row onto the DISPATCHER and TECHNICIAN roles of every existing org.
- [x] The Roles screen renders it as a single switch, grantable to a custom role and settable as a
      per-user override (allow and deny).
- [x] Revoking it takes effect on the holder's next request — no session rebuild required.
- [x] **No behaviour changes anywhere.** Every picker, validator and route behaves exactly as it did
      before this slice; the grant is read by nothing yet.
- [ ] **Still open — nothing is deployed yet.** After deploy, the backfilled row count is confirmed
      **per org** against the number of orgs holding each role, not merely that the migration appears
      in the ledger. Pre-flighted read-only on 2026-08-31: expect **10 rows across 5/5 prod orgs**
      and **20 across 9/9 on staging** (see the implementation record below). Any other number, or
      any org at zero, is the silent demotion this slice exists to prevent.

## Why HITL

This is the one slice in the set whose failure mode is silent and inverted. Everything downstream
fails closed and visibly. A missing or partial backfill fails the other way: dispatchers and
technicians in live orgs come out of the deploy quietly demoted to self-only, and the symptom looks
exactly like the bug this whole PRD sets out to fix.

Per `docs/agents/issue-tracker.md`, this touches permissions and carries a DB migration, so it is
**not** `auto-fix-eligible` and must not be picked up by the nightly cron.

## Notes

Feature branch cut from `main`, first PR into `staging`, per the repo's branching policy. CI runs on
pull requests only, so confirm the permission suites green against the **merged** tree, not just the
PR head.


---

## Implementation record (branch `feat/assign-others-grant`, cut from `main`)

**The pair is `assign` + `User`.** No new `Action` and no new `Subject` — `assign` already exists
(`assign Task`, `assign Job`, `assign Lead`) and so does `User`. That keeps the diff to one catalog
row, and it puts the grant exactly one subject over from its prior art: `assign Task` is already
"Assign tasks to other people", with the same self-versus-others shape and the same reason for
being a grant rather than a role test.

`assign User` does **not** replace `assign Job` / `unassign Job`. Those answer *which jobs* a caller
may re-crew; this answers *whose names* may go there. They compose per-instance — a technician holds
`assign Job` scoped `CREATED_BY_ME` and this org-wide, which intersects to "other people, on my own
jobs". Unconditional is correct rather than merely convenient: `User` is not in `ScopeResource`
(`Lead | Job | Estimate | Invoice | LogisticOrder`), so a condition here would be inert *and*
misleading.

**What shipped**

| Layer | Change |
|---|---|
| `catalog.ts` | one `assign:User` row, category `Users` |
| `defaultGrants.ts` | DISPATCHER + TECHNICIAN rows, unconditional |
| `roleViewModel.ts` | `SENSITIVE.assignOthers` bundle + view-model key + emitter |
| `role.controller.ts` | `assignOthers: true` in the two full-access view models (so it enters `MANAGED_KEYS`) |
| `userCapabilities.ts` | per-user override entry, no `ownCondition`, no `impliesRead` |
| migration `20260831120000_assign_others_grant_backfill` | backfill |
| v2 `RolesPage.tsx` + `lib/api/roles.ts` | the switch, on the **routed** fork |

**The backfill derives from `assign Job`, it does not name roles.** The calendar-entry precedent
could `CROSS JOIN organizations` and hardcode `'DISPATCHER'` because it granted something nobody
had. This one preserves something DISPATCHER and TECHNICIAN can already do, so anything it misses is
demoted at slice 2. A hardcoded role list misses custom roles — SRVW-138/139 writes a custom role's
`key` into `role_permissions.role`, and one cloned from DISPATCHER carries a full copy of its
grants. `assign Job` is the honest proxy for "can put people on work today", and it sits outside
`MANAGED_KEYS`, so the Roles editor can never have stripped it. SALES is excluded by construction
rather than by name: no SALES row anywhere holds `assign Job`.

**Pre-flight counts (read-only, 2026-08-31) — this is the expected post-deploy number.**

| | orgs | live custom roles | rows the backfill inserts | orgs covered | already present |
|---|---|---|---|---|---|
| prod `alpha-crm-cutover-clone` | 5 | 0 | **10** | 5 / 5 | 0 |
| staging `knriiqdqxgfoecsfarlx` | 9 | 0 | **20** | 9 / 9 | 0 |

Every org is covered — no org matched zero rows, which is the failure this slice was marked HITL
for. Both DBs hold 0 live custom roles today, so the custom-role reasoning above is future-proofing,
not present coverage; the derived gate costs nothing either way.

**Gates.** `tsc --noEmit` clean on both workspaces (4 pre-existing backend test errors on `main`,
in files this branch does not touch). 931 backend permission/role/task tests green; 23 frontend
roles tests green; the 28 new backend and 8 new frontend specs green. `lint-changed-lines.mjs`
reports 0 errors on changed lines.

**The tests were mutation-checked, not merely run** — a green suite proves nothing about a slice
whose whole claim is "nothing changed". Eight mutations, each caught:

| Mutation | Failures |
|---|---|
| drop the TECHNICIAN default grant | 4 |
| drop the catalog entry | 9 |
| hardcode `role = 'DISPATCHER'` in the migration | 10 |
| `viewModelToGrants` stops emitting the bundle | 3 |
| `assembleRoleViewModel` stops reading it back | 1 |
| a controller starts reading `can('assign','User')` | 1 |
| the switch ships to the dead v1 `RolesPage` fork | 8 |
| the label drops the "walkthrough" half | 1 |

**Two things worth knowing before slice 2.**

1. `permissions-assign-others-backfill.test.ts` ends with a block titled *DELETE THIS BLOCK IN
   SLICE 2*. It walks `controllers/`, `services/` and `lib/` asserting nothing calls
   `can('assign','User')` — the executable form of "inert by design". Slice 2 adds the first
   reader, so it is meant to go red exactly then.
2. "Revoking takes effect on the holder's next request" needed no work and got no new test: the
   ability is rebuilt per request from grants (60s cache, `clearPermissionCache(orgId)` on every
   role Save), never baked into the session. Existing infrastructure, already covered.

**Merge note.** Cut from `main` per branching policy, first PR into `staging`. `staging` carries the
manual-communication-log slice (#1911, unpromoted), which added its own `logPastCommunications`
bundle at the same four points in `roleViewModel.ts` / `roles.ts` / v2 `RolesPage.tsx`. Expect
additive conflicts there. Resolve by keeping **staging's block first, then this one** — resolving in
a different order than the source branch is what silently duplicates a block on the back-merge.

---

## Review, live QA and merge record (PR #1940)

### The custom-role claim was understated, and is now measured

The implementation record above says both DBs hold "0 live custom roles", read from the
`custom_roles` table. That is true and beside the point: the gate reads `role_permissions.role`,
and **staging has three custom role keys holding `assign Job` right now** —
`qa-bug-repro`, `qa-bug-repro-2`, `zz-reachability-probe` — alongside DISPATCHER and TECHNICIAN.
A migration that hardcoded the two system role names would have missed all three.

| | orgs | distinct roles holding `assign Job` | rows the backfill inserts | orgs covered |
|---|---|---|---|---|
| prod | 5 | 2 (DISPATCHER, TECHNICIAN) | **10** | 5 / 5 |
| staging | 9 | **5** (+ 3 custom keys) | **20** | 9 / 9 |

Prod is still 10 across 5/5, so the post-deploy number to confirm is unchanged.

### Two review findings worth the fix

**A stale admin tab could delete the freshly backfilled row.** Every SENSITIVE bundle sits inside
`MANAGED_KEYS`, so a Save whose body omits one was read as OFF and the grant deleted. That was
harmless for every previous bundle, because a bundle's grant could only ever have come from the
editor itself — nobody held `editRecordIds` without a tab that knew the key. `assign User` breaks
that assumption: **a migration writes it**, so a Roles tab loaded before the frontend deploy holds
no `assignOthers` key while the org already holds the grant. Vercel and Render deploy
independently, so the window is real, and an admin ticking an unrelated box inside it would demote
that role with nothing to re-create the row — the exact failure this slice exists to prevent,
arriving through the editor instead of the backfill.

Fixed by freezing any sensitive bundle whose key is **absent** from the posted body, derived from
`SENSITIVE` so a bundle added later is covered without anyone remembering. It can only refuse a
deletion: turning a switch off sends `false`, never absence. Three tests, mutation-checked in both
directions — removing the freeze turns the stale-tab test red; freezing unconditionally turns the
revoke tests red.

**The inertness guard did not match the shape a slice-2 author would write.** It walked only
`controllers/`, `services/` and `lib/`, and matched only `can('assign','User')` — so a reader added
the conventional way, `canDo(...)` on a route line or `canActOnRow(...)`, left it green. It now
walks `routes/` and `middleware/` too and matches all three shapes; verified by adding a `canDo`
reader to a route file and watching it fail.

Also: the "is the newest migration in the tree" assertion was deleted. Its premise was wrong —
`prisma migrate deploy` applies any folder absent from `_prisma_migrations` regardless of sort
position — and it would have turned a *permissions* suite red on the next unrelated PR to add a
migration.

**"Nothing reads it" means nothing GATES on it.** `user.controller.ts` walks `USER_CAPABILITIES`
and computes each row's default through `ability.can(...)`, so the per-user Permissions dialog
gains an "Assign work to other people" row on deploy. That is story 23, not a behaviour change.

### Live QA — staging DB, demo org, state restored

Driven against the branch's own backend and frontend, pointed at the staging database.

1. The switch renders on the **routed** v2 Roles page, under Sensitive, with both surfaces named.
2. Ticking it on TECHNICIAN and saving → `PUT /api/roles/TECHNICIAN/permissions` 200 → the row
   `TECHNICIAN | assign | User | conditions NULL` appears in `role_permissions`.
3. Full page reload → the switch reads back ON. Not optimistic state.
4. Unticking and saving → the row is **deleted**, confirming the pair really is inside
   `MANAGED_KEYS` and the switch is not one-way.
5. Staging left exactly as found: no `assign User` row in the demo org.

### Merge

`origin/staging` merged into the branch: six conflicts, all additive collisions with the
manual-communication-log slice (#1911) at the four predicted points plus two fixture suites.
Resolved by keeping **both, staging's block first**, everywhere. `staging`'s own
`permissions-manual-communication-log.test.ts` gained `assignOthers` in its two fixtures — the
view-model interface is exhaustive, so the two slices' keys are in lockstep by construction.
