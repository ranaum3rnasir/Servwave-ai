# Technician estimate read + tag row-scope gap

**Status:** both parts implemented, TDD-green, PR'd into staging - awaiting review/merge and live QA.
Part 1: [PR #1307](https://github.com/ranro1/ALPHA_CRM/pull/1307). Part 2: [PR #1310](https://github.com/ranro1/ALPHA_CRM/pull/1310).
**Found by:** live technician QA on prod, 2026-08-05, following the creator-tracking /
technician-creator-control promotion ([PR #1300](https://github.com/ranro1/ALPHA_CRM/pull/1300)).
**Depends on:** `md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md`
(creation confers control; every creatable entity records its creator).

Two independent gaps, two PRs, both into `staging` first. Neither touches the migrations already
live in prod.

## Part 1 - TECHNICIAN cannot read the estimates it creates (blocking live QA)

### Symptom
`role_permissions` grants TECHNICIAN `create Estimate` (added by
`20260805150000_technician_creator_control_grants`, live in prod) but no `read Estimate` of any
kind. A technician can create a standalone estimate and then cannot see it - the list/detail scope
resolves to `MATCH_NOTHING` (`scopeWhereFor`'s fail-closed default for "no read grant").

### Fix
Grant TECHNICIAN `read Estimate` with the condition already defined for exactly this shape,
`OWN_ESTIMATE_VIA_LEAD_OR_CREATOR` (`backend/src/lib/permissions/defaultGrants.ts:21`):

```ts
{
  OR: [
    { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    { AND: [{ lead_id: null }, { created_by: '{{userId}}' }] },
  ],
}
```

A technician's standalone estimate is lead-less, so it lands on the second branch, keyed off the
estimate's own `created_by` column (Estimate predates the `created_by_id` triplet - do not confuse
the two). This is the same condition SALES already uses and the same one
`canAccessEstimate`'s getById gate mirrors, so list and detail agree.

### Changes
1. **`backend/src/lib/permissions/defaultGrants.ts`** - one line, new-org default:
   `{ role: 'TECHNICIAN', action: 'read', subject: 'Estimate', conditions: OWN_ESTIMATE_VIA_LEAD_OR_CREATOR }`
2. **Backfill migration** for the 4 orgs the 2026-08-05 grants backfill already reached (B&G
   Cabinet, Servwave Demo, Talon Septic, Alpha Doors & Security) - Neon Services is deliberately
   left alone, matching the standing decision on that org. Gate the INSERT the same way
   `20260805150000_technician_creator_control_grants` gates its own statements: only orgs whose
   TECHNICIAN `read Job` row already carries the upgraded `OWN_JOB` OR `created_by_id` condition,
   so an org where an admin has since hand-edited the role is left alone rather than silently
   re-granted. `ON CONFLICT (organization_id, role, action, subject) DO NOTHING` for idempotency.
3. **Test**, TDD-first: extend the existing backfill-pinning pattern
   (`permissions-technician-creator-backfill.test.ts` is the sibling to copy) so the SQL and
   `defaultGrants.ts` stay pinned together. Add a case to `permissions-parity.test.ts` (or wherever
   TECHNICIAN's grant list is enumerated) asserting `read Estimate` is present.
4. Confirm no controller path assumed "TECHNICIAN never reads Estimate" as an implicit guard -
   grep `estimate.controller.ts` for role-literal checks before trusting the grant alone.

### Out of scope here
Widening `update Job` to own-or-created (still Ran's open call, tracked in the parent spec, not
touched by this fix).

## Part 2 - Tag routes have no per-row scope check (separate PR)

### Symptom
All five tag routes gate on `canDo(action, subject)`
(`backend/src/routes/{job,lead,estimate,invoice,customer}.routes.ts`), which is
`req.ability.can(action, subject)` with no row loaded - a **subject-level** check. CASL cannot
evaluate a row condition (e.g. `OWN_JOB`) without a row, so every technician (or anyone else with
the bare grant) passes it for every row. The handlers
(`addTagToEntity`/`removeTagFromEntity` in `backend/src/controllers/tag.controller.ts`) then only
check `entityExistsInOrg` - org tenancy, no row scope.

Net effect: a technician who can `update Job` (an unconditional role default,
`defaultGrants.ts:237`) can attach or remove a tag on **any job in the org**, not just jobs they're
assigned to or created - despite `read`/`delete`/`assign`/`manage_lines` on the same subject all
being properly row-scoped in the 2026-08-05 work. Same shape applies to `Lead`, `Estimate`,
`Invoice` wherever the acting role's `update` grant on that subject is conditional. `Customer` is
not affected the same way - `read Customer` is unconditional for every role that has it today, so
there is no existing row-scoping concept for Customer anywhere in the codebase to be inconsistent
with.

Confirmed not reachable via the UI without already having another job's id (tag pickers are
scoped), so this is an API-level gap, not a one-click UI bug - but it is a real cross-row write.

### Fix
Reuse `canAccessRow` (`backend/src/lib/permissions/enforce.ts:191`), the same helper every
update/delete controller in `job.controller.ts` already uses for its per-instance gate, keyed off
the subject's **read** scope (the established precedent for "can this actor reach this specific
row", not a new `update`-scope concept). Two-step check, matching the existing job.controller.ts
pattern exactly:

```ts
// 1. tenant-scoped existence probe (unchanged - entityExistsInOrg already does this)
// 2. row-scope gate, only for the 4 ScopeResource-backed types
if (isScopeResource(entityType) && !(await canAccessRow(req, toSubject(entityType), delegateFor(entityType), entityId))) {
  res.status(403).json({ error: 'Insufficient permissions' });
  return;
}
```

`ScopeResource` is `'Lead' | 'Job' | 'Estimate' | 'Invoice' | 'LogisticOrder'` - `Customer` has no
member and stays existence-only, consistent with the rest of the codebase.

### Changes
1. **`backend/src/controllers/tag.controller.ts`** - add the `canAccessRow` gate inside
   `addTagToEntity`/`removeTagFromEntity` for `JOB`/`LEAD`/`ESTIMATE`/`INVOICE`, after the existing
   existence check, before the tag lookup/mutation. One small type map from `TagEntityType` to
   `ScopeResource` + prisma delegate (`JOB`→`prisma.job`, etc.) - `CUSTOMER` excluded.
2. **Tests**, TDD-first, in `backend/src/__tests__/tag.test.ts`: for each of the four affected
   entity types, a case where the actor's row-scope condition does NOT match the target row and the
   endpoint now 403s on both `POST .../tags` and `DELETE .../tags/:tagId` - today these assert only
   404-on-missing and 201/204-on-success. Use the same mock/fixture shape already in the file
   (`mockAuthAs`, `CUSTOMER_FIXTURE`/`ESTIMATE_FIXTURE`/`INVOICE_FIXTURE`), add job/lead fixtures if
   the file doesn't already have them.
3. No migration - this is a code-only fix, no schema or grant-table change.

### Not bundled with Part 1
Different blast radius (five routes across four subjects, every role with a conditional `update`
grant on any of them - not just TECHNICIAN), and Part 1 is what's blocking today's live QA. Ship
Part 1 first.

## Both parts

- Worktree off `staging` (the ancestry gate is non-zero right now - `main` carries #1299/#1301
  that `staging` doesn't have yet - so per CLAUDE.md this cuts from `staging`, not `main`).
- PR into `staging`. Do not promote to `main` until Ran asks, same standing rule as everything
  else.
- Backend TDD: failing test first, per `test-driven-development` skill.
- Run `npx tsc --noEmit` (both workspaces) + `npm test --workspace=backend` before claiming done.
