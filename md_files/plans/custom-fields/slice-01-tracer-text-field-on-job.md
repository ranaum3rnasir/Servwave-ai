# Slice 1 - Tracer: one text field on Job, end to end

**Parent:** SRVW-114 · **Type:** AFK · **Blocked by:** None - can start immediately

## What to build

The entire spine of custom fields at its narrowest useful width: an org admin defines a single
**text** field for **jobs**, and it renders in an editable "Extra Info" panel on the job detail page.

This slice carries every integration layer. Everything after it widens an axis that already works.

The migration in this slice lands the **complete** schema for the whole MVP - both enums, all
definition columns, and the `custom_fields` value column on all four entities - even though only the
job path is wired up. Later slices turn behavior on without a second migration.

Schema shape (from the design doc, which is the authority):

```prisma
enum CustomFieldType   { TEXT NUMBER DATE SELECT CHECKBOX }
enum CustomFieldEntity { LEAD JOB CUSTOMER PRICE_BOOK_ITEM }

model CustomFieldDefinition {
  id, organization_id, entity_types CustomFieldEntity[], key, label,
  type CustomFieldType, options Json @default("[]"), required Boolean @default(false),
  sort_order Int @default(0), archived_at DateTime?
  @@unique([organization_id, key])
}
```

Values live in `custom_fields Json @default("{}")` on `leads`, `jobs`, `customers`,
`price_book_items`, keyed by **definition UUID**.

Definition CRUD is org-admin only, reusing the `update Organization` capability the way Payments &
Lists does, so the 126-pair permission catalog is untouched. Reading definitions needs only entity
read.

Values are written through the **existing** job PATCH endpoint. No new value routes anywhere in this
program.

## Acceptance criteria

- [ ] Migration adds both enums, `custom_field_definitions`, and `custom_fields` on all four entity tables; portable, idempotent, applies cleanly to a fresh DB and to staging
- [ ] Admin can create, read, update and archive a TEXT definition scoped to JOB via the API, org-scoped through `tenantWhere` on every query
- [ ] A second org cannot see or mutate the first org's definitions, proven by test
- [ ] Settings -> Custom Fields page exists in the ADVANCED group, gated on `update Organization`, and can create a text field
- [ ] Job detail page renders an "Extra Info" panel listing active JOB definitions with their stored values
- [ ] Editing a value in the panel persists through the existing job PATCH and survives reload
- [ ] Writing an unknown definition key 400s; writing a value for another org's definition 400s
- [ ] Panel is absent, not broken, when the org has defined no fields
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Notes

* Value merge semantics live in `backend/src/lib/custom-fields.ts` from this slice onward: shallow
  merge over the stored bag, explicit `null` deletes a key. Later slices reuse it rather than
  reimplementing per entity.
* `required` and `sort_order` columns exist here but are inert until slice 6.
* The panel component is built as `<ExtraInfoPanel entityType entityId />` from the start, since
  slices 3 and 5 mount the same component elsewhere.

## Blocked by

None - can start immediately.
