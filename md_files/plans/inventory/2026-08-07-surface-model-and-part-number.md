# Plan - Surface model number and part number outside the Add/Edit dialog

**Date:** 2026-08-07
**Module:** Inventory (Stock > Items) + Price Book (Items)
**Status:** implemented 2026-08-07 (test-first), pending live check on staging
**Follows:** PR #1382, which added both fields to the Add/Edit Item dialog

## Problem

PR #1382 made both identifiers writable and searchable, but **not visible**. Today you can
type a model number, save it, and search by it - and then never see it again anywhere in the
UI. It appears only when you reopen the edit dialog for that item.

That is a half-delivered field. The whole reason a contractor records a model number is to
read it back when ordering a replacement or quoting a vendor.

`mpn` has been in the schema far longer and has the same gap, so this fixes both at once.

## Where they should appear

Three surfaces read the same `Item` shape. Both fields are already on it
(`frontend/src/lib/api/inventory.ts` - `mpn`, `modelNumber`) and already populated by the
server list mapper (`backend/src/controllers/inv-catalog.controller.ts` `mapItem`), so
**no API or schema work is needed** - this is presentation only.

### 1. Stock > Items grid - secondary line under the item name

`frontend/src/pages/inventory/InventoryPage.tsx:1132-1145`. The Item cell already stacks a
name over a badge row. Add a compact line between them, rendered only when at least one value
is present:

```
Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin
Model MT5+ · Part 114
[serialized] [hazmat]
```

**Not new columns.** The grid is already 9 columns wide and adding two more would force
horizontal scroll on a laptop. A secondary line costs no width and matches how SKU is already
subordinated to the name on the Price Book grid.

### 2. Stock item side panel - alongside the SKU

`InventoryPage.tsx:1786-1798` (`DetailPanel` header). The header already shows SKU, name and a
category chip. Add the two identifiers under the SKU, using the same muted `font-mono`
treatment, each rendered only when present. This is the surface someone actually reads before
placing an order, so it is the most valuable of the three.

### 3. Price Book > Items grid - same secondary line

`frontend/src/pages/inventory/PriceBookPage.tsx:861-873`. The Item cell already renders
`name` over `sku` in exactly the shape this needs. Extend that second line.

Including this surface is a deliberate scope call: it is the same `Item` type and the same
two-line cell, so it is a handful of lines, and leaving Price Book as the one place that hides
the fields would be an odd inconsistency.

## Format

- Label the values - a bare `MT5+ · 114` is unreadable. Use `Model` and `Part`.
- Render nothing at all when both are absent. Most existing rows have no model number
  (the column is new, with no backfill), so an unconditional line would put a row of
  em-dashes under every item.
- When only one is present, show only that one - no dangling separator.
- Reuse the existing `text-[11px] text-text-secondary` treatment from the Price Book SKU line
  rather than minting new type. Design tokens only, no raw hex or palette classes
  (`frontend/DESIGN_SYSTEM.md`).

Extract one tiny presentational helper for the label pair and use it on all three surfaces,
so the format cannot drift between them.

## Steps

1. Write the failing test first: extend `frontend/src/__tests__/inventory-model-part-number.test.tsx`
   with cases asserting (a) the Stock grid row shows both values, (b) the side panel shows both,
   (c) the Price Book row shows both, (d) an item with neither renders no label text at all,
   (e) an item with only one renders that one without a stray separator.
2. Add the shared helper.
3. Wire it into the three surfaces.
4. Run `inventory-model-part-number`, `inventory-item-type-taxable`, `price-book-persistence`,
   `inventory-stock-page-writes`, plus `useInventoryFilters.test.tsx`.
5. `npx tsc --noEmit` + full frontend suite.
6. Live check on staging after merge, on an item that has both values and one that has neither.

## Files

| File | Change |
|---|---|
| `frontend/src/components/inventory/ItemIdentifiers.tsx` (new) | small presentational helper |
| `frontend/src/pages/inventory/InventoryPage.tsx` | grid Item cell + `DetailPanel` header |
| `frontend/src/pages/inventory/PriceBookPage.tsx` | grid Item cell second line |
| `frontend/src/__tests__/inventory-model-part-number.test.tsx` | display cases |

## Risk

Low. Presentation only - no schema, API, or write-path change, and no new query. The one thing
to watch is vertical rhythm: the Stock grid's Item cell gains a third line on items that carry
identifiers, so row heights become uneven across the grid. Check that visually before merging;
if it reads badly, fall back to showing the identifiers in the side panel only and drop the two
grid surfaces.

## Explicitly out of scope

- Making the identifiers **editable** anywhere but the Add/Edit dialog.
- Adding them to PO, estimate, or invoice line-item rendering. Defensible (a part number on a
  PO line is genuinely useful to a vendor) but a different surface with its own line-item
  shapes, and it is not what was asked for.
- Exposing `upc`, which has the same invisibility problem. Flag it, do not fix it here.
