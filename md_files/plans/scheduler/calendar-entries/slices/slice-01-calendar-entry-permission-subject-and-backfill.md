# Slice 01 — The `CalendarEntry` permission subject, seeded into every existing org

**Type:** AFK
**Blocked by:** None — can start immediately
**Spec sections:** §4, §9 risk 2

## What to build

The permission plumbing for Calendar Entries, shipped on its own and **before the table exists**.
Nothing in this slice reads or writes a Calendar Entry; what it delivers is that on every
organization — the ones already in staging and prod, not just a freshly seeded one — ADMIN and
DISPATCHER hold `read` / `create` / `update` / `delete` on a new CASL subject `CalendarEntry`, an
admin can see and toggle that on the Roles & Permissions screen under the label **Events**, and a
SALES user can be granted it individually.

Shipping permission plumbing ahead of the capability it gates is this project's own established
move: `20260819230000_editable_record_ids_dispatcher_backfill` did exactly that for DISPATCHER
`renumber`, whose `PATCH .../:id/number` endpoints landed in a later PR. Doing the same here is
what lets §9 risk 2 — "the per-org grant backfill is the most likely thing to ship broken and be
invisible in testing, because the developer's own org will have the grant" — be reviewed and
verified as the only thing in the diff.

The pieces, and the decisions inside them:

- **`backend/src/lib/permissions/catalog.ts`** — `'CalendarEntry'` joins the `Subject` union, and
  four `PERMISSION_CATALOG` rows land under a new `category: 'Calendar'`. The `description`
  strings use the user-facing word: "View events", "Create events", "Edit events", "Delete
  events". No new `Action` values — read/create/update/delete already exist.
- **`backend/src/lib/permissions/defaultGrants.ts`** — four `DISPATCHER` rows, `conditions`
  absent (visibility is org-wide per §4, so there is no own-scope condition to write). **ADMIN
  gets no rows** — it reaches the subject through the code-level manage-all bypass, same as every
  other subject. **SALES and TECHNICIAN get no rows**, deliberately.
- **`backend/src/lib/permissions/roleViewModel.ts`** — `MODULES` gains
  `{ subject: 'CalendarEntry', label: 'Events' }`. Without this row the grants exist but the
  Roles editor has no cell for them, so `MANAGED_KEYS` never covers them and an admin can
  neither see nor change them (the D15 `complete Job` shape, recorded in the `TOGGLES` comment
  in that file). `CalendarEntry` is **not** added to `SCOPE_ENTITIES` — there is no ownership
  chain and no own-scope.
- **`backend/src/lib/permissions/userCapabilities.ts`** — `create` and `update` entries so §4's
  "a SALES user who needs it gets it through `UserPermissionOverride`" is actually reachable from
  the per-user Permissions page. Note the header contract in that file: per-user grants are
  fixed own-scoped, and an `impliesRead` write toggle auto-adds the paired `read`. Because
  `CalendarEntry` is not a `ScopeResource`, `scopeWhereFor` returns `{}` for it and the override
  yields the org-wide read §4 requires. Confirm that rather than assuming it.
- **`frontend/src/lib/ability.ts`** — `'CalendarEntry'` joins `AppSubject`, kept in lockstep with
  the backend catalog the way every other subject in that union is.
- **The backfill migration** — `backend/prisma/migrations/<ts>_calendar_entry_dispatcher_grants_backfill/migration.sql`,
  copied in shape from `20260819230000_editable_record_ids_dispatcher_backfill`:
  `INSERT ... SELECT ... FROM organizations o CROSS JOIN (VALUES ...) ON CONFLICT
  (organization_id, role, action, subject) DO NOTHING`. Portable vanilla Postgres, idempotent,
  safe to re-run on the shared staging database.

## Acceptance criteria

- [ ] `PERMISSION_CATALOG` holds exactly four `CalendarEntry` rows (read/create/update/delete) and
      `isCatalogEntry('read', 'CalendarEntry')` is true.
- [ ] `DEFAULT_GRANTS` holds exactly four `CalendarEntry` rows, all `role: 'DISPATCHER'`, all with
      no `conditions`. A test asserts there are **zero** `SALES` and zero `TECHNICIAN`
      `CalendarEntry` rows, and zero `ADMIN` rows.
- [ ] A new `backend/src/__tests__/permissions-calendar-entry-backfill.test.ts`, modelled on
      `permissions-technician-pricebook-backfill.test.ts`, reads the migration SQL as text and
      asserts it contains `FROM organizations`, `CROSS JOIN (VALUES`, and
      `ON CONFLICT (organization_id, role, action, subject) DO NOTHING`; and that every row in
      `DEFAULT_GRANTS.filter(g => g.subject === 'CalendarEntry')` appears verbatim as a
      `('DISPATCHER','<action>','CalendarEntry',NULL)` tuple in that SQL.
- [ ] **Every existing org is covered, proven against a real database, not one org.** After
      applying the migration to staging, this query returns `0`:
      `SELECT count(*) FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM role_permissions rp
      WHERE rp.organization_id = o.id AND rp.role = 'DISPATCHER' AND rp.subject = 'CalendarEntry'
      AND rp.action = 'read');` — and the same query returns `0` for `create`, `update` and
      `delete`. Record the org count alongside the zero, so "0 of 0 orgs" cannot pass as a green.
- [ ] `cd backend && npx tsx src/scripts/check-role-permission-drift.ts --strict` exits 0 —
      the stored rows and `DEFAULT_GRANTS` agree for every org.
- [ ] `frontend/src/lib/ability.ts`'s `AppSubject` union contains `'CalendarEntry'` and the
      frontend type-check passes.
- [ ] The Roles & Permissions screen renders an **Events** row with the four CRUD cells, and
      saving that role round-trips without dropping any other grant.

## Out of scope for this slice

- The `calendar_entries` table and any API — Slice 02.
- Any UI that reads or writes a Calendar Entry.
- Plan-tier gating. §4 is explicit: this is core scheduler for every tier, so no
  `requireFeature` anywhere.

## Verification

`cd backend && npm test -- permissions-calendar-entry-backfill` and
`npm test -- check-role-permission-drift`. Then apply the migration against staging and run the
four `NOT EXISTS` count queries above; paste the counts into the PR. Finally open
Settings → Roles & Permissions as an ADMIN, confirm the **Events** row is present with
DISPATCHER's four cells ticked, and confirm SALES' four cells are unticked.
