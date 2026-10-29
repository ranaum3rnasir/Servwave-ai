# Custom Fields program - slice index

**Cards:** SRVW-114 (MVP) blocks SRVW-115 (v2). Both fold into one body of work.
**Design doc:** [`2026-08-06-custom-fields-mvp-srvw-114.md`](./2026-08-06-custom-fields-mvp-srvw-114.md) -
schema, decisions, verified starting state. Read it before picking up any slice.
**Latest handoff:** [`2026-08-07-handoff.md`](./2026-08-07-handoff.md) - what slice 1 actually
shipped, the one defect to fix before promotion, and the promotion set. Read it second.
**Base branch:** `staging`. `git merge-base --is-ancestor origin/main origin/staging` returns
non-zero, so a `main`-based branch would show phantom files.

Slices are **vertical tracer bullets**: each cuts schema -> API -> UI -> tests and is demoable on its
own. They are written as local documents, not GitHub issues, per Ran's instruction 2026-08-06.

## SRVW-114 - MVP (approved to build)

| # | Slice | Type | Blocked by |
|---|-------|------|-----------|
| 1 | [Tracer: one text field on Job, end to end](./slice-01-tracer-text-field-on-job.md) | AFK | None |
| 2 | [The remaining four field types](./slice-02-remaining-field-types.md) | AFK | 1 |
| 3 | [Widen to Lead and Customer](./slice-03-widen-to-lead-and-customer.md) | AFK | 1 |
| 4 | [Values survive lead to job conversion](./slice-04-conversion-carry-over.md) | AFK | 3 |
| 5 | [Custom fields on price-book items](./slice-05-price-book-items.md) | AFK | 2, 3 |
| 6 | [Definition lifecycle: reorder, archive, required](./slice-06-definition-lifecycle.md) | AFK | 2 |

Completing 1 to 6 satisfies every SRVW-114 acceptance criterion.

## SRVW-115 - v2 (planned, NOT approved to start)

The card states v2 must not start until the MVP has proven the schema model. These are written so
the program is fully mapped, not because they are cleared to build.

| # | Slice | Type | Blocked by |
|---|-------|------|-----------|
| 7 | [List search and filter on custom-field values](./slice-07-list-search-and-filter.md) | AFK | 6 |
| 8 | [Per-job-type field scoping](./slice-08-per-job-type-scoping.md) | **HITL** | 6 |
| 9 | [Merge tokens in document templates](./slice-09-document-merge-tokens.md) | AFK | 6 |
| 10 | [Automation conditions and templates](./slice-10-automation-integration.md) | AFK | 9 |
| 11 | [Custom fields exposed to reports](./slice-11-reports-exposure.md) | **HITL** | 7 |

Completing 7 to 11 satisfies every SRVW-115 acceptance criterion.

## Dependency graph

```
1 ──┬── 2 ──┬── 5           6 ──┬── 7 ── 11
    │       └── 6                ├── 8
    └── 3 ──┬── 5                └── 9 ── 10
            └── 4
```

## Why slice 1 is the tracer

It carries the whole spine - migration, definitions table, CRUD API, Settings page, panel on a
detail page - at the narrowest possible width: one entity, one field type. Every later slice widens
an axis that is already proven, so no slice after 1 introduces a new integration layer.

All four value columns and every definition column land in slice 1's single migration. Later slices
turn behavior on; none of them adds a second migration.

## Standing gates for every slice

* Backend is TDD: failing test first, then implement.
* `npx tsc --noEmit` + `npm test --workspace=backend` before any "done" claim, real results reported.
* Every authed Prisma `where`/`data` spreads `tenantWhere(req)`.
* Design tokens only in components: no raw hex, no raw Tailwind palette class.
* Migrations portable + idempotent, never run from a worktree.
* One PR per slice into `staging`.

## Open questions carried by the program

* **`required` enforcement** (slice 6) - panel-only by default. A hard API gate needs its own submit
  endpoint, because enforcing on the shared PATCH endpoints would fail unrelated partial updates.
* **Job types are strings** (slice 8) - `Organization.job_type_options` is a JSON string array with no
  `JobType` model, so scoping has no referential integrity. This is why slice 8 is HITL.
* **Which reports** (slice 11) - report set and per-plan gating are Ran's call.
