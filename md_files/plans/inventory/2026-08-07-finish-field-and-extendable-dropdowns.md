# Plan - Finish field + "add new" on every entity-backed inventory dropdown

**Date:** 2026-08-07
**Module:** Inventory (Add/Edit Item dialog) + Price Book
**Status:** implemented 2026-08-11 (backend test-first), pending live check on staging
**Rides with:** the identifier-display work and the duplicate-row fix on `feat/inventory-identifier-display`

## Asks

1. Add a **Finish** field to the Add Item dialog, as a dropdown.
2. Every dropdown in inventory should offer "add a new one", the way Brand was expected to.

Ran's calls (2026-08-07): Finish is a **full entity like Brand**, and **UoM is user-extendable too**.

## What already exists

The `__add_new__` sentinel pattern is already in `AddItemDialog.tsx` for two dropdowns
(`handleVendorChange` / `handleCategoryChange`, lines ~294-320). It renders a separator plus a
`+ Add new …` option, opens the matching dialog, and `adoptServerId`s the created row back into
form state. Brand and Location are the two entity-backed dropdowns that never got it, and
`AddBrandDialog` / `AddLocationDialog` both already exist. So those two are wiring, not new work.

| Dropdown | Backing | Add-new today | After this plan |
|---|---|---|---|
| Vendor / Source | `Vendor` | yes | unchanged |
| Category | `PriceBookCategory` | yes | unchanged |
| Brand | `Brand` | **no** | yes (wire existing dialog) |
| Location | `Location` | **no** | yes (wire existing dialog) |
| Finish | *nothing* | n/a | **new entity** + add-new |
| Unit of Measure | hardcoded array | n/a | **new options table** + add-new |
| Item Kind | fixed enum | n/a | unchanged - closed vocabulary |
| Visibility | fixed enum | n/a | unchanged - closed vocabulary |

Item Kind and Visibility stay fixed: "add new" there would mean inventing enum values that
downstream branching (`kind === "material"`, visibility gating) switches on.

## Design

### Finish - a real entity, mirroring `Brand`

`Brand` is the template to copy (schema, routes, controller, dialog), so Finish follows it exactly:

```prisma
model Finish {
  id         String   @id @default(uuid()) @db.Uuid
  name       String
  code       String?  // e.g. BHMA "630" - optional, trades outside door hardware have none
  is_active  Boolean  @default(true)
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt
  items      PriceBookItem[]
  organization_id String       @db.Uuid
  organization    Organization @relation(fields: [organization_id], references: [id])
  @@unique([organization_id, name])
  @@index([organization_id])
  @@map("finishes")
}
```

plus `finish_id String? @db.Uuid` + relation on `PriceBookItem`, matching `brand_id`.

Routes mirror Brand's split exactly (reads on `inv-catalog`, writes on `price-book`):
`GET /api/inventory/finishes` · `POST /api/price-book/finishes` · `DELETE /api/price-book/finishes/:id`.

### Unit of Measure - an options list, NOT a foreign key

**The `uom` column stays a `String`.** Converting it to an FK is a much larger and riskier job than
it looks: 41 backend and 190 frontend references, and the value is carried on PO lines, stock
movements, job stage lines and reservation lines. A backfill across all of those is its own project
and is not what was asked for.

Instead, an org-scoped table supplies the dropdown's options only:

```prisma
model UomOption {
  id         String   @id @default(uuid()) @db.Uuid
  code       String   // "EA", "FT", "BX"
  label      String?  // "Each", "Feet", "Box"
  is_active  Boolean  @default(true)
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt
  organization_id String       @db.Uuid
  organization    Organization @relation(fields: [organization_id], references: [id])
  @@unique([organization_id, code])
  @@index([organization_id])
  @@map("uom_options")
}
```

Items keep storing the code string, so nothing downstream changes and no data is migrated. The
migration seeds today's hardcoded seven (`EA FT HR ROLL KIT CYL BX`, `AddItemDialog.tsx:91`) for
every existing org, so the dropdown looks identical on day one.

This is a deliberate asymmetry with Finish and is worth stating plainly: Finish is a new field with
no existing data, so an FK costs nothing; UoM is an existing field with data everywhere, so an FK
costs a cross-table backfill. Same user-visible behaviour either way.

## Steps (backend is strict TDD - failing test first)

1. **Backend tests first** - `backend/src/__tests__/price-book.test.ts` (+ a new
   `finishes.test.ts`): create/list/delete a Finish, org isolation via `tenantWhere`, duplicate-name
   rejection, `finish_id` round-trips on item create and PATCH, and clears on null. Same for UoM
   options. Confirm red.
