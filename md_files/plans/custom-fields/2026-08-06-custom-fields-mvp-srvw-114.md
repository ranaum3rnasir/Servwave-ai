# Custom Fields MVP - SRVW-114 implementation plan

**Date:** 2026-08-06
**Cards:** SRVW-114 (this plan) blocks SRVW-115 (v2, not built here)
**Base branch:** `staging` - `git merge-base --is-ancestor origin/main origin/staging` returns non-zero, so a
`main`-based branch would show phantom files (CLAUDE.md gate).

## Decisions taken with Ran (2026-08-06 session)

1. **Values stored as a JSONB bag keyed by definition UUID.** Definitions live in their own table; a
   rename never orphans stored data.
2. **Entities: Lead, Job, Customer, PriceBookItem.** Items are pulled forward past the card text to
   avoid revisiting the schema.
3. **SRVW-115 is not built.** The schema is shaped so search, merge tokens and automation conditions
   are additive.
4. **Per-job-type scoping deferred to SRVW-115**, with the job-type prerequisite recorded on that card.

## Verified starting state

* Zero hits for `custom_field` / `customField` across `backend/` and `frontend/` - nothing exists.
* No attribute bag on any target entity. `Lead` has no `Json` column; `Job` and `Estimate` carry an
  unrelated `scopes Json?`.
* **Job has no `lead_id`.** The lead link runs through `estimate.lead_id`
  (`job.controller.ts:1268`), and the only Convert-to-Job path in the UI requires a WON estimate
  (`LeadDetailPage.tsx:724,786,1399`). The conversion-copy hook therefore sits in the
  create-job-from-estimate transaction, not on a direct lead-to-job edge.
* Job type is `Organization.job_type_options`, a `Json` string array with a hardcoded default
  (`schema.prisma:1728`), validated at `organization.controller.ts:431`. No `JobType` model exists -
  this is the SRVW-115 prerequisite.
* Settings nav is a declarative array with per-row CASL gating (`SettingsLayout.tsx:47-61`).
* Price-book items have **no detail page**; they are edited through `AddItemDialog` in edit mode
  (`PriceBookPage.tsx:503`), so their custom fields render as a dialog section, not a panel.

## Schema

```prisma
enum CustomFieldType   { TEXT NUMBER DATE SELECT CHECKBOX }
enum CustomFieldEntity { LEAD JOB CUSTOMER PRICE_BOOK_ITEM }

model CustomFieldDefinition {
  id              String             @id @default(uuid()) @db.Uuid
  organization_id String             @db.Uuid
  entity_types    CustomFieldEntity[]           // one definition may serve several entities
  key             String                        // stable slug - v2 merge tokens bind to this
  label           String
  type            CustomFieldType
  options         Json               @default("[]")   // SELECT choices only
  required        Boolean            @default(false)
  sort_order      Int                @default(0)
  archived_at     DateTime?                      // archive, never hard-delete: preserves history
  created_at      DateTime           @default(now())
  updated_at      DateTime           @updatedAt
  organization    Organization       @relation(fields: [organization_id], references: [id])

  @@unique([organization_id, key])
  @@index([organization_id])
  @@map("custom_field_definitions")
}
```

Values: `custom_fields Json @default("{}")` added to `leads`, `jobs`, `customers`,
`price_book_items`. Shape `{ "<definition-uuid>": <scalar> }`.

**Why definition-UUID keys:** label and slug both become editable without a data migration. The `key`
column still exists so SRVW-115 merge tokens read `{{job.custom.gate_code}}` and resolve slug ->
definition -> UUID at render time.

**v2 readiness:** a GIN index on each `custom_fields` column is additive, so SRVW-115's list
search/filter needs no value rewrite.

Migration is portable + idempotent, authored per the `writing-migrations` skill, never run from a
worktree.

## Backend

* `backend/src/lib/custom-fields.ts` - single source of truth:
  * `validateCustomFieldValues(orgId, entityType, patch)` - unknown key 400s, type coercion per
    definition, SELECT membership check, archived definitions reject new writes but keep reading.
  * `mergeCustomFields(existing, patch)` - shallow merge; explicit `null` deletes a key.
* `custom-field-definitions.controller.ts` - org-scoped CRUD, every `where`/`data` spreading
  `tenantWhere(req)`. Delete is an archive.
* Value writes ride the **existing** PATCH endpoints for the four entities - no new value routes.
* Conversion: inside the create-job-from-estimate transaction, copy the lead's `custom_fields`
  entries whose definition also lists `JOB`, without overwriting anything already set on the job.

**Assumption to confirm:** `required` is enforced in the Extra Info panel, **not** as an API 400.
Hard-enforcing it server-side would break every unrelated partial PATCH on an entity the moment an
admin marks a field required. If you want a hard API gate, it needs its own submit endpoint.

**Permissions:** definition CRUD reuses `update Organization`, matching Payments & Lists, so the
126-pair catalog is untouched. Reading definitions requires only entity read. A dedicated
`CustomField` subject is the v2 option if item-level gating is ever needed.

Backend is TDD - failing test first on every slice (CLAUDE.md rule 6).

## Frontend

* `Settings -> Custom Fields` (ADVANCED group, gated `update Organization`) - define fields, pick
  entities, reorder, archive.
* `<ExtraInfoPanel entityType entityId values />` - one component, four mounts:
  Lead / Job / Customer detail pages, plus an `AddItemDialog` section for price-book items.
* Inline edit, saving through each entity's existing PATCH mutation.
* Design tokens only - no raw hex, no raw Tailwind palette class.

## Slices (one PR each, into `staging`)

| # | Slice | Surface |
|---|-------|---------|
| 1 | Enums, model, 4 value columns, migration, definitions CRUD API | backend |
| 2 | Validation/merge lib wired into the 4 entity PATCHes + conversion copy | backend |
| 3 | Settings -> Custom Fields admin UI | frontend |
| 4 | ExtraInfoPanel on Lead / Job / Customer detail | frontend |
| 5 | Custom-fields section in AddItemDialog | frontend |

Gate before every "done" claim: `npx tsc --noEmit` + `npm test --workspace=backend`, real results
reported.

## Explicitly out of scope (SRVW-115)

List search/filter on values · per-job-type visibility · document merge tokens · automation
conditions · reports exposure.

## Open items to record on SRVW-115

* Job types are strings in an org JSON array with no referential integrity - per-job-type scoping
  needs either a `JobType` model or accepted rename breakage.
* Hard `required` enforcement needs a dedicated submit endpoint.
