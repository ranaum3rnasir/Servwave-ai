# Row 020 — a rep books and crews their own job

Sales-Role QA tracker row 020, part (2). Ruled by Ran on **2026-09-01**, which closed the question
the [PRD](00-prd.md) deliberately left open under *Out of Scope → "Widening what sales may do to
jobs"*.

## The ruling

SALES gains **scoped write rights over jobs their own lead's estimate produced** —
`OWN_JOB_VIA_ESTIMATE`, the same row scope as the `read Job` grant they already held.

## What was built: one grant, not two

The decision was taken as *"scoped assign + update on own jobs"*. It shipped as **`assign Job`
alone**, and the dropped verb is the most useful thing in this document.

`update Job` is not needed. The booking dialog (`AssignJobDialog`) posts to `POST /:id/assign` for
both of its modes; that route is gated `assign Job` and first-books the schedule **and** sets the
crew in one call. Nothing in the flow issues a `PATCH /:id`.

`update Job` is also not free. Two things ride it that nobody decided:

- **`manage_lines Job`** is pinned to mirror `update Job` role-for-role *and*
  condition-for-condition (PR 2 of the technician-ownership spec,
  `permissions-job-manage-lines.test.ts`). Granting SALES `update Job` therefore hands a rep the
  job's **line items** — money.
- **`POST /:id/notes`** is gated on the same verb.

Both surfaced as red tests rather than as review comments, which is the invariant doing its job.

## What was deliberately NOT granted

| Verb | Why not |
|---|---|
| `update Job` | Drags `manage_lines Job` (job money) and job notes along with it. See above. |
| `reschedule Job` | First-booking goes through `/assign`. **Moving** an existing booking runs through `PATCH /:id`'s `changesSchedule` check and the `/visits` routes, both gated `reschedule Job` (DISPATCHER by default). A rep can book their own job but cannot yet move it — a real, deliberate gap, and the next question if row 020 is revisited. |
| `create Job` / `delete Job` | Never part of the ruling; actively revoked, see below. |
| `assign User` | Ran's 017 ruling. `assign Job` says *which jobs*; `assign User` (slice 1) says *whose names*. SALES holding the first without the second is exactly "a rep may put themselves, and only themselves, on their own job". |

## The production over-grant this uncovered

A read-only pre-flight on 2026-09-01 found **Alpha Doors & Security** holding SALES rows for
`create`, `update` and `delete` on `Job` — **all unconditional**, all written within 18ms of each
other on 2026-08-12 by a single Roles-editor save. None of the three is in `defaultGrants.ts`.
Staging was clean; this was production-only and one org only. Four active SALES users held it,
including the QA who filed the tracker — so a salesperson at Alpha Doors could delete any job in
the org.

Two consequences worth keeping:

1. **It re-reads the finding.** The QA ran on 18 Aug, six days after that save. In Emanuel's own
   org the missing verb was never `update` — it was `assign Job`, plus the empty picker.
2. **It changed the migration.** A plain `ON CONFLICT DO NOTHING` would have let the pre-existing
   `update` row win the conflict and survive, so the migration would have reported success while
   leaving one org's salespeople with org-wide job update — silent and inverted. The migration
   revokes all three explicitly instead.

Ran's call: bring Alpha Doors in line rather than document a permanent divergence. `update` is
**deleted** rather than re-scoped, because the final shape grants SALES no `update Job` at all.

## Verification

Migration `20260901120000_sales_scoped_job_assign`. Derived from the `OWN_JOB_VIA_ESTIMATE` read row
rather than the name `SALES`, for the SRVW-138/139 custom-role reason slice 1 documents.

Measured read-only, 2026-09-01 — **count these per-org after deploying, not on the totals**:

| | insert `assign` | delete over-grant | orgs |
|---|---|---|---|
| production | +5 | −3 (Alpha Doors) | 5 |
| staging | +9 | 0 | 9 |

## Still open on row 020

- **The "Crew" label.** The QA's part (2) also said the field is *modelled* as a crew with no way to
  name an individual. That half is simply wrong — `MultiAssigneeSelect` holds a list of individual
  users and there is no crew entity; assigning exactly one person always worked. What is real is the
  **word "Crew"** on the field. Left alone here: the rename touches ~20 test files and is cosmetic,
  and it does not belong riding on a permissions change.
- **Rescheduling**, per the table above.
