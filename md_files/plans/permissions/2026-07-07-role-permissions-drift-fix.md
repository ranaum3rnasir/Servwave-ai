# role_permissions drift fix — plan

## Problem (verified via code read + live DB query, staging + prod)

`role_permissions` (per-org SALES/DISPATCHER/TECHNICIAN grants, `backend/src/lib/permissions/defaultGrants.ts`)
is only ever seeded by:
- `backend/src/lib/e2e-org.ts:79` (test-only org provisioning)
- `backend/src/controllers/role.controller.ts` `resetRole` (admin-triggered, destructive delete+recreate, one role/org at a time)
- One-off migrations that backfill specific grants (e.g. `20260528204625_add_role_permissions`, `20260707000000_backfill_reference_data_reads`)

No code path re-syncs existing orgs when `DEFAULT_GRANTS` gains new grants. Confirmed live drift on
staging (4 orgs) and **prod** (2 orgs — Alpha Doors INC., B&G Cabinet): grant counts per role are
20-90% below current `DEFAULT_GRANTS`. Notably, real orgs on staging are missing the TECHNICIAN
`read Job` (own-job) grant entirely.

Shape-drift (old `{"assigned_to":"{{userId}}"}` flat condition vs current relation-based
`{ lead_assignees: { some: { user_id } } }`) was checked directly against the DB — no surviving rows
use the old shape. Not a live bug, but it's *why* orgs are under- rather than over-provisioned (old
rows were cleaned during the Phase B RBAC overhaul, never fully re-backfilled).

## Decisions (signed off 2026-07-07)

1. One migration, additive-only, covers staging + prod — ships through the normal
   PR → staging → promote → main pipeline (per `ship-changes` skill), not applied out-of-band via MCP.
2. Org-provisioning hook (seeding new orgs) is out of scope — no code path creates orgs today;
   revisit as a separate task once the actual provisioning process is identified.
3. Ship both: the sync migration AND a reusable drift-detection script.

## Work

1. `backend/scripts/check-role-permission-drift.ts` — reads `DEFAULT_GRANTS`, compares against live
   `role_permissions` per org. Two modes:
   - `report` (default): prints missing grants (in `DEFAULT_GRANTS`, absent from DB) and extra grants
     (in DB, absent from `DEFAULT_GRANTS`) per org/role. Read-only.
   - `--emit-sql`: prints an idempotent `INSERT ... ON CONFLICT DO NOTHING` statement for the missing
     set only, used to generate the migration body (avoids hand-transcribing `DEFAULT_GRANTS` into SQL).
2. New migration `backend/prisma/migrations/<ts>_sync_role_permissions_defaults/migration.sql` —
   INSERT-only, `ON CONFLICT (organization_id, role, action, subject) DO NOTHING`, generated via the
   script above against current `DEFAULT_GRANTS`. Never deletes or updates existing rows.
3. Unit tests for the drift script's diff logic (missing/extra detection), mocked prisma, following
   existing `roles.test.ts` conventions.
4. Do NOT touch Servwave Test's TECHNICIAN over-provisioning (17 vs 10 grants) — flagged by the drift
   script's "extra" report but left for manual `resetRole` by an admin; out of scope here since it's a
   demo org, not a real-org risk.
