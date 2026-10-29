# Slice 3 - Widen to Lead and Customer

**Parent:** SRVW-114 · **Type:** AFK · **Blocked by:** Slice 1

## What to build

Widen the entity axis from Job to **Lead** and **Customer**, and make `entity_types` genuinely
multi-valued: one definition can serve several entities at once, which is what makes the conversion
carry-over in slice 4 possible at all.

* Admin UI grows an entity picker on the definition form (multi-select over LEAD / JOB / CUSTOMER;
  PRICE_BOOK_ITEM arrives in slice 5).
* `ExtraInfoPanel` mounts on the lead detail page and the customer detail page. Same component, same
  contract, different `entityType`.
* Value writes ride the existing lead and customer PATCH endpoints, validated by the shared lib.

Definition listing is filtered by entity: a job-only field must not appear on a customer, and a
value written against a definition that does not list the target entity is rejected.

## Acceptance criteria

- [ ] A definition can be scoped to any non-empty subset of LEAD, JOB, CUSTOMER, and the subset is editable after creation
- [ ] Extra Info panel renders on lead detail and customer detail, listing only definitions scoped to that entity
- [ ] Editing a value on a lead or customer persists via that entity's existing PATCH and survives reload
- [ ] Writing a value for a definition not scoped to the target entity 400s
- [ ] Narrowing a definition's entity scope does not delete values already stored on the dropped entity - they stop rendering, and reinstating the scope brings them back
- [ ] Org isolation holds on both new entities, proven by test
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Notes

The "narrowing does not destroy data" rule is the same instinct as archive-not-delete: an admin
mis-clicking an entity checkbox must not be a data-loss event.

## Blocked by

- Slice 1 (tracer)