2. **Schema + migration** - portable and idempotent (`CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`), per the `writing-migrations` skill. Seed the seven default UoM rows
   per existing org in the same migration. Never run `prisma migrate` from this worktree.
3. **Controllers/routes** - `upsertFinish` / `deleteFinish` / `listFinishes` copied from the Brand
   equivalents; ditto UoM options. `finish_id` into `itemSupersetFields` and the PATCH passthrough;
   `finishId` into `inv-catalog` `mapItem`.
4. **Frontend seam** - `useFinishes` / `useUpsertFinish` / `useDeleteFinish`, `useUomOptions` /
   `useUpsertUomOption`; `finishId` on `Item` and `ItemWritePayload`; `finish_id` in
   `toPriceBookBody`.
5. **Frontend tests first** - the dialog exposes Finish and UoM; picking `+ Add new …` on Brand,
   Location, Finish and UoM opens the right dialog and adopts the server id; a create ships
   `finishId`; edit prefills it.
6. **Dialog wiring** - `handleBrandChange` / `handleLocationChange` / `handleFinishChange` /
   `handleUomChange` following the existing vendor/category handlers; new small `AddFinishDialog`
   modelled on `AddBrandDialog`.
7. `npx tsc --noEmit` + `npm test --workspace=backend` + the inventory frontend suites.

## Files

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | `Finish`, `UomOption`, `PriceBookItem.finish_id` |
| `backend/prisma/migrations/<ts>_finish_and_uom_options/migration.sql` | new tables + column + UoM seed |
| `backend/src/controllers/price-book.controller.ts` | finish/uom CRUD + item passthrough |
| `backend/src/controllers/inv-catalog.controller.ts` | `listFinishes`, `listUomOptions`, `mapItem` |
| `backend/src/routes/{price-book,inv-catalog}.routes.ts` | new routes |
| `backend/src/__tests__/*` | failing-first coverage |
| `frontend/src/lib/api/inventory.ts` | hooks, types, `toPriceBookBody` |
| `frontend/src/components/inventory/AddItemDialog.tsx` | Finish + UoM fields, 4 add-new handlers |
| `frontend/src/components/inventory/AddFinishDialog.tsx` (new) | modelled on `AddBrandDialog` |
| `frontend/src/__tests__/*` | dialog coverage |

## Risk

Medium - the first schema change in this branch, and the first new entities. The migration must be
idempotent because it runs against staging and prod ledgers that are already 160 migrations deep.

The UoM seed is the one destructive-adjacent step: it INSERTs per existing org. It must be
`ON CONFLICT DO NOTHING` against `(organization_id, code)` so a re-run cannot duplicate rows.

## Outcome (2026-08-11)

Implemented as designed. Two things the plan did not anticipate:

- **The org-purge ratchet caught the new tables.** `purge-tenant-coverage.test.ts` fails any
  org-scoped model that `purgeOrganization` neither deletes nor exempts. Both tables now get a real
  `deleteMany`, ordered after `priceBookItem` (the `finish_id` FK is ON DELETE SET NULL, so purging
  finishes first would rewrite every item row on its way to deleting them). Deliberately NOT added
  to `PURGE_EXEMPT` alongside Brand - these are new, nothing else points at them, and there was no
  reason to grow the #1027 backlog.
- **The migration needs the RLS backstop too**, for the same reason: `rls-coverage.test.ts` compares
  `pg_policies` against the real schema and fails a new org-scoped table with no `tenant_isolation`
  policy. Included, plus the anon/authenticated revoke.

Also resolved in passing: removing the optimistic prepend (the duplicate-row fix) does **not** break
`inventory-stock-page-writes`' opening-count test - that suite passes. The earlier failure was the
1s `findByText` default losing to a loaded machine, not a regression.

## Out of scope

- ~~Surfacing Finish on the grid/side panel~~ - PULLED BACK IN 2026-08-11, before merge.
  Leaving it out shipped a field you could save and never see again, which is the exact
  "half-delivered field" defect the sibling identifier plan exists to fix. Finish now rides the
  same `ItemIdentifiers` line on all three surfaces and is matched by the Items search. Because it
  is a foreign key rather than a string, the pages resolve `finishId` to a name via a memoized map
  and pass it down; the component stays presentational and fires no query per row.
- A Settings management screen for finishes and UoM. Creation happens inline from the dialog; full
  CRUD management is a separate surface, and Brand/Category already show that gap exists.
- Converting `uom` to a foreign key. Explicitly rejected above.
- Backfilling `finish` on existing items - there is no source data to backfill from.
