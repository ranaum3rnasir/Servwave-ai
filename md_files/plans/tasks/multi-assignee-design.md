# Tasks: multiple assignees — settled design

Status: agreed 2026-08-24, awaiting implementation. Cut the branch from `staging`.

## 1. What changed and why

A task had exactly one `owner_id`. Real work is often shared, so the owner scalar is
replaced by a **flat set of assignees** — no primary, no accountable-one. Alongside it,
`watcher_ids` is redefined from an accidental CC list into a deliberate **observer** role.

Domain note driving the permission model: tasks are primarily an **office / administrative**
tool (logistics, sales, dispatch). Technicians may create their own to-dos, but the module
is not aimed at them, and nobody outside a manager/admin role opens tasks for other people.

### Rejected, deliberately

| Considered | Verdict |
|---|---|
| Owner + co-assignees | No. Flat set; there is no accountable-one. |
| Per-assignee completion | No. Done is done for everyone; `TaskSubtask` already divides work. |
| Watcher as approver (DONE → approved gate) | No. Observer only. Filed separately. |
| Removing watchers entirely | Reversed. The manager-oversees-a-delegated-task case needs a third-party follower. |
| `owner_id` compatibility shim for iOS | Unnecessary — the iOS `TaskDTO` never had the field and all its properties are Optional. |
| `CANCELLED` status | Out of scope — it is a status-model change, not a notification. Filed separately. |
| Fractional workload split for shared tasks | No. A shared task counts once per assignee. |

## 2. Data model

```prisma
model Task {
  // owner_id            String?   @db.Uuid   ← DROPPED
  assignee_ids           String[]  @default([]) @db.Uuid   // NEW — flat set, min 1 in practice
  watcher_ids            String[]  @default([]) @db.Uuid   // KEPT — observers, optional
  created_by             String    @db.Uuid                // KEPT — audit only, grants nothing
  ...
}
```

- **Array, not a join table.** No per-assignee state is needed (§1), and it mirrors
  `watcher_ids` so both lists share one mental model and one set of query helpers.
- **Known cost:** arrays carry no FK, so a deleted user's id rots in every task's array —
  exactly as `watcher_ids` already does today. Pre-existing; fix once for both lists, later.
- `created_by` is **audit only**. It no longer grants visibility (§4) and is not surfaced as
  a field in the UI — it appears in the activity feed via the existing `CREATED` event.

### Migration (one file, three steps)

1. `ALTER TABLE tasks ADD COLUMN assignee_ids uuid[] NOT NULL DEFAULT '{}';`
2. `UPDATE tasks SET assignee_ids = ARRAY[owner_id] WHERE owner_id IS NOT NULL;`
3. `ALTER TABLE tasks DROP COLUMN owner_id;`

`watcher_ids` is **not** dropped. Follow `writing-migrations` for the three places it runs.

**Precondition:** count real rows in prod before running. Clients are not using tasks
correctly yet, so the backfill is expected to be a formality — if it is not, stop and re-plan.

## 3. Assignment rules

Enforced by a new CASL grant **`assign` on `Task`**, defaulted to **ADMIN** (and grantable to
custom roles such as a sales manager — this is why it is a grant and not a `role === 'ADMIN'`
check; a hardcoded role is invisible to the custom-roles system already in production).

| Actor | Can do |
|---|---|
| No `assign` grant | Creating a task **force-assigns them**, and only them. Cannot add or remove anyone else. |
| Holds `assign` grant | Self pre-filled in the create dialog as a **removable default**; may assign anyone, any number. |

- **A task always has ≥ 1 assignee.** Non-holders cannot leave a task to zero.
- **Self-join is not allowed.** You cannot add yourself to someone else's task; only a grant
  holder adds people.
- **Escape hatch:** a creator who is the sole assignee of their own task gets rid of it by
  deleting it. Because TECHNICIAN has no `delete` grant on Task, `remove` gains a row-level
  exception: *the caller created it and is the only assignee* → allowed. No blanket delete
  grant is added (that would let a technician delete an office task reached via a job page).
- Register the grant in **both** `defaultGrants.ts` and the grants register row — these have
  drifted before.
- The user picker (`GET /api/users?eligible_for=task`) is grant-gated in the UI.

## 4. Visibility

`taskVisibilityWhere` OR-arms become:

```
assignee_ids has me   OR   watcher_ids has me          (ADMIN: everything)
```

`created_by = me` is **removed** — creating is an event, not a role. `canAccessTask` drops its
`created_by === me` check accordingly and keeps the **linked-entity fallthrough**: anyone who
can access the linked job/lead/estimate/customer can see that entity's tasks. That path is
load-bearing for the tasks tab on job and lead pages, and it is why technicians retain
read access to tasks attached to their jobs.

