# Slice 02 — `CalendarEntry` + `CalendarEntryParticipant`: model, migration, CRUD API

**Type:** AFK
**Blocked by:** Slice 01 — The `CalendarEntry` permission subject, seeded into every existing org
**Spec sections:** §2, §4, §7, §8

## What to build

The two tables and a permission-gated REST resource over them. At the end of this slice a
dispatcher can create, list, read, edit and hard-delete a Calendar Entry over the API, with
participants attached, and nothing renders it yet.

**Schema** (`backend/prisma/schema.prisma`), following the `Task` model as the style reference —
org-scoped, `created_by` a plain FK column, `@@map` to a snake_case table:

```
enum CalendarParticipantKind { USER CUSTOMER }

model CalendarEntry {
  id, organization_id, title, description (String @default("")),
  start (DateTime), end (DateTime), is_all_day (Boolean @default(false)),
  rrule (String?), recurrence_until (DateTime?),
  created_by, created_at, updated_at
  participants CalendarEntryParticipant[]
  @@map("calendar_entries")
}

model CalendarEntryParticipant {
  id, organization_id, calendar_entry_id,
  kind (CalendarParticipantKind), user_id (String?), customer_id (String?),
  notified_at (DateTime?)
  @@map("calendar_entry_participants")
}
```

Decisions that are load-bearing and must not be quietly changed:

- **`start` and `end` are both required.** §2 is explicit that one entry spans multiple days as
  one row — "Dave is on vacation Mon–Fri" is one row, not five. There is no duration column and
  no derivation of the end from a duration; the walkthrough shape's `duration_minutes` is what
  §8 calls out as the reason walkthrough all-day is broken, and this table must not inherit it.
- **`rrule` and `recurrence_until` ship in this first migration, written null, never read.** §2:
  two nullable columns now make recurrence an additive change later instead of a migration
  against live rows. The API must **not** accept them and the controller must **not** select
  them into the response — a reserved column that leaks into the payload becomes a de-facto
  contract.
- **`CalendarEntryParticipant` carries its own `organization_id`.** It is not derivable at the
  row level without a join, and the RLS backstop below is per-table. `NotificationRecipient`
  carries `organization_id` for the same reason.
- **No record number.** §2: `SchedulableEvent.number` is satisfied by `''` in the adapter.
  Do not touch `lib/numbering.ts` / `allocateNumber`.
- **The creator is not a participant.** `created_by` is a plain column and the create handler
  must not insert a participant row for the caller.
- **Delete is a hard delete** (§7) — `onDelete: Cascade` from entry to participants. No
  `archived_at`, no soft-delete column.

**RLS.** Both new tables are org-scoped, so both need the `tenant_isolation` backstop in the same
migration, in the exact shape of `20260807140000_custom_field_definitions_rls`: `ENABLE` +
`FORCE ROW LEVEL SECURITY`, `DROP POLICY IF EXISTS` then `CREATE POLICY "tenant_isolation"` with
the canonical predicate, plus the guarded `REVOKE ALL PRIVILEGES ... FROM anon` /
`FROM authenticated` blocks (each role guarded separately — one combined `REVOKE` naming both
fails outright when only one role exists). `rls-coverage.test.ts` is a ratchet over every table
with an `organization_id` column and runs in the `Database (migrations + RLS)` CI job, so a
missing policy reddens CI rather than reaching prod.

**API** — `backend/src/controllers/calendar-entry.controller.ts` +
`backend/src/routes/calendar-entry.routes.ts`, mounted at `/api/calendar-entries` in
`backend/src/app.ts`. Follow `task.controller.ts` / `task.routes.ts`: exported zod schemas, the
`authenticate, attachAbility` router-level `use`, and per-route `canDo(action, 'CalendarEntry')`
plus `validate(schema)`.

- `GET /` — list. Takes `start_after` and `start_before` (ISO instants). The filter is an
  **overlap** test, not containment: `start <= start_before AND end >= start_after`. A five-day
  vacation entry has to appear in every week it spans, and a containment filter would drop it
  from the middle weeks.
- `POST /` `GET /:id` `PATCH /:id` `DELETE /:id`.
- Participants are a **single array on the entry payload**, `participants: [{ kind, user_id?,
  customer_id? }]`, replaced wholesale on `PATCH` (REPLACE semantics — the same shape the
  scheduler's crew editing already uses). Zod refines that `kind === 'USER'` iff `user_id` is
  set and `kind === 'CUSTOMER'` iff `customer_id` is set. **Zero participants is valid** and
  must have an explicit test — §2 calls it normal and expected.
- Every read is `tenantWhere`-scoped, and both `user_id` and `customer_id` are verified to
  belong to the caller's org before insert.
- The list response includes each participant's display fields (user first/last name,
  customer name and `email`) so later slices do not each re-resolve them.

## Acceptance criteria

- [ ] `npx prisma migrate deploy` applies cleanly and `npx prisma migrate status` reports no
      drift (the CI `Database` job runs both).
- [ ] `rls-coverage.test.ts` passes with `calendar_entries` and `calendar_entry_participants`
      present and carrying the canonical `tenant_isolation` predicate — neither is added to
      `GLOBAL_BY_DESIGN`.
- [ ] A new `backend/src/__tests__/calendar-entries.test.ts` covers: create with 0 participants →
      201; create with 1 user + 1 customer participant → both rows written; create does **not**
      write a participant row for `created_by`; `PATCH` replaces the participant set wholesale;
      `DELETE` removes the entry and cascades its participants.
- [ ] A cross-org read (`GET /:id` for another org's entry) returns 404, not the row.
- [ ] Each of the four routes returns 403 for a role without the matching grant — assert with
      `mockRoleGrantsWithout` for a SALES caller, and 200/201 for DISPATCHER.
- [ ] `rrule` and `recurrence_until` are rejected by the create/update zod schemas and are absent
      from every response body — asserted, not assumed.
- [ ] A multi-day entry (Mon 09:00 → Fri 17:00) is returned by a `GET /` window covering only
      Wednesday.

## Out of scope for this slice

- Anything on the board — Slice 03.
- Any UI at all — Slice 04.
- Any email or in-app notification, and the `notified_at` column stays unwritten — Slice 07.
- Recurrence expansion — permanently out (§8); the columns exist and are never read.

## Verification

`cd backend && npm test -- calendar-entries` and `npm test -- rls-coverage`. Then against staging:
`POST /api/calendar-entries` with a title, a start, an end and one user + one customer
participant; `GET /api/calendar-entries?start_after=...&start_before=...` and confirm the row
comes back with both participants resolved; `DELETE` it and confirm the participant rows are
gone (`SELECT count(*) FROM calendar_entry_participants WHERE calendar_entry_id = '<id>'` → 0).
