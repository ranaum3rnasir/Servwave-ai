# Tasks follow-ups — staging acceptance (2026-08-25)

Hosted version: https://claude.ai/code/artifact/25c85b9a-9a80-4a01-a922-e01c58411740

Covers the five issues merged into `staging` on 2026-08-25:

| PR | Issue | Merge |
|---|---|---|
| #1755 | 02 — dangling user ids in task people arrays | `883fc5b3b` |
| #1757 | 03 — CANCELLED task status | `c7ec0ea9b` |
| #1758 | 01 — redact linked-entity labels | `9349cbe28` |
| #1756 | 04 — deleting a task destroys its audit trail | `0463ddeac` |
| #1759 | 05 — warn when assigning someone without entity access | `0a96bd7f2` |

## Verified before testing (checked live, not inferred)

- `servwave-demo.vercel.app` serves `0a96bd7f2` (the #1759 merge). All five features present in the
  shipped chunks: `entity-access`, `linked_entity_redacted`, `entity_deleted`, `CANCELLED`.
- `pg_enum` lists 5 labels for `TaskStatus`, ending in `CANCELLED` — the catalog itself, not the
  migration ledger (the `20260819190000_jobstatus_enum_repair` trap).
- Migrations applied: `20260825120000_task_people_arrays_drop_inactive` 08:17Z,
  `20260825130000_task_status_cancelled` 08:20Z.
- **Staging API is `https://alpha-crm-test-env.onrender.com`.** The URLs our docs used to name
  (`staging.alphacrm.com`, `alpha-crm-staging-api.onrender.com`, `alpha-crm-staging.vercel.app`)
  are all dead — a parked domain, a suspended Render service and a 404. Corrected in this same
  change; `go-live-playbook.md` is the live environment map.
- Issue 02's backfill swept **0 rows** on staging: there were no dangling ids. A clean backfill is
  not evidence the sweep works, hence the manufactured fixtures in scenario 4.

Org: **ServWave Test** `00000000-0000-0000-0000-000000000001` — 22 active users, 43 tasks.

## Accounts with real logins

| Who | Email | Role | Why |
|---|---|---|---|
| Ran Roffe | `ranroffe@servwave.com` | ADMIN | Only role holding `assign Task` by default |
| Mike Turner | `mike.turner@alphacrm.com` | TECHNICIAN | On 57 job crews — but **not** J00001's |
| Mike Rivera | `tech@alphacrm.com` | TECHNICIAN | On 62 job crews, J00001 **among them** — the control |
| Test Technician | `technician@alphacrm.com` | TECHNICIAN | Disposable; scenario 4 deactivates it |
| Test Dispatcher | `dispatcher@alphacrm.com` | DISPATCHER | Unscoped `read Job`, never flagged |

Run in order — scenario 4 deactivates a user and there is one clean shot at it.

## 1. Assign-time warning + read-time redaction (#1759 + #1758)

As admin, create `QA-1 access split` linked to job **J00001**; assign **Mike Rivera** and
**Mike Turner**. Then sign in as `mike.turner@alphacrm.com`, open the task, and edit it (change
priority).

The pair is the point: both are technicians with dozens of jobs each, and they differ on exactly
one — J00001. A fix that decides access by role rather than by the job passes a single-user test
and fails this one.

**Pass** — Mike Turner badged `No access`, Mike Rivera not; one note reading *"Flagged people
cannot open J00001 … . You can still add them; that link stays hidden from them."*; exactly **12**
of 22 roster names badged (3 SALES + 9 TECHNICIAN); as Mike Turner the chip reads `Restricted job`
as plain text, and still does after the edit.

**Fail** — all or no names badged (batching collapsed to one verdict); Mike Rivera badged (access
decided by role, not by the job); the real `J00001 · …` label visible to Mike Turner; **chip goes
blank after the edit** (a real defect found during the run — the write response carries no label and the
client must keep the one it had).

The 12 is derived from the grant conditions against today's staging data, not observed in a browser:
SALES reach a job only via its estimate's lead, TECHNICIANs only via a visit crew. A different count
is itself a finding.

## 2. Cancelled is not completed (#1757)

Create `QA-2 cancel me` with a past due date. Confirm it is on the Board and overdue, then set
status to **Cancelled** from the drawer (there is no drag path — Cancelled has no lane).

**Pass** — leaves the board; appears on **History** struck through with a CANCELLED chip; stops
reading overdue; `completed_at` is null, gets stamped on DONE, returns to null on re-cancel.

**Fail** — cancelling stamps `completed_at`; card stays on the board; History shows it as a
completion; still flagged overdue.

```sql
SELECT task_number, status, completed_at, updated_at
FROM tasks
WHERE organization_id = '00000000-0000-0000-0000-000000000001' AND title LIKE 'QA-2%';
```

## 3. A deleted task still names who deleted it (#1756)

Create `QA-3 delete me`, note its task number, give it a comment and a status change, delete it,
then read **Recent Activity** on the main Dashboard page (not the Tasks hub's Dashboard tab).

**Pass** — a trash-glyph row reading `T000xx · QA-3 delete me` with a **Deleted** badge, actor name
resolved.

**Fail** — no row; empty label or bare uuid; a row labelled with another record sharing the id.

Knock-on to decide before promotion: surviving events name their actor, so a user whose only history
was creating and deleting a task can no longer be hard-deleted. Arguably correct, but nobody asked
for it.

## 4. Deactivation hands tasks over rather than stranding them (#1755)

Build **all three** fixtures before deactivating anyone.

- `QA-4 handover` — assignee Test Technician only (remove yourself); you stay the creator.
- `QA-4 partial` — assignees Test Technician + Mike Rivera.
- `QA-4 ghost` — assignee Test Technician plus a dead id, which the UI cannot produce:

```sql
UPDATE tasks
SET assignee_ids = ARRAY[
      '00000000-0000-0000-0000-0000000000ff',   -- a user who does not exist
      'cf7d9f70-de5b-4291-90f9-b0623622f9a3'    -- Test Technician
    ]::uuid[]
WHERE organization_id = '00000000-0000-0000-0000-000000000001' AND title = 'QA-4 ghost';
```

Then, once: Settings → Team → deactivate `technician@alphacrm.com`.

**Pass** — `QA-4 handover` reassigned to you (the creator) with a *task assigned* notification;
`QA-4 partial` keeps Mike Rivera; `QA-4 ghost` is assigned to you alone (the dead id went too); the
sweep query returns 0 rows including watchers.

**Fail** — any task with zero assignees; a blank/ghost chip; `QA-4 ghost` still carrying `…0000ff`
(the whole defect class — removing only the triggering id leaves the task assigned solely to
somebody who does not exist, and it looks fine in every screen); watchers cleaned but assignees not.

```sql
SELECT task_number, title, assignee_ids, watcher_ids
FROM tasks
WHERE organization_id = '00000000-0000-0000-0000-000000000001'
  AND ( assignee_ids @> ARRAY['cf7d9f70-de5b-4291-90f9-b0623622f9a3']::uuid[]
     OR watcher_ids  @> ARRAY['cf7d9f70-de5b-4291-90f9-b0623622f9a3']::uuid[] );
-- must return 0 rows
```

Reactivating the user afterwards does **not** put them back on anything — deliberate, but worth
seeing once before production.

## Cleanup

Delete `QA-1`..`QA-4`; reactivate `technician@alphacrm.com`. Deleting them now leaves `DELETED`
timeline events behind by design (that is #1756), so four rows will appear in Recent Activity.

## Deliberately not covered

- `revokeLogin` does not sweep — it clears `has_login`, not `is_active`. Such a user can never sign
  in, so their tasks are unreachable in practice, but the ids stay put.
- The handover emits one notification per task, synchronously, inside the deactivation request.
  Fine for a handful; unbounded for someone solely assigned to hundreds.
- Redaction is label-only: `linked_entity_id` / `linked_entity_type` still travel on the wire.
- Pre-existing: an admin-derived **custom** role still sees every task in the org on the list —
  `taskVisibilityWhere` tests `role !== 'ADMIN'` rather than the super-user predicate.
- `getActivityReport` needs nothing: it resolves no entity label and renders no link, so it is
  structurally immune. Issue 04's acceptance criteria implied otherwise and were wrong; a controller
  test pins it.