Accepted consequences:
- A creator who is neither assignee nor watcher cannot see their own task. This is unreachable
  in practice because creation force-assigns (§3).
- An unassigned, unlinked task is visible only to ADMINs. Also unreachable by the ≥1 rule.

## 5. Notifications

**None of this exists today.** `task.*` verbs are on the deferred list and `emit()` *silently
returns* on an unknown verb — an unregistered verb fails with no error and a green suite.
Every verb below must be registered in `templates.ts` and the known-verb set.

| Verb | Fires when | Recipients (actor always suppressed) | Priority |
|---|---|---|---|
| `task.assigned` | someone is added to `assignee_ids` (create or later) | the newly added assignees only | FEED |
| `task.watching` | someone is added to `watcher_ids` (create or later) | the newly added watchers only | FEED |
| `task.completed` | status flips to DONE | other assignees + watchers | FEED |
| `task.removed` | someone is removed from either list | the person removed | FEED |
| `task.deleted` | task is hard-deleted | assignees + watchers | FEED |

- No `needs_action` / `action_type` — nothing here is an approval.
- `task.deleted` outlives its object: **snapshot the title** into `object_label` and the body.
  Its deep link will dead-end; accepted.
- Category `TASK`. `TASK` is deliberately absent from `filterByAccess`'s scope map, so
  recipients are passthrough — whoever is resolved, gets it.
- Deferred: due-soon / overdue. They need a cron that does not exist.

## 6. Activity log

`diffTaskActivities` diffs **both** sets and emits one named event per person, replacing the
single `"reassigned the task"` string:

- `"assigned Dana"` / `"unassigned Sagiv"`
- `"added Dana as watcher"` / `"removed Dana as watcher"`

The same diff feeds §5's recipient lists — compute it once. Named entries are what make
§3's unrestricted watcher editing survivable (oversight the overseen party can delete).

## 7. UI

- **Assignee field:** multi-select; avatar stack capped at 3 + "+N", full names on hover.
  Replaces the single owner name on the card, list rows and calendar chips.
- **Create dialog:** self pre-filled; the field is disabled for non-grant-holders.
- **Watcher field:** unchanged component, now optional and never auto-seeded with the creator.
- **Filters:** member and department filters become `includes` tests. Text search matches any
  assignee's name. A task with assignees in two departments matches both filters — accepted,
  because it is true.
- **No "Created by" chip and no "Created by me" lens** — creator is audit-only (§2).
- **Workload / risk:** a shared task counts **once for each** assignee. Org-wide open-task
  totals will therefore exceed the number of tasks. Accepted.
- The AI task assistant is out of scope for this change.

## 8. Delivery

Two stacked PRs, `staging` first:

1. **Multi-assign** — schema + migration, `assign` grant, visibility, API, activity diff, UI.
2. **Notifications** — the five verbs, templates, recipient resolution.

PR 2 needs the assignee/watcher diff from PR 1. After PR 1 lands, rebase PR 2 with
`rebase --onto` — this repo squash-merges, which breaks stacked bases.

## 9. Test strategy

The sharpest risk is §5's silent no-op. Two guards, both required:

1. **Row-level assertions.** Create a task with two assignees and a watcher, then assert
   `NotificationRecipient` rows exist for exactly the expected user ids. Do **not** assert on
   a mocked `emit` — that passes while the feature delivers nothing.
2. **Verb registration unit test.** `isKnownVerb()` returns true for all five verbs.

Plus:
- Non-grant-holder create → assignees is exactly `[creator]`; attempting to add another → 403.
- Grant-holder create for someone else → creator is **not** on the task.
- Creator is **not** auto-added to `watcher_ids` (this reverses today's behaviour).
- Sole-assignee creator can delete their own task without a `delete` grant; a non-creator
  technician cannot delete a task reached via a linked job.
- Visibility: a former assignee who was removed can no longer read the task.

## 10. Filed separately

- **Watcher approval gate** — DONE as "submitted" awaiting a watcher's ratification. The
  notification system already supports the shape (`needs_action` + `action_type`, as inventory
  does). Needs answers for multi-watcher and zero-watcher cases.
- **`CANCELLED` task status** — enum, board treatment, whether it sets `completed_at`.
- **Hard delete destroys the audit trail** — `DELETE /api/tasks/:id` also wipes the task's
  notes and timeline events, so "who created this" is durable only until someone deletes it.
  Contradicts the audit rationale for keeping `created_by`.
- **Privilege escalation by assignment** — assignment grants visibility, so a grant holder can
  hand out read access to a linked job a user could not otherwise see. Pre-existing.
- **Dangling user ids in `assignee_ids` / `watcher_ids`** — no FK on either array.
