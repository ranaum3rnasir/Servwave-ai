# Slice 5 - Custom fields on price-book items

**Parent:** SRVW-114 · **Type:** AFK · **Blocked by:** Slices 2, 3

## What to build

The fourth entity: **PRICE_BOOK_ITEM**. This is the entity Ran pulled forward past the card text on
2026-08-06 so the schema never has to be revisited for it.

**The wrinkle:** price-book items have **no detail page**. They are created and edited through
`AddItemDialog` in edit mode, launched from the price-book page. So the custom fields render as a
section inside that dialog rather than as a panel on a detail page. Same data contract, different
host. `ExtraInfoPanel` needs to tolerate a dialog host - narrower, no page chrome - or expose a
variant that does.

The item form is already large (a catalog and inventory superset: sku, mpn, upc, brand, uom, several
prices, serialization, hazmat flags). The custom-fields section must not make it harder to scan:
collapse it or place it last, and hide it entirely when the org has defined no item fields.

## Acceptance criteria

- [ ] Definitions can be scoped to PRICE_BOOK_ITEM alongside the other three entities
- [ ] `AddItemDialog` shows a custom-fields section in both create and edit mode, listing only item-scoped definitions
- [ ] Values save with the item through its existing endpoints and survive reopening the dialog
- [ ] The section is absent when the org has no item-scoped definitions, adding no vertical space to an already dense form
- [ ] All five field types render correctly in the dialog host, not only the page host
- [ ] Org isolation holds, proven by test
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Notes

Out of scope: showing custom-field values in the price-book **list** columns, and in the item picker
used from jobs and estimates. Both are list-surface work that belongs with slice 7.

## Blocked by

- Slice 2 (all field types must render in the dialog host)
- Slice 3 (multi-entity definitions)
