# Scoped assignee pool — build slices

Row 017 of the Sales-Role QA tracker: *a salesperson cannot schedule a walkthrough on their own
lead.* Product ruling by Ran, 2026-08-31.

- **PRD:** [00-prd.md](00-prd.md) — also published as
  [ranro1/ALPHA_CRM#1938](https://github.com/ranro1/ALPHA_CRM/issues/1938).
- **Related permission card:** SRVW-283 — *make "assign performers other than yourself" a grantable
  permission.* This build is that card's implementation for the walkthrough half, plus the shared
  seam for the job half.

## The slices

Five tracer bullets, in dependency order. Each is a thin vertical slice through every layer, and
each is verifiable on its own.

| # | Slice | Type | Blocked by |
|---|-------|------|------------|
| 1 | [The grant exists, is held by default, and shows up in Roles](01-grant-exists-and-is-visible.md) | **HITL** | — |
| 2 | [The server refuses a foreign performer or crew member](02-server-refuses-foreign-assignee.md) | AFK | 1 |
| 3 | [The people-picker returns a scoped roster instead of nothing](03-scoped-roster-endpoint.md) | AFK | 2 |
| 4 | [The booking form seeds the rep and states the rule](04-form-seeds-the-rep-and-states-the-rule.md) | AFK | 3 |
| 5 | [The whole booking lifecycle holds for a rep on their own lead](05-lifecycle-holds-for-a-rep.md) | AFK | 4 |
| 6 | [Row 020 — a rep books and crews their own job](06-row-020-sales-books-its-own-job.md) | **HITL** | — |

Slice 6 is the exception to the ordering below: it is not part of the walkthrough chain at all.
It closes the job half that the [PRD](00-prd.md) put out of scope, after Ran ruled on it on
2026-09-01, and it depends only on slice 1's `assign User` grant existing. Like slice 1 it is
**not `auto-fix-eligible`** — permissions plus a DB migration.

The chain is strictly linear. That is not a failure to parallelise — each slice reads the thing the
one before it created, and the ordering is what makes each one independently verifiable.

## Why this order

**Enforcement lands before the door opens.** Slices 1 and 2 ship the grant and the server-side
refusal while the sales picker is still empty, so they change nothing a user can see and close a
hand-made-request hole on the way past. Only then does Slice 3 open the picker. Building it the
other way round would mean a window in which any salesperson could put any colleague on any
walkthrough.

**The symptom disappears at Slice 3, the rule is stated at Slice 4.** Slice 3 is where "No more
members" stops appearing; Slice 4 is where the field explains itself and the Schedule button comes
back to life. Both are worth demoing separately.

**Slice 5 is a regression sweep, so it goes last.** It asserts the PRD's load-bearing claim — that
row scoping was already correct — against finished behaviour rather than a moving target.

## Story coverage

All 35 user stories in the PRD are covered, with no story assigned twice:

| Slice | Stories |
|-------|---------|
| 1 | 20–25 |
| 2 | 19, 28–31, 33 |
| 3 | 13–16, 26, 27 |
| 4 | 1–5, 32 |
| 5 | 6–12, 17, 18, 34, 35 |

## Standing constraints

- **Slice 1 is not `auto-fix-eligible`.** It touches permissions and carries a DB migration; per
  `docs/agents/issue-tracker.md` those must never be picked up by the nightly cron.
- **Branch policy:** feature branch cut from `main`, first PR into `staging`. Never commit to either
  directly.
- **Verify against the merged tree.** CI runs on pull requests only, so nothing re-runs on the merge
  commit itself. Confirm the permission suites green against the merged result, not just the PR head.
- **The backfill is the only silent failure mode in the set.** Confirm row counts per org after
  deploying Slice 1 — not merely that the migration ran.
